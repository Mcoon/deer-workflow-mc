import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { agent } from "@deerwork-ai/deer-workflow/agents";
import type {
  AgentFunction,
  AgentOptions,
  JsonSchema,
} from "@deerwork-ai/deer-workflow/agents";
import {
  getWorkflowContext,
  phase,
  workflow,
} from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";
import { format } from "prettier";

import {
  DEFAULT_ARTIFACT_ROOT,
  buildMobilecliActionCommand,
  buildMobilecliForegroundCommand,
  buildMobilecliPreflightCommand,
  buildMobilecliScreenshotCommand,
  buildMobilecliUiDumpCommand,
  matchUiElement,
  parseUiDump,
  runCommand,
  writeJsonAtomic,
} from "../ios-regression-kit";

import type { UiElement } from "../ios-regression-kit/types";
import type {
  AgentGoalResolution,
  AgentPlanningTrial,
  CompiledExperimentPlan,
  CompiledExperimentStep,
  ExecutableUiGraphExperiment,
  ExperimentElement,
  ExperimentComposedPathValidation,
  ExperimentExecutionTier,
  ExperimentEntryRecovery,
  ExperimentGroundingResult,
  ExperimentOperator,
  ExperimentResetStrategy,
  ExperimentScene,
  ExperimentTask,
  ExperimentVerifierAssertion,
  ExperimentVerifierEvaluation,
  ExperimentVerifierSpec,
  GraphEntityStatus,
  IosUiTargetedDiscoveryResult,
  IosUiGraphExperimentInput,
  IosUiGraphExperimentResult,
  IosUiGraphWorkflowFailure,
  IosUiGraphWorkflowFailureResult,
  ReferenceAsset,
  SemanticGoalResolution,
  TargetedDiscoveryAction,
  TargetedDiscoveryObservation,
  TimedExperimentCommand,
} from "./types";

const DEFAULT_GRAPH_PATH = resolve(
  dirname(import.meta.path),
  "graph-chat-full.json",
);
const DEFAULT_WORKFLOW_ROOT = resolve(dirname(import.meta.path), "../..");
const VISION_OCR_SOURCE_PATH = resolve(
  dirname(import.meta.path),
  "vision_ocr.swift",
);
const DEVICECTL_RESTART_SOURCE_PATH = resolve(
  dirname(import.meta.path),
  "devicectl_restart.py",
);
const DEVICECTL_WAIT_LAUNCH_SOURCE_PATH = resolve(
  dirname(import.meta.path),
  "devicectl_wait_launch.py",
);
const DEFAULT_PLANNING_ITERATIONS = 1000;
const DEFAULT_MINIMUM_SEMANTIC_CONFIDENCE = 0.8;
const DEFAULT_MAXIMUM_DISCOVERY_STEPS = 6;
const DEFAULT_AGENT_TIMEOUT_MS = 60_000;
const DEFAULT_DISCOVERY_CAPTURE_ATTEMPTS = 3;
const DEFAULT_MAP_HTML_PATH =
  "/Users/bytedance/Documents/BDWorkSpace/ios-perf-optimizer/assets/app-regression/com.bot.doubao/ui-map/map.html";

export const meta = {
  name: "ios-ui-graph-experiment",
  description:
    "Resolves a natural-language goal through an Agent, then plans and optionally executes a verified iOS UI graph.",
  phases: [
    { title: "Load" },
    { title: "Resolve" },
    { title: "Plan" },
    { title: "Evaluate Agent" },
    { title: "Preflight" },
    { title: "Reset" },
    { title: "Ground" },
    { title: "Recover Entry" },
    { title: "Discover" },
    { title: "Synthesize Graph" },
    { title: "Refresh Map" },
    { title: "Execute" },
    { title: "Verify" },
    { title: "Report" },
  ],
  exampleArgs: {
    goal: "帮我发一条消息说你好",
    planOnly: true,
  },
};

const agentGoalResolutionSchema = {
  type: "object",
  properties: {
    requestType: {
      type: "string",
      enum: ["reach_scene", "execute_task"],
    },
    targetId: { type: "string" },
    parameters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "string" },
        },
        required: ["name", "value"],
        additionalProperties: false,
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["requestType", "targetId", "parameters", "confidence", "reason"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const semanticExecutionResolutionSchema = {
  type: "object",
  properties: {
    requestType: {
      type: "string",
      enum: ["execute_task", "unsupported"],
    },
    targetId: { type: "string" },
    parameters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "string" },
        },
        required: ["name", "value"],
        additionalProperties: false,
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["requestType", "targetId", "parameters", "confidence", "reason"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const dynamicCompositionResolutionSchema = {
  type: "object",
  properties: {
    resolutionType: {
      type: "string",
      enum: ["composed_path", "discovery_required"],
    },
    operatorIds: {
      type: "array",
      items: { type: "string" },
    },
    targetSceneId: { type: "string" },
    proposedTaskTitle: { type: "string" },
    desiredOutcome: { type: "string" },
    knownFrontierSceneId: { type: "string" },
    missingCapabilities: {
      type: "array",
      items: { type: "string" },
    },
    suggestedExplorationActions: {
      type: "array",
      items: { type: "string" },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: [
    "resolutionType",
    "operatorIds",
    "targetSceneId",
    "proposedTaskTitle",
    "desiredOutcome",
    "knownFrontierSceneId",
    "missingCapabilities",
    "suggestedExplorationActions",
    "confidence",
    "reason",
  ],
  additionalProperties: false,
} as const satisfies JsonSchema;

const targetedDiscoveryDecisionSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["action", "complete", "blocked"],
    },
    candidateId: { type: "string" },
    actionType: {
      type: "string",
      enum: ["tap", "long_press", "swipe_left", "swipe_right"],
    },
    durationMs: { type: "number", minimum: 300, maximum: 3000 },
    targetElementTitle: { type: "string" },
    targetSemanticRole: { type: "string" },
    operatorTitle: { type: "string" },
    risk: {
      type: "string",
      enum: [
        "navigation",
        "interaction",
        "selection",
        "permission",
        "mutation",
        "destructive",
      ],
    },
    expectedOutcome: { type: "string" },
    sceneTitle: { type: "string" },
    visualTextAnchors: {
      type: "array",
      items: { type: "string" },
    },
    completionEvidence: {
      type: "array",
      items: { type: "string" },
    },
    completionOracleType: {
      type: "string",
      enum: [
        "text_absent",
        "text_visible",
        "scene_changed",
        "region_stable",
        "none",
      ],
    },
    completionOracleValue: { type: "string" },
    reason: { type: "string" },
  },
  required: [
    "status",
    "candidateId",
    "actionType",
    "durationMs",
    "targetElementTitle",
    "targetSemanticRole",
    "operatorTitle",
    "risk",
    "expectedOutcome",
    "sceneTitle",
    "visualTextAnchors",
    "completionEvidence",
    "completionOracleType",
    "completionOracleValue",
    "reason",
  ],
  additionalProperties: false,
} as const satisfies JsonSchema;

const graphSynthesisProposalSchema = {
  type: "object",
  properties: {
    taskId: { type: "string" },
    taskTitle: { type: "string" },
    taskSummary: { type: "string" },
    scenes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          observationId: { type: "string" },
          sceneId: { type: "string" },
          title: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          visualTextAnchors: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "observationId",
          "sceneId",
          "title",
          "aliases",
          "visualTextAnchors",
        ],
        additionalProperties: false,
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stepId: { type: "string" },
          elementId: { type: "string" },
          elementTitle: { type: "string" },
          semanticRole: { type: "string" },
          operatorId: { type: "string" },
          operatorTitle: { type: "string" },
          fromSceneId: { type: "string" },
          toSceneId: { type: "string" },
          effect: { type: "string" },
        },
        required: [
          "stepId",
          "elementId",
          "elementTitle",
          "semanticRole",
          "operatorId",
          "operatorTitle",
          "fromSceneId",
          "toSceneId",
          "effect",
        ],
        additionalProperties: false,
      },
    },
    reason: { type: "string" },
  },
  required: [
    "taskId",
    "taskTitle",
    "taskSummary",
    "scenes",
    "actions",
    "reason",
  ],
  additionalProperties: false,
} as const satisfies JsonSchema;

const agentVerifierProposalSchema = {
  type: "object",
  properties: {
    assertions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          assertionId: { type: "string" },
          type: {
            type: "string",
            enum: [
              "all_text_visible",
              "any_text_visible",
              "text_absent",
              "scene_current",
              "foreground_bundle",
              "region_stable",
            ],
          },
          values: { type: "array", items: { type: "string" } },
          value: { type: "string" },
          sceneId: { type: "string" },
          bundleId: { type: "string" },
        },
        required: [
          "assertionId",
          "type",
          "values",
          "value",
          "sceneId",
          "bundleId",
        ],
        additionalProperties: false,
      },
    },
    reason: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["assertions", "reason", "confidence"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const liveElementResolutionSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["matched", "unmatched"],
    },
    candidateId: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["status", "candidateId", "confidence", "reason"],
  additionalProperties: false,
} as const satisfies JsonSchema;

interface AgentExecutionResolution {
  readonly requestType: "execute_task" | "unsupported";
  readonly targetId: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly confidence: number;
  readonly reason: string;
}

interface AgentDynamicCompositionResolution {
  readonly resolutionType: "composed_path" | "discovery_required";
  readonly operatorIds: readonly string[];
  readonly targetSceneId: string;
  readonly proposedTaskTitle: string;
  readonly desiredOutcome: string;
  readonly knownFrontierSceneId: string;
  readonly missingCapabilities: readonly string[];
  readonly suggestedExplorationActions: readonly string[];
  readonly confidence: number;
  readonly reason: string;
}

export interface AgentTargetedDiscoveryDecision {
  readonly status: "action" | "complete" | "blocked";
  readonly candidateId: string;
  readonly actionType: "tap" | "long_press" | "swipe_left" | "swipe_right";
  readonly durationMs: number;
  readonly targetElementTitle: string;
  readonly targetSemanticRole: string;
  readonly operatorTitle: string;
  readonly risk: ExperimentOperator["risk"];
  readonly expectedOutcome: string;
  readonly sceneTitle: string;
  readonly visualTextAnchors: readonly string[];
  readonly completionEvidence: readonly string[];
  readonly completionOracleType:
    "text_absent" | "text_visible" | "scene_changed" | "region_stable" | "none";
  readonly completionOracleValue: string;
  readonly reason: string;
}

interface AgentGraphSynthesisProposal {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskSummary: string;
  readonly scenes: readonly {
    readonly observationId: string;
    readonly sceneId: string;
    readonly title: string;
    readonly aliases: readonly string[];
    readonly visualTextAnchors: readonly string[];
  }[];
  readonly actions: readonly {
    readonly stepId: string;
    readonly elementId: string;
    readonly elementTitle: string;
    readonly semanticRole: string;
    readonly operatorId: string;
    readonly operatorTitle: string;
    readonly fromSceneId: string;
    readonly toSceneId: string;
    readonly effect: string;
  }[];
  readonly reason: string;
}

interface AgentVerifierProposal {
  readonly assertions: readonly {
    readonly assertionId: string;
    readonly type:
      | "all_text_visible"
      | "any_text_visible"
      | "text_absent"
      | "scene_current"
      | "foreground_bundle"
      | "region_stable";
    readonly values: readonly string[];
    readonly value: string;
    readonly sceneId: string;
    readonly bundleId: string;
  }[];
  readonly reason: string;
  readonly confidence: number;
}

interface AgentLiveElementResolution {
  readonly status: "matched" | "unmatched";
  readonly candidateId: string;
  readonly confidence: number;
  readonly reason: string;
}

export interface AgentVerifierEvidence {
  readonly goal: string;
  readonly currentSceneId: string | null;
  readonly texts: readonly string[];
  readonly foregroundBundle: string | null;
  readonly regionItems: readonly string[];
  readonly evidencePaths: readonly string[];
}

export interface OperatorExecutionOutcome {
  readonly operatorId: string;
  readonly success: boolean;
  readonly evidencePath: string;
  readonly failure?: string;
  readonly liveResolution?: CompiledExperimentStep["liveResolution"];
}

interface NormalizedInput {
  graphPath: string;
  projectRoot: string;
  agentCwd: string;
  udid: string;
  taskId?: string;
  sceneId?: string;
  operatorId?: string;
  goal: string;
  parameters: Readonly<Record<string, string>>;
  deviceProfileId?: string;
  outputDir: string;
  planOnly: boolean;
  allowCandidate: boolean;
  includeReferenceAssetsInSemanticCards: boolean;
  planningIterations: number;
  evaluateAgentPlanning: boolean;
  minimumSemanticConfidence: number;
  maximumDiscoverySteps: number;
  agentTimeoutMs: number;
  replayDiscoveryResultPath?: string;
  correction?: {
    sourceResultPath: string;
    feedback: string;
  };
  appVersion?: string;
  model?: string;
}

export default async function iosUiGraphExperiment(
  args: IosUiGraphExperimentInput,
): Promise<
  | IosUiGraphExperimentResult
  | IosUiTargetedDiscoveryResult
  | IosUiGraphWorkflowFailureResult
> {
  let input: NormalizedInput | undefined;
  try {
    input = normalizeInput(args);
    await mkdir(input.outputDir, { recursive: true });
    return await runIosUiGraphExperiment(input);
  } catch (error) {
    const failureInput = input ?? fallbackInput(args);
    await mkdir(failureInput.outputDir, { recursive: true });
    return writeUnexpectedWorkflowFailure({
      input: failureInput,
      error,
    });
  }
}

async function runIosUiGraphExperiment(
  input: NormalizedInput,
): Promise<
  | IosUiGraphExperimentResult
  | IosUiTargetedDiscoveryResult
  | IosUiGraphWorkflowFailureResult
> {
  phase("Load");
  const loadStarted = performance.now();
  const graph = await readGraph(input.graphPath);
  const loadMs = elapsed(loadStarted);
  validateGraph(graph);
  if (input.replayDiscoveryResultPath) {
    return replayAndSynthesizeTargetedDiscovery({
      graph,
      graphPath: input.graphPath,
      input,
    });
  }
  const activeGraph = input.correction
    ? await applyWorkflowCorrection({
        graph,
        graphPath: input.graphPath,
        outputDir: input.outputDir,
        correction: input.correction,
      })
    : graph;
  const correctionPatchPath = input.correction
    ? join(input.outputDir, "graph-correction-patch.json")
    : undefined;

  phase("Resolve");
  const resolveStarted = performance.now();
  const goalResolution = await resolveSemanticGoal({
    graph: activeGraph,
    taskId: input.taskId,
    sceneId: input.sceneId,
    operatorId: input.operatorId,
    goal: input.goal,
    parameters: input.parameters,
    cwd: input.agentCwd,
    model: input.model,
    minimumConfidence: input.minimumSemanticConfidence,
    timeoutMs: input.agentTimeoutMs,
  });
  const resolveMs = elapsed(resolveStarted);
  const goalResolutionPath = join(input.outputDir, "goal-resolution.json");
  await writeJsonAtomic(goalResolutionPath, goalResolution);
  if (goalResolution.resolutionType === "discovery_required") {
    const discoveryArtifacts = await writeDiscoveryArtifacts({
      resolution: goalResolution,
      graph: activeGraph,
      outputDir: input.outputDir,
    });
    if (!input.planOnly) {
      return executeTargetedDiscovery({
        graph: activeGraph,
        graphPath: input.graphPath,
        resolution: goalResolution,
        graphGapPath: discoveryArtifacts.graphGapPath,
        discoveryPacketPath: discoveryArtifacts.discoveryPacketPath,
        input,
      });
    }
    const resultPath = join(input.outputDir, "result.json");
    const message = "Graph discovery is required before this goal can execute.";
    const result: IosUiGraphWorkflowFailureResult = {
      success: false,
      mode: "workflow_failure",
      planOnly: true,
      outputDir: input.outputDir,
      graphPath: input.graphPath,
      resultPath,
      goal: input.goal,
      commands: [],
      goalResolutionPath,
      graphGapPath: discoveryArtifacts.graphGapPath,
      discoveryPacketPath: discoveryArtifacts.discoveryPacketPath,
      failure: workflowFailure({
        code: "graph_discovery_required",
        stage: "Resolve",
        message,
        recoverable: true,
        evidencePaths: [
          goalResolutionPath,
          discoveryArtifacts.graphGapPath,
          discoveryArtifacts.discoveryPacketPath,
        ],
      }),
    };
    phase("Report");
    await writeJsonAtomic(resultPath, result);
    logWorkflowResult(result);
    return result;
  }
  const task =
    goalResolution.resolutionType === "verified_task" ||
    goalResolution.resolutionType === "candidate_task"
      ? activeGraph.tasks.find(
          (candidate) => candidate.taskId === goalResolution.taskId,
        )!
      : buildComposedCandidateTask(activeGraph, goalResolution);
  const candidateReplay = goalResolution.resolutionType === "candidate_task";
  const parameters = goalResolution.parameters;
  const candidateTaskProposalPath =
    goalResolution.resolutionType === "composed_path"
      ? join(input.outputDir, "candidate-task-proposal.json")
      : undefined;
  if (candidateTaskProposalPath) {
    await writeJsonAtomic(candidateTaskProposalPath, {
      schemaVersion: "ios-ui-candidate-task-proposal/v1",
      goal: input.goal,
      confidence: goalResolution.confidence,
      reason: goalResolution.reason,
      task,
    });
  }

  phase("Plan");
  let plan = compileExperimentPlan({
    graph: activeGraph,
    task,
    parameters,
    udid: input.udid,
    deviceProfileId: input.deviceProfileId,
    allowCandidate: input.allowCandidate || candidateReplay,
    appVersion: input.appVersion,
  });
  let benchmark = benchmarkPlanning({
    graph: activeGraph,
    task,
    parameters,
    udid: input.udid,
    deviceProfileId: input.deviceProfileId,
    allowCandidate: input.allowCandidate || candidateReplay,
    appVersion: input.appVersion,
    iterations: input.planningIterations,
  });
  const planPath = join(input.outputDir, "plan.json");
  await writeJsonAtomic(planPath, plan);
  log(
    [
      "## Executable semantic UI graph plan",
      `- **Graph:** \`${activeGraph.graphId}\``,
      `- **Task:** \`${task.taskId}\``,
      `- **Resolved by:** ${goalResolution.mode} · ${goalResolution.resolutionType} · confidence ${goalResolution.confidence.toFixed(2)}`,
      `- **Steps:** ${plan.steps.length}`,
      `- **Planning:** ${plan.planningDurationMs.toFixed(3)} ms`,
      `- **Benchmark:** ${benchmark.iterations} iterations · mean ${benchmark.meanMs.toFixed(4)} ms · p95 ${benchmark.p95Ms.toFixed(4)} ms`,
      `- **Reference assets:** ${plan.referenceAssets.length}`,
    ].join("\n"),
  );

  let agentPlanningEvaluation:
    IosUiGraphExperimentResult["agentPlanningEvaluation"] | undefined;
  phase("Evaluate Agent");
  if (input.evaluateAgentPlanning) {
    if (!input.goal) {
      throw new Error(
        "evaluateAgentPlanning requires a non-empty natural-language goal.",
      );
    }
    agentPlanningEvaluation = await evaluateAgentPlanning({
      graph: activeGraph,
      goal: input.goal,
      cwd: input.agentCwd,
      model: input.model,
      timeoutMs: input.agentTimeoutMs,
    });
    await writeJsonAtomic(
      join(input.outputDir, "agent-planning-evaluation.json"),
      agentPlanningEvaluation,
    );
  }

  const resultPath = join(input.outputDir, "result.json");
  if (input.planOnly) {
    const result: IosUiGraphExperimentResult = {
      success: true,
      planOnly: true,
      outputDir: input.outputDir,
      graphPath: input.graphPath,
      goalResolutionPath,
      planPath,
      resultPath,
      goalResolution,
      plan,
      candidateTaskProposalPath,
      correctionPatchPath,
      timings: {
        loadMs,
        resolveMs,
        planMs: plan.planningDurationMs,
        benchmark,
      },
      commands: [],
      agentPlanningEvaluation,
    };
    await writeJsonAtomic(resultPath, result);
    return result;
  }

  const commands: TimedExperimentCommand[] = [];
  const executionStarted = performance.now();

  phase("Preflight");
  const preflightStarted = performance.now();
  const preflight = await runTimedCommand({
    stepId: "preflight",
    command: buildMobilecliPreflightCommand(),
    outputDir: input.outputDir,
    cwd: input.projectRoot,
  });
  commands.push(preflight);
  const preflightMs = elapsed(preflightStarted);
  if (preflight.exitCode !== 0) {
    throw new Error(
      `mobilecli preflight failed with exit code ${preflight.exitCode}.`,
    );
  }
  const appVersion =
    input.appVersion ??
    (await detectInstalledAppVersion({
      bundleId: activeGraph.bundleId,
      udid: input.udid,
      outputDir: input.outputDir,
      cwd: input.projectRoot,
    }));
  if (appVersion && appVersion !== plan.appVersion) {
    plan = compileExperimentPlan({
      graph: activeGraph,
      task,
      parameters,
      udid: input.udid,
      deviceProfileId: input.deviceProfileId,
      allowCandidate: input.allowCandidate || candidateReplay,
      appVersion,
    });
    benchmark = benchmarkPlanning({
      graph: activeGraph,
      task,
      parameters,
      udid: input.udid,
      deviceProfileId: input.deviceProfileId,
      allowCandidate: input.allowCandidate || candidateReplay,
      appVersion,
      iterations: input.planningIterations,
    });
    await writeJsonAtomic(planPath, plan);
  }

  phase("Reset");
  const resetStarted = performance.now();
  await executeStrictResetStrategy({
    strategy: plan.resetStrategy,
    udid: input.udid,
    outputDir: input.outputDir,
    cwd: input.projectRoot,
    commands,
    stepPrefix: "reset",
  });
  const resetMs = elapsed(resetStarted);

  phase("Ground");
  const initialGrounding = await captureAndGround({
    graph: activeGraph,
    expectedSceneId: plan.entrySceneId,
    udid: input.udid,
    outputDir: join(input.outputDir, "grounding"),
    prefix: "initial",
  });
  let entryRecovery: ExperimentEntryRecovery | undefined;
  if (initialGrounding.matchedSceneId !== plan.entrySceneId) {
    phase("Recover Entry");
    entryRecovery = await recoverTaskEntry({
      graph: activeGraph,
      fromSceneId: initialGrounding.matchedSceneId,
      targetSceneId: plan.entrySceneId,
      deviceProfileId: plan.deviceProfileId,
      udid: input.udid,
      outputDir: input.outputDir,
      cwd: input.projectRoot,
      commands,
    });
  }
  const activeGrounding =
    entryRecovery?.postRecoveryGrounding ?? initialGrounding;
  if (activeGrounding.matchedSceneId !== plan.entrySceneId) {
    const reexplorationPacketPath = await writeReexplorationPacket({
      outputDir: input.outputDir,
      goalResolution,
      plan,
      initialGrounding,
      entryRecovery,
      commands,
    });
    const result: IosUiGraphExperimentResult = {
      success: false,
      planOnly: false,
      outputDir: input.outputDir,
      graphPath: input.graphPath,
      goalResolutionPath,
      planPath,
      resultPath,
      goalResolution,
      plan,
      timings: {
        loadMs,
        resolveMs,
        planMs: plan.planningDurationMs,
        benchmark,
        preflightMs,
        resetMs,
        groundingMs: initialGrounding.durationMs,
        entryRecoveryMs: entryRecovery?.durationMs,
        totalExecutionMs: elapsed(executionStarted),
      },
      initialGrounding,
      entryRecovery,
      commands,
      agentPlanningEvaluation,
      candidateTaskProposalPath,
      correctionPatchPath,
      reexplorationPacketPath,
      failure: workflowFailure({
        code: "entry_scene_unrecoverable",
        stage: "Recover Entry",
        message: `Unable to recover Task entry Scene ${plan.entrySceneId} from ${initialGrounding.matchedSceneId ?? "unmatched"}.`,
        recoverable: true,
        evidencePaths: [reexplorationPacketPath],
      }),
    };
    phase("Report");
    await writeJsonAtomic(resultPath, result);
    logWorkflowResult(result);
    return result;
  }

  phase("Execute");
  const corridorStarted = performance.now();
  const validateComposedPath =
    goalResolution.resolutionType === "composed_path" ||
    candidateReplay ||
    plan.steps.some((step) => step.requiresLiveResolution === true);
  const composedValidationSteps: Array<
    ExperimentComposedPathValidation["steps"][number]
  > = [];
  const executionOutcomes: OperatorExecutionOutcome[] = [];
  let composedPathSuccess = true;
  for (const step of plan.steps) {
    const executableStep = step.requiresLiveResolution
      ? await resolveGuardedStep({
          graph: activeGraph,
          step,
          deviceProfileId: plan.deviceProfileId,
          udid: input.udid,
          outputDir: join(
            input.outputDir,
            "guarded-resolution",
            safeSegment(step.stepId),
          ),
          commandCwd: input.projectRoot,
          agentCwd: input.agentCwd,
          model: input.model,
          timeoutMs: input.agentTimeoutMs,
        })
      : step;
    const timed = await runTimedCommand({
      stepId: step.stepId,
      command: executableStep.command,
      outputDir: join(input.outputDir, "trusted-corridor"),
      cwd: input.projectRoot,
    });
    commands.push(timed);
    if (timed.exitCode !== 0) {
      if (step.executionTier === "guarded") {
        executionOutcomes.push({
          operatorId: step.operatorId,
          success: false,
          evidencePath: timed.stderrPath,
          failure: `Command exited with status ${timed.exitCode}.`,
          liveResolution: step.liveResolutionRequired
            ? undefined
            : executableStep.liveResolution,
        });
      }
      break;
    }
    if (executableStep.operation.type === "tap_restart_app") {
      const proof = parseWaitLaunchResult(
        await Bun.file(timed.stdoutPath).text(),
      );
      if (proof.bundleId !== activeGraph.bundleId) {
        throw new Error(
          `Restart-and-relaunch returned bundle ${proof.bundleId}; expected ${activeGraph.bundleId}.`,
        );
      }
      await writeJsonAtomic(
        join(
          input.outputDir,
          "trusted-corridor",
          `${safeSegment(step.stepId)}-process-proof.json`,
        ),
        proof,
      );
    }
    if (step.settleMs > 0) {
      await Bun.sleep(step.settleMs);
    }
    if (validateComposedPath) {
      const grounding = await captureAndGround({
        graph: activeGraph,
        expectedSceneId: step.expectedToSceneId,
        udid: input.udid,
        outputDir: join(
          input.outputDir,
          "composed-path-validation",
          safeSegment(step.stepId),
        ),
        prefix: "post-step",
      });
      const stepSuccess = grounding.matchedSceneId === step.expectedToSceneId;
      const validationStep = {
        stepId: step.stepId,
        operatorId: step.operatorId,
        expectedSceneId: step.expectedToSceneId,
        grounding,
        success: stepSuccess,
      };
      composedValidationSteps.push(validationStep);
      composedPathSuccess = composedPathSuccess && stepSuccess;
      if (step.executionTier === "guarded") {
        executionOutcomes.push({
          operatorId: step.operatorId,
          success: stepSuccess,
          evidencePath:
            grounding.uiDumpPath ??
            grounding.screenshotPath ??
            join(
              input.outputDir,
              "composed-path-validation",
              safeSegment(step.stepId),
            ),
          failure: stepSuccess
            ? undefined
            : `Expected ${step.expectedToSceneId}; observed ${grounding.matchedSceneId ?? "unmatched"}.`,
          liveResolution: step.liveResolutionRequired
            ? undefined
            : executableStep.liveResolution,
        });
      }
      if (!stepSuccess) {
        break;
      }
    }
  }
  const trustedCorridorMs = elapsed(corridorStarted);
  const composedPathValidation: ExperimentComposedPathValidation | undefined =
    validateComposedPath
      ? {
          success: composedPathSuccess,
          steps: composedValidationSteps,
        }
      : undefined;

  phase("Verify");
  const finalVerification = await verifyFinalState({
    graph: activeGraph,
    plan,
    udid: input.udid,
    outputDir: join(input.outputDir, "verification"),
    baselineScreenshotPath: activeGrounding.screenshotPath,
  });
  const commandSuccess = commands
    .filter((command) => !command.stepId.startsWith("reset-"))
    .every((command) => command.exitCode === 0);
  const pathSuccess =
    commandSuccess && composedPathValidation?.success !== false;
  const verifierEvidence = await captureTaskVerifierEvidence({
    graph: activeGraph,
    goal: input.goal || task.title,
    plan,
    finalVerification,
    udid: input.udid,
    outputDir: join(input.outputDir, "verification", "agent-evidence"),
  });
  const agentVerifier = await compileAndEvaluateAgentVerifier({
    graph: activeGraph,
    goal: input.goal || task.title,
    evidence: verifierEvidence,
    existingSpec: task.verifier,
    legacySuccess: finalVerification.success,
    pathSuccess,
    outputDir: join(input.outputDir, "verification", "agent-verifier"),
    cwd: input.agentCwd,
    model: input.model,
  });

  phase("Report");
  const success = pathSuccess && agentVerifier.success;
  const result: IosUiGraphExperimentResult = {
    success,
    planOnly: false,
    outputDir: input.outputDir,
    graphPath: input.graphPath,
    goalResolutionPath,
    planPath,
    resultPath,
    goalResolution,
    plan,
    timings: {
      loadMs,
      resolveMs,
      planMs: plan.planningDurationMs,
      benchmark,
      preflightMs,
      resetMs,
      groundingMs: initialGrounding.durationMs,
      entryRecoveryMs: entryRecovery?.durationMs,
      trustedCorridorMs,
      finalVerificationMs: finalVerification.durationMs,
      totalExecutionMs: elapsed(executionStarted),
    },
    initialGrounding,
    entryRecovery,
    composedPathValidation,
    commands,
    agentPlanningEvaluation,
    finalVerification,
    agentVerifier,
    candidateTaskProposalPath,
    correctionPatchPath,
  };
  let candidateTaskPatchPath: string | undefined;
  if (success && goalResolution.resolutionType === "composed_path") {
    candidateTaskPatchPath = await persistCandidateTask({
      graph: activeGraph,
      graphPath: input.graphPath,
      task,
      goal: input.goal,
      evidencePath: resultPath,
      outputDir: input.outputDir,
      verifier: agentVerifier.spec,
    });
  }
  const candidateReplayPatchPath =
    success && candidateReplay
      ? await promoteCandidateReplay({
          graph: activeGraph,
          graphPath: input.graphPath,
          task,
          verifier: agentVerifier.spec,
          goal: input.goal,
          evidencePath: resultPath,
          outputDir: input.outputDir,
        })
      : undefined;
  const taskVerifierPatchPath =
    success && goalResolution.resolutionType === "verified_task"
      ? await persistTaskVerifier({
          graph: activeGraph,
          graphPath: input.graphPath,
          task,
          verifier: agentVerifier.spec,
          outputDir: input.outputDir,
        })
      : undefined;
  if (!success) {
    const failureEvidencePath =
      finalVerification.uiDumpPath ?? finalVerification.screenshotPath;
    for (const step of plan.steps) {
      if (
        step.executionTier === "fast" &&
        !executionOutcomes.some(
          (outcome) => outcome.operatorId === step.operatorId,
        )
      ) {
        executionOutcomes.push({
          operatorId: step.operatorId,
          success: false,
          evidencePath: failureEvidencePath,
          failure:
            "The fast path did not satisfy its final verification; downgrade to guarded replay.",
        });
      }
    }
  }
  const executionLearningPatchPath =
    executionOutcomes.length > 0
      ? await persistOperatorExecutionOutcomes({
          graphPath: input.graphPath,
          outcomes: executionOutcomes,
          appVersion: plan.appVersion,
          outputDir: input.outputDir,
        })
      : undefined;
  if (!success) {
    const reexplorationPacketPath = await writeReexplorationPacket({
      outputDir: input.outputDir,
      goalResolution,
      plan,
      initialGrounding,
      entryRecovery,
      commands,
      finalVerification,
    });
    const failedResult: IosUiGraphExperimentResult = {
      ...result,
      candidateReplayPatchPath,
      taskVerifierPatchPath,
      executionLearningPatchPath,
      reexplorationPacketPath,
      failure: workflowFailure({
        code: "execution_verification_failed",
        stage: "Verify",
        message:
          "The UI Graph path or final Agent verifier did not accept the execution outcome.",
        recoverable: true,
        evidencePaths: [
          reexplorationPacketPath,
          agentVerifier.evidencePath,
          finalVerification.uiDumpPath ?? finalVerification.screenshotPath,
        ],
      }),
    };
    await writeJsonAtomic(resultPath, failedResult);
    logWorkflowResult(failedResult);
    return failedResult;
  }
  const completedResult: IosUiGraphExperimentResult = {
    ...result,
    candidateTaskPatchPath,
    candidateReplayPatchPath,
    taskVerifierPatchPath,
    executionLearningPatchPath,
  };
  await writeJsonAtomic(resultPath, completedResult);
  logWorkflowResult(completedResult);
  return completedResult;
}

