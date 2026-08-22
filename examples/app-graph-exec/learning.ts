import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyAndSave, loadGraph } from "../ios-ui-graph-manager";
import type {
  AppGraph,
  Binding,
  ExecutionTrust,
  GraphEntityStatus,
  GraphPatch,
  Operator,
  Task,
  TaskStep,
} from "../ios-ui-graph-manager/types";
import type { AppGraphPlanResult } from "../app-graph-plan/types";
import type { ExecStepRecord } from "./types";
import type { RuntimeCandidate, RuntimeObservation } from "./runtime-recovery";
import { isHistoricalViewportHintStep } from "./viewport-search";

export interface RuntimeLearningResult {
  readonly graph: AppGraph;
  readonly graphUpdated: boolean;
  readonly patchPath?: string;
  readonly taskId?: string;
  readonly taskStatus?: GraphEntityStatus;
  readonly executionTier?: "guarded" | "fast" | "quarantined";
}

export async function persistFastFailureLearning(options: {
  graphPath: string;
  graph: AppGraph;
  taskId: string;
  deviceProfileId: string;
  outputDir: string;
  evidencePath: string;
  failure: string;
}): Promise<RuntimeLearningResult> {
  const task = options.graph.tasks[options.taskId];
  if (!task) return { graph: options.graph, graphUpdated: false };
  const now = new Date().toISOString();
  const previousTask = task.validation;
  const consecutiveFailedExecutions =
    (previousTask?.consecutiveFailedExecutions ?? 0) + 1;
  const tier = consecutiveFailedExecutions >= 2 ? "quarantined" : "guarded";
  const operators: NonNullable<GraphPatch["operators"]> = {};
  const scenes: NonNullable<GraphPatch["scenes"]> = {};
  for (const taskStep of task.steps) {
    const operator = options.graph.operators[taskStep.operatorId];
    if (!operator) continue;
    const previous = operator.execution;
    const operatorConsecutiveFailures =
      (previous?.consecutiveFailedExecutions ?? 0) + 1;
    operators[operator.operatorId] = {
      ...operator,
      executionStats: {
        ...operator.executionStats,
        fail: operator.executionStats.fail + 1,
        lastExecutedAt: now,
      },
      execution: {
        tier: operatorConsecutiveFailures >= 2 ? "quarantined" : "guarded",
        successfulExecutions: previous?.successfulExecutions ?? 0,
        failedExecutions: (previous?.failedExecutions ?? 0) + 1,
        consecutiveSuccessfulExecutions: 0,
        consecutiveFailedExecutions: operatorConsecutiveFailures,
        evidencePaths: unique([
          ...(previous?.evidencePaths ?? []),
          options.evidencePath,
        ]),
        lastValidatedAt: previous?.lastValidatedAt,
        lastFailedAt: now,
        lastValidatedAppVersion: previous?.lastValidatedAppVersion,
        lastDeviceProfileId: previous?.lastDeviceProfileId,
        lastFailure: options.failure,
      },
    };
    const elementId = operator.operation.elementId;
    const scene = elementId
      ? options.graph.scenes[operator.fromSceneId]
      : undefined;
    const element = elementId ? scene?.elements[elementId] : undefined;
    const binding = element?.bindings[options.deviceProfileId];
    if (!scene || !element || !binding) continue;
    const trust = binding.execution;
    const bindingFailures = (trust?.consecutiveFailedExecutions ?? 0) + 1;
    const pendingScene = scenes[scene.sceneId] ?? scene;
    scenes[scene.sceneId] = {
      ...pendingScene,
      sceneId: scene.sceneId,
      elements: {
        ...(pendingScene.elements ?? scene.elements),
        [element.elementId]: {
          ...element,
          bindings: {
            ...element.bindings,
            [options.deviceProfileId]: {
              ...binding,
              execution: {
                tier: bindingFailures >= 2 ? "quarantined" : "guarded",
                successfulExecutions: trust?.successfulExecutions ?? 0,
                failedExecutions: (trust?.failedExecutions ?? 0) + 1,
                consecutiveSuccessfulExecutions: 0,
                consecutiveFailedExecutions: bindingFailures,
                evidencePaths: unique([
                  ...(trust?.evidencePaths ?? []),
                  options.evidencePath,
                ]),
                lastValidatedAt: trust?.lastValidatedAt,
                lastFailedAt: now,
                lastValidatedAppVersion: trust?.lastValidatedAppVersion,
                lastDeviceProfileId: trust?.lastDeviceProfileId,
                lastFailure: options.failure,
              },
            },
          },
        },
      },
    };
  }
  const patch: GraphPatch = {
    schemaVersion: "ios-ui-graph-patch/v2",
    graphId: options.graph.graphId,
    baseRevision: options.graph.revision,
    source: "navigator",
    scenes: Object.keys(scenes).length ? scenes : undefined,
    operators,
    tasks: {
      [task.taskId]: {
        ...task,
        validation: {
          source: previousTask?.source ?? "runtime_composition",
          sourceGoals: previousTask?.sourceGoals ?? task.intents,
          tier,
          successfulExecutions: previousTask?.successfulExecutions ?? 0,
          failedExecutions: (previousTask?.failedExecutions ?? 0) + 1,
          consecutiveSuccessfulExecutions: 0,
          consecutiveFailedExecutions,
          evidencePaths: unique([
            ...(previousTask?.evidencePaths ?? []),
            options.evidencePath,
          ]),
          lastValidatedAt: previousTask?.lastValidatedAt,
          lastFailedAt: now,
          lastValidatedAppVersion: previousTask?.lastValidatedAppVersion,
          lastDeviceProfileId: previousTask?.lastDeviceProfileId,
          lastFailure: options.failure,
          requiresFixtureReplay: previousTask?.requiresFixtureReplay,
        },
      },
    },
    evidencePaths: [options.evidencePath],
  };
  const directory = join(options.outputDir, "runtime-graph-patches");
  await mkdir(directory, { recursive: true });
  const patchPath = join(directory, "fast-failure-downgrade.json");
  await writeFile(patchPath, JSON.stringify(patch, null, 2), "utf8");
  const applied = await applyAndSave(options.graphPath, patch);
  return applied.success
    ? {
        graph: await loadGraph(options.graphPath),
        graphUpdated: true,
        patchPath,
        taskId: task.taskId,
        taskStatus: task.status,
        executionTier: tier,
      }
    : { graph: options.graph, graphUpdated: false };
}

