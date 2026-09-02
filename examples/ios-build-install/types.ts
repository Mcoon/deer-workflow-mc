/** Input accepted by the iOS Build and Install Workflow. */
export interface IosBuildInstallInput {
  /** Git repository root. Defaults to `projectRoot` for standalone repositories. */
  repositoryRoot?: string;

  /** iOS source root containing Modules/, Flow/, and Podfile. */
  projectRoot: string;

  /** Root passed to flow-ios-dev/JoJo. Defaults to `projectRoot`. */
  buildRoot?: string;

  /** Real-device UDID used for install-only devicectl deployment. */
  udid: string;

  /** Path to the flow-ios-dev `build_app.py` script. */
  buildScriptPath?: string;

  /** Existing successful build_app summary to reuse instead of rebuilding. */
  existingBuildSummaryPath?: string;

  /**
   * Skip building and install the artifacts already exported under
   * `<buildRoot>/.vscode-out` (e.g. `Grace.app`). Use this when the code has
   * not changed and you only want to reinstall the last build.
   */
  reuseExistingArtifacts?: boolean;

  /**
   * Build target used to locate reused artifacts (`Grace.app` / `Cici.app`).
   * Defaults to `Grace`. Only affects reuse resolution.
   */
  target?: "Grace" | "Cici";

  /** Python executable used to run the build script. */
  python?: string;

  /** Build configuration passed to build_app.py. */
  mode?: "Debug" | "Release";

  /** Stop on the first build error instead of using build_app keep-going mode. */
  noKeepGoing?: boolean;

  /** Request dSYM generation. Defaults to true for trace-ready builds. */
  symbolsRequired?: boolean;

  /** Require `symbolication_status: "ready"` before installing. */
  requireReadySymbols?: boolean;

  /** Stable run id used when deriving the default output directory. */
  runId?: string;

  /** Directory where build/install logs and summaries are written. */
  outputDir?: string;

  /** Timeout passed to `xcrun devicectl device install app`. */
  installTimeoutSeconds?: number;
}

/** One compile diagnostic reported by build_app.py. */
export interface FlowIosBuildError {
  file?: string;
  line?: number;
  column?: number;
  message?: string;
}

/** JSON payload returned by flow-ios-dev build_app.py. */
export interface FlowIosBuildOutput {
  success?: boolean;
  action?: string;
  error?: string;
  errors?: FlowIosBuildError[];
  error_count?: number;
  truncated?: boolean;
  app_path?: string;
  log_file?: string;
  build_config?: Record<string, unknown>;
  dsym_path?: string;
  exported_dsym_path?: string;
  dsym_paths?: string[];
  symbolication_status?: string;
  dsym_metadata?: FlowIosDsymMetadata[];
  repository_root?: string;
  project_root?: string;
  build_root?: string;
}

/** Metadata reported for one generated dSYM bundle. */
export interface FlowIosDsymMetadata {
  path?: string;
  bundle_name?: string;
  binary_name?: string;
  uuids?: string[];
  dwarf_path?: string;
}

/** Result returned by the build-install Workflow. */
export interface IosBuildInstallResult {
  success: boolean;
  repositoryRoot: string;
  projectRoot: string;
  buildRoot: string;
  udid: string;
  outputDir: string;
  appPath: string;
  dsymPath: string;
  dsymPaths: string[];
  /** dSYM for the business framework that owns most flow_iOS code. */
  businessDsymPath: string;
  /** Directory recursively consumed by xctrace symbolicate. */
  symbolSearchPath: string;
  exportedDsymPath: string;
  symbolicationStatus: string;
  buildReused: boolean;
  buildCommand: string[];
  installCommand: string[];
  buildExitCode: number;
  installExitCode: number;
  buildSummaryPath: string;
  buildStdoutPath: string;
  buildStderrPath: string;
  buildLogFile: string;
  installJsonPath: string;
  installLogPath: string;
  buildOutput: FlowIosBuildOutput;
  installOutput: unknown;
}
