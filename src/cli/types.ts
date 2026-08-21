/**
 * Parsed arguments accepted by the `run` CLI command.
 */
export interface RunCommandArguments {
  /** Workflow module path supplied by the user. */
  readonly scriptPath: string;

  /** Whether stdout should contain only the JSONL Workflow Event Stream. */
  readonly print: boolean;

  /** Whether a durable execution trace should be written. */
  readonly trace: boolean;

  /** Optional root directory for trace run folders. */
  readonly traceDirectory?: string;

  /** JSON text supplied directly through `--input`. */
  readonly inlineInput?: string;

  /** Path to a JSON document supplied through `--input-file`. */
  readonly inputFile?: string;
}
