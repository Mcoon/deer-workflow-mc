import type {
  NavigationCategory,
  NavigationGraph,
  NavigationGraphEdge,
  NavigationGraphNode,
  NavigationPlan,
  NavigationPolicy,
  NavigationStatus,
  PageIndex,
  RegressionAction,
  UiControl,
  UiPage,
  UiTransition,
} from "./types";

const DEFAULT_EDGE_COST = 1;
const DEFAULT_RELIABILITY = 0.5;
const DEFAULT_SETTLE_MS = 700;

export interface PageResolution {
  readonly pageId: string | null;
  readonly candidates: readonly string[];
  readonly reason: "page_id" | "alias" | "fuzzy" | "ambiguous" | "not_found";
}

export function buildNavigationGraph(options: {
  bundleId: string;
  pages: readonly UiPage[];
  controls: readonly UiControl[];
  transitions: readonly UiTransition[];
  policy: NavigationPolicy;
  generatedAt?: string;
}): NavigationGraph {
  if (options.policy.bundleId !== options.bundleId) {
    throw new TypeError(
      `Navigation policy bundleId ${options.policy.bundleId} does not match ${options.bundleId}.`,
    );
  }

  const pageIds = new Set(options.pages.map((page) => page.pageId));
  const controls = new Map(
    options.controls.map((control) => [control.controlId, control]),
  );
  if (!pageIds.has(options.policy.defaultStartPageId)) {
    throw new TypeError(
      `Navigation default start page does not exist: ${options.policy.defaultStartPageId}.`,
    );
  }

  const nodes: NavigationGraphNode[] = [
    {
      pageId: options.policy.rootPageId,
      title: "冷启动",
      aliases: ["冷启动", "cold start", "cold_start"],
      status: "active",
      anchorControlIds: [],
      controlIds: [],
      variants: {},
    },
    ...options.pages.map((page) => {
      const pagePolicy = options.policy.pagePolicies?.[page.pageId];
      return {
        pageId: page.pageId,
        title: page.title,
        aliases: uniqueStrings([
          page.pageId,
          page.title,
          ...(pagePolicy?.aliases ?? []),
        ]),
        status: pagePolicy?.status ?? "active",
        fingerprint: page.fingerprint,
        anchorControlIds: page.anchorControlIds,
        controlIds: page.controlIds,
        deviceProfileId: page.deviceProfileId,
        screenshotPath: page.screenshotPath,
        uiDumpPath: page.uiDumpPath,
        variants: pagePolicy?.variants ?? {},
      };
    }),
  ];

  const edges = new Map<string, NavigationGraphEdge>();
  for (const transition of options.transitions) {
    if (
      !pageIds.has(transition.fromPageId) ||
      !pageIds.has(transition.toPageId)
    ) {
      continue;
    }
    if (!transition.controlId || !controls.has(transition.controlId)) {
      continue;
    }
    const transitionPolicy =
      options.policy.transitionPolicies?.[transition.transitionId];
    const edge: NavigationGraphEdge = {
      edgeId: transition.transitionId,
      fromPageId: transition.fromPageId,
      toPageId: transition.toPageId,
      category: transitionPolicy?.category ?? "navigation",
      status: transitionPolicy?.status ?? "candidate",
      action: {
        type: "tap",
        controlId: transition.controlId,
      },
      preconditions: [{ type: "page", pageId: transition.fromPageId }],
      postconditions: [{ type: "page", pageId: transition.toPageId }],
      cost: boundedPositive(transitionPolicy?.cost, DEFAULT_EDGE_COST),
      reliability: boundedReliability(
        transitionPolicy?.reliability,
        DEFAULT_RELIABILITY,
      ),
      settleMs: boundedNonNegative(
        transitionPolicy?.settleMs,
        DEFAULT_SETTLE_MS,
      ),
      observedAt: transition.observedAt,
    };
    edges.set(edge.edgeId, edge);
  }

  for (const manual of options.policy.manualEdges ?? []) {
    if (
      manual.fromPageId !== options.policy.rootPageId &&
      !pageIds.has(manual.fromPageId)
    ) {
      throw new TypeError(
        `Navigation manual edge ${manual.edgeId} has unknown source ${manual.fromPageId}.`,
      );
    }
    if (!pageIds.has(manual.toPageId)) {
      throw new TypeError(
        `Navigation manual edge ${manual.edgeId} has unknown target ${manual.toPageId}.`,
      );
    }
    if (
      manual.action.type === "tap" &&
      !controls.has(manual.action.controlId)
    ) {
      throw new TypeError(
        `Navigation manual edge ${manual.edgeId} has unknown control ${manual.action.controlId}.`,
      );
    }
    edges.set(manual.edgeId, {
      edgeId: manual.edgeId,
      fromPageId: manual.fromPageId,
      toPageId: manual.toPageId,
      category: manual.category,
      status: manual.status,
      action: manual.action,
      preconditions:
        manual.fromPageId === options.policy.rootPageId
          ? []
          : [{ type: "page", pageId: manual.fromPageId }],
      postconditions: [{ type: "page", pageId: manual.toPageId }],
      cost: boundedPositive(manual.cost, DEFAULT_EDGE_COST),
      reliability: boundedReliability(manual.reliability, 1),
      settleMs: boundedNonNegative(manual.settleMs, DEFAULT_SETTLE_MS),
      notes: manual.notes,
    });
  }

  return {
    schemaVersion: "ios-ui-navigation-graph/v1",
    bundleId: options.bundleId,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    rootPageId: options.policy.rootPageId,
    defaultStartPageId: options.policy.defaultStartPageId,
    nodes: nodes.sort((left, right) => left.pageId.localeCompare(right.pageId)),
    edges: [...edges.values()].sort((left, right) =>
      left.edgeId.localeCompare(right.edgeId),
    ),
  };
}

