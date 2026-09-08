/** Input accepted by the iOS Cosign and BitSky Install Workflow. */
export interface IosCosignBitskyInstallInput {
  /** Git repository root. Defaults to `projectRoot`. */
  repositoryRoot?: string;

  /** iOS project root containing Scripts/cosign.sh and .bitsky/bitsky.yaml. */
  projectRoot: string;

  /** Real-device UDID forwarded to cosign. */
  udid: string;

  /** App target prepared by bitsky_install. Defaults to Grace. */
  target?: "Grace" | "Cici";

  /** BitSky configuration prepared by bitsky_install. Defaults to Debug. */
  configuration?: "Debug" | "Inhouse" | "InhouseRelease" | "Adhoc" | "Release";

  /** Optional Xcode path; auto-detects Xcode_26.app, then Xcode.app. */
  developerDir?: string;

  /** Override for the repository-native cosign script. */
  cosignScriptPath?: string;

  /** Stable run id used when deriving the default output directory. */
  runId?: string;

  /** Directory where command stdout, stderr, and summary are written. */
  outputDir?: string;
}

/** Result returned by the iOS Cosign and BitSky Install Workflow. */
export interface IosCosignBitskyInstallResult {
  success: boolean;
  repositoryRoot: string;
  projectRoot: string;
  target: "Grace" | "Cici";
  configuration: string;
  developerDir: string;
  udid: string;
  outputDir: string;
  cosignCommand: string[];
  bundleInstallCommand: string[];
  bitskyInstallCommand: string[];
  cosignExitCode: number;
  bundleInstallExitCode: number;
  bitskyInstallExitCode: number;
  cosignStdoutPath: string;
  cosignStderrPath: string;
  bundleInstallStdoutPath: string;
  bundleInstallStderrPath: string;
  bitskyInstallStdoutPath: string;
  bitskyInstallStderrPath: string;
  summaryPath: string;
}
