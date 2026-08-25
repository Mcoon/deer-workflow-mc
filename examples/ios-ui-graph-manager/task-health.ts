import { createHash } from "node:crypto";

import { planRoute } from "./route";
import type { AppGraph, Task } from "./types";

const UNAVAILABLE_STATUSES = new Set(["stale", "blocked", "disabled"]);
const INVALID_TASK_STATUSES = new Set(["blocked", "disabled"]);
export const DEFAULT_FAST_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_GUARDED_TASK_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type TaskHealthStatus = "fresh" | "guarded" | "stale" | "invalid";

export interface TaskHealth {
  readonly status: TaskHealthStatus;
  readonly recipeReusable: boolean;
  readonly targetSceneId?: string;
  readonly dependencyDigest: string;
  readonly validUntil?: string;
  readonly reasons: readonly string[];
}

/** Produces a stable digest of the Graph entities that a Task recipe depends on. */
export function taskDependencyDigest(graph: AppGraph, task: Task): string {
  const sceneIds = new Set<string>([task.entrySceneId]);
  const operators = task.steps.map((step) => {
    const operator = graph.operators[step.operatorId];
    if (operator?.fromSceneId) sceneIds.add(operator.fromSceneId);
    if (operator?.toSceneId) sceneIds.add(operator.toSceneId);
    const element = operator?.operation.elementId
      ? graph.scenes[operator.fromSceneId]?.elements[
          operator.operation.elementId
        ]
      : undefined;
    return {
      step,
      operator: operator
        ? {
            operatorId: operator.operatorId,
            fromSceneId: operator.fromSceneId,
            toSceneId: operator.toSceneId,
            operation: operator.operation,
            effects: operator.effects,
            risk: operator.risk,
            status: operator.status,
          }
        : null,
      element: element
        ? {
            elementId: element.elementId,
            title: element.title,
            semanticRole: element.semanticRole,
            status: element.status,
            selectors: element.selectors,
          }
        : null,
    };
  });
  for (const oracle of task.finalOracles) {
    if (oracle.type === "scene_current" && oracle.sceneId) {
      sceneIds.add(oracle.sceneId);
    }
  }
  const scenes = [...sceneIds].sort().map((sceneId) => {
    const scene = graph.scenes[sceneId];
    return scene
      ? {
          sceneId,
          status: scene.status,
          foregroundBundleId: scene.foregroundBundleId,
          visualTextAnchors: scene.visualTextAnchors,
        }
      : { sceneId, missing: true };
  });
  return createHash("sha256")
    .update(
      stableJson({
        entrySceneId: task.entrySceneId,
        steps: operators,
        finalOracles: task.finalOracles,
        parameters: task.parameters ?? {},
        scenes,
      }),
    )
    .digest("hex");
}

/** Produces a recipe identity that ignores transient viewport-position swipes. */
export function taskSemanticSignature(graph: AppGraph, task: Task): string {
  const semanticSteps = task.steps.filter(
    (_, index) => !isHistoricalViewportHint(graph, task.steps, index),
  );
  return createHash("sha256")
    .update(
      stableJson({
        entrySceneId: task.entrySceneId,
        steps: semanticSteps,
        finalOracles: task.finalOracles,
        parameters: task.parameters ?? {},
      }),
    )
    .digest("hex");
}

/** Finds the preferred existing Task with the same semantic recipe. */
export function findEquivalentTaskId(
  graph: AppGraph,
  task: Task,
): string | undefined {
  const signature = taskSemanticSignature(graph, task);
  const candidates = Object.values(graph.tasks).filter(
    (candidate) =>
      !INVALID_TASK_STATUSES.has(candidate.status) &&
      taskSemanticSignature(graph, candidate) === signature,
  );
  if (!candidates.some((candidate) => candidate.taskId === task.taskId)) {
    candidates.push(task);
  }
  return candidates.sort(
    (left, right) =>
      taskCanonicalPreference(right) - taskCanonicalPreference(left) ||
      left.taskId.localeCompare(right.taskId),
  )[0]?.taskId;
}