export function buildPageIndex(graph: NavigationGraph): PageIndex {
  return {
    schemaVersion: "ios-ui-page-index/v1",
    bundleId: graph.bundleId,
    generatedAt: graph.generatedAt,
    pages: graph.nodes
      .filter((node) => node.pageId !== graph.rootPageId)
      .map((node) => ({
        pageId: node.pageId,
        title: node.title,
        aliases: node.aliases,
        status: node.status,
      })),
  };
}

export function resolvePageReference(
  reference: string,
  index: PageIndex,
): PageResolution {
  const normalized = normalizeReference(reference);
  if (!normalized) {
    return { pageId: null, candidates: [], reason: "not_found" };
  }

  const byId = index.pages.find(
    (page) => normalizeReference(page.pageId) === normalized,
  );
  if (byId) {
    return {
      pageId: byId.pageId,
      candidates: [byId.pageId],
      reason: "page_id",
    };
  }

  const exactAliases = index.pages.filter((page) =>
    [page.title, ...page.aliases].some(
      (alias) => normalizeReference(alias) === normalized,
    ),
  );
  if (exactAliases.length === 1) {
    return {
      pageId: exactAliases[0]!.pageId,
      candidates: [exactAliases[0]!.pageId],
      reason: "alias",
    };
  }
  if (exactAliases.length > 1) {
    return {
      pageId: null,
      candidates: exactAliases.map((page) => page.pageId),
      reason: "ambiguous",
    };
  }

  const fuzzy = index.pages.filter((page) =>
    [page.pageId, page.title, ...page.aliases].some((alias) => {
      const candidate = normalizeReference(alias);
      return candidate.includes(normalized) || normalized.includes(candidate);
    }),
  );
  if (fuzzy.length === 1) {
    return {
      pageId: fuzzy[0]!.pageId,
      candidates: [fuzzy[0]!.pageId],
      reason: "fuzzy",
    };
  }
  return {
    pageId: null,
    candidates: fuzzy.map((page) => page.pageId),
    reason: fuzzy.length > 1 ? "ambiguous" : "not_found",
  };
}

