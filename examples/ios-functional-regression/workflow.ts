import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import {
  DEFAULT_ARTIFACT_ROOT,
  assetLayout,
  buildMobilecliActionCommand,
  buildMobilecliForegroundCommand,
  buildMobilecliPreflightCommand,
  buildMobilecliScreenshotCommand,
  buildMobilecliUiDumpCommand,
  compileNavigationPlanActions,
  fileExists,
  fingerprintUi,
  loadControls,
  loadDeviceProfiles,
  loadPage,
  loadPages,
  matchUiElement,
  parseUiDump,
  planNavigation,
  readJson,
  renderRegressionHtml,
  resolvePageReference,
  resolveTapPoint,
  runCommand,
  validateCaseSet,
  writeJsonAtomic,
} from "../ios-regression-kit";

import type {
  ActionExecution,
  CaseExecution,
  DeviceProfile,
  NavigationGraph,
  PageIndex,
  RegressionAction,
  RegressionAssertion,
  RegressionCase,
  RegressionCaseSet,
  UiControl,
  UiElement,
} from "../ios-regression-kit/types";
import type {
  IosFunctionalRegressionInput,
  IosFunctionalRegressionResult,
} from "./types";

const DEFAULT_SETTLE_MS = 700;

export const meta = {
  name: "ios-functional-regression",
  description:
    "Runs validated iOS regression cases serially with mobilecli and produces structured evidence and an HTML report.",
  phases: [
    { title: "Prepare" },
    { title: "Preflight" },
    { title: "Execute" },
    { title: "Evaluate" },
    { title: "Report" },
  ],
  exampleArgs: {
    udid: "00008030-001A286A2229802E",
    bundleId: "com.bot.doubao",
    caseSetPath:
      "/Users/bytedance/Documents/BDWorkSpace/ios-perf-optimizer/assets/app-regression/com.bot.doubao/cases/com.bot.doubao-regression.cases.json",
    priorities: ["P0"],
  },
};

