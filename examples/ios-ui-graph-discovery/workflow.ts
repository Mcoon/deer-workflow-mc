import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { phase, workflow } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import {
  DEFAULT_ARTIFACT_ROOT,
  readJson,
  readJsonIfExists,
  writeJsonAtomic,
} from "../ios-regression-kit";
import { isStableIdentityText } from "../ios-ui-graph-experiment/workflow";
import runSceneCrawler from "./crawler";

import type {
  ExecutableUiGraphExperiment,
  GraphEntityStatus,
  IosUiGraphExperimentInput,
  IosUiGraphExperimentResult,
  IosUiGraphWorkflowFailureResult,
  IosUiTargetedDiscoveryResult,
  TargetedDiscoveryObservation,
} from "../ios-ui-graph-experiment/types";
import type {
  IosUiGraphDiscoveryCoverage,
  IosUiGraphDiscoveryFrontier,
  IosUiGraphDiscoveryFrontierStatus,
  IosUiGraphDiscoveryInput,
  IosUiGraphDiscoveryModule,
  IosUiGraphDiscoveryResult,
  IosUiGraphDiscoveryState,
  IosUiGraphSnapshot,
  IosUiCrawlerInput,
  IosUiCrawlerResult,
} from "./types";

const DEFAULT_GRAPH_PATH = resolve(
  dirname(import.meta.path),
  "../ios-ui-graph-experiment/graph-chat-full.json",
);
const DEFAULT_PROJECT_ROOT = resolve(dirname(import.meta.path), "../..");
const DEFAULT_MAXIMUM_FRONTIERS = 12;
const DEFAULT_MAXIMUM_QUEUED_FRONTIERS = 80;
const DEFAULT_MAXIMUM_NEW_SCENES = 30;
const DEFAULT_MAXIMUM_DURATION_MINUTES = 30;
const DEFAULT_MAXIMUM_ATTEMPTS = 2;
const DEFAULT_MAXIMUM_DISCOVERY_STEPS = 6;
const DEFAULT_AGENT_TIMEOUT_MS = 60_000;

const DEFAULT_MODULES: readonly IosUiGraphDiscoveryModule[] = [
  {
    moduleId: "global-navigation",
    title: "全局导航",
    seedGoals: [
      "打开侧边栏",
      "进入搜索页面",
      "进入技能页面",
      "进入云盘",
      "进入 AI 创作页面",
    ],
    allowedScenePrefixes: ["chat", "search", "skills", "cloud.drive", "create"],
  },
  {
    moduleId: "chat",
    title: "聊天与媒体",
    seedGoals: [
      "打开更多面板",
      "进入相机页面",
      "进入相册选择页面",
      "进入当前 Bot 设置页",
    ],
    allowedScenePrefixes: ["chat", "camera", "photo", "bot"],
  },
  {
    moduleId: "skills",
    title: "技能",
    seedGoals: [
      "进入技能页面",
      "打开个股研究",
      "打开估值建模",
      "打开市场热点分析",
    ],
    allowedScenePrefixes: ["skills", "chat"],
  },
  {
    moduleId: "cloud-drive",
    title: "云盘",
    seedGoals: ["进入云盘", "打开我的云盘", "打开云盘搜索"],
    allowedScenePrefixes: ["cloud.drive", "chat"],
  },
  {
    moduleId: "settings",
    title: "设置",
    seedGoals: ["进入当前 Bot 设置页", "打开豆包账号管理"],
    allowedScenePrefixes: ["bot", "settings", "account", "chat"],
  },
];

const NAVIGATION_ENTRY_PATTERN =
  /搜索|技能|云盘|创作|相册|相机|设置|管理|帮助|关于|隐私|通知|通用|语音|图片|视频|文件|收藏|模型|智能体|历史|账号/;

