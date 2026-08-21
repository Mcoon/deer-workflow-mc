import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppGraph } from "./types";

export async function readGraph(path: string): Promise<AppGraph> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as AppGraph;
}

export async function readSceneSubtree(
  graphPath: string,
  sceneId: string,
): Promise<AppGraph["scenes"][string] | null> {
  const graph = await readGraph(graphPath);
  return graph.scenes[sceneId] ?? null;
}

export async function writeGraphAtomic(
  path: string,
  graph: AppGraph,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, JSON.stringify(graph, null, 2), "utf8");
  await rename(tempPath, path);
}

export async function graphExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function getGraphDir(graphPath: string): string {
  return dirname(graphPath);
}

export function getRevisionsDir(graphPath: string): string {
  return join(dirname(graphPath), "revisions");
}

export function getPatchesDir(graphPath: string): string {
  return join(dirname(graphPath), "patches");
}

export function getIndexesDir(graphPath: string): string {
  return join(dirname(graphPath), "indexes");
}
