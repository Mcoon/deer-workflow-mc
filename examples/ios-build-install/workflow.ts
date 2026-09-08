import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";
import { resolveDeveloperDirectory } from "../ios-xcode";

import type {
  FlowIosBuildError,
  FlowIosBuildOutput,
  IosBuildInstallInput,
  IosBuildInstallResult,
} from "./types";

const DEFAULT_ARTIFACT_ROOT = join(homedir(), ".ios_pref_optimizer");
const DEFAULT_MODE = "Debug";
const DEFAULT_TARGET = "Grace";
const DEFAULT_INSTALL_TIMEOUT_SECONDS = 180;
const OUTPUT_TAIL_LENGTH = 4000;
const REUSE_ARTIFACT_DIR = ".vscode-out";

export const meta = {
  name: "ios-build-install",
  description:
    "Builds a Flow iOS device app and dSYMs with BitSky, exports them to .vscode-out, and installs without launching.",
  phases: [
    { title: "Prepare" },
    { title: "Build" },
    { title: "Validate symbols" },
    { title: "Install" },
    { title: "Summarize" },
  ],
  exampleArgs: {
    repositoryRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak",
    projectRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    buildRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    udid: "00008030-001A286A2229802E",
    target: "Grace",
    mode: "Debug",
  },
};

