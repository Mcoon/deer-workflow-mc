import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import graphJson from "../../examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json";
import { WorkflowRunner } from "@deerwork-ai/deer-workflow/runner";

import { compileFastRecipe } from "../../examples/app-graph-exec/fast-path";
import {
  persistFastFailureLearning,
  persistSuccessfulExecutionLearning,
  runtimeTaskId,
} from "../../examples/app-graph-exec/learning";
import type { ExecStepRecord } from "../../examples/app-graph-exec/types";
import type {
  AppGraphPlanOutput,
  AppGraphPlanResult,
} from "../../examples/app-graph-plan/types";
import type { AppGraph } from "../../examples/ios-ui-graph-manager/types";

const graph = graphJson as AppGraph;
const graphPath = join(
  process.cwd(),
  "examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);
const planWorkflowPath = join(
  process.cwd(),
  "examples/app-graph-plan/workflow.ts",
);

describe("App Graph runtime learning", () => {
  test("keeps a repeated route with live viewport search guarded", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-learning-"));
    const graphPath = join(root, "graph.json");
    const isolatedGraph = { ...graph, tasks: {} } as AppGraph;
    await writeFile(graphPath, JSON.stringify(isolatedGraph), "utf8");
    const runner = new WorkflowRunner({ logWriter: () => undefined });
    try {
      const plan = await runner.run<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开帮助与反馈",
        target: { kind: "scene", id: "bot.settings.customer_service" },
        graphPath,
        outputDir: join(root, "plan"),
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const records = executionRecords(plan);
      const taskId = runtimeTaskId(plan.goal, plan.targetSceneId);

      const first = await persistSuccessfulExecutionLearning({
        graphPath,
        graph: isolatedGraph,
        plan,
        goal: plan.goal,
        steps: records,
        deviceProfileId: plan.deviceProfileId,
        outputDir: join(root, "first"),
        evidencePath: join(root, "first-evidence.json"),
      });
      expect(first).toMatchObject({
        graphUpdated: true,
        taskId,
        taskStatus: "candidate",
        executionTier: "guarded",
      });
      expect(first.graph.tasks[taskId]).toMatchObject({
        status: "candidate",
        validation: {
          tier: "guarded",
          successfulExecutions: 1,
        },
      });
      expect(
        first.graph.tasks[taskId]?.steps.map((step) => step.operatorId),
      ).toEqual([
        "chat.open_bot_settings",
        "bot.settings.item-120ed8fe.tap.bot.settings.customer_service",
      ]);

      const second = await persistSuccessfulExecutionLearning({
        graphPath,
        graph: first.graph,
        plan,
        goal: plan.goal,
        steps: records,
        deviceProfileId: plan.deviceProfileId,
        outputDir: join(root, "second"),
        evidencePath: join(root, "second-evidence.json"),
      });
      expect(second).toMatchObject({
        graphUpdated: true,
        taskId,
        taskStatus: "verified",
        executionTier: "guarded",
      });
      expect(second.graph.tasks[taskId]?.validation).toMatchObject({
        tier: "guarded",
        successfulExecutions: 2,
        consecutiveSuccessfulExecutions: 2,
      });
      const learnedPlan: AppGraphPlanResult = {
        ...plan,
        matchedTaskId: taskId,
        matchedTask: second.graph.tasks[taskId],
      };
      const recipe = compileFastRecipe({
        graph: second.graph,
        plan: learnedPlan,
        deviceProfileId: plan.deviceProfileId,
        udid: "device-1",
        runtimeAppVersion: second.graph.appVersion,
      });
      expect(recipe).toBeNull();
      expect(JSON.parse(await readFile(graphPath, "utf8"))).toMatchObject({
        revision: isolatedGraph.revision + 2,
        tasks: {
          [taskId]: {
            status: "verified",
            validation: { tier: "guarded" },
          },
        },
      });

      const downgraded = await persistFastFailureLearning({
        graphPath,
        graph: second.graph,
        taskId,
        deviceProfileId: plan.deviceProfileId,
        outputDir: join(root, "failed-fast"),
        evidencePath: join(root, "failed-fast-evidence.json"),
        failure: "final oracle drift",
      });
      expect(downgraded).toMatchObject({
        graphUpdated: true,
        taskId,
        executionTier: "guarded",
      });
      expect(downgraded.graph.tasks[taskId]?.validation).toMatchObject({
        tier: "guarded",
        failedExecutions: 1,
        consecutiveSuccessfulExecutions: 0,
        consecutiveFailedExecutions: 1,
        lastFailure: "final oracle drift",
      });
    } finally {
      runner.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("removes historical same-Scene viewport hints from planned Task recipes", async () => {
    const runner = new WorkflowRunner({ logWriter: () => undefined });
    try {
      const plan = await runner.run<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开帮助与反馈",
        graphPath,
        outputDir: join(tmpdir(), "app-graph-fixed-swipe-plan"),
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      expect(
        plan.resolvedSteps.some(
          (step) =>
            step.operation.type === "swipe" &&
            step.toSceneId === step.fromSceneId,
        ),
      ).toBeFalse();
      expect(
        compileFastRecipe({
          graph,
          plan,
          deviceProfileId: plan.deviceProfileId,
          udid: "device-1",
          runtimeAppVersion: graph.appVersion,
        }),
      ).toBeNull();
    } finally {
      runner.dispose();
    }
  });

  test("persists Scene evidence even when a technical goal is not a reusable Task intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-scene-evidence-"));
    const isolatedGraphPath = join(root, "graph.json");
    const isolatedGraph = { ...graph, tasks: {} } as AppGraph;
    const screenshotPath = join(root, "sound.png");
    const uiDumpPath = join(root, "sound.json");
    await writeFile(isolatedGraphPath, JSON.stringify(isolatedGraph), "utf8");
    await writeFile(screenshotPath, "fake-image", "utf8");
    await writeFile(uiDumpPath, "[]", "utf8");
    const runner = new WorkflowRunner({ logWriter: () => undefined });
    try {
      const plan = await runner.run<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "bot.settings.sound",
        target: { kind: "scene", id: "bot.settings.sound" },
        graphPath: isolatedGraphPath,
        outputDir: join(root, "plan"),
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;

      const learned = await persistSuccessfulExecutionLearning({
        graphPath: isolatedGraphPath,
        graph: isolatedGraph,
        plan,
        goal: plan.goal,
        steps: executionRecords(plan),
        deviceProfileId: plan.deviceProfileId,
        outputDir: join(root, "learn"),
        evidencePath: uiDumpPath,
        finalSceneEvidence: { screenshotPath, uiDumpPath },
      });

      expect(learned).toMatchObject({
        graphUpdated: true,
        taskId: undefined,
        taskStatus: undefined,
      });
      expect(Object.keys(learned.graph.tasks)).toHaveLength(0);
      const assets =
        learned.graph.scenes["bot.settings.sound"]?.referenceAssets ?? [];
      expect(assets).toHaveLength(1);
      expect(assets[0]?.screenshot).toStartWith(
        "reference-assets/bot.settings.sound/",
      );
      expect(
        await Bun.file(join(root, assets[0]!.screenshot)).exists(),
      ).toBeTrue();
    } finally {
      runner.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects fast execution when the installed App version is unavailable or changed", async () => {
    const runner = new WorkflowRunner({ logWriter: () => undefined });
    try {
      const plan = await runner.run<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开设置页面",
        graphPath,
        outputDir: join(tmpdir(), "app-graph-fast-version-plan"),
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      expect(
        compileFastRecipe({
          graph,
          plan,
          deviceProfileId: plan.deviceProfileId,
          udid: "device-1",
        }),
      ).toBeNull();
      expect(
        compileFastRecipe({
          graph,
          plan,
          deviceProfileId: plan.deviceProfileId,
          udid: "device-1",
          runtimeAppVersion: "99.0.0",
        }),
      ).toBeNull();
    } finally {
      runner.dispose();
    }
  });
});

function executionRecords(plan: AppGraphPlanResult): ExecStepRecord[] {
  return plan.resolvedSteps.map((step, index) => ({
    stepIndex: index,
    operatorId: step.operatorId,
    action: step.operation.type,
    actionDescription: step.action.description,
    targetElementId: step.targetElement?.elementId,
    normalizedPoint:
      index === 0 ? { x: 0.483, y: 0.069 } : { x: 0.5, y: 0.436 },
    resolutionSource: "live_selector",
    commands: [["mobilecli", "io", "tap", "--device", "device-1", "1,1"]],
    visibilityRecoveryCommands:
      index === 1
        ? [
            [
              "mobilecli",
              "io",
              "swipe",
              "--device",
              "device-1",
              "207,699,207,251",
            ],
          ]
        : [],
    startedAt: "2026-08-19T00:00:00.000Z",
    finishedAt: "2026-08-19T00:00:01.000Z",
    durationMs: 1_000,
    exitCode: 0,
    success: true,
    agentUsed: false,
    bindingUsed: "selector",
    expectedSceneId: step.toSceneId ?? undefined,
    outcomeVerified: true,
  }));
}
