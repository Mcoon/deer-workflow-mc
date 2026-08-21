export type TraceEntryKind =
  | "workflow:event"
  | "workflow:input"
  | "workflow:result"
  | "workflow:error"
  | "command:start"
  | "command:end"
  | "agent:start"
  | "agent:end";

export interface TraceEntry {
  readonly schemaVersion: "deer-workflow-trace-entry/v1";
  readonly traceId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly elapsedMs: number;
  readonly kind: TraceEntryKind;
  readonly workflowId?: string;
  readonly operationId?: string;
  readonly payload: unknown;
}

export interface TraceOptions {
  readonly rootDirectory?: string;
  readonly maximumTextCharacters?: number;
}

export interface TraceArtifacts {
  readonly traceId: string;
  readonly outputDirectory: string;
  readonly tracePath: string;
  readonly summaryPath: string;
  readonly htmlPath: string;
  readonly resultPath?: string;
  readonly status: "success" | "failure" | "error";
}

export interface CommandTraceResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
