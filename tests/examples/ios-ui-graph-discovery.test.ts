import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import graphJson from "../../examples/ios-ui-graph-experiment/graph-chat-full.json";
import {
  computeDiscoveryCoverage,
  deriveObservationFrontiers,
  frontierSafetyIssue,
  initializeDiscoveryState,
  mergeSeedFrontiers,
  meta,
  normalizeDiscoveryGoal,
  resumeDiscoveryState,
} from "../../examples/ios-ui-graph-discovery/workflow";
import {
  computePageAudit,
  repairPageCoverageActions,
} from "../../examples/ios-ui-graph-discovery/crawler";
import { workflow } from "@deerwork-ai/deer-workflow/flow";

import type { ExecutableUiGraphExperiment } from "../../examples/ios-ui-graph-experiment/types";
import type { TargetedDiscoveryObservation } from "../../examples/ios-ui-graph-experiment/types";
import type {
  IosUiCrawlerResult,
  IosUiCrawlerState,
  IosUiGraphDiscoveryModule,
  IosUiGraphDiscoveryState,
} from "../../examples/ios-ui-graph-discovery/types";

const graph = graphJson as unknown as ExecutableUiGraphExperiment;

const modules: readonly IosUiGraphDiscoveryModule[] = [
  {
    moduleId: "global",
    title: "全局",
    seedGoals: ["进入搜索页面", "删除最后一条消息", "进入搜索页面"],
  },
];

