import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import type {
  IosCosignBitskyInstallInput,
  IosCosignBitskyInstallResult,
} from "./types";

const DEFAULT_ARTIFACT_ROOT = "/tmp/ios_perf-opt";
const OUTPUT_TAIL_LENGTH = 4000;

export const meta = {
  name: "ios-cosign-bitsky-install",
  description:
    "Prepares Flow iOS device signing, Ruby dependencies, and BitSky build materials.",
  phases: [
    { title: "Prepare" },
    { title: "Cosign" },
    { title: "Ruby Dependencies" },
    { title: "BitSky Install" },
    { title: "Summarize" },
  ],
  exampleArgs: {
    repositoryRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak",
    projectRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    udid: "00008030-001A286A2229802E",
    target: "Grace",
    configuration: "Debug",
    developerDir: "/Applications/Xcode_26.app/Contents/Developer",
  },
};

interface NormalizedInput {
  repositoryRoot: string;
  projectRoot: string;
  udid: string;
  target: "Grace" | "Cici";
  configuration: NonNullable<IosCosignBitskyInstallInput["configuration"]>;
  developerDir: string;
  cosignScriptPath: string;
  outputDir: string;
  cosignStdoutPath: string;
  cosignStderrPath: string;
  bundleInstallStdoutPath: string;
  bundleInstallStderrPath: string;
  bitskyInstallStdoutPath: string;
  bitskyInstallStderrPath: string;
  summaryPath: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export default async function iosCosignBitskyInstall(
  args: IosCosignBitskyInstallInput,
): Promise<IosCosignBitskyInstallResult> {
  const input = normalizeInput(args);
  await mkdir(input.outputDir, { recursive: true });

  phase("Prepare");
  log(
    [
      "## Preparing iOS signing and BitSky install",
      `- **Repository:** \`${input.repositoryRoot}\``,
      `- **iOS project:** \`${input.projectRoot}\``,
      `- **Target:** \`${input.target}\``,
      `- **Configuration:** \`${input.configuration}\``,
      `- **Device:** \`${input.udid}\``,
      `- **Output:** \`${input.outputDir}\``,
    ].join("\n"),
  );

  const cosignCommand = buildCosignCommand(input);
  phase("Cosign");
  const cosign = await runCommand(
    cosignCommand,
    input.projectRoot,
    input.developerDir,
  );
  await persistCommandOutput(
    cosign,
    input.cosignStdoutPath,
    input.cosignStderrPath,
  );
  await assertStageSucceeded("cosign", cosign, input.cosignStderrPath, input, {
    cosignCommand,
  });

  const bundleInstallCommand = buildBundleInstallCommand();
  phase("Ruby Dependencies");
  const bundleInstall = await runCommand(
    bundleInstallCommand,
    input.projectRoot,
    input.developerDir,
  );
  await persistCommandOutput(
    bundleInstall,
    input.bundleInstallStdoutPath,
    input.bundleInstallStderrPath,
  );
  await assertStageSucceeded(
    "bundle_install",
    bundleInstall,
    input.bundleInstallStderrPath,
    input,
    {
      cosignCommand,
      bundleInstallCommand,
    },
  );

  const bitskyInstallCommand = buildBitskyInstallCommand(input);
  phase("BitSky Install");
  const bitskyInstall = await runCommand(
    bitskyInstallCommand,
    input.projectRoot,
    input.developerDir,
  );
  await persistCommandOutput(
    bitskyInstall,
    input.bitskyInstallStdoutPath,
    input.bitskyInstallStderrPath,
  );
  await assertStageSucceeded(
    "bitsky_install",
    bitskyInstall,
    input.bitskyInstallStderrPath,
    input,
    {
      cosignCommand,
      bundleInstallCommand,
      bitskyInstallCommand,
    },
  );

  const result: IosCosignBitskyInstallResult = {
    success: true,
    repositoryRoot: input.repositoryRoot,
    projectRoot: input.projectRoot,
    target: input.target,
    configuration: input.configuration,
    developerDir: input.developerDir,
    udid: input.udid,
    outputDir: input.outputDir,
    cosignCommand,
    bundleInstallCommand,
    bitskyInstallCommand,
    cosignExitCode: cosign.exitCode,
    bundleInstallExitCode: bundleInstall.exitCode,
    bitskyInstallExitCode: bitskyInstall.exitCode,
    cosignStdoutPath: input.cosignStdoutPath,
    cosignStderrPath: input.cosignStderrPath,
    bundleInstallStdoutPath: input.bundleInstallStdoutPath,
    bundleInstallStderrPath: input.bundleInstallStderrPath,
    bitskyInstallStdoutPath: input.bitskyInstallStdoutPath,
    bitskyInstallStderrPath: input.bitskyInstallStderrPath,
    summaryPath: input.summaryPath,
  };
  await writeSummary(input.summaryPath, result);

  phase("Summarize");
  log(
    [
      "## iOS signing and BitSky install complete",
      `- **Cosign exit:** ${cosign.exitCode}`,
      `- **Bundle install exit:** ${bundleInstall.exitCode}`,
      `- **BitSky install exit:** ${bitskyInstall.exitCode}`,
      `- **Summary:** \`${input.summaryPath}\``,
      "- Run ios-build-install next to build and install without launching.",
    ].join("\n"),
  );
  return result;
}

/** Builds the repository-native non-interactive cosign command. */
export function buildCosignCommand(input: {
  cosignScriptPath: string;
  udid: string;
}): string[] {
  return [
    input.cosignScriptPath,
    "--no-interactive",
    "--device-udid",
    input.udid,
  ];
}

/** Builds the Orbit-managed Ruby dependency installation command. */
export function buildBundleInstallCommand(): string[] {
  return ["orbit", "bundle", "install"];
}

/** Builds the target/configuration-specific BitSky material install command. */
export function buildBitskyInstallCommand(input: {
  target: "Grace" | "Cici";
  configuration: string;
}): string[] {
  return [
    "orbit",
    "bundle",
    "exec",
    "bitsky_install",
    "--target",
    input.target.toLowerCase(),
    "--mode",
    input.configuration,
  ];
}

function normalizeInput(args: IosCosignBitskyInstallInput): NormalizedInput {
  if (!args) {
    throw new TypeError(
      "iOS Cosign and BitSky Install requires input arguments.",
    );
  }
  const projectRoot = resolve(requiredText(args.projectRoot, "projectRoot"));
  const repositoryRoot = resolve(args.repositoryRoot?.trim() || projectRoot);
  const udid = requiredText(args.udid, "udid");
  const runId = safeSegment(args.runId?.trim() || timestampForPath());
  const outputDir = resolve(
    args.outputDir?.trim() ||
      join(DEFAULT_ARTIFACT_ROOT, "ios-cosign-bitsky-install", runId),
  );
  return {
    repositoryRoot,
    projectRoot,
    udid,
    target: args.target ?? "Grace",
    configuration: args.configuration ?? "Debug",
    developerDir: args.developerDir?.trim() ? resolve(args.developerDir) : "",
    cosignScriptPath: resolve(
      args.cosignScriptPath?.trim() ||
        join(projectRoot, "Scripts", "cosign.sh"),
    ),
    outputDir,
    cosignStdoutPath: join(outputDir, "cosign.stdout.txt"),
    cosignStderrPath: join(outputDir, "cosign.stderr.txt"),
    bundleInstallStdoutPath: join(outputDir, "bundle-install.stdout.txt"),
    bundleInstallStderrPath: join(outputDir, "bundle-install.stderr.txt"),
    bitskyInstallStdoutPath: join(outputDir, "bitsky-install.stdout.txt"),
    bitskyInstallStderrPath: join(outputDir, "bitsky-install.stderr.txt"),
    summaryPath: join(outputDir, "summary.json"),
  };
}

async function assertStageSucceeded(
  phaseName: string,
  result: CommandResult,
  stderrPath: string,
  input: NormalizedInput,
  commands: Record<string, string[]>,
): Promise<void> {
  if (result.exitCode === 0) {
    return;
  }
  await writeSummary(input.summaryPath, {
    success: false,
    failedPhase: phaseName,
    repositoryRoot: input.repositoryRoot,
    projectRoot: input.projectRoot,
    target: input.target,
    configuration: input.configuration,
    udid: input.udid,
    ...commands,
    exitCode: result.exitCode,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
  });
  throw new Error(
    `${phaseName} failed with exit code ${result.exitCode}. See ${stderrPath}.`,
  );
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

async function persistCommandOutput(
  result: CommandResult,
  stdoutPath: string,
  stderrPath: string,
): Promise<void> {
  await Promise.all([
    writeFile(stdoutPath, result.stdout, "utf8"),
    writeFile(stderrPath, result.stderr, "utf8"),
  ]);
}

async function writeSummary(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requiredText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new TypeError(`iOS Cosign and BitSky Install requires ${label}.`);
  }
  return normalized;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\..+$/u, "");
}

function tail(value: string): string {
  return value.length <= OUTPUT_TAIL_LENGTH
    ? value
    : value.slice(-OUTPUT_TAIL_LENGTH);
}
