import type { LaunchTraceSummary } from "../ios-launch-trace/types";

/**
 * Input accepted by the iOS Attach Trace Workflow.
 */
export interface IosAttachTraceInput {
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

  /** Bundle identifier shown in the report. */
  bundleId?: string;

  /**
   * Process name or pid passed to `xctrace record --attach`.
   *
   * Defaults to `targetBinary`, which is usually the executable name.
   */
  attachTarget?: string;

  /** Time Profiler template name or path. */
  template?: string;

  /** Python executable used by the shared XML parser. */
  python?: string;

  /** Existing `.app` bundle recorded in the summary for trace context. */
  appPath?: string;

  /** Matching `.app.dSYM` bundle for source-level symbolication context. */
  dsymPath?: string;

  /**
   * Directory recursively searched by `xctrace symbolicate`. When omitted,
   * the Workflow tries matching ios-build-install and flow-ios-bitsky summaries.
   */
  symbolSearchPath?: string;

  /** Business framework whose source coverage determines symbolication status. */
  businessBinary?: string;

  /** xctrace time limit, such as `30s` or `15000ms`. */
  timeLimit?: string;

  /** Stable run id used when deriving the default output directory. */
  runId?: string;

  /** Directory where trace, XML, summary, and HTML artifacts are written. */
  outputDir?: string;

  /** Binary name highlighted as application code in the rendered timeline. */
  targetBinary?: string;

  /** HTML report path. Defaults to `<outputDir>/attach-trace-report.html`. */
  htmlReportPath?: string;

  /** Maximum samples rendered in the HTML flame timeline. */
  maxSamples?: number;

  /** Maximum frame depth rendered in the HTML flame timeline. */
  maxDepth?: number;
}

/**
 * Process result embedded in the attach summary.
 */
export interface AttachProcessSummary {
  returncode: number;
  stdout_tail: string;
  stderr_tail: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  observed_recording_started_at?: string;
  observed_recording_finished_at?: string;
  observed_recording_duration_ms?: number;
  observed_attach_message?: string;
}

/**
 * Attach target resolution recorded when the workflow converts a process name
 * into a concrete PID before invoking xctrace.
 */
export interface AttachTargetResolution {
  requestedTarget: string;
  resolvedTarget: string;
  strategy: "explicit_pid" | "devicectl_main_executable_latest_pid";
  candidates?: Array<{
    pid: number;
    executable: string;
  }>;
}

/**
 * Summary shape emitted by the iOS Attach Trace Workflow.
 */
export interface IosAttachTraceSummary extends LaunchTraceSummary {
  mode: "attach";
  repository_root?: string;
  build_root?: string;
  attach_target: string;
  attach_target_resolution?: AttachTargetResolution;
  template: string;
  record?: AttachProcessSummary;
  symbolicate?: AttachProcessSummary;
  export_toc?: AttachProcessSummary;
  export_time_profile?: AttachProcessSummary;
  symbol_search_path?: string;
  symbol_search_source?: string;
  symbolicated_trace_path?: string;
  build_summary_path?: string;
}

/**
 * Result returned by the Workflow handler.
 */
export interface IosAttachTraceResult {
  success: boolean;
  repositoryRoot: string;
  projectRoot: string;
  buildRoot: string;
  exitCode: number;
  command: string[];
  outputDir: string;
  summaryPath: string;
  tracePath: string;
  symbolicatedTracePath: string;
  tocPath: string;
  timeProfilePath: string;
  htmlReportPath: string;
  symbolicationStatus: string;
  mainThreadRows: number;
  mainThreadGraceRows: number;
  mainThreadGraceSourceRows: number;
  stdoutTail: string;
  stderrTail: string;
  summary: IosAttachTraceSummary;
}
