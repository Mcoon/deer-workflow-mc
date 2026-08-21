import type { Agent, AgentFunction, AgentOptions } from "./types";
import { getWorkflowContext } from "../flow/context";
import { getTraceRecorder } from "../trace/context";

/**
 * Binds an {@link Agent} instance to the callable {@link AgentFunction} API.
 *
 * @param runtime - Agent runtime that will handle every invocation.
 * @returns A function that forwards prompts and options to `runtime.run()`.
 */
export function bindAgent(runtime: Agent): AgentFunction {
  return async <TOutput = string>(
    prompt: string,
    options?: AgentOptions,
  ): Promise<TOutput> => {
    const recorder = getTraceRecorder();
    const operationId = crypto.randomUUID();
    const runtimeName = runtime.constructor.name || "Agent";
    const workflowId = getWorkflowContext()?.id;
    const startedAt = performance.now();
    recorder?.recordAgentStart({
      operationId,
      runtime: runtimeName,
      prompt,
      model: options?.model,
      cwd: options?.cwd,
      sandbox: options?.sandbox,
      schema: options?.schema,
      workflowId,
    });
    try {
      const response = await runtime.run<TOutput>(prompt, options);
      recorder?.recordAgentEnd({
        operationId,
        runtime: runtimeName,
        durationMs: performance.now() - startedAt,
        response,
        workflowId,
      });
      return response;
    } catch (error) {
      recorder?.recordAgentEnd({
        operationId,
        runtime: runtimeName,
        durationMs: performance.now() - startedAt,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
        workflowId,
      });
      throw error;
    }
  };
}
