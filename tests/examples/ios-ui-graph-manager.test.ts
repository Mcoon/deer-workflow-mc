import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyAndSave,
  promoteReferenceAsset,
  resolveGraphAssetPath,
  retainValidReferenceAssets,
} from "../../examples/ios-ui-graph-manager";
import { planRoute } from "../../examples/ios-ui-graph-manager/route";
import { validateGraph } from "../../examples/ios-ui-graph-manager/validate";
import { migrateV1ToV2 } from "../../examples/ios-ui-graph-manager/migrate";
import type { ExecutableUiGraphExperiment } from "../../examples/ios-ui-graph-manager/legacy-v1-types";
import {
  matchTask,
  selectBestTaskMatch,
} from "../../examples/ios-ui-graph-manager/match";
import {
  evaluateTaskHealth,
  migrateTaskCatalog,
  normalizeTaskCatalogForWrite,
  taskDependencyDigest,
  taskIntentIsReusable,
} from "../../examples/ios-ui-graph-manager/task-health";
import type { AppGraph } from "../../examples/ios-ui-graph-manager/types";

const minimalGraph: AppGraph = {
  schemaVersion: "ios-executable-ui-graph/v2",
  graphId: "test",
  bundleId: "com.test",
  revision: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  deviceProfiles: {
    "iphone-test": {
      profileId: "iphone-test",
      viewportWidth: 414,
      viewportHeight: 896,
    },
  },
  defaultDeviceProfileId: "iphone-test",
  defaultResetStrategyId: "reset.default",
  resetStrategies: [
    {
      strategyId: "reset.default",
      entrySceneId: "chat.detail",
      steps: [
        { type: "terminate_app", bundleId: "com.test" },
        { type: "wait", durationMs: 500 },
        { type: "launch_app", bundleId: "com.test" },
        { type: "wait", durationMs: 2500 },
      ],
    },
  ],
  scenes: {
    "chat.detail": {
      sceneId: "chat.detail",
      parentSceneId: null,
      status: "verified",
      title: "Chat",
      aliases: [],
      visualTextAnchors: ["Chat"],
      referenceAssets: [],
      elements: {
        "chat.input": {
          elementId: "chat.input",
          title: "Message Input",
          semanticRole: "input",
          status: "verified",
          selectors: [{ type: "label", value: "Message" }],
          bindings: {
            "iphone-test": {
              deviceProfileId: "iphone-test",
              normalizedPoint: { x: 0.5, y: 0.9 },
              source: "ui_dump",
              status: "verified",
            },
          },
        },
      },
    },
  },
  operators: {
    "chat.tap_input": {
      operatorId: "chat.tap_input",
      fromSceneId: "chat.detail",
      toSceneId: "chat.detail",
      operation: { type: "tap", elementId: "chat.input" },
      effects: [{ type: "state_change", key: "focused", value: true }],
      status: "verified",
      executionStats: { pass: 1, fail: 0 },
    },
  },
  tasks: {},
};

