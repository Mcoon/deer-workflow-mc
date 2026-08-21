import type {
  ExecutableUiGraphExperiment,
  GraphEntityStatus,
} from "../ios-ui-graph-experiment/types";

export interface IosUiGraphDiscoveryModule {
  readonly moduleId: string;
  readonly title: string;
  readonly seedGoals: readonly string[];
  readonly allowedScenePrefixes?: readonly string[];
}

export interface IosUiGraphDiscoveryInput {
  readonly graphPath?: string;
  readonly projectRoot?: string;
  readonly udid?: string;
  readonly runId?: string;
  readonly outputDir?: string;
  readonly resumeStatePath?: string;
  readonly modules?: readonly IosUiGraphDiscoveryModule[];
  readonly planOnly?: boolean;
  readonly maximumFrontiers?: number;
  readonly maximumQueuedFrontiers?: number;
  readonly maximumNewScenes?: number;
  readonly maximumDurationMinutes?: number;
  readonly maximumAttemptsPerFrontier?: number;
  readonly maximumDiscoveryStepsPerGoal?: number;
  readonly agentTimeoutMs?: number;
  readonly model?: string;
}

export type IosUiGraphDiscoveryFrontierStatus =
  "pending" | "running" | "completed" | "failed" | "blocked" | "skipped";

export interface IosUiGraphDiscoveryFrontier {
  readonly frontierId: string;
  readonly moduleId: string;
  readonly goal: string;
  readonly source: "seed" | "observation";
  readonly sourceSceneId?: string;
  readonly sourceObservationId?: string;
  readonly priority: number;
  readonly status: IosUiGraphDiscoveryFrontierStatus;
  readonly attempts: number;
  readonly continuationCount?: number;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly workerOutputDir?: string;
  readonly resultPath?: string;
  readonly resolvedTaskId?: string;
  readonly issue?: string;
}

export interface IosUiGraphSnapshot {
  readonly capturedAt: string;
  readonly sceneCount: number;
  readonly elementCount: number;
  readonly operatorCount: number;
  readonly taskCount: number;
  readonly sceneStatusCounts: Readonly<Record<GraphEntityStatus, number>>;
  readonly operatorStatusCounts: Readonly<Record<GraphEntityStatus, number>>;
  readonly taskStatusCounts: Readonly<Record<GraphEntityStatus, number>>;
}

export interface IosUiGraphDiscoveryState {
  readonly schemaVersion: "ios-ui-graph-discovery-state/v1";
  readonly runId: string;
  readonly graphPath: string;
  readonly status: "ready" | "running" | "paused" | "completed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessionCount: number;
  readonly modules: readonly IosUiGraphDiscoveryModule[];
  readonly budgets: {
    readonly maximumFrontiers: number;
    readonly maximumQueuedFrontiers: number;
    readonly maximumNewScenes: number;
    readonly maximumDurationMinutes: number;
    readonly maximumAttemptsPerFrontier: number;
    readonly maximumDiscoveryStepsPerGoal: number;
    readonly agentTimeoutMs: number;
  };
  readonly baseline: IosUiGraphSnapshot;
  readonly frontiers: readonly IosUiGraphDiscoveryFrontier[];
  readonly lastSession?: {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly processedFrontiers: number;
    readonly durationMs: number;
    readonly stopReason:
      | "plan_only"
      | "queue_empty"
      | "frontier_budget"
      | "scene_budget"
      | "duration_budget";
  };
}

export interface IosUiGraphDiscoveryCoverage {
  readonly schemaVersion: "ios-ui-graph-discovery-coverage/v1";
  readonly generatedAt: string;
  readonly graphPath: string;
  readonly baseline: IosUiGraphSnapshot;
  readonly current: IosUiGraphSnapshot;
  readonly delta: {
    readonly scenes: number;
    readonly elements: number;
    readonly operators: number;
    readonly tasks: number;
  };
  readonly frontiers: Readonly<
    Record<IosUiGraphDiscoveryFrontierStatus, number>
  >;
  readonly modules: readonly {
    readonly moduleId: string;
    readonly title: string;
    readonly totalFrontiers: number;
    readonly completedFrontiers: number;
    readonly pendingFrontiers: number;
    readonly blockedFrontiers: number;
    readonly failedFrontiers: number;
  }[];
}

