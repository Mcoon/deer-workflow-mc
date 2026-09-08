import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import {
  findBestScene,
  matchTask,
  selectBestTaskMatch,
  canReplanTaskAsScene,
  evaluateTaskHealth,
  loadGraph,
  planRoute,
} from "../ios-ui-graph-manager";

import type {
  AppGraph,
  Binding,
  Element,
  GraphEntityStatus,
  Operator,
  RouteStep,
  Scene,
  SelectorEntry,
  StructuredEffect,
  Task,
  TaskOracle,
  TaskStep,
} from "../ios-ui-graph-manager/types";
import type {
  AppGraphPlanFailure,
  AppGraphPlanInput,
  AppGraphPlanOutput,
  AppGraphPlanResolutionType,
  AppGraphPlanResult,
  ElementResolutionPolicy,
  ResolvedAction,
  ResolvedElementTarget,
  ResolvedSceneContext,
  ResolvedStep,
  TaskResolutionCandidate,
} from "./types";

export { meta } from "./types";

const DEFAULT_GRAPH_PATH = resolve(
  dirname(import.meta.path),
  "../ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);
const DEFAULT_OUTPUT_ROOT = join(
  homedir(),
  ".ios_pref_optimizer",
  "app-graph-plan",
);
const UNAVAILABLE_STATUSES = new Set<GraphEntityStatus>([
  "stale",
  "blocked",
  "disabled",
]);
const SELECTOR_PRIORITY: readonly SelectorEntry["type"][] = [
  "accessibilityIdentifier",
  "label",
  "text",
  "value",
  "role",
];

export default async function appGraphPlan(
  args: AppGraphPlanInput,
): Promise<AppGraphPlanOutput> {
  const startedAt = Date.now();
  const goal = args.goal?.trim();
  if (!goal) {
    return planFailure({
      outputDir: args.outputDir ?? DEFAULT_OUTPUT_ROOT,
      goal: "",
      code: "missing_goal",
      message: "goal is required.",
      recoverable: false,
    });
  }

  const graphPath = resolve(args.graphPath?.trim() || DEFAULT_GRAPH_PATH);
  const outputDir = resolve(
    join(
      args.outputDir?.trim() || DEFAULT_OUTPUT_ROOT,
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
  );
  await mkdir(outputDir, { recursive: true });

  phase("Load");
  log("Loading graph: " + graphPath);
  let graph: AppGraph;
  try {
    graph = await loadGraph(graphPath);
  } catch (error) {
    return planFailure({
      outputDir,
      goal,
      code: "graph_load_failed",
      message: `Cannot load a valid graph from ${graphPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      recoverable: false,
    });
  }

  const entrySceneId = resolveDefaultEntrySceneId(graph);
  const entryScene = graph.scenes[entrySceneId];
  if (!entryScene) {
    return planFailure({
      outputDir,
      goal,
      code: "default_entry_scene_missing",
      message: "Default entry Scene does not exist: " + entrySceneId + ".",
      recoverable: false,
    });
  }

  const deviceProfileId = args.deviceProfileId ?? graph.defaultDeviceProfileId;
  if (!graph.deviceProfiles[deviceProfileId]) {
    return planFailure({
      outputDir,
      goal,
      code: "device_profile_missing",
      message: "Device profile does not exist: " + deviceProfileId + ".",
      recoverable: false,
    });
  }

  phase("Resolve Goal");
  log("Goal: " + goal);

  const parameters = { ...(args.parameters ?? {}) };
  let resolutionType: AppGraphPlanResolutionType = "unresolved";
  let resolution: AppGraphPlanResult["resolution"] = {
    kind: "none",
    confidence: 0,
  };
  let matchedTask: Task | undefined;
  let taskResolution: AppGraphPlanResult["taskResolution"];
  let matchedOperatorId: string | undefined;
  let targetSceneId: string | undefined;
  let navigationRoute: readonly RouteStep[] = [];
  let taskSteps: readonly TaskStep[] = [];
  let resolvedSteps: readonly ResolvedStep[] = [];
  let finalOracles: readonly TaskOracle[] = [];
  let issue: string | undefined;

  const explicitTarget = args.target;
  if (explicitTarget && !explicitTargetExists(graph, explicitTarget)) {
    return planFailure({
      outputDir,
      goal,
      code: "explicit_target_missing",
      message: `${explicitTarget.kind} does not exist: ${explicitTarget.id}.`,
      recoverable: false,
    });
  }

  if (explicitTarget?.kind === "operator") {
    const operator = requireOperator(graph, explicitTarget.id);
    const routeToOperator = routeBetween(
      graph,
      entrySceneId,
      operator.fromSceneId,
    );
    if (routeToOperator === null) {
      return planFailure({
        outputDir,
        goal,
        code: "operator_entry_unreachable",
        message: `Operator entry ${operator.fromSceneId} is unreachable from ${entrySceneId}.`,
        recoverable: true,
      });
    }
    try {
      resolvedSteps = [
        ...compileRouteSteps({
          graph,
          route: routeToOperator,
          deviceProfileId,
          runtimeAppVersion: args.runtimeAppVersion,
          parameters,
        }),
        compileOperatorStep({
          graph,
          operator,
          index: routeToOperator.length,
          deviceProfileId,
          runtimeAppVersion: args.runtimeAppVersion,
          parameters,
        }),
      ];
    } catch (error) {
      return planFailure({
        outputDir,
        goal,
        code: "operator_compile_failed",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      });
    }
    matchedOperatorId = operator.operatorId;
    resolutionType = "matched_operator";
    resolution = {
      kind: "operator",
      id: operator.operatorId,
      title: operator.operation.elementId ?? operator.operation.type,
      confidence: 1,
      matchedText: explicitTarget.id,
    };
    navigationRoute = routeToOperator;
    targetSceneId = operator.toSceneId ?? operator.fromSceneId;
    finalOracles = [
      { type: "scene_current", sceneId: targetSceneId },
      {
        type: "foreground_bundle",
        bundleId:
          graph.scenes[targetSceneId]?.foregroundBundleId ?? graph.bundleId,
      },
    ];
  }

  const taskCandidates = explicitTarget
    ? []
    : matchTask(graph, goal).map((match) => ({
        match,
        health: evaluateTaskHealth({
          graph,
          task: graph.tasks[match.taskId]!,
          deviceProfileId,
          runtimeAppVersion: args.runtimeAppVersion,
        }),
      }));
  const taskCandidateDiagnostics: TaskResolutionCandidate[] =
    taskCandidates.map(({ match, health }) => ({
      taskId: match.taskId,
      matchedIntent: match.intent,
      confidence: match.confidence,
      health: health.status,
      recipeReusable: health.recipeReusable,
      targetSceneId: health.targetSceneId,
      validUntil: health.validUntil,
      reasons: health.reasons,
    }));
  const taskCandidatesForOutput:
    readonly TaskResolutionCandidate[] | undefined =
    taskCandidateDiagnostics.length > 0
      ? taskCandidateDiagnostics.slice(0, 5)
      : undefined;
  const taskMatch =
    explicitTarget?.kind === "task"
      ? { taskId: explicitTarget.id, intent: goal, confidence: 1 }
      : explicitTarget
        ? null
        : selectBestTaskMatch(
            graph,
            taskCandidates.map(({ match }) => match),
          );
  if (!explicitTarget && !taskMatch && taskCandidates.length > 1) {
    return planFailure({
      outputDir,
      goal,
      code: "task_match_ambiguous",
      message: `Task match is ambiguous: ${taskCandidates
        .slice(0, 5)
        .map(({ match }) => `${match.taskId} (${match.confidence.toFixed(2)})`)
        .join(", ")}.`,
      recoverable: true,
      taskCandidates: taskCandidateDiagnostics,
    });
  }
  if (taskMatch) {
    const task = graph.tasks[taskMatch.taskId];
    if (task) {
      const health = evaluateTaskHealth({
        graph,
        task,
        deviceProfileId,
        runtimeAppVersion: args.runtimeAppVersion,
      });
      taskResolution = {
        health: health.status,
        recipeReused: health.recipeReusable,
        dependencyDigest: health.dependencyDigest,
        validUntil: health.validUntil,
        reasons: health.reasons,
      };
      if (
        health.status === "invalid" ||
        (health.status === "stale" && !canReplanTaskAsScene(graph, task))
      ) {
        return planFailure({
          outputDir,
          goal,
          code: health.status === "invalid" ? "task_invalid" : "task_stale",
          message: `Task ${task.taskId} cannot reuse its recipe: ${health.reasons.join(", ")}.`,
          recoverable: true,
          taskCandidates: taskCandidateDiagnostics,
        });
      }
      const parameterIssue = validateTaskParameters(task, parameters);
      if (parameterIssue) {
        return planFailure({
          outputDir,
          goal,
          code: parameterIssue.code,
          message: parameterIssue.message,
          recoverable: true,
        });
      }

      const routeToTaskEntry = routeBetween(
        graph,
        entrySceneId,
        task.entrySceneId,
      );
      if (routeToTaskEntry === null) {
        return planFailure({
          outputDir,
          goal,
          code: "task_entry_unreachable",
          message:
            "Task entry Scene " +
            task.entrySceneId +
            " is unreachable from " +
            entrySceneId +
            ".",
          recoverable: true,
        });
      }

      try {
        if (health.status === "stale" && canReplanTaskAsScene(graph, task)) {
          const freshRoute = planRoute(
            graph,
            entrySceneId,
            health.targetSceneId!,
          );
          if (freshRoute === null) {
            throw new Error(
              `Stale Task ${task.taskId} cannot be replanned to ${health.targetSceneId}.`,
            );
          }
          navigationRoute = freshRoute;
          resolvedSteps = compileRouteSteps({
            graph,
            route: freshRoute,
            deviceProfileId,
            runtimeAppVersion: args.runtimeAppVersion,
            parameters,
          });
          taskResolution = { ...taskResolution, recipeReused: false };
        } else {
          resolvedSteps = compileTaskPlan({
            graph,
            task,
            initialRoute: routeToTaskEntry,
            deviceProfileId,
            runtimeAppVersion: args.runtimeAppVersion,
            parameters,
          });
        }
      } catch (error) {
        return planFailure({
          outputDir,
          goal,
          code: "task_compile_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        });
      }

      matchedTask = task;
      resolutionType = "matched_task";
      resolution = {
        kind: "task",
        id: task.taskId,
        title: task.intents[0] ?? task.taskId,
        confidence: taskMatch.confidence,
        matchedText: taskMatch.intent,
      };
      if (!navigationRoute.length) navigationRoute = routeToTaskEntry;
      taskSteps = taskResolution?.recipeReused === false ? [] : task.steps;
      finalOracles = task.finalOracles.map((oracle) =>
        interpolateOracle(oracle, parameters),
      );
      targetSceneId = inferTaskTargetScene(task, resolvedSteps);
      log(
        "Matched Task: " +
          task.taskId +
          " (confidence: " +
          taskMatch.confidence.toFixed(2) +
          `; health: ${taskResolution?.health ?? "unknown"}; recipe: ${taskResolution?.recipeReused === false ? "replanned" : "reused"})`,
      );
    }
  }

  if (resolutionType === "unresolved") {
    const sceneMatch =
      explicitTarget?.kind === "scene"
        ? {
            sceneId: explicitTarget.id,
            title: graph.scenes[explicitTarget.id]!.title,
            confidence: 1,
            matchedBy: "title" as const,
            matchedText: explicitTarget.id,
          }
        : explicitTarget
          ? null
          : resolveSceneGoal(graph, goal);
    const targetScene = sceneMatch
      ? graph.scenes[sceneMatch.sceneId]
      : undefined;
    if (
      sceneMatch &&
      targetScene &&
      !UNAVAILABLE_STATUSES.has(targetScene.status)
    ) {
      const routeToScene = routeBetween(
        graph,
        entrySceneId,
        sceneMatch.sceneId,
      );
      if (routeToScene === null) {
        return planFailure({
          outputDir,
          goal,
          code: "target_scene_unreachable",
          message:
            "Target Scene " +
            sceneMatch.sceneId +
            " is unreachable from " +
            entrySceneId +
            ".",
          recoverable: true,
        });
      }

      try {
        resolvedSteps = compileRouteSteps({
          graph,
          route: routeToScene,
          deviceProfileId,
          runtimeAppVersion: args.runtimeAppVersion,
          parameters,
        });
      } catch (error) {
        return planFailure({
          outputDir,
          goal,
          code: "route_compile_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        });
      }

      resolutionType = "matched_scene";
      targetSceneId = sceneMatch.sceneId;
      resolution = {
        kind: "scene",
        id: sceneMatch.sceneId,
        title: sceneMatch.title,
        confidence: sceneMatch.confidence,
        matchedText: sceneMatch.matchedText,
      };
      navigationRoute = routeToScene;
      finalOracles = [
        { type: "scene_current", sceneId: targetScene.sceneId },
        {
          type: "foreground_bundle",
          bundleId: targetScene.foregroundBundleId ?? graph.bundleId,
        },
      ];
      log(
        "Matched Scene: " +
          sceneMatch.sceneId +
          " (confidence: " +
          sceneMatch.confidence.toFixed(2) +
          ")",
      );
    } else {
      issue =
        "No active Task or Scene matched the goal with sufficient confidence.";
      log(issue);
    }
  }

  if (resolutionType === "unresolved") {
    return planFailure({
      outputDir,
      goal,
      code: "goal_unresolved",
      message: issue ?? "No active Task or Scene matched the goal.",
      recoverable: true,
    });
  }

  phase("Plan Route");
  log(
    "Plan: " +
      resolutionType +
      " · navigation " +
      navigationRoute.length +
      " · executable steps " +
      resolvedSteps.length,
  );

  phase("Resolve Bindings");
  log(
    "Device profile: " +
      deviceProfileId +
      "; semantic steps preserve selectors when coordinates are unavailable.",
  );

  phase("Output");
  const planPath = join(outputDir, "plan.json");
  const result: AppGraphPlanResult = {
    schemaVersion: "app-graph-semantic-plan/v2",
    success: true,
    mode: "plan",
    planOnly: args.planOnly ?? false,
    outputDir,
    goal,
    resolutionType,
    resolution,
    matchedTaskId: matchedTask?.taskId,
    matchedTask,
    taskCandidates: taskCandidatesForOutput,
    taskResolution,
    matchedOperatorId,
    entrySceneId,
    entryScene: sceneContext(graph, entryScene),
    targetSceneId,
    targetScene: targetSceneId
      ? sceneContext(graph, requireScene(graph, targetSceneId))
      : undefined,
    navigationRoute,
    taskSteps,
    route: navigationRoute,
    resolvedSteps,
    finalOracles,
    parameters,
    deviceProfileId,
    runtimeAppVersion: args.runtimeAppVersion,
    planningMs: Date.now() - startedAt,
    graphIdentity: {
      graphId: graph.graphId,
      schemaVersion: graph.schemaVersion,
      revision: graph.revision,
      updatedAt: graph.updatedAt,
      appVersion: graph.appVersion,
    },
    graphRevision: graph.revision,
    planPath,
    issue,
  };
  await writeFile(planPath, JSON.stringify(result, null, 2), "utf8");
  log("Plan written to " + planPath);
  return result;
}

function explicitTargetExists(
  graph: AppGraph,
  target: NonNullable<AppGraphPlanInput["target"]>,
): boolean {
  if (target.kind === "task") return Boolean(graph.tasks[target.id]);
  if (target.kind === "scene") return Boolean(graph.scenes[target.id]);
  return Boolean(graph.operators[target.id]);
}

function resolveSceneGoal(
  graph: AppGraph,
  goal: string,
): ReturnType<typeof findBestScene> {
  const normalizedGoal = goal.trim().toLowerCase();
  const activeScenes = Object.values(graph.scenes).filter(
    (scene) => !UNAVAILABLE_STATUSES.has(scene.status),
  );
  const exactTitleMatches = activeScenes.filter(
    (scene) => scene.title.trim().toLowerCase() === normalizedGoal,
  );
  if (exactTitleMatches.length === 1) {
    const scene = exactTitleMatches[0]!;
    return {
      sceneId: scene.sceneId,
      title: scene.title,
      confidence: 1,
      matchedBy: "title",
      matchedText: scene.title,
    };
  }

  const exactAliasMatches = activeScenes.flatMap((scene) =>
    scene.aliases
      .filter((alias) => alias.trim().toLowerCase() === normalizedGoal)
      .map((alias) => ({ scene, alias })),
  );
  if (exactAliasMatches.length === 1) {
    const match = exactAliasMatches[0]!;
    return {
      sceneId: match.scene.sceneId,
      title: match.scene.title,
      confidence: 1,
      matchedBy: "alias",
      matchedText: match.alias,
    };
  }

  return findBestScene(graph, [goal]);
}

function compileTaskPlan(options: {
  graph: AppGraph;
  task: Task;
  initialRoute: readonly RouteStep[];
  deviceProfileId: string;
  runtimeAppVersion?: string;
  parameters: Readonly<Record<string, string>>;
}): ResolvedStep[] {
  const steps: ResolvedStep[] = [];
  for (const routeStep of options.initialRoute) {
    steps.push(
      compileOperatorStep({
        graph: options.graph,
        operator: requireOperator(options.graph, routeStep.operatorId),
        index: steps.length,
        deviceProfileId: options.deviceProfileId,
        runtimeAppVersion: options.runtimeAppVersion,
        parameters: options.parameters,
      }),
    );
  }

  let cursor = options.task.entrySceneId;
  for (const taskStep of options.task.steps) {
    const operator = requireOperator(options.graph, taskStep.operatorId);
    if (operator.fromSceneId !== cursor) {
      const bridge = routeBetween(options.graph, cursor, operator.fromSceneId);
      if (bridge === null) {
        throw new Error(
          "Task " +
            options.task.taskId +
            " cannot bridge " +
            cursor +
            " to Operator " +
            operator.operatorId +
            " entry " +
            operator.fromSceneId +
            ".",
        );
      }
      for (const bridgeStep of bridge) {
        const bridgeOperator = requireOperator(
          options.graph,
          bridgeStep.operatorId,
        );
        steps.push(
          compileOperatorStep({
            graph: options.graph,
            operator: bridgeOperator,
            index: steps.length,
            deviceProfileId: options.deviceProfileId,
            runtimeAppVersion: options.runtimeAppVersion,
            parameters: options.parameters,
          }),
        );
      }
    }

    steps.push(
      compileOperatorStep({
        graph: options.graph,
        operator,
        index: steps.length,
        deviceProfileId: options.deviceProfileId,
        runtimeAppVersion: options.runtimeAppVersion,
        parameters: resolveStepParameters(options.parameters, taskStep.params),
        skipIf: taskStep.skipIf,
      }),
    );
    cursor = operator.toSceneId ?? operator.fromSceneId;
  }
  return steps;
}

export function compileRouteSteps(options: {
  graph: AppGraph;
  route: readonly RouteStep[];
  deviceProfileId: string;
  runtimeAppVersion?: string;
  parameters: Readonly<Record<string, string>>;
}): ResolvedStep[] {
  return options.route.map((routeStep, index) =>
    compileOperatorStep({
      graph: options.graph,
      operator: requireOperator(options.graph, routeStep.operatorId),
      index,
      deviceProfileId: options.deviceProfileId,
      runtimeAppVersion: options.runtimeAppVersion,
      parameters: options.parameters,
    }),
  );
}

function compileOperatorStep(options: {
  graph: AppGraph;
  operator: Operator;
  index: number;
  deviceProfileId: string;
  runtimeAppVersion?: string;
  parameters: Readonly<Record<string, string>>;
  skipIf?: TaskStep["skipIf"];
}): ResolvedStep {
  const { graph, operator } = options;
  if (UNAVAILABLE_STATUSES.has(operator.status)) {
    throw new Error(
      "Operator " +
        operator.operatorId +
        " is not plannable because its status is " +
        operator.status +
        ".",
    );
  }

  const fromScene = requireScene(graph, operator.fromSceneId);
  const toScene = operator.toSceneId
    ? requireScene(graph, operator.toSceneId)
    : null;
  const element = operator.operation.elementId
    ? findElement(graph, operator.fromSceneId, operator.operation.elementId)
    : undefined;
  if (operator.operation.elementId && !element) {
    throw new Error(
      "Operator " +
        operator.operatorId +
        " references missing Element " +
        operator.operation.elementId +
        " in Scene " +
        operator.fromSceneId +
        ".",
    );
  }

  const selectorTemplate = element?.selectors ?? [];
  const resolvedSelectors = selectorTemplate.map((selector) => ({
    ...selector,
    value: interpolate(selector.value, options.parameters),
  }));
  const profileBinding = element
    ? chooseBinding(element, options.deviceProfileId)
    : undefined;
  const binding = bindingMatchesRuntime({
    binding: profileBinding,
    graphAppVersion: graph.appVersion,
    runtimeAppVersion: options.runtimeAppVersion,
  })
    ? profileBinding
    : undefined;
  const hintBinding =
    profileBinding ?? (element ? chooseHintBinding(element) : undefined);
  const bindingStatus = binding
    ? binding.status === "verified"
      ? "verified"
      : "candidate"
    : "missing";
  const risk = operator.risk ?? "interaction";
  const effects = operator.effects.map((effect) =>
    interpolateEffect(effect, options.parameters),
  );
  const resolutionPolicy = buildResolutionPolicy({
    risk,
    selectorTemplate,
    binding,
  });
  const locationHint = hintBinding
    ? inferLocationHint(
        hintBinding.normalizedPoint,
        hintBinding.deviceProfileId,
      )
    : undefined;
  const targetElement: ResolvedElementTarget | undefined = element
    ? {
        elementId: element.elementId,
        title: element.title,
        semanticRole: element.semanticRole,
        status: element.status,
        selectors: resolvedSelectors,
        selectorTemplate,
        locationHint,
      }
    : undefined;

  return {
    stepId:
      String(options.index + 1).padStart(2, "0") + "-" + operator.operatorId,
    operatorId: operator.operatorId,
    operatorStatus: operator.status,
    fromSceneId: operator.fromSceneId,
    toSceneId: operator.toSceneId,
    risk,
    operation: {
      type: operator.operation.type,
      elementId: operator.operation.elementId,
      value: operator.operation.value
        ? interpolate(operator.operation.value, options.parameters)
        : undefined,
      durationMs: operator.operation.durationMs,
      from: operator.operation.from,
      to: operator.operation.to,
      bundleId: operator.operation.bundleId,
    },
    normalizedPoint: binding?.normalizedPoint,
    bindingStatus,
    elementTitle: element?.title,
    semanticRole: element?.semanticRole,
    skipIf: options.skipIf,
    fromScene: sceneContext(graph, fromScene),
    action: buildResolvedAction({
      operator,
      fromScene,
      targetElement,
      locationHint,
      parameters: options.parameters,
      effects,
    }),
    targetElement,
    binding: {
      deviceProfileId: options.deviceProfileId,
      appVersion:
        binding?.execution?.lastValidatedAppVersion ?? binding?.appVersion,
      status: bindingStatus,
      normalizedPoint: binding?.normalizedPoint,
      source: binding?.source,
      observedAt: binding?.observedAt,
    },
    resolutionPolicy,
    expectedOutcome: {
      scene: toScene ? sceneContext(graph, toScene) : null,
      effects,
    },
  };
}

function buildResolvedAction(options: {
  operator: Operator;
  fromScene: Scene;
  targetElement?: ResolvedElementTarget;
  locationHint?: ResolvedElementTarget["locationHint"];
  parameters: Readonly<Record<string, string>>;
  effects: readonly StructuredEffect[];
}): ResolvedAction {
  const { operator, fromScene, targetElement, locationHint } = options;
  const target = targetElement
    ? "「" +
      targetElement.title +
      "」" +
      semanticRoleLabel(targetElement.semanticRole)
    : operator.operation.elementId
      ? "Element「" + operator.operation.elementId + "」"
      : "当前页面";
  const location = locationHint ? locationHint.description + "的" : "";
  let description: string;
  switch (operator.operation.type) {
    case "tap":
      description =
        "在「" + fromScene.title + "」点击" + location + target + "。";
      break;
    case "long_press":
      description =
        "在「" +
        fromScene.title +
        "」长按" +
        location +
        target +
        "，持续 " +
        (operator.operation.durationMs ?? 800) +
        "ms。";
      break;
    case "input_text":
      description =
        "在「" +
        fromScene.title +
        "」输入「" +
        interpolate(operator.operation.value ?? "", options.parameters) +
        "」。";
      break;
    case "swipe":
      description =
        "在「" +
        fromScene.title +
        "」从 (" +
        String(operator.operation.from?.x ?? "?") +
        ", " +
        String(operator.operation.from?.y ?? "?") +
        ") 滑动到 (" +
        String(operator.operation.to?.x ?? "?") +
        ", " +
        String(operator.operation.to?.y ?? "?") +
        ")。";
      break;
    case "tap_restart_app":
      description =
        "在「" +
        fromScene.title +
        "」点击" +
        location +
        target +
        "并重启应用。";
      break;
  }
  return {
    type: operator.operation.type,
    description,
    effects: options.effects,
    settleMs: operator.settleMs ?? 900,
  };
}

function semanticRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    Button: "按钮",
    StaticText: "文本",
    Image: "图片",
    TextField: "输入框",
    SecureTextField: "密码输入框",
    ScrollView: "滚动区域",
    HorizontalScrollRegion: "横向滚动区域",
    VerticalScrollRegion: "纵向滚动区域",
  };
  return labels[role] ?? role;
}

function buildResolutionPolicy(options: {
  risk: NonNullable<Operator["risk"]>;
  selectorTemplate: readonly SelectorEntry[];
  binding?: Binding;
}): ElementResolutionPolicy {
  const parameterized = options.selectorTemplate.some((selector) =>
    /\$parameters\.[A-Za-z0-9_.-]+/.test(selector.value),
  );
  const highRisk = [
    "selection",
    "permission",
    "mutation",
    "destructive",
  ].includes(options.risk);
  const liveResolutionRequired = parameterized || highRisk;
  const allowBindingFallback =
    !liveResolutionRequired &&
    Boolean(options.binding) &&
    ["navigation", "interaction"].includes(options.risk);
  const reason = parameterized
    ? "The target selector contains runtime parameters, so historical coordinates are forbidden."
    : highRisk
      ? "Risk " +
        options.risk +
        " requires a live semantic match before execution."
      : allowBindingFallback
        ? "Prefer current selectors; use the profile-matched Binding only as a low-risk fallback."
        : "Resolve against current selectors; no usable historical Binding is available.";
  return {
    preferred: "live_selector",
    selectorPriority: SELECTOR_PRIORITY,
    allowAgentVisualResolution: true,
    allowBindingFallback,
    liveResolutionRequired,
    reason,
  };
}

function inferLocationHint(
  point: Binding["normalizedPoint"],
  sourceDeviceProfileId: string,
): NonNullable<ResolvedElementTarget["locationHint"]> {
  const vertical =
    point.y < 1 / 3 ? "top" : point.y > 2 / 3 ? "bottom" : "middle";
  const horizontal =
    point.x < 1 / 3 ? "left" : point.x > 2 / 3 ? "right" : "center";
  let region: NonNullable<ResolvedElementTarget["locationHint"]>["region"];
  if (vertical === "middle" && horizontal === "center") {
    region = "center";
  } else {
    region = (vertical + "_" + horizontal) as typeof region;
  }
  const descriptions: Record<typeof region, string> = {
    top_left: "页面左上区域",
    top_center: "页面顶部中间区域",
    top_right: "页面右上区域",
    middle_left: "页面左侧中部",
    center: "页面中央区域",
    middle_right: "页面右侧中部",
    bottom_left: "页面左下区域",
    bottom_center: "页面底部中间区域",
    bottom_right: "页面右下区域",
  };
  return {
    region,
    description: descriptions[region],
    sourceDeviceProfileId,
  };
}

function chooseBinding(
  element: Element,
  deviceProfileId: string,
): Binding | undefined {
  return element.bindings[deviceProfileId];
}

function bindingMatchesRuntime(options: {
  binding?: Binding;
  graphAppVersion?: string;
  runtimeAppVersion?: string;
}): boolean {
  if (!options.binding) return false;
  if (!options.runtimeAppVersion) return true;
  if (options.graphAppVersion !== options.runtimeAppVersion) return false;
  const validatedVersion =
    options.binding.execution?.lastValidatedAppVersion ??
    options.binding.appVersion;
  return validatedVersion === options.runtimeAppVersion;
}

function chooseHintBinding(element: Element): Binding | undefined {
  return Object.values(element.bindings).sort((left, right) =>
    left.status === right.status ? 0 : left.status === "verified" ? -1 : 1,
  )[0];
}

function sceneContext(graph: AppGraph, scene: Scene): ResolvedSceneContext {
  return {
    sceneId: scene.sceneId,
    title: scene.title,
    status: scene.status,
    aliases: scene.aliases,
    anchors: scene.visualTextAnchors,
    foregroundBundleId: scene.foregroundBundleId ?? graph.bundleId,
  };
}

function routeBetween(
  graph: AppGraph,
  fromSceneId: string,
  toSceneId: string,
): readonly RouteStep[] | null {
  if (fromSceneId === toSceneId) return [];
  return planRoute(graph, fromSceneId, toSceneId);
}

function resolveDefaultEntrySceneId(graph: AppGraph): string {
  return (
    graph.resetStrategies.find(
      (strategy) => strategy.strategyId === graph.defaultResetStrategyId,
    )?.entrySceneId ?? "chat.detail"
  );
}

function inferTaskTargetScene(
  task: Task,
  resolvedSteps: readonly ResolvedStep[],
): string | undefined {
  const sceneOracle = task.finalOracles.find(
    (oracle) => oracle.type === "scene_current" && oracle.sceneId,
  );
  return (
    sceneOracle?.sceneId ??
    [...resolvedSteps].reverse().find((step) => step.toSceneId)?.toSceneId ??
    undefined
  );
}

function resolveStepParameters(
  parameters: Readonly<Record<string, string>>,
  stepParameters?: Readonly<Record<string, string>>,
): Record<string, string> {
  if (!stepParameters) return { ...parameters };
  return {
    ...parameters,
    ...Object.fromEntries(
      Object.entries(stepParameters).map(([name, value]) => [
        name,
        interpolate(value, parameters),
      ]),
    ),
  };
}

function validateTaskParameters(
  task: Task,
  parameters: Readonly<Record<string, string>>,
): { readonly code: string; readonly message: string } | null {
  const definitions = task.parameters ?? {};
  const unknown = Object.keys(parameters).filter(
    (name) => !(name in definitions),
  );
  if (unknown.length > 0) {
    return {
      code: "unknown_parameters",
      message:
        "Task " +
        task.taskId +
        " does not accept parameter(s): " +
        unknown.join(", ") +
        ".",
    };
  }
  const missing = Object.entries(definitions)
    .filter(([, definition]) => definition.required)
    .map(([name]) => name)
    .filter((name) => !parameters[name]?.trim());
  if (missing.length > 0) {
    return {
      code: "missing_required_parameters",
      message:
        "Task " +
        task.taskId +
        " requires parameter(s): " +
        missing.join(", ") +
        ".",
    };
  }
  return null;
}

function interpolateOracle(
  oracle: TaskOracle,
  parameters: Readonly<Record<string, string>>,
): TaskOracle {
  return oracle.value
    ? { ...oracle, value: interpolate(oracle.value, parameters) }
    : oracle;
}

function interpolateEffect(
  effect: StructuredEffect,
  parameters: Readonly<Record<string, string>>,
): StructuredEffect {
  return {
    ...effect,
    key: interpolate(effect.key, parameters),
    value:
      typeof effect.value === "string"
        ? interpolate(effect.value, parameters)
        : effect.value,
  };
}

function interpolate(
  value: string,
  parameters: Readonly<Record<string, string>>,
): string {
  return value.replaceAll(
    /\$parameters\.([A-Za-z0-9_.-]+)/g,
    (_, name: string) => parameters[name] ?? "",
  );
}

function findElement(
  graph: AppGraph,
  sceneId: string,
  elementId: string,
): Element | undefined {
  return (
    graph.scenes[sceneId]?.elements[elementId] ??
    Object.values(graph.scenes)
      .map((scene) => scene.elements[elementId])
      .find((element) => element !== undefined)
  );
}

function requireScene(graph: AppGraph, sceneId: string): Scene {
  const scene = graph.scenes[sceneId];
  if (!scene) throw new Error("Scene does not exist: " + sceneId + ".");
  if (UNAVAILABLE_STATUSES.has(scene.status)) {
    throw new Error(
      "Scene " + sceneId + " is not plannable: " + scene.status + ".",
    );
  }
  return scene;
}

function requireOperator(graph: AppGraph, operatorId: string): Operator {
  const operator = graph.operators[operatorId];
  if (!operator)
    throw new Error("Operator does not exist: " + operatorId + ".");
  return operator;
}

function planFailure(options: {
  outputDir: string;
  goal: string;
  code: string;
  message: string;
  recoverable: boolean;
  taskCandidates?: readonly TaskResolutionCandidate[];
}): AppGraphPlanFailure {
  return {
    schemaVersion: "app-graph-semantic-plan-failure/v1",
    success: false,
    mode: "plan_failure",
    outputDir: options.outputDir,
    goal: options.goal,
    code: options.code,
    message: options.message,
    recoverable: options.recoverable,
    evidencePaths: [],
    taskCandidates: options.taskCandidates,
  };
}
