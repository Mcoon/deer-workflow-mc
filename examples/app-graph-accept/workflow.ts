import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import appGraphPlan from "../app-graph-plan/workflow";
import appGraphExec from "../app-graph-exec/workflow";
import type { AppGraphPlanOutput } from "../app-graph-plan/types";

import type {
  AppGraphAcceptFailure,
  AppGraphAcceptInput,
  AppGraphAcceptOutput,
  AppGraphAcceptResult,
  CaseRunResult,
  StructuredCase,
} from "./types";

export { meta } from "./types";

const DEFAULT_OUTPUT_ROOT = "/tmp/ios_perf-opt/app-graph-accept";

export default async function appGraphAccept(
  args: AppGraphAcceptInput,
): Promise<AppGraphAcceptOutput> {
  const startedAt = Date.now();
  const outputDir = resolve(
    join(
      args.outputDir?.trim() || DEFAULT_OUTPUT_ROOT,
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
  );
  await mkdir(outputDir, { recursive: true });

  phase("Load");
  log("Loading cases...");

  phase("Parse Cases");
  const cases = await loadCases(args);
  if (!cases || cases.length === 0) {
    return fail({
      outputDir,
      code: "no_cases",
      message: "No cases found. Provide case, cases, or caseSetPath.",
      recoverable: true,
    });
  }
  log(`Loaded ${cases.length} cases`);

  const planOnly = args.planOnly === true;
  const graphPath = args.graphPath;

  phase("Run Cases");
  const caseResults: CaseRunResult[] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const caseStart = Date.now();
    const caseOutputDir = join(outputDir, "cases", String(c.case_id));
    await mkdir(caseOutputDir, { recursive: true });

    const goalCandidates = buildPlanningGoalCandidates(c);
    const goal = goalCandidates[0]!;
    log(`Case ${i + 1}/${cases.length}: ${c.case_id} — ${c.title}`);

    try {
      const { result: planResult, selectedGoal } = await planCase({
        goalCandidates,
        graphPath,
        deviceProfileId: args.deviceProfileId,
        udid: args.udid,
        outputDir: join(caseOutputDir, "plan"),
        planOnly: args.planOnly,
        parameters: c.parameters,
      });

      if (!planResult.success) {
        caseResults.push({
          caseId: c.case_id,
          title: c.title,
          priority: c.priority,
          tags: c.tags,
          goal,
          startedAt: new Date(caseStart).toISOString(),
          finishedAt: new Date().toISOString(),
          caseOutputDir,
          verdict: "blocked",
          planResult,
          reason: `Plan failed: ${planResult.message}`,
          expected: c.expected,
          selectedPlanningGoal: selectedGoal,
          evidencePaths: planResult.evidencePaths,
        });
        continue;
      }

      const execResult = await appGraphExec({
        goal,
        plan: planResult,
        graphPath,
        projectRoot: args.projectRoot,
        udid: args.udid,
        deviceProfileId: args.deviceProfileId,
        outputDir: join(caseOutputDir, "exec"),
        planOnly: args.planOnly,
        allowLearning: args.allowDiscovery ?? true,
        model: args.model,
        agentTimeoutMs: args.agentTimeoutMs,
      });

      caseResults.push({
        caseId: c.case_id,
        title: c.title,
        priority: c.priority,
        tags: c.tags,
        goal,
        startedAt: new Date(caseStart).toISOString(),
        finishedAt: new Date().toISOString(),
        caseOutputDir,
        verdict: execResult.mode === "exec" ? execResult.verdict : "blocked",
        planResult: planResult,
        execResult: execResult.mode === "exec" ? execResult : undefined,
        reason:
          execResult.mode === "exec"
            ? execResult.verdictReason
            : "message" in execResult
              ? execResult.message
              : "Unknown error",
        expected: c.expected,
        selectedPlanningGoal: selectedGoal,
        evidencePaths: [
          planResult.planPath,
          ...(execResult.mode === "exec" ? execResult.evidencePaths : []),
        ],
      });
    } catch (err) {
      caseResults.push({
        caseId: c.case_id,
        title: c.title,
        priority: c.priority,
        tags: c.tags,
        goal,
        startedAt: new Date(caseStart).toISOString(),
        finishedAt: new Date().toISOString(),
        caseOutputDir,
        verdict: "blocked",
        reason: `Handler threw: ${err instanceof Error ? err.message : String(err)}`,
        expected: c.expected,
        evidencePaths: [],
      });
    }
  }

  phase("Aggregate");
  const summary = {
    total: caseResults.length,
    pass: caseResults.filter((c) => c.verdict === "pass").length,
    fail: caseResults.filter((c) => c.verdict === "fail").length,
    needsReview: caseResults.filter((c) => c.verdict === "needs_review").length,
    blocked: caseResults.filter((c) => c.verdict === "blocked").length,
  };

  phase("Report");
  const resultPath = join(outputDir, "result.json");
  const reportPath = join(outputDir, "report.json");
  const totalDurationMs = Date.now() - startedAt;

  const result: AppGraphAcceptResult = {
    success: summary.fail === 0 && summary.blocked === 0,
    mode: "accept",
    planOnly,
    outputDir,
    summary,
    cases: caseResults,
    reportPath,
    resultPath,
    totalDurationMs,
  };

  await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
  await writeFile(
    reportPath,
    JSON.stringify({ summary, generatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );

  log(
    `Status: ${result.success ? "PASS" : "ATTENTION"} | Cases: ${summary.total} · pass ${summary.pass} · fail ${summary.fail} · review ${summary.needsReview} · blocked ${summary.blocked}`,
  );

  return result;
}

export function buildPlanningGoalCandidates(c: StructuredCase): string[] {
  return [c.goal, c.title, c.step]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim())
    .filter((value, index, values) => values.indexOf(value) === index);
}

async function planCase(options: {
  goalCandidates: readonly string[];
  graphPath?: string;
  deviceProfileId?: string;
  udid?: string;
  outputDir: string;
  planOnly?: boolean;
  parameters?: Record<string, string>;
}): Promise<{ result: AppGraphPlanOutput; selectedGoal: string }> {
  let lastResult: AppGraphPlanOutput | undefined;
  let selectedGoal = options.goalCandidates[0] ?? "";
  for (const [index, candidate] of options.goalCandidates.entries()) {
    selectedGoal = candidate;
    const result = await appGraphPlan({
      goal: candidate,
      graphPath: options.graphPath,
      deviceProfileId: options.deviceProfileId,
      udid: options.udid,
      outputDir: join(options.outputDir, `candidate-${index + 1}`),
      planOnly: options.planOnly,
      parameters: options.parameters,
    });
    lastResult = result;
    if (result.success) {
      return { result, selectedGoal };
    }
    if (
      result.code !== "goal_unresolved" &&
      result.code !== "missing_required_parameters"
    ) {
      break;
    }
  }
  return {
    result: lastResult ?? {
      schemaVersion: "app-graph-semantic-plan-failure/v1",
      success: false,
      mode: "plan_failure",
      outputDir: options.outputDir,
      goal: selectedGoal,
      code: "goal_unresolved",
      message: "No planning goal candidate resolved.",
      recoverable: true,
      evidencePaths: [],
    },
    selectedGoal,
  };
}

async function loadCases(args: AppGraphAcceptInput): Promise<StructuredCase[]> {
  if (args.case) return [args.case];
  if (args.cases && args.cases.length > 0) return args.cases;
  if (args.caseSetPath) {
    const raw = await readFile(args.caseSetPath, "utf8");
    const parsed = JSON.parse(raw);
    const cases = Array.isArray(parsed) ? parsed : parsed.cases;
    if (!Array.isArray(cases)) {
      throw new Error(
        "Caseset JSON must be an array of cases or an object with a `cases` array.",
      );
    }
    return filterCases(cases, args.filterTags, args.filterCaseIds);
  }
  return [];
}

function filterCases(
  cases: StructuredCase[],
  filterTags?: string[],
  filterCaseIds?: (string | number)[],
): StructuredCase[] {
  let filtered = cases;
  if (filterTags && filterTags.length > 0) {
    const tagSet = new Set(filterTags);
    filtered = filtered.filter((c) => c.tags?.some((t) => tagSet.has(t)));
  }
  if (filterCaseIds && filterCaseIds.length > 0) {
    const idSet = new Set(filterCaseIds);
    filtered = filtered.filter((c) => idSet.has(c.case_id));
  }
  return filtered;
}

function fail(opts: {
  outputDir: string;
  code: string;
  message: string;
  recoverable: boolean;
}): AppGraphAcceptFailure {
  return {
    success: false,
    mode: "accept_failure",
    outputDir: opts.outputDir,
    code: opts.code,
    message: opts.message,
    recoverable: opts.recoverable,
    evidencePaths: [],
  };
}
