import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { agent } from "@deerwork-ai/deer-workflow/agents";
import type {
  AgentFunction,
  JsonSchema,
} from "@deerwork-ai/deer-workflow/agents";
import { WorkflowRunner } from "@deerwork-ai/deer-workflow/runner";
import { format } from "prettier";

import type {
  AppGraph,
  GraphEntityStatus,
  Scene,
  Task,
} from "../ios-ui-graph-manager/types";
import type { AppGraphPlanOutput } from "../app-graph-plan/types";
import type {
  GraphConsoleActionRequest,
  GraphConsoleChatRequest,
  GraphConsoleChatResponse,
  GraphConsoleCorrectionChange,
  GraphConsoleCorrectionProposal,
  GraphConsoleDevice,
  GraphConsoleRun,
  GraphConsoleRunEvent,
  GraphConsoleTarget,
} from "./types";

const SAFE_CORRECTION_STATUSES = new Set<GraphEntityStatus>([
  "candidate",
  "stale",
  "blocked",
  "disabled",
]);

const chatResponseSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [
        "explain",
        "plan",
        "execute",
        "explore",
        "recover",
        "correction_proposal",
      ],
    },
    message: { type: "string" },
    action: {
      type: "string",
      enum: ["", "plan", "execute", "explore", "recover"],
    },
    targetKind: {
      type: "string",
      enum: ["", "scene", "element", "operator", "task"],
    },
    targetId: { type: "string" },
    correctionSummary: { type: "string" },
    requiresExploration: { type: "boolean" },
    explorationGoal: { type: "string" },
    evidencePaths: { type: "array", items: { type: "string" } },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entityKind: { type: "string", enum: ["scene", "task"] },
          entityId: { type: "string" },
          field: {
            type: "string",
            enum: ["title", "aliases", "intents", "status"],
          },
          stringValue: { type: "string" },
          listValue: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: [
          "entityKind",
          "entityId",
          "field",
          "stringValue",
          "listValue",
          "reason",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "kind",
    "message",
    "action",
    "targetKind",
    "targetId",
    "correctionSummary",
    "requiresExploration",
    "explorationGoal",
    "evidencePaths",
    "changes",
  ],
  additionalProperties: false,
} satisfies JsonSchema;

interface AgentChatDecision {
  readonly kind:
    | "explain"
    | "plan"
    | "execute"
    | "explore"
    | "recover"
    | "correction_proposal";
  readonly message: string;
  readonly action: "" | "plan" | "execute" | "explore" | "recover";
  readonly targetKind: "" | GraphConsoleTarget["kind"];
  readonly targetId: string;
  readonly correctionSummary: string;
  readonly requiresExploration: boolean;
  readonly explorationGoal: string;
  readonly evidencePaths: readonly string[];
  readonly changes: readonly {
    readonly entityKind: "scene" | "task";
    readonly entityId: string;
    readonly field: GraphConsoleCorrectionChange["field"];
    readonly stringValue: string;
    readonly listValue: readonly string[];
    readonly reason: string;
  }[];
}

interface RunManagerOptions {
  readonly graphPath: string;
  readonly artifactRoot: string;
  readonly planWorkflowPath: string;
  readonly execWorkflowPath: string;
  readonly appGraphWorkflowPath: string;
  readonly discoveryWorkflowPath: string;
  readonly agentCwd?: string;
  readonly model?: string;
  readonly agentTimeoutMs?: number;
  readonly udid?: string;
  readonly deviceProfileId?: string;
  readonly deviceScanner?: () => Promise<readonly GraphConsoleDevice[]>;
  readonly onGraphChanged?: () => void;
  readonly runnerFactory?: () => WorkflowRunner;
}

type MutableRun = {
  -readonly [Key in keyof GraphConsoleRun]: Key extends "events"
    ? GraphConsoleRunEvent[]
    : GraphConsoleRun[Key];
};

export class GraphConsoleRunManager {
  readonly #options: RunManagerOptions;
  readonly #runs = new Map<string, MutableRun>();
  readonly #listeners = new Map<
    string,
    Set<(event: GraphConsoleRunEvent) => void>
  >();
  #queue: Promise<void> = Promise.resolve();

  constructor(options: RunManagerOptions) {
    this.#options = options;
  }

