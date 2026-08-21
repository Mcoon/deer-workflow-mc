import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import type {
  FlowIosBuildError,
  FlowIosBuildOutput,
  IosBuildInstallInput,
  IosBuildInstallResult,
} from "./types";

const DEFAULT_ARTIFACT_ROOT = "/tmp/ios_perf-opt";
const DEFAULT_BUILD_SCRIPT_PATH =
  "/Users/bytedance/.agents/skills/flow-ios-dev/scripts/build_app.py";
const DEFAULT_MODE = "Debug";
const DEFAULT_INSTALL_TIMEOUT_SECONDS = 180;
const OUTPUT_TAIL_LENGTH = 4000;

/** Declares the Workflow's identity and observable phase plan. */
export const meta = {
  name: "ios-build-install",
  description:
    "Builds a flow_iOS app with dSYM artifacts and installs it without launching.",
  phases: [
    { title: "Prepare" },
    { title: "Build" },
    { title: "Validate symbols" },
    { title: "Install" },
    { title: "Summarize" },
  ],
  exampleArgs: {
    projectRoot: "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
    udid: "00008030-001A286A2229802E",
    mode: "Debug",
  },
};

/**
 * Builds the target app with dSYM output and installs the `.app` without
 * launching it.
 *
 * @param args - Build target, device UDID, and output settings.
 * @returns Trace-ready app and dSYM paths plus build/install diagnostics.
 */
export default async function iosBuildInstall(
  args: IosBuildInstallInput,
): Promise<IosBuildInstallResult> {
  const input = normalizeInput(args);

  phase("Prepare");
  await mkdir(input.outputDir, { recursive: true });
  log(
    [
      "## Preparing trace-ready iOS build",
      `- **Project:** \`${input.projectRoot}\``,
      `- **Device:** \`${input.udid}\``,
      `- **Mode:** \`${input.mode}\``,
      `- **Output:** \`${input.outputDir}\``,
    ].join("\n"),
  );

  phase("Build");
  const buildCommand = buildAppCommand(input);
  log(
    [
      "## Building app with dSYM artifacts",
      `- **Script:** \`${input.buildScriptPath}\``,
      `- **Symbols required:** ${input.symbolsRequired ? "yes" : "no"}`,
      "- Build output is captured under the workflow output directory",
    ].join("\n"),
  );
  const build = await runCommand(buildCommand, input.projectRoot);
  await writeFile(input.buildStdoutPath, build.stdout, "utf8");
  await writeFile(input.buildStderrPath, build.stderr, "utf8");
  const buildOutput = parseJsonObject<FlowIosBuildOutput>(build.stdout, {
    success: false,
    error: "build_output_parse_failed",
  });
  await writeJson(input.buildSummaryPath, buildOutput);

  phase("Validate symbols");
  const symbolPaths = resolveSymbolPaths(buildOutput);
  const appPath = buildOutput.app_path ?? "";
  const dsymPath = symbolPaths.primary;
  const symbolicationStatus = buildOutput.symbolication_status ?? "unknown";
  const compileErrors = formatBuildErrors(buildOutput);
  log(
    [
      "## Validating build artifacts",
      `- **App:** \`${appPath || "missing"}\``,
      `- **dSYM:** \`${dsymPath || "missing"}\``,
      `- **Symbolication:** \`${symbolicationStatus}\``,
      `- **Build log:** \`${buildOutput.log_file ?? ""}\``,
      ...(compileErrors.length > 0
        ? [
            "",
            `### Compile errors (${buildOutput.error_count ?? compileErrors.length})`,
            ...compileErrors.map((line) => `- ${line}`),
            ...(buildOutput.truncated === true
              ? ["- _…error list truncated; see build log for the rest._"]
              : []),
          ]
        : []),
    ].join("\n"),
  );
  await assertBuildReady({
    buildExitCode: build.exitCode,
    buildOutput,
    appPath,
    dsymPath,
    requireReadySymbols: input.requireReadySymbols,
    symbolicationStatus,
    buildSummaryPath: input.buildSummaryPath,
  });

  phase("Install");
  const installPaths = installOutputPaths(input.outputDir, appPath);
  const installCommand = installOnlyCommand({
    appPath,
    udid: input.udid,
    timeoutSeconds: input.installTimeoutSeconds,
    jsonPath: installPaths.jsonPath,
    logPath: installPaths.logPath,
  });
  log(
    [
      "## Installing app without launch",
      `- **Command:** \`${installCommand.map(shellQuote).join(" ")}\``,
      `- **Install JSON:** \`${installPaths.jsonPath}\``,
      `- **Install log:** \`${installPaths.logPath}\``,
    ].join("\n"),
  );
  const install = await runCommand(installCommand, input.projectRoot);
  if (install.stdout.trim()) {
    await writeFile(
      join(input.outputDir, "install-stdout.txt"),
      install.stdout,
      "utf8",
    );
  }
  if (install.stderr.trim()) {
    await writeFile(
      join(input.outputDir, "install-stderr.txt"),
      install.stderr,
      "utf8",
    );
  }
  const installOutput = await readOptionalJson(installPaths.jsonPath);

  if (install.exitCode !== 0) {
    throw new Error(
      [
        "Install-only devicectl command failed.",
        `Exit code: ${install.exitCode}`,
        `Install log: ${installPaths.logPath}`,
        `stderr tail: ${tail(install.stderr)}`,
      ].join("\n"),
    );
  }

  phase("Summarize");
  log(
    [
      "## Build and install ready",
      `- **appPath:** \`${appPath}\``,
      `- **dsymPath:** \`${dsymPath}\``,
      "- Pass these paths into `ios-launch-trace` to avoid default dSYM lookup.",
    ].join("\n"),
  );

  return {
    success: true,
    projectRoot: input.projectRoot,
    udid: input.udid,
    outputDir: input.outputDir,
    appPath,
    dsymPath,
    dsymPaths: symbolPaths.all,
    exportedDsymPath: buildOutput.exported_dsym_path ?? "",
    symbolicationStatus,
    buildCommand,
    installCommand,
    buildExitCode: build.exitCode,
    installExitCode: install.exitCode,
    buildSummaryPath: input.buildSummaryPath,
    buildStdoutPath: input.buildStdoutPath,
    buildStderrPath: input.buildStderrPath,
    buildLogFile: buildOutput.log_file ?? "",
    installJsonPath: installPaths.jsonPath,
    installLogPath: installPaths.logPath,
    buildOutput,
    installOutput,
  };
}

