export type ViewportSearchAxis = "horizontal" | "vertical";
export type ViewportSearchDirection = "left" | "right" | "up" | "down";

export interface ViewportMoveResult<TObservation> {
  readonly observation: TObservation;
  readonly stable: boolean;
  readonly changedFromPrevious: boolean;
  readonly fingerprint: string;
}

export interface ViewportSearchMove {
  readonly moveIndex: number;
  readonly direction: ViewportSearchDirection;
  readonly stable: boolean;
  readonly changedFromPrevious: boolean;
  readonly fingerprint: string;
}

export interface ViewportSearchResult<TObservation, TTarget> {
  readonly observation: TObservation;
  readonly target?: TTarget;
  readonly moves: readonly ViewportSearchMove[];
  readonly stopReason:
    "found" | "unstable" | "boundaries_reached" | "budget_exhausted";
}

interface ViewportStepLike {
  readonly fromSceneId: string;
  readonly toSceneId: string | null;
  readonly operation: { readonly type: string };
  readonly targetElement?: unknown;
}

export function isHistoricalViewportHintStep(
  steps: readonly ViewportStepLike[],
  index: number,
): boolean {
  const step = steps[index];
  if (
    !step ||
    step.operation.type !== "swipe" ||
    step.toSceneId !== step.fromSceneId
  ) {
    return false;
  }
  for (let nextIndex = index + 1; nextIndex < steps.length; nextIndex += 1) {
    const next = steps[nextIndex]!;
    if (next.fromSceneId !== step.fromSceneId) return false;
    if (
      next.operation.type === "swipe" &&
      next.toSceneId === step.fromSceneId
    ) {
      continue;
    }
    return Boolean(
      next.targetElement &&
      (next.operation.type === "tap" || next.operation.type === "long_press"),
    );
  }
  return false;
}

export function viewportSearchAxisForTarget(target: {
  readonly elementId: string;
  readonly semanticRole?: string;
}): ViewportSearchAxis {
  return /actionbar|horizontal/i.test(
    `${target.elementId} ${target.semanticRole ?? ""}`,
  )
    ? "horizontal"
    : "vertical";
}

/**
 * Searches one bounded segment at a time and re-evaluates the live UI after every
 * move. Target coordinates never decide direction or move count.
 */
export async function searchViewports<TObservation, TTarget>(options: {
  readonly axis: ViewportSearchAxis;
  readonly initialObservation: TObservation;
  readonly resolveVisibleTarget: (observation: TObservation) => TTarget | null;
  readonly moveAndObserve: (
    direction: ViewportSearchDirection,
    moveIndex: number,
    previous: TObservation,
  ) => Promise<ViewportMoveResult<TObservation>>;
  readonly maximumMoves?: number;
}): Promise<ViewportSearchResult<TObservation, TTarget>> {
  const directions: readonly ViewportSearchDirection[] =
    options.axis === "horizontal" ? ["left", "right"] : ["up", "down"];
  const maximumMoves = Math.max(0, options.maximumMoves ?? 6);
  let observation = options.initialObservation;
  let directionIndex = 0;
  const moves: ViewportSearchMove[] = [];
  const seenInDirection = new Set<string>();

  const initialTarget = options.resolveVisibleTarget(observation);
  if (initialTarget) {
    return { observation, target: initialTarget, moves, stopReason: "found" };
  }

  while (moves.length < maximumMoves) {
    const direction = directions[directionIndex]!;
    const moved = await options.moveAndObserve(
      direction,
      moves.length + 1,
      observation,
    );
    moves.push({
      moveIndex: moves.length + 1,
      direction,
      stable: moved.stable,
      changedFromPrevious: moved.changedFromPrevious,
      fingerprint: moved.fingerprint,
    });
    observation = moved.observation;
    if (!moved.stable) {
      return { observation, moves, stopReason: "unstable" };
    }
    const target = options.resolveVisibleTarget(observation);
    if (target) {
      return { observation, target, moves, stopReason: "found" };
    }

    const boundary =
      !moved.changedFromPrevious || seenInDirection.has(moved.fingerprint);
    seenInDirection.add(moved.fingerprint);
    if (boundary) {
      if (directionIndex === directions.length - 1) {
        return { observation, moves, stopReason: "boundaries_reached" };
      }
      directionIndex += 1;
      seenInDirection.clear();
    }
  }

  return { observation, moves, stopReason: "budget_exhausted" };
}

export function buildViewportSearchCommand(options: {
  readonly udid: string;
  readonly axis: ViewportSearchAxis;
  readonly direction: ViewportSearchDirection;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly horizontalCenterY?: number;
}): string[] {
  const centerX = Math.round(options.viewportWidth / 2);
  const centerY = Math.round(
    options.horizontalCenterY ?? options.viewportHeight * 0.8,
  );
  const left = Math.round(options.viewportWidth * 0.38);
  const right = Math.round(options.viewportWidth * 0.62);
  // Mobile swipe APIs apply momentum. A short drag advances one inspectable
  // segment instead of flinging from top to bottom.
  const top = Math.round(options.viewportHeight * 0.52);
  const bottom = Math.round(options.viewportHeight * 0.64);
  const gesture =
    options.direction === "left"
      ? `${right},${centerY},${left},${centerY}`
      : options.direction === "right"
        ? `${left},${centerY},${right},${centerY}`
        : options.direction === "up"
          ? `${centerX},${bottom},${centerX},${top}`
          : `${centerX},${top},${centerX},${bottom}`;
  return ["mobilecli", "io", "swipe", "--device", options.udid, gesture];
}
