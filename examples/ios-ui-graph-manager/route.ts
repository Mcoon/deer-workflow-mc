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
    for (const { neighbor, operatorId } of neighbors) {
      if (!unvisited.has(neighbor)) continue;
      const alt = minDist + 1;
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
): Map<string, Array<{ neighbor: string; operatorId: string }>> {
  const adj = new Map<
    string,
    Array<{ neighbor: string; operatorId: string }>
  >();
  for (const [id] of Object.entries(graph.scenes)) {
    adj.set(id, []);
  }
  for (const op of Object.values(graph.operators)) {
    if (
      op.toSceneId &&
      op.status !== "stale" &&
      op.status !== "blocked" &&
      op.status !== "disabled"
    ) {
      const list = adj.get(op.fromSceneId);
      if (list) {
        list.push({ neighbor: op.toSceneId, operatorId: op.operatorId });
      }
    }
  }
  return adj;
}