export const meta = {
  name: "ios-ui-graph-discovery",
  description:
    "Crawls an iOS app through resumable Scene, Element, Action, and Effect frontiers.",
  phases: [
    { title: "Load State" },
    { title: "Preflight" },
    { title: "Bootstrap Entry" },
    { title: "Scan Scene" },
    { title: "Generate Actions" },
    { title: "Execute Action" },
    { title: "Observe Effect" },
    { title: "Merge Graph" },
    { title: "Coverage" },
    { title: "Checkpoint" },
    { title: "Refresh Map" },
    { title: "Report" },
  ],
  exampleArgs: {
    maximumActions: 4,
    maximumScenes: 5,
    maximumDepth: 2,
    maximumDurationMinutes: 10,
    planOnly: true,
  },
};

export default async function iosUiGraphDiscovery(
  args: IosUiCrawlerInput,
): Promise<IosUiCrawlerResult> {
  return runSceneCrawler(args);
}

interface NormalizedInput {
  graphPath: string;
  projectRoot: string;
  udid: string;
  runId: string;
  outputDir: string;
  statePath: string;
  manifestPath: string;
  coveragePath: string;
  graphDeltaPath: string;
  reportPath: string;
  modules: readonly IosUiGraphDiscoveryModule[];
  planOnly: boolean;
  maximumFrontiers: number;
  maximumQueuedFrontiers: number;
  maximumNewScenes: number;
  maximumDurationMinutes: number;
  maximumAttemptsPerFrontier: number;
  maximumDiscoveryStepsPerGoal: number;
  agentTimeoutMs: number;
  model?: string;
}

type WorkerResult =
  | IosUiGraphExperimentResult
  | IosUiTargetedDiscoveryResult
  | IosUiGraphWorkflowFailureResult;

