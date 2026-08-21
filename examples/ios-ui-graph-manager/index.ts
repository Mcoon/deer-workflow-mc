export type {
  AppGraph,
  Binding,
  DeviceProfile,
  Element,
  ExecutionStats,
  ExecutionTrust,
  ExecutionTier,
  GraphEntityStatus,
  GraphPatch,
  Operator,
  Operation,
  PatchResult,
  PatchValidation,
  ReferenceAsset,
  ResetStrategy,
  ResetStep,
  RouteStep,
  Scene,
  SelectorEntry,
  StructuredEffect,
  Task,
  TaskOracle,
  TaskStep,
} from "./types";

export { migrateV1ToV2 } from "./migrate";
export { validateGraph, type ValidationResult } from "./validate";
export { applyPatch, type PatchApplication } from "./patch";
export {
  readGraph,
  readSceneSubtree,
  writeGraphAtomic,
  graphExists,
  getGraphDir,
  getRevisionsDir,
  getPatchesDir,
  getIndexesDir,
} from "./store";
export {
  getReferenceAssetsDir,
  isManagedReferenceAssetPath,
  persistGraphReferenceAssets,
  promoteReferenceAsset,
  resolveGraphAssetPath,
  retainValidReferenceAssets,
} from "./assets";
export {
  rebuildAllIndexes,
  buildSceneSemanticIndex,
  buildAdjacencyIndex,
  buildElementBySceneIndex,
  buildOperatorByElementIndex,
  buildTaskIntentIndex,
  type SceneSemanticIndex,
  type AdjacencyIndex,
  type ElementBySceneIndex,
  type OperatorByElementIndex,
  type TaskIntentIndex,
} from "./indexes";
export { planRoute } from "./route";
export {
  findScene,
  findBestScene,
  matchTask,
  findBestTask,
  type SceneMatch,
  type TaskMatch,
} from "./match";

import type { AppGraph, GraphPatch } from "./types";
import { readGraph, writeGraphAtomic } from "./store";
import { applyPatch } from "./patch";
import { rebuildAllIndexes } from "./indexes";
import { validateGraph } from "./validate";
import { persistGraphReferenceAssets } from "./assets";

export async function loadGraph(graphPath: string): Promise<AppGraph> {
  return readGraph(graphPath);
}

export async function saveGraph(
  graphPath: string,
  graph: AppGraph,
): Promise<void> {
  const persistedGraph = await persistGraphReferenceAssets(graphPath, graph);
  const validation = validateGraph(persistedGraph);
  if (!validation.valid) {
    throw new Error(`Graph validation failed: ${validation.errors.join("; ")}`);
  }
  await writeGraphAtomic(graphPath, persistedGraph);
  await rebuildAllIndexes(persistedGraph, graphPath);
}

export async function applyAndSave(
  graphPath: string,
  patch: GraphPatch,
): Promise<{
  success: boolean;
  newRevision: number;
  conflicts: string[];
  rejected: string[];
}> {
  const graph = await readGraph(graphPath);
  const result = applyPatch(graph, patch);
  if (result.success) {
    await saveGraph(graphPath, result.graph);
  }
  return {
    success: result.success,
    newRevision: result.newRevision,
    conflicts: result.conflicts,
    rejected: result.rejected,
  };
}
