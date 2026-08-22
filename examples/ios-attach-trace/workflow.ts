import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import {
  parseTraceTimeline,
  renderLaunchTraceHtml,
} from "../ios-launch-trace/workflow";
import type { ParsedTraceTimeline } from "../ios-launch-trace/types";

import type {
  AttachTargetResolution,
  IosAttachTraceInput,
  IosAttachTraceResult,
  IosAttachTraceSummary,
} from "./types";

const DEFAULT_ARTIFACT_ROOT = "/Users/bytedance/.ios_pref_optimizer";
const DEFAULT_BUNDLE_ID = "com.bot.doubao";
const DEFAULT_TARGET_BINARY = "Grace";
const DEFAULT_TEMPLATE = "Time Profiler";
const DEFAULT_TIME_LIMIT = "30s";
const DEFAULT_MAX_SAMPLES = 12000;
const DEFAULT_MAX_DEPTH = 72;
const DEFAULT_EXPORT_ATTEMPTS = 3;
const DEFAULT_EXPORT_RETRY_DELAY_MS = 1000;
const DEFAULT_TRACE_SETTLE_ATTEMPTS = 10;
const DEFAULT_TRACE_SETTLE_DELAY_MS = 500;
const DEFAULT_BUILD_ARTIFACT_ROOT = "/tmp/ios_perf-opt/ios-build-install";
const OUTPUT_TAIL_LENGTH = 4000;
const TIME_PROFILE_XPATH =
  '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]';

/**
 * Declares the Workflow's identity and observable phase plan.
 */
export const meta = {
  name: "ios-attach-trace",
  description:
    "Attaches Time Profiler to a running iOS app and renders a local HTML timeline.",
  phases: [
    { title: "Prepare" },
    { title: "Attach" },
    { title: "Record" },
    { title: "Save Trace" },
    { title: "Symbolicate" },
    { title: "Export" },
    { title: "Parse" },
    { title: "Report" },
  ],
  exampleArgs: {
    projectRoot: "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
    udid: "00008030-001A286A2229802E",
    bundleId: "com.bot.doubao",
    attachTarget: "Grace",
    timeLimit: "30s",
  },
};

/**
 * Attaches Time Profiler to an already-running iOS process and writes an HTML report.
 *
 * @param args - Trace target, attach target, and output settings.
 * @returns Paths to the generated trace, XML, summary, and HTML artifacts.
 */
