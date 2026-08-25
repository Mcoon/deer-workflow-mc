import type {
  ExecutableUiGraphExperiment,
  ExperimentBinding,
  ExperimentElement,
  ExperimentOperator,
  ExperimentScene,
  ExperimentTask,
  ExperimentVerifierAssertion,
} from "./legacy-v1-types";
import type {
  AppGraph,
  Binding,
  Element,
  GraphEntityStatus,
  Operator,
  ReferenceAsset,
  Scene,
  SelectorEntry,
  StructuredEffect,
  Task,
  TaskOracle,
  TaskStep,
} from "./types";

function migrateStatus(old: string | undefined): GraphEntityStatus {
  if (!old) return "candidate";
  const valid = new Set([
    "observed",
    "candidate",
    "verified",
    "stale",
    "blocked",
    "disabled",
  ]);
  return valid.has(old) ? (old as GraphEntityStatus) : "candidate";
}

function migrateBinding(b: ExperimentBinding): Binding {
  return {
    deviceProfileId: b.deviceProfileId,
    normalizedPoint: { x: b.normalizedPoint.x, y: b.normalizedPoint.y },
    source: b.source === "manual" ? "manual" : "ui_dump",
    status: migrateStatus(b.status),
    observedAt: b.observedAt,
  };
}

function migrateElement(el: ExperimentElement): Element {
  const selectors: SelectorEntry[] = [];
  if (el.selector.accessibilityId)
    selectors.push({
      type: "accessibilityIdentifier",
      value: el.selector.accessibilityId,
    });
  if (el.selector.label)
    selectors.push({ type: "label", value: el.selector.label });
  if (el.selector.text)
    selectors.push({ type: "text", value: el.selector.text });
  if (el.selector.value)
    selectors.push({ type: "value", value: el.selector.value });
  if (el.selector.role)
    selectors.push({ type: "role", value: el.selector.role });

  const bindings: Record<string, Binding> = {};
  for (const b of el.bindings) {
    bindings[b.deviceProfileId] = migrateBinding(b);
  }

  return {
    elementId: el.elementId,
    title: el.title ?? el.elementId,
    semanticRole: el.semanticRole,
    status: migrateStatus(el.bindings[0]?.status),
    selectors,
    bindings,
  };
}

function migrateScene(
  s: ExperimentScene,
  elements: Record<string, ExperimentElement>,
): Scene {
  const sceneElements: Record<string, Element> = {};
  for (const el of Object.values(elements)) {
    if (el.sceneId === s.sceneId) {
      sceneElements[el.elementId] = migrateElement(el);
    }
  }

  const assets: ReferenceAsset[] = s.referenceAssets.map((a) => ({
    screenshot: a.screenshotPath ?? "",
    uiDump: a.uiDumpPath ?? "",
    ocr: a.recordPath,
  }));

  return {
    sceneId: s.sceneId,
    parentSceneId: null,
    status: migrateStatus(s.status),
    title: s.title,
    aliases: [...s.aliases],
    visualTextAnchors: [...(s.visualTextAnchors ?? [])],
    referenceAssets: assets,
    elements: sceneElements,
  };
}

function migrateEffectString(eff: string): StructuredEffect {
  if (eff.startsWith("scene.")) {
    const parts = eff.split("=");
    return {
      type: "scene_change",
      key: parts[0] ?? eff,
      value: parts[1] ?? "",
    };
  }
  const parts = eff.split("=");
  const rawValue = parts.length > 1 ? parts[1] : undefined;
  return {
    type: "state_change",
    key: parts[0] ?? eff,
    value:
      rawValue === "true"
        ? true
        : rawValue === "false"
          ? false
          : (rawValue ?? true),
  };
}

function migrateOperator(op: ExperimentOperator): Operator {
  const effects: StructuredEffect[] = op.effects.map(migrateEffectString);

  const operation: Operator["operation"] = (() => {
    switch (op.operation.type) {
      case "tap":
        return { type: "tap", elementId: op.operation.elementId };
      case "long_press":
        return {
          type: "long_press",
          elementId: op.operation.elementId,
          durationMs: op.operation.durationMs,
        };
      case "input_text":
        return { type: "input_text", value: op.operation.value };
      case "tap_restart_app":
        return {
          type: "tap_restart_app",
          elementId: op.operation.elementId,
          bundleId: op.operation.bundleId,
        };
      case "swipe":
        return {
          type: "swipe",
          from: { x: op.operation.from.x, y: op.operation.from.y },
          to: { x: op.operation.to.x, y: op.operation.to.y },
        };
      default:
        return { type: "tap", elementId: "" };
    }
  })();

  return {
    operatorId: op.operatorId,
    fromSceneId: op.fromSceneId,
    toSceneId: op.toSceneId || null,
    operation,
    effects,
    status: migrateStatus(op.status),
    executionStats: {
      pass: op.execution?.successfulExecutions ?? 0,
      fail: op.execution?.failedExecutions ?? 0,
      lastExecutedAt: op.execution?.lastValidatedAt,
    },
    risk: op.risk,
    settleMs: op.settleMs,
  };
}