/** Returns whether an intent is suitable for future natural-language matching. */
export function taskIntentIsReusable(intent: string): boolean {
  const normalized = intent.trim();
  if (!normalized) return false;
  if (/^(?:scene|task|operator):/i.test(normalized)) return false;
  if (/^[a-z0-9_.:-]+$/i.test(normalized)) return false;
  return !/(?:录屏不对|重新录|当前上下文|缺少.{0,12}证据|查找并验证|调试|测试专用)/i.test(
    normalized,
  );
}

/** Calculates the validation deadline for a Task execution tier. */
export function taskValidityDeadline(
  validatedAt: string,
  tier: "guarded" | "fast" | "quarantined",
): string {
  const base = Date.parse(validatedAt);
  const ttl =
    tier === "fast" ? DEFAULT_FAST_TASK_TTL_MS : DEFAULT_GUARDED_TASK_TTL_MS;
  return new Date(
    (Number.isFinite(base) ? base : Date.now()) + ttl,
  ).toISOString();
}

/** Classifies whether a Task recipe can be reused safely in the current runtime. */
export function evaluateTaskHealth(options: {
  readonly graph: AppGraph;
  readonly task: Task;
  readonly deviceProfileId: string;
  readonly runtimeAppVersion?: string;
  readonly now?: Date;
}): TaskHealth {
  const { graph, task } = options;
  const dependencyDigest = taskDependencyDigest(graph, task);
  const structuralReasons = validateTaskStructure(graph, task);
  if (structuralReasons.length > 0 || INVALID_TASK_STATUSES.has(task.status)) {
    return {
      status: "invalid",
      recipeReusable: false,
      targetSceneId: taskTargetSceneId(task),
      dependencyDigest,
      reasons: [
        ...structuralReasons,
        ...(INVALID_TASK_STATUSES.has(task.status)
          ? [`task_status_${task.status}`]
          : []),
      ],
    };
  }
  if (task.status === "stale") {
    return {
      status: "stale",
      recipeReusable: false,
      targetSceneId: taskTargetSceneId(task),
      dependencyDigest,
      validUntil: task.validation?.validUntil,
      reasons: ["task_status_stale"],
    };
  }

  const validation = task.validation;
  if (!validation) {
    return {
      status: "guarded",
      recipeReusable: true,
      targetSceneId: taskTargetSceneId(task),
      dependencyDigest,
      reasons: ["validation_missing"],
    };
  }

  const staleReasons: string[] = [];
  if (validation.tier === "quarantined")
    staleReasons.push("recipe_quarantined");
  if (
    validation.lastValidatedAppVersion &&
    graph.appVersion &&
    validation.lastValidatedAppVersion !== graph.appVersion
  ) {
    staleReasons.push("graph_app_version_changed");
  }
  if (
    options.runtimeAppVersion &&
    graph.appVersion &&
    options.runtimeAppVersion !== graph.appVersion
  ) {
    staleReasons.push("runtime_app_version_changed");
  }
  if (
    options.runtimeAppVersion &&
    validation.lastValidatedAppVersion &&
    options.runtimeAppVersion !== validation.lastValidatedAppVersion
  ) {
    staleReasons.push("task_app_version_changed");
  }
  if (
    validation.dependencyDigest !== undefined &&
    validation.dependencyDigest !== dependencyDigest
  ) {
    staleReasons.push("dependency_changed");
  }
  const validUntil =
    validation.validUntil ??
    derivedValidUntil(validation.lastValidatedAt, validation.tier);
  if (validUntil) {
    const expiresAt = Date.parse(validUntil);
    if (!Number.isFinite(expiresAt)) {
      return {
        status: "invalid",
        recipeReusable: false,
        targetSceneId: taskTargetSceneId(task),
        dependencyDigest,
        validUntil,
        reasons: ["invalid_valid_until"],
      };
    }
    if (expiresAt <= (options.now ?? new Date()).getTime()) {
      staleReasons.push("validation_expired");
    }
  }
  if (staleReasons.length > 0) {
    return {
      status: "stale",
      recipeReusable: false,
      targetSceneId: taskTargetSceneId(task),
      dependencyDigest,
      validUntil,
      reasons: [...new Set(staleReasons)],
    };
  }
  if (!validation.dependencyDigest) {
    return {
      status: "guarded",
      recipeReusable: true,
      targetSceneId: taskTargetSceneId(task),
      dependencyDigest,
      reasons: ["dependency_digest_missing"],
    };
  }

  const guardedReasons: string[] = [];
  if (task.status !== "verified") guardedReasons.push("task_not_verified");
  if (validation.tier !== "fast") guardedReasons.push("recipe_not_fast");
  if (!validation.lastValidatedAt)
    guardedReasons.push("validation_timestamp_missing");
  if (!validation.lastValidatedAppVersion)
    guardedReasons.push("validation_app_version_missing");
  if (!validation.lastDeviceProfileId)
    guardedReasons.push("validation_device_profile_missing");
  if (
    validation.lastDeviceProfileId &&
    validation.lastDeviceProfileId !== options.deviceProfileId
  ) {
    guardedReasons.push("device_profile_changed");
  }
  if (validation.requiresFixtureReplay)
    guardedReasons.push("fixture_replay_required");
  return {
    status: guardedReasons.length === 0 ? "fresh" : "guarded",
    recipeReusable: true,
    targetSceneId: taskTargetSceneId(task),
    dependencyDigest,
    validUntil,
    reasons: guardedReasons,
  };
}

