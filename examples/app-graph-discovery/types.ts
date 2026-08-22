import type { AgentFunction } from "@deerwork-ai/deer-workflow/agents";

import type { UiElement } from "../ios-regression-kit/types";

export interface AppGraphDiscoveryInput {
  readonly graphPath?: string;
  readonly discoveryRequestPath?: string;
  readonly goal?: string;
  readonly projectRoot?: string;
  readonly agentCwd?: string;
  readonly udid?: string;
  readonly outputDir?: string;
  readonly planOnly?: boolean;
  /** Internal handoff: the caller already navigated and grounded the start Scene. */
  readonly skipReset?: boolean;
  readonly startSceneId?: string;
  readonly startElementId?: string;
  /** Explicit stale-Scene recovery may probe the historical focus Element. */
  readonly allowStaleFocus?: boolean;
  /** Expected stale Scene that must be observed before recovery is persisted. */
  readonly expectedSceneId?: string;
  readonly maxDepth?: number;
  readonly maxActions?: number;
  readonly model?: string;
  readonly agentTimeoutMs?: number;
  readonly maxAgentRecoverySteps?: number;
  readonly minimumAgentConfidence?: number;
  /** Test/runtime injection. CLI callers normally omit this. */
  readonly agentRunner?: AgentFunction;
}

export interface AppGraphDiscoveryRequest {
  readonly schemaVersion: "app-graph-discovery-request/v1";
  readonly goal: string;
  readonly graphIdentity?: {
    readonly graphId: string;
    readonly revision: number;
  };
  readonly startSceneId?: string;
  readonly focusElementId?: string;
  readonly failure?: string;
  readonly evidencePaths: readonly string[];
}

export interface DiscoveryPlan {
  readonly schemaVersion: "app-graph-discovery-plan/v1";
  readonly graphId: string;
  readonly graphRevision: number;
  readonly goal: string;
  readonly requestPath?: string;
  readonly startSceneId: string;
  readonly focusElementId?: string;
  readonly allowStaleFocus?: boolean;
  readonly expectedSceneId?: string;
  readonly candidates: readonly {
    readonly elementId: string;
    readonly title: string;
    readonly semanticRole: string;
    readonly status: string;
    readonly selectors: readonly {
      readonly type: string;
      readonly value: string;
    }[];
    readonly operatorIds: readonly string[];
    readonly allowedActions: readonly ("tap" | "long_press" | "swipe")[];
  }[];
  readonly budgets: { readonly maxDepth: number; readonly maxActions: number };
  readonly evidencePaths: readonly string[];
}

export interface DiscoveryElement {
  readonly elementId: string;
  readonly accessibilityId: string;
  readonly label: string;
  readonly text: string;
  readonly value: string;
  readonly role: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DiscoveryObservation {
  readonly sceneId: string;
  readonly screenshotPath: string;
  readonly uiDumpPath: string;
  readonly foregroundPath?: string;
  readonly foregroundBundleId?: string;
  readonly elements: readonly DiscoveryElement[];
  /** Raw recursive UI dump elements used for stability and bounded Agent recovery. */
  readonly uiElements?: readonly UiElement[];
  readonly timestamp: string;
}

export interface AppGraphDiscoveryResult {
  readonly success: boolean;
  readonly mode: "discovery";
  readonly planOnly: boolean;
  readonly outputDir: string;
  readonly graphPath: string;
  readonly discoveryPlanPath: string;
  readonly discoveryRequestPath?: string;
  readonly startSceneId?: string;
  readonly scenesDiscovered: number;
  readonly elementsDiscovered: number;
  readonly operatorsDiscovered: number;
  readonly actionsExecuted: number;
  readonly visibilityActionsExecuted?: number;
  readonly focusElementId?: string;
  readonly focusElementTitle?: string;
  readonly expectedSceneId?: string;
  readonly observedSceneIds?: readonly string[];
  readonly totalDurationMs: number;
  readonly patchPath?: string;
  readonly graphRevision: number;
  readonly graphUpdated: boolean;
  readonly evidencePaths: readonly string[];
  readonly stabilityPath?: string;
  readonly agentUsed?: boolean;
  readonly agentDiagnosticPath?: string;
  readonly issue?: string;
}

export interface AppGraphDiscoveryFailure {
  readonly success: false;
  readonly mode: "discovery_failure";
  readonly outputDir: string;
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly evidencePaths: readonly string[];
  readonly stabilityPath?: string;
  readonly agentUsed?: boolean;
  readonly agentDiagnosticPath?: string;
  readonly visibilityActionsExecuted?: number;
  readonly focusElementId?: string;
  readonly focusElementTitle?: string;
  readonly expectedSceneId?: string;
}

export type AppGraphDiscoveryOutput =
  AppGraphDiscoveryResult | AppGraphDiscoveryFailure;

export const meta = {
  name: "app-graph-discovery",
  description:
    "Probe one explicit goal-relevant Element and expand the App UI Graph from observed evidence",
  phases: [
    { title: "Load" },
    { title: "Preflight" },
    { title: "Reset" },
    { title: "Ground" },
    { title: "Explore" },
    { title: "Synthesize" },
    { title: "Output" },
  ],
  exampleArgs: {
    goal: "打开侧边栏",
    startSceneId: "chat.detail",
    startElementId: "chat.sidebar_entry",
  },
};