interface NormalizedInput {
  repositoryRoot: string;
  projectRoot: string;
  buildRoot: string;
  developerDir: string;
  udid: string;
  existingBuildSummaryPath: string;
  reuseExistingArtifacts: boolean;
  target: "Grace" | "Cici";
  mode: NonNullable<IosBuildInstallInput["mode"]>;
  keepGoing: boolean;
  symbolsRequired: boolean;
  requireReadySymbols: boolean;
  businessBinary: string;
  outputDir: string;
  artifactDir: string;
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

interface SymbolPaths {
  primary: string;
  all: string[];
  business: string;
  searchRoot: string;
}

export default async function iosBuildInstall(
  args: IosBuildInstallInput,
): Promise<IosBuildInstallResult> {
  const input = normalizeInput(args);

  phase("Prepare");
  await mkdir(input.outputDir, { recursive: true });
  log(
    [
      "## Preparing trace-ready BitSky build",
      `- **Repository:** \`${input.repositoryRoot}\``,
      `- **iOS source:** \`${input.projectRoot}\``,
      `- **BitSky root:** \`${input.buildRoot}\``,
      `- **Artifacts:** \`${input.artifactDir}\``,
      `- **Device:** \`${input.udid}\``,
      `- **Target/configuration:** \`${input.target}/${input.mode}\``,
    ].join("\n"),
  );

  phase("Build");
  let buildCommand: string[] = [];
  let build: CommandResult = { stdout: "", stderr: "", exitCode: 0 };
  let buildOutput: FlowIosBuildOutput;
  if (input.reuseExistingArtifacts) {
    buildOutput = await reusedArtifactOutput(input);
    log(
      `## Reusing BitSky artifacts\n- **Artifacts:** \`${input.artifactDir}\``,
    );
  } else if (input.existingBuildSummaryPath) {
    buildOutput = normalizeBuildSummary(
      parseJsonObject(
        await readFile(input.existingBuildSummaryPath, "utf8"),
        {},
      ),
      input,
    );
    log(
      `## Reusing build summary\n- **Summary:** \`${input.existingBuildSummaryPath}\``,
    );
  } else {
    buildCommand = buildBitskyCommand(input);
    log(
      [
        "## Building app with BitSky",
        `- **Command:** \`${buildCommand.map(shellQuote).join(" ")}\``,
        `- **dSYM:** ${input.symbolsRequired ? "enabled" : "disabled"}`,
      ].join("\n"),
    );
    build = await runCommand(buildCommand, input.buildRoot, input.developerDir);
    buildOutput = await inspectBitSkyArtifacts(input, build);
  }

  await writeFile(input.buildStdoutPath, build.stdout, "utf8");
  await writeFile(input.buildStderrPath, build.stderr, "utf8");
  await writeJson(input.buildSummaryPath, buildOutput);

  phase("Validate symbols");
  const symbolPaths = resolveSymbolPaths(buildOutput, input.businessBinary);
  const appPath = buildOutput.app_path ?? "";
  const dsymPath = symbolPaths.primary;
  let symbolicationStatus = buildOutput.symbolication_status ?? "unknown";
  let matchedUuids: string[] = [];

  await assertBuildReady({
    buildExitCode: build.exitCode,
    buildOutput,
    appPath,
    dsymPath,
    requireReadySymbols: false,
    symbolicationStatus,
    buildSummaryPath: input.buildSummaryPath,
  });
  await verifyCodeSignature(appPath, input);
  if (input.symbolsRequired) {
    matchedUuids = await matchingAppDsymUuids({ appPath, dsymPath, input });
    symbolicationStatus = matchedUuids.length > 0 ? "ready" : "missing";
  }
  buildOutput.symbolication_status = symbolicationStatus;
  buildOutput.matched_uuids = matchedUuids;
  await writeJson(input.buildSummaryPath, buildOutput);
  await assertBuildReady({
    buildExitCode: build.exitCode,
    buildOutput,
    appPath,
    dsymPath,
    requireReadySymbols: input.requireReadySymbols,
    symbolicationStatus,
    buildSummaryPath: input.buildSummaryPath,
  });

  log(
    [
      "## Validating BitSky artifacts",
      `- **App:** \`${appPath}\``,
      `- **dSYM:** \`${dsymPath || "missing"}\``,
      `- **Business dSYM:** \`${symbolPaths.business || "missing"}\``,
      `- **Symbol search path:** \`${symbolPaths.searchRoot || "missing"}\``,
      `- **Symbolication:** \`${symbolicationStatus}\``,
      `- **Matched UUIDs:** \`${matchedUuids.join(", ") || "none"}\``,
    ].join("\n"),
  );

  phase("Install");
  const installPaths = installOutputPaths(input.outputDir, appPath);
  const installCommand = installOnlyCommand({
    appPath,
    udid: input.udid,
    timeoutSeconds: input.installTimeoutSeconds,
    jsonPath: installPaths.jsonPath,
    logPath: installPaths.logPath,
  });
  const install = await runCommand(
    installCommand,
    input.buildRoot,
    input.developerDir,
  );
  const installOutput = await readOptionalJson(installPaths.jsonPath);
  if (install.exitCode !== 0) {
    throw new Error(
      `Install-only devicectl command failed (${install.exitCode}). See ${installPaths.logPath}.\n${tail(install.stderr)}`,
    );
  }

  phase("Summarize");
  const result: IosBuildInstallResult = {
    success: true,
    repositoryRoot: input.repositoryRoot,
    projectRoot: input.projectRoot,
    buildRoot: input.buildRoot,
    developerDir: input.developerDir,
    udid: input.udid,
    target: input.target,
    mode: input.mode,
    outputDir: input.outputDir,
    artifactDir: input.artifactDir,
    appPath,
    dsymPath,
    dsymPaths: symbolPaths.all,
    businessDsymPath: symbolPaths.business,
    symbolSearchPath: symbolPaths.searchRoot,
    exportedDsymPath: buildOutput.exported_dsym_path ?? "",
    symbolicationStatus,
    buildReused:
      input.reuseExistingArtifacts || Boolean(input.existingBuildSummaryPath),
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
    launchPerformed: false,
    buildOutput,
    installOutput,
  };
  log(
    [
      "## BitSky build and install ready",
      `- **App:** \`${appPath}\``,
      `- **dSYM:** \`${dsymPath}\``,
      `- **Symbol search path:** \`${symbolPaths.searchRoot}\``,
      "- **Launch performed:** no",
    ].join("\n"),
  );
  return result;
}

function normalizeInput(args: IosBuildInstallInput): NormalizedInput {
  if (!args) {
    throw new TypeError("iOS Build Install requires input arguments.");
  }
  const projectRoot = resolve(requiredText(args.projectRoot, "projectRoot"));
  const repositoryRoot = resolve(args.repositoryRoot?.trim() || projectRoot);
  const buildRoot = resolve(args.buildRoot?.trim() || projectRoot);
  const udid = requiredText(args.udid, "udid");
  const runId = safeSegment(args.runId?.trim() || timestampForPath());
  const outputDir = resolve(
    args.outputDir?.trim() ||
      join(DEFAULT_ARTIFACT_ROOT, "ios-build-install", runId),
  );
  const symbolsRequired = args.symbolsRequired !== false;
  return {
    repositoryRoot,
    projectRoot,
    buildRoot,
    developerDir: resolveDeveloperDirectory(args.developerDir),
    udid,
    existingBuildSummaryPath: args.existingBuildSummaryPath?.trim()
      ? resolve(args.existingBuildSummaryPath)
      : "",
    reuseExistingArtifacts: args.reuseExistingArtifacts === true,
    target: args.target ?? DEFAULT_TARGET,
    mode: args.mode ?? DEFAULT_MODE,
    keepGoing: args.keepGoing === true && args.noKeepGoing !== true,
    symbolsRequired,
    requireReadySymbols: args.requireReadySymbols ?? symbolsRequired,
    businessBinary: args.businessBinary?.trim() || "FlowDebugBasicDynamic",
    outputDir,
    artifactDir: join(buildRoot, REUSE_ARTIFACT_DIR),
    installTimeoutSeconds: boundedInteger(
      args.installTimeoutSeconds,
      30,
      900,
      DEFAULT_INSTALL_TIMEOUT_SECONDS,
    ),
    buildSummaryPath: join(outputDir, "build-summary.json"),
    buildStdoutPath: join(outputDir, "build-stdout.txt"),
    buildStderrPath: join(outputDir, "build-stderr.txt"),
  };
}

/** Builds a Flow BitSky command for a physical arm64 device. */
export function buildBitskyCommand(input: {
  buildRoot: string;
  target: "Grace" | "Cici";
  mode: string;
  symbolsRequired: boolean;
  keepGoing: boolean;
}): string[] {
  const command = [
    "orbit",
    "bundle",
    "exec",
    "bitsky_build",
    "--target",
    input.target.toLowerCase(),
    "--configuration",
    input.mode,
    "--sdk",
    "os",
    "--archs",
    "arm64",
  ];
  if (input.symbolsRequired) {
    command.push("--dsym");
  }
  if (input.keepGoing) {
    command.push("--keep_going");
  }
  command.push("--output", join(input.buildRoot, REUSE_ARTIFACT_DIR));
  return command;
}

/** Reads the stable BitSky `.vscode-out` artifact layout without rebuilding. */
export async function reusedArtifactOutput(input: {
  repositoryRoot?: string;
  projectRoot?: string;
  buildRoot: string;
  target: "Grace" | "Cici";
  businessBinary?: string;
}): Promise<FlowIosBuildOutput> {
  const artifactDir = join(input.buildRoot, REUSE_ARTIFACT_DIR);
  const appPath = join(artifactDir, `${input.target}.app`);
  if (!(await pathExists(appPath))) {
    throw new Error(
      `Cannot reuse artifacts: ${appPath} does not exist. Run a BitSky build first.`,
    );
  }
  const dsymRoot = join(artifactDir, "dSYM");
  const dsymPath = await firstExistingPath([
    join(dsymRoot, `${input.target}.app.dSYM`),
    join(artifactDir, `${input.target}.app.dSYM`),
  ]);
  const dsymPaths = await listDsymBundles(dsymRoot);
  if (dsymPath && !dsymPaths.includes(dsymPath)) {
    dsymPaths.unshift(dsymPath);
  }
  const businessBinary = input.businessBinary || "FlowDebugBasicDynamic";
  const businessDsym = dsymPaths.find(
    (path) => basename(path) === `${businessBinary}.framework.dSYM`,
  );
  return {
    success: true,
    status: "success",
    repository_root: input.repositoryRoot,
    project_root: input.projectRoot,
    build_root: input.buildRoot,
    app_path: appPath,
    exported_dsym_path: dsymPath || undefined,
    dsym_path: dsymPath || undefined,
    dsym_paths: dsymPaths,
    symbol_search_path: dsymPaths.length > 0 ? dsymRoot : undefined,
    symbolication_status: dsymPath ? "ready" : "unknown",
    dsym_metadata: dsymPaths.map((path) => ({
      path,
      bundle_name: basename(path),
      binary_name:
        path === dsymPath
          ? input.target
          : basename(path).replace(/\.(framework|appex)\.dSYM$/u, ""),
    })),
    ...(businessDsym ? { business_dsym_path: businessDsym } : {}),
  };
}

async function inspectBitSkyArtifacts(
  input: NormalizedInput,
  build: CommandResult,
): Promise<FlowIosBuildOutput> {
  const output = await reusedArtifactOutput(input).catch(() => ({
    success: false,
    app_path: join(input.artifactDir, `${input.target}.app`),
  }));
  return {
    ...output,
    success: build.exitCode === 0 && output.success === true,
    status:
      build.exitCode === 0 && output.success === true ? "success" : "failed",
    error:
      build.exitCode === 0 ? undefined : tail(build.stderr || build.stdout),
    log_file: join(input.artifactDir, "bazel_build.raw.log"),
    build_config: {
      system: "bitsky",
      target: input.target,
      configuration: input.mode,
      sdk: "os",
      archs: "arm64",
      dsym: input.symbolsRequired,
    },
  };
}

function normalizeBuildSummary(
  value: Record<string, unknown>,
  input: NormalizedInput,
): FlowIosBuildOutput {
  const normalized = value as FlowIosBuildOutput & {
    matched_dsym_path?: string;
    status?: string;
  };
  return {
    ...normalized,
    success: normalized.success === true || normalized.status === "success",
    app_path:
      normalized.app_path || join(input.artifactDir, `${input.target}.app`),
    exported_dsym_path:
      normalized.exported_dsym_path || normalized.matched_dsym_path,
    dsym_path: normalized.dsym_path || normalized.matched_dsym_path,
  };
}

/** Builds a devicectl install command that never launches the App. */
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
  developerDir: string,
): Promise<CommandResult> {
  const env = developerDir
    ? { ...process.env, DEVELOPER_DIR: developerDir }
    : undefined;
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
  return { stdout, stderr, exitCode };
}

