export type GraphEntityStatus =
  "observed" | "candidate" | "verified" | "stale" | "blocked" | "disabled";

export type ExecutionTier = "guarded" | "fast" | "quarantined";

export interface ExecutionStats {
  readonly pass: number;
  readonly fail: number;
  readonly lastExecutedAt?: string;
}

export interface ExecutionTrust {
  readonly tier: ExecutionTier;
  readonly successfulExecutions: number;
  readonly failedExecutions: number;
  readonly consecutiveSuccessfulExecutions: number;
  readonly consecutiveFailedExecutions: number;
  readonly evidencePaths: readonly string[];
  readonly lastValidatedAt?: string;
  readonly lastFailedAt?: string;
  readonly lastValidatedAppVersion?: string;
  readonly lastDeviceProfileId?: string;
  readonly lastFailure?: string;
}

export interface ReferenceAsset {
  /** Path relative to the Graph file for persisted assets. */
  readonly screenshot: string;
  /** Path relative to the Graph file for persisted assets. */
  readonly uiDump: string;
  /** Path relative to the Graph file for persisted assets. */
  readonly ocr?: string;
}

export interface SelectorEntry {
  readonly type:
    "accessibilityIdentifier" | "label" | "role" | "text" | "value";
  readonly value: string;
}

export interface Binding {
  readonly deviceProfileId: string;
  readonly normalizedPoint: { readonly x: number; readonly y: number };
  readonly source: "ui_dump" | "agent_inferred" | "manual";
  readonly status: GraphEntityStatus;
  readonly observedAt?: string;
  readonly appVersion?: string;
  readonly execution?: ExecutionTrust;
}

export interface Element {
  readonly elementId: string;
  readonly title: string;
  readonly semanticRole: string;
  readonly status: GraphEntityStatus;
  readonly effectiveVersion?: string;
  readonly expiredVersion?: string;
  readonly selectors: readonly SelectorEntry[];
  readonly bindings: Record<string, Binding>;
}

export interface Scene {
  readonly sceneId: string;
  readonly parentSceneId: string | null;
  readonly foregroundBundleId?: string;
  readonly status: GraphEntityStatus;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly visualTextAnchors: readonly string[];
  readonly effectiveVersion?: string;
  readonly expiredVersion?: string;
  readonly referenceAssets: readonly ReferenceAsset[];
  readonly elements: Record<string, Element>;
}

export interface StructuredEffect {
  readonly type: "state_change" | "scene_change" | "ui_change";
  readonly key: string;
  readonly value: string | number | boolean;
}

export interface Operation {
  readonly type:
    "tap" | "long_press" | "swipe" | "input_text" | "tap_restart_app";
  readonly elementId?: string;
  readonly durationMs?: number;
  readonly value?: string;
  readonly from?: { readonly x: number; readonly y: number };
  readonly to?: { readonly x: number; readonly y: number };
  readonly bundleId?: string;
}

export interface Operator {
  readonly operatorId: string;
  readonly fromSceneId: string;
  readonly toSceneId: string | null;
  readonly operation: Operation;
  readonly effects: readonly StructuredEffect[];
  readonly status: GraphEntityStatus;
  readonly executionStats: ExecutionStats;
  readonly execution?: ExecutionTrust;
  readonly risk?:
    | "navigation"
    | "interaction"
    | "selection"
    | "permission"
    | "mutation"
    | "destructive";
  readonly settleMs?: number;
}

export interface TaskStep {
  readonly operatorId: string;
  readonly params?: Record<string, string>;
  readonly skipIf?: {
    readonly key: string;
    readonly op: string;
    readonly value: unknown;
  };
}

export interface TaskOracle {
  readonly type:
    | "text_visible"
    | "text_absent"
    | "ui_text_visible"
    | "ui_text_absent"
    | "visual_changed"
    | "foreground_bundle"
    | "scene_current";
  readonly value?: string;
  readonly sceneId?: string;
  readonly bundleId?: string;
  readonly maximumSsim?: number;
}

export interface Task {
  readonly taskId: string;
  readonly intents: readonly string[];
  readonly entrySceneId: string;
  readonly steps: readonly TaskStep[];
  readonly finalOracles: readonly TaskOracle[];
  readonly status: GraphEntityStatus;
  readonly parameters?: Record<
    string,
    { readonly type: string; readonly required: boolean }
  >;
  readonly validation?: {
    readonly source: "declared" | "runtime_composition" | "targeted_discovery";
    readonly sourceGoals: readonly string[];
    readonly tier: ExecutionTier;
    readonly successfulExecutions: number;
    readonly failedExecutions: number;
    readonly consecutiveSuccessfulExecutions: number;
    readonly consecutiveFailedExecutions: number;
    readonly evidencePaths: readonly string[];
    readonly lastValidatedAt?: string;
    readonly lastFailedAt?: string;
    readonly lastValidatedAppVersion?: string;
    readonly lastDeviceProfileId?: string;
    readonly lastFailure?: string;
    readonly requiresFixtureReplay?: boolean;
  };
}

export interface DeviceProfile {
  readonly profileId: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface ResetStrategy {
  readonly strategyId: string;
  readonly entrySceneId: string;
  readonly steps: readonly ResetStep[];
}

export type ResetStep =
  | { readonly type: "terminate_app"; readonly bundleId: string }
  | { readonly type: "launch_app"; readonly bundleId: string }
  | { readonly type: "wait"; readonly durationMs: number };

export interface AppGraph {
  readonly schemaVersion: "ios-executable-ui-graph/v2";
  readonly graphId: string;
  readonly bundleId: string;
  readonly appName?: string;
  readonly appVersion?: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly deviceProfiles: Record<string, DeviceProfile>;
  readonly defaultDeviceProfileId: string;
  readonly defaultResetStrategyId: string;
  readonly resetStrategies: readonly ResetStrategy[];
  readonly scenes: Record<string, Scene>;
  readonly operators: Record<string, Operator>;
  readonly tasks: Record<string, Task>;
}

export interface GraphPatch {
  readonly schemaVersion: "ios-ui-graph-patch/v2";
  readonly graphId: string;
  readonly baseRevision: number;
  readonly source: "discovery" | "navigator" | "manual";
  readonly scenes?: Record<string, Partial<Scene> & { sceneId: string }>;
  readonly operators?: Record<
    string,
    Partial<Operator> & { operatorId: string }
  >;
  readonly tasks?: Record<string, Partial<Task> & { taskId: string }>;
  readonly evidencePaths?: readonly string[];
}

export interface PatchValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface PatchResult {
  readonly success: boolean;
  readonly newRevision: number;
  readonly conflicts?: readonly string[];
  readonly rejected?: readonly string[];
}

export interface RouteStep {
  readonly operatorId: string;
  readonly fromSceneId: string;
  readonly toSceneId: string | null;
  readonly operation: Operation;
}
