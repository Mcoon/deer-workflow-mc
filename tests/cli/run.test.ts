import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { WorkflowEvent } from "@deerwork-ai/deer-workflow/events";

const projectDirectory = resolve(".");
const cliPath = resolve("src/cli.ts");

let temporaryDirectory: string;
let echoWorkflowPath: string;
let failingWorkflowPath: string;
let inputFilePath: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "deer-workflow-cli-test-"));

  const flowModuleUrl = pathToFileURL(resolve("src/flow/index.ts")).href;
  const loggingModuleUrl = pathToFileURL(resolve("src/logging/index.ts")).href;

  echoWorkflowPath = join(temporaryDirectory, "echo.ts");
  await writeFile(
    echoWorkflowPath,
    `
import { phase } from ${JSON.stringify(flowModuleUrl)};
import { log } from ${JSON.stringify(loggingModuleUrl)};

export default function run(args, context) {
  phase("Echo");
  log("Returning CLI input");
  return {
    input: args,
    depth: context.depth,
  };
}
`,
    "utf8",
  );

  failingWorkflowPath = join(temporaryDirectory, "failing.ts");
  await writeFile(
    failingWorkflowPath,
    "export default () => { throw new Error('workflow failed'); };\n",
    "utf8",
  );

  inputFilePath = join(temporaryDirectory, "input.json");
  await writeFile(inputFilePath, JSON.stringify({ source: "file" }), "utf8");
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("deer-workflow run", () => {
  test("runs a Workflow with inline JSON input", async () => {
    const result = await runCli([
      "run",
      echoWorkflowPath,
      "--input",
      JSON.stringify({ source: "inline" }),
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      input: { source: "inline" },
      depth: 0,
    });

    const events = parseEventLines(result.stderr);
    expect(events.map((event) => event.type)).toEqual([
      "workflow:start",
      "workflow:phase:start",
      "log",
      "workflow:phase:end",
      "workflow:end",
    ]);
  });

  test("accepts JSON input from a file", async () => {
    const result = await runCli([
      "run",
      echoWorkflowPath,
      "--input-file",
      inputFilePath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      input: { source: "file" },
      depth: 0,
    });
  });

  test("accepts JSON input from stdin", async () => {
    const result = await runCli(
      ["run", echoWorkflowPath],
      JSON.stringify({ source: "stdin" }),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      input: { source: "stdin" },
      depth: 0,
    });
  });

  test("prints one Workflow event per stdout line with --print", async () => {
    const result = await runCli([
      "run",
      echoWorkflowPath,
      "--print",
      "--input",
      JSON.stringify({ source: "print" }),
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const events = parseEventLines(result.stdout);
    expect(events.map((event) => event.type)).toEqual([
      "workflow:start",
      "workflow:phase:start",
      "log",
      "workflow:phase:end",
      "workflow:end",
    ]);
    expect(events.every((event) => event.sequence > 0)).toBe(true);
    expect(result.stdout.split("\n")).toHaveLength(events.length);
  });

  test("supports -p and keeps failures out of the stdout Event Stream", async () => {
    const result = await runCli(["run", failingWorkflowPath, "-p"]);

    expect(result.exitCode).toBe(1);
    expect(parseEventLines(result.stdout).map((event) => event.type)).toEqual([
      "workflow:start",
      "workflow:error",
    ]);
    expect(result.stderr).toContain("workflow failed");
  });

  test("rejects invalid JSON before starting the Workflow", async () => {
    const result = await runCli([
      "run",
      echoWorkflowPath,
      "--input",
      "{invalid",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid JSON from --input");
    expect(parseEventLines(result.stderr)).toEqual([]);
  });

  test("returns a failing exit code after emitting workflow:error", async () => {
    const result = await runCli(["run", failingWorkflowPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("workflow failed");
    expect(parseEventLines(result.stderr).map((event) => event.type)).toEqual([
      "workflow:start",
      "workflow:error",
    ]);
  });

  test("writes durable trace artifacts with --trace", async () => {
    const traceRoot = join(temporaryDirectory, "traces");
    const result = await runCli([
      "run",
      echoWorkflowPath,
      "--trace",
      "--trace-dir",
      traceRoot,
      "--input",
      JSON.stringify({ source: "trace" }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Trace HTML");
    expect(result.stderr).toContain("Trace JSONL");
    const directory = traceOutputDirectory(result.stderr);
    expect(directory.startsWith(traceRoot)).toBeTrue();
    for (const file of [
      "trace.jsonl",
      "summary.json",
      "result.json",
      "trace.html",
    ]) {
      expect(await Bun.file(join(directory, file)).exists()).toBeTrue();
    }
    const summary = JSON.parse(
      await Bun.file(join(directory, "summary.json")).text(),
    );
    expect(summary).toMatchObject({
      schemaVersion: "deer-workflow-trace-summary/v1",
      status: "success",
      commandCount: 0,
      agentCallCount: 0,
    });
  });

  test("keeps an error trace when the Workflow fails", async () => {
    const traceRoot = join(temporaryDirectory, "error-traces");
    const result = await runCli([
      "run",
      failingWorkflowPath,
      "--trace-dir",
      traceRoot,
    ]);
    expect(result.exitCode).toBe(1);
    const directory = traceOutputDirectory(result.stderr);
    expect(directory.startsWith(traceRoot)).toBeTrue();
    const summary = JSON.parse(
      await Bun.file(join(directory, "summary.json")).text(),
    );
    expect(summary.status).toBe("error");
    expect(await Bun.file(join(directory, "trace.html")).exists()).toBeTrue();
    expect(await Bun.file(join(directory, "trace.jsonl")).text()).toContain(
      "workflow failed",
    );
  });

  test("marks a returned success false result as a trace failure", async () => {
    const traceRoot = join(temporaryDirectory, "business-failure-traces");
    const businessFailurePath = join(temporaryDirectory, "business-failure.ts");
    await writeFile(
      businessFailurePath,
      "export default () => ({ success: false, code: 'blocked' });\n",
      "utf8",
    );
    const result = await runCli([
      "run",
      businessFailurePath,
      "--trace-dir",
      traceRoot,
    ]);
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(
      await Bun.file(
        join(traceOutputDirectory(result.stderr), "summary.json"),
      ).text(),
    );
    expect(summary.status).toBe("failure");
  });
});

async function runCli(args: readonly string[], stdin = "") {
  const subprocess = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: projectDirectory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  subprocess.stdin.write(stdin);
  subprocess.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

function parseEventLines(stderr: string): WorkflowEvent[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as WorkflowEvent);
}

function traceOutputDirectory(stderr: string): string {
  const htmlPath = stderr
    .split("\n")
    .find((line) => line.startsWith("Trace HTML"))
    ?.replace(/^Trace HTML\s+/, "")
    .trim();
  if (!htmlPath) throw new Error("Trace HTML path was not printed.");
  return resolve(htmlPath, "..");
}