async function verifyCodeSignature(
  appPath: string,
  input: NormalizedInput,
): Promise<void> {
  const result = await runCommand(
    ["codesign", "--verify", "--deep", "--strict", appPath],
    input.buildRoot,
    input.developerDir,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `App code signature verification failed: ${tail(result.stderr || result.stdout)}`,
    );
  }
}

async function matchingAppDsymUuids(options: {
  appPath: string;
  dsymPath: string;
  input: NormalizedInput;
}): Promise<string[]> {
  const binaries = [join(options.appPath, options.input.target)];
  if (options.input.mode === "Debug") {
    binaries.push(join(options.appPath, `${options.input.target}.debug.dylib`));
  }
  const appUuids = new Set<string>();
  for (const binary of binaries) {
    if (await pathExists(binary)) {
      for (const uuid of await readMachOUuids(binary, options.input)) {
        appUuids.add(uuid);
      }
    }
  }
  const dsymUuids = await readMachOUuids(options.dsymPath, options.input);
  const matched = dsymUuids.filter((uuid) => appUuids.has(uuid));
  if (matched.length === 0) {
    throw new Error(
      `No dSYM UUID matches the App executable images. app=${[...appUuids].join(",")} dsym=${dsymUuids.join(",")}`,
    );
  }
  return matched;
}