  async enqueue(request: GraphConsoleActionRequest): Promise<GraphConsoleRun> {
    const graph = await readGraph(this.#options.graphPath);
    const revision = await graphRevision(this.#options.graphPath);
    if (request.graphRevision && request.graphRevision !== revision) {
      throw new Error(
        "Graph changed after the page loaded. Refresh and retry.",
      );
    }
    const normalizedRequest = normalizeActionRequest(graph, request);
    validateActionRequest(graph, normalizedRequest);
    if (
      normalizedRequest.action !== "plan" &&
      !normalizedRequest.udid &&
      !this.#options.udid
    ) {
      throw new Error(
        "Execution and exploration require selecting an online iOS device.",
      );
    }
    const runId = `${timestampForPath()}-${randomUUID().slice(0, 8)}`;
    const outputDir = join(this.#options.artifactRoot, runId);
    const run: MutableRun = {
      runId,
      status: "queued",
      request: normalizedRequest,
      createdAt: new Date().toISOString(),
      outputDir,
      events: [],
    };
    this.#runs.set(runId, run);
    this.#emit(run, {
      type: "run",
      status: "queued",
      message: "Run queued behind the single-device lock.",
    });
    this.#queue = this.#queue
      .then(() => this.#execute(run))
      .catch(() => undefined);
    return cloneRun(run);
  }

  get(runId: string): GraphConsoleRun | undefined {
    const run = this.#runs.get(runId);
    return run ? cloneRun(run) : undefined;
  }

  async listDevices(): Promise<readonly GraphConsoleDevice[]> {
    const scan = this.#queue.then(() => this.#options.deviceScanner?.() ?? []);
    this.#queue = scan.then(
      () => undefined,
      () => undefined,
    );
    return scan;
  }

  subscribe(
    runId: string,
    listener: (event: GraphConsoleRunEvent) => void,
  ): () => void {
    const listeners = this.#listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#listeners.delete(runId);
      }
    };
  }

  async #execute(run: MutableRun): Promise<void> {
    run.status = "running";
    run.startedAt = new Date().toISOString();
    await mkdir(run.outputDir, { recursive: true });
    this.#emit(run, {
      type: "run",
      status: "running",
      message: "Run acquired the single-device lock.",
    });
    const runner =
      this.#options.runnerFactory?.() ??
      new WorkflowRunner({
        logWriter: () => undefined,
      });
    const removeListener = runner.on((event) => {
      this.#emit(run, {
        type: "workflow",
        workflowEvent: event,
      });
    });
    try {
      if (run.request.action !== "plan") {
        const udid = run.request.udid ?? this.#options.udid;
        if (!udid) {
          throw new Error(
            "Execution and exploration require selecting an online iOS device.",
          );
        }
        const devices = await this.#options.deviceScanner?.();
        if (devices && !devices.some((device) => device.id === udid)) {
          throw new Error(`Selected iOS device is not online: ${udid}.`);
        }
      }
      const result = await executeWorkflowChain(
        runner,
        run.request,
        this.#options,
        run.outputDir,
      );
      run.result = result;
      const successful =
        typeof result === "object" &&
        result !== null &&
        "success" in result &&
        (result as { success?: unknown }).success === true;
      run.status = successful ? "succeeded" : "failed";
      if (run.request.action === "explore" || successful) {
        this.#options.onGraphChanged?.();
      }
      this.#emit(run, {
        type: "run",
        status: run.status,
        message: successful
          ? workflowSuccessMessage(result)
          : workflowFailureMessage(result),
      });
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      this.#emit(run, {
        type: "run",
        status: "failed",
        message: run.error,
      });
    } finally {
      run.finishedAt = new Date().toISOString();
      removeListener();
      runner.dispose();
    }
  }

  #emit(
    run: MutableRun,
    event: Omit<GraphConsoleRunEvent, "sequence" | "timestamp">,
  ): void {
    const completed: GraphConsoleRunEvent = {
      sequence: run.events.length + 1,
      timestamp: new Date().toISOString(),
      ...event,
    };
    run.events.push(completed);
    for (const listener of this.#listeners.get(run.runId) ?? []) {
      listener(completed);
    }
  }
}

export function workflowSuccessMessage(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    return "Workflow completed successfully.";
  }
  const value = result as {
    mode?: unknown;
    actionsExecuted?: unknown;
    visibilityActionsExecuted?: unknown;
    focusElementTitle?: unknown;
    expectedSceneId?: unknown;
    observedSceneIds?: unknown;
    scenesDiscovered?: unknown;
    elementsDiscovered?: unknown;
    graphUpdated?: unknown;
    graphRevision?: unknown;
    finalExec?: {
      readonly graphUpdated?: unknown;
      readonly graphRevision?: unknown;
    };
    rounds?: readonly {
      readonly execResult?: {
        readonly graphUpdated?: unknown;
        readonly graphRevision?: unknown;
      };
    }[];
  };
  if (value.mode === "discovery") {
    const actions = Number(value.actionsExecuted ?? 0);
    const visibilityActions = Number(value.visibilityActionsExecuted ?? 0);
    const scenes = Number(value.scenesDiscovered ?? 0);
    const elements = Number(value.elementsDiscovered ?? 0);
    const revision =
      typeof value.graphRevision === "number"
        ? ` Graph r${value.graphRevision}.`
        : "";
    const target =
      typeof value.focusElementTitle === "string"
        ? ` Focus: ${value.focusElementTitle}.`
        : "";
    const reached = Array.isArray(value.observedSceneIds)
      ? value.observedSceneIds.filter(
          (sceneId): sceneId is string => typeof sceneId === "string",
        )
      : [];
    const destination =
      reached.length > 0
        ? ` Reached: ${reached.join(", ")}.`
        : typeof value.expectedSceneId === "string"
          ? ` Expected: ${value.expectedSceneId}.`
          : "";
    return `Exploration completed: ${actions} target action(s), ${visibilityActions} visibility action(s), ${scenes} target Scene(s), ${elements} new Element(s); Graph ${
      value.graphUpdated === true ? "updated" : "unchanged"
    }.${revision}${target}${destination}`;
  }
  const executionResults = [
    value,
    value.finalExec,
    ...(value.rounds ?? []).map((round) => round.execResult),
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));
  const graphUpdated = executionResults.some(
    (item) => item.graphUpdated === true,
  );
  const graphRevision = executionResults
    .map((item) => item.graphRevision)
    .find((revision) => typeof revision === "number");
  return graphUpdated
    ? `执行成功。Graph 已更新${typeof graphRevision === "number" ? `到 r${graphRevision}` : ""}，请刷新页面查看新的 Task、截图或 Binding。`
    : "执行成功。Graph 未变化，无需刷新。";
}