export interface IosUiGraphDiscoveryResult {
  readonly success: boolean;
  readonly planOnly: boolean;
  readonly outputDir: string;
  readonly graphPath: string;
  readonly statePath: string;
  readonly manifestPath: string;
  readonly coveragePath: string;
  readonly graphDeltaPath: string;
  readonly reportPath: string;
  readonly state: IosUiGraphDiscoveryState;
  readonly coverage: IosUiGraphDiscoveryCoverage;
}

export type MutableDiscoveryState = {
  -readonly [
    Key in keyof IosUiGraphDiscoveryState
  ]: IosUiGraphDiscoveryState[Key];
};

export type DiscoveryWorkerGraph = ExecutableUiGraphExperiment;

export type IosUiCrawlerActionType =
  | "tap"
  | "long_press"
  | "swipe_left"
  | "swipe_right"
  | "swipe_up"
  | "swipe_down"
  | "drag_left"
  | "drag_right"
  | "drag_up"
  | "drag_down";

export type IosUiCrawlerFrontierStatus =
  "pending" | "running" | "completed" | "failed" | "blocked" | "skipped";

export interface IosUiCrawlerInput {
  readonly graphPath?: string;
  readonly projectRoot?: string;
  readonly udid?: string;
  readonly startSceneId?: string;
  readonly focusElementId?: string;
  readonly runId?: string;
  readonly outputDir?: string;
  readonly resumeStatePath?: string;
  readonly planOnly?: boolean;
  readonly evidenceMigrationOnly?: boolean;
  readonly maximumActions?: number;
  readonly maximumScenes?: number;
  readonly maximumDepth?: number;
  readonly maximumDurationMinutes?: number;
  readonly maximumAttemptsPerAction?: number;
  readonly maximumActionsPerScene?: number;
  readonly agentTimeoutMs?: number;
  readonly settleMs?: number;
  readonly refreshMap?: boolean;
  readonly mapHtmlPath?: string;
  readonly sceneIdPrefixes?: readonly string[];
  readonly model?: string;
}

export interface IosUiCrawlerSceneFrontier {
  readonly frontierId: string;
  readonly sceneId: string;
  readonly title: string;
  readonly depth: number;
  readonly status:
    "pending_scan" | "scanning" | "scanned" | "failed" | "blocked";
  readonly recoveryOperatorIds: readonly string[];
  readonly discoveredFromActionId?: string;
  readonly observationPath?: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly issue?: string;
}