export default async function iosAttachTrace(
  args: IosAttachTraceInput,
): Promise<IosAttachTraceResult> {
  const input = normalizeInput(args);

  phase("Prepare");
  await mkdir(input.outputDir, { recursive: true });
  log(
    [
      "## Preparing iOS attach trace collection",
      `- **Project:** \`${input.projectRoot}\``,
      `- **Device:** \`${input.udid}\``,
      `- **Bundle:** \`${input.bundleId}\``,
      `- **Attach target:** \`${input.attachTarget}\``,
      `- **Duration:** \`${input.timeLimit}\``,
      `- **Output:** \`${input.outputDir}\``,
    ].join("\n"),
  );

  const summary = baseSummary(input);

  const resolvedAttachTarget = await resolveAttachTarget(input);
  summary.attach_target = resolvedAttachTarget.attachTarget;
  if (resolvedAttachTarget.resolution) {
    summary.attach_target_resolution = resolvedAttachTarget.resolution;
  }
  const recordCommand = buildAttachRecordCommand({
    ...input,
    attachTarget: resolvedAttachTarget.attachTarget,
  });

  phase("Attach");
  log(
    [
      "## Attaching Time Profiler to the running process",
      `- **Template:** \`${input.template}\``,
      `- **Target:** \`${resolvedAttachTarget.attachTarget}\``,
      resolvedAttachTarget.resolution
        ? `- **Resolved from:** \`${resolvedAttachTarget.resolution.requestedTarget}\``
        : "",
      "- Wait for the Record phase before operating the phone.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const record = await runAttachRecordCommand(recordCommand, input.projectRoot);
  summary.record = processSummary(record);
  summary.trace_path = input.tracePath;

  if (record.exitCode !== 0) {
    const diagnosis = diagnoseAttachRecordFailure(record, {
      attachTarget: input.attachTarget,
    });
    summary.error = diagnosis.error;
    summary.message = diagnosis.message;
    await writeSummary(input.summaryPath, summary);
    await writeFailureReport({
      input,
      summary,
      command: recordCommand,
      exitCode: record.exitCode,
      stdoutTail: tail(record.stdout),
      stderrTail: tail(record.stderr),
    });
    throw collectionError("iOS attach trace collection failed", summary, input);
  }

  phase("Symbolicate");
  summary.trace_settle = await waitForTraceTreeToSettle(input.tracePath);
  const symbolContext = await resolveAttachSymbolContext({
    projectRoot: input.projectRoot,
    targetBinary: input.targetBinary,
    businessBinary: input.businessBinary,
    explicitDsymPath: input.dsymPath,
    explicitSymbolSearchPath: input.symbolSearchPath,
    buildArtifactRoot: DEFAULT_BUILD_ARTIFACT_ROOT,
  });
  summary.dsym_path = symbolContext.dsymPath || input.dsymPath;
  summary.symbol_search_path = symbolContext.searchPath;
  summary.symbol_search_source = symbolContext.source;
  summary.build_summary_path = symbolContext.buildSummaryPath;

  let exportTracePath = input.tracePath;
  if (symbolContext.searchPath) {
    log(
      [
        "## Symbolicating attach trace",
        `- **Search path:** \`${symbolContext.searchPath}\``,
        `- **Source:** \`${symbolContext.source}\``,
        `- **Output:** \`${input.symbolicatedTracePath}\``,
      ].join("\n"),
    );
    const symbolicateCommand = buildXctraceSymbolicateCommand({
      tracePath: input.tracePath,
      outputPath: input.symbolicatedTracePath,
      symbolSearchPath: symbolContext.searchPath,
    });
    const symbolicate = await runCommand(symbolicateCommand, input.projectRoot);
    summary.symbolicate = processSummary(symbolicate);
    if (symbolicate.exitCode !== 0) {
      summary.error = "symbolication_failed";
      summary.message = `xctrace symbolicate failed with return code ${symbolicate.exitCode}.`;
      await writeSummary(input.summaryPath, summary);
      throw collectionError(
        "iOS attach trace symbolication failed",
        summary,
        input,
      );
    }
    exportTracePath = input.symbolicatedTracePath;
    summary.symbolicated_trace_path = input.symbolicatedTracePath;
  } else {
    summary.warning =
      "No dSYM symbol search path was found; exporting the unsymbolicated trace.";
    log(
      [
        "## Skipping attach trace symbolication",
        "- No explicit or recent build-install symbol search path was found.",
      ].join("\n"),
    );
  }

  phase("Export");
  log(
    [
      "## Exporting Time Profiler XML",
      `- **Trace:** \`${exportTracePath}\``,
      `- **Trace settled:** ${summary.trace_settle.settled === true ? "yes" : "no"}`,
      `- **TOC:** \`${input.tocPath}\``,
      `- **Time profile:** \`${input.timeProfilePath}\``,
    ].join("\n"),
  );
  const tocExport = await runXctraceExportWithRetry({
    label: "toc",
    command: buildTocExportCommand(exportTracePath, input.tocPath),
    cwd: input.projectRoot,
    outputDir: input.outputDir,
  });
  summary.export_attempts = {
    ...(summary.export_attempts ?? {}),
    toc: tocExport.attempts,
  };
  summary.export_toc = processSummary(tocExport.result);
  if (tocExport.result.exitCode !== 0) {
    summary.error = "toc_export_failed";
    summary.message = `xctrace export --toc failed after ${tocExport.attempts.length} attempt(s); last return code ${tocExport.result.exitCode}.`;
    await writeSummary(input.summaryPath, summary);
    await writeFailureReport({
      input,
      summary,
      command: recordCommand,
      exitCode: tocExport.result.exitCode,
      stdoutTail: tail(tocExport.result.stdout),
      stderrTail: tail(tocExport.result.stderr),
    });
    throw collectionError("iOS attach trace export failed", summary, input);
  }

  const profileExport = await runXctraceExportWithRetry({
    label: "time-profile",
    command: buildTimeProfileExportCommand(
      exportTracePath,
      input.timeProfilePath,
    ),
    cwd: input.projectRoot,
    outputDir: input.outputDir,
  });
  summary.export_attempts = {
    ...(summary.export_attempts ?? {}),
    time_profile: profileExport.attempts,
  };
  summary.export_time_profile = processSummary(profileExport.result);
  summary.toc_path = input.tocPath;
  summary.time_profile_path = input.timeProfilePath;
  if (profileExport.result.exitCode !== 0) {
    summary.error = "time_profile_export_failed";
    summary.message = `xctrace export time-profile failed after ${profileExport.attempts.length} attempt(s); last return code ${profileExport.result.exitCode}.`;
    await writeSummary(input.summaryPath, summary);
    await writeFailureReport({
      input,
      summary,
      command: recordCommand,
      exitCode: profileExport.result.exitCode,
      stdoutTail: tail(profileExport.result.stdout),
      stderrTail: tail(profileExport.result.stderr),
    });
    throw collectionError("iOS attach trace export failed", summary, input);
  }

  phase("Parse");
  const timeline = await parseTraceTimeline({
    timeProfilePath: input.timeProfilePath,
    targetBinary: input.targetBinary,
    maxSamples: input.maxSamples,
    maxDepth: input.maxDepth,
    python: input.python,
  });
  const symbolCoverage = summarizeTimelineSymbolication(
    timeline,
    input.targetBinary,
    input.businessBinary,
  );
  summary.main_thread_rows = timeline.totalMainThreadRows;
  summary.main_thread_grace_rows = symbolCoverage.appRows;
  summary.main_thread_grace_source_rows = symbolCoverage.businessSourceRows;
  summary.success = true;
  summary.symbolication_status = symbolCoverage.status;
  summary.summary_path = input.summaryPath;
  await writeSummary(input.summaryPath, summary);

  phase("Report");
  const html = renderLaunchTraceHtml({
    command: recordCommand,
    exitCode: 0,
    generatedAt: new Date().toISOString(),
    outputDir: input.outputDir,
    summary,
    summaryPath: input.summaryPath,
    timeProfilePath: input.timeProfilePath,
    stdoutTail: tail(record.stdout),
    stderrTail: tail(record.stderr),
    timeline,
  });
  await mkdir(dirname(input.htmlReportPath), { recursive: true });
  await writeFile(input.htmlReportPath, html, "utf8");
  log(
    [
      "## Attach trace report ready",
      `- **HTML:** \`${input.htmlReportPath}\``,
      `- **Rendered samples:** ${timeline.renderedSamples}/${timeline.totalMainThreadRows}`,
      `- **Top frame rows:** ${timeline.topFrames.length}`,
    ].join("\n"),
  );

  return {
    success: true,
    exitCode: 0,
    command: recordCommand,
    outputDir: input.outputDir,
    summaryPath: input.summaryPath,
    tracePath: input.tracePath,
    symbolicatedTracePath: summary.symbolicated_trace_path ?? "",
    tocPath: input.tocPath,
    timeProfilePath: input.timeProfilePath,
    htmlReportPath: input.htmlReportPath,
    symbolicationStatus: summary.symbolication_status ?? "unknown",
    mainThreadRows: summary.main_thread_rows ?? 0,
    mainThreadGraceRows: summary.main_thread_grace_rows ?? 0,
    mainThreadGraceSourceRows: summary.main_thread_grace_source_rows ?? 0,
    stdoutTail: tail(record.stdout),
    stderrTail: tail(record.stderr),
    summary,
  };
}

interface NormalizedInput {
  projectRoot: string;
  udid: string;
  bundleId: string;
  attachTarget: string;
  template: string;
  python: string;
  appPath: string;
  dsymPath: string;
  symbolSearchPath: string;
  symbolicatedTracePath: string;
  timeLimit: string;
  outputDir: string;
  tracePath: string;
  tocPath: string;
  timeProfilePath: string;
  summaryPath: string;
  targetBinary: string;
  businessBinary: string;
  htmlReportPath: string;
  maxSamples: number;
  maxDepth: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  observedRecordingStartedAt?: string;
  observedRecordingFinishedAt?: string;
  observedRecordingDurationMs?: number;
  observedAttachMessage?: string;
}

interface TraceTreeSnapshot {
  attempt: number;
  file_count: number;
  total_bytes: number;
  newest_mtime_ns: number;
}

interface ExportAttemptSummary {
  attempt: number;
  returncode: number;
  stdout_path: string;
  stderr_path: string;
  stdout_tail: string;
  stderr_tail: string;
}

interface XctraceExportRetryResult {
  result: CommandResult;
  attempts: ExportAttemptSummary[];
}

interface AttachSymbolContext {
  dsymPath: string;
  searchPath: string;
  source:
    | "explicit-symbol-search-path"
    | "recent-build-summary"
    | "explicit-dsym"
    | "none";
  buildSummaryPath?: string;
}

interface BuildSymbolSummary {
  success?: boolean;
  app_path?: string;
  dsym_path?: string;
  exported_dsym_path?: string;
  dsym_paths?: string[];
  dsym_metadata?: Array<{
    path?: string;
    binary_name?: string;
  }>;
}

export interface AttachRecordObservation {
  startedAt?: string;
  finishedAt?: string;
  attachMessage?: string;
  pendingLine?: string;
  onRecordingStarted?: () => void;
  onRecordingLimitReached?: () => void;
}

interface DeviceProcessInfo {
  pid: number;
  executable: string;
}

type CommandRunner = (
  command: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

function normalizeInput(args: IosAttachTraceInput): NormalizedInput {
  if (!args) {
    throw new TypeError("iOS Attach Trace requires input arguments.");
  }

  const projectRoot = resolve(requiredText(args.projectRoot, "projectRoot"));
  const udid = requiredText(args.udid, "udid");
  const runId = safeSegment(args.runId?.trim() || timestampForPath());
  const outputDir = resolve(
    args.outputDir?.trim() ||
      join(DEFAULT_ARTIFACT_ROOT, "ios-attach-trace", runId),
  );
  const targetBinary = args.targetBinary?.trim() || DEFAULT_TARGET_BINARY;
  const htmlReportPath = resolve(
    args.htmlReportPath?.trim() || join(outputDir, "attach-trace-report.html"),
  );

  return {
    projectRoot,
    udid,
    bundleId: args.bundleId?.trim() || DEFAULT_BUNDLE_ID,
    attachTarget: args.attachTarget?.trim() || targetBinary,
    template: args.template?.trim() || DEFAULT_TEMPLATE,
    python: args.python?.trim() || "python3",
    appPath: args.appPath?.trim() || "",
    dsymPath: args.dsymPath?.trim() || "",
    symbolSearchPath: args.symbolSearchPath?.trim() || "",
    symbolicatedTracePath: join(outputDir, "symbolicated.trace"),
    timeLimit: args.timeLimit?.trim() || DEFAULT_TIME_LIMIT,
    outputDir,
    tracePath: join(outputDir, "attach_target.trace"),
    tocPath: join(outputDir, "toc.xml"),
    timeProfilePath: join(outputDir, "time_profile.xml"),
    summaryPath: join(outputDir, "summary.json"),
    targetBinary,
    businessBinary: args.businessBinary?.trim() || `${targetBinary}Core`,
    htmlReportPath,
    maxSamples: boundedInteger(args.maxSamples, 40, 50000, DEFAULT_MAX_SAMPLES),
    maxDepth: boundedInteger(args.maxDepth, 4, 120, DEFAULT_MAX_DEPTH),
  };
}

export function buildAttachRecordCommand(input: {
  template: string;
  udid: string;
  timeLimit: string;
  tracePath: string;
  attachTarget: string;
}): string[] {
  return [
    "xcrun",
    "xctrace",
    "record",
    "--template",
    input.template,
    "--device",
    input.udid,
    "--time-limit",
    input.timeLimit,
    "--output",
    input.tracePath,
    "--attach",
    input.attachTarget,
    "--no-prompt",
  ];
}

export function buildTocExportCommand(
  tracePath: string,
  tocPath: string,
): string[] {
  return [
    "xcrun",
    "xctrace",
    "export",
    "--input",
    tracePath,
    "--toc",
    "--output",
    tocPath,
  ];
}

export function buildTimeProfileExportCommand(
  tracePath: string,
  timeProfilePath: string,
): string[] {
  return [
    "xcrun",
    "xctrace",
    "export",
    "--input",
    tracePath,
    "--xpath",
    TIME_PROFILE_XPATH,
    "--output",
    timeProfilePath,
  ];
}

/** Builds the command that applies matching dSYMs before XML export. */
export function buildXctraceSymbolicateCommand(input: {
  tracePath: string;
  outputPath: string;
  symbolSearchPath: string;
}): string[] {
  return [
    "xcrun",
    "xctrace",
    "symbolicate",
    "--input",
    input.tracePath,
    "--output",
    input.outputPath,
    "--dsym",
    input.symbolSearchPath,
  ];
}

/** Resolves a recursive dSYM search root for an attach trace. */
export async function resolveAttachSymbolContext(input: {
  projectRoot: string;
  targetBinary: string;
  businessBinary: string;
  explicitDsymPath?: string;
  explicitSymbolSearchPath?: string;
  buildArtifactRoot?: string;
}): Promise<AttachSymbolContext> {
  const explicitSearchPath = input.explicitSymbolSearchPath?.trim();
  if (explicitSearchPath && (await pathExists(explicitSearchPath))) {
    return {
      dsymPath: input.explicitDsymPath?.trim() ?? "",
      searchPath: resolve(explicitSearchPath),
      source: "explicit-symbol-search-path",
    };
  }

  const buildSummary = await findLatestBuildSymbolSummary({
    projectRoot: input.projectRoot,
    targetBinary: input.targetBinary,
    businessBinary: input.businessBinary,
    buildArtifactRoot: input.buildArtifactRoot ?? DEFAULT_BUILD_ARTIFACT_ROOT,
  });
  if (buildSummary) {
    return {
      dsymPath:
        input.explicitDsymPath?.trim() ||
        buildSummary.payload.exported_dsym_path ||
        buildSummary.payload.dsym_path ||
        "",
      searchPath: dirname(buildSummary.businessDsymPath),
      source: "recent-build-summary",
      buildSummaryPath: buildSummary.path,
    };
  }

  const explicitDsymPath = input.explicitDsymPath?.trim();
  if (explicitDsymPath && (await pathExists(explicitDsymPath))) {
    return {
      dsymPath: resolve(explicitDsymPath),
      searchPath: resolve(explicitDsymPath),
      source: "explicit-dsym",
    };
  }

  return { dsymPath: "", searchPath: "", source: "none" };
}

async function findLatestBuildSymbolSummary(input: {
  projectRoot: string;
  targetBinary: string;
  businessBinary: string;
  buildArtifactRoot: string;
}): Promise<{
  path: string;
  payload: BuildSymbolSummary;
  businessDsymPath: string;
} | null> {
  let entries: string[];
  try {
    entries = await readdir(input.buildArtifactRoot);
  } catch {
    return null;
  }

  const summaries: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const path = join(input.buildArtifactRoot, entry, "build-summary.json");
    try {
      const stats = await stat(path);
      summaries.push({ path, mtimeMs: stats.mtimeMs });
    } catch {
      continue;
    }
  }

  summaries.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const projectRoot = resolve(input.projectRoot);
  const workspaceRoot = dirname(projectRoot);
  for (const summary of summaries) {
    let payload: BuildSymbolSummary;
    try {
      payload = JSON.parse(
        await readFile(summary.path, "utf8"),
      ) as BuildSymbolSummary;
    } catch {
      continue;
    }
    if (
      payload.success !== true ||
      !payload.app_path ||
      basename(payload.app_path) !== `${input.targetBinary}.app` ||
      !isPathWithin(resolve(payload.app_path), workspaceRoot)
    ) {
      continue;
    }
    const businessDsymPath =
      payload.dsym_metadata?.find(
        (metadata) => metadata.binary_name === input.businessBinary,
      )?.path ??
      payload.dsym_paths?.find(
        (path) => basename(path) === `${input.businessBinary}.framework.dSYM`,
      );
    if (
      businessDsymPath &&
      isPathWithin(resolve(businessDsymPath), projectRoot) &&
      (await pathExists(businessDsymPath))
    ) {
      return { path: summary.path, payload, businessDsymPath };
    }
  }
  return null;
}

/** Summarizes whether main-thread app frames have business source symbols. */
export function summarizeTimelineSymbolication(
  timeline: ParsedTraceTimeline,
  targetBinary: string,
  businessBinary: string,
): {
  status: "ready" | "partial" | "missing";
  appRows: number;
  businessSourceRows: number;
} {
  const mainThread = timeline.threads.find((thread) => thread.isMain);
  const appRows = new Set<number>();
  const businessSourceRows = new Set<number>();
  for (const span of mainThread?.spans ?? timeline.spans) {
    const isTargetBinary =
      span.binary === targetBinary || span.binary === businessBinary;
    const hasBusinessSource =
      span.binary === businessBinary &&
      span.sourcePath.length > 0 &&
      span.line.length > 0 &&
      span.line !== "0" &&
      !isBootstrapFrame(span.name);
    for (let index = span.startSample; index < span.endSample; index += 1) {
      if (span.appFrame || isTargetBinary) {
        appRows.add(index);
      }
      if (hasBusinessSource) {
        businessSourceRows.add(index);
      }
    }
  }
  return {
    status:
      businessSourceRows.size > 0
        ? "ready"
        : appRows.size > 0
          ? "partial"
          : "missing",
    appRows: appRows.size,
    businessSourceRows: businessSourceRows.size,
  };
}

function isBootstrapFrame(name: string): boolean {
  return (
    name === "main" ||
    name === "start" ||
    name === "flow_main" ||
    name === "flow_main()"
  );
}

function isPathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

async function runCommand(
  command: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  const subprocess = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { stdout, stderr, exitCode };
}

export async function runAttachRecordCommand(
  command: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  const startedAt = new Date();
  const observation: AttachRecordObservation = {
    onRecordingStarted: () => phase("Record"),
    onRecordingLimitReached: () => phase("Save Trace"),
  };
  let stdout = "";
  let stderr = "";

  const subprocess = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  await Promise.all([
    readProcessStream(subprocess.stdout, (chunk) => {
      stdout += chunk;
      observeAttachRecordOutput(chunk, observation);
    }),
    readProcessStream(subprocess.stderr, (chunk) => {
      stderr += chunk;
    }),
  ]);
  observeAttachRecordOutput("\n", observation);
  const exitCode = await subprocess.exited;
  const finishedAt = new Date();

  return {
    stdout,
    stderr,
    exitCode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    observedRecordingStartedAt: observation.startedAt,
    observedRecordingFinishedAt: observation.finishedAt,
    observedRecordingDurationMs:
      observation.startedAt && observation.finishedAt
        ? new Date(observation.finishedAt).getTime() -
          new Date(observation.startedAt).getTime()
        : undefined,
    observedAttachMessage: observation.attachMessage,
  };
}

async function readProcessStream(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new StringDecoder("utf8");
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      onChunk(decoder.write(Buffer.from(value)));
    }
  }
  const rest = decoder.end();
  if (rest) {
    onChunk(rest);
  }
}