export function workflowFailureMessage(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    return "Workflow returned a failed result.";
  }
  const failure = result as {
    code?: unknown;
    message?: unknown;
    visibilityActionsExecuted?: unknown;
    focusElementTitle?: unknown;
    expectedSceneId?: unknown;
  };
  const message =
    typeof failure.message === "string" && failure.message.trim()
      ? failure.message.trim()
      : "Workflow returned a failed result.";
  const context =
    typeof failure.focusElementTitle === "string"
      ? ` Focus: ${failure.focusElementTitle}. Visibility actions: ${Number(
          failure.visibilityActionsExecuted ?? 0,
        )}.${
          typeof failure.expectedSceneId === "string"
            ? ` Expected: ${failure.expectedSceneId}.`
            : ""
        }`
      : "";
  const summary =
    typeof failure.code === "string" && failure.code.trim()
      ? `${failure.code.trim()}: ${message}`
      : message;
  return `${summary}${context}`;
}

export function workflowInvocation(
  request: GraphConsoleActionRequest,
  options: Pick<
    RunManagerOptions,
    | "graphPath"
    | "planWorkflowPath"
    | "execWorkflowPath"
    | "appGraphWorkflowPath"
    | "discoveryWorkflowPath"
    | "udid"
    | "deviceProfileId"
  >,
  outputDir: string,
): { readonly path: string; readonly args: Readonly<Record<string, unknown>> } {
  if (request.action === "execute") {
    throw new Error(
      "Execute requests must run through the unified App Graph Workflow.",
    );
  }
  if (request.action === "explore") {
    if (request.target.kind !== "element") {
      throw new Error(
        "Continue exploration requires one explicit Element target. Full-Scene exhaustive exploration is not allowed.",
      );
    }
    return {
      path: options.discoveryWorkflowPath,
      args: {
        graphPath: options.graphPath,
        outputDir,
        planOnly: false,
        goal: requestGoal(request),
        startElementId: request.target.id,
        maxActions: 1,
        maxDepth: 0,
        udid: request.udid ?? options.udid,
      },
    };
  }
  if (request.target.kind === "element") {
    throw new Error(
      "Element execution is ambiguous; select one of its Operator actions.",
    );
  }
  return {
    path: options.planWorkflowPath,
    args: {
      graphPath: options.graphPath,
      outputDir: join(outputDir, "plan"),
      goal: requestGoal(request),
      planOnly: true,
      parameters: request.parameters ?? {},
      deviceProfileId: options.deviceProfileId,
      target: { kind: request.target.kind, id: request.target.id },
    },
  };
}

async function executeWorkflowChain(
  runner: WorkflowRunner,
  request: GraphConsoleActionRequest,
  options: RunManagerOptions,
  outputDir: string,
): Promise<unknown> {
  if (request.action === "recover") {
    return executeStaleSceneRecoveryChain(runner, request, options, outputDir);
  }
  if (request.action === "explore") {
    return executeDiscoveryChain(runner, request, options, outputDir);
  }
  if (request.action === "execute") {
    return runner.run(options.appGraphWorkflowPath, {
      goal: requestGoal(request),
      target: { kind: request.target.kind, id: request.target.id },
      parameters: request.parameters ?? {},
      graphPath: options.graphPath,
      udid: request.udid ?? options.udid,
      deviceProfileId: options.deviceProfileId,
      outputDir,
      planOnly: false,
    });
  }
  const invocation = workflowInvocation(request, options, outputDir);
  return runner.run(invocation.path, invocation.args);
}

