import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  Agent,
  AgentOptions,
  PiAgentConfig,
  PiAgentErrorDetails,
  ResolvedPiAgentConfig,
} from "./types";

/**
 * Error raised when the configured Pi CLI executable is unavailable.
 */
export class PiCliNotFoundError extends Error {
  /** Executable name or path that could not be resolved. */
  readonly command: string;

  /**
   * Creates an actionable Pi CLI installation error.
   *
   * @param command - Executable name or path that was not found.
   */
  constructor(command: string) {
    super(`Pi CLI command "${command}" was not found.

Install Pi Coding Agent 0.84.1:
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
  pi auth check
  pi --version

Installation guide: https://pi.dev/docs/latest/quickstart`);
    this.name = "PiCliNotFoundError";
    this.command = command;
  }
}

/**
 * Error raised when Pi cannot complete an Agent run or return the requested
 * structured output.
 */
export class PiAgentError extends Error {
  /** Pi process exit status. */
  readonly exitCode: number;

  /** Complete standard output captured from Pi. */
  readonly stdout: string;

  /** Complete standard error captured from Pi. */
  readonly stderr: string;

  /**
   * Creates an error with the original Pi process diagnostics.
   *
   * @param message - Human-readable failure summary.
   * @param details - Exit status and captured process output.
   */
  constructor(message: string, details: PiAgentErrorDetails) {
    super(message);
    this.name = "PiAgentError";
    this.exitCode = details.exitCode;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
  }
}

/**
 * Agent runtime backed by the non-interactive Pi CLI.
 *
 * @remarks
 * Text runs use Print Mode. Schema-backed runs load a temporary terminating
 * tool and parse its validated result from Pi's JSON Event Stream. Pi has no
 * built-in operating-system Sandbox, so constrained modes use explicit tool
 * allowlists and `workspace-write` omits bash.
 *
 * @example
 * ```ts
 * const runtime = new PiAgent({ sandbox: "read-only" });
 * const result = await runtime.run("Inspect this repository.");
 * ```
 */
export class PiAgent implements Agent {
  readonly #config: ResolvedPiAgentConfig;

