/** Input accepted by the iOS Build and Install Workflow. */
export interface IosBuildInstallInput {
  /** Git repository root. Defaults to `projectRoot` for standalone repositories. */
  repositoryRoot?: string;

  /** iOS source root containing Modules/, Flow/, Podfile, and .bitsky/. */
  projectRoot: string;

  /** BitSky build root. Defaults to `projectRoot`. */
  buildRoot?: string;

  /** Real-device UDID used for install-only devicectl deployment. */
  udid: string;

  /** Existing successful build summary to reuse instead of rebuilding. */
  existingBuildSummaryPath?: string;

  /** Skip building and install `<buildRoot>/.vscode-out/<target>.app`. */
  reuseExistingArtifacts?: boolean;

  /** Flow app target. Defaults to Grace. */
  target?: "Grace" | "Cici";

  /** BitSky build configuration. Defaults to Debug. */
  mode?: "Debug" | "Inhouse" | "InhouseRelease" | "Adhoc" | "Release";

  /** Generate dSYM output. Defaults to true for trace-ready builds. */
  symbolsRequired?: boolean;

  /** Require a UUID-matched main App dSYM before installing. */
  requireReadySymbols?: boolean;

  /** Keep compiling independent actions after an error. Defaults to false. */
  keepGoing?: boolean;

  /** Deprecated compatibility switch. When true, keeps fail-fast behavior. */
  noKeepGoing?: boolean;

  /** Business binary used by attach-trace source coverage checks. */
  businessBinary?: string;

  /** Optional full Xcode Developer directory exported as DEVELOPER_DIR. */
  developerDir?: string;

  /** Stable run id used when deriving the workflow diagnostics directory. */
  runId?: string;

  /** Directory where workflow logs and summaries are written. */
  outputDir?: string;

  /** Timeout passed to `xcrun devicectl device install app`. */
  installTimeoutSeconds?: number;
}

export interface FlowIosBuildError {
  file?: string;
  line?: number;
  column?: number;
  message?: string;
}

/** Normalized BitSky build output persisted for trace workflows. */
export interface FlowIosBuildOutput {
  success?: boolean;
  status?: string;
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
  symbol_search_path?: string;
  symbolication_status?: string;
  matched_uuids?: string[];
  business_dsym_path?: string;
  dsym_metadata?: FlowIosDsymMetadata[];
  repository_root?: string;
  project_root?: string;
  build_root?: string;
}

export interface FlowIosDsymMetadata {
  path?: string;
  bundle_name?: string;
  binary_name?: string;
  uuids?: string[];
  dwarf_path?: string;
}

export interface IosBuildInstallResult {
  success: boolean;
  repositoryRoot: string;
  projectRoot: string;
  buildRoot: string;
  developerDir: string;
  udid: string;
  target: "Grace" | "Cici";
  mode: string;
  outputDir: string;
  artifactDir: string;
  appPath: string;
  dsymPath: string;
  dsymPaths: string[];
  businessDsymPath: string;
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
  launchPerformed: false;
  buildOutput: FlowIosBuildOutput;
  installOutput: unknown;
}
