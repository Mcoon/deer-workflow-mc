import type {
  CaseExecution,
  RegressionPriority,
} from "../ios-regression-kit/types";

export interface IosFunctionalRegressionInput {
  readonly projectRoot?: string;
  readonly udid: string;
  readonly bundleId: string;
  readonly caseSetPath: string;
  readonly assetRoot?: string;
  readonly runId?: string;
  readonly outputDir?: string;
  readonly mobilecliPreflightPath?: string;
  readonly deviceProfileId?: string;
  readonly priorities?: readonly RegressionPriority[];
  readonly tags?: readonly string[];
  readonly caseIds?: readonly string[];
  readonly settleMs?: number;
  readonly stopOnFailure?: boolean;
  /**
   * Reserved until device management exposes one serialized recording session
   * that can also perform input without competing mobilecli processes.
   */
  readonly captureVideo?: boolean;
}

export interface IosFunctionalRegressionResult {
  readonly success: boolean;
  readonly outputDir: string;
  readonly caseSetPath: string;
  readonly reportPath: string;
  readonly summaryPath: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly needsReview: number;
  readonly cases: readonly CaseExecution[];
}
