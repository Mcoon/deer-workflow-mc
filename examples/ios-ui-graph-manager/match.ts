import type { AppGraph } from "./types";

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

export function matchTask(
  graph: AppGraph,
  userGoal: string,
  options?: { readonly minimumConfidence?: number },
): TaskMatch[] {
  const minConf = options?.minimumConfidence ?? 0.3;
  const results: TaskMatch[] = [];

  for (const task of Object.values(graph.tasks)) {
    for (const intent of task.intents) {
      const score = textSimilarity(userGoal, intent);
      if (score >= minConf) {
        results.push({ taskId: task.taskId, intent, confidence: score });
      }
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

export function findBestTask(
  graph: AppGraph,
  userGoal: string,
  options?: { readonly minimumConfidence?: number },
): TaskMatch | null {
  const matches = matchTask(graph, userGoal, options);
  if (matches.length === 0) return null;
  const first = matches[0];
  return first ?? null;
}

function textSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();

  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  const setA = new Set(na.split(/\s+/));
  const setB = new Set(nb.split(/\s+/));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);

  const jaccard = intersection.size / union.size;
  if (jaccard > 0.5) return jaccard;

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
  return 1 - dp[lenA]![lenB]! / maxLen;
}