function fallbackInput(
  args: IosUiGraphExperimentInput | undefined,
): NormalizedInput {
  const runId = safeSegment(args?.runId?.trim() || timestampForPath());
  return {
    graphPath: resolve(args?.graphPath?.trim() || DEFAULT_GRAPH_PATH),
    projectRoot: resolve(args?.projectRoot?.trim() || DEFAULT_WORKFLOW_ROOT),
    agentCwd: DEFAULT_WORKFLOW_ROOT,
    udid: args?.udid?.trim() || "00008030-001A286A2229802E",
    taskId: args?.taskId?.trim() || undefined,
    sceneId: args?.sceneId?.trim() || undefined,
    operatorId: args?.operatorId?.trim() || undefined,
    goal: args?.goal?.trim() || "",
    parameters: args?.parameters ?? {},
    deviceProfileId: args?.deviceProfileId?.trim() || undefined,
    outputDir: resolve(
      args?.outputDir?.trim() ||
        join(DEFAULT_ARTIFACT_ROOT, "ios-ui-graph-experiment", runId),
    ),
    planOnly: args?.planOnly !== false,
    allowCandidate: args?.allowCandidate === true,
    includeReferenceAssetsInSemanticCards:
      args?.includeReferenceAssetsInSemanticCards === true,
    planningIterations: DEFAULT_PLANNING_ITERATIONS,
    evaluateAgentPlanning: args?.evaluateAgentPlanning === true,
    minimumSemanticConfidence: DEFAULT_MINIMUM_SEMANTIC_CONFIDENCE,
    maximumDiscoverySteps: DEFAULT_MAXIMUM_DISCOVERY_STEPS,
    agentTimeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    replayDiscoveryResultPath: args?.replayDiscoveryResultPath?.trim()
      ? resolve(args.replayDiscoveryResultPath)
      : undefined,
    correction:
      args?.correction?.sourceResultPath.trim() &&
      args.correction.feedback.trim()
        ? {
            sourceResultPath: resolve(args.correction.sourceResultPath),
            feedback: args.correction.feedback.trim(),
          }
        : undefined,
    appVersion: args?.appVersion?.trim() || undefined,
    model: args?.model?.trim() || undefined,
  };
}

function workflowFailure(options: {
  code: string;
  stage: string;
  message: string;
  recoverable: boolean;
  evidencePaths?: readonly string[];
}): IosUiGraphWorkflowFailure {
  return {
    code: options.code,
    stage: options.stage,
    message: options.message,
    recoverable: options.recoverable,
    evidencePaths: (options.evidencePaths ?? []).filter(Boolean),
  };
}

async function writeUnexpectedWorkflowFailure(options: {
  input: NormalizedInput;
  error: unknown;
}): Promise<IosUiGraphWorkflowFailureResult> {
  const failedStage = getWorkflowContext()?.phase ?? "Unknown";
  phase("Report");
  const resultPath = join(options.input.outputDir, "result.json");
  const message =
    options.error instanceof Error
      ? options.error.message
      : String(options.error);
  const result: IosUiGraphWorkflowFailureResult = {
    success: false,
    mode: "workflow_failure",
    planOnly: options.input.planOnly,
    outputDir: options.input.outputDir,
    graphPath: options.input.graphPath,
    resultPath,
    goal: options.input.goal,
    commands: [],
    failure: workflowFailure({
      code: unexpectedFailureCode(failedStage),
      stage: failedStage,
      message,
      recoverable: failedStage !== "Load",
      evidencePaths: [resultPath],
    }),
  };
  await writeJsonAtomic(resultPath, result);
  logWorkflowResult(result);
  return result;
}

function unexpectedFailureCode(stage: string): string {
  return `${safeSegment(stage).replaceAll(".", "_").toLocaleLowerCase() || "workflow"}_failed`;
}

function logWorkflowResult(
  result:
    | IosUiGraphExperimentResult
    | IosUiTargetedDiscoveryResult
    | IosUiGraphWorkflowFailureResult,
): void {
  const lines = [
    "## UI graph workflow result",
    `- **Status:** ${result.success ? "PASS" : "FAIL"}`,
    `- **Result:** \`${result.resultPath}\``,
  ];
  if (!result.success && result.failure) {
    lines.push(
      `- **Failure:** \`${result.failure.code}\` at ${result.failure.stage}`,
      `- **Message:** ${result.failure.message}`,
      `- **Recoverable:** ${result.failure.recoverable ? "yes" : "no"}`,
    );
  }
  log(lines.join("\n"));
}

function normalizeInput(args: IosUiGraphExperimentInput): NormalizedInput {
  if (!args) {
    throw new TypeError("iOS UI Graph Experiment requires input arguments.");
  }
  const runId = safeSegment(args.runId?.trim() || timestampForPath());
  return {
    graphPath: resolve(args.graphPath?.trim() || DEFAULT_GRAPH_PATH),
    projectRoot: resolve(args.projectRoot?.trim() || DEFAULT_WORKFLOW_ROOT),
    agentCwd: DEFAULT_WORKFLOW_ROOT,
    udid: args.udid?.trim() || "00008030-001A286A2229802E",
    taskId: args.taskId?.trim() || undefined,
    sceneId: args.sceneId?.trim() || undefined,
    operatorId: args.operatorId?.trim() || undefined,
    goal: args.goal?.trim() || "",
    parameters: args.parameters ?? {},
    deviceProfileId: args.deviceProfileId?.trim() || undefined,
    outputDir: resolve(
      args.outputDir?.trim() ||
        join(DEFAULT_ARTIFACT_ROOT, "ios-ui-graph-experiment", runId),
    ),
    planOnly: args.planOnly !== false,
    allowCandidate: args.allowCandidate === true,
    includeReferenceAssetsInSemanticCards:
      args.includeReferenceAssetsInSemanticCards === true,
    planningIterations: boundedInteger(
      args.planningIterations,
      1,
      100000,
      DEFAULT_PLANNING_ITERATIONS,
    ),
    evaluateAgentPlanning: args.evaluateAgentPlanning === true,
    minimumSemanticConfidence: boundedNumber(
      args.minimumSemanticConfidence,
      0,
      1,
      DEFAULT_MINIMUM_SEMANTIC_CONFIDENCE,
    ),
    maximumDiscoverySteps: boundedInteger(
      args.maximumDiscoverySteps,
      1,
      8,
      DEFAULT_MAXIMUM_DISCOVERY_STEPS,
    ),
    agentTimeoutMs: boundedInteger(
      args.agentTimeoutMs,
      1_000,
      300_000,
      DEFAULT_AGENT_TIMEOUT_MS,
    ),
    replayDiscoveryResultPath: args.replayDiscoveryResultPath?.trim()
      ? resolve(args.replayDiscoveryResultPath)
      : undefined,
    correction:
      args.correction?.sourceResultPath.trim() &&
      args.correction.feedback.trim()
        ? {
            sourceResultPath: resolve(args.correction.sourceResultPath),
            feedback: args.correction.feedback.trim(),
          }
        : undefined,
    appVersion: args.appVersion?.trim() || undefined,
    model: args.model?.trim() || undefined,
  };
}

export async function readGraph(
  path: string,
): Promise<ExecutableUiGraphExperiment> {
  return JSON.parse(await Bun.file(path).text()) as ExecutableUiGraphExperiment;
}

async function applyWorkflowCorrection(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  outputDir: string;
  correction: NonNullable<NormalizedInput["correction"]>;
}): Promise<ExecutableUiGraphExperiment> {
  const source = JSON.parse(
    await Bun.file(options.correction.sourceResultPath).text(),
  ) as {
    goalResolution?: { taskId?: string; goal?: string };
    plan?: { taskId?: string };
  };
  const taskId = source.goalResolution?.taskId ?? source.plan?.taskId;
  if (
    taskId !== "bot.settings.set_max_font_size" ||
    !/重启/.test(options.correction.feedback)
  ) {
    throw new Error(
      `Unsupported Graph correction for Task ${taskId ?? "unknown"}: ${options.correction.feedback}`,
    );
  }
  const previousTask = options.graph.tasks.find(
    (task) => task.taskId === taskId,
  );
  if (!previousTask) {
    throw new Error(`Correction Task does not exist: ${taskId}.`);
  }

  const observationPath =
    "/tmp/ios_perf-opt/ios-ui-graph-experiment/20260816140804/targeted-discovery/observation-02";
  const restartElement: ExperimentElement = {
    elementId: "bot.settings.font_background.restart_prompt.restart",
    sceneId: "bot.settings.font_background.restart_prompt",
    title: "重启并应用字号",
    semanticRole: "Button",
    selector: {
      accessibilityId: "重启",
      label: "重启",
      role: "Button",
    },
    bindings: [
      {
        bindingId:
          "bot.settings.font_background.restart_prompt.restart.iphone-414x896-portrait",
        deviceProfileId: "iphone-414x896-portrait",
        normalizedPoint: {
          x: 274 / 414,
          y: 495 / 896,
        },
        source: "ui_dump",
        status: "verified",
        reliability: 0.9,
        observedAt: new Date().toISOString(),
        appVersion: "14.7.0",
      },
    ],
  };
  const restartOperator: ExperimentOperator = {
    operatorId: "bot.settings.font_background.restart_and_relaunch",
    title: "重启 App 并应用最大字号",
    fromSceneId: "bot.settings.font_background.restart_prompt",
    toSceneId: "chat.detail",
    operation: {
      type: "tap_restart_app",
      elementId: restartElement.elementId,
      bundleId: options.graph.bundleId,
    },
    settleMs: 2_500,
    risk: "mutation",
    status: "candidate",
    reliability: 0.7,
    effects: [
      "点击重启，等待旧 App 进程退出，再通过 devicectl 启动新进程。",
      "font_size=max",
    ],
    postconditions: [
      "scene.current=chat.detail",
      "font_size=max",
      "app.process=restarted",
    ],
    execution: {
      tier: "guarded",
      successfulExecutions: 0,
      failedExecutions: 0,
      consecutiveSuccessfulExecutions: 0,
      consecutiveFailedExecutions: 0,
      evidencePaths: [
        `${observationPath}/ui.json`,
        "/tmp/ios_perf-opt/ios-ui-graph-experiment/20260816140804/targeted-discovery/discover-03-tap.stdout.txt",
        "/tmp/ios_perf-opt/ios-ui-graph-experiment/20260816140804/targeted-discovery/observation-03/ui.json",
        options.correction.sourceResultPath,
      ],
      lastFailure:
        "The historical path proved the restart button exits the app, but did not relaunch and verify the completed user outcome.",
    },
  };
  const correctedTask: ExperimentTask = {
    ...previousTask,
    title: "将字号设置成最大并重启生效",
    summary:
      "选择最大字号并确认，点击重启，证明旧进程退出后重新启动 App，回到会话页才算完成。",
    intents: [
      ...new Set([
        ...previousTask.intents,
        "将字号设置成最大并重启生效",
        "把聊天字体调到最大并应用",
      ]),
    ],
    operatorIds: [
      "chat.open_bot_settings",
      "bot.settings.fabd3ffe8b28.tap.bot.settings.font_background",
      "bot.settings.font_background.select_max_font",
      "bot.settings.font_background.confirm_max_font",
      restartOperator.operatorId,
    ],
    finalOracles: [
      { type: "scene_current", sceneId: "chat.detail" },
      { type: "foreground_bundle", bundleId: options.graph.bundleId },
    ],
    status: "candidate",
    verifier: undefined,
    validation: {
      source: "user_correction",
      sourceGoals: [
        ...new Set([
          ...(previousTask.validation?.sourceGoals ?? previousTask.intents),
          source.goalResolution?.goal ?? "将字号设置成最大",
        ]),
      ],
      successfulExecutions: 0,
      evidencePaths: [
        ...new Set([
          ...(previousTask.validation?.evidencePaths ?? []),
          options.correction.sourceResultPath,
          `${observationPath}/ui.json`,
          "/tmp/ios_perf-opt/ios-ui-graph-experiment/20260816140804/targeted-discovery/observation-03/ui.json",
        ]),
      ],
      lastValidatedAt: new Date().toISOString(),
      requiresFixtureReplay: false,
      completionEvidence: [
        "确认最大字号后出现“重启生效”提示。",
        "用户纠正：必须点击“重启”，不能把提示弹窗当作最终完成。",
        "点击重启后旧 App 退出到系统桌面；需要重新启动新进程并回到会话页。",
      ],
      completionOracle: {
        type: "scene_current",
        value: "chat.detail",
      },
    },
  };
  const patchedGraph: ExecutableUiGraphExperiment = {
    ...options.graph,
    elements: [
      ...options.graph.elements.filter(
        (element) => element.elementId !== restartElement.elementId,
      ),
      restartElement,
    ],
    operators: [
      ...options.graph.operators.filter(
        (operator) => operator.operatorId !== restartOperator.operatorId,
      ),
      restartOperator,
    ],
    tasks: options.graph.tasks.map((task) =>
      task.taskId === correctedTask.taskId ? correctedTask : task,
    ),
  };
  await writeGraphAtomic(options.graphPath, patchedGraph);
  await writeJsonAtomic(
    join(options.outputDir, "graph-correction-patch.json"),
    {
      schemaVersion: "ios-ui-graph-correction/v1",
      graphPath: options.graphPath,
      sourceResultPath: options.correction.sourceResultPath,
      feedback: options.correction.feedback,
      previousTask,
      addedElement: restartElement,
      addedOperator: restartOperator,
      correctedTask,
      generatedAt: new Date().toISOString(),
    },
  );
  return patchedGraph;
}

export function parseInstalledAppVersion(
  output: string,
  bundleId: string,
): string | undefined {
  let root: unknown;
  try {
    root = JSON.parse(output);
  } catch {
    return undefined;
  }
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    const object = value as Record<string, unknown>;
    const reportedBundleId = [
      object.CFBundleIdentifier,
      object.bundleId,
      object.bundleIdentifier,
      object.packageName,
      object.appId,
    ].find((candidate) => typeof candidate === "string");
    if (reportedBundleId === bundleId) {
      const shortVersion = [
        object.CFBundleShortVersionString,
        object.shortVersion,
        object.version,
      ].find(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim().length > 0,
      );
      const buildVersion = [object.CFBundleVersion, object.buildVersion].find(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim().length > 0,
      );
      if (shortVersion || buildVersion) {
        return [shortVersion, buildVersion].filter(Boolean).join("+");
      }
    }
    queue.push(...Object.values(object));
  }
  return undefined;
}

async function detectInstalledAppVersion(options: {
  bundleId: string;
  udid: string;
  outputDir: string;
  cwd: string;
}): Promise<string | undefined> {
  const command = ["mobilecli", "apps", "list", "--device", options.udid];
  const result = await runCommand(command, options.cwd);
  const version =
    result.exitCode === 0
      ? parseInstalledAppVersion(result.stdout, options.bundleId)
      : undefined;
  await writeJsonAtomic(join(options.outputDir, "app-version.json"), {
    schemaVersion: "ios-ui-app-version/v1",
    bundleId: options.bundleId,
    command,
    exitCode: result.exitCode,
    version: version ?? null,
    stderr: result.stderr.slice(-4_000),
  });
  return version;
}

export async function writeGraphAtomic(
  path: string,
  graph: ExecutableUiGraphExperiment,
): Promise<void> {
  const formatted = await format(JSON.stringify(graph), {
    parser: "json",
    filepath: path,
  });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, formatted, "utf8");
  await rename(temporaryPath, path);
  if (resolve(path) === resolve(DEFAULT_GRAPH_PATH) && getWorkflowContext()) {
    phase("Refresh Map");
    await workflow("../ios-ui-semantic-map-report/workflow.ts", {
      graphPath: path,
      htmlPath: DEFAULT_MAP_HTML_PATH,
      discoveryStatePath:
        "/tmp/ios_perf-opt/ios-ui-graph-discovery/doubao-app-crawl-v1/state.json",
    });
  }
}

export function validateGraph(graph: ExecutableUiGraphExperiment): void {
  if (graph.schemaVersion !== "ios-executable-ui-graph-experiment/v1") {
    throw new Error(`Unsupported experiment graph: ${graph.schemaVersion}.`);
  }
  const sceneIds = new Set(graph.scenes.map((scene) => scene.sceneId));
  const elementIds = new Set(
    graph.elements.map((element) => element.elementId),
  );
  const operatorIds = new Set(
    graph.operators.map((operator) => operator.operatorId),
  );
  for (const scene of graph.scenes) {
    for (const elementId of scene.anchorElementIds) {
      if (!elementIds.has(elementId)) {
        throw new Error(
          `Scene ${scene.sceneId} references missing anchor ${elementId}.`,
        );
      }
    }
  }
  for (const operator of graph.operators) {
    if (
      !sceneIds.has(operator.fromSceneId) ||
      !sceneIds.has(operator.toSceneId)
    ) {
      throw new Error(
        `Operator ${operator.operatorId} references an unknown scene.`,
      );
    }
    if (
      (operator.operation.type === "tap" ||
        operator.operation.type === "long_press") &&
      !elementIds.has(operator.operation.elementId)
    ) {
      throw new Error(
        `Operator ${operator.operatorId} references missing element ${operator.operation.elementId}.`,
      );
    }
  }
  for (const task of graph.tasks) {
    for (const operatorId of task.operatorIds) {
      if (!operatorIds.has(operatorId)) {
        throw new Error(
          `Task ${task.taskId} references missing operator ${operatorId}.`,
        );
      }
    }
  }
}

export async function resolveSemanticGoal(options: {
  graph: ExecutableUiGraphExperiment;
  taskId?: string;
  sceneId?: string;
  operatorId?: string;
  goal: string;
  parameters: Readonly<Record<string, string>>;
  cwd: string;
  model?: string;
  minimumConfidence: number;
  timeoutMs?: number;
  agentRunner?: AgentFunction;
}): Promise<SemanticGoalResolution> {
  const started = performance.now();
  const explicitTargets = [
    options.taskId ? "taskId" : null,
    options.sceneId ? "sceneId" : null,
    options.operatorId ? "operatorId" : null,
  ].filter(Boolean);
  if (explicitTargets.length > 1) {
    throw new Error(
      `Only one explicit Graph target may be supplied; received ${explicitTargets.join(", ")}.`,
    );
  }
  if (options.taskId) {
    const task = requireResolvableTask(options.graph, options.taskId);
    return {
      mode: "explicit_task",
      resolutionType:
        task.status === "verified" ? "verified_task" : "candidate_task",
      goal: options.goal,
      taskId: task.taskId,
      parameters: resolveTaskParameters(task, options.parameters, options.goal),
      confidence: 1,
      reason: "The caller explicitly selected this Task.",
      durationMs: elapsed(started),
    };
  }
  if (options.sceneId) {
    const scene = options.graph.scenes.find(
      (candidate) => candidate.sceneId === options.sceneId,
    );
    if (!scene) {
      throw new Error(`Scene does not exist: ${options.sceneId}.`);
    }
    if (!isPlannableScene(scene)) {
      throw new Error(
        `Scene ${scene.sceneId} is not plannable: ${scene.status}.`,
      );
    }
    const resetStrategy = options.graph.resetStrategies.find(
      (strategy) =>
        strategy.strategyId === options.graph.defaultResetStrategyId,
    );
    if (!resetStrategy) {
      throw new Error(
        `Reset strategy does not exist: ${options.graph.defaultResetStrategyId}.`,
      );
    }
    const operatorIds = findEvidenceBackedScenePath(
      options.graph,
      resetStrategy.entrySceneId,
      scene.sceneId,
    );
    if (!operatorIds) {
      throw new Error(
        `No evidence-backed path reaches Scene ${scene.sceneId} from ${resetStrategy.entrySceneId}.`,
      );
    }
    return {
      mode: "explicit_scene",
      resolutionType: "composed_path",
      goal: options.goal || `打开${scene.title}`,
      parameters: options.parameters,
      operatorIds,
      targetSceneId: scene.sceneId,
      proposedTaskTitle: `打开${scene.title}`,
      desiredOutcome: `到达${scene.title}`,
      confidence: 1,
      reason: "The caller explicitly selected this Scene.",
      durationMs: elapsed(started),
      promptBytes: 0,
    };
  }
  if (options.operatorId) {
    const operator = options.graph.operators.find(
      (candidate) => candidate.operatorId === options.operatorId,
    );
    if (!operator) {
      throw new Error(`Operator does not exist: ${options.operatorId}.`);
    }
    if (!isPlannableOperator(operator)) {
      throw new Error(
        `Operator ${operator.operatorId} is not plannable: ${operator.status}.`,
      );
    }
    const resetStrategy = options.graph.resetStrategies.find(
      (strategy) =>
        strategy.strategyId === options.graph.defaultResetStrategyId,
    );
    if (!resetStrategy) {
      throw new Error(
        `Reset strategy does not exist: ${options.graph.defaultResetStrategyId}.`,
      );
    }
    const prefix = findEvidenceBackedScenePath(
      options.graph,
      resetStrategy.entrySceneId,
      operator.fromSceneId,
    );
    if (!prefix) {
      throw new Error(
        `No evidence-backed path reaches Operator entry Scene ${operator.fromSceneId}.`,
      );
    }
    const operatorIds = expandEvidenceBackedStatePreparationOperators(
      options.graph,
      [...prefix, operator.operatorId],
    );
    validateComposedOperatorPath(options.graph, operatorIds);
    return {
      mode: "explicit_operator",
      resolutionType: "composed_path",
      goal: options.goal || operator.title,
      parameters: options.parameters,
      operatorIds,
      targetSceneId: operator.toSceneId,
      proposedTaskTitle: operator.title,
      desiredOutcome: `执行 ${operator.title}`,
      confidence: 1,
      reason: "The caller explicitly selected this Operator.",
      durationMs: elapsed(started),
      promptBytes: 0,
    };
  }
  if (!options.goal) {
    throw new Error(
      "A natural-language goal is required when no explicit Graph target is supplied.",
    );
  }
  const exactTask = resolveExactIntentTask(options.graph, options.goal);
  if (exactTask) {
    return {
      mode: "exact_intent",
      resolutionType:
        exactTask.status === "verified" ? "verified_task" : "candidate_task",
      goal: options.goal,
      taskId: exactTask.taskId,
      parameters: resolveTaskParameters(
        exactTask,
        options.parameters,
        options.goal,
      ),
      confidence: 1,
      reason: `Normalized goal exactly matched Task intent ${exactTask.taskId}.`,
      durationMs: elapsed(started),
      promptBytes: 0,
    };
  }
  const sceneResolution = resolveGoalFromUniqueScene(
    options.graph,
    options.goal,
  );
  if (sceneResolution) {
    return {
      mode: "semantic_scene",
      resolutionType: "composed_path",
      goal: options.goal,
      parameters: options.parameters,
      operatorIds: sceneResolution.operatorIds,
      targetSceneId: sceneResolution.scene.sceneId,
      proposedTaskTitle: `打开${sceneResolution.scene.title}`,
      desiredOutcome: `到达${sceneResolution.scene.title}`,
      confidence: 1,
      reason: `The goal uniquely matched Scene ${sceneResolution.scene.sceneId}; the evidence-backed path was resolved locally.`,
      durationMs: elapsed(started),
      promptBytes: 0,
    };
  }
  const cards = buildResolvableTaskCards(options.graph);
  if (cards.length === 0) {
    throw new Error(
      "The Graph has no verified or safe candidate Tasks available for resolution.",
    );
  }
  const prompt = [
    "Resolve the user request to exactly one available iOS Task.",
    "Return only the schema-backed JSON.",
    "Choose only a targetId from Available Tasks.",
    "Use requestType=execute_task only when exactly one available Task fully supports the request.",
    "A candidate Task is valid when it fully matches the request; the deterministic Plan will apply stricter replay checkpoints.",
    "Use requestType=unsupported, an empty targetId, and empty parameters when no Task fully supports the request or the request is ambiguous.",
    "Extract required parameter values verbatim from the user request.",
    "Do not invent Task IDs, parameter names, UI elements, coordinates, or execution steps.",
    "",
    `User request: ${options.goal}`,
    `Available Tasks: ${JSON.stringify(cards)}`,
  ].join("\n");
  const resolution = await runAgentWithTimeout<AgentExecutionResolution>(
    prompt,
    {
      cwd: options.cwd,
      model: options.model,
      sandbox: "read-only",
      schema: semanticExecutionResolutionSchema,
      env: {
        CODEX_HOME: undefined,
      },
    },
    options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    "semantic Task resolution",
    options.agentRunner,
  );
  if (resolution.requestType === "unsupported") {
    return resolveGoalFromVerifiedOperators({
      ...options,
      started,
      taskResolutionReason: resolution.reason,
    });
  }
  if (resolution.requestType !== "execute_task") {
    throw new Error(
      `Semantic resolver returned unsupported request type: ${resolution.requestType}.`,
    );
  }
  const task = requireResolvableTask(options.graph, resolution.targetId);
  if (resolution.confidence < options.minimumConfidence) {
    throw new Error(
      `Semantic resolution confidence ${resolution.confidence.toFixed(2)} is below the execution threshold ${options.minimumConfidence.toFixed(2)} for Task ${task.taskId}. Reason: ${resolution.reason}`,
    );
  }
  const resolvedParameters: Record<string, string> = {};
  for (const parameter of resolution.parameters) {
    if (!(parameter.name in task.parameters)) {
      throw new Error(
        `Semantic resolver returned unknown parameter ${parameter.name} for Task ${task.taskId}.`,
      );
    }
    if (parameter.value.trim()) {
      resolvedParameters[parameter.name] = parameter.value;
    }
  }
  const parameters = resolveTaskParameters(
    task,
    { ...resolvedParameters, ...options.parameters },
    "",
  );
  return {
    mode: "agent_task",
    resolutionType:
      task.status === "verified" ? "verified_task" : "candidate_task",
    goal: options.goal,
    taskId: task.taskId,
    parameters,
    confidence: resolution.confidence,
    reason: resolution.reason,
    durationMs: elapsed(started),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
  };
}

