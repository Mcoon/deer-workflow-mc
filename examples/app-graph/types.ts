import type { AgentFunction } from "@deerwork-ai/deer-workflow/agents";

import type { AppGraphAcceptInput } from "../app-graph-accept/types";
import type {
  AppGraphExecInput,
  AppGraphExecOutput,
} from "../app-graph-exec/types";
import type {
  AppGraphPlanInput,
  AppGraphPlanOutput,
  AppGraphPlanResult,
} from "../app-graph-plan/types";

export interface AppGraphWorkflowInput {
  readonly goal: string;
  readonly target?: AppGraphPlanInput["target"];
  readonly parameters?: Record<string, string>;
  readonly graphPath?: string;
  readonly projectRoot?: string;
  readonly agentCwd?: string;
  readonly udid?: string;
  readonly deviceProfileId?: string;
  readonly outputDir?: string;
  readonly planOnly?: boolean;
  readonly allowLearning?: boolean;
  readonly maximumRecoveryRounds?: number;
  readonly maxAgentRecoverySteps?: number;
  readonly minimumAgentConfidence?: number;
  readonly preferFastPath?: boolean;
  readonly model?: string;
  readonly agentTimeoutMs?: number;
  /** Test/runtime injection. CLI callers normally omit this. */
  readonly agentRunner?: AgentFunction;
  /** Test/host injection. CLI callers normally omit this. */
  readonly commandRunner?: AppGraphExecInput["commandRunner"];
}

export interface AppGraphWorkflowRound {
  readonly round: number;
  readonly planResult: AppGraphPlanOutput;
  readonly execResult?: AppGraphExecOutput;
}

export interface AppGraphWorkflowResult {
  readonly schemaVersion: "app-graph-workflow-result/v1";
  readonly success: boolean;
  readonly mode: "app_graph";
  readonly planOnly: boolean;
  readonly goal: string;
  readonly outputDir: string;
  readonly verdict: "plan_ready" | "pass";
  readonly rounds: readonly AppGraphWorkflowRound[];
  readonly finalPlan: AppGraphPlanResult;
  readonly finalExec?: AppGraphExecOutput;
  readonly graphUpdated: boolean;
  readonly resultPath: string;
  readonly evidencePaths: readonly string[];
  readonly totalDurationMs: number;
}

export interface AppGraphWorkflowFailure {
  readonly schemaVersion: "app-graph-workflow-failure/v1";
  readonly success: false;
  readonly mode: "app_graph_failure";
  readonly planOnly: boolean;
  readonly goal: string;
  readonly outputDir: string;
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly rounds: readonly AppGraphWorkflowRound[];
  readonly resultPath: string;
  readonly evidencePaths: readonly string[];
  readonly totalDurationMs: number;
}

export type AppGraphWorkflowOutput =
  AppGraphWorkflowResult | AppGraphWorkflowFailure;

export const meta = {
  name: "app-graph",
  description:
    "Single App Graph entry: Plan, execute, recover with goal-driven bounded Agent decisions, update Graph, and retry",
  phases: [
    { title: "Plan" },
    { title: "Execute" },
    { title: "Retry" },
    { title: "Output" },
  ],
  exampleArgs: {
    goal: "打开侧边栏",
    planOnly: true,
  },
};

// Keep shared input compatibility discoverable for case-driven callers.
export type AppGraphCaseInput = AppGraphAcceptInput;
