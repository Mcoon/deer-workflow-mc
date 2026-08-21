import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import graphJson from "../../examples/ios-ui-graph-experiment/graph-chat-full.json";
import {
  businessCandidates,
  canonicalizeCrawlerEffect,
  collapseStateScenes,
  compileCrawlerOperatorCommand,
  computeCrawlerCoverage,
  crawlerActionSafetyIssue,
  generateActionFrontiers,
  gesturePoints,
  initializeCrawlerState,
  maintainFocusedScene,
  migrateEvidenceBackedExecutionTrustGraph,
  observationEvidenceLevel,
  pruneInvalidCrawlerArtifacts,
  relocateTarget,
  repairCrawlerStateAgainstGraph,
  resumeCrawlerState,
  scopeCrawlerState,
  selectFocusedSceneId,
} from "../../examples/ios-ui-graph-discovery/crawler";
import { meta } from "../../examples/ios-ui-graph-discovery/workflow";
import { workflow } from "@deerwork-ai/deer-workflow/flow";

import type {
  ExecutableUiGraphExperiment,
  TargetedDiscoveryObservation,
} from "../../examples/ios-ui-graph-experiment/types";
import type {
  IosUiCrawlerElementTarget,
  IosUiCrawlerResult,
  IosUiCrawlerState,
} from "../../examples/ios-ui-graph-discovery/types";

const graph = graphJson as unknown as ExecutableUiGraphExperiment;