export default async function iosFunctionalRegression(
  args: IosFunctionalRegressionInput,
): Promise<IosFunctionalRegressionResult> {
  const input = normalizeInput(args);

  phase("Prepare");
  await mkdir(input.outputDir, { recursive: true });
  if (input.captureVideo) {
    throw new Error(
      "captureVideo is not supported by the serialized mobilecli executor yet. Run with captureVideo=false; per-step screenshots and UI dumps remain enabled.",
    );
  }
  if (!(await fileExists(input.caseSetPath))) {
    throw new Error(`Case set does not exist: ${input.caseSetPath}`);
  }
  const layout = assetLayout(input.bundleId, input.assetRoot);
  const caseSet = await readJson<RegressionCaseSet>(input.caseSetPath);
  if (caseSet.bundleId !== input.bundleId) {
    throw new Error(
      `Case set bundleId ${caseSet.bundleId} does not match ${input.bundleId}.`,
    );
  }
  const controls = (await loadControls(layout.controlsPath)).controls;
  const pages = await loadPages(layout.pagesDirectory);
  const profiles = await loadDeviceProfiles(layout.deviceProfilesPath);
  const profile = chooseDeviceProfile(profiles.profiles, input.deviceProfileId);
  const validation = validateCaseSet(
    caseSet,
    controls,
    new Set(pages.map((page) => page.pageId)),
  );
  if (!validation.valid) {
    throw new Error(
      [
        "Regression case set failed deterministic validation.",
        ...validation.issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );
  }
  const selectedSourceCases = selectCases(caseSet.cases, input);
  const needsNavigationGraph = selectedSourceCases.some((regressionCase) =>
    regressionCase.actions.some((action) => action.type === "navigate"),
  );
  const navigationAssets = needsNavigationGraph
    ? await Promise.all([
        readJson<NavigationGraph>(layout.graphPath),
        readJson<PageIndex>(layout.pageIndexPath),
      ])
    : null;
  const selectedCases = selectedSourceCases.map((regressionCase) =>
    expandNavigationActions({
      regressionCase,
      graph: navigationAssets?.[0],
      pageIndex: navigationAssets?.[1],
      bundleId: input.bundleId,
    }),
  );
  const expandedValidation = validateCaseSet(
    {
      ...caseSet,
      cases: selectedCases,
    },
    controls,
    new Set(pages.map((page) => page.pageId)),
  );
  if (!expandedValidation.valid) {
    throw new Error(
      [
        "Expanded regression cases failed deterministic validation.",
        ...expandedValidation.issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );
  }
  if (selectedCases.length === 0) {
    throw new Error("No regression cases matched the supplied filters.");
  }
  log(
    [
      "## Preparing iOS functional regression",
      `- **Bundle:** \`${input.bundleId}\``,
      `- **Device:** \`${input.udid}\``,
      `- **Cases:** ${selectedCases.length}/${caseSet.cases.length}`,
      `- **Device profile:** \`${profile.profileId}\``,
      `- **Output:** \`${input.outputDir}\``,
    ].join("\n"),
  );

  phase("Preflight");
  const preflight = await runCommand(
    buildMobilecliPreflightCommand(input.mobilecliPreflightPath),
    input.projectRoot,
  );
  await writeFile(
    join(input.outputDir, "mobilecli-preflight.stdout.txt"),
    preflight.stdout,
    "utf8",
  );
  await writeFile(
    join(input.outputDir, "mobilecli-preflight.stderr.txt"),
    preflight.stderr,
    "utf8",
  );
  if (preflight.exitCode !== 0) {
    throw new Error(
      `mobilecli preflight failed with exit code ${preflight.exitCode}.`,
    );
  }

  phase("Execute");
  const executions: CaseExecution[] = [];
  for (const regressionCase of selectedCases) {
    const execution = await executeCase({
      regressionCase,
      input,
      layout,
      controls,
      profile,
    });
    executions.push(execution);
    log(
      `- **${regressionCase.title}**: \`${execution.verdict}\` · ${execution.actions.length} action(s)`,
    );
    if (input.stopOnFailure && execution.verdict !== "pass") {
      break;
    }
  }

  phase("Evaluate");
  const counts = {
    passed: executions.filter((item) => item.verdict === "pass").length,
    failed: executions.filter((item) => item.verdict === "fail").length,
    blocked: executions.filter((item) => item.verdict === "blocked").length,
    needsReview: executions.filter((item) => item.verdict === "needs_review")
      .length,
  };
  const success =
    executions.length === selectedCases.length &&
    counts.failed === 0 &&
    counts.blocked === 0 &&
    counts.needsReview === 0;

  phase("Report");
  const reportPath = join(input.outputDir, "functional-regression-report.html");
  const summaryPath = join(input.outputDir, "summary.json");
  const report = renderRegressionHtml({
    title: "iOS Functional Regression",
    subtitle:
      "Deterministic mobilecli execution. Every device action is serial and each case keeps its own evidence.",
    summary: [
      { label: "Total", value: String(executions.length) },
      { label: "Passed", value: String(counts.passed) },
      { label: "Failed", value: String(counts.failed) },
      { label: "Blocked", value: String(counts.blocked) },
      { label: "Needs Review", value: String(counts.needsReview) },
    ],
    rows: executions.map((execution) => ({
      id: execution.caseId,
      title: execution.title,
      verdict: execution.verdict,
      details:
        execution.issues.join(" ") ||
        `${execution.actions.length} actions completed`,
      evidence: relative(
        input.outputDir,
        join(input.outputDir, "case-run", safeSegment(execution.caseId)),
      ),
    })),
  });
  await writeFile(reportPath, report, "utf8");
  await writeJsonAtomic(summaryPath, {
    schemaVersion: "ios-functional-regression-result/v1",
    success,
    bundleId: input.bundleId,
    caseSetPath: input.caseSetPath,
    deviceProfileId: profile.profileId,
    total: executions.length,
    ...counts,
    cases: executions,
    reportPath,
  });

  return {
    success,
    outputDir: input.outputDir,
    caseSetPath: input.caseSetPath,
    reportPath,
    summaryPath,
    total: executions.length,
    ...counts,
    cases: executions,
  };
}

interface NormalizedInput {
  projectRoot: string;
  udid: string;
  bundleId: string;
  caseSetPath: string;
  assetRoot?: string;
  outputDir: string;
  mobilecliPreflightPath?: string;
  deviceProfileId?: string;
  priorities: ReadonlySet<string>;
  tags: ReadonlySet<string>;
  caseIds: ReadonlySet<string>;
  settleMs: number;
  stopOnFailure: boolean;
  captureVideo: boolean;
}

function normalizeInput(args: IosFunctionalRegressionInput): NormalizedInput {
  if (!args) {
    throw new TypeError("iOS Functional Regression requires input arguments.");
  }
  const bundleId = requiredText(args.bundleId, "bundleId");
  const runId = safeSegment(args.runId?.trim() || timestampForPath());
  return {
    projectRoot: resolve(args.projectRoot?.trim() || process.cwd()),
    udid: requiredText(args.udid, "udid"),
    bundleId,
    caseSetPath: resolve(requiredText(args.caseSetPath, "caseSetPath")),
    assetRoot: args.assetRoot?.trim() || undefined,
    outputDir: resolve(
      args.outputDir?.trim() ||
        join(DEFAULT_ARTIFACT_ROOT, "ios-functional-regression", runId),
    ),
    mobilecliPreflightPath: args.mobilecliPreflightPath?.trim() || undefined,
    deviceProfileId: args.deviceProfileId?.trim() || undefined,
    priorities: new Set(args.priorities ?? []),
    tags: new Set(args.tags ?? []),
    caseIds: new Set(args.caseIds ?? []),
    settleMs: boundedInteger(args.settleMs, 0, 10000, DEFAULT_SETTLE_MS),
    stopOnFailure: args.stopOnFailure === true,
    captureVideo: args.captureVideo === true,
  };
}

async function executeCase(options: {
  regressionCase: RegressionCase;
  input: NormalizedInput;
  layout: ReturnType<typeof assetLayout>;
  controls: readonly UiControl[];
  profile: DeviceProfile;
}): Promise<CaseExecution> {
  const caseDirectory = join(
    options.input.outputDir,
    "case-run",
    safeSegment(options.regressionCase.caseId),
  );
  await mkdir(caseDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const actions: ActionExecution[] = [];
  const issues: string[] = [];
  let currentPageId: string | undefined;
  let latestElements: UiElement[] = [];

  const preconditions = await evaluateAssertions({
    assertions: options.regressionCase.preconditions,
    bundleId: options.input.bundleId,
    caseDirectory,
    controls: options.controls,
    currentPageId,
    elements: latestElements,
    profile: options.profile,
    udid: options.input.udid,
    layout: options.layout,
    prefix: "00-precondition",
  });
  if (!preconditions.success) {
    issues.push(...preconditions.issues);
    return finishCase({
      regressionCase: options.regressionCase,
      startedAt,
      actions,
      issues,
      verdict: "blocked",
      caseDirectory,
    });
  }
  latestElements = preconditions.elements;
  currentPageId = preconditions.currentPageId;

  for (const [index, action] of options.regressionCase.actions.entries()) {
    const prefix = String(index + 1).padStart(2, "0");
    const before = await evaluateAssertions({
      assertions: action.assertBefore ?? [],
      bundleId: options.input.bundleId,
      caseDirectory,
      controls: options.controls,
      currentPageId,
      elements: latestElements,
      profile: options.profile,
      udid: options.input.udid,
      layout: options.layout,
      prefix: `${prefix}-before`,
    });
    if (!before.success) {
      issues.push(...before.issues);
      actions.push({
        actionId: action.actionId,
        type: action.type,
        success: false,
        exitCode: 2,
        message: before.issues.join(" "),
      });
      break;
    }
    latestElements = before.elements;
    currentPageId = before.currentPageId;

    const executed = await executeRegressionAction({
      action,
      bundleId: options.input.bundleId,
      caseDirectory,
      controls: options.controls,
      currentPageId,
      elements: latestElements,
      prefix,
      profile: options.profile,
      udid: options.input.udid,
      layout: options.layout,
    });
    actions.push(executed.execution);
    if (!executed.execution.success) {
      issues.push(
        executed.execution.message || `Action ${action.actionId} failed.`,
      );
      break;
    }
    currentPageId = executed.currentPageId;
    latestElements = executed.elements;
    if (action.type !== "wait" && options.input.settleMs > 0) {
      await Bun.sleep(options.input.settleMs);
    }

    const after = await evaluateAssertions({
      assertions: action.assertAfter ?? [],
      bundleId: options.input.bundleId,
      caseDirectory,
      controls: options.controls,
      currentPageId,
      elements: latestElements,
      profile: options.profile,
      udid: options.input.udid,
      layout: options.layout,
      prefix: `${prefix}-after`,
    });
    latestElements = after.elements;
    currentPageId = after.currentPageId;
    if (!after.success) {
      issues.push(...after.issues);
      break;
    }
  }

  let verdict: CaseExecution["verdict"] = issues.length ? "fail" : "pass";
  if (!issues.length) {
    const expected = await evaluateAssertions({
      assertions: options.regressionCase.expected,
      bundleId: options.input.bundleId,
      caseDirectory,
      controls: options.controls,
      currentPageId,
      elements: latestElements,
      profile: options.profile,
      udid: options.input.udid,
      layout: options.layout,
      prefix: "99-expected",
    });
    if (!expected.success) {
      issues.push(...expected.issues);
      verdict = "fail";
    }
  }

  return finishCase({
    regressionCase: options.regressionCase,
    startedAt,
    actions,
    issues,
    verdict,
    caseDirectory,
  });
}

async function executeRegressionAction(options: {
  action: RegressionAction;
  bundleId: string;
  caseDirectory: string;
  controls: readonly UiControl[];
  currentPageId?: string;
  elements: readonly UiElement[];
  prefix: string;
  profile: DeviceProfile;
  udid: string;
  layout: ReturnType<typeof assetLayout>;
}): Promise<{
  execution: ActionExecution;
  currentPageId?: string;
  elements: UiElement[];
}> {
  if (options.action.type === "snapshot") {
    const captured = await captureState({
      caseDirectory: options.caseDirectory,
      prefix: `${options.prefix}-${safeSegment(options.action.pageId)}`,
      udid: options.udid,
    });
    const pageVerification = captured.success
      ? await verifyCapturedPage({
          pageId: options.action.pageId,
          layout: options.layout,
          controls: options.controls,
          elements: captured.elements,
        })
      : {
          success: false,
          issue: captured.issue ?? "Snapshot evidence capture failed.",
        };
    return {
      execution: {
        actionId: options.action.actionId,
        type: options.action.type,
        success: captured.success && pageVerification.success,
        exitCode: captured.success && pageVerification.success ? 0 : 2,
        message: captured.issue ?? pageVerification.issue,
        screenshotPath: captured.screenshotPath,
        uiDumpPath: captured.uiDumpPath,
      },
      currentPageId:
        captured.success && pageVerification.success
          ? options.action.pageId
          : options.currentPageId,
      elements: captured.elements,
    };
  }

  let tapPoint: { x: number; y: number } | undefined;
  if (options.action.type === "tap") {
    const resolved = resolveTapPoint({
      action: options.action,
      controls: options.controls,
      elements: options.elements,
      profile: options.profile,
      currentPageId: options.currentPageId,
    });
    if (!resolved.point) {
      return {
        execution: {
          actionId: options.action.actionId,
          type: options.action.type,
          success: false,
          exitCode: 2,
          message: resolved.issue,
        },
        currentPageId: options.currentPageId,
        elements: [...options.elements],
      };
    }
    tapPoint = resolved.point;
  }

  const command = buildMobilecliActionCommand({
    action: options.action,
    udid: options.udid,
    bundleId: options.bundleId,
    tapPoint,
  });
  const result = await runCommand(command);
  await writeFile(
    join(
      options.caseDirectory,
      `${options.prefix}-${safeSegment(options.action.actionId)}.stdout.txt`,
    ),
    result.stdout,
    "utf8",
  );
  await writeFile(
    join(
      options.caseDirectory,
      `${options.prefix}-${safeSegment(options.action.actionId)}.stderr.txt`,
    ),
    result.stderr,
    "utf8",
  );
  return {
    execution: {
      actionId: options.action.actionId,
      type: options.action.type,
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      command,
      message:
        result.exitCode === 0
          ? undefined
          : result.stderr || result.stdout || "mobilecli action failed",
    },
    currentPageId:
      options.action.type === "launch_app" ||
      options.action.type === "terminate_app"
        ? undefined
        : options.currentPageId,
    elements: [...options.elements],
  };
}

async function verifyCapturedPage(options: {
  pageId: string;
  layout: ReturnType<typeof assetLayout>;
  controls: readonly UiControl[];
  elements: readonly UiElement[];
}): Promise<{ success: boolean; issue?: string }> {
  const page = await loadPage(options.layout.pagesDirectory, options.pageId);
  if (!page) {
    return {
      success: false,
      issue: `Page asset is missing: ${options.pageId}.`,
    };
  }
  const anchors = page.anchorControlIds
    .map((controlId) =>
      options.controls.find(
        (control) =>
          control.controlId === controlId && control.pageId === options.pageId,
      ),
    )
    .filter((control): control is UiControl => control !== undefined);
  const anchorsMatch =
    anchors.length > 0 &&
    anchors.every((control) =>
      matchUiElement(options.elements, control.selector),
    );
  const fingerprintMatches =
    fingerprintUi(options.elements) === page.fingerprint;
  return {
    success: anchorsMatch || fingerprintMatches,
    issue:
      anchorsMatch || fingerprintMatches
        ? undefined
        : `Captured UI does not match page ${options.pageId}.`,
  };
}

async function evaluateAssertions(options: {
  assertions: readonly RegressionAssertion[];
  bundleId: string;
  caseDirectory: string;
  controls: readonly UiControl[];
  currentPageId?: string;
  elements: readonly UiElement[];
  profile: DeviceProfile;
  udid: string;
  layout: ReturnType<typeof assetLayout>;
  prefix: string;
}): Promise<{
  success: boolean;
  issues: string[];
  elements: UiElement[];
  currentPageId?: string;
}> {
  if (options.assertions.length === 0) {
    return {
      success: true,
      issues: [],
      elements: [...options.elements],
      currentPageId: options.currentPageId,
    };
  }
  const captured = await captureState({
    caseDirectory: options.caseDirectory,
    prefix: options.prefix,
    udid: options.udid,
  });
  if (!captured.success) {
    return {
      success: false,
      issues: [captured.issue || "Unable to capture assertion state."],
      elements: captured.elements,
      currentPageId: options.currentPageId,
    };
  }

  const issues: string[] = [];
  let currentPageId = options.currentPageId;
  for (const assertion of options.assertions) {
    switch (assertion.type) {
      case "ui_not_empty":
        if (captured.elements.length === 0) {
          issues.push("UI dump is empty.");
        }
        break;
      case "text_visible":
        if (
          !captured.elements.some((element) =>
            [element.text, element.label, element.value].some((value) =>
              value?.includes(assertion.text),
            ),
          )
        ) {
          issues.push(`Text is not visible: ${assertion.text}.`);
        }
        break;
      case "control_visible": {
        const control = options.controls.find(
          (candidate) =>
            candidate.controlId === assertion.controlId &&
            candidate.pageId === assertion.pageId,
        );
        if (!control || !matchUiElement(captured.elements, control.selector)) {
          issues.push(
            `Control ${assertion.controlId} is not visible on ${assertion.pageId}.`,
          );
        } else {
          currentPageId = assertion.pageId;
        }
        break;
      }
      case "page": {
        const page = await loadPage(
          options.layout.pagesDirectory,
          assertion.pageId,
        );
        if (!page) {
          issues.push(`Page asset is missing: ${assertion.pageId}.`);
          break;
        }
        const anchors = page.anchorControlIds
          .map((controlId) =>
            options.controls.find(
              (control) =>
                control.controlId === controlId &&
                control.pageId === assertion.pageId,
            ),
          )
          .filter((control): control is UiControl => control !== undefined);
        const anchorsMatch =
          anchors.length > 0 &&
          anchors.every((control) =>
            matchUiElement(captured.elements, control.selector),
          );
        const fingerprintMatches =
          fingerprintUi(captured.elements) === page.fingerprint;
        if (!anchorsMatch && !fingerprintMatches) {
          issues.push(`Current UI does not match page ${assertion.pageId}.`);
        } else {
          currentPageId = assertion.pageId;
        }
        break;
      }
      case "foreground_bundle": {
        const foreground = await runCommand(
          buildMobilecliForegroundCommand(options.udid),
        );
        const expectedBundle = assertion.bundleId ?? options.bundleId;
        if (
          foreground.exitCode !== 0 ||
          !`${foreground.stdout}\n${foreground.stderr}`.includes(expectedBundle)
        ) {
          issues.push(`Foreground app is not ${expectedBundle}.`);
        }
        await writeFile(
          join(options.caseDirectory, `${options.prefix}-foreground.txt`),
          `${foreground.stdout}\n${foreground.stderr}`,
          "utf8",
        );
        break;
      }
    }
  }
  return {
    success: issues.length === 0,
    issues,
    elements: captured.elements,
    currentPageId,
  };
}

async function captureState(options: {
  caseDirectory: string;
  prefix: string;
  udid: string;
}): Promise<{
  success: boolean;
  issue?: string;
  screenshotPath: string;
  uiDumpPath: string;
  elements: UiElement[];
}> {
  const screenshotPath = join(
    options.caseDirectory,
    `${safeSegment(options.prefix)}.png`,
  );
  const uiDumpPath = join(
    options.caseDirectory,
    `${safeSegment(options.prefix)}.ui.json`,
  );
  const screenshot = await runCommand(
    buildMobilecliScreenshotCommand(options.udid, screenshotPath),
  );
  const dump = await runCommand(buildMobilecliUiDumpCommand(options.udid));
  await writeFile(uiDumpPath, dump.stdout, "utf8");
  return {
    success: screenshot.exitCode === 0 && dump.exitCode === 0,
    issue:
      screenshot.exitCode === 0 && dump.exitCode === 0
        ? undefined
        : `Evidence capture failed: screenshot=${screenshot.exitCode}, uiDump=${dump.exitCode}.`,
    screenshotPath,
    uiDumpPath,
    elements: parseUiDump(dump.stdout),
  };
}

async function finishCase(options: {
  regressionCase: RegressionCase;
  startedAt: string;
  actions: readonly ActionExecution[];
  issues: readonly string[];
  verdict: CaseExecution["verdict"];
  evidenceVideoPath?: string;
  caseDirectory: string;
}): Promise<CaseExecution> {
  const result: CaseExecution = {
    caseId: options.regressionCase.caseId,
    title: options.regressionCase.title,
    verdict: options.verdict,
    startedAt: options.startedAt,
    finishedAt: new Date().toISOString(),
    actions: options.actions,
    issues: options.issues,
    evidenceVideoPath: options.evidenceVideoPath,
  };
  await writeJsonAtomic(join(options.caseDirectory, "result.json"), result);
  return result;
}

export function selectCases(
  cases: readonly RegressionCase[],
  filters: Pick<NormalizedInput, "priorities" | "tags" | "caseIds">,
): RegressionCase[] {
  return cases.filter((regressionCase) => {
    if (
      filters.caseIds.size > 0 &&
      !filters.caseIds.has(regressionCase.caseId)
    ) {
      return false;
    }
    if (
      filters.priorities.size > 0 &&
      !filters.priorities.has(regressionCase.priority)
    ) {
      return false;
    }
    if (
      filters.tags.size > 0 &&
      !regressionCase.tags.some((tag) => filters.tags.has(tag))
    ) {
      return false;
    }
    return true;
  });
}

export function expandNavigationActions(options: {
  regressionCase: RegressionCase;
  graph?: NavigationGraph;
  pageIndex?: PageIndex;
  bundleId: string;
}): RegressionCase {
  const actions: RegressionAction[] = [];
  for (const action of options.regressionCase.actions) {
    if (action.type !== "navigate") {
      actions.push(action);
      continue;
    }
    if (!options.graph || !options.pageIndex) {
      throw new Error(
        `Navigate action ${action.actionId} requires graph.json and page-index.json.`,
      );
    }
    const targetPageId = resolveNavigateTarget(action, options.pageIndex);
    const plan = planNavigation({
      graph: options.graph,
      sourcePageId: action.sourcePageId ?? options.graph.rootPageId,
      targetPageId,
      allowCategories: action.allowCategories,
    });
    const compiled = compileNavigationPlanActions({
      plan,
      bundleId: options.bundleId,
      actionIdPrefix: action.actionId,
    });
    const first = compiled[0];
    const last = compiled.at(-1);
    if (first && action.assertBefore?.length) {
      compiled[0] = {
        ...first,
        assertBefore: [...(first.assertBefore ?? []), ...action.assertBefore],
      };
    }
    if (last && action.assertAfter?.length) {
      compiled[compiled.length - 1] = {
        ...last,
        assertAfter: [...(last.assertAfter ?? []), ...action.assertAfter],
      };
    }
    actions.push(...compiled);
  }
  return { ...options.regressionCase, actions };
}

function resolveNavigateTarget(
  action: Extract<RegressionAction, { type: "navigate" }>,
  pageIndex: PageIndex,
): string {
  const reference = action.targetPageId?.trim() || action.targetPage?.trim();
  if (!reference) {
    throw new Error(
      `Navigate action ${action.actionId} requires targetPageId or targetPage.`,
    );
  }
  const resolution = resolvePageReference(reference, pageIndex);
  if (!resolution.pageId) {
    throw new Error(
      `Navigate action ${action.actionId} target is ${resolution.reason}: ${reference}. Candidates: ${resolution.candidates.join(", ") || "none"}.`,
    );
  }
  return resolution.pageId;
}

function chooseDeviceProfile(
  profiles: readonly DeviceProfile[],
  requestedId?: string,
): DeviceProfile {
  if (requestedId) {
    const requested = profiles.find(
      (profile) => profile.profileId === requestedId,
    );
    if (!requested) {
      throw new Error(`Device profile does not exist: ${requestedId}`);
    }
    return requested;
  }
  const profile = profiles[0];
  if (!profile) {
    throw new Error(
      "No device profile is available. Add one to the canonical App Graph or provide deviceProfileId.",
    );
  }
  return profile;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function requiredText(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new TypeError(`iOS Functional Regression requires ${name}.`);
  }
  return trimmed;
}

function safeSegment(value: string): string {
  return (
    value.replaceAll(/[^A-Za-z0-9_.-]+/g, "-").replaceAll(/^-+|-+$/g, "") ||
    "item"
  );
}

function timestampForPath(): string {
  return new Date()
    .toISOString()
    .replaceAll(/[^0-9]/g, "")
    .slice(0, 14);
}
