import type { AppGraphPlanOutput } from "../app-graph-plan/types";
import type { AgentFunction } from "@deerwork-ai/deer-workflow/agents";
import type {
  AppGraphExecInput,
  AppGraphExecOutput,
} from "../app-graph-exec/types";
import type { TaskOracle } from "../ios-ui-graph-manager/types";

export type CaseVerifyItem =
  | string
  | TaskOracle
  | {
      readonly type?: string;
      readonly kind?: string;
      readonly checkType?: string;
      readonly assertionId?: string;
      readonly value?: string | readonly string[];
      readonly values?: readonly string[];
      readonly text?: string;
      readonly expected?: string;
      readonly sceneId?: string;
      readonly scene_id?: string;
      readonly bundleId?: string;
      readonly bundle_id?: string;
      readonly maximumSsim?: number;
      readonly maximum_ssim?: number;
      readonly visible?: boolean;
    };

export type CaseVerifyInput =
  | CaseVerifyItem
  | readonly CaseVerifyItem[]
  | {
      readonly schemaVersion?: string;
      readonly status?: string;
      readonly source?: string;
      readonly reason?: string;
      readonly confidence?: number;
      readonly successfulExecutions?: number;
      readonly evidencePaths?: readonly string[];
      readonly updatedAt?: string;
      readonly oracle?: CaseVerifyItem;
      readonly condition?: CaseVerifyItem;
      readonly oracles?: readonly CaseVerifyItem[];
      readonly conditions?: readonly CaseVerifyItem[];
      readonly assertions?: readonly CaseVerifyItem[];
      readonly checks?: readonly CaseVerifyItem[];
    };

export interface CaseVerification {
  readonly supplied: boolean;
  readonly sources: readonly ("oracles" | "verify" | "expected")[];
  readonly oracles: readonly TaskOracle[];
  readonly issues: readonly string[];
  readonly compiler: "none" | "deterministic" | "agent";
  readonly reason?: string;
}

export interface StructuredCase {
  readonly case_id: string | number;
  readonly title: string;
  readonly goal?: string;
  readonly parameters?: Record<string, string>;
  readonly priority?: string;
  readonly tags?: string[];
  readonly path?: string[];
  readonly precondition?: string;
  readonly step: string;
  readonly expected: string;
  /** Machine-checkable acceptance criteria appended to the semantic Plan. */
  readonly oracles?: readonly TaskOracle[];
  /** Compatible verifier input normalized into Task Oracles before Exec. */
  readonly verify?: CaseVerifyInput;
}

export interface AppGraphAcceptInput {
  readonly case?: StructuredCase;
  readonly cases?: StructuredCase[];
  readonly caseSetPath?: string;
  readonly filterTags?: string[];
  readonly filterCaseIds?: (string | number)[];
  readonly graphPath?: string;
  readonly projectRoot?: string;
  readonly udid?: string;
  readonly deviceProfileId?: string;
  readonly outputDir?: string;
  readonly planOnly?: boolean;
  readonly allowDiscovery?: boolean;
  /** Test/runtime injection for the installed App version. */
  readonly runtimeAppVersion?: string;
  readonly model?: string;
  readonly agentTimeoutMs?: number;
  readonly agentCwd?: string;
  /** Test/runtime injection for verification compilation and Exec recovery. */
  readonly agentRunner?: AgentFunction;
  /** Test/host injection. CLI callers normally omit this. */
  readonly commandRunner?: AppGraphExecInput["commandRunner"];
}

export interface CaseRunResult {
  readonly caseId: string | number;
  readonly title: string;
  readonly priority?: string;
  readonly tags?: string[];
  readonly goal: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly caseOutputDir: string;
  readonly verdict: "pass" | "fail" | "needs_review" | "blocked";
  readonly planResult?: AppGraphPlanOutput;
  readonly execResult?: AppGraphExecOutput;
  readonly reason: string;
  readonly expected: string;
  readonly selectedPlanningGoal?: string;
  readonly warnings?: readonly string[];
  readonly verification?: CaseVerification;
  readonly verificationPath?: string;
  readonly evidencePaths: readonly string[];
}

export interface AppGraphAcceptResult {
  readonly success: boolean;
  readonly mode: "accept";
  readonly planOnly: boolean;
  readonly outputDir: string;
  readonly summary: {
    readonly total: number;
    readonly pass: number;
    readonly fail: number;
    readonly needsReview: number;
    readonly blocked: number;
  };
  readonly cases: readonly CaseRunResult[];
  readonly reportPath: string;
  readonly resultPath: string;
  readonly totalDurationMs: number;
}

export interface AppGraphAcceptFailure {
  readonly success: false;
  readonly mode: "accept_failure";
  readonly outputDir: string;
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly evidencePaths: readonly string[];
}

export type AppGraphAcceptOutput = AppGraphAcceptResult | AppGraphAcceptFailure;

export const meta = {
  name: "app-graph-accept",
  description:
    "Batch accept: run structured test cases through Plan→Exec and aggregate verdicts",
  phases: [
    { title: "Load" },
    { title: "Parse Cases" },
    { title: "Run Cases" },
    { title: "Aggregate" },
    { title: "Report" },
  ],
  exampleArgs: {
    caseSetPath: "/tmp/cases.json",
  },
};
