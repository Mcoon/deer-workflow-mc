import type { AppGraph } from "./types";
import {
  findEquivalentTaskId,
  taskIntentIsReusable,
  taskSemanticSignature,
} from "./task-health";

const UNAVAILABLE_STATUSES = new Set(["blocked", "disabled"]);

export interface SceneMatch {
  readonly sceneId: string;
  readonly title: string;
  readonly confidence: number;
  readonly matchedBy: "visual_text_anchors" | "alias" | "title";
  readonly matchedText: string;
}

export function findScene(
  graph: AppGraph,
  observedTexts: readonly string[],
  options?: { readonly minimumConfidence?: number },
): SceneMatch[] {
  const minConf = options?.minimumConfidence ?? 0.3;
  const results: SceneMatch[] = [];

  for (const [sceneId, scene] of Object.entries(graph.scenes)) {
    let bestScore = 0;
    let bestMatch = "";
    let bestMethod: SceneMatch["matchedBy"] = "visual_text_anchors";

    for (const anchor of scene.visualTextAnchors) {
      for (const obs of observedTexts) {
        const score = textSimilarity(anchor, obs);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = anchor;
          bestMethod = "visual_text_anchors";
        }
      }
    }

    for (const alias of scene.aliases) {
      for (const obs of observedTexts) {
        const score = textSimilarity(alias, obs);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = alias;
          bestMethod = "alias";
        }
      }
    }

    for (const obs of observedTexts) {
      const score = textSimilarity(scene.title, obs);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = scene.title;
        bestMethod = "title";
      }
    }

    if (bestScore >= minConf) {
      results.push({
        sceneId,
        title: scene.title,
        confidence: bestScore,
        matchedBy: bestMethod,
        matchedText: bestMatch,
      });
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

export function findBestScene(
  graph: AppGraph,
  observedTexts: readonly string[],
  options?: { readonly minimumConfidence?: number },
): SceneMatch | null {
  const matches = findScene(graph, observedTexts, options);
  if (matches.length === 0) return null;
  const first = matches[0];
  if (!first) return null;
  if (matches.length === 1) return first;
  const second = matches[1];
  if (!second) return first;
  if (first.confidence > 0.8 && first.confidence - second.confidence > 0.2) {
    return first;
  }
  return null;
}

export interface TaskMatch {
  readonly taskId: string;
  readonly intent: string;
  readonly confidence: number;
}

/** Returns reusable Task intent candidates ordered by semantic similarity. */
export function matchTask(
  graph: AppGraph,
  userGoal: string,
  options?: { readonly minimumConfidence?: number },
): TaskMatch[] {
  const minConf = options?.minimumConfidence ?? 0.55;
  const results: TaskMatch[] = [];

  for (const task of Object.values(graph.tasks)) {
    if (UNAVAILABLE_STATUSES.has(task.status)) continue;
    for (const intent of task.intents) {
      if (!taskIntentIsReusable(intent)) continue;
      const score = textSimilarity(userGoal, intent);
      if (score >= minConf) {
        results.push({ taskId: task.taskId, intent, confidence: score });
      }
    }
  }

  return dedupeTaskMatches(results);
}

/** Selects one unambiguous semantic Task recipe for a natural-language goal. */
export function findBestTask(
  graph: AppGraph,
  userGoal: string,
  options?: { readonly minimumConfidence?: number },
): TaskMatch | null {
  const matches = dedupeTaskMatches(matchTask(graph, userGoal, options));
  return selectBestTaskMatch(graph, matches);
}

/** Resolves equivalent Task matches and rejects close scores for different recipes. */
export function selectBestTaskMatch(
  graph: AppGraph,
  matches: readonly TaskMatch[],
): TaskMatch | null {
  if (matches.length === 0) return null;
  const bySignature = new Map<string, TaskMatch[]>();
  for (const match of matches) {
    const task = graph.tasks[match.taskId];
    if (!task) continue;
    const signature = taskSemanticSignature(graph, task);
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), match]);
  }
  const distinctRecipes = [...bySignature.values()]
    .map((group) => {
      const strongest = [...group].sort(
        (left, right) => right.confidence - left.confidence,
      )[0]!;
      const preferredTaskId =
        findEquivalentTaskId(graph, graph.tasks[strongest.taskId]!) ??
        strongest.taskId;
      return {
        taskId: preferredTaskId,
        intent: strongest.intent,
        confidence: strongest.confidence,
      };
    })
    .sort((left, right) => right.confidence - left.confidence);
  const first = distinctRecipes[0];
  if (!first) return null;
  const second = distinctRecipes[1];
  if (!second) return first;
  return first.confidence - second.confidence >= 0.12 ? first : null;
}

function textSimilarity(a: string, b: string): number {
  const na = normalizeIntent(a);
  const nb = normalizeIntent(b);

  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  const lenA = na.length;
  const lenB = nb.length;
  const maxLen = Math.max(lenA, lenB);
  if (maxLen === 0) return 0;

  const dp: number[][] = Array.from({ length: lenA + 1 }, () =>
    new Array<number>(lenB + 1).fill(0),
  );
  for (let i = 0; i <= lenA; i++) dp[i]![0] = i;
  for (let j = 0; j <= lenB; j++) dp[0]![j] = j;
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      dp[i]![j] =
        na[i - 1] === nb[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  const editSimilarity = 1 - dp[lenA]![lenB]! / maxLen;
  const gramsA = characterBigrams(na);
  const gramsB = characterBigrams(nb);
  const overlap = [...gramsA].filter((value) => gramsB.has(value)).length;
  const dice =
    gramsA.size + gramsB.size > 0
      ? (2 * overlap) / (gramsA.size + gramsB.size)
      : 0;
  return Math.max(editSimilarity, dice);
}

function normalizeIntent(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\s，。！？、,.!?：:"'“”‘’]/g, "")
    .replaceAll("然后", "")
    .replaceAll("页面", "")
    .trim();
}

function characterBigrams(value: string): Set<string> {
  if (value.length < 2) return new Set(value ? [value] : []);
  const grams = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.add(value.slice(index, index + 2));
  }
  return grams;
}

function dedupeTaskMatches(matches: readonly TaskMatch[]): TaskMatch[] {
  const bestByTask = new Map<string, TaskMatch>();
  for (const match of matches) {
    const previous = bestByTask.get(match.taskId);
    if (!previous || match.confidence > previous.confidence) {
      bestByTask.set(match.taskId, match);
    }
  }
  return [...bestByTask.values()].sort((left, right) =>
    right.confidence === left.confidence
      ? left.taskId.localeCompare(right.taskId)
      : right.confidence - left.confidence,
  );
}