function resolveExactIntentTask(
  graph: ExecutableUiGraphExperiment,
  goal: string,
): ExperimentTask | undefined {
  const normalizedGoal = normalizeIntent(goal);
  if (!normalizedGoal) {
    return undefined;
  }
  const matches = graph.tasks.filter(
    (task) =>
      (task.status === "verified" ||
        (task.status === "candidate" &&
          task.validation?.requiresFixtureReplay !== true)) &&
      task.intents.some((intent) => normalizeIntent(intent) === normalizedGoal),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeIntent(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s,，。.!！?？、；;:："'“”‘’（）()]/g, "");
}

function resolveGoalFromUniqueScene(
  graph: ExecutableUiGraphExperiment,
  goal: string,
):
  | {
      scene: ExperimentScene;
      operatorIds: readonly string[];
    }
  | undefined {
  const normalizedGoal = normalizeSceneReference(goal);
  const matches = graph.scenes.filter((scene) => {
    if (!isPlannableScene(scene)) {
      return false;
    }
    const terms = [scene.title, ...scene.aliases]
      .map(normalizeSceneReference)
      .filter((term) => term.length >= 2);
    return terms.some((term) => normalizedGoal === term);
  });
  if (matches.length !== 1) {
    return undefined;
  }
  const resetStrategy = graph.resetStrategies.find(
    (strategy) => strategy.strategyId === graph.defaultResetStrategyId,
  );
  if (!resetStrategy) {
    return undefined;
  }
  const path = findEvidenceBackedScenePath(
    graph,
    resetStrategy.entrySceneId,
    matches[0]!.sceneId,
  );
  return path ? { scene: matches[0]!, operatorIds: path } : undefined;
}

function normalizeSceneReference(value: string): string {
  return normalizeIntent(value)
    .replace(/^(?:请|帮我|麻烦)?(?:打开|进入|前往|去到|跳转到|到)/, "")
    .replace(/(?:页面|界面|页|看看|看一下|一下)$/, "");
}

function findEvidenceBackedScenePath(
  graph: ExecutableUiGraphExperiment,
  fromSceneId: string,
  targetSceneId: string,
): readonly string[] | null {
  if (fromSceneId === targetSceneId) {
    return [];
  }
  const outgoing = new Map<string, ExperimentOperator[]>();
  for (const operator of graph.operators) {
    if (
      !isPlannableOperator(operator) ||
      operator.fromSceneId === operator.toSceneId ||
      (operator.risk !== "navigation" && operator.risk !== "interaction")
    ) {
      continue;
    }
    const list = outgoing.get(operator.fromSceneId) ?? [];
    list.push(operator);
    outgoing.set(operator.fromSceneId, list);
  }
  const queue: Array<{
    sceneId: string;
    operatorIds: readonly string[];
  }> = [{ sceneId: fromSceneId, operatorIds: [] }];
  const visited = new Set([fromSceneId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const operator of outgoing.get(current.sceneId) ?? []) {
      if (visited.has(operator.toSceneId)) {
        continue;
      }
      const rawPath = [...current.operatorIds, operator.operatorId];
      const expanded = expandEvidenceBackedStatePreparationOperators(
        graph,
        rawPath,
      );
      try {
        validateComposedOperatorPath(graph, expanded);
      } catch {
        continue;
      }
      if (operator.toSceneId === targetSceneId) {
        return expanded;
      }
      visited.add(operator.toSceneId);
      queue.push({ sceneId: operator.toSceneId, operatorIds: expanded });
    }
  }
  return null;
}

async function resolveGoalFromVerifiedOperators(options: {
  graph: ExecutableUiGraphExperiment;
  goal: string;
  parameters: Readonly<Record<string, string>>;
  cwd: string;
  model?: string;
  minimumConfidence: number;
  timeoutMs?: number;
  started: number;
  taskResolutionReason: string;
  agentRunner?: AgentFunction;
}): Promise<SemanticGoalResolution> {
  const cards = buildVerifiedCompositionCards(options.graph);
  const prompt = [
    "The user request did not match any verified Task.",
    "Try to satisfy it by composing a continuous path from evidence-backed Scene and Operator cards.",
    "Return only the schema-backed JSON.",
    "Use resolutionType=composed_path only when the listed Operators form one continuous path and fully satisfy the request.",
    "A composed_path may use only the provided Operators. Do not invent IDs, parameters, coordinates, or actions.",
    "Both fast and guarded navigation or interaction Operators are real-device evidence-backed.",
    "Same-Scene interaction Operators may establish required state facts such as scroll position before a navigation Operator.",
    "Every Operator precondition must be satisfied by a prior effect or postcondition in the proposed path.",
    "Guarded Operators will be relocated and grounded after every step.",
    "Never compose selection, permission, mutation, or destructive Operators.",
    "Use resolutionType=discovery_required when the Graph cannot fully satisfy the goal.",
    "For discovery_required, describe the known frontier Scene, missing capabilities, and targeted exploration actions.",
    "",
    `User request: ${options.goal}`,
    `Task resolver reason: ${options.taskResolutionReason}`,
    `Verified composition cards: ${JSON.stringify(cards)}`,
  ].join("\n");
  const resolution =
    await runAgentWithTimeout<AgentDynamicCompositionResolution>(
      prompt,
      {
        cwd: options.cwd,
        model: options.model,
        sandbox: "read-only",
        schema: dynamicCompositionResolutionSchema,
        env: {
          CODEX_HOME: undefined,
        },
      },
      options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      "verified Operator composition",
      options.agentRunner,
    );
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (resolution.resolutionType === "discovery_required") {
    return {
      mode: "agent_discovery",
      resolutionType: "discovery_required",
      goal: options.goal,
      parameters: options.parameters,
      confidence: resolution.confidence,
      reason: resolution.reason,
      desiredOutcome: resolution.desiredOutcome,
      knownFrontierSceneId: resolution.knownFrontierSceneId || undefined,
      missingCapabilities: resolution.missingCapabilities,
      suggestedExplorationActions: resolution.suggestedExplorationActions,
      durationMs: elapsed(options.started),
      promptBytes,
    };
  }
  if (resolution.confidence < options.minimumConfidence) {
    return {
      mode: "agent_discovery",
      resolutionType: "discovery_required",
      goal: options.goal,
      parameters: options.parameters,
      confidence: resolution.confidence,
      reason: `Dynamic composition confidence is below the execution threshold. ${resolution.reason}`,
      desiredOutcome: resolution.desiredOutcome,
      knownFrontierSceneId: resolution.knownFrontierSceneId || undefined,
      missingCapabilities: [
        ...resolution.missingCapabilities,
        "A high-confidence verified Operator path",
      ],
      suggestedExplorationActions: resolution.suggestedExplorationActions,
      durationMs: elapsed(options.started),
      promptBytes,
    };
  }
  const operatorIds = expandEvidenceBackedStatePreparationOperators(
    options.graph,
    resolution.operatorIds,
  );
  validateComposedOperatorPath(options.graph, operatorIds);
  const operators = new Map(
    options.graph.operators.map((operator) => [operator.operatorId, operator]),
  );
  const lastOperator = operators.get(operatorIds.at(-1)!);
  if (!lastOperator || lastOperator.toSceneId !== resolution.targetSceneId) {
    throw new Error(
      `Dynamic composition target ${resolution.targetSceneId} does not match the final Operator Scene.`,
    );
  }
  return {
    mode: "agent_composed",
    resolutionType: "composed_path",
    goal: options.goal,
    parameters: options.parameters,
    operatorIds,
    targetSceneId: resolution.targetSceneId,
    proposedTaskTitle:
      resolution.proposedTaskTitle.trim() || `动态任务：${options.goal}`,
    desiredOutcome: resolution.desiredOutcome,
    confidence: resolution.confidence,
    reason: resolution.reason,
    durationMs: elapsed(options.started),
    promptBytes,
  };
}

export function expandEvidenceBackedStatePreparationOperators(
  graph: ExecutableUiGraphExperiment,
  operatorIds: readonly string[],
): readonly string[] {
  const resetStrategy = graph.resetStrategies.find(
    (strategy) => strategy.strategyId === graph.defaultResetStrategyId,
  );
  if (!resetStrategy) {
    throw new Error(
      `Reset strategy does not exist: ${graph.defaultResetStrategyId}.`,
    );
  }
  const operators = new Map(
    graph.operators.map((operator) => [operator.operatorId, operator]),
  );
  const expanded: string[] = [];
  const knownStateFacts = new Map<string, string>();
  let currentSceneId = resetStrategy.entrySceneId;
  const appendFacts = (operator: ExperimentOperator): void => {
    for (const fact of [...operator.effects, ...operator.postconditions]) {
      if (fact.startsWith("scene.current=")) {
        continue;
      }
      const separator = fact.indexOf("=");
      if (separator >= 0) {
        knownStateFacts.set(fact.slice(0, separator), fact);
      }
    }
  };
  for (const operatorId of operatorIds) {
    const operator = operators.get(operatorId);
    if (!operator) {
      throw new Error(
        `Dynamic composition returned unknown Operator ${operatorId}.`,
      );
    }
    const unsatisfiedPreconditions = (operator.preconditions ?? []).filter(
      (precondition) => {
        const separator = precondition.indexOf("=");
        const key =
          separator >= 0 ? precondition.slice(0, separator) : precondition;
        return knownStateFacts.get(key) !== precondition;
      },
    );
    for (const precondition of unsatisfiedPreconditions) {
      const preparation = graph.operators
        .filter(
          (candidate) =>
            candidate.fromSceneId === currentSceneId &&
            candidate.toSceneId === currentSceneId &&
            isPlannableOperator(candidate) &&
            (candidate.risk === "navigation" ||
              candidate.risk === "interaction") &&
            (candidate.preconditions ?? []).every((required) => {
              const separator = required.indexOf("=");
              const key =
                separator >= 0 ? required.slice(0, separator) : required;
              return knownStateFacts.get(key) === required;
            }) &&
            [...candidate.effects, ...candidate.postconditions].includes(
              precondition,
            ),
        )
        .sort((left, right) => {
          const tierRank = (candidate: ExperimentOperator) =>
            operatorExecutionTier(candidate) === "fast" ? 1 : 0;
          return (
            tierRank(right) - tierRank(left) ||
            right.reliability - left.reliability
          );
        })[0];
      if (!preparation) {
        continue;
      }
      if (!expanded.includes(preparation.operatorId)) {
        expanded.push(preparation.operatorId);
        appendFacts(preparation);
      }
    }
    expanded.push(operatorId);
    appendFacts(operator);
    currentSceneId = operator.toSceneId;
  }
  return expanded;
}

function buildVerifiedCompositionCards(graph: ExecutableUiGraphExperiment): {
  entrySceneId: string;
  scenes: Array<{
    sceneId: string;
    title: string;
    aliases: readonly string[];
    executionTier: ExperimentExecutionTier;
  }>;
  operators: Array<{
    operatorId: string;
    title: string;
    fromSceneId: string;
    toSceneId: string;
    risk: ExperimentOperator["risk"];
    executionTier: ExperimentExecutionTier;
    effects: readonly string[];
    postconditions: readonly string[];
  }>;
} {
  const resetStrategy = graph.resetStrategies.find(
    (strategy) => strategy.strategyId === graph.defaultResetStrategyId,
  );
  if (!resetStrategy) {
    throw new Error(
      `Reset strategy does not exist: ${graph.defaultResetStrategyId}.`,
    );
  }
  return {
    entrySceneId: resetStrategy.entrySceneId,
    scenes: graph.scenes.filter(isPlannableScene).map((scene) => ({
      sceneId: scene.sceneId,
      title: scene.title,
      aliases: scene.aliases,
      executionTier: sceneExecutionTier(graph, scene.sceneId),
    })),
    operators: graph.operators
      .filter(
        (operator) =>
          isPlannableOperator(operator) &&
          (operator.risk === "navigation" || operator.risk === "interaction") &&
          (operator.fromSceneId !== operator.toSceneId ||
            operator.effects.some((effect) => effect.includes("=")) ||
            operator.postconditions.some((condition) =>
              condition.includes("="),
            )),
      )
      .map((operator) => ({
        operatorId: operator.operatorId,
        title: operator.title,
        fromSceneId: operator.fromSceneId,
        toSceneId: operator.toSceneId,
        risk: operator.risk,
        executionTier: operatorExecutionTier(operator),
        effects: operator.effects,
        postconditions: operator.postconditions,
      })),
  };
}

export function operatorExecutionTier(
  operator: ExperimentOperator,
  appVersion?: string,
): ExperimentExecutionTier {
  if (
    operator.status === "stale" ||
    operator.status === "blocked" ||
    operator.status === "disabled" ||
    operator.execution?.tier === "quarantined"
  ) {
    return "quarantined";
  }
  const versionChanged =
    Boolean(appVersion) &&
    operator.execution?.lastValidatedAppVersion !== appVersion;
  if (versionChanged) {
    return "guarded";
  }
  if (operator.execution?.tier) {
    return operator.execution.tier;
  }
  return operator.status === "verified" ? "fast" : "guarded";
}

export function applyOperatorExecutionOutcome(options: {
  graph: ExecutableUiGraphExperiment;
  operatorId: string;
  success: boolean;
  evidencePath: string;
  appVersion?: string;
  failure?: string;
  liveResolution?: CompiledExperimentStep["liveResolution"];
}): ExecutableUiGraphExperiment {
  const now = new Date().toISOString();
  const operators: ExperimentOperator[] = options.graph.operators.map(
    (operator): ExperimentOperator => {
      if (operator.operatorId !== options.operatorId) {
        return operator;
      }
      const previous = operator.execution;
      const successfulExecutions =
        (previous?.successfulExecutions ?? 0) + (options.success ? 1 : 0);
      const failedExecutions =
        (previous?.failedExecutions ?? 0) + (options.success ? 0 : 1);
      const consecutiveSuccessfulExecutions = options.success
        ? (previous?.consecutiveSuccessfulExecutions ?? 0) + 1
        : 0;
      const consecutiveFailedExecutions = options.success
        ? 0
        : (previous?.consecutiveFailedExecutions ?? 0) + 1;
      const tier: ExperimentExecutionTier =
        consecutiveFailedExecutions >= 2
          ? "quarantined"
          : options.success && consecutiveSuccessfulExecutions >= 2
            ? "fast"
            : "guarded";
      return {
        ...operator,
        status: "verified",
        reliability: options.success
          ? Math.min(1, Math.max(operator.reliability, 0.8) + 0.05)
          : Math.max(0.1, operator.reliability - 0.2),
        execution: {
          tier,
          successfulExecutions,
          failedExecutions,
          consecutiveSuccessfulExecutions,
          consecutiveFailedExecutions,
          evidencePaths: [
            ...new Set([
              ...(previous?.evidencePaths ?? []),
              options.evidencePath,
              ...(options.liveResolution
                ? [options.liveResolution.evidencePath]
                : []),
            ]),
          ],
          lastValidatedAt: options.success ? now : previous?.lastValidatedAt,
          lastFailedAt: options.success ? previous?.lastFailedAt : now,
          lastValidatedAppVersion: options.success
            ? (options.appVersion ?? previous?.lastValidatedAppVersion)
            : previous?.lastValidatedAppVersion,
          lastFailure: options.success
            ? undefined
            : (options.failure ??
              "Operator execution did not reach its expected Scene."),
        },
      };
    },
  );
  const step = options.graph.operators.find(
    (operator) => operator.operatorId === options.operatorId,
  );
  const elementId =
    step?.operation.type === "tap" || step?.operation.type === "long_press"
      ? step.operation.elementId
      : undefined;
  const elements = options.graph.elements.map((element) => {
    if (
      !elementId ||
      element.elementId !== elementId ||
      !options.success ||
      !options.liveResolution?.selector ||
      !options.liveResolution.normalizedPoint
    ) {
      return element;
    }
    const selectorChanged =
      JSON.stringify(element.selector) !==
      JSON.stringify(options.liveResolution.selector);
    const selectorHistory = selectorChanged
      ? [
          ...(element.selectorHistory ?? []),
          {
            selector: element.selector,
            observedAt: now,
            appVersion: options.appVersion,
            evidencePath: options.liveResolution.evidencePath,
          },
        ]
      : element.selectorHistory;
    const profileBinding = element.bindings.find(
      (binding) =>
        binding.deviceProfileId === options.liveResolution?.deviceProfileId,
    );
    const nextBinding: ExperimentElement["bindings"][number] = {
      bindingId:
        profileBinding?.bindingId ??
        `${element.elementId}.${options.liveResolution.deviceProfileId}`,
      deviceProfileId: options.liveResolution.deviceProfileId,
      normalizedPoint: options.liveResolution.normalizedPoint,
      source: "ui_dump",
      status: "verified",
      reliability: options.liveResolution.matchedBy === "selector" ? 1 : 0.8,
      observedAt: now,
      appVersion: options.appVersion,
    };
    return {
      ...element,
      selector: options.liveResolution.selector,
      selectorHistory,
      bindings: [
        ...element.bindings.filter(
          (binding) =>
            binding.deviceProfileId !== options.liveResolution?.deviceProfileId,
        ),
        nextBinding,
      ],
    };
  });
  return { ...options.graph, operators, elements };
}

export function isPlannableOperator(
  operator: ExperimentOperator,
  appVersion?: string,
): boolean {
  return (
    operatorExecutionTier(operator, appVersion) !== "quarantined" &&
    (operator.status === "verified" ||
      (operator.status === "candidate" &&
        operator.execution?.tier === "guarded" &&
        operator.execution.evidencePaths.length > 0))
  );
}

function isPlannableScene(scene: ExperimentScene): boolean {
  return (
    scene.status === "verified" ||
    (scene.status === "candidate" && scene.referenceAssets.length > 0)
  );
}

function sceneExecutionTier(
  graph: ExecutableUiGraphExperiment,
  sceneId: string,
): ExperimentExecutionTier {
  const incoming = graph.operators.filter(
    (operator) =>
      operator.toSceneId === sceneId &&
      operator.fromSceneId !== sceneId &&
      isPlannableOperator(operator),
  );
  return incoming.length > 0 &&
    incoming.every((operator) => operatorExecutionTier(operator) === "fast")
    ? "fast"
    : "guarded";
}

function buildComposedCandidateTask(
  graph: ExecutableUiGraphExperiment,
  resolution: SemanticGoalResolution,
): ExperimentTask {
  if (
    resolution.resolutionType !== "composed_path" ||
    !resolution.operatorIds ||
    !resolution.targetSceneId
  ) {
    throw new Error("Cannot build a candidate Task from this resolution.");
  }
  const resetStrategy = graph.resetStrategies.find(
    (strategy) => strategy.strategyId === graph.defaultResetStrategyId,
  );
  if (!resetStrategy) {
    throw new Error(
      `Reset strategy does not exist: ${graph.defaultResetStrategyId}.`,
    );
  }
  const taskId = `dynamic.${safeSegment(resolution.operatorIds.join("."))}`;
  return {
    taskId,
    title:
      resolution.proposedTaskTitle?.trim() || `动态任务：${resolution.goal}`,
    summary:
      resolution.desiredOutcome?.trim() ||
      `通过 verified Operator 组合完成：${resolution.goal}`,
    intents: [resolution.goal],
    parameters: {},
    entrySceneId: resetStrategy.entrySceneId,
    operatorIds: resolution.operatorIds,
    finalOracles: [
      { type: "scene_current", sceneId: resolution.targetSceneId },
      { type: "foreground_bundle", bundleId: graph.bundleId },
    ],
    status: "candidate",
  };
}

export async function writeDiscoveryArtifacts(options: {
  resolution: SemanticGoalResolution;
  graph: ExecutableUiGraphExperiment;
  outputDir: string;
}): Promise<{ graphGapPath: string; discoveryPacketPath: string }> {
  const graphGapPath = join(options.outputDir, "graph-gap.json");
  const discoveryPacketPath = join(options.outputDir, "discovery-packet.json");
  const knownFrontierScene = options.resolution.knownFrontierSceneId
    ? options.graph.scenes.find(
        (scene) =>
          scene.sceneId === options.resolution.knownFrontierSceneId &&
          scene.status === "verified",
      )
    : undefined;
  const resetStrategy = options.graph.resetStrategies.find(
    (strategy) => strategy.strategyId === options.graph.defaultResetStrategyId,
  );
  const knownOperatorPath =
    knownFrontierScene && resetStrategy
      ? findVerifiedEntryRecoveryOperators(
          options.graph,
          resetStrategy.entrySceneId,
          knownFrontierScene.sceneId,
        )
      : null;
  const gap = {
    schemaVersion: "ios-ui-graph-gap/v1",
    graphId: options.graph.graphId,
    goal: options.resolution.goal,
    desiredOutcome: options.resolution.desiredOutcome,
    knownFrontierSceneId: knownFrontierScene?.sceneId,
    knownOperatorPath,
    missingCapabilities: options.resolution.missingCapabilities ?? [],
    suggestedExplorationActions:
      options.resolution.suggestedExplorationActions ?? [],
    confidence: options.resolution.confidence,
    reason: options.resolution.reason,
    generatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(graphGapPath, gap);
  await writeJsonAtomic(discoveryPacketPath, {
    schemaVersion: "ios-ui-targeted-discovery-packet/v1",
    agentRole: "ios-ui-graph-targeted-discovery",
    goal: options.resolution.goal,
    constraints: [
      "Execute known verified navigation only up to the frontier.",
      "Use screenshot and UI dump at the unknown boundary.",
      "Ask the Agent to identify candidate elements and actions, not to invent coordinates.",
      "Promote no Scene, Element, Binding, Operator, or Task directly to verified.",
      "Persist all screenshots, UI dumps, commands, observations, and oracle evidence.",
      "Stop before destructive or account-affecting actions without explicit approval.",
    ],
    graphGapPath,
    frontier: knownFrontierScene
      ? {
          sceneId: knownFrontierScene.sceneId,
          title: knownFrontierScene.title,
          referenceAssets: knownFrontierScene.referenceAssets,
          knownOperatorPath,
        }
      : null,
    missingCapabilities: gap.missingCapabilities,
    suggestedExplorationActions: gap.suggestedExplorationActions,
    expectedOutputs: [
      "candidate Scene and Element observations",
      "candidate Operator with preconditions, effects, and postconditions",
      "candidate Task proposal",
      "real-device replay evidence",
      "Graph patch proposal",
    ],
  });
  return { graphGapPath, discoveryPacketPath };
}

async function replayAndSynthesizeTargetedDiscovery(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  input: NormalizedInput;
}): Promise<IosUiTargetedDiscoveryResult> {
  const sourcePath = options.input.replayDiscoveryResultPath!;
  const source = JSON.parse(
    await Bun.file(sourcePath).text(),
  ) as IosUiTargetedDiscoveryResult;
  const resultPath = join(
    options.input.outputDir,
    "replayed-discovery-result.json",
  );
  const replayBoundary = findDeterministicReplayCompletion({
    goal: source.goalResolution.goal,
    observations: source.observations,
    actions: source.actions,
  });
  const completionOracle =
    source.completionOracle ?? replayBoundary?.completion.oracle;
  const completionEvidence =
    source.completionEvidence.length > 0
      ? source.completionEvidence
      : (replayBoundary?.completion.evidence ?? []);
  const replayObservations = replayBoundary
    ? source.observations.slice(0, replayBoundary.observationIndex + 1)
    : source.observations;
  const replayActionIds = new Set(
    replayBoundary
      ? source.actions
          .slice(0, replayBoundary.actionIndex + 1)
          .map((action) => action.stepId)
      : source.actions.map((action) => action.stepId),
  );
  const replayActions = source.actions.filter((action) =>
    replayActionIds.has(action.stepId),
  );
  const initialObservation = replayObservations[0];
  const currentObservation = replayObservations.at(-1);
  if (!completionOracle || !initialObservation || !currentObservation) {
    throw new Error(
      `Discovery replay requires completion Oracle and Observations: ${sourcePath}.`,
    );
  }
  const replayGraph = await repairReplayedFallbackCollision({
    graph: options.graph,
    graphPath: options.graphPath,
    source,
    sourcePath,
    outputDir: options.input.outputDir,
  });
  phase("Verify");
  const completionPassed = await verifyTargetedDiscoveryCompletion({
    oracle: completionOracle,
    initialObservation,
    currentObservation,
  });
  if (!completionPassed) {
    const result: IosUiTargetedDiscoveryResult = {
      ...source,
      success: false,
      outputDir: options.input.outputDir,
      graphPath: options.graphPath,
      resultPath,
      issue:
        "Replayed discovery evidence does not satisfy the current completion Oracle.",
      failure: workflowFailure({
        code: "replay_completion_verification_failed",
        stage: "Verify",
        message:
          "Replayed discovery evidence does not satisfy the current completion Oracle.",
        recoverable: true,
        evidencePaths: [sourcePath],
      }),
    };
    await writeJsonAtomic(resultPath, result);
    logWorkflowResult(result);
    return result;
  }
  phase("Synthesize Graph");
  const goalActions = replayActions.filter(
    (action) => action.purpose === "advance_goal",
  );
  const synthesis = await synthesizeAndPersistTargetedDiscoveryGraph({
    graph: replayGraph,
    graphPath: options.graphPath,
    outputDir: options.input.outputDir,
    goal: source.goalResolution.goal,
    observations: replayObservations,
    actions: goalActions,
    completionOracle,
    completionEvidence,
    evidencePath: sourcePath,
    deviceProfileId:
      options.input.deviceProfileId ?? options.graph.defaultDeviceProfileId,
    agentCwd: options.input.agentCwd,
    model: options.input.model,
    timeoutMs: options.input.agentTimeoutMs,
    verifier:
      source.agentVerifier?.spec ??
      (completionOracle.type === "text_visible"
        ? buildVerifierSpecFromCompletionOracle({
            oracle: {
              type: "text_visible",
              value: completionOracle.value,
            },
            bundleId: options.graph.bundleId,
            reason:
              "Replayed deterministic completion evidence compiled the verifier.",
            successfulExecutions: 1,
          })
        : undefined),
  });
  const result: IosUiTargetedDiscoveryResult = {
    ...source,
    success: true,
    outputDir: options.input.outputDir,
    graphPath: options.graphPath,
    resultPath,
    issue: undefined,
    observations: replayObservations,
    actions: replayActions,
    completionOracle,
    completionEvidence,
    graphPatchPath: synthesis.graphPatchPath,
    graphSynthesisProposalPath: synthesis.proposalPath,
    graphSynthesisValidationPath: synthesis.validationPath,
    graphSynthesisMode: synthesis.mode,
    candidateTaskId: synthesis.candidateTaskId,
  };
  await writeJsonAtomic(resultPath, result);
  return result;
}

export function findDeterministicReplayCompletion(options: {
  goal: string;
  observations: readonly TargetedDiscoveryObservation[];
  actions: readonly TargetedDiscoveryAction[];
}):
  | {
      observationIndex: number;
      actionIndex: number;
      completion: NonNullable<
        ReturnType<typeof deterministicTargetedDiscoveryCompletion>
      >;
    }
  | undefined {
  for (
    let observationIndex = 0;
    observationIndex < options.observations.length;
    observationIndex += 1
  ) {
    const observation = options.observations[observationIndex]!;
    const actionIndex = options.actions.findIndex(
      (action) => action.afterObservationId === observation.observationId,
    );
    const actions =
      actionIndex >= 0 ? options.actions.slice(0, actionIndex + 1) : [];
    const completion = deterministicTargetedDiscoveryCompletion({
      goal: options.goal,
      observation,
      actions,
    });
    if (completion) {
      return {
        observationIndex,
        actionIndex,
        completion,
      };
    }
  }
  return undefined;
}

async function repairReplayedFallbackCollision(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  source: IosUiTargetedDiscoveryResult;
  sourcePath: string;
  outputDir: string;
}): Promise<ExecutableUiGraphExperiment> {
  const oldTaskId = options.source.candidateTaskId;
  const desiredTaskId = targetedDiscoveryTaskId(
    options.source.goalResolution.goal,
  );
  if (
    options.source.graphSynthesisMode !== "deterministic_fallback" ||
    !oldTaskId ||
    oldTaskId === desiredTaskId ||
    !options.source.graphPatchPath ||
    !(await Bun.file(options.source.graphPatchPath).exists())
  ) {
    return options.graph;
  }
  const patch = JSON.parse(
    await Bun.file(options.source.graphPatchPath).text(),
  ) as {
    addedScenes?: readonly ExperimentScene[];
    addedElements?: readonly ExperimentElement[];
    addedOperators?: readonly ExperimentOperator[];
    task?: ExperimentTask;
  };
  const addedSceneIds = new Set(
    patch.addedScenes?.map((scene) => scene.sceneId) ?? [],
  );
  const addedElementIds = new Set(
    patch.addedElements?.map((element) => element.elementId) ?? [],
  );
  const addedOperatorIds = new Set(
    patch.addedOperators?.map((operator) => operator.operatorId) ?? [],
  );
  const existingOperator = options.graph.operators.find(
    (operator) => operator.operatorId === oldTaskId,
  );
  const corruptedTask = options.graph.tasks.find(
    (task) =>
      task.taskId === oldTaskId &&
      task.operatorIds.length > 0 &&
      task.operatorIds.every((operatorId) => addedOperatorIds.has(operatorId)),
  );
  if (!corruptedTask) {
    return options.graph;
  }
  if (!existingOperator) {
    const existingDesiredTask = options.graph.tasks.find(
      (task) => task.taskId === desiredTaskId,
    );
    const migratedTask: ExperimentTask = existingDesiredTask ?? {
      ...corruptedTask,
      taskId: desiredTaskId,
    };
    const repairedGraph: ExecutableUiGraphExperiment = {
      ...options.graph,
      tasks: [
        ...options.graph.tasks.filter(
          (task) => task.taskId !== oldTaskId && task.taskId !== desiredTaskId,
        ),
        migratedTask,
      ],
    };
    await writeGraphAtomic(options.graphPath, repairedGraph);
    await writeJsonAtomic(
      join(options.outputDir, "replay-fallback-task-id-migration.json"),
      {
        schemaVersion: "ios-ui-replay-fallback-task-id-migration/v1",
        graphPath: options.graphPath,
        previousTask: corruptedTask,
        migratedTask,
      },
    );
    return repairedGraph;
  }
  const restoredTask: ExperimentTask = {
    taskId: existingOperator.operatorId,
    title: existingOperator.title,
    summary: `通过已观测导航进入 ${existingOperator.toSceneId}。`,
    intents: [existingOperator.title],
    parameters: {},
    entrySceneId: existingOperator.fromSceneId,
    operatorIds: [existingOperator.operatorId],
    finalOracles: [
      { type: "scene_current", sceneId: existingOperator.toSceneId },
      { type: "foreground_bundle", bundleId: options.graph.bundleId },
    ],
    status: existingOperator.status,
    validation: {
      source: "targeted_discovery",
      sourceGoals: [existingOperator.title],
      successfulExecutions: 1,
      evidencePaths: [options.sourcePath],
      lastValidatedAt: new Date().toISOString(),
      requiresFixtureReplay: false,
      completionEvidence: existingOperator.postconditions,
      completionOracle: {
        type: "scene_current",
        value: existingOperator.toSceneId,
      },
    },
  };
  const repairedGraph: ExecutableUiGraphExperiment = {
    ...options.graph,
    scenes: options.graph.scenes.filter(
      (scene) => !addedSceneIds.has(scene.sceneId),
    ),
    elements: options.graph.elements.filter(
      (element) => !addedElementIds.has(element.elementId),
    ),
    operators: options.graph.operators.filter(
      (operator) => !addedOperatorIds.has(operator.operatorId),
    ),
    tasks: options.graph.tasks.map((task) =>
      task.taskId === restoredTask.taskId ? restoredTask : task,
    ),
  };
  await writeGraphAtomic(options.graphPath, repairedGraph);
  await writeJsonAtomic(
    join(options.outputDir, "replay-fallback-collision-repair.json"),
    {
      schemaVersion: "ios-ui-replay-fallback-collision-repair/v1",
      graphPath: options.graphPath,
      previousTask: corruptedTask,
      restoredTask,
      removedSceneIds: [...addedSceneIds],
      removedElementIds: [...addedElementIds],
      removedOperatorIds: [...addedOperatorIds],
    },
  );
  return repairedGraph;
}

async function executeTargetedDiscovery(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  resolution: SemanticGoalResolution;
  graphGapPath: string;
  discoveryPacketPath: string;
  input: NormalizedInput;
}): Promise<IosUiTargetedDiscoveryResult> {
  const commands: TimedExperimentCommand[] = [];
  const observations: TargetedDiscoveryObservation[] = [];
  const actions: TargetedDiscoveryAction[] = [];
  const resultPath = join(options.input.outputDir, "discovery-result.json");
  const evidenceDirectory = join(options.input.outputDir, "targeted-discovery");
  await mkdir(evidenceDirectory, { recursive: true });

  phase("Preflight");
  const preflight = await runTimedCommand({
    stepId: "discovery-preflight",
    command: buildMobilecliPreflightCommand(),
    outputDir: options.input.outputDir,
    cwd: options.input.projectRoot,
  });
  commands.push(preflight);
  if (preflight.exitCode !== 0) {
    throw new Error(
      `Targeted discovery preflight failed with exit code ${preflight.exitCode}.`,
    );
  }

  phase("Reset");
  const resetStrategy = options.graph.resetStrategies.find(
    (strategy) => strategy.strategyId === options.graph.defaultResetStrategyId,
  );
  if (!resetStrategy) {
    throw new Error(
      `Reset strategy does not exist: ${options.graph.defaultResetStrategyId}.`,
    );
  }
  await executeStrictResetStrategy({
    strategy: resetStrategy,
    udid: options.input.udid,
    outputDir: options.input.outputDir,
    cwd: options.input.projectRoot,
    commands,
    stepPrefix: "discovery-reset",
  });
  phase("Ground");
  const initialGrounding = await captureAndGround({
    graph: options.graph,
    expectedSceneId: resetStrategy.entrySceneId,
    udid: options.input.udid,
    outputDir: join(evidenceDirectory, "initial-grounding"),
    prefix: "initial",
  });
  let entryRecovery: ExperimentEntryRecovery | undefined;
  let recoveredEntryObservation: TargetedDiscoveryObservation | undefined;
  if (initialGrounding.matchedSceneId !== resetStrategy.entrySceneId) {
    phase("Recover Entry");
    entryRecovery = await recoverTaskEntry({
      graph: options.graph,
      fromSceneId: initialGrounding.matchedSceneId,
      targetSceneId: resetStrategy.entrySceneId,
      deviceProfileId:
        options.input.deviceProfileId ?? options.graph.defaultDeviceProfileId,
      udid: options.input.udid,
      outputDir: options.input.outputDir,
      cwd: options.input.projectRoot,
      commands,
    });
  }
  let groundedEntry = entryRecovery?.postRecoveryGrounding ?? initialGrounding;
  if (groundedEntry.matchedSceneId !== resetStrategy.entrySceneId) {
    const recovery = await recoverUnknownDiscoveryEntry({
      graph: options.graph,
      targetSceneId: resetStrategy.entrySceneId,
      udid: options.input.udid,
      outputDir: evidenceDirectory,
      cwd: options.input.projectRoot,
      agentCwd: options.input.agentCwd,
      model: options.input.model,
      timeoutMs: options.input.agentTimeoutMs,
      commands,
      actions,
      observations,
    });
    recoveredEntryObservation = recovery.observation;
    groundedEntry = recovery.grounding;
  }
  if (groundedEntry.matchedSceneId !== resetStrategy.entrySceneId) {
    const message = `Unable to ground the discovery entry Scene ${resetStrategy.entrySceneId}.`;
    const result: IosUiTargetedDiscoveryResult = {
      success: false,
      mode: "targeted_discovery",
      outputDir: options.input.outputDir,
      graphPath: options.graphPath,
      graphGapPath: options.graphGapPath,
      discoveryPacketPath: options.discoveryPacketPath,
      resultPath,
      goalResolution: options.resolution,
      initialGrounding,
      entryRecovery,
      observations,
      actions,
      commands,
      completionEvidence: [],
      issue: message,
      failure: workflowFailure({
        code: "discovery_entry_unrecoverable",
        stage: "Recover Entry",
        message,
        recoverable: true,
        evidencePaths: [
          initialGrounding.uiDumpPath ?? initialGrounding.screenshotPath ?? "",
        ],
      }),
    };
    phase("Report");
    await writeJsonAtomic(resultPath, result);
    logWorkflowResult(result);
    return result;
  }

  const frontierSceneId =
    options.resolution.knownFrontierSceneId ?? resetStrategy.entrySceneId;
  const knownOperatorPath =
    frontierSceneId === resetStrategy.entrySceneId
      ? []
      : findVerifiedEntryRecoveryOperators(
          options.graph,
          resetStrategy.entrySceneId,
          frontierSceneId,
        );
  if (knownOperatorPath === null) {
    throw new Error(
      `Targeted discovery cannot reach the known frontier ${frontierSceneId} through verified navigation.`,
    );
  }
  if (knownOperatorPath.length > 0) {
    const knownPathResult = await executeKnownDiscoveryFrontierPath({
      graph: options.graph,
      operatorIds: knownOperatorPath,
      deviceProfileId:
        options.input.deviceProfileId ?? options.graph.defaultDeviceProfileId,
      udid: options.input.udid,
      outputDir: evidenceDirectory,
      cwd: options.input.projectRoot,
      commands,
    });
    if (!knownPathResult.success) {
      throw new Error(
        `Targeted discovery failed before the unknown frontier. Evidence: ${knownPathResult.evidencePath}`,
      );
    }
  }

  phase("Discover");
  let currentObservation =
    recoveredEntryObservation ??
    (await captureTargetedDiscoveryObservation({
      graph: options.graph,
      udid: options.input.udid,
      outputDir: evidenceDirectory,
      index: observations.length,
      preferredSceneId: frontierSceneId,
    }));
  if (
    !observations.some(
      (item) => item.observationId === currentObservation.observationId,
    )
  ) {
    observations.push(currentObservation);
  }
  const targetInitialObservation = currentObservation;
  let completionEvidence: string[] = [];
  let completionOracle:
    | {
        type:
          "text_absent" | "text_visible" | "scene_changed" | "region_stable";
        value: string;
      }
    | undefined;
  let completed = false;
  let agentReportedComplete = false;
  let issue: string | undefined;
  let agentVerifier: ExperimentVerifierEvaluation | undefined;
  let deterministicVerifierSpec: ExperimentVerifierSpec | undefined;

  for (
    let stepIndex = 0;
    stepIndex < options.input.maximumDiscoverySteps;
    stepIndex += 1
  ) {
    const currentCompletion = deterministicTargetedDiscoveryCompletion({
      goal: options.resolution.goal,
      observation: currentObservation,
      actions,
    });
    if (currentCompletion) {
      completionOracle = currentCompletion.oracle;
      completionEvidence = currentCompletion.evidence;
      deterministicVerifierSpec = buildVerifierSpecFromCompletionOracle({
        oracle: currentCompletion.oracle,
        bundleId: options.graph.bundleId,
        reason:
          "Deterministic Scene classification proved the requested target.",
      });
      completed = true;
      break;
    }
    const decision = await decideTargetedDiscoveryAction({
      resolution: options.resolution,
      observation: currentObservation,
      actions,
      cwd: options.input.agentCwd,
      model: options.input.model,
      timeoutMs: options.input.agentTimeoutMs,
    });
    if (decision.status === "blocked") {
      issue = decision.reason;
      break;
    }
    if (decision.status === "complete") {
      agentReportedComplete = true;
      completionEvidence = [...decision.completionEvidence];
      completionOracle =
        decision.completionOracleType === "none"
          ? undefined
          : {
              type: decision.completionOracleType,
              value: decision.completionOracleValue,
            };
      completed = await verifyTargetedDiscoveryCompletion({
        oracle: completionOracle,
        initialObservation: targetInitialObservation,
        currentObservation,
      });
      if (!completed) {
        issue =
          "The Agent reported completion, but the legacy deterministic completion Oracle did not pass.";
      }
      break;
    }
    const candidate = currentObservation.candidates.find(
      (item) => item.candidateId === decision.candidateId,
    );
    if (!candidate) {
      issue = `The Agent selected an unavailable discovery candidate: ${decision.candidateId}.`;
      break;
    }
    const safetyIssue = targetedDiscoverySafetyIssue({
      goal: options.resolution.goal,
      decision,
      candidate,
      previousActions: actions,
    });
    if (safetyIssue) {
      issue = safetyIssue;
      break;
    }
    const executed = await executeTargetedDiscoveryAction({
      graph: options.graph,
      decision,
      candidate,
      currentObservation,
      udid: options.input.udid,
      outputDir: evidenceDirectory,
      observationIndex: observations.length,
      stepIdPrefix: "discover",
      stepIndex,
      purpose: "advance_goal",
      cwd: options.input.projectRoot,
      commands,
    });
    observations.push(executed.observation);
    actions.push(executed.action);
    currentObservation = executed.observation;
    if (executed.action.exitCode !== 0) {
      issue = `Discovery action ${executed.action.stepId} failed with exit code ${executed.action.exitCode}.`;
      break;
    }
    const deterministicCompletion = deterministicTargetedDiscoveryCompletion({
      goal: options.resolution.goal,
      observation: currentObservation,
      actions,
    });
    if (deterministicCompletion) {
      completionOracle = deterministicCompletion.oracle;
      completionEvidence = deterministicCompletion.evidence;
      deterministicVerifierSpec = buildVerifierSpecFromCompletionOracle({
        oracle: deterministicCompletion.oracle,
        bundleId: options.graph.bundleId,
        reason:
          "Deterministic Scene classification proved the requested target.",
      });
      completed = true;
      break;
    }
    if (
      decision.actionType === "swipe_left" ||
      decision.actionType === "swipe_right"
    ) {
      const beforeItems = horizontalRegionItems(candidate);
      const afterRegion = currentObservation.candidates.find(
        (item) => item.role === "HorizontalScrollRegion",
      );
      const afterItems = afterRegion ? horizontalRegionItems(afterRegion) : [];
      if (
        beforeItems.length > 0 &&
        afterItems.length > 0 &&
        JSON.stringify(beforeItems) === JSON.stringify(afterItems)
      ) {
        completionOracle = {
          type: "region_stable",
          value: beforeItems.join("|"),
        };
        completionEvidence = [
          `Horizontal region items are stable after ${decision.actionType}: ${beforeItems.join(" | ")}`,
        ];
        completed = true;
        break;
      }
    }
    if (decision.risk === "destructive") {
      const targetMessage = actions.find(
        (action) =>
          action.actionType === "long_press" &&
          action.targetSemanticRole.toLocaleLowerCase().includes("message"),
      )?.targetText;
      if (
        targetMessage &&
        (await verifyTargetedDiscoveryCompletion({
          oracle: { type: "text_absent", value: targetMessage },
          initialObservation: targetInitialObservation,
          currentObservation,
        }))
      ) {
        completionOracle = { type: "text_absent", value: targetMessage };
        completionEvidence = [
          `The originally long-pressed message text is absent: ${targetMessage}`,
        ];
        completed = true;
        break;
      }
    }
  }
  if ((completed || agentReportedComplete) && currentObservation) {
    phase("Verify");
    try {
      const verifierEvidence = await captureAgentVerifierEvidence({
        graph: options.graph,
        goal: options.resolution.goal,
        observation: currentObservation,
        udid: options.input.udid,
      });
      agentVerifier = await compileAndEvaluateAgentVerifier({
        graph: options.graph,
        goal: options.resolution.goal,
        evidence: verifierEvidence,
        existingSpec:
          options.graph.tasks.find(
            (task) =>
              task.validation?.source === "targeted_discovery" &&
              task.intents.includes(options.resolution.goal),
          )?.verifier ?? deterministicVerifierSpec,
        legacySuccess: completed,
        pathSuccess: actions.every((action) => action.exitCode === 0),
        outputDir: options.input.outputDir,
        cwd: options.input.agentCwd,
        model: options.input.model,
        timeoutMs: options.input.agentTimeoutMs,
      });
      if (agentVerifier.success) {
        completed = true;
        issue = undefined;
        completionEvidence = [
          ...completionEvidence,
          `Agent verifier classification: ${agentVerifier.classification}`,
        ];
      } else {
        completed = false;
        issue = `Agent verifier did not accept the outcome: ${agentVerifier.classification}.`;
      }
    } catch (error) {
      completed = false;
      issue = `Agent verifier failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!completed && !issue) {
    issue = `Targeted discovery exhausted the maximum ${options.input.maximumDiscoverySteps} action steps before proving completion.`;
  }

  let graphPatchPath: string | undefined;
  let graphSynthesisProposalPath: string | undefined;
  let graphSynthesisValidationPath: string | undefined;
  let graphSynthesisMode: "agent" | "deterministic_fallback" | undefined;
  let candidateTaskId: string | undefined;
  if (completed && actions.length > 0 && completionOracle) {
    const goalActions = actions.filter(
      (action) => action.purpose === "advance_goal",
    );
    phase("Synthesize Graph");
    const patch = await synthesizeAndPersistTargetedDiscoveryGraph({
      graph: options.graph,
      graphPath: options.graphPath,
      outputDir: options.input.outputDir,
      goal: options.resolution.goal,
      observations,
      actions: goalActions,
      completionOracle,
      completionEvidence,
      evidencePath: resultPath,
      deviceProfileId:
        options.input.deviceProfileId ?? options.graph.defaultDeviceProfileId,
      agentCwd: options.input.agentCwd,
      model: options.input.model,
      timeoutMs: options.input.agentTimeoutMs,
      verifier: agentVerifier?.spec,
    });
    graphPatchPath = patch.graphPatchPath;
    candidateTaskId = patch.candidateTaskId;
    graphSynthesisProposalPath = patch.proposalPath;
    graphSynthesisValidationPath = patch.validationPath;
    graphSynthesisMode = patch.mode;
  }
  const success = completed && Boolean(graphPatchPath);
  const result: IosUiTargetedDiscoveryResult = {
    success,
    mode: "targeted_discovery",
    outputDir: options.input.outputDir,
    graphPath: options.graphPath,
    graphGapPath: options.graphGapPath,
    discoveryPacketPath: options.discoveryPacketPath,
    resultPath,
    goalResolution: options.resolution,
    initialGrounding,
    entryRecovery,
    observations,
    actions,
    commands,
    graphPatchPath,
    graphSynthesisProposalPath,
    graphSynthesisValidationPath,
    graphSynthesisMode,
    candidateTaskId,
    completionEvidence,
    completionOracle,
    agentVerifier,
    issue,
    failure: success
      ? undefined
      : workflowFailure({
          code: "targeted_discovery_incomplete",
          stage: "Discover",
          message:
            issue ?? "Targeted discovery did not complete the requested goal.",
          recoverable: true,
          evidencePaths: [
            options.graphGapPath,
            options.discoveryPacketPath,
            currentObservation.uiDumpPath,
            currentObservation.screenshotPath,
          ],
        }),
  };
  phase("Report");
  await writeJsonAtomic(resultPath, result);
  logWorkflowResult(result);
  return result;
}

async function executeKnownDiscoveryFrontierPath(options: {
  graph: ExecutableUiGraphExperiment;
  operatorIds: readonly string[];
  deviceProfileId: string;
  udid: string;
  outputDir: string;
  cwd: string;
  commands: TimedExperimentCommand[];
}): Promise<{ success: boolean; evidencePath: string }> {
  const profile = options.graph.deviceProfiles.find(
    (candidate) => candidate.profileId === options.deviceProfileId,
  );
  if (!profile) {
    throw new Error(
      `Device profile does not exist: ${options.deviceProfileId}.`,
    );
  }
  const operatorById = new Map(
    options.graph.operators.map((operator) => [operator.operatorId, operator]),
  );
  const elements = new Map(
    options.graph.elements.map((element) => [element.elementId, element]),
  );
  const evidencePath = join(options.outputDir, "known-frontier-path.json");
  const evidence: unknown[] = [];
  for (const [index, operatorId] of options.operatorIds.entries()) {
    const operator = operatorById.get(operatorId);
    if (
      !operator ||
      operator.status !== "verified" ||
      operator.risk !== "navigation"
    ) {
      throw new Error(
        `Discovery frontier Operator is not verified navigation: ${operatorId}.`,
      );
    }
    const step = compileOperatorStep({
      graph: options.graph,
      operator,
      index,
      parameters: {},
      udid: options.udid,
      deviceProfileId: options.deviceProfileId,
      profile,
      elements,
      stepPrefix: "frontier-",
    });
    const timed = await runTimedCommand({
      stepId: step.stepId,
      command: step.command,
      outputDir: options.outputDir,
      cwd: options.cwd,
    });
    options.commands.push(timed);
    await Bun.sleep(step.settleMs);
    const grounding = await captureAndGround({
      graph: options.graph,
      expectedSceneId: step.expectedToSceneId,
      udid: options.udid,
      outputDir: join(options.outputDir, safeSegment(step.stepId)),
      prefix: "post-step",
    });
    evidence.push({ step, timed, grounding });
    if (
      timed.exitCode !== 0 ||
      grounding.matchedSceneId !== step.expectedToSceneId
    ) {
      await writeJsonAtomic(evidencePath, evidence);
      return { success: false, evidencePath };
    }
  }
  await writeJsonAtomic(evidencePath, evidence);
  return { success: true, evidencePath };
}

async function recoverUnknownDiscoveryEntry(options: {
  graph: ExecutableUiGraphExperiment;
  targetSceneId: string;
  udid: string;
  outputDir: string;
  cwd: string;
  agentCwd: string;
  model?: string;
  timeoutMs: number;
  commands: TimedExperimentCommand[];
  actions: TargetedDiscoveryAction[];
  observations: TargetedDiscoveryObservation[];
}): Promise<{
  observation: TargetedDiscoveryObservation;
  grounding: ExperimentGroundingResult;
}> {
  let observation = await captureTargetedDiscoveryObservation({
    graph: options.graph,
    udid: options.udid,
    outputDir: options.outputDir,
    index: options.observations.length,
    preferredSceneId: options.targetSceneId,
  });
  options.observations.push(observation);
  for (let index = 0; index < 3; index += 1) {
    if (observation.matchedSceneId === options.targetSceneId) {
      return {
        observation,
        grounding: observationToGrounding(observation),
      };
    }
    const prompt = [
      "Recover the iOS app to the required entry Scene before targeted discovery.",
      "Return only schema-backed JSON.",
      "Choose one current candidate that safely cancels, closes, dismisses, or navigates back.",
      "Coordinates are forbidden; choose candidateId only from Observation.",
      "Only tap is allowed. Never choose delete, send, confirm, payment, permission, or content actions.",
      "Use blocked if no safe recovery candidate exists.",
      "",
      `Required entry Scene: ${options.targetSceneId}`,
      `Observation: ${JSON.stringify(observation)}`,
    ].join("\n");
    const decision = await runAgentWithTimeout<AgentTargetedDiscoveryDecision>(
      prompt,
      {
        cwd: options.agentCwd,
        model: options.model,
        sandbox: "read-only",
        schema: targetedDiscoveryDecisionSchema,
        env: { CODEX_HOME: undefined },
      },
      options.timeoutMs,
      "discovery entry recovery",
    );
    if (decision.status !== "action" || decision.actionType !== "tap") {
      break;
    }
    const candidate = observation.candidates.find(
      (item) => item.candidateId === decision.candidateId,
    );
    if (!candidate || !isSafeRecoveryCandidate(candidate)) {
      break;
    }
    const executed = await executeTargetedDiscoveryAction({
      graph: options.graph,
      decision: {
        ...decision,
        risk: "navigation",
      },
      candidate,
      currentObservation: observation,
      udid: options.udid,
      outputDir: options.outputDir,
      observationIndex: options.observations.length,
      stepIdPrefix: "recover-unknown",
      stepIndex: index,
      purpose: "recover_entry",
      cwd: options.cwd,
      commands: options.commands,
    });
    options.actions.push(executed.action);
    options.observations.push(executed.observation);
    observation = executed.observation;
  }
  return {
    observation,
    grounding: observationToGrounding(observation),
  };
}

export async function executeTargetedDiscoveryAction(options: {
  graph: ExecutableUiGraphExperiment;
  decision: AgentTargetedDiscoveryDecision;
  candidate: TargetedDiscoveryObservation["candidates"][number];
  currentObservation: TargetedDiscoveryObservation;
  udid: string;
  outputDir: string;
  observationIndex: number;
  stepIdPrefix: string;
  stepIndex: number;
  purpose: TargetedDiscoveryAction["purpose"];
  cwd: string;
  commands: TimedExperimentCommand[];
  observationEvidenceLevel?: "full" | "ui_dump";
  fallbackToUiDump?: boolean;
}): Promise<{
  action: TargetedDiscoveryAction;
  observation: TargetedDiscoveryObservation;
}> {
  const point = centerOfBounds(options.candidate.bounds);
  const horizontalInset = Math.max(12, options.candidate.bounds.width * 0.12);
  const swipeY = point.y;
  const profile = options.graph.deviceProfiles.find(
    (candidate) => candidate.profileId === options.graph.defaultDeviceProfileId,
  );
  if (!profile) {
    throw new Error(
      `Device profile does not exist: ${options.graph.defaultDeviceProfileId}.`,
    );
  }
  const clampX = (value: number): number =>
    Math.min(profile.viewportWidth - 8, Math.max(8, value));
  const clampY = (value: number): number =>
    Math.min(profile.viewportHeight - 8, Math.max(8, value));
  const command =
    options.decision.actionType === "long_press"
      ? [
          "mobilecli",
          "io",
          "longpress",
          "--device",
          options.udid,
          `${Math.round(point.x)},${Math.round(point.y)}`,
          "--duration",
          String(Math.round(options.decision.durationMs)),
        ]
      : options.decision.actionType === "swipe_left" ||
          options.decision.actionType === "swipe_right"
        ? [
            "mobilecli",
            "io",
            "swipe",
            "--device",
            options.udid,
            options.decision.actionType === "swipe_left"
              ? `${Math.round(clampX(options.candidate.bounds.x + options.candidate.bounds.width - horizontalInset))},${Math.round(clampY(swipeY))},${Math.round(clampX(options.candidate.bounds.x + horizontalInset))},${Math.round(clampY(swipeY))}`
              : `${Math.round(clampX(options.candidate.bounds.x + horizontalInset))},${Math.round(clampY(swipeY))},${Math.round(clampX(options.candidate.bounds.x + options.candidate.bounds.width - horizontalInset))},${Math.round(clampY(swipeY))}`,
          ]
        : [
            "mobilecli",
            "io",
            "tap",
            "--device",
            options.udid,
            `${Math.round(point.x)},${Math.round(point.y)}`,
          ];
  const stepId = `${options.stepIdPrefix}-${String(options.stepIndex + 1).padStart(2, "0")}-${options.decision.actionType}`;
  const timed = await runTimedCommand({
    stepId,
    command,
    outputDir: options.outputDir,
    cwd: options.cwd,
  });
  options.commands.push(timed);
  await Bun.sleep(900);
  let nextObservation: TargetedDiscoveryObservation;
  try {
    nextObservation = await captureTargetedDiscoveryObservation({
      graph: options.graph,
      udid: options.udid,
      outputDir: options.outputDir,
      index: options.observationIndex,
      preferredSceneId: options.currentObservation.matchedSceneId ?? undefined,
      evidenceLevel: options.observationEvidenceLevel,
    });
  } catch (error) {
    if (
      !options.fallbackToUiDump ||
      options.observationEvidenceLevel === "ui_dump"
    ) {
      throw error;
    }
    const diagnosticsPath = join(
      options.outputDir,
      `observation-${String(options.observationIndex).padStart(2, "0")}`,
      "full-capture-failure.json",
    );
    await writeJsonAtomic(diagnosticsPath, {
      schemaVersion: "ios-ui-discovery-capture-fallback/v1",
      error: error instanceof Error ? error.message : String(error),
      fallback: "ui_dump",
      generatedAt: new Date().toISOString(),
    });
    const fallback = await captureTargetedDiscoveryObservation({
      graph: options.graph,
      udid: options.udid,
      outputDir: options.outputDir,
      index: options.observationIndex,
      preferredSceneId: options.currentObservation.matchedSceneId ?? undefined,
      evidenceLevel: "ui_dump",
    });
    nextObservation = {
      ...fallback,
      screenshotPath: diagnosticsPath,
    };
  }
  const expectedAnchorsVisible =
    options.decision.visualTextAnchors.length > 0 &&
    options.decision.visualTextAnchors.every((anchor) =>
      nextObservation.candidates.some((item) =>
        normalizeComparableText(discoveryCandidateText(item)).includes(
          normalizeComparableText(anchor),
        ),
      ),
    );
  const classifiedObservation: TargetedDiscoveryObservation =
    expectedAnchorsVisible
      ? {
          ...nextObservation,
          matchedSceneId: null,
          candidateSceneId: `discovery.${safeSegment(options.decision.sceneTitle || `step-${options.stepIndex + 1}`)}`,
          candidateSceneTitle:
            options.decision.sceneTitle || nextObservation.candidateSceneTitle,
          visualTextAnchors: options.decision.visualTextAnchors,
        }
      : nextObservation;
  const action: TargetedDiscoveryAction = {
    stepId,
    purpose: options.purpose,
    actionType: options.decision.actionType,
    candidateId: options.candidate.candidateId,
    targetText: primaryDiscoveryCandidateText(options.candidate),
    targetElementTitle: options.decision.targetElementTitle,
    targetSemanticRole: options.decision.targetSemanticRole,
    operatorTitle: options.decision.operatorTitle,
    risk: options.decision.risk,
    expectedOutcome: options.decision.expectedOutcome,
    expectedSceneTitle: options.decision.sceneTitle,
    expectedVisualTextAnchors: options.decision.visualTextAnchors,
    command,
    fromSceneId: observationSceneId(options.currentObservation),
    toSceneId: observationSceneId(classifiedObservation),
    beforeObservationId: options.currentObservation.observationId,
    afterObservationId: classifiedObservation.observationId,
    exitCode: timed.exitCode,
  };
  return { action, observation: classifiedObservation };
}

function isSafeRecoveryCandidate(
  candidate: TargetedDiscoveryObservation["candidates"][number],
): boolean {
  const text = normalizeComparableText(discoveryCandidateText(candidate));
  return ["取消", "关闭", "返回", "完成"].some((token) =>
    text.includes(normalizeComparableText(token)),
  );
}

function observationToGrounding(
  observation: TargetedDiscoveryObservation,
): ExperimentGroundingResult {
  return {
    matchedSceneId: observation.matchedSceneId,
    matchedBy: observation.matchedSceneId ? "visual_text_anchors" : "unmatched",
    screenshotPath: observation.screenshotPath,
    uiDumpPath: observation.uiDumpPath,
    durationMs: 0,
  };
}

export async function captureTargetedDiscoveryObservation(options: {
  graph: ExecutableUiGraphExperiment;
  udid: string;
  outputDir: string;
  index: number;
  preferredSceneId?: string;
  evidenceLevel?: "full" | "ui_dump";
}): Promise<TargetedDiscoveryObservation> {
  const observationId = `observation-${String(options.index).padStart(2, "0")}`;
  const directory = join(options.outputDir, observationId);
  await mkdir(directory, { recursive: true });
  const evidenceLevel = options.evidenceLevel ?? "full";
  const screenshotPath =
    evidenceLevel === "full" ? join(directory, "screen.png") : "";
  const uiDumpPath = join(directory, "ui.json");
  if (evidenceLevel === "full") {
    const screenshot = await runDiscoveryCaptureCommand({
      command: buildMobilecliScreenshotCommand(options.udid, screenshotPath),
      directory,
      kind: "screenshot",
    });
    if (screenshot.exitCode !== 0) {
      throw new Error(`Discovery screenshot failed: ${screenshot.stderr}`);
    }
  }
  const dump = await runDiscoveryCaptureCommand({
    command: buildMobilecliUiDumpCommand(options.udid),
    directory,
    kind: "ui-dump",
  });
  if (dump.exitCode !== 0) {
    throw new Error(`Discovery UI dump failed: ${dump.stderr}`);
  }
  await writeFile(uiDumpPath, dump.stdout, "utf8");
  let elements = parseUiDump(dump.stdout);
  if (
    evidenceLevel === "full" &&
    options.preferredSceneId &&
    elements.length <= 3 &&
    elements.some((element) =>
      element.role?.toLocaleLowerCase().includes("webview"),
    )
  ) {
    await Bun.sleep(2_000);
    const refreshedDump = await runDiscoveryCaptureCommand({
      command: buildMobilecliUiDumpCommand(options.udid),
      directory,
      kind: "ui-dump",
    });
    if (refreshedDump.exitCode === 0) {
      await writeFile(uiDumpPath, refreshedDump.stdout, "utf8");
      elements = parseUiDump(refreshedDump.stdout);
    }
    const refreshedScreenshot = await runDiscoveryCaptureCommand({
      command: buildMobilecliScreenshotCommand(options.udid, screenshotPath),
      directory,
      kind: "screenshot",
    });
    if (refreshedScreenshot.exitCode !== 0) {
      throw new Error(
        `Discovery screenshot refresh failed: ${refreshedScreenshot.stderr}`,
      );
    }
  }
  const ocr =
    evidenceLevel === "full"
      ? await runVisionOcr({
          imagePath: screenshotPath,
          outputDir: directory,
          outputFileName: "ocr.json",
        })
      : { outputPath: "", texts: [] };
  const ocrObservations =
    evidenceLevel === "full"
      ? (JSON.parse(await Bun.file(ocr.outputPath).text()) as Array<{
          text: string;
          confidence: number;
          x: number;
          y: number;
          width: number;
          height: number;
        }>)
      : [];
  const matchedSceneId =
    (evidenceLevel === "full"
      ? recognizeSceneByVisualText(
          options.graph,
          ocr.texts,
          options.preferredSceneId,
        )
      : null) ??
    recognizeScene(options.graph, elements, options.preferredSceneId);
  const profile = options.graph.deviceProfiles.find(
    (candidate) => candidate.profileId === options.graph.defaultDeviceProfileId,
  );
  if (!profile) {
    throw new Error(
      `Device profile does not exist: ${options.graph.defaultDeviceProfileId}.`,
    );
  }
  const uiCandidates = selectDiscoveryUiElements(
    elements,
    profile.viewportHeight,
    100,
  ).map((element, index) => ({
    candidateId: `ui-${index + 1}`,
    source: "ui_dump" as const,
    role: element.role,
    accessibilityId: element.accessibilityId,
    label: element.label,
    text: element.text,
    value: element.value,
    bounds: element.bounds!,
  }));
  const ocrCandidates = ocrObservations
    .filter((item) => item.text.trim().length > 0)
    .slice(0, 100)
    .map((item, index) => ({
      candidateId: `ocr-${index + 1}`,
      source: "vision_ocr" as const,
      role: "TextObservation",
      text: item.text,
      confidence: item.confidence,
      bounds: {
        x: item.x * profile.viewportWidth,
        y: (1 - item.y - item.height) * profile.viewportHeight,
        width: item.width * profile.viewportWidth,
        height: item.height * profile.viewportHeight,
      },
    }));
  const gestureCandidates = deriveHorizontalGestureCandidates([
    ...uiCandidates,
    ...ocrCandidates,
  ]);
  const normalizedTexts = (
    evidenceLevel === "full"
      ? ocr.texts
      : elements.flatMap((element) => [
          element.label ?? "",
          element.text ?? "",
          element.value ?? "",
        ])
  )
    .map((text) => text.trim())
    .filter(Boolean)
    .slice(0, 8);
  const allCandidates = [
    ...uiCandidates,
    ...ocrCandidates,
    ...gestureCandidates,
  ];
  const semanticCandidateScene = classifyTargetedDiscoveryScene(allCandidates);
  const candidateSceneId =
    semanticCandidateScene?.sceneId ??
    matchedSceneId ??
    `discovery.${safeSegment(observationId)}`;
  return {
    observationId,
    screenshotPath,
    uiDumpPath,
    ocrPath: ocr.outputPath,
    matchedSceneId: semanticCandidateScene ? null : matchedSceneId,
    candidateSceneId,
    candidateSceneTitle:
      semanticCandidateScene?.title ??
      options.graph.scenes.find((scene) => scene.sceneId === matchedSceneId)
        ?.title ??
      `探索页面 ${options.index}`,
    visualTextAnchors:
      semanticCandidateScene?.visualTextAnchors ?? normalizedTexts,
    candidates: allCandidates,
  };
}

export function isRetryableDiscoveryCaptureFailure(stderr: string): boolean {
  const normalized = stderr.toLocaleLowerCase();
  return [
    'post "http://localhost:8100/rpc": eof',
    "unexpected eof",
    "use of closed network connection",
    "connection reset by peer",
    "broken pipe",
  ].some((pattern) => normalized.includes(pattern));
}

async function runDiscoveryCaptureCommand(options: {
  command: readonly string[];
  directory: string;
  kind: "screenshot" | "ui-dump";
}): Promise<Awaited<ReturnType<typeof runCommand>>> {
  let result = await runCommand(options.command);
  for (
    let attempt = 1;
    attempt <= DEFAULT_DISCOVERY_CAPTURE_ATTEMPTS;
    attempt += 1
  ) {
    await Promise.all([
      writeFile(
        join(
          options.directory,
          `${options.kind}-attempt-${attempt}.stdout.txt`,
        ),
        result.stdout,
        "utf8",
      ),
      writeFile(
        join(
          options.directory,
          `${options.kind}-attempt-${attempt}.stderr.txt`,
        ),
        result.stderr,
        "utf8",
      ),
    ]);
    if (
      result.exitCode === 0 ||
      attempt === DEFAULT_DISCOVERY_CAPTURE_ATTEMPTS ||
      !isRetryableDiscoveryCaptureFailure(result.stderr)
    ) {
      return result;
    }
    await Bun.sleep(attempt * 1_000);
    result = await runCommand(options.command);
  }
  return result;
}

export async function decideTargetedDiscoveryAction(options: {
  resolution: SemanticGoalResolution;
  observation: TargetedDiscoveryObservation;
  actions: readonly TargetedDiscoveryAction[];
  cwd: string;
  model?: string;
  timeoutMs: number;
}): Promise<AgentTargetedDiscoveryDecision> {
  const prompt = [
    "Drive one bounded step of targeted iOS UI discovery.",
    "Return only schema-backed JSON.",
    "Choose candidateId only from the current Observation.",
    "Coordinates are forbidden; the executor resolves candidate bounds.",
    "Use tap, long_press, swipe_left, or swipe_right only.",
    "For horizontal scrolling goals, choose a HorizontalScrollRegion candidate and swipe_left to reveal later items or swipe_right to reveal earlier items.",
    "Do not tap items merely to move a scrollable region.",
    "Use complete when repeated swipes leave the region's visible item set unchanged, or when a clear requested end marker is stably visible.",
    "Use complete only when current evidence proves the original goal completed and provide a deterministic completion Oracle.",
    "Use blocked when no safe, goal-relevant candidate exists.",
    "Do not select send, payment, permission approval, or unrelated destructive actions.",
    "For deletion goals, long-pressing the exact target message is interaction; selecting a visible delete/confirm-delete control may be destructive only after the target message menu was opened.",
    "",
    `Goal: ${options.resolution.goal}`,
    `Desired outcome: ${options.resolution.desiredOutcome ?? ""}`,
    `Missing capabilities: ${JSON.stringify(options.resolution.missingCapabilities ?? [])}`,
    `Previous actions: ${JSON.stringify(options.actions)}`,
    `Observation: ${JSON.stringify(options.observation)}`,
  ].join("\n");
  return runAgentWithTimeout<AgentTargetedDiscoveryDecision>(
    prompt,
    {
      cwd: options.cwd,
      model: options.model,
      sandbox: "read-only",
      schema: targetedDiscoveryDecisionSchema,
      env: { CODEX_HOME: undefined },
    },
    options.timeoutMs,
    "targeted discovery decision",
  );
}

export function targetedDiscoverySafetyIssue(options: {
  goal: string;
  decision: AgentTargetedDiscoveryDecision;
  candidate: TargetedDiscoveryObservation["candidates"][number];
  previousActions: readonly TargetedDiscoveryAction[];
}): string | null {
  const targetText = normalizeComparableText(
    discoveryCandidateText(options.candidate),
  );
  const goal = normalizeComparableText(options.goal);
  const actionbarScrollGoal =
    /actionbar|action bar/i.test(options.goal) && /滑|滚/.test(options.goal);
  const swipeAction =
    options.decision.actionType === "swipe_left" ||
    options.decision.actionType === "swipe_right";
  if (actionbarScrollGoal && !swipeAction) {
    return "ActionBar scrolling goals only allow swipe_left or swipe_right; tapping or long-pressing ActionBar items is forbidden.";
  }
  if (swipeAction && options.candidate.role !== "HorizontalScrollRegion") {
    return "Swipe discovery actions require a HorizontalScrollRegion candidate.";
  }
  const alwaysBlocked = ["发送", "支付", "购买", "允许", "授权"];
  if (alwaysBlocked.some((token) => targetText.includes(token))) {
    return `Targeted discovery blocked unrelated high-risk target: ${discoveryCandidateText(options.candidate)}.`;
  }
  if (options.decision.risk === "destructive") {
    const deletionAuthorized =
      /删除|移除|清空/.test(goal) && /删除|移除|清空|确认/.test(targetText);
    const targetMenuOpened = options.previousActions.some(
      (action) => action.actionType === "long_press",
    );
    if (!deletionAuthorized || !targetMenuOpened) {
      return "Destructive discovery action is not authorized by the goal and prior target-menu evidence.";
    }
  }
  return null;
}

export async function verifyTargetedDiscoveryCompletion(options: {
  oracle:
    | {
        type:
          "text_absent" | "text_visible" | "scene_changed" | "region_stable";
        value: string;
      }
    | undefined;
  initialObservation: TargetedDiscoveryObservation;
  currentObservation: TargetedDiscoveryObservation;
}): Promise<boolean> {
  if (!options.oracle || !options.oracle.value.trim()) {
    return false;
  }
  const currentText = options.currentObservation.candidates
    .map(discoveryCandidateText)
    .join("\n");
  if (options.oracle.type === "text_absent") {
    return !normalizeComparableText(currentText).includes(
      normalizeComparableText(options.oracle.value),
    );
  }
  if (options.oracle.type === "text_visible") {
    const expectedTexts = options.oracle.value
      .split(/\s*&&\s*|\s+且\s+/)
      .map((value) => normalizeComparableText(value))
      .filter(Boolean);
    const normalizedCurrentText = normalizeComparableText(currentText);
    return (
      expectedTexts.length > 0 &&
      expectedTexts.every((value) => normalizedCurrentText.includes(value))
    );
  }
  if (options.oracle.type === "region_stable") {
    const initialRegion = options.initialObservation.candidates.find(
      (candidate) => candidate.role === "HorizontalScrollRegion",
    );
    const currentRegion = options.currentObservation.candidates.find(
      (candidate) => candidate.role === "HorizontalScrollRegion",
    );
    return Boolean(
      initialRegion &&
      currentRegion &&
      JSON.stringify(horizontalRegionItems(initialRegion)) ===
        JSON.stringify(horizontalRegionItems(currentRegion)),
    );
  }
  return (
    observationSceneId(options.initialObservation) !==
    observationSceneId(options.currentObservation)
  );
}

export async function compileAndEvaluateAgentVerifier(options: {
  graph: ExecutableUiGraphExperiment;
  goal: string;
  evidence: AgentVerifierEvidence;
  existingSpec?: ExperimentVerifierSpec;
  legacySuccess: boolean;
  pathSuccess: boolean;
  outputDir: string;
  cwd: string;
  model?: string;
  timeoutMs?: number;
}): Promise<ExperimentVerifierEvaluation> {
  await mkdir(options.outputDir, { recursive: true });
  const proposalPath = join(options.outputDir, "agent-verifier-proposal.json");
  const resultPath = join(options.outputDir, "agent-verifier-result.json");
  let spec = options.existingSpec;
  if (!spec || spec.status === "stale") {
    const prompt = [
      "Compile a typed verifier for an executed iOS UI goal.",
      "Return only schema-backed JSON.",
      "Use only the allowed assertion types.",
      "Assertions must express the user-visible business outcome, not implementation details.",
      "Use all_text_visible for conjunctions instead of embedding && in one string.",
      "Use scene_current only when the Scene identity is supported by evidence.",
      "Use region_stable only for a repeated scroll whose visible item set is stable.",
      "Do not use account-specific, personalized, timestamp, or session-varying text as a stable assertion.",
      "Do not declare success directly; compile assertions that deterministic code can execute.",
      "",
      `Goal: ${options.goal}`,
      `Evidence: ${JSON.stringify(options.evidence)}`,
    ].join("\n");
    try {
      const proposal = await runAgentWithTimeout<AgentVerifierProposal>(
        prompt,
        {
          cwd: options.cwd,
          model: options.model,
          sandbox: "read-only",
          schema: agentVerifierProposalSchema,
          env: { CODEX_HOME: undefined },
        },
        options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        "Agent verifier compilation",
      );
      await writeJsonAtomic(proposalPath, proposal);
      const assertions = normalizeAgentVerifierAssertions(proposal);
      spec = {
        schemaVersion: "ios-ui-agent-verifier/v1",
        status: "candidate",
        source: "agent_compiled",
        assertions,
        reason: proposal.reason,
        confidence: proposal.confidence,
        successfulExecutions: 0,
        evidencePaths: [],
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      spec = buildDeterministicVerifierFallback({
        graph: options.graph,
        goal: options.goal,
        evidence: options.evidence,
        error,
      });
      await writeJsonAtomic(proposalPath, {
        schemaVersion: "ios-ui-agent-verifier-fallback/v1",
        reason: spec.reason,
        assertions: spec.assertions,
      });
    }
  }
  const assertionResults = evaluateVerifierAssertions(
    spec.assertions,
    options.evidence,
  );
  const agentSuccess =
    assertionResults.length > 0 &&
    assertionResults.every((result) => result.success);
  const classification = classifyVerifierOutcome({
    agentSuccess,
    legacySuccess: options.legacySuccess,
    pathSuccess: options.pathSuccess,
  });
  const evidencePaths = [
    ...new Set([...spec.evidencePaths, ...options.evidence.evidencePaths]),
  ];
  const successfulExecutions =
    classification === "pass" || classification === "oracle_stale"
      ? spec.successfulExecutions + 1
      : spec.successfulExecutions;
  const updatedSpec: ExperimentVerifierSpec = {
    ...spec,
    status:
      successfulExecutions >= 2
        ? "verified"
        : classification === "uncertain"
          ? "stale"
          : spec.status,
    successfulExecutions,
    evidencePaths,
    updatedAt: new Date().toISOString(),
  };
  const evaluation: ExperimentVerifierEvaluation = {
    success: classification === "pass" || classification === "oracle_stale",
    classification,
    spec: updatedSpec,
    assertionResults,
    evidencePath: resultPath,
  };
  await writeJsonAtomic(resultPath, evaluation);
  return evaluation;
}

export async function runAgentWithTimeout<TOutput>(
  prompt: string,
  options: AgentOptions,
  timeoutMs: number,
  label: string,
  agentRunner: AgentFunction = agent,
): Promise<TOutput> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timed out after ${timeoutMs} ms.`));
  }, timeoutMs);
  try {
    return await agentRunner<TOutput>(prompt, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildDeterministicVerifierFallback(options: {
  graph: ExecutableUiGraphExperiment;
  goal: string;
  evidence: AgentVerifierEvidence;
  error: unknown;
}): ExperimentVerifierSpec {
  const assertions: ExperimentVerifierAssertion[] = [];
  const scene = options.evidence.currentSceneId
    ? options.graph.scenes.find(
        (candidate) => candidate.sceneId === options.evidence.currentSceneId,
      )
    : undefined;
  const stableAnchors = stableVisualTextAnchors(scene?.visualTextAnchors ?? []);
  if (stableAnchors.length > 0) {
    assertions.push({
      assertionId: "fallback-scene-anchors",
      type: "all_text_visible",
      values: stableAnchors,
    });
  } else {
    const goalTokens = stableVisualTextAnchors(
      options.evidence.texts.filter((text) =>
        normalizeComparableText(options.goal).includes(
          normalizeComparableText(text),
        ),
      ),
    ).slice(0, 1);
    if (goalTokens.length > 0) {
      assertions.push({
        assertionId: "fallback-goal-text",
        type: "all_text_visible",
        values: goalTokens,
      });
    }
  }
  if (options.evidence.foregroundBundle) {
    assertions.push({
      assertionId: "fallback-foreground",
      type: "foreground_bundle",
      bundleId: options.evidence.foregroundBundle,
    });
  }
  if (assertions.length === 0) {
    throw options.error;
  }
  return {
    schemaVersion: "ios-ui-agent-verifier/v1",
    status: "candidate",
    source: "deterministic_fallback",
    assertions,
    reason: `Agent verifier compilation failed; deterministic evidence fallback was used: ${options.error instanceof Error ? options.error.message : String(options.error)}`,
    confidence: 0.7,
    successfulExecutions: 0,
    evidencePaths: [],
    updatedAt: new Date().toISOString(),
  };
}

export function classifyVerifierOutcome(options: {
  agentSuccess: boolean;
  legacySuccess: boolean;
  pathSuccess: boolean;
}): ExperimentVerifierEvaluation["classification"] {
  if (!options.pathSuccess) {
    return "path_failed";
  }
  if (options.agentSuccess && options.legacySuccess) {
    return "pass";
  }
  if (options.agentSuccess) {
    return "oracle_stale";
  }
  if (options.legacySuccess) {
    return "uncertain";
  }
  return "evidence_insufficient";
}

function normalizeAgentVerifierAssertions(
  proposal: AgentVerifierProposal,
): ExperimentVerifierAssertion[] {
  const assertions: ExperimentVerifierAssertion[] = [];
  const seen = new Set<string>();
  for (const assertion of proposal.assertions) {
    if (!assertion.assertionId.trim() || seen.has(assertion.assertionId)) {
      continue;
    }
    seen.add(assertion.assertionId);
    if (
      assertion.type === "all_text_visible" ||
      assertion.type === "any_text_visible" ||
      assertion.type === "region_stable"
    ) {
      const values = assertion.values
        .map((value) => value.trim())
        .filter(isStableIdentityText);
      if (values.length > 0) {
        assertions.push({
          assertionId: assertion.assertionId,
          type: assertion.type,
          values,
        });
      }
      continue;
    }
    if (assertion.type === "text_absent" && assertion.value.trim()) {
      assertions.push({
        assertionId: assertion.assertionId,
        type: "text_absent",
        value: assertion.value.trim(),
      });
      continue;
    }
    if (assertion.type === "scene_current" && assertion.sceneId.trim()) {
      assertions.push({
        assertionId: assertion.assertionId,
        type: "scene_current",
        sceneId: assertion.sceneId.trim(),
      });
      continue;
    }
    if (assertion.type === "foreground_bundle" && assertion.bundleId.trim()) {
      assertions.push({
        assertionId: assertion.assertionId,
        type: "foreground_bundle",
        bundleId: assertion.bundleId.trim(),
      });
    }
  }
  if (assertions.length === 0) {
    throw new Error(
      "Agent verifier did not produce any executable assertions.",
    );
  }
  return assertions;
}

export function isStableIdentityText(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return false;
  }
  return !(
    /^用户\s*\d+$/i.test(text) ||
    /^user\s*\d+$/i.test(text) ||
    /^\d{1,2}:\d{2}$/.test(text)
  );
}

function stableVisualTextAnchors(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter(isStableIdentityText);
}

export function evaluateVerifierAssertions(
  assertions: readonly ExperimentVerifierAssertion[],
  evidence: AgentVerifierEvidence,
): ExperimentVerifierEvaluation["assertionResults"] {
  const normalizedTexts = evidence.texts.map(normalizeComparableText);
  return assertions.map((assertion) => {
    const success =
      assertion.type === "all_text_visible"
        ? assertion.values.every((value) =>
            normalizedTexts.some((text) =>
              text.includes(normalizeComparableText(value)),
            ),
          )
        : assertion.type === "any_text_visible"
          ? assertion.values.some((value) =>
              normalizedTexts.some((text) =>
                text.includes(normalizeComparableText(value)),
              ),
            )
          : assertion.type === "text_absent"
            ? !normalizedTexts.some((text) =>
                text.includes(normalizeComparableText(assertion.value)),
              )
            : assertion.type === "scene_current"
              ? evidence.currentSceneId === assertion.sceneId
              : assertion.type === "foreground_bundle"
                ? evidence.foregroundBundle === assertion.bundleId
                : regionItemsMatch(assertion.values, evidence.regionItems);
    return {
      assertion,
      success,
      evidence: evidence.evidencePaths,
    };
  });
}

function regionItemsMatch(
  expectedValues: readonly string[],
  actualValues: readonly string[],
): boolean {
  const expected = [...expectedValues]
    .map(normalizeComparableText)
    .filter(Boolean)
    .sort();
  const actual = [...actualValues]
    .map(normalizeComparableText)
    .filter(Boolean)
    .sort();
  return (
    expected.length > 0 && JSON.stringify(expected) === JSON.stringify(actual)
  );
}

export async function captureAgentVerifierEvidence(options: {
  graph: ExecutableUiGraphExperiment;
  goal: string;
  observation: TargetedDiscoveryObservation;
  udid: string;
}): Promise<AgentVerifierEvidence> {
  const foreground = await runCommand(
    buildMobilecliForegroundCommand(options.udid),
  );
  const foregroundText = `${foreground.stdout}\n${foreground.stderr}`;
  const foregroundBundle = foregroundText.includes(options.graph.bundleId)
    ? options.graph.bundleId
    : null;
  const region = options.observation.candidates.find(
    (candidate) => candidate.role === "HorizontalScrollRegion",
  );
  return {
    goal: options.goal,
    currentSceneId: observationSceneId(options.observation),
    texts: options.observation.candidates
      .map(primaryDiscoveryCandidateText)
      .filter(Boolean),
    foregroundBundle,
    regionItems: region ? horizontalRegionItems(region) : [],
    evidencePaths: [
      options.observation.screenshotPath,
      options.observation.uiDumpPath,
      options.observation.ocrPath,
    ],
  };
}

async function captureTaskVerifierEvidence(options: {
  graph: ExecutableUiGraphExperiment;
  goal: string;
  plan: CompiledExperimentPlan;
  finalVerification: NonNullable<
    IosUiGraphExperimentResult["finalVerification"]
  >;
  udid: string;
  outputDir: string;
}): Promise<AgentVerifierEvidence> {
  await mkdir(options.outputDir, { recursive: true });
  const ocr = await runVisionOcr({
    imagePath: options.finalVerification.screenshotPath,
    outputDir: options.outputDir,
    outputFileName: "final-ocr.json",
  });
  const uiDumpPath = join(options.outputDir, "final-ui.json");
  const dump = await runCommand(buildMobilecliUiDumpCommand(options.udid));
  await writeFile(uiDumpPath, dump.stdout, "utf8");
  const elements = dump.exitCode === 0 ? parseUiDump(dump.stdout) : [];
  const uiTexts = elements.flatMap((element) =>
    [element.text, element.label, element.value].filter(
      (value): value is string => Boolean(value?.trim()),
    ),
  );
  const preferredSceneId = options.plan.steps.at(-1)?.expectedToSceneId;
  const currentSceneId =
    recognizeSceneByVisualText(options.graph, ocr.texts, preferredSceneId) ??
    recognizeScene(options.graph, elements, preferredSceneId);
  const foreground = await runCommand(
    buildMobilecliForegroundCommand(options.udid),
  );
  const foregroundText = `${foreground.stdout}\n${foreground.stderr}`;
  const foregroundBundle = foregroundText.includes(options.graph.bundleId)
    ? options.graph.bundleId
    : null;
  const evidence: AgentVerifierEvidence = {
    goal: options.goal,
    currentSceneId,
    texts: [...new Set([...ocr.texts, ...uiTexts])],
    foregroundBundle,
    regionItems: [],
    evidencePaths: [
      options.finalVerification.screenshotPath,
      ocr.outputPath,
      uiDumpPath,
    ],
  };
  await writeJsonAtomic(join(options.outputDir, "evidence.json"), evidence);
  return evidence;
}

export function centerOfBounds(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number } {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

export function selectDiscoveryUiElements(
  elements: readonly UiElement[],
  viewportHeight: number,
  limit: number,
): UiElement[] {
  const candidates = elements.filter(
    (element) => element.bounds && discoveryCandidateText(element).length > 0,
  );
  const visible = candidates.filter((element) => {
    const bounds = element.bounds!;
    return bounds.y < viewportHeight && bounds.y + bounds.height > 0;
  });
  const bandCount = 8;
  const perBand = Math.ceil(limit / bandCount);
  const selected = Array.from({ length: bandCount }, (_, bandIndex) =>
    visible
      .filter((element) => {
        const centerY = element.bounds!.y + element.bounds!.height / 2;
        const normalized = Math.min(
          0.999,
          Math.max(0, centerY / viewportHeight),
        );
        return Math.floor(normalized * bandCount) === bandIndex;
      })
      .slice(0, perBand),
  )
    .flat()
    .slice(0, limit);
  if (selected.length >= limit) {
    return selected;
  }
  const selectedSet = new Set(selected);
  return [
    ...selected,
    ...candidates
      .filter((element) => !selectedSet.has(element))
      .slice(0, limit - selected.length),
  ];
}

function discoveryCandidateText(
  candidate: Pick<
    TargetedDiscoveryObservation["candidates"][number],
    "accessibilityId" | "label" | "text" | "value" | "role"
  >,
): string {
  return [
    candidate.label,
    candidate.text,
    candidate.value,
    candidate.accessibilityId,
    candidate.role,
  ]
    .filter(Boolean)
    .join(" · ")
    .trim();
}

function primaryDiscoveryCandidateText(
  candidate: Pick<
    TargetedDiscoveryObservation["candidates"][number],
    "accessibilityId" | "label" | "text" | "value"
  >,
): string {
  return (
    candidate.label ??
    candidate.text ??
    candidate.value ??
    candidate.accessibilityId ??
    ""
  ).trim();
}

function horizontalRegionItems(
  candidate: Pick<
    TargetedDiscoveryObservation["candidates"][number],
    "value" | "label"
  >,
): string[] {
  const source =
    candidate.value ??
    candidate.label?.replace(/^横向可滑动区域：\s*/, "") ??
    "";
  return source
    .split("|")
    .map((item) => normalizeComparableText(item))
    .filter(Boolean)
    .sort();
}

export function classifyTargetedDiscoveryScene(
  candidates: TargetedDiscoveryObservation["candidates"],
): {
  sceneId: string;
  title: string;
  visualTextAnchors: readonly string[];
} | null {
  const texts = candidates.map(discoveryCandidateText);
  const has = (value: string): boolean =>
    texts.some((text) =>
      normalizeComparableText(text).includes(normalizeComparableText(value)),
    );
  const visibleSkillTitleCount = candidates.filter(
    (candidate) =>
      candidate.source === "ui_dump" &&
      candidate.role?.toLocaleLowerCase() === "statictext" &&
      candidate.bounds.x >= 70 &&
      candidate.bounds.x <= 130 &&
      candidate.bounds.width >= 170 &&
      candidate.bounds.width <= 290 &&
      candidate.bounds.height >= 22 &&
      candidate.bounds.height <= 32 &&
      primaryDiscoveryCandidateText(candidate).length >= 2 &&
      primaryDiscoveryCandidateText(candidate).length <= 24,
  ).length;
  if (has("删除全部记忆")) {
    return {
      sceneId: "bot.settings.memory.more_menu",
      title: "记忆更多菜单",
      visualTextAnchors: ["删除全部记忆"],
    };
  }
  if (
    has("记忆") &&
    has("更多") &&
    (has("豆包会自动从对话中提取内容优化回复") || has("memory_stars"))
  ) {
    return {
      sceneId: "bot.settings.memory",
      title: "记忆设置",
      visualTextAnchors: ["记忆", "更多"],
    };
  }
  if (has("克隆我的声音") && has("录制自己的声音") && has("确认录制")) {
    return {
      sceneId: "bot.settings.sound.clone_my_voice",
      title: "克隆我的声音",
      visualTextAnchors: ["克隆我的声音", "录制自己的声音", "确认录制"],
    };
  }
  if (has("重启生效") && has("新的字体大小在重启后生效") && has("重启")) {
    return {
      sceneId: "bot.settings.font_background.restart_prompt",
      title: "字号设置重启提示",
      visualTextAnchors: ["重启生效", "新的字体大小在重启后生效"],
    };
  }
  if (
    has("字号与背景") &&
    has("字号调整") &&
    has("font_adjust_max") &&
    (has("确认") || has("恢复默认"))
  ) {
    return {
      sceneId: "bot.settings.font_background",
      title: "字号与背景设置",
      visualTextAnchors: ["字号与背景", "字号调整"],
    };
  }
  if (
    has("常用工具") &&
    has("AI角色备份") &&
    has("大家常问") &&
    (has("意见反馈") || has("在线咨询") || has("AI角色备份"))
  ) {
    return {
      sceneId: "bot.settings.customer_service",
      title: "客服中心",
      visualTextAnchors: ["客服中心", "大家常问"],
    };
  }
  if (
    has("关于豆包 Debug") &&
    has("用户协议") &&
    has("隐私政策") &&
    has("关于豆包大模型")
  ) {
    return {
      sceneId: "bot.settings.about_debug",
      title: "关于豆包 Debug",
      visualTextAnchors: ["关于豆包 Debug", "用户协议", "隐私政策"],
    };
  }
  if (
    has("隐私政策简明版") &&
    has("豆包《隐私政策》简明版") &&
    (has("我们如何收集、使用信息") || has("更新时间"))
  ) {
    return {
      sceneId: "bot.settings.about_debug.privacy_summary",
      title: "隐私政策简明版",
      visualTextAnchors: [
        "隐私政策简明版",
        "豆包《隐私政策》简明版",
        "我们如何收集、使用信息",
      ],
    };
  }
  if (has("豆包侵权投诉指引") && (has("豆包侵权投诉指引FAQ") || has("导言"))) {
    return {
      sceneId: "bot.settings.about_debug.infringement_complaint",
      title: "豆包侵权投诉指引",
      visualTextAnchors: ["豆包侵权投诉指引", "导言"],
    };
  }
  if (
    has("豆包购物及钱包功能FAQ") &&
    (has("豆包购物及钱包相关功能的提供者") || has("豆包隐私政策"))
  ) {
    return {
      sceneId: "bot.settings.about_debug.shopping_wallet_faq",
      title: "豆包购物及钱包功能FAQ",
      visualTextAnchors: [
        "豆包购物及钱包功能FAQ",
        "豆包购物及钱包相关功能的提供者",
      ],
    };
  }
  if (
    has("权限清单") &&
    (has("NSFaceIDUsageDescription") ||
      has("NSCameraUsageDescription") ||
      has("NSPhotoLibraryUsageDescription"))
  ) {
    return {
      sceneId: "bot.settings.about_debug.app_permissions",
      title: "权限清单",
      visualTextAnchors: ["权限清单", "NSFaceIDUsageDescription"],
    };
  }
  if (
    has("个人信息收集清单") &&
    has("个人信息列表") &&
    has("个人资料") &&
    has("当前设备信息")
  ) {
    return {
      sceneId: "bot.settings.personal_information_collection_list",
      title: "个人信息收集清单",
      visualTextAnchors: [
        "个人信息收集清单",
        "个人信息列表",
        "个人资料",
        "当前设备信息",
      ],
    };
  }
  if (has("最近 7 天") && has("最近一月") && has("最近一年") && has("取消")) {
    return {
      sceneId: "bot.settings.personal_information_collection.time_range_menu",
      title: "时间范围选择菜单",
      visualTextAnchors: ["最近 7 天", "最近一月", "最近一年", "取消"],
    };
  }
  const personalInformationDetailScenes = [
    {
      sceneId: "bot.settings.personal_information_collection.personal_profile",
      title: "个人资料",
      anchors: ["个人资料", "手机号收集情况说明"],
    },
    {
      sceneId: "bot.settings.personal_information_collection.app_info",
      title: "应用信息",
      anchors: ["应用信息", "APP名称收集情况说明"],
    },
    {
      sceneId:
        "bot.settings.personal_information_collection.current_device_info",
      title: "当前设备信息",
      anchors: ["当前设备信息", "信息内容："],
    },
    {
      sceneId:
        "bot.settings.personal_information_collection.usage_process_info",
      title: "使用过程信息",
      anchors: ["使用过程信息", "位置信息收集情况说明"],
    },
    {
      sceneId: "bot.settings.personal_information_collection.account_profile",
      title: "账号资料",
      anchors: ["账号资料", "注册时间"],
    },
    {
      sceneId:
        "bot.settings.personal_information_collection.content_interaction",
      title: "内容及互动",
      anchors: ["内容及互动", "发布记录"],
    },
    {
      sceneId:
        "bot.settings.personal_information_collection.social_relationship",
      title: "社交及关系",
      anchors: ["社交及关系", "关注列表"],
    },
  ] as const;
  for (const detail of personalInformationDetailScenes) {
    if (detail.anchors.every(has)) {
      return {
        sceneId: detail.sceneId,
        title: detail.title,
        visualTextAnchors: detail.anchors,
      };
    }
  }
  if (
    has("第三方信息共享清单") &&
    (has("第三方SDK目录") || has("合作方隐私政策") || has("官网链接"))
  ) {
    return {
      sceneId: "bot.settings.third_party_information_sharing_list",
      title: "第三方信息共享清单",
      visualTextAnchors: ["第三方信息共享清单", "第三方SDK目录"],
    };
  }
  if (
    has("豆包小助手") &&
    has("为你解答豆包使用问题") &&
    has("请输入您想咨询的问题") &&
    has("意见反馈") &&
    has("反馈历史")
  ) {
    return {
      sceneId: "bot.settings.customer_service.online_consult",
      title: "豆包小助手在线咨询",
      visualTextAnchors: ["豆包小助手", "意见反馈", "反馈历史"],
    };
  }
  if (
    has("关闭更多操作") &&
    has("我的订单") &&
    has("关闭当前页面") &&
    (has("按预算挑") || has("商品对比"))
  ) {
    return {
      sceneId: "chat.buy_before_ask.more_menu",
      title: "买前问豆包更多操作菜单",
      visualTextAnchors: ["关闭更多操作", "我的订单", "关闭当前页面"],
    };
  }
  if (
    has("我的订单") &&
    has("打开更多操作") &&
    has("关闭当前页面") &&
    has("更多面板")
  ) {
    return {
      sceneId: "chat.buy_before_ask",
      title: "买前问豆包",
      visualTextAnchors: [
        "我的订单",
        "打开更多操作",
        "关闭当前页面",
        "更多面板",
      ],
    };
  }
  if (
    (has("AI 写歌") || has("AI写歌")) &&
    has("重新进入") &&
    has("关于") &&
    has("问题反馈")
  ) {
    return {
      sceneId: "chat.ai_song.more_menu",
      title: "AI 写歌更多菜单",
      visualTextAnchors: ["AI 写歌", "重新进入", "关于", "问题反馈"],
    };
  }
  if (has("AI 写歌") && has("开始写歌") && has("bar more") && has("bar exit")) {
    return {
      sceneId: "chat.ai_song",
      title: "AI 写歌",
      visualTextAnchors: ["AI 写歌", "开始写歌", "bar more", "bar exit"],
    };
  }
  if (
    has("【火山方舟】产品的推荐意愿度") &&
    has("您还有哪些意见或建议") &&
    has("提交")
  ) {
    return {
      sceneId: "volcengine.ark.feedback.survey",
      title: "火山方舟问卷反馈",
      visualTextAnchors: [
        "【火山方舟】产品的推荐意愿度",
        "您还有哪些意见或建议？",
        "提交",
      ],
    };
  }
  if (
    has("火山方舟 - 体验") &&
    has("欢迎来到") &&
    has("精选") &&
    has("语言") &&
    has("Doubao-Seedance-2.5")
  ) {
    return {
      sceneId: "volcengine.ark.console.experience",
      title: "火山方舟体验页",
      visualTextAnchors: [
        "火山方舟 - 体验",
        "欢迎来到",
        "精选",
        "语言",
        "Doubao-Seedance-2.5",
      ],
    };
  }
  if (
    has("火山方舟 - 首页") &&
    has("快速接入") &&
    has("接入模型") &&
    has("示例代码")
  ) {
    return {
      sceneId: "volcengine.ark.console.home",
      title: "火山方舟首页",
      visualTextAnchors: [
        "火山方舟 - 首页",
        "快速接入",
        "接入模型",
        "示例代码",
      ],
    };
  }
  if (
    (has("火山引擎-你的AI云") || has("火山引擎 你的AI云")) &&
    (has("立即构建") || has("一站式大模型服务平台") || has("为什么选火山"))
  ) {
    return {
      sceneId: "bot.settings.about_debug.model_about.volcengine_home",
      title: "火山引擎官网",
      visualTextAnchors: ["火山引擎-你的AI云", "立即构建"],
    };
  }
  if (
    has("快速入门 - 火山方舟 - 火山引擎") &&
    (has("快速入门（新手版）") ||
      has("数分钟内完成你的首次 API 调用") ||
      has("获取并配置 API Key"))
  ) {
    return {
      sceneId: "volcengine.ark.docs.quickstart",
      title: "火山方舟快速入门文档",
      visualTextAnchors: [
        "快速入门 - 火山方舟 - 火山引擎",
        "快速入门（新手版）",
      ],
    };
  }
  if (
    has("ARK_API_KEY") &&
    has("volcenginesdkarkruntime") &&
    (has("base_url") || has("支持输入图片的模型系列是哪个"))
  ) {
    return {
      sceneId: "volcengine.ark.docs.api_examples",
      title: "火山方舟 API 示例文档",
      visualTextAnchors: ["ARK_API_KEY", "volcenginesdkarkruntime"],
    };
  }
  if (has("豆包大模型-火山引擎") && has("返回")) {
    return {
      sceneId: "bot.settings.about_debug.model_about",
      title: "豆包大模型",
      visualTextAnchors: ["豆包大模型-火山引擎", "返回"],
    };
  }
  if (
    has("豆包大模型") &&
    (has("火山引擎") || has("更强模型") || has("更低价格"))
  ) {
    return {
      sceneId: "bot.settings.about_debug.model_about",
      title: "豆包大模型",
      visualTextAnchors: ["豆包大模型", "火山引擎"],
    };
  }
  if (
    has("隐私与权限") &&
    has("数据权限") &&
    has("系统权限") &&
    has("黑名单")
  ) {
    return {
      sceneId: "bot.settings.privacy.permissions",
      title: "隐私与权限",
      visualTextAnchors: ["隐私与权限", "数据权限", "系统权限"],
    };
  }
  for (const permission of ["麦克风权限", "相机权限", "剪切板权限"] as const) {
    if (has(permission) && has("取消") && has("去设置")) {
      return {
        sceneId: `bot.settings.privacy.permissions.${permission === "麦克风权限" ? "microphone" : permission === "相机权限" ? "camera" : "clipboard"}.permission.dialog`,
        title: `${permission}弹窗`,
        visualTextAnchors: [permission, "取消", "去设置"],
      };
    }
  }
  if (has("声音") && has("取消") && has("使用") && has("后台声音朗读")) {
    return {
      sceneId: "bot.settings.sound",
      title: "声音设置",
      visualTextAnchors: ["声音", "取消", "使用", "后台声音朗读"],
    };
  }
  const aiCreationTabs = ["发现", "视频", "带货模板", "P 图", "萌宠"].filter(
    has,
  );
  if (has("参考图") && has("模型 4.5") && has("比例 自动") && has("玩法")) {
    return {
      sceneId: "chat.image_generation.panel",
      title: "图片生成面板",
      visualTextAnchors: ["参考图", "模型 4.5", "比例 自动", "玩法"],
    };
  }
  if (
    aiCreationTabs.length >= 3 &&
    (has("图片生成") || has("照片动起来") || has("豆包 P 图"))
  ) {
    return {
      sceneId: "chat.ai_creation.discovery",
      title: "AI 创作发现页",
      visualTextAnchors: aiCreationTabs.slice(0, 3),
    };
  }
  if (
    has("快速") &&
    has("专家") &&
    has("工作任务 Turbo") &&
    has("工作任务 Pro")
  ) {
    return {
      sceneId: "bot.settings.default_mode_menu",
      title: "新对话默认模式菜单",
      visualTextAnchors: ["快速", "专家", "工作任务 Turbo", "工作任务 Pro"],
    };
  }
  if (has("取消") && has("逆时针旋转") && has("完成")) {
    return {
      sceneId: "camera.photo_crop",
      title: "相机照片裁剪页",
      visualTextAnchors: ["取消", "逆时针旋转", "完成"],
    };
  }
  if (has("返回") && has("选择") && has("下一步")) {
    return {
      sceneId: "photo.preview",
      title: "单张照片预览",
      visualTextAnchors: ["返回", "选择", "下一步"],
    };
  }
  if (has("所有照片") && has("截屏") && has("最近存储")) {
    return {
      sceneId: "photo.album.selector",
      title: "相册选择菜单",
      visualTextAnchors: ["所有照片", "截屏", "最近存储"],
    };
  }
  if (has("选择文件") && has("打开云盘") && has("上传本地文件")) {
    return {
      sceneId: "file.picker",
      title: "选择文件",
      visualTextAnchors: ["选择文件", "打开云盘", "上传本地文件"],
    };
  }
  if (has("云盘文件") && has("搜索") && has("未搜索到相关结果")) {
    return {
      sceneId: "cloud.drive.files.empty",
      title: "云盘文件页",
      visualTextAnchors: ["云盘文件", "搜索", "未搜索到相关结果"],
    };
  }
  if (has("关闭面板") && has("相册") && has("文件")) {
    return {
      sceneId: "chat.media_panel",
      title: "会话快捷媒体面板",
      visualTextAnchors: ["关闭面板", "相册", "文件"],
    };
  }
  if (
    has("帮我写作") &&
    has("关闭") &&
    (has("输入你想写的主题") ||
      has("更多建议") ||
      (has("文本输入") && has("按住说话")))
  ) {
    return {
      sceneId: "chat.write_assistant.panel",
      title: "帮我写作面板",
      visualTextAnchors: ["帮我写作", "关闭"],
    };
  }
  if (
    has("PPT 生成") &&
    has("篇幅") &&
    has("关闭") &&
    (has("输入主题及要求") || has("按住说话"))
  ) {
    return {
      sceneId: "chat.ppt.generate.panel",
      title: "PPT 生成面板",
      visualTextAnchors: ["PPT 生成", "篇幅", "关闭"],
    };
  }
  if (
    has("通知设置") &&
    has("返回") &&
    !has("豆包账号管理") &&
    !has("豆包形象")
  ) {
    return {
      sceneId: "bot.settings.notification_settings",
      title: "通知设置",
      visualTextAnchors: ["通知设置", "返回"],
    };
  }
  if (
    has("所有照片") &&
    has("关闭") &&
    (has("未选中照片") || has("照片2026") || has("album_ic_selection"))
  ) {
    return {
      sceneId: "photo.picker",
      title: "系统照片选择器",
      visualTextAnchors: ["所有照片", "关闭"],
    };
  }
  if (
    has("取消") &&
    has("全部") &&
    has("消息") &&
    has("云盘") &&
    has("最近对话")
  ) {
    return {
      sceneId: "chat.sidebar.search",
      title: "侧边栏搜索页",
      visualTextAnchors: ["取消", "全部", "消息", "云盘", "最近对话"],
    };
  }
  if (has("搜索") && has("技能") && has("云盘")) {
    return {
      sceneId: "chat.sidebar",
      title: "会话侧边栏",
      visualTextAnchors: ["搜索", "技能", "云盘"],
    };
  }
  if (has("最近") && has("我的") && has("这里还没有任何文件")) {
    return {
      sceneId: "cloud.drive.recent.empty",
      title: "云盘空状态",
      visualTextAnchors: ["最近", "我的", "这里还没有任何文件"],
    };
  }
  if (has("完整内容暂不支持展示") && (has("添加") || has("在对话中试用"))) {
    return {
      sceneId: "skills.detail",
      title: "技能详情页",
      visualTextAnchors: [
        "完整内容暂不支持展示",
        has("在对话中试用") ? "在对话中试用" : "添加",
      ],
    };
  }
  if (
    has("技能") &&
    (visibleSkillTitleCount >= 3 ||
      (has("个股研究") && has("估值建模") && has("市场热点分析")))
  ) {
    return {
      sceneId: "skills.home",
      title: "技能页面",
      visualTextAnchors: [
        "技能",
        ...candidates
          .filter(
            (candidate) =>
              candidate.source === "ui_dump" &&
              candidate.bounds.x >= 70 &&
              candidate.bounds.x <= 130 &&
              candidate.bounds.height >= 22 &&
              candidate.bounds.height <= 32,
          )
          .map(primaryDiscoveryCandidateText)
          .filter(Boolean)
          .slice(0, 2),
      ],
    };
  }
  if (has("是否删除已选消息") && has("删除后消息内容无法恢复")) {
    return {
      sceneId: "chat.message_delete_confirmation",
      title: "消息删除确认弹窗",
      visualTextAnchors: ["是否删除已选消息", "删除后，消息内容无法恢复"],
    };
  }
  if (has("选择对话") && has("删除")) {
    return {
      sceneId: "chat.message_selection",
      title: "消息选择删除页",
      visualTextAnchors: ["选择对话", "删除"],
    };
  }
  if (has("反馈与举报") && has("导出为文档") && has("删除")) {
    return {
      sceneId: "chat.message_more_menu",
      title: "消息更多操作菜单",
      visualTextAnchors: ["反馈与举报", "导出为文档", "删除"],
    };
  }
  if (has("复制") && has("朗读") && has("追问") && has("更多")) {
    return {
      sceneId: "chat.message_action_menu",
      title: "消息操作菜单",
      visualTextAnchors: ["复制", "朗读", "追问", "更多"],
    };
  }
  if (has("豆包 P 图") && has("博物馆讲解") && has("豆包爱学")) {
    return {
      sceneId: "chat.detail.actionbar_end",
      title: "会话页 ActionBar 末尾态",
      visualTextAnchors: ["豆包 P 图", "博物馆讲解", "豆包爱学"],
    };
  }
  if (has("照片动起来") && has("AI写歌") && has("PPT 生成")) {
    return {
      sceneId: "chat.detail.actionbar_middle",
      title: "会话页 ActionBar 中间态",
      visualTextAnchors: ["照片动起来", "AI写歌", "PPT 生成"],
    };
  }
  return null;
}

export function deterministicTargetedDiscoveryCompletion(options: {
  goal: string;
  observation: TargetedDiscoveryObservation;
  actions?: readonly TargetedDiscoveryAction[];
}): {
  oracle: {
    type: "text_visible";
    value: string;
  };
  evidence: string[];
} | null {
  const scene = classifyTargetedDiscoveryScene(options.observation.candidates);
  if (
    scene?.sceneId === "skills.home" &&
    /技能|skill/i.test(options.goal) &&
    /进入|打开|前往|页面|页/.test(options.goal)
  ) {
    return {
      oracle: {
        type: "text_visible",
        value: "技能 && 个股研究 && 估值建模",
      },
      evidence: [
        "技能页面标题可见。",
        "稳定技能条目“个股研究”和“估值建模”可见。",
      ],
    };
  }
  if (
    scene?.sceneId === "cloud.drive.recent.empty" &&
    /云盘|cloud\s*drive/i.test(options.goal)
  ) {
    return {
      oracle: {
        type: "text_visible",
        value: "最近 && 我的 && 这里还没有任何文件",
      },
      evidence: ["云盘分栏和空状态文案可见。"],
    };
  }
  const normalizedGoal = normalizeComparableText(options.goal);
  const visibleText = normalizeComparableText(
    options.observation.candidates.map(discoveryCandidateText).join("\n"),
  );
  const selectedMaximumFont = (options.actions ?? []).some(
    (action) =>
      action.exitCode === 0 &&
      (normalizeComparableText(action.targetText) === "大" ||
        action.candidateId === "font_adjust_max" ||
        normalizeComparableText(action.expectedOutcome).includes(
          "字号调整到最大",
        )),
  );
  const confirmedFontSelection = (options.actions ?? []).some(
    (action) =>
      action.exitCode === 0 &&
      normalizeComparableText(action.targetText) === "确认",
  );
  if (
    /字号|字体/.test(normalizedGoal) &&
    /最大/.test(normalizedGoal) &&
    selectedMaximumFont &&
    confirmedFontSelection &&
    visibleText.includes("重启生效") &&
    visibleText.includes("新的字体大小在重启后生效")
  ) {
    return null;
  }
  return null;
}

function buildVerifierSpecFromCompletionOracle(options: {
  oracle: {
    type: "text_visible";
    value: string;
  };
  bundleId: string;
  reason: string;
  successfulExecutions?: number;
}): ExperimentVerifierSpec {
  const values = stableVisualTextAnchors(
    options.oracle.value.split(/\s*&&\s*|\s+且\s+/),
  );
  return {
    schemaVersion: "ios-ui-agent-verifier/v1",
    status: "candidate",
    source: "deterministic_fallback",
    assertions: [
      {
        assertionId: "completion-text-visible",
        type: "all_text_visible",
        values,
      },
      {
        assertionId: "completion-foreground",
        type: "foreground_bundle",
        bundleId: options.bundleId,
      },
    ],
    reason: options.reason,
    confidence: 0.9,
    successfulExecutions: options.successfulExecutions ?? 0,
    evidencePaths: [],
    updatedAt: new Date().toISOString(),
  };
}

export function deriveHorizontalGestureCandidates(
  candidates: TargetedDiscoveryObservation["candidates"],
): TargetedDiscoveryObservation["candidates"] {
  const eligible = candidates
    .filter(
      (candidate) =>
        candidate.candidateId.startsWith("ui-") &&
        candidate.bounds.width > 0 &&
        candidate.bounds.height > 0 &&
        candidate.bounds.width <= 180 &&
        candidate.bounds.height <= 100 &&
        primaryDiscoveryCandidateText(candidate).length > 0,
    )
    .sort(
      (left, right) =>
        left.bounds.y +
        left.bounds.height / 2 -
        (right.bounds.y + right.bounds.height / 2),
    );
  const bands: Array<
    Array<TargetedDiscoveryObservation["candidates"][number]>
  > = [];
  for (const candidate of eligible) {
    const centerY = candidate.bounds.y + candidate.bounds.height / 2;
    const band = bands.find((items) => {
      const averageY =
        items.reduce(
          (sum, item) => sum + item.bounds.y + item.bounds.height / 2,
          0,
        ) / items.length;
      return Math.abs(averageY - centerY) <= 24;
    });
    if (band) {
      band.push(candidate);
    } else {
      bands.push([candidate]);
    }
  }
  const regions: Array<TargetedDiscoveryObservation["candidates"][number]> = [];
  for (const [index, items] of bands.entries()) {
    const unique = [
      ...new Map(
        items.map((item) => [
          normalizeComparableText(discoveryCandidateText(item)),
          item,
        ]),
      ).values(),
    ];
    if (unique.length < 3) {
      continue;
    }
    const left = Math.min(...unique.map((item) => item.bounds.x));
    const right = Math.max(
      ...unique.map((item) => item.bounds.x + item.bounds.width),
    );
    const top = Math.min(...unique.map((item) => item.bounds.y));
    const bottom = Math.max(
      ...unique.map((item) => item.bounds.y + item.bounds.height),
    );
    if (right - left < 145 || bottom - top > 110) {
      continue;
    }
    const labels = unique
      .map(primaryDiscoveryCandidateText)
      .filter(Boolean)
      .slice(0, 8);
    regions.push({
      candidateId: `gesture-horizontal-${index + 1}`,
      source: "ui_dump" as const,
      role: "HorizontalScrollRegion",
      label: `横向可滑动区域：${labels.join(" | ")}`,
      value: labels.join("|"),
      bounds: {
        x: left,
        y: Math.max(0, top - 10),
        width: right - left,
        height: bottom - top + 20,
      },
    });
  }
  return regions;
}

function observationSceneId(observation: TargetedDiscoveryObservation): string {
  return observation.matchedSceneId ?? observation.candidateSceneId;
}

export async function synthesizeAndPersistTargetedDiscoveryGraph(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  outputDir: string;
  goal: string;
  observations: readonly TargetedDiscoveryObservation[];
  actions: readonly TargetedDiscoveryAction[];
  completionOracle: {
    type: "text_absent" | "text_visible" | "scene_changed" | "region_stable";
    value: string;
  };
  completionEvidence: readonly string[];
  evidencePath: string;
  deviceProfileId: string;
  agentCwd: string;
  model?: string;
  timeoutMs?: number;
  verifier?: ExperimentVerifierSpec;
  initialEntityStatus?: GraphEntityStatus;
}): Promise<{
  graphPatchPath: string;
  candidateTaskId: string;
  proposalPath: string;
  validationPath: string;
  mode: "agent" | "deterministic_fallback";
}> {
  const proposalPath = join(options.outputDir, "graph-synthesis-proposal.json");
  const validationPath = join(
    options.outputDir,
    "graph-synthesis-validation.json",
  );
  const prompt = [
    "Synthesize stable semantic Graph names from completed iOS targeted discovery evidence.",
    "Return only schema-backed JSON.",
    "Do not change action order, risk, action type, coordinates, or completion evidence.",
    "Map every goal action stepId exactly once.",
    "Map every before/after Observation used by goal actions to a stable Scene.",
    "Reuse an existing Scene, Element, or Operator ID when the evidence and action semantics truly represent that same entity.",
    "When reusing an existing Element or Operator, copy its existing ID exactly; do not create a duplicate.",
    "Do not use account-specific, personalized, timestamp, or session-varying text as a Scene visual anchor.",
    "Use concise lower-case dot-separated IDs; never use generic IDs like discovery.1, item, screen, or page.",
    "Overlay/menu/selection/confirmation variants should receive distinct Scene IDs.",
    "Task ID should describe the business effect, not the exploration mechanism.",
    "",
    `Goal: ${options.goal}`,
    `Existing Graph IDs: ${JSON.stringify({
      scenes: options.graph.scenes.map((scene) => scene.sceneId),
      elements: options.graph.elements.map((element) => element.elementId),
      operators: options.graph.operators.map((operator) => operator.operatorId),
      tasks: options.graph.tasks.map((task) => task.taskId),
    })}`,
    `Observations: ${JSON.stringify(options.observations)}`,
    `Actions: ${JSON.stringify(options.actions)}`,
    `Completion Oracle: ${JSON.stringify(options.completionOracle)}`,
  ].join("\n");
  let proposal: AgentGraphSynthesisProposal | undefined;
  let agentError: string | undefined;
  try {
    proposal = await runAgentWithTimeout<AgentGraphSynthesisProposal>(
      prompt,
      {
        cwd: options.agentCwd,
        model: options.model,
        sandbox: "read-only",
        schema: graphSynthesisProposalSchema,
        env: { CODEX_HOME: undefined },
      },
      options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      "Graph synthesis",
    );
    await writeJsonAtomic(proposalPath, proposal);
  } catch (error) {
    agentError = error instanceof Error ? error.message : String(error);
  }
  const validation = proposal
    ? validateGraphSynthesisProposal({
        graph: options.graph,
        observations: options.observations,
        actions: options.actions,
        proposal,
      })
    : {
        valid: false,
        issues: [
          agentError ?? "Graph synthesis Agent did not return a proposal.",
        ],
      };
  await writeJsonAtomic(validationPath, {
    schemaVersion: "ios-ui-graph-synthesis-validation/v1",
    valid: validation.valid,
    issues: validation.issues,
    agentError,
    proposalPath: proposal ? proposalPath : null,
  });
  if (!proposal) {
    await writeJsonAtomic(proposalPath, {
      schemaVersion: "ios-ui-graph-synthesis-proposal-unavailable/v1",
      error: agentError,
    });
  }
  const mode = validation.valid ? "agent" : "deterministic_fallback";
  const patch = await persistTargetedDiscoveryGraphPatch({
    graph: options.graph,
    graphPath: options.graphPath,
    outputDir: options.outputDir,
    goal: options.goal,
    observations: options.observations,
    actions: options.actions,
    completionOracle: options.completionOracle,
    completionEvidence: options.completionEvidence,
    evidencePath: options.evidencePath,
    deviceProfileId: options.deviceProfileId,
    synthesisProposal: validation.valid ? proposal : undefined,
    verifier: options.verifier,
    initialEntityStatus: options.initialEntityStatus,
  });
  return {
    ...patch,
    proposalPath,
    validationPath,
    mode,
  };
}

export function validateGraphSynthesisProposal(options: {
  graph: ExecutableUiGraphExperiment;
  observations: readonly TargetedDiscoveryObservation[];
  actions: readonly TargetedDiscoveryAction[];
  proposal: AgentGraphSynthesisProposal;
}): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const goalActions = options.actions.filter(
    (action) => action.purpose === "advance_goal",
  );
  const requiredObservationIds = new Set(
    goalActions.flatMap((action) => [
      action.beforeObservationId,
      action.afterObservationId,
    ]),
  );
  const sceneByObservation = new Map(
    options.proposal.scenes.map((scene) => [scene.observationId, scene]),
  );
  const actionByStep = new Map(
    options.proposal.actions.map((action) => [action.stepId, action]),
  );
  const synthesizedElementIds = options.proposal.actions.map(
    (action) => action.elementId,
  );
  const synthesizedOperatorIds = options.proposal.actions.map(
    (action) => action.operatorId,
  );
  const existingElementIds = new Set(
    options.graph.elements.map((element) => element.elementId),
  );
  const existingOperatorIds = new Set(
    options.graph.operators.map((operator) => operator.operatorId),
  );
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(options.proposal.taskId)) {
    issues.push(
      `Task ID is not stable dot-separated ASCII: ${options.proposal.taskId}.`,
    );
  }
  if (/^discovery\.\d+$/.test(options.proposal.taskId)) {
    issues.push(`Task ID is generic: ${options.proposal.taskId}.`);
  }
  if (
    new Set(options.proposal.scenes.map((scene) => scene.observationId))
      .size !== options.proposal.scenes.length
  ) {
    issues.push("Scene proposal contains duplicate observation IDs.");
  }
  if (
    new Set(options.proposal.actions.map((action) => action.stepId)).size !==
    options.proposal.actions.length
  ) {
    issues.push("Action proposal contains duplicate step IDs.");
  }
  if (new Set(synthesizedElementIds).size !== synthesizedElementIds.length) {
    issues.push("Action proposal contains duplicate Element IDs.");
  }
  if (new Set(synthesizedOperatorIds).size !== synthesizedOperatorIds.length) {
    issues.push("Action proposal contains duplicate Operator IDs.");
  }
  for (const observationId of requiredObservationIds) {
    if (!sceneByObservation.has(observationId)) {
      const observation = options.observations.find(
        (candidate) => candidate.observationId === observationId,
      );
      const deterministic = observation
        ? classifyTargetedDiscoveryScene(observation.candidates)
        : null;
      const representedByExistingProposal =
        deterministic !== null &&
        options.proposal.scenes.some(
          (scene) =>
            semanticGraphIdCompatible(deterministic.sceneId, scene.sceneId) ||
            deterministic.visualTextAnchors.every((expectedAnchor) =>
              scene.visualTextAnchors.some((proposedAnchor) =>
                normalizeComparableText(proposedAnchor).includes(
                  normalizeComparableText(expectedAnchor),
                ),
              ),
            ),
        );
      if (!representedByExistingProposal) {
        issues.push(`Missing Scene mapping for ${observationId}.`);
      }
    }
  }
  for (const action of goalActions) {
    const proposed = actionByStep.get(action.stepId);
    if (!proposed) {
      issues.push(`Missing action mapping for ${action.stepId}.`);
      continue;
    }
    const from = sceneByObservation.get(action.beforeObservationId);
    const to = sceneByObservation.get(action.afterObservationId);
    if (from && proposed.fromSceneId !== from.sceneId) {
      issues.push(
        `Action ${action.stepId} fromSceneId does not match its Observation mapping.`,
      );
    }
    if (to && proposed.toSceneId !== to.sceneId) {
      issues.push(
        `Action ${action.stepId} toSceneId does not match its Observation mapping.`,
      );
    }
    for (const id of [proposed.elementId, proposed.operatorId]) {
      if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(id)) {
        issues.push(`Unstable synthesized ID for ${action.stepId}: ${id}.`);
      }
    }
    if (
      existingElementIds.has(proposed.elementId) &&
      !proposalReusesExistingElement(options.graph, action, proposed)
    ) {
      issues.push(
        `Synthesized Element ID collides with the existing Graph: ${proposed.elementId}.`,
      );
    }
    if (
      existingOperatorIds.has(proposed.operatorId) &&
      !proposalReusesExistingOperator(options.graph, proposed)
    ) {
      issues.push(
        `Synthesized Operator ID collides with the existing Graph: ${proposed.operatorId}.`,
      );
    }
  }
  const observationById = new Map(
    options.observations.map((observation) => [
      observation.observationId,
      observation,
    ]),
  );
  for (const scene of options.proposal.scenes) {
    const observation = observationById.get(scene.observationId);
    if (!observation) {
      issues.push(
        `Scene proposal references unknown Observation ${scene.observationId}.`,
      );
      continue;
    }
    const deterministic = classifyTargetedDiscoveryScene(
      observation.candidates,
    );
    const deterministicAnchorsCovered =
      deterministic?.visualTextAnchors.every((expectedAnchor) =>
        scene.visualTextAnchors.some((proposedAnchor) =>
          normalizeComparableText(proposedAnchor).includes(
            normalizeComparableText(expectedAnchor),
          ),
        ),
      ) ?? false;
    if (
      deterministic &&
      !semanticGraphIdCompatible(deterministic.sceneId, scene.sceneId) &&
      !deterministicAnchorsCovered
    ) {
      issues.push(
        `Scene ${scene.observationId} conflicts with deterministic classification ${deterministic.sceneId}.`,
      );
    }
    if (
      scene.visualTextAnchors.length > 0 &&
      !scene.visualTextAnchors.every((anchor) =>
        observation.candidates.some((candidate) =>
          normalizeComparableText(discoveryCandidateText(candidate)).includes(
            normalizeComparableText(anchor),
          ),
        ),
      )
    ) {
      issues.push(
        `Scene ${scene.sceneId} contains unsupported visual anchors.`,
      );
    }
  }
  return { valid: issues.length === 0, issues };
}