export async function runLegacyGoalFrontierDiscovery(
  args: IosUiGraphDiscoveryInput,
): Promise<IosUiGraphDiscoveryResult> {
  const input = normalizeInput(args);
  await mkdir(input.outputDir, { recursive: true });

  phase("Load State");
  const graph = await readGraph(input.graphPath);
  const existingState = await readJsonIfExists<IosUiGraphDiscoveryState>(
    input.statePath,
  );
  let state = existingState
    ? resumeDiscoveryState(existingState, input)
    : initializeDiscoveryState({
        graph,
        graphPath: input.graphPath,
        runId: input.runId,
        modules: input.modules,
        input,
      });
  await persistState(input, state);

  phase("Seed Frontier");
  state = mergeSeedFrontiers(state, input.modules);
  await persistState(input, state);
  log(
    [
      "## Semantic App Graph discovery",
      `- **Graph:** \`${input.graphPath}\``,
      `- **State:** \`${input.statePath}\``,
      `- **Modules:** ${state.modules.length}`,
      `- **Queued frontiers:** ${state.frontiers.filter((item) => item.status === "pending").length}`,
      `- **Plan only:** ${input.planOnly}`,
    ].join("\n"),
  );

  const sessionStarted = performance.now();
  const sessionStartedAt = new Date().toISOString();
  let processedFrontiers = 0;
  let stopReason: NonNullable<
    IosUiGraphDiscoveryState["lastSession"]
  >["stopReason"] = input.planOnly ? "plan_only" : "queue_empty";

  if (!input.planOnly) {
    phase("Crawl");
    const attemptedThisSession = new Set<string>();
    while (true) {
      const currentGraph = await readGraph(input.graphPath);
      const currentSnapshot = snapshotGraph(currentGraph);
      if (
        currentSnapshot.sceneCount - state.baseline.sceneCount >=
        input.maximumNewScenes
      ) {
        stopReason = "scene_budget";
        break;
      }
      if (processedFrontiers >= input.maximumFrontiers) {
        stopReason = "frontier_budget";
        break;
      }
      if (
        performance.now() - sessionStarted >=
        input.maximumDurationMinutes * 60_000
      ) {
        stopReason = "duration_budget";
        break;
      }
      const frontier = nextPendingFrontier(state, attemptedThisSession);
      if (!frontier) {
        stopReason = "queue_empty";
        break;
      }
      attemptedThisSession.add(frontier.frontierId);
      const startedFrontier: IosUiGraphDiscoveryFrontier = {
        ...frontier,
        status: "running",
        attempts: frontier.attempts + 1,
        startedAt: new Date().toISOString(),
        issue: undefined,
      };
      state = replaceFrontier(state, startedFrontier);
      await persistState(input, state);

      const workerOutputDir = join(
        input.outputDir,
        "frontiers",
        safeSegment(frontier.frontierId),
        `attempt-${startedFrontier.attempts}`,
      );
      try {
        const result = await workflow<WorkerResult, IosUiGraphExperimentInput>(
          "../ios-ui-graph-experiment/workflow.ts",
          {
            graphPath: input.graphPath,
            projectRoot: input.projectRoot,
            udid: input.udid,
            goal: frontier.goal,
            outputDir: workerOutputDir,
            planOnly: false,
            maximumDiscoverySteps: input.maximumDiscoveryStepsPerGoal,
            agentTimeoutMs: input.agentTimeoutMs,
            model: input.model,
          },
        );
        const completedFrontier: IosUiGraphDiscoveryFrontier = {
          ...startedFrontier,
          status: result.success ? "completed" : "failed",
          completedAt: new Date().toISOString(),
          workerOutputDir,
          resultPath: result.resultPath,
          resolvedTaskId:
            "goalResolution" in result
              ? (result.goalResolution.taskId ??
                ("candidateTaskId" in result
                  ? result.candidateTaskId
                  : undefined))
              : undefined,
          issue: result.success
            ? undefined
            : `${result.failure?.code ?? "worker_failed"}: ${
                result.failure?.message ?? "Worker returned success=false."
              }`,
        };
        state = replaceFrontier(state, completedFrontier);
        if (
          result.success &&
          "mode" in result &&
          result.mode === "targeted_discovery"
        ) {
          state = enqueueObservationFrontiers({
            state,
            result,
            frontier,
            maximumQueuedFrontiers: input.maximumQueuedFrontiers,
          });
        }
      } catch (error) {
        const failedFrontier: IosUiGraphDiscoveryFrontier = {
          ...startedFrontier,
          status: "failed",
          completedAt: new Date().toISOString(),
          workerOutputDir,
          issue: error instanceof Error ? error.message : String(error),
        };
        state = replaceFrontier(state, failedFrontier);
      }
      processedFrontiers += 1;
      await persistState(input, state);
    }
  }

  phase("Merge Graph");
  const finalGraph = await readGraph(input.graphPath);
  const currentSnapshot = snapshotGraph(finalGraph);
  await writeJsonAtomic(input.graphDeltaPath, {
    schemaVersion: "ios-ui-graph-discovery-delta/v1",
    graphPath: input.graphPath,
    baseline: state.baseline,
    current: currentSnapshot,
    delta: graphDelta(state.baseline, currentSnapshot),
  });

  phase("Coverage");
  const finishedAt = new Date().toISOString();
  const hasPending = state.frontiers.some(
    (item) =>
      item.status === "pending" ||
      item.status === "running" ||
      (item.status === "failed" &&
        item.attempts < state.budgets.maximumAttemptsPerFrontier),
  );
  state = {
    ...state,
    status: hasPending ? "paused" : "completed",
    updatedAt: finishedAt,
    lastSession: {
      startedAt: sessionStartedAt,
      finishedAt,
      processedFrontiers,
      durationMs: performance.now() - sessionStarted,
      stopReason,
    },
  };
  const coverage = computeDiscoveryCoverage(state, finalGraph);
  await Promise.all([
    persistState(input, state),
    writeJsonAtomic(input.coveragePath, coverage),
  ]);

  phase("Report");
  await Bun.write(input.reportPath, renderDiscoveryReport(state, coverage));
  await writeJsonAtomic(input.manifestPath, {
    schemaVersion: "ios-ui-graph-discovery-manifest/v1",
    runId: state.runId,
    graphPath: input.graphPath,
    statePath: input.statePath,
    coveragePath: input.coveragePath,
    graphDeltaPath: input.graphDeltaPath,
    reportPath: input.reportPath,
    planOnly: input.planOnly,
    generatedAt: new Date().toISOString(),
  });
  log(
    [
      "## App Graph discovery result",
      `- **Status:** ${state.status}`,
      `- **Processed:** ${processedFrontiers}`,
      `- **Scenes:** ${coverage.current.sceneCount} (${signed(coverage.delta.scenes)})`,
      `- **Operators:** ${coverage.current.operatorCount} (${signed(coverage.delta.operators)})`,
      `- **Pending frontiers:** ${coverage.frontiers.pending}`,
      `- **Coverage:** \`${input.coveragePath}\``,
      `- **Report:** \`${input.reportPath}\``,
    ].join("\n"),
  );
  return {
    success: true,
    planOnly: input.planOnly,
    outputDir: input.outputDir,
    graphPath: input.graphPath,
    statePath: input.statePath,
    manifestPath: input.manifestPath,
    coveragePath: input.coveragePath,
    graphDeltaPath: input.graphDeltaPath,
    reportPath: input.reportPath,
    state,
    coverage,
  };
}

