import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import graphJson from "../../examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json";
import { WorkflowRunner } from "@deerwork-ai/deer-workflow/runner";

import type { AppGraph } from "../../examples/ios-ui-graph-manager/types";
import type {
  AppGraphPlanInput,
  AppGraphPlanOutput,
} from "../../examples/app-graph-plan/types";

const graph = graphJson as AppGraph;
const graphPath = join(
  process.cwd(),
  "examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);
const workflowPath = join(process.cwd(), "examples/app-graph-plan/workflow.ts");

async function runPlan(args: AppGraphPlanInput): Promise<AppGraphPlanOutput> {
  const runner = new WorkflowRunner({ logWriter: () => {} });
  try {
    return await runner.run<AppGraphPlanOutput>(workflowPath, args);
  } finally {
    runner.dispose();
  }
}

describe("app-graph-plan", () => {
  test("compiles a coordinate-optional semantic Task plan", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-semantic-"),
    );
    try {
      const result = await runPlan({
        goal: "打开侧边栏",
        graphPath,
        deviceProfileId: "iphone-414x896-portrait",
        planOnly: true,
        outputDir: outputRoot,
      });

      expect(result.success).toBeTrue();
      if (!result.success) return;

      expect(result.schemaVersion).toBe("app-graph-semantic-plan/v2");
      expect(result.resolutionType).toBe("matched_task");
      expect(result.resolution).toMatchObject({
        kind: "task",
        id: "chat.open_sidebar",
        title: "打开侧边栏",
        confidence: 1,
      });
      expect(result.navigationRoute).toEqual([]);
      expect(result.taskSteps).toEqual([{ operatorId: "chat.open_sidebar" }]);
      expect(result.resolvedSteps).toHaveLength(1);
      expect(result.resolvedSteps[0]).toMatchObject({
        stepId: "01-chat.open_sidebar",
        operatorId: "chat.open_sidebar",
        fromScene: {
          sceneId: "chat.detail",
          title: "会话页",
        },
        action: {
          type: "tap",
          description: "在「会话页」点击页面左上区域的「对话列表」按钮。",
        },
        targetElement: {
          elementId: "chat.sidebar_entry",
          title: "对话列表",
          semanticRole: "Button",
          locationHint: {
            region: "top_left",
            description: "页面左上区域",
            sourceDeviceProfileId: "iphone-414x896-portrait",
          },
        },
        expectedOutcome: {
          scene: {
            sceneId: "chat.sidebar",
            title: "会话侧边栏",
            anchors: ["搜索", "技能", "云盘"],
          },
        },
        resolutionPolicy: {
          preferred: "live_selector",
          allowAgentVisualResolution: true,
          allowBindingFallback: true,
          liveResolutionRequired: false,
        },
      });
      expect(result.resolvedSteps[0]?.targetElement?.selectors).toEqual([
        { type: "accessibilityIdentifier", value: "对话列表" },
        { type: "label", value: "对话列表" },
        { type: "role", value: "Button" },
      ]);
      expect(result.finalOracles).toEqual(
        graph.tasks["chat.open_sidebar"]!.finalOracles,
      );
      expect(result.graphIdentity).toMatchObject({
        graphId: "com.bot.doubao.chat-full-v2",
        revision: graph.revision,
        schemaVersion: "ios-executable-ui-graph/v2",
      });

      const persisted = JSON.parse(await readFile(result.planPath, "utf8"));
      expect(persisted).toEqual(result);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("keeps semantic selectors when the device Binding is unavailable", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-no-binding-"),
    );
    const temporaryGraphPath = join(outputRoot, "graph.json");
    const graphWithoutBinding = structuredClone(graph) as AppGraph;
    const sidebarElement =
      graphWithoutBinding.scenes["chat.detail"]?.elements["chat.sidebar_entry"];
    if (!sidebarElement)
      throw new Error("chat.sidebar_entry fixture is missing");
    (
      sidebarElement as unknown as { bindings: Record<string, never> }
    ).bindings = {};
    await writeFile(
      temporaryGraphPath,
      JSON.stringify(graphWithoutBinding),
      "utf8",
    );

    try {
      const result = await runPlan({
        goal: "打开侧边栏",
        graphPath: temporaryGraphPath,
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result.success).toBeTrue();
      if (!result.success) return;

      const step = result.resolvedSteps[0];
      expect(step?.normalizedPoint).toBeUndefined();
      expect(step?.binding).toEqual({
        deviceProfileId: "iphone-414x896-portrait",
        status: "missing",
      });
      expect(step?.targetElement?.selectors).toEqual([
        { type: "accessibilityIdentifier", value: "对话列表" },
        { type: "label", value: "对话列表" },
        { type: "role", value: "Button" },
      ]);
      expect(step?.action.description).toBe(
        "在「会话页」点击「对话列表」按钮。",
      );
      expect(step?.resolutionPolicy).toMatchObject({
        preferred: "live_selector",
        allowAgentVisualResolution: true,
        allowBindingFallback: false,
        liveResolutionRequired: false,
      });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("does not reuse coordinates from a different device profile", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-profile-isolation-"),
    );
    const temporaryGraphPath = join(outputRoot, "graph.json");
    const multiProfileGraph = structuredClone(graph) as AppGraph;
    (
      multiProfileGraph.deviceProfiles as Record<
        string,
        AppGraph["deviceProfiles"][string]
      >
    )["iphone-alternate"] = {
      profileId: "iphone-alternate",
      viewportWidth: 390,
      viewportHeight: 844,
    };
    await writeFile(
      temporaryGraphPath,
      JSON.stringify(multiProfileGraph),
      "utf8",
    );

    try {
      const result = await runPlan({
        goal: "打开侧边栏",
        graphPath: temporaryGraphPath,
        deviceProfileId: "iphone-alternate",
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result.success).toBeTrue();
      if (!result.success) return;

      const step = result.resolvedSteps[0];
      expect(step?.binding).toEqual({
        deviceProfileId: "iphone-alternate",
        status: "missing",
      });
      expect(step?.normalizedPoint).toBeUndefined();
      expect(step?.targetElement?.selectors.length).toBeGreaterThan(0);
      expect(step?.targetElement?.locationHint).toEqual({
        region: "top_left",
        description: "页面左上区域",
        sourceDeviceProfileId: "iphone-414x896-portrait",
      });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("does not reuse coordinates when the runtime App version differs from the Graph", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-version-isolation-"),
    );
    try {
      const result = await runPlan({
        goal: "打开侧边栏",
        graphPath,
        runtimeAppVersion: "99.0.0",
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result.success).toBeTrue();
      if (!result.success) return;

      const step = result.resolvedSteps[0];
      expect(result.runtimeAppVersion).toBe("99.0.0");
      expect(step?.normalizedPoint).toBeUndefined();
      expect(step?.binding).toEqual({
        deviceProfileId: "iphone-414x896-portrait",
        status: "missing",
      });
      expect(step?.targetElement?.locationHint).toMatchObject({
        region: "top_left",
      });
      expect(step?.resolutionPolicy.allowBindingFallback).toBeFalse();
      expect(result.taskResolution).toMatchObject({
        health: "stale",
        recipeReused: false,
      });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("compiles a multi-step semantic route for a matched Scene", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-scene-route-"),
    );
    try {
      const result = await runPlan({
        goal: "云盘最近空状态",
        graphPath,
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result.success).toBeTrue();
      if (!result.success) return;

      expect(result.resolutionType).toBe("matched_scene");
      expect(result.targetSceneId).toBe("cloud.drive.recent.empty");
      expect(result.navigationRoute.map((step) => step.operatorId)).toEqual([
        "chat.open_sidebar",
        "chat.sidebar.open.cloud.drive",
      ]);
      expect(
        result.resolvedSteps.map((step) => step.action.description),
      ).toEqual([
        "在「会话页」点击页面左上区域的「对话列表」按钮。",
        "在「会话侧边栏」点击页面左上区域的「云盘」文本。",
      ]);
      expect(result.finalOracles).toEqual([
        { type: "scene_current", sceneId: "cloud.drive.recent.empty" },
        { type: "foreground_bundle", bundleId: "com.bot.doubao" },
      ]);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("compiles an explicit Operator target for Console execution", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-operator-target-"),
    );
    try {
      const result = await runPlan({
        goal: "执行 Operator chat.open_bot_settings",
        target: { kind: "operator", id: "chat.open_bot_settings" },
        graphPath,
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result.success).toBeTrue();
      if (!result.success) return;
      expect(result).toMatchObject({
        resolutionType: "matched_operator",
        matchedOperatorId: "chat.open_bot_settings",
        targetSceneId: "bot.settings",
      });
      expect(result.resolvedSteps.at(-1)?.operatorId).toBe(
        "chat.open_bot_settings",
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("resolves parameterized selectors and Oracles without permitting Binding fallback", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-parameterized-"),
    );
    try {
      const result = await runPlan({
        goal: "删除指定文本消息",
        graphPath,
        parameters: { text: "GraphV2 测试消息" },
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result.success).toBeTrue();
      if (!result.success) return;

      const targetStep = result.resolvedSteps[0];
      expect(targetStep?.operatorId).toBe("message.delete_target.long_press");
      expect(targetStep?.targetElement?.selectorTemplate).toEqual([
        { type: "text", value: "$parameters.text" },
        { type: "role", value: "StaticText" },
      ]);
      expect(targetStep?.targetElement?.selectors).toEqual([
        { type: "text", value: "GraphV2 测试消息" },
        { type: "role", value: "StaticText" },
      ]);
      expect(targetStep?.resolutionPolicy).toMatchObject({
        allowBindingFallback: false,
        liveResolutionRequired: true,
      });
      expect(result.finalOracles[0]).toEqual({
        type: "text_absent",
        value: "GraphV2 测试消息",
      });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("rejects a parameterized Task when a required parameter is missing", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-missing-param-"),
    );
    try {
      const result = await runPlan({
        goal: "发送文本消息",
        graphPath,
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result).toMatchObject({
        schemaVersion: "app-graph-semantic-plan-failure/v1",
        success: false,
        mode: "plan_failure",
        code: "missing_required_parameters",
        recoverable: true,
      });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("returns a failure instead of an empty successful plan for an unresolved goal", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-unresolved-"),
    );
    try {
      const result = await runPlan({
        goal: "执行一个图里完全不存在的量子传送动作",
        graphPath,
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result).toMatchObject({
        schemaVersion: "app-graph-semantic-plan-failure/v1",
        success: false,
        mode: "plan_failure",
        code: "goal_unresolved",
        recoverable: true,
      });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("rejects an ambiguous natural-language Task match", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-ambiguous-"),
    );
    const temporaryGraphPath = join(outputRoot, "graph.json");
    const ambiguous = structuredClone(graph) as AppGraph;
    const tasks = ambiguous.tasks as Record<string, AppGraph["tasks"][string]>;
    tasks["test.open_chat_a"] = {
      taskId: "test.open_chat_a",
      intents: ["打开聊天页面甲"],
      entrySceneId: "chat.detail",
      steps: [],
      finalOracles: [{ type: "scene_current", sceneId: "chat.detail" }],
      status: "verified",
    };
    tasks["test.open_chat_b"] = {
      taskId: "test.open_chat_b",
      intents: ["打开聊天页面乙"],
      entrySceneId: "chat.detail",
      steps: [],
      finalOracles: [{ type: "ui_text_visible", value: "豆包" }],
      status: "verified",
    };
    await writeFile(temporaryGraphPath, JSON.stringify(ambiguous), "utf8");
    try {
      const result = await runPlan({
        goal: "打开聊天页面",
        graphPath: temporaryGraphPath,
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result).toMatchObject({
        success: false,
        code: "task_match_ambiguous",
      });
      if (result.success) return;
      expect(
        result.taskCandidates?.map((candidate) => candidate.taskId),
      ).toContain("test.open_chat_a");
      expect(
        result.taskCandidates?.map((candidate) => candidate.taskId),
      ).toContain("test.open_chat_b");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("replans an expired navigation Task from its target Scene", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-stale-task-"),
    );
    const temporaryGraphPath = join(outputRoot, "graph.json");
    const stale = structuredClone(graph) as AppGraph;
    const task = stale.tasks["runtime.task.66ed2576a0a7"]!;
    (
      task as unknown as { validation: NonNullable<typeof task.validation> }
    ).validation = {
      ...task.validation!,
      dependencyDigest: "0".repeat(64),
      validUntil: "2020-01-01T00:00:00.000Z",
    };
    await writeFile(temporaryGraphPath, JSON.stringify(stale), "utf8");
    try {
      const result = await runPlan({
        goal: "打开帮助与反馈",
        graphPath: temporaryGraphPath,
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result.success).toBeTrue();
      if (!result.success) return;
      expect(result.taskResolution).toMatchObject({
        health: "stale",
        recipeReused: false,
      });
      expect(result.targetSceneId).toBe("bot.settings.customer_service");
      expect(result.taskSteps).toEqual([]);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("replans an explicitly stale navigation Task from its target Scene", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-explicit-stale-task-"),
    );
    const temporaryGraphPath = join(outputRoot, "graph.json");
    const stale = structuredClone(graph) as AppGraph;
    const task = stale.tasks["runtime.task.66ed2576a0a7"]!;
    (task as unknown as { status: string }).status = "stale";
    await writeFile(temporaryGraphPath, JSON.stringify(stale), "utf8");
    try {
      const result = await runPlan({
        goal: "打开帮助与反馈",
        graphPath: temporaryGraphPath,
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result.success).toBeTrue();
      if (!result.success) return;
      expect(result.taskResolution).toMatchObject({
        health: "stale",
        recipeReused: false,
        reasons: ["task_status_stale"],
      });
      expect(result.targetSceneId).toBe("bot.settings.customer_service");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("fails closed when the only matching mutating Task is stale", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-stale-mutation-"),
    );
    const temporaryGraphPath = join(outputRoot, "graph.json");
    const stale = structuredClone(graph) as AppGraph;
    const deleteTask = stale.tasks["message.delete_last"]!;
    (stale.tasks as Record<string, AppGraph["tasks"][string]>)[
      "test.approximate.delete"
    ] = {
      ...deleteTask,
      taskId: "test.approximate.delete",
      intents: ["删除文本消息"],
      finalOracles: [
        ...deleteTask.finalOracles,
        { type: "ui_text_absent", value: "删除失败" },
      ],
      validation: undefined,
    };
    await writeFile(temporaryGraphPath, JSON.stringify(stale), "utf8");
    try {
      const result = await runPlan({
        goal: "删除指定文本消息",
        graphPath: temporaryGraphPath,
        parameters: { text: "GraphV2 测试消息" },
        runtimeAppVersion: "99.0.0",
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result).toMatchObject({
        success: false,
        code: "task_stale",
        recoverable: true,
      });
      if (result.success) return;
      expect(result.taskCandidates?.[0]).toMatchObject({
        taskId: "message.delete_last",
        health: "stale",
        recipeReusable: false,
      });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("preserves complete swipe operation semantics", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-swipe-operation-"),
    );
    try {
      const result = await runPlan({
        goal: "查看更早消息",
        graphPath,
        outputDir: outputRoot,
        planOnly: true,
      });
      expect(result.success).toBeTrue();
      if (!result.success) return;

      expect(result.matchedTaskId).toBe("chat.load_more");
      expect(result.resolvedSteps[0]).toMatchObject({
        operatorStatus: "verified",
        operation: {
          type: "swipe",
          from: { x: 207, y: 240 },
          to: { x: 207, y: 690 },
        },
        action: {
          description: "在「会话页」从 (207, 240) 滑动到 (207, 690)。",
        },
      });
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("compiles every verified Task when required parameters are supplied", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "app-graph-plan-all-tasks-"),
    );
    try {
      for (const task of Object.values(graph.tasks)) {
        if (task.status !== "verified") continue;
        const parameters = Object.fromEntries(
          Object.keys(task.parameters ?? {}).map((name) => [
            name,
            name === "question" ? "这是什么？" : "测试文本",
          ]),
        );
        const result = await runPlan({
          goal: task.intents[0] ?? task.taskId,
          target: { kind: "task", id: task.taskId },
          graphPath,
          parameters,
          outputDir: outputRoot,
          planOnly: true,
        });
        expect(result.success, task.taskId).toBeTrue();
        if (!result.success) continue;
        expect(result.resolutionType, task.taskId).toBe("matched_task");
        expect(result.matchedTaskId, task.taskId).toBe(task.taskId);
        if (task.steps.length > 0) {
          expect(result.resolvedSteps.length, task.taskId).toBeGreaterThan(0);
        } else {
          expect(result.finalOracles.length, task.taskId).toBeGreaterThan(0);
        }
      }
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
