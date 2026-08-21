import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { AppGraph, ReferenceAsset } from "./types";

const DEFAULT_MAX_REFERENCE_ASSETS = 3;

/** Returns the persistent reference-asset directory owned by one Graph. */
export function getReferenceAssetsDir(graphPath: string): string {
  return join(dirname(resolve(graphPath)), "reference-assets");
}

/** Resolves a Graph-relative or legacy absolute asset path. */
export function resolveGraphAssetPath(
  graphPath: string,
  assetPath: string,
): string {
  return isAbsolute(assetPath)
    ? resolve(assetPath)
    : resolve(dirname(resolve(graphPath)), assetPath);
}

/** Reports whether a path belongs to the Graph-managed reference store. */
export function isManagedReferenceAssetPath(
  graphPath: string,
  assetPath: string,
): boolean {
  return isWithin(
    getReferenceAssetsDir(graphPath),
    resolveGraphAssetPath(graphPath, assetPath),
  );
}

/** Copies one validated observation into the Graph-managed content store. */
export async function promoteReferenceAsset(options: {
  graphPath: string;
  sceneId: string;
  screenshotPath: string;
  uiDumpPath: string;
  ocrPath?: string;
}): Promise<ReferenceAsset> {
  const screenshotPath = resolveGraphAssetPath(
    options.graphPath,
    options.screenshotPath,
  );
  const uiDumpPath = resolveGraphAssetPath(
    options.graphPath,
    options.uiDumpPath,
  );
  const requestedOcrPath = options.ocrPath
    ? resolveGraphAssetPath(options.graphPath, options.ocrPath)
    : undefined;
  const ocrPath =
    requestedOcrPath && (await fileExists(requestedOcrPath))
      ? requestedOcrPath
      : undefined;
  const screenshot = await readFile(screenshotPath);
  const uiDump = await readFile(uiDumpPath);
  const ocr = ocrPath ? await readFile(ocrPath) : undefined;
  const contentHash = createHash("sha256")
    .update(screenshot)
    .update(uiDump)
    .update(ocr ?? Buffer.alloc(0))
    .digest("hex")
    .slice(0, 16);
  const assetDirectory = join(
    getReferenceAssetsDir(options.graphPath),
    safePathSegment(options.sceneId),
    contentHash,
  );
  await mkdir(assetDirectory, { recursive: true });

  const screenshotExtension = normalizedScreenshotExtension(screenshotPath);
  const destinationScreenshot = join(
    assetDirectory,
    `screenshot${screenshotExtension}`,
  );
  const destinationUiDump = join(assetDirectory, "ui-dump.json");
  const destinationOcr = ocrPath ? join(assetDirectory, "ocr.json") : undefined;
  await copyIfNeeded(screenshotPath, destinationScreenshot);
  await copyIfNeeded(uiDumpPath, destinationUiDump);
  if (ocrPath && destinationOcr) {
    await copyIfNeeded(ocrPath, destinationOcr);
  }

  return {
    screenshot: graphRelativePath(options.graphPath, destinationScreenshot),
    uiDump: graphRelativePath(options.graphPath, destinationUiDump),
    ...(destinationOcr
      ? { ocr: graphRelativePath(options.graphPath, destinationOcr) }
      : {}),
  };
}

/** Keeps unique reference assets whose screenshot and UI dump both exist. */
export async function retainValidReferenceAssets(options: {
  graphPath: string;
  assets: readonly ReferenceAsset[];
  maxReferences?: number;
}): Promise<ReferenceAsset[]> {
  const retained: ReferenceAsset[] = [];
  const seen = new Set<string>();
  for (const asset of options.assets) {
    const screenshot = resolveGraphAssetPath(
      options.graphPath,
      asset.screenshot,
    );
    const uiDump = resolveGraphAssetPath(options.graphPath, asset.uiDump);
    if (!(await fileExists(screenshot)) || !(await fileExists(uiDump)))
      continue;
    const key = `${screenshot}\0${uiDump}`;
    if (seen.has(key)) continue;
    seen.add(key);
    retained.push(asset);
  }
  return retained.slice(
    -Math.max(1, options.maxReferences ?? DEFAULT_MAX_REFERENCE_ASSETS),
  );
}

/**
 * Promotes every valid Scene reference and removes dangling references.
 * @param graphPath Path to the owning Graph JSON file.
 * @param graph Graph value being persisted.
 * @returns A Graph whose Scene references are portable and Graph-relative.
 */
export async function persistGraphReferenceAssets(
  graphPath: string,
  graph: AppGraph,
): Promise<AppGraph> {
  const scenes = await Promise.all(
    Object.entries(graph.scenes).map(async ([sceneId, scene]) => {
      const promoted = await Promise.all(
        scene.referenceAssets.map(async (asset) => {
          try {
            return await promoteReferenceAsset({
              graphPath,
              sceneId,
              screenshotPath: asset.screenshot,
              uiDumpPath: asset.uiDump,
              ocrPath: asset.ocr,
            });
          } catch {
            return asset;
          }
        }),
      );
      return [
        sceneId,
        {
          ...scene,
          referenceAssets: await retainValidReferenceAssets({
            graphPath,
            assets: promoted,
          }),
        },
      ] as const;
    }),
  );
  return { ...graph, scenes: Object.fromEntries(scenes) };
}

async function copyIfNeeded(
  source: string,
  destination: string,
): Promise<void> {
  if (
    resolve(source) === resolve(destination) ||
    (await fileExists(destination))
  ) {
    return;
  }
  await copyFile(source, destination);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function graphRelativePath(graphPath: string, path: string): string {
  return relative(dirname(resolve(graphPath)), path)
    .split(sep)
    .join("/");
}

function normalizedScreenshotExtension(path: string): string {
  const extension = extname(path).toLocaleLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp"].includes(extension)
    ? extension
    : ".png";
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== "..")
  );
}