export async function persistSuccessfulExecutionLearning(options: {
  graphPath: string;
  graph: AppGraph;
  plan: AppGraphPlanResult;
  goal: string;
  steps: readonly ExecStepRecord[];
  deviceProfileId: string;
  outputDir: string;
  evidencePath: string;
  finalSceneEvidence?: {
    readonly screenshotPath: string;
    readonly uiDumpPath: string;
    readonly ocrPath?: string;
  };
  agentElementResolutions?: readonly {
    readonly stepIndex: number;
    readonly candidate: RuntimeCandidate;
    readonly observation: RuntimeObservation;
  }[];
}): Promise<RuntimeLearningResult> {
  const now = new Date().toISOString();
  const evidencePaths = [options.evidencePath];
  const operators: NonNullable<GraphPatch["operators"]> = {};
  const recipe: TaskStep[] = [];
  const graph = options.graph;

  for (const record of options.steps) {
    const planStep = options.plan.resolvedSteps[record.stepIndex];
    if (!planStep) continue;
    if (
      isHistoricalViewportHintStep(
        options.plan.resolvedSteps,
        record.stepIndex,
      ) &&
      record.commands.length === 0
    ) {
      continue;
    }
    for (const command of record.visibilityRecoveryCommands ?? []) {
      const scrollOperator = findOrCreateScrollOperator({
        graph,
        pendingOperators: operators,
        fromSceneId: planStep.fromSceneId,
        command,
      });
      if (!scrollOperator) continue;
      const updated = applyOperatorSuccess(
        scrollOperator,
        graph.appVersion,
        options.deviceProfileId,
        evidencePaths,
        now,
      );
      operators[updated.operatorId] = updated;
      recipe.push({ operatorId: updated.operatorId });
    }

    const operator =
      operators[record.operatorId] ?? graph.operators[record.operatorId];
    if (!operator) continue;
    const updated = applyOperatorSuccess(
      operator as Operator,
      graph.appVersion,
      options.deviceProfileId,
      evidencePaths,
      now,
    );
    operators[updated.operatorId] = updated;
    recipe.push({ operatorId: updated.operatorId });
  }

  const taskId =
    options.plan.matchedTaskId ??
    runtimeTaskId(options.goal, options.plan.targetSceneId);
  const existingTask = graph.tasks[taskId];
  const previousValidation = existingTask?.validation;
  const evidenceIsNew = !(previousValidation?.evidencePaths ?? []).includes(
    options.evidencePath,
  );
  const successfulExecutions =
    (previousValidation?.successfulExecutions ?? 0) + (evidenceIsNew ? 1 : 0);
  const status: GraphEntityStatus = existingTask
    ? existingTask.status === "verified"
      ? "verified"
      : successfulExecutions >= 2
        ? "verified"
        : "candidate"
    : successfulExecutions >= 2
      ? "verified"
      : "candidate";
  const hasHistoricalViewportHint = options.plan.resolvedSteps.some(
    (_, index) =>
      isHistoricalViewportHintStep(options.plan.resolvedSteps, index),
  );
  const usedViewportSearch = options.steps.some(
    (record) => (record.visibilityRecoveryCommands?.length ?? 0) > 0,
  );
  const tier =
    successfulExecutions >= 2 &&
    !hasHistoricalViewportHint &&
    !usedViewportSearch
      ? "fast"
      : "guarded";
  const task: Task = {
    ...(existingTask ?? {}),
    taskId,
    intents: unique([...(existingTask?.intents ?? []), options.goal]),
    entrySceneId: options.plan.entrySceneId,
    steps: recipe,
    finalOracles: options.plan.finalOracles,
    status,
    parameters: existingTask?.parameters ?? {},
    validation: {
      source:
        existingTask?.validation?.source ??
        (existingTask ? "declared" : "runtime_composition"),
      sourceGoals: unique([
        ...(previousValidation?.sourceGoals ?? existingTask?.intents ?? []),
        options.goal,
      ]),
      tier,
      successfulExecutions,
      failedExecutions: previousValidation?.failedExecutions ?? 0,
      consecutiveSuccessfulExecutions:
        (previousValidation?.consecutiveSuccessfulExecutions ?? 0) +
        (evidenceIsNew ? 1 : 0),
      consecutiveFailedExecutions: 0,
      evidencePaths: unique([
        ...(previousValidation?.evidencePaths ?? []),
        ...evidencePaths,
      ]),
      lastValidatedAt: now,
      lastFailedAt: previousValidation?.lastFailedAt,
      lastValidatedAppVersion: graph.appVersion,
      lastDeviceProfileId: options.deviceProfileId,
      lastFailure: undefined,
      requiresFixtureReplay: previousValidation?.requiresFixtureReplay,
    },
  };

  const scenes: NonNullable<GraphPatch["scenes"]> = {};
  for (const record of options.steps) {
    const planStep = options.plan.resolvedSteps[record.stepIndex];
    if (!planStep?.targetElement || !record.normalizedPoint) continue;
    const scene = graph.scenes[planStep.fromSceneId];
    const element = scene?.elements[planStep.targetElement.elementId];
    if (!scene || !element) continue;
    const previous = element.bindings[options.deviceProfileId];
    const agentResolution = options.agentElementResolutions?.find(
      (candidate) => candidate.stepIndex === record.stepIndex,
    );
    const updatedBinding = applyBindingSuccess(
      previous,
      options.deviceProfileId,
      record.normalizedPoint,
      graph.appVersion,
      evidencePaths,
      now,
    );
    const pendingScene = scenes[scene.sceneId] ?? scene;
    scenes[scene.sceneId] = {
      ...pendingScene,
      sceneId: scene.sceneId,
      elements: {
        ...(pendingScene.elements ?? scene.elements),
        [element.elementId]: {
          ...element,
          selectors: agentResolution
            ? uniqueSelectors([
                ...element.selectors,
                ...candidateSelectors(agentResolution.candidate),
              ])
            : element.selectors,
          bindings: {
            ...element.bindings,
            [options.deviceProfileId]: updatedBinding,
          },
        },
      },
    };
  }
  const targetSceneId = options.plan.finalOracles.find(
    (oracle) => oracle.type === "scene_current" && oracle.sceneId,
  )?.sceneId;
  const targetScene = targetSceneId ? graph.scenes[targetSceneId] : undefined;
  if (targetSceneId && targetScene && options.finalSceneEvidence) {
    const pendingScene = scenes[targetSceneId] ?? targetScene;
    scenes[targetSceneId] = {
      ...pendingScene,
      sceneId: targetSceneId,
      referenceAssets: [
        ...targetScene.referenceAssets,
        {
          screenshot: options.finalSceneEvidence.screenshotPath,
          uiDump: options.finalSceneEvidence.uiDumpPath,
          ...(options.finalSceneEvidence.ocrPath
            ? { ocr: options.finalSceneEvidence.ocrPath }
            : {}),
        },
      ],
    };
  }

  const patch: GraphPatch = {
    schemaVersion: "ios-ui-graph-patch/v2",
    graphId: graph.graphId,
    baseRevision: graph.revision,
    source: "navigator",
    scenes: Object.keys(scenes).length ? scenes : undefined,
    operators,
    tasks: { [task.taskId]: task },
    evidencePaths,
  };
  const directory = join(options.outputDir, "runtime-graph-patches");
  await mkdir(directory, { recursive: true });
  const patchPath = join(directory, "runtime-learning.json");
  await writeFile(patchPath, JSON.stringify(patch, null, 2), "utf8");
  const applied = await applyAndSave(options.graphPath, patch);
  if (!applied.success) {
    return {
      graph,
      graphUpdated: false,
      taskId,
      taskStatus: status,
      executionTier: tier,
    };
  }
  return {
    graph: await loadGraph(options.graphPath),
    graphUpdated: true,
    patchPath,
    taskId,
    taskStatus: status,
    executionTier: tier,
  };
}