  /**
   * Creates a Pi-backed Agent runtime.
   *
   * @param config - Defaults applied to every Pi invocation.
   */
  constructor(config: PiAgentConfig = {}) {
    this.#config = {
      command: config.command ?? "pi",
      commandArgs: config.commandArgs ?? [],
      cwd: config.cwd,
      model: config.model,
      sandbox: config.sandbox,
      ephemeral: config.ephemeral ?? true,
      extraArgs: config.extraArgs ?? [],
      env: config.env,
    };
  }

  /**
   * Runs Pi until it produces a final response.
   *
   * @typeParam TOutput - Expected final response type.
   * @param prompt - Task instructions sent to Pi over stdin.
   * @param options - Per-run options that override constructor defaults.
   * @returns Text when no schema is supplied, otherwise parsed JSON.
   * @throws {@link PiAgentError} When Pi exits unsuccessfully, emits invalid
   * JSONL, or omits the requested structured response.
   * @throws {@link PiCliNotFoundError} When the configured executable cannot
   * be resolved.
   * @throws TypeError When `prompt` is empty.
   */
  async run<TOutput = string>(
    prompt: string,
    options: AgentOptions = {},
  ): Promise<TOutput> {
    if (prompt.trim().length === 0) {
      throw new TypeError("PiAgent requires a non-empty prompt.");
    }

    assertSafeExtraArgs(this.#config.extraArgs);
    options.signal?.throwIfAborted();
    this.#assertCommandAvailable();

    const sandbox = options.sandbox ?? this.#config.sandbox;
    if (!options.schema && sandbox !== "workspace-write") {
      const result = await this.#runProcess(prompt, options, ["--print"]);
      return result.stdout.trimEnd() as TOutput;
    }

    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "deer-workflow-pi-"),
    );
    const extensionPath = join(temporaryDirectory, "structured-output.ts");
    const policyPath = join(temporaryDirectory, "workspace-policy.ts");

    try {
      const modeArgs = options.schema ? ["--mode", "json"] : ["--print"];

      if (options.schema) {
        await writeFile(
          extensionPath,
          buildStructuredOutputExtension(options.schema),
          "utf8",
        );
        modeArgs.push("--extension", extensionPath);
      }

      if (sandbox === "workspace-write") {
        const cwd = resolve(options.cwd ?? this.#config.cwd ?? process.cwd());
        const writableRoots = [
          cwd,
          ...(options.additionalWritableDirectories ?? []).map((directory) =>
            resolve(directory),
          ),
        ];
        await writeFile(
          policyPath,
          buildWorkspacePolicyExtension(writableRoots, cwd),
          "utf8",
        );
        modeArgs.push("--extension", policyPath);
      }

      const result = await this.#runProcess(prompt, options, modeArgs);
      return options.schema
        ? (parseStructuredOutput(result) as TOutput)
        : (result.stdout.trimEnd() as TOutput);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  #assertCommandAvailable(): void {
    if (Bun.which(this.#config.command) === null) {
      throw new PiCliNotFoundError(this.#config.command);
    }
  }

  async #runProcess(
    prompt: string,
    options: AgentOptions,
    modeArgs: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const command = [
      this.#config.command,
      ...this.#config.commandArgs,
      ...this.#config.extraArgs,
      ...modeArgs,
    ];
    const sandbox = options.sandbox ?? this.#config.sandbox;
    if (sandbox === "read-only") {
      command.push("--no-extensions", "--no-approve", "--tools");
      command.push(
        options.schema
          ? "read,grep,find,ls,deer_workflow_final_response"
          : "read,grep,find,ls",
      );
    } else if (sandbox === "workspace-write") {
      command.push(
        "--no-extensions",
        "--no-approve",
        "--tools",
        options.schema
          ? "read,grep,find,ls,edit,write,deer_workflow_final_response"
          : "read,grep,find,ls,edit,write",
      );
    }
    if (this.#config.ephemeral) {
      command.push("--no-session");
    }
    const model = options.model ?? this.#config.model;
    if (model) {
      command.push("--model", model);
    }

    const subprocess = Bun.spawn(command, {
      cwd: resolve(options.cwd ?? this.#config.cwd ?? process.cwd()),
      env: mergeEnvironment(process.env, this.#config.env, options.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const abort = (): void => {
      subprocess.kill();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    subprocess.stdin.write(prompt);
    subprocess.stdin.end();

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      if (options.signal?.aborted) {
        throw (
          options.signal.reason ??
          new DOMException("The Agent run was aborted.", "AbortError")
        );
      }
      if (exitCode !== 0) {
        throw new PiAgentError(`Pi CLI exited with status ${exitCode}.`, {
          exitCode,
          stdout,
          stderr,
        });
      }
      return { stdout, stderr, exitCode };
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

function buildStructuredOutputExtension(
  schema: AgentOptions["schema"],
): string {
  return `const parameters = ${JSON.stringify(schema)};

export default function registerStructuredOutput(pi) {
  pi.registerTool({
    name: "deer_workflow_final_response",
    label: "Deer Workflow Final Response",
    description: "Return the final response matching the required schema. Use this tool exactly once as the final action.",
    promptSnippet: "Return the final structured response with deer_workflow_final_response",
    promptGuidelines: [
      "Use deer_workflow_final_response as your final action.",
      "Do not emit another assistant response after calling it.",
    ],
    parameters,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Structured response accepted." }],
        details: params,
        terminate: true,
      };
    },
  });
}
`;
}

function buildWorkspacePolicyExtension(
  writableRoots: string[],
  cwd: string,
): string {
  return `import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const cwd = ${JSON.stringify(cwd)};
const writableRoots = ${JSON.stringify(writableRoots)};

async function canonicalizeTarget(path) {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const missingSegments = [];
  let candidate = absolute;

  while (true) {
    try {
      const existing = await realpath(candidate);
      return resolve(existing, ...missingSegments.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      missingSegments.push(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      candidate = parent;
    }
  }
}

function contains(root, target) {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(\`..\${sep}\`));
}

export default function registerWorkspacePolicy(pi) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return undefined;
    }
    const path = event.input?.path;
    if (typeof path !== "string") {
      return { block: true, reason: "A writable path is required." };
    }
    try {
      const [target, ...roots] = await Promise.all([
        canonicalizeTarget(path),
        ...writableRoots.map((root) => canonicalizeTarget(root)),
      ]);
      if (roots.some((root) => contains(root, target))) {
        return undefined;
      }
    } catch {
      return { block: true, reason: \`Unable to validate writable path "\${path}".\` };
    }
    return { block: true, reason: \`Path "\${path}" is outside the writable roots.\` };
  });
}
`;
}

function parseStructuredOutput(details: PiAgentErrorDetails): unknown {
  for (const line of details.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let event: {
      type?: string;
      toolName?: string;
      isError?: boolean;
      result?: { details?: unknown };
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch (cause) {
      throw new PiAgentError(
        `Pi CLI returned an invalid JSON Event Stream: ${formatCause(cause)}`,
        details,
      );
    }
    if (
      event.type === "tool_execution_end" &&
      event.toolName === "deer_workflow_final_response" &&
      event.isError === false &&
      event.result?.details !== undefined
    ) {
      return event.result.details;
    }
  }
  throw new PiAgentError(
    "Pi CLI completed without the requested structured response.",
    details,
  );
}

function formatCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function mergeEnvironment(
  ...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === undefined) {
        delete environment[key];
      } else {
        environment[key] = value;
      }
    }
  }

  return environment;
}

const reservedPiOptions = new Set([
  "--approve",
  "--continue",
  "--exclude-tools",
  "--extension",
  "--fork",
  "--mode",
  "--no-approve",
  "--no-builtin-tools",
  "--no-extensions",
  "--no-session",
  "--no-tools",
  "--print",
  "--resume",
  "--session",
  "--tools",
  "-a",
  "-c",
  "-e",
  "-na",
  "-nbt",
  "-nt",
  "-p",
  "-r",
  "-t",
  "-xt",
]);

function assertSafeExtraArgs(extraArgs: readonly string[]): void {
  for (const value of extraArgs) {
    const option = value.split("=", 1)[0] ?? value;
    if (reservedPiOptions.has(option)) {
      throw new TypeError(
        `PiAgent extraArgs contains reserved Pi CLI option: ${option}.`,
      );
    }
  }
}
