import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import appGraphExec from "../app-graph-exec/workflow";
import appGraphPlan from "../app-graph-plan/workflow";
import { loadGraph } from "../ios-ui-graph-manager";
import { runCommand } from "../ios-regression-kit";

import type { AppGraphExecOutput } from "../app-graph-exec/types";
import type { AppGraphPlanResult } from "../app-graph-plan/types";
import type {
  AppGraphWorkflowFailure,
  AppGraphWorkflowInput,
  AppGraphWorkflowOutput,
  AppGraphWorkflowResult,
  AppGraphWorkflowRound,
} from "./types";

export { meta } from "./types";

const DEFAULT_OUTPUT_ROOT = "/tmp/ios_perf-opt/app-graph";
const DEFAULT_GRAPH_PATH = resolve(
  dirname(import.meta.path),
  "../ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);

export default async function appGraphWorkflow(
  args: AppGraphWorkflowInput,
): Promise<AppGraphWorkflowOutput> {
  const startedAt = Date.now();
  const goal = normalizeGoal(args.goal ?? "");
  const outputDir = resolve(
    join(
      args.outputDir?.trim() || DEFAULT_OUTPUT_ROOT,
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
  );
  await mkdir(outputDir, { recursive: true });
  const resultPath = join(outputDir, "result.json");
  if (!goal) {
    return writeFailure({
      outputDir,
      resultPath,
      goal: "",
      planOnly: args.planOnly === true,
      code: "missing_goal",
      message: "goal is required.",
      recoverable: false,
      rounds: [],
      evidencePaths: [],
      startedAt,
    });
  }

  const rounds: AppGraphWorkflowRound[] = [];
  const evidencePaths: string[] = [];
  const planOnly = args.planOnly === true;
  const commandRunner = args.commandRunner ?? runCommand;
  const graphPath = resolve(args.graphPath?.trim() || DEFAULT_GRAPH_PATH);
  let runtimeAppVersion = args.runtimeAppVersion?.trim() || undefined;
  if (!planOnly && !runtimeAppVersion && args.udid?.trim()) {
    try {
      const graph = await loadGraph(graphPath);
      const installed = await commandRunner(
        ["mobilecli", "apps", "list", "--device", args.udid.trim()],
        process.cwd(),
      );
      if (installed.exitCode === 0) {
        runtimeAppVersion = installedAppVersion(
          installed.stdout,
          graph.bundleId,
        );
      }
    } catch {
      log(
        "Installed App version is unavailable; Exec will remain guarded unless it can prove version identity.",
      );
    }
  }
  const maximumRecoveryRounds = Math.max(
    0,
    Math.min(3, args.maximumRecoveryRounds ?? 0),
  );
  let graphUpdated = false;

  for (
    let roundIndex = 0;
    roundIndex <= maximumRecoveryRounds;
    roundIndex += 1
  ) {
    phase(roundIndex === 0 ? "Plan" : "Retry");
    log(`App Graph round ${roundIndex + 1}: planning ${goal}`);
    const roundDirectory = join(
      outputDir,
      `round-${String(roundIndex + 1).padStart(2, "0")}`,
    );
    const planResult = await appGraphPlan({
      goal,
      target: args.target,
      parameters: args.parameters,
      graphPath,
      deviceProfileId: args.deviceProfileId,
      udid: args.udid,
      runtimeAppVersion,
      outputDir: join(roundDirectory, "plan"),
      planOnly: true,
    });
    const round: {
      round: number;
      planResult: typeof planResult;
      execResult?: AppGraphExecOutput;
    } = {
      round: roundIndex + 1,
      planResult,
    };
    rounds.push(round);
    if (!planResult.success) {
      return writeFailure({
        outputDir,
        resultPath,
        goal,
        planOnly,
        code: planResult.code,
        message: planResult.message,
        recoverable: planResult.recoverable,
        rounds,
        evidencePaths: [...evidencePaths, ...planResult.evidencePaths],
        startedAt,
      });
    }
    evidencePaths.push(planResult.planPath);
    if (planOnly) {
      phase("Output");
      return writeSuccess({
        outputDir,
        resultPath,
        goal,
        planOnly: true,
        verdict: "plan_ready",
        rounds,
        finalPlan: planResult,
        graphUpdated,
        evidencePaths,
        startedAt,
      });
    }

    phase("Execute");
    const execResult = await appGraphExec({
      goal,
      plan: planResult,
      graphPath,
      projectRoot: args.projectRoot,
      agentCwd: args.agentCwd,
      udid: args.udid,
      deviceProfileId: args.deviceProfileId,
      outputDir: join(roundDirectory, "exec"),
      planOnly: false,
      skipReset: roundIndex > 0,
      allowLearning: args.allowLearning,
      runtimeAppVersion,
      runtimeAppVersionChecked: true,
      model: args.model,
      agentTimeoutMs: args.agentTimeoutMs,
      maxAgentRecoverySteps: args.maxAgentRecoverySteps,
      minimumAgentConfidence: args.minimumAgentConfidence,
      preferFastPath: args.preferFastPath,
      agentRunner: args.agentRunner,
      commandRunner: args.commandRunner,
    });
    round.execResult = execResult;
    if (execResult.mode === "exec") {
      evidencePaths.push(...execResult.evidencePaths);
      graphUpdated ||= execResult.graphUpdated;
      if (execResult.success && execResult.verdict === "pass") {
        phase("Output");
        return writeSuccess({
          outputDir,
          resultPath,
          goal,
          planOnly: false,
          verdict: "pass",
          rounds,
          finalPlan: planResult,
          finalExec: execResult,
          graphUpdated,
          evidencePaths,
          startedAt,
        });
      }
    } else {
      evidencePaths.push(...execResult.evidencePaths);
      graphUpdated ||= execResult.graphUpdated === true;
    }

    if (roundIndex >= maximumRecoveryRounds) {
      return executionFailure({
        outputDir,
        resultPath,
        goal,
        planOnly,
        rounds,
        execResult,
        evidencePaths,
        startedAt,
      });
    }

    if (graphUpdated) {
      log("Exec updated the Graph; re-planning against the new revision.");
      continue;
    }

    return executionFailure({
      outputDir,
      resultPath,
      goal,
      planOnly,
      rounds,
      execResult,
      evidencePaths,
      startedAt,
    });
  }

  return writeFailure({
    outputDir,
    resultPath,
    goal,
    planOnly,
    code: "recovery_rounds_exhausted",
    message: "App Graph recovery rounds were exhausted.",
    recoverable: true,
    rounds,
    evidencePaths,
    startedAt,
  });
}

export function installedAppVersion(
  output: string,
  bundleId: string,
): string | undefined {
  try {
    const parsed = JSON.parse(output) as {
      readonly data?: readonly {
        readonly packageName?: unknown;
        readonly version?: unknown;
      }[];
    };
    const app = parsed.data?.find(
      (candidate) => candidate.packageName === bundleId,
    );
    return typeof app?.version === "string"
      ? app.version.trim() || undefined
      : undefined;
  } catch {
    return undefined;
  }
}

function executionFailure(options: {
  outputDir: string;
  resultPath: string;
  goal: string;
  planOnly: boolean;
  rounds: readonly AppGraphWorkflowRound[];
  execResult: AppGraphExecOutput;
  evidencePaths: readonly string[];
  startedAt: number;
}): Promise<AppGraphWorkflowFailure> {
  return writeFailure({
    outputDir: options.outputDir,
    resultPath: options.resultPath,
    goal: options.goal,
    planOnly: options.planOnly,
    code:
      options.execResult.mode === "exec_failure"
        ? options.execResult.code
        : `exec_${options.execResult.verdict}`,
    message:
      options.execResult.mode === "exec_failure"
        ? options.execResult.message
        : options.execResult.verdictReason,
    recoverable:
      options.execResult.mode === "exec_failure"
        ? options.execResult.recoverable
        : true,
    rounds: options.rounds,
    evidencePaths: options.evidencePaths,
    startedAt: options.startedAt,
  });
}

async function writeSuccess(options: {
  outputDir: string;
  resultPath: string;
  goal: string;
  planOnly: boolean;
  verdict: AppGraphWorkflowResult["verdict"];
  rounds: readonly AppGraphWorkflowRound[];
  finalPlan: AppGraphPlanResult;
  finalExec?: AppGraphExecOutput;
  graphUpdated: boolean;
  evidencePaths: readonly string[];
  startedAt: number;
}): Promise<AppGraphWorkflowResult> {
  const result: AppGraphWorkflowResult = {
    schemaVersion: "app-graph-workflow-result/v1",
    success: true,
    mode: "app_graph",
    planOnly: options.planOnly,
    goal: options.goal,
    outputDir: options.outputDir,
    verdict: options.verdict,
    rounds: options.rounds,
    finalPlan: options.finalPlan,
    finalExec: options.finalExec,
    graphUpdated: options.graphUpdated,
    resultPath: options.resultPath,
    evidencePaths: unique(options.evidencePaths),
    totalDurationMs: Date.now() - options.startedAt,
  };
  await writeFile(options.resultPath, JSON.stringify(result, null, 2), "utf8");
  return result;
}

async function writeFailure(options: {
  outputDir: string;
  resultPath: string;
  goal: string;
  planOnly: boolean;
  code: string;
  message: string;
  recoverable: boolean;
  rounds: readonly AppGraphWorkflowRound[];
  evidencePaths: readonly string[];
  startedAt: number;
}): Promise<AppGraphWorkflowFailure> {
  const result: AppGraphWorkflowFailure = {
    schemaVersion: "app-graph-workflow-failure/v1",
    success: false,
    mode: "app_graph_failure",
    planOnly: options.planOnly,
    goal: options.goal,
    outputDir: options.outputDir,
    code: options.code,
    message: options.message,
    recoverable: options.recoverable,
    rounds: options.rounds,
    resultPath: options.resultPath,
    evidencePaths: unique(options.evidencePaths),
    totalDurationMs: Date.now() - options.startedAt,
  };
  await writeFile(options.resultPath, JSON.stringify(result, null, 2), "utf8");
  return result;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeGoal(value: string): string {
  return value
    .trim()
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/gu, "")
    .trim();
}
