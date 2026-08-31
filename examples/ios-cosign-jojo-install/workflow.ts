import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import type {
  IosCosignJojoInstallInput,
  IosCosignJojoInstallResult,
} from "./types";

const DEFAULT_ARTIFACT_ROOT = "/tmp/ios_perf-opt";
const OUTPUT_TAIL_LENGTH = 4000;

/** Declares the Workflow's identity and observable phase plan. */
export const meta = {
  name: "ios-cosign-jojo-install",
  description:
    "Runs the repository-native iOS cosign and JoJo dependency installation scripts in order.",
  phases: [
    { title: "Prepare" },
    { title: "Cosign" },
    { title: "JoJo Install" },
    { title: "Summarize" },
  ],
  exampleArgs: {
    repositoryRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak",
    projectRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    udid: "00008030-001A286A2229802E",
    target: "Grace",
  },
};

interface NormalizedInput {
  repositoryRoot: string;
  projectRoot: string;
  udid: string;
  target: "Grace" | "Cici";
  cosignScriptPath: string;
  jojoInstallScriptPath: string;
  outputDir: string;
  cosignStdoutPath: string;
  cosignStderrPath: string;
  jojoInstallStdoutPath: string;
  jojoInstallStderrPath: string;
  summaryPath: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs repository-native signing followed by JoJo dependency installation.
 *
 * @param args - Florak repository, iOS project, signing, and target settings.
 * @returns Commands, exit codes, and persisted diagnostic paths.
 */
export default async function iosCosignJojoInstall(
  args: IosCosignJojoInstallInput,
): Promise<IosCosignJojoInstallResult> {
  const input = normalizeInput(args);
  await mkdir(input.outputDir, { recursive: true });

  phase("Prepare");
  log(
    [
      "## Preparing iOS signing and JoJo install",
      `- **Repository:** \`${input.repositoryRoot}\``,
      `- **iOS project:** \`${input.projectRoot}\``,
      `- **Target:** \`${input.target}\``,
      `- **Device:** \`${input.udid || "script default/interactive selection"}\``,
      `- **Output:** \`${input.outputDir}\``,
    ].join("\n"),
  );

  const cosignCommand = buildCosignCommand(input);
  phase("Cosign");
  const cosign = await runCommand(cosignCommand, input.projectRoot);
  await persistCommandOutput(
    cosign,
    input.cosignStdoutPath,
    input.cosignStderrPath,
  );
  if (cosign.exitCode !== 0) {
    await writeSummary(input.summaryPath, {
      success: false,
      failedPhase: "cosign",
      repositoryRoot: input.repositoryRoot,
      projectRoot: input.projectRoot,
      target: input.target,
      udid: input.udid,
      cosignCommand,
      cosignExitCode: cosign.exitCode,
      cosignStdoutPath: input.cosignStdoutPath,
      cosignStderrPath: input.cosignStderrPath,
      stdoutTail: tail(cosign.stdout),
      stderrTail: tail(cosign.stderr),
    });
    throw new Error(
      `iOS cosign failed with exit code ${cosign.exitCode}. See ${input.cosignStderrPath}.`,
    );
  }

  const jojoInstallCommand = buildJojoInstallCommand(input);
  phase("JoJo Install");
  const jojoInstall = await runCommand(jojoInstallCommand, input.projectRoot);
  await persistCommandOutput(
    jojoInstall,
    input.jojoInstallStdoutPath,
    input.jojoInstallStderrPath,
  );
  if (jojoInstall.exitCode !== 0) {
    await writeSummary(input.summaryPath, {
      success: false,
      failedPhase: "jojo_install",
      repositoryRoot: input.repositoryRoot,
      projectRoot: input.projectRoot,
      target: input.target,
      udid: input.udid,
      cosignCommand,
      cosignExitCode: cosign.exitCode,
      jojoInstallCommand,
      jojoInstallExitCode: jojoInstall.exitCode,
      cosignStdoutPath: input.cosignStdoutPath,
      cosignStderrPath: input.cosignStderrPath,
      jojoInstallStdoutPath: input.jojoInstallStdoutPath,
      jojoInstallStderrPath: input.jojoInstallStderrPath,
      stdoutTail: tail(jojoInstall.stdout),
      stderrTail: tail(jojoInstall.stderr),
    });
    throw new Error(
      `JoJo install failed with exit code ${jojoInstall.exitCode}. See ${input.jojoInstallStderrPath}.`,
    );
  }

  const result: IosCosignJojoInstallResult = {
    success: true,
    repositoryRoot: input.repositoryRoot,
    projectRoot: input.projectRoot,
    target: input.target,
    udid: input.udid,
    outputDir: input.outputDir,
    cosignCommand,
    jojoInstallCommand,
    cosignExitCode: cosign.exitCode,
    jojoInstallExitCode: jojoInstall.exitCode,
    cosignStdoutPath: input.cosignStdoutPath,
    cosignStderrPath: input.cosignStderrPath,
    jojoInstallStdoutPath: input.jojoInstallStdoutPath,
    jojoInstallStderrPath: input.jojoInstallStderrPath,
    summaryPath: input.summaryPath,
  };
  await writeSummary(input.summaryPath, result);

  phase("Summarize");
  log(
    [
      "## iOS signing and JoJo install complete",
      `- **Cosign exit:** ${cosign.exitCode}`,
      `- **JoJo install exit:** ${jojoInstall.exitCode}`,
      `- **Summary:** \`${input.summaryPath}\``,
      "- Run ios-build-install next to build and install without launching.",
    ].join("\n"),
  );
  return result;
}

/** Build the repository-native cosign command. */
export function buildCosignCommand(input: {
  cosignScriptPath: string;
  udid?: string;
}): string[] {
  const command = [input.cosignScriptPath];
  const udid = input.udid?.trim();
  if (udid) {
    command.push("--device-udid", udid);
  }
  return command;
}

/** Build the repository-native JoJo install command. */
export function buildJojoInstallCommand(input: {
  jojoInstallScriptPath: string;
  target: "Grace" | "Cici";
}): string[] {
  return [input.jojoInstallScriptPath, input.target];
}

function normalizeInput(args: IosCosignJojoInstallInput): NormalizedInput {
  if (!args) {
    throw new TypeError(
      "iOS Cosign and JoJo Install requires input arguments.",
    );
  }
  const projectRoot = resolve(requiredText(args.projectRoot, "projectRoot"));
  const repositoryRoot = resolve(args.repositoryRoot?.trim() || projectRoot);
  const runId = safeSegment(args.runId?.trim() || timestampForPath());
  const outputDir = resolve(
    args.outputDir?.trim() ||
      join(DEFAULT_ARTIFACT_ROOT, "ios-cosign-jojo-install", runId),
  );
  return {
    repositoryRoot,
    projectRoot,
    udid: args.udid?.trim() || "",
    target: args.target ?? "Grace",
    cosignScriptPath: resolve(
      args.cosignScriptPath?.trim() ||
        join(projectRoot, "Scripts", "cosign.sh"),
    ),
    jojoInstallScriptPath: resolve(
      args.jojoInstallScriptPath?.trim() || join(projectRoot, "jojoInstall.sh"),
    ),
    outputDir,
    cosignStdoutPath: join(outputDir, "cosign.stdout.txt"),
    cosignStderrPath: join(outputDir, "cosign.stderr.txt"),
    jojoInstallStdoutPath: join(outputDir, "jojo-install.stdout.txt"),
    jojoInstallStderrPath: join(outputDir, "jojo-install.stderr.txt"),
    summaryPath: join(outputDir, "summary.json"),
  };
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
    throw new TypeError(`iOS Cosign and JoJo Install requires ${label}.`);
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
