import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { WorkflowEvent } from "../events";
import { renderTraceHtml } from "./render";
import { sanitizeCommand, sanitizeTraceValue } from "./sanitize";
import type {
  CommandTraceResult,
  TraceArtifacts,
  TraceEntry,
  TraceEntryKind,
  TraceOptions,
} from "./types";

const DEFAULT_TRACE_ROOT = "/tmp/ios_perf-opt/deer-workflow-traces";
const DEFAULT_MAX_TEXT = 100_000;

export class TraceRecorder {
  readonly traceId = crypto.randomUUID();
  readonly outputDirectory: string;
  readonly tracePath: string;
  readonly summaryPath: string;
  readonly htmlPath: string;
  readonly #startedAt = performance.now();
  readonly #maximumTextCharacters: number;
  readonly #entries: TraceEntry[] = [];
  readonly #workflowScript: string;
  #sequence = 0;
  #resultPath: string | undefined;

  constructor(workflowScript: string, options: TraceOptions = {}) {
    this.#workflowScript = resolve(workflowScript);
    this.#maximumTextCharacters =
      options.maximumTextCharacters ?? DEFAULT_MAX_TEXT;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = basename(workflowScript).replace(/\.[^.]+$/, "");
    this.outputDirectory = resolve(
      options.rootDirectory ?? DEFAULT_TRACE_ROOT,
      `${timestamp}-${name}-${this.traceId.slice(0, 8)}`,
    );
    this.tracePath = join(this.outputDirectory, "trace.jsonl");
    this.summaryPath = join(this.outputDirectory, "summary.json");
    this.htmlPath = join(this.outputDirectory, "trace.html");
  }

  async initialize(input: unknown): Promise<void> {
    await mkdir(this.outputDirectory, { recursive: true });
    await writeFile(this.tracePath, "", "utf8");
    this.record("workflow:input", {
      scriptPath: this.#workflowScript,
      input,
    });
  }

  recordWorkflowEvent(event: WorkflowEvent): void {
    this.record("workflow:event", event, { workflowId: event.workflowId });
  }

  record(
    kind: TraceEntryKind,
    payload: unknown,
    options?: { workflowId?: string; operationId?: string },
  ): TraceEntry {
    const entry: TraceEntry = {
      schemaVersion: "deer-workflow-trace-entry/v1",
      traceId: this.traceId,
      sequence: ++this.#sequence,
      timestamp: new Date().toISOString(),
      elapsedMs: performance.now() - this.#startedAt,
      kind,
      workflowId: options?.workflowId,
      operationId: options?.operationId,
      payload: sanitizeTraceValue(payload, this.#maximumTextCharacters),
    };
    this.#entries.push(entry);
    appendFileSync(this.tracePath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  recordCommandStart(options: {
    operationId: string;
    command: readonly string[];
    cwd: string;
    workflowId?: string;
  }): void {
    this.record(
      "command:start",
      {
        command: sanitizeCommand(options.command),
        cwd: options.cwd,
      },
      { operationId: options.operationId, workflowId: options.workflowId },
    );
  }

  recordCommandEnd(options: {
    operationId: string;
    durationMs: number;
    result?: CommandTraceResult;
    error?: unknown;
    workflowId?: string;
  }): void {
    this.record("command:end", options, {
      operationId: options.operationId,
      workflowId: options.workflowId,
    });
  }

  recordAgentStart(options: {
    operationId: string;
    runtime: string;
    prompt: string;
    model?: string;
    cwd?: string;
    sandbox?: string;
    schema?: unknown;
    workflowId?: string;
  }): void {
    this.record("agent:start", options, {
      operationId: options.operationId,
      workflowId: options.workflowId,
    });
  }

  recordAgentEnd(options: {
    operationId: string;
    runtime: string;
    durationMs: number;
    response?: unknown;
    error?: unknown;
    workflowId?: string;
  }): void {
    this.record("agent:end", options, {
      operationId: options.operationId,
      workflowId: options.workflowId,
    });
  }

  async finalizeSuccess(result: unknown): Promise<TraceArtifacts> {
    this.#resultPath = join(this.outputDirectory, "result.json");
    await writeFile(
      this.#resultPath,
      JSON.stringify(
        sanitizeTraceValue(result, this.#maximumTextCharacters),
        null,
        2,
      ),
      "utf8",
    );
    this.record("workflow:result", { result, resultPath: this.#resultPath });
    return this.#finalize(
      resultIndicatesFailure(result) ? "failure" : "success",
    );
  }

  async finalizeError(error: unknown): Promise<TraceArtifacts> {
    this.record("workflow:error", {
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    });
    return this.#finalize("error");
  }

  async #finalize(
    status: "success" | "failure" | "error",
  ): Promise<TraceArtifacts> {
    const commandDurationMs = this.#entries
      .filter((entry) => entry.kind === "command:end")
      .reduce(
        (total, entry) => total + numericField(entry.payload, "durationMs"),
        0,
      );
    const agentDurationMs = this.#entries
      .filter((entry) => entry.kind === "agent:end")
      .reduce(
        (total, entry) => total + numericField(entry.payload, "durationMs"),
        0,
      );
    const phaseDurationsMs: Record<string, number> = {};
    for (const entry of this.#entries.filter(
      (candidate) => candidate.kind === "workflow:event",
    )) {
      const payload = objectValue(entry.payload);
      if (payload?.type !== "workflow:phase:end") continue;
      const phase =
        typeof payload.phase === "string" ? payload.phase : "unknown";
      phaseDurationsMs[phase] =
        (phaseDurationsMs[phase] ?? 0) +
        (typeof payload.durationMs === "number" ? payload.durationMs : 0);
    }
    const summary = {
      schemaVersion: "deer-workflow-trace-summary/v1",
      traceId: this.traceId,
      status,
      workflowScript: this.#workflowScript,
      startedAt: this.#entries[0]?.timestamp,
      finishedAt: new Date().toISOString(),
      totalDurationMs: performance.now() - this.#startedAt,
      entryCount: this.#entries.length,
      workflowEventCount: this.#entries.filter(
        (entry) => entry.kind === "workflow:event",
      ).length,
      commandCount: this.#entries.filter(
        (entry) => entry.kind === "command:start",
      ).length,
      agentCallCount: this.#entries.filter(
        (entry) => entry.kind === "agent:start",
      ).length,
      commandDurationMs,
      agentDurationMs,
      phaseDurationsMs,
      tracePath: this.tracePath,
      resultPath: this.#resultPath,
      htmlPath: this.htmlPath,
    };
    await writeFile(this.summaryPath, JSON.stringify(summary, null, 2), "utf8");
    await writeFile(
      this.htmlPath,
      renderTraceHtml({
        traceId: this.traceId,
        status,
        entries: this.#entries,
        summary,
      }),
      "utf8",
    );
    await writeFile(
      this.tracePath,
      `${this.#entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    return {
      traceId: this.traceId,
      outputDirectory: this.outputDirectory,
      tracePath: this.tracePath,
      summaryPath: this.summaryPath,
      htmlPath: this.htmlPath,
      resultPath: this.#resultPath,
      status,
    };
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numericField(value: unknown, field: string): number {
  const candidate = objectValue(value)?.[field];
  return typeof candidate === "number" ? candidate : 0;
}

function resultIndicatesFailure(result: unknown): boolean {
  const value = objectValue(result);
  return value?.success === false;
}
