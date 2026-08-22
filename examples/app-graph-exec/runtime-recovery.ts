import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { agent } from "@deerwork-ai/deer-workflow/agents";
import type {
  AgentFunction,
  JsonSchema,
} from "@deerwork-ai/deer-workflow/agents";

import { applyAndSave, loadGraph } from "../ios-ui-graph-manager";
import type {
  AppGraph,
  Element,
  GraphPatch,
  Scene,
  SelectorEntry,
} from "../ios-ui-graph-manager/types";
import type { UiElement } from "../ios-regression-kit/types";
import type { ResolvedStep } from "../app-graph-plan/types";

export interface RuntimeObservation {
  readonly screenshotPath: string;
  readonly uiDumpPath: string;
  readonly foregroundPath: string;
  readonly foregroundBundleId: string;
  readonly uiElements: readonly UiElement[];
}

export interface RuntimeCandidate {
  readonly candidateId: string;
  readonly title: string;
  readonly role: string;
  readonly accessibilityId: string;
  readonly label: string;
  readonly text: string;
  readonly value: string;
  readonly bounds: NonNullable<UiElement["bounds"]>;
  readonly allowedActions: readonly RuntimeRecoveryActionType[];
}

export type RuntimeRecoveryActionType =
  | "tap"
  | "long_press"
  | "swipe_up"
  | "swipe_down"
  | "swipe_left"
  | "swipe_right";

export interface RuntimeElementAgentDecision {
  readonly status: "matched" | "blocked";
  readonly candidateId: string;
  readonly confidence: number;
  readonly reason: string;
}

export interface RuntimeSceneAgentDecision {
  readonly status: "action" | "at_target" | "blocked";
  readonly candidateId: string;
  readonly actionType: RuntimeRecoveryActionType | "none";
  readonly confidence: number;
  readonly reason: string;
}

export interface RuntimeSceneMatch {
  readonly sceneId: string;
  readonly confidence: number;
  readonly matchedAnchors: readonly string[];
}

export interface RuntimeSceneAgentEvaluation {
  readonly decision: RuntimeSceneAgentDecision;
  readonly accepted: boolean;
  readonly rejectionReason?: string;
}

export interface RuntimeGraphUpdate {
  readonly graph: AppGraph;
  readonly graphUpdated: boolean;
  readonly patchPaths: readonly string[];
  readonly sourceSceneId: string;
  readonly targetSceneId: string;
  readonly sourceElementId: string;
}

const elementDecisionSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["matched", "blocked"] },
    candidateId: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["status", "candidateId", "confidence", "reason"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const sceneDecisionSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["action", "at_target", "blocked"] },
    candidateId: { type: "string" },
    actionType: {
      type: "string",
      enum: [
        "none",
        "tap",
        "swipe_up",
        "swipe_down",
        "swipe_left",
        "swipe_right",
      ],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["status", "candidateId", "actionType", "confidence", "reason"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const BLOCKED_RECOVERY_TEXT =
  /发送|支付|购买|付款|允许|授权|删除|清空|注销|退出登录|登录|注册|提交|发布|安装|添加|订阅|确认|确定|完成|保存|开启|关闭|confirm delete/i;

export function classifyRuntimeScene(
  graph: AppGraph,
  observation: RuntimeObservation,
): RuntimeSceneMatch | null {
  const matches = Object.values(graph.scenes)
    .filter(
      (scene) =>
        !["stale", "blocked", "disabled"].includes(scene.status) &&
        bundleMatches(scene, graph, observation.foregroundBundleId),
    )
    .map((scene) => scoreScene(scene, observation.uiElements))
    .filter((match) => match.confidence >= 0.6)
    .sort((left, right) => right.confidence - left.confidence);
  const first = matches[0];
  const second = matches[1];
  if (!first) return null;
  if (second && first.confidence - second.confidence < 0.15) return null;
  return first;
}

export function runtimeSceneMatches(
  graph: AppGraph,
  sceneId: string,
  observation: RuntimeObservation,
): boolean {
  const scene = graph.scenes[sceneId];
  if (!scene || !bundleMatches(scene, graph, observation.foregroundBundleId)) {
    return false;
  }
  if (scene.visualTextAnchors.length === 0) return true;
  return scoreScene(scene, observation.uiElements).confidence >= 0.6;
}

export function buildRuntimeCandidates(
  elements: readonly UiElement[],
  options?: {
    readonly safeNavigationOnly?: boolean;
    readonly viewportWidth?: number;
    readonly viewportHeight?: number;
  },
): RuntimeCandidate[] {
  const candidates = elements
    .filter(
      (
        element,
      ): element is UiElement & { bounds: NonNullable<UiElement["bounds"]> } =>
        Boolean(
          element.bounds &&
          element.bounds.width > 0 &&
          element.bounds.height > 0,
        ),
    )
    .map((element, index) => {
      const title =
        element.label ??
        element.text ??
        element.accessibilityId ??
        element.value ??
        `candidate-${index + 1}`;
      const scrollable = /scroll|webview/i.test(element.role ?? "");
      const allowedActions: RuntimeRecoveryActionType[] = scrollable
        ? ["swipe_up", "swipe_down", "swipe_left", "swipe_right"]
        : ["tap"];
      return {
        candidateId: `ui-${index + 1}`,
        title,
        role: element.role ?? "",
        accessibilityId: element.accessibilityId ?? "",
        label: element.label ?? "",
        text: element.text ?? "",
        value: element.value ?? "",
        bounds: element.bounds,
        allowedActions,
      };
    })
    .filter(
      (candidate) =>
        options?.viewportWidth === undefined ||
        options.viewportHeight === undefined ||
        boundsCenterWithinViewport(
          candidate.bounds,
          options.viewportWidth,
          options.viewportHeight,
        ),
    )
    .filter(
      (candidate) =>
        !options?.safeNavigationOnly ||
        (isSafeNavigationCandidate(candidate) &&
          !BLOCKED_RECOVERY_TEXT.test(candidateComparableText(candidate))),
    );
  return candidates.slice(0, 80);
}

export async function resolveElementWithAgent(options: {
  goal: string;
  currentSceneId: string;
  step: ResolvedStep;
  observation: RuntimeObservation;
  viewportWidth: number;
  viewportHeight: number;
  cwd: string;
  model?: string;
  timeoutMs: number;
  minimumConfidence: number;
  agentRunner?: AgentFunction;
}): Promise<{
  candidate: RuntimeCandidate;
  decision: RuntimeElementAgentDecision;
} | null> {
  const candidates = buildRuntimeCandidates(options.observation.uiElements, {
    viewportWidth: options.viewportWidth,
    viewportHeight: options.viewportHeight,
  });
  if (candidates.length === 0) return null;
  const prompt = [
    "Resolve one planned iOS UI Element against the current real observation.",
    "Return only schema-backed JSON.",
    "Do not execute commands, call device tools, modify files, or operate the device. Only return the decision.",
    "Choose candidateId only from Current candidates.",
    "Coordinates are forbidden. The executor uses the chosen candidate bounds.",
    "Use status=blocked when no candidate confidently represents the planned Element.",
    "Do not reinterpret the user goal or choose an unrelated control.",
    "",
    `User goal: ${options.goal}`,
    `Current Scene: ${options.currentSceneId}`,
    `Planned action: ${options.step.action.description}`,
    `Planned Element: ${JSON.stringify(options.step.targetElement ?? null)}`,
    `Screenshot path: ${options.observation.screenshotPath}`,
    `Current candidates: ${JSON.stringify(candidates.map(candidateCard))}`,
  ].join("\n");
  const decision = await runAgentWithTimeout<RuntimeElementAgentDecision>({
    prompt,
    schema: elementDecisionSchema,
    cwd: options.cwd,
    model: options.model,
    timeoutMs: options.timeoutMs,
    label: "runtime element resolution",
    agentRunner: options.agentRunner,
  });
  if (
    decision.status !== "matched" ||
    decision.confidence < options.minimumConfidence
  ) {
    return null;
  }
  const candidate = candidates.find(
    (item) => item.candidateId === decision.candidateId,
  );
  if (!candidate) return null;
  const highRiskPlan = [
    "selection",
    "permission",
    "mutation",
    "destructive",
  ].includes(options.step.risk);
  if (
    !highRiskPlan &&
    BLOCKED_RECOVERY_TEXT.test(candidateComparableText(candidate))
  ) {
    return null;
  }
  return { candidate, decision };
}

export function boundsCenterWithinViewport(
  bounds: NonNullable<UiElement["bounds"]>,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return (
    centerX >= 0 &&
    centerX < viewportWidth &&
    centerY >= 0 &&
    centerY < viewportHeight
  );
}

export async function decideSceneRecoveryWithAgent(options: {
  goal: string;
  expectedScene: Scene;
  currentSceneId?: string;
  nextStep?: ResolvedStep;
  observation: RuntimeObservation;
  viewportWidth?: number;
  viewportHeight?: number;
  previousActions: readonly {
    readonly candidateId: string;
    readonly actionType: RuntimeRecoveryActionType;
  }[];
  cwd: string;
  model?: string;
  timeoutMs: number;
  minimumConfidence: number;
  agentRunner?: AgentFunction;
  historicalTarget?: Pick<Element, "title" | "semanticRole" | "selectors">;
  onEvaluation?: (evaluation: RuntimeSceneAgentEvaluation) => void;
}): Promise<{
  candidate?: RuntimeCandidate;
  decision: RuntimeSceneAgentDecision;
} | null> {
  const candidates = buildRuntimeCandidates(options.observation.uiElements, {
    safeNavigationOnly: true,
    viewportWidth: options.viewportWidth,
    viewportHeight: options.viewportHeight,
  });
  const prompt = [
    "Choose one bounded safe iOS UI action to recover toward the requested Scene.",
    "Return only schema-backed JSON.",
    "Do not execute commands, call device tools, modify files, or operate the device. Only return the decision.",
    "Choose candidateId only from Current candidates and actionType only from that candidate's allowedActions.",
    "Coordinates are forbidden. The executor uses the candidate bounds.",
    "Use status=at_target, candidateId empty, and actionType=none when current evidence already represents the expected Scene.",
    "Use status=blocked when neither the target Scene nor a safe goal-relevant action exists.",
    "Never choose send, payment, purchase, permission approval, delete, account mutation, publish, install, subscribe, or other destructive actions.",
    "Prefer navigation controls whose semantics move toward the expected Scene or expose the next planned Element.",
    "This is not exhaustive exploration: choose only the single best action for the user goal, never probe controls merely to learn what they do.",
    "",
    `User goal: ${options.goal}`,
    `Expected Scene: ${JSON.stringify({ sceneId: options.expectedScene.sceneId, title: options.expectedScene.title, aliases: options.expectedScene.aliases, anchors: options.expectedScene.visualTextAnchors })}`,
    `Current Scene: ${options.currentSceneId ?? "unknown"}`,
    `Next planned action: ${options.nextStep?.action.description ?? "none"}`,
    `Historical target Element: ${JSON.stringify(options.historicalTarget ?? null)}`,
    `Previous recovery actions: ${JSON.stringify(options.previousActions)}`,
    `Screenshot path: ${options.observation.screenshotPath}`,
    `Current candidates: ${JSON.stringify(candidates.map(candidateCard))}`,
  ].join("\n");
  const decision = await runAgentWithTimeout<RuntimeSceneAgentDecision>({
    prompt,
    schema: sceneDecisionSchema,
    cwd: options.cwd,
    model: options.model,
    timeoutMs: options.timeoutMs,
    label: "runtime Scene recovery",
    agentRunner: options.agentRunner,
  });
  if (decision.confidence < options.minimumConfidence) {
    options.onEvaluation?.({
      decision,
      accepted: false,
      rejectionReason: `Agent confidence ${decision.confidence} is below ${options.minimumConfidence}.`,
    });
    return null;
  }
  if (
    decision.status === "blocked" &&
    decision.candidateId === "" &&
    decision.actionType === "none"
  ) {
    options.onEvaluation?.({ decision, accepted: true });
    return { decision };
  }
  if (decision.status === "at_target" && decision.actionType === "none") {
    options.onEvaluation?.({ decision, accepted: true });
    return { decision };
  }
  if (decision.status !== "action" || decision.actionType === "none") {
    options.onEvaluation?.({
      decision,
      accepted: false,
      rejectionReason: "Agent did not return an executable action.",
    });
    return null;
  }
  const candidate = candidates.find(
    (item) => item.candidateId === decision.candidateId,
  );
  if (!candidate || !candidate.allowedActions.includes(decision.actionType)) {
    options.onEvaluation?.({
      decision,
      accepted: false,
      rejectionReason: candidate
        ? `Action ${decision.actionType} is not allowed for ${decision.candidateId}.`
        : `Candidate ${decision.candidateId || "<empty>"} is not present in the stable observation.`,
    });
    return null;
  }
  if (
    options.previousActions.some(
      (previous) =>
        previous.candidateId === candidate.candidateId &&
        previous.actionType === decision.actionType,
    )
  ) {
    options.onEvaluation?.({
      decision,
      accepted: false,
      rejectionReason: "The same candidate action was already attempted.",
    });
    return null;
  }
  options.onEvaluation?.({ decision, accepted: true });
  return { candidate, decision };
}

export function buildRuntimeRecoveryCommand(
  udid: string,
  candidate: RuntimeCandidate,
  actionType: RuntimeRecoveryActionType,
): string[] {
  const centerX = Math.round(candidate.bounds.x + candidate.bounds.width / 2);
  const centerY = Math.round(candidate.bounds.y + candidate.bounds.height / 2);
  if (actionType === "tap") {
    return [
      "mobilecli",
      "io",
      "tap",
      "--device",
      udid,
      `${centerX},${centerY}`,
    ];
  }
  if (actionType === "long_press") {
    return [
      "mobilecli",
      "io",
      "longpress",
      "--device",
      udid,
      `${centerX},${centerY}`,
      "--duration",
      "800",
    ];
  }
  const horizontal =
    actionType === "swipe_left" || actionType === "swipe_right";
  const reverse = actionType === "swipe_right" || actionType === "swipe_down";
  const from = horizontal
    ? {
        x: candidate.bounds.x + candidate.bounds.width * (reverse ? 0.2 : 0.8),
        y: centerY,
      }
    : {
        x: centerX,
        y: candidate.bounds.y + candidate.bounds.height * (reverse ? 0.2 : 0.8),
      };
  const to = horizontal
    ? {
        x: candidate.bounds.x + candidate.bounds.width * (reverse ? 0.8 : 0.2),
        y: centerY,
      }
    : {
        x: centerX,
        y: candidate.bounds.y + candidate.bounds.height * (reverse ? 0.8 : 0.2),
      };
  return [
    "mobilecli",
    "io",
    "swipe",
    "--device",
    udid,
    `${Math.round(from.x)},${Math.round(from.y)},${Math.round(to.x)},${Math.round(to.y)}`,
  ];
}

export async function persistRuntimeTransition(options: {
  graphPath: string;
  graph: AppGraph;
  sourceSceneId?: string;
  before: RuntimeObservation;
  candidate: RuntimeCandidate;
  actionType: RuntimeRecoveryActionType;
  after: RuntimeObservation;
  outputDir: string;
  patchIndex: number;
  deviceProfileId: string;
  allowLearning: boolean;
}): Promise<RuntimeGraphUpdate> {
  let graph = options.graph;
  let sourceSceneId = options.sourceSceneId;
  const patchPaths: string[] = [];
  let graphUpdated = false;
  if (!sourceSceneId) {
    sourceSceneId = runtimeSceneId(options.before);
    if (options.allowLearning && !graph.scenes[sourceSceneId]) {
      const sourcePatch = runtimeScenePatch({
        graph,
        sceneId: sourceSceneId,
        observation: options.before,
        deviceProfileId: options.deviceProfileId,
      });
      const applied = await writeAndApplyPatch({
        graphPath: options.graphPath,
        patch: sourcePatch,
        outputDir: options.outputDir,
        patchIndex: options.patchIndex,
        suffix: "source-scene",
      });
      if (applied) {
        graph = applied.graph;
        patchPaths.push(applied.patchPath);
        graphUpdated = true;
      }
    }
  }
  const classifiedTarget = classifyRuntimeScene(graph, options.after);
  const targetSceneId =
    classifiedTarget?.sceneId ??
    (sourceSceneId &&
    runtimeObservationsEquivalent(options.before, options.after)
      ? sourceSceneId
      : runtimeSceneId(options.after));
  const sourceScene = graph.scenes[sourceSceneId];
  const sourceElement = sourceScene
    ? findGraphElementForCandidate(sourceScene, options.candidate)
    : undefined;
  const sourceElementId =
    sourceElement?.elementId ??
    runtimeElementId(sourceSceneId, options.candidate);
  if (!options.allowLearning) {
    return {
      graph,
      graphUpdated,
      patchPaths,
      sourceSceneId,
      targetSceneId,
      sourceElementId,
    };
  }
  const scenes: NonNullable<GraphPatch["scenes"]> = {};
  if (!graph.scenes[targetSceneId]) {
    Object.assign(
      scenes,
      runtimeScenePatch({
        graph,
        sceneId: targetSceneId,
        observation: options.after,
        deviceProfileId: options.deviceProfileId,
      }).scenes,
    );
  }
  if (sourceScene && !sourceElement) {
    const profile = graph.deviceProfiles[options.deviceProfileId];
    scenes[sourceSceneId] = {
      ...sourceScene,
      sceneId: sourceSceneId,
      elements: {
        ...sourceScene.elements,
        [sourceElementId]: runtimeElement(
          sourceElementId,
          options.candidate,
          options.deviceProfileId,
          profile?.viewportWidth,
          profile?.viewportHeight,
        ),
      },
    };
  }
  const targetScene = graph.scenes[targetSceneId];
  if (
    targetScene &&
    !runtimeObservationsEquivalent(options.before, options.after)
  ) {
    const profile = graph.deviceProfiles[options.deviceProfileId];
    const elements = {
      ...(scenes[targetSceneId]?.elements ?? targetScene.elements),
    };
    for (const candidate of buildRuntimeCandidates(options.after.uiElements)) {
      if (findGraphElementForCandidate(targetScene, candidate)) continue;
      const elementId = runtimeElementId(targetSceneId, candidate);
      elements[elementId] = runtimeElement(
        elementId,
        candidate,
        options.deviceProfileId,
        profile?.viewportWidth,
        profile?.viewportHeight,
      );
    }
    if (
      Object.keys(elements).length > Object.keys(targetScene.elements).length
    ) {
      scenes[targetSceneId] = {
        ...targetScene,
        ...scenes[targetSceneId],
        sceneId: targetSceneId,
        elements,
        referenceAssets: [
          ...targetScene.referenceAssets,
          {
            screenshot: options.after.screenshotPath,
            uiDump: options.after.uiDumpPath,
          },
        ],
      };
    }
  }
  const operationType =
    options.actionType === "tap"
      ? "tap"
      : options.actionType === "long_press"
        ? "long_press"
        : "swipe";
  const equivalent = Object.values(graph.operators).some(
    (operator) =>
      operator.fromSceneId === sourceSceneId &&
      operator.toSceneId === targetSceneId &&
      operator.operation.elementId === sourceElementId &&
      operator.operation.type === operationType,
  );
  const operators: NonNullable<GraphPatch["operators"]> = {};
  if (!equivalent && sourceSceneId !== targetSceneId) {
    const operatorId = runtimeOperatorId(
      sourceSceneId,
      sourceElementId,
      options.actionType,
      targetSceneId,
    );
    operators[operatorId] = {
      operatorId,
      fromSceneId: sourceSceneId,
      toSceneId: targetSceneId,
      operation:
        operationType === "tap"
          ? { type: "tap", elementId: sourceElementId }
          : operationType === "long_press"
            ? {
                type: "long_press",
                elementId: sourceElementId,
                durationMs: 800,
              }
            : {
                type: "swipe",
                elementId: sourceElementId,
                from: runtimeSwipePoints(options.candidate, options.actionType)
                  .from,
                to: runtimeSwipePoints(options.candidate, options.actionType)
                  .to,
              },
      effects: [
        {
          type: "scene_change",
          key: "scene.current",
          value: targetSceneId,
        },
      ],
      status: "candidate",
      executionStats: { pass: 0, fail: 0 },
      risk: "navigation",
      settleMs: 900,
    };
  }
  if (Object.keys(scenes).length || Object.keys(operators).length) {
    const patch: GraphPatch = {
      schemaVersion: "ios-ui-graph-patch/v2",
      graphId: graph.graphId,
      baseRevision: graph.revision,
      source: "navigator",
      scenes: Object.keys(scenes).length ? scenes : undefined,
      operators: Object.keys(operators).length ? operators : undefined,
      evidencePaths: [
        options.before.screenshotPath,
        options.before.uiDumpPath,
        options.after.screenshotPath,
        options.after.uiDumpPath,
      ],
    };
    const applied = await writeAndApplyPatch({
      graphPath: options.graphPath,
      patch,
      outputDir: options.outputDir,
      patchIndex: options.patchIndex + patchPaths.length,
      suffix: "transition",
    });
    if (applied) {
      graph = applied.graph;
      patchPaths.push(applied.patchPath);
      graphUpdated = true;
    }
  }
  return {
    graph,
    graphUpdated,
    patchPaths,
    sourceSceneId,
    targetSceneId,
    sourceElementId,
  };
}

export async function persistAgentElementResolution(options: {
  graphPath: string;
  graph: AppGraph;
  sceneId: string;
  elementId: string;
  candidate: RuntimeCandidate;
  observation: RuntimeObservation;
  outputDir: string;
  patchIndex: number;
  deviceProfileId: string;
  allowLearning: boolean;
}): Promise<{
  graph: AppGraph;
  graphUpdated: boolean;
  patchPath?: string;
}> {
  const scene = options.graph.scenes[options.sceneId];
  const element = scene?.elements[options.elementId];
  const profile = options.graph.deviceProfiles[options.deviceProfileId];
  if (!options.allowLearning || !scene || !element || !profile) {
    return { graph: options.graph, graphUpdated: false };
  }
  const updatedElement: Element = {
    ...element,
    selectors: uniqueSelectors([
      ...element.selectors,
      ...runtimeSelectors(options.candidate),
    ]),
    bindings: {
      ...element.bindings,
      [options.deviceProfileId]: {
        deviceProfileId: options.deviceProfileId,
        normalizedPoint: {
          x: clamp01(
            (options.candidate.bounds.x + options.candidate.bounds.width / 2) /
              profile.viewportWidth,
          ),
          y: clamp01(
            (options.candidate.bounds.y + options.candidate.bounds.height / 2) /
              profile.viewportHeight,
          ),
        },
        source: "agent_inferred",
        status: "candidate",
        observedAt: new Date().toISOString(),
      },
    },
  };
  const patch: GraphPatch = {
    schemaVersion: "ios-ui-graph-patch/v2",
    graphId: options.graph.graphId,
    baseRevision: options.graph.revision,
    source: "navigator",
    scenes: {
      [scene.sceneId]: {
        ...scene,
        sceneId: scene.sceneId,
        elements: {
          ...scene.elements,
          [element.elementId]: updatedElement,
        },
      },
    },
    evidencePaths: [
      options.observation.screenshotPath,
      options.observation.uiDumpPath,
      options.observation.foregroundPath,
    ],
  };
  const applied = await writeAndApplyPatch({
    graphPath: options.graphPath,
    patch,
    outputDir: options.outputDir,
    patchIndex: options.patchIndex,
    suffix: "element-relocation",
  });
  return applied
    ? { graph: applied.graph, graphUpdated: true, patchPath: applied.patchPath }
    : { graph: options.graph, graphUpdated: false };
}

export async function persistAgentSceneRecognition(options: {
  graphPath: string;
  graph: AppGraph;
  sceneId: string;
  observation: RuntimeObservation;
  outputDir: string;
  patchIndex: number;
  deviceProfileId: string;
  allowLearning: boolean;
}): Promise<{ graph: AppGraph; graphUpdated: boolean; patchPath?: string }> {
  const scene = options.graph.scenes[options.sceneId];
  if (!options.allowLearning || !scene) {
    return { graph: options.graph, graphUpdated: false };
  }
  const candidates = buildRuntimeCandidates(options.observation.uiElements);
  const elements = { ...scene.elements };
  const profile = options.graph.deviceProfiles[options.deviceProfileId];
  for (const candidate of candidates) {
    if (findGraphElementForCandidate(scene, candidate)) continue;
    const elementId = runtimeElementId(scene.sceneId, candidate);
    elements[elementId] = runtimeElement(
      elementId,
      candidate,
      options.deviceProfileId,
      profile?.viewportWidth,
      profile?.viewportHeight,
    );
  }
  const patch: GraphPatch = {
    schemaVersion: "ios-ui-graph-patch/v2",
    graphId: options.graph.graphId,
    baseRevision: options.graph.revision,
    source: "navigator",
    scenes: {
      [scene.sceneId]: {
        ...scene,
        sceneId: scene.sceneId,
        referenceAssets: [
          ...scene.referenceAssets,
          {
            screenshot: options.observation.screenshotPath,
            uiDump: options.observation.uiDumpPath,
          },
        ],
        elements,
      },
    },
    evidencePaths: [
      options.observation.screenshotPath,
      options.observation.uiDumpPath,
      options.observation.foregroundPath,
    ],
  };
  const applied = await writeAndApplyPatch({
    graphPath: options.graphPath,
    patch,
    outputDir: options.outputDir,
    patchIndex: options.patchIndex,
    suffix: "scene-recognition",
  });
  return applied
    ? { graph: applied.graph, graphUpdated: true, patchPath: applied.patchPath }
    : { graph: options.graph, graphUpdated: false };
}

function scoreScene(
  scene: Scene,
  elements: readonly UiElement[],
): RuntimeSceneMatch {
  const observed = observedTexts(elements);
  const anchors = scene.visualTextAnchors.map(normalizeText).filter(Boolean);
  const matchedAnchors = anchors.filter((anchor) =>
    observed.some((value) => value.includes(anchor) || anchor.includes(value)),
  );
  const anchorCoverage = anchors.length
    ? matchedAnchors.length / anchors.length
    : 0;
  const semanticNames = [scene.title, ...scene.aliases].map(normalizeText);
  const nameMatched = semanticNames.some((name) =>
    observed.some((value) => value === name),
  );
  return {
    sceneId: scene.sceneId,
    confidence: Math.min(1, anchorCoverage + (nameMatched ? 0.2 : 0)),
    matchedAnchors,
  };
}

function bundleMatches(
  scene: Scene,
  graph: AppGraph,
  foregroundBundleId: string,
): boolean {
  if (!foregroundBundleId) return false;
  return foregroundBundleId.includes(
    scene.foregroundBundleId ?? graph.bundleId,
  );
}

function observedTexts(elements: readonly UiElement[]): string[] {
  return [
    ...new Set(
      elements
        .flatMap((element) => [
          element.accessibilityId,
          element.label,
          element.text,
          element.value,
        ])
        .filter((value): value is string => Boolean(value))
        .map(normalizeText)
        .filter(Boolean),
    ),
  ];
}

export function runtimeObservationsEquivalent(
  before: RuntimeObservation,
  after: RuntimeObservation,
): boolean {
  if (before.foregroundBundleId !== after.foregroundBundleId) return false;
  const beforeSignature = buildRuntimeCandidates(before.uiElements)
    .map(candidateComparableText)
    .sort();
  const afterSignature = buildRuntimeCandidates(after.uiElements)
    .map(candidateComparableText)
    .sort();
  return JSON.stringify(beforeSignature) === JSON.stringify(afterSignature);
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function candidateCard(candidate: RuntimeCandidate) {
  return {
    candidateId: candidate.candidateId,
    title: candidate.title,
    role: candidate.role,
    accessibilityId: candidate.accessibilityId,
    label: candidate.label,
    text: candidate.text,
    value: candidate.value,
    allowedActions: candidate.allowedActions,
  };
}

function candidateComparableText(candidate: RuntimeCandidate): string {
  return [
    candidate.title,
    candidate.role,
    candidate.accessibilityId,
    candidate.label,
    candidate.text,
    candidate.value,
  ].join(" ");
}

function isSafeNavigationCandidate(candidate: RuntimeCandidate): boolean {
  return /button|link|cell|menu|tab|navigation|scroll|webview/i.test(
    candidate.role,
  );
}

function runtimeSwipePoints(
  candidate: RuntimeCandidate,
  actionType: RuntimeRecoveryActionType,
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const centerX = Math.round(candidate.bounds.x + candidate.bounds.width / 2);
  const centerY = Math.round(candidate.bounds.y + candidate.bounds.height / 2);
  const horizontal =
    actionType === "swipe_left" || actionType === "swipe_right";
  const reverse = actionType === "swipe_right" || actionType === "swipe_down";
  return horizontal
    ? {
        from: {
          x: Math.round(
            candidate.bounds.x + candidate.bounds.width * (reverse ? 0.2 : 0.8),
          ),
          y: centerY,
        },
        to: {
          x: Math.round(
            candidate.bounds.x + candidate.bounds.width * (reverse ? 0.8 : 0.2),
          ),
          y: centerY,
        },
      }
    : {
        from: {
          x: centerX,
          y: Math.round(
            candidate.bounds.y +
              candidate.bounds.height * (reverse ? 0.2 : 0.8),
          ),
        },
        to: {
          x: centerX,
          y: Math.round(
            candidate.bounds.y +
              candidate.bounds.height * (reverse ? 0.8 : 0.2),
          ),
        },
      };
}

async function runAgentWithTimeout<TOutput>(options: {
  prompt: string;
  schema: JsonSchema;
  cwd: string;
  model?: string;
  timeoutMs: number;
  label: string;
  agentRunner?: AgentFunction;
}): Promise<TOutput> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`${options.label} timed out after ${options.timeoutMs} ms.`),
      ),
    options.timeoutMs,
  );
  try {
    return await (options.agentRunner ?? agent)<TOutput>(options.prompt, {
      cwd: options.cwd,
      model: options.model,
      sandbox: "read-only",
      schema: options.schema,
      env: { CODEX_HOME: undefined },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function runtimeScenePatch(options: {
  graph: AppGraph;
  sceneId: string;
  observation: RuntimeObservation;
  deviceProfileId: string;
}): GraphPatch {
  const profile = options.graph.deviceProfiles[options.deviceProfileId];
  const candidates = buildRuntimeCandidates(options.observation.uiElements);
  return {
    schemaVersion: "ios-ui-graph-patch/v2",
    graphId: options.graph.graphId,
    baseRevision: options.graph.revision,
    source: "navigator",
    scenes: {
      [options.sceneId]: {
        sceneId: options.sceneId,
        parentSceneId: null,
        foregroundBundleId:
          options.observation.foregroundBundleId || options.graph.bundleId,
        status: "observed",
        title: runtimeSceneTitle(candidates, options.sceneId),
        aliases: [],
        visualTextAnchors: candidates
          .map((candidate) => candidate.title)
          .filter((title) => title.length >= 2 && title.length <= 40)
          .slice(0, 6),
        referenceAssets: [
          {
            screenshot: options.observation.screenshotPath,
            uiDump: options.observation.uiDumpPath,
          },
        ],
        elements: Object.fromEntries(
          candidates.map((candidate) => {
            const elementId = runtimeElementId(options.sceneId, candidate);
            return [
              elementId,
              runtimeElement(
                elementId,
                candidate,
                options.deviceProfileId,
                profile?.viewportWidth,
                profile?.viewportHeight,
              ),
            ];
          }),
        ),
      },
    },
    evidencePaths: [
      options.observation.screenshotPath,
      options.observation.uiDumpPath,
      options.observation.foregroundPath,
    ],
  };
}

function runtimeElement(
  elementId: string,
  candidate: RuntimeCandidate,
  deviceProfileId: string,
  viewportWidth = 1,
  viewportHeight = 1,
): Element {
  return {
    elementId,
    title: candidate.title,
    semanticRole: candidate.role || "Unknown",
    status: "observed",
    selectors: runtimeSelectors(candidate),
    bindings: {
      [deviceProfileId]: {
        deviceProfileId,
        normalizedPoint: {
          x: clamp01(
            (candidate.bounds.x + candidate.bounds.width / 2) / viewportWidth,
          ),
          y: clamp01(
            (candidate.bounds.y + candidate.bounds.height / 2) / viewportHeight,
          ),
        },
        source: "agent_inferred",
        status: "candidate",
        observedAt: new Date().toISOString(),
      },
    },
  };
}

function runtimeSelectors(candidate: RuntimeCandidate): SelectorEntry[] {
  const selectors: SelectorEntry[] = [];
  if (candidate.accessibilityId) {
    selectors.push({
      type: "accessibilityIdentifier",
      value: candidate.accessibilityId,
    });
  }
  if (candidate.label)
    selectors.push({ type: "label", value: candidate.label });
  if (candidate.text) selectors.push({ type: "text", value: candidate.text });
  if (candidate.value)
    selectors.push({ type: "value", value: candidate.value });
  if (candidate.role) selectors.push({ type: "role", value: candidate.role });
  return selectors;
}

function uniqueSelectors(selectors: readonly SelectorEntry[]): SelectorEntry[] {
  const seen = new Set<string>();
  return selectors.filter((selector) => {
    const key = `${selector.type}:${normalizeText(selector.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findGraphElementForCandidate(
  scene: Scene,
  candidate: RuntimeCandidate,
): Element | undefined {
  const values = new Set(
    [
      candidate.accessibilityId,
      candidate.label,
      candidate.text,
      candidate.value,
    ]
      .map(normalizeText)
      .filter(Boolean),
  );
  return Object.values(scene.elements).find((element) =>
    element.selectors.some(
      (selector) =>
        selector.type !== "role" && values.has(normalizeText(selector.value)),
    ),
  );
}

async function writeAndApplyPatch(options: {
  graphPath: string;
  patch: GraphPatch;
  outputDir: string;
  patchIndex: number;
  suffix: string;
}): Promise<{ graph: AppGraph; patchPath: string } | null> {
  const directory = join(options.outputDir, "runtime-graph-patches");
  await mkdir(directory, { recursive: true });
  const patchPath = join(
    directory,
    `${String(options.patchIndex + 1).padStart(2, "0")}-${options.suffix}.json`,
  );
  await writeFile(patchPath, JSON.stringify(options.patch, null, 2), "utf8");
  const result = await applyAndSave(options.graphPath, options.patch);
  if (!result.success) return null;
  return { graph: await loadGraph(options.graphPath), patchPath };
}

function runtimeSceneId(observation: RuntimeObservation): string {
  const identity = observedTexts(observation.uiElements).slice(0, 20).join("|");
  return `runtime.scene.${shortHash(identity || observation.uiDumpPath)}`;
}

function runtimeElementId(
  sceneId: string,
  candidate: RuntimeCandidate,
): string {
  return `${sceneId}.element.${shortHash(candidateComparableText(candidate))}`;
}

function runtimeOperatorId(
  sourceSceneId: string,
  elementId: string,
  actionType: RuntimeRecoveryActionType,
  targetSceneId: string,
): string {
  return `runtime.operator.${shortHash(
    [sourceSceneId, elementId, actionType, targetSceneId].join("|"),
  )}`;
}

function runtimeSceneTitle(
  candidates: readonly RuntimeCandidate[],
  fallback: string,
): string {
  return (
    [...candidates]
      .map((candidate) => candidate.title)
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)[0] ?? fallback
  );
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
