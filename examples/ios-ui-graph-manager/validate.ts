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
  if (!Array.isArray(t.steps)) {
    errors.push(`Task "${taskId}": steps must be an array.`);
  } else {
    for (const step of t.steps) {
      if (operators && !(step.operatorId in operators)) {
        errors.push(
          `Task "${taskId}": step operatorId "${step.operatorId}" not found in operators.`,
        );
      }
    }
  }
  if (!Array.isArray(t.finalOracles)) {
    errors.push(`Task "${taskId}": finalOracles must be an array.`);
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