describe("validateGraph", () => {
  it("passes a valid graph", () => {
    const result = validateGraph(minimalGraph);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects non-object", () => {
    const result = validateGraph(null);
    expect(result.valid).toBe(false);
  });

  it("rejects wrong schema version", () => {
    const result = validateGraph({ ...minimalGraph, schemaVersion: "wrong" });
    expect(result.valid).toBe(false);
  });

  it("rejects missing graphId", () => {
    const result = validateGraph({ ...minimalGraph, graphId: "" });
    expect(result.valid).toBe(false);
  });

  it("rejects missing bundleId", () => {
    const result = validateGraph({ ...minimalGraph, bundleId: "" });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid revision", () => {
    const result = validateGraph({ ...minimalGraph, revision: 0 });
    expect(result.valid).toBe(false);
  });

  it("validates scene with element mismatch", () => {
    const g = JSON.parse(JSON.stringify(minimalGraph)) as Record<
      string,
      unknown
    >;
    ((g as Record<string, unknown>).scenes as Record<string, unknown>)[
      "chat.detail"
    ] = {
      ...minimalGraph.scenes["chat.detail"],
      sceneId: "wrong",
    };
    const result = validateGraph(g as unknown as AppGraph);
    expect(result.valid).toBe(false);
  });

  it("validates operator fromSceneId missing", () => {
    const g = JSON.parse(JSON.stringify(minimalGraph)) as Record<
      string,
      unknown
    >;
    ((g as Record<string, unknown>).operators as Record<string, unknown>)[
      "chat.tap_input"
    ] = {
      ...minimalGraph.operators["chat.tap_input"],
      fromSceneId: "nonexistent",
    };
    const result = validateGraph(g as unknown as AppGraph);
    expect(result.valid).toBe(false);
  });

  it("accepts a Scene with an external foreground bundle", () => {
    const graph = JSON.parse(JSON.stringify(minimalGraph)) as AppGraph;
    const scenes = graph.scenes as Record<string, AppGraph["scenes"][string]>;
    scenes["external.browser"] = {
      sceneId: "external.browser",
      parentSceneId: null,
      foregroundBundleId: "com.apple.mobilesafari",
      status: "verified",
      title: "External Browser",
      aliases: [],
      visualTextAnchors: ["Example"],
      referenceAssets: [],
      elements: {},
    };

    expect(validateGraph(graph).valid).toBe(true);
  });

  it("rejects an empty external foreground bundle", () => {
    const graph = JSON.parse(JSON.stringify(minimalGraph)) as AppGraph;
    const scene = graph.scenes["chat.detail"] as unknown as {
      foregroundBundleId?: string;
    };
    scene.foregroundBundleId = "";

    expect(validateGraph(graph).valid).toBe(false);
  });

  it("rejects Task validation with an invalid deadline or digest", () => {
    const graph = structuredClone(minimalGraph) as AppGraph;
    (graph.tasks as Record<string, AppGraph["tasks"][string]>).invalid = {
      taskId: "invalid",
      intents: ["Invalid task"],
      entrySceneId: "chat.detail",
      steps: [{ operatorId: "chat.tap_input" }],
      finalOracles: [{ type: "scene_current", sceneId: "missing" }],
      status: "verified",
      validation: {
        source: "runtime_composition",
        sourceGoals: ["Invalid task"],
        tier: "fast",
        successfulExecutions: 2,
        failedExecutions: 0,
        consecutiveSuccessfulExecutions: 2,
        consecutiveFailedExecutions: 0,
        evidencePaths: [],
        validUntil: "not-a-date",
        dependencyDigest: "bad",
      },
    };
    const result = validateGraph(graph);
    expect(result.valid).toBeFalse();
    expect(result.errors.join("\n")).toContain("scene_current oracle");
    expect(result.errors.join("\n")).toContain("validUntil");
    expect(result.errors.join("\n")).toContain("dependencyDigest");
  });

  it("validates final Oracle types and required payloads", () => {
    const invalid = structuredClone(minimalGraph) as AppGraph;
    (invalid.tasks as Record<string, AppGraph["tasks"][string]>).oracles = {
      taskId: "oracles",
      intents: ["Invalid Oracles"],
      entrySceneId: "chat.detail",
      steps: [],
      finalOracles: [
        { type: "all_text_visible", values: [] },
        { type: "text_visible" },
        { type: "visual_changed", maximumSsim: 2 },
        { type: "unknown" as "text_visible", value: "bad" },
      ],
      status: "candidate",
    };
    const result = validateGraph(invalid);
    expect(result.valid).toBeFalse();
    expect(result.errors.join("\n")).toContain(
      "all_text_visible oracle requires non-empty values",
    );
    expect(result.errors.join("\n")).toContain(
      "text_visible oracle requires value",
    );
    expect(result.errors.join("\n")).toContain(
      "visual_changed oracle requires maximumSsim between 0 and 1",
    );
    expect(result.errors.join("\n")).toContain(
      'unsupported final Oracle type "unknown"',
    );
  });
});

