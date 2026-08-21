import { mkdir, writeFile } from "node:fs/promises";
import type { AppGraph } from "./types";
import { getIndexesDir } from "./store";

export interface SceneSemanticIndex {
  [sceneId: string]: {
    title: string;
    aliases: readonly string[];
    visualTextAnchors: readonly string[];
    status: string;
  };
}

export interface AdjacencyIndex {
  [sceneId: string]: string[];
}

export interface ElementBySceneIndex {
  [sceneId: string]: string[];
}

export interface OperatorByElementIndex {
  [elementId: string]: string[];
}

export interface TaskIntentIndex {
  [intent: string]: string[];
}

export function buildSceneSemanticIndex(graph: AppGraph): SceneSemanticIndex {
  const index: SceneSemanticIndex = {};
  for (const [id, scene] of Object.entries(graph.scenes)) {
    index[id] = {
      title: scene.title,
      aliases: scene.aliases,
      visualTextAnchors: scene.visualTextAnchors,
      status: scene.status,
    };
  }
  return index;
}

export function buildAdjacencyIndex(graph: AppGraph): AdjacencyIndex {
  const index: AdjacencyIndex = {};
  for (const [id] of Object.entries(graph.scenes)) {
    index[id] = [];
  }
  for (const op of Object.values(graph.operators)) {
    if (op.toSceneId) {
      const neighbors = index[op.fromSceneId];
      if (neighbors && !neighbors.includes(op.toSceneId)) {
        neighbors.push(op.toSceneId);
      }
    }
  }
  return index;
}

export function buildElementBySceneIndex(graph: AppGraph): ElementBySceneIndex {
  const index: ElementBySceneIndex = {};
  for (const [sceneId, scene] of Object.entries(graph.scenes)) {
    index[sceneId] = Object.keys(scene.elements);
  }
  return index;
}

export function buildOperatorByElementIndex(
  graph: AppGraph,
): OperatorByElementIndex {
  const index: OperatorByElementIndex = {};
  for (const op of Object.values(graph.operators)) {
    if (op.operation.elementId) {
      const elId = op.operation.elementId;
      if (!index[elId]) index[elId] = [];
      index[elId].push(op.operatorId);
    }
  }
  return index;
}

export function buildTaskIntentIndex(graph: AppGraph): TaskIntentIndex {
  const index: TaskIntentIndex = {};
  for (const task of Object.values(graph.tasks)) {
    for (const intent of task.intents) {
      if (!index[intent]) index[intent] = [];
      index[intent].push(task.taskId);
    }
  }
  return index;
}

export async function rebuildAllIndexes(
  graph: AppGraph,
  graphPath: string,
): Promise<void> {
  const dir = getIndexesDir(graphPath);
  await mkdir(dir, { recursive: true });

  await Promise.all([
    writeFile(
      `${dir}/scene-semantic.json`,
      JSON.stringify(buildSceneSemanticIndex(graph), null, 2),
      "utf8",
    ),
    writeFile(
      `${dir}/adjacency.json`,
      JSON.stringify(buildAdjacencyIndex(graph), null, 2),
      "utf8",
    ),
    writeFile(
      `${dir}/element-by-scene.json`,
      JSON.stringify(buildElementBySceneIndex(graph), null, 2),
      "utf8",
    ),
    writeFile(
      `${dir}/operator-by-element.json`,
      JSON.stringify(buildOperatorByElementIndex(graph), null, 2),
      "utf8",
    ),
    writeFile(
      `${dir}/task-intent.json`,
      JSON.stringify(buildTaskIntentIndex(graph), null, 2),
      "utf8",
    ),
  ]);
}
