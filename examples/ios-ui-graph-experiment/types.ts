export type GraphEntityStatus =
  "observed" | "candidate" | "verified" | "stale" | "blocked" | "disabled";

export type ExperimentExecutionTier = "guarded" | "fast" | "quarantined";

export interface ExperimentExecutionTrust {
  readonly tier: ExperimentExecutionTier;
  readonly successfulExecutions: number;
  readonly failedExecutions: number;
  readonly consecutiveSuccessfulExecutions?: number;
  readonly consecutiveFailedExecutions?: number;
  readonly evidencePaths: readonly string[];
  readonly lastValidatedAt?: string;
  readonly lastFailedAt?: string;
  readonly lastValidatedAppVersion?: string;
  readonly lastFailure?: string;
}

export interface ReferenceAsset {
  readonly screenshotPath?: string;
  readonly uiDumpPath?: string;
  readonly recordPath?: string;
}

export interface ExperimentScene {
  readonly sceneId: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly status: GraphEntityStatus;
  readonly anchorElementIds: readonly string[];
  readonly visualTextAnchors?: readonly string[];
  readonly referenceAssets: readonly ReferenceAsset[];
  readonly stateVariants?: readonly {
    readonly title: string;
    readonly facts: readonly string[];
    readonly visualTextAnchors: readonly string[];
    readonly referenceAssets: readonly ReferenceAsset[];
  }[];
}

export interface ExperimentBinding {
  readonly bindingId: string;
  readonly deviceProfileId: string;
  readonly normalizedPoint: {
    readonly x: number;
    readonly y: number;
  };
  readonly source: "ui_dump" | "manual";
  readonly status: GraphEntityStatus;
  readonly reliability: number;
  readonly observedAt: string;
  readonly appVersion?: string;
}

export interface ExperimentSelector {
  readonly accessibilityId?: string;
  readonly label?: string;
  readonly text?: string;
  readonly value?: string;
  readonly role?: string;
}

export interface ExperimentElement {
  readonly elementId: string;
  readonly sceneId: string;
  readonly title: string;
  readonly semanticRole: string;
  readonly selector: ExperimentSelector;
  readonly selectorHistory?: readonly {
    readonly selector: ExperimentSelector;
    readonly observedAt: string;
    readonly appVersion?: string;
    readonly evidencePath?: string;
  }[];
  readonly bindings: readonly ExperimentBinding[];
}

export type ExperimentOperation =
  | {
      readonly type: "tap";
      readonly elementId: string;
    }
  | {
      readonly type: "input_text";
      readonly value: string;
    }
  | {
      readonly type: "long_press";
      readonly elementId: string;
      readonly durationMs: number;
    }
  | {
      readonly type: "tap_restart_app";
      readonly elementId: string;
      readonly bundleId: string;
    }
  | {
      readonly type: "swipe";
      readonly from: {
        readonly x: number;
        readonly y: number;
      };
      readonly to: {
        readonly x: number;
        readonly y: number;
      };
    };

export interface ExperimentOperator {
  readonly operatorId: string;
  readonly title: string;
  readonly fromSceneId: string;
  readonly toSceneId: string;
  readonly operation: ExperimentOperation;
  readonly settleMs: number;
  readonly risk:
    | "navigation"
    | "interaction"
    | "selection"
    | "permission"
    | "mutation"
    | "destructive";
  readonly status: GraphEntityStatus;
  readonly reliability: number;
  readonly preconditions?: readonly string[];
  readonly effects: readonly string[];
  readonly postconditions: readonly string[];
  readonly execution?: ExperimentExecutionTrust;
}

