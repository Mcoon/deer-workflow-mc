import type { AppGraph, GraphPatch } from "./types";
import { validateGraph } from "./validate";

export interface PatchApplication {
  readonly success: boolean;
  readonly newRevision: number;
  readonly conflicts: string[];
  readonly rejected: string[];
  readonly graph: AppGraph;
}

export function applyPatch(
  graph: AppGraph,
  patch: GraphPatch,
): PatchApplication {
  const conflicts: string[] = [];
  const rejected: string[] = [];

  if (patch.graphId !== graph.graphId) {
    return {
      success: false,
      newRevision: graph.revision,
      conflicts: [],
      rejected: [
        `graphId mismatch: patch "${patch.graphId}" vs graph "${graph.graphId}"`,
      ],
      graph,
    };
  }

  if (patch.baseRevision !== graph.revision) {
    conflicts.push(
      `baseRevision ${patch.baseRevision} does not match current revision ${graph.revision}. Patch must be regenerated against latest.`,
    );
    return {
      success: false,
      newRevision: graph.revision,
      conflicts,
      rejected,
      graph,
    };
  }

  const updated = JSON.parse(JSON.stringify(graph)) as Record<string, unknown>;
  if (patch.appVersion !== undefined) {
    updated.appVersion = patch.appVersion;
  }

  if (patch.scenes) {
    for (const [sceneId, patchScene] of Object.entries(patch.scenes)) {
      const scenes = updated.scenes as Record<string, Record<string, unknown>>;
      if (scenes[sceneId]) {
        Object.assign(scenes[sceneId], patchScene);
      } else {
        scenes[sceneId] = patchScene as Record<string, unknown>;
      }
    }
  }

  if (patch.operators) {
    for (const [opId, patchOp] of Object.entries(patch.operators)) {
      const operators = updated.operators as Record<
        string,
        Record<string, unknown>
      >;
      if (operators[opId]) {
        Object.assign(operators[opId], patchOp);
      } else {
        operators[opId] = patchOp as Record<string, unknown>;
      }
    }
  }

  if (patch.tasks) {
    for (const [taskId, patchTask] of Object.entries(patch.tasks)) {
      const tasks = updated.tasks as Record<string, Record<string, unknown>>;
      if (tasks[taskId]) {
        Object.assign(tasks[taskId], patchTask);
      } else {
        tasks[taskId] = patchTask as Record<string, unknown>;
      }
    }
  }

  const validation = validateGraph(updated as unknown as AppGraph);
  if (!validation.valid) {
    rejected.push(...validation.errors);
    return {
      success: false,
      newRevision: graph.revision,
      conflicts,
      rejected,
      graph,
    };
  }

  (updated as Record<string, unknown>).revision = graph.revision + 1;
  (updated as Record<string, unknown>).updatedAt = new Date().toISOString();

  return {
    success: true,
    newRevision: graph.revision + 1,
    conflicts,
    rejected,
    graph: updated as unknown as AppGraph,
  };
}