function migrateTask(t: ExperimentTask): Task {
  const steps: TaskStep[] = t.operatorIds.map((oid) => ({ operatorId: oid }));
  const finalOracles = dedupeTaskOracles([
    ...t.finalOracles.map(migrateTaskOracle),
    ...(t.verifier?.assertions ?? []).map(migrateVerifierAssertion),
  ]);

  return {
    taskId: t.taskId,
    intents: [...t.intents],
    entrySceneId: t.entrySceneId,
    steps,
    finalOracles,
    status: migrateStatus(t.status),
    parameters: t.parameters as Task["parameters"],
  };
}

function migrateVerifierAssertion(
  assertion: ExperimentVerifierAssertion,
): TaskOracle {
  switch (assertion.type) {
    case "all_text_visible":
    case "any_text_visible":
    case "region_stable":
      return { type: assertion.type, values: [...assertion.values] };
    case "scene_current":
      return { type: "scene_current", sceneId: assertion.sceneId };
    case "foreground_bundle":
      return { type: "foreground_bundle", bundleId: assertion.bundleId };
    case "text_absent":
      return { type: "text_absent", value: assertion.value };
  }
}

function migrateTaskOracle(
  oracle: ExperimentTask["finalOracles"][number],
): TaskOracle {
  switch (oracle.type) {
    case "scene_current":
      return { type: "scene_current", sceneId: oracle.sceneId };
    case "foreground_bundle":
      return { type: "foreground_bundle", bundleId: oracle.bundleId };
    case "visual_changed":
      return { type: "visual_changed", maximumSsim: oracle.maximumSsim };
    default:
      return { type: oracle.type, value: oracle.value };
  }
}

function dedupeTaskOracles(oracles: readonly TaskOracle[]): TaskOracle[] {
  const seen = new Set<string>();
  return oracles.filter((oracle) => {
    const key = JSON.stringify(oracle);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function migrateV1ToV2(
  v1: ExecutableUiGraphExperiment,
  appVersion?: string,
): AppGraph {
  const elementMap: Record<string, ExperimentElement> = {};
  for (const el of v1.elements) {
    elementMap[el.elementId] = el;
  }

  const scenes: Record<string, Scene> = {};
  for (const s of v1.scenes) {
    scenes[s.sceneId] = migrateScene(s, elementMap);
  }

  const operators: Record<string, Operator> = {};
  for (const op of v1.operators) {
    operators[op.operatorId] = migrateOperator(op);
  }

  const tasks: Record<string, Task> = {};
  for (const t of v1.tasks) {
    tasks[t.taskId] = migrateTask(t);
  }

  const deviceProfiles: AppGraph["deviceProfiles"] = {};
  for (const dp of v1.deviceProfiles) {
    deviceProfiles[dp.profileId] = {
      profileId: dp.profileId,
      viewportWidth: dp.viewportWidth,
      viewportHeight: dp.viewportHeight,
    };
  }

  return {
    schemaVersion: "ios-executable-ui-graph/v2",
    graphId: v1.graphId,
    bundleId: v1.bundleId,
    appName: v1.appName,
    appVersion: (appVersion ?? v1.appName) ? undefined : undefined,
    revision: 1,
    updatedAt: new Date().toISOString(),
    deviceProfiles,
    defaultDeviceProfileId: v1.defaultDeviceProfileId,
    defaultResetStrategyId: v1.defaultResetStrategyId,
    resetStrategies: v1.resetStrategies.map((r) => ({
      strategyId: r.strategyId,
      entrySceneId: r.entrySceneId,
      steps: r.steps.map((s) => {
        switch (s.type) {
          case "terminate_app":
            return { type: "terminate_app", bundleId: s.bundleId };
          case "launch_app":
            return { type: "launch_app", bundleId: s.bundleId };
          case "wait":
            return { type: "wait", durationMs: s.durationMs };
          default:
            return { type: "wait", durationMs: 1000 };
        }
      }),
    })),
    scenes,
    operators,
    tasks,
  };
}
