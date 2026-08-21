import type {
  GraphEntityStatus,
  RouteStep,
  SelectorEntry,
  StructuredEffect,
  Task,
  TaskOracle,
} from "../ios-ui-graph-manager/types";

export interface AppGraphPlanInput {
  readonly goal: string;
  readonly target?: {
    readonly kind: "task" | "scene" | "operator";
    readonly id: string;
  };
  readonly graphPath?: string;
  readonly deviceProfileId?: string;
  readonly udid?: string;
  readonly outputDir?: string;
  readonly planOnly?: boolean;
  readonly parameters?: Record<string, string>;
}

export interface ResolvedStep {
  readonly stepId: string;
  readonly operatorId: string;
  readonly operatorStatus: GraphEntityStatus;
  readonly fromSceneId: string;
  readonly toSceneId: string | null;
  readonly risk:
    | "navigation"
    | "interaction"
    | "selection"
    | "permission"
    | "mutation"
    | "destructive";
  readonly operation: {
    readonly type: string;
    readonly elementId?: string;
    readonly value?: string;
    readonly durationMs?: number;
    readonly from?: { readonly x: number; readonly y: number };
    readonly to?: { readonly x: number; readonly y: number };
    readonly bundleId?: string;
  };
  readonly normalizedPoint?: { readonly x: number; readonly y: number };
  readonly bindingStatus: "verified" | "candidate" | "missing";
  readonly elementTitle?: string;
  readonly semanticRole?: string;
  readonly skipIf?: {
    readonly key: string;
    readonly op: string;
    readonly value: unknown;
  };
  /** Complete semantic context. Coordinates remain only a runtime acceleration hint. */
  readonly fromScene: ResolvedSceneContext;
  readonly action: ResolvedAction;
  readonly targetElement?: ResolvedElementTarget;
  readonly binding: ResolvedBinding;
  readonly resolutionPolicy: ElementResolutionPolicy;
  readonly expectedOutcome: ExpectedStepOutcome;
}

export type AppGraphPlanResolutionType =
  "matched_task" | "matched_scene" | "matched_operator" | "unresolved";

export interface ResolvedSceneContext {
  readonly sceneId: string;
  readonly title: string;
  readonly status: GraphEntityStatus;
  readonly aliases: readonly string[];
  readonly anchors: readonly string[];
  readonly foregroundBundleId?: string;
}

export interface ResolvedAction {
  readonly type: string;
  readonly description: string;
  readonly effects: readonly StructuredEffect[];
  readonly settleMs: number;
}

export interface ResolvedElementTarget {
  readonly elementId: string;
  readonly title: string;
  readonly semanticRole: string;
  readonly status: GraphEntityStatus;
  readonly selectors: readonly SelectorEntry[];
  readonly selectorTemplate: readonly SelectorEntry[];
  readonly locationHint?: {
    readonly region:
      | "top_left"
      | "top_center"
      | "top_right"
      | "middle_left"
      | "center"
      | "middle_right"
      | "bottom_left"
      | "bottom_center"
      | "bottom_right";
    readonly description: string;
    readonly sourceDeviceProfileId?: string;
  };
}

export interface ResolvedBinding {
  readonly deviceProfileId: string;
  readonly status: "verified" | "candidate" | "missing";
  readonly normalizedPoint?: { readonly x: number; readonly y: number };
  readonly source?: "ui_dump" | "agent_inferred" | "manual";
  readonly observedAt?: string;
}

export interface ElementResolutionPolicy {
  readonly preferred: "live_selector";
  readonly selectorPriority: readonly SelectorEntry["type"][];
  readonly allowAgentVisualResolution: boolean;
  readonly allowBindingFallback: boolean;
  readonly liveResolutionRequired: boolean;
  readonly reason: string;
}

export interface ExpectedStepOutcome {
  readonly scene: ResolvedSceneContext | null;
  readonly effects: readonly StructuredEffect[];
}

export interface AppGraphPlanResult {
  readonly schemaVersion: "app-graph-semantic-plan/v2";
  readonly success: true;
  readonly mode: "plan";
  readonly planOnly: boolean;
  readonly outputDir: string;
  readonly goal: string;
  readonly resolutionType: AppGraphPlanResolutionType;
  readonly resolution: {
    readonly kind: "task" | "scene" | "operator" | "none";
    readonly id?: string;
    readonly title?: string;
    readonly confidence: number;
    readonly matchedText?: string;
  };
  readonly matchedTaskId?: string;
  readonly matchedTask?: Task;
  readonly matchedOperatorId?: string;
  readonly entrySceneId: string;
  readonly entryScene: ResolvedSceneContext;
  readonly targetSceneId?: string;
  readonly targetScene?: ResolvedSceneContext;
  /** Navigation needed before the requested Task or target Scene. */
  readonly navigationRoute: readonly RouteStep[];
  /** Declared Task steps before semantic compilation. Empty for Scene plans. */
  readonly taskSteps: readonly {
    readonly operatorId: string;
    readonly params?: Record<string, string>;
    readonly skipIf?: {
      readonly key: string;
      readonly op: string;
      readonly value: unknown;
    };
  }[];
  /** Backward-compatible alias for navigationRoute. */
  readonly route: readonly RouteStep[];
  readonly resolvedSteps: readonly ResolvedStep[];
  readonly finalOracles: readonly TaskOracle[];
  readonly parameters: Record<string, string>;
  readonly deviceProfileId: string;
  readonly planningMs: number;
  readonly graphIdentity: {
    readonly graphId: string;
    readonly schemaVersion: "ios-executable-ui-graph/v2";
    readonly revision: number;
    readonly updatedAt: string;
    readonly appVersion?: string;
  };
  readonly graphRevision: number;
  readonly planPath: string;
  readonly issue?: string;
}

export interface AppGraphPlanFailure {
  readonly schemaVersion: "app-graph-semantic-plan-failure/v1";
  readonly success: false;
  readonly mode: "plan_failure";
  readonly outputDir: string;
  readonly goal: string;
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly evidencePaths: readonly string[];
}

export type AppGraphPlanOutput = AppGraphPlanResult | AppGraphPlanFailure;

export const meta = {
  name: "app-graph-plan",
  description:
    "Semantic goal → coordinate-optional execution plan with Scene, Element, selector, binding, and outcome context",
  phases: [
    { title: "Load" },
    { title: "Resolve Goal" },
    { title: "Plan Route" },
    { title: "Resolve Bindings" },
    { title: "Output" },
  ],
  exampleArgs: {
    goal: "打开侧边栏",
    planOnly: true,
  },
};
