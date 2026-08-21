import { describe, expect, test } from "bun:test";

import {
  expandNavigationActions,
  meta,
  selectCases,
} from "../../examples/ios-functional-regression/workflow";

import type {
  NavigationGraph,
  PageIndex,
  RegressionCase,
} from "../../examples/ios-regression-kit/types";

const cases: RegressionCase[] = [
  {
    caseId: "launch",
    title: "启动",
    priority: "P0",
    tags: ["smoke"],
    preconditions: [],
    actions: [{ actionId: "launch", type: "launch_app" }],
    expected: [],
  },
  {
    caseId: "send-image",
    title: "发送图片",
    priority: "P1",
    tags: ["message", "media"],
    preconditions: [],
    actions: [{ actionId: "launch", type: "launch_app" }],
    expected: [],
  },
];

describe("iOS Functional Regression workflow", () => {
  test("declares serial execution and reporting phases", () => {
    expect(meta.name).toBe("ios-functional-regression");
    expect(meta.phases.map((phase) => phase.title)).toEqual([
      "Prepare",
      "Preflight",
      "Execute",
      "Evaluate",
      "Report",
    ]);
  });

  test("selects smoke cases by priority and tag", () => {
    expect(
      selectCases(cases, {
        priorities: new Set(["P0"]),
        tags: new Set(["smoke"]),
        caseIds: new Set(),
      }).map((item) => item.caseId),
    ).toEqual(["launch"]);

    expect(
      selectCases(cases, {
        priorities: new Set(),
        tags: new Set(["media"]),
        caseIds: new Set(["send-image"]),
      }).map((item) => item.caseId),
    ).toEqual(["send-image"]);
  });

  test("expands navigate actions before device execution", () => {
    const graph: NavigationGraph = {
      schemaVersion: "ios-ui-navigation-graph/v1",
      bundleId: "com.bot.doubao",
      generatedAt: "2026-08-13T00:00:00.000Z",
      rootPageId: "cold_start",
      defaultStartPageId: "chat",
      nodes: [
        {
          pageId: "cold_start",
          title: "冷启动",
          aliases: ["冷启动"],
          status: "active",
          anchorControlIds: [],
          controlIds: [],
          variants: {},
        },
        {
          pageId: "chat",
          title: "会话页",
          aliases: ["聊天页"],
          status: "active",
          anchorControlIds: ["chat.more"],
          controlIds: ["chat.more"],
          variants: {},
        },
        {
          pageId: "media",
          title: "媒体面板",
          aliases: ["附件面板"],
          status: "active",
          anchorControlIds: ["media.close"],
          controlIds: ["media.close"],
          variants: {},
        },
      ],
      edges: [
        {
          edgeId: "cold-chat",
          fromPageId: "cold_start",
          toPageId: "chat",
          category: "navigation",
          status: "active",
          action: { type: "cold_launch" },
          preconditions: [],
          postconditions: [{ type: "page", pageId: "chat" }],
          cost: 1,
          reliability: 1,
          settleMs: 1000,
        },
        {
          edgeId: "chat-media",
          fromPageId: "chat",
          toPageId: "media",
          category: "navigation",
          status: "active",
          action: { type: "tap", controlId: "chat.more" },
          preconditions: [{ type: "page", pageId: "chat" }],
          postconditions: [{ type: "page", pageId: "media" }],
          cost: 1,
          reliability: 1,
          settleMs: 500,
        },
      ],
    };
    const pageIndex: PageIndex = {
      schemaVersion: "ios-ui-page-index/v1",
      bundleId: "com.bot.doubao",
      generatedAt: graph.generatedAt,
      pages: [
        {
          pageId: "chat",
          title: "会话页",
          aliases: ["聊天页"],
          status: "active",
        },
        {
          pageId: "media",
          title: "媒体面板",
          aliases: ["附件面板"],
          status: "active",
        },
      ],
    };
    const expanded = expandNavigationActions({
      regressionCase: {
        caseId: "navigate-media",
        title: "导航到媒体面板",
        priority: "P0",
        tags: ["navigation"],
        preconditions: [],
        actions: [
          {
            actionId: "go-media",
            type: "navigate",
            targetPage: "附件面板",
          },
        ],
        expected: [{ type: "page", pageId: "media" }],
      },
      graph,
      pageIndex,
      bundleId: "com.bot.doubao",
    });
    expect(expanded.actions.some((action) => action.type === "navigate")).toBe(
      false,
    );
    expect(expanded.actions.map((action) => action.type)).toEqual([
      "terminate_app",
      "launch_app",
      "wait",
      "snapshot",
      "tap",
      "wait",
      "snapshot",
    ]);
  });
});