async function executeStaleSceneRecoveryChain(
  runner: WorkflowRunner,
  request: GraphConsoleActionRequest,
  options: RunManagerOptions,
  outputDir: string,
): Promise<unknown> {
  if (request.target.kind !== "scene") {
    throw new Error("Only a stale Scene can be recovered.");
  }
  const graph = await readGraph(options.graphPath);
  const targetScene = graph.scenes[request.target.id];
  if (!targetScene || targetScene.status !== "stale") {
    throw new Error(`Scene is not stale: ${request.target.id}.`);
  }
  const recoveryEntry = resolveStaleSceneRecoveryEntry(
    graph,
    targetScene.sceneId,
  );
  if (!recoveryEntry) {
    throw new Error(
      `No historical incoming Element can recover stale Scene ${targetScene.sceneId}.`,
    );
  }
  const sourceSceneId = recoveryEntry.sourceSceneId;
  const plan = (await runner.run(options.planWorkflowPath, {
    graphPath: options.graphPath,
    outputDir: join(outputDir, "entry-plan"),
    goal: sourceSceneId,
    planOnly: true,
    deviceProfileId: options.deviceProfileId,
    target: { kind: "scene", id: sourceSceneId },
  })) as AppGraphPlanOutput;
  if (!plan.success) return plan;
  const entryExec = await runner.run(options.execWorkflowPath, {
    goal: plan.goal,
    plan,
    graphPath: options.graphPath,
    outputDir: join(outputDir, "entry-exec"),
    planOnly: false,
    allowLearning: false,
    udid: request.udid ?? options.udid,
    deviceProfileId: options.deviceProfileId,
    agentCwd: options.agentCwd ?? process.cwd(),
    model: options.model,
    agentTimeoutMs: options.agentTimeoutMs ?? 60_000,
  });
  const entrySucceeded =
    typeof entryExec === "object" &&
    entryExec !== null &&
    "success" in entryExec &&
    (entryExec as { success?: unknown }).success === true;
  if (!entrySucceeded) return entryExec;
  return runner.run(options.discoveryWorkflowPath, {
    graphPath: options.graphPath,
    outputDir: join(outputDir, "recovery"),
    planOnly: false,
    goal: requestGoal(request),
    skipReset: true,
    startSceneId: sourceSceneId,
    startElementId: recoveryEntry.elementId,
    expectedSceneId: targetScene.sceneId,
    allowStaleFocus: true,
    maxActions: 1,
    maxDepth: 0,
    udid: request.udid ?? options.udid,
    agentCwd: options.agentCwd ?? process.cwd(),
    model: options.model,
    agentTimeoutMs: options.agentTimeoutMs ?? 60_000,
  });
}

export function resolveStaleSceneRecoveryEntry(
  graph: AppGraph,
  sceneId: string,
): { readonly sourceSceneId: string; readonly elementId: string } | undefined {
  const recoveryOperator = Object.values(graph.operators)
    .filter(
      (operator) =>
        operator.toSceneId === sceneId &&
        operator.fromSceneId !== sceneId &&
        Boolean(operator.operation.elementId) &&
        !["stale", "blocked", "disabled"].includes(
          graph.scenes[operator.fromSceneId]?.status ?? "disabled",
        ) &&
        Boolean(
          graph.scenes[operator.fromSceneId]?.elements[
            operator.operation.elementId!
          ],
        ),
    )
    .sort(
      (left, right) =>
        right.executionStats.pass - left.executionStats.pass ||
        left.operatorId.localeCompare(right.operatorId),
    )[0];
  return recoveryOperator?.operation.elementId
    ? {
        sourceSceneId: recoveryOperator.fromSceneId,
        elementId: recoveryOperator.operation.elementId,
      }
    : undefined;
}

async function executeDiscoveryChain(
  runner: WorkflowRunner,
  request: GraphConsoleActionRequest,
  options: RunManagerOptions,
  outputDir: string,
): Promise<unknown> {
  if (request.target.kind !== "element") {
    throw new Error(
      "Continue exploration requires one explicit Element target.",
    );
  }
  const graph = await readGraph(options.graphPath);
  const sceneId = findElementEntry(graph, request.target.id)?.sceneId;
  if (!sceneId) {
    throw new Error(
      `Cannot resolve the Scene for Element ${request.target.id}.`,
    );
  }
  const plan = (await runner.run(options.planWorkflowPath, {
    graphPath: options.graphPath,
    outputDir: join(outputDir, "entry-plan"),
    goal: sceneId,
    planOnly: true,
    deviceProfileId: options.deviceProfileId,
    target: { kind: "scene", id: sceneId },
  })) as AppGraphPlanOutput;
  if (!plan.success) return plan;
  const entryExec = await runner.run(options.execWorkflowPath, {
    goal: plan.goal,
    plan,
    graphPath: options.graphPath,
    outputDir: join(outputDir, "entry-exec"),
    planOnly: false,
    allowLearning: false,
    udid: request.udid ?? options.udid,
    deviceProfileId: options.deviceProfileId,
    agentCwd: options.agentCwd ?? process.cwd(),
    model: options.model,
    agentTimeoutMs: options.agentTimeoutMs ?? 60_000,
  });
  const entrySucceeded =
    typeof entryExec === "object" &&
    entryExec !== null &&
    "success" in entryExec &&
    (entryExec as { success?: unknown }).success === true;
  if (!entrySucceeded) return entryExec;
  return runner.run(options.discoveryWorkflowPath, {
    graphPath: options.graphPath,
    outputDir: join(outputDir, "discovery"),
    planOnly: false,
    goal: requestGoal(request),
    skipReset: true,
    startSceneId: sceneId,
    startElementId: request.target.id,
    maxActions: 1,
    maxDepth: 0,
    udid: request.udid ?? options.udid,
    agentCwd: options.agentCwd ?? process.cwd(),
    model: options.model,
    agentTimeoutMs: options.agentTimeoutMs ?? 60_000,
  });
}

