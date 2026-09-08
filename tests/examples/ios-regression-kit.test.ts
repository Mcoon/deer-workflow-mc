import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  buildMobilecliActionCommand,
  DEFAULT_ARTIFACT_ROOT,
  denormalizePoint,
  matchUiElement,
  normalizePoint,
  parseUiDump,
  resolveTapPoint,
  validateCaseSet,
} from "../../examples/ios-regression-kit";

import type {
  DeviceProfile,
  RegressionCaseSet,
  UiControl,
} from "../../examples/ios-regression-kit/types";

const profile: DeviceProfile = {
  schemaVersion: "ios-device-profile/v1",
  profileId: "iphone-test-390x844",
  platform: "ios",
  viewportWidth: 390,
  viewportHeight: 844,
  coordinateSpace: "mobilecli",
  orientation: "portrait",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

test("uses the persistent per-user artifact root by default", () => {
  expect(DEFAULT_ARTIFACT_ROOT).toBe(join(homedir(), ".ios_pref_optimizer"));
});

const sendControl: UiControl = {
  schemaVersion: "ios-ui-control/v1",
  controlId: "chat.send_button",
  pageId: "chat",
  title: "发送",
  role: "XCUIElementTypeButton",
  selector: { accessibilityId: "chat.send" },
  bindings: [
    {
      deviceProfileId: profile.profileId,
      normalizedPoint: { x: 0.9, y: 0.92 },
      observedAt: "2026-08-12T00:00:00.000Z",
      source: "ui_dump",
    },
  ],
  updatedAt: "2026-08-12T00:00:00.000Z",
};

describe("iOS regression asset helpers", () => {
  test("parses JSON UI dumps and resolves the unique live control bounds", () => {
    const elements = parseUiDump(
      JSON.stringify({
        children: [
          {
            type: "XCUIElementTypeButton",
            identifier: "chat.send",
            label: "发送",
            frame: { x: 340, y: 760, width: 42, height: 42 },
          },
        ],
      }),
    );

    expect(matchUiElement(elements, { accessibilityId: "chat.send" })).toEqual(
      expect.objectContaining({
        accessibilityId: "chat.send",
        bounds: { x: 340, y: 760, width: 42, height: 42 },
      }),
    );
    expect(
      resolveTapPoint({
        action: {
          actionId: "send",
          type: "tap",
          pageId: "chat",
          target: { controlId: "chat.send_button" },
        },
        controls: [sendControl],
        elements,
        profile,
        currentPageId: "chat",
      }),
    ).toEqual({
      point: { x: 361, y: 781 },
      source: "ui_dump",
    });
  });

  test("rejects ambiguous UI matches instead of choosing one", () => {
    const elements = parseUiDump(
      JSON.stringify([
        { label: "发送", frame: [10, 10, 20, 20] },
        { label: "发送", frame: [100, 10, 20, 20] },
      ]),
    );

    expect(matchUiElement(elements, { label: "发送" })).toBeNull();
  });

  test("falls back to the same device profile binding after page validation", () => {
    expect(
      resolveTapPoint({
        action: {
          actionId: "send",
          type: "tap",
          pageId: "chat",
          target: { controlId: "chat.send_button" },
        },
        controls: [sendControl],
        elements: [],
        profile,
        currentPageId: "chat",
      }),
    ).toEqual({
      point: { x: 351, y: 776.48 },
      source: "device_binding",
    });
  });

  test("refuses coordinate fallback before the expected page is verified", () => {
    expect(
      resolveTapPoint({
        action: {
          actionId: "send",
          type: "tap",
          pageId: "chat",
          target: { controlId: "chat.send_button" },
        },
        controls: [sendControl],
        elements: [],
        profile,
      }),
    ).toEqual({
      point: null,
      issue:
        "Control chat.send_button requires a verified chat page before using its coordinate binding.",
    });
  });

  test("normalizes coordinates for reusable device profiles", () => {
    const normalized = normalizePoint({ x: 195, y: 422 }, profile);
    expect(normalized).toEqual({ x: 0.5, y: 0.5 });
    expect(denormalizePoint(normalized, profile)).toEqual({ x: 195, y: 422 });
  });

  test("rejects cases that reference unknown controls", () => {
    const caseSet: RegressionCaseSet = {
      schemaVersion: "ios-regression-case-set/v1",
      caseSetId: "message-smoke",
      title: "Message smoke",
      bundleId: "com.bot.doubao",
      generatedAt: "2026-08-12T00:00:00.000Z",
      source: { kind: "manual" },
      cases: [
        {
          caseId: "send-text",
          title: "发送文本",
          priority: "P0",
          tags: ["message"],
          preconditions: [],
          actions: [
            {
              actionId: "tap-send",
              type: "tap",
              pageId: "chat",
              target: { controlId: "chat.missing_button" },
              assertBefore: [{ type: "page", pageId: "chat" }],
            },
          ],
          expected: [],
        },
      ],
    };

    expect(validateCaseSet(caseSet, [sendControl])).toEqual({
      valid: false,
      issues: [
        "Tap send-text/tap-send references unknown control chat.missing_button.",
      ],
    });
  });

  test("rejects an unguarded tap even when the control exists", () => {
    const caseSet: RegressionCaseSet = {
      schemaVersion: "ios-regression-case-set/v1",
      caseSetId: "message-smoke",
      title: "Message smoke",
      bundleId: "com.bot.doubao",
      generatedAt: "2026-08-12T00:00:00.000Z",
      source: { kind: "manual" },
      cases: [
        {
          caseId: "send-text",
          title: "发送文本",
          priority: "P0",
          tags: ["message"],
          preconditions: [],
          actions: [
            {
              actionId: "tap-send",
              type: "tap",
              pageId: "chat",
              target: { controlId: "chat.send_button" },
            },
          ],
          expected: [],
        },
      ],
    };

    expect(validateCaseSet(caseSet, [sendControl])).toEqual({
      valid: false,
      issues: [
        "Tap send-text/tap-send must verify page chat or its target control before execution.",
      ],
    });
  });

  test("rejects pages that were not captured by UI discovery", () => {
    const caseSet: RegressionCaseSet = {
      schemaVersion: "ios-regression-case-set/v1",
      caseSetId: "message-smoke",
      title: "Message smoke",
      bundleId: "com.bot.doubao",
      generatedAt: "2026-08-12T00:00:00.000Z",
      source: { kind: "manual" },
      cases: [
        {
          caseId: "open-settings",
          title: "打开设置",
          priority: "P1",
          tags: ["settings"],
          preconditions: [],
          actions: [
            {
              actionId: "capture-settings",
              type: "snapshot",
              pageId: "settings",
              title: "设置",
            },
          ],
          expected: [{ type: "page", pageId: "settings" }],
        },
      ],
    };

    expect(validateCaseSet(caseSet, [sendControl], new Set(["chat"]))).toEqual({
      valid: false,
      issues: [
        "Action open-settings/capture-settings references unknown page settings.",
        "Case open-settings assertion references unknown page settings.",
      ],
    });
  });

  test("builds mobilecli actions without involving Midscene", () => {
    expect(
      buildMobilecliActionCommand({
        action: {
          actionId: "send",
          type: "tap",
          pageId: "chat",
          target: { controlId: "chat.send_button" },
        },
        udid: "device-1",
        bundleId: "com.bot.doubao",
        tapPoint: { x: 351, y: 776 },
      }),
    ).toEqual(["mobilecli", "io", "tap", "--device", "device-1", "351,776"]);
  });
});
