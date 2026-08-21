import type { WorkflowEvent } from "@deerwork-ai/deer-workflow/events";

export type GraphConsoleTargetKind = "scene" | "element" | "operator" | "task";

export interface GraphConsoleTarget {
  readonly kind: GraphConsoleTargetKind;
  readonly id: string;
}

export interface GraphConsoleActionRequest {
  readonly action: "plan" | "execute" | "explore" | "recover";
  readonly target: GraphConsoleTarget;
  /** User intent that constrains execution or the single targeted probe. */
  readonly goal?: string;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly graphRevision?: string;
  readonly confirmed?: boolean;
  /** Connected iOS device selected for execution or exploration. */
  readonly udid?: string;
}

export interface GraphConsoleDevice {
  readonly id: string;
  readonly name: string;
  readonly platform: "ios";
  readonly type: "real";
  readonly version: string;
  readonly state: string;
  readonly model: string;
}

export interface GraphConsoleChatRequest {
  readonly message: string;
  readonly target?: GraphConsoleTarget;
  readonly graphRevision?: string;
}

export interface GraphConsoleCorrectionChange {
  readonly entityKind: "scene" | "task";
  readonly entityId: string;
  readonly field: "title" | "aliases" | "intents" | "status";
  readonly value: string | readonly string[];
  readonly reason: string;
}

export interface GraphConsoleCorrectionProposal {
  readonly schemaVersion: "ios-ui-graph-correction-proposal/v1";
  readonly proposalId: string;
  readonly graphRevision: string;
  readonly summary: string;
  readonly evidencePaths: readonly string[];
  readonly changes: readonly GraphConsoleCorrectionChange[];
  readonly requiresExploration: boolean;
  readonly explorationGoal: string;
  readonly createdAt: string;
}

export interface GraphConsoleChatResponse {
  readonly kind:
    | "explain"
    | "plan"
    | "execute"
    | "explore"
    | "recover"
    | "correction_proposal";
  readonly message: string;
  readonly target?: GraphConsoleTarget;
  readonly action?: GraphConsoleActionRequest["action"];
  /** Suggested goal for an Agent-proposed targeted exploration. */
  readonly goal?: string;
  readonly proposal?: GraphConsoleCorrectionProposal;
}

export type GraphConsoleRunStatus =
  "queued" | "running" | "succeeded" | "failed";

export interface GraphConsoleRunEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: "run" | "workflow";
  readonly status?: GraphConsoleRunStatus;
  readonly message?: string;
  readonly workflowEvent?: WorkflowEvent;
}

export interface GraphConsoleRun {
  readonly runId: string;
  readonly status: GraphConsoleRunStatus;
  readonly request: GraphConsoleActionRequest;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly outputDir: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly events: readonly GraphConsoleRunEvent[];
}

export interface GraphConsoleServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly graphPath?: string;
  readonly mapDirectory?: string;
  readonly artifactRoot?: string;
  readonly udid?: string;
  readonly deviceProfileId?: string;
  readonly planWorkflowPath?: string;
  readonly execWorkflowPath?: string;
  readonly appGraphWorkflowPath?: string;
  readonly discoveryWorkflowPath?: string;
  readonly agentCwd?: string;
  readonly model?: string;
  readonly agentTimeoutMs?: number;
  readonly deviceScanner?: () => Promise<readonly GraphConsoleDevice[]>;
}