export function initializeDiscoveryState(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  runId: string;
  modules: readonly IosUiGraphDiscoveryModule[];
  input: Pick<
    NormalizedInput,
    | "maximumFrontiers"
    | "maximumQueuedFrontiers"
    | "maximumNewScenes"
    | "maximumDurationMinutes"
    | "maximumAttemptsPerFrontier"
    | "maximumDiscoveryStepsPerGoal"
    | "agentTimeoutMs"
  >;
}): IosUiGraphDiscoveryState {
  const now = new Date().toISOString();
  const state: IosUiGraphDiscoveryState = {
    schemaVersion: "ios-ui-graph-discovery-state/v1",
    runId: options.runId,
    graphPath: options.graphPath,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    sessionCount: 1,
    modules: options.modules,
    budgets: {
      maximumFrontiers: options.input.maximumFrontiers,
      maximumQueuedFrontiers: options.input.maximumQueuedFrontiers,
      maximumNewScenes: options.input.maximumNewScenes,
      maximumDurationMinutes: options.input.maximumDurationMinutes,
      maximumAttemptsPerFrontier: options.input.maximumAttemptsPerFrontier,
      maximumDiscoveryStepsPerGoal: options.input.maximumDiscoveryStepsPerGoal,
      agentTimeoutMs: options.input.agentTimeoutMs,
    },
    baseline: snapshotGraph(options.graph),
    frontiers: [],
  };
  return mergeSeedFrontiers(state, options.modules);
}

export function mergeSeedFrontiers(
  state: IosUiGraphDiscoveryState,
  modules: readonly IosUiGraphDiscoveryModule[],
): IosUiGraphDiscoveryState {
  const existingGoals = new Set(
    state.frontiers.map((frontier) => normalizeDiscoveryGoal(frontier.goal)),
  );
  const frontiers = [...state.frontiers];
  for (const module of modules) {
    for (const [index, goal] of module.seedGoals.entries()) {
      const normalizedGoal = normalizeDiscoveryGoal(goal);
      if (!normalizedGoal || existingGoals.has(normalizedGoal)) {
        continue;
      }
      existingGoals.add(normalizedGoal);
      const issue = frontierSafetyIssue(goal);
      frontiers.push({
        frontierId: frontierId(module.moduleId, goal),
        moduleId: module.moduleId,
        goal: goal.trim(),
        source: "seed",
        priority: 100 - index,
        status: issue ? "blocked" : "pending",
        attempts: 0,
        createdAt: new Date().toISOString(),
        issue: issue ?? undefined,
      });
    }
  }
  return {
    ...state,
    modules: mergeModules(state.modules, modules),
    frontiers,
    updatedAt: new Date().toISOString(),
  };
}