export function observeAttachRecordOutput(
  chunk: string,
  observation: AttachRecordObservation,
): AttachRecordObservation {
  const combined = `${observation.pendingLine ?? ""}${chunk}`;
  const lines = combined.split(/\r?\n/u);
  observation.pendingLine = lines.pop() ?? "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (
      !observation.startedAt &&
      /^Starting recording with .+ Attaching to:/u.test(line)
    ) {
      observation.startedAt = new Date().toISOString();
      observation.attachMessage = line;
      observation.onRecordingStarted?.();
      log(
        [
          "## Time Profiler has attached and is recording",
          `- **xctrace:** ${line}`,
          "- Operate the phone now; recording stops when the configured limit is reached.",
        ].join("\n"),
      );
    } else if (
      observation.startedAt &&
      !observation.finishedAt &&
      line === "Reached specified time limit, ending recording..."
    ) {
      observation.finishedAt = new Date().toISOString();
      observation.onRecordingLimitReached?.();
      log(
        [
          "## Time Profiler reached the configured recording limit",
          "- Waiting for xctrace to save the trace bundle before export.",
        ].join("\n"),
      );
    }
  }
  return observation;
}

async function resolveAttachTarget(input: NormalizedInput): Promise<{
  attachTarget: string;
  resolution?: AttachTargetResolution;
}> {
  if (/^\d+$/u.test(input.attachTarget)) {
    return {
      attachTarget: input.attachTarget,
      resolution: {
        requestedTarget: input.attachTarget,
        resolvedTarget: input.attachTarget,
        strategy: "explicit_pid",
      },
    };
  }

  const processes = await listDeviceProcesses(input);
  const resolution = resolveMainExecutableProcess({
    requestedTarget: input.attachTarget,
    targetBinary: input.targetBinary,
    processes,
  });
  if (!resolution) {
    return { attachTarget: input.attachTarget };
  }

  return {
    attachTarget: resolution.resolvedTarget,
    resolution,
  };
}