function proposalReusesExistingElement(
  graph: ExecutableUiGraphExperiment,
  action: TargetedDiscoveryAction,
  proposed: AgentGraphSynthesisProposal["actions"][number],
): boolean {
  const element = graph.elements.find(
    (candidate) => candidate.elementId === proposed.elementId,
  );
  if (!element || element.sceneId !== proposed.fromSceneId) {
    return false;
  }
  const observedText = normalizeComparableText(action.targetText);
  const semanticTexts = [
    element.title,
    element.selector.accessibilityId,
    element.selector.label,
    element.selector.text,
    element.selector.value,
  ]
    .map((value) => normalizeComparableText(value ?? ""))
    .filter(Boolean);
  return semanticTexts.some(
    (value) => value.includes(observedText) || observedText.includes(value),
  );
}

function proposalReusesExistingOperator(
  graph: ExecutableUiGraphExperiment,
  proposed: AgentGraphSynthesisProposal["actions"][number],
): boolean {
  const operator = graph.operators.find(
    (candidate) => candidate.operatorId === proposed.operatorId,
  );
  return Boolean(
    operator &&
    operator.fromSceneId === proposed.fromSceneId &&
    operator.toSceneId === proposed.toSceneId &&
    (operator.operation.type === "tap" ||
      operator.operation.type === "long_press") &&
    operator.operation.elementId === proposed.elementId,
  );
}