export interface ExperimentTask {
  readonly taskId: string;
  readonly title: string;
  readonly summary: string;
  readonly intents: readonly string[];
  readonly parameters: Readonly<
    Record<
      string,
      {
        readonly type: "string";
        readonly required: boolean;
      }
    >
  >;
  readonly entrySceneId: string;
  readonly operatorIds: readonly string[];
  readonly finalOracles: readonly (
    | {
        readonly type: "text_visible";
        readonly value: string;
      }
    | {
        readonly type: "text_absent";
        readonly value: string;
      }
    | {
        readonly type: "ui_text_visible";
        readonly value: string;
      }
    | {
        readonly type: "visual_changed";
        readonly maximumSsim: number;
      }
    | {
        readonly type: "foreground_bundle";
        readonly bundleId: string;
      }
    | {
        readonly type: "scene_current";
        readonly sceneId: string;
      }
  )[];
  readonly status: GraphEntityStatus;
  readonly verifier?: ExperimentVerifierSpec;
  readonly validation?: {
    readonly source:
      "dynamic_composition" | "targeted_discovery" | "user_correction";
    readonly sourceGoals: readonly string[];
    readonly successfulExecutions: number;
    readonly evidencePaths: readonly string[];
    readonly lastValidatedAt: string;
    readonly requiresFixtureReplay?: boolean;
    readonly completionEvidence?: readonly string[];
    readonly completionOracle?: Readonly<Record<string, string>>;
  };
}

export type ExperimentVerifierAssertion =
  | {
      readonly assertionId: string;
      readonly type: "all_text_visible";
      readonly values: readonly string[];
    }
  | {
      readonly assertionId: string;
      readonly type: "any_text_visible";
      readonly values: readonly string[];
    }
  | {
      readonly assertionId: string;
      readonly type: "text_absent";
      readonly value: string;
    }
  | {
      readonly assertionId: string;
      readonly type: "scene_current";
      readonly sceneId: string;
    }
  | {
      readonly assertionId: string;
      readonly type: "foreground_bundle";
      readonly bundleId: string;
    }
  | {
      readonly assertionId: string;
      readonly type: "region_stable";
      readonly values: readonly string[];
    };

export interface ExperimentVerifierSpec {
  readonly schemaVersion: "ios-ui-agent-verifier/v1";
  readonly status: "candidate" | "verified" | "stale";
  readonly source: "agent_compiled" | "deterministic_fallback";
  readonly assertions: readonly ExperimentVerifierAssertion[];
  readonly reason: string;
  readonly confidence: number;
  readonly successfulExecutions: number;
  readonly evidencePaths: readonly string[];
  readonly updatedAt: string;
}

export interface ExperimentVerifierEvaluation {
  readonly success: boolean;
  readonly classification:
    | "pass"
    | "oracle_stale"
    | "uncertain"
    | "path_failed"
    | "evidence_insufficient";
  readonly spec: ExperimentVerifierSpec;
  readonly assertionResults: readonly {
    readonly assertion: ExperimentVerifierAssertion;
    readonly success: boolean;
    readonly evidence: readonly string[];
  }[];
  readonly evidencePath: string;
}

export interface ExperimentResetStrategy {
  readonly strategyId: string;
  readonly entrySceneId: string;
  readonly steps: readonly (
    | {
        readonly type: "terminate_app" | "launch_app";
        readonly bundleId: string;
      }
    | {
        readonly type: "wait";
        readonly durationMs: number;
      }
  )[];
}

export interface ExecutableUiGraphExperiment {
  readonly schemaVersion: "ios-executable-ui-graph-experiment/v1";
  readonly graphId: string;
  readonly bundleId: string;
  readonly appName: string;
  readonly deviceProfiles: readonly {
    readonly profileId: string;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
  }[];
  readonly defaultDeviceProfileId: string;
  readonly defaultResetStrategyId: string;
  readonly resetStrategies: readonly ExperimentResetStrategy[];
  readonly scenes: readonly ExperimentScene[];
  readonly elements: readonly ExperimentElement[];
  readonly operators: readonly ExperimentOperator[];
  readonly tasks: readonly ExperimentTask[];
}

