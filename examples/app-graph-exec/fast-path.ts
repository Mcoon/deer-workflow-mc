import type {
  AppGraph,
  Binding,
  Operator,
  Task,
} from "../ios-ui-graph-manager/types";
import type { AppGraphPlanResult } from "../app-graph-plan/types";
import type { ExecStepRecord } from "./types";
import { isHistoricalViewportHintStep } from "./viewport-search";

export interface FastRecipeStep {
  readonly operator: Operator;
  readonly binding?: Binding;
  readonly command: readonly string[];
}

export function compileFastRecipe(options: {
  graph: AppGraph;
  plan: AppGraphPlanResult;
  deviceProfileId: string;
  udid: string;
}): { task: Task; steps: readonly FastRecipeStep[] } | null {
  const taskId = options.plan.matchedTaskId;
  const task = taskId ? options.graph.tasks[taskId] : undefined;
  if (!task || task.status !== "verified" || task.validation?.tier !== "fast") {
    return null;
  }
  if (
    task.validation.lastValidatedAppVersion !== options.graph.appVersion ||
    task.validation.lastDeviceProfileId !== options.deviceProfileId
  ) {
    return null;
  }
  const profile = options.graph.deviceProfiles[options.deviceProfileId];
  if (!profile) return null;
  if (
    options.plan.resolvedSteps.some((_, index) =>
      isHistoricalViewportHintStep(options.plan.resolvedSteps, index),
    )
  ) {
    return null;
  }
  const steps: FastRecipeStep[] = [];
  for (const taskStep of task.steps) {
    const operator = options.graph.operators[taskStep.operatorId];
    if (
      !operator ||
      operator.status !== "verified" ||
      operator.execution?.tier !== "fast" ||
      operator.execution.lastValidatedAppVersion !== options.graph.appVersion ||
      operator.execution.lastDeviceProfileId !== options.deviceProfileId
    ) {
      return null;
    }
    if (operator.operation.type === "swipe") {
      if (!operator.operation.from || !operator.operation.to) return null;
      steps.push({
        operator,
        command: [
          "mobilecli",
          "io",
          "swipe",
          "--device",
          options.udid,
          `${operator.operation.from.x},${operator.operation.from.y},${operator.operation.to.x},${operator.operation.to.y}`,
        ],
      });
      continue;
    }
    if (
      operator.operation.type !== "tap" &&
      operator.operation.type !== "long_press"
    ) {
      return null;
    }
    const elementId = operator.operation.elementId;
    const element = elementId
      ? options.graph.scenes[operator.fromSceneId]?.elements[elementId]
      : undefined;
    const binding = element?.bindings[options.deviceProfileId];
    if (
      !element ||
      !binding ||
      binding.status !== "verified" ||
      binding.execution?.tier !== "fast" ||
      binding.execution.lastValidatedAppVersion !== options.graph.appVersion ||
      binding.execution.lastDeviceProfileId !== options.deviceProfileId ||
      binding.normalizedPoint.x < 0 ||
      binding.normalizedPoint.x >= 1 ||
      binding.normalizedPoint.y < 0 ||
      binding.normalizedPoint.y >= 1
    ) {
      return null;
    }
    const x = Math.round(binding.normalizedPoint.x * profile.viewportWidth);
    const y = Math.round(binding.normalizedPoint.y * profile.viewportHeight);
    const command =
      operator.operation.type === "tap"
        ? ["mobilecli", "io", "tap", "--device", options.udid, `${x},${y}`]
        : [
            "mobilecli",
            "io",
            "longpress",
            "--device",
            options.udid,
            `${x},${y}`,
            "--duration",
            String(operator.operation.durationMs ?? 800),
          ];
    steps.push({ operator, binding, command });
  }
  return { task, steps };
}

export async function executeFastRecipe(options: {
  recipe: NonNullable<ReturnType<typeof compileFastRecipe>>;
  outputDir: string;
  commandRunner: (
    command: readonly string[],
    cwd?: string,
  ) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}): Promise<{ success: boolean; records: ExecStepRecord[]; error?: string }> {
  const records: ExecStepRecord[] = [];
  for (const [index, item] of options.recipe.steps.entries()) {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const result = await options.commandRunner(item.command, process.cwd());
    const record: ExecStepRecord = {
      stepIndex: index,
      operatorId: item.operator.operatorId,
      action: item.operator.operation.type,
      actionDescription: `Fast recipe: ${item.operator.operatorId}`,
      targetElementId: item.operator.operation.elementId,
      normalizedPoint: item.binding?.normalizedPoint,
      resolutionSource: item.binding ? "binding_fallback" : "operation",
      commands: [item.command],
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      exitCode: result.exitCode,
      success: result.exitCode === 0,
      error: result.exitCode === 0 ? undefined : result.stderr.slice(0, 500),
      agentUsed: false,
      bindingUsed: item.binding ? "verified" : "operation",
      expectedSceneId: item.operator.toSceneId ?? item.operator.fromSceneId,
      outcomeVerified: false,
    };
    records.push(record);
    if (!record.success) {
      return { success: false, records, error: record.error };
    }
    await Bun.sleep(item.operator.settleMs ?? 700);
  }
  return { success: true, records };
}