async function readMachOUuids(
  path: string,
  input: NormalizedInput,
): Promise<string[]> {
  const result = await runCommand(
    ["xcrun", "dwarfdump", "--uuid", path],
    input.buildRoot,
    input.developerDir,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to read Mach-O UUIDs from ${path}: ${tail(result.stderr)}`,
    );
  }
  return [...result.stdout.matchAll(/UUID:\s+([A-Fa-f0-9-]+)/gu)].map((match) =>
    match[1]!.toUpperCase(),
  );
}

/** Enforces the App and optional ready-symbol gates before installation. */
export async function assertBuildReady(options: {
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
  if (options.requireReadySymbols && !(await pathExists(options.dsymPath))) {
    issues.push(`dSYM is missing or does not exist: ${options.dsymPath}`);
  }
  if (options.requireReadySymbols && options.symbolicationStatus !== "ready") {
    issues.push(
      `symbolication_status is ${options.symbolicationStatus}; expected ready`,
    );
  }
  if (issues.length > 0) {
    throw new Error(
      [
        "Build did not produce installable trace-ready artifacts.",
        ...issues.map((issue) => `- ${issue}`),
        `Build summary: ${options.buildSummaryPath}`,
      ].join("\n"),
    );
  }
}

/** Formats structured build diagnostics when a reused legacy summary provides them. */
export function formatBuildErrors(output: FlowIosBuildOutput): string[] {
  return (output.errors ?? [])
    .map((entry) => formatBuildError(entry))
    .filter((line): line is string => line.length > 0);
}

function formatBuildError(entry: FlowIosBuildError | undefined): string {
  if (!entry || typeof entry !== "object") return "";
  const location = [entry.file, entry.line, entry.column]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join(":");
  const message = entry.message?.trim() ?? "";
  return location && message ? `${location} ${message}` : location || message;
}

function buildFailureReason(
  output: FlowIosBuildOutput,
  exitCode: number,
): string {
  if (output.action)
    return `action=${output.action}: ${output.error ?? "build failed"}`;
  if (output.error) return output.error;
  return `bitsky_build exited with status ${exitCode}`;
}

/** Resolves the main and business dSYMs plus the recursive search directory. */
export function resolveSymbolPaths(
  output: FlowIosBuildOutput,
  businessBinary = "FlowDebugBasicDynamic",
): SymbolPaths {
  const paths = [
    output.exported_dsym_path,
    output.dsym_path,
    ...(output.dsym_paths ?? []),
  ].filter((path): path is string => Boolean(path));
  const all = [...new Set(paths)];
  const business =
    output.dsym_metadata?.find(
      (metadata) => metadata.binary_name === businessBinary,
    )?.path ??
    all.find((path) => basename(path) === `${businessBinary}.framework.dSYM`) ??
    "";
  return {
    primary: output.exported_dsym_path ?? output.dsym_path ?? all[0] ?? "",
    all,
    business,
    searchRoot:
      output.symbol_search_path ??
      (business ? dirname(business) : all[0] ? dirname(all[0]) : ""),
  };
}

async function listDsymBundles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".dSYM"))
    .map((entry) => join(root, entry.name))
    .sort();
}

async function firstExistingPath(paths: string[]): Promise<string> {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return "";
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
  if (!(await pathExists(path))) return null;
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
  if (!path) return false;
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function requiredText(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new TypeError(`iOS Build Install requires ${name}.`);
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
  if (/^[A-Za-z0-9_./:=+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