export async function runGraphConsoleChat(options: {
  readonly graphPath: string;
  readonly request: GraphConsoleChatRequest;
  readonly proposalDirectory: string;
  readonly agentCwd: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly agentRunner?: AgentFunction;
}): Promise<GraphConsoleChatResponse> {
  const graph = await readGraph(options.graphPath);
  const revision = await graphRevision(options.graphPath);
  if (
    options.request.graphRevision &&
    options.request.graphRevision !== revision
  ) {
    throw new Error("Graph changed after the page loaded. Refresh and retry.");
  }
  const context = selectedGraphContext(graph, options.request.target);
  const prompt = [
    "You are the local iOS executable UI Graph console Agent.",
    "Classify the user's request as explain, plan, execute, explore, recover, or correction_proposal.",
    "Use only IDs present in the supplied context.",
    "Never invent Scene, Element, Operator, or Task IDs.",
    "A correction proposal may only change Scene title/aliases/status or Task intents/status.",
    "Never propose verified status. Structural path, selector, coordinate, element, operator, oracle, or binding changes require exploration instead.",
    "Use requiresExploration=true whenever evidence is insufficient or the request describes a structural UI/path problem.",
    "A stale Scene cannot be planned or executed normally. If the user wants to reach, validate, or retry a stale Scene, return kind=recover and action=recover for that Scene.",
    "Return only the schema-backed JSON.",
    "",
    `User message: ${options.request.message}`,
    `Selected context: ${JSON.stringify(context)}`,
  ].join("\n");
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const abortFromCaller = () => {
    controller.abort(
      options.signal?.reason ??
        new DOMException("Graph Agent request was cancelled.", "AbortError"),
    );
  };
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(
      new DOMException(
        `Graph Agent timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
        "TimeoutError",
      ),
    );
  }, timeoutMs);
  let decision: AgentChatDecision;
  try {
    decision = await (options.agentRunner ?? agent)<AgentChatDecision>(prompt, {
      cwd: options.agentCwd,
      model: options.model,
      sandbox: "read-only",
      schema: chatResponseSchema,
      env: { CODEX_HOME: undefined },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
  const target = normalizeAgentTarget(graph, decision);
  if (decision.kind !== "correction_proposal") {
    const staleTarget =
      target?.kind === "scene" && graph.scenes[target.id]?.status === "stale";
    const action = staleTarget
      ? "recover"
      : decision.action === "plan" ||
          decision.action === "execute" ||
          decision.action === "explore" ||
          decision.action === "recover"
        ? decision.action
        : undefined;
    return {
      kind: staleTarget ? "recover" : decision.kind,
      message: staleTarget
        ? `${decision.message} 该 Scene 已过期，需要先重新探索恢复，不能直接执行。`
        : decision.message,
      target,
      action,
      goal:
        action === "explore" || action === "recover"
          ? decision.explorationGoal.trim() || options.request.message.trim()
          : undefined,
    };
  }
  const changes = decision.changes.map(normalizeCorrectionChange);
  if (changes.length > 0) {
    validateCorrectionChanges(graph, changes);
  } else if (!decision.requiresExploration) {
    throw new Error(
      "A directly applicable correction proposal must contain at least one change.",
    );
  }
  const proposal: GraphConsoleCorrectionProposal = {
    schemaVersion: "ios-ui-graph-correction-proposal/v1",
    proposalId: randomUUID(),
    graphRevision: revision,
    summary: decision.correctionSummary || decision.message,
    evidencePaths: decision.evidencePaths.filter((path) =>
      path.startsWith("/tmp/ios_perf-opt/"),
    ),
    changes,
    requiresExploration: decision.requiresExploration,
    explorationGoal: decision.explorationGoal,
    createdAt: new Date().toISOString(),
  };
  await mkdir(options.proposalDirectory, { recursive: true });
  await writeJsonAtomic(
    join(options.proposalDirectory, `${proposal.proposalId}.json`),
    proposal,
  );
  return {
    kind: "correction_proposal",
    message: decision.message,
    target,
    proposal,
  };
}

export async function applyGraphCorrectionProposal(options: {
  readonly graphPath: string;
  readonly proposalPath: string;
  readonly backupDirectory: string;
}): Promise<{
  readonly graphRevision: string;
  readonly backupPath: string;
  readonly appliedChangeCount: number;
}> {
  const graph = await readGraph(options.graphPath);
  const proposal = JSON.parse(
    await Bun.file(options.proposalPath).text(),
  ) as GraphConsoleCorrectionProposal;
  const revision = await graphRevision(options.graphPath);
  if (proposal.graphRevision !== revision) {
    throw new Error(
      "Graph changed after this correction was proposed. Generate a new proposal.",
    );
  }
  if (proposal.requiresExploration) {
    throw new Error(
      "This proposal requires exploration and cannot be applied directly.",
    );
  }
  validateCorrectionChanges(graph, proposal.changes);
  const patched = applyCorrectionChanges(graph, proposal.changes);
  validateGraphReferences(patched);
  await mkdir(options.backupDirectory, { recursive: true });
  const backupPath = join(
    options.backupDirectory,
    `${timestampForPath()}-${revision.slice(0, 12)}.json`,
  );
  await writeFile(backupPath, await Bun.file(options.graphPath).text(), "utf8");
  await writeGraphAtomic(options.graphPath, patched);
  return {
    graphRevision: await graphRevision(options.graphPath),
    backupPath,
    appliedChangeCount: proposal.changes.length,
  };
}

export async function graphRevision(path: string): Promise<string> {
  return createHash("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest("hex");
}

export function validateActionRequest(
  graph: AppGraph,
  request: GraphConsoleActionRequest,
): void {
  assertTargetExists(graph, request.target);
  if (request.action === "explore" && request.target.kind !== "element") {
    throw new Error(
      "Continue exploration requires one explicit Element target.",
    );
  }
  if (request.action === "explore" && !request.goal?.trim()) {
    throw new Error(
      "Continue exploration requires a user goal; target-only probing is not allowed.",
    );
  }
  if (request.action === "recover") {
    if (request.target.kind !== "scene") {
      throw new Error("Only a stale Scene can be recovered.");
    }
    if (graph.scenes[request.target.id]?.status !== "stale") {
      throw new Error(`Scene is not stale: ${request.target.id}.`);
    }
  }
  if (request.action === "plan" || request.action === "execute") {
    const status = targetStatus(graph, request.target);
    if (status && ["stale", "blocked", "disabled"].includes(status)) {
      throw new Error(
        request.target.kind === "scene" && status === "stale"
          ? `Scene ${request.target.id} is stale. Use stale Scene recovery before executing it.`
          : `${request.target.kind} ${request.target.id} is not executable because its status is ${status}.`,
      );
    }
  }
  if (
    request.action === "execute" &&
    !request.confirmed &&
    requestIsDestructive(graph, request.target)
  ) {
    throw new Error(
      "This target contains a destructive action and requires explicit confirmation.",
    );
  }
}

export function normalizeActionRequest(
  graph: AppGraph,
  request: GraphConsoleActionRequest,
): GraphConsoleActionRequest {
  if (request.action === "execute" && request.target.kind === "element") {
    const entry = findElementEntry(graph, request.target.id);
    if (!entry) {
      throw new Error(`element does not exist: ${request.target.id}.`);
    }
    return withSemanticExecutionGoal(graph, {
      ...request,
      target: { kind: "scene", id: entry.sceneId },
    });
  }
  if (request.action === "execute" && request.target.kind === "scene") {
    return withSemanticExecutionGoal(graph, request);
  }
  if (request.action !== "explore") {
    return request;
  }
  if (request.target.kind === "scene" || request.target.kind === "element") {
    return request;
  }
  if (request.target.kind === "operator") {
    const operator = graph.operators[request.target.id];
    if (!operator) {
      throw new Error(`operator does not exist: ${request.target.id}.`);
    }
    return {
      ...request,
      target: {
        kind: "scene",
        id: operator.toSceneId ?? operator.fromSceneId,
      },
    };
  }
  const task = graph.tasks[request.target.id];
  if (!task) {
    throw new Error(`task does not exist: ${request.target.id}.`);
  }
  const finalOperator = task.steps.length
    ? graph.operators[task.steps.at(-1)!.operatorId]
    : undefined;
  return {
    ...request,
    target: {
      kind: "scene",
      id:
        finalOperator?.toSceneId ??
        finalOperator?.fromSceneId ??
        task.entrySceneId,
    },
  };
}

function withSemanticExecutionGoal(
  graph: AppGraph,
  request: GraphConsoleActionRequest,
): GraphConsoleActionRequest {
  if (request.goal?.trim() || request.target.kind !== "scene") return request;
  const scene = graph.scenes[request.target.id];
  return scene ? { ...request, goal: `打开${scene.title}` } : request;
}

function requestIsDestructive(
  graph: AppGraph,
  target: GraphConsoleTarget,
): boolean {
  if (target.kind === "operator") {
    return graph.operators[target.id]?.risk === "destructive";
  }
  if (target.kind !== "task") {
    return false;
  }
  const task = graph.tasks[target.id];
  return (task?.steps ?? []).some(
    (step) => graph.operators[step.operatorId]?.risk === "destructive",
  );
}

function selectedGraphContext(
  graph: AppGraph,
  target?: GraphConsoleTarget,
): unknown {
  if (!target) {
    return {
      graphId: graph.graphId,
      scenes: Object.values(graph.scenes).map((scene) => ({
        id: scene.sceneId,
        title: scene.title,
        status: scene.status,
      })),
      tasks: Object.values(graph.tasks).map((task) => ({
        id: task.taskId,
        title: task.intents[0] ?? task.taskId,
        status: task.status,
      })),
    };
  }
  assertTargetExists(graph, target);
  if (target.kind === "scene") {
    const scene = graph.scenes[target.id]!;
    return {
      target,
      scene,
      elements: Object.values(scene.elements),
      operators: Object.values(graph.operators).filter(
        (operator) =>
          operator.fromSceneId === scene.sceneId ||
          operator.toSceneId === scene.sceneId,
      ),
    };
  }
  if (target.kind === "element") {
    const elementEntry = findElementEntry(graph, target.id)!;
    const element = elementEntry.element;
    return {
      target,
      element,
      scene: graph.scenes[elementEntry.sceneId],
      operators: Object.values(graph.operators).filter(
        (operator) => operator.operation.elementId === element.elementId,
      ),
    };
  }
  if (target.kind === "operator") {
    return {
      target,
      operator: graph.operators[target.id],
    };
  }
  return {
    target,
    task: graph.tasks[target.id],
  };
}

function normalizeAgentTarget(
  graph: AppGraph,
  decision: AgentChatDecision,
): GraphConsoleTarget | undefined {
  if (!decision.targetKind || !decision.targetId) {
    return undefined;
  }
  const target: GraphConsoleTarget = {
    kind: decision.targetKind,
    id: decision.targetId,
  };
  assertTargetExists(graph, target);
  return target;
}

function assertTargetExists(graph: AppGraph, target: GraphConsoleTarget): void {
  const collection =
    target.kind === "scene"
      ? Object.keys(graph.scenes)
      : target.kind === "element"
        ? allElements(graph).map((entity) => entity.elementId)
        : target.kind === "operator"
          ? Object.keys(graph.operators)
          : Object.keys(graph.tasks);
  if (!collection.includes(target.id)) {
    throw new Error(`${target.kind} does not exist: ${target.id}.`);
  }
}

function targetStatus(
  graph: AppGraph,
  target: GraphConsoleTarget,
): GraphEntityStatus | undefined {
  if (target.kind === "scene") return graph.scenes[target.id]?.status;
  if (target.kind === "operator") return graph.operators[target.id]?.status;
  if (target.kind === "task") return graph.tasks[target.id]?.status;
  return findElementEntry(graph, target.id)?.element.status;
}

function normalizeCorrectionChange(
  change: AgentChatDecision["changes"][number],
): GraphConsoleCorrectionChange {
  const listField = change.field === "aliases" || change.field === "intents";
  return {
    entityKind: change.entityKind,
    entityId: change.entityId,
    field: change.field,
    value: listField ? change.listValue : change.stringValue,
    reason: change.reason,
  };
}

function validateCorrectionChanges(
  graph: AppGraph,
  changes: readonly GraphConsoleCorrectionChange[],
): void {
  if (changes.length === 0) {
    throw new Error("A correction proposal must contain at least one change.");
  }
  for (const change of changes) {
    const entity =
      change.entityKind === "scene"
        ? graph.scenes[change.entityId]
        : graph.tasks[change.entityId];
    if (!entity) {
      throw new Error(
        `${change.entityKind} does not exist: ${change.entityId}.`,
      );
    }
    const allowed =
      change.entityKind === "scene"
        ? new Set(["title", "aliases", "status"])
        : new Set(["intents", "status"]);
    if (!allowed.has(change.field)) {
      throw new Error(
        `${change.field} cannot be changed on ${change.entityKind}.`,
      );
    }
    if (
      (change.field === "aliases" || change.field === "intents") &&
      (!Array.isArray(change.value) ||
        change.value.some(
          (value) => typeof value !== "string" || !value.trim(),
        ))
    ) {
      throw new Error(`${change.field} must be a non-empty string list.`);
    }
    if (
      change.field !== "aliases" &&
      change.field !== "intents" &&
      (typeof change.value !== "string" || !change.value.trim())
    ) {
      throw new Error(`${change.field} must be a non-empty string.`);
    }
    if (
      change.field === "status" &&
      (typeof change.value !== "string" ||
        !SAFE_CORRECTION_STATUSES.has(change.value as GraphEntityStatus))
    ) {
      throw new Error(
        "Correction proposals may only downgrade status to candidate, stale, blocked, or disabled.",
      );
    }
  }
}

function applyCorrectionChanges(
  graph: AppGraph,
  changes: readonly GraphConsoleCorrectionChange[],
): AppGraph {
  const byEntity = new Map<string, GraphConsoleCorrectionChange[]>();
  for (const change of changes) {
    const key = `${change.entityKind}:${change.entityId}`;
    const values = byEntity.get(key) ?? [];
    values.push(change);
    byEntity.set(key, values);
  }
  const applyScene = (scene: Scene): Scene => {
    let next = scene;
    for (const change of byEntity.get(`scene:${scene.sceneId}`) ?? []) {
      if (change.field === "title" && typeof change.value === "string") {
        next = { ...next, title: change.value };
      } else if (change.field === "aliases" && Array.isArray(change.value)) {
        next = { ...next, aliases: change.value };
      } else if (
        change.field === "status" &&
        typeof change.value === "string"
      ) {
        next = { ...next, status: change.value as GraphEntityStatus };
      }
    }
    return next;
  };
  const applyTask = (task: Task): Task => {
    let next = task;
    for (const change of byEntity.get(`task:${task.taskId}`) ?? []) {
      if (change.field === "intents" && Array.isArray(change.value)) {
        next = { ...next, intents: change.value };
      } else if (
        change.field === "status" &&
        typeof change.value === "string"
      ) {
        next = { ...next, status: change.value as GraphEntityStatus };
      }
    }
    return next;
  };
  return {
    ...graph,
    revision: graph.revision + 1,
    updatedAt: new Date().toISOString(),
    scenes: Object.fromEntries(
      Object.entries(graph.scenes).map(([id, scene]) => [
        id,
        applyScene(scene),
      ]),
    ),
    tasks: Object.fromEntries(
      Object.entries(graph.tasks).map(([id, task]) => [id, applyTask(task)]),
    ),
  };
}

function validateGraphReferences(graph: AppGraph): void {
  const sceneIds = new Set(Object.keys(graph.scenes));
  const operatorIds = new Set(Object.keys(graph.operators));
  for (const operator of Object.values(graph.operators)) {
    if (
      !sceneIds.has(operator.fromSceneId) ||
      (operator.toSceneId !== null && !sceneIds.has(operator.toSceneId))
    ) {
      throw new Error(
        `Operator ${operator.operatorId} references an unknown Scene.`,
      );
    }
    if (
      operator.operation.elementId &&
      !findElementEntry(graph, operator.operation.elementId)
    ) {
      throw new Error(
        `Operator ${operator.operatorId} references missing Element ${operator.operation.elementId}.`,
      );
    }
  }
  for (const task of Object.values(graph.tasks)) {
    for (const step of task.steps) {
      const operatorId = step.operatorId;
      if (!operatorIds.has(operatorId)) {
        throw new Error(
          `Task ${task.taskId} references missing Operator ${operatorId}.`,
        );
      }
    }
  }
}

function allElements(graph: AppGraph) {
  return Object.values(graph.scenes).flatMap((scene) =>
    Object.values(scene.elements),
  );
}

function findElementEntry(
  graph: AppGraph,
  elementId: string,
):
  | {
      readonly sceneId: string;
      readonly element: AppGraph["scenes"][string]["elements"][string];
    }
  | undefined {
  for (const scene of Object.values(graph.scenes)) {
    const element = scene.elements[elementId];
    if (element) return { sceneId: scene.sceneId, element };
  }
  return undefined;
}

function requestGoal(request: GraphConsoleActionRequest): string {
  const explicitGoal = request.goal?.trim();
  if (explicitGoal) return explicitGoal;
  return request.target.kind === "task"
    ? request.target.id
    : request.target.kind === "scene"
      ? request.target.id
      : request.target.kind === "operator"
        ? `执行 Operator ${request.target.id}`
        : `探索 Element ${request.target.id} 的目标行为`;
}

async function readGraph(path: string): Promise<AppGraph> {
  return JSON.parse(await Bun.file(path).text()) as AppGraph;
}

async function writeGraphAtomic(path: string, graph: AppGraph): Promise<void> {
  const formatted = await format(JSON.stringify(graph), {
    parser: "json",
    filepath: path,
  });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, formatted, "utf8");
  await rename(temporaryPath, path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function cloneRun(run: MutableRun): GraphConsoleRun {
  return {
    ...run,
    events: [...run.events],
  };
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}
