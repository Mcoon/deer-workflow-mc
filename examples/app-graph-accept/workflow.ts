import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";
import { agent } from "@deerwork-ai/deer-workflow/agents";
import type { JsonSchema } from "@deerwork-ai/deer-workflow/agents";

import appGraphPlan from "../app-graph-plan/workflow";
import appGraphExec, {
  parseInstalledAppVersion,
} from "../app-graph-exec/workflow";
import type {
  AppGraphPlanOutput,
  AppGraphPlanResult,
} from "../app-graph-plan/types";
import { loadGraph } from "../ios-ui-graph-manager";
import { runCommand } from "../ios-regression-kit";
import type { TaskOracle } from "../ios-ui-graph-manager/types";

import type {
  AppGraphAcceptFailure,
  AppGraphAcceptInput,
  AppGraphAcceptOutput,
  AppGraphAcceptResult,
  CaseRunResult,
  CaseVerification,
  CaseVerifyInput,
  StructuredCase,
} from "./types";

export { meta } from "./types";

const DEFAULT_OUTPUT_ROOT = join(
  homedir(),
  ".ios_pref_optimizer",
  "app-graph-accept",
);
const DEFAULT_GRAPH_PATH = resolve(
  dirname(import.meta.path),
  "../ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);

interface VerificationAgentDecision {
  readonly status: "compiled" | "covered" | "unsupported";
  readonly reason: string;
  readonly oracles: readonly {
    readonly type: string;
    readonly value: string;
    readonly values: readonly string[];
    readonly sceneId: string;
    readonly bundleId: string;
    readonly maximumSsim: number;
  }[];
}

const verificationAgentSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["compiled", "covered", "unsupported"],
    },
    reason: { type: "string" },
    oracles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "text_visible",
              "text_absent",
              "ui_text_visible",
              "ui_text_absent",
              "all_text_visible",
              "any_text_visible",
              "visual_changed",
              "foreground_bundle",
              "scene_current",
            ],
          },
          value: { type: "string" },
          values: { type: "array", items: { type: "string" } },
          sceneId: { type: "string" },
          bundleId: { type: "string" },
          maximumSsim: { type: "number" },
        },
        required: [
          "type",
          "value",
          "values",
          "sceneId",
          "bundleId",
          "maximumSsim",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["status", "reason", "oracles"],
  additionalProperties: false,
} as const satisfies JsonSchema;

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
  const graphPath = resolve(args.graphPath?.trim() || DEFAULT_GRAPH_PATH);
  const commandRunner = args.commandRunner ?? runCommand;
  let runtimeAppVersion = args.runtimeAppVersion?.trim() || undefined;
  if (!planOnly && !runtimeAppVersion && args.udid?.trim()) {
    try {
      const graph = await loadGraph(graphPath);
      const installed = await commandRunner(
        ["mobilecli", "apps", "list", "--device", args.udid.trim()],
        process.cwd(),
      );
      if (installed.exitCode === 0) {
        runtimeAppVersion = parseInstalledAppVersion(
          installed.stdout,
          graph.bundleId,
        );
      }
    } catch {
      log(
        "Installed App version is unavailable; case execution will remain guarded.",
      );
    }
  }

  phase("Run Cases");
  const caseResults: CaseRunResult[] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const caseStart = Date.now();
    const caseOutputDir = join(outputDir, "cases", String(c.case_id));
    await mkdir(caseOutputDir, { recursive: true });

    const goalCandidates = buildPlanningGoalCandidates(c);
    const goal = goalCandidates[0]!;
    let verification = normalizeCaseVerification(c);
    let warnings = buildCaseWarnings(c, verification);
    const verificationPath = join(caseOutputDir, "verification.json");
    log(`Case ${i + 1}/${cases.length}: ${c.case_id} — ${c.title}`);
    if (
      verification.issues.length > 0 &&
      !verificationIssuesRequireAgent(verification)
    ) {
      await writeCaseVerification(
        verificationPath,
        c.expected,
        warnings,
        verification,
      );
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
        reason: `Verify conditions are invalid or unsupported: ${verification.issues.join("; ")}`,
        expected: c.expected,
        warnings,
        verification,
        verificationPath,
        evidencePaths: [verificationPath],
      });
      continue;
    }

    try {
      const { result: planResult, selectedGoal } = await planCase({
        goalCandidates,
        graphPath,
        deviceProfileId: args.deviceProfileId,
        udid: args.udid,
        runtimeAppVersion,
        outputDir: join(caseOutputDir, "plan"),
        planOnly: args.planOnly,
        parameters: c.parameters,
      });

      if (!planResult.success) {
        await writeCaseVerification(
          verificationPath,
          c.expected,
          warnings,
          verification,
        );
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
          warnings,
          verification,
          verificationPath,
          evidencePaths: uniquePaths([
            verificationPath,
            ...planResult.evidencePaths,
          ]),
        });
        continue;
      }

      verification = await resolveCaseVerification({
        structuredCase: c,
        initial: verification,
        plan: planResult,
        agentCwd: resolve(args.agentCwd?.trim() || process.cwd()),
        model: args.model,
        timeoutMs: Math.max(1_000, args.agentTimeoutMs ?? 60_000),
        agentRunner: args.agentRunner,
      });
      warnings = buildCaseWarnings(c, verification);
      await writeCaseVerification(
        verificationPath,
        c.expected,
        warnings,
        verification,
      );
      if (verification.issues.length > 0) {
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
          reason: `Verify conditions are invalid or unsupported: ${verification.issues.join("; ")}`,
          expected: c.expected,
          selectedPlanningGoal: selectedGoal,
          warnings,
          verification,
          verificationPath,
          evidencePaths: uniquePaths([verificationPath, planResult.planPath]),
        });
        continue;
      }

      const planForExec = await appendCaseOraclesToPlan({
        plan: planResult,
        caseOracles: verification.oracles,
        outputDir: caseOutputDir,
      });

      const execResult = await appGraphExec({
        goal,
        plan: planForExec,
        learningPlan: planResult,
        graphPath,
        projectRoot: args.projectRoot,
        udid: args.udid,
        deviceProfileId: args.deviceProfileId,
        outputDir: join(caseOutputDir, "exec"),
        planOnly: args.planOnly,
        allowLearning: args.allowDiscovery ?? true,
        runtimeAppVersion,
        runtimeAppVersionChecked: true,
        preferFastPath: false,
        model: args.model,
        agentTimeoutMs: args.agentTimeoutMs,
        agentCwd: args.agentCwd,
        agentRunner: args.agentRunner,
        commandRunner,
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
        planResult: planForExec,
        execResult: execResult.mode === "exec" ? execResult : undefined,
        reason:
          execResult.mode === "exec"
            ? execResult.verdictReason
            : "message" in execResult
              ? execResult.message
              : "Unknown error",
        expected: c.expected,
        selectedPlanningGoal: selectedGoal,
        warnings,
        verification,
        verificationPath,
        evidencePaths: uniquePaths([
          verificationPath,
          planResult.planPath,
          planForExec.planPath,
          ...(execResult.mode === "exec" ? execResult.evidencePaths : []),
        ]),
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
        warnings,
        verification,
        verificationPath,
        evidencePaths: [verificationPath],
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

function buildCaseWarnings(
  c: StructuredCase,
  verification: CaseVerification,
): string[] {
  const warnings: string[] = [];
  if (c.expected.trim() && !verification.supplied) {
    warnings.push(
      "`expected` is acceptance context only; add case-level `verify` or `oracles` for machine-checked assertions.",
    );
  }
  return warnings;
}

export function normalizeCaseVerification(c: StructuredCase): CaseVerification {
  const sources: Array<"oracles" | "verify" | "expected"> = [];
  const oracles: TaskOracle[] = [];
  const issues: string[] = [];
  if (c.oracles !== undefined) {
    sources.push("oracles");
    collectVerifyInput(c.oracles, "oracles", oracles, issues);
  }
  if (c.verify !== undefined) {
    sources.push("verify");
    collectVerifyInput(c.verify, "verify", oracles, issues);
  }
  if (sources.length === 0 && c.expected.trim()) {
    const expectedOracles = parseVerifyText(c.expected);
    if (expectedOracles.length > 0) {
      sources.push("expected");
      oracles.push(...expectedOracles);
    }
  }
  if (sources.length > 0 && oracles.length === 0 && issues.length === 0) {
    issues.push("verification input did not contain any conditions");
  }
  return {
    supplied: sources.length > 0,
    sources,
    oracles: dedupeOracles(oracles),
    issues: [...new Set(issues)],
    compiler: sources.length > 0 ? "deterministic" : "none",
    reason: sources.includes("expected")
      ? "Compiled the case expected text with deterministic rules."
      : undefined,
  };
}

export async function resolveCaseVerification(options: {
  structuredCase: StructuredCase;
  initial?: CaseVerification;
  plan: AppGraphPlanResult;
  agentCwd: string;
  model?: string;
  timeoutMs: number;
  agentRunner?: AppGraphAcceptInput["agentRunner"];
}): Promise<CaseVerification> {
  const initial =
    options.initial ?? normalizeCaseVerification(options.structuredCase);
  if (initial.supplied && initial.issues.length === 0) return initial;
  if (
    initial.supplied &&
    initial.issues.length > 0 &&
    !verificationIssuesRequireAgent(initial)
  ) {
    return initial;
  }

  const expected = options.structuredCase.expected.trim();
  const deterministicExpected =
    !initial.supplied && expected ? parseVerifyText(expected) : [];
  if (deterministicExpected.length > 0) {
    return {
      supplied: true,
      sources: ["expected"],
      oracles: dedupeOracles(deterministicExpected),
      issues: [],
      compiler: "deterministic",
      reason: "Compiled the case expected text with deterministic rules.",
    };
  }
  const source = initial.supplied
    ? {
        verify: options.structuredCase.verify,
        oracles: options.structuredCase.oracles,
      }
    : expected;
  if (!initial.supplied && !expected) return initial;

  try {
    const decision = await runVerificationCompilerAgent({
      structuredCase: options.structuredCase,
      source,
      plan: options.plan,
      agentCwd: options.agentCwd,
      model: options.model,
      timeoutMs: options.timeoutMs,
      agentRunner: options.agentRunner,
    });
    if (decision.status === "unsupported") {
      return {
        supplied: true,
        sources: initial.supplied ? initial.sources : ["expected"],
        oracles: initial.oracles,
        issues: [
          decision.reason || "Agent could not compile verify conditions.",
        ],
        compiler: "agent",
        reason: decision.reason,
      };
    }
    const compiled: TaskOracle[] = [];
    const issues: string[] = [];
    decision.oracles.forEach((oracle, index) => {
      const normalized = normalizeVerifyObject(oracle);
      if (normalized) compiled.push(normalized);
      else issues.push(`agent.oracles[${index}]: invalid Oracle`);
    });
    if (compiled.length === 0) {
      issues.push(
        `Agent reported ${decision.status} verification without any valid Oracle.`,
      );
    }
    return {
      supplied: true,
      sources: initial.supplied ? initial.sources : ["expected"],
      oracles: dedupeOracles([...initial.oracles, ...compiled]),
      issues,
      compiler: "agent",
      reason: decision.reason,
    };
  } catch (error) {
    return {
      supplied: true,
      sources: initial.supplied ? initial.sources : ["expected"],
      oracles: initial.oracles,
      issues: [
        `verification Agent failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      compiler: "agent",
    };
  }
}

function verificationIssuesRequireAgent(
  verification: CaseVerification,
): boolean {
  return (
    verification.issues.length > 0 &&
    verification.issues.every((issue) =>
      issue.includes(": unsupported natural-language condition "),
    )
  );
}

async function runVerificationCompilerAgent(options: {
  structuredCase: StructuredCase;
  source: unknown;
  plan: AppGraphPlanResult;
  agentCwd: string;
  model?: string;
  timeoutMs: number;
  agentRunner?: AppGraphAcceptInput["agentRunner"];
}): Promise<VerificationAgentDecision> {
  const prompt = [
    "Compile user-supplied iOS acceptance verification into deterministic App Graph Oracles.",
    "Return only schema-backed JSON. Do not operate devices, run commands, or modify files.",
    "Use only these Oracle types: ui_text_visible, ui_text_absent, all_text_visible, any_text_visible, scene_current, foreground_bundle, visual_changed.",
    "Use status=covered only when the existing Plan finalOracles fully and unambiguously verify the supplied condition; return the exact covering Plan Oracles in oracles.",
    "Use status=unsupported when any required condition cannot be represented without guessing; never return only a partial interpretation.",
    "For compiled, include every required condition. Leave irrelevant fields empty and maximumSsim at 0.",
    "Do not infer screen text that is not explicitly named by the user.",
    "",
    `Case: ${JSON.stringify({ title: options.structuredCase.title, step: options.structuredCase.step, expected: options.structuredCase.expected })}`,
    `Verification input: ${JSON.stringify(options.source)}`,
    `Plan target: ${JSON.stringify(options.plan.targetScene ?? null)}`,
    `Existing Plan finalOracles: ${JSON.stringify(options.plan.finalOracles)}`,
  ].join("\n");
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `verification compiler timed out after ${options.timeoutMs} ms.`,
        ),
      ),
    options.timeoutMs,
  );
  try {
    return await (options.agentRunner ?? agent)<VerificationAgentDecision>(
      prompt,
      {
        cwd: options.agentCwd,
        model: options.model,
        sandbox: "read-only",
        schema: verificationAgentSchema,
        env: { CODEX_HOME: undefined },
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function writeCaseVerification(
  path: string,
  expected: string,
  warnings: readonly string[],
  verification: CaseVerification,
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({ expected, warnings, ...verification }, null, 2),
    "utf8",
  );
}

function collectVerifyInput(
  input: CaseVerifyInput | readonly TaskOracle[],
  path: string,
  oracles: TaskOracle[],
  issues: string[],
): void {
  if (Array.isArray(input)) {
    input.forEach((item, index) =>
      collectVerifyInput(item, `${path}[${index}]`, oracles, issues),
    );
    return;
  }
  if (typeof input === "string") {
    const parsed = parseVerifyText(input);
    if (parsed.length === 0) {
      issues.push(
        `${path}: unsupported natural-language condition ${JSON.stringify(input)}`,
      );
    } else {
      oracles.push(...parsed);
    }
    return;
  }
  if (!input || typeof input !== "object") {
    issues.push(
      `${path}: expected an Oracle, text condition, array, or verification group`,
    );
    return;
  }
  const value = input as Record<string, unknown>;
  const nestedKeys = [
    "oracle",
    "condition",
    "oracles",
    "conditions",
    "assertions",
    "checks",
  ] as const;
  const nested = nestedKeys.filter((key) => value[key] !== undefined);
  if (nested.length > 0 && !verificationType(value)) {
    for (const key of nested) {
      collectVerifyInput(
        value[key] as CaseVerifyInput,
        `${path}.${key}`,
        oracles,
        issues,
      );
    }
    return;
  }
  const oracle = normalizeVerifyObject(value);
  if (oracle) {
    oracles.push(oracle);
  } else {
    issues.push(
      `${path}: unsupported verification object ${JSON.stringify(value)}`,
    );
  }
}

function verificationType(value: Record<string, unknown>): string | undefined {
  const candidate = value.type ?? value.kind ?? value.checkType;
  return typeof candidate === "string" ? candidate.trim() : undefined;
}

function normalizeVerifyObject(
  value: Record<string, unknown>,
): TaskOracle | undefined {
  const rawType = verificationType(value);
  const text = textField(value.value ?? value.text ?? value.expected);
  if (!rawType && text && typeof value.visible === "boolean") {
    return {
      type: value.visible ? "ui_text_visible" : "ui_text_absent",
      value: text,
    };
  }
  const type = normalizeVerifyType(rawType ?? "");
  if (
    type === "all_text_visible" ||
    type === "any_text_visible" ||
    type === "region_stable"
  ) {
    const values = stringList(value.values ?? value.value);
    return values.length > 0 ? { type, values } : undefined;
  }
  if (
    type === "text_visible" ||
    type === "text_absent" ||
    type === "ui_text_visible" ||
    type === "ui_text_absent"
  ) {
    return text ? { type, value: text } : undefined;
  }
  if (type === "scene_current") {
    const sceneId = textField(value.sceneId ?? value.scene_id ?? value.value);
    return sceneId ? { type, sceneId } : undefined;
  }
  if (type === "foreground_bundle") {
    const bundleId = textField(
      value.bundleId ?? value.bundle_id ?? value.value,
    );
    return bundleId ? { type, bundleId } : undefined;
  }
  if (type === "visual_changed") {
    const maximumSsim = value.maximumSsim ?? value.maximum_ssim;
    return typeof maximumSsim === "number" &&
      Number.isFinite(maximumSsim) &&
      maximumSsim >= 0 &&
      maximumSsim <= 1
      ? { type, maximumSsim }
      : undefined;
  }
  return undefined;
}

function normalizeVerifyType(type: string): TaskOracle["type"] | undefined {
  const normalized = type.trim().toLocaleLowerCase().replace(/[ -]+/g, "_");
  const aliases: Record<string, TaskOracle["type"]> = {
    visible: "ui_text_visible",
    text_visible: "text_visible",
    ui_text_visible: "ui_text_visible",
    contains_text: "ui_text_visible",
    all_visible: "all_text_visible",
    all_text_visible: "all_text_visible",
    any_visible: "any_text_visible",
    any_text_visible: "any_text_visible",
    absent: "ui_text_absent",
    text_absent: "text_absent",
    ui_text_absent: "ui_text_absent",
    not_contains_text: "ui_text_absent",
    scene: "scene_current",
    scene_current: "scene_current",
    foreground: "foreground_bundle",
    foreground_bundle: "foreground_bundle",
    visual_changed: "visual_changed",
    region_stable: "region_stable",
  };
  return aliases[normalized];
}

function parseVerifyText(input: string): TaskOracle[] {
  const text = input
    .trim()
    .replace(/^[\s•*-]+/, "")
    .replace(/[。；;]+$/, "");
  if (!text) return [];
  const scene = text.match(
    /^(?:当前页面|页面|场景)?(?:为|是|应为|应该是)?\s*scene[:：]\s*([a-z0-9_.:-]+)$/i,
  );
  if (scene?.[1]) return [{ type: "scene_current", sceneId: scene[1] }];
  const bundle = text.match(
    /^(?:前台)?(?:应用|包名|bundle(?:Id)?)?(?:为|是|应为|应该是)?\s*(?:bundle[:：]\s*)?([a-z][a-z0-9]*(?:[.-][a-z0-9]+){2,})$/i,
  );
  if (bundle?.[1]) return [{ type: "foreground_bundle", bundleId: bundle[1] }];
  const absent = /(?:不显示|不可见|不存在|不包含|不应显示|不应出现|消失)/.test(
    text,
  );
  const positiveText = text.replace(
    /(?:不显示|不可见|不存在|不包含|不应显示|不应出现)/g,
    "",
  );
  const visible = /(?:显示|可见|存在|包含|出现|看到)/.test(positiveText);
  if (absent && visible) return [];
  const quoted = [...text.matchAll(/[“"']([^”"']+)[”"']/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (quoted.length > 0 && (absent || visible)) {
    const unquoted = text
      .replace(/[“"'][^”"']+[”"']/g, "")
      .replace(
        /(?:验证|校验|确认|检查|页面|应|应该|需要|需|不显示|不可见|不存在|不包含|不应显示|不应出现|显示|可见|存在|包含|出现|能看到|可以看到|并且|并|以及|及|和|中|里|上|下|底部|顶部|正文|内容|区域|入口|按钮|文本)/g,
        "",
      )
      .replace(/[\s、,，。；;：:]+/g, "");
    if (unquoted) return [];
    return quoted.map((value) => ({
      type: absent ? "ui_text_absent" : "ui_text_visible",
      value,
    }));
  }
  const match = text.match(
    /^(?:验证|校验|确认|检查)?[:：\s]*(?:页面)?(?:应|应该|需要|需)?(不显示|不可见|不存在|不包含|不应显示|不应出现|显示|可见|存在|包含|出现|能看到|可以看到)[:：\s]*(.+)$/u,
  );
  if (match?.[2]) {
    const negative = /^(?:不|不可|不存在)/.test(match[1] ?? "");
    return splitVerifyValues(match[2]).map((value) => ({
      type: negative ? "ui_text_absent" : "ui_text_visible",
      value,
    }));
  }
  return [];
}

function splitVerifyValues(value: string): string[] {
  return value
    .split(/(?:、|,|，|以及|及|和)/u)
    .map((item) => item.trim().replace(/^[“"']|[”"']$/g, ""))
    .filter(Boolean);
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

async function appendCaseOraclesToPlan(options: {
  plan: AppGraphPlanResult;
  caseOracles: readonly TaskOracle[];
  outputDir: string;
}): Promise<AppGraphPlanResult> {
  if (options.caseOracles.length === 0) return options.plan;

  const finalOracles = dedupeOracles([
    ...options.plan.finalOracles,
    ...options.caseOracles,
  ]);
  const planPath = join(options.outputDir, "plan-with-case-oracles.json");
  const plan = {
    ...options.plan,
    finalOracles,
    planPath,
  };
  await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
  return plan;
}

function dedupeOracles(oracles: readonly TaskOracle[]): TaskOracle[] {
  const seen = new Set<string>();
  const result: TaskOracle[] = [];
  for (const oracle of oracles) {
    const key = oracleKey(oracle);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(oracle);
  }
  return result;
}

function oracleKey(oracle: TaskOracle): string {
  const type =
    oracle.type === "text_visible"
      ? "ui_text_visible"
      : oracle.type === "text_absent"
        ? "ui_text_absent"
        : oracle.type;
  return JSON.stringify({
    type,
    value: oracle.value?.trim(),
    sceneId: oracle.sceneId?.trim(),
    bundleId: oracle.bundleId?.trim(),
    values: oracle.values?.map((value) => value.trim()),
    maximumSsim: oracle.maximumSsim,
  });
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

async function planCase(options: {
  goalCandidates: readonly string[];
  graphPath?: string;
  deviceProfileId?: string;
  udid?: string;
  runtimeAppVersion?: string;
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
      runtimeAppVersion: options.runtimeAppVersion,
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