interface NormalizedInput {
  projectRoot: string;
  udid: string;
  buildScriptPath: string;
  python: string;
  mode: "Debug" | "Release";
  noKeepGoing: boolean;
  symbolsRequired: boolean;
  requireReadySymbols: boolean;
  outputDir: string;
  installTimeoutSeconds: number;
  buildSummaryPath: string;
  buildStdoutPath: string;
  buildStderrPath: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function normalizeInput(args: IosBuildInstallInput): NormalizedInput {
  if (!args) {
    throw new TypeError("iOS Build Install requires input arguments.");
  }

  const projectRoot = resolve(requiredText(args.projectRoot, "projectRoot"));
  const udid = requiredText(args.udid, "udid");
  const runId = safeSegment(args.runId?.trim() || timestampForPath());
  const outputDir = resolve(
    args.outputDir?.trim() ||
      join(DEFAULT_ARTIFACT_ROOT, "ios-build-install", runId),
  );

  return {
    projectRoot,
    udid,
    buildScriptPath: resolve(
      args.buildScriptPath?.trim() || DEFAULT_BUILD_SCRIPT_PATH,
    ),
    python: args.python?.trim() || "python3",
    mode: args.mode ?? DEFAULT_MODE,
    noKeepGoing: args.noKeepGoing === true,
    symbolsRequired: args.symbolsRequired !== false,
    requireReadySymbols: args.requireReadySymbols !== false,
    outputDir,
    installTimeoutSeconds: boundedInteger(
      args.installTimeoutSeconds,
      30,
      900,
      DEFAULT_INSTALL_TIMEOUT_SECONDS,
    ),
    buildSummaryPath: join(outputDir, "build-summary.json"),
    buildStdoutPath: join(outputDir, "build-stdout.json"),
    buildStderrPath: join(outputDir, "build-stderr.txt"),
  };
}

/** @internal */
export function buildAppCommand(input: {
  python: string;
  buildScriptPath: string;
  projectRoot: string;
  mode: "Debug" | "Release";
  noKeepGoing: boolean;
  symbolsRequired: boolean;
}): string[] {
  const command = [
    input.python,
    input.buildScriptPath,
    "--project-root",
    input.projectRoot,
    "--mode",
    input.mode,
  ];
  if (input.noKeepGoing) {
    command.push("--no-keep-going");
  }
  if (input.symbolsRequired) {
    command.push("--symbols-required");
  }
  return command;
}

/** @internal */
export function installOnlyCommand(options: {
  appPath: string;
  udid: string;
  timeoutSeconds: number;
  jsonPath: string;
  logPath: string;
}): string[] {
  return [
    "xcrun",
    "devicectl",
    "device",
    "install",
    "app",
    "--device",
    options.udid,
    options.appPath,
    "--timeout",
    String(options.timeoutSeconds),
    "--json-output",
    options.jsonPath,
    "--log-output",
    options.logPath,
  ];
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

async function assertBuildReady(options: {
  buildExitCode: number;
  buildOutput: FlowIosBuildOutput;
  appPath: string;
  dsymPath: string;
  requireReadySymbols: boolean;
  symbolicationStatus: string;
  buildSummaryPath: string;
}): Promise<void> {
  const issues: string[] = [];
  if (options.buildExitCode !== 0 || options.buildOutput.success !== true) {
    issues.push(buildFailureReason(options.buildOutput, options.buildExitCode));
  }
  if (!(await pathExists(options.appPath))) {
    issues.push(`app_path is missing or does not exist: ${options.appPath}`);
  }
  if (!(await pathExists(options.dsymPath))) {
    issues.push(`dSYM is missing or does not exist: ${options.dsymPath}`);
  }
  if (options.requireReadySymbols && options.symbolicationStatus !== "ready") {
    issues.push(
      `symbolication_status is ${options.symbolicationStatus}; expected ready`,
    );
  }

  if (issues.length > 0) {
    const compileErrors = formatBuildErrors(options.buildOutput);
    throw new Error(
      [
        "Build did not produce installable trace-ready artifacts.",
        ...issues.map((issue) => `- ${issue}`),
        ...(compileErrors.length > 0
          ? [
              `Compile errors (${options.buildOutput.error_count ?? compileErrors.length}):`,
              ...compileErrors.map((line) => `  - ${line}`),
              ...(options.buildOutput.truncated === true
                ? ["  - …error list truncated; see build log for the rest."]
                : []),
            ]
          : []),
        `Build summary: ${options.buildSummaryPath}`,
        ...(options.buildOutput.log_file
          ? [`Build log: ${options.buildOutput.log_file}`]
          : []),
      ].join("\n"),
    );
  }
}

/**
 * Renders `build_app.py` compile diagnostics into human-readable lines like
 * `path/to/File.swift:550:27 message`. Returns an empty array when the build
 * output carries no structured error entries.
 *
 * @internal
 */
export function formatBuildErrors(output: FlowIosBuildOutput): string[] {
  const errors = output.errors;
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors
    .map((entry) => formatBuildError(entry))
    .filter((line): line is string => line.length > 0);
}

function formatBuildError(entry: FlowIosBuildError | undefined): string {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  const location = [entry.file, entry.line, entry.column]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join(":");
  const message = entry.message?.trim() ?? "";
  if (location && message) {
    return `${location} ${message}`;
  }
  return location || message;
}

function buildFailureReason(
  output: FlowIosBuildOutput,
  exitCode: number,
): string {
  if (output.action) {
    return `action=${output.action}: ${output.error ?? "build failed"}`;
  }
  if (output.error) {
    return output.error;
  }
  if (output.error_count !== undefined) {
    return `build produced ${output.error_count} errors`;
  }
  return `build_app.py exited with status ${exitCode}`;
}

/** @internal */
export function resolveSymbolPaths(output: FlowIosBuildOutput): {
  primary: string;
  all: string[];
} {
  const paths = [
    output.exported_dsym_path,
    output.dsym_path,
    ...(output.dsym_paths ?? []),
  ].filter((path): path is string => Boolean(path));
  const all = [...new Set(paths)];
  return {
    primary: output.exported_dsym_path ?? output.dsym_path ?? all[0] ?? "",
    all,
  };
}

function installOutputPaths(
  outputDir: string,
  appPath: string,
): { jsonPath: string; logPath: string } {
  const stem = safeSegment(basename(appPath).replace(/\.app$/u, "") || "app");
  return {
    jsonPath: join(outputDir, `${stem}-install.json`),
    logPath: join(outputDir, `${stem}-install.log`),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readOptionalJson(path: string): Promise<unknown> {
  if (!(await pathExists(path))) {
    return null;
  }
  return parseJsonObject(await readFile(path, "utf8"), null);
}

function parseJsonObject<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function pathExists(path: string): Promise<boolean> {
  if (!path) {
    return false;
  }
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
    throw new TypeError(`iOS Build Install requires ${name}.`);
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

function tail(value: string): string {
  return value.slice(-OUTPUT_TAIL_LENGTH);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