describe("migrateV1ToV2", () => {
  it("preserves compiled verifier assertions as final Oracles", () => {
    const legacy = {
      schemaVersion: "ios-executable-ui-graph-experiment/v1",
      graphId: "legacy",
      bundleId: "com.test",
      appName: "Test",
      deviceProfiles: [
        { profileId: "iphone-test", viewportWidth: 414, viewportHeight: 896 },
      ],
      defaultDeviceProfileId: "iphone-test",
      defaultResetStrategyId: "reset.default",
      resetStrategies: [
        {
          strategyId: "reset.default",
          entrySceneId: "chat.detail",
          steps: [],
        },
      ],
      scenes: [
        {
          sceneId: "chat.detail",
          title: "Chat",
          aliases: [],
          status: "verified",
          anchorElementIds: [],
          visualTextAnchors: ["Chat"],
          referenceAssets: [],
        },
      ],
      elements: [],
      operators: [],
      tasks: [
        {
          taskId: "legacy.verify",
          title: "Legacy Verify",
          summary: "",
          intents: ["校验旧任务"],
          parameters: {},
          entrySceneId: "chat.detail",
          operatorIds: [],
          finalOracles: [{ type: "scene_current", sceneId: "chat.detail" }],
          status: "verified",
          verifier: {
            schemaVersion: "ios-ui-agent-verifier/v1",
            status: "verified",
            source: "agent_compiled",
            assertions: [
              {
                assertionId: "all-visible",
                type: "all_text_visible",
                values: ["豆包", "输入框"],
              },
              {
                assertionId: "foreground",
                type: "foreground_bundle",
                bundleId: "com.test",
              },
            ],
            reason: "compiled",
            confidence: 1,
            successfulExecutions: 1,
            evidencePaths: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      ],
    } as ExecutableUiGraphExperiment;

    expect(migrateV1ToV2(legacy).tasks["legacy.verify"]?.finalOracles).toEqual([
      { type: "scene_current", sceneId: "chat.detail" },
      { type: "all_text_visible", values: ["豆包", "输入框"] },
      { type: "foreground_bundle", bundleId: "com.test" },
    ]);
  });
});

describe("Task health", () => {
  const task = {
    taskId: "chat.focus",
    intents: ["聚焦消息输入框"],
    entrySceneId: "chat.detail",
    steps: [{ operatorId: "chat.tap_input" }],
    finalOracles: [{ type: "scene_current" as const, sceneId: "chat.detail" }],
    status: "verified" as const,
    parameters: {},
  };

  it("keeps legacy declared tasks guarded without rejecting them", () => {
    expect(
      evaluateTaskHealth({
        graph: minimalGraph,
        task,
        deviceProfileId: "iphone-test",
        now: new Date("2026-08-22T00:00:00Z"),
      }),
    ).toMatchObject({
      status: "guarded",
      recipeReusable: true,
      reasons: ["validation_missing"],
    });
  });

  it("marks a digest change stale while keeping a navigation target reusable", () => {
    const withValidation = {
      ...task,
      validation: {
        source: "runtime_composition" as const,
        sourceGoals: task.intents,
        tier: "fast" as const,
        successfulExecutions: 2,
        failedExecutions: 0,
        consecutiveSuccessfulExecutions: 2,
        consecutiveFailedExecutions: 0,
        evidencePaths: [],
        lastValidatedAt: "2026-08-21T00:00:00Z",
        lastValidatedAppVersion: "1.0.0",
        lastDeviceProfileId: "iphone-test",
        dependencyDigest: "0".repeat(64),
      },
    };
    expect(
      evaluateTaskHealth({
        graph: { ...minimalGraph, appVersion: "1.0.0" },
        task: withValidation,
        deviceProfileId: "iphone-test",
        now: new Date("2026-08-22T00:00:00Z"),
      }),
    ).toMatchObject({
      status: "stale",
      recipeReusable: false,
      reasons: ["dependency_changed"],
    });
  });

  it("classifies an explicitly stale Task as stale instead of structurally invalid", () => {
    expect(
      evaluateTaskHealth({
        graph: minimalGraph,
        task: { ...task, status: "stale" },
        deviceProfileId: "iphone-test",
      }),
    ).toMatchObject({
      status: "stale",
      recipeReusable: false,
      reasons: ["task_status_stale"],
    });
  });

  it("marks a fresh recipe stale when the runtime App version changes", () => {
    const graph = { ...minimalGraph, appVersion: "1.0.0" };
    const withValidation = {
      ...task,
      validation: {
        source: "runtime_composition" as const,
        sourceGoals: task.intents,
        tier: "fast" as const,
        successfulExecutions: 2,
        failedExecutions: 0,
        consecutiveSuccessfulExecutions: 2,
        consecutiveFailedExecutions: 0,
        evidencePaths: [],
        lastValidatedAt: "2026-08-21T00:00:00Z",
        lastValidatedAppVersion: "1.0.0",
        lastDeviceProfileId: "iphone-test",
        dependencyDigest: "",
      },
    };
    withValidation.validation.dependencyDigest = taskDependencyDigest(
      graph,
      withValidation,
    );
    expect(
      evaluateTaskHealth({
        graph,
        task: withValidation,
        deviceProfileId: "iphone-test",
        runtimeAppVersion: "2.0.0",
        now: new Date("2026-08-22T00:00:00Z"),
      }),
    ).toMatchObject({
      status: "stale",
      recipeReusable: false,
      reasons: ["runtime_app_version_changed", "task_app_version_changed"],
    });
  });

  it("removes diagnostic intents and merges duplicate semantic recipes", () => {
    const graph = structuredClone(minimalGraph) as AppGraph;
    (graph.tasks as Record<string, AppGraph["tasks"][string]>).canonical = {
      ...task,
      taskId: "canonical",
    };
    (graph.tasks as Record<string, AppGraph["tasks"][string]>).duplicate = {
      ...task,
      taskId: "duplicate",
      intents: ["页面的录屏不对 需要重新录一下"],
      status: "candidate",
    };
    const migrated = migrateTaskCatalog(graph, {
      appVersion: "2.0.0",
      now: new Date("2026-08-22T00:00:00Z"),
    });
    expect(migrated.tasks.canonical?.intents).toEqual(["聚焦消息输入框"]);
    expect(migrated.tasks.duplicate).toBeUndefined();
    expect(migrated.appVersion).toBe("2.0.0");
    expect(migrated.revision).toBe(2);
  });

  it("normalizes duplicate runtime Tasks whenever the Graph is written", () => {
    const graph = structuredClone(minimalGraph) as AppGraph;
    (graph.tasks as Record<string, AppGraph["tasks"][string]>).canonical = {
      ...task,
      taskId: "canonical",
    };
    (graph.tasks as Record<string, AppGraph["tasks"][string]>).duplicate = {
      ...task,
      taskId: "duplicate",
      intents: ["聚焦输入框"],
      status: "candidate",
      validation: {
        source: "runtime_composition",
        sourceGoals: ["聚焦输入框"],
        tier: "guarded",
        successfulExecutions: 1,
        failedExecutions: 0,
        consecutiveSuccessfulExecutions: 1,
        consecutiveFailedExecutions: 0,
        evidencePaths: [],
      },
    };
    const normalized = normalizeTaskCatalogForWrite(graph);
    expect(normalized.tasks.canonical?.intents).toEqual([
      "聚焦消息输入框",
      "聚焦输入框",
    ]);
    expect(normalized.tasks.duplicate).toBeUndefined();
    expect(normalized.revision).toBe(graph.revision);
  });

  it("filters internal identifiers and diagnostic prose from reusable intents", () => {
    expect(taskIntentIsReusable("打开帮助与反馈")).toBeTrue();
    expect(taskIntentIsReusable("bot.settings.customer_service")).toBeFalse();
    expect(taskIntentIsReusable("页面的录屏不对 需要重新录一下")).toBeFalse();
  });

  it("keeps the strongest intent score when selecting a canonical duplicate Task", () => {
    const graph = structuredClone(minimalGraph) as AppGraph;
    const tasks = graph.tasks as Record<string, AppGraph["tasks"][string]>;
    tasks.canonical = {
      ...task,
      taskId: "canonical",
      intents: ["打开设置"],
      validation: {
        source: "declared",
        sourceGoals: ["打开设置"],
        tier: "guarded",
        successfulExecutions: 0,
        failedExecutions: 0,
        consecutiveSuccessfulExecutions: 0,
        consecutiveFailedExecutions: 0,
        evidencePaths: [],
      },
    };
    tasks.duplicate = {
      ...task,
      taskId: "duplicate",
      intents: ["打开侧边栏"],
      status: "candidate",
      validation: {
        source: "runtime_composition",
        sourceGoals: ["打开侧边栏"],
        tier: "guarded",
        successfulExecutions: 1,
        failedExecutions: 0,
        consecutiveSuccessfulExecutions: 1,
        consecutiveFailedExecutions: 0,
        evidencePaths: [],
      },
    };
    expect(selectBestTaskMatch(graph, matchTask(graph, "打开侧边栏"))).toEqual({
      taskId: "canonical",
      intent: "打开侧边栏",
      confidence: 1,
    });
  });

  it("prefers an executable runtime duplicate over a stale declared Task", () => {
    const graph = structuredClone(minimalGraph) as AppGraph;
    const tasks = graph.tasks as Record<string, AppGraph["tasks"][string]>;
    tasks.declared = {
      ...task,
      taskId: "declared",
      intents: ["打开设置"],
      status: "stale",
      validation: {
        source: "declared",
        sourceGoals: ["打开设置"],
        tier: "guarded",
        successfulExecutions: 0,
        failedExecutions: 1,
        consecutiveSuccessfulExecutions: 0,
        consecutiveFailedExecutions: 1,
        evidencePaths: [],
      },
    };
    tasks.runtime = {
      ...task,
      taskId: "runtime",
      intents: ["打开侧边栏"],
      validation: {
        source: "runtime_composition",
        sourceGoals: ["打开侧边栏"],
        tier: "guarded",
        successfulExecutions: 2,
        failedExecutions: 0,
        consecutiveSuccessfulExecutions: 2,
        consecutiveFailedExecutions: 0,
        evidencePaths: [],
      },
    };
    expect(selectBestTaskMatch(graph, matchTask(graph, "打开侧边栏"))).toEqual({
      taskId: "runtime",
      intent: "打开侧边栏",
      confidence: 1,
    });
  });
});

describe("planRoute", () => {
  it("ignores stale, blocked, and disabled operators", () => {
    const graph = JSON.parse(JSON.stringify(minimalGraph)) as AppGraph;
    const routeGraph = graph as unknown as {
      scenes: Record<string, AppGraph["scenes"][string]>;
      operators: Record<string, AppGraph["operators"][string]>;
    };
    routeGraph.scenes.target = {
      sceneId: "target",
      parentSceneId: "chat.detail",
      status: "verified",
      title: "Target",
      aliases: [],
      visualTextAnchors: ["Target"],
      referenceAssets: [],
      elements: {},
    };
    for (const status of ["stale", "blocked", "disabled"] as const) {
      routeGraph.operators[`chat.${status}`] = {
        operatorId: `chat.${status}`,
        fromSceneId: "chat.detail",
        toSceneId: "target",
        operation: { type: "tap", elementId: "chat.input" },
        effects: [],
        status,
        executionStats: { pass: 0, fail: 0 },
      };
    }

    expect(planRoute(graph, "chat.detail", "target")).toBeNull();

    routeGraph.operators["chat.verified"] = {
      operatorId: "chat.verified",
      fromSceneId: "chat.detail",
      toSceneId: "target",
      operation: { type: "tap", elementId: "chat.input" },
      effects: [],
      status: "verified",
      executionStats: { pass: 1, fail: 0 },
    };

    expect(
      planRoute(graph, "chat.detail", "target")?.map((step) => step.operatorId),
    ).toEqual(["chat.verified"]);
  });
});

describe("reference assets", () => {
  it("promotes assets beside the Graph with stable relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "graph-assets-"));
    const graphPath = join(root, "graph.json");
    const screenshotPath = join(root, "runtime-screen.png");
    const uiDumpPath = join(root, "runtime-ui.json");
    await writeFile(screenshotPath, new Uint8Array([137, 80, 78, 71]));
    await writeFile(uiDumpPath, JSON.stringify({ label: "Chat" }));
    try {
      const first = await promoteReferenceAsset({
        graphPath,
        sceneId: "chat.detail",
        screenshotPath,
        uiDumpPath,
      });
      const second = await promoteReferenceAsset({
        graphPath,
        sceneId: "chat.detail",
        screenshotPath,
        uiDumpPath,
      });

      expect(second).toEqual(first);
      expect(first.screenshot).toMatch(
        /^reference-assets\/chat.detail\/[a-f0-9]{16}\/screenshot.png$/,
      );
      expect(
        await readFile(resolveGraphAssetPath(graphPath, first.uiDump), "utf8"),
      ).toBe(JSON.stringify({ label: "Chat" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops missing and duplicate references while respecting the limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "graph-assets-retain-"));
    const graphPath = join(root, "graph.json");
    const screenshotPath = join(root, "screen.png");
    const uiDumpPath = join(root, "ui.json");
    await writeFile(screenshotPath, new Uint8Array([1]));
    await writeFile(uiDumpPath, "{}");
    try {
      const valid = { screenshot: screenshotPath, uiDump: uiDumpPath };
      expect(
        await retainValidReferenceAssets({
          graphPath,
          assets: [
            { screenshot: join(root, "missing.png"), uiDump: uiDumpPath },
            valid,
            valid,
          ],
          maxReferences: 1,
        }),
      ).toEqual([valid]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists patch references as Graph-relative assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "graph-assets-patch-"));
    const graphPath = join(root, "graph.json");
    const screenshotPath = join(root, "runtime-screen.png");
    const uiDumpPath = join(root, "runtime-ui.json");
    await writeFile(graphPath, JSON.stringify(minimalGraph));
    await writeFile(screenshotPath, new Uint8Array([137, 80, 78, 71]));
    await writeFile(uiDumpPath, "{}");
    try {
      const result = await applyAndSave(graphPath, {
        schemaVersion: "ios-ui-graph-patch/v2",
        graphId: minimalGraph.graphId,
        baseRevision: minimalGraph.revision,
        source: "discovery",
        scenes: {
          "chat.detail": {
            sceneId: "chat.detail",
            referenceAssets: [
              { screenshot: screenshotPath, uiDump: uiDumpPath },
            ],
          },
        },
      });
      const saved = JSON.parse(await readFile(graphPath, "utf8")) as AppGraph;
      const reference = saved.scenes["chat.detail"]!.referenceAssets[0]!;

      expect(result.success).toBe(true);
      expect(reference.screenshot.startsWith("reference-assets/")).toBe(true);
      expect(
        await Bun.file(
          resolveGraphAssetPath(graphPath, reference.screenshot),
        ).exists(),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