export function resolveMainExecutableProcess(input: {
  requestedTarget: string;
  targetBinary: string;
  processes: readonly DeviceProcessInfo[];
}): AttachTargetResolution | null {
  const mainExecutableSuffix = `/${input.targetBinary}.app/${input.targetBinary}`;
  const candidates = input.processes.filter((process) =>
    process.executable.endsWith(mainExecutableSuffix),
  );
  if (candidates.length === 0) {
    return null;
  }

  const selected = [...candidates].sort(
    (left, right) => right.pid - left.pid,
  )[0]!;
  return {
    requestedTarget: input.requestedTarget,
    resolvedTarget: String(selected.pid),
    strategy: "devicectl_main_executable_latest_pid",
    candidates,
  };
}

async function listDeviceProcesses(
  input: NormalizedInput,
): Promise<DeviceProcessInfo[]> {
  const directory = await mkdtemp(join(tmpdir(), "ios-attach-processes-"));
  const jsonPath = join(directory, "processes.json");
  const logPath = join(directory, "processes.log");
  const result = await runCommand(
    [
      "xcrun",
      "devicectl",
      "device",
      "info",
      "processes",
      "--device",
      input.udid,
      "--columns",
      "*",
      "--json-output",
      jsonPath,
      "--log-output",
      logPath,
      "--timeout",
      "10",
      "--quiet",
    ],
    input.projectRoot,
  );
  if (result.exitCode !== 0) {
    return [];
  }

  try {
    const payload = JSON.parse(await readFile(jsonPath, "utf8")) as {
      result?: {
        runningProcesses?: Array<{
          executable?: string;
          processIdentifier?: number;
        }>;
      };
    };
    return (payload.result?.runningProcesses ?? [])
      .map((process) => ({
        pid: Number(process.processIdentifier),
        executable: normalizeExecutableUrl(process.executable ?? ""),
      }))
      .filter(
        (process) =>
          Number.isFinite(process.pid) && process.executable.length > 0,
      );
  } catch {
    return [];
  }
}