export interface CompiledExperimentStep {
  readonly stepId: string;
  readonly operatorId: string;
  readonly title: string;
  readonly operation: ExperimentOperation;
  readonly command: readonly string[];
  readonly expectedFromSceneId: string;
  readonly expectedToSceneId: string;
  readonly settleMs: number;
  readonly risk: ExperimentOperator["risk"];
  readonly executionTier: ExperimentExecutionTier;
  readonly bindingId?: string;
  readonly bindingSource?: ExperimentBinding["source"];
  readonly bindingReliability?: number;
  readonly requiresLiveResolution?: boolean;
  readonly liveResolutionRequired?: boolean;
  readonly resolvedElementSelector?: ExperimentSelector;
  readonly liveResolution?: {
    readonly matchedBy: "selector" | "agent" | "binding";
    readonly deviceProfileId: string;
    readonly selector?: ExperimentSelector;
    readonly normalizedPoint?: {
      readonly x: number;
      readonly y: number;
    };
    readonly evidencePath: string;
  };
}

export interface CompiledExperimentPlan {
  readonly schemaVersion: "ios-ui-graph-experiment-plan/v1";
  readonly graphId: string;
  readonly taskId: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly resetStrategy: ExperimentResetStrategy;
  readonly entrySceneId: string;
  readonly deviceProfileId: string;
  readonly appVersion?: string;
  readonly referenceAssets: readonly ReferenceAsset[];
  readonly steps: readonly CompiledExperimentStep[];
  readonly finalOracles: ExperimentTask["finalOracles"];
  readonly planningDurationMs: number;
}

export interface IosUiGraphExperimentInput {
  readonly graphPath?: string;
  readonly projectRoot?: string;
  readonly udid?: string;
  readonly taskId?: string;
  readonly sceneId?: string;
  readonly operatorId?: string;
  readonly goal?: string;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly deviceProfileId?: string;
  readonly outputDir?: string;
  readonly runId?: string;
  readonly planOnly?: boolean;
  readonly allowCandidate?: boolean;
  readonly includeReferenceAssetsInSemanticCards?: boolean;
  readonly planningIterations?: number;
  readonly evaluateAgentPlanning?: boolean;
  readonly minimumSemanticConfidence?: number;
  readonly maximumDiscoverySteps?: number;
  readonly agentTimeoutMs?: number;
  readonly replayDiscoveryResultPath?: string;
  readonly correction?: {
    readonly sourceResultPath: string;
    readonly feedback: string;
  };
  readonly appVersion?: string;
  readonly model?: string;
}

