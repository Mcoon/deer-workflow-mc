export type RegressionPriority = "P0" | "P1" | "P2";

export type RegressionVerdict = "pass" | "fail" | "blocked" | "needs_review";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Bounds extends Point {
  readonly width: number;
  readonly height: number;
}

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface NormalizedBounds extends NormalizedPoint {
  readonly width: number;
  readonly height: number;
}

export interface UiSelector {
  readonly accessibilityId?: string;
  readonly label?: string;
  readonly text?: string;
  readonly textContains?: string;
  readonly value?: string;
  readonly role?: string;
}

export interface DeviceProfile {
  readonly schemaVersion: "ios-device-profile/v1";
  readonly profileId: string;
  readonly platform: "ios";
  readonly model?: string;
  readonly osVersion?: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly screenshotWidth?: number;
  readonly screenshotHeight?: number;
  readonly coordinateSpace: "mobilecli";
  readonly orientation: "portrait" | "landscape";
  readonly displayScale?: number;
  readonly updatedAt: string;
}

export interface ControlBinding {
  readonly deviceProfileId: string;
  readonly normalizedPoint: NormalizedPoint;
  readonly normalizedBounds?: NormalizedBounds;
  readonly observedAt: string;
  readonly source: "ui_dump" | "manual_hint";
}

export interface UiControl {
  readonly schemaVersion: "ios-ui-control/v1";
  readonly controlId: string;
  readonly pageId: string;
  readonly title: string;
  readonly role?: string;
  readonly selector: UiSelector;
  readonly bindings: readonly ControlBinding[];
  readonly updatedAt: string;
}

export interface UiPage {
  readonly schemaVersion: "ios-ui-page/v1";
  readonly pageId: string;
  readonly title: string;
  readonly bundleId: string;
  readonly fingerprint: string;
  readonly observedAt: string;
  readonly deviceProfileId: string;
  readonly screenshotPath: string;
  readonly uiDumpPath: string;
  readonly controlIds: readonly string[];
  readonly anchorControlIds: readonly string[];
}

export interface UiTransition {
  readonly schemaVersion: "ios-ui-transition/v1";
  readonly transitionId: string;
  readonly fromPageId: string;
  readonly toPageId: string;
  readonly actionId: string;
  readonly controlId?: string;
  readonly observedAt: string;
}

export type NavigationCategory =
  "navigation" | "selection" | "permission" | "mutation";

export type NavigationStatus = "active" | "candidate" | "stale" | "blocked";

export type NavigationEdgeAction =
  | {
      readonly type: "cold_launch";
      readonly bundleId?: string;
      readonly waitMs?: number;
    }
  | {
      readonly type: "tap";
      readonly controlId: string;
    };

export interface NavigationPagePolicy {
  readonly aliases?: readonly string[];
  readonly status?: NavigationStatus;
  readonly variants?: Readonly<Record<string, string>>;
}

export interface NavigationTransitionPolicy {
  readonly category?: NavigationCategory;
  readonly status?: NavigationStatus;
  readonly cost?: number;
  readonly reliability?: number;
  readonly settleMs?: number;
}

export interface NavigationManualEdge {
  readonly edgeId: string;
  readonly fromPageId: string;
  readonly toPageId: string;
  readonly category: NavigationCategory;
  readonly status: NavigationStatus;
  readonly action: NavigationEdgeAction;
  readonly cost?: number;
  readonly reliability?: number;
  readonly settleMs?: number;
  readonly notes?: string;
}

export interface NavigationPolicy {
  readonly schemaVersion: "ios-ui-navigation-policy/v1";
  readonly bundleId: string;
  readonly rootPageId: "cold_start";
  readonly defaultStartPageId: string;
  readonly pagePolicies?: Readonly<Record<string, NavigationPagePolicy>>;
  readonly transitionPolicies?: Readonly<
    Record<string, NavigationTransitionPolicy>
  >;
  readonly manualEdges?: readonly NavigationManualEdge[];
}

export interface NavigationGraphNode {
  readonly pageId: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly status: NavigationStatus;
  readonly fingerprint?: string;
  readonly anchorControlIds: readonly string[];
  readonly controlIds: readonly string[];
  readonly deviceProfileId?: string;
  readonly screenshotPath?: string;
  readonly uiDumpPath?: string;
  readonly variants: Readonly<Record<string, string>>;
}

export interface NavigationGraphEdge {
  readonly edgeId: string;
  readonly fromPageId: string;
  readonly toPageId: string;
  readonly category: NavigationCategory;
  readonly status: NavigationStatus;
  readonly action: NavigationEdgeAction;
  readonly preconditions: readonly RegressionAssertion[];
  readonly postconditions: readonly RegressionAssertion[];
  readonly cost: number;
  readonly reliability: number;
  readonly settleMs: number;
  readonly observedAt?: string;
  readonly notes?: string;
}

export interface NavigationGraph {
  readonly schemaVersion: "ios-ui-navigation-graph/v1";
  readonly bundleId: string;
  readonly generatedAt: string;
  readonly rootPageId: "cold_start";
  readonly defaultStartPageId: string;
  readonly nodes: readonly NavigationGraphNode[];
  readonly edges: readonly NavigationGraphEdge[];
}

export interface PageIndexEntry {
  readonly pageId: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly status: NavigationStatus;
}