function semanticGraphIdCompatible(
  deterministicId: string,
  proposedId: string,
): boolean {
  const tokens = (value: string): string[] =>
    value
      .toLocaleLowerCase()
      .split(/[._-]+/)
      .filter(Boolean);
  const deterministicTokens = tokens(deterministicId);
  const proposedTokens = new Set(tokens(proposedId));
  return deterministicTokens.every((token) => proposedTokens.has(token));
}

export async function persistTargetedDiscoveryGraphPatch(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  outputDir: string;
  goal: string;
  observations: readonly TargetedDiscoveryObservation[];
  actions: readonly TargetedDiscoveryAction[];
  completionOracle: {
    type: "text_absent" | "text_visible" | "scene_changed" | "region_stable";
    value: string;
  };
  completionEvidence: readonly string[];
  evidencePath: string;
  deviceProfileId: string;
  synthesisProposal?: AgentGraphSynthesisProposal;
  verifier?: ExperimentVerifierSpec;
  initialEntityStatus?: GraphEntityStatus;
}): Promise<{ graphPatchPath: string; candidateTaskId: string }> {
  const initialEntityStatus = options.initialEntityStatus ?? "verified";
  const normalizedObservations = options.observations.map((observation) => {
    const classified = classifyTargetedDiscoveryScene(observation.candidates);
    return classified
      ? {
          ...observation,
          matchedSceneId: null,
          candidateSceneId: classified.sceneId,
          candidateSceneTitle: classified.title,
          visualTextAnchors: classified.visualTextAnchors,
        }
      : observation;
  });
  const sceneByObservation = new Map(
    normalizedObservations.map((observation) => [
      observation.observationId,
      observation,
    ]),
  );
  const synthesizedSceneByObservation = new Map(
    options.synthesisProposal?.scenes.map((scene) => [
      scene.observationId,
      scene,
    ]) ?? [],
  );
  const synthesizedActionByStep = new Map(
    options.synthesisProposal?.actions.map((action) => [
      action.stepId,
      action,
    ]) ?? [],
  );
  const newScenes = [...options.graph.scenes];
  const newElements = [...options.graph.elements];
  const newOperators = [...options.graph.operators];
  const operatorIds: string[] = [];
  const goalActions = options.actions.filter(
    (action) => action.purpose === "advance_goal",
  );
  const semanticPrefix = targetedDiscoverySemanticPrefix(options.goal);
  for (const [index, action] of goalActions.entries()) {
    const before = sceneByObservation.get(action.beforeObservationId)!;
    const after = sceneByObservation.get(action.afterObservationId)!;
    const synthesizedBefore = synthesizedSceneByObservation.get(
      action.beforeObservationId,
    );
    const synthesizedAfter = synthesizedSceneByObservation.get(
      action.afterObservationId,
    );
    for (const observation of [before, after]) {
      const synthesizedScene = synthesizedSceneByObservation.get(
        observation.observationId,
      );
      const sceneId =
        synthesizedScene?.sceneId ?? observationSceneId(observation);
      if (!newScenes.some((scene) => scene.sceneId === sceneId)) {
        newScenes.push({
          sceneId,
          title: synthesizedScene?.title ?? observation.candidateSceneTitle,
          aliases: synthesizedScene?.aliases ?? [],
          status: initialEntityStatus,
          anchorElementIds: [],
          visualTextAnchors: stableVisualTextAnchors(
            synthesizedScene?.visualTextAnchors ??
              observation.visualTextAnchors.slice(0, 3),
          ),
          referenceAssets: [
            {
              screenshotPath: observation.screenshotPath,
              uiDumpPath: observation.uiDumpPath,
              recordPath: observation.ocrPath,
            },
          ],
        });
      }
    }
    const beforeCandidate = before.candidates.find(
      (candidate) => candidate.candidateId === action.candidateId,
    )!;
    const semanticRole = safeSegment(
      action.targetSemanticRole,
    ).toLocaleLowerCase();
    const synthesizedAction = synthesizedActionByStep.get(action.stepId);
    const reusableAction =
      synthesizedAction ??
      findReusableObservedNavigation({
        graph: options.graph,
        action,
        fromSceneId: observationSceneId(before),
        toSceneId: observationSceneId(after),
      });
    const deterministicActionIds = deterministicTargetedDiscoveryActionIds({
      goal: options.goal,
      action,
    });
    const elementId =
      deterministicActionIds?.elementId ??
      reusableAction?.elementId ??
      `${semanticPrefix}.${index + 1}.${action.actionType}.${semanticRole || "element"}`;
    const profile = options.graph.deviceProfiles.find(
      (candidate) => candidate.profileId === options.deviceProfileId,
    )!;
    const point = centerOfBounds(beforeCandidate.bounds);
    if (!newElements.some((element) => element.elementId === elementId)) {
      newElements.push({
        elementId,
        sceneId: synthesizedBefore?.sceneId ?? observationSceneId(before),
        title:
          synthesizedAction?.elementTitle ??
          deterministicActionIds?.elementTitle ??
          action.targetElementTitle,
        semanticRole:
          synthesizedAction?.semanticRole ?? action.targetSemanticRole,
        selector: {
          accessibilityId: beforeCandidate.accessibilityId,
          label: beforeCandidate.label,
          text: beforeCandidate.text,
          value: beforeCandidate.value,
          role: beforeCandidate.role,
        },
        bindings: [
          {
            bindingId: `${elementId}.${options.deviceProfileId}`,
            deviceProfileId: options.deviceProfileId,
            normalizedPoint: {
              x: point.x / profile.viewportWidth,
              y: point.y / profile.viewportHeight,
            },
            source: beforeCandidate.source === "ui_dump" ? "ui_dump" : "manual",
            status: initialEntityStatus,
            reliability: 0.8,
            observedAt: new Date().toISOString(),
          },
        ],
      });
    } else {
      const elementIndex = newElements.findIndex(
        (element) => element.elementId === elementId,
      );
      const existingElement = newElements[elementIndex]!;
      newElements[elementIndex] = {
        ...existingElement,
        selector: {
          accessibilityId: beforeCandidate.accessibilityId,
          label: beforeCandidate.label,
          text: beforeCandidate.text,
          value: beforeCandidate.value,
          role: beforeCandidate.role,
        },
        bindings: [
          ...existingElement.bindings.filter(
            (binding) => binding.deviceProfileId !== options.deviceProfileId,
          ),
          {
            bindingId:
              existingElement.bindings.find(
                (binding) =>
                  binding.deviceProfileId === options.deviceProfileId,
              )?.bindingId ?? `${elementId}.${options.deviceProfileId}`,
            deviceProfileId: options.deviceProfileId,
            normalizedPoint: {
              x: point.x / profile.viewportWidth,
              y: point.y / profile.viewportHeight,
            },
            source: beforeCandidate.source === "ui_dump" ? "ui_dump" : "manual",
            status:
              existingElement.bindings.find(
                (binding) =>
                  binding.deviceProfileId === options.deviceProfileId,
              )?.status ?? initialEntityStatus,
            reliability: 0.8,
            observedAt: new Date().toISOString(),
          },
        ],
      };
    }
    const operatorId =
      deterministicActionIds?.operatorId ??
      reusableAction?.operatorId ??
      `${semanticPrefix}.${index + 1}.${action.actionType}.${semanticRole || "element"}`;
    operatorIds.push(operatorId);
    if (!newOperators.some((operator) => operator.operatorId === operatorId)) {
      newOperators.push({
        operatorId,
        title:
          synthesizedAction?.operatorTitle ??
          deterministicActionIds?.operatorTitle ??
          action.operatorTitle,
        fromSceneId:
          reusableAction?.fromSceneId ??
          synthesizedBefore?.sceneId ??
          observationSceneId(before),
        toSceneId:
          reusableAction?.toSceneId ??
          synthesizedAfter?.sceneId ??
          observationSceneId(after),
        operation:
          action.actionType === "long_press"
            ? { type: "long_press", elementId, durationMs: 1200 }
            : action.actionType === "swipe_left" ||
                action.actionType === "swipe_right"
              ? parseDiscoverySwipeOperation(action.command)
              : { type: "tap", elementId },
        settleMs: 900,
        risk: action.risk,
        status: initialEntityStatus,
        reliability: 0.8,
        effects: [synthesizedAction?.effect ?? action.expectedOutcome],
        postconditions: [
          `scene.current=${
            synthesizedAction?.toSceneId ??
            synthesizedAfter?.sceneId ??
            observationSceneId(after)
          }`,
        ],
        execution: {
          tier: "guarded",
          successfulExecutions: 1,
          failedExecutions: 0,
          evidencePaths: [
            before.uiDumpPath,
            after.uiDumpPath,
            options.evidencePath,
          ],
          lastValidatedAt: new Date().toISOString(),
        },
      });
    } else {
      const operatorIndex = newOperators.findIndex(
        (operator) => operator.operatorId === operatorId,
      );
      const existingOperator = newOperators[operatorIndex]!;
      const evidenceIsNew = !(
        existingOperator.execution?.evidencePaths ?? []
      ).includes(options.evidencePath);
      const successfulExecutions =
        (existingOperator.execution?.successfulExecutions ?? 0) +
        (evidenceIsNew ? 1 : 0);
      newOperators[operatorIndex] = {
        ...existingOperator,
        status:
          existingOperator.status === "verified"
            ? "verified"
            : initialEntityStatus,
        reliability: Math.max(existingOperator.reliability, 0.8),
        execution: {
          tier: successfulExecutions >= 2 ? "fast" : "guarded",
          successfulExecutions,
          failedExecutions: existingOperator.execution?.failedExecutions ?? 0,
          consecutiveSuccessfulExecutions:
            (existingOperator.execution?.consecutiveSuccessfulExecutions ?? 0) +
            (evidenceIsNew ? 1 : 0),
          consecutiveFailedExecutions:
            existingOperator.execution?.consecutiveFailedExecutions ?? 0,
          evidencePaths: [
            ...new Set([
              ...(existingOperator.execution?.evidencePaths ?? []),
              before.uiDumpPath,
              after.uiDumpPath,
              options.evidencePath,
            ]),
          ],
          lastValidatedAt: new Date().toISOString(),
          lastFailedAt: existingOperator.execution?.lastFailedAt,
          lastValidatedAppVersion:
            existingOperator.execution?.lastValidatedAppVersion,
          lastFailure: existingOperator.execution?.lastFailure,
        },
      };
    }
  }
  const candidateTaskId =
    options.synthesisProposal?.taskId ?? targetedDiscoveryTaskId(options.goal);
  const existingTask = options.graph.tasks.find(
    (item) => item.taskId === candidateTaskId,
  );
  const existingEvidencePaths = existingTask?.validation?.evidencePaths ?? [];
  const evidenceIsNew = !existingEvidencePaths.includes(options.evidencePath);
  const successfulExecutions = Math.max(
    1,
    (existingTask?.validation?.successfulExecutions ?? 0) +
      (evidenceIsNew ? 1 : 0),
  );
  const requiresFixtureReplay =
    existingTask?.validation?.requiresFixtureReplay === true ||
    goalActions.some((action) => action.risk === "destructive");
  const taskStatus: GraphEntityStatus =
    successfulExecutions >= 2 && !requiresFixtureReplay
      ? "verified"
      : "candidate";
  const finalOracles: ExperimentTask["finalOracles"] = [
    options.completionOracle.type === "text_absent"
      ? { type: "text_absent", value: options.completionOracle.value }
      : options.completionOracle.type === "text_visible"
        ? { type: "text_visible", value: options.completionOracle.value }
        : {
            type: "scene_current",
            sceneId:
              synthesizedSceneByObservation.get(
                normalizedObservations.at(-1)!.observationId,
              )?.sceneId ?? observationSceneId(normalizedObservations.at(-1)!),
          },
    { type: "foreground_bundle", bundleId: options.graph.bundleId },
  ];
  const task: ExperimentTask = {
    ...(existingTask ?? {}),
    taskId: candidateTaskId,
    title: options.synthesisProposal?.taskTitle ?? options.goal,
    summary:
      options.synthesisProposal?.taskSummary ??
      `通过 targeted discovery 发现并执行：${options.goal}`,
    intents: [options.goal],
    parameters: {},
    entrySceneId: options.graph.resetStrategies.find(
      (strategy) =>
        strategy.strategyId === options.graph.defaultResetStrategyId,
    )!.entrySceneId,
    operatorIds,
    finalOracles,
    status: taskStatus,
    verifier: options.verifier ?? existingTask?.verifier,
    validation: {
      source: "targeted_discovery",
      sourceGoals: [
        ...new Set([
          ...(existingTask?.validation?.sourceGoals ??
            existingTask?.intents ??
            []),
          options.goal,
        ]),
      ],
      successfulExecutions,
      evidencePaths: [
        ...new Set([...existingEvidencePaths, options.evidencePath]),
      ],
      lastValidatedAt: new Date().toISOString(),
      requiresFixtureReplay,
      completionEvidence: options.completionEvidence,
      completionOracle: {
        type: options.completionOracle.type,
        value: options.completionOracle.value,
      },
    },
  };
  if (taskStatus === "verified") {
    promoteVerifiedTaskPath({
      scenes: newScenes,
      elements: newElements,
      operators: newOperators,
      operatorIds,
    });
  }
  const normalizedGoal = normalizeComparableText(options.goal);
  const operatorIdSet = new Set(operatorIds);
  const tasks = [
    ...options.graph.tasks.filter((item) => {
      if (item.taskId === candidateTaskId) {
        return false;
      }
      return !(
        item.taskId === "discovery.item" &&
        item.operatorIds.length === operatorIds.length &&
        item.operatorIds.every((operatorId) => operatorIdSet.has(operatorId)) &&
        item.intents.some(
          (intent) => normalizeComparableText(intent) === normalizedGoal,
        )
      );
    }),
    task,
  ];
  pruneSupersededCandidateTaskPath({
    elements: newElements,
    operators: newOperators,
    tasks,
    previousTask: existingTask,
    nextOperatorIds: operatorIds,
  });
  const patchedGraph: ExecutableUiGraphExperiment = {
    ...options.graph,
    scenes: newScenes,
    elements: newElements,
    operators: newOperators,
    tasks,
  };
  await writeGraphAtomic(options.graphPath, patchedGraph);
  const graphPatchPath = join(
    options.outputDir,
    "targeted-discovery-patch.json",
  );
  await writeJsonAtomic(graphPatchPath, {
    schemaVersion: "ios-ui-targeted-discovery-patch/v1",
    graphPath: options.graphPath,
    candidateTaskId,
    completionOracle: options.completionOracle,
    completionEvidence: options.completionEvidence,
    addedScenes: newScenes.filter(
      (scene) =>
        !options.graph.scenes.some(
          (existing) => existing.sceneId === scene.sceneId,
        ),
    ),
    addedElements: newElements.filter(
      (element) =>
        !options.graph.elements.some(
          (existing) => existing.elementId === element.elementId,
        ),
    ),
    addedOperators: newOperators.filter(
      (operator) =>
        !options.graph.operators.some(
          (existing) => existing.operatorId === operator.operatorId,
        ),
    ),
    task,
  });
  return { graphPatchPath, candidateTaskId };
}

