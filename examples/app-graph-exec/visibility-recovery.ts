import type { AppGraph } from "../ios-ui-graph-manager/types";

/** Builds bounded Graph-backed gestures that reveal a hidden scrollable item. */
export function buildHorizontalVisibilityRecoveryCommands(options: {
  graph: AppGraph;
  sceneId: string;
  focusElementId: string;
  udid: string;
  maxAttempts: number;
}): readonly (readonly string[])[] {
  const scene = options.graph.scenes[options.sceneId];
  const element = scene?.elements[options.focusElementId];
  if (!scene || !element || options.maxAttempts <= 0) return [];
  const horizontalTarget = /actionbar|horizontal/i.test(
    `${element.elementId} ${element.semanticRole}`,
  );
  if (!horizontalTarget) return [];

  const candidates = Object.values(options.graph.operators)
    .filter(
      (operator) =>
        operator.fromSceneId === scene.sceneId &&
        (operator.toSceneId === scene.sceneId || operator.toSceneId === null) &&
        operator.operation.type === "swipe" &&
        operator.operation.from &&
        operator.operation.to &&
        !["stale", "blocked", "disabled"].includes(operator.status),
    )
    .map((operator) => {
      const from = operator.operation.from!;
      const to = operator.operation.to!;
      const dx = to.x - from.x;
      const directionMatches = dx < 0;
      const semantics = `${operator.operatorId} ${JSON.stringify(operator.effects)}`;
      return {
        from,
        to,
        directionMatches,
        score:
          (/actionbar/i.test(semantics) ? 30 : 0) +
          (operator.status === "verified" ? 20 : 0) +
          Math.min(operator.executionStats.pass, 5) * 2 +
          Math.min(Math.abs(dx), 500) / 100,
      };
    })
    .filter(
      (candidate) =>
        candidate.directionMatches &&
        Math.abs(candidate.to.x - candidate.from.x) >
          Math.abs(candidate.to.y - candidate.from.y),
    )
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best) return [];

  const y = Math.round((best.from.y + best.to.y) / 2);
  const direction = Math.sign(best.to.x - best.from.x) || -1;
  const primary = swipeCommand(options.udid, best.from, best.to);
  const reverseNudge =
    direction < 0
      ? [
          "mobilecli",
          "io",
          "swipe",
          "--device",
          options.udid,
          `90,${y},230,${y}`,
        ]
      : [
          "mobilecli",
          "io",
          "swipe",
          "--device",
          options.udid,
          `324,${y},184,${y}`,
        ];
  return [primary, reverseNudge, primary].slice(0, options.maxAttempts);
}

function swipeCommand(
  udid: string,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): readonly string[] {
  return [
    "mobilecli",
    "io",
    "swipe",
    "--device",
    udid,
    `${Math.round(from.x)},${Math.round(from.y)},${Math.round(to.x)},${Math.round(to.y)}`,
  ];
}