export interface TimedExperimentCommand {
  readonly stepId: string;
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface ExperimentGroundingResult {
  readonly matchedSceneId: string | null;
  readonly matchedBy:
    | "visual_text_anchors"
    | "reference_screenshot"
    | "ui_dump_anchors"
    | "unmatched";
  readonly screenshotPath?: string;
  readonly uiDumpPath?: string;
  readonly referenceScores?: readonly {
    readonly sceneId: string;
    readonly score: number;
    readonly referencePath: string;
  }[];
  readonly durationMs: number;
}

export interface ExperimentEntryRecovery {
  readonly fromSceneId: string | null;
  readonly targetSceneId: string;
  readonly operatorIds: readonly string[];
  readonly success: boolean;
  readonly durationMs: number;
  readonly issue?: string;
  readonly postRecoveryGrounding?: ExperimentGroundingResult;
}

export interface ExperimentComposedPathValidation {
  readonly success: boolean;
  readonly steps: readonly {
    readonly stepId: string;
    readonly operatorId: string;
    readonly expectedSceneId: string;
    readonly grounding: ExperimentGroundingResult;
    readonly success: boolean;
  }[];
}

/**
 * Structured failure details returned by the iOS UI Graph Workflow.
 *
 * @remarks
 * Business failures are returned as ordinary Workflow results instead of
 * being raised as process errors. Evidence paths point to persisted artifacts
 * that callers may use for diagnosis or recovery.
 */
export interface IosUiGraphWorkflowFailure {
  /** Stable machine-readable failure code. */
  readonly code: string;
  /** Workflow phase in which the failure occurred. */
  readonly stage: string;
  /** Human-readable diagnostic message. */
  readonly message: string;
  /** Whether retry, exploration, or another recovery action may succeed. */
  readonly recoverable: boolean;
  /** Persisted artifacts supporting the failure diagnosis. */
  readonly evidencePaths: readonly string[];
}

export interface IosUiGraphExperimentResult {
  readonly success: boolean;
  readonly planOnly: boolean;
  readonly outputDir: string;
  readonly graphPath: string;
  readonly goalResolutionPath: string;
  readonly planPath: string;
  readonly resultPath: string;
  readonly goalResolution: SemanticGoalResolution;
  readonly plan: CompiledExperimentPlan;
  readonly candidateTaskProposalPath?: string;
  readonly candidateTaskPatchPath?: string;
  readonly candidateReplayPatchPath?: string;
  readonly correctionPatchPath?: string;
  readonly taskVerifierPatchPath?: string;
  readonly executionLearningPatchPath?: string;
  readonly graphGapPath?: string;
  readonly discoveryPacketPath?: string;
  readonly reexplorationPacketPath?: string;
  readonly timings: {
    readonly loadMs: number;
    readonly resolveMs: number;
    readonly planMs: number;
    readonly benchmark: {
      readonly iterations: number;
      readonly totalMs: number;
      readonly meanMs: number;
      readonly p95Ms: number;
    };
    readonly preflightMs?: number;
    readonly resetMs?: number;
    readonly groundingMs?: number;
    readonly entryRecoveryMs?: number;
    readonly trustedCorridorMs?: number;
    readonly finalVerificationMs?: number;
    readonly totalExecutionMs?: number;
  };
  readonly initialGrounding?: ExperimentGroundingResult;
  readonly entryRecovery?: ExperimentEntryRecovery;
  readonly composedPathValidation?: ExperimentComposedPathValidation;
  readonly commands: readonly TimedExperimentCommand[];
  readonly agentPlanningEvaluation?: {
    readonly goal: string;
    readonly semanticOnly: AgentPlanningTrial;
    readonly withReferenceAssets: AgentPlanningTrial;
    readonly sameResolution: boolean | null;
    readonly conclusion: string;
  };
  readonly finalVerification?: {
    readonly success: boolean;
    readonly issues: readonly string[];
    readonly screenshotPath: string;
    readonly uiDumpPath?: string;
    readonly oracleResults: readonly {
      readonly oracle: string;
      readonly source:
        | "ui_dump"
        | "vision_ocr"
        | "vision_diff"
        | "scene_grounding"
        | "foreground";
      readonly success: boolean;
      readonly durationMs: number;
      readonly evidencePath?: string;
    }[];
    readonly durationMs: number;
  };
  readonly agentVerifier?: ExperimentVerifierEvaluation;
  readonly failure?: IosUiGraphWorkflowFailure;
}

export interface TargetedDiscoveryObservation {
  readonly observationId: string;
  readonly screenshotPath: string;
  readonly uiDumpPath: string;
  readonly ocrPath: string;
  readonly matchedSceneId: string | null;
  readonly candidateSceneId: string;
  readonly candidateSceneTitle: string;
  readonly visualTextAnchors: readonly string[];
  readonly candidates: readonly {
    readonly candidateId: string;
    readonly source: "ui_dump" | "vision_ocr";
    readonly role?: string;
    readonly accessibilityId?: string;
    readonly label?: string;
    readonly text?: string;
    readonly value?: string;
    readonly confidence?: number;
    readonly bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  }[];
}

export interface TargetedDiscoveryAction {
  readonly stepId: string;
  readonly purpose: "recover_entry" | "advance_goal";
  readonly actionType: "tap" | "long_press" | "swipe_left" | "swipe_right";
  readonly candidateId: string;
  readonly targetText: string;
  readonly targetElementTitle: string;
  readonly targetSemanticRole: string;
  readonly operatorTitle: string;
  readonly risk: ExperimentOperator["risk"];
  readonly expectedOutcome: string;
  readonly expectedSceneTitle: string;
  readonly expectedVisualTextAnchors: readonly string[];
  readonly command: readonly string[];
  readonly fromSceneId: string;
  readonly toSceneId: string;
  readonly beforeObservationId: string;
  readonly afterObservationId: string;
  readonly exitCode: number;
}

export interface IosUiTargetedDiscoveryResult {
  readonly success: boolean;
  readonly mode: "targeted_discovery";
  readonly outputDir: string;
  readonly graphPath: string;
  readonly graphGapPath: string;
  readonly discoveryPacketPath: string;
  readonly resultPath: string;
  readonly goalResolution: SemanticGoalResolution;
  readonly initialGrounding: ExperimentGroundingResult;
  readonly entryRecovery?: ExperimentEntryRecovery;
  readonly observations: readonly TargetedDiscoveryObservation[];
  readonly actions: readonly TargetedDiscoveryAction[];
  readonly commands: readonly TimedExperimentCommand[];
  readonly graphPatchPath?: string;
  readonly graphSynthesisProposalPath?: string;
  readonly graphSynthesisValidationPath?: string;
  readonly graphSynthesisMode?: "agent" | "deterministic_fallback";
  readonly candidateTaskId?: string;
  readonly completionEvidence: readonly string[];
  readonly completionOracle?: {
    readonly type:
      "text_absent" | "text_visible" | "scene_changed" | "region_stable";
    readonly value: string;
  };
  readonly issue?: string;
  readonly agentVerifier?: ExperimentVerifierEvaluation;
  readonly failure?: IosUiGraphWorkflowFailure;
}

/**
 * Fallback result returned when execution fails before a full plan or
 * Targeted Discovery result can be constructed.
 */
export interface IosUiGraphWorkflowFailureResult {
  /** Always `false` for this result variant. */
  readonly success: false;
  /** Discriminator for an early or unexpected Workflow failure. */
  readonly mode: "workflow_failure";
  /** Whether the caller requested planning without device execution. */
  readonly planOnly: boolean;
  /** Directory containing the persisted result and supporting artifacts. */
  readonly outputDir: string;
  /** Graph path requested by the caller. */
  readonly graphPath: string;
  /** Absolute path to the persisted JSON result. */
  readonly resultPath: string;
  /** Original natural-language goal, when supplied. */
  readonly goal: string;
  /** Commands captured before the failure. */
  readonly commands: readonly TimedExperimentCommand[];
  /** Structured failure diagnosis. */
  readonly failure: IosUiGraphWorkflowFailure;
  /** Persisted semantic resolution, when Resolve completed. */
  readonly goalResolutionPath?: string;
  /** Persisted Graph gap, when discovery is required. */
  readonly graphGapPath?: string;
  /** Persisted discovery handoff packet, when available. */
  readonly discoveryPacketPath?: string;
}

export interface AgentGoalResolution {
  readonly requestType: "reach_scene" | "execute_task";
  readonly targetId: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly confidence: number;
  readonly reason: string;
}

export interface SemanticGoalResolution {
  readonly mode:
    | "explicit_task"
    | "explicit_scene"
    | "explicit_operator"
    | "exact_intent"
    | "semantic_scene"
    | "agent_task"
    | "agent_composed"
    | "agent_discovery";
  readonly resolutionType:
    "verified_task" | "candidate_task" | "composed_path" | "discovery_required";
  readonly goal: string;
  readonly taskId?: string;
  readonly operatorIds?: readonly string[];
  readonly targetSceneId?: string;
  readonly proposedTaskTitle?: string;
  readonly desiredOutcome?: string;
  readonly knownFrontierSceneId?: string;
  readonly missingCapabilities?: readonly string[];
  readonly suggestedExplorationActions?: readonly string[];
  readonly parameters: Readonly<Record<string, string>>;
  readonly confidence: number;
  readonly reason: string;
  readonly durationMs: number;
  readonly promptBytes?: number;
}

export interface AgentPlanningTrial {
  readonly status: "success" | "blocked";
  readonly includeReferenceAssets: boolean;
  readonly promptBytes: number;
  readonly durationMs: number;
  readonly resolution?: AgentGoalResolution;
  readonly error?: string;
}