function promoteVerifiedTaskPath(options: {
  scenes: ExperimentScene[];
  elements: ExperimentElement[];
  operators: ExperimentOperator[];
  operatorIds: readonly string[];
}): void {
  const promotedSceneIds = new Set<string>();
  const promotedElementIds = new Set<string>();
  for (const operatorId of options.operatorIds) {
    const index = options.operators.findIndex(
      (operator) => operator.operatorId === operatorId,
    );
    const operator = options.operators[index];
    if (
      !operator ||
      (operator.risk !== "navigation" && operator.risk !== "interaction")
    ) {
      continue;
    }
    promotedSceneIds.add(operator.fromSceneId);
    promotedSceneIds.add(operator.toSceneId);
    if (
      operator.operation.type === "tap" ||
      operator.operation.type === "long_press"
    ) {
      promotedElementIds.add(operator.operation.elementId);
    }
    options.operators[index] = {
      ...operator,
      status: "verified",
      reliability: Math.max(operator.reliability, 0.9),
    };
  }
  for (const [index, scene] of options.scenes.entries()) {
    if (promotedSceneIds.has(scene.sceneId)) {
      options.scenes[index] = { ...scene, status: "verified" };
    }
  }
  for (const [index, element] of options.elements.entries()) {
    if (promotedElementIds.has(element.elementId)) {
      options.elements[index] = {
        ...element,
        bindings: element.bindings.map((binding) => ({
          ...binding,
          status: "verified",
          reliability: Math.max(binding.reliability, 0.9),
        })),
      };
    }
  }
}

function deterministicTargetedDiscoveryActionIds(options: {
  goal: string;
  action: TargetedDiscoveryAction;
}):
  | {
      elementId: string;
      elementTitle: string;
      operatorId: string;
      operatorTitle: string;
    }
  | undefined {
  if (
    /字号|字体/.test(options.goal) &&
    /最大/.test(options.goal) &&
    (normalizeComparableText(options.action.targetText) === "大" ||
      normalizeComparableText(options.action.expectedOutcome).includes(
        "字号调整到最大",
      ))
  ) {
    return {
      elementId: "bot.settings.font_background.font_adjust_max",
      elementTitle: "最大字号",
      operatorId: "bot.settings.font_background.select_max_font",
      operatorTitle: "选择最大字号",
    };
  }
  if (
    /字号|字体/.test(options.goal) &&
    /最大/.test(options.goal) &&
    normalizeComparableText(options.action.targetText) === "确认"
  ) {
    return {
      elementId: "font_background.confirm",
      elementTitle: "确认",
      operatorId: "bot.settings.font_background.confirm_max_font",
      operatorTitle: "确认最大字号设置",
    };
  }
  if (
    /技能|skill/i.test(options.goal) &&
    normalizeComparableText(options.action.targetText) ===
      normalizeComparableText("技能")
  ) {
    return {
      elementId: "chat.sidebar.skills.entry",
      elementTitle: "技能",
      operatorId: "chat.sidebar.open.skills",
      operatorTitle: "从侧边栏进入技能页面",
    };
  }
  if (
    /云盘|cloud\s*drive/i.test(options.goal) &&
    normalizeComparableText(options.action.targetText) ===
      normalizeComparableText("云盘")
  ) {
    return {
      elementId: "chat.sidebar.cloud.drive.entry",
      elementTitle: "云盘",
      operatorId: "chat.sidebar.open.cloud.drive",
      operatorTitle: "从侧边栏进入云盘",
    };
  }
  return undefined;
}

function pruneSupersededCandidateTaskPath(options: {
  elements: ExperimentElement[];
  operators: ExperimentOperator[];
  tasks: ExperimentTask[];
  previousTask?: ExperimentTask;
  nextOperatorIds: readonly string[];
}): void {
  if (!options.previousTask) {
    return;
  }
  const nextOperatorIds = new Set(options.nextOperatorIds);
  const referencedByOtherTasks = new Set(
    options.tasks.flatMap((task) => task.operatorIds),
  );
  const removableOperatorIds = new Set(
    options.previousTask.operatorIds.filter((operatorId) => {
      if (
        nextOperatorIds.has(operatorId) ||
        referencedByOtherTasks.has(operatorId)
      ) {
        return false;
      }
      return options.operators.some(
        (operator) =>
          operator.operatorId === operatorId && operator.status === "candidate",
      );
    }),
  );
  const removableElementIds = new Set<string>();
  for (let index = options.operators.length - 1; index >= 0; index -= 1) {
    const operator = options.operators[index]!;
    if (!removableOperatorIds.has(operator.operatorId)) {
      continue;
    }
    if (
      operator.operation.type === "tap" ||
      operator.operation.type === "long_press"
    ) {
      removableElementIds.add(operator.operation.elementId);
    }
    options.operators.splice(index, 1);
  }
  for (let index = options.elements.length - 1; index >= 0; index -= 1) {
    const element = options.elements[index]!;
    if (
      removableElementIds.has(element.elementId) &&
      !options.operators.some(
        (operator) =>
          (operator.operation.type === "tap" ||
            operator.operation.type === "long_press") &&
          operator.operation.elementId === element.elementId,
      )
    ) {
      options.elements.splice(index, 1);
    }
  }
}