describe("iOS semantic Graph discovery", () => {
  test("declares resumable crawl and coverage phases", () => {
    expect(meta.name).toBe("ios-ui-graph-discovery");
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

  test("seeds unique safe frontiers and blocks side effects", () => {
    const state = initializeDiscoveryState({
      graph,
      graphPath: "/tmp/graph.json",
      runId: "run-1",
      modules,
      input: {
        maximumFrontiers: 10,
        maximumQueuedFrontiers: 50,
        maximumNewScenes: 20,
        maximumDurationMinutes: 30,
        maximumAttemptsPerFrontier: 2,
        maximumDiscoveryStepsPerGoal: 6,
        agentTimeoutMs: 60_000,
      },
    });

    expect(state.frontiers).toHaveLength(2);
    expect(
      state.frontiers.find((frontier) => frontier.goal === "进入搜索页面")
        ?.status,
    ).toBe("pending");
    expect(
      state.frontiers.find((frontier) => frontier.goal === "删除最后一条消息")
        ?.status,
    ).toBe("blocked");
    expect(frontierSafetyIssue("打开设置页面")).toBeNull();
    expect(frontierSafetyIssue("发布一条消息")).toContain("发布");
  });

  test("resumes interrupted and retryable failed frontiers", () => {
    const initial = initializeDiscoveryState({
      graph,
      graphPath: "/tmp/graph.json",
      runId: "run-2",
      modules: [
        {
          moduleId: "global",
          title: "全局",
          seedGoals: ["进入搜索页面", "进入技能页面"],
        },
      ],
      input: {
        maximumFrontiers: 10,
        maximumQueuedFrontiers: 50,
        maximumNewScenes: 20,
        maximumDurationMinutes: 30,
        maximumAttemptsPerFrontier: 2,
        maximumDiscoveryStepsPerGoal: 6,
        agentTimeoutMs: 60_000,
      },
    });
    const state: IosUiGraphDiscoveryState = {
      ...initial,
      status: "running",
      frontiers: initial.frontiers.map((frontier, index) =>
        index === 0
          ? { ...frontier, status: "running", attempts: 1 }
          : { ...frontier, status: "failed", attempts: 1, issue: "timeout" },
      ),
    };

    const resumed = resumeDiscoveryState(state, {
      graphPath: "/tmp/graph.json",
      maximumFrontiers: 5,
      maximumQueuedFrontiers: 20,
      maximumNewScenes: 10,
      maximumDurationMinutes: 15,
      maximumAttemptsPerFrontier: 2,
      maximumDiscoveryStepsPerGoal: 4,
      agentTimeoutMs: 20_000,
    });

    expect(resumed.status).toBe("ready");
    expect(resumed.sessionCount).toBe(2);
    expect(
      resumed.frontiers.every((frontier) => frontier.status === "pending"),
    ).toBeTrue();
    expect(resumed.frontiers[0]?.issue).toContain("interrupted");
  });

  test("derives bounded stable navigation frontiers from an Observation", () => {
    const observation = makeObservation([
      ["ui-1", "Button", "搜索"],
      ["ui-2", "StaticText", "技能"],
      ["ui-3", "Button", "用户876180"],
      ["ui-4", "StaticText", "删除"],
      ["ui-5", "StaticText", "一段普通内容"],
      ["ocr-1", "TextObservation", "云盘"],
    ]);
    const derived = deriveObservationFrontiers({
      observation,
      moduleId: "global",
      existingGoals: new Set([normalizeDiscoveryGoal("打开搜索")]),
      maximum: 10,
    });

    expect(derived.map((frontier) => frontier.goal)).toEqual(["打开技能"]);
    expect(derived[0]?.sourceSceneId).toBe("chat.sidebar");
  });

  test("computes Graph and frontier coverage deltas", () => {
    const state = initializeDiscoveryState({
      graph,
      graphPath: "/tmp/graph.json",
      runId: "run-3",
      modules,
      input: {
        maximumFrontiers: 10,
        maximumQueuedFrontiers: 50,
        maximumNewScenes: 20,
        maximumDurationMinutes: 30,
        maximumAttemptsPerFrontier: 2,
        maximumDiscoveryStepsPerGoal: 6,
        agentTimeoutMs: 60_000,
      },
    });
    const expandedGraph: ExecutableUiGraphExperiment = {
      ...graph,
      scenes: [
        ...graph.scenes,
        {
          sceneId: "search.home",
          title: "搜索",
          aliases: [],
          status: "candidate",
          anchorElementIds: [],
          visualTextAnchors: ["搜索"],
          referenceAssets: [],
        },
      ],
    };

    const coverage = computeDiscoveryCoverage(state, expandedGraph);

    expect(coverage.delta.scenes).toBe(1);
    expect(coverage.delta.elements).toBe(0);
    expect(coverage.frontiers.pending).toBe(1);
    expect(coverage.frontiers.blocked).toBe(1);
  });

  test("runs plan-only without touching a device and writes resumable artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-graph-discovery-"));
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
      expect(result.state.status).toBe("paused");
      expect(result.coverage.scenes.pending).toBe(
        result.state.sceneFrontiers.filter(
          (frontier) => frontier.status === "pending_scan",
        ).length,
      );
      expect(
        result.state.sceneFrontiers.some(
          (frontier) =>
            frontier.sceneId === result.state.entrySceneId &&
            frontier.status === "pending_scan",
        ),
      ).toBeTrue();
      expect(
        JSON.parse(await readFile(result.manifestPath, "utf8")).schemaVersion,
      ).toBe("ios-ui-scene-crawler-manifest/v1");
      expect(await Bun.file(result.reportPath).exists()).toBeTrue();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("keeps ActionBar entries with similar ASCII prefixes distinct", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-actionbar-identity-"));
    const graphPath = join(outputDir, "graph.json");
    try {
      const collidingElementId = "chat.detail.actionbar.AI";
      const graphWithCollision: ExecutableUiGraphExperiment = {
        ...graph,
        elements: [
          ...graph.elements.filter(
            (element) => element.elementId !== collidingElementId,
          ),
          {
            elementId: collidingElementId,
            sceneId: "chat.detail",
            title: "AI写歌",
            semanticRole: "actionbar_navigation_entry",
            selector: {
              accessibilityId: "AI写歌",
              label: "AI写歌",
              role: "StaticText",
            },
            bindings: [],
          },
        ],
        operators: [
          ...graph.operators,
          {
            operatorId: "actionbar.ai-creation",
            title: "tap AI 创作",
            fromSceneId: "chat.detail",
            toSceneId: "chat.ai_creation.discovery",
            operation: { type: "tap", elementId: collidingElementId },
            settleMs: 900,
            risk: "navigation",
            status: "candidate",
            reliability: 0.7,
            effects: [],
            postconditions: ["scene.current=chat.ai_creation.discovery"],
          },
          {
            operatorId: "actionbar.ai-song",
            title: "tap AI写歌",
            fromSceneId: "chat.detail",
            toSceneId: "chat.ai_song",
            operation: { type: "tap", elementId: collidingElementId },
            settleMs: 900,
            risk: "navigation",
            status: "candidate",
            reliability: 0.7,
            effects: [],
            postconditions: ["scene.current=chat.ai_song"],
          },
        ],
      };
      await writeFile(
        graphPath,
        `${JSON.stringify(graphWithCollision)}\n`,
        "utf8",
      );

      await workflow<IosUiCrawlerResult>(
        join(process.cwd(), "examples/ios-ui-graph-discovery/workflow.ts"),
        {
          graphPath,
          outputDir,
          runId: "actionbar-identity",
          planOnly: true,
          refreshMap: false,
          maximumActions: 1,
          maximumScenes: 1,
        },
      );

      const migrated = JSON.parse(
        await readFile(graphPath, "utf8"),
      ) as ExecutableUiGraphExperiment;
      const creation = migrated.operators.find(
        (operator) => operator.operatorId === "actionbar.ai-creation",
      );
      const song = migrated.operators.find(
        (operator) => operator.operatorId === "actionbar.ai-song",
      );
      expect(creation?.operation.type).toBe("tap");
      expect(song?.operation.type).toBe("tap");
      if (
        creation?.operation.type !== "tap" ||
        song?.operation.type !== "tap"
      ) {
        throw new Error("Expected migrated ActionBar tap operators.");
      }
      const creationElementId = creation.operation.elementId;
      const songElementId = song.operation.elementId;
      expect(creationElementId).not.toBe(songElementId);
      expect(
        migrated.elements.find(
          (element) => element.elementId === creationElementId,
        )?.title,
      ).toBe("AI 创作");
      expect(
        migrated.elements.find((element) => element.elementId === songElementId)
          ?.title,
      ).toBe("AI写歌");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("keeps the session paused while a failed frontier remains retryable", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-graph-retryable-"));
    const graphPath = join(outputDir, "graph.json");
    const statePath = join(outputDir, "state.json");
    try {
      await writeFile(graphPath, `${JSON.stringify(graph)}\n`, "utf8");
      const now = new Date().toISOString();
      const initial: IosUiCrawlerState = {
        schemaVersion: "ios-ui-scene-crawler-state/v1",
        runId: "retryable",
        graphPath,
        status: "paused",
        createdAt: now,
        updatedAt: now,
        sessionCount: 1,
        entrySceneId: "chat.detail",
        budgets: {
          maximumActions: 1,
          maximumScenes: 1,
          maximumDepth: 1,
          maximumDurationMinutes: 10,
          maximumAttemptsPerAction: 2,
          maximumActionsPerScene: 4,
          agentTimeoutMs: 60_000,
          settleMs: 900,
        },
        baseline: {
          capturedAt: now,
          sceneCount: graph.scenes.length,
          elementCount: graph.elements.length,
          operatorCount: graph.operators.length,
          taskCount: graph.tasks.length,
          sceneStatusCounts: {
            observed: 0,
            candidate: 0,
            verified: graph.scenes.length,
            stale: 0,
            blocked: 0,
            disabled: 0,
          },
          operatorStatusCounts: {
            observed: 0,
            candidate: 0,
            verified: graph.operators.length,
            stale: 0,
            blocked: 0,
            disabled: 0,
          },
          taskStatusCounts: {
            observed: 0,
            candidate: 0,
            verified: graph.tasks.length,
            stale: 0,
            blocked: 0,
            disabled: 0,
          },
        },
        sceneFrontiers: [
          {
            frontierId: "scene.chat.detail",
            sceneId: "chat.detail",
            title: "会话页",
            depth: 0,
            status: "scanning",
            recoveryOperatorIds: [],
            attempts: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
        actionFrontiers: [],
      };
      await writeFile(statePath, `${JSON.stringify(initial)}\n`, "utf8");

      const result = await workflow<IosUiCrawlerResult>(
        join(process.cwd(), "examples/ios-ui-graph-discovery/workflow.ts"),
        {
          graphPath,
          resumeStatePath: statePath,
          planOnly: true,
          refreshMap: false,
          maximumActions: 1,
          maximumScenes: 1,
          maximumAttemptsPerAction: 2,
        },
      );

      expect(result.state.status).toBe("paused");
      expect(result.state.sceneFrontiers[0]?.status).toBe("pending_scan");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("does not treat an unevidenced semantic navigation edge as page coverage", () => {
    const now = new Date().toISOString();
    const elementId = "chat.detail.synthetic_entry";
    const operatorId = "chat.detail.synthetic_entry.tap.synthetic.page";
    const graphWithSemanticEdge: ExecutableUiGraphExperiment = {
      ...graph,
      scenes: [
        ...graph.scenes,
        {
          sceneId: "synthetic.page",
          title: "未实测页面",
          aliases: [],
          status: "candidate",
          anchorElementIds: [],
          visualTextAnchors: ["未实测页面"],
          referenceAssets: [],
        },
      ],
      elements: [
        ...graph.elements,
        {
          elementId,
          sceneId: "chat.detail",
          title: "打开未实测页面",
          semanticRole: "navigation_entry",
          selector: {
            accessibilityId: "打开未实测页面",
            label: "打开未实测页面",
            role: "Button",
          },
          bindings: [],
        },
      ],
      operators: [
        ...graph.operators,
        {
          operatorId,
          title: "打开未实测页面",
          fromSceneId: "chat.detail",
          toSceneId: "synthetic.page",
          operation: { type: "tap", elementId },
          settleMs: 900,
          risk: "navigation",
          status: "candidate",
          reliability: 0.7,
          preconditions: [],
          effects: [],
          postconditions: ["scene.current=synthetic.page"],
        },
      ],
    };
    const frontier: IosUiCrawlerState["actionFrontiers"][number] = {
      frontierId: "action.synthetic",
      sceneId: "chat.detail",
      sceneDepth: 0,
      recoveryOperatorIds: [],
      target: {
        candidateId: elementId,
        elementId,
        title: "打开未实测页面",
        semanticRole: "navigation_entry",
        source: "ui_dump",
        selector: {
          accessibilityId: "打开未实测页面",
          label: "打开未实测页面",
          role: "Button",
        },
        bounds: { x: 10, y: 10, width: 100, height: 44 },
      },
      actionType: "tap",
      risk: "navigation",
      expectedEffectType: "new_scene",
      priority: 1,
      status: "completed",
      attempts: 0,
      createdAt: now,
      operatorId,
      effect: {
        type: "new_scene",
        fromSceneId: "chat.detail",
        toSceneId: "synthetic.page",
        title: "未实测页面",
        visualTextAnchors: [],
        description: "Synthesized without device evidence.",
        confidence: 0.7,
      },
      issue: "Covered by an existing executable semantic navigation edge.",
    };
    const state: IosUiCrawlerState = {
      schemaVersion: "ios-ui-scene-crawler-state/v1",
      runId: "live-evidence-gate",
      graphPath: "/tmp/graph.json",
      status: "paused",
      createdAt: now,
      updatedAt: now,
      sessionCount: 1,
      entrySceneId: "chat.detail",
      budgets: {
        maximumActions: 10,
        maximumScenes: 10,
        maximumDepth: 4,
        maximumDurationMinutes: 10,
        maximumAttemptsPerAction: 2,
        maximumActionsPerScene: 10,
        agentTimeoutMs: 60_000,
        settleMs: 900,
      },
      baseline: {
        capturedAt: now,
        sceneCount: graphWithSemanticEdge.scenes.length,
        elementCount: graphWithSemanticEdge.elements.length,
        operatorCount: graphWithSemanticEdge.operators.length,
        taskCount: graphWithSemanticEdge.tasks.length,
        sceneStatusCounts: {
          observed: 0,
          candidate: graphWithSemanticEdge.scenes.length,
          verified: 0,
          stale: 0,
          blocked: 0,
          disabled: 0,
        },
        operatorStatusCounts: {
          observed: 0,
          candidate: graphWithSemanticEdge.operators.length,
          verified: 0,
          stale: 0,
          blocked: 0,
          disabled: 0,
        },
        taskStatusCounts: {
          observed: 0,
          candidate: graphWithSemanticEdge.tasks.length,
          verified: 0,
          stale: 0,
          blocked: 0,
          disabled: 0,
        },
      },
      sceneFrontiers: [],
      actionFrontiers: [frontier],
    };

    const repaired = repairPageCoverageActions(state, graphWithSemanticEdge);
    expect(repaired.actionFrontiers[0]?.status).toBe("pending");
    expect(repaired.actionFrontiers[0]?.operatorId).toBeUndefined();
    expect(repaired.actionFrontiers[0]?.issue).toContain(
      "no live before/after evidence",
    );

    const audit = computePageAudit(repaired, graphWithSemanticEdge);
    expect(audit.status).toBe("incomplete");
    expect(audit.gaps).toBe(1);
    expect(audit.entries[0]?.status).toBe("gap");
  });

  test("does not audit controls hidden behind an active survey overlay", () => {
    const now = new Date().toISOString();
    const state: IosUiCrawlerState = {
      schemaVersion: "ios-ui-scene-crawler-state/v1",
      runId: "survey-overlay",
      graphPath: "/tmp/graph.json",
      status: "paused",
      createdAt: now,
      updatedAt: now,
      sessionCount: 1,
      entrySceneId: "chat.detail",
      budgets: {
        maximumActions: 10,
        maximumScenes: 10,
        maximumDepth: 4,
        maximumDurationMinutes: 10,
        maximumAttemptsPerAction: 2,
        maximumActionsPerScene: 10,
        agentTimeoutMs: 60_000,
        settleMs: 900,
      },
      baseline: {
        capturedAt: now,
        sceneCount: graph.scenes.length,
        elementCount: graph.elements.length,
        operatorCount: graph.operators.length,
        taskCount: graph.tasks.length,
        sceneStatusCounts: {
          observed: 0,
          candidate: graph.scenes.length,
          verified: 0,
          stale: 0,
          blocked: 0,
          disabled: 0,
        },
        operatorStatusCounts: {
          observed: 0,
          candidate: graph.operators.length,
          verified: 0,
          stale: 0,
          blocked: 0,
          disabled: 0,
        },
        taskStatusCounts: {
          observed: 0,
          candidate: graph.tasks.length,
          verified: 0,
          stale: 0,
          blocked: 0,
          disabled: 0,
        },
      },
      sceneFrontiers: [],
      actionFrontiers: [
        {
          frontierId: "survey-overlay-products",
          sceneId: "volcengine.ark.feedback.survey",
          actionType: "tap",
          target: {
            candidateId: "products",
            elementId: "ark.products.entry",
            title: "全部产品",
            semanticRole: "button",
            source: "vision_ocr",
            selector: { text: "全部产品" },
            bounds: { x: 0, y: 0, width: 100, height: 44 },
          },
          risk: "navigation",
          priority: 1,
          sceneDepth: 1,
          recoveryOperatorIds: [],
          expectedEffectType: "new_scene",
          requiredStateFacts: [],
          expectedStateFacts: [],
          status: "skipped",
          attempts: 0,
          createdAt: now,
          completedAt: now,
          issue:
            "Skipped underlying background control hidden by the active survey overlay.",
        },
      ],
    };

    const audit = computePageAudit(state, graph);
    expect(audit.entries).toEqual([]);
    expect(audit.gaps).toBe(0);
  });

  test("merges later module seeds without duplicating existing goals", () => {
    const initial = initializeDiscoveryState({
      graph,
      graphPath: "/tmp/graph.json",
      runId: "run-4",
      modules: [
        {
          moduleId: "global",
          title: "全局",
          seedGoals: ["进入搜索页面"],
        },
      ],
      input: {
        maximumFrontiers: 10,
        maximumQueuedFrontiers: 50,
        maximumNewScenes: 20,
        maximumDurationMinutes: 30,
        maximumAttemptsPerFrontier: 2,
        maximumDiscoveryStepsPerGoal: 6,
        agentTimeoutMs: 60_000,
      },
    });
    const merged = mergeSeedFrontiers(initial, [
      {
        moduleId: "global",
        title: "全局导航",
        seedGoals: ["进入搜索页面", "进入云盘"],
      },
    ]);

    expect(merged.frontiers).toHaveLength(2);
    expect(merged.modules[0]?.title).toBe("全局导航");
  });
});

function makeObservation(
  candidates: Array<[string, string, string]>,
): TargetedDiscoveryObservation {
  return {
    observationId: "observation-01",
    screenshotPath: "/tmp/screen.png",
    uiDumpPath: "/tmp/ui.json",
    ocrPath: "/tmp/ocr.json",
    matchedSceneId: null,
    candidateSceneId: "chat.sidebar",
    candidateSceneTitle: "侧边栏",
    visualTextAnchors: ["搜索", "技能", "云盘"],
    candidates: candidates.map(([candidateId, role, label], index) => ({
      candidateId,
      source: candidateId.startsWith("ocr")
        ? ("vision_ocr" as const)
        : ("ui_dump" as const),
      role,
      label,
      bounds: {
        x: 20,
        y: 40 + index * 40,
        width: 100,
        height: 30,
      },
    })),
  };
}
