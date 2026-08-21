import { describe, expect, test } from "bun:test";

import {
  buildNavigationGraph,
  buildPageIndex,
  compileNavigationPlanActions,
  planNavigation,
  resolvePageReference,
} from "../../examples/ios-regression-kit";

import type {
  NavigationPolicy,
  UiControl,
  UiPage,
  UiSelector,
  UiTransition,
} from "../../examples/ios-regression-kit/types";

const pages: UiPage[] = [
  page("chat_detail", "会话页", ["chat.more"]),
  page("chat_media_panel", "媒体面板", ["media.album"]),
  page("system_photo_picker", "系统照片选择器", ["picker.close"]),
  page("image_selection_ready", "图片选择页", ["selection.next"]),
  page("image_send_ready", "图片发送确认页", ["send.send"]),
  page("permission_prompt", "相册权限弹窗", ["permission.allow"]),
];

const controls: UiControl[] = [
  control("chat.more", "chat_detail"),
  control("media.album", "chat_media_panel"),
  control("picker.close", "system_photo_picker"),
  control("picker.mouse", "system_photo_picker", {}),
  control("selection.next", "image_selection_ready"),
  control("send.send", "image_send_ready"),
  control("permission.allow", "permission_prompt"),
];

const transitions: UiTransition[] = [
  transition("chat-to-media", "chat_detail", "chat_media_panel", "chat.more"),
  transition(
    "media-to-picker",
    "chat_media_panel",
    "system_photo_picker",
    "media.album",
  ),
  transition(
    "picker-to-selection",
    "system_photo_picker",
    "image_selection_ready",
    "picker.mouse",
  ),
  transition(
    "selection-to-send",
    "image_selection_ready",
    "image_send_ready",
    "selection.next",
  ),
  transition(
    "chat-to-permission",
    "chat_detail",
    "permission_prompt",
    "chat.more",
  ),
];

const policy: NavigationPolicy = {
  schemaVersion: "ios-ui-navigation-policy/v1",
  bundleId: "com.bot.doubao",
  rootPageId: "cold_start",
  defaultStartPageId: "chat_detail",
  pagePolicies: {
    chat_detail: { aliases: ["聊天页"], status: "active" },
    image_send_ready: {
      aliases: ["图片发送确认页", "发送图片页面"],
      status: "active",
    },
    permission_prompt: { status: "blocked" },
  },
  transitionPolicies: {
    "chat-to-media": {
      category: "navigation",
      status: "active",
      reliability: 1,
    },
    "media-to-picker": {
      category: "navigation",
      status: "active",
      reliability: 1,
    },
    "picker-to-selection": {
      category: "selection",
      status: "active",
      reliability: 0.8,
    },
    "selection-to-send": {
      category: "selection",
      status: "active",
      reliability: 1,
    },
    "chat-to-permission": {
      category: "permission",
      status: "blocked",
    },
  },
  manualEdges: [
    {
      edgeId: "cold-to-chat",
      fromPageId: "cold_start",
      toPageId: "chat_detail",
      category: "navigation",
      status: "active",
      action: { type: "cold_launch", waitMs: 3000 },
      reliability: 1,
    },
    {
      edgeId: "send-mutation",
      fromPageId: "image_send_ready",
      toPageId: "chat_detail",
      category: "mutation",
      status: "active",
      action: { type: "tap", controlId: "send.send" },
      reliability: 1,
    },
  ],
};

describe("iOS navigation graph", () => {
  const graph = buildNavigationGraph({
    bundleId: "com.bot.doubao",
    pages,
    controls,
    transitions,
    policy,
    generatedAt: "2026-08-13T00:00:00.000Z",
  });
  const index = buildPageIndex(graph);

  test("keeps raw transitions candidate unless policy activates them", () => {
    expect(
      graph.edges.find((edge) => edge.edgeId === "chat-to-permission"),
    ).toEqual(
      expect.objectContaining({
        category: "permission",
        status: "blocked",
      }),
    );
    expect(
      graph.nodes.find((node) => node.pageId === "permission_prompt"),
    ).toEqual(expect.objectContaining({ status: "blocked" }));
  });

  test("resolves model-facing aliases without an Agent", () => {
    expect(resolvePageReference("发送图片页面", index)).toEqual({
      pageId: "image_send_ready",
      candidates: ["image_send_ready"],
      reason: "alias",
    });
  });

  test("plans navigation and selection without leaking mutation", () => {
    expect(() =>
      planNavigation({
        graph,
        targetPageId: "image_send_ready",
        allowCategories: ["navigation"],
      }),
    ).toThrow();

    const plan = planNavigation({
      graph,
      targetPageId: "image_send_ready",
      allowCategories: ["navigation", "selection"],
    });
    expect(plan.edges.map((edge) => edge.edgeId)).toEqual([
      "cold-to-chat",
      "chat-to-media",
      "media-to-picker",
      "picker-to-selection",
      "selection-to-send",
    ]);
    expect(plan.edges.some((edge) => edge.category === "mutation")).toBeFalse();
  });

  test("requires explicit mutation permission for sending", () => {
    expect(
      planNavigation({
        graph,
        sourcePageId: "image_send_ready",
        targetPageId: "chat_detail",
        allowCategories: ["mutation"],
      }).edges.map((edge) => edge.edgeId),
    ).toEqual(["send-mutation"]);
  });

  test("compiles a plan into deterministic actions", () => {
    const plan = planNavigation({
      graph,
      targetPageId: "system_photo_picker",
      allowCategories: ["navigation"],
    });
    const actions = compileNavigationPlanActions({
      plan,
      bundleId: "com.bot.doubao",
      actionIdPrefix: "go-picker",
    });
    expect(actions.map((action) => action.type)).toEqual([
      "terminate_app",
      "launch_app",
      "wait",
      "snapshot",
      "tap",
      "wait",
      "snapshot",
      "tap",
      "wait",
      "snapshot",
    ]);
  });
});

function page(
  pageId: string,
  title: string,
  anchors: readonly string[],
): UiPage {
  return {
    schemaVersion: "ios-ui-page/v1",
    pageId,
    title,
    bundleId: "com.bot.doubao",
    fingerprint: `${pageId}-fingerprint`,
    observedAt: "2026-08-13T00:00:00.000Z",
    deviceProfileId: "iphone-test",
    screenshotPath: `/tmp/${pageId}.png`,
    uiDumpPath: `/tmp/${pageId}.json`,
    controlIds: anchors,
    anchorControlIds: anchors,
  };
}

function control(
  controlId: string,
  pageId: string,
  selector: UiSelector = { accessibilityId: controlId },
): UiControl {
  return {
    schemaVersion: "ios-ui-control/v1",
    controlId,
    pageId,
    title: controlId,
    role: "Button",
    selector,
    bindings: [],
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

function transition(
  transitionId: string,
  fromPageId: string,
  toPageId: string,
  controlId: string,
): UiTransition {
  return {
    schemaVersion: "ios-ui-transition/v1",
    transitionId,
    fromPageId,
    toPageId,
    actionId: transitionId,
    controlId,
    observedAt: "2026-08-13T00:00:00.000Z",
  };
}