export function resumeDiscoveryState(
  state: IosUiGraphDiscoveryState,
  input: Pick<
    NormalizedInput,
    | "graphPath"
    | "maximumAttemptsPerFrontier"
    | "maximumFrontiers"
    | "maximumQueuedFrontiers"
    | "maximumNewScenes"
    | "maximumDurationMinutes"
    | "maximumDiscoveryStepsPerGoal"
    | "agentTimeoutMs"
  >,
): IosUiGraphDiscoveryState {
  if (state.schemaVersion !== "ios-ui-graph-discovery-state/v1") {
    throw new Error(`Unsupported discovery state: ${state.schemaVersion}.`);
  }
  if (resolve(state.graphPath) !== resolve(input.graphPath)) {
    throw new Error(
      "Discovery state Graph path does not match input graphPath.",
    );
  }
  const frontiers = state.frontiers.map((frontier) => {
    if (
      frontier.status === "running" ||
      (frontier.status === "failed" &&
        frontier.attempts < input.maximumAttemptsPerFrontier)
    ) {
      return {
        ...frontier,
        status: "pending" as const,
        issue:
          frontier.status === "running"
            ? "Recovered an interrupted frontier."
            : frontier.issue,
      };
    }
    return frontier;
  });
  return {
    ...state,
    status: "ready",
    updatedAt: new Date().toISOString(),
    sessionCount: state.sessionCount + 1,
    budgets: {
      maximumFrontiers: input.maximumFrontiers,
      maximumQueuedFrontiers: input.maximumQueuedFrontiers,
      maximumNewScenes: input.maximumNewScenes,
      maximumDurationMinutes: input.maximumDurationMinutes,
      maximumAttemptsPerFrontier: input.maximumAttemptsPerFrontier,
      maximumDiscoveryStepsPerGoal: input.maximumDiscoveryStepsPerGoal,
      agentTimeoutMs: input.agentTimeoutMs,
    },
    frontiers,
  };
}

export function frontierSafetyIssue(goal: string): string | null {
  const normalized = normalizeDiscoveryGoal(goal);
  const blocked = [
    "发送",
    "删除",
    "支付",
    "购买",
    "下单",
    "提交",
    "发布",
    "转账",
    "充值",
    "退出登录",
    "注销",
    "清空",
    "允许权限",
    "授权",
  ];
  const token = blocked.find((candidate) => normalized.includes(candidate));
  return token
    ? `Full-app discovery blocks side-effect goal token: ${token}.`
    : null;
}

export function normalizeDiscoveryGoal(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s,，。.!！?？、；;:："“”'‘’（）()]/g, "");
}

export function deriveObservationFrontiers(options: {
  observation: TargetedDiscoveryObservation;
  moduleId: string;
  existingGoals: ReadonlySet<string>;
  maximum: number;
}): IosUiGraphDiscoveryFrontier[] {
  const results: IosUiGraphDiscoveryFrontier[] = [];
  const seen = new Set<string>();
  for (const candidate of options.observation.candidates) {
    if (
      candidate.source !== "ui_dump" ||
      !["Button", "StaticText", "Image"].includes(candidate.role ?? "")
    ) {
      continue;
    }
    const text = (
      candidate.label ??
      candidate.text ??
      candidate.accessibilityId ??
      ""
    ).trim();
    if (
      text.length < 2 ||
      text.length > 24 ||
      !isStableIdentityText(text) ||
      !NAVIGATION_ENTRY_PATTERN.test(text)
    ) {
      continue;
    }
    const goal = /^进入|^打开|^查看/.test(text) ? text : `打开${text}`;
    const normalizedGoal = normalizeDiscoveryGoal(goal);
    if (
      seen.has(normalizedGoal) ||
      options.existingGoals.has(normalizedGoal) ||
      frontierSafetyIssue(goal)
    ) {
      continue;
    }
    seen.add(normalizedGoal);
    results.push({
      frontierId: frontierId(options.moduleId, goal),
      moduleId: options.moduleId,
      goal,
      source: "observation",
      sourceSceneId:
        options.observation.matchedSceneId ??
        options.observation.candidateSceneId,
      sourceObservationId: options.observation.observationId,
      priority: 50,
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
    });
    if (results.length >= options.maximum) {
      break;
    }
  }
  return results;
}

