import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";
import { resolveDeveloperDirectory } from "../ios-xcode";

import type {
  IosLaunchTraceInput,
  IosLaunchTraceResult,
  LaunchTraceSummary,
  ParsedTraceTimeline,
  ThreadTimeline,
  TraceFrame,
  TraceFrameSpan,
} from "./types";

const DEFAULT_ARTIFACT_ROOT = join(homedir(), ".ios_pref_optimizer");
const DEFAULT_BUNDLE_ID = "com.bot.doubao";
const DEFAULT_TARGET_BINARY = "Grace";
const DEFAULT_BUSINESS_BINARY = "FlowDebugBasicDynamic";
const DEFAULT_TIME_LIMIT = "20s";
const DEFAULT_MAX_SAMPLES = 12000;
const DEFAULT_MAX_DEPTH = 72;
const DEFAULT_EXPORT_ATTEMPTS = 3;
const DEFAULT_EXPORT_RETRY_DELAY_MS = 1000;
const DEFAULT_TRACE_SETTLE_ATTEMPTS = 10;
const DEFAULT_TRACE_SETTLE_DELAY_MS = 500;
const OUTPUT_TAIL_LENGTH = 4000;
const TIMELINE_PIXELS_PER_SAMPLE = 2;
const TIME_PROFILE_XPATH =
  '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]';

/**
 * Declares the Workflow's identity and observable phase plan.
 */
export const meta = {
  name: "ios-launch-trace",
  description:
    "Collects an iOS launch Time Profiler trace and renders a local HTML timeline.",
  phases: [
    { title: "Prepare" },
    { title: "Install" },
    { title: "Launch & Record" },
    { title: "Symbolicate" },
    { title: "Export" },
    { title: "Backfill Symbols" },
    { title: "Parse" },
    { title: "Report" },
  ],
  exampleArgs: {
    repositoryRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak",
    projectRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    buildRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    udid: "00008030-001A286A2229802E",
    bundleId: "com.bot.doubao",
    timeLimit: "20s",
  },
};

/**
 * Records a launch Time Profiler trace and writes an HTML report.
 *
 * @param args - Trace target, symbol, and output settings.
 * @returns Paths to the generated trace, XML, summary, and HTML artifacts.
 */
export default async function iosLaunchTrace(
  args: IosLaunchTraceInput,
): Promise<IosLaunchTraceResult> {
  const input = normalizeInput(args);
  await mkdir(input.outputDir, { recursive: true });
  const summary = baseLaunchSummary(input);
  const command = buildLaunchRecordCommand(input);
  let lastResult: CommandResult = { stdout: "", stderr: "", exitCode: 0 };
  let recordResult: CommandResult | undefined;

  phase("Prepare");
  log(
    [
      "## Preparing iOS launch trace collection",
      `- **Repository:** \`${input.repositoryRoot}\``,
      `- **iOS source:** \`${input.projectRoot}\``,
      `- **Build root:** \`${input.buildRoot}\``,
      `- **Device:** \`${input.udid}\``,
      `- **Bundle:** \`${input.bundleId}\``,
      `- **Output:** \`${input.outputDir}\``,
    ].join("\n"),
  );

  try {
    await validateLaunchInputs(input, summary);

    if (!input.skipInstall) {
      phase("Install");
      log(
        [
          "## Installing the trace-ready App without launching it",
          `- **App:** \`${input.appPath}\``,
          `- **Device:** \`${input.udid}\``,
        ].join("\n"),
      );
      lastResult = await runCommand(
        buildInstallCommand(input),
        input.projectRoot,
        input.developerDir,
      );
      summary.install = processSummary(lastResult);
      if (lastResult.exitCode !== 0) {
        failCollection(summary, "install_failed", "App installation failed.");
      }
    } else {
      log(
        "## Reusing the installed App\n- Installation was skipped; the installed App must match the supplied dSYMs.",
      );
    }

    summary.terminate = await terminateRunningAppProcesses(input);

    phase("Launch & Record");
    await rm(input.tracePath, { recursive: true, force: true });
    log(
      [
        "## Launching under Time Profiler",
        `- **Bundle:** \`${input.bundleId}\``,
        `- **Limit:** \`${input.timeLimit}\``,
        `- **Trace:** \`${input.tracePath}\``,
      ].join("\n"),
    );
    recordResult = await runLaunchRecordCommand(
      command,
      input.projectRoot,
      input.developerDir,
    );
    lastResult = recordResult;
    summary.record = processSummary(lastResult);
    summary.trace_path = input.tracePath;
    if (lastResult.exitCode !== 0) {
      failCollection(
        summary,
        "record_failed",
        `xctrace launch recording failed with return code ${lastResult.exitCode}.`,
      );
    }
    summary.trace_settle = await waitForTraceTreeToSettle(input.tracePath);

    phase("Symbolicate");
    await rm(input.symbolicatedTracePath, { recursive: true, force: true });
    lastResult = await runCommand(
      buildXctraceSymbolicateCommand(input),
      input.projectRoot,
      input.developerDir,
    );
    summary.symbolicate = processSummary(lastResult);
    let exportTracePath = input.symbolicatedTracePath;
    if (lastResult.exitCode === 0) {
      summary.symbolicated_trace_path = input.symbolicatedTracePath;
    } else if (isRecoverableMissingImageSymbolication(lastResult)) {
      exportTracePath = input.tracePath;
      summary.symbolicate.fallback = "raw_trace_atos_backfill";
      summary.symbolicate.recoverable = true;
      log(
        "## Symbolication fallback\n- xctrace found no registered image matching the dSYMs. Exporting the raw trace for fail-closed atos recovery.",
      );
    } else {
      failCollection(
        summary,
        "symbolication_failed",
        `xctrace symbolicate failed with return code ${lastResult.exitCode}.`,
      );
    }

    phase("Export");
    const tocExport = await runXctraceExportWithRetry({
      label: "toc",
      command: buildTocExportCommand(exportTracePath, input.tocPath),
      outputPath: input.tocPath,
      cwd: input.projectRoot,
      outputDir: input.outputDir,
      developerDir: input.developerDir,
    });
    const profileExport = await runXctraceExportWithRetry({
      label: "time-profile",
      command: buildTimeProfileExportCommand(
        exportTracePath,
        input.timeProfilePath,
      ),
      outputPath: input.timeProfilePath,
      cwd: input.projectRoot,
      outputDir: input.outputDir,
      developerDir: input.developerDir,
    });
    summary.export_attempts = {
      toc: tocExport.attempts,
      time_profile: profileExport.attempts,
    };
    summary.toc_path = input.tocPath;
    summary.time_profile_path = input.timeProfilePath;
    if (tocExport.result.exitCode !== 0) {
      lastResult = tocExport.result;
      failCollection(summary, "toc_export_failed", "TOC export failed.");
    }
    if (profileExport.result.exitCode !== 0) {
      lastResult = profileExport.result;
      failCollection(
        summary,
        "time_profile_export_failed",
        "Time Profiler XML export failed.",
      );
    }

    phase("Backfill Symbols");
    const recovery = await recoverLaunchSymbols(input);
    Object.assign(summary, recovery.coverage);
    summary.symbol_uuids = recovery.symbolUuids;
    summary.dsym_uuid =
      recovery.symbolUuids[`${input.targetBinary}.debug.dylib`]?.[0] ??
      recovery.symbolUuids[input.targetBinary]?.[0] ??
      null;
    summary.atos_backfill = recovery.backfill;
    validateLaunchSymbolication(summary);
    if (summary.success !== true) {
      throw new LaunchCollectionError();
    }
    await writeLaunchSummary(input.summaryPath, summary);
  } catch (cause) {
    if (!(cause instanceof LaunchCollectionError)) {
      summary.error = summary.error ?? "exception";
      summary.message = summary.message ?? formatError(cause);
    }
    summary.success = false;
    await writeLaunchSummary(input.summaryPath, summary);
    const timeline = skippedTimelineForCollectionFailure(
      summary,
      lastResult.exitCode,
    );
    await writeLaunchReport({
      input,
      summary,
      command,
      result: lastResult,
      timeline,
    });
    throw new Error(
      [
        "iOS launch trace collection failed.",
        `Reason: ${collectionFailureReason(summary, lastResult.exitCode)}`,
        `HTML report: ${input.htmlReportPath}`,
        `Summary: ${input.summaryPath}`,
      ].join("\n"),
      { cause },
    );
  }

  phase("Parse");
  const timeline = await parseSuccessfulTrace({
    timeProfilePath: input.timeProfilePath,
    summary,
    python: input.python,
    targetBinary: input.targetBinary,
    maxSamples: input.maxSamples,
    maxDepth: input.maxDepth,
  });

  phase("Report");
  await writeLaunchReport({
    input,
    summary,
    command,
    result: recordResult ?? lastResult,
    timeline,
  });
  log(
    [
      "## Launch trace report ready",
      `- **HTML:** \`${input.htmlReportPath}\``,
      `- **Rendered samples:** ${timeline.renderedSamples}/${timeline.totalMainThreadRows}`,
      `- **Top frame rows:** ${timeline.topFrames.length}`,
      "- **Collection:** self-contained TypeScript workflow",
    ].join("\n"),
  );

  return {
    success: true,
    repositoryRoot: input.repositoryRoot,
    projectRoot: input.projectRoot,
    buildRoot: input.buildRoot,
    exitCode: 0,
    command,
    outputDir: input.outputDir,
    summaryPath: input.summaryPath,
    tracePath: input.tracePath,
    tocPath: input.tocPath,
    timeProfilePath: input.timeProfilePath,
    htmlReportPath: input.htmlReportPath,
    symbolicationStatus: summary.symbolication_status ?? "unknown",
    mainThreadRows: summary.main_thread_rows ?? 0,
    mainThreadGraceRows: summary.main_thread_grace_rows ?? 0,
    mainThreadGraceSourceRows: summary.main_thread_grace_source_rows ?? 0,
    stdoutTail: tail((recordResult ?? lastResult).stdout),
    stderrTail: tail((recordResult ?? lastResult).stderr),
    summary,
  };
}