function normalizeExecutableUrl(value: string): string {
  if (value.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch {
      return value.replace(/^file:\/\//u, "");
    }
  }
  return value;
}

export async function waitForTraceTreeToSettle(
  tracePath: string,
  options: {
    attempts?: number;
    delayMs?: number;
  } = {},
): Promise<{
  settled: boolean;
  snapshots: TraceTreeSnapshot[];
}> {
  const attempts = boundedInteger(
    options.attempts,
    1,
    100,
    DEFAULT_TRACE_SETTLE_ATTEMPTS,
  );
  const delayMs = boundedInteger(
    options.delayMs,
    0,
    60_000,
    DEFAULT_TRACE_SETTLE_DELAY_MS,
  );
  const snapshots: TraceTreeSnapshot[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const snapshot = await snapshotTraceTree(tracePath, attempt);
    snapshots.push(snapshot);

    const previous = snapshots.at(-2);
    if (
      previous &&
      snapshot.file_count > 0 &&
      previous.file_count === snapshot.file_count &&
      previous.total_bytes === snapshot.total_bytes &&
      previous.newest_mtime_ns === snapshot.newest_mtime_ns
    ) {
      return { settled: true, snapshots };
    }

    if (attempt < attempts) {
      await delay(delayMs);
    }
  }

  return { settled: false, snapshots };
}

async function snapshotTraceTree(
  tracePath: string,
  attempt: number,
): Promise<TraceTreeSnapshot> {
  let fileCount = 0;
  let totalBytes = 0;
  let newestMtimeNs = 0;

  async function visit(path: string): Promise<void> {
    let stats;
    try {
      stats = await stat(path, { bigint: true });
    } catch {
      return;
    }

    if (stats.isDirectory()) {
      let entries: string[];
      try {
        entries = await readdir(path);
      } catch {
        return;
      }
      for (const entry of entries) {
        await visit(join(path, entry));
      }
      return;
    }

    fileCount += 1;
    totalBytes += Number(stats.size);
    newestMtimeNs = Math.max(newestMtimeNs, Number(stats.mtimeNs));
  }

  await visit(tracePath);
  return {
    attempt,
    file_count: fileCount,
    total_bytes: totalBytes,
    newest_mtime_ns: newestMtimeNs,
  };
}

export async function runXctraceExportWithRetry(options: {
  label: string;
  command: readonly string[];
  cwd: string;
  outputDir: string;
  attempts?: number;
  retryDelayMs?: number;
  runner?: CommandRunner;
}): Promise<XctraceExportRetryResult> {
  const attempts = boundedInteger(
    options.attempts,
    1,
    20,
    DEFAULT_EXPORT_ATTEMPTS,
  );
  const retryDelayMs = boundedInteger(
    options.retryDelayMs,
    0,
    60_000,
    DEFAULT_EXPORT_RETRY_DELAY_MS,
  );
  const runner = options.runner ?? runCommand;
  const attemptSummaries: ExportAttemptSummary[] = [];
  let lastResult: CommandResult | undefined;

  await mkdir(options.outputDir, { recursive: true });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runner(options.command, options.cwd);
    lastResult = result;

    const logPrefix = join(
      options.outputDir,
      `xctrace-export-${safeSegment(options.label)}-attempt-${attempt}`,
    );
    const stdoutPath = `${logPrefix}.stdout.txt`;
    const stderrPath = `${logPrefix}.stderr.txt`;
    await Promise.all([
      writeFile(stdoutPath, result.stdout, "utf8"),
      writeFile(stderrPath, result.stderr, "utf8"),
    ]);

    attemptSummaries.push({
      attempt,
      returncode: result.exitCode,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
    });

    if (result.exitCode === 0) {
      return { result, attempts: attemptSummaries };
    }

    if (attempt < attempts) {
      await delay(retryDelayMs);
    }
  }

  return {
    result: lastResult ?? { stdout: "", stderr: "", exitCode: 1 },
    attempts: attemptSummaries,
  };
}

