import type { Element, Operator, Scene, Task } from "./types";

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}

export function validateGraph(graph: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!graph || typeof graph !== "object") {
    return {
      valid: false,
      errors: ["Graph must be a non-null object."],
      warnings: [],
    };
  }

  const g = graph as Record<string, unknown>;

  if (g.schemaVersion !== "ios-executable-ui-graph/v2") {
    errors.push(
      `schemaVersion must be "ios-executable-ui-graph/v2", got "${String(g.schemaVersion)}".`,
    );
  }

  if (typeof g.graphId !== "string" || g.graphId.length === 0) {
    errors.push("graphId must be a non-empty string.");
  }

  if (typeof g.bundleId !== "string" || g.bundleId.length === 0) {
    errors.push("bundleId must be a non-empty string.");
  }

  if (typeof g.revision !== "number" || g.revision < 1) {
    errors.push("revision must be a positive integer.");
  }

  if (typeof g.updatedAt !== "string") {
    errors.push("updatedAt must be a string (ISO 8601).");
  }

  const scenes = g.scenes as Record<string, unknown> | undefined;
  if (!scenes || typeof scenes !== "object") {
    errors.push("scenes must be a non-null object.");
  } else {
    for (const [sceneId, scene] of Object.entries(scenes)) {
      validateScene(sceneId, scene as Scene, errors);
    }
  }

  const operators = g.operators as Record<string, unknown> | undefined;
  if (!operators || typeof operators !== "object") {
    errors.push("operators must be a non-null object.");
  } else {
    for (const [opId, op] of Object.entries(operators)) {
      validateOperator(opId, op as Operator, scenes, errors);
    }
  }

  const tasks = g.tasks as Record<string, unknown> | undefined;
  if (tasks && typeof tasks === "object") {
    for (const [taskId, task] of Object.entries(tasks)) {
      validateTask(taskId, task as Task, operators, scenes, errors);
    }
  }

  const deviceProfiles = g.deviceProfiles;
  if (!deviceProfiles || typeof deviceProfiles !== "object") {
    errors.push("deviceProfiles must be a non-null object.");
  }

  if (typeof g.defaultDeviceProfileId !== "string") {
    errors.push("defaultDeviceProfileId must be a string.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateScene(id: string, s: Scene, errors: string[]): void {
  if (s.sceneId !== id) {
    errors.push(
      `Scene "${id}": sceneId "${s.sceneId}" does not match key "${id}".`,
    );
  }
  if (typeof s.title !== "string" || s.title.length === 0) {
    errors.push(`Scene "${id}": title must be a non-empty string.`);
  }
  if (
    s.foregroundBundleId !== undefined &&
    (typeof s.foregroundBundleId !== "string" ||
      s.foregroundBundleId.length === 0)
  ) {
    errors.push(
      `Scene "${id}": foregroundBundleId must be a non-empty string when provided.`,
    );
  }
  if (!Array.isArray(s.aliases)) {
    errors.push(`Scene "${id}": aliases must be an array.`);
  }
  if (!Array.isArray(s.visualTextAnchors)) {
    errors.push(`Scene "${id}": visualTextAnchors must be an array.`);
  }
  if (s.elements && typeof s.elements === "object") {
    for (const [elId, el] of Object.entries(s.elements)) {
      validateElement(elId, el as Element, id, errors);
    }
  }
}

function validateElement(
  elId: string,
  el: Element,
  sceneId: string,
  errors: string[],
): void {
  if (el.elementId !== elId) {
    errors.push(`Element "${elId}" in Scene "${sceneId}": elementId mismatch.`);
  }
  if (typeof el.semanticRole !== "string" || el.semanticRole.length === 0) {
    errors.push(`Element "${elId}": semanticRole must be a non-empty string.`);
  }
  if (!Array.isArray(el.selectors)) {
    errors.push(`Element "${elId}": selectors must be an array.`);
  }
  if (el.bindings && typeof el.bindings !== "object") {
    errors.push(`Element "${elId}": bindings must be an object.`);
  }
  for (const binding of Object.values(el.bindings ?? {})) {
    validateExecutionTrust(
      binding.execution,
      `Element "${elId}" Binding "${binding.deviceProfileId}"`,
      errors,
    );
  }
}

function validateOperator(
  opId: string,
  op: Operator,
  scenes: Record<string, unknown> | undefined,
  errors: string[],
): void {
  if (op.operatorId !== opId) {
    errors.push(`Operator "${opId}": operatorId mismatch.`);
  }
  if (
    typeof op.fromSceneId !== "string" ||
    !scenes ||
    !(op.fromSceneId in scenes)
  ) {
    errors.push(
      `Operator "${opId}": fromSceneId "${op.fromSceneId}" not found in scenes.`,
    );
  }
  if (
    op.toSceneId !== null &&
    (typeof op.toSceneId !== "string" || (scenes && !(op.toSceneId in scenes)))
  ) {
    errors.push(
      `Operator "${opId}": toSceneId "${op.toSceneId}" not found in scenes.`,
    );
  }
  if (!op.operation || typeof op.operation.type !== "string") {
    errors.push(`Operator "${opId}": operation must have a type.`);
  }
  if (!Array.isArray(op.effects)) {
    errors.push(`Operator "${opId}": effects must be an array.`);
  }
  validateExecutionTrust(op.execution, `Operator "${opId}"`, errors);
}

function validateTask(
  taskId: string,
  t: Task,
  operators: Record<string, unknown> | undefined,
  scenes: Record<string, unknown> | undefined,
  errors: string[],
): void {
  if (t.taskId !== taskId) {
    errors.push(`Task "${taskId}": taskId mismatch.`);
  }
  if (
    typeof t.entrySceneId !== "string" ||
    !scenes ||
    !(t.entrySceneId in scenes)
  ) {
    errors.push(
      `Task "${taskId}": entrySceneId "${t.entrySceneId}" not found in scenes.`,
    );
  }
  if (!Array.isArray(t.intents) || t.intents.length === 0) {
    errors.push(`Task "${taskId}": intents must be a non-empty array.`);
  } else if (
    t.intents.some((intent) => typeof intent !== "string" || !intent.trim())
  ) {
    errors.push(`Task "${taskId}": intents must contain non-empty strings.`);
  }
  if (
    ![
      "observed",
      "candidate",
      "verified",
      "stale",
      "blocked",
      "disabled",
    ].includes(t.status)
  ) {
    errors.push(`Task "${taskId}": status is invalid.`);
  }
  if (!Array.isArray(t.steps)) {
    errors.push(`Task "${taskId}": steps must be an array.`);
  } else {
    for (const step of t.steps) {
      if (!step || typeof step.operatorId !== "string") {
        errors.push(`Task "${taskId}": every step requires operatorId.`);
        continue;
      }
      if (operators && !(step.operatorId in operators)) {
        errors.push(
          `Task "${taskId}": step operatorId "${step.operatorId}" not found in operators.`,
        );
      }
    }
  }
  if (!Array.isArray(t.finalOracles)) {
    errors.push(`Task "${taskId}": finalOracles must be an array.`);
  } else if (t.finalOracles.length === 0) {
    errors.push(`Task "${taskId}": finalOracles must not be empty.`);
  } else {
    for (const oracle of t.finalOracles) {
      if (!oracle || typeof oracle !== "object") {
        errors.push(`Task "${taskId}": every final Oracle must be an object.`);
        continue;
      }
      const supportedOracleTypes = new Set([
        "text_visible",
        "text_absent",
        "ui_text_visible",
        "ui_text_absent",
        "all_text_visible",
        "any_text_visible",
        "region_stable",
        "visual_changed",
        "foreground_bundle",
        "scene_current",
      ]);
      if (!supportedOracleTypes.has(oracle.type)) {
        errors.push(
          `Task "${taskId}": unsupported final Oracle type "${String(oracle.type)}".`,
        );
        continue;
      }
      if (
        (oracle.type === "all_text_visible" ||
          oracle.type === "any_text_visible" ||
          oracle.type === "region_stable") &&
        (!Array.isArray(oracle.values) ||
          oracle.values.length === 0 ||
          oracle.values.some(
            (value: unknown) => typeof value !== "string" || !value.trim(),
          ))
      ) {
        errors.push(
          `Task "${taskId}": ${oracle.type} oracle requires non-empty values.`,
        );
      }
      if (
        (oracle.type === "text_visible" ||
          oracle.type === "text_absent" ||
          oracle.type === "ui_text_visible" ||
          oracle.type === "ui_text_absent") &&
        (typeof oracle.value !== "string" || !oracle.value.trim())
      ) {
        errors.push(`Task "${taskId}": ${oracle.type} oracle requires value.`);
      }
      if (
        oracle.type === "visual_changed" &&
        (typeof oracle.maximumSsim !== "number" ||
          !Number.isFinite(oracle.maximumSsim) ||
          oracle.maximumSsim < 0 ||
          oracle.maximumSsim > 1)
      ) {
        errors.push(
          `Task "${taskId}": visual_changed oracle requires maximumSsim between 0 and 1.`,
        );
      }
      if (
        oracle.type === "scene_current" &&
        (typeof oracle.sceneId !== "string" ||
          !scenes ||
          !(oracle.sceneId in scenes))
      ) {
        errors.push(
          `Task "${taskId}": scene_current oracle references missing Scene "${String(oracle.sceneId)}".`,
        );
      }
      if (
        oracle.type === "foreground_bundle" &&
        (typeof oracle.bundleId !== "string" || !oracle.bundleId.trim())
      ) {
        errors.push(
          `Task "${taskId}": foreground_bundle oracle requires bundleId.`,
        );
      }
    }
  }
  if (t.validation) {
    if (!Array.isArray(t.validation.evidencePaths)) {
      errors.push(
        `Task "${taskId}": validation evidencePaths must be an array.`,
      );
    }
    if (!["guarded", "fast", "quarantined"].includes(t.validation.tier)) {
      errors.push(`Task "${taskId}": validation tier is invalid.`);
    }
    for (const [field, value] of [
      ["lastValidatedAt", t.validation.lastValidatedAt],
      ["lastFailedAt", t.validation.lastFailedAt],
      ["validUntil", t.validation.validUntil],
    ] as const) {
      if (value !== undefined && !Number.isFinite(Date.parse(value))) {
        errors.push(`Task "${taskId}": validation ${field} must be ISO 8601.`);
      }
    }
    if (
      t.validation.validatedGraphRevision !== undefined &&
      (!Number.isInteger(t.validation.validatedGraphRevision) ||
        t.validation.validatedGraphRevision < 1)
    ) {
      errors.push(
        `Task "${taskId}": validation validatedGraphRevision must be a positive integer.`,
      );
    }
    if (
      t.validation.dependencyDigest !== undefined &&
      !/^[a-f0-9]{64}$/.test(t.validation.dependencyDigest)
    ) {
      errors.push(
        `Task "${taskId}": validation dependencyDigest must be a SHA-256 hex digest.`,
      );
    }
  }
}

function validateExecutionTrust(
  trust: Operator["execution"] | undefined,
  label: string,
  errors: string[],
): void {
  if (!trust) return;
  if (!["guarded", "fast", "quarantined"].includes(trust.tier)) {
    errors.push(`${label}: execution tier is invalid.`);
  }
  if (!Array.isArray(trust.evidencePaths)) {
    errors.push(`${label}: execution evidencePaths must be an array.`);
  }
}
