import type { AppGraphPlanOutput } from "../app-graph-plan/types";
import type { AppGraphExecOutput } from "../app-graph-exec/types";

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
  readonly model?: string;
  readonly agentTimeoutMs?: number;
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