export function diagnoseAttachRecordFailure(
  result: CommandResult,
  input: {
    attachTarget: string;
  },
): {
  error: string;
  message: string;
} {
  const candidates = parseAmbiguousAttachCandidates(result.stderr);
  if (candidates.length > 0) {
    const pidList = candidates.map((candidate) => candidate.pid).join(", ");
    return {
      error: "ambiguous_attach_target",
      message: `xctrace attach target "${input.attachTarget}" matched ${candidates.length} processes. Re-run with attachTarget set to one PID: ${pidList}.`,
    };
  }

  return {
    error: "record_failed",
    message: "xctrace record --attach failed.",
  };
}

function parseAmbiguousAttachCandidates(
  stderr: string,
): Array<{ pid: string; executablePath: string }> {
  if (!/Provided process .+ is ambiguous/u.test(stderr)) {
    return [];
  }

  const candidates: Array<{ pid: string; executablePath: string }> = [];
  for (const line of stderr.split(/\r?\n/u)) {
    const match = /^(\d+)\s+(.+Grace\.app\/Grace.*)$/u.exec(line.trim());
    if (match) {
      candidates.push({
        pid: match[1]!,
        executablePath: match[2]!,
      });
    }
  }
  return candidates;
}

function baseSummary(input: NormalizedInput): IosAttachTraceSummary {
  return {
    success: false,
    mode: "attach",
    project_root: input.projectRoot,
    udid: input.udid,
    bundle_id: input.bundleId,
    attach_target: input.attachTarget,
    template: input.template,
    app_path: input.appPath,
    dsym_path: input.dsymPath,
    output_dir: input.outputDir,
    trace_path: input.tracePath,
    toc_path: input.tocPath,
    time_profile_path: input.timeProfilePath,
    summary_path: input.summaryPath,
  };
}

