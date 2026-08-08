import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PiAgent,
  PiAgentError,
  PiCliNotFoundError,
} from "@deerwork-ai/deer-workflow/agents";

let temporaryDirectory: string;
let stubPath: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "deer-workflow-pi-test-"));
  stubPath = join(temporaryDirectory, "pi-stub.ts");

  await writeFile(
    stubPath,
    `
const args = Bun.argv.slice(2);
const prompt = await Bun.stdin.text();

if (prompt.trim() === "fail") {
  console.error("mock pi failure");
  process.exit(7);
}

if (prompt.trim() === "wait-for-abort") {
  await Bun.sleep(10_000);
  console.log("too late");
  process.exit(0);
}

if (!args.includes("--no-session") && prompt.trim() !== "inspect-runtime") {
  console.error("missing --no-session");
  process.exit(9);
}

if (args.includes("--mode")) {
  const modeIndex = args.indexOf("--mode");
  const extensionIndex = args.indexOf("--extension");
  const extensionPath = args[extensionIndex + 1];
  if (args[modeIndex + 1] !== "json" || !extensionPath) {
    console.error("missing structured output mode");
    process.exit(10);
  }
  const extension = await Bun.file(extensionPath).text();
  if (!extension.includes('"required":["ok","prompt"]')) {
    console.error("schema was not passed to the structured output tool");
    process.exit(11);
  }
  if (prompt.trim() === "malformed-jsonl") {
    console.log("not json");
    process.exit(0);
  }
  console.log(JSON.stringify({ type: "agent_start" }));
  if (prompt.trim() === "missing-structured-output") {
    console.log(JSON.stringify({ type: "agent_end", messages: [] }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    type: "tool_execution_end",
    toolName: "deer_workflow_final_response",
    result: {
      content: [{ type: "text", text: "Structured response accepted." }],
      details: { ok: true, prompt },
    },
    isError: false,
  }));
  console.log(JSON.stringify({ type: "agent_end", messages: [] }));
  process.exit(0);
}

if (!args.includes("--print")) {
  console.error("missing --print");
  process.exit(8);
}

if (prompt.trim() === "inspect-args") {
  console.log(JSON.stringify(args));
  process.exit(0);
}

if (prompt.trim() === "inspect-runtime") {
  console.log(JSON.stringify({
    args,
    cwd: process.cwd(),
    base: process.env.PI_TEST_BASE,
    removed: process.env.PI_TEST_REMOVE,
  }));
  process.exit(0);
}

if (prompt.trim() === "inspect-policy") {
  const extensionIndexes = args
    .map((value, index) => value === "--extension" ? index : -1)
    .filter((index) => index >= 0);
  const extensionPath = args[extensionIndexes.at(-1) + 1];
  if (!extensionPath) {
    console.error("missing workspace policy extension");
    process.exit(12);
  }
  let handler;
  const extension = await import(extensionPath);
  extension.default({
    on(event, callback) {
      if (event === "tool_call") handler = callback;
    },
  });
  if (!handler) {
    console.error("workspace policy did not register a tool guard");
    process.exit(13);
  }
  const allowedPath = process.env.TEST_ALLOWED_PATH;
  const outsidePath = process.env.TEST_OUTSIDE_PATH;
  const symlinkPath = process.env.TEST_SYMLINK_PATH;
  const allowed = await handler({ toolName: "write", input: { path: allowedPath } });
  const outside = await handler({ toolName: "edit", input: { path: outsidePath } });
  const symlink = await handler({ toolName: "write", input: { path: symlinkPath } });
  console.log(JSON.stringify({ args, allowed, outside, symlink }));
  process.exit(0);
}

console.log(\`mock: \${prompt}\`);
`,
    "utf8",
  );
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("PiAgent", () => {
  test("returns the final text response from an ephemeral print run", async () => {
    const runtime = createStubAgent();

    const result = await runtime.run("hello");

    expect(result).toBe("mock: hello");
  });

  test("returns a schema-backed response from the terminating tool", async () => {
    const runtime = createStubAgent();

    const result = await runtime.run<{ ok: boolean; prompt: string }>(
      "inspect",
      {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            prompt: { type: "string" },
          },
          required: ["ok", "prompt"],
          additionalProperties: false,
        },
      },
    );

    expect(result).toEqual({ ok: true, prompt: "inspect" });
  });

  test("preserves Pi diagnostics on process failure", async () => {
    const runtime = createStubAgent();

    try {
      await runtime.run("fail");
      throw new Error("Expected the Agent run to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(PiAgentError);
      expect((error as PiAgentError).exitCode).toBe(7);
      expect((error as PiAgentError).stderr).toContain("mock pi failure");
    }
  });

  test("explains how to install Pi 0.84.1 when the command is missing", async () => {
    const runtime = new PiAgent({
      command: "deer-workflow-missing-pi-command",
    });

    try {
      await runtime.run("inspect");
      throw new Error("Expected the Pi CLI lookup to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(PiCliNotFoundError);
      expect((error as Error).message).toContain(
        "@earendil-works/pi-coding-agent@0.84.1",
      );
      expect((error as Error).message).toContain("pi auth check");
      expect((error as Error).message).toContain("pi --version");
    }
  });

  test("fails when Pi completes without the terminating structured response", async () => {
    const runtime = createStubAgent();

    expect(
      runtime.run("missing-structured-output", {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            prompt: { type: "string" },
          },
          required: ["ok", "prompt"],
          additionalProperties: false,
        },
      }),
    ).rejects.toBeInstanceOf(PiAgentError);
  });

  test("limits read-only runs to non-mutating built-in tools", async () => {
    const runtime = createStubAgent();

    const result = await runtime.run("inspect-args", {
      sandbox: "read-only",
    });
    const args = JSON.parse(result) as string[];

    expect(args).toContain("--no-extensions");
    expect(
      args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2),
    ).toEqual(["--tools", "read,grep,find,ls"]);
    expect(args.join(" ")).not.toContain("bash");
    expect(args.join(" ")).not.toContain("edit");
    expect(args.join(" ")).not.toContain("write");
  });

  test("confines workspace writes to cwd and additional writable roots", async () => {
    const runtime = createStubAgent();
    const additionalRoot = join(temporaryDirectory, "additional-root");
    const outsidePath = join(tmpdir(), "deer-workflow-pi-outside.txt");
    await Bun.write(join(additionalRoot, ".keep"), "");
    await symlink(tmpdir(), join(additionalRoot, "escape"));

    const result = await runtime.run("inspect-policy", {
      sandbox: "workspace-write",
      additionalWritableDirectories: [additionalRoot],
      env: {
        TEST_ALLOWED_PATH: join(additionalRoot, "result.txt"),
        TEST_OUTSIDE_PATH: outsidePath,
        TEST_SYMLINK_PATH: join(additionalRoot, "escape", "result.txt"),
      },
    });
    const policy = JSON.parse(result) as {
      args: string[];
      allowed?: { block?: boolean };
      outside?: { block?: boolean; reason?: string };
      symlink?: { block?: boolean; reason?: string };
    };

    expect(policy.args).toContain("--no-extensions");
    expect(
      policy.args.slice(
        policy.args.indexOf("--tools"),
        policy.args.indexOf("--tools") + 2,
      ),
    ).toEqual(["--tools", "read,grep,find,ls,edit,write"]);
    expect(policy.args.join(" ")).not.toContain("bash");
    expect(policy.allowed).toBeUndefined();
    expect(policy.outside?.block).toBe(true);
    expect(policy.outside?.reason).toContain("outside the writable roots");
    expect(policy.symlink?.block).toBe(true);
    expect(policy.symlink?.reason).toContain("outside the writable roots");
  });

  test("terminates an active Pi process and propagates the abort reason", async () => {
    const runtime = createStubAgent();
    const controller = new AbortController();
    const reason = new Error("stop Pi");
    const result = runtime.run("wait-for-abort", { signal: controller.signal });

    setTimeout(() => controller.abort(reason), 20);

    await expect(result).rejects.toBe(reason);
  });

  test("rejects raw arguments that could override harness safety controls", async () => {
    const runtime = new PiAgent({
      command: process.execPath,
      commandArgs: [stubPath],
      extraArgs: ["--tools", "bash"],
    });

    await expect(
      runtime.run("inspect-args", { sandbox: "read-only" }),
    ).rejects.toThrow("reserved Pi CLI option: --tools");
  });

  test("fails clearly when Pi emits a malformed JSON Event Stream", async () => {
    const runtime = createStubAgent();

    await expect(
      runtime.run("malformed-jsonl", {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            prompt: { type: "string" },
          },
          required: ["ok", "prompt"],
          additionalProperties: false,
        },
      }),
    ).rejects.toThrow("invalid JSON Event Stream");
  });

  test("applies per-run model and environment overrides", async () => {
    const runtime = new PiAgent({
      command: process.execPath,
      commandArgs: [stubPath],
      cwd: temporaryDirectory,
      model: "base-model",
      ephemeral: false,
      env: {
        PI_TEST_BASE: "constructor",
        PI_TEST_REMOVE: "remove-me",
      },
    });

    const result = await runtime.run("inspect-runtime", {
      model: "run-model",
      env: {
        PI_TEST_BASE: "run",
        PI_TEST_REMOVE: undefined,
      },
    });
    const runtimeDetails = JSON.parse(result) as {
      args: string[];
      cwd: string;
      base?: string;
      removed?: string;
    };

    expect(runtimeDetails.args).toContain("--model");
    expect(runtimeDetails.args).toContain("run-model");
    expect(runtimeDetails.args).not.toContain("base-model");
    expect(runtimeDetails.args).not.toContain("--no-session");
    expect(runtimeDetails.cwd).toBe(await realpath(temporaryDirectory));
    expect(runtimeDetails.base).toBe("run");
    expect(runtimeDetails.removed).toBeUndefined();
  });

  test("rejects an empty or already-aborted run before command lookup", async () => {
    const runtime = new PiAgent({ command: "missing-pi-for-abort-test" });
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);

    await expect(runtime.run("   ")).rejects.toBeInstanceOf(TypeError);
    await expect(
      runtime.run("inspect", { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});

const realPiTest =
  process.env.DEER_WORKFLOW_PI_INTEGRATION === "1" ? test : test.skip;

realPiTest("runs a schema-backed call through Pi 0.84.1", async () => {
  const versionProcess = Bun.spawn(["pi", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [version, exitCode] = await Promise.all([
    new Response(versionProcess.stdout).text(),
    versionProcess.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(version.trim()).toBe("0.84.1");

  const runtime = new PiAgent();
  const result = await runtime.run<{ ok: boolean }>(
    "Return ok=true using the required final response tool.",
    {
      sandbox: "read-only",
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  );

  expect(result).toEqual({ ok: true });
});

function createStubAgent(): PiAgent {
  return new PiAgent({
    command: process.execPath,
    commandArgs: [stubPath],
    cwd: temporaryDirectory,
  });
}
