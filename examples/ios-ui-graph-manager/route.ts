import type { AppGraph, RouteStep } from "./types";

export function planRoute(
  graph: AppGraph,
  fromSceneId: string,
  toSceneId: string,
): RouteStep[] | null {
  if (fromSceneId === toSceneId) return [];

  const adjacency = buildAdjacency(graph);
  const distances = new Map<string, number>();
  const previous = new Map<string, string>();
  const previousOp = new Map<string, string>();
  const unvisited = new Set<string>();

  for (const sceneId of Object.keys(graph.scenes)) {
    distances.set(sceneId, Infinity);
    unvisited.add(sceneId);
  }
  distances.set(fromSceneId, 0);

  while (unvisited.size > 0) {
    let current: string | null = null;
    let minDist = Infinity;
    for (const id of unvisited) {
      const d = distances.get(id) ?? Infinity;
      if (d < minDist) {
        minDist = d;
        current = id;
      }
    }

    if (current === null || current === toSceneId) break;
    if (minDist === Infinity) break;

    unvisited.delete(current);

    const neighbors = adjacency.get(current) ?? [];
    for (const { neighbor, operatorId, cost } of neighbors) {
      if (!unvisited.has(neighbor)) continue;
      const alt = minDist + cost;
      if (alt < (distances.get(neighbor) ?? Infinity)) {
        distances.set(neighbor, alt);
        previous.set(neighbor, current);
        previousOp.set(neighbor, operatorId);
      }
    }
  }

  if (!previous.has(toSceneId) && fromSceneId !== toSceneId) {
    return null;
  }

  const path: string[] = [];
  let current: string | undefined = toSceneId;
  while (current && current !== fromSceneId) {
    path.unshift(current);
    current = previous.get(current);
  }

  const steps: RouteStep[] = [];
  for (const next of path) {
    const opId = previousOp.get(next);
    if (opId) {
      const op = graph.operators[opId];
      if (op) {
        steps.push({
          operatorId: op.operatorId,
          fromSceneId: op.fromSceneId,
          toSceneId: op.toSceneId,
          operation: op.operation,
        });
      }
    }
  }

  return steps.length > 0 ? steps : null;
}

function buildAdjacency(
  graph: AppGraph,
): Map<string, Array<{ neighbor: string; operatorId: string; cost: number }>> {
  const adj = new Map<
    string,
    Array<{ neighbor: string; operatorId: string; cost: number }>
  >();
  for (const [id] of Object.entries(graph.scenes)) {
    adj.set(id, []);
  }
  for (const op of Object.values(graph.operators)) {
    if (
      op.toSceneId &&
      op.status !== "stale" &&
      op.status !== "blocked" &&
      op.status !== "disabled" &&
      !["stale", "blocked", "disabled"].includes(
        graph.scenes[op.fromSceneId]?.status ?? "disabled",
      ) &&
      !["stale", "blocked", "disabled"].includes(
        graph.scenes[op.toSceneId]?.status ?? "disabled",
      ) &&
      ["navigation", "interaction"].includes(op.risk ?? "interaction")
    ) {
      const list = adj.get(op.fromSceneId);
      if (list) {
        list.push({
          neighbor: op.toSceneId,
          operatorId: op.operatorId,
          cost: operatorTraversalCost(op),
        });
      }
    }
  }
  return adj;
}

function operatorTraversalCost(
  operator: AppGraph["operators"][string],
): number {
  const statusCost =
    operator.status === "verified"
      ? 1
      : operator.status === "candidate"
        ? 3
        : 5;
  const trustCost =
    operator.execution?.tier === "fast"
      ? -0.25
      : operator.execution?.tier === "guarded"
        ? 0.5
        : 0;
  const attempts = operator.executionStats.pass + operator.executionStats.fail;
  const failureCost =
    attempts > 0 ? (operator.executionStats.fail / attempts) * 2 : 0.5;
  return Math.max(0.25, statusCost + trustCost + failureCost);
}
