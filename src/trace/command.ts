import { resolve } from "node:path";

import { getWorkflowContext } from "../flow/context";
import { getTraceRecorder } from "./context";
import type { CommandTraceResult } from "./types";

export async function runTracedCommand(
  command: readonly string[],
  cwd = process.cwd(),
): Promise<CommandTraceResult> {
  const recorder = getTraceRecorder();
  const operationId = crypto.randomUUID();
  const resolvedCwd = resolve(cwd);
  const workflowId = getWorkflowContext()?.id;
  recorder?.recordCommandStart({
    operationId,
    command,
    cwd: resolvedCwd,
    workflowId,
  });
  const startedAt = performance.now();
  try {
    const subprocess = Bun.spawn([...command], {
      cwd: resolvedCwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    const result = { stdout, stderr, exitCode };
    recorder?.recordCommandEnd({
      operationId,
      durationMs: performance.now() - startedAt,
      result,
      workflowId,
    });
    return result;
  } catch (error) {
    recorder?.recordCommandEnd({
      operationId,
      durationMs: performance.now() - startedAt,
      error,
      workflowId,
    });
    throw error;
  }
}
