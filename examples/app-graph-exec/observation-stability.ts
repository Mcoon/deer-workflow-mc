import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { runCommand } from "../ios-regression-kit";
import type { UiElement } from "../ios-regression-kit/types";

export interface StableObservationSample {
  readonly sampleIndex: number;
  readonly fingerprint: string;
  readonly strategy: "ui-layout" | "screenshot";
  readonly screenshotPath: string;
  readonly uiDumpPath: string;
  readonly similarityToPrevious?: number;
}

export interface StableObservationResult<TObservation> {
  readonly observation: TObservation;
  readonly stable: boolean;
  readonly sampleCount: number;
  readonly consecutiveMatches: number;
  readonly requiredConsecutiveMatches: number;
  readonly changedFromPrevious: boolean;
  readonly samples: readonly StableObservationSample[];
}

export interface StabilityObservation {
  readonly screenshotPath: string;
  readonly uiDumpPath: string;
  readonly uiElements: readonly UiElement[];
}

export async function waitForStableObservation<TObservation>(options: {
  readonly initialObservation?: TObservation;
  readonly previousObservation?: TObservation;
  readonly requireChangeFromPrevious?: boolean;
  readonly capture: (sampleIndex: number) => Promise<TObservation>;
  readonly describe: (observation: TObservation) => StabilityObservation;
  readonly acceptStable?: (observation: TObservation) => boolean;
  readonly maximumSamples?: number;
  readonly requiredConsecutiveMatches?: number;
  readonly pollMs?: number;
  readonly sleep?: (durationMs: number) => Promise<void>;
}): Promise<StableObservationResult<TObservation>> {
  const maximumSamples = Math.max(2, options.maximumSamples ?? 6);
  const requiredConsecutiveMatches = Math.max(
    2,
    options.requiredConsecutiveMatches ?? 2,
  );
  const pollMs = Math.max(0, options.pollMs ?? 700);
  const sleep = options.sleep ?? Bun.sleep;
  const samples: StableObservationSample[] = [];
  let previousDescription: StabilityObservation | undefined;
  const transitionDescription = options.previousObservation
    ? options.describe(options.previousObservation)
    : undefined;
  let changedFromPrevious = transitionDescription === undefined;
  let consecutiveMatches = 0;
  let observation = options.initialObservation;

  for (let sampleIndex = 1; sampleIndex <= maximumSamples; sampleIndex += 1) {
    if (!observation) {
      observation = await options.capture(sampleIndex);
    }
    const described = options.describe(observation);
    const fingerprint = await observationFingerprint(described);
    const comparison = previousDescription
      ? await observationsEquivalent(previousDescription, described)
      : undefined;
    const transitionComparison = transitionDescription
      ? await observationsEquivalent(transitionDescription, described)
      : undefined;
    samples.push({
      sampleIndex,
      fingerprint: fingerprint.value,
      strategy: fingerprint.strategy,
      screenshotPath: described.screenshotPath,
      uiDumpPath: described.uiDumpPath,
      similarityToPrevious: comparison?.similarity,
    });
    consecutiveMatches = comparison?.equivalent ? consecutiveMatches + 1 : 1;
    changedFromPrevious ||= transitionComparison?.equivalent === false;
    if (
      (options.requireChangeFromPrevious !== true || changedFromPrevious) &&
      consecutiveMatches >= requiredConsecutiveMatches &&
      (options.acceptStable?.(observation) ?? true)
    ) {
      return {
        observation,
        stable: true,
        sampleCount: samples.length,
        consecutiveMatches,
        requiredConsecutiveMatches,
        changedFromPrevious,
        samples,
      };
    }
    previousDescription = described;
    if (sampleIndex < maximumSamples) {
      await sleep(pollMs);
      observation = await options.capture(sampleIndex + 1);
    }
  }

  return {
    observation: observation!,
    stable: false,
    sampleCount: samples.length,
    consecutiveMatches,
    requiredConsecutiveMatches,
    changedFromPrevious,
    samples,
  };
}

async function observationsEquivalent(
  before: StabilityObservation,
  after: StabilityObservation,
): Promise<{ readonly equivalent: boolean; readonly similarity?: number }> {
  const containsWebView =
    isSparseWebViewObservation(before.uiElements) ||
    isSparseWebViewObservation(after.uiElements);
  if (!containsWebView) {
    return {
      equivalent:
        uiLayoutFingerprint(before.uiElements) ===
        uiLayoutFingerprint(after.uiElements),
    };
  }
  const similarity = await screenshotSimilarity(
    before.screenshotPath,
    after.screenshotPath,
  );
  return { equivalent: similarity >= 0.995, similarity };
}

async function screenshotSimilarity(
  beforePath: string,
  afterPath: string,
): Promise<number> {
  try {
    const comparison = await runCommand([
      "ffmpeg",
      "-hide_banner",
      "-i",
      beforePath,
      "-i",
      afterPath,
      "-lavfi",
      "[0:v]crop=iw:ih*0.92:0:ih*0.08[a];[1:v]crop=iw:ih*0.92:0:ih*0.08[b];[a][b]ssim",
      "-f",
      "null",
      "-",
    ]);
    const match = comparison.stderr.match(/All:([0-9.]+)/);
    if (comparison.exitCode === 0 && match?.[1]) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return value;
    }
  } catch {
    // File-size similarity below keeps the check available without ffmpeg.
  }
  const [beforeStat, afterStat] = await Promise.all([
    stat(beforePath),
    stat(afterPath),
  ]);
  const maximum = Math.max(beforeStat.size, afterStat.size, 1);
  return 1 - Math.abs(beforeStat.size - afterStat.size) / maximum;
}

export async function observationFingerprint(
  observation: StabilityObservation,
): Promise<{
  readonly value: string;
  readonly strategy: "ui-layout" | "screenshot";
}> {
  if (!isSparseWebViewObservation(observation.uiElements)) {
    return {
      value: `ui-layout:${uiLayoutFingerprint(observation.uiElements)}`,
      strategy: "ui-layout",
    };
  }
  const screenshot = createHash("sha256")
    .update(await readFile(observation.screenshotPath))
    .digest("hex")
    .slice(0, 24);
  return {
    value: `screenshot:${screenshot}`,
    strategy: "screenshot",
  };
}

function uiLayoutFingerprint(elements: readonly UiElement[]): string {
  const stable = elements
    .map((element) => ({
      accessibilityId: element.accessibilityId ?? "",
      label: element.label ?? "",
      role: element.role ?? "",
      text: element.text ?? "",
      value: element.value ?? "",
      bounds: element.bounds
        ? {
            x: Math.round(element.bounds.x),
            y: Math.round(element.bounds.y),
            width: Math.round(element.bounds.width),
            height: Math.round(element.bounds.height),
          }
        : null,
    }))
    .filter((element) =>
      Object.values(element).some((value) => value !== "" && value !== null),
    )
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex")
    .slice(0, 24);
}

export function isSparseWebViewObservation(
  elements: readonly UiElement[],
): boolean {
  // A WebView accessibility tree can expose final semantic children while the
  // pixels still show a loading overlay. Wait for the rendered frame itself.
  return elements.some((element) => /webview/i.test(element.role ?? ""));
}