export function computeDiscoveryCoverage(
  state: IosUiGraphDiscoveryState,
  graph: ExecutableUiGraphExperiment,
): IosUiGraphDiscoveryCoverage {
  const current = snapshotGraph(graph);
  const frontierCounts = countFrontierStatuses(state.frontiers);
  return {
    schemaVersion: "ios-ui-graph-discovery-coverage/v1",
    generatedAt: new Date().toISOString(),
    graphPath: state.graphPath,
    baseline: state.baseline,
    current,
    delta: graphDelta(state.baseline, current),
    frontiers: frontierCounts,
    modules: state.modules.map((module) => {
      const frontiers = state.frontiers.filter(
        (frontier) => frontier.moduleId === module.moduleId,
      );
      return {
        moduleId: module.moduleId,
        title: module.title,
        totalFrontiers: frontiers.length,
        completedFrontiers: frontiers.filter(
          (frontier) => frontier.status === "completed",
        ).length,
        pendingFrontiers: frontiers.filter(
          (frontier) => frontier.status === "pending",
        ).length,
        blockedFrontiers: frontiers.filter(
          (frontier) => frontier.status === "blocked",
        ).length,
        failedFrontiers: frontiers.filter(
          (frontier) => frontier.status === "failed",
        ).length,
      };
    }),
  };
}

function normalizeInput(args: IosUiGraphDiscoveryInput): NormalizedInput {
  if (!args) {
    throw new TypeError("iOS UI Graph Discovery requires input arguments.");
  }
  const runId = safeSegment(args.runId?.trim() || timestampForPath());
  const graphPath = resolve(args.graphPath?.trim() || DEFAULT_GRAPH_PATH);
  const resumeStatePath = args.resumeStatePath?.trim()
    ? resolve(args.resumeStatePath)
    : undefined;
  const outputDir = resumeStatePath
    ? dirname(resumeStatePath)
    : resolve(
        args.outputDir?.trim() ||
          join(DEFAULT_ARTIFACT_ROOT, "ios-ui-graph-discovery", runId),
      );
  return {
    graphPath,
    projectRoot: resolve(args.projectRoot?.trim() || DEFAULT_PROJECT_ROOT),
    udid: args.udid?.trim() || "00008030-001A286A2229802E",
    runId,
    outputDir,
    statePath: resumeStatePath ?? join(outputDir, "state.json"),
    manifestPath: join(outputDir, "manifest.json"),
    coveragePath: join(outputDir, "coverage.json"),
    graphDeltaPath: join(outputDir, "graph-delta.json"),
    reportPath: join(outputDir, "report.html"),
    modules:
      args.modules ?? (resumeStatePath === undefined ? DEFAULT_MODULES : []),
    planOnly: args.planOnly !== false,
    maximumFrontiers: boundedInteger(
      args.maximumFrontiers,
      1,
      100,
      DEFAULT_MAXIMUM_FRONTIERS,
    ),
    maximumQueuedFrontiers: boundedInteger(
      args.maximumQueuedFrontiers,
      1,
      1000,
      DEFAULT_MAXIMUM_QUEUED_FRONTIERS,
    ),
    maximumNewScenes: boundedInteger(
      args.maximumNewScenes,
      1,
      200,
      DEFAULT_MAXIMUM_NEW_SCENES,
    ),
    maximumDurationMinutes: boundedInteger(
      args.maximumDurationMinutes,
      1,
      480,
      DEFAULT_MAXIMUM_DURATION_MINUTES,
    ),
    maximumAttemptsPerFrontier: boundedInteger(
      args.maximumAttemptsPerFrontier,
      1,
      5,
      DEFAULT_MAXIMUM_ATTEMPTS,
    ),
    maximumDiscoveryStepsPerGoal: boundedInteger(
      args.maximumDiscoveryStepsPerGoal,
      1,
      8,
      DEFAULT_MAXIMUM_DISCOVERY_STEPS,
    ),
    agentTimeoutMs: boundedInteger(
      args.agentTimeoutMs,
      1_000,
      300_000,
      DEFAULT_AGENT_TIMEOUT_MS,
    ),
    model: args.model?.trim() || undefined,
  };
}

