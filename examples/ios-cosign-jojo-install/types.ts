/** Input accepted by the iOS Cosign and JoJo Install Workflow. */
export interface IosCosignJojoInstallInput {
  /** Git repository root. Defaults to `projectRoot`. */
  repositoryRoot?: string;

  /** iOS project root containing Scripts/cosign.sh and jojoInstall.sh. */
  projectRoot: string;

  /** Real-device UDID forwarded to cosign as --device-udid when provided. */
  udid?: string;

  /** App target passed to jojoInstall.sh. Defaults to Grace. */
  target?: "Grace" | "Cici";

  /** Override for the repository-native cosign script. */
  cosignScriptPath?: string;

  /** Override for the repository-native JoJo install script. */
  jojoInstallScriptPath?: string;

  /** Stable run id used when deriving the default output directory. */
  runId?: string;

  /** Directory where command stdout, stderr, and summary are written. */
  outputDir?: string;
}

/** Result returned by the iOS Cosign and JoJo Install Workflow. */
export interface IosCosignJojoInstallResult {
  success: boolean;
  repositoryRoot: string;
  projectRoot: string;
  target: "Grace" | "Cici";
  udid: string;
  outputDir: string;
  cosignCommand: string[];
  jojoInstallCommand: string[];
  cosignExitCode: number;
  jojoInstallExitCode: number;
  cosignStdoutPath: string;
  cosignStderrPath: string;
  jojoInstallStdoutPath: string;
  jojoInstallStderrPath: string;
  summaryPath: string;
}