function processSummary(result: CommandResult) {
  return {
    returncode: result.exitCode,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
    started_at: result.startedAt,
    finished_at: result.finishedAt,
    duration_ms: result.durationMs,
    observed_recording_started_at: result.observedRecordingStartedAt,
    observed_recording_finished_at: result.observedRecordingFinishedAt,
    observed_recording_duration_ms: result.observedRecordingDurationMs,
    observed_attach_message: result.observedAttachMessage,
  };
}

async function writeSummary(
  summaryPath: string,
  summary: IosAttachTraceSummary,
): Promise<void> {
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(
    summaryPath,
    JSON.stringify(summary, null, 2).concat("\n"),
    "utf8",
  );
}

async function writeFailureReport(options: {
  input: NormalizedInput;
  summary: IosAttachTraceSummary;
  command: string[];
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}): Promise<void> {
  const html = renderLaunchTraceHtml({
    command: options.command,
    exitCode: options.exitCode,
    generatedAt: new Date().toISOString(),
    outputDir: options.input.outputDir,
    summary: options.summary,
    summaryPath: options.input.summaryPath,
    timeProfilePath: options.input.timeProfilePath,
    stdoutTail: options.stdoutTail,
    stderrTail: options.stderrTail,
    timeline: {
      totalMainThreadRows: 0,
      renderedSamples: 0,
      sampleStride: 1,
      sampleTimesSeconds: [],
      sampleWeightsMs: [],
      maxDepth: 0,
      sampleDepths: [],
      spans: [],
      topFrames: [],
      threads: [],
      traceStartSeconds: 0,
      traceEndSeconds: 0,
      warnings: [collectionFailureReason(options.summary)],
    },
  });
  await mkdir(dirname(options.input.htmlReportPath), { recursive: true });
  await writeFile(options.input.htmlReportPath, html, "utf8");
}