interface NormalizedInput {
  repositoryRoot: string;
  projectRoot: string;
  buildRoot: string;
  developerDir: string;
  udid: string;
  bundleId: string;
  python: string;
  appPath: string;
  dsymPath: string;
  symbolSearchPath: string;
  symbolicatedTracePath: string;
  timeLimit: string;
  skipInstall: boolean;
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

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  observedRecordingStartedAt?: string;
  observedRecordingFinishedAt?: string;
  observedRecordingDurationMs?: number;
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

interface LaunchCoverage {
  trace_grace_uuid?: string;
  trace_target_uuids: Record<string, string>;
  main_thread_rows: number;
  main_thread_grace_rows: number;
  main_thread_grace_source_rows: number;
  main_thread_source_rows_by_binary: Record<string, number>;
  main_thread_unresolved_rows: number;
  main_thread_unmapped_rows: number;
  samples: NonNullable<LaunchTraceSummary["samples"]>;
}

class LaunchCollectionError extends Error {}

interface PythonThreadPayload {
  threadId?: string;
  label?: string;
  isMain?: boolean;
  totalRows?: number;
  stride?: number;
  sampleTimesSeconds?: number[];
  sampleWeightsMs?: number[];
  samples?: TraceFrame[][];
}

interface PythonTimelinePayload {
  totalMainThreadRows?: number;
  sampleStride?: number;
  sampleTimesSeconds?: number[];
  sampleWeightsMs?: number[];
  samples?: TraceFrame[][];
  threads?: PythonThreadPayload[];
  traceStartSeconds?: number;
  traceEndSeconds?: number;
  warnings?: string[];
}

interface RenderLaunchTraceHtmlInput {
  command: string[];
  exitCode: number;
  generatedAt: string;
  outputDir: string;
  summary: LaunchTraceSummary;
  summaryPath: string;
  timeProfilePath: string;
  stdoutTail?: string;
  stderrTail?: string;
  timeline: ParsedTraceTimeline;
}

function normalizeInput(args: IosLaunchTraceInput): NormalizedInput {
  if (!args) {
    throw new TypeError("iOS Launch Trace requires input arguments.");
  }

  const projectRoot = resolve(requiredText(args.projectRoot, "projectRoot"));
  const repositoryRoot = resolve(args.repositoryRoot?.trim() || projectRoot);
  const buildRoot = resolve(args.buildRoot?.trim() || projectRoot);
  const udid = requiredText(args.udid, "udid");
  const runId = safeSegment(args.runId?.trim() || timestampForPath());
  const outputDir = resolve(
    args.outputDir?.trim() ||
      join(DEFAULT_ARTIFACT_ROOT, "ios-launch-trace", runId),
  );
  const htmlReportPath = resolve(
    args.htmlReportPath?.trim() || join(outputDir, "launch-trace-report.html"),
  );
  const targetBinary = args.targetBinary?.trim() || DEFAULT_TARGET_BINARY;
  const dsymPath = resolve(
    args.dsymPath?.trim() ||
      join(buildRoot, ".vscode-out", "dSYM", `${targetBinary}.app.dSYM`),
  );

  return {
    repositoryRoot,
    projectRoot,
    buildRoot,
    developerDir: resolveDeveloperDirectory(args.developerDir),
    udid,
    bundleId: args.bundleId?.trim() || DEFAULT_BUNDLE_ID,
    python: args.python?.trim() || "python3",
    appPath: resolve(
      args.appPath?.trim() ||
        join(buildRoot, ".vscode-out", `${targetBinary}.app`),
    ),
    dsymPath,
    symbolSearchPath: resolve(
      args.symbolSearchPath?.trim() || dirname(dsymPath),
    ),
    symbolicatedTracePath: join(outputDir, "symbolicated.trace"),
    timeLimit: args.timeLimit?.trim() || DEFAULT_TIME_LIMIT,
    skipInstall: args.skipInstall === true,
    outputDir,
    tracePath: join(outputDir, "launch_target.trace"),
    tocPath: join(outputDir, "toc.xml"),
    timeProfilePath: join(outputDir, "time_profile.xml"),
    summaryPath: join(outputDir, "summary.json"),
    targetBinary,
    businessBinary: args.businessBinary?.trim() || DEFAULT_BUSINESS_BINARY,
    htmlReportPath,
    maxSamples: boundedInteger(args.maxSamples, 40, 50000, DEFAULT_MAX_SAMPLES),
    maxDepth: boundedInteger(args.maxDepth, 4, 120, DEFAULT_MAX_DEPTH),
  };
}

/** Builds the xctrace command that launches and records the target App. */
export function buildLaunchRecordCommand(input: {
  udid: string;
  bundleId: string;
  timeLimit: string;
  tracePath: string;
}): string[] {
  return [
    "xcrun",
    "xctrace",
    "record",
    "--template",
    "Time Profiler",
    "--device",
    input.udid,
    "--time-limit",
    input.timeLimit,
    "--output",
    input.tracePath,
    "--no-prompt",
    "--launch",
    "--",
    input.bundleId,
  ];
}

/** Builds the install-only devicectl command used before a cold launch. */
export function buildInstallCommand(input: {
  udid: string;
  appPath: string;
}): string[] {
  return [
    "xcrun",
    "devicectl",
    "device",
    "install",
    "app",
    "--device",
    input.udid,
    input.appPath,
  ];
}

/** Builds the devicectl command that force-terminates one device process. */
export function buildTerminateCommand(input: {
  udid: string;
  pid: number;
}): string[] {
  return [
    "xcrun",
    "devicectl",
    "device",
    "process",
    "terminate",
    "--device",
    input.udid,
    "--pid",
    String(input.pid),
    "--kill",
  ];
}

async function terminateRunningAppProcesses(
  input: NormalizedInput,
): Promise<NonNullable<LaunchTraceSummary["terminate"]>> {
  const processes = await listDeviceProcesses(input);
  const executableSuffix = `/${input.targetBinary}.app/${input.targetBinary}`;
  const pids = processes
    .filter((process) => process.executable.endsWith(executableSuffix))
    .map((process) => process.pid);
  const results: CommandResult[] = [];
  for (const pid of pids) {
    results.push(
      await runCommand(
        buildTerminateCommand({ udid: input.udid, pid }),
        input.projectRoot,
        input.developerDir,
      ),
    );
  }
  return {
    returncode: results.find((result) => result.exitCode !== 0)?.exitCode ?? 0,
    stdout_tail: tail(results.map((result) => result.stdout).join("\n")),
    stderr_tail: tail(results.map((result) => result.stderr).join("\n")),
    requested_target: input.targetBinary,
    resolved_pids: pids,
    terminated_pids: pids.filter((_, index) => results[index]?.exitCode === 0),
  };
}

async function listDeviceProcesses(
  input: NormalizedInput,
): Promise<Array<{ pid: number; executable: string }>> {
  const outputPath = join(input.outputDir, "device-processes.json");
  const logPath = join(input.outputDir, "device-processes.log");
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
      outputPath,
      "--log-output",
      logPath,
      "--timeout",
      "10",
      "--quiet",
    ],
    input.projectRoot,
    input.developerDir,
  );
  if (result.exitCode !== 0 || !(await fileExists(outputPath))) {
    return [];
  }
  try {
    const payload = JSON.parse(await Bun.file(outputPath).text()) as {
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
  if (!value.startsWith("file://")) {
    return value;
  }
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    return value.replace(/^file:\/\//u, "");
  }
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  developerDir = "",
  environment: Record<string, string | undefined> = {},
): Promise<CommandResult> {
  const startedAt = new Date();
  const env = {
    ...process.env,
    ...environment,
    ...(developerDir ? { DEVELOPER_DIR: developerDir } : {}),
  };
  const subprocess = Bun.spawn([...command], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  const finishedAt = new Date();
  return {
    stdout,
    stderr,
    exitCode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}

/** Runs xctrace while observing its launch and recording-limit messages. */
export async function runLaunchRecordCommand(
  command: readonly string[],
  cwd: string,
  developerDir = "",
): Promise<CommandResult> {
  const startedAt = new Date();
  const subprocess = Bun.spawn([...command], {
    cwd,
    env: developerDir
      ? { ...process.env, DEVELOPER_DIR: developerDir }
      : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  let stderr = "";
  const stdoutObservation: {
    pendingLine?: string;
    startedAt?: string;
    finishedAt?: string;
  } = {};
  const stderrObservation: typeof stdoutObservation = {};

  await Promise.all([
    readProcessStream(subprocess.stdout, (chunk) => {
      stdout += chunk;
      observeLaunchRecordOutput(chunk, stdoutObservation);
    }),
    readProcessStream(subprocess.stderr, (chunk) => {
      stderr += chunk;
      observeLaunchRecordOutput(chunk, stderrObservation);
    }),
  ]);
  observeLaunchRecordOutput("\n", stdoutObservation);
  observeLaunchRecordOutput("\n", stderrObservation);
  const exitCode = await subprocess.exited;
  const finishedAt = new Date();
  const observedStartedAt =
    stdoutObservation.startedAt ?? stderrObservation.startedAt;
  const observedFinishedAt =
    stdoutObservation.finishedAt ?? stderrObservation.finishedAt;
  return {
    stdout,
    stderr,
    exitCode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    observedRecordingStartedAt: observedStartedAt,
    observedRecordingFinishedAt: observedFinishedAt,
    observedRecordingDurationMs:
      observedStartedAt && observedFinishedAt
        ? new Date(observedFinishedAt).getTime() -
          new Date(observedStartedAt).getTime()
        : undefined,
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

/** Updates launch timing when complete xctrace output lines arrive. */
export function observeLaunchRecordOutput(
  chunk: string,
  observation: {
    pendingLine?: string;
    startedAt?: string;
    finishedAt?: string;
  },
): typeof observation {
  const combined = `${observation.pendingLine ?? ""}${chunk}`;
  const lines = combined.split(/\r?\n/u);
  observation.pendingLine = lines.pop() ?? "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!observation.startedAt && line.includes("Launching process:")) {
      observation.startedAt = new Date().toISOString();
      log(
        [
          "## Time Profiler launched the App and started recording",
          `- **xctrace:** ${line}`,
        ].join("\n"),
      );
    } else if (
      observation.startedAt &&
      !observation.finishedAt &&
      line === "Reached specified time limit, ending recording..."
    ) {
      observation.finishedAt = new Date().toISOString();
      log(
        "## Time Profiler reached the recording limit\n- Waiting for xctrace to save the trace bundle.",
      );
    }
  }
  return observation;
}

/** Returns whether xctrace failed only because the launch image was omitted. */
export function isRecoverableMissingImageSymbolication(
  result: CommandResult,
): boolean {
  return (
    result.exitCode === 55 &&
    `${result.stdout}\n${result.stderr}`.includes(
      "No dSYMs were found or relevant to this trace",
    )
  );
}

function baseLaunchSummary(input: NormalizedInput): LaunchTraceSummary {
  return {
    success: false,
    mode: "launch",
    repository_root: input.repositoryRoot,
    project_root: input.projectRoot,
    build_root: input.buildRoot,
    udid: input.udid,
    bundle_id: input.bundleId,
    app_path: input.appPath,
    dsym_path: input.dsymPath,
    symbol_search_path: input.symbolSearchPath,
    target_binary: input.targetBinary,
    output_dir: input.outputDir,
    summary_path: input.summaryPath,
  };
}

async function validateLaunchInputs(
  input: NormalizedInput,
  summary: LaunchTraceSummary,
): Promise<void> {
  if (!(await fileExists(input.appPath))) {
    failCollection(
      summary,
      "missing_app",
      `App bundle was not found at ${input.appPath}. Run ios-build-install first.`,
    );
  }
  if (!(await fileExists(input.dsymPath))) {
    failCollection(
      summary,
      "missing_dsym",
      `App dSYM was not found at ${input.dsymPath}. Run ios-build-install with symbols enabled.`,
    );
  }
  if (!(await fileExists(input.symbolSearchPath))) {
    failCollection(
      summary,
      "missing_symbol_search_path",
      `Symbol search path was not found at ${input.symbolSearchPath}.`,
    );
  }
}

function failCollection(
  summary: LaunchTraceSummary,
  error: string,
  message: string,
): never {
  summary.success = false;
  summary.error = error;
  summary.message = message;
  throw new LaunchCollectionError(message);
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
  };
}

/** Builds the command that applies matching dSYMs to a launch trace. */
export function buildXctraceSymbolicateCommand(input: {
  tracePath: string;
  symbolicatedTracePath: string;
  symbolSearchPath: string;
}): string[] {
  return [
    "xcrun",
    "xctrace",
    "symbolicate",
    "--input",
    input.tracePath,
    "--output",
    input.symbolicatedTracePath,
    "--dsym",
    input.symbolSearchPath,
  ];
}

/** Builds the xctrace table-of-contents export command. */
export function buildTocExportCommand(
  tracePath: string,
  outputPath: string,
): string[] {
  return [
    "xcrun",
    "xctrace",
    "export",
    "--input",
    tracePath,
    "--toc",
    "--output",
    outputPath,
  ];
}

/** Builds the xctrace Time Profiler XML export command. */
export function buildTimeProfileExportCommand(
  tracePath: string,
  outputPath: string,
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
    outputPath,
  ];
}

/** Waits for two identical non-empty snapshots of the trace bundle tree. */
export async function waitForTraceTreeToSettle(
  tracePath: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<{ settled: boolean; snapshots: TraceTreeSnapshot[] }> {
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

/** Runs an xctrace export with bounded retries and attempt diagnostics. */
export async function runXctraceExportWithRetry(options: {
  label: string;
  command: readonly string[];
  outputPath: string;
  cwd: string;
  outputDir: string;
  developerDir?: string;
  attempts?: number;
  retryDelayMs?: number;
  runner?: (
    command: readonly string[],
    cwd: string,
    developerDir?: string,
  ) => Promise<CommandResult>;
}): Promise<{ result: CommandResult; attempts: ExportAttemptSummary[] }> {
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
  let result: CommandResult = { stdout: "", stderr: "", exitCode: -1 };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await rm(options.outputPath, { recursive: true, force: true });
    result = await runner(options.command, options.cwd, options.developerDir);
    const prefix = join(
      options.outputDir,
      `xctrace-export-${safeSegment(options.label)}-attempt-${attempt}`,
    );
    const stdoutPath = `${prefix}.stdout.txt`;
    const stderrPath = `${prefix}.stderr.txt`;
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
  return { result, attempts: attemptSummaries };
}

interface LaunchSymbolRecoveryInput {
  python: string;
  timeProfilePath: string;
  symbolSearchPath: string;
  dsymPath: string;
  targetBinary: string;
  businessBinary: string;
  projectRoot: string;
  developerDir: string;
  environment?: Record<string, string | undefined>;
}

/** Runs the bundled UUID-aware, fail-closed symbol recovery pass. */
export async function recoverLaunchSymbols(
  input: LaunchSymbolRecoveryInput,
): Promise<{
  coverage: LaunchCoverage;
  symbolUuids: Record<string, string[]>;
  backfill: NonNullable<LaunchTraceSummary["atos_backfill"]>;
}> {
  const result = await runCommand(
    [
      input.python,
      "-c",
      PYTHON_SYMBOL_RECOVERY,
      input.timeProfilePath,
      input.symbolSearchPath,
      input.dsymPath,
      input.targetBinary,
      input.businessBinary,
    ],
    input.projectRoot,
    input.developerDir,
    input.environment,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Bundled symbol recovery failed with return code ${result.exitCode}: ${tail(result.stderr)}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as {
      coverage: LaunchCoverage;
      symbolUuids: Record<string, string[]>;
      backfill: NonNullable<LaunchTraceSummary["atos_backfill"]>;
    };
  } catch (cause) {
    throw new Error(
      `Bundled symbol recovery returned invalid JSON: ${formatError(cause)}`,
      { cause },
    );
  }
}

/** Applies same-image UUID and source-coverage validation to a summary. */
export function validateLaunchSymbolication(summary: LaunchTraceSummary): void {
  if (summary.success === false && summary.error) {
    return;
  }
  const traceUuids = summary.trace_target_uuids ?? {};
  const symbolUuids = summary.symbol_uuids ?? {};
  const mismatches = Object.fromEntries(
    Object.entries(traceUuids).filter(
      ([name, uuid]) =>
        symbolUuids[name] && !symbolUuids[name]!.includes(uuid.toUpperCase()),
    ),
  );
  if (Object.keys(mismatches).length > 0) {
    summary.success = false;
    summary.symbolication_status = "mismatch";
    summary.error = "dsym_uuid_mismatch";
    summary.message =
      `No matching dSYM UUID for recorded images: ${JSON.stringify(mismatches)}. ` +
      "Supply symbols from the recorded App build. The raw trace is preserved.";
    return;
  }

  const sourceImages = summary.main_thread_source_rows_by_binary ?? {};
  if (Object.keys(sourceImages).length === 0) {
    summary.success = false;
    summary.symbolication_status = "missing";
    summary.error = "missing_symbols";
    summary.message =
      "No target source symbols were found. The raw trace is preserved.";
    return;
  }

  const allSourceImagesVerified = Object.keys(sourceImages).every((name) => {
    const traceUuid = traceUuids[name]?.toUpperCase();
    return Boolean(traceUuid && symbolUuids[name]?.includes(traceUuid));
  });
  const unresolvedRows = summary.main_thread_unresolved_rows ?? 0;
  summary.success = true;
  summary.symbolication_status =
    unresolvedRows === 0 && allSourceImagesVerified ? "ready" : "partial";
  delete summary.error;
  delete summary.message;
  if (unresolvedRows > 0) {
    summary.warning =
      `${unresolvedRows} main-thread samples still contain raw addresses; ` +
      `${summary.main_thread_unmapped_rows ?? 0} lack an image mapping. ` +
      "Available source symbols do not imply complete symbolication.";
  }
}

async function writeLaunchSummary(
  path: string,
  summary: LaunchTraceSummary,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

async function writeLaunchReport(options: {
  input: NormalizedInput;
  summary: LaunchTraceSummary;
  command: string[];
  result: CommandResult;
  timeline: ParsedTraceTimeline;
}): Promise<void> {
  const html = renderLaunchTraceHtml({
    command: options.command,
    exitCode:
      options.summary.success === true ? 0 : options.result.exitCode || 1,
    generatedAt: new Date().toISOString(),
    outputDir: options.input.outputDir,
    summary: options.summary,
    summaryPath: options.input.summaryPath,
    timeProfilePath: options.input.timeProfilePath,
    stdoutTail: tail(options.result.stdout),
    stderrTail: tail(options.result.stderr),
    timeline: options.timeline,
  });
  await mkdir(dirname(options.input.htmlReportPath), { recursive: true });
  await writeFile(options.input.htmlReportPath, html, "utf8");
}

async function parseSuccessfulTrace(options: {
  timeProfilePath: string;
  summary: LaunchTraceSummary;
  python: string;
  targetBinary: string;
  maxSamples: number;
  maxDepth: number;
}): Promise<ParsedTraceTimeline> {
  log(
    [
      "## Parsing exported Time Profiler XML",
      `- **Time profile:** \`${options.timeProfilePath}\``,
      `- **Symbolication:** \`${options.summary.symbolication_status ?? "unknown"}\``,
    ].join("\n"),
  );

  return parseTraceTimeline({
    timeProfilePath: options.timeProfilePath,
    targetBinary: options.targetBinary,
    maxSamples: options.maxSamples,
    maxDepth: options.maxDepth,
    python: options.python,
  });
}

function skippedTimelineForCollectionFailure(
  summary: LaunchTraceSummary,
  exitCode: number,
): ParsedTraceTimeline {
  const reason = collectionFailureReason(summary, exitCode);
  log(
    [
      "## Skipping Time Profiler XML parsing",
      `- **Collection:** failed`,
      `- **Reason:** ${reason}`,
      "- No Time Profiler XML will be parsed for this failed collection.",
    ].join("\n"),
  );

  return emptyTimeline([reason]);
}

function collectionFailureReason(
  summary: LaunchTraceSummary,
  exitCode: number,
): string {
  const code = summary.error?.trim();
  const message = summary.message?.trim();
  if (code && message) {
    return `${code}: ${message}`;
  }
  if (message) {
    return message;
  }
  if (code) {
    return code;
  }
  return `collection exited with status ${exitCode}`;
}

/**
 * Parses the exported Time Profiler XML into timeline spans for rendering.
 *
 * @param options - XML path, binary highlight, and sampling limits.
 * @returns Down-sampled main-thread frames and merged spans.
 */
export async function parseTraceTimeline(options: {
  timeProfilePath: string;
  targetBinary: string;
  maxSamples: number;
  maxDepth: number;
  python?: string;
}): Promise<ParsedTraceTimeline> {
  if (!(await fileExists(options.timeProfilePath))) {
    return emptyTimeline([
      `time_profile.xml was not found at ${options.timeProfilePath}.`,
    ]);
  }

  const command = [
    options.python ?? "python3",
    "-c",
    PYTHON_TRACE_PARSER,
    options.timeProfilePath,
    options.targetBinary,
    String(options.maxSamples),
    String(options.maxDepth),
  ];
  const result = await runCommand(command, process.cwd());

  if (result.exitCode !== 0) {
    return emptyTimeline([
      `Python XML parser exited with status ${result.exitCode}.`,
      tail(result.stderr),
    ]);
  }

  try {
    const payload = JSON.parse(result.stdout) as PythonTimelinePayload;
    const timeline = buildTraceTimelineFromSamples(payload.samples ?? [], {
      sampleStride: payload.sampleStride ?? 1,
      sampleTimesSeconds: payload.sampleTimesSeconds ?? [],
      sampleWeightsMs: payload.sampleWeightsMs ?? [],
      totalMainThreadRows: payload.totalMainThreadRows ?? 0,
      warnings: payload.warnings ?? [],
    });
    const threads = buildThreadTimelines(payload.threads ?? []);
    const traceStartSeconds = Number(payload.traceStartSeconds ?? 0);
    const traceEndSeconds = Number(payload.traceEndSeconds ?? 0);
    return {
      ...timeline,
      threads,
      traceStartSeconds,
      traceEndSeconds:
        traceEndSeconds > traceStartSeconds
          ? traceEndSeconds
          : traceStartSeconds,
    };
  } catch (cause) {
    return emptyTimeline([
      `Could not parse XML parser output: ${formatError(cause)}.`,
    ]);
  }
}

/**
 * Builds one time-based flame timeline per sampled thread.
 *
 * @param threads - Per-thread payloads from the Python parser.
 * @returns Render-ready per-thread timelines sorted main-thread first.
 */
export function buildThreadTimelines(
  threads: readonly PythonThreadPayload[],
): ThreadTimeline[] {
  return threads.map((thread, index) => {
    const samples = thread.samples ?? [];
    const built = buildTraceTimelineFromSamples(samples, {
      sampleStride: thread.stride ?? 1,
      sampleTimesSeconds: thread.sampleTimesSeconds ?? [],
      sampleWeightsMs: thread.sampleWeightsMs ?? [],
      totalMainThreadRows: thread.totalRows ?? samples.length,
      warnings: [],
    });
    const startSeconds = built.sampleTimesSeconds[0] ?? 0;
    const endSeconds =
      built.spans.reduce(
        (maximum, span) => Math.max(maximum, span.endTimeSeconds),
        startSeconds,
      ) || startSeconds;
    const isMain = thread.isMain === true;
    const hasAppFrame = built.spans.some((span) => span.appFrame);
    const group: ThreadTimeline["group"] = isMain
      ? "main"
      : hasAppFrame
        ? "app"
        : "other";
    return {
      threadId: String(thread.threadId ?? index),
      label:
        thread.label ?? (thread.isMain ? "Main Thread" : `Thread ${index}`),
      isMain,
      group,
      totalRows: thread.totalRows ?? samples.length,
      renderedSamples: built.renderedSamples,
      maxDepth: built.maxDepth,
      startSeconds,
      endSeconds,
      sampleDepths: built.sampleDepths,
      spans: built.spans,
    };
  });
}

/**
 * Converts sampled stacks into merged flame timeline spans.
 *
 * @param samples - Ordered main-thread samples, each containing stack frames.
 * @param metadata - Total row count and down-sampling metadata.
 * @returns Render-ready timeline data.
 */
export function buildTraceTimelineFromSamples(
  samples: readonly (readonly TraceFrame[])[],
  metadata: {
    totalMainThreadRows?: number;
    sampleStride?: number;
    sampleTimesSeconds?: readonly number[];
    sampleWeightsMs?: readonly number[];
    warnings?: readonly string[];
  } = {},
): ParsedTraceTimeline {
  const renderedSamples = samples.length;
  const hasRealSampleTimes = hasProvidedSampleTimes(
    renderedSamples,
    metadata.sampleTimesSeconds,
  );
  const sampleTimesSeconds = normalizeSampleTimes(
    renderedSamples,
    metadata.sampleTimesSeconds,
  );
  const sampleWeightsMs = normalizeSampleWeights(
    renderedSamples,
    metadata.sampleWeightsMs,
    sampleTimesSeconds,
  );
  const sampleDepths = samples.map((sample) => sample.length);
  const maxDepth = sampleDepths.reduce(
    (maximum, depth) => Math.max(maximum, depth),
    0,
  );
  const spans: TraceFrameSpan[] = [];

  for (let depth = 0; depth < maxDepth; depth += 1) {
    let active: { frame: TraceFrame; startSample: number } | null = null;

    for (
      let sampleIndex = 0;
      sampleIndex <= renderedSamples;
      sampleIndex += 1
    ) {
      const frame = samples[sampleIndex]?.[depth];
      if (frame && active && sameFrame(frame, active.frame)) {
        continue;
      }

      if (active) {
        const spanWeights = sampleWeightsMs.slice(
          active.startSample,
          sampleIndex,
        );
        spans.push({
          ...active.frame,
          depth,
          startSample: active.startSample,
          endSample: sampleIndex,
          startTimeSeconds: sampleTimesSeconds[active.startSample] ?? 0,
          endTimeSeconds: hasRealSampleTimes
            ? sampleWeightedEndTimeSeconds(
                sampleIndex,
                sampleTimesSeconds,
                sampleWeightsMs,
              )
            : sampleBoundaryTimeSeconds(sampleIndex, sampleTimesSeconds),
          weightMs: spanWeights.reduce((sum, weight) => sum + weight, 0),
          color: frameColor(active.frame),
        });
      }

      active = frame ? { frame, startSample: sampleIndex } : null;
    }
  }

  const topFrameMap = new Map<string, TraceFrame & { samples: number }>();
  for (const sample of samples) {
    for (const frame of sample) {
      const key = frameIdentity(frame);
      const existing = topFrameMap.get(key);
      if (existing) {
        existing.samples += 1;
      } else {
        topFrameMap.set(key, { ...frame, samples: 1 });
      }
    }
  }

  const topFrames = Array.from(topFrameMap.values())
    .sort((left, right) => {
      if (left.appFrame !== right.appFrame) {
        return left.appFrame ? -1 : 1;
      }
      return right.samples - left.samples;
    })
    .slice(0, 16);

  return {
    totalMainThreadRows: metadata.totalMainThreadRows ?? renderedSamples,
    renderedSamples,
    sampleStride: metadata.sampleStride ?? 1,
    sampleTimesSeconds,
    sampleWeightsMs,
    maxDepth,
    sampleDepths,
    spans,
    topFrames,
    threads: [],
    traceStartSeconds: sampleTimesSeconds[0] ?? 0,
    traceEndSeconds:
      spans.reduce(
        (maximum, span) => Math.max(maximum, span.endTimeSeconds),
        sampleTimesSeconds[0] ?? 0,
      ) ||
      (sampleTimesSeconds[0] ?? 0),
    warnings: [...(metadata.warnings ?? [])],
  };
}

function normalizeSampleTimes(
  renderedSamples: number,
  sampleTimesSeconds: readonly number[] | undefined,
): number[] {
  const normalized = Array.from({ length: renderedSamples }, (_, index) => {
    const value = sampleTimesSeconds?.[index];
    return Number.isFinite(value) ? Number(value) : index;
  });

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1] ?? 0;
    const current = normalized[index] ?? previous;
    if (current < previous) {
      normalized[index] = previous;
    }
  }
  return normalized;
}

function hasProvidedSampleTimes(
  renderedSamples: number,
  sampleTimesSeconds: readonly number[] | undefined,
): boolean {
  return (
    renderedSamples > 0 &&
    Array.isArray(sampleTimesSeconds) &&
    sampleTimesSeconds.length > 0
  );
}

function normalizeSampleWeights(
  renderedSamples: number,
  sampleWeightsMs: readonly number[] | undefined,
  sampleTimesSeconds: readonly number[],
): number[] {
  return Array.from({ length: renderedSamples }, (_, index) => {
    const weight = sampleWeightsMs?.[index];
    if (Number.isFinite(weight) && Number(weight) > 0) {
      return Number(weight);
    }
    const nextTime = sampleBoundaryTimeSeconds(index + 1, sampleTimesSeconds);
    const currentTime = sampleTimesSeconds[index] ?? 0;
    const inferredMs = (nextTime - currentTime) * 1000;
    return Number.isFinite(inferredMs) && inferredMs > 0 ? inferredMs : 1;
  });
}

function sampleBoundaryTimeSeconds(
  endSample: number,
  sampleTimesSeconds: readonly number[],
): number {
  if (sampleTimesSeconds.length === 0) {
    return endSample;
  }
  const lastIndex = sampleTimesSeconds.length - 1;
  if (endSample <= lastIndex) {
    return sampleTimesSeconds[endSample] ?? sampleTimesSeconds[lastIndex] ?? 0;
  }
  if (sampleTimesSeconds.length >= 2) {
    const last = sampleTimesSeconds[lastIndex] ?? 0;
    const previous = sampleTimesSeconds[lastIndex - 1] ?? last;
    const interval = Math.max(0.001, last - previous);
    return last + interval * (endSample - lastIndex);
  }
  return (sampleTimesSeconds[0] ?? 0) + Math.max(1, endSample);
}

function sampleWeightedEndTimeSeconds(
  endSample: number,
  sampleTimesSeconds: readonly number[],
  sampleWeightsMs: readonly number[],
): number {
  if (sampleTimesSeconds.length === 0) {
    return endSample;
  }
  const lastIndex = sampleTimesSeconds.length - 1;
  const lastCoveredIndex = Math.min(Math.max(0, endSample - 1), lastIndex);
  const lastSampleTime = sampleTimesSeconds[lastCoveredIndex] ?? 0;
  const lastSampleWeightSeconds =
    Math.max(0.001, sampleWeightsMs[lastCoveredIndex] ?? 1) / 1000;
  return lastSampleTime + lastSampleWeightSeconds;
}

/**
 * Renders a self-contained Instruments-inspired HTML report.
 *
 * @param input - Collection summary and parsed timeline data.
 * @returns Complete HTML document.
 */
export function renderLaunchTraceHtml(
  input: RenderLaunchTraceHtmlInput,
): string {
  const { summary, timeline } = input;
  const sampleCount = Math.max(1, timeline.renderedSamples);
  const timelineWidth = Math.max(
    1280,
    sampleCount * TIMELINE_PIXELS_PER_SAMPLE,
  );
  const frameHeight = 18;
  const fallbackDurationSeconds =
    parseTimeLimitFromCommand(input.command) ?? 10;
  const layout = buildThreadLayout(
    timeline,
    frameHeight,
    fallbackDurationSeconds,
  );
  const timelineHeight = layout.timelineHeight;
  const topRows = timeline.topFrames
    .map(
      (frame, index) => `
        <tr class="top-frame-row" data-frame-name="${escapeAttribute(frame.name)}">
          <td>${index + 1}</td>
          <td><span class="binary-dot ${frame.appFrame ? "app" : "system"}"></span>${escapeHtml(frame.binary || "unknown")}</td>
          <td title="${escapeAttribute(frame.name)}">${escapeHtml(frame.name)}</td>
          <td>${frame.samples}</td>
          <td>${escapeHtml(formatSource(frame))}</td>
        </tr>`,
    )
    .join("");
  const warnings =
    timeline.warnings.length > 0
      ? `<section class="band warnings"><h2>Warnings</h2><ul>${timeline.warnings
          .map((warning) => `<li>${escapeHtml(warning)}</li>`)
          .join("")}</ul></section>`
      : "";
  const diagnostics = renderCollectionDiagnostics(input);
  const commandLine = input.command.map(shellQuote).join(" ");
  const status = summary.symbolication_status ?? "unknown";
  const viewerScript = renderViewerScript();
  const viewerData = renderViewerDataScript({
    timeline,
    layout,
    frameHeight,
    timelineHeight,
    durationSeconds: fallbackDurationSeconds,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>iOS Launch Trace Timeline</title>
  <style>
    :root {
      --bg: #f7f7f4;
      --panel: #ffffff;
      --ink: #1f252d;
      --muted: #68717d;
      --line: #d8dce1;
      --track: #202c3a;
      --toolbar: #101722;
      --sidebar: #ffe56b;
      --sidebar-deep: #e7c13a;
      --ready: #0d8f56;
      --partial: #b7791f;
      --missing: #c24135;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--sans);
      font-size: 14px;
      letter-spacing: 0;
    }
    .hero {
      padding: 24px 28px 18px;
      background: #ffffff;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      line-height: 1.16;
      font-weight: 760;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 16px;
      line-height: 1.25;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 10px;
      max-width: 1180px;
    }
    .metric {
      min-height: 66px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 12px;
      background: #fbfbfa;
    }
    .metric strong {
      display: block;
      font-size: 20px;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .metric span {
      display: block;
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      border-radius: 4px;
      padding: 3px 8px;
      color: #ffffff;
      font-weight: 700;
      font-size: 13px;
    }
    .status.ready { background: var(--ready); }
    .status.partial { background: var(--partial); }
    .status.missing,
    .status.unknown { background: var(--missing); }
    .viewer-toolbar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      align-items: center;
      padding: 10px 14px;
      background: var(--toolbar);
      color: #ffffff;
      border-bottom: 1px solid #313a47;
    }
    .viewer-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-wrap: wrap;
    }
    .tool-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 32px;
      height: 30px;
      border: 1px solid #3c4756;
      border-radius: 4px;
      background: #1b2431;
      color: #ffffff;
      font-weight: 700;
      font-family: var(--mono);
      cursor: pointer;
    }
    .tool-button:hover,
    .tool-button:focus-visible {
      border-color: #6d7a8d;
      background: #263244;
      outline: none;
    }
    .zoom-control {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 190px;
      color: #ccd4df;
      font-size: 12px;
    }
    .zoom-control input {
      width: 118px;
      accent-color: #7eb7ff;
    }
    .search-box {
      width: min(320px, 44vw);
      height: 30px;
      border: 1px solid #3c4756;
      border-radius: 4px;
      background: #0d131d;
      color: #ffffff;
      padding: 0 10px;
      font: 12px var(--mono);
    }
    .search-box:focus {
      border-color: #7eb7ff;
      outline: none;
    }
    .search-status {
      min-width: 86px;
      font: 12px var(--mono);
      color: #9fb0c3;
    }
    .thread-filter-panel {
      border-bottom: 1px solid #313a47;
      background: #0d131d;
      color: #eef3f8;
    }
    .thread-filter-header {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
      padding: 8px 14px;
      flex-wrap: wrap;
    }
    .thread-filter-title {
      font-weight: 750;
      font-size: 13px;
    }
    .thread-filter-status {
      min-width: 126px;
      color: #9fb0c3;
      font: 12px var(--mono);
    }
    .thread-filter-search {
      width: min(300px, 44vw);
      height: 30px;
      border: 1px solid #3c4756;
      border-radius: 4px;
      background: #090e15;
      color: #ffffff;
      padding: 0 10px;
      font: 12px var(--mono);
    }
    .thread-filter-search:focus {
      border-color: #7eb7ff;
      outline: none;
    }
    .thread-filter-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 4px 8px;
      max-height: 168px;
      overflow: auto;
      padding: 0 14px 10px;
    }
    .thread-filter-group {
      grid-column: 1 / -1;
      min-height: 24px;
      display: flex;
      align-items: center;
      color: #9fb0c3;
      font-size: 12px;
      font-weight: 700;
    }
    .thread-filter-item {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      min-height: 30px;
      border: 1px solid #263244;
      border-radius: 4px;
      padding: 4px 8px;
      background: #111a26;
      cursor: pointer;
    }
    .thread-filter-item:hover,
    .thread-filter-item:focus-within {
      border-color: #536173;
      background: #152032;
    }
    .thread-filter-item input {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: #7eb7ff;
    }
    .thread-filter-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 650;
    }
    .thread-filter-meta {
      color: #9fb0c3;
      font: 11px var(--mono);
      white-space: nowrap;
    }
    .thread-filter-empty {
      grid-column: 1 / -1;
      min-height: 34px;
      display: flex;
      align-items: center;
      color: #9fb0c3;
      font-size: 12px;
    }
    .viewer-readout {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 280px;
      font: 12px var(--mono);
      color: #dce4ee;
    }
    .mini-map {
      position: relative;
      width: 180px;
      height: 18px;
      border: 1px solid #485466;
      border-radius: 3px;
      background: linear-gradient(90deg, #3b4656, #223044);
      overflow: hidden;
    }
    .mini-window {
      position: absolute;
      top: 1px;
      bottom: 1px;
      left: 0;
      width: 100%;
      min-width: 5px;
      border: 1px solid #ffffff;
      border-radius: 2px;
      background: rgba(126, 183, 255, 0.32);
    }
    .trace-shell {
      display: block;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
    }
    .workspace-sidebar {
      display: none;
    }
    .workspace-title {
      height: 52px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      background: #ffffff;
      border-bottom: 1px solid var(--line);
      font-weight: 700;
    }
    .process-row {
      height: 31px;
      display: flex;
      align-items: center;
      padding: 0 10px;
      background: var(--sidebar);
      border-bottom: 1px solid var(--sidebar-deep);
      font-size: 13px;
    }
    .thread-row {
      min-height: 60px;
      padding: 9px 10px;
      color: #7b6813;
      background: #ffe978;
      font-family: var(--mono);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .timeline-scroll {
      position: relative;
      overflow-x: auto;
      overflow-y: auto;
      max-height: 78vh;
      overscroll-behavior: contain;
      background: #ffffff;
    }
    .timeline-spacer {
      position: relative;
      width: ${timelineWidth}px;
      min-width: ${timelineWidth}px;
      min-height: ${timelineHeight}px;
    }
    .timeline {
      position: absolute;
      left: 0;
      top: 0;
      min-width: 0;
      background: #ffffff;
      contain: paint style;
      pointer-events: none;
    }
    .timeline-canvas {
      display: block;
      width: 100%;
      height: ${timelineHeight}px;
      background: #ffffff;
      cursor: crosshair;
      contain: strict;
      transform: translateZ(0);
      pointer-events: auto;
    }
    .details-panel {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 60;
      width: min(420px, calc(100vw - 32px));
      max-height: min(360px, 42vh);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(251, 251, 250, 0.98);
      box-shadow: 0 14px 34px rgba(15, 23, 42, 0.22);
      padding: 14px;
      min-height: 0;
    }
    .details-panel h2 {
      margin-bottom: 10px;
    }
    .details-panel dl {
      display: grid;
      grid-template-columns: 82px minmax(0, 1fr);
      gap: 8px 10px;
      margin: 0;
      font-size: 12px;
    }
    .details-panel dt {
      color: var(--muted);
    }
    .details-panel dd {
      margin: 0;
      overflow-wrap: anywhere;
      font-family: var(--mono);
    }
    .detail-note {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }
    .top-frame-row {
      cursor: pointer;
    }
    .top-frame-row:hover,
    .top-frame-row.selected {
      background: #eef6ff;
    }
    .band {
      padding: 20px 28px;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
    }
    .paths {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 8px 12px;
      max-width: 1180px;
      font-family: var(--mono);
      font-size: 12px;
    }
    .paths dt {
      color: var(--muted);
    }
    .paths dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    table {
      width: min(1180px, 100%);
      border-collapse: collapse;
      background: #ffffff;
      font-size: 13px;
    }
    th,
    td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    td:nth-child(3) {
      max-width: 520px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--mono);
      font-size: 12px;
    }
    .binary-dot {
      display: inline-block;
      width: 9px;
      height: 9px;
      margin-right: 7px;
      border-radius: 50%;
      background: #8b95a1;
    }
    .binary-dot.app { background: #1c9b6a; }
    .warnings {
      background: #fff8e7;
    }
    .warnings ul {
      margin: 0;
      padding-left: 18px;
    }
    code {
      font-family: var(--mono);
      font-size: 12px;
    }
    @media (max-width: 760px) {
      .hero,
      .band { padding: 16px; }
      .viewer-toolbar {
        position: static;
        grid-template-columns: 1fr;
      }
      .viewer-readout {
        min-width: 0;
        justify-content: space-between;
      }
      .thread-filter-search {
        width: min(100%, 320px);
      }
      .details-panel {
        right: 8px;
        bottom: 8px;
        width: calc(100vw - 16px);
        max-height: 36vh;
      }
      .workspace-title,
      .process-row,
      .thread-row { padding-left: 8px; padding-right: 8px; }
      .paths { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="hero">
    <h1>iOS Launch Trace Timeline</h1>
    <div class="summary-grid">
      <div class="metric"><strong><span class="status ${escapeAttribute(statusClass(status))}">${escapeHtml(status)}</span></strong><span>symbolication</span></div>
      <div class="metric"><strong>${summary.success === true ? "success" : "failed"}</strong><span>collection result</span></div>
      <div class="metric"><strong>${formatInteger(timeline.totalMainThreadRows)}</strong><span>main-thread rows</span></div>
      <div class="metric"><strong>${formatInteger(summary.main_thread_grace_source_rows ?? 0)}</strong><span>source-level app rows</span></div>
      <div class="metric"><strong>${formatInteger(timeline.renderedSamples)}</strong><span>rendered samples</span></div>
      <div class="metric"><strong>${input.exitCode}</strong><span>collection exit code</span></div>
    </div>
  </header>

  <section class="viewer-toolbar" aria-label="Trace controls">
    <div class="viewer-actions">
      <button class="tool-button" type="button" title="Zoom out" aria-label="Zoom out" data-zoom-out>-</button>
      <button class="tool-button" type="button" title="Zoom in" aria-label="Zoom in" data-zoom-in>+</button>
      <button class="tool-button" type="button" title="Fit timeline" aria-label="Fit timeline" data-fit>Fit</button>
      <button class="tool-button" type="button" title="Reset zoom" aria-label="Reset zoom" data-reset>1:1</button>
      <button class="tool-button" type="button" title="Expand all threads" aria-label="Expand all threads" data-expand-all>Expand all</button>
      <button class="tool-button" type="button" title="Collapse all threads" aria-label="Collapse all threads" data-collapse-all>Collapse all</button>
      <label class="zoom-control">Zoom <input type="range" min="1" max="6400" value="100" step="1" data-zoom-slider><span data-zoom-label>100%</span></label>
      <input class="search-box" type="search" placeholder="Search frames" aria-label="Search frames" data-search>
      <button class="tool-button" type="button" title="Clear search" aria-label="Clear search" data-clear-search>Clear</button>
      <span class="search-status" data-search-status aria-live="polite"></span>
    </div>
    <div class="viewer-readout">
      <span data-range>${formatTime(0)} - ${formatTime(fallbackDurationSeconds)}</span>
      <span class="mini-map" aria-hidden="true"><span class="mini-window" data-mini-window></span></span>
    </div>
  </section>

  <section class="thread-filter-panel" aria-label="Thread filter">
    <div class="thread-filter-header">
      <span class="thread-filter-title">Threads</span>
      <input class="thread-filter-search" type="search" placeholder="Search threads" aria-label="Search threads" data-thread-filter-search>
      <button class="tool-button" type="button" title="Select all threads" aria-label="Select all threads" data-thread-select-all>All</button>
      <button class="tool-button" type="button" title="Clear selected threads" aria-label="Clear selected threads" data-thread-clear>None</button>
      <span class="thread-filter-status" data-thread-filter-status aria-live="polite"></span>
    </div>
    <div class="thread-filter-list" data-thread-filter-list></div>
  </section>

  <section class="trace-shell" aria-label="Launch trace timeline">
    <aside class="workspace-sidebar">
      <div class="workspace-title">Default Workspace</div>
      <div class="process-row">Process ${escapeHtml(summary.bundle_id ?? "target")}</div>
      <div class="thread-row">${formatInteger(timeline.threads.length)} threads<br>${escapeHtml(summary.bundle_id ?? "")}</div>
    </aside>
    <div class="timeline-scroll" data-scroll>
      <div class="timeline-spacer" data-spacer>
        <div class="timeline" data-timeline data-base-width="${timelineWidth}" data-duration-seconds="${fallbackDurationSeconds}" data-sample-count="${sampleCount}">
          <canvas class="timeline-canvas" data-canvas width="${timelineWidth}" height="${timelineHeight}" aria-label="Launch trace flame graph"></canvas>
        </div>
      </div>
    </div>
    <aside class="details-panel" aria-live="polite" data-details-panel hidden>
      <h2>Frame Details</h2>
      <dl>
        <dt>Name</dt><dd data-detail-name>No frame selected</dd>
        <dt>Thread</dt><dd data-detail-thread>-</dd>
        <dt>Binary</dt><dd data-detail-binary>-</dd>
        <dt>Source</dt><dd data-detail-source>-</dd>
        <dt>Samples</dt><dd data-detail-samples>-</dd>
        <dt>Sample Weight</dt><dd data-detail-duration>-</dd>
        <dt>Time</dt><dd data-detail-time>-</dd>
        <dt>Depth</dt><dd data-detail-depth>-</dd>
      </dl>
      <p class="detail-note" data-detail-note hidden></p>
    </aside>
  </section>

  <section class="band">
    <h2>Top Sampled Frames</h2>
    <table>
      <thead>
        <tr><th>#</th><th>Binary</th><th>Symbol</th><th>Samples</th><th>Source</th></tr>
      </thead>
      <tbody>${topRows || `<tr><td colspan="5">No sampled frames were found.</td></tr>`}</tbody>
    </table>
  </section>

  ${warnings}
  ${diagnostics}

  <section class="band">
    <h2>Artifacts</h2>
    <dl class="paths">
      <dt>Generated</dt><dd>${escapeHtml(input.generatedAt)}</dd>
      <dt>Output</dt><dd>${escapeHtml(input.outputDir)}</dd>
      <dt>Summary</dt><dd>${escapeHtml(input.summaryPath)}</dd>
      <dt>Trace</dt><dd>${escapeHtml(summary.trace_path ?? "")}</dd>
      <dt>TOC</dt><dd>${escapeHtml(summary.toc_path ?? "")}</dd>
      <dt>Time Profile</dt><dd>${escapeHtml(input.timeProfilePath)}</dd>
      <dt>dSYM UUID</dt><dd>${escapeHtml(summary.dsym_uuid ?? "")}</dd>
      <dt>Trace UUID</dt><dd>${escapeHtml(summary.trace_grace_uuid ?? "")}</dd>
      <dt>Collection error</dt><dd>${escapeHtml(summary.error ?? "")}</dd>
      <dt>Collection message</dt><dd>${escapeHtml(summary.message ?? "")}</dd>
      <dt>Command</dt><dd><code>${escapeHtml(commandLine)}</code></dd>
    </dl>
  </section>
  ${viewerData}
  ${viewerScript}
</body>
</html>`;
}

interface ThreadLayout {
  headerHeight: number;
  groupHeaderHeight: number;
  laneGap: number;
  contentTop: number;
  timelineHeight: number;
  traceStartSeconds: number;
  traceEndSeconds: number;
  traceDurationSeconds: number;
}

const TIMELINE_HEADER_OFFSET = 153;
const THREAD_GROUP_ORDER: ThreadTimeline["group"][] = ["main", "app", "other"];

/**
 * Estimates the initial stacked height and resolves the shared time domain.
 *
 * The viewer recomputes exact band offsets on the client so groups and threads
 * can collapse, so this only needs a reasonable starting height.
 *
 * @param timeline - Parsed timeline carrying per-thread flame data.
 * @param frameHeight - Pixel height of a single stack frame row.
 * @param fallbackDurationSeconds - Duration used when the trace has no range.
 * @returns Layout metrics plus the overall time domain.
 */
function buildThreadLayout(
  timeline: ParsedTraceTimeline,
  frameHeight: number,
  fallbackDurationSeconds: number,
): ThreadLayout {
  const headerHeight = 22;
  const groupHeaderHeight = 26;
  const laneGap = 10;
  const contentTop = TIMELINE_HEADER_OFFSET;
  const threads =
    timeline.threads.length > 0
      ? timeline.threads
      : fallbackThreadList(timeline);

  const groups = new Set<string>();
  let cursor = contentTop;
  for (const thread of threads) {
    groups.add(thread.group);
    const depth = Math.max(1, thread.maxDepth);
    cursor += headerHeight + depth * frameHeight + laneGap;
  }
  cursor += groups.size * groupHeaderHeight;

  const contentHeight = Math.max(240, cursor - contentTop);
  const timelineHeight = contentTop + contentHeight + 8;
  const traceStartSeconds = timeline.traceStartSeconds ?? 0;
  const rawEnd = timeline.traceEndSeconds ?? 0;
  const traceEndSeconds =
    rawEnd > traceStartSeconds
      ? rawEnd
      : traceStartSeconds + fallbackDurationSeconds;
  return {
    headerHeight,
    groupHeaderHeight,
    laneGap,
    contentTop,
    timelineHeight,
    traceStartSeconds,
    traceEndSeconds,
    traceDurationSeconds: Math.max(0.001, traceEndSeconds - traceStartSeconds),
  };
}

function fallbackThreadList(timeline: ParsedTraceTimeline): ThreadTimeline[] {
  if (timeline.renderedSamples === 0) {
    return [];
  }
  return [
    {
      threadId: "main",
      label: "Main Thread",
      isMain: true,
      group: "main",
      totalRows: timeline.totalMainThreadRows,
      renderedSamples: timeline.renderedSamples,
      maxDepth: timeline.maxDepth,
      startSeconds: timeline.sampleTimesSeconds[0] ?? 0,
      endSeconds: timeline.traceEndSeconds,
      sampleDepths: timeline.sampleDepths,
      spans: timeline.spans,
    },
  ];
}

function renderViewerDataScript(input: {
  timeline: ParsedTraceTimeline;
  layout: ThreadLayout;
  frameHeight: number;
  timelineHeight: number;
  durationSeconds: number;
}): string {
  const threads =
    input.timeline.threads.length > 0
      ? input.timeline.threads
      : fallbackThreadList(input.timeline);
  const orderedThreads = [...threads].sort((left, right) => {
    const groupDelta =
      THREAD_GROUP_ORDER.indexOf(left.group) -
      THREAD_GROUP_ORDER.indexOf(right.group);
    if (groupDelta !== 0) {
      return groupDelta;
    }
    return right.renderedSamples - left.renderedSamples;
  });
  const payload = {
    frameHeight: input.frameHeight,
    timelineHeight: input.timelineHeight,
    durationSeconds: input.durationSeconds,
    traceStartSeconds: input.layout.traceStartSeconds,
    traceEndSeconds: input.layout.traceEndSeconds,
    contentTop: input.layout.contentTop,
    headerHeight: input.layout.headerHeight,
    groupHeaderHeight: input.layout.groupHeaderHeight,
    laneGap: input.layout.laneGap,
    groupOrder: THREAD_GROUP_ORDER,
    threads: orderedThreads.map((thread) => {
      return {
        threadId: thread.threadId,
        label: thread.label,
        isMain: thread.isMain,
        group: thread.group,
        totalRows: thread.totalRows,
        renderedSamples: thread.renderedSamples,
        depth: Math.max(1, thread.maxDepth),
        startTime: thread.startSeconds,
        endTime: thread.endSeconds,
        spans: thread.spans.map((span) => ({
          name: span.name,
          binary: span.binary || "unknown",
          source: formatSource(span),
          appFrame: span.appFrame,
          depth: span.depth,
          startTime: span.startTimeSeconds,
          endTime: span.endTimeSeconds,
          weightMs: span.weightMs,
          samples: span.endSample - span.startSample,
          color: span.color,
        })),
      };
    }),
  };

  return `<script type="application/json" id="trace-viewer-data">${escapeScriptJson(
    JSON.stringify(payload),
  )}</script>`;
}

function renderViewerScript(): string {
  return `<script>
(() => {
  const scroll = document.querySelector("[data-scroll]");
  const timeline = document.querySelector("[data-timeline]");
  const spacer = document.querySelector("[data-spacer]");
  const canvas = document.querySelector("[data-canvas]");
  const dataNode = document.getElementById("trace-viewer-data");
  if (!scroll || !timeline || !spacer || !canvas || !dataNode) {
    return;
  }

  const data = JSON.parse(dataNode.textContent || "{}");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    return;
  }

  const baseWidth = Number(timeline.dataset.baseWidth || timeline.offsetWidth || 1);
  const durationSeconds = Number(data.durationSeconds || timeline.dataset.durationSeconds || 10);
  const frameHeight = Number(data.frameHeight || 18);
  let timelineHeight = Number(data.timelineHeight || canvas.height || 1);
  let contentHeight = Math.max(240, timelineHeight - 153);
  const contentTop = Number(data.contentTop || 153);
  const headerHeight = Number(data.headerHeight || 22);
  const groupHeaderHeight = Number(data.groupHeaderHeight || 26);
  const laneGap = Number(data.laneGap || 10);
  const traceStartSeconds = Number(data.traceStartSeconds || 0);
  const rawEndSeconds = Number(data.traceEndSeconds || 0);
  const traceEndSeconds = rawEndSeconds > traceStartSeconds ? rawEndSeconds : traceStartSeconds + durationSeconds;
  const traceDurationSeconds = Math.max(0.001, traceEndSeconds - traceStartSeconds);

  const groupOrder = Array.isArray(data.groupOrder) ? data.groupOrder : ["main", "app", "other"];
  const groupLabels = { main: "Main thread", app: "App threads", other: "Other threads" };

  let spanKey = 0;
  const threads = (Array.isArray(data.threads) ? data.threads : []).map((thread) => {
    const spans = (Array.isArray(thread.spans) ? thread.spans : [])
      .map((span) => ({
        ...span,
        key: spanKey++,
        threadId: thread.threadId,
        threadLabel: thread.label,
        depth: Math.max(0, Number(span.depth || 0)),
        startTime: Number(span.startTime || 0),
        endTime: Number(span.endTime || 0),
      }))
      .filter((span) => span.endTime >= span.startTime);
    return {
      threadId: thread.threadId,
      label: thread.label || "Thread",
      isMain: thread.isMain === true,
      group: thread.group || (thread.isMain ? "main" : "other"),
      totalRows: Number(thread.totalRows || 0),
      renderedSamples: Number(thread.renderedSamples || spans.length),
      depth: Math.max(1, Number(thread.depth || 1)),
      headerTop: contentTop,
      flameTop: contentTop + headerHeight,
      spans,
      spansByDepth: buildDepthIndex(spans),
    };
  });

  // Group threads in the requested order, keeping only groups that exist.
  const groups = [];
  for (const groupId of groupOrder) {
    const members = threads.filter((thread) => thread.group === groupId);
    if (members.length > 0) {
      groups.push({ id: groupId, label: groupLabels[groupId] || groupId, threads: members });
    }
  }

  const collapsedGroups = new Set();
  const collapsedThreads = new Set();
  const selectedThreadIds = new Set(threads.map((thread) => thread.threadId));
  let threadFilterQuery = "";

  // Recomputes every band offset from the current collapse state so groups and
  // threads can fold without touching the underlying span data.
  function relayout() {
    let cursor = contentTop;
    for (const group of groups) {
      group.headerTop = cursor;
      group.visibleThreads = group.threads.filter((thread) => selectedThreadIds.has(thread.threadId));
      group.hidden = group.visibleThreads.length === 0;
      if (group.hidden) {
        for (const thread of group.threads) {
          thread.groupId = group.id;
          thread.hidden = true;
        }
        continue;
      }
      cursor += groupHeaderHeight;
      group.collapsed = collapsedGroups.has(group.id);
      for (const thread of group.threads) {
        thread.groupId = group.id;
        thread.hidden = group.collapsed || !selectedThreadIds.has(thread.threadId);
        if (group.collapsed) {
          continue;
        }
        if (!selectedThreadIds.has(thread.threadId)) {
          continue;
        }
        thread.headerTop = cursor;
        thread.flameTop = cursor + headerHeight;
        thread.collapsed = collapsedThreads.has(thread.threadId);
        const bodyHeight = thread.collapsed ? 0 : thread.depth * frameHeight;
        cursor = thread.flameTop + bodyHeight + laneGap;
      }
    }
    contentHeight = Math.max(240, cursor - contentTop);
    timelineHeight = contentTop + contentHeight + 8;
    spacer.style.minHeight = timelineHeight + "px";
  }

  const allSpans = threads.flatMap((thread) => thread.spans);
  const threadById = new Map(threads.map((thread) => [thread.threadId, thread]));
  const firstSpanByName = new Map();
  for (const span of allSpans) {
    if (!firstSpanByName.has(span.name)) {
      firstSpanByName.set(span.name, span);
    }
  }

  const zoomSlider = document.querySelector("[data-zoom-slider]");
  const zoomLabel = document.querySelector("[data-zoom-label]");
  const rangeLabel = document.querySelector("[data-range]");
  const miniWindow = document.querySelector("[data-mini-window]");
  const search = document.querySelector("[data-search]");
  const clearSearch = document.querySelector("[data-clear-search]");
  const searchStatus = document.querySelector("[data-search-status]");
  const threadFilterSearch = document.querySelector("[data-thread-filter-search]");
  const threadFilterList = document.querySelector("[data-thread-filter-list]");
  const threadFilterStatus = document.querySelector("[data-thread-filter-status]");
  const threadSelectAll = document.querySelector("[data-thread-select-all]");
  const threadClear = document.querySelector("[data-thread-clear]");
  const detailPanel = document.querySelector("[data-details-panel]");
  const detail = {
    name: document.querySelector("[data-detail-name]"),
    thread: document.querySelector("[data-detail-thread]"),
    binary: document.querySelector("[data-detail-binary]"),
    source: document.querySelector("[data-detail-source]"),
    samples: document.querySelector("[data-detail-samples]"),
    duration: document.querySelector("[data-detail-duration]"),
    time: document.querySelector("[data-detail-time]"),
    depth: document.querySelector("[data-detail-depth]"),
    note: document.querySelector("[data-detail-note]"),
  };
  const topRows = Array.from(document.querySelectorAll(".top-frame-row"));
  const minZoom = 0.01;
  const maxZoom = 512;
  let zoom = 1;
  let virtualWidth = Math.max(360, Math.round(baseWidth * zoom));
  let selectedFrame = null;
  let readoutFrame = 0;
  let drawFrame = 0;
  let interactionTimer = 0;
  let isInteracting = false;
  let hitFrames = [];
  let hitSet = null;
  let hitIndex = -1;
  let query = "";

  function escapeText(value) {
    return String(value || "").replace(/[&<>"']/g, (character) => {
      const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
      return entities[character] || character;
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatClock(seconds) {
    const safeSeconds = Math.max(0, seconds);
    const minutes = Math.floor(safeSeconds / 60);
    const rest = safeSeconds - minutes * 60;
    return String(minutes).padStart(2, "0") + ":" + rest.toFixed(3).padStart(6, "0");
  }

  function renderThreadFilter() {
    if (!threadFilterList) {
      return;
    }
    const normalizedQuery = threadFilterQuery.trim().toLowerCase();
    const parts = [];
    for (const group of groups) {
      const visibleItems = group.threads.filter((thread) => {
        if (!normalizedQuery) {
          return true;
        }
        return [
          thread.label,
          group.label,
          thread.threadId,
          String(thread.renderedSamples || 0),
        ].join(" ").toLowerCase().includes(normalizedQuery);
      });
      if (visibleItems.length === 0) {
        continue;
      }
      parts.push(
        '<div class="thread-filter-group">' +
          escapeText(group.label) +
          " (" +
          String(visibleItems.length) +
          ")" +
          "</div>",
      );
      for (const thread of visibleItems) {
        const checked = selectedThreadIds.has(thread.threadId) ? " checked" : "";
        parts.push(
          '<label class="thread-filter-item" title="' +
            escapeText(thread.label) +
            '">' +
            '<input type="checkbox" data-thread-filter-id="' +
            escapeText(thread.threadId) +
            '"' +
            checked +
            ">" +
            '<span class="thread-filter-name">' +
            escapeText(thread.label) +
            "</span>" +
            '<span class="thread-filter-meta">' +
            String(thread.renderedSamples || 0) +
            " samples</span>" +
            "</label>",
        );
      }
    }
    threadFilterList.innerHTML =
      parts.join("") ||
      '<div class="thread-filter-empty">No matching threads</div>';
    threadFilterList.querySelectorAll("[data-thread-filter-id]").forEach((input) => {
      input.addEventListener("change", () => {
        const threadId = input.getAttribute("data-thread-filter-id") || "";
        if (input.checked) {
          selectedThreadIds.add(threadId);
        } else {
          selectedThreadIds.delete(threadId);
        }
        applyThreadSelection();
      });
    });
    updateThreadFilterStatus();
  }

  function updateThreadFilterStatus() {
    if (!threadFilterStatus) {
      return;
    }
    threadFilterStatus.textContent =
      String(selectedThreadIds.size) + " / " + String(threads.length) + " shown";
  }

  function applyThreadSelection() {
    if (selectedFrame && isFrameHidden(selectedFrame)) {
      hideInspector();
    }
    relayout();
    setupCanvas();
    updateThreadFilterStatus();
    applySearch();
    scheduleReadout();
    scheduleDraw();
  }

  function buildDepthIndex(frames) {
    let maxDepth = 0;
    for (const frame of frames) {
      maxDepth = Math.max(maxDepth, frame.depth || 0);
    }
    const rows = Array.from({ length: maxDepth + 1 }, () => []);
    for (const frame of frames) {
      rows[frame.depth].push(frame);
    }
    for (const row of rows) {
      row.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
    }
    return rows;
  }

  function lowerBoundEndTime(row, time) {
    let low = 0;
    let high = row.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((row[mid].endTime || 0) < time) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  function timeToX(seconds, leftSeconds, xScale) {
    return (seconds - leftSeconds) * xScale;
  }

  function getVirtualWidth() {
    return virtualWidth;
  }

  function visibleTimeRange() {
    const width = getVirtualWidth();
    const viewportWidth = scroll.clientWidth || 1;
    const leftRatio = clamp(scroll.scrollLeft / width, 0, 1);
    const rightRatio = clamp((scroll.scrollLeft + viewportWidth) / width, 0, 1);
    return {
      leftSeconds: traceStartSeconds + leftRatio * traceDurationSeconds,
      rightSeconds: traceStartSeconds + rightRatio * traceDurationSeconds,
      viewportWidth,
    };
  }

  function setZoom(nextZoom, anchorRatio = 0.5) {
    const previousWidth = getVirtualWidth();
    zoom = clamp(nextZoom, minZoom, maxZoom);
    const nextWidth = Math.max(scroll.clientWidth || 360, Math.round(baseWidth * zoom));
    const viewportWidth = scroll.clientWidth || 1;
    const anchorX = scroll.scrollLeft + viewportWidth * anchorRatio;
    const anchorProgress = previousWidth > 0 ? anchorX / previousWidth : anchorRatio;

    virtualWidth = nextWidth;
    spacer.style.width = nextWidth + "px";
    spacer.style.minWidth = nextWidth + "px";
    scroll.scrollLeft = Math.max(0, anchorProgress * nextWidth - viewportWidth * anchorRatio);

    if (zoomSlider) {
      zoomSlider.value = String(Math.round(zoom * 100));
    }
    updateReadout();
    scheduleDraw();
  }

  function fitTimeline() {
    const viewportWidth = scroll.clientWidth || baseWidth;
    setZoom(clamp(viewportWidth / baseWidth, minZoom, maxZoom), 0);
    scroll.scrollLeft = 0;
    updateReadout();
  }

  function updateReadout() {
    const width = getVirtualWidth();
    const viewportWidth = scroll.clientWidth || 1;
    const leftRatio = clamp(scroll.scrollLeft / width, 0, 1);
    const rightRatio = clamp((scroll.scrollLeft + viewportWidth) / width, 0, 1);

    if (zoomLabel) {
      zoomLabel.textContent = Math.round(zoom * 100) + "%";
    }
    if (rangeLabel) {
      rangeLabel.textContent =
        formatClock(traceStartSeconds + leftRatio * traceDurationSeconds) +
        " - " +
        formatClock(traceStartSeconds + rightRatio * traceDurationSeconds);
    }
    if (miniWindow) {
      miniWindow.style.left = (leftRatio * 100).toFixed(2) + "%";
      miniWindow.style.width = Math.max(2, (rightRatio - leftRatio) * 100).toFixed(2) + "%";
    }
  }

  function scheduleReadout() {
    if (readoutFrame) {
      return;
    }
    readoutFrame = requestAnimationFrame(() => {
      readoutFrame = 0;
      updateReadout();
    });
  }

  function showInspector() {
    if (detailPanel) {
      detailPanel.hidden = false;
    }
  }

  function hideInspector() {
    selectedFrame = null;
    if (detailPanel) {
      detailPanel.hidden = true;
    }
    topRows.forEach((row) => row.classList.remove("selected"));
    scheduleDraw();
  }

  function selectFrame(frame) {
    selectedFrame = frame;
    showInspector();

    const startSeconds = Number(frame.startTime || 0);
    const endSeconds = Math.max(startSeconds, Number(frame.endTime || startSeconds));
    const wallMs = Math.max(0, endSeconds - startSeconds) * 1000;
    const weightMs = Math.max(0, Number(frame.weightMs || 0));

    if (detail.name) detail.name.textContent = frame.name || "";
    if (detail.thread) detail.thread.textContent = frame.threadLabel || "";
    if (detail.binary) detail.binary.textContent = frame.binary || "";
    if (detail.source) detail.source.textContent = frame.source || "-";
    if (detail.samples) detail.samples.textContent = String(Math.max(0, Number(frame.samples || 0)));
    if (detail.duration) {
      detail.duration.textContent =
        formatMilliseconds(weightMs) + " sampled, " + formatMilliseconds(wallMs) + " wall";
    }
    if (detail.time) detail.time.textContent = formatClock(startSeconds) + " - " + formatClock(endSeconds);
    if (detail.depth) detail.depth.textContent = String(frame.depth || 0);
    if (detail.note) {
      const note = frameNote(frame);
      detail.note.textContent = note;
      detail.note.hidden = !note;
    }

    topRows.forEach((row) => {
      row.classList.toggle("selected", row.dataset.frameName === frame.name);
    });
    scheduleDraw();
  }

  function scrollToFrame(frame) {
    const owner = threadById.get(frame.threadId);
    if (owner) {
      let changed = false;
      if (!selectedThreadIds.has(owner.threadId)) {
        selectedThreadIds.add(owner.threadId);
        renderThreadFilter();
        changed = true;
      }
      if (collapsedGroups.has(owner.group)) {
        collapsedGroups.delete(owner.group);
        changed = true;
      }
      if (collapsedThreads.has(owner.threadId)) {
        collapsedThreads.delete(owner.threadId);
        changed = true;
      }
      if (changed) {
        relayout();
      }
    }
    const centerSeconds = (Number(frame.startTime || 0) + Number(frame.endTime || 0)) / 2;
    const centerRatio = clamp((centerSeconds - traceStartSeconds) / traceDurationSeconds, 0, 1);
    const width = getVirtualWidth();
    scroll.scrollLeft = Math.max(0, centerRatio * width - (scroll.clientWidth || 1) / 2);
    const flameTop = owner ? owner.flameTop : contentTop;
    const frameY = flameTop + Number(frame.depth || 0) * frameHeight;
    const viewportHeight = scroll.clientHeight || timelineHeight;
    if (frameY < scroll.scrollTop || frameY + frameHeight > scroll.scrollTop + viewportHeight) {
      scroll.scrollTop = clamp(frameY - viewportHeight / 2, 0, Math.max(0, timelineHeight - viewportHeight));
    }
    scheduleReadout();
    scheduleDraw();
  }

  function applySearch() {
    query = (search?.value || "").trim().toLowerCase();
    hitFrames = [];
    hitSet = null;
    hitIndex = -1;
    if (!query) {
      updateSearchStatus();
      topRows.forEach((row) => row.classList.remove("selected"));
      scheduleDraw();
      return;
    }

    for (const frame of allSpans) {
      if (isFrameHidden(frame)) {
        continue;
      }
      const text = [
        frame.name,
        frame.binary,
        frame.source,
        frame.threadLabel,
      ].join(" ").toLowerCase();
      if (text.includes(query)) {
        hitFrames.push(frame);
      }
    }
    hitFrames.sort((left, right) =>
      Number(left.startTime || 0) - Number(right.startTime || 0) ||
      Number(left.depth || 0) - Number(right.depth || 0) ||
      String(left.name || "").localeCompare(String(right.name || "")),
    );
    hitSet = new Set(hitFrames);

    if (hitFrames.length > 0) {
      activateSearchHit(0);
    } else {
      updateSearchStatus();
    }
    scheduleDraw();
  }

  function clearSearchQuery() {
    if (search) {
      search.value = "";
    }
    query = "";
    hitFrames = [];
    hitSet = null;
    hitIndex = -1;
    updateSearchStatus();
    scheduleDraw();
  }

  function activateSearchHit(index) {
    if (hitFrames.length === 0) {
      hitIndex = -1;
      updateSearchStatus();
      return;
    }
    hitIndex = ((index % hitFrames.length) + hitFrames.length) % hitFrames.length;
    const frame = hitFrames[hitIndex];
    scrollToFrame(frame);
    selectFrame(frame);
    updateSearchStatus();
  }

  function updateSearchStatus() {
    if (!searchStatus) {
      return;
    }
    if (!query) {
      searchStatus.textContent = "";
      return;
    }
    if (hitFrames.length === 0) {
      searchStatus.textContent = "0 matches";
      return;
    }
    searchStatus.textContent = String(hitIndex + 1) + " / " + String(hitFrames.length);
  }

  function scheduleDraw() {
    if (drawFrame) {
      return;
    }
    drawFrame = requestAnimationFrame(() => {
      drawFrame = 0;
      draw();
    });
  }

  function markInteracting() {
    isInteracting = true;
    if (interactionTimer) {
      window.clearTimeout(interactionTimer);
    }
    interactionTimer = window.setTimeout(() => {
      isInteracting = false;
      scheduleDraw();
    }, 110);
    scheduleDraw();
  }

  function setupCanvas() {
    const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssWidth = Math.max(1, scroll.clientWidth || baseWidth);
    const cssHeight = Math.max(1, Math.min(timelineHeight, scroll.clientHeight || timelineHeight));
    positionViewportCanvas(cssWidth, cssHeight);
    canvas.style.width = cssWidth + "px";
    canvas.style.height = cssHeight + "px";
    canvas.width = Math.max(1, Math.floor(cssWidth * pixelRatio));
    canvas.height = Math.max(1, Math.floor(cssHeight * pixelRatio));
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    if (virtualWidth < cssWidth) {
      virtualWidth = cssWidth;
      spacer.style.width = cssWidth + "px";
      spacer.style.minWidth = cssWidth + "px";
    }
  }

  function positionViewportCanvas(width = scroll.clientWidth || baseWidth, height = scroll.clientHeight || timelineHeight) {
    timeline.style.left = scroll.scrollLeft + "px";
    timeline.style.top = scroll.scrollTop + "px";
    timeline.style.width = Math.max(1, width) + "px";
    timeline.style.height = Math.max(1, Math.min(timelineHeight, height)) + "px";
  }

  function draw() {
    const viewportWidth = scroll.clientWidth || baseWidth;
    const viewportHeight = canvas.clientHeight || scroll.clientHeight || timelineHeight;
    const { leftSeconds, rightSeconds } = visibleTimeRange();
    const topY = scroll.scrollTop || 0;
    const bottomY = topY + viewportHeight;
    const secondsWindow = Math.max(0.000001, rightSeconds - leftSeconds);
    const xScale = viewportWidth / secondsWindow;
    const fast = isInteracting;

    positionViewportCanvas(viewportWidth, viewportHeight);
    context.save();
    context.clearRect(0, 0, viewportWidth, viewportHeight);
    drawOverview(leftSeconds, rightSeconds, viewportWidth, topY, viewportHeight, fast);
    drawTicks(leftSeconds, rightSeconds, viewportWidth, topY, viewportHeight);
    drawProcessTrack(viewportWidth, topY, viewportHeight);

    for (const group of groups) {
      if (group.hidden) {
        continue;
      }
      drawGroupHeader(group, topY, bottomY, viewportWidth);
      if (group.collapsed) {
        continue;
      }
      for (const thread of group.threads) {
        if (thread.hidden) {
          continue;
        }
        drawThreadBand(thread, leftSeconds, rightSeconds, topY, bottomY, xScale, viewportWidth, fast);
      }
    }

    if (selectedFrame && !isFrameHidden(selectedFrame)) {
      const owner = threadById.get(selectedFrame.threadId);
      const flameTop = owner ? owner.flameTop : contentTop;
      const x = timeToX(selectedFrame.startTime, leftSeconds, xScale);
      const width = Math.max(2, (selectedFrame.endTime - selectedFrame.startTime) * xScale);
      const y = flameTop + selectedFrame.depth * frameHeight - topY;
      if (y + frameHeight >= 0 && y <= viewportHeight) {
        context.strokeStyle = "#111827";
        context.lineWidth = 2;
        context.strokeRect(x + 1, y + 1, Math.max(1, width - 2), frameHeight - 4);
      }
    }
    context.restore();
  }

  function isFrameHidden(frame) {
    const owner = threadById.get(frame.threadId);
    return !owner || owner.hidden || owner.collapsed;
  }

  function drawGroupHeader(group, topY, bottomY, viewportWidth) {
    const viewportHeight = bottomY - topY;
    const y = group.headerTop - topY;
    if (y + groupHeaderHeight < 0 || y > viewportHeight) {
      return;
    }
    context.fillStyle = "#0f1722";
    context.fillRect(0, y, viewportWidth, groupHeaderHeight);
    context.fillStyle = "#f0f3f8";
    context.font = "700 12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    context.textBaseline = "middle";
    context.textAlign = "left";
    const chevron = group.collapsed ? "\u25B6" : "\u25BC";
    const shown = group.visibleThreads ? group.visibleThreads.length : group.threads.length;
    const label = chevron + "  " + group.label + "  (" + shown + "/" + group.threads.length + ")";
    context.fillText(label, 8, y + groupHeaderHeight / 2);
  }

  function drawThreadBand(thread, leftSeconds, rightSeconds, topY, bottomY, xScale, viewportWidth, fast) {
    const viewportHeight = bottomY - topY;
    const headerY = thread.headerTop - topY;
    const bodyHeight = thread.collapsed ? 0 : thread.depth * frameHeight;
    const bandBottom = thread.flameTop + bodyHeight - topY;
    if (bandBottom < 0 || headerY > bottomY) {
      return;
    }

    if (headerY + headerHeight >= 0 && headerY <= viewportHeight) {
      context.fillStyle = thread.isMain ? "#1f6feb" : "#3a4553";
      context.fillRect(0, headerY, viewportWidth, headerHeight);
      context.fillStyle = "#ffffff";
      context.font = "600 11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
      context.textBaseline = "middle";
      context.textAlign = "left";
      const chevron = thread.collapsed ? "\u25B6" : "\u25BC";
      const label = chevron + "  " + thread.label + "  ·  " + thread.renderedSamples + " samples";
      context.fillText(label, 20, headerY + headerHeight / 2);
    }

    if (thread.collapsed) {
      return;
    }

    for (const span of thread.spans) {
      if (span.endTime < leftSeconds || span.startTime > rightSeconds) {
        continue;
      }
      const y = thread.flameTop + span.depth * frameHeight - topY;
      if (y + frameHeight < 0 || y > viewportHeight) {
        continue;
      }
      const x = timeToX(span.startTime, leftSeconds, xScale);
      const width = Math.max(1, (span.endTime - span.startTime) * xScale);
      if (fast && width < 0.8 && !span.appFrame && selectedFrame !== span) {
        continue;
      }
      const isSearchDimmed = Boolean(hitSet && !hitSet.has(span));
      drawFrameFill(span, x, y, width, frameHeight - 1, !isSearchDimmed, fast);
      drawFrameLabel(span, x, y, width, frameHeight - 1, fast);
    }
  }

  function drawOverview(leftSeconds, rightSeconds, viewportWidth, topY, viewportHeight, fast) {
    void leftSeconds;
    void rightSeconds;
    void fast;
    const yBase = -topY;
    if (yBase > viewportHeight || yBase + 52 < 0) {
      return;
    }
    const gradient = context.createLinearGradient(0, 0, 0, 52);
    gradient.addColorStop(0, "#fafafa");
    gradient.addColorStop(1, "#f1f1ef");
    context.fillStyle = gradient;
    context.fillRect(0, yBase, viewportWidth, 52);
    context.globalAlpha = 1;
    context.strokeStyle = "#d8dce1";
    context.beginPath();
    context.moveTo(0, yBase + 52.5);
    context.lineTo(viewportWidth, yBase + 52.5);
    context.stroke();
  }

  function drawTicks(leftSeconds, rightSeconds, viewportWidth, topY, viewportHeight) {
    const yBase = 52 - topY;
    if (yBase > viewportHeight || yBase + 70 < 0) {
      return;
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, yBase, viewportWidth, 70);
    context.strokeStyle = "#cfd3d8";
    context.fillStyle = "#737b86";
    context.font = "11px SFMono-Regular, Consolas, Liberation Mono, monospace";
    context.textAlign = "center";
    context.textBaseline = "top";
    for (let index = 0; index <= 10; index += 1) {
      const x = (index / 10) * viewportWidth;
      const seconds = leftSeconds + (index / 10) * (rightSeconds - leftSeconds);
      context.beginPath();
      context.moveTo(x + 0.5, yBase);
      context.lineTo(x + 0.5, yBase + 70);
      context.stroke();
      context.fillText(formatShortTime(seconds), x, yBase + 8);
    }
    context.strokeStyle = "#d8dce1";
    context.beginPath();
    context.moveTo(0, yBase + 70.5);
    context.lineTo(viewportWidth, yBase + 70.5);
    context.stroke();
  }

  function drawProcessTrack(viewportWidth, topY, viewportHeight) {
    const yBase = 122 - topY;
    if (yBase > viewportHeight || yBase + 31 < 0) {
      return;
    }
    context.fillStyle = "#202c3a";
    context.fillRect(0, yBase, viewportWidth, 31);
    context.strokeStyle = "#101721";
    context.beginPath();
    context.moveTo(0, yBase + 30.5);
    context.lineTo(viewportWidth, yBase + 30.5);
    context.stroke();
  }

  function drawFrameFill(frame, x, y, width, height, searchVisible, fast) {
    context.globalAlpha = searchVisible ? 1 : 0.16;
    context.fillStyle = frame.color || (frame.appFrame ? "#2f9e73" : "#d2d7dd");
    const drawX = Math.round(x);
    const drawY = Math.round(y);
    const drawWidth = Math.max(1, Math.ceil(width));
    context.fillRect(drawX, drawY, drawWidth, height);
    if (drawWidth > (fast ? 8 : 3)) {
      context.strokeStyle = "rgba(255,255,255,0.72)";
      context.strokeRect(drawX + 0.5, drawY + 0.5, Math.max(1, drawWidth - 1), Math.max(1, height - 1));
    }
    if (query && searchVisible) {
      context.strokeStyle = "#f6d75c";
      context.lineWidth = 2;
      context.strokeRect(drawX + 1, drawY + 1, Math.max(1, drawWidth - 2), Math.max(1, height - 2));
      context.lineWidth = 1;
    }
    context.globalAlpha = 1;
  }

  function drawFrameLabel(frame, x, y, width, height, fast) {
    const drawX = Math.round(x);
    const drawY = Math.round(y);
    const drawWidth = Math.max(1, Math.ceil(width));
    if (drawWidth > (fast ? 92 : 52)) {
      context.save();
      context.beginPath();
      context.rect(drawX + 2, drawY, Math.max(1, drawWidth - 4), height);
      context.clip();
      context.fillStyle = frame.appFrame ? "#ffffff" : "#18202a";
      context.font = "11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
      context.textBaseline = "middle";
      context.textAlign = "left";
      context.fillText(shortText(frame.name || "", Math.floor(drawWidth / 7)), drawX + 5, drawY + height / 2);
      context.restore();
    }
  }

  function frameAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = scroll.scrollTop + clientY - rect.top;
    const { leftSeconds, rightSeconds } = visibleTimeRange();
    const seconds = leftSeconds + (x / Math.max(1, rect.width)) * Math.max(0.000001, rightSeconds - leftSeconds);

    for (const thread of threads) {
      if (thread.hidden || thread.collapsed) {
        continue;
      }
      const relative = y - thread.flameTop;
      if (relative < 0) {
        continue;
      }
      const depth = Math.floor(relative / frameHeight);
      if (depth < 0 || depth >= thread.spansByDepth.length) {
        continue;
      }
      const row = thread.spansByDepth[depth] || [];
      let index = lowerBoundEndTime(row, seconds);
      let best = null;
      while (index < row.length) {
        const span = row[index];
        if (span.startTime > seconds) {
          break;
        }
        if (span.startTime <= seconds && span.endTime >= seconds) {
          if (!best || span.endTime - span.startTime < best.endTime - best.startTime) {
            best = span;
          }
        }
        index += 1;
      }
      if (best) {
        return best;
      }
    }
    return null;
  }

  function headerAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const y = scroll.scrollTop + (clientY - rect.top);
    void clientX;
    for (const group of groups) {
      if (group.hidden) {
        continue;
      }
      if (y >= group.headerTop && y < group.headerTop + groupHeaderHeight) {
        return { type: "group", id: group.id };
      }
      if (group.collapsed) {
        continue;
      }
      for (const thread of group.threads) {
        if (thread.hidden) {
          continue;
        }
        if (y >= thread.headerTop && y < thread.headerTop + headerHeight) {
          return { type: "thread", id: thread.threadId };
        }
      }
    }
    return null;
  }

  function toggleGroup(groupId) {
    if (collapsedGroups.has(groupId)) {
      collapsedGroups.delete(groupId);
    } else {
      collapsedGroups.add(groupId);
    }
    relayout();
    scheduleReadout();
    scheduleDraw();
  }

  function toggleThread(threadId) {
    if (collapsedThreads.has(threadId)) {
      collapsedThreads.delete(threadId);
    } else {
      collapsedThreads.add(threadId);
    }
    relayout();
    scheduleReadout();
    scheduleDraw();
  }

  function setAllCollapsed(collapsed) {
    collapsedGroups.clear();
    collapsedThreads.clear();
    if (collapsed) {
      for (const group of groups) {
        for (const thread of group.threads) {
          collapsedThreads.add(thread.threadId);
        }
      }
    }
    relayout();
    scheduleReadout();
    scheduleDraw();
  }

  function shortText(value, maxLength) {
    if (maxLength <= 3) return "";
    return value.length <= maxLength ? value : value.slice(0, maxLength - 3) + "...";
  }

  function formatShortTime(seconds) {
    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;
    const millis = Math.round((seconds - whole) * 1000);
    return String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0") + "." + String(millis).padStart(3, "0");
  }

  function formatMilliseconds(value) {
    if (value >= 1000) {
      return (value / 1000).toFixed(3) + " s (" + Math.round(value) + " ms)";
    }
    if (value >= 10) {
      return value.toFixed(1) + " ms";
    }
    return value.toFixed(2) + " ms";
  }

  function frameNote(frame) {
    const name = frame.name || "";
    if (name === "main") {
      return "Entry frame from main.m. It can appear in multiple sampled spans when the stack between those samples is interrupted or changes.";
    }
    if (name === "flow_main" || name === "flow_main()") {
      return "App entry wrapper below main. The plain symbol and Swift function symbol are distinct frames from the original Instruments stack.";
    }
    return "";
  }

  document.querySelector("[data-zoom-in]")?.addEventListener("click", () => setZoom(zoom * 1.35));
  document.querySelector("[data-zoom-out]")?.addEventListener("click", () => setZoom(zoom / 1.35));
  document.querySelector("[data-fit]")?.addEventListener("click", fitTimeline);
  document.querySelector("[data-reset]")?.addEventListener("click", () => setZoom(1));

  zoomSlider?.addEventListener("input", () => {
    setZoom(Number(zoomSlider.value || 100) / 100);
    markInteracting();
  });

  search?.addEventListener("input", applySearch);
  search?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || hitFrames.length === 0) {
      return;
    }
    event.preventDefault();
    activateSearchHit(hitIndex + (event.shiftKey ? -1 : 1));
  });
  clearSearch?.addEventListener("click", clearSearchQuery);
  threadFilterSearch?.addEventListener("input", () => {
    threadFilterQuery = threadFilterSearch.value || "";
    renderThreadFilter();
  });
  threadSelectAll?.addEventListener("click", () => {
    for (const thread of threads) {
      selectedThreadIds.add(thread.threadId);
    }
    renderThreadFilter();
    applyThreadSelection();
  });
  threadClear?.addEventListener("click", () => {
    selectedThreadIds.clear();
    renderThreadFilter();
    applyThreadSelection();
  });
  scroll.addEventListener("scroll", () => {
    markInteracting();
    scheduleReadout();
  }, { passive: true });
  window.addEventListener("resize", () => {
    setupCanvas();
    scheduleReadout();
    scheduleDraw();
  });
  scroll.addEventListener(
    "wheel",
    (event) => {
      if (!event.metaKey && !event.ctrlKey) {
        return;
      }
      event.preventDefault();
      const rect = scroll.getBoundingClientRect();
      const anchorRatio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
      setZoom(zoom * (event.deltaY < 0 ? 1.18 : 1 / 1.18), anchorRatio);
      markInteracting();
    },
    { passive: false },
  );

  canvas.addEventListener("click", (event) => {
    const header = headerAt(event.clientX, event.clientY);
    if (header) {
      if (header.type === "group") {
        toggleGroup(header.id);
      } else {
        toggleThread(header.id);
      }
      return;
    }
    const frame = frameAt(event.clientX, event.clientY);
    if (frame) {
      selectFrame(frame);
    } else {
      hideInspector();
    }
  });

  document.querySelector("[data-expand-all]")?.addEventListener("click", () => setAllCollapsed(false));
  document.querySelector("[data-collapse-all]")?.addEventListener("click", () => setAllCollapsed(true));

  topRows.forEach((row) => {
    row.addEventListener("click", () => {
      const target = firstSpanByName.get(row.dataset.frameName);
      if (target) {
        scrollToFrame(target);
        selectFrame(target);
      }
    });
  });

  relayout();
  renderThreadFilter();
  setupCanvas();
  fitTimeline();
})();
</script>`;
}

function renderCollectionDiagnostics(
  input: RenderLaunchTraceHtmlInput,
): string {
  const exportDiagnostics = Object.entries(input.summary.export_attempts ?? {})
    .flatMap(([label, attempts]) =>
      attempts.map((attempt) =>
        [
          `${label} export attempt ${attempt.attempt ?? "?"}: returncode ${attempt.returncode ?? "?"}`,
          attempt.stdout_path ? `stdout: ${attempt.stdout_path}` : "",
          attempt.stderr_path ? `stderr: ${attempt.stderr_path}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    )
    .join("\n\n");
  const diagnostics = [
    input.summary.error ? `error: ${input.summary.error}` : "",
    input.summary.message ? `message: ${input.summary.message}` : "",
    input.summary.trace_settle
      ? `trace settled: ${input.summary.trace_settle.settled === true ? "yes" : "no"}`
      : "",
    input.summary.recovery_note
      ? `recovery: ${input.summary.recovery_note}`
      : "",
    exportDiagnostics,
    input.stdoutTail ? `stdout tail:\n${input.stdoutTail}` : "",
    input.stderrTail ? `stderr tail:\n${input.stderrTail}` : "",
  ].filter(Boolean);

  if (diagnostics.length === 0) {
    return "";
  }

  return `<section class="band diagnostics"><h2>Collection Diagnostics</h2><pre>${escapeHtml(diagnostics.join("\n\n"))}</pre></section>`;
}

function parseTimeLimitFromCommand(command: readonly string[]): number | null {
  const index = command.indexOf("--time-limit");
  const value = index >= 0 ? command[index + 1] : undefined;
  return parseTimeLimitSeconds(value);
}

function parseTimeLimitSeconds(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m)?$/u.exec(value.trim());
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  if (unit === "ms") {
    return amount / 1000;
  }
  if (unit === "m") {
    return amount * 60;
  }
  return amount;
}

function formatTime(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function statusClass(status: string): string {
  if (status === "ready" || status === "partial" || status === "missing") {
    return status;
  }
  return "unknown";
}

function emptyTimeline(warnings: string[]): ParsedTraceTimeline {
  return {
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
    warnings,
  };
}

function sameFrame(left: TraceFrame, right: TraceFrame): boolean {
  return frameIdentity(left) === frameIdentity(right);
}

function frameIdentity(frame: TraceFrame): string {
  return [frame.name, frame.binary, frame.sourcePath, frame.line].join(
    "\u0000",
  );
}

const APP_COLORS = [
  "#2f9e73",
  "#c44936",
  "#3c8dbc",
  "#a567c9",
  "#d58b2a",
  "#1d8f99",
  "#c43f83",
  "#5d7fe5",
  "#7d9635",
  "#b35b45",
];
const SYSTEM_COLORS = [
  "#d2d7dd",
  "#b7bec8",
  "#9aa3ad",
  "#c8c3b8",
  "#aeb8b0",
  "#d7cfc5",
];

function frameColor(frame: TraceFrame): string {
  const palette = frame.appFrame ? APP_COLORS : SYSTEM_COLORS;
  const index = hashText(frameIdentity(frame)) % palette.length;
  return palette[index] ?? "#8b95a1";
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function formatSource(frame: TraceFrame): string {
  if (!frame.sourcePath) {
    return "";
  }
  const line = frame.line ? `:${frame.line}` : "";
  return `${frame.sourcePath}${line}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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
    throw new TypeError(`iOS Launch Trace requires ${name}.`);
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return false;
    }
    throw cause;
  }
}

function isNotFoundError(value: unknown): boolean {
  return value instanceof Error && "code" in value && value.code === "ENOENT";
}

function tail(value: string): string {
  return value.slice(-OUTPUT_TAIL_LENGTH);
}

function formatError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value: string | number | null | undefined): string {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}

function escapeScriptJson(value: string): string {
  return value
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

const PYTHON_SYMBOL_RECOVERY = String.raw`
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

xml_path = Path(sys.argv[1])
symbol_root = Path(sys.argv[2])
primary_dsym = Path(sys.argv[3])
target_binary = sys.argv[4]
business_binary = sys.argv[5]
raw_address = re.compile(r"0x[0-9a-fA-F]+")
target_names = {target_binary, target_binary + ".debug.dylib", business_binary}
tree = ET.parse(xml_path)
root = tree.getroot()

def tag_name(element):
    return element.tag.rsplit("}", 1)[-1]

def child(element, name):
    if element is None:
        return None
    for item in list(element):
        if tag_name(item) == name:
            return item
    return None

definitions = {}
for element in root.iter():
    element_id = element.get("id")
    if element_id:
        definitions[(tag_name(element), element_id)] = element

def resolve_ref(element):
    seen = set()
    while element is not None and element.get("ref"):
        key = (tag_name(element), element.get("ref"))
        if key in seen or key not in definitions:
            return None
        seen.add(key)
        element = definitions[key]
    return element

binary_definitions = {}
for element in root.iter():
    if tag_name(element) == "binary" and element.get("id"):
        binary_definitions[element.get("id")] = element

def binary_info(binary):
    if binary is None:
        return None
    resolved = binary_definitions.get(binary.get("ref"), binary)
    return {
        "name": binary.get("name") or resolved.get("name") or "",
        "uuid": (binary.get("UUID") or resolved.get("UUID") or "").upper(),
        "load_addr": binary.get("load-addr") or resolved.get("load-addr") or "",
    }

def source_info(frame):
    source = resolve_ref(child(frame, "source"))
    if source is None:
        return "", ""
    line = source.get("line") or ""
    path = child(source, "path")
    if path is None:
        return "", line
    resolved = resolve_ref(path)
    return ((resolved.text or "") if resolved is not None else ""), line

def run(command):
    return subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def dwarf_images():
    bundles = set()
    for base in (symbol_root, primary_dsym):
        if base.name.endswith(".dSYM") and base.exists():
            bundles.add(base)
        if base.is_dir():
            bundles.update(base.rglob("*.dSYM"))
    images = {}
    symbols = {}
    for bundle in sorted(bundles):
        dwarf_dir = bundle / "Contents" / "Resources" / "DWARF"
        if not dwarf_dir.is_dir():
            continue
        for dwarf in sorted(dwarf_dir.iterdir()):
            if not dwarf.is_file():
                continue
            result = run(["dwarfdump", "--uuid", str(dwarf)])
            if result.returncode != 0:
                continue
            for match in re.finditer(r"UUID:\s+([0-9A-Fa-f-]+)\s+\(arm64\)", result.stdout):
                uuid = match.group(1).upper()
                images.setdefault(uuid, dwarf)
                symbols.setdefault(dwarf.name, []).append(uuid)
    return images, {name: sorted(set(uuids)) for name, uuids in symbols.items()}

uuid_images, symbol_uuids = dwarf_images()

def parse_atos(line):
    text = (line or "").strip()
    if not text or raw_address.fullmatch(text):
        return None
    match = re.match(r"^(.*) \(in [^)]+\)(?: \((.+):(\d+)\))?\s*$", text)
    if not match or raw_address.fullmatch(match.group(1).strip()):
        return None
    return match.group(1).strip(), match.group(2), match.group(3)

def atos(dwarf, load_addr, addresses):
    output = []
    for start in range(0, len(addresses), 8000):
        chunk = addresses[start:start + 8000]
        result = run(["atos", "-o", str(dwarf), "-arch", "arm64", "-l", load_addr, *chunk])
        if result.returncode != 0:
            return None
        output.extend(result.stdout.splitlines())
    return output if len(output) == len(addresses) else None

def add_source(frame, source_file, source_line):
    if not source_file or not source_line:
        return
    existing = child(frame, "source")
    if existing is not None:
        frame.remove(existing)
    source = ET.SubElement(frame, "source")
    source.set("line", source_line)
    path = ET.SubElement(source, "path")
    path.text = source_file

def mapped_backfill():
    groups = {}
    for frame in root.iter():
        if tag_name(frame) != "frame" or not raw_address.fullmatch(frame.get("name", "")):
            continue
        info = binary_info(child(frame, "binary"))
        if not info or not info["uuid"] or not info["load_addr"]:
            continue
        if info["uuid"] not in uuid_images:
            continue
        groups.setdefault((info["uuid"], info["load_addr"]), []).append(frame)
    resolved = 0
    images = {}
    for (uuid, load_addr), frames in groups.items():
        addresses = list(dict.fromkeys(frame.get("name") for frame in frames))
        results = atos(uuid_images[uuid], load_addr, addresses)
        if results is None:
            continue
        parsed = dict(zip(addresses, map(parse_atos, results)))
        image_count = 0
        for frame in frames:
            value = parsed.get(frame.get("name"))
            if value is None:
                continue
            frame.set("name", value[0])
            add_source(frame, value[1], value[2])
            image_count += 1
        if image_count:
            images[uuid] = image_count
            resolved += image_count
    return resolved, images

def text_vmaddr(dwarf):
    result = run(["otool", "-arch", "arm64", "-l", str(dwarf)])
    if result.returncode != 0:
        return None
    waiting = False
    for raw_line in result.stdout.splitlines():
        line = raw_line.strip()
        if line == "sectname __text":
            waiting = True
        elif waiting and line.startswith("addr " ):
            try:
                return int(line.split(None, 1)[1], 16)
            except ValueError:
                return None
    return None

def infer_debug_image():
    debug_name = target_binary + ".debug.dylib"
    candidates = [(uuid, path) for uuid, path in uuid_images.items() if path.name == debug_name]
    if len(candidates) != 1:
        return None
    debug_uuid, dwarf = candidates[0]
    raw_frames = []
    for frame in root.iter():
        if tag_name(frame) != "frame" or child(frame, "binary") is not None:
            continue
        name = frame.get("name", "")
        if raw_address.fullmatch(name):
            raw_frames.append((int(name, 16), frame, name))
    if len(raw_frames) < 20:
        return None
    blocks = {}
    for address, frame, name in raw_frames:
        blocks.setdefault(address & ~((1 << 32) - 1), []).append((frame, name))
    vmaddr = text_vmaddr(dwarf)
    if vmaddr is None:
        return None
    matches = []
    for items in blocks.values():
        if len(items) < 20:
            continue
        addresses = sorted(set(name for _, name in items), key=lambda value: int(value, 16))
        load_addr = hex((int(addresses[0], 16) & ~((1 << 14) - 1)) - vmaddr)
        first = atos(dwarf, load_addr, addresses[:1])
        if not first or not first[0].startswith("__debug_main_executable_dylib_entry_point "):
            continue
        probe = addresses
        if len(probe) > 200:
            probe = [probe[round(index * (len(probe) - 1) / 199)] for index in range(200)]
        probe_result = atos(dwarf, load_addr, probe)
        if not probe_result:
            continue
        ratio = sum(parse_atos(line) is not None for line in probe_result) / len(probe_result)
        if ratio >= 0.90:
            matches.append((items, addresses, load_addr, ratio))
    if len(matches) != 1:
        return None
    items, addresses, load_addr, ratio = matches[0]
    results = atos(dwarf, load_addr, addresses)
    if results is None:
        return None
    parsed = dict(zip(addresses, map(parse_atos, results)))
    resolved = 0
    for frame, address in items:
        value = parsed.get(address)
        if value is None:
            continue
        frame.set("name", value[0])
        binary = ET.SubElement(frame, "binary")
        binary.set("name", debug_name)
        binary.set("UUID", debug_uuid)
        binary.set("load-addr", load_addr)
        add_source(frame, value[1], value[2])
        resolved += 1
    return {
        "uuid": debug_uuid,
        "load_addr": load_addr,
        "candidate_frames": len(items),
        "resolved_frames": resolved,
        "validation_ratio": round(ratio, 4),
    } if resolved else None

def coverage():
    target_uuids = {}
    source_rows_by_binary = {}
    main_thread_ids = set()
    main_rows = 0
    app_rows = 0
    source_rows = 0
    unresolved_rows = 0
    unmapped_rows = 0
    samples = []
    for row in root.iter():
        if tag_name(row) != "row":
            continue
        thread = resolve_ref(child(row, "thread"))
        if thread is None:
            continue
        thread_id = thread.get("id") or thread.get("ref") or ""
        fmt = thread.get("fmt") or ""
        if "Main Thread" in fmt and thread_id:
            main_thread_ids.add(thread_id)
        if "Main Thread" not in fmt and thread_id not in main_thread_ids:
            continue
        main_rows += 1
        row_app = False
        row_source = False
        row_raw = False
        row_unmapped = False
        source_images = set()
        backtrace = resolve_ref(child(row, "backtrace"))
        if backtrace is None:
            continue
        for item in backtrace.iter():
            if tag_name(item) != "frame":
                continue
            frame = resolve_ref(item)
            if frame is None:
                continue
            frame_name = frame.get("name", "")
            binary = child(frame, "binary")
            info = binary_info(binary)
            if raw_address.fullmatch(frame_name):
                row_raw = True
                row_unmapped = row_unmapped or info is None
            if not info or info["name"] not in target_names:
                continue
            row_app = True
            if info["uuid"]:
                target_uuids.setdefault(info["name"], info["uuid"])
            source_path, source_line = source_info(frame)
            if source_path and source_line and source_line != "0":
                row_source = True
                source_images.add(info["name"])
                if len(samples) < 12:
                    samples.append({
                        "name": frame_name,
                        "source_path": source_path,
                        "line": source_line,
                        "uuid": info["uuid"],
                    })
        app_rows += int(row_app)
        source_rows += int(row_source)
        unresolved_rows += int(row_raw)
        unmapped_rows += int(row_unmapped)
        for name in source_images:
            source_rows_by_binary[name] = source_rows_by_binary.get(name, 0) + 1
    return {
        "trace_grace_uuid": target_uuids.get(target_binary + ".debug.dylib") or target_uuids.get(target_binary),
        "trace_target_uuids": target_uuids,
        "main_thread_rows": main_rows,
        "main_thread_grace_rows": app_rows,
        "main_thread_grace_source_rows": source_rows,
        "main_thread_source_rows_by_binary": source_rows_by_binary,
        "main_thread_unresolved_rows": unresolved_rows,
        "main_thread_unmapped_rows": unmapped_rows,
        "samples": samples,
    }

mapped_resolved, mapped_images = mapped_backfill()
inferred = infer_debug_image()
resolved_frames = mapped_resolved + (inferred["resolved_frames"] if inferred else 0)
if resolved_frames:
    tree.write(xml_path, encoding="utf-8", xml_declaration=True)
backfill = {"resolved_frames": resolved_frames, "images": mapped_images}
if inferred:
    backfill["inferred_images"] = {target_binary + ".debug.dylib": inferred}
print(json.dumps({
    "coverage": coverage(),
    "symbolUuids": symbol_uuids,
    "backfill": backfill,
}, ensure_ascii=False))
`;

const PYTHON_TRACE_PARSER = String.raw`
import json
import math
import sys
import xml.etree.ElementTree as ET

time_profile_path = sys.argv[1]
target_binary = sys.argv[2]
max_samples = max(1, int(sys.argv[3]))
max_depth = max(1, int(sys.argv[4]))

def tag_name(element):
    return element.tag.rsplit("}", 1)[-1]

def child(element, name):
    for item in list(element):
        if tag_name(item) == name:
            return item
    return None

def path_text(path_element, paths):
    if path_element is None:
        return ""
    ref = path_element.get("ref")
    if ref:
        return paths.get(ref, "")
    return path_element.text or ""

root = ET.parse(time_profile_path).getroot()
paths = {}
binaries = {}
sample_times = {}
threads = {}
weights = {}
backtraces = {}
for element in root.iter():
    name = tag_name(element)
    if name == "path" and element.get("id"):
        paths[element.get("id")] = element.text or ""
    elif name == "binary" and element.get("id"):
        binaries[element.get("id")] = {
            "name": element.get("name") or "",
            "uuid": element.get("UUID") or element.get("uuid") or "",
            "path": element.get("path") or "",
        }
    elif name == "sample-time" and element.get("id") and not element.get("ref"):
        sample_times[element.get("id")] = element
    elif name == "thread" and element.get("id") and not element.get("ref"):
        threads[element.get("id")] = element
    elif name == "weight" and element.get("id") and not element.get("ref"):
        weights[element.get("id")] = element
    elif name == "backtrace" and element.get("id") and not element.get("ref"):
        backtraces[element.get("id")] = element

def resolve_ref(element, table):
    if element is None:
        return None
    ref = element.get("ref")
    if ref:
        return table.get(ref)
    return element

def sample_time_seconds(time_element):
    resolved = resolve_ref(time_element, sample_times)
    if resolved is None:
        return None
    text = (resolved.text or "").strip()
    if text:
        try:
            return int(text) / 1000000000.0
        except ValueError:
            pass
    fmt = resolved.get("fmt") or ""
    parts = []
    for item in fmt.replace(":", ".").split("."):
        if item.isdigit():
            parts.append(int(item))
    if len(parts) >= 4:
        return parts[0] * 60 + parts[1] + parts[2] / 1000.0 + parts[3] / 1000000.0
    if len(parts) >= 3:
        return parts[0] * 60 + parts[1] + parts[2] / 1000.0
    return None

def sample_weight_ms(weight_element):
    resolved = resolve_ref(weight_element, weights)
    if resolved is None:
        return 1.0
    text = (resolved.text or "").strip()
    if text:
        try:
            return int(text) / 1000000.0
        except ValueError:
            pass
    fmt = resolved.get("fmt") or ""
    if "ms" in fmt:
        try:
            return float(fmt.split("ms", 1)[0].strip())
        except ValueError:
            pass
    return 1.0

def binary_info(binary_element):
    if binary_element is None:
        return {}
    ref = binary_element.get("ref")
    if ref:
        return binaries.get(ref, {})
    binary_id = binary_element.get("id")
    if binary_id:
        return binaries.get(binary_id, {})
    return {}

def is_app_frame(binary_name, binary_path, source_path):
    if target_binary and binary_name in (
        target_binary,
        target_binary + ".debug.dylib",
        target_binary + "Core",
        "FlowDebugBasicDynamic",
    ):
        return True
    local_markers = (
        "/Florak/flow/ios/",
        "/BDWorkSpace/Dbao/",
        "/flow_iOS/",
        "/.jojo/repos/",
        "/bazel_build/",
    )
    if any(marker in binary_path for marker in local_markers):
        return True
    if source_path.startswith(("./flow/ios/", "./flow_iOS/")):
        return True
    return False

def parse_frame_definition(frame):
    binary_element = child(frame, "binary")
    binary = binary_info(binary_element)
    binary_name = ""
    if binary_element is not None:
        binary_name = binary_element.get("name") or binary.get("name", "")
    binary_name = binary_name or frame.get("binary") or ""
    binary_path = binary.get("path", "")

    source = child(frame, "source")
    source_path = ""
    line = ""
    if source is not None:
        line = source.get("line") or ""
        source_path = source.get("path") or path_text(child(source, "path"), paths)

    frame_name = frame.get("name") or frame.get("symbol") or frame.get("fmt") or ""
    if not frame_name:
        frame_name = (frame.text or "").strip() or "unknown"

    return {
        "name": frame_name,
        "binary": binary_name,
        "sourcePath": source_path,
        "line": line,
        "appFrame": is_app_frame(binary_name, binary_path, source_path),
    }

frames_by_id = {}
for element in root.iter():
    if tag_name(element) == "frame" and element.get("id") and not element.get("ref"):
        frames_by_id[element.get("id")] = parse_frame_definition(element)

def resolve_frame(frame):
    ref = frame.get("ref")
    if ref:
        resolved = frames_by_id.get(ref)
        if resolved:
            return dict(resolved)
        return None

    parsed = parse_frame_definition(frame)
    frame_id = frame.get("id")
    if frame_id:
        frames_by_id[frame_id] = parsed
    return parsed

main_thread_ids = set()
rows_by_thread = {}
thread_labels = {}
thread_order = []
warnings = []

def thread_bucket(thread_id):
    if thread_id not in rows_by_thread:
        rows_by_thread[thread_id] = {"rows": [], "times": [], "weights": []}
        thread_order.append(thread_id)
    return rows_by_thread[thread_id]

for row in root.iter():
    if tag_name(row) != "row":
        continue
    thread = resolve_ref(child(row, "thread"), threads)
    if thread is None:
        continue
    thread_id = thread.get("id") or thread.get("ref") or ""
    thread_fmt = thread.get("fmt") or thread.text or ""
    if not thread_id:
        continue
    if thread_fmt and thread_id not in thread_labels:
        thread_labels[thread_id] = thread_fmt.strip()
    if "Main Thread" in thread_fmt:
        main_thread_ids.add(thread_id)

    frames = []
    backtrace = resolve_ref(child(row, "backtrace"), backtraces)
    frame_source = backtrace.iter() if backtrace is not None else row.iter()
    for frame in frame_source:
        if tag_name(frame) != "frame":
            continue
        resolved = resolve_frame(frame)
        if resolved:
            frames.append(resolved)

    if not frames:
        continue

    bucket = thread_bucket(thread_id)
    root_first = list(reversed(frames))
    bucket["rows"].append(root_first[:max_depth])
    bucket["times"].append(sample_time_seconds(child(row, "sample-time")))
    bucket["weights"].append(sample_weight_ms(child(row, "weight")))

def downsample(rows, times, weights):
    stride = max(1, math.ceil(len(rows) / max_samples)) if rows else 1
    indexes = list(range(0, len(rows), stride))[:max_samples]
    out_samples = [rows[index] for index in indexes]
    out_times = []
    out_weights = []
    last_time = None
    for index in indexes:
        current_time = times[index]
        if current_time is None:
            if last_time is None:
                current_time = 0.0
            else:
                current_time = last_time + max(0.001, weights[index] / 1000.0)
        out_times.append(current_time)
        bucket_weight = 0.0
        bucket_end = min(len(weights), index + stride)
        for weight_index in range(index, bucket_end):
            bucket_weight += weights[weight_index]
        out_weights.append(bucket_weight if bucket_weight > 0 else weights[index])
        last_time = current_time
    return stride, out_samples, out_times, out_weights

trace_start = None
trace_end = None
thread_payloads = []
for thread_id in thread_order:
    bucket = rows_by_thread[thread_id]
    rows = bucket["rows"]
    if not rows:
        continue
    stride, samples, times, weights = downsample(rows, bucket["times"], bucket["weights"])
    is_main = thread_id in main_thread_ids
    label = thread_labels.get(thread_id) or ("Main Thread" if is_main else "Thread " + str(thread_id))
    first_time = times[0] if times else None
    last_time = None
    if times:
        last_index = len(times) - 1
        last_time = times[last_index] + max(0.001, weights[last_index] / 1000.0)
    if first_time is not None:
        trace_start = first_time if trace_start is None else min(trace_start, first_time)
    if last_time is not None:
        trace_end = last_time if trace_end is None else max(trace_end, last_time)
    thread_payloads.append({
        "threadId": str(thread_id),
        "label": label,
        "isMain": is_main,
        "totalRows": len(rows),
        "stride": stride,
        "sampleTimesSeconds": times,
        "sampleWeightsMs": weights,
        "samples": samples,
    })

# Sort main thread first, then by first sample time so the stack reads top-down.
def thread_sort_key(payload):
    first = payload["sampleTimesSeconds"][0] if payload["sampleTimesSeconds"] else 0.0
    return (0 if payload["isMain"] else 1, first)

thread_payloads.sort(key=thread_sort_key)

main_payload = next((payload for payload in thread_payloads if payload["isMain"]), None)
if main_payload is None and thread_payloads:
    main_payload = thread_payloads[0]

if main_payload is None:
    warnings.append("No sampled frame rows were found in time_profile.xml.")

print(json.dumps({
    "totalMainThreadRows": main_payload["totalRows"] if main_payload else 0,
    "sampleStride": main_payload["stride"] if main_payload else 1,
    "sampleTimesSeconds": main_payload["sampleTimesSeconds"] if main_payload else [],
    "sampleWeightsMs": main_payload["sampleWeightsMs"] if main_payload else [],
    "samples": main_payload["samples"] if main_payload else [],
    "threads": thread_payloads,
    "traceStartSeconds": trace_start if trace_start is not None else 0.0,
    "traceEndSeconds": trace_end if trace_end is not None else 0.0,
    "warnings": warnings,
}, ensure_ascii=False))
`;
