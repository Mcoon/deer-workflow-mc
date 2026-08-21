import type { AppGraphPlanResult } from "../app-graph-plan/types";
import type { AgentFunction } from "@deerwork-ai/deer-workflow/agents";

export interface AppGraphExecInput {
  readonly goal: string;
  readonly plan: AppGraphPlanResult;
  readonly graphPath?: string;
  readonly projectRoot?: string;
  readonly agentCwd?: string;
  readonly udid?: string;
  readonly deviceProfileId?: string;
  readonly outputDir?: string;
  readonly planOnly?: boolean;
  /** Internal retry handoff: preserve the current foreground/UI state. */
  readonly skipReset?: boolean;
  readonly maxSteps?: number;
  readonly allowLearning?: boolean;
  readonly model?: string;
  readonly agentTimeoutMs?: number;
  readonly maxAgentRecoverySteps?: number;
  readonly minimumAgentConfidence?: number;
  /** Prefer a learned verified fast recipe when all trust gates match. */
  readonly preferFastPath?: boolean;
  /** Test/runtime injection. CLI callers normally omit this. */
  readonly agentRunner?: AgentFunction;
  /** Test/host injection. CLI callers normally omit this. */
  readonly commandRunner?: (
    command: readonly string[],
    cwd?: string,
  ) => Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
  }>;
}

export interface ExecStepRecord {
  readonly stepIndex: number;
  readonly operatorId: string;
  readonly action: string;
  readonly actionDescription: string;
  readonly targetElementId?: string;
  readonly normalizedPoint?: { readonly x: number; readonly y: number };
  readonly resolutionSource:
    | "live_selector"
    | "visual_semantic"
    | "agent_selector"
    | "binding_fallback"
    | "operation"
    | "unresolved";
  readonly commands: readonly (readonly string[])[];
  readonly visibilityRecoveryCommands?: readonly (readonly string[])[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly success: boolean;
  readonly error?: string;
  readonly screenshotPath?: string;
  readonly uiDumpPath?: string;
  readonly ocrPath?: string;
  readonly perceivedSceneId?: string;
  readonly perceivedSceneTitle?: string;
  readonly agentUsed: boolean;
  readonly bindingUsed:
    | "verified"
    | "candidate"
    | "selector"
    | "visual"
    | "agent"
    | "operation"
    | "missing";
  readonly expectedSceneId?: string;
  readonly outcomeVerified: boolean;
}

export interface AppGraphExecResult {
  readonly success: boolean;
  readonly mode: "exec";
  readonly planOnly: boolean;
  readonly outputDir: string;
  readonly goal: string;
  readonly matchedTaskId?: string;
  readonly verdict: "pass" | "fail" | "needs_review" | "blocked";
  readonly verdictReason: string;
  readonly executionMode?: "fast" | "guarded";
  readonly fastFallbackUsed?: boolean;
  readonly steps: readonly ExecStepRecord[];
  readonly totalDurationMs: number;
  readonly graphRevision: number;
  readonly planSchemaVersion: AppGraphPlanResult["schemaVersion"];
  readonly planPath: string;
  readonly finalOracleResults: readonly FinalOracleResult[];
  readonly recoveryActions: readonly RuntimeRecoveryActionRecord[];
  readonly graphUpdated: boolean;
  readonly graphPatchPaths: readonly string[];
  readonly learningPatchPath?: string;
  readonly discoveryRequestPath?: string;
  readonly evidencePaths: readonly string[];
}

export interface RuntimeRecoveryActionRecord {
  readonly recoveryIndex: number;
  readonly reason:
    "graph_route" | "scene_unknown" | "route_missing" | "route_failed";
  readonly goal: string;
  readonly expectedSceneId: string;
  readonly sourceSceneId: string;
  readonly targetSceneId: string;
  readonly candidateId: string;
  readonly candidateTitle: string;
  readonly actionType:
    | "tap"
    | "long_press"
    | "none"
    | "swipe_up"
    | "swipe_down"
    | "swipe_left"
    | "swipe_right";
  readonly command: readonly string[];
  readonly agentReason: string;
  readonly confidence: number;
  readonly beforeScreenshotPath: string;
  readonly beforeUiDumpPath: string;
  readonly afterScreenshotPath: string;
  readonly afterUiDumpPath: string;
  readonly success: boolean;
  readonly error?: string;
}

export interface FinalOracleResult {
  readonly type: string;
  readonly supported: boolean;
  readonly success: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface AppGraphExecFailure {
  readonly success: false;
  readonly mode: "exec_failure";
  readonly outputDir: string;
  readonly goal: string;
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly evidencePaths: readonly string[];
  readonly partialSteps?: readonly ExecStepRecord[];
  readonly discoveryRequestPath?: string;
  readonly recoveryActions?: readonly RuntimeRecoveryActionRecord[];
  readonly graphUpdated?: boolean;
  readonly graphPatchPaths?: readonly string[];
}

export type AppGraphExecOutput = AppGraphExecResult | AppGraphExecFailure;

export const meta = {
  name: "app-graph-exec",
  description: "Execute a resolved plan step by step with result determination",
  phases: [
    { title: "Load" },
    { title: "Preflight" },
    { title: "Reset" },
    { title: "Ground" },
    { title: "Execute Steps" },
    { title: "Verify" },
    { title: "Learn" },
    { title: "Output" },
  ],
  exampleArgs: {
    goal: "发一条消息说你好",
  },
};