function findReusableObservedNavigation(options: {
  graph: ExecutableUiGraphExperiment;
  action: TargetedDiscoveryAction;
  fromSceneId: string;
  toSceneId: string;
}):
  | {
      elementId: string;
      operatorId: string;
      fromSceneId: string;
      toSceneId: string;
    }
  | undefined {
  if (options.action.actionType !== "tap") {
    return undefined;
  }
  const observedText = normalizeComparableText(options.action.targetText);
  for (const operator of options.graph.operators) {
    if (
      operator.risk !== "navigation" ||
      operator.fromSceneId !== options.fromSceneId ||
      operator.toSceneId !== options.toSceneId ||
      operator.operation.type !== "tap"
    ) {
      continue;
    }
    const elementId = operator.operation.elementId;
    const element = options.graph.elements.find(
      (candidate) => candidate.elementId === elementId,
    );
    const semanticTexts = [
      element?.title,
      element?.selector.accessibilityId,
      element?.selector.label,
      element?.selector.text,
      element?.selector.value,
    ]
      .map((value) => normalizeComparableText(value ?? ""))
      .filter(Boolean);
    if (
      semanticTexts.some(
        (value) => value.includes(observedText) || observedText.includes(value),
      )
    ) {
      return {
        elementId: element!.elementId,
        operatorId: operator.operatorId,
        fromSceneId: operator.fromSceneId,
        toSceneId: operator.toSceneId,
      };
    }
  }
  return undefined;
}

export function targetedDiscoverySemanticPrefix(goal: string): string {
  if (/字号|字体/.test(goal) && /最大/.test(goal)) {
    return "bot.settings.set_max_font_size";
  }
  if (/技能|skill/i.test(goal)) {
    return "skills.open_from_chat_sidebar";
  }
  if (/云盘|cloud\s*drive/i.test(goal)) {
    return "cloud_drive.open_from_chat_sidebar";
  }
  if (/侧边栏|sidebar/i.test(goal) && /打开|展开|显示/.test(goal)) {
    return "chat.open_sidebar";
  }
  if (/actionbar|action bar/i.test(goal) && /滑|滚/.test(goal)) {
    return "chat.actionbar_scroll_end";
  }
  if (/删除.*(?:最后|最新).*消息|删除最后.*消息/.test(goal)) {
    return "message.delete_last";
  }
  return `discovery.${safeSegment(goal).toLocaleLowerCase()}`;
}

function parseDiscoverySwipeOperation(
  command: readonly string[],
): Extract<ExperimentOperator["operation"], { type: "swipe" }> {
  const coordinates = command.at(-1)?.split(",").map(Number) ?? [];
  if (
    coordinates.length !== 4 ||
    coordinates.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      `Unable to parse targeted discovery swipe command: ${command.join(" ")}`,
    );
  }
  return {
    type: "swipe",
    from: { x: coordinates[0]!, y: coordinates[1]! },
    to: { x: coordinates[2]!, y: coordinates[3]! },
  };
}

function targetedDiscoveryTaskId(goal: string): string {
  return targetedDiscoverySemanticPrefix(goal);
}

export async function persistCandidateTask(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  task: ExperimentTask;
  goal: string;
  evidencePath: string;
  outputDir: string;
  verifier?: ExperimentVerifierSpec;
}): Promise<string> {
  const patchPath = join(options.outputDir, "candidate-task-patch.json");
  const existing = options.graph.tasks.find(
    (task) => task.taskId === options.task.taskId,
  );
  const successfulExecutions =
    (existing?.validation?.successfulExecutions ?? 0) + 1;
  const status = successfulExecutions >= 2 ? "verified" : "candidate";
  const sourceGoals = [
    ...new Set([
      ...(existing?.validation?.sourceGoals ?? existing?.intents ?? []),
      options.goal,
    ]),
  ];
  const evidencePaths = [
    ...new Set([
      ...(existing?.validation?.evidencePaths ?? []),
      options.evidencePath,
    ]),
  ];
  const persistedTask: ExperimentTask = {
    ...(existing ?? options.task),
    title: options.task.title,
    summary: options.task.summary,
    intents: sourceGoals,
    operatorIds: options.task.operatorIds,
    finalOracles: options.task.finalOracles,
    status,
    verifier: options.verifier ?? existing?.verifier ?? options.task.verifier,
    validation: {
      source: "dynamic_composition",
      sourceGoals,
      successfulExecutions,
      evidencePaths,
      lastValidatedAt: new Date().toISOString(),
    },
  };
  const tasks = existing
    ? options.graph.tasks.map((task) =>
        task.taskId === persistedTask.taskId ? persistedTask : task,
      )
    : [...options.graph.tasks, persistedTask];
  await writeGraphAtomic(options.graphPath, { ...options.graph, tasks });
  await writeJsonAtomic(patchPath, {
    schemaVersion: "ios-ui-candidate-task-patch/v1",
    graphPath: options.graphPath,
    action: existing ? "updated" : "added",
    promotedToVerified: status === "verified",
    successfulExecutions,
    previousTask: existing ?? null,
    task: persistedTask,
  });
  return patchPath;
}

export async function persistTaskVerifier(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  task: ExperimentTask;
  verifier: ExperimentVerifierSpec;
  outputDir: string;
}): Promise<string> {
  const patchPath = join(options.outputDir, "task-verifier-patch.json");
  const persistedTask: ExperimentTask = {
    ...options.task,
    verifier: options.verifier,
  };
  const tasks = options.graph.tasks.map((task) =>
    task.taskId === persistedTask.taskId ? persistedTask : task,
  );
  await writeGraphAtomic(options.graphPath, { ...options.graph, tasks });
  await writeJsonAtomic(patchPath, {
    schemaVersion: "ios-ui-task-verifier-patch/v1",
    graphPath: options.graphPath,
    taskId: persistedTask.taskId,
    previousVerifier: options.task.verifier ?? null,
    verifier: options.verifier,
  });
  return patchPath;
}

export async function persistOperatorExecutionOutcomes(options: {
  graphPath: string;
  outcomes: readonly OperatorExecutionOutcome[];
  appVersion?: string;
  outputDir: string;
}): Promise<string> {
  const patchPath = join(options.outputDir, "execution-learning-patch.json");
  let graph = await readGraph(options.graphPath);
  const changes: Array<{
    operatorId: string;
    previous: ExperimentOperator | null;
    current: ExperimentOperator | null;
  }> = [];
  for (const outcome of options.outcomes) {
    const previous =
      graph.operators.find(
        (operator) => operator.operatorId === outcome.operatorId,
      ) ?? null;
    graph = applyOperatorExecutionOutcome({
      graph,
      operatorId: outcome.operatorId,
      success: outcome.success,
      evidencePath: outcome.evidencePath,
      appVersion: options.appVersion,
      failure: outcome.failure,
      liveResolution: outcome.liveResolution,
    });
    const current =
      graph.operators.find(
        (operator) => operator.operatorId === outcome.operatorId,
      ) ?? null;
    changes.push({ operatorId: outcome.operatorId, previous, current });
  }
  await writeGraphAtomic(options.graphPath, graph);
  await writeJsonAtomic(patchPath, {
    schemaVersion: "ios-ui-execution-learning-patch/v1",
    graphPath: options.graphPath,
    appVersion: options.appVersion ?? null,
    changes,
    generatedAt: new Date().toISOString(),
  });
  return patchPath;
}

export async function promoteCandidateReplay(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  task: ExperimentTask;
  verifier: ExperimentVerifierSpec;
  goal: string;
  evidencePath: string;
  outputDir: string;
}): Promise<string> {
  if (
    options.task.status !== "candidate" ||
    (options.task.validation?.source !== "targeted_discovery" &&
      options.task.validation?.source !== "user_correction") ||
    options.task.validation.requiresFixtureReplay === true
  ) {
    throw new Error(
      `Task ${options.task.taskId} is not eligible for safe candidate replay promotion.`,
    );
  }
  const patchPath = join(options.outputDir, "candidate-replay-patch.json");
  const evidencePaths = [
    ...new Set([
      ...options.task.validation.evidencePaths,
      options.evidencePath,
    ]),
  ];
  const evidenceIsNew =
    evidencePaths.length > options.task.validation.evidencePaths.length;
  const successfulExecutions =
    options.task.validation.successfulExecutions + (evidenceIsNew ? 1 : 0);
  const status: GraphEntityStatus =
    successfulExecutions >= 2 ? "verified" : "candidate";
  const tasks = options.graph.tasks.map((task) =>
    task.taskId === options.task.taskId
      ? {
          ...task,
          status,
          verifier: {
            ...options.verifier,
            status:
              successfulExecutions >= 2
                ? ("verified" as const)
                : options.verifier.status,
            successfulExecutions: Math.max(
              options.verifier.successfulExecutions,
              successfulExecutions,
            ),
          },
          validation: {
            ...options.task.validation!,
            sourceGoals: [
              ...new Set([
                ...options.task.validation!.sourceGoals,
                options.goal,
              ]),
            ],
            successfulExecutions,
            evidencePaths,
            lastValidatedAt: new Date().toISOString(),
          },
        }
      : task,
  );
  const scenes = [...options.graph.scenes];
  const elements = [...options.graph.elements];
  const operators = [...options.graph.operators];
  if (status === "verified") {
    promoteVerifiedTaskPath({
      scenes,
      elements,
      operators,
      operatorIds: options.task.operatorIds,
    });
  }
  const patchedGraph: ExecutableUiGraphExperiment = {
    ...options.graph,
    scenes,
    elements,
    operators,
    tasks,
  };
  await writeGraphAtomic(options.graphPath, patchedGraph);
  const promotedTask = tasks.find(
    (task) => task.taskId === options.task.taskId,
  )!;
  await writeJsonAtomic(patchPath, {
    schemaVersion: "ios-ui-candidate-replay-patch/v1",
    graphPath: options.graphPath,
    taskId: options.task.taskId,
    evidenceIsNew,
    successfulExecutions,
    promotedToVerified: status === "verified",
    previousTask: options.task,
    task: promotedTask,
  });
  return patchPath;
}

async function writeReexplorationPacket(options: {
  outputDir: string;
  goalResolution: SemanticGoalResolution;
  plan: CompiledExperimentPlan;
  initialGrounding: ExperimentGroundingResult;
  entryRecovery?: ExperimentEntryRecovery;
  commands: readonly TimedExperimentCommand[];
  finalVerification?: IosUiGraphExperimentResult["finalVerification"];
}): Promise<string> {
  const path = join(options.outputDir, "reexploration-packet.json");
  const failedCommands = options.commands.filter(
    (command) => !command.stepId.startsWith("reset-") && command.exitCode !== 0,
  );
  const categories: string[] = [];
  if (
    options.initialGrounding.matchedSceneId !== options.plan.entrySceneId &&
    options.entryRecovery?.success !== true
  ) {
    categories.push("scene_or_entry_path");
  }
  if (failedCommands.length > 0) {
    categories.push("operator_or_binding");
  }
  if (options.finalVerification?.success === false) {
    categories.push("effect_or_oracle");
  }
  await writeJsonAtomic(path, {
    schemaVersion: "ios-ui-reexploration-packet/v1",
    goalResolution: options.goalResolution,
    plan: {
      taskId: options.plan.taskId,
      entrySceneId: options.plan.entrySceneId,
      operatorIds: options.plan.steps.map((step) => step.operatorId),
    },
    failureCategories: categories,
    initialGrounding: options.initialGrounding,
    entryRecovery: options.entryRecovery,
    failedCommands,
    finalVerification: options.finalVerification,
    recommendedActions: [
      ...(categories.includes("scene_or_entry_path")
        ? [
            "Re-inspect Scene anchors and verified navigation edges from the observed Scene.",
          ]
        : []),
      ...(categories.includes("operator_or_binding")
        ? [
            "Capture current screenshot and UI dump at the failed Operator boundary.",
            "Re-resolve the target Element and mark the old Binding or Operator stale if it moved.",
          ]
        : []),
      ...(categories.includes("effect_or_oracle")
        ? [
            "Separate action failure from Oracle failure using screenshot, UI dump, and foreground evidence.",
            "Repair the Effect or Oracle contract before replaying a mutating action.",
          ]
        : []),
    ],
    generatedAt: new Date().toISOString(),
  });
  return path;
}

export function validateComposedOperatorPath(
  graph: ExecutableUiGraphExperiment,
  operatorIds: readonly string[],
): void {
  if (operatorIds.length === 0) {
    throw new Error("Dynamic composition returned an empty Operator path.");
  }
  const resetStrategy = graph.resetStrategies.find(
    (strategy) => strategy.strategyId === graph.defaultResetStrategyId,
  );
  if (!resetStrategy) {
    throw new Error(
      `Reset strategy does not exist: ${graph.defaultResetStrategyId}.`,
    );
  }
  const operators = new Map(
    graph.operators.map((operator) => [operator.operatorId, operator]),
  );
  let currentSceneId = resetStrategy.entrySceneId;
  const knownStateFacts = new Map<string, string>();
  for (const operatorId of operatorIds) {
    const operator = operators.get(operatorId);
    if (!operator) {
      throw new Error(
        `Dynamic composition returned unknown Operator ${operatorId}.`,
      );
    }
    if (
      !isPlannableOperator(operator) ||
      (operator.risk !== "navigation" && operator.risk !== "interaction") ||
      operator.fromSceneId !== currentSceneId
    ) {
      throw new Error(
        `Dynamic composition Operator ${operatorId} is not a continuous evidence-backed navigation edge from ${currentSceneId}.`,
      );
    }
    const unsatisfiedPreconditions = (operator.preconditions ?? []).filter(
      (precondition) => {
        const separator = precondition.indexOf("=");
        const key =
          separator >= 0 ? precondition.slice(0, separator) : precondition;
        return knownStateFacts.get(key) !== precondition;
      },
    );
    if (unsatisfiedPreconditions.length > 0) {
      throw new Error(
        `Dynamic composition Operator ${operatorId} has unsatisfied state preconditions: ${unsatisfiedPreconditions.join(", ")}.`,
      );
    }
    for (const fact of [...operator.effects, ...operator.postconditions]) {
      if (fact.startsWith("scene.current=")) {
        continue;
      }
      const separator = fact.indexOf("=");
      if (separator >= 0) {
        knownStateFacts.set(fact.slice(0, separator), fact);
      }
    }
    currentSceneId = operator.toSceneId;
  }
}

function buildResolvableTaskCards(graph: ExecutableUiGraphExperiment): Array<{
  taskId: string;
  title: string;
  summary: string;
  intents: readonly string[];
  status: "verified" | "candidate";
  parameters: Readonly<
    Record<string, { readonly type: "string"; readonly required: boolean }>
  >;
}> {
  return graph.tasks
    .filter(
      (task): task is ExperimentTask & { status: "verified" | "candidate" } =>
        (task.status === "verified" ||
          (task.status === "candidate" &&
            task.validation?.requiresFixtureReplay !== true &&
            (task.validation?.successfulExecutions ?? 0) > 0)) &&
        task.operatorIds.every((operatorId) => {
          const operator = graph.operators.find(
            (candidate) => candidate.operatorId === operatorId,
          );
          return Boolean(operator && isPlannableOperator(operator));
        }),
    )
    .map((task) => ({
      taskId: task.taskId,
      title: task.title,
      summary: task.summary,
      intents: task.intents,
      status: task.status,
      parameters: task.parameters,
    }));
}

function requireResolvableTask(
  graph: ExecutableUiGraphExperiment,
  taskId: string,
): ExperimentTask {
  const task = graph.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) {
    throw new Error(`Task does not exist: ${taskId}.`);
  }
  if (
    (task.status !== "verified" &&
      !(
        task.status === "candidate" &&
        task.validation?.requiresFixtureReplay !== true &&
        (task.validation?.successfulExecutions ?? 0) > 0
      )) ||
    !task.operatorIds.every((operatorId) => {
      const operator = graph.operators.find(
        (candidate) => candidate.operatorId === operatorId,
      );
      return Boolean(operator && isPlannableOperator(operator));
    })
  ) {
    throw new Error(`Task ${task.taskId} is not resolvable: ${task.status}.`);
  }
  return task;
}