function collectionError(
  prefix: string,
  summary: IosAttachTraceSummary,
  input: NormalizedInput,
): Error {
  return new Error(
    [
      `${prefix}.`,
      `Reason: ${collectionFailureReason(summary)}`,
      `HTML report: ${input.htmlReportPath}`,
      `Summary: ${input.summaryPath}`,
    ].join("\n"),
  );
}

function collectionFailureReason(summary: IosAttachTraceSummary): string {
  const code = summary.error?.trim();
  const message = summary.message?.trim();
  if (code && message) {
    return `${code}: ${message}`;
  }
  return message || code || "unknown attach trace failure";
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
  const integer = Math.trunc(value);
  return Math.min(maximum, Math.max(minimum, integer));
}

function requiredText(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new TypeError(`iOS Attach Trace requires ${name}.`);
  }
  return trimmed;
}

function timestampForPath(): string {
  return new Date()
    .toISOString()
    .replaceAll(/[^0-9]/g, "")
    .slice(0, 14);
}

function safeSegment(value: string): string {
  return (
    value.replaceAll(/[^A-Za-z0-9_.-]+/g, "-").replaceAll(/^-+|-+$/g, "") ||
    "run"
  );
}

async function pathExists(path: string): Promise<boolean> {
  if (!path) {
    return false;
  }
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function tail(value: string): string {
  return value.slice(-OUTPUT_TAIL_LENGTH);
}