export async function promoteSceneReferenceAssets(options: {
  graphPath: string;
  graph: AppGraph;
  sceneId: string;
  screenshotPath: string;
  uiDumpPath: string;
  ocrPath?: string;
}): Promise<{ graphUpdated: boolean }> {
  const scene = options.graph.scenes[options.sceneId];
  if (!scene) {
    return { graphUpdated: false };
  }

  const scenes: NonNullable<GraphPatch["scenes"]> = {
    [options.sceneId]: {
      ...scene,
      referenceAssets: [
        ...scene.referenceAssets,
        {
          screenshot: options.screenshotPath,
          uiDump: options.uiDumpPath,
          ...(options.ocrPath ? { ocr: options.ocrPath } : {}),
        },
      ],
    },
  };

  const patch: GraphPatch = {
    schemaVersion: "ios-ui-graph-patch/v2",
    graphId: options.graph.graphId,
    baseRevision: options.graph.revision,
    source: "navigator",
    scenes,
  };

  const applied = await applyAndSave(options.graphPath, patch);
  return { graphUpdated: applied.success };
}

export function runtimeTaskId(goal: string, targetSceneId?: string): string {
  const identity = `${normalize(goal)}|${targetSceneId ?? "unknown"}`;
  return `runtime.task.${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

function applyOperatorSuccess(
  operator: Operator,
  appVersion: string | undefined,
  deviceProfileId: string,
  evidencePaths: readonly string[],
  now: string,
): Operator {
  const previous = operator.execution;
  const successfulExecutions = (previous?.successfulExecutions ?? 0) + 1;
  const consecutiveSuccessfulExecutions =
    (previous?.consecutiveSuccessfulExecutions ?? 0) + 1;
  const execution: ExecutionTrust = {
    tier: consecutiveSuccessfulExecutions >= 2 ? "fast" : "guarded",
    successfulExecutions,
    failedExecutions: previous?.failedExecutions ?? 0,
    consecutiveSuccessfulExecutions,
    consecutiveFailedExecutions: 0,
    evidencePaths: unique([
      ...(previous?.evidencePaths ?? []),
      ...evidencePaths,
    ]),
    lastValidatedAt: now,
    lastFailedAt: previous?.lastFailedAt,
    lastValidatedAppVersion: appVersion,
    lastDeviceProfileId: deviceProfileId,
    lastFailure: undefined,
  };
  return {
    ...operator,
    status:
      operator.status === "verified" || successfulExecutions >= 2
        ? "verified"
        : "candidate",
    executionStats: {
      ...operator.executionStats,
      pass: operator.executionStats.pass + 1,
      lastExecutedAt: now,
    },
    execution,
  };
}

function applyBindingSuccess(
  previous: Binding | undefined,
  deviceProfileId: string,
  normalizedPoint: { readonly x: number; readonly y: number },
  appVersion: string | undefined,
  evidencePaths: readonly string[],
  now: string,
): Binding {
  const trust = previous?.execution;
  const successfulExecutions = (trust?.successfulExecutions ?? 0) + 1;
  const consecutiveSuccessfulExecutions =
    (trust?.consecutiveSuccessfulExecutions ?? 0) + 1;
  return {
    deviceProfileId,
    normalizedPoint,
    source: previous?.source === "manual" ? "manual" : "ui_dump",
    status:
      previous?.status === "verified" || successfulExecutions >= 2
        ? "verified"
        : "candidate",
    observedAt: now,
    appVersion,
    execution: {
      tier: consecutiveSuccessfulExecutions >= 2 ? "fast" : "guarded",
      successfulExecutions,
      failedExecutions: trust?.failedExecutions ?? 0,
      consecutiveSuccessfulExecutions,
      consecutiveFailedExecutions: 0,
      evidencePaths: unique([
        ...(trust?.evidencePaths ?? []),
        ...evidencePaths,
      ]),
      lastValidatedAt: now,
      lastFailedAt: trust?.lastFailedAt,
      lastValidatedAppVersion: appVersion,
      lastDeviceProfileId: deviceProfileId,
      lastFailure: undefined,
    },
  };
}

function findOrCreateScrollOperator(options: {
  graph: AppGraph;
  pendingOperators: NonNullable<GraphPatch["operators"]>;
  fromSceneId: string;
  command: readonly string[];
}): Operator | null {
  const coordinates = options.command.at(-1)?.split(",").map(Number);
  if (
    !coordinates ||
    coordinates.length !== 4 ||
    coordinates.some(Number.isNaN)
  ) {
    return null;
  }
  const [fromX, fromY, toX, toY] = coordinates as [
    number,
    number,
    number,
    number,
  ];
  const candidates = [
    ...Object.values(options.pendingOperators),
    ...Object.values(options.graph.operators),
  ].filter((operator): operator is Operator => {
    const operation = operator.operation;
    return (
      operator.fromSceneId === options.fromSceneId &&
      (operator.toSceneId === options.fromSceneId ||
        operator.toSceneId === null) &&
      operation?.type === "swipe" &&
      Boolean(operation.from && operation.to)
    );
  });
  const sameDirection = candidates
    .map((operator) => ({
      operator,
      distance:
        Math.abs(operator.operation.from!.x - fromX) +
        Math.abs(operator.operation.from!.y - fromY) +
        Math.abs(operator.operation.to!.x - toX) +
        Math.abs(operator.operation.to!.y - toY),
      directionMatches:
        Math.sign(operator.operation.to!.y - operator.operation.from!.y) ===
          Math.sign(toY - fromY) &&
        Math.sign(operator.operation.to!.x - operator.operation.from!.x) ===
          Math.sign(toX - fromX),
    }))
    .filter((item) => item.directionMatches)
    .sort((left, right) => left.distance - right.distance)[0];
  if (sameDirection) return sameDirection.operator;
  const operatorId = `runtime.operator.scroll.${createHash("sha256")
    .update(`${options.fromSceneId}|${fromX},${fromY},${toX},${toY}`)
    .digest("hex")
    .slice(0, 12)}`;
  return {
    operatorId,
    fromSceneId: options.fromSceneId,
    toSceneId: options.fromSceneId,
    operation: {
      type: "swipe",
      from: { x: fromX, y: fromY },
      to: { x: toX, y: toY },
    },
    effects: [{ type: "ui_change", key: "viewport.changed", value: true }],
    status: "candidate",
    executionStats: { pass: 0, fail: 0 },
    risk: "navigation",
    settleMs: 700,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueSelectors(
  selectors: readonly {
    readonly type:
      "accessibilityIdentifier" | "label" | "role" | "text" | "value";
    readonly value: string;
  }[],
) {
  const seen = new Set<string>();
  return selectors.filter((selector) => {
    const key = `${selector.type}:${normalize(selector.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateSelectors(candidate: RuntimeCandidate) {
  return [
    candidate.accessibilityId
      ? {
          type: "accessibilityIdentifier" as const,
          value: candidate.accessibilityId,
        }
      : undefined,
    candidate.label
      ? { type: "label" as const, value: candidate.label }
      : undefined,
    candidate.text
      ? { type: "text" as const, value: candidate.text }
      : undefined,
    candidate.value
      ? { type: "value" as const, value: candidate.value }
      : undefined,
    candidate.role
      ? { type: "role" as const, value: candidate.role }
      : undefined,
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