/** Returns whether a stale Task may safely be replaced by a fresh Scene route. */
export function canReplanTaskAsScene(graph: AppGraph, task: Task): boolean {
  const targetSceneId = taskTargetSceneId(task);
  if (!targetSceneId || targetSceneId === task.entrySceneId) return false;
  const passiveOracleTypes = new Set([
    "scene_current",
    "foreground_bundle",
    "text_visible",
    "text_absent",
    "ui_text_visible",
    "ui_text_absent",
    "all_text_visible",
    "any_text_visible",
    "region_stable",
  ]);
  if (
    task.finalOracles.some((oracle) => !passiveOracleTypes.has(oracle.type))
  ) {
    return false;
  }
  return task.steps.every((step) => {
    const risk = graph.operators[step.operatorId]?.risk ?? "interaction";
    return risk === "navigation" || risk === "interaction";
  });
}

/** Migrates Task metadata and removes duplicate or non-reusable runtime recipes. */
export function migrateTaskCatalog(
  graph: AppGraph,
  options?: { readonly appVersion?: string; readonly now?: Date },
): AppGraph {
  const migrated = structuredClone(graph) as AppGraph;
  const tasks = migrated.tasks as Record<string, Task>;
  for (const task of Object.values(tasks)) {
    const filteredSteps = task.steps.filter(
      (_, index) => !isHistoricalViewportHint(migrated, task.steps, index),
    );
    tasks[task.taskId] = { ...task, steps: filteredSteps };
  }
  for (const task of Object.values(tasks)) {
    if (
      task.taskId.startsWith("runtime.task.") &&
      task.intents.every((intent) => !taskIntentIsReusable(intent))
    ) {
      delete tasks[task.taskId];
    }
  }

  const groups = new Map<string, Task[]>();
  for (const task of Object.values(tasks)) {
    const signature = taskSemanticSignature(migrated, task);
    groups.set(signature, [...(groups.get(signature) ?? []), task]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(
      (left, right) =>
        taskCanonicalPreference(right) - taskCanonicalPreference(left) ||
        left.taskId.localeCompare(right.taskId),
    );
    const canonical = ordered[0]!;
    const mergedIntents = [
      ...new Set(
        group.flatMap((task) => task.intents).filter(taskIntentIsReusable),
      ),
    ];
    tasks[canonical.taskId] = {
      ...canonical,
      intents: mergedIntents.length > 0 ? mergedIntents : canonical.intents,
    };
    for (const duplicate of ordered.slice(1)) delete tasks[duplicate.taskId];
  }
  const revision = graph.revision + 1;
  const now = (options?.now ?? new Date()).toISOString();
  const next = {
    ...migrated,
    appVersion: options?.appVersion ?? graph.appVersion,
    revision,
    updatedAt: now,
    tasks,
  } as AppGraph;
  for (const task of Object.values(tasks)) {
    const previous = task.validation;
    const source = previous?.source ?? "declared";
    const validatedForTargetVersion =
      Boolean(previous?.lastValidatedAt) &&
      Boolean(previous?.lastValidatedAppVersion) &&
      previous!.lastValidatedAppVersion === next.appVersion;
    const tier = validatedForTargetVersion
      ? (previous?.tier ?? "guarded")
      : "guarded";
    tasks[task.taskId] = {
      ...task,
      validation: {
        source,
        sourceGoals: [
          ...new Set(
            [...(previous?.sourceGoals ?? []), ...task.intents].filter(
              taskIntentIsReusable,
            ),
          ),
        ],
        tier,
        successfulExecutions: previous?.successfulExecutions ?? 0,
        failedExecutions: previous?.failedExecutions ?? 0,
        consecutiveSuccessfulExecutions:
          previous?.consecutiveSuccessfulExecutions ?? 0,
        consecutiveFailedExecutions: previous?.consecutiveFailedExecutions ?? 0,
        evidencePaths: previous?.evidencePaths ?? [],
        lastValidatedAt: validatedForTargetVersion
          ? previous?.lastValidatedAt
          : undefined,
        lastFailedAt: previous?.lastFailedAt,
        lastValidatedAppVersion: validatedForTargetVersion
          ? previous?.lastValidatedAppVersion
          : undefined,
        lastDeviceProfileId: validatedForTargetVersion
          ? previous?.lastDeviceProfileId
          : undefined,
        validatedGraphRevision: validatedForTargetVersion
          ? previous?.validatedGraphRevision
          : undefined,
        dependencyDigest: taskDependencyDigest(next, task),
        validUntil:
          validatedForTargetVersion && previous?.lastValidatedAt
            ? taskValidityDeadline(previous.lastValidatedAt, tier)
            : undefined,
        lastFailure: previous?.lastFailure,
        requiresFixtureReplay: previous?.requiresFixtureReplay,
      },
    };
  }
  return next;
}

/** Normalizes Task intents and semantic duplicates before every Graph write. */
export function normalizeTaskCatalogForWrite(graph: AppGraph): AppGraph {
  const normalized = structuredClone(graph) as AppGraph;
  const tasks = normalized.tasks as Record<string, Task>;
  for (const task of Object.values(tasks)) {
    tasks[task.taskId] = {
      ...task,
      intents: [...new Set(task.intents.filter(taskIntentIsReusable))],
    };
  }
  for (const task of Object.values(tasks)) {
    if (task.taskId.startsWith("runtime.task.") && task.intents.length === 0) {
      delete tasks[task.taskId];
    }
  }
  const groups = new Map<string, Task[]>();
  for (const task of Object.values(tasks)) {
    const signature = taskSemanticSignature(normalized, task);
    groups.set(signature, [...(groups.get(signature) ?? []), task]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(
      (left, right) =>
        taskCanonicalPreference(right) - taskCanonicalPreference(left) ||
        left.taskId.localeCompare(right.taskId),
    );
    const canonical = ordered[0]!;
    tasks[canonical.taskId] = {
      ...canonical,
      intents: [...new Set(group.flatMap((task) => task.intents))],
    };
    for (const duplicate of ordered.slice(1)) delete tasks[duplicate.taskId];
  }
  return normalized;
}

function derivedValidUntil(
  lastValidatedAt: string | undefined,
  tier: "guarded" | "fast" | "quarantined",
): string | undefined {
  return lastValidatedAt
    ? taskValidityDeadline(lastValidatedAt, tier)
    : undefined;
}

function taskTargetSceneId(task: Task): string | undefined {
  return task.finalOracles.find(
    (oracle) => oracle.type === "scene_current" && oracle.sceneId,
  )?.sceneId;
}

function validateTaskStructure(graph: AppGraph, task: Task): string[] {
  const reasons: string[] = [];
  const entry = graph.scenes[task.entrySceneId];
  if (!entry) return ["entry_scene_missing"];
  if (UNAVAILABLE_STATUSES.has(entry.status))
    reasons.push("entry_scene_unavailable");
  let cursor = task.entrySceneId;
  for (const taskStep of task.steps) {
    const operator = graph.operators[taskStep.operatorId];
    if (!operator) {
      reasons.push(`operator_missing:${taskStep.operatorId}`);
      continue;
    }
    if (UNAVAILABLE_STATUSES.has(operator.status)) {
      reasons.push(`operator_unavailable:${operator.operatorId}`);
    }
    if (
      operator.fromSceneId !== cursor &&
      !planRoute(graph, cursor, operator.fromSceneId)
    ) {
      reasons.push(`operator_entry_unreachable:${operator.operatorId}`);
    }
    const sourceScene = graph.scenes[operator.fromSceneId];
    if (UNAVAILABLE_STATUSES.has(sourceScene?.status ?? "disabled")) {
      reasons.push(`operator_source_unavailable:${operator.operatorId}`);
    }
    if (operator.toSceneId) {
      const targetScene = graph.scenes[operator.toSceneId];
      if (UNAVAILABLE_STATUSES.has(targetScene?.status ?? "disabled")) {
        reasons.push(`operator_target_unavailable:${operator.operatorId}`);
      }
    }
    if (operator.operation.elementId) {
      const element = sourceScene?.elements[operator.operation.elementId];
      if (!element)
        reasons.push(`element_missing:${operator.operation.elementId}`);
      else if (UNAVAILABLE_STATUSES.has(element.status)) {
        reasons.push(`element_unavailable:${element.elementId}`);
      } else if (element.selectors.length === 0) {
        reasons.push(`element_selectors_missing:${element.elementId}`);
      }
    }
    cursor = operator.toSceneId ?? operator.fromSceneId;
  }
  if (task.finalOracles.length === 0) reasons.push("final_oracles_missing");
  for (const oracle of task.finalOracles) {
    if (oracle.type !== "scene_current") continue;
    if (!oracle.sceneId || !graph.scenes[oracle.sceneId]) {
      reasons.push(`oracle_scene_missing:${oracle.sceneId ?? ""}`);
    } else if (UNAVAILABLE_STATUSES.has(graph.scenes[oracle.sceneId]!.status)) {
      reasons.push(`oracle_scene_unavailable:${oracle.sceneId}`);
    } else if (cursor !== oracle.sceneId) {
      reasons.push(`oracle_scene_not_reached:${oracle.sceneId}`);
    }
  }
  return [...new Set(reasons)];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function taskCanonicalPreference(task: Task): number {
  return (
    (task.status === "stale" ||
    task.status === "blocked" ||
    task.status === "disabled"
      ? -10
      : 0) +
    (task.validation?.source === "declared" || !task.validation ? 4 : 0) +
    (task.status === "verified" ? 2 : 0) +
    (task.validation?.tier === "fast" ? 1 : 0)
  );
}

function isHistoricalViewportHint(
  graph: AppGraph,
  steps: Task["steps"],
  index: number,
): boolean {
  const operator = graph.operators[steps[index]?.operatorId ?? ""];
  if (
    !operator ||
    operator.operation.type !== "swipe" ||
    operator.toSceneId !== operator.fromSceneId
  ) {
    return false;
  }
  for (let nextIndex = index + 1; nextIndex < steps.length; nextIndex += 1) {
    const next = graph.operators[steps[nextIndex]?.operatorId ?? ""];
    if (!next || next.fromSceneId !== operator.fromSceneId) return false;
    if (
      next.operation.type === "swipe" &&
      next.toSceneId === operator.fromSceneId
    ) {
      continue;
    }
    return Boolean(
      next.operation.elementId &&
      (next.operation.type === "tap" || next.operation.type === "long_press"),
    );
  }
  return false;
}