export interface PageIndex {
  readonly schemaVersion: "ios-ui-page-index/v1";
  readonly bundleId: string;
  readonly generatedAt: string;
  readonly pages: readonly PageIndexEntry[];
}

export interface NavigationPlan {
  readonly schemaVersion: "ios-ui-navigation-plan/v1";
  readonly sourcePageId: string;
  readonly targetPageId: string;
  readonly allowedCategories: readonly NavigationCategory[];
  readonly totalCost: number;
  readonly edges: readonly NavigationGraphEdge[];
}

export interface AppRegressionManifest {
  readonly schemaVersion: "ios-app-regression-manifest/v1";
  readonly bundleId: string;
  readonly appName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly uiMap: {
    readonly pagesDirectory: string;
    readonly controlsPath: string;
    readonly transitionsPath: string;
    readonly deviceProfilesPath: string;
    readonly navigationPolicyPath?: string;
    readonly graphPath?: string;
    readonly pageIndexPath?: string;
    readonly mapHtmlPath?: string;
  };
  readonly casesDirectory: string;
  readonly compiledDirectory: string;
  readonly baselinesDirectory: string;
}

export interface UiControlCollection {
  readonly schemaVersion: "ios-ui-controls/v1";
  readonly bundleId: string;
  readonly updatedAt: string;
  readonly controls: readonly UiControl[];
}

export interface UiTransitionCollection {
  readonly schemaVersion: "ios-ui-transitions/v1";
  readonly bundleId: string;
  readonly updatedAt: string;
  readonly transitions: readonly UiTransition[];
}

export interface DeviceProfileCollection {
  readonly schemaVersion: "ios-device-profiles/v1";
  readonly bundleId: string;
  readonly updatedAt: string;
  readonly profiles: readonly DeviceProfile[];
}

export type RegressionAssertion =
  | {
      readonly type: "page";
      readonly pageId: string;
    }
  | {
      readonly type: "control_visible";
      readonly pageId: string;
      readonly controlId: string;
    }
  | {
      readonly type: "text_visible";
      readonly text: string;
    }
  | {
      readonly type: "foreground_bundle";
      readonly bundleId?: string;
    }
  | {
      readonly type: "ui_not_empty";
    };

export interface RegressionActionBase {
  readonly actionId: string;
  readonly description?: string;
  readonly assertBefore?: readonly RegressionAssertion[];
  readonly assertAfter?: readonly RegressionAssertion[];
}

export type RegressionAction =
  | (RegressionActionBase & {
      readonly type: "launch_app";
      readonly bundleId?: string;
    })
  | (RegressionActionBase & {
      readonly type: "terminate_app";
      readonly bundleId?: string;
    })
  | (RegressionActionBase & {
      readonly type: "tap";
      readonly pageId: string;
      readonly target: {
        readonly controlId?: string;
        readonly point?: Point;
        readonly normalizedPoint?: NormalizedPoint;
      };
    })
  | (RegressionActionBase & {
      readonly type: "type_text";
      readonly text: string;
    })
  | (RegressionActionBase & {
      readonly type: "swipe";
      readonly from: Point;
      readonly to: Point;
      readonly durationMs?: number;
    })
  | (RegressionActionBase & {
      readonly type: "button";
      readonly button: string;
    })
  | (RegressionActionBase & {
      readonly type: "wait";
      readonly durationMs: number;
    })
  | (RegressionActionBase & {
      readonly type: "snapshot";
      readonly pageId: string;
      readonly title: string;
      readonly anchorControlIds?: readonly string[];
    })
  | (RegressionActionBase & {
      readonly type: "navigate";
      readonly targetPageId?: string;
      readonly targetPage?: string;
      readonly sourcePageId?: "cold_start";
      readonly allowCategories?: readonly NavigationCategory[];
    });

export interface RegressionCase {
  readonly caseId: string;
  readonly title: string;
  readonly priority: RegressionPriority;
  readonly tags: readonly string[];
  readonly preconditions: readonly RegressionAssertion[];
  readonly actions: readonly RegressionAction[];
  readonly expected: readonly RegressionAssertion[];
}

export interface RegressionCaseSet {
  readonly schemaVersion: "ios-regression-case-set/v1";
  readonly caseSetId: string;
  readonly title: string;
  readonly bundleId: string;
  readonly generatedAt: string;
  readonly source: {
    readonly kind: "recording" | "requirements" | "mixed" | "manual";
    readonly recordingPath?: string;
    readonly requirementsPath?: string;
  };
  readonly cases: readonly RegressionCase[];
}

export interface UiElement {
  readonly role?: string;
  readonly accessibilityId?: string;
  readonly label?: string;
  readonly text?: string;
  readonly value?: string;
  readonly bounds?: Bounds;
}

export interface CaseValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface ActionExecution {
  readonly actionId: string;
  readonly type: RegressionAction["type"];
  readonly success: boolean;
  readonly exitCode: number;
  readonly command?: readonly string[];
  readonly message?: string;
  readonly screenshotPath?: string;
  readonly uiDumpPath?: string;
}

export interface CaseExecution {
  readonly caseId: string;
  readonly title: string;
  readonly verdict: RegressionVerdict;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly actions: readonly ActionExecution[];
  readonly issues: readonly string[];
  readonly evidenceVideoPath?: string;
}