export function planNavigation(options: {
  graph: NavigationGraph;
  sourcePageId?: string;
  targetPageId: string;
  allowCategories?: readonly NavigationCategory[];
}): NavigationPlan {
  const sourcePageId = options.sourcePageId ?? options.graph.rootPageId;
  const allowedCategories = uniqueStrings(
    options.allowCategories ?? ["navigation"],
  ) as NavigationCategory[];
  const nodes = new Map(options.graph.nodes.map((node) => [node.pageId, node]));
  const source = nodes.get(sourcePageId);
  const target = nodes.get(options.targetPageId);
  if (!source || source.status !== "active") {
    throw new Error(`Navigation source page is not active: ${sourcePageId}.`);
  }
  if (!target || target.status !== "active") {
    throw new Error(
      `Navigation target page is not active: ${options.targetPageId}.`,
    );
  }

  const activeEdges = options.graph.edges.filter(
    (edge) =>
      edge.status === "active" &&
      allowedCategories.includes(edge.category) &&
      nodes.get(edge.fromPageId)?.status === "active" &&
      nodes.get(edge.toPageId)?.status === "active",
  );
  const distances = new Map<string, number>([[sourcePageId, 0]]);
  const previous = new Map<string, NavigationGraphEdge>();
  const pending = new Set(nodes.keys());

  while (pending.size > 0) {
    let current: string | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const pageId of pending) {
      const distance = distances.get(pageId) ?? Number.POSITIVE_INFINITY;
      if (distance < currentDistance) {
        current = pageId;
        currentDistance = distance;
      }
    }
    if (current === null || !Number.isFinite(currentDistance)) {
      break;
    }
    pending.delete(current);
    if (current === options.targetPageId) {
      break;
    }
    for (const edge of activeEdges.filter(
      (candidate) => candidate.fromPageId === current,
    )) {
      if (!pending.has(edge.toPageId)) {
        continue;
      }
      const nextDistance = currentDistance + navigationWeight(edge);
      if (
        nextDistance <
        (distances.get(edge.toPageId) ?? Number.POSITIVE_INFINITY)
      ) {
        distances.set(edge.toPageId, nextDistance);
        previous.set(edge.toPageId, edge);
      }
    }
  }

  if (!distances.has(options.targetPageId)) {
    throw new Error(
      `No active navigation path from ${sourcePageId} to ${options.targetPageId} for categories: ${allowedCategories.join(", ")}.`,
    );
  }

  const edges: NavigationGraphEdge[] = [];
  let cursor = options.targetPageId;
  while (cursor !== sourcePageId) {
    const edge = previous.get(cursor);
    if (!edge) {
      throw new Error(
        `Navigation path reconstruction failed at page ${cursor}.`,
      );
    }
    edges.unshift(edge);
    cursor = edge.fromPageId;
  }

  return {
    schemaVersion: "ios-ui-navigation-plan/v1",
    sourcePageId,
    targetPageId: options.targetPageId,
    allowedCategories,
    totalCost: edges.reduce((total, edge) => total + navigationWeight(edge), 0),
    edges,
  };
}

export function compileNavigationPlanActions(options: {
  plan: NavigationPlan;
  bundleId: string;
  actionIdPrefix?: string;
}): RegressionAction[] {
  const prefix = options.actionIdPrefix ?? "navigate";
  const actions: RegressionAction[] = [];
  for (const [index, edge] of options.plan.edges.entries()) {
    const sequence = String(index + 1).padStart(2, "0");
    if (edge.action.type === "cold_launch") {
      const bundleId = edge.action.bundleId ?? options.bundleId;
      actions.push(
        {
          actionId: `${prefix}-${sequence}-terminate`,
          type: "terminate_app",
          bundleId,
        },
        {
          actionId: `${prefix}-${sequence}-launch`,
          type: "launch_app",
          bundleId,
        },
        {
          actionId: `${prefix}-${sequence}-wait`,
          type: "wait",
          durationMs: edge.action.waitMs ?? edge.settleMs,
        },
        {
          actionId: `${prefix}-${sequence}-verify-${edge.toPageId}`,
          type: "snapshot",
          pageId: edge.toPageId,
          title: `导航到 ${edge.toPageId}`,
          assertAfter: edge.postconditions,
        },
      );
      continue;
    }
    actions.push(
      {
        actionId: `${prefix}-${sequence}-${edge.edgeId}`,
        type: "tap",
        pageId: edge.fromPageId,
        target: { controlId: edge.action.controlId },
        assertBefore: edge.preconditions,
      },
      {
        actionId: `${prefix}-${sequence}-wait-${edge.toPageId}`,
        type: "wait",
        durationMs: edge.settleMs,
      },
      {
        actionId: `${prefix}-${sequence}-verify-${edge.toPageId}`,
        type: "snapshot",
        pageId: edge.toPageId,
        title: `导航到 ${edge.toPageId}`,
        assertAfter: edge.postconditions,
      },
    );
  }
  return actions;
}

function navigationWeight(edge: NavigationGraphEdge): number {
  return edge.cost + (1 - edge.reliability) * 10;
}

function normalizeReference(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[\s_.:/\\-]+/g, "");
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function boundedNonNegative(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function boundedReliability(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

export function isNavigationStatus(value: string): value is NavigationStatus {
  return ["active", "candidate", "stale", "blocked"].includes(value);
}
