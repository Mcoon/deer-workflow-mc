import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import graphJson from "../../examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json";
import { WorkflowRunner } from "@deerwork-ai/deer-workflow/runner";

import {
  compileFastRecipe,
  executeFastRecipe,
} from "../../examples/app-graph-exec/fast-path";
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
const planWorkflowPath = join(
  process.cwd(),
  "examples/app-graph-plan/workflow.ts",
);

describe("App Graph runtime learning", () => {
  test("promotes a repeated Scene route into a verified fast Task recipe", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-learning-"));
    const graphPath = join(root, "graph.json");
    await writeFile(graphPath, JSON.stringify(graph), "utf8");
    const runner = new WorkflowRunner({ logWriter: () => undefined });
    try {
      const plan = await runner.run<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "测试专用打开帮助反馈路径",
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
        graph,
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
        "bot.settings.settings_scroll_region.swipe_up.bot.settings",
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
        executionTier: "fast",
      });
      expect(second.graph.tasks[taskId]?.validation).toMatchObject({
        tier: "fast",
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
      });
      expect(recipe?.steps.map((step) => step.command[2])).toEqual([
        "tap",
        "swipe",
        "tap",
      ]);
      const commands: readonly string[][] = [];
      const mutableCommands = commands as string[][];
      const executed = await executeFastRecipe({
        recipe: recipe!,
        outputDir: join(root, "fast"),
        commandRunner: async (command) => {
          mutableCommands.push([...command]);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      expect(executed.success).toBeTrue();
      expect(mutableCommands).toHaveLength(3);
      expect(JSON.parse(await readFile(graphPath, "utf8"))).toMatchObject({
        revision: graph.revision + 2,
        tasks: {
          [taskId]: { status: "verified", validation: { tier: "fast" } },
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
