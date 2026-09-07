/**
 * Input accepted by the iOS Launch Trace Workflow.
 */
export interface IosLaunchTraceInput {
  /** Git repository root. Defaults to `projectRoot`. */
  repositoryRoot?: string;

  /**
   * iOS source root containing Modules/, Flow/, and Podfile.
   */
  projectRoot: string;

  /** Root containing BitSky `.vscode-out`; defaults to `projectRoot`. */
  buildRoot?: string;

  /**
   * Full Xcode Developer directory exported as DEVELOPER_DIR.
   * Defaults to `/Applications/Xcode_26.app/Contents/Developer`.
   */
  developerDir?: string;

  /** Real-device UDID used by xctrace. */
  udid: string;

  /** Bundle identifier launched under Time Profiler. */
  bundleId?: string;

  /** Path to the flow-ios-trace-collection `collect_trace.py` script. */
  collectorScriptPath?: string;

  /** Python executable used to run the collector script. */
  python?: string;

  /** Existing `.app` bundle to install before tracing. */
  appPath?: string;

  /** Matching `.app.dSYM` bundle for source-level symbolication. */
  dsymPath?: string;

  /** Directory recursively searched for BitSky dSYMs before XML export. */
  symbolSearchPath?: string;

  /** xctrace time limit, such as `20s` or `15000ms`. */
  timeLimit?: string;

  /** Skip the install step when the device already has the matching app. */
  skipInstall?: boolean;

  /** Stable run id used when deriving the default output directory. */
  runId?: string;

  /** Directory where trace, XML, summary, and HTML artifacts are written. */
  outputDir?: string;

  /** Binary name highlighted as application code in the rendered timeline. */
  targetBinary?: string;

  /** HTML report path. Defaults to `<outputDir>/launch-trace-report.html`. */
  htmlReportPath?: string;

  /** Maximum samples rendered in the HTML flame timeline. */
  maxSamples?: number;

  /** Maximum frame depth rendered in the HTML flame timeline. */
  maxDepth?: number;
}

/**
 * Summary shape emitted by `collect_trace.py`.
 */
export interface LaunchTraceSummary {
  success?: boolean;
  mode?: string;
  repository_root?: string;
  project_root?: string;
  build_root?: string;
  udid?: string;
  bundle_id?: string;
  app_path?: string;
  dsym_path?: string;
  symbol_search_path?: string;
  symbolicated_trace_path?: string;
  target_binary?: string;
  output_dir?: string;
  trace_path?: string;
  toc_path?: string;
  time_profile_path?: string;
  summary_path?: string;
  symbolication_status?: string;
  symbolicate?: {
    returncode?: number;
    stdout_tail?: string;
    stderr_tail?: string;
  };
  dsym_uuid?: string | null;
  trace_grace_uuid?: string | null;
  trace_target_uuids?: Record<string, string>;
  main_thread_rows?: number;
  main_thread_grace_rows?: number;
  main_thread_grace_source_rows?: number;
  samples?: LaunchTraceSymbolSample[];
  error?: string;
  message?: string;
  warning?: string;
  trace_settle?: {
    settled?: boolean;
    snapshots?: Array<{
      attempt?: number;
      file_count?: number;
      total_bytes?: number;
      newest_mtime_ns?: number;
    }>;
  };
  export_attempts?: Record<
    string,
    Array<{
      attempt?: number;
      returncode?: number;
      stdout_path?: string;
      stderr_path?: string;
      stdout_tail?: string;
      stderr_tail?: string;
    }>
  >;
  recovered_from_export_failure?: boolean;
  recovery_note?: string;
}

/**
 * Representative symbol sample preserved by the collector summary.
 */
export interface LaunchTraceSymbolSample {
  name?: string;
  source_path?: string;
  line?: string;
  uuid?: string;
}

/**
 * Result returned by the Workflow handler.
 */
export interface IosLaunchTraceResult {
  success: boolean;
  repositoryRoot: string;
  projectRoot: string;
  buildRoot: string;
  exitCode: number;
  command: string[];
  outputDir: string;
  summaryPath: string;
  tracePath: string;
  tocPath: string;
  timeProfilePath: string;
  htmlReportPath: string;
  symbolicationStatus: string;
  mainThreadRows: number;
  mainThreadGraceRows: number;
  mainThreadGraceSourceRows: number;
  stdoutTail: string;
  stderrTail: string;
  summary: LaunchTraceSummary;
}

/**
 * One resolved frame in a sampled main-thread stack.
 */
export interface TraceFrame {
  name: string;
  binary: string;
  sourcePath: string;
  line: string;
  appFrame: boolean;
}

/**
 * Consecutive samples where the same frame appears at the same stack depth.
 */
export interface TraceFrameSpan extends TraceFrame {
  depth: number;
  startSample: number;
  endSample: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  weightMs: number;
  color: string;
}

/**
 * Grouping bucket used to organize stacked thread bands.
 */
export type ThreadGroup = "main" | "app" | "other";

/**
 * One thread's merged flame timeline built from its own samples.
 */
export interface ThreadTimeline {
  threadId: string;
  label: string;
  isMain: boolean;
  group: ThreadGroup;
  totalRows: number;
  renderedSamples: number;
  maxDepth: number;
  startSeconds: number;
  endSeconds: number;
  sampleDepths: number[];
  spans: TraceFrameSpan[];
}

/**
 * Parsed timeline data used by the HTML renderer.
 *
 * The top-level `spans`/`sampleDepths`/`sampleTimesSeconds` fields describe the
 * main thread for backward compatibility. `threads` carries every sampled
 * thread so the viewer can stack them on a shared time axis.
 */
export interface ParsedTraceTimeline {
  totalMainThreadRows: number;
  renderedSamples: number;
  sampleStride: number;
  sampleTimesSeconds: number[];
  sampleWeightsMs: number[];
  maxDepth: number;
  sampleDepths: number[];
  spans: TraceFrameSpan[];
  topFrames: Array<TraceFrame & { samples: number }>;
  threads: ThreadTimeline[];
  traceStartSeconds: number;
  traceEndSeconds: number;
  warnings: string[];
}