describe("iOS Scene-driven semantic crawler", () => {
  test("uses Scene, Element, Action, and Effect phases", () => {
    expect(meta.phases.map((phase) => phase.title)).toEqual([
      "Load State",
      "Preflight",
      "Bootstrap Entry",
      "Scan Scene",
      "Generate Actions",
      "Execute Action",
      "Observe Effect",
      "Merge Graph",
      "Coverage",
      "Checkpoint",
      "Refresh Map",
      "Report",
    ]);
  });

  test("compiles Graph swipe recovery coordinates as integers", () => {
    expect(
      compileCrawlerOperatorCommand(
        graph,
        {
          operatorId: "test.swipe",
          title: "test swipe",
          fromSceneId: "chat.detail",
          toSceneId: "chat.detail",
          operation: {
            type: "swipe",
            from: { x: 207, y: 282.8 },
            to: { x: 207, y: 648.2 },
          },
          settleMs: 900,
          risk: "interaction",
          status: "candidate",
          reliability: 0.7,
          effects: [],
          postconditions: [],
        },
        "device-1",
      ),
    ).toEqual([
      "mobilecli",
      "io",
      "swipe",
      "--device",
      "device-1",
      "207,283,207,648",
    ]);
  });

  test("initializes the cold-launch entry Scene frontier", () => {
    const state = initializeCrawlerState(graph, crawlerInput("init"));

    expect(state.entrySceneId).toBe("chat.detail");
    expect(state.sceneFrontiers).toHaveLength(1);
    expect(state.sceneFrontiers[0]).toMatchObject({
      sceneId: "chat.detail",
      depth: 0,
      status: "pending_scan",
      recoveryOperatorIds: [],
    });
    expect(state.actionFrontiers).toEqual([]);
  });

  test("scopes continued exploration to one Scene and optional Element", () => {
    const state = initializeCrawlerState(graph, crawlerInput("scoped"));
    const sceneScoped = scopeCrawlerState(state, graph, {
      startSceneId: "bot.settings",
    });
    expect(sceneScoped.sceneFrontiers).toHaveLength(1);
    expect(sceneScoped.sceneFrontiers[0]).toMatchObject({
      sceneId: "bot.settings",
      status: "pending_scan",
      recoveryOperatorIds: ["chat.open_bot_settings"],
    });

    const elementScoped = scopeCrawlerState(state, graph, {
      focusElementId: "chat.bot_settings_entry",
    });
    expect(elementScoped.sceneFrontiers).toHaveLength(1);
    expect(elementScoped.sceneFrontiers[0]).toMatchObject({
      sceneId: "chat.detail",
      status: "pending_scan",
      recoveryOperatorIds: [],
    });
    expect(
      elementScoped.actionFrontiers.every(
        (frontier) => frontier.target.elementId === "chat.bot_settings_entry",
      ),
    ).toBeTrue();
  });

  test("promotes only completed before-and-after crawler evidence to guarded trust", () => {
    const operator = graph.operators.find(
      (candidate) => candidate.operatorId === "chat.open_bot_settings",
    )!;
    const candidateGraph: ExecutableUiGraphExperiment = {
      ...graph,
      operators: graph.operators.map((candidate) =>
        candidate.operatorId === operator.operatorId
          ? { ...candidate, status: "candidate", execution: undefined }
          : candidate,
      ),
    };
    const state = initializeCrawlerState(
      candidateGraph,
      crawlerInput("evidence-migration"),
    );
    const migrated = migrateEvidenceBackedExecutionTrustGraph(candidateGraph, {
      ...state,
      actionFrontiers: [
        {
          frontierId: "action.settings",
          sceneId: operator.fromSceneId,
          sceneDepth: 0,
          recoveryOperatorIds: [],
          target: target("豆包设置", "navigation_entry"),
          actionType: "tap",
          risk: "navigation",
          priority: 100,
          status: "completed",
          attempts: 1,
          createdAt: "2026-08-16T00:00:00.000Z",
          completedAt: "2026-08-16T00:00:01.000Z",
          beforeObservationPath: "/tmp/before.json",
          afterObservationPath: "/tmp/after.json",
          operatorId: operator.operatorId,
          effect: {
            type: "new_scene",
            fromSceneId: operator.fromSceneId,
            toSceneId: operator.toSceneId,
            title: "当前 Bot 设置页",
            visualTextAnchors: ["豆包账号管理"],
            description: "Real before/after navigation evidence.",
            confidence: 1,
          },
        },
      ],
    });
    const promoted = migrated.operators.find(
      (candidate) => candidate.operatorId === operator.operatorId,
    )!;

    expect(promoted.status).toBe("verified");
    expect(promoted.execution?.tier).toBe("guarded");
    expect(promoted.execution?.evidencePaths).toEqual([
      "/tmp/before.json",
      "/tmp/after.json",
    ]);
    expect(
      migrated.operators.find(
        (candidate) =>
          candidate.operatorId !== operator.operatorId &&
          candidate.status === "candidate",
      )?.execution,
    ).toBeUndefined();
  });

  test("generates deduplicated ElementAction frontiers from applicable actions", () => {
    const state = initializeCrawlerState(graph, crawlerInput("actions"));
    const scene = state.sceneFrontiers[0]!;
    const observation = makeObservation([
      ["ui-sidebar", "Button", "对话列表"],
      ["ui-send", "Button", "发送"],
      ["ui-message", "StaticText", "一条消息"],
    ]);

    const actions = generateActionFrontiers({
      state,
      frontier: scene,
      observation,
      scan: {
        sceneId: "chat.detail",
        title: "会话页",
        aliases: [],
        visualTextAnchors: ["豆包", "发消息或按住说话"],
        reason: "Test scan.",
        elements: [
          {
            candidateId: "ui-sidebar",
            elementId: "chat.sidebar.entry",
            title: "对话列表",
            semanticRole: "Button",
            actions: ["tap", "tap", "swipe_left"],
            risk: "navigation",
            priority: 90,
            reason: "Navigation entry.",
          },
          {
            candidateId: "ui-send",
            elementId: "chat.send",
            title: "发送",
            semanticRole: "Button",
            actions: ["tap"],
            risk: "mutation",
            priority: 80,
            reason: "Send action.",
          },
          {
            candidateId: "ui-message",
            elementId: "chat.message",
            title: "一条消息",
            semanticRole: "StaticText",
            actions: ["tap", "long_press"],
            risk: "interaction",
            priority: 50,
            reason: "Message content.",
          },
        ],
      },
      maximum: 10,
    });

    expect(
      actions.map((frontier) => [
        frontier.target.title,
        frontier.actionType,
        frontier.status,
      ]),
    ).toEqual([
      ["对话列表", "tap", "pending"],
      ["发送", "tap", "blocked"],
    ]);
    expect(new Set(actions.map((frontier) => frontier.frontierId)).size).toBe(
      actions.length,
    );
  });

  test("prioritizes same-Scene state actions before leaving the page", () => {
    const state = initializeCrawlerState(graph, crawlerInput("session-order"));
    const scene = state.sceneFrontiers[0]!;
    const observation = makeObservation([
      ["ui-close", "Button", "关闭相机"],
      ["ui-flash", "Button", "闪光灯开关"],
    ]);
    const actions = generateActionFrontiers({
      state,
      frontier: scene,
      observation,
      scan: {
        sceneId: scene.sceneId,
        title: "相机",
        aliases: [],
        visualTextAnchors: [],
        reason: "Test action ordering.",
        elements: [
          {
            candidateId: "ui-close",
            elementId: "camera.close",
            title: "关闭相机",
            semanticRole: "close_button",
            actions: ["tap"],
            risk: "navigation",
            expectedEffectType: "new_scene",
            requiredStateFacts: [],
            expectedStateFacts: [],
            undoHint: "",
            priority: 100,
            reason: "Leaves the Scene.",
          },
          {
            candidateId: "ui-flash",
            elementId: "camera.flash",
            title: "闪光灯开关",
            semanticRole: "toggle_button",
            actions: ["tap"],
            risk: "selection",
            expectedEffectType: "state_change",
            requiredStateFacts: [],
            expectedStateFacts: ["camera.flash=next"],
            undoHint: "再次点击",
            priority: 50,
            reason: "Stays in the Scene.",
          },
        ],
      },
      maximum: 10,
    });

    expect(actions.map((frontier) => frontier.target.title)).toEqual([
      "闪光灯开关",
      "关闭相机",
    ]);
    expect(observationEvidenceLevel(actions[0]!)).toBe("ui_dump");
    expect(observationEvidenceLevel(actions[1]!)).toBe("full");
  });

  test("keeps toggle and viewport Effects in the base Scene", () => {
    const observation = makeObservation([
      ["ui-flash", "Button", "闪光灯已开启"],
    ]);
    const frontier: IosUiCrawlerState["actionFrontiers"][number] = {
      frontierId: "action.flash",
      sceneId: "camera.capture",
      sceneDepth: 1,
      recoveryOperatorIds: ["chat.open_camera"],
      target: target("闪光灯开关", "toggle_button"),
      actionType: "tap",
      risk: "selection",
      expectedEffectType: "state_change",
      expectedStateFacts: ["camera.flash=on"],
      priority: 50,
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    const effect = canonicalizeCrawlerEffect(
      frontier,
      {
        type: "new_scene",
        fromSceneId: "camera.capture",
        toSceneId: "camera.capture.flash.on",
        title: "闪光灯开启",
        visualTextAnchors: ["闪光灯已开启"],
        description: "Toggle changed flash mode.",
        confidence: 0.9,
      },
      observation,
    );

    expect(effect).toMatchObject({
      type: "state_change",
      fromSceneId: "camera.capture",
      toSceneId: "camera.capture",
      stateFacts: ["camera.flash=on"],
    });

    const documentViewport = canonicalizeCrawlerEffect(
      {
        ...frontier,
        frontierId: "action.docs-scroll",
        sceneId: "volcengine.ark.docs.quickstart",
        target: target("文档正文滚动区", "vertical_scroll_region"),
        actionType: "swipe_up",
        risk: "interaction",
        expectedEffectType: "viewport_change",
        expectedStateFacts: ["docs.viewport=api_examples"],
      },
      {
        type: "new_scene",
        fromSceneId: "volcengine.ark.docs.quickstart",
        toSceneId: "volcengine.ark.docs.api_examples",
        title: "API 示例文档",
        visualTextAnchors: ["ARK_API_KEY"],
        description: "Scrolled to API examples.",
        confidence: 1,
      },
      observation,
    );

    expect(documentViewport).toMatchObject({
      type: "viewport_change",
      fromSceneId: "volcengine.ark.docs.quickstart",
      toSceneId: "volcengine.ark.docs.quickstart",
      stateFacts: ["docs.viewport=api_examples"],
    });
  });

  test("does not let a predicted state Effect hide a real page transition", () => {
    const observation = makeObservation([["ui-search", "Button", "搜索结果"]]);
    const frontier: IosUiCrawlerState["actionFrontiers"][number] = {
      frontierId: "action.search",
      sceneId: "chat.sidebar",
      sceneDepth: 1,
      recoveryOperatorIds: ["chat.open_sidebar"],
      target: target("搜索", "Button"),
      actionType: "tap",
      risk: "interaction",
      expectedEffectType: "state_change",
      priority: 50,
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    const effect = canonicalizeCrawlerEffect(
      frontier,
      {
        type: "new_scene",
        fromSceneId: "chat.sidebar",
        toSceneId: "search.home",
        title: "搜索页",
        visualTextAnchors: ["搜索结果"],
        description: "Opened search.",
        confidence: 1,
      },
      observation,
    );

    expect(effect).toMatchObject({
      type: "new_scene",
      fromSceneId: "chat.sidebar",
      toSceneId: "search.home",
    });
  });

  test("collapses historical state Scenes into base Scene variants", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-crawler-state-"));
    const graphPath = join(outputDir, "graph.json");
    const sample: ExecutableUiGraphExperiment = {
      ...graph,
      scenes: graph.scenes.filter((scene) =>
        ["chat.detail", "chat.detail.voice.input"].includes(scene.sceneId),
      ),
      elements: graph.elements.filter((element) =>
        ["chat.detail", "chat.detail.voice.input"].includes(element.sceneId),
      ),
      operators: graph.operators.filter(
        (operator) =>
          ["chat.detail", "chat.detail.voice.input"].includes(
            operator.fromSceneId,
          ) &&
          ["chat.detail", "chat.detail.voice.input"].includes(
            operator.toSceneId,
          ),
      ),
      tasks: [],
    };
    try {
      await writeFile(graphPath, `${JSON.stringify(sample)}\n`, "utf8");
      const collapsed = await collapseStateScenes(graphPath, sample);
      expect(
        collapsed.scenes.some(
          (scene) => scene.sceneId === "chat.detail.voice.input",
        ),
      ).toBeFalse();
      expect(
        collapsed.scenes
          .find((scene) => scene.sceneId === "chat.detail")
          ?.stateVariants?.some((variant) =>
            variant.facts.includes("composer.mode=voice"),
          ),
      ).toBeTrue();
      expect(
        collapsed.operators.every(
          (operator) =>
            operator.fromSceneId !== "chat.detail.voice.input" &&
            operator.toSceneId !== "chat.detail.voice.input",
        ),
      ).toBeTrue();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("blocks side effects and inapplicable gestures", () => {
    const button = target("发送", "Button");
    const safeButton = target("对话列表", "Button");
    const list = target("ActionBar", "HorizontalScrollRegion");
    const composerList = target(
      "相机 | 语音输入 | 发送",
      "HorizontalScrollRegion",
    );

    expect(
      crawlerActionSafetyIssue({
        target: button,
        actionType: "tap",
        risk: "mutation",
      }),
    ).toContain("mutation");
    expect(
      crawlerActionSafetyIssue({
        target: safeButton,
        actionType: "swipe_left",
        risk: "interaction",
      }),
    ).toContain("not applicable");
    expect(
      crawlerActionSafetyIssue({
        target: list,
        actionType: "swipe_left",
        risk: "interaction",
      }),
    ).toBeNull();
    expect(
      crawlerActionSafetyIssue({
        target: composerList,
        actionType: "swipe_left",
        risk: "interaction",
      }),
    ).toBeNull();
    expect(
      crawlerActionSafetyIssue({
        target: target("使用过程信息", "navigation_entry"),
        actionType: "tap",
        risk: "navigation",
      }),
    ).toBeNull();
  });

  test("limits gesture directions to the scroll axis", () => {
    const horizontal = target("ActionBar", "HorizontalScrollRegion");
    const vertical = target("设置列表", "scrollable_list");
    const observation = makeObservation([
      ["ui-horizontal", "HorizontalScrollRegion", "ActionBar"],
      ["ui-vertical", "scrollable_list", "设置列表"],
    ]);
    const state = initializeCrawlerState(graph, crawlerInput("axis"));
    const actions = generateActionFrontiers({
      state,
      frontier: state.sceneFrontiers[0]!,
      observation,
      scan: {
        sceneId: "chat.detail",
        title: "会话页",
        aliases: [],
        visualTextAnchors: [],
        reason: "Axis test.",
        elements: [
          {
            candidateId: "ui-horizontal",
            elementId: horizontal.elementId,
            title: horizontal.title,
            semanticRole: horizontal.semanticRole,
            actions: ["swipe_left", "swipe_right", "swipe_up", "swipe_down"],
            risk: "interaction",
            expectedEffectType: "viewport_change",
            requiredStateFacts: [],
            expectedStateFacts: [],
            undoHint: "",
            priority: 1,
            reason: "Horizontal.",
          },
          {
            candidateId: "ui-vertical",
            elementId: vertical.elementId,
            title: vertical.title,
            semanticRole: vertical.semanticRole,
            actions: ["swipe_left", "swipe_right", "swipe_up", "swipe_down"],
            risk: "interaction",
            expectedEffectType: "viewport_change",
            requiredStateFacts: [],
            expectedStateFacts: [],
            undoHint: "",
            priority: 1,
            reason: "Vertical.",
          },
        ],
      },
      maximum: 10,
    });

    expect(
      actions
        .filter((action) => action.target.title === "ActionBar")
        .map((action) => action.actionType),
    ).toEqual(["swipe_left", "swipe_right"]);
    expect(
      actions
        .filter((action) => action.target.title === "设置列表")
        .map((action) => action.actionType),
    ).toEqual(["swipe_up", "swipe_down"]);
  });

  test("uses a viewport-sized vertical gesture for small list anchors", () => {
    const state = initializeCrawlerState(graph, crawlerInput("viewport"));
    const observation = makeObservation([
      ["ui-list", "scrollable_list", "设置列表"],
    ]);
    const actions = generateActionFrontiers({
      state,
      frontier: state.sceneFrontiers[0]!,
      observation,
      scan: {
        sceneId: "chat.detail",
        title: "设置",
        aliases: [],
        visualTextAnchors: [],
        reason: "Viewport gesture.",
        elements: [
          {
            candidateId: "ui-list",
            elementId: "settings.list",
            title: "设置列表",
            semanticRole: "scrollable_list",
            actions: ["swipe_up"],
            risk: "interaction",
            expectedEffectType: "viewport_change",
            requiredStateFacts: [],
            expectedStateFacts: [],
            undoHint: "",
            priority: 1,
            reason: "Scrollable.",
          },
        ],
      },
      maximum: 10,
    });

    expect(actions[0]?.actionType).toBe("swipe_up");
    expect(gesturePoints("swipe_up", actions[0]!.target.bounds)).toEqual({
      from: { x: 80, y: 720 },
      to: { x: 80, y: 230 },
    });
  });

  test("recovers interrupted Scene and Action frontiers on resume", () => {
    const initial = initializeCrawlerState(graph, crawlerInput("resume"));
    const state: IosUiCrawlerState = {
      ...initial,
      status: "running",
      sceneFrontiers: initial.sceneFrontiers.map((frontier) => ({
        ...frontier,
        status: "scanning",
        attempts: 1,
      })),
      actionFrontiers: [
        {
          frontierId: "action.test",
          sceneId: "chat.detail",
          sceneDepth: 0,
          recoveryOperatorIds: [],
          target: target("对话列表", "Button"),
          actionType: "tap",
          risk: "navigation",
          priority: 90,
          status: "running",
          attempts: 1,
          createdAt: new Date().toISOString(),
        },
      ],
    };

    const resumed = resumeCrawlerState(state, crawlerInput("resume"));

    expect(resumed.status).toBe("ready");
    expect(resumed.sessionCount).toBe(2);
    expect(resumed.sceneFrontiers[0]?.status).toBe("pending_scan");
    expect(resumed.actionFrontiers[0]?.status).toBe("pending");
  });

  test("computes Scene and ElementAction coverage", () => {
    const initial = initializeCrawlerState(graph, crawlerInput("coverage"));
    const state: IosUiCrawlerState = {
      ...initial,
      sceneFrontiers: initial.sceneFrontiers.map((frontier) => ({
        ...frontier,
        status: "scanned",
      })),
      actionFrontiers: [
        {
          frontierId: "action.completed",
          sceneId: "chat.detail",
          sceneDepth: 0,
          recoveryOperatorIds: [],
          target: target("对话列表", "Button"),
          actionType: "tap",
          risk: "navigation",
          priority: 90,
          status: "completed",
          attempts: 1,
          createdAt: new Date().toISOString(),
          effect: {
            type: "new_scene",
            fromSceneId: "chat.detail",
            toSceneId: "chat.sidebar",
            title: "侧边栏",
            visualTextAnchors: ["搜索", "技能", "云盘"],
            description: "Opened sidebar.",
            confidence: 1,
          },
        },
      ],
    };
    const coverage = computeCrawlerCoverage(state, graph);

    expect(coverage.scenes.scanned).toBe(1);
    expect(coverage.actions.completed).toBe(1);
    expect(coverage.actionTypeCounts.tap).toBe(1);
    expect(coverage.effectTypeCounts.new_scene).toBe(1);
  });

  test("keeps the current Scene focused until all of its Actions are exhausted", () => {
    const initial = initializeCrawlerState(graph, crawlerInput("focus"));
    const now = new Date().toISOString();
    const state: IosUiCrawlerState = {
      ...initial,
      sceneFrontiers: [
        {
          ...initial.sceneFrontiers[0]!,
          status: "scanned",
        },
        {
          frontierId: "scene.chat.sidebar",
          sceneId: "chat.sidebar",
          title: "侧边栏",
          depth: 1,
          status: "scanned",
          recoveryOperatorIds: ["chat.open_sidebar"],
          attempts: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      actionFrontiers: [
        {
          frontierId: "action.chat.1",
          sceneId: "chat.detail",
          sceneDepth: 0,
          recoveryOperatorIds: [],
          target: target("更多面板", "Button"),
          actionType: "tap",
          risk: "navigation",
          priority: 80,
          status: "pending",
          attempts: 0,
          createdAt: now,
        },
        {
          frontierId: "action.sidebar.1",
          sceneId: "chat.sidebar",
          sceneDepth: 1,
          recoveryOperatorIds: ["chat.open_sidebar"],
          target: target("技能", "StaticText"),
          actionType: "tap",
          risk: "navigation",
          priority: 100,
          status: "pending",
          attempts: 0,
          createdAt: now,
        },
      ],
    };

    expect(selectFocusedSceneId(state)).toBe("chat.detail");
    expect(maintainFocusedScene(state, "chat.detail")).toBe("chat.detail");

    const exhausted: IosUiCrawlerState = {
      ...state,
      actionFrontiers: state.actionFrontiers.map((frontier) =>
        frontier.sceneId === "chat.detail"
          ? { ...frontier, status: "completed" }
          : frontier,
      ),
    };
    expect(maintainFocusedScene(exhausted, "chat.detail")).toBe("chat.sidebar");
  });

  test("relocates a derived scroll region by role, band, and child overlap", () => {
    const scrollTarget: IosUiCrawlerElementTarget = {
      candidateId: "gesture-old",
      elementId: "chat.toolbar.scroll",
      title: "输入工具横向区域",
      semanticRole: "horizontal_scroll_region",
      source: "ui_dump",
      selector: {
        role: "HorizontalScrollRegion",
        label: "横向可滑动区域：相机 | 语音输入 | 更多面板",
        value: "相机|语音输入|更多面板",
      },
      bounds: { x: 24, y: 796, width: 366, height: 52 },
    };
    const observation = makeObservation([]);
    const liveObservation: TargetedDiscoveryObservation = {
      ...observation,
      candidates: [
        {
          candidateId: "gesture-new",
          source: "ui_dump",
          role: "HorizontalScrollRegion",
          label: "横向可滑动区域：相机 | 文本输入 | 更多面板",
          value: "相机|文本输入|更多面板",
          bounds: { x: 24, y: 796, width: 366, height: 52 },
        },
        {
          candidateId: "gesture-other",
          source: "ui_dump",
          role: "HorizontalScrollRegion",
          label: "横向可滑动区域：搜索 | 技能 | 云盘",
          value: "搜索|技能|云盘",
          bounds: { x: 20, y: 100, width: 300, height: 50 },
        },
      ],
    };

    expect(relocateTarget(scrollTarget, liveObservation)?.candidateId).toBe(
      "gesture-new",
    );

    const legalLinkTarget: IosUiCrawlerElementTarget = {
      candidateId: "historical-settings-row",
      elementId: "bot.settings.personal-information-list",
      title: "《个人信息清单》",
      semanticRole: "settings_navigation_entry",
      source: "ui_dump",
      selector: {
        accessibilityId: "《个人信息清单》",
        label: "《个人信息清单》",
        role: "Button",
      },
      bounds: { x: 16, y: 780, width: 382, height: 56 },
    };
    const liveLegalLink: TargetedDiscoveryObservation = {
      ...observation,
      candidates: [
        {
          candidateId: "live-legal-link",
          source: "ui_dump",
          role: "Button",
          accessibilityId: "《个人信息清单》",
          label: "《个人信息清单》",
          bounds: { x: 90, y: 803, width: 98, height: 29 },
        },
      ],
    };
    expect(relocateTarget(legalLinkTarget, liveLegalLink)?.candidateId).toBe(
      "live-legal-link",
    );

    const debugRowTarget: IosUiCrawlerElementTarget = {
      candidateId: "historical-debug-row",
      elementId: "bot.settings.row.debug",
      title: "关于豆包 Debug",
      semanticRole: "settings_navigation_entry",
      source: "ui_dump",
      selector: {
        accessibilityId: "关于豆包 Debug",
        label: "关于豆包 Debug",
        role: "StaticText",
      },
      bounds: { x: 16, y: 1500, width: 382, height: 56 },
    };
    const liveDebugRow: TargetedDiscoveryObservation = {
      ...observation,
      candidates: [
        {
          candidateId: "offscreen-debug-row",
          source: "ui_dump",
          role: "StaticText",
          accessibilityId: "关于豆包 Debug",
          label: "关于豆包 Debug",
          bounds: { x: 16, y: 1500, width: 382, height: 56 },
        },
        {
          candidateId: "false-visible-debug-child",
          source: "ui_dump",
          role: "StaticText",
          accessibilityId: "关于豆包 Debug",
          label: "关于豆包 Debug",
          bounds: { x: 16, y: 92, width: 262, height: 44 },
        },
      ],
    };
    expect(
      relocateTarget(debugRowTarget, liveDebugRow, {
        width: 414,
        height: 896,
      }),
    ).toBeUndefined();
    expect(relocateTarget(debugRowTarget, liveDebugRow)?.candidateId).toBe(
      "offscreen-debug-row",
    );

    const faqTarget: IosUiCrawlerElementTarget = {
      candidateId: "historical-faq",
      elementId: "bot.settings.about_debug.faq",
      title: "豆包购物及钱包功能FAQ",
      semanticRole: "StaticText",
      source: "ui_dump",
      selector: {
        accessibilityId: "豆包购物及钱包功能FAQ",
        label: "豆包购物及钱包功能FAQ",
        role: "StaticText",
      },
      bounds: { x: 84, y: 700, width: 186, height: 20 },
    };
    const liveFaq: TargetedDiscoveryObservation = {
      ...observation,
      candidates: [
        {
          candidateId: "false-visible-faq-child",
          source: "ui_dump",
          role: "StaticText",
          accessibilityId: "豆包购物及钱包功能FAQ",
          label: "豆包购物及钱包功能FAQ",
          bounds: { x: 16, y: 92, width: 186, height: 20 },
        },
      ],
    };
    expect(
      relocateTarget(faqTarget, liveFaq, {
        width: 414,
        height: 896,
      }),
    ).toBeUndefined();
  });

  test("keeps visible business rows, drops decorative children, and derives vertical scrolling", () => {
    const observation = makeObservation([]);
    const liveObservation: TargetedDiscoveryObservation = {
      ...observation,
      candidates: [
        {
          candidateId: "ui-row",
          source: "ui_dump",
          role: "StaticText",
          label: "隐私与权限",
          accessibilityId: "隐私与权限",
          bounds: { x: 16, y: 307, width: 382, height: 56 },
        },
        {
          candidateId: "ui-icon",
          source: "ui_dump",
          role: "Image",
          accessibilityId: "icon_setting_privacypermission",
          bounds: { x: 32, y: 319, width: 32, height: 32 },
        },
        {
          candidateId: "ui-offscreen-1",
          source: "ui_dump",
          role: "StaticText",
          label: "我的智能设备",
          accessibilityId: "我的智能设备",
          bounds: { x: 16, y: 1556, width: 382, height: 56 },
        },
        {
          candidateId: "ui-offscreen-2",
          source: "ui_dump",
          role: "StaticText",
          label: "切换账号",
          accessibilityId: "切换账号",
          bounds: { x: 16, y: 1628, width: 382, height: 56 },
        },
      ],
    };

    const candidates = businessCandidates(liveObservation);

    expect(candidates.map((candidate) => candidate.candidateId)).toEqual([
      "ui-row",
      "gesture-vertical-chat.detail",
    ]);
    expect(
      relocateTarget(
        {
          ...target("我的智能设备", "StaticText"),
          selector: {
            accessibilityId: "我的智能设备",
            label: "我的智能设备",
            role: "StaticText",
          },
          bounds: { x: 16, y: 1556, width: 382, height: 56 },
        },
        liveObservation,
        { width: 414, height: 896 },
      ),
    ).toBeUndefined();
  });

  test("prunes invalid candidate self-loops and requeues their state", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-crawler-prune-"));
    const graphPath = join(outputDir, "graph.json");
    const invalidOperator = {
      operatorId: "chat.sidebar.search.tap.chat.sidebar",
      title: "tap 搜索",
      fromSceneId: "chat.sidebar",
      toSceneId: "chat.sidebar",
      operation: {
        type: "tap" as const,
        elementId: "sidebar.invalid.search",
      },
      settleMs: 900,
      risk: "navigation" as const,
      status: "candidate" as const,
      reliability: 0.7,
      effects: ["Deterministic Scene classification matched chat.sidebar."],
      postconditions: ["scene.current=chat.sidebar"],
    };
    const invalidElement = {
      elementId: "sidebar.invalid.search",
      sceneId: "chat.sidebar",
      title: "搜索",
      semanticRole: "search_entry",
      selector: { label: "搜索" },
      bindings: [
        {
          bindingId: "sidebar.search.test",
          deviceProfileId: graph.defaultDeviceProfileId,
          normalizedPoint: { x: 0.2, y: 0.1 },
          source: "ui_dump" as const,
          status: "candidate" as const,
          reliability: 0.7,
          observedAt: new Date().toISOString(),
        },
      ],
    };
    const polluted: ExecutableUiGraphExperiment = {
      ...graph,
      elements: [...graph.elements, invalidElement],
      operators: [
        ...graph.operators,
        invalidOperator,
        {
          operatorId: "chat.toolbar.swipe.chat.sidebar",
          title: "swipe toolbar",
          fromSceneId: "chat.detail",
          toSceneId: "chat.sidebar",
          operation: {
            type: "swipe" as const,
            from: { x: 80, y: 820 },
            to: { x: 320, y: 820 },
          },
          settleMs: 900,
          risk: "interaction" as const,
          status: "candidate" as const,
          reliability: 0.7,
          effects: ["Deterministic Scene classification matched chat.sidebar."],
          postconditions: ["scene.current=chat.sidebar"],
        },
      ],
    };
    try {
      await writeFile(graphPath, `${JSON.stringify(polluted)}\n`, "utf8");
      const pruned = await pruneInvalidCrawlerArtifacts(graphPath, polluted);
      expect(
        pruned.operators.some(
          (operator) => operator.operatorId === invalidOperator.operatorId,
        ),
      ).toBeFalse();
      expect(
        pruned.elements.some(
          (element) => element.elementId === invalidElement.elementId,
        ),
      ).toBeFalse();
      expect(
        pruned.operators.some(
          (operator) =>
            operator.operatorId === "chat.toolbar.swipe.chat.sidebar",
        ),
      ).toBeFalse();

      const state = initializeCrawlerState(pruned, {
        ...crawlerInput("repair"),
        graphPath,
      });
      const completedState: IosUiCrawlerState = {
        ...state,
        actionFrontiers: [
          {
            frontierId: "action.search",
            sceneId: "chat.sidebar",
            sceneDepth: 1,
            recoveryOperatorIds: ["chat.open_sidebar"],
            target: target("搜索", "StaticText"),
            actionType: "tap",
            risk: "navigation",
            priority: 90,
            status: "completed",
            attempts: 1,
            createdAt: new Date().toISOString(),
            operatorId: invalidOperator.operatorId,
            effect: {
              type: "state_change",
              fromSceneId: "chat.sidebar",
              toSceneId: "chat.sidebar",
              title: "侧边栏",
              visualTextAnchors: ["搜索"],
              description: "Invalid self-loop.",
              confidence: 1,
            },
          },
        ],
      };
      const repaired = repairCrawlerStateAgainstGraph(completedState, pruned);
      expect(repaired.actionFrontiers[0]?.status).toBe("pending");
      expect(repaired.actionFrontiers[0]?.operatorId).toBeUndefined();

      const liveRepaired = repairCrawlerStateAgainstGraph(
        {
          ...completedState,
          actionFrontiers: completedState.actionFrontiers.map((frontier) => ({
            ...frontier,
            beforeObservationPath: "/tmp/before-ui.json",
            afterObservationPath: "/tmp/after-ui.json",
          })),
        },
        pruned,
      );
      expect(liveRepaired.actionFrontiers[0]?.status).toBe("completed");
      expect(liveRepaired.actionFrontiers[0]?.operatorId).toBeUndefined();
      expect(liveRepaired.actionFrontiers[0]?.issue).toContain(
        "invalid self-loop Operator was removed",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("runs plan-only through the new Scene crawler entry", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-scene-crawler-"));
    const graphPath = join(outputDir, "graph.json");
    try {
      await writeFile(graphPath, `${JSON.stringify(graph)}\n`, "utf8");
      const result = await workflow<IosUiCrawlerResult>(
        join(process.cwd(), "examples/ios-ui-graph-discovery/workflow.ts"),
        {
          graphPath,
          outputDir,
          runId: "plan-only",
          planOnly: true,
          refreshMap: false,
          maximumActions: 1,
          maximumScenes: 1,
        },
      );

      expect(result.success).toBeTrue();
      expect(result.planOnly).toBeTrue();
      expect(result.state.schemaVersion).toBe("ios-ui-scene-crawler-state/v1");
      expect(result.state.sceneFrontiers[0]?.sceneId).toBe("chat.detail");
      expect(
        JSON.parse(await readFile(result.manifestPath, "utf8")).schemaVersion,
      ).toBe("ios-ui-scene-crawler-manifest/v1");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("migrates existing crawler evidence without entering device phases", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-crawler-migration-"));
    const graphPath = join(outputDir, "graph.json");
    const statePath = join(outputDir, "state.json");
    const operator = graph.operators.find(
      (candidate) => candidate.operatorId === "chat.open_bot_settings",
    )!;
    const candidateGraph: ExecutableUiGraphExperiment = {
      ...graph,
      operators: graph.operators.map((candidate) =>
        candidate.operatorId === operator.operatorId
          ? { ...candidate, status: "candidate", execution: undefined }
          : candidate,
      ),
    };
    const state = initializeCrawlerState(
      candidateGraph,
      crawlerInput("migration-only"),
    );
    try {
      await writeFile(graphPath, `${JSON.stringify(candidateGraph)}\n`, "utf8");
      await writeFile(
        statePath,
        `${JSON.stringify({
          ...state,
          graphPath,
          actionFrontiers: [
            {
              frontierId: "action.settings",
              sceneId: operator.fromSceneId,
              sceneDepth: 0,
              recoveryOperatorIds: [],
              target: target("豆包设置", "navigation_entry"),
              actionType: "tap",
              risk: "navigation",
              priority: 100,
              status: "completed",
              attempts: 1,
              createdAt: "2026-08-16T00:00:00.000Z",
              completedAt: "2026-08-16T00:00:01.000Z",
              beforeObservationPath: "/tmp/before.json",
              afterObservationPath: "/tmp/after.json",
              operatorId: operator.operatorId,
              effect: {
                type: "new_scene",
                fromSceneId: operator.fromSceneId,
                toSceneId: operator.toSceneId,
                title: "当前 Bot 设置页",
                visualTextAnchors: ["豆包账号管理"],
                description: "Real before/after navigation evidence.",
                confidence: 1,
              },
            },
          ],
        })}\n`,
        "utf8",
      );
      const result = await workflow<IosUiCrawlerResult>(
        join(process.cwd(), "examples/ios-ui-graph-discovery/workflow.ts"),
        {
          graphPath,
          resumeStatePath: statePath,
          evidenceMigrationOnly: true,
          refreshMap: false,
        },
      );
      const migrated = JSON.parse(
        await readFile(graphPath, "utf8"),
      ) as ExecutableUiGraphExperiment;
      const migratedOperator = migrated.operators.find(
        (candidate) => candidate.operatorId === operator.operatorId,
      );

      expect(result.success).toBeTrue();
      expect(result.planOnly).toBeTrue();
      expect(migratedOperator?.status).toBe("verified");
      expect(migratedOperator?.execution?.tier).toBe("guarded");
      expect(
        await Bun.file(join(outputDir, "preflight.stdout.txt")).exists(),
      ).toBeFalse();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

function crawlerInput(runId: string) {
  return {
    runId,
    graphPath: "/tmp/graph.json",
    maximumActions: 4,
    maximumScenes: 4,
    maximumDepth: 2,
    maximumDurationMinutes: 10,
    maximumAttemptsPerAction: 2,
    maximumActionsPerScene: 10,
    agentTimeoutMs: 60_000,
    settleMs: 900,
  };
}

function target(
  title: string,
  semanticRole: string,
): IosUiCrawlerElementTarget {
  return {
    candidateId: `ui-${title}`,
    elementId: `test.${title}`,
    title,
    semanticRole,
    source: "ui_dump",
    selector: { label: title, role: semanticRole },
    bounds: { x: 20, y: 40, width: 120, height: 40 },
  };
}

function makeObservation(
  candidates: Array<[string, string, string]>,
): TargetedDiscoveryObservation {
  return {
    observationId: "observation-00",
    screenshotPath: "/tmp/screen.png",
    uiDumpPath: "/tmp/ui.json",
    ocrPath: "/tmp/ocr.json",
    matchedSceneId: "chat.detail",
    candidateSceneId: "chat.detail",
    candidateSceneTitle: "会话页",
    visualTextAnchors: ["豆包", "发消息或按住说话"],
    candidates: candidates.map(([candidateId, role, label], index) => ({
      candidateId,
      source: "ui_dump",
      role,
      label,
      accessibilityId: label,
      bounds: {
        x: 20,
        y: 40 + index * 50,
        width: 120,
        height: 40,
      },
    })),
  };
}