function resolveTaskParameters(
  task: ExperimentTask,
  supplied: Readonly<Record<string, string>>,
  goal: string,
): Readonly<Record<string, string>> {
  const parameters: Record<string, string> = { ...supplied };
  for (const name of Object.keys(parameters)) {
    if (!(name in task.parameters)) {
      throw new Error(`Task ${task.taskId} does not accept parameter ${name}.`);
    }
  }
  if (task.parameters.text?.required && !parameters.text && goal) {
    const quoted =
      goal.match(/[“"]([^”"]+)[”"]/) ??
      goal.match(/(?:消息|文本|说|发送)[:：]\s*(.+)$/);
    if (quoted?.[1]) {
      parameters.text = quoted[1].trim();
    }
  }
  for (const [name, definition] of Object.entries(task.parameters)) {
    if (definition.required && !parameters[name]) {
      throw new Error(`Task ${task.taskId} requires parameter ${name}.`);
    }
  }
  return parameters;
}

export function compileExperimentPlan(options: {
  graph: ExecutableUiGraphExperiment;
  task: ExperimentTask;
  parameters: Readonly<Record<string, string>>;
  udid: string;
  deviceProfileId?: string;
  allowCandidate: boolean;
  appVersion?: string;
}): CompiledExperimentPlan {
  const started = performance.now();
  const { graph, task } = options;
  if (
    task.status === "candidate" &&
    task.validation?.requiresFixtureReplay === true
  ) {
    throw new Error(
      `Candidate Task ${task.taskId} requires an isolated fixture replay and cannot execute through allowCandidate alone.`,
    );
  }
  const deviceProfileId =
    options.deviceProfileId ?? graph.defaultDeviceProfileId;
  const profile = graph.deviceProfiles.find(
    (candidate) => candidate.profileId === deviceProfileId,
  );
  if (!profile) {
    throw new Error(`Device profile does not exist: ${deviceProfileId}.`);
  }
  const resetStrategy = graph.resetStrategies.find(
    (strategy) => strategy.strategyId === graph.defaultResetStrategyId,
  );
  if (!resetStrategy) {
    throw new Error(
      `Reset strategy does not exist: ${graph.defaultResetStrategyId}.`,
    );
  }
  if (resetStrategy.entrySceneId !== task.entrySceneId) {
    throw new Error(
      `This minimal experiment requires reset entry ${task.entrySceneId}; got ${resetStrategy.entrySceneId}.`,
    );
  }
  const operators = new Map(
    graph.operators.map((operator) => [operator.operatorId, operator]),
  );
  const elements = new Map(
    graph.elements.map((element) => [element.elementId, element]),
  );
  const steps: CompiledExperimentStep[] = [];
  let currentSceneId = task.entrySceneId;
  const knownStateFacts = new Map<string, string>();
  const appendOperator = (operator: ExperimentOperator): void => {
    if (
      !isPlannableOperator(operator, options.appVersion) &&
      !(options.allowCandidate && operator.status === "candidate")
    ) {
      throw new Error(
        `Operator ${operator.operatorId} is not executable: ${operator.status}.`,
      );
    }
    if (operator.fromSceneId !== currentSceneId) {
      throw new Error(
        `Operator ${operator.operatorId} expects ${operator.fromSceneId}, current planned scene is ${currentSceneId}.`,
      );
    }
    const unsatisfiedPreconditions = (operator.preconditions ?? []).filter(
      (precondition) => {
        const separator = precondition.indexOf("=");
        const key =
          separator >= 0 ? precondition.slice(0, separator) : precondition;
        return knownStateFacts.get(key) !== precondition;
      },
    );
    if (unsatisfiedPreconditions.length > 0) {
      throw new Error(
        `Operator ${operator.operatorId} has unsatisfied state preconditions: ${unsatisfiedPreconditions.join(", ")}.`,
      );
    }
    steps.push(
      compileOperatorStep({
        graph,
        operator,
        index: steps.length,
        parameters: options.parameters,
        udid: options.udid,
        deviceProfileId,
        profile,
        elements,
        allowCandidate: options.allowCandidate,
        appVersion: options.appVersion,
      }),
    );
    for (const fact of [...operator.effects, ...operator.postconditions]) {
      if (fact.startsWith("scene.current=")) {
        continue;
      }
      const separator = fact.indexOf("=");
      if (separator < 0) {
        continue;
      }
      knownStateFacts.set(fact.slice(0, separator), fact);
    }
    currentSceneId = operator.toSceneId;
  };
  for (const operatorId of task.operatorIds) {
    const operator = operators.get(operatorId);
    if (!operator) {
      throw new Error(`Operator does not exist: ${operatorId}.`);
    }
    if (operator.fromSceneId !== currentSceneId) {
      const bridgeOperatorIds = findVerifiedEntryRecoveryOperators(
        graph,
        currentSceneId,
        operator.fromSceneId,
      );
      if (!bridgeOperatorIds) {
        throw new Error(
          `Operator ${operator.operatorId} expects ${operator.fromSceneId}, current planned scene is ${currentSceneId}, and no verified navigation bridge exists.`,
        );
      }
      for (const bridgeOperatorId of bridgeOperatorIds) {
        const bridgeOperator = operators.get(bridgeOperatorId);
        if (!bridgeOperator) {
          throw new Error(
            `Verified navigation bridge Operator does not exist: ${bridgeOperatorId}.`,
          );
        }
        appendOperator(bridgeOperator);
      }
    }
    appendOperator(operator);
  }
  return {
    schemaVersion: "ios-ui-graph-experiment-plan/v1",
    graphId: graph.graphId,
    taskId: task.taskId,
    parameters: options.parameters,
    resetStrategy,
    entrySceneId: task.entrySceneId,
    deviceProfileId,
    appVersion: options.appVersion,
    referenceAssets: graph.scenes.flatMap((scene) => scene.referenceAssets),
    steps,
    finalOracles: task.finalOracles.map((oracle) =>
      oracle.type === "text_visible"
        ? {
            ...oracle,
            value: interpolate(oracle.value, options.parameters),
          }
        : oracle,
    ),
    planningDurationMs: elapsed(started),
  };
}

export function findVerifiedEntryRecoveryOperators(
  graph: ExecutableUiGraphExperiment,
  fromSceneId: string,
  targetSceneId: string,
): readonly string[] | null {
  if (fromSceneId === targetSceneId) {
    return [];
  }
  const outgoing = new Map<string, ExperimentOperator[]>();
  for (const operator of graph.operators) {
    if (
      operator.status !== "verified" ||
      operator.risk !== "navigation" ||
      operator.fromSceneId === operator.toSceneId ||
      (operator.preconditions?.length ?? 0) > 0
    ) {
      continue;
    }
    const operators = outgoing.get(operator.fromSceneId) ?? [];
    operators.push(operator);
    outgoing.set(operator.fromSceneId, operators);
  }
  const queue: Array<{ sceneId: string; operatorIds: string[] }> = [
    { sceneId: fromSceneId, operatorIds: [] },
  ];
  const visited = new Set([fromSceneId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const operator of outgoing.get(current.sceneId) ?? []) {
      if (visited.has(operator.toSceneId)) {
        continue;
      }
      const operatorIds = [...current.operatorIds, operator.operatorId];
      if (operator.toSceneId === targetSceneId) {
        return operatorIds;
      }
      visited.add(operator.toSceneId);
      queue.push({ sceneId: operator.toSceneId, operatorIds });
    }
  }
  return null;
}

export function compileOperatorStep(options: {
  graph: ExecutableUiGraphExperiment;
  operator: ExperimentOperator;
  index: number;
  parameters: Readonly<Record<string, string>>;
  udid: string;
  deviceProfileId: string;
  profile: ExecutableUiGraphExperiment["deviceProfiles"][number];
  elements: ReadonlyMap<string, ExperimentElement>;
  stepPrefix?: string;
  allowCandidate?: boolean;
  appVersion?: string;
}): CompiledExperimentStep {
  const { graph, operator } = options;
  const resolvedOperation =
    operator.operation.type === "input_text"
      ? {
          ...operator.operation,
          value: interpolate(operator.operation.value, options.parameters),
        }
      : operator.operation;
  let command: string[];
  let bindingId: string | undefined;
  let bindingSource: "ui_dump" | "manual" | undefined;
  let bindingReliability: number | undefined;
  let resolvedElementSelector: ExperimentElement["selector"] | undefined;
  let liveResolutionRequired = false;
  if (
    resolvedOperation.type === "tap" ||
    resolvedOperation.type === "long_press" ||
    resolvedOperation.type === "tap_restart_app"
  ) {
    const element = options.elements.get(resolvedOperation.elementId);
    if (!element) {
      throw new Error(
        `Gesture target does not exist: ${resolvedOperation.elementId}.`,
      );
    }
    resolvedElementSelector = interpolateSelector(
      element.selector,
      options.parameters,
    );
    liveResolutionRequired = selectorContainsParameter(element.selector);
    const executionTier = operatorExecutionTier(operator, options.appVersion);
    if (liveResolutionRequired) {
      // This command must be replaced by resolveGuardedStep. Keeping a
      // non-mutating failure command prevents a stale Binding from being used
      // if a future caller accidentally skips required live resolution.
      command = ["/usr/bin/false"];
    } else {
      const binding = chooseBinding(
        element,
        options.deviceProfileId,
        options.allowCandidate === true || executionTier === "guarded",
      );
      const point = {
        x: binding.normalizedPoint.x * options.profile.viewportWidth,
        y: binding.normalizedPoint.y * options.profile.viewportHeight,
      };
      command =
        resolvedOperation.type === "long_press"
          ? [
              "mobilecli",
              "io",
              "longpress",
              "--device",
              options.udid,
              `${Math.round(point.x)},${Math.round(point.y)}`,
              "--duration",
              String(resolvedOperation.durationMs),
            ]
          : resolvedOperation.type === "tap_restart_app"
            ? [
                "python3",
                DEVICECTL_WAIT_LAUNCH_SOURCE_PATH,
                "--device",
                options.udid,
                "--bundle-id",
                resolvedOperation.bundleId,
                "--tap-point",
                `${Math.round(point.x)},${Math.round(point.y)}`,
              ]
            : buildMobilecliActionCommand({
                action: {
                  actionId: operator.operatorId,
                  type: "tap",
                  pageId: operator.fromSceneId,
                  target: { controlId: element.elementId },
                },
                udid: options.udid,
                bundleId: graph.bundleId,
                tapPoint: point,
              });
      bindingId = binding.bindingId;
      bindingSource = binding.source;
      bindingReliability = binding.reliability;
    }
  } else if (resolvedOperation.type === "input_text") {
    command = buildMobilecliActionCommand({
      action: {
        actionId: operator.operatorId,
        type: "type_text",
        text: resolvedOperation.value,
      },
      udid: options.udid,
      bundleId: graph.bundleId,
    });
  } else {
    command = buildMobilecliActionCommand({
      action: {
        actionId: operator.operatorId,
        type: "swipe",
        from: resolvedOperation.from,
        to: resolvedOperation.to,
      },
      udid: options.udid,
      bundleId: graph.bundleId,
    });
  }
  return {
    stepId: `${options.stepPrefix ?? ""}${String(options.index + 1).padStart(2, "0")}-${operator.operatorId}`,
    operatorId: operator.operatorId,
    title: operator.title,
    operation: resolvedOperation,
    command,
    expectedFromSceneId: operator.fromSceneId,
    expectedToSceneId: operator.toSceneId,
    settleMs: operator.settleMs,
    risk: operator.risk,
    executionTier: operatorExecutionTier(operator, options.appVersion),
    bindingId,
    bindingSource,
    bindingReliability,
    resolvedElementSelector,
    liveResolutionRequired,
    requiresLiveResolution:
      liveResolutionRequired ||
      (operatorExecutionTier(operator, options.appVersion) === "guarded" &&
        (resolvedOperation.type === "tap" ||
          resolvedOperation.type === "long_press" ||
          resolvedOperation.type === "tap_restart_app")),
  };
}

export function matchGuardedElement(
  elements: readonly UiElement[],
  element: ExperimentElement,
): UiElement | null {
  return matchUiElement(elements, element.selector);
}

export async function resolveGuardedStep(options: {
  graph: ExecutableUiGraphExperiment;
  step: CompiledExperimentStep;
  deviceProfileId: string;
  udid: string;
  outputDir: string;
  commandCwd: string;
  agentCwd: string;
  model?: string;
  timeoutMs: number;
}): Promise<CompiledExperimentStep> {
  if (
    options.step.operation.type !== "tap" &&
    options.step.operation.type !== "long_press" &&
    options.step.operation.type !== "tap_restart_app"
  ) {
    return options.step;
  }
  const operation = options.step.operation;
  const element = options.graph.elements.find(
    (candidate) =>
      candidate.elementId === operation.elementId &&
      candidate.sceneId === options.step.expectedFromSceneId,
  );
  const profile = options.graph.deviceProfiles.find(
    (candidate) => candidate.profileId === options.deviceProfileId,
  );
  if (!element || !profile) {
    if (options.step.liveResolutionRequired) {
      throw new Error(
        `Required live Element resolution metadata is missing for ${options.step.operatorId}.`,
      );
    }
    return options.step;
  }
  const expectedElement = options.step.resolvedElementSelector
    ? { ...element, selector: options.step.resolvedElementSelector }
    : element;
  await mkdir(options.outputDir, { recursive: true });
  const dump = await runCommand(
    buildMobilecliUiDumpCommand(options.udid),
    options.commandCwd,
  );
  await Promise.all([
    writeFile(join(options.outputDir, "ui-dump.stdout.json"), dump.stdout),
    writeFile(join(options.outputDir, "ui-dump.stderr.txt"), dump.stderr),
  ]);
  if (dump.exitCode !== 0) {
    if (options.step.liveResolutionRequired) {
      throw new Error(
        `Required live Element resolution failed because UI dump exited with ${dump.exitCode}.`,
      );
    }
    await writeJsonAtomic(join(options.outputDir, "resolution.json"), {
      schemaVersion: "ios-ui-guarded-element-resolution/v1",
      status: "binding_fallback",
      reason: `Current UI dump failed with exit code ${dump.exitCode}.`,
      bindingId: options.step.bindingId,
      command: options.step.command,
    });
    return options.step;
  }
  const elements = parseUiDump(dump.stdout);
  let matched = matchGuardedElement(elements, expectedElement);
  let matchedBy: "selector" | "agent" | "binding" = "selector";
  let agentResolution: AgentLiveElementResolution | undefined;
  let agentError: string | undefined;
  if (!matched) {
    const candidates = selectDiscoveryUiElements(
      elements,
      profile.viewportHeight,
      80,
    ).map((candidate, index) => ({
      candidateId: `ui-${index + 1}`,
      role: candidate.role,
      accessibilityId: candidate.accessibilityId,
      label: candidate.label,
      text: candidate.text,
      value: candidate.value,
      bounds: candidate.bounds,
    }));
    const prompt = [
      "Relocate one known iOS Graph Element after a possible app UI update.",
      "Return only schema-backed JSON.",
      "Choose candidateId only from Current candidates.",
      "Match business meaning, role, visible text, and surrounding geometry.",
      "Use unmatched when the target is not confidently present.",
      "Coordinates are forbidden.",
      "",
      `Expected Scene: ${options.step.expectedFromSceneId}`,
      `Known Element: ${JSON.stringify({
        elementId: expectedElement.elementId,
        title: expectedElement.title,
        semanticRole: expectedElement.semanticRole,
        selector: expectedElement.selector,
      })}`,
      `Current candidates: ${JSON.stringify(candidates)}`,
    ].join("\n");
    try {
      agentResolution = await runAgentWithTimeout<AgentLiveElementResolution>(
        prompt,
        {
          cwd: options.agentCwd,
          model: options.model,
          sandbox: "read-only",
          schema: liveElementResolutionSchema,
          env: { CODEX_HOME: undefined },
        },
        options.timeoutMs,
        "guarded Element relocation",
      );
      if (
        agentResolution.status === "matched" &&
        agentResolution.confidence >= 0.8
      ) {
        const selectedIndex = Number.parseInt(
          agentResolution.candidateId.replace(/^ui-/, ""),
          10,
        );
        matched =
          Number.isInteger(selectedIndex) && selectedIndex > 0
            ? (selectDiscoveryUiElements(elements, profile.viewportHeight, 80)[
                selectedIndex - 1
              ] ?? null)
            : null;
        if (matched?.bounds) {
          matchedBy = "agent";
        }
      }
    } catch (error) {
      agentError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!matched?.bounds) {
    if (options.step.liveResolutionRequired) {
      await writeJsonAtomic(join(options.outputDir, "resolution.json"), {
        schemaVersion: "ios-ui-guarded-element-resolution/v1",
        status: "required_live_match_failed",
        expectedElement,
        agentResolution,
        agentError,
      });
      throw new Error(
        `Required live Element resolution did not find ${expectedElement.elementId}.`,
      );
    }
    await writeJsonAtomic(join(options.outputDir, "resolution.json"), {
      schemaVersion: "ios-ui-guarded-element-resolution/v1",
      status: "binding_fallback",
      expectedElement,
      agentResolution,
      agentError,
      bindingId: options.step.bindingId,
      command: options.step.command,
    });
    return options.step;
  }
  const point = centerOfBounds(matched.bounds);
  const command =
    operation.type === "tap"
      ? buildMobilecliActionCommand({
          action: {
            actionId: options.step.operatorId,
            type: "tap",
            pageId: options.step.expectedFromSceneId,
            target: { controlId: element.elementId },
          },
          udid: options.udid,
          bundleId: options.graph.bundleId,
          tapPoint: point,
        })
      : operation.type === "tap_restart_app"
        ? [
            "python3",
            DEVICECTL_WAIT_LAUNCH_SOURCE_PATH,
            "--device",
            options.udid,
            "--bundle-id",
            operation.bundleId,
            "--tap-point",
            `${Math.round(point.x)},${Math.round(point.y)}`,
          ]
        : [
            "mobilecli",
            "io",
            "longpress",
            "--device",
            options.udid,
            `${Math.round(point.x)},${Math.round(point.y)}`,
            "--duration",
            String(operation.durationMs),
          ];
  await writeJsonAtomic(join(options.outputDir, "resolution.json"), {
    schemaVersion: "ios-ui-guarded-element-resolution/v1",
    status: "live_match",
    matchedBy,
    expectedElement,
    matchedElement: matched,
    agentResolution,
    agentError,
    command,
  });
  return {
    ...options.step,
    command,
    bindingSource: "ui_dump",
    bindingReliability: matchedBy === "selector" ? 1 : 0.8,
    liveResolution: {
      matchedBy,
      deviceProfileId: options.deviceProfileId,
      selector: {
        accessibilityId: matched.accessibilityId,
        label: matched.label,
        text: matched.text,
        value: matched.value,
        role: matched.role,
      },
      normalizedPoint: {
        x: point.x / profile.viewportWidth,
        y: point.y / profile.viewportHeight,
      },
      evidencePath: join(options.outputDir, "resolution.json"),
    },
  };
}

function benchmarkPlanning(options: {
  graph: ExecutableUiGraphExperiment;
  task: ExperimentTask;
  parameters: Readonly<Record<string, string>>;
  udid: string;
  deviceProfileId?: string;
  allowCandidate: boolean;
  appVersion?: string;
  iterations: number;
}): {
  iterations: number;
  totalMs: number;
  meanMs: number;
  p95Ms: number;
} {
  const samples: number[] = [];
  const totalStarted = performance.now();
  for (let index = 0; index < options.iterations; index += 1) {
    const started = performance.now();
    compileExperimentPlan(options);
    samples.push(elapsed(started));
  }
  const totalMs = elapsed(totalStarted);
  samples.sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(samples.length * 0.95) - 1);
  return {
    iterations: options.iterations,
    totalMs,
    meanMs: totalMs / options.iterations,
    p95Ms: samples[p95Index] ?? 0,
  };
}

function chooseBinding(
  element: ExperimentElement,
  deviceProfileId: string,
  allowCandidate = false,
) {
  const bindings = element.bindings
    .filter(
      (binding) =>
        binding.deviceProfileId === deviceProfileId &&
        (binding.status === "verified" ||
          (allowCandidate && binding.status === "candidate")),
    )
    .sort((left, right) => right.reliability - left.reliability);
  const binding = bindings[0];
  if (!binding) {
    throw new Error(
      `Element ${element.elementId} has no verified binding for ${deviceProfileId}.`,
    );
  }
  return binding;
}

async function evaluateAgentPlanning(options: {
  graph: ExecutableUiGraphExperiment;
  goal: string;
  cwd: string;
  model?: string;
  timeoutMs: number;
}): Promise<
  NonNullable<IosUiGraphExperimentResult["agentPlanningEvaluation"]>
> {
  const semanticOnly = await runAgentPlanningTrial({
    ...options,
    includeReferenceAssets: false,
  });
  const withReferenceAssets = await runAgentPlanningTrial({
    ...options,
    includeReferenceAssets: true,
  });
  const sameResolution =
    semanticOnly.status === "success" &&
    withReferenceAssets.status === "success" &&
    semanticOnly.resolution &&
    withReferenceAssets.resolution
      ? semanticOnly.resolution.requestType ===
          withReferenceAssets.resolution.requestType &&
        semanticOnly.resolution.targetId ===
          withReferenceAssets.resolution.targetId &&
        JSON.stringify(semanticOnly.resolution.parameters) ===
          JSON.stringify(withReferenceAssets.resolution.parameters)
      : null;
  return {
    goal: options.goal,
    semanticOnly,
    withReferenceAssets,
    sameResolution,
    conclusion:
      sameResolution === null
        ? "Agent planning A/B was blocked by the Agent runtime. Graph compilation and execution remain independent; keep reference screenshots out of the hot path until the A/B can run."
        : sameResolution
          ? "Reference screenshots did not change goal resolution in this minimal graph; keep them as evidence/fallback rather than hot-path prompt content."
          : "Reference assets changed goal resolution; inspect both reasons before deciding whether screenshots belong in semantic planning prompts.",
  };
}

async function runAgentPlanningTrial(options: {
  graph: ExecutableUiGraphExperiment;
  goal: string;
  cwd: string;
  model?: string;
  timeoutMs: number;
  includeReferenceAssets: boolean;
}): Promise<AgentPlanningTrial> {
  const cards = buildSemanticCards(
    options.graph,
    options.includeReferenceAssets,
  );
  const prompt = [
    "Map the user request to exactly one available iOS graph target.",
    "Return only the schema-backed JSON.",
    "Do not invent scene IDs, task IDs, controls, coordinates, or execution steps.",
    "Use execute_task for business actions and reach_scene only when the user merely wants to open or reach a UI scene.",
    "",
    `User request: ${options.goal}`,
    `Available graph cards: ${JSON.stringify(cards)}`,
  ].join("\n");
  const started = performance.now();
  try {
    const resolution = await runAgentWithTimeout<AgentGoalResolution>(
      prompt,
      {
        cwd: options.cwd,
        model: options.model,
        sandbox: "read-only",
        schema: agentGoalResolutionSchema,
        env: {
          CODEX_HOME: undefined,
        },
      },
      options.timeoutMs,
      "Agent planning evaluation",
    );
    if (
      !cards.some(
        (card) =>
          card.targetId === resolution.targetId &&
          card.requestType === resolution.requestType,
      )
    ) {
      throw new Error(
        `Agent selected unavailable graph target: ${resolution.targetId}.`,
      );
    }
    return {
      status: "success",
      includeReferenceAssets: options.includeReferenceAssets,
      promptBytes: Buffer.byteLength(prompt, "utf8"),
      durationMs: elapsed(started),
      resolution,
    };
  } catch (error) {
    const stderr =
      error instanceof Error &&
      "stderr" in error &&
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    return {
      status: "blocked",
      includeReferenceAssets: options.includeReferenceAssets,
      promptBytes: Buffer.byteLength(prompt, "utf8"),
      durationMs: elapsed(started),
      error: [
        error instanceof Error ? error.message : String(error),
        stderr.slice(-4000),
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
}

export function buildSemanticCards(
  graph: ExecutableUiGraphExperiment,
  includeReferenceAssets: boolean,
): Array<{
  requestType: "reach_scene" | "execute_task";
  targetId: string;
  title: string;
  summary?: string;
  aliasesOrIntents: readonly string[];
  parameters?: readonly string[];
  referenceAssets?: readonly ReferenceAsset[];
}> {
  return [
    ...graph.scenes.map((scene) => ({
      requestType: "reach_scene" as const,
      targetId: scene.sceneId,
      title: scene.title,
      aliasesOrIntents: [
        ...scene.aliases,
        ...(scene.stateVariants ?? []).flatMap((variant) => [
          variant.title,
          ...variant.facts,
        ]),
      ],
      referenceAssets: includeReferenceAssets
        ? [
            ...scene.referenceAssets,
            ...(scene.stateVariants ?? []).flatMap(
              (variant) => variant.referenceAssets,
            ),
          ]
        : undefined,
    })),
    ...graph.tasks.map((task) => ({
      requestType: "execute_task" as const,
      targetId: task.taskId,
      title: task.title,
      summary: task.summary,
      aliasesOrIntents: task.intents,
      parameters: Object.keys(task.parameters),
      referenceAssets: includeReferenceAssets
        ? graph.scenes
            .filter((scene) => scene.sceneId === task.entrySceneId)
            .flatMap((scene) => [
              ...scene.referenceAssets,
              ...(scene.stateVariants ?? []).flatMap(
                (variant) => variant.referenceAssets,
              ),
            ])
        : undefined,
    })),
  ];
}

async function recoverTaskEntry(options: {
  graph: ExecutableUiGraphExperiment;
  fromSceneId: string | null;
  targetSceneId: string;
  deviceProfileId: string;
  udid: string;
  outputDir: string;
  cwd: string;
  commands: TimedExperimentCommand[];
}): Promise<ExperimentEntryRecovery> {
  const started = performance.now();
  const recoveryDirectory = join(options.outputDir, "entry-recovery");
  await mkdir(recoveryDirectory, { recursive: true });
  const finish = async (
    recovery: Omit<ExperimentEntryRecovery, "durationMs">,
  ): Promise<ExperimentEntryRecovery> => {
    const result = { ...recovery, durationMs: elapsed(started) };
    await writeJsonAtomic(
      join(recoveryDirectory, "entry-recovery.json"),
      result,
    );
    return result;
  };
  if (!options.fromSceneId) {
    return finish({
      fromSceneId: null,
      targetSceneId: options.targetSceneId,
      operatorIds: [],
      success: false,
      issue: "Initial Grounding did not recognize a recoverable Scene.",
    });
  }
  const operatorIds = findVerifiedEntryRecoveryOperators(
    options.graph,
    options.fromSceneId,
    options.targetSceneId,
  );
  if (!operatorIds) {
    return finish({
      fromSceneId: options.fromSceneId,
      targetSceneId: options.targetSceneId,
      operatorIds: [],
      success: false,
      issue: `No verified navigation path exists from ${options.fromSceneId} to ${options.targetSceneId}.`,
    });
  }
  const profile = options.graph.deviceProfiles.find(
    (candidate) => candidate.profileId === options.deviceProfileId,
  );
  if (!profile) {
    return finish({
      fromSceneId: options.fromSceneId,
      targetSceneId: options.targetSceneId,
      operatorIds,
      success: false,
      issue: `Device profile does not exist: ${options.deviceProfileId}.`,
    });
  }
  const operators = new Map(
    options.graph.operators.map((operator) => [operator.operatorId, operator]),
  );
  const elements = new Map(
    options.graph.elements.map((element) => [element.elementId, element]),
  );
  const steps = operatorIds.map((operatorId, index) => {
    const operator = operators.get(operatorId);
    if (!operator) {
      throw new Error(`Recovery Operator does not exist: ${operatorId}.`);
    }
    return compileOperatorStep({
      graph: options.graph,
      operator,
      index,
      parameters: {},
      udid: options.udid,
      deviceProfileId: options.deviceProfileId,
      profile,
      elements,
      stepPrefix: "recover-",
    });
  });
  await writeJsonAtomic(join(recoveryDirectory, "plan.json"), {
    schemaVersion: "ios-ui-entry-recovery-plan/v1",
    fromSceneId: options.fromSceneId,
    targetSceneId: options.targetSceneId,
    operatorIds,
    steps,
  });
  for (const step of steps) {
    const timed = await runTimedCommand({
      stepId: step.stepId,
      command: step.command,
      outputDir: recoveryDirectory,
      cwd: options.cwd,
    });
    options.commands.push(timed);
    if (timed.exitCode !== 0) {
      return finish({
        fromSceneId: options.fromSceneId,
        targetSceneId: options.targetSceneId,
        operatorIds,
        success: false,
        issue: `Recovery Operator ${step.operatorId} failed with exit code ${timed.exitCode}.`,
      });
    }
    if (step.settleMs > 0) {
      await Bun.sleep(step.settleMs);
    }
  }
  const postRecoveryGrounding = await captureAndGround({
    graph: options.graph,
    expectedSceneId: options.targetSceneId,
    udid: options.udid,
    outputDir: recoveryDirectory,
    prefix: "post-recovery",
  });
  const success =
    postRecoveryGrounding.matchedSceneId === options.targetSceneId;
  return finish({
    fromSceneId: options.fromSceneId,
    targetSceneId: options.targetSceneId,
    operatorIds,
    success,
    issue: success
      ? undefined
      : `Post-recovery Grounding matched ${postRecoveryGrounding.matchedSceneId ?? "nothing"} instead of ${options.targetSceneId}.`,
    postRecoveryGrounding,
  });
}

async function captureAndGround(options: {
  graph: ExecutableUiGraphExperiment;
  expectedSceneId: string;
  udid: string;
  outputDir: string;
  prefix: string;
}): Promise<ExperimentGroundingResult> {
  const started = performance.now();
  await mkdir(options.outputDir, { recursive: true });
  const screenshotPath = join(options.outputDir, `${options.prefix}.png`);
  const uiDumpPath = join(options.outputDir, `${options.prefix}.ui.json`);
  const screenshot = await runCommand(
    buildMobilecliScreenshotCommand(options.udid, screenshotPath),
  );
  if (screenshot.exitCode === 0) {
    const ocr = await runVisionOcr({
      imagePath: screenshotPath,
      outputDir: options.outputDir,
      outputFileName: `${options.prefix}.ocr.json`,
    });
    const visualTextMatch = recognizeSceneByVisualText(
      options.graph,
      ocr.texts,
      options.expectedSceneId,
    );
    if (visualTextMatch) {
      return {
        matchedSceneId: visualTextMatch,
        matchedBy: "visual_text_anchors",
        screenshotPath,
        durationMs: elapsed(started),
      };
    }
    const referenceMatch = await recognizeSceneByReferenceScreenshot({
      graph: options.graph,
      screenshotPath,
      preferredSceneId: options.expectedSceneId,
    });
    if (referenceMatch.matchedSceneId) {
      return {
        matchedSceneId: referenceMatch.matchedSceneId,
        matchedBy: "reference_screenshot",
        screenshotPath,
        referenceScores: referenceMatch.scores,
        durationMs: elapsed(started),
      };
    }
  }

  const dump = await runCommand(buildMobilecliUiDumpCommand(options.udid));
  await writeFile(uiDumpPath, dump.stdout, "utf8");
  if (dump.exitCode !== 0) {
    return {
      matchedSceneId: null,
      matchedBy: "unmatched",
      screenshotPath: screenshot.exitCode === 0 ? screenshotPath : undefined,
      uiDumpPath,
      durationMs: elapsed(started),
    };
  }
  const elements = parseUiDump(dump.stdout);
  const matchedSceneId = recognizeScene(
    options.graph,
    elements,
    options.expectedSceneId,
  );
  if (matchedSceneId) {
    return {
      matchedSceneId,
      matchedBy: "ui_dump_anchors",
      screenshotPath: screenshot.exitCode === 0 ? screenshotPath : undefined,
      uiDumpPath,
      durationMs: elapsed(started),
    };
  }
  return {
    matchedSceneId: null,
    matchedBy: "unmatched",
    screenshotPath: screenshot.exitCode === 0 ? screenshotPath : undefined,
    uiDumpPath,
    durationMs: elapsed(started),
  };
}

async function recognizeSceneByReferenceScreenshot(options: {
  graph: ExecutableUiGraphExperiment;
  screenshotPath: string;
  preferredSceneId?: string;
}): Promise<{
  matchedSceneId: string | null;
  scores: Array<{
    sceneId: string;
    score: number;
    referencePath: string;
  }>;
}> {
  const comparisons = options.graph.scenes.flatMap((scene) =>
    scene.referenceAssets
      .filter((asset) => Boolean(asset.screenshotPath))
      .slice(0, 1)
      .map(async (asset) => {
        const referencePath = asset.screenshotPath!;
        const result = await runCommand([
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "info",
          "-i",
          referencePath,
          "-i",
          options.screenshotPath,
          "-lavfi",
          "ssim",
          "-f",
          "null",
          "-",
        ]);
        const match = result.stderr.match(/All:([0-9.]+)/);
        return {
          sceneId: scene.sceneId,
          score: match ? Number(match[1]) : 0,
          referencePath,
        };
      }),
  );
  const scores = (await Promise.all(comparisons)).sort((left, right) => {
    if (
      options.preferredSceneId &&
      left.sceneId === options.preferredSceneId &&
      right.sceneId !== options.preferredSceneId
    ) {
      return -1;
    }
    if (
      options.preferredSceneId &&
      right.sceneId === options.preferredSceneId &&
      left.sceneId !== options.preferredSceneId
    ) {
      return 1;
    }
    return right.score - left.score;
  });
  const scoreOrder = [...scores].sort(
    (left, right) => right.score - left.score,
  );
  const best = scoreOrder[0];
  const second = scoreOrder[1];
  const confident =
    best !== undefined &&
    best.score >= 0.6 &&
    (!second || best.score - second.score >= 0.03);
  return {
    matchedSceneId: confident ? best.sceneId : null,
    scores,
  };
}

export function recognizeScene(
  graph: ExecutableUiGraphExperiment,
  elements: readonly UiElement[],
  preferredSceneId?: string,
): string | null {
  const scenes = preferredSceneId
    ? [
        ...graph.scenes.filter((scene) => scene.sceneId === preferredSceneId),
        ...graph.scenes.filter((scene) => scene.sceneId !== preferredSceneId),
      ]
    : graph.scenes;
  const elementById = new Map(
    graph.elements.map((element) => [element.elementId, element]),
  );
  for (const scene of scenes) {
    const anchors = scene.anchorElementIds
      .map((elementId) => elementById.get(elementId))
      .filter((element): element is ExperimentElement => element !== undefined);
    if (
      anchors.length > 0 &&
      anchors.every((anchor) => matchUiElement(elements, anchor.selector))
    ) {
      return scene.sceneId;
    }
  }
  return null;
}

export function recognizeSceneByVisualText(
  graph: ExecutableUiGraphExperiment,
  texts: readonly string[],
  preferredSceneId?: string,
): string | null {
  const normalizedTexts = texts.map(normalizeComparableText);
  const scenes = preferredSceneId
    ? [
        ...graph.scenes.filter((scene) => scene.sceneId === preferredSceneId),
        ...graph.scenes.filter((scene) => scene.sceneId !== preferredSceneId),
      ]
    : graph.scenes;
  for (const scene of scenes) {
    const anchors = scene.visualTextAnchors ?? [];
    if (
      anchors.length > 0 &&
      anchors.every((anchor) => {
        const normalizedAnchor = normalizeComparableText(anchor);
        return normalizedTexts.some((text) =>
          visualAnchorMatches(normalizedAnchor, text),
        );
      })
    ) {
      return scene.sceneId;
    }
  }
  return null;
}

function visualAnchorMatches(anchor: string, observed: string): boolean {
  if (!anchor || !observed) {
    return false;
  }
  if (anchor.length <= 3) {
    return observed === anchor || stripOcrDecorationPrefix(observed) === anchor;
  }
  return observed.includes(anchor) || anchor.includes(observed);
}

function stripOcrDecorationPrefix(value: string): string {
  return value
    .replace(/^[a-z]\s*/i, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
}

async function verifyFinalState(options: {
  graph: ExecutableUiGraphExperiment;
  plan: CompiledExperimentPlan;
  udid: string;
  outputDir: string;
  baselineScreenshotPath?: string;
}): Promise<{
  success: boolean;
  issues: string[];
  screenshotPath: string;
  uiDumpPath?: string;
  oracleResults: Array<{
    oracle: string;
    source:
      | "ui_dump"
      | "vision_ocr"
      | "vision_diff"
      | "scene_grounding"
      | "foreground";
    success: boolean;
    durationMs: number;
    evidencePath?: string;
  }>;
  durationMs: number;
}> {
  const started = performance.now();
  await mkdir(options.outputDir, { recursive: true });
  const screenshotPath = join(options.outputDir, "final.png");
  const screenshot = await runCommand(
    buildMobilecliScreenshotCommand(options.udid, screenshotPath),
  );
  const issues: string[] = [];
  const oracleResults: Array<{
    oracle: string;
    source:
      | "ui_dump"
      | "vision_ocr"
      | "vision_diff"
      | "scene_grounding"
      | "foreground";
    success: boolean;
    durationMs: number;
    evidencePath?: string;
  }> = [];
  if (screenshot.exitCode !== 0) {
    issues.push(`Final screenshot capture failed: ${screenshot.exitCode}.`);
  }
  for (const oracle of options.plan.finalOracles) {
    if (oracle.type === "text_visible") {
      let visible = false;
      if (screenshot.exitCode === 0) {
        const ocr = await runVisionOcr({
          imagePath: screenshotPath,
          outputDir: options.outputDir,
        });
        visible = matchesVisibleTextOracle(ocr.texts, oracle.value);
        oracleResults.push({
          oracle: `text_visible:${oracle.value}`,
          source: "vision_ocr",
          success: visible,
          durationMs: ocr.durationMs,
          evidencePath: ocr.outputPath,
        });
      }
      if (!visible) {
        issues.push(`Expected text is not visible: ${oracle.value}.`);
      }
      continue;
    }
    if (oracle.type === "ui_text_visible") {
      const uiDumpStarted = performance.now();
      const uiDumpPath = join(options.outputDir, "final.ui.json");
      const dump = await runCommand(buildMobilecliUiDumpCommand(options.udid));
      await writeFile(uiDumpPath, dump.stdout, "utf8");
      const elements = dump.exitCode === 0 ? parseUiDump(dump.stdout) : [];
      const visible = elements.some((element) =>
        [element.text, element.label, element.value].some((value) =>
          normalizeComparableText(value ?? "").includes(
            normalizeComparableText(oracle.value),
          ),
        ),
      );
      oracleResults.push({
        oracle: `ui_text_visible:${oracle.value}`,
        source: "ui_dump",
        success: visible,
        durationMs: elapsed(uiDumpStarted),
        evidencePath: uiDumpPath,
      });
      if (!visible) {
        issues.push(`Expected UI text is not visible: ${oracle.value}.`);
      }
      continue;
    }
    if (oracle.type === "visual_changed") {
      const visualStarted = performance.now();
      const evidencePath = join(options.outputDir, "visual-change.json");
      let score: number | null = null;
      if (options.baselineScreenshotPath && screenshot.exitCode === 0) {
        score = await compareScreenshotSsim(
          options.baselineScreenshotPath,
          screenshotPath,
        );
      }
      const changed = score !== null && score <= oracle.maximumSsim;
      await writeJsonAtomic(evidencePath, {
        baselineScreenshotPath: options.baselineScreenshotPath,
        finalScreenshotPath: screenshotPath,
        ssim: score,
        maximumSsim: oracle.maximumSsim,
        changed,
      });
      oracleResults.push({
        oracle: `visual_changed:ssim<=${oracle.maximumSsim}`,
        source: "vision_diff",
        success: changed,
        durationMs: elapsed(visualStarted),
        evidencePath,
      });
      if (!changed) {
        issues.push(
          `Expected visual change with SSIM <= ${oracle.maximumSsim}; got ${score ?? "unavailable"}.`,
        );
      }
      continue;
    }
    if (oracle.type === "scene_current") {
      const sceneStarted = performance.now();
      const grounding = await captureAndGround({
        graph: options.graph,
        expectedSceneId: oracle.sceneId,
        udid: options.udid,
        outputDir: join(options.outputDir, "scene-current"),
        prefix: safeSegment(oracle.sceneId),
      });
      const matched = grounding.matchedSceneId === oracle.sceneId;
      const evidencePath = join(
        options.outputDir,
        "scene-current",
        `${safeSegment(oracle.sceneId)}.json`,
      );
      await writeJsonAtomic(evidencePath, grounding);
      oracleResults.push({
        oracle: `scene_current:${oracle.sceneId}`,
        source: "scene_grounding",
        success: matched,
        durationMs: elapsed(sceneStarted),
        evidencePath,
      });
      if (!matched) {
        issues.push(
          `Expected current Scene ${oracle.sceneId}; matched ${grounding.matchedSceneId ?? "nothing"}.`,
        );
      }
      continue;
    }
    if (oracle.type === "text_absent") {
      const absentStarted = performance.now();
      let absent = false;
      let evidencePath: string | undefined;
      if (screenshot.exitCode === 0) {
        const ocr = await runVisionOcr({
          imagePath: screenshotPath,
          outputDir: options.outputDir,
        });
        evidencePath = ocr.outputPath;
        absent = !ocr.texts.some((text) =>
          normalizeComparableText(text).includes(
            normalizeComparableText(oracle.value),
          ),
        );
      }
      oracleResults.push({
        oracle: `text_absent:${oracle.value}`,
        source: "vision_ocr",
        success: absent,
        durationMs: elapsed(absentStarted),
        evidencePath,
      });
      if (!absent) {
        issues.push(`Expected text is still visible: ${oracle.value}.`);
      }
      continue;
    }
    const foregroundStarted = performance.now();
    const foreground = await runCommand(
      buildMobilecliForegroundCommand(options.udid),
    );
    const foregroundMatches = !(
      foreground.exitCode !== 0 ||
      !`${foreground.stdout}\n${foreground.stderr}`.includes(oracle.bundleId)
    );
    oracleResults.push({
      oracle: `foreground_bundle:${oracle.bundleId}`,
      source: "foreground",
      success: foregroundMatches,
      durationMs: elapsed(foregroundStarted),
    });
    if (!foregroundMatches) {
      issues.push(`Foreground app is not ${oracle.bundleId}.`);
    }
  }
  return {
    success: issues.length === 0,
    issues,
    screenshotPath,
    oracleResults,
    durationMs: elapsed(started),
  };
}

export function matchesVisibleTextOracle(
  texts: readonly string[],
  value: string,
): boolean {
  const expectedTexts = value
    .split(/\s*&&\s*|\s+且\s+/)
    .map(normalizeComparableText)
    .filter(Boolean);
  const normalizedTexts = texts.map(normalizeComparableText);
  return (
    expectedTexts.length > 0 &&
    expectedTexts.every((expected) =>
      normalizedTexts.some((text) => text.includes(expected)),
    )
  );
}

async function compareScreenshotSsim(
  baselinePath: string,
  finalPath: string,
): Promise<number | null> {
  const result = await runCommand([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "info",
    "-i",
    baselinePath,
    "-i",
    finalPath,
    "-lavfi",
    "ssim",
    "-f",
    "null",
    "-",
  ]);
  if (result.exitCode !== 0) {
    return null;
  }
  const match = result.stderr.match(/All:([0-9.]+)/);
  return match ? Number(match[1]) : null;
}

async function runVisionOcr(options: {
  imagePath: string;
  outputDir: string;
  outputFileName?: string;
}): Promise<{
  texts: string[];
  outputPath: string;
  durationMs: number;
}> {
  const started = performance.now();
  const binaryPath = join(
    DEFAULT_ARTIFACT_ROOT,
    "ios-ui-graph-experiment",
    "vision-ocr",
  );
  if (!(await Bun.file(binaryPath).exists())) {
    const compile = await runCommand([
      "swiftc",
      "-O",
      VISION_OCR_SOURCE_PATH,
      "-o",
      binaryPath,
      "-framework",
      "Vision",
      "-framework",
      "AppKit",
    ]);
    if (compile.exitCode !== 0) {
      throw new Error(`Vision OCR compile failed: ${compile.stderr}`);
    }
  }
  const result = await runCommand([binaryPath, options.imagePath]);
  if (result.exitCode !== 0) {
    throw new Error(`Vision OCR failed: ${result.stderr}`);
  }
  const outputPath = join(
    options.outputDir,
    options.outputFileName ?? "final.ocr.json",
  );
  await writeFile(outputPath, result.stdout, "utf8");
  const observations = JSON.parse(result.stdout) as Array<{ text?: string }>;
  return {
    texts: observations
      .map((observation) => observation.text?.trim())
      .filter((text): text is string => Boolean(text)),
    outputPath,
    durationMs: elapsed(started),
  };
}

function normalizeComparableText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replaceAll(/[\s\u00a0，。、“”"'`~!！?？:：;；._\-<>＜＞〈〉《》›»]+/g, "");
}

export async function runTimedCommand(options: {
  stepId: string;
  command: readonly string[];
  outputDir: string;
  cwd: string;
}): Promise<TimedExperimentCommand> {
  await mkdir(options.outputDir, { recursive: true });
  const safeStep = safeSegment(options.stepId);
  const stdoutPath = join(options.outputDir, `${safeStep}.stdout.txt`);
  const stderrPath = join(options.outputDir, `${safeStep}.stderr.txt`);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = await runCommand(options.command, options.cwd);
  const durationMs = elapsed(started);
  const finishedAt = new Date().toISOString();
  await Promise.all([
    writeFile(stdoutPath, result.stdout, "utf8"),
    writeFile(stderrPath, result.stderr, "utf8"),
  ]);
  return {
    stepId: options.stepId,
    command: options.command,
    startedAt,
    finishedAt,
    durationMs,
    exitCode: result.exitCode,
    stdoutPath,
    stderrPath,
  };
}

export function parseStrictRestartResult(output: string): {
  bundleId: string;
  oldPids: number[];
  terminatedPids: number[];
  newPid: number;
  currentPids: number[];
  success: true;
} {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  const numberArray = (value: unknown, field: string): number[] => {
    if (
      !Array.isArray(value) ||
      value.some((item) => !Number.isInteger(item) || Number(item) <= 0)
    ) {
      throw new Error(`Strict restart returned invalid ${field}.`);
    }
    return value.map(Number);
  };
  const oldPids = numberArray(parsed.oldPids, "oldPids");
  const terminatedPids = numberArray(parsed.terminatedPids, "terminatedPids");
  const currentPids = numberArray(parsed.currentPids, "currentPids");
  const newPid = Number(parsed.newPid);
  const bundleId = typeof parsed.bundleId === "string" ? parsed.bundleId : "";
  if (
    parsed.schemaVersion !== "ios-ui-devicectl-restart/v1" ||
    parsed.success !== true ||
    !bundleId ||
    !Number.isInteger(newPid) ||
    newPid <= 0 ||
    oldPids.includes(newPid) ||
    !currentPids.includes(newPid) ||
    oldPids.some((pid) => currentPids.includes(pid)) ||
    JSON.stringify([...oldPids].sort((a, b) => a - b)) !==
      JSON.stringify([...terminatedPids].sort((a, b) => a - b))
  ) {
    throw new Error("Strict restart did not prove a new app process.");
  }
  return {
    bundleId,
    oldPids,
    terminatedPids,
    newPid,
    currentPids,
    success: true,
  };
}

export function parseWaitLaunchResult(output: string): {
  bundleId: string;
  oldPids: number[];
  newPid: number;
  currentPids: number[];
  success: true;
} {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  const numberArray = (value: unknown, field: string): number[] => {
    if (
      !Array.isArray(value) ||
      value.some((item) => !Number.isInteger(item) || Number(item) <= 0)
    ) {
      throw new Error(`Restart-and-relaunch returned invalid ${field}.`);
    }
    return value.map(Number);
  };
  const oldPids = numberArray(parsed.oldPids, "oldPids");
  const currentPids = numberArray(parsed.currentPids, "currentPids");
  const newPid = Number(parsed.newPid);
  const bundleId = typeof parsed.bundleId === "string" ? parsed.bundleId : "";
  if (
    parsed.schemaVersion !== "ios-ui-devicectl-wait-launch/v1" ||
    parsed.success !== true ||
    !bundleId ||
    oldPids.length === 0 ||
    !Number.isInteger(newPid) ||
    newPid <= 0 ||
    oldPids.includes(newPid) ||
    !currentPids.includes(newPid) ||
    oldPids.some((pid) => currentPids.includes(pid))
  ) {
    throw new Error(
      "Restart-and-relaunch did not prove old-process exit and new-process launch.",
    );
  }
  return {
    bundleId,
    oldPids,
    newPid,
    currentPids,
    success: true,
  };
}

export async function executeStrictResetStrategy(options: {
  strategy: ExperimentResetStrategy;
  udid: string;
  outputDir: string;
  cwd: string;
  commands: TimedExperimentCommand[];
  stepPrefix: string;
}): Promise<void> {
  const lifecycleBundles = [
    ...new Set(
      options.strategy.steps
        .filter(
          (
            step,
          ): step is Extract<
            ExperimentResetStrategy["steps"][number],
            { type: "terminate_app" | "launch_app" }
          > => step.type === "terminate_app" || step.type === "launch_app",
        )
        .map((step) => step.bundleId),
    ),
  ];
  if (lifecycleBundles.length !== 1) {
    throw new Error(
      `Strict Reset requires exactly one lifecycle bundle; got ${lifecycleBundles.join(", ")}.`,
    );
  }
  const restart = await runTimedCommand({
    stepId: `${options.stepPrefix}-strict-devicectl-restart`,
    command: [
      "python3",
      DEVICECTL_RESTART_SOURCE_PATH,
      "--device",
      options.udid,
      "--bundle-id",
      lifecycleBundles[0]!,
    ],
    outputDir: options.outputDir,
    cwd: options.cwd,
  });
  options.commands.push(restart);
  if (restart.exitCode !== 0) {
    throw new Error(
      `Strict devicectl restart failed with exit code ${restart.exitCode}. Diagnostics: ${restart.stderrPath}`,
    );
  }
  const restartOutput = await Bun.file(restart.stdoutPath).text();
  const proof = parseStrictRestartResult(restartOutput);
  if (proof.bundleId !== lifecycleBundles[0]) {
    throw new Error(
      `Strict restart returned bundle ${proof.bundleId}; expected ${lifecycleBundles[0]}.`,
    );
  }
  await writeJsonAtomic(
    join(options.outputDir, `${options.stepPrefix}-strict-restart-proof.json`),
    proof,
  );
  const settleMs = options.strategy.steps
    .filter(
      (
        step,
      ): step is Extract<
        ExperimentResetStrategy["steps"][number],
        { type: "wait" }
      > => step.type === "wait",
    )
    .reduce((total, step) => total + step.durationMs, 0);
  if (settleMs > 0) {
    const settle = await runTimedCommand({
      stepId: `${options.stepPrefix}-post-launch-settle`,
      command: ["sleep", formatSeconds(settleMs)],
      outputDir: options.outputDir,
      cwd: options.cwd,
    });
    options.commands.push(settle);
    if (settle.exitCode !== 0) {
      throw new Error(
        `Strict Reset settle failed with exit code ${settle.exitCode}.`,
      );
    }
  }
}

function interpolate(
  value: string,
  parameters: Readonly<Record<string, string>>,
): string {
  return value.replaceAll(
    /\$parameters\.([A-Za-z0-9_.-]+)/g,
    (_, name: string) => parameters[name] ?? "",
  );
}

function interpolateSelector(
  selector: ExperimentElement["selector"],
  parameters: Readonly<Record<string, string>>,
): ExperimentElement["selector"] {
  return Object.fromEntries(
    Object.entries(selector).map(([key, value]) => [
      key,
      value === undefined ? undefined : interpolate(value, parameters),
    ]),
  );
}

function selectorContainsParameter(
  selector: ExperimentElement["selector"],
): boolean {
  return Object.values(selector).some(
    (value) =>
      typeof value === "string" && /\$parameters\.[A-Za-z0-9_.-]+/.test(value),
  );
}

function elapsed(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}

function formatSeconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(3).replace(/\.?0+$/, "");
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function boundedNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function safeSegment(value: string): string {
  return (
    value.replaceAll(/[^A-Za-z0-9_.-]+/g, "-").replaceAll(/^-+|-+$/g, "") ||
    "item"
  );
}

function timestampForPath(): string {
  return new Date()
    .toISOString()
    .replaceAll(/[^0-9]/g, "")
    .slice(0, 14);
}