export interface IosUiCrawlerElementTarget {
  readonly candidateId: string;
  readonly elementId: string;
  readonly title: string;
  readonly semanticRole: string;
  readonly source: "ui_dump" | "vision_ocr";
  readonly selector: {
    readonly accessibilityId?: string;
    readonly label?: string;
    readonly text?: string;
    readonly value?: string;
    readonly role?: string;
  };
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface IosUiCrawlerEffect {
  readonly type:
    | "new_scene"
    | "overlay"
    | "state_change"
    | "viewport_change"
    | "external_scene"
    | "no_effect";
  readonly fromSceneId: string;
  readonly toSceneId: string;
  readonly title: string;
  readonly visualTextAnchors: readonly string[];
  readonly stateFacts?: readonly string[];
  readonly description: string;
  readonly confidence: number;
}

export interface IosUiCrawlerActionFrontier {
  readonly frontierId: string;
  readonly sceneId: string;
  readonly sceneDepth: number;
  readonly recoveryOperatorIds: readonly string[];
  readonly target: IosUiCrawlerElementTarget;
  readonly actionType: IosUiCrawlerActionType;
  readonly risk:
    | "navigation"
    | "interaction"
    | "selection"
    | "permission"
    | "mutation"
    | "destructive";
  readonly expectedEffectType?:
    | "new_scene"
    | "overlay"
    | "state_change"
    | "viewport_change"
    | "external_scene"
    | "unknown";
  readonly expectedStateFacts?: readonly string[];
  readonly requiredStateFacts?: readonly string[];
  readonly undoHint?: string;
  readonly priority: number;
  readonly status: IosUiCrawlerFrontierStatus;
  readonly attempts: number;
  readonly continuationCount?: number;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly beforeObservationPath?: string;
  readonly afterObservationPath?: string;
  readonly operatorId?: string;
  readonly effect?: IosUiCrawlerEffect;
  readonly issue?: string;
}

export interface IosUiCrawlerState {
  readonly schemaVersion: "ios-ui-scene-crawler-state/v1";
  readonly runId: string;
  readonly graphPath: string;
  readonly status: "ready" | "running" | "paused" | "completed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessionCount: number;
  readonly entrySceneId: string;
  readonly budgets: {
    readonly maximumActions: number;
    readonly maximumScenes: number;
    readonly maximumDepth: number;
    readonly maximumDurationMinutes: number;
    readonly maximumAttemptsPerAction: number;
    readonly maximumActionsPerScene: number;
    readonly agentTimeoutMs: number;
    readonly settleMs: number;
  };
  readonly baseline: IosUiGraphSnapshot;
  readonly sceneFrontiers: readonly IosUiCrawlerSceneFrontier[];
  readonly actionFrontiers: readonly IosUiCrawlerActionFrontier[];
  readonly lastSession?: {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly scannedScenes: number;
    readonly executedActions: number;
    readonly durationMs: number;
    readonly stopReason:
      | "plan_only"
      | "queue_empty"
      | "action_budget"
      | "scene_budget"
      | "duration_budget";
  };
}

export interface IosUiCrawlerCoverage {
  readonly schemaVersion: "ios-ui-scene-crawler-coverage/v1";
  readonly generatedAt: string;
  readonly baseline: IosUiGraphSnapshot;
  readonly current: IosUiGraphSnapshot;
  readonly delta: {
    readonly scenes: number;
    readonly elements: number;
    readonly operators: number;
    readonly tasks: number;
  };
  readonly scenes: {
    readonly pending: number;
    readonly scanning: number;
    readonly scanned: number;
    readonly failed: number;
    readonly blocked: number;
  };
  readonly actions: Readonly<Record<IosUiCrawlerFrontierStatus, number>>;
  readonly actionTypeCounts: Readonly<Record<IosUiCrawlerActionType, number>>;
  readonly effectTypeCounts: Readonly<
    Record<IosUiCrawlerEffect["type"], number>
  >;
  readonly pageAudit: {
    readonly status: "complete" | "complete_with_blocks" | "incomplete";
    readonly covered: number;
    readonly templateCovered: number;
    readonly blocked: number;
    readonly gaps: number;
    readonly entries: readonly {
      readonly sceneId: string;
      readonly elementId: string;
      readonly title: string;
      readonly status: "covered" | "template_covered" | "blocked" | "gap";
      readonly reason: string;
      readonly operatorId?: string;
      readonly toSceneId?: string;
    }[];
  };
}

export interface IosUiCrawlerResult {
  readonly success: boolean;
  readonly planOnly: boolean;
  readonly outputDir: string;
  readonly graphPath: string;
  readonly statePath: string;
  readonly manifestPath: string;
  readonly coveragePath: string;
  readonly graphDeltaPath: string;
  readonly reportPath: string;
  readonly state: IosUiCrawlerState;
  readonly coverage: IosUiCrawlerCoverage;
}