async function readGraph(path: string): Promise<ExecutableUiGraphExperiment> {
  return readJson<ExecutableUiGraphExperiment>(path);
}

async function persistState(
  input: NormalizedInput,
  state: IosUiGraphDiscoveryState,
): Promise<void> {
  await writeJsonAtomic(input.statePath, state);
}

function nextPendingFrontier(
  state: IosUiGraphDiscoveryState,
  attemptedThisSession: ReadonlySet<string>,
): IosUiGraphDiscoveryFrontier | undefined {
  return state.frontiers
    .filter(
      (frontier) =>
        frontier.status === "pending" &&
        frontier.attempts < state.budgets.maximumAttemptsPerFrontier &&
        !attemptedThisSession.has(frontier.frontierId),
    )
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.createdAt.localeCompare(right.createdAt),
    )[0];
}

function replaceFrontier(
  state: IosUiGraphDiscoveryState,
  frontier: IosUiGraphDiscoveryFrontier,
): IosUiGraphDiscoveryState {
  return {
    ...state,
    status: "running",
    updatedAt: new Date().toISOString(),
    frontiers: state.frontiers.map((candidate) =>
      candidate.frontierId === frontier.frontierId ? frontier : candidate,
    ),
  };
}

function enqueueObservationFrontiers(options: {
  state: IosUiGraphDiscoveryState;
  result: IosUiTargetedDiscoveryResult;
  frontier: IosUiGraphDiscoveryFrontier;
  maximumQueuedFrontiers: number;
}): IosUiGraphDiscoveryState {
  const observation = options.result.observations.at(-1);
  if (!observation) {
    return options.state;
  }
  const remaining =
    options.maximumQueuedFrontiers - options.state.frontiers.length;
  if (remaining <= 0) {
    return options.state;
  }
  const existingGoals = new Set(
    options.state.frontiers.map((item) => normalizeDiscoveryGoal(item.goal)),
  );
  const derived = deriveObservationFrontiers({
    observation,
    moduleId: options.frontier.moduleId,
    existingGoals,
    maximum: remaining,
  });
  return derived.length === 0
    ? options.state
    : {
        ...options.state,
        updatedAt: new Date().toISOString(),
        frontiers: [...options.state.frontiers, ...derived],
      };
}

function snapshotGraph(graph: ExecutableUiGraphExperiment): IosUiGraphSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    sceneCount: graph.scenes.length,
    elementCount: graph.elements.length,
    operatorCount: graph.operators.length,
    taskCount: graph.tasks.length,
    sceneStatusCounts: countGraphStatuses(graph.scenes),
    operatorStatusCounts: countGraphStatuses(graph.operators),
    taskStatusCounts: countGraphStatuses(graph.tasks),
  };
}

function countGraphStatuses(
  entities: readonly { readonly status: GraphEntityStatus }[],
): Record<GraphEntityStatus, number> {
  const counts = emptyGraphStatusCounts();
  for (const entity of entities) {
    counts[entity.status] += 1;
  }
  return counts;
}

function emptyGraphStatusCounts(): Record<GraphEntityStatus, number> {
  return {
    observed: 0,
    candidate: 0,
    verified: 0,
    stale: 0,
    blocked: 0,
    disabled: 0,
  };
}

function countFrontierStatuses(
  frontiers: readonly IosUiGraphDiscoveryFrontier[],
): Record<IosUiGraphDiscoveryFrontierStatus, number> {
  const counts: Record<IosUiGraphDiscoveryFrontierStatus, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
  };
  for (const frontier of frontiers) {
    counts[frontier.status] += 1;
  }
  return counts;
}

function graphDelta(
  baseline: IosUiGraphSnapshot,
  current: IosUiGraphSnapshot,
): IosUiGraphDiscoveryCoverage["delta"] {
  return {
    scenes: current.sceneCount - baseline.sceneCount,
    elements: current.elementCount - baseline.elementCount,
    operators: current.operatorCount - baseline.operatorCount,
    tasks: current.taskCount - baseline.taskCount,
  };
}

function renderDiscoveryReport(
  state: IosUiGraphDiscoveryState,
  coverage: IosUiGraphDiscoveryCoverage,
): string {
  const frontierRows = state.frontiers
    .map(
      (frontier) =>
        `<tr><td>${escapeHtml(frontier.moduleId)}</td><td>${escapeHtml(frontier.goal)}</td><td>${escapeHtml(frontier.status)}</td><td>${frontier.attempts}</td><td>${escapeHtml(frontier.issue ?? "")}</td></tr>`,
    )
    .join("");
  const moduleRows = coverage.modules
    .map(
      (module) =>
        `<tr><td>${escapeHtml(module.title)}</td><td>${module.totalFrontiers}</td><td>${module.completedFrontiers}</td><td>${module.pendingFrontiers}</td><td>${module.blockedFrontiers}</td><td>${module.failedFrontiers}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>iOS Semantic Graph Discovery</title>
<style>
body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f4f7fb;color:#17202a}
main{max-width:1180px;margin:0 auto;padding:28px}.card{background:#fff;border:1px solid #dce3eb;border-radius:12px;padding:18px;margin-bottom:16px}
h1{margin:0 0 18px}h2{font-size:17px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.metric{background:#f8fafc;border-radius:9px;padding:12px}.metric b{display:block;font-size:24px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e5eaf0}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
</head>
<body><main>
<h1>iOS Semantic Graph Discovery</h1>
<section class="card"><div class="grid">
<div class="metric"><span>Scenes</span><b>${coverage.current.sceneCount}</b><small>${signed(coverage.delta.scenes)}</small></div>
<div class="metric"><span>Elements</span><b>${coverage.current.elementCount}</b><small>${signed(coverage.delta.elements)}</small></div>
<div class="metric"><span>Operators</span><b>${coverage.current.operatorCount}</b><small>${signed(coverage.delta.operators)}</small></div>
<div class="metric"><span>Tasks</span><b>${coverage.current.taskCount}</b><small>${signed(coverage.delta.tasks)}</small></div>
</div><p>Status: <b>${escapeHtml(state.status)}</b> · State: <code>${escapeHtml(state.runId)}</code></p></section>
<section class="card"><h2>Modules</h2><table><thead><tr><th>Module</th><th>Total</th><th>Completed</th><th>Pending</th><th>Blocked</th><th>Failed</th></tr></thead><tbody>${moduleRows}</tbody></table></section>
<section class="card"><h2>Frontiers</h2><table><thead><tr><th>Module</th><th>Goal</th><th>Status</th><th>Attempts</th><th>Issue</th></tr></thead><tbody>${frontierRows}</tbody></table></section>
</main></body></html>`;
}

function mergeModules(
  existing: readonly IosUiGraphDiscoveryModule[],
  incoming: readonly IosUiGraphDiscoveryModule[],
): IosUiGraphDiscoveryModule[] {
  const modules = new Map(
    existing.map((module) => [module.moduleId, module] as const),
  );
  for (const module of incoming) {
    modules.set(module.moduleId, module);
  }
  return [...modules.values()];
}

function frontierId(moduleId: string, goal: string): string {
  return `frontier.${safeSegment(moduleId)}.${createHash("sha1")
    .update(normalizeDiscoveryGoal(goal))
    .digest("hex")
    .slice(0, 10)}`;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `Expected an integer between ${minimum} and ${maximum}; got ${value}.`,
    );
  }
  return value;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function timestampForPath(): string {
  return new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}
