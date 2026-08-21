import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { agent } from "@deerwork-ai/deer-workflow/agents";
import type {
  AgentOptions,
  JsonSchema,
} from "@deerwork-ai/deer-workflow/agents";
import { phase, workflow } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";
import { format } from "prettier";

import {
  DEFAULT_ARTIFACT_ROOT,
  buildMobilecliActionCommand,
  buildMobilecliPreflightCommand,
  parseUiDump,
  readJson,
  readJsonIfExists,
  runCommand,
  writeJsonAtomic,
} from "../ios-regression-kit";
import {
  captureTargetedDiscoveryObservation,
  classifyTargetedDiscoveryScene,
  findVerifiedEntryRecoveryOperators,
  isStableIdentityText,
} from "../ios-ui-graph-experiment/workflow";

import type {
  ExecutableUiGraphExperiment,
  ExperimentElement,
  ExperimentOperator,
  ExperimentScene,
  ReferenceAsset,
  TargetedDiscoveryObservation,
} from "../ios-ui-graph-experiment/types";
import type {
  IosUiCrawlerActionFrontier,
  IosUiCrawlerActionType,
  IosUiCrawlerCoverage,
  IosUiCrawlerEffect,
  IosUiCrawlerElementTarget,
  IosUiCrawlerFrontierStatus,
  IosUiCrawlerInput,
  IosUiCrawlerResult,
  IosUiCrawlerSceneFrontier,
  IosUiCrawlerState,
  IosUiGraphSnapshot,
} from "./types";

const DEFAULT_GRAPH_PATH = resolve(
  dirname(import.meta.path),
  "../ios-ui-graph-experiment/graph-chat-full.json",
);
const DEFAULT_PROJECT_ROOT = resolve(dirname(import.meta.path), "../..");
const DEFAULT_MAXIMUM_ACTIONS = 8;
const DEFAULT_MAXIMUM_SCENES = 10;
const DEFAULT_MAXIMUM_DEPTH = 3;
const DEFAULT_MAXIMUM_DURATION_MINUTES = 30;
const DEFAULT_MAXIMUM_ATTEMPTS = 2;
const DEFAULT_MAXIMUM_ACTIONS_PER_SCENE = 12;
const DEFAULT_AGENT_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_MS = 900;

const STATE_SCENE_MIGRATIONS: Readonly<
  Record<
    string,
    {
      readonly baseSceneId: string;
      readonly title: string;
      readonly facts: readonly string[];
    }
  >
> = {
  "chat.detail.voice.input": {
    baseSceneId: "chat.detail",
    title: "语音输入态",
    facts: ["composer.mode=voice"],
  },
  "chat.detail.ai_creation.voice_input": {
    baseSceneId: "chat.detail",
    title: "AI 创作语音输入态",
    facts: ["composer.mode=voice", "actionbar.mode=ai_creation"],
  },
  "chat.detail.actionbar_middle": {
    baseSceneId: "chat.detail",
    title: "ActionBar 中间态",
    facts: ["actionbar.position=middle"],
  },
  "chat.detail.actionbar_end": {
    baseSceneId: "chat.detail",
    title: "ActionBar 末尾态",
    facts: ["actionbar.position=end"],
  },
  "camera.capture.flash.auto": {
    baseSceneId: "camera.capture",
    title: "闪光灯自动模式",
    facts: ["camera.flash=auto"],
  },
  "camera.capture.flash.on": {
    baseSceneId: "camera.capture",
    title: "闪光灯开启",
    facts: ["camera.flash=on"],
  },
  "camera.capture.front": {
    baseSceneId: "camera.capture",
    title: "前置摄像头",
    facts: ["camera.facing=front"],
  },
  "chat.detail.keyboard": {
    baseSceneId: "chat.detail",
    title: "键盘输入态",
    facts: ["composer.focused=true", "keyboard.visible=true"],
  },
  "chat.auto_read_on": {
    baseSceneId: "chat.detail",
    title: "自动朗读已开启",
    facts: ["chat.auto_read=true"],
  },
  "chat.history_older": {
    baseSceneId: "chat.detail",
    title: "更早历史消息视口",
    facts: ["chat.older_messages_visible=true"],
  },
  "photo.selected": {
    baseSceneId: "photo.preview",
    title: "已选择一张照片",
    facts: ["photo.selected_count=1"],
  },
  "chat.detail.new": {
    baseSceneId: "chat.detail",
    title: "新对话态",
    facts: ["chat.mode=new"],
  },
  "chat.new_conversation": {
    baseSceneId: "chat.detail",
    title: "新对话态",
    facts: ["chat.mode=new"],
  },
  "chat.detail.yiqifafeng": {
    baseSceneId: "chat.detail",
    title: "动态会话结果",
    facts: ["chat.thread=dynamic_search_result"],
  },
  "volcengine.ark.docs.api_examples": {
    baseSceneId: "volcengine.ark.docs.quickstart",
    title: "API 示例视口",
    facts: ["docs.viewport=api_examples"],
  },
};

const scanSceneSchema = {
  type: "object",
  properties: {
    sceneId: { type: "string" },
    title: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    visualTextAnchors: { type: "array", items: { type: "string" } },
    elements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          elementId: { type: "string" },
          title: { type: "string" },
          semanticRole: { type: "string" },
          actions: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "tap",
                "long_press",
                "swipe_left",
                "swipe_right",
                "swipe_up",
                "swipe_down",
                "drag_left",
                "drag_right",
                "drag_up",
                "drag_down",
              ],
            },
          },
          risk: {
            type: "string",
            enum: [
              "navigation",
              "interaction",
              "selection",
              "permission",
              "mutation",
              "destructive",
            ],
          },
          expectedEffectType: {
            type: "string",
            enum: [
              "new_scene",
              "overlay",
              "state_change",
              "viewport_change",
              "external_scene",
              "unknown",
            ],
          },
          requiredStateFacts: { type: "array", items: { type: "string" } },
          expectedStateFacts: { type: "array", items: { type: "string" } },
          undoHint: { type: "string" },
          priority: { type: "number", minimum: 0, maximum: 100 },
          reason: { type: "string" },
        },
        required: [
          "candidateId",
          "elementId",
          "title",
          "semanticRole",
          "actions",
          "risk",
          "expectedEffectType",
          "requiredStateFacts",
          "expectedStateFacts",
          "undoHint",
          "priority",
          "reason",
        ],
        additionalProperties: false,
      },
    },
    reason: { type: "string" },
  },
  required: [
    "sceneId",
    "title",
    "aliases",
    "visualTextAnchors",
    "elements",
    "reason",
  ],
  additionalProperties: false,
} as const satisfies JsonSchema;

const effectSchema = {
  type: "object",
  properties: {
    effectType: {
      type: "string",
      enum: [
        "new_scene",
        "overlay",
        "state_change",
        "viewport_change",
        "external_scene",
        "no_effect",
      ],
    },
    toSceneId: { type: "string" },
    title: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    visualTextAnchors: { type: "array", items: { type: "string" } },
    description: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "effectType",
    "toSceneId",
    "title",
    "aliases",
    "visualTextAnchors",
    "description",
    "confidence",
  ],
  additionalProperties: false,
} as const satisfies JsonSchema;

interface SceneScanProposal {
  readonly sceneId: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly visualTextAnchors: readonly string[];
  readonly elements: readonly {
    readonly candidateId: string;
    readonly elementId: string;
    readonly title: string;
    readonly semanticRole: string;
    readonly actions: readonly IosUiCrawlerActionType[];
    readonly risk: ExperimentOperator["risk"];
    readonly expectedEffectType?:
      | "new_scene"
      | "overlay"
      | "state_change"
      | "viewport_change"
      | "external_scene"
      | "unknown";
    readonly requiredStateFacts?: readonly string[];
    readonly expectedStateFacts?: readonly string[];
    readonly undoHint?: string;
    readonly priority: number;
    readonly reason: string;
  }[];
  readonly reason: string;
}

interface EffectProposal {
  readonly effectType: IosUiCrawlerEffect["type"];
  readonly toSceneId: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly visualTextAnchors: readonly string[];
  readonly description: string;
  readonly confidence: number;
}

interface NormalizedInput {
  graphPath: string;
  projectRoot: string;
  udid: string;
  startSceneId?: string;
  focusElementId?: string;
  runId: string;
  outputDir: string;
  statePath: string;
  manifestPath: string;
  coveragePath: string;
  graphDeltaPath: string;
  reportPath: string;
  planOnly: boolean;
  evidenceMigrationOnly: boolean;
  maximumActions: number;
  maximumScenes: number;
  maximumDepth: number;
  maximumDurationMinutes: number;
  maximumAttemptsPerAction: number;
  maximumActionsPerScene: number;
  agentTimeoutMs: number;
  settleMs: number;
  refreshMap: boolean;
  mapHtmlPath: string;
  sceneIdPrefixes: readonly string[];
  model?: string;
}

export default async function runSceneCrawler(
  args: IosUiCrawlerInput,
): Promise<IosUiCrawlerResult> {
  const input = normalizeInput(args);
  await mkdir(input.outputDir, { recursive: true });

  phase("Load State");
  let graph = await readGraph(input.graphPath);
  const existingState = await readJsonIfExists<IosUiCrawlerState>(
    input.statePath,
  );
  if (input.evidenceMigrationOnly) {
    graph = await migrateEvidenceBackedExecutionTrust(
      input.graphPath,
      graph,
      existingState ?? undefined,
    );
    let migrationState = existingState
      ? repairCrawlerStateAgainstGraph(
          resumeCrawlerState(existingState, input),
          graph,
        )
      : initializeCrawlerState(graph, input);
    const coverage = computeCrawlerCoverage(migrationState, graph);
    migrationState = finishState(
      migrationState,
      "plan_only",
      0,
      0,
      performance.now(),
      coverage,
    );
    await persistOutputs(input, migrationState, coverage);
    await refreshSemanticMap(input);
    return buildResult(input, migrationState, coverage);
  }
  graph = await collapseStateScenes(input.graphPath, graph);
  graph = await pruneInvalidCrawlerArtifacts(input.graphPath, graph);
  graph = await normalizeSkillTryInChatGraph(input.graphPath, graph);
  graph = await normalizeSettingsRowOperators(input.graphPath, graph);
  graph = await backfillKnownReverseOperators(input.graphPath, graph);
  graph = await migrateEvidenceBackedExecutionTrust(
    input.graphPath,
    graph,
    existingState ?? undefined,
  );
  graph = await normalizeSceneScopedElementIdentityGraph(
    input.graphPath,
    graph,
    existingState,
  );
  graph = await normalizeVolcengineExperienceEntryGraph(
    input.graphPath,
    graph,
    existingState,
  );
  graph = await normalizeActionBarIdentityGraph(
    input.graphPath,
    graph,
    existingState,
  );
  graph = await normalizeSettingsRowIdentityGraph(
    input.graphPath,
    graph,
    existingState,
  );
  graph = await backfillReadOnlySceneElements(input.graphPath, graph);
  let state = existingState
    ? repairCrawlerStateAgainstGraph(
        resumeCrawlerState(existingState, input),
        graph,
      )
    : initializeCrawlerState(graph, input);
  state = repairSceneScopedElementIdentityState(state, graph);
  state = mergeDuplicateActionEvidence(state);
  state = repairVolcengineExperienceEntryState(state, graph);
  state = repairActionBarIdentityState(state, graph);
  state = repairSettingsRowIdentityState(state, graph);
  state = repairSkillDiscoveryState(state);
  state = repairKnownSceneRecoveryPaths(state, graph);
  state = reopenFaqActionsAfterLiveTargetRepair(state);
  state = reopenUnevidencedSemanticActions(state);
  state = reopenOverblockedSafeNavigationActions(state);
  state = dedupePendingSemanticActions(state);
  state = dedupePendingScrollActions(state);
  ({ graph, state } = await backfillScenesFromReferenceEvidence({
    input,
    graph,
    state,
  }));
  ({ graph, state } = await synthesizeSemanticGraphOperators(
    input.graphPath,
    graph,
    state,
  ));
  state = await seedKnownSceneFrontiers(graph, state);
  state = await backfillStableNavigationActions(state);
  state = await backfillSkillsActions(state);
  state = await backfillActionBarActions(state, graph);
  state = backfillGraphElementActions(state, graph);
  state = mergeDuplicateActionEvidence(state);
  ({ graph, state } = await synthesizeSemanticGraphOperators(
    input.graphPath,
    graph,
    state,
  ));
  state = repairGraphCoveredActions(state, graph);
  state = applyPageActionPolicies(state);
  state = applyActionBarAvailabilityPolicy(state, graph);
  state = repairGestureDirectionActions(state);
  state = skipDuplicateAndDecorativeActions(state);
  state = repairPageCoverageActions(state, graph);
  state = classifyConditionalAndEvidenceCoveredScenes(state, graph);
  state = scopeCrawlerState(state, graph, input);
  await persistState(input, state);

  if (input.planOnly) {
    phase("Coverage");
    const coverage = computeCrawlerCoverage(state, graph);
    state = finishState(state, "plan_only", 0, 0, performance.now(), coverage);
    await persistOutputs(input, state, coverage);
    await refreshSemanticMap(input);
    return buildResult(input, state, coverage);
  }

  phase("Preflight");
  const preflight = await runCommand(
    buildMobilecliPreflightCommand(),
    input.projectRoot,
  );
  await Promise.all([
    writeFile(
      join(input.outputDir, "preflight.stdout.txt"),
      preflight.stdout,
      "utf8",
    ),
    writeFile(
      join(input.outputDir, "preflight.stderr.txt"),
      preflight.stderr,
      "utf8",
    ),
  ]);
  if (preflight.exitCode !== 0) {
    throw new Error(`mobilecli preflight failed: ${preflight.exitCode}.`);
  }

  const sessionStarted = performance.now();
  let scannedScenes = 0;
  let executedActions = 0;
  let stopReason: NonNullable<IosUiCrawlerState["lastSession"]>["stopReason"];
  let liveSceneId: string | null = null;
  let liveObservation: TargetedDiscoveryObservation | undefined;
  let focusedSceneId = selectFocusedSceneId(
    state,
    undefined,
    input.sceneIdPrefixes,
  );

  while (true) {
    if (executedActions >= input.maximumActions) {
      stopReason = "action_budget";
      break;
    }
    if (
      performance.now() - sessionStarted >=
      input.maximumDurationMinutes * 60_000
    ) {
      stopReason = "duration_budget";
      break;
    }

    focusedSceneId = maintainFocusedScene(
      state,
      focusedSceneId,
      input.sceneIdPrefixes,
    );
    const pendingAction = nextActionFrontier(
      state,
      focusedSceneId,
      input.sceneIdPrefixes,
    );
    const sceneFrontier = pendingAction
      ? undefined
      : nextSceneFrontier(state, input.sceneIdPrefixes);
    if (sceneFrontier) {
      if (scannedScenes >= input.maximumScenes) {
        stopReason = "scene_budget";
        break;
      }
      phase("Bootstrap Entry");
      const restored = await restoreScene({
        input,
        graph,
        frontier: sceneFrontier,
        outputDir: join(
          input.outputDir,
          "scenes",
          safeSegment(sceneFrontier.frontierId),
          `scan-${sceneFrontier.attempts + 1}`,
        ),
      });
      liveSceneId = restored.observation
        ? observationSceneId(restored.observation)
        : null;
      liveObservation = restored.observation;
      if (
        !restored.success ||
        !liveObservation ||
        liveSceneId !== sceneFrontier.sceneId
      ) {
        state = replaceSceneFrontier(state, {
          ...sceneFrontier,
          status: "failed",
          attempts: sceneFrontier.attempts + 1,
          updatedAt: new Date().toISOString(),
          issue:
            restored.issue ?? `Unable to restore ${sceneFrontier.sceneId}.`,
        });
        await persistState(input, state);
        continue;
      }

      phase("Scan Scene");
      state = replaceSceneFrontier(state, {
        ...sceneFrontier,
        status: "scanning",
        attempts: sceneFrontier.attempts + 1,
        observationPath: liveObservation.uiDumpPath,
        updatedAt: new Date().toISOString(),
      });
      await persistState(input, state);
      const scan = await understandScene({
        graph,
        frontier: sceneFrontier,
        observation: liveObservation,
        input,
      });
      graph = await mergeScannedScene({
        graph,
        graphPath: input.graphPath,
        observation: liveObservation,
        frontier: sceneFrontier,
        scan,
      });

      phase("Generate Actions");
      const actionFrontiers = generateActionFrontiers({
        state,
        frontier: sceneFrontier,
        observation: liveObservation,
        scan,
        maximum: input.maximumActionsPerScene,
        viewport: crawlerViewport(graph),
      }).filter(
        (frontier) =>
          !input.focusElementId ||
          frontier.target.elementId === input.focusElementId,
      );
      state = {
        ...state,
        updatedAt: new Date().toISOString(),
        sceneFrontiers: state.sceneFrontiers.map((candidate) =>
          candidate.frontierId === sceneFrontier.frontierId
            ? {
                ...candidate,
                title: scan.title,
                status: "scanned",
                observationPath: liveObservation!.uiDumpPath,
                updatedAt: new Date().toISOString(),
              }
            : candidate,
        ),
        actionFrontiers: [...state.actionFrontiers, ...actionFrontiers],
      };
      scannedScenes += 1;
      await persistState(input, state);
      continue;
    }

    const actionFrontier =
      pendingAction ??
      nextActionFrontier(state, undefined, input.sceneIdPrefixes);
    if (!actionFrontier) {
      stopReason = "queue_empty";
      break;
    }
    if (
      actionFrontier.sceneDepth > input.maximumDepth ||
      isBlockedRisk(actionFrontier.risk)
    ) {
      state = replaceActionFrontier(state, {
        ...actionFrontier,
        status: "blocked",
        completedAt: new Date().toISOString(),
        issue:
          actionFrontier.sceneDepth > input.maximumDepth
            ? "Scene depth exceeds crawler budget."
            : `Risk ${actionFrontier.risk} is blocked for full-app discovery.`,
      });
      await persistState(input, state);
      continue;
    }

    const actionOutputDir = join(
      input.outputDir,
      "actions",
      safeSegment(actionFrontier.frontierId),
      `attempt-${actionFrontier.attempts + 1}`,
    );
    phase("Execute Action");
    let restored:
      | {
          success: boolean;
          observation?: TargetedDiscoveryObservation;
          issue?: string;
        }
      | undefined;
    if (liveSceneId === actionFrontier.sceneId && liveObservation) {
      restored = { success: true, observation: liveObservation };
    } else if (liveSceneId && liveObservation) {
      restored = await recoverFocusedScene({
        input,
        graph,
        fromSceneId: liveSceneId,
        targetSceneId: actionFrontier.sceneId,
        beforeObservation: liveObservation,
        outputDir: join(actionOutputDir, "local-recovery"),
      });
    }
    if (!restored?.success || !restored.observation) {
      restored = await restoreScene({
        input,
        graph,
        frontier: {
          frontierId: `restore.${actionFrontier.frontierId}`,
          sceneId: actionFrontier.sceneId,
          title: actionFrontier.sceneId,
          depth: actionFrontier.sceneDepth,
          status: "scanned",
          recoveryOperatorIds: actionFrontier.recoveryOperatorIds,
          attempts: 0,
          createdAt: actionFrontier.createdAt,
          updatedAt: actionFrontier.createdAt,
        },
        outputDir: join(actionOutputDir, "restore"),
      });
    }
    if (!restored.success || !restored.observation) {
      state = replaceActionFrontier(state, {
        ...actionFrontier,
        status: "failed",
        attempts: actionFrontier.attempts + 1,
        completedAt: new Date().toISOString(),
        issue: restored.issue ?? "Unable to restore action Scene.",
      });
      liveSceneId = null;
      liveObservation = undefined;
      await persistState(input, state);
      continue;
    }
    const preparedTarget = await prepareActionTarget({
      input,
      graph,
      frontier: actionFrontier,
      observation: restored.observation,
      outputDir: join(actionOutputDir, "target-recovery"),
    });
    if (!preparedTarget.target) {
      state = replaceActionFrontier(state, {
        ...actionFrontier,
        status: "failed",
        attempts: actionFrontier.attempts + 1,
        completedAt: new Date().toISOString(),
        issue:
          preparedTarget.issue ??
          "Target Element could not be relocated in the restored Scene.",
      });
      liveSceneId = null;
      liveObservation = undefined;
      await persistState(input, state);
      continue;
    }
    const liveTarget = preparedTarget.target;
    const beforeObservation = preparedTarget.observation;
    restored = {
      success: true,
      observation: beforeObservation,
    };
    state = replaceActionFrontier(state, {
      ...actionFrontier,
      status: "running",
      attempts: actionFrontier.attempts + 1,
      startedAt: new Date().toISOString(),
      beforeObservationPath: beforeObservation.uiDumpPath,
    });
    await persistState(input, state);
    const action = await executeCrawlerAction({
      input,
      frontier: actionFrontier,
      target: liveTarget,
      outputDir: actionOutputDir,
    });
    if (!action.success) {
      state = replaceActionFrontier(state, {
        ...actionFrontier,
        status: "failed",
        attempts: actionFrontier.attempts + 1,
        completedAt: new Date().toISOString(),
        issue: action.issue,
      });
      liveSceneId = null;
      liveObservation = undefined;
      await persistState(input, state);
      continue;
    }

    phase("Observe Effect");
    const after = await captureTargetedDiscoveryObservation({
      graph,
      udid: input.udid,
      outputDir: join(actionOutputDir, "after"),
      index: 0,
      preferredSceneId: actionFrontier.sceneId,
      evidenceLevel: observationEvidenceLevel(actionFrontier),
    });
    const effect = canonicalizeCrawlerEffect(
      actionFrontier,
      await understandEffect({
        graph,
        frontier: actionFrontier,
        before: beforeObservation,
        after,
        input,
      }),
      after,
    );

    phase("Merge Graph");
    const merged = await mergeActionEffect({
      graph,
      graphPath: input.graphPath,
      frontier: actionFrontier,
      liveTarget,
      before: beforeObservation,
      after,
      effect,
    });
    graph = merged.graph;
    const completedAction: IosUiCrawlerActionFrontier = {
      ...actionFrontier,
      status: "completed",
      attempts: actionFrontier.attempts + 1,
      completedAt: new Date().toISOString(),
      beforeObservationPath: beforeObservation.uiDumpPath,
      afterObservationPath: after.uiDumpPath,
      operatorId: merged.operatorId,
      effect,
    };
    state = replaceActionFrontier(state, completedAction);
    if (effect.type === "viewport_change") {
      const sceneFrontierForExpansion = state.sceneFrontiers.find(
        (candidate) => candidate.sceneId === actionFrontier.sceneId,
      );
      if (sceneFrontierForExpansion) {
        const incrementalScan = deterministicSceneScan(
          sceneFrontierForExpansion,
          after,
          "Incremental viewport scan.",
          crawlerViewport(graph),
        );
        graph = await mergeScannedScene({
          graph,
          graphPath: input.graphPath,
          observation: after,
          frontier: sceneFrontierForExpansion,
          scan: incrementalScan,
        });
        const incrementalActions = generateActionFrontiers({
          state,
          frontier: sceneFrontierForExpansion,
          observation: after,
          scan: incrementalScan,
          maximum: input.maximumActionsPerScene,
          viewport: crawlerViewport(graph),
        }).filter(
          (candidate) =>
            !candidate.actionType.startsWith("swipe") &&
            !candidate.actionType.startsWith("drag"),
        );
        if (incrementalActions.length > 0) {
          state = {
            ...state,
            updatedAt: new Date().toISOString(),
            actionFrontiers: [...state.actionFrontiers, ...incrementalActions],
          };
        }
        if (
          isForwardScrollAction(actionFrontier.actionType) &&
          (actionFrontier.continuationCount ?? 0) < 3
        ) {
          const continuation: IosUiCrawlerActionFrontier = {
            ...actionFrontier,
            frontierId: `${actionFrontier.frontierId}.continue-${(actionFrontier.continuationCount ?? 0) + 1}`,
            status: "pending",
            attempts: 0,
            continuationCount: (actionFrontier.continuationCount ?? 0) + 1,
            createdAt: new Date().toISOString(),
            startedAt: undefined,
            completedAt: undefined,
            beforeObservationPath: after.uiDumpPath,
            afterObservationPath: undefined,
            operatorId: undefined,
            effect: undefined,
            issue: "Continuation after viewport changed.",
          };
          if (
            !state.actionFrontiers.some(
              (candidate) => candidate.frontierId === continuation.frontierId,
            )
          ) {
            state = {
              ...state,
              actionFrontiers: [...state.actionFrontiers, continuation],
            };
          }
        }
      }
    }
    if (
      (effect.type === "new_scene" ||
        effect.type === "overlay" ||
        effect.type === "external_scene") &&
      actionFrontier.sceneDepth < input.maximumDepth &&
      merged.operatorId &&
      !state.sceneFrontiers.some(
        (candidate) => candidate.sceneId === effect.toSceneId,
      )
    ) {
      state = {
        ...state,
        sceneFrontiers: [
          ...state.sceneFrontiers,
          {
            frontierId: `scene.${safeSegment(effect.toSceneId)}`,
            sceneId: effect.toSceneId,
            title: effect.title,
            depth: actionFrontier.sceneDepth + 1,
            status: "pending_scan",
            recoveryOperatorIds: [
              ...actionFrontier.recoveryOperatorIds,
              merged.operatorId,
            ],
            discoveredFromActionId: actionFrontier.frontierId,
            attempts: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      };
    }
    liveSceneId =
      effect.type === "new_scene" ||
      effect.type === "overlay" ||
      effect.type === "external_scene"
        ? effect.toSceneId
        : actionFrontier.sceneId;
    liveObservation = after;
    executedActions += 1;
    if (
      nextActionFrontier(state, focusedSceneId, input.sceneIdPrefixes) ===
        undefined &&
      focusedSceneId === actionFrontier.sceneId
    ) {
      focusedSceneId = selectFocusedSceneId(
        state,
        focusedSceneId,
        input.sceneIdPrefixes,
      );
    }
    await persistState(input, state);
  }

  phase("Coverage");
  graph = await pruneInvalidCrawlerArtifacts(
    input.graphPath,
    await readGraph(input.graphPath),
  );
  state = repairCrawlerStateAgainstGraph(state, graph);
  const coverage = computeCrawlerCoverage(state, graph);
  phase("Checkpoint");
  state = finishState(
    state,
    stopReason,
    scannedScenes,
    executedActions,
    sessionStarted,
    coverage,
  );
  await persistOutputs(input, state, coverage);
  await refreshSemanticMap(input);
  phase("Report");
  log(
    [
      "## Scene-driven App Graph crawler",
      `- **Status:** ${state.status}`,
      `- **Scanned Scenes:** ${scannedScenes}`,
      `- **Executed Actions:** ${executedActions}`,
      `- **Graph Scenes:** ${coverage.current.sceneCount} (${signed(coverage.delta.scenes)})`,
      `- **Graph Operators:** ${coverage.current.operatorCount} (${signed(coverage.delta.operators)})`,
      `- **State:** \`${input.statePath}\``,
      `- **Report:** \`${input.reportPath}\``,
    ].join("\n"),
  );
  return buildResult(input, state, coverage);
}

function reopenFaqActionsAfterLiveTargetRepair(
  state: IosUiCrawlerState,
): IosUiCrawlerState {
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map((frontier) =>
      frontier.sceneId === "bot.settings.about_debug.shopping_wallet_faq" &&
      frontier.status === "failed" &&
      (frontier.continuationCount ?? 0) < 2 &&
      frontier.issue?.includes("could not relocate its live target")
        ? {
            ...frontier,
            status: "pending",
            attempts: 0,
            continuationCount: (frontier.continuationCount ?? 0) + 1,
            completedAt: undefined,
            issue:
              "Requeued after visible-viewport candidate sampling and FAQ live-target relocation were repaired.",
          }
        : frontier,
    ),
  };
}

async function backfillScenesFromReferenceEvidence(options: {
  input: NormalizedInput;
  graph: ExecutableUiGraphExperiment;
  state: IosUiCrawlerState;
}): Promise<{
  graph: ExecutableUiGraphExperiment;
  state: IosUiCrawlerState;
}> {
  let graph = options.graph;
  let state = options.state;
  for (const frontier of state.sceneFrontiers) {
    const existingElementCount = graph.elements.filter(
      (element) => element.sceneId === frontier.sceneId,
    ).length;
    const informationDocumentScene =
      frontier.sceneId.startsWith("bot.settings.about_debug.") ||
      frontier.sceneId.startsWith("bot.settings.customer_service.");
    const needsCoverageRepair =
      existingElementCount === 0 ||
      (frontier.sceneId === "bot.settings.privacy.permissions" &&
        existingElementCount < 5) ||
      (informationDocumentScene && !frontier.issue?.includes("OCR-enriched"));
    if (
      frontier.status === "blocked" ||
      (!needsCoverageRepair && frontier.status === "scanned")
    ) {
      continue;
    }
    const scene = graph.scenes.find(
      (candidate) => candidate.sceneId === frontier.sceneId,
    );
    const asset = [...(scene?.referenceAssets ?? [])]
      .reverse()
      .find(
        (candidate) =>
          candidate.uiDumpPath?.includes(options.input.outputDir) &&
          candidate.uiDumpPath,
      );
    if (
      !scene ||
      !asset?.uiDumpPath ||
      !(await Bun.file(asset.uiDumpPath).exists())
    ) {
      continue;
    }
    const observation = await observationFromReferenceAsset(
      frontier,
      scene,
      asset,
      crawlerViewport(graph),
    );
    const scan = await understandScene({
      graph,
      frontier,
      observation,
      input: options.input,
    });
    graph = await mergeScannedScene({
      graph,
      graphPath: options.input.graphPath,
      observation,
      frontier,
      scan,
    });
    const actions = generateActionFrontiers({
      state,
      frontier,
      observation,
      scan,
      maximum: options.input.maximumActionsPerScene,
      viewport: crawlerViewport(graph),
    });
    state = {
      ...state,
      updatedAt: new Date().toISOString(),
      sceneFrontiers: state.sceneFrontiers.map((candidate) =>
        candidate.frontierId === frontier.frontierId
          ? {
              ...candidate,
              status: "scanned" as const,
              observationPath: observation.uiDumpPath,
              updatedAt: new Date().toISOString(),
              issue:
                "Agent-understood from current-run OCR-enriched reference evidence; live replay was not required.",
            }
          : candidate,
      ),
      actionFrontiers: [...state.actionFrontiers, ...actions],
    };
  }
  return { graph, state };
}

async function observationFromReferenceAsset(
  frontier: IosUiCrawlerSceneFrontier,
  scene: ExperimentScene,
  asset: ReferenceAsset,
  viewport: ViewportDimensions,
): Promise<TargetedDiscoveryObservation> {
  const uiDumpPath = asset.uiDumpPath!;
  const elements = parseUiDump(await Bun.file(uiDumpPath).text());
  const ocrItems =
    asset.recordPath && (await Bun.file(asset.recordPath).exists())
      ? (JSON.parse(await Bun.file(asset.recordPath).text()) as Array<{
          text: string;
          confidence?: number;
          x: number;
          y: number;
          width: number;
          height: number;
        }>)
      : [];
  return {
    observationId: `reference.${safeSegment(frontier.sceneId)}`,
    screenshotPath: asset.screenshotPath ?? "",
    uiDumpPath,
    ocrPath: asset.recordPath ?? "",
    matchedSceneId: frontier.sceneId,
    candidateSceneId: frontier.sceneId,
    candidateSceneTitle: scene.title,
    visualTextAnchors: scene.visualTextAnchors ?? [],
    candidates: [
      ...elements.flatMap((element, index) =>
        element.bounds
          ? [
              {
                candidateId: `reference-${index + 1}`,
                source: "ui_dump" as const,
                role: element.role,
                accessibilityId: element.accessibilityId,
                label: element.label,
                text: element.text,
                value: element.value,
                bounds: element.bounds,
              },
            ]
          : [],
      ),
      ...ocrItems
        .filter((item) => item.text.trim().length > 0)
        .map((item, index) => ({
          candidateId: `reference-ocr-${index + 1}`,
          source: "vision_ocr" as const,
          role: "TextObservation",
          text: item.text,
          confidence: item.confidence,
          bounds: {
            x: item.x * viewport.width,
            y: (1 - item.y - item.height) * viewport.height,
            width: item.width * viewport.width,
            height: item.height * viewport.height,
          },
        })),
    ],
  };
}

async function synthesizeSemanticGraphOperators(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
  state: IosUiCrawlerState,
): Promise<{
  graph: ExecutableUiGraphExperiment;
  state: IosUiCrawlerState;
}> {
  const parentByScene = new Map(
    state.sceneFrontiers.flatMap((frontier) => {
      const lastOperatorId = frontier.recoveryOperatorIds.at(-1);
      if (!lastOperatorId) {
        return [];
      }
      const operator = graph.operators.find(
        (candidate) => candidate.operatorId === lastOperatorId,
      );
      return operator
        ? [
            [
              frontier.sceneId,
              {
                sceneId: operator.fromSceneId,
                operatorId: operator.operatorId,
              },
            ] as const,
          ]
        : [];
    }),
  );
  const additions: ExperimentOperator[] = [];
  const operatorIds = new Set(
    graph.operators.map((operator) => operator.operatorId),
  );
  for (const frontier of state.actionFrontiers) {
    if (frontier.status !== "pending" || frontier.actionType === "long_press") {
      continue;
    }
    const role = frontier.target.semanticRole.toLocaleLowerCase();
    const stateLike =
      role.includes("tab") ||
      role.includes("toggle") ||
      role.includes("option") ||
      frontier.expectedEffectType === "state_change" ||
      frontier.expectedEffectType === "viewport_change" ||
      frontier.expectedEffectType === "overlay" ||
      frontier.actionType.startsWith("swipe") ||
      frontier.actionType.startsWith("drag");
    const reverseLike =
      frontier.actionType === "tap" &&
      /返回|关闭|取消|退出/.test(frontier.target.title);
    const parent = parentByScene.get(frontier.sceneId);
    if (!stateLike && (!reverseLike || !parent)) {
      continue;
    }
    const toSceneId = stateLike
      ? frontier.sceneId
      : (parent?.sceneId ?? frontier.sceneId);
    const operatorId = semanticOperatorId(frontier, toSceneId);
    if (operatorIds.has(operatorId)) {
      continue;
    }
    operatorIds.add(operatorId);
    const stateFact = semanticStateFact(frontier);
    const operation: ExperimentOperator["operation"] =
      frontier.actionType === "tap"
        ? { type: "tap", elementId: frontier.target.elementId }
        : {
            type: "swipe",
            ...gesturePoints(frontier.actionType, frontier.target.bounds),
          };
    additions.push({
      operatorId,
      title: `${frontier.actionType} ${frontier.target.title}`,
      fromSceneId: frontier.sceneId,
      toSceneId,
      operation,
      settleMs: DEFAULT_SETTLE_MS,
      risk: frontier.risk,
      status: "candidate",
      reliability: stateLike ? 0.6 : 0.7,
      preconditions: frontier.requiredStateFacts ?? [],
      effects: stateFact
        ? [stateFact]
        : [
            stateLike
              ? `Semantic ${frontier.expectedEffectType ?? "interaction"} within ${frontier.sceneId}.`
              : `Semantic reverse navigation to ${toSceneId}.`,
          ],
      postconditions: [
        `scene.current=${toSceneId}`,
        ...(stateFact ? [stateFact] : []),
      ],
    });
  }
  for (const frontier of state.actionFrontiers) {
    if (frontier.status !== "pending" || frontier.actionType !== "tap") {
      continue;
    }
    const toSceneId = knownSemanticNavigationTarget(frontier);
    if (
      !toSceneId ||
      !graph.scenes.some((scene) => scene.sceneId === toSceneId)
    ) {
      continue;
    }
    const operatorId = semanticOperatorId(frontier, toSceneId);
    if (operatorIds.has(operatorId)) {
      continue;
    }
    operatorIds.add(operatorId);
    additions.push({
      operatorId,
      title: `tap ${frontier.target.title}`,
      fromSceneId: frontier.sceneId,
      toSceneId,
      operation: { type: "tap", elementId: frontier.target.elementId },
      settleMs: DEFAULT_SETTLE_MS,
      risk: "navigation",
      status: "candidate",
      reliability: 0.65,
      effects: [
        `Semantic navigation reuses the verified ${frontier.target.title} destination ${toSceneId}.`,
      ],
      postconditions: [`scene.current=${toSceneId}`],
    });
  }
  if (additions.length === 0) {
    return { graph, state };
  }
  const normalized: ExecutableUiGraphExperiment = {
    ...graph,
    operators: [...graph.operators, ...additions],
  };
  await writeGraph(graphPath, normalized);
  return {
    graph: normalized,
    state: repairGraphCoveredActions(state, normalized),
  };
}

function knownSemanticNavigationTarget(
  frontier: IosUiCrawlerActionFrontier,
): string | null {
  if (
    ["chat.write_assistant.panel", "chat.ppt.generate.panel"].includes(
      frontier.sceneId,
    ) &&
    frontier.target.title === "对话列表"
  ) {
    return "chat.sidebar";
  }
  if (frontier.sceneId === "chat.sidebar.search") {
    if (frontier.target.title === "技能") {
      return "skills.home";
    }
    if (frontier.target.title === "AI 创作") {
      return "chat.detail";
    }
    if (frontier.target.title === "云盘") {
      return "cloud.drive.recent.empty";
    }
    if (frontier.target.title === "豆包") {
      return "chat.detail";
    }
  }
  if (
    frontier.sceneId === "cloud.drive.files.empty" &&
    frontier.target.title === "搜索"
  ) {
    return "cloud.drive.search";
  }
  if (
    frontier.sceneId === "chat.ai_creation.discovery" &&
    frontier.target.title === "更多面板"
  ) {
    return "chat.media_panel";
  }
  return null;
}

function semanticOperatorId(
  frontier: IosUiCrawlerActionFrontier,
  toSceneId: string,
): string {
  return `semantic.${createHash("sha1")
    .update(
      JSON.stringify([
        frontier.sceneId,
        frontier.target.elementId,
        frontier.actionType,
        toSceneId,
      ]),
    )
    .digest("hex")
    .slice(0, 14)}`;
}

function semanticStateFact(
  frontier: IosUiCrawlerActionFrontier,
): string | null {
  const expected = frontier.expectedStateFacts?.[0];
  if (expected) {
    return expected;
  }
  if (frontier.actionType.startsWith("swipe")) {
    return `viewport.${createHash("sha1")
      .update(`${frontier.sceneId}:${frontier.target.elementId}`)
      .digest("hex")
      .slice(0, 8)}=${frontier.actionType}`;
  }
  if (frontier.target.semanticRole.toLocaleLowerCase().includes("tab")) {
    return `tab.selected=${stableTextSlug(frontier.target.title)}`;
  }
  if (frontier.target.semanticRole.toLocaleLowerCase().includes("toggle")) {
    return `toggle.${stableTextSlug(frontier.target.title)}=toggled`;
  }
  return null;
}

function repairGestureDirectionActions(
  state: IosUiCrawlerState,
): IosUiCrawlerState {
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map((frontier) => {
      if (frontier.status !== "pending") {
        return frontier;
      }
      const semantics = normalizeText(
        [
          frontier.target.title,
          frontier.target.selector.label,
          frontier.target.selector.value,
          frontier.target.semanticRole,
        ]
          .filter(Boolean)
          .join(" "),
      );
      const horizontal =
        semantics.includes("横向可滑动区域") ||
        semantics.includes("horizontal");
      const vertical =
        semantics.includes("纵向可滑动区域") ||
        semantics.includes("vertical") ||
        semantics.includes("内容滚动") ||
        semantics.includes("网格滚动");
      const invalid =
        (horizontal &&
          (frontier.actionType === "swipe_up" ||
            frontier.actionType === "swipe_down")) ||
        (vertical &&
          (frontier.actionType === "swipe_left" ||
            frontier.actionType === "swipe_right"));
      return invalid
        ? {
            ...frontier,
            status: "skipped" as const,
            completedAt: new Date().toISOString(),
            issue:
              "Skipped gesture whose direction does not match the semantic scroll axis.",
          }
        : frontier;
    }),
  };
}

async function refreshSemanticMap(input: NormalizedInput): Promise<void> {
  if (!input.refreshMap) {
    return;
  }
  phase("Refresh Map");
  await workflow("../ios-ui-semantic-map-report/workflow.ts", {
    graphPath: input.graphPath,
    htmlPath: input.mapHtmlPath,
    discoveryStatePath: input.statePath,
  });
}

export function initializeCrawlerState(
  graph: ExecutableUiGraphExperiment,
  input: Pick<
    NormalizedInput,
    | "runId"
    | "graphPath"
    | "maximumActions"
    | "maximumScenes"
    | "maximumDepth"
    | "maximumDurationMinutes"
    | "maximumAttemptsPerAction"
    | "maximumActionsPerScene"
    | "agentTimeoutMs"
    | "settleMs"
  >,
): IosUiCrawlerState {
  const reset = graph.resetStrategies.find(
    (candidate) => candidate.strategyId === graph.defaultResetStrategyId,
  );
  if (!reset) {
    throw new Error(
      `Default reset strategy does not exist: ${graph.defaultResetStrategyId}.`,
    );
  }
  const entryScene = graph.scenes.find(
    (candidate) => candidate.sceneId === reset.entrySceneId,
  );
  if (!entryScene) {
    throw new Error(`Entry Scene does not exist: ${reset.entrySceneId}.`);
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: "ios-ui-scene-crawler-state/v1",
    runId: input.runId,
    graphPath: input.graphPath,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    sessionCount: 1,
    entrySceneId: entryScene.sceneId,
    budgets: {
      maximumActions: input.maximumActions,
      maximumScenes: input.maximumScenes,
      maximumDepth: input.maximumDepth,
      maximumDurationMinutes: input.maximumDurationMinutes,
      maximumAttemptsPerAction: input.maximumAttemptsPerAction,
      maximumActionsPerScene: input.maximumActionsPerScene,
      agentTimeoutMs: input.agentTimeoutMs,
      settleMs: input.settleMs,
    },
    baseline: snapshotGraph(graph),
    sceneFrontiers: [
      {
        frontierId: `scene.${safeSegment(entryScene.sceneId)}`,
        sceneId: entryScene.sceneId,
        title: entryScene.title,
        depth: 0,
        status: "pending_scan",
        recoveryOperatorIds: [],
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
    actionFrontiers: [],
  };
}

export function scopeCrawlerState(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
  input: Pick<NormalizedInput, "startSceneId" | "focusElementId">,
): IosUiCrawlerState {
  if (!input.startSceneId && !input.focusElementId) {
    return state;
  }
  const focusElement = input.focusElementId
    ? graph.elements.find(
        (element) => element.elementId === input.focusElementId,
      )
    : undefined;
  if (input.focusElementId && !focusElement) {
    throw new Error(`Focus Element does not exist: ${input.focusElementId}.`);
  }
  const startSceneId = input.startSceneId ?? focusElement?.sceneId;
  const scene = graph.scenes.find(
    (candidate) => candidate.sceneId === startSceneId,
  );
  if (!scene) {
    throw new Error(`Start Scene does not exist: ${startSceneId}.`);
  }
  if (focusElement && focusElement.sceneId !== scene.sceneId) {
    throw new Error(
      `Focus Element ${focusElement.elementId} belongs to ${focusElement.sceneId}, not ${scene.sceneId}.`,
    );
  }
  const reset = graph.resetStrategies.find(
    (candidate) => candidate.strategyId === graph.defaultResetStrategyId,
  );
  if (!reset) {
    throw new Error(
      `Default reset strategy does not exist: ${graph.defaultResetStrategyId}.`,
    );
  }
  const existing = state.sceneFrontiers.find(
    (frontier) => frontier.sceneId === scene.sceneId,
  );
  const recoveryOperatorIds = existing?.recoveryOperatorIds.length
    ? existing.recoveryOperatorIds
    : (findVerifiedEntryRecoveryOperators(
        graph,
        reset.entrySceneId,
        scene.sceneId,
      ) ?? []);
  if (
    reset.entrySceneId !== scene.sceneId &&
    recoveryOperatorIds.length === 0
  ) {
    throw new Error(
      `No safe recovery path reaches Start Scene ${scene.sceneId}.`,
    );
  }
  const now = new Date().toISOString();
  return {
    ...state,
    updatedAt: now,
    sceneFrontiers: [
      {
        frontierId:
          existing?.frontierId ?? `scene.${safeSegment(scene.sceneId)}`,
        sceneId: scene.sceneId,
        title: scene.title,
        depth: recoveryOperatorIds.length,
        status: "pending_scan",
        recoveryOperatorIds,
        attempts: 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      },
    ],
    actionFrontiers: state.actionFrontiers
      .filter(
        (frontier) =>
          frontier.sceneId === scene.sceneId &&
          (!focusElement ||
            frontier.target.elementId === focusElement.elementId),
      )
      .map((frontier) => ({
        ...frontier,
        status:
          frontier.status === "blocked" || frontier.status === "skipped"
            ? frontier.status
            : ("pending" as const),
        attempts: 0,
        completedAt: undefined,
      })),
  };
}

export function resumeCrawlerState(
  state: IosUiCrawlerState,
  input: Pick<
    NormalizedInput,
    | "graphPath"
    | "maximumActions"
    | "maximumScenes"
    | "maximumDepth"
    | "maximumDurationMinutes"
    | "maximumAttemptsPerAction"
    | "maximumActionsPerScene"
    | "agentTimeoutMs"
    | "settleMs"
  >,
): IosUiCrawlerState {
  if (state.schemaVersion !== "ios-ui-scene-crawler-state/v1") {
    throw new Error(`Unsupported crawler state: ${state.schemaVersion}.`);
  }
  if (resolve(state.graphPath) !== resolve(input.graphPath)) {
    throw new Error("Crawler state graphPath does not match input graphPath.");
  }
  return {
    ...state,
    status: "ready",
    updatedAt: new Date().toISOString(),
    sessionCount: state.sessionCount + 1,
    budgets: {
      maximumActions: input.maximumActions,
      maximumScenes: input.maximumScenes,
      maximumDepth: input.maximumDepth,
      maximumDurationMinutes: input.maximumDurationMinutes,
      maximumAttemptsPerAction: input.maximumAttemptsPerAction,
      maximumActionsPerScene: input.maximumActionsPerScene,
      agentTimeoutMs: input.agentTimeoutMs,
      settleMs: input.settleMs,
    },
    sceneFrontiers: state.sceneFrontiers.map((frontier) =>
      frontier.status === "scanning" ||
      (frontier.status === "failed" &&
        frontier.attempts < input.maximumAttemptsPerAction)
        ? {
            ...frontier,
            status: "pending_scan",
            updatedAt: new Date().toISOString(),
          }
        : frontier,
    ),
    actionFrontiers: state.actionFrontiers.map((frontier) =>
      frontier.status === "running" ||
      (frontier.status === "failed" &&
        frontier.attempts < input.maximumAttemptsPerAction)
        ? { ...frontier, status: "pending" }
        : frontier,
    ),
  };
}

export function repairCrawlerStateAgainstGraph(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerState {
  const operatorIds = new Set(
    graph.operators.map((operator) => operator.operatorId),
  );
  const sceneIds = new Set(graph.scenes.map((scene) => scene.sceneId));
  return {
    ...state,
    sceneFrontiers: state.sceneFrontiers.filter((frontier) =>
      sceneIds.has(frontier.sceneId),
    ),
    actionFrontiers: state.actionFrontiers
      .filter((frontier) => !STATE_SCENE_MIGRATIONS[frontier.sceneId])
      .map((frontier) => {
        const operator = frontier.operatorId
          ? graph.operators.find(
              (candidate) => candidate.operatorId === frontier.operatorId,
            )
          : undefined;
        const expectedEffectType = normalizeExpectedEffectType(
          frontier.expectedEffectType,
          frontier.target.semanticRole,
          frontier.target.title,
          frontier.risk,
        );
        const migratedEffect =
          frontier.effect && operator
            ? {
                ...frontier.effect,
                type:
                  operator.fromSceneId === operator.toSceneId
                    ? frontier.effect.type === "viewport_change"
                      ? ("viewport_change" as const)
                      : ("state_change" as const)
                    : frontier.effect.type === "overlay"
                      ? ("overlay" as const)
                      : ("new_scene" as const),
                fromSceneId: operator.fromSceneId,
                toSceneId: operator.toSceneId,
                stateFacts: operator.effects.filter((effect) =>
                  effect.includes("="),
                ),
              }
            : frontier.effect
              ? canonicalizeCrawlerEffect(
                  {
                    ...frontier,
                    expectedEffectType,
                    expectedStateFacts:
                      frontier.expectedStateFacts ??
                      inferExpectedStateFacts(frontier.target.title),
                  },
                  frontier.effect,
                  emptyObservationForStateRepair(frontier),
                )
              : undefined;
        if (
          frontier.status === "completed" &&
          frontier.operatorId &&
          !operatorIds.has(frontier.operatorId)
        ) {
          const hasLiveSameSceneEvidence =
            Boolean(frontier.beforeObservationPath) &&
            Boolean(frontier.afterObservationPath) &&
            Boolean(
              migratedEffect &&
              ["no_effect", "state_change", "viewport_change"].includes(
                migratedEffect.type,
              ) &&
              migratedEffect.toSceneId === frontier.sceneId,
            );
          if (hasLiveSameSceneEvidence) {
            return {
              ...frontier,
              expectedEffectType,
              expectedStateFacts:
                frontier.expectedStateFacts ??
                inferExpectedStateFacts(frontier.target.title),
              operatorId: undefined,
              effect: migratedEffect,
              issue:
                "Explored with live before/after evidence; the invalid self-loop Operator was removed.",
            };
          }
          return {
            ...frontier,
            expectedEffectType,
            expectedStateFacts:
              frontier.expectedStateFacts ??
              inferExpectedStateFacts(frontier.target.title),
            status: "pending" as const,
            attempts: 0,
            completedAt: undefined,
            operatorId: undefined,
            effect: undefined,
            issue: "Requeued after an invalid crawler edge was pruned.",
          };
        }
        const normalizedElementId =
          operator &&
          (operator.operation.type === "tap" ||
            operator.operation.type === "long_press")
            ? operator.operation.elementId
            : undefined;
        const normalizedTarget = normalizedElementId
          ? graph.elements.find(
              (element) => element.elementId === normalizedElementId,
            )
          : undefined;
        return {
          ...frontier,
          target: normalizedTarget
            ? {
                ...frontier.target,
                elementId: normalizedTarget.elementId,
                title: normalizedTarget.title,
                semanticRole: normalizedTarget.semanticRole,
                selector: normalizedTarget.selector,
              }
            : frontier.target,
          expectedEffectType,
          expectedStateFacts:
            frontier.expectedStateFacts ??
            inferExpectedStateFacts(frontier.target.title),
          effect: migratedEffect,
        };
      }),
  };
}

function skipDuplicateAndDecorativeActions(
  state: IosUiCrawlerState,
): IosUiCrawlerState {
  const completedSignatures = new Set(
    state.actionFrontiers
      .filter((frontier) => frontier.status === "completed")
      .flatMap((frontier) =>
        actionSemanticSignatures(
          frontier.sceneId,
          frontier.target,
          frontier.actionType,
        ),
      ),
  );
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map((frontier) => {
      if (
        frontier.sceneId === "bot.settings" &&
        /^icon[_\s-]/i.test(frontier.target.title) &&
        frontier.status !== "blocked"
      ) {
        return {
          ...frontier,
          status: "skipped" as const,
          completedAt: frontier.completedAt ?? new Date().toISOString(),
          issue:
            "Skipped decorative settings child; the containing row is the stable action target.",
        };
      }
      if (
        (frontier.status === "pending" || frontier.status === "failed") &&
        actionSemanticSignatures(
          frontier.sceneId,
          frontier.target,
          frontier.actionType,
        ).some((signature) => completedSignatures.has(signature))
      ) {
        return {
          ...frontier,
          status: "skipped" as const,
          completedAt: new Date().toISOString(),
          issue:
            "Skipped duplicate semantic action already covered in this Scene.",
        };
      }
      return frontier;
    }),
  };
}

function repairSkillDiscoveryState(
  state: IosUiCrawlerState,
): IosUiCrawlerState {
  const templateCovered = state.actionFrontiers.some(
    (frontier) =>
      frontier.sceneId === "skills.home" &&
      frontier.status === "completed" &&
      frontier.effect?.toSceneId === "skills.detail",
  );
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map((frontier) => {
      if (frontier.sceneId !== "skills.home") {
        return frontier;
      }
      const isViewportAction =
        frontier.target.selector.role === "VerticalScrollRegion" ||
        frontier.target.semanticRole === "VerticalScrollRegion";
      const isSkillEntry =
        frontier.actionType === "tap" &&
        (frontier.target.semanticRole === "skill_navigation_entry" ||
          isSkillTitleBounds(frontier.target.bounds));
      if (!isSkillEntry) {
        return isViewportAction ||
          frontier.status === "blocked" ||
          frontier.status === "skipped"
          ? frontier
          : {
              ...frontier,
              status: "skipped" as const,
              completedAt: frontier.completedAt ?? new Date().toISOString(),
              issue:
                "Skipped non-title content from the skills list; descriptions are semantic evidence, not action targets.",
            };
      }
      const title = frontier.target.title;
      const repairedTarget = {
        ...frontier.target,
        candidateId: `skills.${stableTextSlug(title)}`,
        elementId: `skills.home.${stableTextSlug(title)}`,
        semanticRole: "skill_navigation_entry",
      };
      const needsReplay =
        frontier.status === "pending" ||
        frontier.status === "running" ||
        frontier.status === "failed" ||
        frontier.target.elementId === "skills.home." ||
        (frontier.status === "completed" &&
          frontier.effect?.toSceneId !== "skills.detail");
      if (
        templateCovered &&
        needsReplay &&
        frontier.status !== "blocked" &&
        frontier.status !== "skipped"
      ) {
        return {
          ...frontier,
          target: repairedTarget,
          expectedEffectType: "new_scene" as const,
          expectedStateFacts: [`skill.name=${title}`],
          status: "skipped" as const,
          completedAt: frontier.completedAt ?? new Date().toISOString(),
          issue:
            "Template-covered by the verified skills.home → skills.detail page family; another skill instance is not a new page.",
        };
      }
      if (!needsReplay) {
        return {
          ...frontier,
          target: repairedTarget,
          expectedEffectType: "new_scene" as const,
          expectedStateFacts: [`skill.name=${title}`],
        };
      }
      return {
        ...frontier,
        target: repairedTarget,
        expectedEffectType: "new_scene" as const,
        expectedStateFacts: [`skill.name=${title}`],
        status: "pending" as const,
        attempts: 0,
        startedAt: undefined,
        completedAt: undefined,
        beforeObservationPath: undefined,
        afterObservationPath: undefined,
        operatorId: undefined,
        effect: undefined,
        issue: "Requeued after skills.detail classification was added.",
      };
    }),
  };
}

function reopenOverblockedSafeNavigationActions(
  state: IosUiCrawlerState,
): IosUiCrawlerState {
  return {
    ...state,
    status: "ready",
    updatedAt: new Date().toISOString(),
    actionFrontiers: state.actionFrontiers.map((frontier) => {
      const safeInformationNavigation =
        frontier.sceneId === "bot.settings.about_debug" ||
        frontier.sceneId === "bot.settings.customer_service" ||
        (frontier.sceneId ===
          "bot.settings.personal_information_collection_list" &&
          [
            "个人资料",
            "当前设备信息",
            "应用信息",
            "账号资料",
            "内容及互动",
            "社交及关系",
            "使用过程信息",
          ].includes(frontier.target.title)) ||
        (frontier.sceneId === "bot.settings" &&
          ["《个人信息清单》", "《三方信息共享清单》"].includes(
            frontier.target.title,
          )) ||
        (frontier.sceneId === "bot.settings.privacy.permissions" &&
          [
            "麦克风权限",
            "相机权限",
            "相册权限",
            "位置权限",
            "推送通知",
            "剪切板权限",
            "更多权限",
            "黑名单",
          ].includes(frontier.target.title));
      const safeInformationScroll =
        ["bot.settings.about_debug", "bot.settings.customer_service"].includes(
          frontier.sceneId,
        ) &&
        (frontier.actionType.startsWith("swipe") ||
          frontier.actionType.startsWith("drag"));
      const safeInformationTap =
        frontier.actionType === "tap" && safeInformationNavigation;
      if (
        frontier.status !== "blocked" ||
        (!safeInformationTap && !safeInformationScroll) ||
        (frontier.target.title === "相册权限" &&
          frontier.issue?.includes(
            "Permission entry is unavailable in the current App/account state",
          )) ||
        isBlockedPageEntry(frontier.target.title) ||
        /支付|购买|订阅|升级|订单|账号|退出|注销|切换|领取|生成|开始写歌|发送|提交|授权|允许/.test(
          frontier.target.title,
        )
      ) {
        return frontier;
      }
      return {
        ...frontier,
        risk: safeInformationScroll
          ? ("interaction" as const)
          : ("navigation" as const),
        expectedEffectType: safeInformationScroll
          ? ("viewport_change" as const)
          : ("new_scene" as const),
        status: "pending" as const,
        attempts: 0,
        startedAt: undefined,
        completedAt: undefined,
        beforeObservationPath: undefined,
        afterObservationPath: undefined,
        operatorId: undefined,
        effect: undefined,
        issue:
          "Reopened after narrowing the safety policy to block mutations instead of whole information pages.",
      };
    }),
  };
}

function reopenUnevidencedSemanticActions(
  state: IosUiCrawlerState,
): IosUiCrawlerState {
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map((frontier) => {
      if (
        frontier.status !== "completed" ||
        !frontier.operatorId?.startsWith("semantic.") ||
        !requiresLiveActionObservation(frontier) ||
        frontier.beforeObservationPath ||
        frontier.afterObservationPath
      ) {
        return frontier;
      }
      return {
        ...frontier,
        status: "pending" as const,
        attempts: 0,
        startedAt: undefined,
        completedAt: undefined,
        operatorId: undefined,
        effect: undefined,
        issue:
          "Reopened because a synthesized semantic Operator has no live before/after observation.",
      };
    }),
  };
}

function requiresLiveActionObservation(
  frontier: IosUiCrawlerActionFrontier,
): boolean {
  const role = frontier.target.semanticRole.toLocaleLowerCase();
  return (
    isPageEntryFrontier(frontier) ||
    role.includes("tab") ||
    role.includes("scroll") ||
    role.includes("list") ||
    frontier.expectedEffectType === "viewport_change"
  );
}

function repairKnownSceneRecoveryPaths(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerState {
  let customerServiceOperator: ExperimentOperator | undefined;
  for (const operator of graph.operators) {
    if (
      operator.fromSceneId !== "bot.settings" ||
      operator.toSceneId !== "bot.settings.customer_service" ||
      operator.operation.type !== "tap"
    ) {
      continue;
    }
    const elementId = operator.operation.elementId;
    if (
      graph.elements.some(
        (element) =>
          element.elementId === elementId && element.title === "帮助与反馈",
      )
    ) {
      customerServiceOperator = operator;
      break;
    }
  }
  const timeRangeRecoveryPath = [
    "chat.open_bot_settings",
    "bot.settings.a085cb3d7c19.tap.bot.settings.personal_information_collection_list",
    "bot.settings.personal_information_collection_list.app_info_entry.tap.bot.settings.personal_information_collection.app_info",
    "bot.settings.personal_information_collection.app_info.time_range_current_value.tap.bot.settings.personal_information_collection.time_range_menu",
  ];
  const hasTimeRangeRecoveryPath = timeRangeRecoveryPath.every((operatorId) =>
    graph.operators.some((operator) => operator.operatorId === operatorId),
  );
  const volcengineHomeScrollOperatorId =
    "volcengine.ark.docs.quickstart.body_scroll.swipe_down.volcengine.ark.docs.quickstart";
  const volcengineHomeOpenOperatorId =
    "volcengine.ark.docs.quickstart.open.tap.bot.settings.about_debug.model_about.volcengine_home";
  const repairPath = (sceneId: string, path: readonly string[]): string[] => {
    if (
      sceneId ===
        "bot.settings.personal_information_collection.time_range_menu" &&
      hasTimeRangeRecoveryPath
    ) {
      return [...timeRangeRecoveryPath];
    }
    if (
      sceneId === "bot.settings.about_debug.model_about.volcengine_home" &&
      path.includes(volcengineHomeOpenOperatorId) &&
      !path.includes(volcengineHomeScrollOperatorId)
    ) {
      const openIndex = path.indexOf(volcengineHomeOpenOperatorId);
      return [
        ...path.slice(0, openIndex),
        volcengineHomeScrollOperatorId,
        ...path.slice(openIndex),
      ];
    }
    if (
      sceneId !== "bot.settings.customer_service" &&
      !sceneId.startsWith("bot.settings.customer_service.")
    ) {
      return [...path];
    }
    return path.map((operatorId) =>
      customerServiceOperator &&
      operatorId === "bot.settings.settings.tap.bot.settings.customer_service"
        ? customerServiceOperator.operatorId
        : operatorId,
    );
  };
  return {
    ...state,
    sceneFrontiers: state.sceneFrontiers.map((frontier) => ({
      ...frontier,
      recoveryOperatorIds: repairPath(
        frontier.sceneId,
        frontier.recoveryOperatorIds,
      ),
    })),
    actionFrontiers: state.actionFrontiers.map((frontier) => ({
      ...frontier,
      recoveryOperatorIds: repairPath(
        frontier.sceneId,
        frontier.recoveryOperatorIds,
      ),
    })),
  };
}

function dedupePendingSemanticActions(
  state: IosUiCrawlerState,
): IosUiCrawlerState {
  const bestBySignature = new Map<string, IosUiCrawlerActionFrontier>();
  const ranking = (frontier: IosUiCrawlerActionFrontier): number => {
    const role = frontier.target.semanticRole.toLocaleLowerCase();
    return (
      (role.includes("navigation") || role.includes("entry") ? 20 : 0) +
      (role.includes("system_permission") ? 10 : 0) +
      frontier.target.bounds.width * frontier.target.bounds.height * 0.0001
    );
  };
  for (const frontier of state.actionFrontiers) {
    if (frontier.status !== "pending") {
      continue;
    }
    const signature = JSON.stringify([
      frontier.sceneId,
      normalizeText(frontier.target.title),
      frontier.actionType,
    ]);
    const current = bestBySignature.get(signature);
    if (!current || ranking(frontier) > ranking(current)) {
      bestBySignature.set(signature, frontier);
    }
  }
  const keepIds = new Set(
    [...bestBySignature.values()].map((frontier) => frontier.frontierId),
  );
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map((frontier) => {
      if (frontier.status !== "pending" || keepIds.has(frontier.frontierId)) {
        return frontier;
      }
      return {
        ...frontier,
        status: "skipped" as const,
        completedAt: new Date().toISOString(),
        issue:
          "Skipped duplicate pending action with the same Scene, title, and action type.",
      };
    }),
  };
}

function dedupePendingScrollActions(
  state: IosUiCrawlerState,
): IosUiCrawlerState {
  const selected = new Map<string, IosUiCrawlerActionFrontier>();
  for (const frontier of state.actionFrontiers) {
    if (
      frontier.status !== "pending" ||
      (!frontier.actionType.startsWith("swipe") &&
        !frontier.actionType.startsWith("drag"))
    ) {
      continue;
    }
    const key = JSON.stringify([frontier.sceneId, frontier.actionType]);
    const current = selected.get(key);
    const area = frontier.target.bounds.width * frontier.target.bounds.height;
    const currentArea = current
      ? current.target.bounds.width * current.target.bounds.height
      : -1;
    if (!current || area > currentArea) {
      selected.set(key, frontier);
    }
  }
  const keepIds = new Set(
    [...selected.values()].map((frontier) => frontier.frontierId),
  );
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map((frontier) => {
      if (
        frontier.status !== "pending" ||
        (!frontier.actionType.startsWith("swipe") &&
          !frontier.actionType.startsWith("drag")) ||
        keepIds.has(frontier.frontierId)
      ) {
        return frontier;
      }
      return {
        ...frontier,
        status: "skipped" as const,
        completedAt: new Date().toISOString(),
        issue:
          "Skipped duplicate scroll action for the same Scene and direction.",
      };
    }),
  };
}

export function repairPageCoverageActions(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerState {
  const liveSameSceneBySignature = new Map<
    string,
    IosUiCrawlerActionFrontier
  >();
  for (const frontier of state.actionFrontiers) {
    if (
      frontier.status === "completed" &&
      frontier.beforeObservationPath &&
      frontier.afterObservationPath &&
      frontier.effect &&
      ["no_effect", "state_change", "viewport_change"].includes(
        frontier.effect.type,
      ) &&
      frontier.effect.toSceneId === frontier.sceneId
    ) {
      liveSameSceneBySignature.set(
        JSON.stringify([
          frontier.sceneId,
          normalizeText(frontier.target.title),
          frontier.actionType,
        ]),
        frontier,
      );
    }
  }
  const liveCoveredEntrySignatures = new Set(
    state.actionFrontiers
      .filter(
        (frontier) =>
          frontier.status === "completed" &&
          frontier.beforeObservationPath &&
          frontier.afterObservationPath &&
          frontier.effect &&
          ["new_scene", "overlay", "external_scene"].includes(
            frontier.effect.type,
          ) &&
          frontier.effect.toSceneId !== frontier.sceneId,
      )
      .map((frontier) =>
        JSON.stringify([
          frontier.sceneId,
          normalizeText(frontier.target.title),
        ]),
      ),
  );
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map((frontier) => {
      if (
        frontier.status === "skipped" &&
        (frontier.issue?.includes(
          "Skipped underlying chat/keyboard residue outside the sidebar search control set.",
        ) ||
          frontier.issue?.includes(
            "Skipped the current document title; it is page identity",
          ) ||
          frontier.issue?.includes(
            "Skipped control captured from the external Volcengine WebView",
          ) ||
          frontier.issue?.includes(
            "Skipped underlying background control hidden by the active survey overlay",
          ))
      ) {
        return frontier;
      }
      const knownOperator = findPageNavigationOperator(frontier, graph);
      const pageEntry = isPageEntryFrontier(frontier);
      const entrySignature = JSON.stringify([
        frontier.sceneId,
        normalizeText(frontier.target.title),
      ]);
      const actionSignature = JSON.stringify([
        frontier.sceneId,
        normalizeText(frontier.target.title),
        frontier.actionType,
      ]);
      const liveSameScene = liveSameSceneBySignature.get(actionSignature);
      const hasLiveNavigationEvidence =
        Boolean(frontier.beforeObservationPath) &&
        Boolean(frontier.afterObservationPath) &&
        Boolean(
          frontier.effect &&
          ["new_scene", "overlay", "external_scene"].includes(
            frontier.effect.type,
          ) &&
          frontier.effect.toSceneId !== frontier.sceneId,
        );
      const hasLiveNonNavigationEvidence =
        Boolean(frontier.beforeObservationPath) &&
        Boolean(frontier.afterObservationPath) &&
        Boolean(
          frontier.effect &&
          ["no_effect", "state_change", "viewport_change"].includes(
            frontier.effect.type,
          ) &&
          frontier.effect.toSceneId === frontier.sceneId,
        );
      if (
        frontier.status === "pending" &&
        liveSameScene &&
        !frontier.beforeObservationPath &&
        !frontier.afterObservationPath
      ) {
        return {
          ...frontier,
          status: "completed" as const,
          completedAt: liveSameScene.completedAt ?? new Date().toISOString(),
          operatorId: liveSameScene.operatorId,
          effect: liveSameScene.effect,
          issue: "Covered by equivalent live same-Scene before/after evidence.",
        };
      }
      if (
        !pageEntry &&
        frontier.status === "pending" &&
        frontier.beforeObservationPath &&
        frontier.afterObservationPath &&
        frontier.issue?.includes("Requeued after an invalid crawler edge")
      ) {
        return {
          ...frontier,
          status: "completed" as const,
          completedAt: frontier.completedAt ?? new Date().toISOString(),
          effect: {
            type: "no_effect" as const,
            fromSceneId: frontier.sceneId,
            toSceneId: frontier.sceneId,
            title: frontier.sceneId,
            visualTextAnchors: [],
            description:
              "Live replay did not confirm a cross-Scene navigation.",
            confidence: 1,
          },
          issue:
            "Explored with live before/after evidence; no cross-Scene navigation was confirmed.",
        };
      }
      if (
        liveCoveredEntrySignatures.has(entrySignature) &&
        !hasLiveNavigationEvidence
      ) {
        return frontier;
      }
      if (
        knownOperator &&
        frontier.actionType === "tap" &&
        frontier.expectedEffectType === "new_scene" &&
        frontier.sceneId !== "skills.home" &&
        frontier.status !== "blocked" &&
        hasLiveNavigationEvidence
      ) {
        return {
          ...frontier,
          status: "completed" as const,
          completedAt: frontier.completedAt ?? new Date().toISOString(),
          operatorId: knownOperator.operatorId,
          effect: {
            type: "new_scene" as const,
            fromSceneId: knownOperator.fromSceneId,
            toSceneId: knownOperator.toSceneId,
            title:
              graph.scenes.find(
                (scene) => scene.sceneId === knownOperator.toSceneId,
              )?.title ?? knownOperator.toSceneId,
            visualTextAnchors: [],
            description:
              "Confirmed by live before/after observations and linked to the executable navigation edge.",
            confidence: knownOperator.reliability,
          },
          issue:
            "Covered by live before/after observations and an executable navigation edge.",
        };
      }
      if (
        frontier.status === "completed" &&
        pageEntry &&
        hasLiveNonNavigationEvidence
      ) {
        return {
          ...frontier,
          issue:
            "Explored with live before/after evidence; no cross-Scene navigation was confirmed.",
        };
      }
      const skippedStableNavigation =
        frontier.status === "skipped" &&
        Boolean(knownOperator) &&
        pageEntry &&
        !isSkippedStaticReverseEvidence(frontier, knownOperator!, state, graph);
      if (
        (frontier.status !== "completed" && !skippedStableNavigation) ||
        frontier.actionType !== "tap" ||
        !pageEntry ||
        frontier.sceneId === "skills.home" ||
        isBlockedPageEntry(frontier.target.title) ||
        hasLiveNavigationEvidence ||
        hasLiveNonNavigationEvidence
      ) {
        return frontier;
      }
      if (
        frontier.attempts >= state.budgets.maximumAttemptsPerAction &&
        !knownOperator
      ) {
        return {
          ...frontier,
          status: "blocked" as const,
          completedAt: frontier.completedAt ?? new Date().toISOString(),
          issue:
            "Safe page entry remained on the same Scene after the maximum replay attempts.",
        };
      }
      return {
        ...frontier,
        status: "pending" as const,
        attempts: knownOperator ? 0 : frontier.attempts,
        startedAt: undefined,
        completedAt: undefined,
        beforeObservationPath: undefined,
        afterObservationPath: undefined,
        operatorId: undefined,
        effect: undefined,
        issue:
          "Requeued because a safe page entry has no live before/after evidence of reaching a distinct Scene.",
      };
    }),
  };
}

function classifyConditionalAndEvidenceCoveredScenes(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerState {
  const conditionallyCovered = new Set([
    "chat.message_action_menu",
    "chat.message_more_menu",
  ]);
  const currentRunEvidenceCovered = new Set([
    "chat.sidebar.search",
    "skills.detail",
  ]);
  return {
    ...state,
    sceneFrontiers: state.sceneFrontiers.map((frontier) => {
      if (
        isReadOnlyScene(frontier.sceneId) &&
        graph.scenes.some(
          (scene) =>
            scene.sceneId === frontier.sceneId &&
            (scene.referenceAssets?.length ?? 0) > 0,
        )
      ) {
        return {
          ...frontier,
          status: "scanned" as const,
          updatedAt: new Date().toISOString(),
          issue:
            "Read-only covered from current-run reference evidence; call controls are inventoried but not executed.",
        };
      }
      if (conditionallyCovered.has(frontier.sceneId)) {
        return {
          ...frontier,
          status: "blocked" as const,
          updatedAt: new Date().toISOString(),
          issue:
            "Conditionally covered by historical evidence; live replay requires a matching fixture message.",
        };
      }
      const scene = graph.scenes.find(
        (candidate) => candidate.sceneId === frontier.sceneId,
      );
      if (
        currentRunEvidenceCovered.has(frontier.sceneId) &&
        (scene?.referenceAssets?.length ?? 0) > 0
      ) {
        return {
          ...frontier,
          status: "scanned" as const,
          updatedAt: new Date().toISOString(),
          issue:
            "Covered by current-run reference evidence; replay is not required for semantic coverage.",
        };
      }
      if (
        frontier.status === "failed" &&
        scene?.status === "verified" &&
        (scene.referenceAssets?.length ?? 0) > 0
      ) {
        return {
          ...frontier,
          status: "scanned" as const,
          updatedAt: new Date().toISOString(),
          issue:
            "Covered by verified reference evidence; current live fixture could not replay the Scene.",
        };
      }
      return frontier;
    }),
  };
}

function emptyObservationForStateRepair(
  frontier: IosUiCrawlerActionFrontier,
): TargetedDiscoveryObservation {
  return {
    observationId: "state-repair",
    screenshotPath: "",
    uiDumpPath: frontier.afterObservationPath ?? "",
    ocrPath: "",
    matchedSceneId: frontier.sceneId,
    candidateSceneId: frontier.sceneId,
    candidateSceneTitle: frontier.sceneId,
    visualTextAnchors: [],
    candidates: [],
  };
}

async function seedKnownSceneFrontiers(
  graph: ExecutableUiGraphExperiment,
  state: IosUiCrawlerState,
): Promise<IosUiCrawlerState> {
  const knownSceneIds = new Set(
    state.sceneFrontiers.map((frontier) => frontier.sceneId),
  );
  const operatorByFrom = new Map<string, ExperimentOperator[]>();
  for (const operator of graph.operators) {
    if (
      isBlockedRisk(operator.risk) ||
      (operator.status !== "verified" && operator.status !== "candidate") ||
      operator.fromSceneId === operator.toSceneId ||
      (operator.preconditions?.length ?? 0) > 0
    ) {
      continue;
    }
    const list = operatorByFrom.get(operator.fromSceneId) ?? [];
    list.push(operator);
    operatorByFrom.set(operator.fromSceneId, list);
  }
  const queue = state.sceneFrontiers
    .filter((frontier) => frontier.recoveryOperatorIds.length === 0)
    .map((frontier) => ({
      sceneId: frontier.sceneId,
      depth: frontier.depth,
      recoveryOperatorIds: [...frontier.recoveryOperatorIds],
    }));
  const visited = new Set<string>();
  const additions: IosUiCrawlerSceneFrontier[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (
      visited.has(current.sceneId) ||
      current.depth >= state.budgets.maximumDepth
    ) {
      continue;
    }
    visited.add(current.sceneId);
    for (const operator of operatorByFrom.get(current.sceneId) ?? []) {
      const recoveryOperatorIds = [
        ...current.recoveryOperatorIds,
        operator.operatorId,
      ];
      const next = {
        sceneId: operator.toSceneId,
        depth: current.depth + 1,
        recoveryOperatorIds,
      };
      queue.push(next);
      if (knownSceneIds.has(operator.toSceneId)) {
        continue;
      }
      const scene = graph.scenes.find(
        (candidate) => candidate.sceneId === operator.toSceneId,
      );
      if (!scene) {
        continue;
      }
      knownSceneIds.add(scene.sceneId);
      additions.push({
        frontierId: `scene.${safeSegment(scene.sceneId)}`,
        sceneId: scene.sceneId,
        title: scene.title,
        depth: next.depth,
        status: "pending_scan",
        recoveryOperatorIds,
        discoveredFromActionId: `known-operator.${operator.operatorId}`,
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return additions.length > 0
    ? {
        ...state,
        updatedAt: new Date().toISOString(),
        sceneFrontiers: [...state.sceneFrontiers, ...additions],
      }
    : state;
}

async function backfillSkillsActions(
  state: IosUiCrawlerState,
): Promise<IosUiCrawlerState> {
  const scene = state.sceneFrontiers.find(
    (frontier) =>
      frontier.sceneId === "skills.home" &&
      frontier.status === "scanned" &&
      frontier.observationPath,
  );
  if (
    !scene?.observationPath ||
    !(await Bun.file(scene.observationPath).exists())
  ) {
    return state;
  }
  const existing = new Set(
    state.actionFrontiers.flatMap((frontier) =>
      actionSemanticSignatures(
        frontier.sceneId,
        frontier.target,
        frontier.actionType,
      ),
    ),
  );
  const elements = parseUiDump(await Bun.file(scene.observationPath).text());
  const additions: IosUiCrawlerActionFrontier[] = [];
  const skillTitlePattern =
    /^(个股研究|估值建模|市场热点分析|业绩分析|公告解读|一级市场公司评估|财富规划|多股对比|选股工具)$/;
  for (const element of elements) {
    const title = (
      element.label ??
      element.text ??
      element.value ??
      element.accessibilityId ??
      ""
    ).trim();
    if (
      !element.bounds ||
      !skillTitlePattern.test(title) ||
      !isStableIdentityText(title)
    ) {
      continue;
    }
    const target: IosUiCrawlerElementTarget = {
      candidateId: `skills.${stableTextSlug(title)}`,
      elementId: `skills.home.${stableTextSlug(title)}`,
      title,
      semanticRole: "skill_navigation_entry",
      source: "ui_dump",
      selector: {
        accessibilityId: element.accessibilityId,
        label: element.label,
        text: element.text,
        value: element.value,
        role: element.role,
      },
      bounds: element.bounds,
    };
    const signatures = actionSemanticSignatures(scene.sceneId, target, "tap");
    if (signatures.some((signature) => existing.has(signature))) {
      continue;
    }
    for (const signature of signatures) {
      existing.add(signature);
    }
    additions.push({
      frontierId: actionFrontierId(scene.sceneId, target, "tap"),
      sceneId: scene.sceneId,
      sceneDepth: scene.depth,
      recoveryOperatorIds: scene.recoveryOperatorIds,
      target,
      actionType: "tap",
      risk: "navigation",
      expectedEffectType: "new_scene",
      expectedStateFacts: [`skill.name=${title}`],
      priority: 0.75,
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
      issue: "Backfilled stable skill entry from scanned UI dump.",
    });
  }
  const skillCount = elements.filter((element) =>
    skillTitlePattern.test(
      (
        element.label ??
        element.text ??
        element.value ??
        element.accessibilityId ??
        ""
      ).trim(),
    ),
  ).length;
  if (skillCount >= 6) {
    const target: IosUiCrawlerElementTarget = {
      candidateId: "skills.vertical.scroll",
      elementId: "skills.home.skill_list",
      title: "技能列表",
      semanticRole: "VerticalScrollRegion",
      source: "ui_dump",
      selector: {
        label: "技能列表",
        value: "个股研究|估值建模|市场热点分析|业绩分析",
        role: "VerticalScrollRegion",
      },
      bounds: { x: 24, y: 110, width: 366, height: 720 },
    };
    for (const actionType of ["swipe_up", "swipe_down"] as const) {
      const signatures = actionSemanticSignatures(
        scene.sceneId,
        target,
        actionType,
      );
      if (signatures.some((signature) => existing.has(signature))) {
        continue;
      }
      for (const signature of signatures) {
        existing.add(signature);
      }
      additions.push({
        frontierId: actionFrontierId(scene.sceneId, target, actionType),
        sceneId: scene.sceneId,
        sceneDepth: scene.depth,
        recoveryOperatorIds: scene.recoveryOperatorIds,
        target,
        actionType,
        risk: "interaction",
        expectedEffectType: "viewport_change",
        expectedStateFacts: [],
        priority: 0.6,
        status: "pending",
        attempts: 0,
        createdAt: new Date().toISOString(),
        issue: "Backfilled skill-list viewport action.",
      });
    }
  }
  return additions.length > 0
    ? {
        ...state,
        updatedAt: new Date().toISOString(),
        actionFrontiers: [...state.actionFrontiers, ...additions],
      }
    : state;
}

async function backfillStableNavigationActions(
  state: IosUiCrawlerState,
): Promise<IosUiCrawlerState> {
  const existing = new Set(
    state.actionFrontiers.flatMap((frontier) =>
      actionSemanticSignatures(
        frontier.sceneId,
        frontier.target,
        frontier.actionType,
      ),
    ),
  );
  const additions: IosUiCrawlerActionFrontier[] = [];
  for (const scene of state.sceneFrontiers) {
    if (
      scene.sceneId !== "bot.settings" ||
      scene.status !== "scanned" ||
      !scene.observationPath ||
      !(await Bun.file(scene.observationPath).exists())
    ) {
      continue;
    }
    const evidencePaths = [
      scene.observationPath,
      ...state.actionFrontiers
        .filter(
          (frontier) =>
            frontier.sceneId === scene.sceneId &&
            frontier.afterObservationPath &&
            (frontier.effect?.type === "viewport_change" ||
              frontier.effect?.type === "no_effect"),
        )
        .map((frontier) => frontier.afterObservationPath!),
    ];
    const deduped = new Map<string, ReturnType<typeof parseUiDump>[number]>();
    for (const evidencePath of new Set(evidencePaths)) {
      if (!(await Bun.file(evidencePath).exists())) {
        continue;
      }
      const elements = parseUiDump(await Bun.file(evidencePath).text());
      for (const element of elements) {
        if (!element.bounds) {
          continue;
        }
        const title = (
          element.label ??
          element.text ??
          element.value ??
          element.accessibilityId ??
          ""
        ).trim();
        if (
          !candidateBoundsWithinViewport(element.bounds) ||
          !isStableBackfillNavigationElement(
            title,
            element.role,
            element.bounds,
          )
        ) {
          continue;
        }
        const key = normalizeText(title);
        const current = deduped.get(key);
        if (
          !current ||
          element.bounds.width * element.bounds.height >
            (current.bounds?.width ?? 0) * (current.bounds?.height ?? 0)
        ) {
          deduped.set(key, element);
        }
      }
    }
    for (const element of deduped.values()) {
      const title = (
        element.label ??
        element.text ??
        element.value ??
        element.accessibilityId ??
        ""
      ).trim();
      const target: IosUiCrawlerElementTarget = {
        candidateId: `backfill.${safeSegment(title)}`,
        elementId: settingsRowElementId(title),
        title,
        semanticRole: element.role ?? "navigation_entry",
        source: "ui_dump",
        selector: {
          accessibilityId: element.accessibilityId,
          label: element.label,
          text: element.text,
          value: element.value,
          role: element.role,
        },
        bounds: element.bounds!,
      };
      const signatures = actionSemanticSignatures(scene.sceneId, target, "tap");
      if (signatures.some((signature) => existing.has(signature))) {
        continue;
      }
      const frontierId = actionFrontierId(scene.sceneId, target, "tap");
      const inventoryOnly = isBlockedPageEntry(title);
      const issue = inventoryOnly
        ? "Inventory-only page entry because it may change account, commerce, subscription, or user data."
        : crawlerActionSafetyIssue({
            target,
            actionType: "tap",
            risk: "navigation",
          });
      for (const signature of signatures) {
        existing.add(signature);
      }
      additions.push({
        frontierId,
        sceneId: scene.sceneId,
        sceneDepth: scene.depth,
        recoveryOperatorIds: scene.recoveryOperatorIds,
        target,
        actionType: "tap",
        risk: "navigation",
        expectedEffectType: "new_scene",
        expectedStateFacts: [],
        priority: 0.5,
        status: issue ? "blocked" : "pending",
        attempts: 0,
        createdAt: new Date().toISOString(),
        issue: issue ?? "Backfilled from scanned UI dump.",
      });
    }
  }
  return additions.length > 0
    ? {
        ...state,
        updatedAt: new Date().toISOString(),
        actionFrontiers: [...state.actionFrontiers, ...additions],
      }
    : state;
}

async function backfillActionBarActions(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): Promise<IosUiCrawlerState> {
  const sceneFrontier = state.sceneFrontiers.find(
    (frontier) =>
      frontier.sceneId === "chat.detail" && frontier.status === "scanned",
  );
  const scene = graph.scenes.find(
    (candidate) => candidate.sceneId === "chat.detail",
  );
  if (!sceneFrontier || !scene) {
    return state;
  }
  const actionBarTitles = new Set([
    "快速",
    "AI 创作",
    "帮我写作",
    "买前问豆包",
    "照片动起来",
    "AI写歌",
    "PPT 生成",
    "同声传译",
    "豆包 P 图",
    "博物馆讲解",
    "豆包爱学",
  ]);
  const evidencePaths = [
    ...scene.referenceAssets,
    ...(scene.stateVariants ?? []).flatMap(
      (variant) => variant.referenceAssets,
    ),
  ]
    .map((asset) => asset.uiDumpPath)
    .filter((path): path is string => Boolean(path));
  const observed = new Map<string, ReturnType<typeof parseUiDump>[number]>();
  for (const evidencePath of new Set(evidencePaths)) {
    if (!(await Bun.file(evidencePath).exists())) {
      continue;
    }
    for (const element of parseUiDump(await Bun.file(evidencePath).text())) {
      const title = (
        element.label ??
        element.text ??
        element.value ??
        element.accessibilityId ??
        ""
      ).trim();
      if (
        actionBarTitles.has(title) &&
        element.bounds &&
        element.bounds.y >= 700 &&
        element.bounds.y <= 810
      ) {
        observed.set(title, element);
      }
    }
  }
  const existing = new Set(
    state.actionFrontiers.flatMap((frontier) =>
      actionSemanticSignatures(
        frontier.sceneId,
        frontier.target,
        frontier.actionType,
      ),
    ),
  );
  const additions: IosUiCrawlerActionFrontier[] = [];
  for (const [title, element] of observed) {
    const identity = actionBarIdentity(title);
    const target: IosUiCrawlerElementTarget = {
      candidateId: `actionbar.${identity}`,
      elementId: `chat.detail.actionbar.${identity}`,
      title,
      semanticRole: "actionbar_navigation_entry",
      source: "ui_dump",
      selector: {
        accessibilityId: element.accessibilityId,
        label: element.label,
        text: element.text,
        value: element.value,
        role: element.role,
      },
      bounds: element.bounds!,
    };
    const signatures = actionSemanticSignatures(
      sceneFrontier.sceneId,
      target,
      "tap",
    );
    if (signatures.some((signature) => existing.has(signature))) {
      continue;
    }
    for (const signature of signatures) {
      existing.add(signature);
    }
    additions.push({
      frontierId: actionFrontierId(sceneFrontier.sceneId, target, "tap"),
      sceneId: sceneFrontier.sceneId,
      sceneDepth: sceneFrontier.depth,
      recoveryOperatorIds: sceneFrontier.recoveryOperatorIds,
      target,
      actionType: "tap",
      risk: "navigation",
      expectedEffectType: "new_scene",
      requiredStateFacts: actionBarRequiredStateFacts(title),
      expectedStateFacts: [`actionbar.feature=${identity}`],
      priority: 0.7,
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
      issue: "Backfilled ActionBar feature entry from captured viewports.",
    });
  }
  return additions.length > 0
    ? {
        ...state,
        updatedAt: new Date().toISOString(),
        actionFrontiers: [...state.actionFrontiers, ...additions],
      }
    : state;
}

function actionBarRequiredStateFacts(title: string): readonly string[] {
  if (["照片动起来", "AI写歌", "PPT 生成", "同声传译"].includes(title)) {
    return ["actionbar.position=middle"];
  }
  if (["豆包 P 图", "博物馆讲解", "豆包爱学"].includes(title)) {
    return ["actionbar.position=end"];
  }
  return [];
}

function backfillGraphElementActions(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerState {
  const existingSignatures = new Set(
    state.actionFrontiers.flatMap((frontier) =>
      actionSemanticSignatures(
        frontier.sceneId,
        frontier.target,
        frontier.actionType,
      ),
    ),
  );
  const sceneById = new Map(
    state.sceneFrontiers
      .filter((frontier) => frontier.status === "scanned")
      .map((frontier) => [frontier.sceneId, frontier]),
  );
  const additions: IosUiCrawlerActionFrontier[] = [];
  for (const element of graph.elements) {
    const scene = sceneById.get(element.sceneId);
    if (!scene) {
      continue;
    }
    const actions = graphElementActions(element).filter(
      (actionType) => actionType !== "long_press",
    );
    for (const actionType of actions) {
      const target = graphElementTarget(element);
      const signatures = actionSemanticSignatures(
        element.sceneId,
        target,
        actionType,
      );
      if (signatures.some((signature) => existingSignatures.has(signature))) {
        continue;
      }
      for (const signature of signatures) {
        existingSignatures.add(signature);
      }
      const risk = inferRisk(element.title);
      const issue = crawlerActionSafetyIssue({
        target,
        actionType,
        risk,
      });
      additions.push(
        applyPageActionPolicy({
          frontierId: actionFrontierId(element.sceneId, target, actionType),
          sceneId: element.sceneId,
          sceneDepth: scene.depth,
          recoveryOperatorIds: scene.recoveryOperatorIds,
          target,
          actionType,
          risk,
          expectedEffectType: inferExpectedEffectType(
            element.semanticRole,
            element.title,
          ),
          expectedStateFacts: inferExpectedStateFacts(element.title),
          priority: inferPriority(element.semanticRole, element.title),
          status: issue ? "blocked" : "pending",
          attempts: 0,
          createdAt: new Date().toISOString(),
          issue: issue ?? "Backfilled from the Agent-understood Graph Element.",
        }),
      );
    }
  }
  return additions.length > 0
    ? {
        ...state,
        updatedAt: new Date().toISOString(),
        actionFrontiers: [...state.actionFrontiers, ...additions],
      }
    : state;
}

function graphElementActions(
  element: ExperimentElement,
): IosUiCrawlerActionType[] {
  const semantics = normalizeText(
    [
      element.title,
      element.selector.label,
      element.selector.text,
      element.selector.value,
      element.semanticRole,
    ]
      .filter(Boolean)
      .join(" "),
  );
  if (semantics.includes("横向可滑动区域")) {
    return ["swipe_left", "swipe_right"];
  }
  if (semantics.includes("纵向可滑动区域")) {
    return ["swipe_up", "swipe_down"];
  }
  return deterministicApplicableActions(element.semanticRole, element.title);
}

function repairGraphCoveredActions(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerState {
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map((frontier) => {
      if (
        frontier.status !== "pending" ||
        (!frontier.actionType.startsWith("swipe") &&
          !frontier.actionType.startsWith("drag") &&
          frontier.actionType !== "tap" &&
          frontier.actionType !== "long_press")
      ) {
        return frontier;
      }
      const semanticId =
        frontier.actionType.startsWith("swipe") ||
        frontier.actionType.startsWith("drag")
          ? semanticOperatorId(frontier, frontier.sceneId)
          : undefined;
      const operator = graph.operators.find(
        (candidate) =>
          candidate.fromSceneId === frontier.sceneId &&
          candidate.status !== "stale" &&
          candidate.status !== "disabled" &&
          candidate.status !== "blocked" &&
          ((frontier.actionType === "tap" &&
            candidate.operation.type === "tap" &&
            candidate.operation.elementId === frontier.target.elementId) ||
            (frontier.actionType === "long_press" &&
              candidate.operation.type === "long_press" &&
              candidate.operation.elementId === frontier.target.elementId) ||
            (semanticId && candidate.operatorId === semanticId)),
      );
      if (!operator) {
        return frontier;
      }
      if (
        requiresLiveActionObservation(frontier) &&
        !frontier.beforeObservationPath &&
        !frontier.afterObservationPath
      ) {
        return frontier;
      }
      const stateFacts = [
        ...operator.effects,
        ...operator.postconditions,
      ].filter((value) => value.includes("="));
      return {
        ...frontier,
        status: "completed",
        completedAt: frontier.completedAt ?? new Date().toISOString(),
        operatorId: operator.operatorId,
        effect: {
          type:
            operator.fromSceneId === operator.toSceneId
              ? stateFacts.length > 0
                ? "state_change"
                : "no_effect"
              : "new_scene",
          fromSceneId: operator.fromSceneId,
          toSceneId: operator.toSceneId,
          title:
            graph.scenes.find((scene) => scene.sceneId === operator.toSceneId)
              ?.title ?? operator.toSceneId,
          visualTextAnchors: [],
          stateFacts,
          description: "Covered by an existing executable Graph Operator.",
          confidence: operator.reliability,
        },
        issue: "Covered by an existing executable Graph Operator.",
      };
    }),
  };
}

async function backfillReadOnlySceneElements(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
): Promise<ExecutableUiGraphExperiment> {
  const additions: ExperimentElement[] = [];
  const sceneAnchorIds = new Map<string, string[]>();
  for (const scene of graph.scenes) {
    if (!isReadOnlyScene(scene.sceneId)) {
      continue;
    }
    const uiDumpPath = [...scene.referenceAssets]
      .reverse()
      .find((asset) => asset.uiDumpPath)?.uiDumpPath;
    if (!uiDumpPath || !(await Bun.file(uiDumpPath).exists())) {
      continue;
    }
    for (const element of parseUiDump(await Bun.file(uiDumpPath).text())) {
      if (!element.bounds || !candidateBoundsWithinViewport(element.bounds)) {
        continue;
      }
      const title = (
        element.label ??
        element.text ??
        element.value ??
        element.accessibilityId ??
        ""
      ).trim();
      if (
        !title ||
        title.length > 32 ||
        /roomid:|link:|process:|^\d{1,2}:\d{2}$|勿扰模式/i.test(title)
      ) {
        continue;
      }
      const elementId = `readonly.${safeSegment(scene.sceneId)}.${createHash(
        "sha1",
      )
        .update(`${title}\0${element.role ?? ""}`)
        .digest("hex")
        .slice(0, 10)}`;
      if (
        graph.elements.some(
          (candidate) =>
            candidate.sceneId === scene.sceneId &&
            normalizeText(candidate.title) === normalizeText(title),
        ) ||
        additions.some((candidate) => candidate.elementId === elementId)
      ) {
        continue;
      }
      additions.push({
        elementId,
        sceneId: scene.sceneId,
        title,
        semanticRole: element.role ?? "read_only_control",
        selector: {
          accessibilityId: element.accessibilityId,
          label: element.label,
          text: element.text,
          value: element.value,
          role: element.role,
        },
        bindings: [],
      });
      const anchors = sceneAnchorIds.get(scene.sceneId) ?? [];
      anchors.push(elementId);
      sceneAnchorIds.set(scene.sceneId, anchors);
    }
  }
  if (additions.length === 0) {
    return graph;
  }
  const normalized: ExecutableUiGraphExperiment = {
    ...graph,
    scenes: graph.scenes.map((scene) => {
      const anchorElementIds = sceneAnchorIds.get(scene.sceneId);
      return anchorElementIds
        ? {
            ...scene,
            anchorElementIds: [
              ...new Set([...scene.anchorElementIds, ...anchorElementIds]),
            ],
          }
        : scene;
    }),
    elements: [...graph.elements, ...additions],
  };
  await writeGraph(graphPath, normalized);
  return normalized;
}

function sceneScopedElementId(sceneId: string, elementId: string): string {
  if (elementId.startsWith(`${safeSegment(sceneId)}.`)) {
    return elementId;
  }
  return stableGraphId(`${sceneId}.${elementId}`, "element");
}

function liveFrontierForElement(
  state: IosUiCrawlerState | null | undefined,
  sceneId: string,
  elementId: string,
): IosUiCrawlerActionFrontier | undefined {
  return state?.actionFrontiers
    .filter(
      (frontier) =>
        frontier.sceneId === sceneId && frontier.target.elementId === elementId,
    )
    .sort(
      (left, right) =>
        (right.beforeObservationPath ? 1 : 0) +
          (right.afterObservationPath ? 1 : 0) -
          ((left.beforeObservationPath ? 1 : 0) +
            (left.afterObservationPath ? 1 : 0)) ||
        right.attempts - left.attempts,
    )[0];
}

async function normalizeSceneScopedElementIdentityGraph(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
  state: IosUiCrawlerState | null | undefined,
): Promise<ExecutableUiGraphExperiment> {
  const scenesByElementId = new Map<string, Set<string>>();
  for (const element of graph.elements) {
    const scenes =
      scenesByElementId.get(element.elementId) ?? new Set<string>();
    scenes.add(element.sceneId);
    scenesByElementId.set(element.elementId, scenes);
  }
  for (const operator of graph.operators) {
    if (
      operator.operation.type !== "tap" &&
      operator.operation.type !== "long_press"
    ) {
      continue;
    }
    const scenes =
      scenesByElementId.get(operator.operation.elementId) ?? new Set<string>();
    scenes.add(operator.fromSceneId);
    scenesByElementId.set(operator.operation.elementId, scenes);
  }
  for (const frontier of state?.actionFrontiers ?? []) {
    const scenes =
      scenesByElementId.get(frontier.target.elementId) ?? new Set<string>();
    scenes.add(frontier.sceneId);
    scenesByElementId.set(frontier.target.elementId, scenes);
  }
  const conflictedIds = new Set(
    [...scenesByElementId]
      .filter(([, scenes]) => scenes.size > 1)
      .map(([elementId]) => elementId),
  );
  if (conflictedIds.size === 0) {
    return graph;
  }
  const elementsByKey = new Map<string, ExperimentElement>();
  const allPairs = new Set<string>();
  for (const [elementId, scenes] of scenesByElementId) {
    if (!conflictedIds.has(elementId)) {
      continue;
    }
    for (const sceneId of scenes) {
      allPairs.add(JSON.stringify([sceneId, elementId]));
    }
  }
  for (const key of allPairs) {
    const [sceneId, oldElementId] = JSON.parse(key) as [string, string];
    const existing = graph.elements.find(
      (element) =>
        element.elementId === oldElementId && element.sceneId === sceneId,
    );
    const fallback = graph.elements.find(
      (element) => element.elementId === oldElementId,
    );
    const frontier = liveFrontierForElement(state, sceneId, oldElementId);
    if (!existing && !fallback && !frontier) {
      continue;
    }
    const elementId = sceneScopedElementId(sceneId, oldElementId);
    const profile = graph.deviceProfiles.find(
      (candidate) => candidate.profileId === graph.defaultDeviceProfileId,
    );
    const fallbackBinding =
      frontier && profile
        ? {
            bindingId: `${elementId}.${profile.profileId}`,
            deviceProfileId: profile.profileId,
            normalizedPoint: {
              x:
                (frontier.target.bounds.x + frontier.target.bounds.width / 2) /
                profile.viewportWidth,
              y:
                (frontier.target.bounds.y + frontier.target.bounds.height / 2) /
                profile.viewportHeight,
            },
            source: "ui_dump" as const,
            status: "candidate" as const,
            reliability: 0.7,
            observedAt: new Date().toISOString(),
          }
        : undefined;
    elementsByKey.set(key, {
      ...(existing ??
        fallback ?? {
          elementId,
          sceneId,
          bindings: [],
          title: frontier!.target.title,
          semanticRole: frontier!.target.semanticRole,
          selector: frontier!.target.selector,
        }),
      elementId,
      sceneId,
      title: frontier?.target.title ?? existing?.title ?? fallback!.title,
      semanticRole:
        frontier?.target.semanticRole ??
        existing?.semanticRole ??
        fallback!.semanticRole,
      selector:
        frontier?.target.selector ?? existing?.selector ?? fallback!.selector,
      bindings: existing?.bindings.length
        ? existing.bindings
        : fallbackBinding
          ? [fallbackBinding]
          : (fallback?.bindings ?? []),
    });
  }
  const elementIdFor = (sceneId: string, elementId: string) =>
    conflictedIds.has(elementId)
      ? sceneScopedElementId(sceneId, elementId)
      : elementId;
  const normalized: ExecutableUiGraphExperiment = {
    ...graph,
    scenes: graph.scenes.map((scene) => ({
      ...scene,
      anchorElementIds: scene.anchorElementIds.map((elementId) =>
        elementIdFor(scene.sceneId, elementId),
      ),
    })),
    elements: [
      ...graph.elements.filter(
        (element) => !conflictedIds.has(element.elementId),
      ),
      ...elementsByKey.values(),
    ],
    operators: graph.operators.map((operator) => {
      if (
        operator.operation.type !== "tap" &&
        operator.operation.type !== "long_press"
      ) {
        return operator;
      }
      return {
        ...operator,
        operation: {
          ...operator.operation,
          elementId: elementIdFor(
            operator.fromSceneId,
            operator.operation.elementId,
          ),
        },
      };
    }),
  };
  await writeGraph(graphPath, normalized);
  return normalized;
}

function repairSceneScopedElementIdentityState(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerState {
  const elementBySceneAndTitle = new Map(
    graph.elements.map((element) => [
      JSON.stringify([element.sceneId, normalizeText(element.title)]),
      element,
    ]),
  );
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map((frontier) => {
      const scopedId = sceneScopedElementId(
        frontier.sceneId,
        frontier.target.elementId,
      );
      const element =
        graph.elements.find(
          (candidate) =>
            candidate.sceneId === frontier.sceneId &&
            candidate.elementId === scopedId,
        ) ??
        elementBySceneAndTitle.get(
          JSON.stringify([
            frontier.sceneId,
            normalizeText(frontier.target.title),
          ]),
        );
      if (!element) {
        return frontier;
      }
      return {
        ...frontier,
        target: {
          ...frontier.target,
          elementId: element.elementId,
          title: element.title,
          semanticRole: element.semanticRole,
          selector: element.selector,
        },
      };
    }),
  };
}

function actionSelectorSignature(frontier: IosUiCrawlerActionFrontier): string {
  return JSON.stringify([
    frontier.sceneId,
    frontier.actionType,
    frontier.target.selector.accessibilityId ?? "",
    frontier.target.selector.label ?? "",
    frontier.target.selector.text ?? "",
    frontier.target.selector.value ?? "",
  ]);
}

function mergeDuplicateActionEvidence(
  state: IosUiCrawlerState,
): IosUiCrawlerState {
  const byFrontierId = new Map<string, IosUiCrawlerActionFrontier[]>();
  for (const frontier of state.actionFrontiers) {
    const group = byFrontierId.get(frontier.frontierId) ?? [];
    group.push(frontier);
    byFrontierId.set(frontier.frontierId, group);
  }
  const mergedById: IosUiCrawlerActionFrontier[] = [];
  for (const group of byFrontierId.values()) {
    const live = group.find(
      (frontier) =>
        frontier.status === "completed" &&
        frontier.beforeObservationPath &&
        frontier.afterObservationPath &&
        frontier.effect,
    );
    const semantic = [...group].sort(
      (left, right) =>
        (right.target.semanticRole.toLocaleLowerCase().includes("navigation")
          ? 10
          : 0) -
          (left.target.semanticRole.toLocaleLowerCase().includes("navigation")
            ? 10
            : 0) || right.target.title.length - left.target.title.length,
    )[0]!;
    mergedById.push(
      live
        ? {
            ...semantic,
            status: "completed",
            attempts: Math.max(...group.map((frontier) => frontier.attempts)),
            completedAt: live.completedAt,
            beforeObservationPath: live.beforeObservationPath,
            afterObservationPath: live.afterObservationPath,
            operatorId: live.operatorId,
            effect: live.effect,
            issue:
              "Merged correct semantic target with equivalent live before/after evidence after Scene-scoped Element migration.",
          }
        : semantic,
    );
  }
  const liveBySelector = new Map<string, IosUiCrawlerActionFrontier>();
  for (const frontier of mergedById) {
    if (
      frontier.status === "completed" &&
      frontier.beforeObservationPath &&
      frontier.afterObservationPath &&
      frontier.effect
    ) {
      liveBySelector.set(actionSelectorSignature(frontier), frontier);
    }
  }
  return {
    ...state,
    actionFrontiers: mergedById.map((frontier) => {
      if (
        frontier.status !== "pending" ||
        frontier.beforeObservationPath ||
        frontier.afterObservationPath
      ) {
        return frontier;
      }
      const live = liveBySelector.get(actionSelectorSignature(frontier));
      return live
        ? {
            ...frontier,
            status: "completed" as const,
            completedAt: live.completedAt,
            beforeObservationPath: live.beforeObservationPath,
            afterObservationPath: live.afterObservationPath,
            operatorId: live.operatorId,
            effect: live.effect,
            issue:
              "Covered by selector-equivalent live before/after evidence after Scene-scoped Element migration.",
          }
        : frontier;
    }),
  };
}

const VOLCENGINE_EXPERIENCE_SCENE_ID = "volcengine.ark.console.experience";
const INVALID_VOLCENGINE_EXPERIENCE_OPERATOR_ID =
  "volcengine.ark.console.home.5s.tap.volcengine.ark.console.experience";
const VOLCENGINE_EXPERIENCE_ELEMENT_ID =
  "volcengine.ark.console.home.experience_entry";
const VOLCENGINE_EXPERIENCE_OPERATOR_ID =
  "volcengine.ark.console.home.experience_entry.tap.volcengine.ark.console.experience";

async function normalizeVolcengineExperienceEntryGraph(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
  state: IosUiCrawlerState | null | undefined,
): Promise<ExecutableUiGraphExperiment> {
  const incorrectFrontier = state?.actionFrontiers.find(
    (frontier) =>
      frontier.operatorId === INVALID_VOLCENGINE_EXPERIENCE_OPERATOR_ID &&
      frontier.beforeObservationPath,
  );
  const beforePath = incorrectFrontier?.beforeObservationPath;
  if (!beforePath || !(await Bun.file(beforePath).exists())) {
    return graph;
  }
  const target = parseUiDump(await Bun.file(beforePath).text()).find(
    (element) =>
      element.bounds &&
      normalizeText(
        element.label ??
          element.text ??
          element.value ??
          element.accessibilityId ??
          "",
      ) === normalizeText("体验"),
  );
  const profile = graph.deviceProfiles.find(
    (candidate) => candidate.profileId === graph.defaultDeviceProfileId,
  );
  if (!target?.bounds || !profile) {
    return graph;
  }
  const point = {
    x: (target.bounds.x + target.bounds.width / 2) / profile.viewportWidth,
    y: (target.bounds.y + target.bounds.height / 2) / profile.viewportHeight,
  };
  const existingElement = graph.elements.find(
    (element) => element.elementId === VOLCENGINE_EXPERIENCE_ELEMENT_ID,
  );
  const element: ExperimentElement = {
    ...(existingElement ?? {
      elementId: VOLCENGINE_EXPERIENCE_ELEMENT_ID,
      sceneId: "volcengine.ark.console.home",
      bindings: [],
    }),
    title: "体验",
    semanticRole: "navigation_entry",
    selector: {
      accessibilityId: target.accessibilityId,
      label: target.label,
      text: target.text,
      value: target.value,
      role: target.role,
    },
    bindings: mergeBinding(existingElement?.bindings ?? [], {
      bindingId: `${VOLCENGINE_EXPERIENCE_ELEMENT_ID}.${profile.profileId}`,
      deviceProfileId: profile.profileId,
      normalizedPoint: point,
      source: "ui_dump",
      status: "candidate",
      reliability: 0.7,
      observedAt: new Date().toISOString(),
    }),
  };
  const operator: ExperimentOperator = {
    operatorId: VOLCENGINE_EXPERIENCE_OPERATOR_ID,
    title: "打开火山方舟体验页",
    fromSceneId: "volcengine.ark.console.home",
    toSceneId: VOLCENGINE_EXPERIENCE_SCENE_ID,
    operation: { type: "tap", elementId: VOLCENGINE_EXPERIENCE_ELEMENT_ID },
    settleMs: DEFAULT_SETTLE_MS,
    risk: "navigation",
    status: "candidate",
    reliability: 0.7,
    preconditions: [],
    effects: ["scene.current=volcengine.ark.console.experience"],
    postconditions: ["scene.current=volcengine.ark.console.experience"],
  };
  const normalized: ExecutableUiGraphExperiment = {
    ...graph,
    elements: [
      ...graph.elements.filter(
        (candidate) =>
          candidate.elementId !== "volcengine.ark.console.home.5s" &&
          candidate.elementId !== VOLCENGINE_EXPERIENCE_ELEMENT_ID,
      ),
      element,
    ],
    operators: [
      ...graph.operators.filter(
        (candidate) =>
          candidate.operatorId !== INVALID_VOLCENGINE_EXPERIENCE_OPERATOR_ID &&
          candidate.operatorId !== VOLCENGINE_EXPERIENCE_OPERATOR_ID,
      ),
      operator,
    ],
  };
  if (JSON.stringify(normalized) !== JSON.stringify(graph)) {
    await writeGraph(graphPath, normalized);
  }
  return normalized;
}

function repairVolcengineExperienceEntryState(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerState {
  const replaceRecoveryPath = (operatorIds: readonly string[]) => {
    const replaced = operatorIds.map((operatorId) =>
      operatorId === INVALID_VOLCENGINE_EXPERIENCE_OPERATOR_ID
        ? VOLCENGINE_EXPERIENCE_OPERATOR_ID
        : operatorId,
    );
    const experienceIndex = replaced.indexOf(VOLCENGINE_EXPERIENCE_OPERATOR_ID);
    if (
      experienceIndex >= 0 &&
      replaced[experienceIndex - 1] !== "semantic.3796f2bd6b6112"
    ) {
      return [
        ...replaced.slice(0, experienceIndex),
        "semantic.3796f2bd6b6112",
        ...replaced.slice(experienceIndex),
      ];
    }
    return replaced;
  };
  const experienceElement = graph.elements.find(
    (element) => element.elementId === VOLCENGINE_EXPERIENCE_ELEMENT_ID,
  );
  const experienceTarget = experienceElement
    ? graphElementTarget(experienceElement)
    : undefined;
  const repairedActions = state.actionFrontiers.map((frontier) => {
    const recoveryOperatorIds = replaceRecoveryPath(
      frontier.recoveryOperatorIds,
    );
    const legacyLiveExperienceEvidence =
      frontier.sceneId === "volcengine.ark.console.home" &&
      frontier.target.title === "5s" &&
      frontier.beforeObservationPath &&
      frontier.afterObservationPath;
    if (
      frontier.operatorId !== INVALID_VOLCENGINE_EXPERIENCE_OPERATOR_ID &&
      !legacyLiveExperienceEvidence
    ) {
      return { ...frontier, recoveryOperatorIds };
    }
    const target = experienceTarget ?? {
      ...frontier.target,
      elementId: VOLCENGINE_EXPERIENCE_ELEMENT_ID,
      title: "体验",
      semanticRole: "navigation_entry",
      selector: {
        accessibilityId: "体验",
        label: "体验",
        role: "Button",
      },
    };
    return {
      ...frontier,
      frontierId: actionFrontierId(
        frontier.sceneId,
        target,
        frontier.actionType,
      ),
      recoveryOperatorIds,
      target,
      status: "completed" as const,
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      operatorId: VOLCENGINE_EXPERIENCE_OPERATOR_ID,
      effect: {
        type: "new_scene" as const,
        fromSceneId: "volcengine.ark.console.home",
        toSceneId: VOLCENGINE_EXPERIENCE_SCENE_ID,
        title: "火山方舟体验页",
        visualTextAnchors: [
          "火山方舟 - 体验",
          "欢迎来到",
          "精选",
          "语言",
          "Doubao-Seedance-2.5",
        ],
        description:
          "Live before/after evidence confirms that tapping the 体验 entry opens the full 火山方舟 experience page.",
        confidence: 1,
      },
      issue:
        "Corrected from a geometrically overlapping 5s control to the live 体验 navigation entry.",
    };
  });
  const dedupedActions = new Map<string, IosUiCrawlerActionFrontier>();
  for (const frontier of repairedActions) {
    const current = dedupedActions.get(frontier.frontierId);
    if (!current || current.status !== "completed") {
      dedupedActions.set(frontier.frontierId, frontier);
    }
  }
  return {
    ...state,
    sceneFrontiers: state.sceneFrontiers.map((frontier) => ({
      ...frontier,
      recoveryOperatorIds: replaceRecoveryPath(frontier.recoveryOperatorIds),
    })),
    actionFrontiers: [...dedupedActions.values()],
  };
}

function isReadOnlyScene(sceneId: string): boolean {
  return /(?:^|[._-])(?:call|voice_call|video_call)(?:$|[._-])/.test(sceneId);
}

function applyActionBarAvailabilityPolicy(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerState {
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map((frontier) => {
      if (
        frontier.sceneId !== "chat.detail" ||
        frontier.target.semanticRole !== "actionbar_navigation_entry" ||
        frontier.status === "completed" ||
        frontier.status === "blocked" ||
        frontier.attempts < 3 ||
        findPageNavigationOperator(frontier, graph)
      ) {
        return frontier;
      }
      return {
        ...frontier,
        status: "blocked" as const,
        completedAt: frontier.completedAt ?? new Date().toISOString(),
        issue:
          "ActionBar entry is unavailable in the current App version after bounded horizontal searches; historical evidence is retained.",
      };
    }),
  };
}

async function normalizeActionBarIdentityGraph(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
  state: IosUiCrawlerState | null | undefined,
): Promise<ExecutableUiGraphExperiment> {
  const titles = new Map<string, string>();
  for (const frontier of state?.actionFrontiers ?? []) {
    if (
      frontier.sceneId === "chat.detail" &&
      frontier.target.semanticRole === "actionbar_navigation_entry"
    ) {
      titles.set(normalizeText(frontier.target.title), frontier.target.title);
    }
  }
  for (const operator of graph.operators) {
    if (
      operator.fromSceneId !== "chat.detail" ||
      operator.operation.type !== "tap" ||
      !operator.operation.elementId.startsWith("chat.detail.actionbar.")
    ) {
      continue;
    }
    const title = operator.title.replace(/^tap\s+/i, "").trim();
    if (title) {
      titles.set(normalizeText(title), title);
    }
  }
  if (titles.size === 0) {
    return graph;
  }
  const actionBarElementIds = new Set(
    graph.elements
      .filter(
        (element) =>
          element.sceneId === "chat.detail" &&
          element.elementId.startsWith("chat.detail.actionbar.") &&
          element.semanticRole === "actionbar_navigation_entry",
      )
      .map((element) => element.elementId),
  );
  const migratedElements: ExperimentElement[] = [];
  for (const title of titles.values()) {
    const existing = graph.elements.find(
      (element) =>
        element.sceneId === "chat.detail" &&
        element.semanticRole === "actionbar_navigation_entry" &&
        normalizeText(element.title) === normalizeText(title),
    );
    migratedElements.push({
      ...(existing ?? {
        sceneId: "chat.detail",
        bindings: [],
      }),
      elementId: `chat.detail.actionbar.${actionBarIdentity(title)}`,
      title,
      semanticRole: "actionbar_navigation_entry",
      selector: {
        ...(existing?.selector ?? {}),
        accessibilityId: title,
        label: title,
        role: existing?.selector.role ?? "StaticText",
      },
    });
  }
  const migratedOperators = graph.operators.map((operator) => {
    if (
      operator.fromSceneId !== "chat.detail" ||
      operator.operation.type !== "tap" ||
      !actionBarElementIds.has(operator.operation.elementId)
    ) {
      return operator;
    }
    const title = operator.title.replace(/^tap\s+/i, "").trim();
    if (!titles.has(normalizeText(title))) {
      return operator;
    }
    const elementId = `chat.detail.actionbar.${actionBarIdentity(title)}`;
    return {
      ...operator,
      operation: { type: "tap" as const, elementId },
    };
  });
  const dedupedOperators = [
    ...new Map(
      migratedOperators.map((operator) => [operator.operatorId, operator]),
    ).values(),
  ];
  const normalized: ExecutableUiGraphExperiment = {
    ...graph,
    elements: [
      ...graph.elements.filter(
        (element) => !actionBarElementIds.has(element.elementId),
      ),
      ...migratedElements,
    ],
    operators: dedupedOperators,
  };
  if (JSON.stringify(normalized) !== JSON.stringify(graph)) {
    await writeGraph(graphPath, normalized);
  }
  return normalized;
}

function repairActionBarIdentityState(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerState {
  const deduped = new Map<string, IosUiCrawlerActionFrontier>();
  for (const frontier of state.actionFrontiers) {
    if (
      frontier.sceneId !== "chat.detail" ||
      frontier.target.semanticRole !== "actionbar_navigation_entry"
    ) {
      deduped.set(frontier.frontierId, frontier);
      continue;
    }
    const identity = actionBarIdentity(frontier.target.title);
    const target = {
      ...frontier.target,
      candidateId: `actionbar.${identity}`,
      elementId: `chat.detail.actionbar.${identity}`,
    };
    const operator = graph.operators.find(
      (candidate) =>
        candidate.fromSceneId === "chat.detail" &&
        candidate.operation.type === "tap" &&
        candidate.operation.elementId === target.elementId &&
        normalizeText(candidate.title.replace(/^tap\s+/i, "")) ===
          normalizeText(target.title),
    );
    const repaired: IosUiCrawlerActionFrontier = {
      ...frontier,
      frontierId: actionFrontierId("chat.detail", target, "tap"),
      target,
      operatorId: operator?.operatorId,
      effect: operator
        ? {
            type:
              operator.fromSceneId === operator.toSceneId
                ? "state_change"
                : "new_scene",
            fromSceneId: operator.fromSceneId,
            toSceneId: operator.toSceneId,
            title:
              graph.scenes.find((scene) => scene.sceneId === operator.toSceneId)
                ?.title ?? operator.toSceneId,
            visualTextAnchors: [],
            description:
              "Recovered after ActionBar element identity migration.",
            confidence: operator.reliability,
          }
        : frontier.effect,
      status: operator ? "completed" : frontier.status,
      completedAt: operator
        ? (frontier.completedAt ?? new Date().toISOString())
        : frontier.completedAt,
      issue: operator
        ? "Covered by a title-exact ActionBar navigation edge."
        : frontier.issue,
    };
    const current = deduped.get(repaired.frontierId);
    if (
      !current ||
      (current.status !== "completed" && repaired.status === "completed") ||
      repaired.attempts > current.attempts
    ) {
      deduped.set(repaired.frontierId, repaired);
    }
  }
  return {
    ...state,
    actionFrontiers: [...deduped.values()],
  };
}

function actionBarIdentity(title: string): string {
  const readable = safeSegment(title).toLocaleLowerCase() || "item";
  const hash = createHash("sha1").update(title).digest("hex").slice(0, 8);
  return `${readable}-${hash}`;
}

async function normalizeSettingsRowIdentityGraph(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
  state: IosUiCrawlerState | null | undefined,
): Promise<ExecutableUiGraphExperiment> {
  const titles = new Map<string, string>();
  for (const frontier of state?.actionFrontiers ?? []) {
    if (isSettingsRowFrontier(frontier)) {
      titles.set(normalizeText(frontier.target.title), frontier.target.title);
    }
  }
  for (const operator of graph.operators) {
    if (
      operator.fromSceneId !== "bot.settings" ||
      operator.operation.type !== "tap"
    ) {
      continue;
    }
    const title = operator.title.replace(/^(?:tap|打开)\s*/i, "").trim();
    if (title && !/返回|Chevron|设置入口/.test(title)) {
      titles.set(normalizeText(title), title);
    }
  }
  if (titles.size === 0) {
    return graph;
  }
  const migratedElements: ExperimentElement[] = [];
  for (const title of titles.values()) {
    const existing = graph.elements.find(
      (element) =>
        element.sceneId === "bot.settings" &&
        normalizeText(element.title) === normalizeText(title),
    );
    const elementId = settingsRowElementId(title);
    migratedElements.push({
      ...(existing ?? {
        sceneId: "bot.settings",
        bindings: [],
      }),
      elementId,
      title,
      semanticRole: "settings_navigation_entry",
      selector: {
        ...(existing?.selector ?? {}),
        accessibilityId: title,
        label: title,
        role: existing?.selector.role ?? "StaticText",
      },
    });
  }
  const migratedTitleKeys = new Set(titles.keys());
  const migratedOperators = graph.operators.map((operator) => {
    if (
      operator.fromSceneId !== "bot.settings" ||
      operator.operation.type !== "tap"
    ) {
      return operator;
    }
    const title = operator.title.replace(/^(?:tap|打开)\s*/i, "").trim();
    return migratedTitleKeys.has(normalizeText(title))
      ? {
          ...operator,
          operation: {
            type: "tap" as const,
            elementId: settingsRowElementId(title),
          },
        }
      : operator;
  });
  const migratedElementTitles = new Set(
    migratedElements.map((element) => normalizeText(element.title)),
  );
  const normalized: ExecutableUiGraphExperiment = {
    ...graph,
    elements: [
      ...graph.elements.filter(
        (element) =>
          element.sceneId !== "bot.settings" ||
          !migratedElementTitles.has(normalizeText(element.title)) ||
          [
            "bot.settings_back",
            "bot.settings.chevron-left",
            "settings_more_button",
            "settings_scroll_region",
          ].includes(element.elementId),
      ),
      ...migratedElements,
    ],
    operators: migratedOperators,
  };
  if (JSON.stringify(normalized) !== JSON.stringify(graph)) {
    await writeGraph(graphPath, normalized);
  }
  return normalized;
}

function repairSettingsRowIdentityState(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerState {
  const repaired = state.actionFrontiers.map((frontier) => {
    if (!isSettingsRowFrontier(frontier)) {
      return frontier;
    }
    const target = {
      ...frontier.target,
      elementId: settingsRowElementId(frontier.target.title),
      semanticRole: "settings_navigation_entry",
    };
    const operator = graph.operators.find(
      (candidate) =>
        candidate.fromSceneId === "bot.settings" &&
        candidate.operation.type === "tap" &&
        candidate.operation.elementId === target.elementId &&
        normalizeText(candidate.title.replace(/^(?:tap|打开)\s*/i, "")) ===
          normalizeText(target.title),
    );
    const operatorMatchesCurrentEffect =
      operator &&
      (!frontier.effect ||
        frontier.effect.type === "no_effect" ||
        frontier.effect.toSceneId === operator.toSceneId);
    return {
      ...frontier,
      frontierId: actionFrontierId("bot.settings", target, "tap"),
      target,
      operatorId: operatorMatchesCurrentEffect
        ? operator.operatorId
        : undefined,
      effect: operatorMatchesCurrentEffect
        ? {
            type:
              operator!.fromSceneId === operator!.toSceneId
                ? ("state_change" as const)
                : ("new_scene" as const),
            fromSceneId: operator!.fromSceneId,
            toSceneId: operator!.toSceneId,
            title:
              graph.scenes.find(
                (scene) => scene.sceneId === operator!.toSceneId,
              )?.title ?? operator!.toSceneId,
            visualTextAnchors: [],
            description:
              "Recovered after settings-row element identity migration.",
            confidence: operator!.reliability,
          }
        : undefined,
      status:
        operatorMatchesCurrentEffect && frontier.status !== "blocked"
          ? ("completed" as const)
          : frontier.status === "completed" &&
              frontier.effect?.type === "new_scene"
            ? ("pending" as const)
            : frontier.status,
      completedAt:
        operatorMatchesCurrentEffect && frontier.status !== "blocked"
          ? (frontier.completedAt ?? new Date().toISOString())
          : frontier.status === "completed" &&
              frontier.effect?.type === "new_scene"
            ? undefined
            : frontier.completedAt,
      issue:
        operatorMatchesCurrentEffect && frontier.status !== "blocked"
          ? "Covered by a title-exact settings-row navigation edge."
          : frontier.status === "completed" &&
              frontier.effect?.type === "new_scene"
            ? "Requeued after settings-row identity collision was repaired."
            : frontier.issue,
    };
  });
  const deduped = new Map<string, IosUiCrawlerActionFrontier>();
  for (const frontier of repaired) {
    const current = deduped.get(frontier.frontierId);
    if (
      !current ||
      (current.status !== "completed" && frontier.status === "completed") ||
      (current.status === frontier.status &&
        frontier.attempts > current.attempts)
    ) {
      deduped.set(frontier.frontierId, frontier);
    }
  }
  return {
    ...state,
    actionFrontiers: [...deduped.values()],
  };
}

function isSettingsRowFrontier(frontier: IosUiCrawlerActionFrontier): boolean {
  return (
    frontier.sceneId === "bot.settings" &&
    frontier.actionType === "tap" &&
    !/返回|Chevron|ic settings normal|设置列表|icon_/i.test(
      frontier.target.title,
    ) &&
    (frontier.target.bounds.width >= 250 ||
      frontier.target.semanticRole.includes("settings_navigation_entry"))
  );
}

function settingsRowElementId(title: string): string {
  return `bot.settings.row.${actionBarIdentity(title)}`;
}

function isStableBackfillNavigationElement(
  title: string,
  role: string | undefined,
  bounds: IosUiCrawlerElementTarget["bounds"],
): boolean {
  if (
    title.length < 2 ||
    title.length > 24 ||
    !isStableIdentityText(title) ||
    /用户\d+|user[_:]|Version|OfficeSDK|照片，20\d\d|未选中，照片/.test(
      title,
    ) ||
    /发送|删除|支付|购买|下单|提交|发布|授权|允许|注销|清空/.test(title) ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.x + bounds.width > 414 ||
    bounds.y + bounds.height > 896
  ) {
    return false;
  }
  const normalizedRole = role?.toLocaleLowerCase() ?? "";
  const largeRow = bounds.width >= 250 && bounds.height >= 40;
  const navigationText =
    /设置|管理|形象|声音|背景|记忆|通知|话题|查找|模式|行为|隐私|帮助|官网|关于|设备|云盘|文件|相册|搜索|技能|返回|关闭|取消|更多|钱包|订单|账号|登录|清单|专业版|升级/.test(
      title,
    );
  return (normalizedRole.includes("button") || largeRow) && navigationText;
}

function candidateBoundsWithinViewport(
  bounds: IosUiCrawlerElementTarget["bounds"],
): boolean {
  return (
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= 414 &&
    bounds.y + bounds.height <= 896
  );
}

function actionSemanticSignatures(
  sceneId: string,
  target: IosUiCrawlerElementTarget,
  actionType: IosUiCrawlerActionType,
): string[] {
  return [
    ...new Set(
      [
        target.selector.accessibilityId,
        target.selector.label,
        target.selector.text,
        target.selector.value,
        target.title,
      ]
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) =>
          JSON.stringify([sceneId, actionType, normalizeText(value)]),
        ),
    ),
  ];
}

export function generateActionFrontiers(options: {
  state: IosUiCrawlerState;
  frontier: IosUiCrawlerSceneFrontier;
  observation: TargetedDiscoveryObservation;
  scan: SceneScanProposal;
  maximum: number;
  viewport?: ViewportDimensions;
}): IosUiCrawlerActionFrontier[] {
  const existing = new Set(
    options.state.actionFrontiers.map((frontier) => frontier.frontierId),
  );
  const byCandidate = new Map(
    businessCandidates(
      options.observation,
      options.viewport ?? { width: 414, height: 896 },
    ).map((candidate) => [candidate.candidateId, candidate]),
  );
  const actions: IosUiCrawlerActionFrontier[] = [];
  for (const element of options.scan.elements) {
    const candidate = byCandidate.get(element.candidateId);
    if (!candidate || !candidate.bounds) {
      continue;
    }
    const target: IosUiCrawlerElementTarget = {
      candidateId: candidate.candidateId,
      elementId: scannedElementId(
        options.frontier.sceneId,
        element.title.trim() || primaryCandidateText(candidate),
        element.semanticRole.trim() || candidate.role || "element",
        element.elementId,
        candidate.bounds,
      ),
      title: element.title.trim() || primaryCandidateText(candidate),
      semanticRole: element.semanticRole.trim() || candidate.role || "element",
      source: candidate.source,
      selector: {
        accessibilityId: candidate.accessibilityId,
        label: candidate.label,
        text: candidate.text,
        value: candidate.value,
        role: candidate.role,
      },
      bounds: candidate.bounds,
    };
    for (const actionType of applicableActions(target, element.actions)) {
      const frontierId = actionFrontierId(
        options.frontier.sceneId,
        target,
        actionType,
      );
      if (existing.has(frontierId)) {
        continue;
      }
      existing.add(frontierId);
      const issue = crawlerActionSafetyIssue({
        target,
        actionType,
        risk: element.risk,
      });
      actions.push(
        applyPageActionPolicy({
          frontierId,
          sceneId: options.frontier.sceneId,
          sceneDepth: options.frontier.depth,
          recoveryOperatorIds: options.frontier.recoveryOperatorIds,
          target,
          actionType,
          risk: element.risk,
          expectedEffectType: normalizeExpectedEffectType(
            element.expectedEffectType,
            target.semanticRole,
            target.title,
            element.risk,
          ),
          requiredStateFacts: element.requiredStateFacts ?? [],
          expectedStateFacts:
            element.expectedStateFacts ?? inferExpectedStateFacts(target.title),
          undoHint: element.undoHint || undefined,
          priority: element.priority,
          status: issue ? "blocked" : "pending",
          attempts: 0,
          createdAt: new Date().toISOString(),
          issue: issue ?? undefined,
        }),
      );
    }
  }
  return actions
    .sort(
      (left, right) =>
        actionSessionPriority(left) - actionSessionPriority(right) ||
        right.priority - left.priority,
    )
    .slice(0, options.maximum);
}

function applyPageActionPolicies(state: IosUiCrawlerState): IosUiCrawlerState {
  return {
    ...state,
    actionFrontiers: state.actionFrontiers.map(applyPageActionPolicy),
  };
}

function applyPageActionPolicy(
  frontier: IosUiCrawlerActionFrontier,
): IosUiCrawlerActionFrontier {
  const normalizedRole = frontier.target.semanticRole.toLocaleLowerCase();
  if (
    (frontier.actionType.startsWith("swipe") ||
      frontier.actionType.startsWith("drag")) &&
    !normalizedRole.includes("scroll") &&
    !normalizedRole.includes("list") &&
    !normalizedRole.includes("carousel")
  ) {
    return {
      ...frontier,
      status: "skipped",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Skipped gesture attached to a non-scroll Element after Scene-scoped identity repair.",
    };
  }
  if (
    (frontier.actionType.startsWith("swipe") ||
      frontier.actionType.startsWith("drag")) &&
    /勿扰模式|^\d{1,2}:\d{2}$|(?:^|\|)\d{1,2}:\d{2}(?:$|\|)/.test(
      frontier.target.selector.value ??
        frontier.target.selector.label ??
        frontier.target.title,
    )
  ) {
    return {
      ...frontier,
      status: "skipped",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Skipped OCR-derived gesture region contaminated by status-bar content.",
    };
  }
  if (
    frontier.sceneId === "volcengine.ark.console.home" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    [
      "Doubao-Seedance-2.5",
      "Doubao-Seedance-2.5 260628",
      "5s",
      "15s",
      "16:9",
      "720P",
      "1 条",
      "调用总量 tokens",
      "复制",
      "收起浮层",
    ].includes(frontier.target.title)
  ) {
    return {
      ...frontier,
      status: "skipped",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only console parameter or utility control; retained as an Element/state option without repeated replay.",
    };
  }
  if (
    frontier.sceneId.startsWith("volcengine.ark.console") &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    /账户充值|开通模型|注册\/登录/.test(frontier.target.title)
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only account activation or paid service action; retained without execution.",
    };
  }
  if (
    frontier.sceneId === "bot.settings.about_debug.privacy_summary" &&
    frontier.target.title === "隐私政策简明版" &&
    frontier.target.bounds.y < 100
  ) {
    return {
      ...frontier,
      status: "skipped",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Skipped the current document title; it is page identity, not a navigation entry.",
    };
  }
  if (
    frontier.sceneId === "bot.settings.about_debug.model_about" &&
    [
      "文档目录",
      "火山方舟",
      "文档指南",
      "API参考",
      "API 参考",
      "资源",
    ].includes(frontier.target.title) &&
    frontier.target.candidateId.startsWith("reference-")
  ) {
    return {
      ...frontier,
      status: "skipped",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Skipped control captured from the external Volcengine WebView; it does not belong to the in-App model-about Scene.",
    };
  }
  if (
    frontier.sceneId === "chat.sidebar.search" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    !frontier.beforeObservationPath &&
    !frontier.afterObservationPath
  ) {
    const stableSearchControl = [
      "搜索",
      "取消",
      "全部",
      "消息",
      "云盘",
      "搜索结果滚动区",
    ].includes(frontier.target.title);
    if (!stableSearchControl) {
      return {
        ...frontier,
        status: "skipped",
        completedAt: frontier.completedAt ?? new Date().toISOString(),
        issue:
          "Skipped underlying chat/keyboard residue outside the sidebar search control set.",
      };
    }
  }
  const genericTextOrImage =
    normalizedRole === "statictext" ||
    normalizedRole === "image" ||
    normalizedRole === "textobservation";
  if (
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    genericTextOrImage
  ) {
    const debugNavigation =
      frontier.sceneId === "bot.settings.about_debug" &&
      [
        "用户协议",
        "隐私政策简明版",
        "隐私政策",
        "应用权限",
        "使用规范",
        "侵权投诉指引",
        "营业执照",
        "ICP 备案",
        "关于豆包大模型",
        "资质规则",
        "平台资质",
        "隐私中心",
        "规则中心",
        "豆包购物及钱包功能FAQ",
      ].includes(frontier.target.title);
    const customerServiceQuestion =
      frontier.sceneId === "bot.settings.customer_service" &&
      /为什么|怎么|如何|忘记|账号被盗|[？?]$/.test(frontier.target.title);
    if (debugNavigation || customerServiceQuestion) {
      return {
        ...frontier,
        risk: "navigation",
        expectedEffectType: "new_scene",
      };
    }
    return {
      ...frontier,
      status: "skipped",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Skipped non-interactive OCR/static text or decorative image; retained as an Element only.",
    };
  }
  if (
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    /订阅|付费|购买|升级套餐/.test(frontier.target.title)
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only subscription or paid entry; paid flows are excluded from this page-map exploration.",
    };
  }
  if (
    frontier.sceneId === "bot.settings.ai_role_backup" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    /迁移|导出|备份/.test(frontier.target.title)
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only account migration action; AI role export or migration is not executed.",
    };
  }
  if (
    frontier.sceneId.startsWith(
      "bot.settings.personal_information_collection",
    ) &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    frontier.target.title === "关联第三方账号"
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only account-linked information entry; multi-account details are excluded from generic page discovery.",
    };
  }
  if (
    frontier.sceneId === "volcengine.ark.docs.quickstart" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    frontier.target.title === "我的收藏"
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only user collection entry; account-specific favorites are excluded from generic page discovery.",
    };
  }
  if (
    frontier.sceneId === "volcengine.ark.feedback.survey" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    frontier.target.title === "开通模型"
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only model activation entry; activation and paid service setup are excluded.",
    };
  }
  if (
    frontier.sceneId === "bot.settings.privacy.permissions" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    frontier.target.title === "相册权限" &&
    (frontier.attempts >= 4 ||
      frontier.issue?.includes(
        "Reopened after narrowing the safety policy to block mutations instead of whole information pages.",
      ))
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Permission entry is unavailable in the current App/account state after four live relocation attempts.",
    };
  }
  if (
    frontier.sceneId === "volcengine.ark.feedback.survey" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    ["展开侧导", "全部产品", "跳转步骤", "问卷反馈"].includes(
      frontier.target.title,
    )
  ) {
    return {
      ...frontier,
      status: "skipped",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Skipped underlying background control hidden by the active survey overlay.",
    };
  }
  if (
    frontier.sceneId === "chat.buy_before_ask.more_menu" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    (frontier.actionType.startsWith("swipe") ||
      frontier.actionType.startsWith("drag"))
  ) {
    return {
      ...frontier,
      status: "skipped",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Skipped underlying shopping-page scroll while the more-actions overlay is active.",
    };
  }
  if (
    frontier.sceneId.includes("permission.dialog") &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    frontier.target.title === "去设置"
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only external system navigation; opening iOS Settings is outside the in-App page map.",
    };
  }
  if (
    frontier.sceneId === "chat.image_generation.panel" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    frontier.target.title === "参考图"
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only personal-media entry; the user's photo library is not opened during generic page discovery.",
    };
  }
  if (
    frontier.sceneId === "bot.settings" &&
    ["云盘存储", "未成年人模式", "工作任务模式设置"].includes(
      frontier.target.title,
    ) &&
    !frontier.operatorId &&
    !frontier.effect
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        frontier.target.title === "云盘存储"
          ? "Informational settings row without a stable navigation affordance; retained as an Element only."
          : "Settings entry is unavailable in the current account/App state after bounded replay attempts; historical evidence is retained.",
    };
  }
  if (
    frontier.status === "pending" &&
    frontier.actionType === "long_press" &&
    !/message|card/.test(frontier.target.semanticRole.toLocaleLowerCase()) &&
    !/消息|卡片/.test(frontier.target.title)
  ) {
    return {
      ...frontier,
      status: "skipped",
      completedAt: new Date().toISOString(),
      issue:
        "Skipped long-press without a stable message or card interaction contract.",
    };
  }
  if (
    isReadOnlyScene(frontier.sceneId) &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped"
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only call control; call, microphone, camera, caption, and hang-up controls are not executed.",
    };
  }
  if (
    /^(?:bot\.settings\.(?:subscription|avatar|default_mode_menu))$/.test(
      frontier.sceneId,
    ) &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    !/返回|关闭|取消|滚动/.test(frontier.target.title)
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only account or selection control; subscription, avatar, and default-mode changes are not executed.",
    };
  }
  if (
    frontier.sceneId === "chat.buy_before_ask.more_menu" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    !/关闭|滚动/.test(frontier.target.title)
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only commerce shortcut; preset queries and order access are not executed.",
    };
  }
  if (
    frontier.sceneId === "chat.doubao.aixue" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    frontier.target.title === "历史记录"
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only account history entry; user-specific history is not opened during generic page discovery.",
    };
  }
  if (
    frontier.sceneId === "photo.album.selector" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped"
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only user album entry; personal album contents are not opened during generic page discovery.",
    };
  }
  if (
    frontier.sceneId === "chat.ai_song" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    /开始写歌/.test(frontier.target.title)
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only generation action; starting song generation is not executed during page discovery.",
    };
  }
  if (
    /^(?:chat\.ppt\.generate\.panel|chat\.write_assistant\.panel)$/.test(
      frontier.sceneId,
    ) &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped"
  ) {
    const title = frontier.target.title;
    if (/分享|打电话|点赞|点踩|复制|按住说话|换行|Shift|表情/.test(title)) {
      return {
        ...frontier,
        status: "blocked",
        completedAt: frontier.completedAt ?? new Date().toISOString(),
        issue:
          "Inventory-only side-effect control; sharing, calling, feedback, clipboard, and text-entry actions are not executed.",
      };
    }
  }
  if (
    frontier.sceneId === "bot.settings" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    frontier.target.title === "云盘存储"
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Informational settings row without a stable navigation affordance; retained as an Element only.",
    };
  }
  if (
    frontier.sceneId === "bot.settings" &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    ["未成年人模式", "工作任务模式设置"].includes(frontier.target.title) &&
    frontier.attempts >= 2
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Settings entry is unavailable in the current account/App state after bounded replay attempts; historical evidence is retained.",
    };
  }
  if (
    frontier.sceneId.startsWith("bot.settings") &&
    frontier.status !== "completed" &&
    frontier.status !== "blocked" &&
    frontier.status !== "skipped" &&
    /toggle|switch|checkbox/.test(
      frontier.target.semanticRole.toLocaleLowerCase(),
    )
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only settings mutation; switches and toggles are not changed during page discovery.",
    };
  }
  if (
    frontier.sceneId !== "chat.buy_before_ask" ||
    frontier.status === "completed" ||
    frontier.status === "blocked" ||
    frontier.status === "skipped"
  ) {
    return frontier;
  }
  const title = frontier.target.title.trim();
  const role = frontier.target.semanticRole.toLocaleLowerCase();
  const stableAllowed =
    /关闭当前页面|打开更多操作|更多面板|输入区工具栏横向滚动|买前问内容滚动区|语音输入/.test(
      title,
    );
  if (!stableAllowed) {
    if (
      role.includes("statictext") ||
      role.includes("verticalscrollregion") ||
      title === "勿扰模式"
    ) {
      return {
        ...frontier,
        status: "skipped",
        completedAt: frontier.completedAt ?? new Date().toISOString(),
        issue:
          "Skipped dynamic recommendation content; it is semantic evidence, not a stable page action target.",
      };
    }
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only non-whitelisted Buy Before Ask action; it may submit a query, claim a promotion, or use commerce/account data.",
    };
  }
  if (
    title === "勿扰模式" ||
    (role.includes("statictext") && !/关闭|更多|语音|输入|滚动/.test(title)) ||
    (role.includes("verticalscrollregion") && title !== "买前问内容滚动区")
  ) {
    return {
      ...frontier,
      status: "skipped",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Skipped dynamic recommendation content; it is semantic evidence, not a stable page action target.",
    };
  }
  if (
    /我的订单|七夕送礼|商品对比|商品测评|扒成分参数|按预算挑|避坑指南/.test(
      title,
    )
  ) {
    return {
      ...frontier,
      status: "blocked",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Inventory-only commerce or preset-query action; executing it may use account data or submit a business query.",
    };
  }
  if (title === "按住说话") {
    return {
      ...frontier,
      status: "skipped",
      completedAt: frontier.completedAt ?? new Date().toISOString(),
      issue:
        "Skipped duplicate composer mode action already represented by the stable voice-input control.",
    };
  }
  return frontier;
}

function actionSessionPriority(frontier: IosUiCrawlerActionFrontier): number {
  if (frontier.status === "blocked") {
    return 3;
  }
  if (
    frontier.expectedEffectType === "state_change" ||
    frontier.expectedEffectType === "viewport_change"
  ) {
    return 0;
  }
  if (
    frontier.expectedEffectType === "new_scene" ||
    frontier.expectedEffectType === "overlay" ||
    frontier.expectedEffectType === "external_scene"
  ) {
    return 2;
  }
  return frontier.risk === "navigation" ? 2 : 1;
}

function isForwardScrollAction(actionType: IosUiCrawlerActionType): boolean {
  return (
    actionType === "swipe_up" ||
    actionType === "swipe_left" ||
    actionType === "drag_up" ||
    actionType === "drag_left"
  );
}

export function crawlerActionSafetyIssue(options: {
  target: IosUiCrawlerElementTarget;
  actionType: IosUiCrawlerActionType;
  risk: ExperimentOperator["risk"];
}): string | null {
  if (isBlockedRisk(options.risk)) {
    return `Risk ${options.risk} is blocked for full-app discovery.`;
  }
  const text = normalizeText(
    [
      options.target.title,
      options.target.selector.accessibilityId,
      options.target.selector.label,
      options.target.selector.text,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const blockedTokens = [
    "发送",
    "删除",
    "支付",
    "购买",
    "下单",
    "提交",
    "确认",
    "确定",
    "使用",
    "保存",
    "完成",
    "发布",
    "授权",
    "允许",
    "添加",
    "退出登录",
    "注销",
    "清空",
  ];
  const token = blockedTokens.find((candidate) =>
    candidate === "使用" ? text === candidate : text.includes(candidate),
  );
  if (
    token &&
    !options.actionType.startsWith("swipe") &&
    !options.actionType.startsWith("drag")
  ) {
    return `Element text contains blocked side-effect token: ${token}.`;
  }
  if (
    options.actionType.startsWith("swipe") ||
    options.actionType.startsWith("drag")
  ) {
    const role = options.target.semanticRole.toLocaleLowerCase();
    if (
      !role.includes("scroll") &&
      !role.includes("list") &&
      !role.includes("carousel") &&
      !role.includes("slider") &&
      !role.includes("canvas")
    ) {
      return "Gesture action is not applicable to this Element role.";
    }
  }
  return null;
}

export function computeCrawlerCoverage(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerCoverage {
  const sceneCounts = {
    pending: state.sceneFrontiers.filter(
      (frontier) => frontier.status === "pending_scan",
    ).length,
    scanning: state.sceneFrontiers.filter(
      (frontier) => frontier.status === "scanning",
    ).length,
    scanned: state.sceneFrontiers.filter(
      (frontier) => frontier.status === "scanned",
    ).length,
    failed: state.sceneFrontiers.filter(
      (frontier) => frontier.status === "failed",
    ).length,
    blocked: state.sceneFrontiers.filter(
      (frontier) => frontier.status === "blocked",
    ).length,
  };
  const actions = emptyActionStatusCounts();
  const actionTypeCounts = emptyActionTypeCounts();
  const effectTypeCounts = emptyEffectTypeCounts();
  for (const frontier of state.actionFrontiers) {
    actions[frontier.status] += 1;
    actionTypeCounts[frontier.actionType] += 1;
    if (frontier.effect) {
      effectTypeCounts[frontier.effect.type] += 1;
    }
  }
  const current = snapshotGraph(graph);
  const pageAudit = computePageAudit(state, graph);
  return {
    schemaVersion: "ios-ui-scene-crawler-coverage/v1",
    generatedAt: new Date().toISOString(),
    baseline: state.baseline,
    current,
    delta: graphDelta(state.baseline, current),
    scenes: sceneCounts,
    actions,
    actionTypeCounts,
    effectTypeCounts,
    pageAudit,
  };
}

export function computePageAudit(
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): IosUiCrawlerCoverage["pageAudit"] {
  const entries: IosUiCrawlerCoverage["pageAudit"]["entries"][number][] = [];
  for (const frontier of state.actionFrontiers) {
    if (!isPageEntryFrontier(frontier)) {
      continue;
    }
    const operator = findPageNavigationOperator(frontier, graph);
    if (
      frontier.status === "skipped" &&
      (frontier.issue?.includes(
        "Skipped underlying background control hidden by the active survey overlay",
      ) ||
        frontier.issue?.includes(
          "Skipped the current document title; it is page identity",
        ) ||
        frontier.issue?.includes(
          "Skipped control captured from the external Volcengine WebView",
        ))
    ) {
      continue;
    }
    if (
      frontier.status === "skipped" &&
      frontier.issue?.includes(
        "Skipped non-interactive OCR/static text or decorative image",
      ) &&
      (!operator ||
        isSkippedStaticReverseEvidence(frontier, operator, state, graph))
    ) {
      continue;
    }
    const templateCovered =
      frontier.sceneId === "skills.home" &&
      graph.scenes.some(
        (scene) =>
          scene.sceneId === "skills.detail" &&
          (scene.stateVariants?.length ?? 0) > 0,
      );
    const equivalentWebViewCovered =
      frontier.sceneId === "bot.settings.about_debug.model_about" &&
      ["文档目录", "火山方舟", "文档指南", "API参考", "资源"].includes(
        frontier.target.title,
      ) &&
      graph.scenes.some(
        (scene) =>
          scene.sceneId === "volcengine.ark.docs.quickstart" &&
          (scene.referenceAssets?.length ?? 0) > 0,
      );
    const equivalentDocumentCovered =
      frontier.sceneId === "bot.settings.about_debug.shopping_wallet_faq" &&
      frontier.target.title === "豆包隐私政策" &&
      graph.scenes.some(
        (scene) =>
          scene.sceneId === "bot.settings.about_debug.privacy_policy" &&
          (scene.referenceAssets?.length ?? 0) > 0,
      );
    const blocked =
      frontier.status === "blocked" ||
      (frontier.status === "skipped" &&
        Boolean(
          frontier.issue?.match(
            /Inventory-only|unavailable|Informational|semantic evidence|duplicate/i,
          ),
        )) ||
      isBlockedPageEntry(frontier.target.title);
    const covered = Boolean(
      operator &&
      frontier.status === "completed" &&
      frontier.beforeObservationPath &&
      frontier.afterObservationPath &&
      frontier.effect &&
      ["new_scene", "overlay", "external_scene"].includes(
        frontier.effect.type,
      ) &&
      frontier.effect.toSceneId !== frontier.sceneId,
    );
    const exploredWithoutNavigation = Boolean(
      frontier.status === "completed" &&
      frontier.beforeObservationPath &&
      frontier.afterObservationPath &&
      frontier.effect &&
      ["no_effect", "state_change", "viewport_change"].includes(
        frontier.effect.type,
      ) &&
      frontier.effect.toSceneId === frontier.sceneId,
    );
    const status =
      covered ||
      exploredWithoutNavigation ||
      equivalentWebViewCovered ||
      equivalentDocumentCovered
        ? "covered"
        : templateCovered
          ? "template_covered"
          : blocked
            ? "blocked"
            : "gap";
    entries.push({
      sceneId: frontier.sceneId,
      elementId: frontier.target.elementId,
      title: frontier.target.title,
      status,
      reason:
        status === "covered"
          ? covered
            ? `Live before/after evidence confirms navigation to ${operator!.toSceneId}.`
            : equivalentWebViewCovered
              ? "Equivalent Volcengine WebView navigation is covered by the scanned quickstart document Scene."
              : equivalentDocumentCovered
                ? "Equivalent privacy-policy document navigation is covered by the scanned privacy policy Scene."
                : "Live before/after evidence confirms this control does not open a distinct Scene."
          : status === "template_covered"
            ? "The entry is another instance of the already-covered skills.detail page template."
            : status === "blocked"
              ? "The entry has account, commerce, mutation, destructive, or other unsafe side effects."
              : (frontier.issue ??
                "No executable cross-Scene navigation has been observed."),
      operatorId: operator?.operatorId,
      toSceneId: operator?.toSceneId,
    });
  }
  const deduped = [
    ...entries
      .reduce((bestByEntry, entry) => {
        const key = JSON.stringify([entry.sceneId, normalizeText(entry.title)]);
        const current = bestByEntry.get(key);
        const rank = {
          covered: 4,
          template_covered: 3,
          gap: 2,
          blocked: 1,
        } as const;
        if (!current || rank[entry.status] > rank[current.status]) {
          bestByEntry.set(key, entry);
        }
        return bestByEntry;
      }, new Map<string, (typeof entries)[number]>())
      .values(),
  ].sort(
    (left, right) =>
      left.sceneId.localeCompare(right.sceneId) ||
      left.title.localeCompare(right.title),
  );
  const count = (status: (typeof deduped)[number]["status"]) =>
    deduped.filter((entry) => entry.status === status).length;
  const gaps = count("gap");
  const blocked = count("blocked");
  return {
    status:
      gaps > 0
        ? "incomplete"
        : blocked > 0
          ? "complete_with_blocks"
          : "complete",
    covered: count("covered"),
    templateCovered: count("template_covered"),
    blocked,
    gaps,
    entries: deduped,
  };
}

function isPageEntryFrontier(frontier: IosUiCrawlerActionFrontier): boolean {
  if (frontier.actionType !== "tap") {
    return false;
  }
  if (/返回|关闭|取消|退出/.test(frontier.target.title)) {
    return false;
  }
  if (
    frontier.status === "skipped" &&
    frontier.issue?.includes(
      "already represented by verified reverse navigation",
    )
  ) {
    return false;
  }
  const role = frontier.target.semanticRole.toLocaleLowerCase();
  const explicitRole =
    role.includes("navigation") ||
    role.includes("entry") ||
    role.includes("link") ||
    role.includes("menu") ||
    role.includes("shortcut");
  const explicitReadOnlyEntry =
    (frontier.sceneId === "bot.settings" &&
      ["《个人信息清单》", "《三方信息共享清单》"].includes(
        frontier.target.title,
      )) ||
    (frontier.sceneId === "bot.settings.about_debug" &&
      [
        "用户协议",
        "隐私政策简明版",
        "隐私政策",
        "应用权限",
        "使用规范",
        "侵权投诉指引",
        "营业执照",
        "ICP 备案",
        "关于豆包大模型",
        "资质规则",
        "豆包购物及钱包功能FAQ",
      ].includes(frontier.target.title)) ||
    (frontier.sceneId === "bot.settings.customer_service" &&
      /为什么|怎么|如何|忘记|账号被盗|[？?]$/.test(frontier.target.title));
  const observedTransition =
    Boolean(frontier.effect) &&
    ["new_scene", "overlay", "external_scene"].includes(
      frontier.effect!.type,
    ) &&
    frontier.effect!.toSceneId !== frontier.sceneId;
  return (
    explicitRole ||
    explicitReadOnlyEntry ||
    observedTransition ||
    (frontier.sceneId === "bot.settings" &&
      frontier.target.bounds.width >= 250 &&
      frontier.target.bounds.height >= 40)
  );
}

function findPageNavigationOperator(
  frontier: IosUiCrawlerActionFrontier,
  graph: ExecutableUiGraphExperiment,
): ExperimentOperator | undefined {
  const direct = frontier.operatorId
    ? graph.operators.find(
        (candidate) =>
          candidate.operatorId === frontier.operatorId &&
          isUsablePageNavigationOperator(candidate) &&
          operatorMatchesFrontierTitle(candidate, frontier, graph),
      )
    : undefined;
  if (direct) {
    return direct;
  }
  const normalizedTitle = normalizeText(frontier.target.title);
  return graph.operators.find((candidate) => {
    if (
      candidate.fromSceneId !== frontier.sceneId ||
      !isUsablePageNavigationOperator(candidate)
    ) {
      return false;
    }
    const element = graph.elements.find(
      (item) =>
        candidate.operation.type === "tap" &&
        item.elementId === candidate.operation.elementId,
    );
    const semanticTitles = [
      element?.title,
      element?.selector.label,
      element?.selector.text,
    ]
      .filter((value): value is string => Boolean(value))
      .map(normalizeText);
    return semanticTitles.some((title) => title === normalizedTitle);
  });
}

function operatorMatchesFrontierTitle(
  operator: ExperimentOperator,
  frontier: IosUiCrawlerActionFrontier,
  graph: ExecutableUiGraphExperiment,
): boolean {
  if (operator.operation.type !== "tap") {
    return false;
  }
  const elementId = operator.operation.elementId;
  const element = graph.elements.find(
    (candidate) => candidate.elementId === elementId,
  );
  const expected = normalizeText(frontier.target.title);
  return [element?.title, element?.selector.label, element?.selector.text]
    .filter((value): value is string => Boolean(value))
    .some((value) => normalizeText(value) === expected);
}

function isUsablePageNavigationOperator(operator: ExperimentOperator): boolean {
  return (
    operator.operation.type === "tap" &&
    operator.status !== "stale" &&
    operator.status !== "disabled" &&
    operator.status !== "blocked" &&
    (operator.toSceneId !== operator.fromSceneId ||
      operator.effects.some((effect) => effect.includes("=")) ||
      operator.postconditions.some((condition) => condition.includes("=")))
  );
}

function isSkippedStaticReverseEvidence(
  frontier: IosUiCrawlerActionFrontier,
  operator: ExperimentOperator,
  state: IosUiCrawlerState,
  graph: ExecutableUiGraphExperiment,
): boolean {
  if (
    frontier.status !== "skipped" ||
    !frontier.issue?.includes(
      "Skipped non-interactive OCR/static text or decorative image",
    )
  ) {
    return false;
  }
  const sceneFrontier = state.sceneFrontiers.find(
    (candidate) => candidate.sceneId === frontier.sceneId,
  );
  const entryOperatorId = sceneFrontier?.recoveryOperatorIds.at(-1);
  const entryOperator = entryOperatorId
    ? graph.operators.find(
        (candidate) => candidate.operatorId === entryOperatorId,
      )
    : undefined;
  return entryOperator?.fromSceneId === operator.toSceneId;
}

function isBlockedPageEntry(title: string): boolean {
  return /钱包|订单|豆包专业版|升级|切换账号|退出登录|注销|开启新话题/.test(
    title,
  );
}

async function understandScene(options: {
  graph: ExecutableUiGraphExperiment;
  frontier: IosUiCrawlerSceneFrontier;
  observation: TargetedDiscoveryObservation;
  input: NormalizedInput;
}): Promise<SceneScanProposal> {
  const candidates = businessCandidates(
    options.observation,
    crawlerViewport(options.graph),
  ).slice(0, 80);
  const prompt = [
    "Understand one iOS Scene for a safe recursive UI crawler.",
    "Return only schema-backed JSON.",
    "Map candidateId only from Current candidates.",
    "Describe stable business Elements, not dynamic content rows.",
    "Choose only actions applicable to the Element role.",
    "Buttons and navigation entries usually use tap.",
    "Cards or messages may use tap and long_press.",
    "Scrollable regions may use directional swipe or drag.",
    "For each Element, predict whether its action stays in the same Scene as state_change/viewport_change or enters a new_scene/overlay.",
    "Represent toggles, selected modes, scroll positions, camera facing, flash mode, and composer mode as state facts, never as new Scenes.",
    "State facts use stable key=value syntax such as camera.flash=auto.",
    "Provide requiredStateFacts only when the action is valid from a specific current state.",
    "Provide a short undoHint when the state can be locally reversed.",
    "Do not propose input_text, send, delete, payment, publish, permission approval, account mutation, or destructive actions.",
    "Coordinates are forbidden.",
    "",
    `Expected Scene: ${options.frontier.sceneId}`,
    `Known Graph scenes: ${JSON.stringify(options.graph.scenes.map((scene) => ({ sceneId: scene.sceneId, title: scene.title, aliases: scene.aliases })))}`,
    `Current candidates: ${JSON.stringify(candidates)}`,
  ].join("\n");
  try {
    const proposal = await runAgentWithTimeout<SceneScanProposal>(
      prompt,
      {
        cwd: DEFAULT_PROJECT_ROOT,
        model: options.input.model,
        sandbox: "read-only",
        schema: scanSceneSchema,
        env: { CODEX_HOME: undefined },
      },
      options.input.agentTimeoutMs,
      "Scene understanding",
    );
    return normalizeSceneScan(proposal, options.frontier, candidates);
  } catch (error) {
    return deterministicSceneScan(
      options.frontier,
      options.observation,
      error,
      crawlerViewport(options.graph),
    );
  }
}

async function understandEffect(options: {
  graph: ExecutableUiGraphExperiment;
  frontier: IosUiCrawlerActionFrontier;
  before: TargetedDiscoveryObservation;
  after: TargetedDiscoveryObservation;
  input: NormalizedInput;
}): Promise<IosUiCrawlerEffect> {
  const deterministic = classifyTargetedDiscoveryScene(
    options.after.candidates,
  );
  if (deterministic) {
    const sameScene = deterministic.sceneId === options.frontier.sceneId;
    const unchanged =
      observationFingerprint(options.before) ===
      observationFingerprint(options.after);
    return {
      type: sameScene
        ? unchanged
          ? "no_effect"
          : "state_change"
        : "new_scene",
      fromSceneId: options.frontier.sceneId,
      toSceneId: deterministic.sceneId,
      title: deterministic.title,
      visualTextAnchors: deterministic.visualTextAnchors,
      description: `Deterministic Scene classification matched ${deterministic.sceneId}.`,
      confidence: 1,
      stateFacts: options.frontier.expectedStateFacts ?? [],
    };
  }
  const beforeFingerprint = observationFingerprint(options.before);
  const afterFingerprint = observationFingerprint(options.after);
  if (beforeFingerprint === afterFingerprint) {
    return {
      type: "no_effect",
      fromSceneId: options.frontier.sceneId,
      toSceneId: options.frontier.sceneId,
      title: "无可见效果",
      visualTextAnchors: [],
      description: "Before and after semantic fingerprints are identical.",
      confidence: 1,
    };
  }
  if (
    options.frontier.expectedEffectType === "state_change" ||
    options.frontier.expectedEffectType === "viewport_change"
  ) {
    return {
      type: options.frontier.expectedEffectType,
      fromSceneId: options.frontier.sceneId,
      toSceneId: options.frontier.sceneId,
      title:
        options.frontier.expectedEffectType === "viewport_change"
          ? `${options.frontier.target.title}视口变化`
          : `${options.frontier.target.title}状态变化`,
      visualTextAnchors: stableObservationTexts(options.after).slice(0, 5),
      stateFacts: options.frontier.expectedStateFacts ?? [],
      description: `Scene scan predicted ${options.frontier.expectedEffectType}; UI dump fingerprint changed while the base Scene remained ${options.frontier.sceneId}.`,
      confidence: 0.9,
    };
  }
  const prompt = [
    "Classify the observed Effect of one safe iOS UI action.",
    "Return only schema-backed JSON.",
    "Use a stable lower-case dot-separated toSceneId.",
    "Use new_scene for a full page, overlay for a sheet/menu/modal, state_change for same-page state, viewport_change for scrolling, external_scene for another bundle/system UI, and no_effect when nothing changed.",
    "Visual anchors must be stable texts visible in After.",
    "",
    `From Scene: ${options.frontier.sceneId}`,
    `Element: ${JSON.stringify(options.frontier.target)}`,
    `Action: ${options.frontier.actionType}`,
    `Known Scenes: ${JSON.stringify(options.graph.scenes.map((scene) => ({ sceneId: scene.sceneId, title: scene.title, aliases: scene.aliases, anchors: scene.visualTextAnchors })))}`,
    `Before: ${JSON.stringify(compactObservation(options.before))}`,
    `After: ${JSON.stringify(compactObservation(options.after))}`,
  ].join("\n");
  try {
    const proposal = await runAgentWithTimeout<EffectProposal>(
      prompt,
      {
        cwd: DEFAULT_PROJECT_ROOT,
        model: options.input.model,
        sandbox: "read-only",
        schema: effectSchema,
        env: { CODEX_HOME: undefined },
      },
      options.input.agentTimeoutMs,
      "Effect understanding",
    );
    return {
      type: proposal.effectType,
      fromSceneId: options.frontier.sceneId,
      toSceneId:
        proposal.effectType === "no_effect"
          ? options.frontier.sceneId
          : stableGraphId(proposal.toSceneId, "scene"),
      title: proposal.title,
      visualTextAnchors: stableAnchors(
        proposal.visualTextAnchors,
        options.after,
      ),
      description: proposal.description,
      confidence: proposal.confidence,
    };
  } catch (error) {
    const anchors = stableObservationTexts(options.after).slice(0, 3);
    const toSceneId = `observed.${createHash("sha1")
      .update(afterFingerprint)
      .digest("hex")
      .slice(0, 10)}`;
    return {
      type: "new_scene",
      fromSceneId: options.frontier.sceneId,
      toSceneId,
      title: "待理解页面",
      visualTextAnchors: anchors,
      description: `Effect Agent failed; semantic fingerprint fallback was used: ${error instanceof Error ? error.message : String(error)}`,
      confidence: 0.5,
    };
  }
}

export function observationEvidenceLevel(
  frontier: IosUiCrawlerActionFrontier,
): "full" | "ui_dump" {
  if (
    frontier.expectedEffectType === "state_change" ||
    frontier.expectedEffectType === "viewport_change" ||
    frontier.actionType.startsWith("swipe") ||
    frontier.actionType.startsWith("drag") ||
    frontier.target.semanticRole.toLocaleLowerCase().includes("toggle")
  ) {
    return "ui_dump";
  }
  return "full";
}

async function restoreScene(options: {
  input: NormalizedInput;
  graph: ExecutableUiGraphExperiment;
  frontier: IosUiCrawlerSceneFrontier;
  outputDir: string;
}): Promise<{
  success: boolean;
  observation?: TargetedDiscoveryObservation;
  issue?: string;
}> {
  await mkdir(options.outputDir, { recursive: true });
  const reset = options.graph.resetStrategies.find(
    (candidate) =>
      candidate.strategyId === options.graph.defaultResetStrategyId,
  );
  if (!reset) {
    return { success: false, issue: "Default reset strategy is missing." };
  }
  for (const [index, step] of reset.steps.entries()) {
    const command =
      step.type === "wait"
        ? ["sleep", String(step.durationMs / 1000)]
        : buildMobilecliActionCommand({
            action: {
              actionId: `crawler-reset-${index + 1}`,
              type: step.type,
              bundleId: step.bundleId,
            },
            udid: options.input.udid,
            bundleId: options.graph.bundleId,
          });
    const result = await runCommand(command, options.input.projectRoot);
    await writeJsonAtomic(join(options.outputDir, `reset-${index + 1}.json`), {
      command,
      ...result,
    });
    if (
      result.exitCode !== 0 &&
      step.type !== "terminate_app" &&
      step.type !== "launch_app"
    ) {
      return {
        success: false,
        issue: `Reset step ${step.type} failed: ${result.exitCode}.`,
      };
    }
  }
  let entryObservation = await captureTargetedDiscoveryObservation({
    graph: options.graph,
    udid: options.input.udid,
    outputDir: join(options.outputDir, "entry-grounding"),
    index: 0,
    preferredSceneId: reset.entrySceneId,
  });
  if (observationSceneId(entryObservation) === options.frontier.sceneId) {
    return { success: true, observation: entryObservation };
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (observationSceneId(entryObservation) === reset.entrySceneId) {
      break;
    }
    const safeTarget = findLocalRecoveryTarget(
      entryObservation,
      reset.entrySceneId,
    );
    if (!safeTarget) {
      const command = [
        "mobilecli",
        "io",
        "swipe",
        "--device",
        options.input.udid,
        "8,448,360,448",
      ];
      const executed = await runCrawlerCommandWithRetry(
        command,
        options.input.projectRoot,
      );
      await writeJsonAtomic(
        join(options.outputDir, `entry-edge-back-${attempt}.json`),
        {
          fromSceneId: observationSceneId(entryObservation),
          targetSceneId: reset.entrySceneId,
          command,
          attempts: executed.attempts,
          result: executed.result,
        },
      );
      if (executed.result.exitCode !== 0) {
        return {
          success: false,
          observation: entryObservation,
          issue: `Reset restored ${observationSceneId(entryObservation)} and the safe edge-back recovery failed.`,
        };
      }
      await Bun.sleep(options.input.settleMs);
      entryObservation = await captureTargetedDiscoveryObservation({
        graph: options.graph,
        udid: options.input.udid,
        outputDir: join(
          options.outputDir,
          `entry-grounding-after-edge-back-${attempt}`,
        ),
        index: 0,
        preferredSceneId: reset.entrySceneId,
      });
      continue;
    }
    const point = {
      x: safeTarget.bounds.x + safeTarget.bounds.width / 2,
      y: safeTarget.bounds.y + safeTarget.bounds.height / 2,
    };
    const command = [
      "mobilecli",
      "io",
      "tap",
      "--device",
      options.input.udid,
      `${Math.round(point.x)},${Math.round(point.y)}`,
    ];
    const result = await runCommand(command, options.input.projectRoot);
    await writeJsonAtomic(
      join(options.outputDir, `entry-recovery-${attempt}.json`),
      { target: safeTarget, command, result },
    );
    if (result.exitCode !== 0) {
      return {
        success: false,
        observation: entryObservation,
        issue: `Entry recovery control failed: ${result.exitCode}.`,
      };
    }
    await Bun.sleep(options.input.settleMs);
    entryObservation = await captureTargetedDiscoveryObservation({
      graph: options.graph,
      udid: options.input.udid,
      outputDir: join(
        options.outputDir,
        `entry-grounding-after-recovery-${attempt}`,
      ),
      index: 0,
      preferredSceneId: reset.entrySceneId,
    });
  }
  if (observationSceneId(entryObservation) !== reset.entrySceneId) {
    return {
      success: false,
      observation: entryObservation,
      issue: `Reset entry recovery observed ${observationSceneId(entryObservation)} instead of ${reset.entrySceneId}.`,
    };
  }
  if (options.frontier.recoveryOperatorIds.length > 0) {
    let currentObservation = entryObservation;
    for (const [
      index,
      operatorId,
    ] of options.frontier.recoveryOperatorIds.entries()) {
      const operator = options.graph.operators.find(
        (candidate) => candidate.operatorId === operatorId,
      );
      if (!operator) {
        return {
          success: false,
          observation: currentObservation,
          issue: `Recovery Operator ${operatorId} does not exist.`,
        };
      }
      if (observationSceneId(currentObservation) !== operator.fromSceneId) {
        return {
          success: false,
          observation: currentObservation,
          issue: `Recovery Operator ${operatorId} expected ${operator.fromSceneId}; observed ${observationSceneId(currentObservation)} before execution.`,
        };
      }
      let command: string[] | undefined;
      if (
        operator.operation.type === "tap" ||
        operator.operation.type === "long_press"
      ) {
        if (
          operator.operatorId ===
          "volcengine.ark.docs.quickstart.open.tap.bot.settings.about_debug.model_about.volcengine_home"
        ) {
          command = compileCrawlerOperatorCommand(
            options.graph,
            operator,
            options.input.udid,
          );
        }
        const elementId = operator.operation.elementId;
        const element = options.graph.elements.find(
          (candidate) => candidate.elementId === elementId,
        );
        if (element && !command) {
          const target = graphElementTarget(element);
          const recoveryFrontier: IosUiCrawlerActionFrontier = {
            frontierId: `recovery.${safeSegment(operatorId)}`,
            sceneId: operator.fromSceneId,
            sceneDepth: options.frontier.depth,
            recoveryOperatorIds: [],
            target,
            actionType:
              operator.operation.type === "tap" ? "tap" : "long_press",
            risk: operator.risk,
            expectedEffectType: "new_scene",
            priority: 1,
            status: "running",
            attempts: 1,
            createdAt: new Date().toISOString(),
          };
          const prepared = await prepareActionTarget({
            input: options.input,
            graph: options.graph,
            frontier: recoveryFrontier,
            observation: currentObservation,
            outputDir: join(
              options.outputDir,
              `recovery-target-${String(index + 1).padStart(2, "0")}`,
            ),
          });
          currentObservation = prepared.observation;
          if (prepared.target) {
            const point = {
              x: prepared.target.bounds.x + prepared.target.bounds.width / 2,
              y: prepared.target.bounds.y + prepared.target.bounds.height / 2,
            };
            command =
              operator.operation.type === "tap"
                ? [
                    "mobilecli",
                    "io",
                    "tap",
                    "--device",
                    options.input.udid,
                    `${Math.round(point.x)},${Math.round(point.y)}`,
                  ]
                : [
                    "mobilecli",
                    "io",
                    "longpress",
                    "--device",
                    options.input.udid,
                    `${Math.round(point.x)},${Math.round(point.y)}`,
                    "--duration",
                    String(operator.operation.durationMs),
                  ];
          }
        }
      } else {
        command = compileCrawlerOperatorCommand(
          options.graph,
          operator,
          options.input.udid,
        );
      }
      if (!command) {
        return {
          success: false,
          observation: currentObservation,
          issue: `Recovery Operator ${operatorId} could not relocate its live target.`,
        };
      }
      const executed = await runCrawlerCommandWithRetry(
        command,
        options.input.projectRoot,
      );
      const result = executed.result;
      await writeJsonAtomic(
        join(
          options.outputDir,
          `${String(index + 1).padStart(2, "0")}-${safeSegment(operatorId)}.json`,
        ),
        { operator, command, attempts: executed.attempts, result },
      );
      if (result.exitCode !== 0) {
        return {
          success: false,
          observation: currentObservation,
          issue: `Recovery Operator ${operatorId} failed.`,
        };
      }
      await Bun.sleep(operator.settleMs);
      currentObservation = await captureTargetedDiscoveryObservation({
        graph: options.graph,
        udid: options.input.udid,
        outputDir: join(
          options.outputDir,
          `recovery-grounding-${String(index + 1).padStart(2, "0")}-${safeSegment(operatorId)}`,
        ),
        index: 0,
        preferredSceneId: operator.toSceneId,
        evidenceLevel:
          index === options.frontier.recoveryOperatorIds.length - 1
            ? "full"
            : "ui_dump",
      });
      if (
        observationSceneId(currentObservation) !== operator.toSceneId &&
        observationSceneId(currentObservation) === operator.fromSceneId
      ) {
        await Bun.sleep(Math.max(operator.settleMs, 1_000));
        currentObservation = await captureTargetedDiscoveryObservation({
          graph: options.graph,
          udid: options.input.udid,
          outputDir: join(
            options.outputDir,
            `recovery-grounding-${String(index + 1).padStart(2, "0")}-${safeSegment(operatorId)}-settled`,
          ),
          index: 0,
          preferredSceneId: operator.toSceneId,
          evidenceLevel:
            index === options.frontier.recoveryOperatorIds.length - 1
              ? "full"
              : "ui_dump",
        });
      }
      if (
        observationSceneId(currentObservation) !== operator.toSceneId &&
        observationSceneId(currentObservation) === operator.fromSceneId
      ) {
        const retried = await runCrawlerCommandWithRetry(
          command,
          options.input.projectRoot,
        );
        await writeJsonAtomic(
          join(
            options.outputDir,
            `${String(index + 1).padStart(2, "0")}-${safeSegment(operatorId)}-retry.json`,
          ),
          {
            operator,
            command,
            attempts: retried.attempts,
            result: retried.result,
          },
        );
        if (retried.result.exitCode === 0) {
          await Bun.sleep(Math.max(operator.settleMs, 1_000));
          currentObservation = await captureTargetedDiscoveryObservation({
            graph: options.graph,
            udid: options.input.udid,
            outputDir: join(
              options.outputDir,
              `recovery-grounding-${String(index + 1).padStart(2, "0")}-${safeSegment(operatorId)}-retry`,
            ),
            index: 0,
            preferredSceneId: operator.toSceneId,
            evidenceLevel:
              index === options.frontier.recoveryOperatorIds.length - 1
                ? "full"
                : "ui_dump",
          });
        }
      }
      if (observationSceneId(currentObservation) !== operator.toSceneId) {
        return {
          success: false,
          observation: currentObservation,
          issue: `Recovery Operator ${operatorId} expected ${operator.toSceneId}; observed ${observationSceneId(currentObservation)} after execution.`,
        };
      }
    }
    return { success: true, observation: currentObservation };
  }
  const observation = await captureTargetedDiscoveryObservation({
    graph: options.graph,
    udid: options.input.udid,
    outputDir: join(options.outputDir, "observation"),
    index: 0,
    preferredSceneId: options.frontier.sceneId,
  });
  return {
    success: observationSceneId(observation) === options.frontier.sceneId,
    observation,
    issue:
      observationSceneId(observation) === options.frontier.sceneId
        ? undefined
        : `Expected ${options.frontier.sceneId}; observed ${observationSceneId(observation)}.`,
  };
}

function graphElementTarget(
  element: ExperimentElement,
): IosUiCrawlerElementTarget {
  const binding = element.bindings.find(
    (candidate) =>
      candidate.status !== "stale" && candidate.status !== "disabled",
  );
  const profileWidth = 414;
  const profileHeight = 896;
  const settingsRow = element.semanticRole === "settings_navigation_entry";
  const actionBar = element.semanticRole === "actionbar_navigation_entry";
  const width = settingsRow ? 382 : actionBar ? 100 : 40;
  const height = settingsRow ? 56 : actionBar ? 38 : 40;
  return {
    candidateId: element.elementId,
    elementId: element.elementId,
    title: element.title,
    semanticRole: element.semanticRole,
    source: "ui_dump",
    selector: element.selector,
    bounds: binding
      ? {
          x: binding.normalizedPoint.x * profileWidth - width / 2,
          y: binding.normalizedPoint.y * profileHeight - height / 2,
          width,
          height,
        }
      : settingsRow
        ? { x: 16, y: 0, width, height }
        : { x: 0, y: 744, width, height },
  };
}

async function executeCrawlerAction(options: {
  input: NormalizedInput;
  frontier: IosUiCrawlerActionFrontier;
  target: TargetedDiscoveryObservation["candidates"][number];
  outputDir: string;
}): Promise<{ success: boolean; issue?: string }> {
  await mkdir(options.outputDir, { recursive: true });
  const point = {
    x: options.target.bounds.x + options.target.bounds.width / 2,
    y: options.target.bounds.y + options.target.bounds.height / 2,
  };
  const inset = Math.max(12, Math.min(48, options.target.bounds.width * 0.2));
  const verticalInset = Math.max(
    12,
    Math.min(48, options.target.bounds.height * 0.2),
  );
  const command =
    options.frontier.actionType === "tap"
      ? [
          "mobilecli",
          "io",
          "tap",
          "--device",
          options.input.udid,
          `${Math.round(point.x)},${Math.round(point.y)}`,
        ]
      : options.frontier.actionType === "long_press"
        ? [
            "mobilecli",
            "io",
            "longpress",
            "--device",
            options.input.udid,
            `${Math.round(point.x)},${Math.round(point.y)}`,
            "--duration",
            "1200",
          ]
        : [
            "mobilecli",
            "io",
            options.frontier.actionType.startsWith("drag") ? "drag" : "swipe",
            "--device",
            options.input.udid,
            gestureCoordinates(
              options.frontier.actionType,
              options.target.bounds,
              inset,
              verticalInset,
            ),
          ];
  const executed = await runCrawlerCommandWithRetry(
    command,
    options.input.projectRoot,
  );
  const { result, attempts } = executed;
  await writeJsonAtomic(join(options.outputDir, "command.json"), {
    command,
    attempts,
    result,
  });
  if (result.exitCode !== 0) {
    return {
      success: false,
      issue: `Action command failed with exit code ${result.exitCode}.`,
    };
  }
  await Bun.sleep(options.input.settleMs);
  return { success: true };
}

async function prepareActionTarget(options: {
  input: NormalizedInput;
  graph: ExecutableUiGraphExperiment;
  frontier: IosUiCrawlerActionFrontier;
  observation: TargetedDiscoveryObservation;
  outputDir: string;
}): Promise<{
  observation: TargetedDiscoveryObservation;
  target?: TargetedDiscoveryObservation["candidates"][number];
  issue?: string;
}> {
  const viewport = crawlerViewport(options.graph);
  if (
    options.frontier.actionType.startsWith("swipe") ||
    options.frontier.actionType.startsWith("drag")
  ) {
    if (
      options.frontier.target.selector.role === "VerticalScrollRegion" ||
      options.frontier.target.selector.role === "HorizontalScrollRegion"
    ) {
      return {
        observation: options.observation,
        target: {
          candidateId: options.frontier.target.candidateId,
          source: "ui_dump",
          role: options.frontier.target.selector.role,
          label: options.frontier.target.selector.label,
          value: options.frontier.target.selector.value,
          bounds: options.frontier.target.bounds,
        },
      };
    }
    return {
      observation: options.observation,
      target: relocateTarget(options.frontier.target, options.observation),
    };
  }
  let observation = options.observation;
  let target = relocateTarget(options.frontier.target, observation, viewport);
  if (target) {
    return { observation, target };
  }
  if (
    options.frontier.sceneId === "chat.detail" &&
    options.frontier.target.semanticRole === "actionbar_navigation_entry"
  ) {
    return searchActionBarTarget({
      input: options.input,
      graph: options.graph,
      sceneId: options.frontier.sceneId,
      target: options.frontier.target,
      observation,
      outputDir: options.outputDir,
      viewport,
    });
  }
  let offscreenTarget = relocateTarget(options.frontier.target, observation);
  if (!offscreenTarget) {
    if (
      options.frontier.sceneId === "skills.home" &&
      options.frontier.target.semanticRole === "skill_navigation_entry"
    ) {
      return searchSkillsListTarget({
        input: options.input,
        graph: options.graph,
        frontier: options.frontier,
        observation,
        outputDir: options.outputDir,
        viewport,
      });
    }
    if (
      options.frontier.sceneId === "bot.settings" ||
      options.frontier.sceneId === "bot.settings.about_debug" ||
      options.frontier.sceneId === "volcengine.ark.console.home" ||
      options.frontier.sceneId === "volcengine.ark.docs.quickstart" ||
      options.frontier.sceneId ===
        "bot.settings.about_debug.model_about.volcengine_home"
    ) {
      return searchVerticalPageTarget({
        input: options.input,
        graph: options.graph,
        frontier: options.frontier,
        observation,
        outputDir: options.outputDir,
        viewport,
      });
    }
    const bindingTarget = bindingFallbackTarget({
      graph: options.graph,
      frontier: options.frontier,
      observation,
      viewport,
    });
    if (bindingTarget) {
      return {
        observation,
        target: bindingTarget,
        issue:
          "Used a same-Scene, same-device candidate binding after live UI/OCR relocation was unavailable.",
      };
    }
    return {
      observation,
      issue: "Target Element is absent from the restored Scene.",
    };
  }
  await mkdir(options.outputDir, { recursive: true });
  let previousCenterY =
    offscreenTarget.bounds.y + offscreenTarget.bounds.height / 2;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const direction = previousCenterY < 0 ? "down" : "up";
    const x = Math.round(viewport.width / 2);
    const top = Math.round(viewport.height * 0.26);
    const bottom = Math.round(viewport.height * 0.8);
    const command = [
      "mobilecli",
      "io",
      "swipe",
      "--device",
      options.input.udid,
      direction === "up"
        ? `${x},${bottom},${x},${top}`
        : `${x},${top},${x},${bottom}`,
    ];
    const executed = await runCrawlerCommandWithRetry(
      command,
      options.input.projectRoot,
    );
    const result = executed.result;
    await writeJsonAtomic(
      join(options.outputDir, `viewport-recovery-${attempt}.json`),
      {
        target: options.frontier.target,
        direction,
        previousCenterY,
        command,
        attempts: executed.attempts,
        result,
      },
    );
    if (result.exitCode !== 0) {
      return {
        observation,
        issue: `Target viewport recovery failed: ${result.exitCode}.`,
      };
    }
    await Bun.sleep(options.input.settleMs);
    observation = await captureTargetedDiscoveryObservation({
      graph: options.graph,
      udid: options.input.udid,
      outputDir: join(
        options.outputDir,
        `grounding-${String(attempt).padStart(2, "0")}`,
      ),
      index: 0,
      preferredSceneId: options.frontier.sceneId,
      evidenceLevel: "ui_dump",
    });
    if (observationSceneId(observation) !== options.frontier.sceneId) {
      return {
        observation,
        issue: `Target viewport recovery left ${options.frontier.sceneId} and observed ${observationSceneId(observation)}.`,
      };
    }
    target = relocateTarget(options.frontier.target, observation, viewport);
    if (target) {
      return { observation, target };
    }
    offscreenTarget = relocateTarget(options.frontier.target, observation);
    if (!offscreenTarget) {
      return {
        observation,
        issue: "Target disappeared while recovering its viewport.",
      };
    }
    const centerY =
      offscreenTarget.bounds.y + offscreenTarget.bounds.height / 2;
    if (Math.abs(centerY - previousCenterY) < 4) {
      return {
        observation,
        issue: "Target remained off-screen after the viewport stopped moving.",
      };
    }
    previousCenterY = centerY;
  }
  return {
    observation,
    issue: "Target remained outside the viewport after four recovery swipes.",
  };
}

function bindingFallbackTarget(options: {
  graph: ExecutableUiGraphExperiment;
  frontier: IosUiCrawlerActionFrontier;
  observation: TargetedDiscoveryObservation;
  viewport: ViewportDimensions;
}): TargetedDiscoveryObservation["candidates"][number] | undefined {
  if (observationSceneId(options.observation) !== options.frontier.sceneId) {
    return undefined;
  }
  const element = options.graph.elements.find(
    (candidate) =>
      candidate.elementId === options.frontier.target.elementId &&
      candidate.sceneId === options.frontier.sceneId,
  );
  const binding = element?.bindings
    .filter(
      (candidate) =>
        candidate.deviceProfileId === options.graph.defaultDeviceProfileId &&
        (candidate.status === "verified" || candidate.status === "candidate"),
    )
    .sort((left, right) => right.reliability - left.reliability)[0];
  if (!element || !binding) {
    return undefined;
  }
  const point = {
    x: binding.normalizedPoint.x * options.viewport.width,
    y: binding.normalizedPoint.y * options.viewport.height,
  };
  if (
    point.x < 0 ||
    point.y < 0 ||
    point.x > options.viewport.width ||
    point.y > options.viewport.height
  ) {
    return undefined;
  }
  return {
    candidateId: `binding.${safeSegment(element.elementId)}`,
    source: "ui_dump",
    role: element.selector.role ?? element.semanticRole,
    accessibilityId: element.selector.accessibilityId,
    label: element.selector.label,
    text: element.selector.text,
    value: element.selector.value,
    bounds: {
      x: Math.max(0, point.x - 20),
      y: Math.max(0, point.y - 20),
      width: 40,
      height: 40,
    },
  };
}

async function searchActionBarTarget(options: {
  input: NormalizedInput;
  graph: ExecutableUiGraphExperiment;
  sceneId: string;
  target: IosUiCrawlerElementTarget;
  observation: TargetedDiscoveryObservation;
  outputDir: string;
  viewport: ViewportDimensions;
}): Promise<{
  observation: TargetedDiscoveryObservation;
  target?: TargetedDiscoveryObservation["candidates"][number];
  issue?: string;
}> {
  await mkdir(options.outputDir, { recursive: true });
  let observation = options.observation;
  const centerY = Math.round(options.viewport.height * 0.84);
  const left = Math.round(options.viewport.width * 0.16);
  const right = Math.round(options.viewport.width * 0.84);
  let stepIndex = 0;
  for (const direction of ["left", "right"] as const) {
    let previousFingerprint = observationFingerprint(observation);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      stepIndex += 1;
      const command = [
        "mobilecli",
        "io",
        "swipe",
        "--device",
        options.input.udid,
        direction === "left"
          ? `${right},${centerY},${left},${centerY}`
          : `${left},${centerY},${right},${centerY}`,
      ];
      const executed = await runCrawlerCommandWithRetry(
        command,
        options.input.projectRoot,
      );
      await writeJsonAtomic(
        join(
          options.outputDir,
          `actionbar-search-${String(stepIndex).padStart(2, "0")}-${direction}.json`,
        ),
        {
          target: options.target,
          direction,
          attempt,
          command,
          attempts: executed.attempts,
          result: executed.result,
        },
      );
      if (executed.result.exitCode !== 0) {
        return {
          observation,
          issue: `ActionBar search failed: ${executed.result.exitCode}.`,
        };
      }
      await Bun.sleep(options.input.settleMs);
      observation = await captureTargetedDiscoveryObservation({
        graph: options.graph,
        udid: options.input.udid,
        outputDir: join(
          options.outputDir,
          `actionbar-search-grounding-${String(stepIndex).padStart(2, "0")}`,
        ),
        index: 0,
        preferredSceneId: options.sceneId,
        evidenceLevel: "ui_dump",
      });
      if (
        observationSceneId(observation) !== options.sceneId &&
        !observationLooksLikeChatDetail(observation)
      ) {
        return {
          observation,
          issue: `ActionBar search left ${options.sceneId} and observed ${observationSceneId(observation)}.`,
        };
      }
      const target = relocateTarget(
        options.target,
        observation,
        options.viewport,
      );
      if (target) {
        return { observation, target };
      }
      const fingerprint = observationFingerprint(observation);
      if (fingerprint === previousFingerprint) {
        break;
      }
      previousFingerprint = fingerprint;
    }
  }
  return {
    observation,
    issue: `ActionBar entry was not found after bounded horizontal search: ${options.target.title}.`,
  };
}

async function searchSkillsListTarget(options: {
  input: NormalizedInput;
  graph: ExecutableUiGraphExperiment;
  frontier: IosUiCrawlerActionFrontier;
  observation: TargetedDiscoveryObservation;
  outputDir: string;
  viewport: ViewportDimensions;
}): Promise<{
  observation: TargetedDiscoveryObservation;
  target?: TargetedDiscoveryObservation["candidates"][number];
  issue?: string;
}> {
  await mkdir(options.outputDir, { recursive: true });
  let observation = options.observation;
  const centerX = Math.round(options.viewport.width / 2);
  const top = Math.round(options.viewport.height * 0.24);
  const bottom = Math.round(options.viewport.height * 0.8);
  let stepIndex = 0;
  for (const direction of ["up", "down"] as const) {
    let previousFingerprint = observationFingerprint(observation);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      stepIndex += 1;
      const command = [
        "mobilecli",
        "io",
        "swipe",
        "--device",
        options.input.udid,
        direction === "up"
          ? `${centerX},${bottom},${centerX},${top}`
          : `${centerX},${top},${centerX},${bottom}`,
      ];
      const executed = await runCrawlerCommandWithRetry(
        command,
        options.input.projectRoot,
      );
      await writeJsonAtomic(
        join(
          options.outputDir,
          `skills-search-${String(stepIndex).padStart(2, "0")}-${direction}.json`,
        ),
        {
          target: options.frontier.target,
          direction,
          attempt,
          command,
          attempts: executed.attempts,
          result: executed.result,
        },
      );
      if (executed.result.exitCode !== 0) {
        return {
          observation,
          issue: `Skills list search failed: ${executed.result.exitCode}.`,
        };
      }
      await Bun.sleep(options.input.settleMs);
      observation = await captureTargetedDiscoveryObservation({
        graph: options.graph,
        udid: options.input.udid,
        outputDir: join(
          options.outputDir,
          `skills-search-grounding-${String(stepIndex).padStart(2, "0")}`,
        ),
        index: 0,
        preferredSceneId: options.frontier.sceneId,
        evidenceLevel: "ui_dump",
      });
      if (observationSceneId(observation) !== options.frontier.sceneId) {
        return {
          observation,
          issue: `Skills list search left ${options.frontier.sceneId} and observed ${observationSceneId(observation)}.`,
        };
      }
      const target = relocateTarget(
        options.frontier.target,
        observation,
        options.viewport,
      );
      if (target) {
        return { observation, target };
      }
      const fingerprint = observationFingerprint(observation);
      if (fingerprint === previousFingerprint) {
        break;
      }
      previousFingerprint = fingerprint;
    }
  }
  return {
    observation,
    issue: `Skill title was not found after bounded list search: ${options.frontier.target.title}.`,
  };
}

async function searchVerticalPageTarget(options: {
  input: NormalizedInput;
  graph: ExecutableUiGraphExperiment;
  frontier: IosUiCrawlerActionFrontier;
  observation: TargetedDiscoveryObservation;
  outputDir: string;
  viewport: ViewportDimensions;
}): Promise<{
  observation: TargetedDiscoveryObservation;
  target?: TargetedDiscoveryObservation["candidates"][number];
  issue?: string;
}> {
  await mkdir(options.outputDir, { recursive: true });
  let observation = options.observation;
  const centerX = Math.round(options.viewport.width / 2);
  const top = Math.round(options.viewport.height * 0.26);
  const bottom = Math.round(options.viewport.height * 0.8);
  let stepIndex = 0;
  for (const direction of ["up", "down"] as const) {
    let previousFingerprint = observationFingerprint(observation);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      stepIndex += 1;
      const command = [
        "mobilecli",
        "io",
        "swipe",
        "--device",
        options.input.udid,
        direction === "up"
          ? `${centerX},${bottom},${centerX},${top}`
          : `${centerX},${top},${centerX},${bottom}`,
      ];
      const executed = await runCrawlerCommandWithRetry(
        command,
        options.input.projectRoot,
      );
      await writeJsonAtomic(
        join(
          options.outputDir,
          `page-search-${String(stepIndex).padStart(2, "0")}-${direction}.json`,
        ),
        {
          target: options.frontier.target,
          direction,
          attempt,
          command,
          attempts: executed.attempts,
          result: executed.result,
        },
      );
      if (executed.result.exitCode !== 0) {
        return {
          observation,
          issue: `Page list search failed: ${executed.result.exitCode}.`,
        };
      }
      await Bun.sleep(options.input.settleMs);
      observation = await captureTargetedDiscoveryObservation({
        graph: options.graph,
        udid: options.input.udid,
        outputDir: join(
          options.outputDir,
          `page-search-grounding-${String(stepIndex).padStart(2, "0")}`,
        ),
        index: 0,
        preferredSceneId: options.frontier.sceneId,
        evidenceLevel: "ui_dump",
      });
      const target = relocateTarget(
        options.frontier.target,
        observation,
        options.viewport,
      );
      if (target) {
        return { observation, target };
      }
      if (observationSceneId(observation) !== options.frontier.sceneId) {
        return {
          observation,
          issue: `Page list search left ${options.frontier.sceneId} and observed ${observationSceneId(observation)}.`,
        };
      }
      const fingerprint = observationFingerprint(observation);
      if (fingerprint === previousFingerprint) {
        break;
      }
      previousFingerprint = fingerprint;
    }
  }
  return {
    observation,
    issue: `Page entry was not found after bounded vertical search: ${options.frontier.target.title}.`,
  };
}

async function mergeScannedScene(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  observation: TargetedDiscoveryObservation;
  frontier: IosUiCrawlerSceneFrontier;
  scan: SceneScanProposal;
}): Promise<ExecutableUiGraphExperiment> {
  const profile = options.graph.deviceProfiles.find(
    (candidate) => candidate.profileId === options.graph.defaultDeviceProfileId,
  );
  if (!profile) {
    throw new Error("Default device profile is missing.");
  }
  const candidateById = new Map(
    options.observation.candidates.map((candidate) => [
      candidate.candidateId,
      candidate,
    ]),
  );
  const scannedElements = options.scan.elements.flatMap((proposal) => {
    const candidate = candidateById.get(proposal.candidateId);
    if (!candidate?.bounds) {
      return [];
    }
    const title = proposal.title.trim() || primaryCandidateText(candidate);
    const elementId = scannedElementId(
      options.frontier.sceneId,
      title,
      proposal.semanticRole,
      proposal.elementId,
      candidate.bounds,
    );
    const existingElement = options.graph.elements.find(
      (element) => element.elementId === elementId,
    );
    const point = {
      x:
        (candidate.bounds.x + candidate.bounds.width / 2) /
        profile.viewportWidth,
      y:
        (candidate.bounds.y + candidate.bounds.height / 2) /
        profile.viewportHeight,
    };
    const element: ExperimentElement = {
      ...(existingElement ?? {
        elementId,
        sceneId: options.frontier.sceneId,
        bindings: [],
      }),
      elementId,
      sceneId: options.frontier.sceneId,
      title,
      semanticRole: proposal.semanticRole.trim() || candidate.role || "element",
      selector: {
        accessibilityId: candidate.accessibilityId,
        label: candidate.label,
        text: candidate.text,
        value: candidate.value,
        role: candidate.role,
      },
      bindings: mergeBinding(existingElement?.bindings ?? [], {
        bindingId: `${elementId}.${profile.profileId}`,
        deviceProfileId: profile.profileId,
        normalizedPoint: point,
        source: candidate.source === "ui_dump" ? "ui_dump" : "manual",
        status: "candidate",
        reliability: 0.7,
        observedAt: new Date().toISOString(),
      }),
    };
    return [element];
  });
  const existing = options.graph.scenes.find(
    (scene) => scene.sceneId === options.frontier.sceneId,
  );
  const scene: ExperimentScene = {
    ...(existing ?? {
      sceneId: options.frontier.sceneId,
      status: "candidate" as const,
      anchorElementIds: [],
      referenceAssets: [],
    }),
    title: options.scan.title,
    aliases: [
      ...new Set([...(existing?.aliases ?? []), ...options.scan.aliases]),
    ],
    visualTextAnchors:
      existing?.status === "verified" &&
      (existing.visualTextAnchors?.length ?? 0) > 0
        ? existing.visualTextAnchors
        : stableAnchors(options.scan.visualTextAnchors, options.observation),
    referenceAssets: [
      ...(existing?.referenceAssets ?? []),
      {
        screenshotPath: options.observation.screenshotPath,
        uiDumpPath: options.observation.uiDumpPath,
        recordPath: options.observation.ocrPath,
      },
    ],
  };
  const graph: ExecutableUiGraphExperiment = {
    ...options.graph,
    scenes: existing
      ? options.graph.scenes.map((candidate) =>
          candidate.sceneId === scene.sceneId ? scene : candidate,
        )
      : [...options.graph.scenes, scene],
    elements: [
      ...options.graph.elements.filter(
        (candidate) =>
          !scannedElements.some(
            (element) => element.elementId === candidate.elementId,
          ),
      ),
      ...scannedElements,
    ],
  };
  await writeGraph(options.graphPath, graph);
  return graph;
}

function scannedElementId(
  sceneId: string,
  title: string,
  semanticRole: string,
  proposedId: string,
  bounds: IosUiCrawlerElementTarget["bounds"],
): string {
  if (
    sceneId === "bot.settings" &&
    (semanticRole === "settings_navigation_entry" ||
      (bounds.width >= 250 && bounds.height >= 40))
  ) {
    return settingsRowElementId(title);
  }
  if (
    sceneId === "chat.detail" &&
    semanticRole === "actionbar_navigation_entry"
  ) {
    return `chat.detail.actionbar.${actionBarIdentity(title)}`;
  }
  return sceneScopedElementId(sceneId, stableGraphId(proposedId, "element"));
}

async function mergeActionEffect(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  frontier: IosUiCrawlerActionFrontier;
  liveTarget: TargetedDiscoveryObservation["candidates"][number];
  before: TargetedDiscoveryObservation;
  after: TargetedDiscoveryObservation;
  effect: IosUiCrawlerEffect;
}): Promise<{
  graph: ExecutableUiGraphExperiment;
  operatorId?: string;
  newScene: boolean;
}> {
  const effect = canonicalizeCrawlerEffect(
    options.frontier,
    options.effect,
    options.after,
  );
  const stateFacts = effect.stateFacts ?? [];
  if (effect.type === "no_effect") {
    return {
      graph: options.graph,
      newScene: false,
    };
  }
  const profile = options.graph.deviceProfiles.find(
    (candidate) => candidate.profileId === options.graph.defaultDeviceProfileId,
  );
  if (!profile) {
    throw new Error("Default device profile is missing.");
  }
  const reusableElement = findReusableElement(
    options.graph,
    options.frontier.sceneId,
    options.liveTarget,
  );
  const elementId =
    reusableElement?.elementId ??
    sceneScopedElementId(
      options.frontier.sceneId,
      options.frontier.target.elementId,
    );
  const point = {
    x:
      (options.liveTarget.bounds.x + options.liveTarget.bounds.width / 2) /
      profile.viewportWidth,
    y:
      (options.liveTarget.bounds.y + options.liveTarget.bounds.height / 2) /
      profile.viewportHeight,
  };
  const existingElement =
    reusableElement ??
    options.graph.elements.find((element) => element.elementId === elementId);
  const element: ExperimentElement = {
    ...(existingElement ?? {
      elementId,
      sceneId: options.frontier.sceneId,
      bindings: [],
    }),
    title: options.frontier.target.title,
    semanticRole: options.frontier.target.semanticRole,
    selector: options.frontier.target.selector,
    bindings: mergeBinding(existingElement?.bindings ?? [], {
      bindingId: `${elementId}.${profile.profileId}`,
      deviceProfileId: profile.profileId,
      normalizedPoint: point,
      source:
        options.liveTarget.source === "ui_dump"
          ? ("ui_dump" as const)
          : ("manual" as const),
      status: "verified",
      reliability:
        existingElement?.bindings.find(
          (binding) => binding.deviceProfileId === profile.profileId,
        )?.reliability ?? 0.8,
      observedAt: new Date().toISOString(),
    }),
  };
  const reusableOperator = findReusableOperator({
    graph: options.graph,
    fromSceneId: options.frontier.sceneId,
    toSceneId: effect.toSceneId,
    actionType: options.frontier.actionType,
    elementId,
  });
  const operatorId =
    reusableOperator?.operatorId ?? crawlerOperatorId(options.frontier, effect);
  const operation: ExperimentOperator["operation"] =
    options.frontier.actionType === "tap"
      ? { type: "tap", elementId }
      : options.frontier.actionType === "long_press"
        ? { type: "long_press", elementId, durationMs: 1200 }
        : {
            type: "swipe",
            from: gesturePoints(
              options.frontier.actionType,
              options.liveTarget.bounds,
            ).from,
            to: gesturePoints(
              options.frontier.actionType,
              options.liveTarget.bounds,
            ).to,
          };
  const operator: ExperimentOperator = {
    ...(reusableOperator ?? {}),
    operatorId,
    title:
      reusableOperator?.title ??
      `${options.frontier.actionType} ${options.frontier.target.title}`,
    fromSceneId: options.frontier.sceneId,
    toSceneId: effect.toSceneId,
    operation,
    settleMs: DEFAULT_SETTLE_MS,
    risk: options.frontier.risk,
    status: "verified",
    reliability: Math.max(reusableOperator?.reliability ?? 0, 0.8),
    preconditions: [
      ...new Set([
        ...(reusableOperator?.preconditions ?? []),
        ...(options.frontier.requiredStateFacts ?? []),
      ]),
    ],
    effects: [
      ...new Set([
        ...(reusableOperator?.effects ?? []),
        ...stateFacts,
        effect.description,
      ]),
    ],
    postconditions: [
      ...new Set([
        ...(reusableOperator?.postconditions ?? []),
        `scene.current=${effect.toSceneId}`,
        ...stateFacts,
      ]),
    ],
    execution: {
      tier: "guarded",
      successfulExecutions: Math.max(
        reusableOperator?.execution?.successfulExecutions ?? 0,
        1,
      ),
      failedExecutions: reusableOperator?.execution?.failedExecutions ?? 0,
      evidencePaths: [
        ...new Set([
          ...(reusableOperator?.execution?.evidencePaths ?? []),
          options.before.uiDumpPath,
          options.after.uiDumpPath,
        ]),
      ],
      lastValidatedAt: new Date().toISOString(),
      lastFailedAt: reusableOperator?.execution?.lastFailedAt,
      lastValidatedAppVersion:
        reusableOperator?.execution?.lastValidatedAppVersion,
      lastFailure: reusableOperator?.execution?.lastFailure,
    },
  };
  const existingScene = options.graph.scenes.find(
    (scene) => scene.sceneId === effect.toSceneId,
  );
  const scene: ExperimentScene = {
    ...(existingScene ?? {
      sceneId: effect.toSceneId,
      status: "verified" as const,
      anchorElementIds: [],
      referenceAssets: [],
    }),
    status: "verified",
    title: existingScene?.title ?? effect.title,
    aliases: [...new Set([...(existingScene?.aliases ?? []), effect.title])],
    visualTextAnchors:
      existingScene?.visualTextAnchors ?? effect.visualTextAnchors,
    referenceAssets: mergeReferenceAsset(
      existingScene?.referenceAssets ?? [],
      observationReferenceAsset(options.after),
    ),
    stateVariants:
      effect.type === "state_change" ||
      effect.type === "viewport_change" ||
      stateFacts.length > 0
        ? mergeStateVariant(existingScene?.stateVariants ?? [], {
            title:
              effect.toSceneId === "skills.detail" &&
              options.frontier.target.semanticRole === "skill_navigation_entry"
                ? `${options.frontier.target.title}详情`
                : effect.title,
            facts: stateFacts,
            visualTextAnchors: effect.visualTextAnchors,
            referenceAssets: observationReferenceAsset(options.after)
              ? [observationReferenceAsset(options.after)!]
              : [],
          })
        : existingScene?.stateVariants,
  };
  const graph: ExecutableUiGraphExperiment = {
    ...options.graph,
    scenes: [
      ...options.graph.scenes.filter(
        (candidate) => candidate.sceneId !== scene.sceneId,
      ),
      scene,
    ],
    elements: [
      ...options.graph.elements.filter(
        (candidate) => candidate.elementId !== element.elementId,
      ),
      element,
    ],
    operators: [
      ...options.graph.operators.filter(
        (candidate) => candidate.operatorId !== operator.operatorId,
      ),
      operator,
    ],
  };
  await writeGraph(options.graphPath, graph);
  const graphWithReverse = await persistDeterministicReverseOperator({
    graph,
    graphPath: options.graphPath,
    after: options.after,
    effect,
  });
  return {
    graph: graphWithReverse,
    operatorId,
    newScene: !existingScene,
  };
}

async function persistDeterministicReverseOperator(options: {
  graph: ExecutableUiGraphExperiment;
  graphPath: string;
  after: TargetedDiscoveryObservation;
  effect: IosUiCrawlerEffect;
}): Promise<ExecutableUiGraphExperiment> {
  if (
    options.effect.toSceneId !== "chat.detail" ||
    !options.effect.stateFacts?.includes("composer.mode=voice")
  ) {
    return options.graph;
  }
  const target = options.after.candidates.find(
    (candidate) =>
      candidate.source === "ui_dump" &&
      normalizeText(primaryCandidateText(candidate)) ===
        normalizeText("文本输入"),
  );
  if (!target) {
    return options.graph;
  }
  const profile = options.graph.deviceProfiles.find(
    (candidate) => candidate.profileId === options.graph.defaultDeviceProfileId,
  );
  if (!profile) {
    return options.graph;
  }
  const elementId = "chat.detail.voice_input.text_mode";
  const operatorId = "chat.detail.voice_input.return_to_text";
  const point = {
    x: (target.bounds.x + target.bounds.width / 2) / profile.viewportWidth,
    y: (target.bounds.y + target.bounds.height / 2) / profile.viewportHeight,
  };
  const existingElement = options.graph.elements.find(
    (element) => element.elementId === elementId,
  );
  const element: ExperimentElement = {
    ...(existingElement ?? {
      elementId,
      sceneId: "chat.detail",
      bindings: [],
    }),
    sceneId: "chat.detail",
    title: "文本输入",
    semanticRole: "input_mode_button",
    selector: {
      accessibilityId: target.accessibilityId,
      label: target.label,
      text: target.text,
      value: target.value,
      role: target.role,
    },
    bindings: mergeBinding(existingElement?.bindings ?? [], {
      bindingId: `${elementId}.${profile.profileId}`,
      deviceProfileId: profile.profileId,
      normalizedPoint: point,
      source: "ui_dump",
      status: "candidate",
      reliability: 0.7,
      observedAt: new Date().toISOString(),
    }),
  };
  const operator: ExperimentOperator = {
    operatorId,
    title: "切回文本输入",
    fromSceneId: "chat.detail",
    toSceneId: "chat.detail",
    operation: { type: "tap", elementId },
    settleMs: DEFAULT_SETTLE_MS,
    risk: "interaction",
    status: "candidate",
    reliability: 0.7,
    preconditions: ["composer.mode=voice"],
    effects: ["composer.mode=text"],
    postconditions: ["scene.current=chat.detail", "composer.mode=text"],
  };
  const graph: ExecutableUiGraphExperiment = {
    ...options.graph,
    elements: [
      ...options.graph.elements.filter(
        (candidate) => candidate.elementId !== elementId,
      ),
      element,
    ],
    operators: [
      ...options.graph.operators.filter(
        (candidate) => candidate.operatorId !== operatorId,
      ),
      operator,
    ],
  };
  await writeGraph(options.graphPath, graph);
  return graph;
}

export function migrateEvidenceBackedExecutionTrustGraph(
  graph: ExecutableUiGraphExperiment,
  state?: IosUiCrawlerState,
): ExecutableUiGraphExperiment {
  if (!state) {
    return graph;
  }
  const evidenceByOperatorId = new Map<
    string,
    { beforePath: string; afterPath: string; completedAt?: string }
  >();
  for (const frontier of state.actionFrontiers) {
    if (
      frontier.status !== "completed" ||
      !frontier.operatorId ||
      !frontier.beforeObservationPath ||
      !frontier.afterObservationPath ||
      !frontier.effect ||
      frontier.effect.type === "no_effect"
    ) {
      continue;
    }
    evidenceByOperatorId.set(frontier.operatorId, {
      beforePath: frontier.beforeObservationPath,
      afterPath: frontier.afterObservationPath,
      completedAt: frontier.completedAt,
    });
  }
  if (evidenceByOperatorId.size === 0) {
    return graph;
  }
  const promotedSceneIds = new Set<string>();
  const promotedElementIds = new Set<string>();
  const operators = graph.operators.map((operator) => {
    const evidence = evidenceByOperatorId.get(operator.operatorId);
    if (
      !evidence ||
      (operator.status !== "candidate" && operator.status !== "observed")
    ) {
      return operator;
    }
    promotedSceneIds.add(operator.fromSceneId);
    promotedSceneIds.add(operator.toSceneId);
    if (
      operator.operation.type === "tap" ||
      operator.operation.type === "long_press"
    ) {
      promotedElementIds.add(operator.operation.elementId);
    }
    return {
      ...operator,
      status: "verified" as const,
      reliability: Math.max(operator.reliability, 0.8),
      execution: {
        tier: "guarded" as const,
        successfulExecutions: Math.max(
          operator.execution?.successfulExecutions ?? 0,
          1,
        ),
        failedExecutions: operator.execution?.failedExecutions ?? 0,
        consecutiveSuccessfulExecutions: Math.max(
          operator.execution?.consecutiveSuccessfulExecutions ?? 0,
          1,
        ),
        consecutiveFailedExecutions:
          operator.execution?.consecutiveFailedExecutions ?? 0,
        evidencePaths: [
          ...new Set([
            ...(operator.execution?.evidencePaths ?? []),
            evidence.beforePath,
            evidence.afterPath,
          ]),
        ],
        lastValidatedAt:
          evidence.completedAt ??
          operator.execution?.lastValidatedAt ??
          new Date().toISOString(),
        lastFailedAt: operator.execution?.lastFailedAt,
        lastValidatedAppVersion: operator.execution?.lastValidatedAppVersion,
        lastFailure: operator.execution?.lastFailure,
      },
    };
  });
  const scenes = graph.scenes.map((scene) =>
    promotedSceneIds.has(scene.sceneId)
      ? { ...scene, status: "verified" as const }
      : scene,
  );
  const elements = graph.elements.map((element) =>
    promotedElementIds.has(element.elementId)
      ? {
          ...element,
          bindings: element.bindings.map((binding) => ({
            ...binding,
            status: "verified" as const,
            reliability: Math.max(binding.reliability, 0.8),
          })),
        }
      : element,
  );
  return { ...graph, scenes, elements, operators };
}

async function migrateEvidenceBackedExecutionTrust(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
  state?: IosUiCrawlerState,
): Promise<ExecutableUiGraphExperiment> {
  const migrated = migrateEvidenceBackedExecutionTrustGraph(graph, state);
  if (migrated !== graph) {
    await writeGraph(graphPath, migrated);
  }
  return migrated;
}

export async function pruneInvalidCrawlerArtifacts(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
): Promise<ExecutableUiGraphExperiment> {
  const taskOperatorIds = new Set(
    graph.tasks.flatMap((task) => task.operatorIds),
  );
  const invalidSceneIds = new Set(
    graph.operators
      .filter(
        (operator) =>
          operator.status === "candidate" &&
          operator.fromSceneId === "bot.settings" &&
          operator.toSceneId === "bot.settings.enter_key_behavior_menu" &&
          operator.title.includes("钱包"),
      )
      .map((operator) => operator.toSceneId),
  );
  const invalidOperatorIds = new Set(
    graph.operators
      .filter(
        (operator) =>
          (operator.status === "candidate" &&
            !taskOperatorIds.has(operator.operatorId) &&
            operator.effects.some((effect) =>
              effect.includes("Deterministic Scene classification matched"),
            ) &&
            ((operator.risk === "navigation" &&
              operator.fromSceneId === operator.toSceneId) ||
              (operator.operation.type === "swipe" &&
                operator.fromSceneId !== operator.toSceneId))) ||
          (operator.status === "candidate" &&
            operator.fromSceneId === "bot.settings" &&
            operator.toSceneId === "bot.settings.enter_key_behavior_menu" &&
            operator.title.includes("钱包")) ||
          (operator.status === "candidate" &&
            operator.fromSceneId === "skills.home" &&
            operator.toSceneId === "skills.home" &&
            (operator.operation.type === "tap" ||
              operator.operation.type === "long_press") &&
            (operator.operation.elementId === "skills.home." ||
              operator.effects.some((effect) =>
                effect.includes(
                  "Deterministic Scene classification matched skills.home",
                ),
              ))),
      )
      .map((operator) => operator.operatorId),
  );
  if (invalidOperatorIds.size === 0 && invalidSceneIds.size === 0) {
    return graph;
  }
  const removedElementIds = new Set<string>();
  for (const operator of graph.operators) {
    if (
      invalidOperatorIds.has(operator.operatorId) &&
      (operator.operation.type === "tap" ||
        operator.operation.type === "long_press")
    ) {
      removedElementIds.add(operator.operation.elementId);
    }
  }
  const operators = graph.operators.filter(
    (operator) => !invalidOperatorIds.has(operator.operatorId),
  );
  const elements = graph.elements.filter(
    (element) =>
      !(
        removedElementIds.has(element.elementId) &&
        element.bindings.every((binding) => binding.status === "candidate") &&
        !operators.some(
          (operator) =>
            (operator.operation.type === "tap" ||
              operator.operation.type === "long_press") &&
            operator.operation.elementId === element.elementId,
        )
      ),
  );
  const pruned: ExecutableUiGraphExperiment = {
    ...graph,
    scenes: graph.scenes.filter(
      (scene) =>
        !(
          invalidSceneIds.has(scene.sceneId) &&
          !graph.operators.some(
            (operator) =>
              !invalidOperatorIds.has(operator.operatorId) &&
              operator.toSceneId === scene.sceneId,
          )
        ),
    ),
    elements,
    operators,
  };
  await writeGraph(graphPath, pruned);
  return pruned;
}

async function normalizeSkillTryInChatGraph(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
): Promise<ExecutableUiGraphExperiment> {
  const unstableOperatorIds = new Set(
    graph.operators
      .filter(
        (operator) =>
          operator.fromSceneId === "skills.home" &&
          operator.toSceneId === "chat.detail" &&
          operator.title.includes("多股对比") &&
          operator.effects.some((effect) =>
            effect.includes("opened a full chat/new conversation page"),
          ),
      )
      .map((operator) => operator.operatorId),
  );
  const elementId = "skills.detail.try_in_chat";
  const operatorId = "skills.detail.try_in_chat.tap.chat.detail";
  const existingElement = graph.elements.find(
    (element) => element.elementId === elementId,
  );
  const profile = graph.deviceProfiles.find(
    (candidate) => candidate.profileId === graph.defaultDeviceProfileId,
  );
  if (!profile) {
    return graph;
  }
  const element: ExperimentElement = {
    ...(existingElement ?? {
      elementId,
      sceneId: "skills.detail",
      bindings: [],
    }),
    title: "在对话中试用",
    semanticRole: "navigation_entry",
    selector: {
      accessibilityId: "在对话中试用",
      label: "在对话中试用",
      role: "StaticText",
    },
    bindings: mergeBinding(existingElement?.bindings ?? [], {
      bindingId: `${elementId}.${profile.profileId}`,
      deviceProfileId: profile.profileId,
      normalizedPoint: {
        x: 0.5,
        y: 0.882,
      },
      source: "ui_dump",
      status: "candidate",
      reliability: 0.7,
      observedAt: new Date().toISOString(),
    }),
  };
  const existingOperator = graph.operators.find(
    (operator) => operator.operatorId === operatorId,
  );
  const operator: ExperimentOperator = {
    ...(existingOperator ?? {}),
    operatorId,
    title: "在对话中试用当前技能",
    fromSceneId: "skills.detail",
    toSceneId: "chat.detail",
    operation: { type: "tap", elementId },
    settleMs: DEFAULT_SETTLE_MS,
    risk: "navigation",
    status: existingOperator?.status ?? "candidate",
    reliability: existingOperator?.reliability ?? 0.7,
    preconditions: existingOperator?.preconditions ?? [],
    effects: [
      ...new Set([...(existingOperator?.effects ?? []), "chat.mode=new"]),
    ],
    postconditions: [
      ...new Set([
        ...(existingOperator?.postconditions ?? []),
        "scene.current=chat.detail",
        "chat.mode=new",
      ]),
    ],
  };
  const normalized: ExecutableUiGraphExperiment = {
    ...graph,
    elements: [
      ...graph.elements.filter(
        (candidate) => candidate.elementId !== elementId,
      ),
      element,
    ],
    operators: [
      ...graph.operators.filter(
        (candidate) =>
          candidate.operatorId !== operatorId &&
          !unstableOperatorIds.has(candidate.operatorId),
      ),
      operator,
    ],
  };
  if (
    JSON.stringify(normalized.elements) === JSON.stringify(graph.elements) &&
    JSON.stringify(normalized.operators) === JSON.stringify(graph.operators)
  ) {
    return graph;
  }
  await writeGraph(graphPath, normalized);
  return normalized;
}

async function normalizeSettingsRowOperators(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
): Promise<ExecutableUiGraphExperiment> {
  const operatorId =
    "bot.settings.icon_setting_right_enter.tap.bot.settings.subscription";
  const operator = graph.operators.find(
    (candidate) => candidate.operatorId === operatorId,
  );
  if (
    !operator ||
    operator.operation.type !== "tap" ||
    operator.operation.elementId === "bot.settings.subscription_entry"
  ) {
    return graph;
  }
  const oldElementId = operator.operation.elementId;
  const oldElement = graph.elements.find(
    (candidate) => candidate.elementId === oldElementId,
  );
  const existingRow = graph.elements.find(
    (candidate) => candidate.elementId === "bot.settings.subscription_entry",
  );
  const bindings = (existingRow?.bindings ?? oldElement?.bindings ?? []).map(
    (binding) => ({
      ...binding,
      bindingId: `bot.settings.subscription_entry.${binding.deviceProfileId}`,
      normalizedPoint: {
        ...binding.normalizedPoint,
        x: 0.5,
      },
    }),
  );
  const row: ExperimentElement = {
    ...(existingRow ?? {
      elementId: "bot.settings.subscription_entry",
      sceneId: "bot.settings",
      bindings: [],
    }),
    title: "豆包专业版",
    semanticRole: "settings_navigation_entry",
    selector: {
      accessibilityId: "豆包专业版",
      label: "豆包专业版",
      role: "StaticText",
    },
    bindings,
  };
  const normalized: ExecutableUiGraphExperiment = {
    ...graph,
    elements: [
      ...graph.elements.filter(
        (candidate) =>
          candidate.elementId !== row.elementId &&
          !(
            candidate.elementId === oldElement?.elementId &&
            !graph.operators.some(
              (item) =>
                item.operatorId !== operatorId &&
                (item.operation.type === "tap" ||
                  item.operation.type === "long_press") &&
                item.operation.elementId === candidate.elementId,
            )
          ),
      ),
      row,
    ],
    operators: graph.operators.map((candidate) =>
      candidate.operatorId === operatorId
        ? {
            ...candidate,
            title: "打开豆包专业版",
            operation: {
              type: "tap" as const,
              elementId: row.elementId,
            },
            risk: "navigation" as const,
          }
        : candidate,
    ),
  };
  await writeGraph(graphPath, normalized);
  return normalized;
}

export async function collapseStateScenes(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
): Promise<ExecutableUiGraphExperiment> {
  const migrations = Object.entries(STATE_SCENE_MIGRATIONS).filter(
    ([sceneId]) => graph.scenes.some((scene) => scene.sceneId === sceneId),
  );
  if (migrations.length === 0) {
    const enriched = enrichStateTaskOracles(graph);
    if (JSON.stringify(enriched.tasks) !== JSON.stringify(graph.tasks)) {
      await writeGraph(graphPath, enriched);
    }
    return enriched;
  }
  const migrationBySceneId = new Map(migrations);
  const stateSceneById = new Map(
    graph.scenes.map((scene) => [scene.sceneId, scene]),
  );
  let scenes = [...graph.scenes];
  for (const [stateSceneId, migration] of migrations) {
    const stateScene = scenes.find((scene) => scene.sceneId === stateSceneId);
    const baseScene = scenes.find(
      (scene) => scene.sceneId === migration.baseSceneId,
    );
    if (!stateScene || !baseScene) {
      continue;
    }
    const stateVariant = {
      title: migration.title,
      facts: migration.facts,
      visualTextAnchors: stateScene.visualTextAnchors ?? [],
      referenceAssets: stateScene.referenceAssets,
    };
    const mergedBase: ExperimentScene = {
      ...baseScene,
      stateVariants: mergeStateVariant(
        baseScene.stateVariants ?? [],
        stateVariant,
      ),
    };
    scenes = scenes
      .filter((scene) => scene.sceneId !== stateSceneId)
      .map((scene) =>
        scene.sceneId === mergedBase.sceneId ? mergedBase : scene,
      );
  }
  const operators = graph.operators.map((operator) => {
    const fromMigration = migrationBySceneId.get(operator.fromSceneId);
    const toMigration = migrationBySceneId.get(operator.toSceneId);
    return {
      ...operator,
      fromSceneId: fromMigration?.baseSceneId ?? operator.fromSceneId,
      toSceneId: toMigration?.baseSceneId ?? operator.toSceneId,
      preconditions: [
        ...new Set([
          ...(operator.preconditions ?? []),
          ...(fromMigration?.facts ?? []),
        ]),
      ],
      effects: [
        ...new Set([
          ...(operator.effects ?? []),
          ...(toMigration?.facts ?? []),
        ]),
      ],
      postconditions: [
        ...new Set(
          operator.postconditions
            .map((postcondition) => {
              if (!postcondition.startsWith("scene.current=")) {
                return postcondition;
              }
              const sceneId = postcondition.slice("scene.current=".length);
              return `scene.current=${
                migrationBySceneId.get(sceneId)?.baseSceneId ?? sceneId
              }`;
            })
            .concat(toMigration?.facts ?? []),
        ),
      ],
    };
  });
  const elements = graph.elements.map((element) => ({
    ...element,
    sceneId:
      migrationBySceneId.get(element.sceneId)?.baseSceneId ?? element.sceneId,
  }));
  const tasks = graph.tasks.map((task) => ({
    ...task,
    entrySceneId:
      migrationBySceneId.get(task.entrySceneId)?.baseSceneId ??
      task.entrySceneId,
    finalOracles: task.finalOracles.flatMap((oracle) => {
      if (
        oracle.type !== "scene_current" ||
        !migrationBySceneId.has(oracle.sceneId)
      ) {
        return [oracle];
      }
      const migration = migrationBySceneId.get(oracle.sceneId)!;
      const stateScene = stateSceneById.get(oracle.sceneId);
      return [
        { ...oracle, sceneId: migration.baseSceneId },
        ...(stateScene?.visualTextAnchors ?? []).slice(0, 3).map((value) => ({
          type: "ui_text_visible" as const,
          value,
        })),
      ];
    }),
  }));
  const collapsed: ExecutableUiGraphExperiment = {
    ...graph,
    scenes,
    elements,
    operators,
    tasks,
  };
  const enriched = enrichStateTaskOracles(collapsed);
  await writeGraph(graphPath, enriched);
  return enriched;
}

function enrichStateTaskOracles(
  graph: ExecutableUiGraphExperiment,
): ExecutableUiGraphExperiment {
  const operatorById = new Map(
    graph.operators.map((operator) => [operator.operatorId, operator]),
  );
  const sceneById = new Map(
    graph.scenes.map((scene) => [scene.sceneId, scene]),
  );
  const tasks = graph.tasks.map((task) => {
    const stateByKey = new Map<string, string>();
    let finalSceneId = task.entrySceneId;
    for (const operatorId of task.operatorIds) {
      const operator = operatorById.get(operatorId);
      if (!operator) {
        continue;
      }
      finalSceneId = operator.toSceneId;
      for (const fact of [...operator.effects, ...operator.postconditions]) {
        if (fact.startsWith("scene.current=")) {
          continue;
        }
        const separator = fact.indexOf("=");
        if (separator >= 0) {
          stateByKey.set(fact.slice(0, separator), fact);
        }
      }
    }
    const variants = sceneById.get(finalSceneId)?.stateVariants ?? [];
    const matchingVariant = variants.find((variant) =>
      variant.facts.every((fact) => {
        const separator = fact.indexOf("=");
        const key = separator >= 0 ? fact.slice(0, separator) : fact;
        return stateByKey.get(key) === fact;
      }),
    );
    if (!matchingVariant) {
      return task;
    }
    const existingUiTexts = new Set(
      task.finalOracles
        .filter((oracle) => oracle.type === "ui_text_visible")
        .map((oracle) => oracle.value),
    );
    const stateOracles = matchingVariant.visualTextAnchors
      .filter((value) => !existingUiTexts.has(value))
      .slice(0, 3)
      .map((value) => ({
        type: "ui_text_visible" as const,
        value,
      }));
    return stateOracles.length > 0
      ? {
          ...task,
          finalOracles: [...task.finalOracles, ...stateOracles],
        }
      : task;
  });
  return { ...graph, tasks };
}

export function canonicalizeCrawlerEffect(
  frontier: IosUiCrawlerActionFrontier,
  effect: IosUiCrawlerEffect,
  after: TargetedDiscoveryObservation,
): IosUiCrawlerEffect {
  if (effect.type === "no_effect") {
    return effect;
  }
  const explicitMigration = STATE_SCENE_MIGRATIONS[effect.toSceneId];
  const gestureAction =
    frontier.actionType.startsWith("swipe") ||
    frontier.actionType.startsWith("drag");
  const stateLike =
    effect.type === "state_change" ||
    effect.type === "viewport_change" ||
    gestureAction ||
    frontier.target.semanticRole.toLocaleLowerCase().includes("toggle");
  if (!explicitMigration && !stateLike) {
    return effect;
  }
  const stateFacts = mergeStateFacts(
    frontier.expectedStateFacts ?? [],
    effect.stateFacts ?? [],
    explicitMigration?.facts ?? [],
  );
  const toSceneId = explicitMigration?.baseSceneId ?? frontier.sceneId;
  const crossesBaseScene = toSceneId !== frontier.sceneId;
  return {
    ...effect,
    type: crossesBaseScene
      ? effect.type === "overlay"
        ? "overlay"
        : effect.type === "external_scene"
          ? "external_scene"
          : "new_scene"
      : effect.type === "viewport_change" ||
          frontier.expectedEffectType === "viewport_change" ||
          frontier.actionType.startsWith("swipe") ||
          frontier.actionType.startsWith("drag")
        ? "viewport_change"
        : "state_change",
    fromSceneId: frontier.sceneId,
    toSceneId,
    stateFacts,
    visualTextAnchors:
      effect.visualTextAnchors.length > 0
        ? effect.visualTextAnchors
        : stableObservationTexts(after).slice(0, 5),
  };
}

function mergeStateFacts(...groups: readonly (readonly string[])[]): string[] {
  const byKey = new Map<string, string>();
  for (const fact of groups.flat()) {
    const trimmed = fact.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    const key = separator >= 0 ? trimmed.slice(0, separator) : trimmed;
    byKey.set(key, trimmed);
  }
  return [...byKey.values()];
}

function observationReferenceAsset(
  observation: TargetedDiscoveryObservation,
): ReferenceAsset | undefined {
  const asset: ReferenceAsset = {
    screenshotPath: observation.screenshotPath || undefined,
    uiDumpPath: observation.uiDumpPath || undefined,
    recordPath: observation.ocrPath || undefined,
  };
  return asset.screenshotPath || asset.uiDumpPath || asset.recordPath
    ? asset
    : undefined;
}

function mergeReferenceAsset(
  existing: readonly ReferenceAsset[],
  asset: ReferenceAsset | undefined,
): ReferenceAsset[] {
  if (!asset) {
    return [...existing];
  }
  const signature = JSON.stringify(asset);
  return existing.some((candidate) => JSON.stringify(candidate) === signature)
    ? [...existing]
    : [...existing, asset];
}

function mergeStateVariant(
  existing: readonly NonNullable<ExperimentScene["stateVariants"]>[number][],
  variant: NonNullable<ExperimentScene["stateVariants"]>[number],
): NonNullable<ExperimentScene["stateVariants"]> {
  const facts = [...variant.facts].sort().join("|");
  const matched = existing.find(
    (candidate) => [...candidate.facts].sort().join("|") === facts,
  );
  if (!matched) {
    return [...existing, variant];
  }
  return existing.map((candidate) =>
    candidate === matched
      ? {
          ...candidate,
          title: variant.title || candidate.title,
          visualTextAnchors: [
            ...new Set([
              ...candidate.visualTextAnchors,
              ...variant.visualTextAnchors,
            ]),
          ],
          referenceAssets: [
            ...candidate.referenceAssets,
            ...variant.referenceAssets.filter(
              (asset) =>
                !candidate.referenceAssets.some(
                  (current) =>
                    JSON.stringify(current) === JSON.stringify(asset),
                ),
            ),
          ],
        }
      : candidate,
  );
}

async function backfillKnownReverseOperators(
  graphPath: string,
  graph: ExecutableUiGraphExperiment,
): Promise<ExecutableUiGraphExperiment> {
  if (
    graph.operators.some(
      (operator) =>
        operator.operatorId === "chat.detail.voice_input.return_to_text",
    )
  ) {
    return graph;
  }
  const scene = graph.scenes.find(
    (candidate) => candidate.sceneId === "chat.detail.voice.input",
  );
  const uiDumpPath = scene?.referenceAssets.find(
    (asset) => asset.uiDumpPath,
  )?.uiDumpPath;
  if (!uiDumpPath || !(await Bun.file(uiDumpPath).exists())) {
    return graph;
  }
  const dump = JSON.parse(await Bun.file(uiDumpPath).text()) as unknown;
  const target = findUiDumpNodeByText(dump, "文本输入");
  if (!target) {
    return graph;
  }
  const observation: TargetedDiscoveryObservation = {
    observationId: "backfill.voice-input",
    screenshotPath: "",
    uiDumpPath,
    ocrPath: "",
    matchedSceneId: "chat.detail.voice.input",
    candidateSceneId: "chat.detail.voice.input",
    candidateSceneTitle: "会话页语音输入态",
    visualTextAnchors: scene.visualTextAnchors ?? [],
    candidates: [
      {
        candidateId: "ui-text-input",
        source: "ui_dump",
        role: target.role,
        accessibilityId: target.accessibilityId,
        label: target.label,
        bounds: target.bounds,
      },
    ],
  };
  return persistDeterministicReverseOperator({
    graph,
    graphPath,
    after: observation,
    effect: {
      type: "state_change",
      fromSceneId: "chat.detail",
      toSceneId: "chat.detail.voice.input",
      title: "会话页语音输入态",
      visualTextAnchors: scene.visualTextAnchors ?? [],
      description: "Backfilled voice-input reverse transition.",
      confidence: 1,
    },
  });
}

function findUiDumpNodeByText(
  value: unknown,
  expected: string,
): {
  role?: string;
  accessibilityId?: string;
  label?: string;
  bounds: { x: number; y: number; width: number; height: number };
} | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUiDumpNodeByText(item, expected);
      if (found) {
        return found;
      }
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const label =
    typeof record.label === "string"
      ? record.label
      : typeof record.name === "string"
        ? record.name
        : undefined;
  const accessibilityId =
    typeof record.accessibilityId === "string" ? record.accessibilityId : label;
  const rawBounds =
    typeof record.bounds === "object" && record.bounds !== null
      ? (record.bounds as Record<string, unknown>)
      : typeof record.rect === "object" && record.rect !== null
        ? (record.rect as Record<string, unknown>)
        : undefined;
  if (
    (label === expected || accessibilityId === expected) &&
    rawBounds &&
    ["x", "y", "width", "height"].every(
      (key) => typeof rawBounds[key] === "number",
    )
  ) {
    return {
      role:
        typeof record.role === "string"
          ? record.role
          : typeof record.type === "string"
            ? record.type
            : undefined,
      accessibilityId,
      label,
      bounds: {
        x: rawBounds.x as number,
        y: rawBounds.y as number,
        width: rawBounds.width as number,
        height: rawBounds.height as number,
      },
    };
  }
  for (const child of Object.values(record)) {
    const found = findUiDumpNodeByText(child, expected);
    if (found) {
      return found;
    }
  }
  return null;
}

function findReusableElement(
  graph: ExecutableUiGraphExperiment,
  sceneId: string,
  target: TargetedDiscoveryObservation["candidates"][number],
): ExperimentElement | undefined {
  return graph.elements.find(
    (element) =>
      element.sceneId === sceneId &&
      ((target.accessibilityId &&
        element.selector.accessibilityId === target.accessibilityId) ||
        (target.label && element.selector.label === target.label) ||
        (target.text && element.selector.text === target.text)),
  );
}

function findReusableOperator(options: {
  graph: ExecutableUiGraphExperiment;
  fromSceneId: string;
  toSceneId: string;
  actionType: IosUiCrawlerActionType;
  elementId: string;
}): ExperimentOperator | undefined {
  return options.graph.operators.find((operator) => {
    if (
      operator.fromSceneId !== options.fromSceneId ||
      operator.toSceneId !== options.toSceneId
    ) {
      return false;
    }
    if (options.actionType === "tap") {
      return (
        operator.operation.type === "tap" &&
        operator.operation.elementId === options.elementId
      );
    }
    if (options.actionType === "long_press") {
      return (
        operator.operation.type === "long_press" &&
        operator.operation.elementId === options.elementId
      );
    }
    return operator.operation.type === "swipe";
  });
}

function deterministicSceneScan(
  frontier: IosUiCrawlerSceneFrontier,
  observation: TargetedDiscoveryObservation,
  error: unknown,
  viewport: ViewportDimensions = { width: 414, height: 896 },
): SceneScanProposal {
  const candidates = businessCandidates(observation, viewport).filter(
    (candidate) =>
      frontier.sceneId !== "skills.home" ||
      candidate.role === "VerticalScrollRegion" ||
      isSkillTitleCandidate(candidate),
  );
  const elements = candidates.slice(0, 30).map((candidate) => {
    const title = primaryCandidateText(candidate);
    const skillEntry =
      frontier.sceneId === "skills.home" &&
      candidate.role !== "VerticalScrollRegion";
    const semanticRole = skillEntry
      ? "skill_navigation_entry"
      : (candidate.role ?? "element");
    return {
      candidateId: candidate.candidateId,
      elementId: skillEntry
        ? `skills.home.${stableTextSlug(title)}`
        : `${safeSegment(frontier.sceneId)}.${safeSegment(title || candidate.candidateId)}`,
      title,
      semanticRole,
      actions: skillEntry
        ? (["tap"] as const)
        : deterministicApplicableActions(semanticRole, title),
      risk: skillEntry ? ("navigation" as const) : inferRisk(title),
      expectedEffectType: skillEntry
        ? ("new_scene" as const)
        : inferExpectedEffectType(semanticRole, title),
      requiredStateFacts: [],
      expectedStateFacts: skillEntry
        ? [`skill.name=${title}`]
        : inferExpectedStateFacts(title),
      undoHint: inferUndoHint(title),
      priority: skillEntry ? 75 : inferPriority(semanticRole, title),
      reason: skillEntry
        ? "Stable skills-list title."
        : "Deterministic role fallback.",
    };
  });
  return {
    sceneId: frontier.sceneId,
    title: frontier.title,
    aliases: [],
    visualTextAnchors: stableObservationTexts(observation).slice(0, 3),
    elements,
    reason: `Scene Agent failed; deterministic fallback was used: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function normalizeSceneScan(
  proposal: SceneScanProposal,
  frontier: IosUiCrawlerSceneFrontier,
  candidates: readonly TargetedDiscoveryObservation["candidates"][number][],
): SceneScanProposal {
  const candidateIds = new Set(
    candidates.map((candidate) => candidate.candidateId),
  );
  return {
    ...proposal,
    sceneId: frontier.sceneId,
    title: proposal.title.trim() || frontier.title,
    aliases: proposal.aliases.map((value) => value.trim()).filter(Boolean),
    visualTextAnchors: proposal.visualTextAnchors
      .map((value) => value.trim())
      .filter(isStableIdentityText),
    elements: proposal.elements
      .filter((element) => candidateIds.has(element.candidateId))
      .map((element) => ({
        ...element,
        elementId: stableGraphId(element.elementId, "element"),
        actions: [...new Set(element.actions)],
        expectedEffectType: normalizeExpectedEffectType(
          element.expectedEffectType,
          element.semanticRole,
          element.title,
          element.risk,
        ),
        requiredStateFacts: (element.requiredStateFacts ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
        expectedStateFacts: (
          element.expectedStateFacts ?? inferExpectedStateFacts(element.title)
        )
          .map((value) => value.trim())
          .filter(Boolean),
        undoHint: (element.undoHint ?? inferUndoHint(element.title)).trim(),
      })),
  };
}

function applicableActions(
  target: IosUiCrawlerElementTarget,
  proposed: readonly IosUiCrawlerActionType[],
): IosUiCrawlerActionType[] {
  const allowed = new Set(
    deterministicApplicableActions(target.semanticRole, target.title),
  );
  return proposed.filter((action) => allowed.has(action));
}

function deterministicApplicableActions(
  role: string,
  title: string,
): IosUiCrawlerActionType[] {
  const normalizedRole = role.toLocaleLowerCase();
  if (
    normalizedRole.includes("horizontal") ||
    normalizedRole.includes("carousel")
  ) {
    return ["swipe_left", "swipe_right"];
  }
  if (normalizedRole.includes("scroll") || normalizedRole.includes("list")) {
    return ["swipe_up", "swipe_down"];
  }
  if (normalizedRole.includes("slider") || normalizedRole.includes("canvas")) {
    return ["drag_left", "drag_right", "drag_up", "drag_down"];
  }
  if (
    normalizedRole.includes("button") ||
    normalizedRole.includes("tab") ||
    normalizedRole.includes("entry") ||
    normalizedRole.includes("link") ||
    normalizedRole.includes("shortcut") ||
    normalizedRole.includes("back") ||
    normalizedRole.includes("close") ||
    normalizedRole.includes("toggle") ||
    normalizedRole.includes("option") ||
    normalizedRole.includes("filter") ||
    normalizedRole.includes("mode") ||
    normalizedRole.includes("dismiss") ||
    normalizedRole.includes("control") ||
    /入口|页面|设置|搜索|技能|云盘|创作|相册|相机|更多/.test(title)
  ) {
    return /消息|图片|卡片/.test(title) ? ["tap", "long_press"] : ["tap"];
  }
  return [];
}

function inferRisk(title: string): ExperimentOperator["risk"] {
  if (/删除|清空|注销/.test(title)) {
    return "destructive";
  }
  if (
    /发送|发布|提交|确认|确定|使用|保存|完成|支付|购买|授权|允许/.test(title)
  ) {
    return "mutation";
  }
  if (/选择|勾选/.test(title)) {
    return "selection";
  }
  return /入口|页面|设置|搜索|技能|云盘|创作|相册|相机|更多|返回|关闭/.test(
    title,
  )
    ? "navigation"
    : "interaction";
}

function inferExpectedEffectType(
  role: string,
  title: string,
): NonNullable<IosUiCrawlerActionFrontier["expectedEffectType"]> {
  const normalizedRole = role.toLocaleLowerCase();
  if (
    normalizedRole.includes("scroll") ||
    normalizedRole.includes("list") ||
    normalizedRole.includes("carousel") ||
    normalizedRole.includes("slider")
  ) {
    return "viewport_change";
  }
  if (
    normalizedRole.includes("toggle") ||
    /闪光灯|切换摄像头|语音输入|文本输入|自动朗读|开关/.test(title)
  ) {
    return "state_change";
  }
  if (/更多|菜单|面板/.test(title)) {
    return "overlay";
  }
  if (/入口|页面|设置|搜索|技能|云盘|创作|相册|相机|返回|关闭/.test(title)) {
    return "new_scene";
  }
  return "unknown";
}

function normalizeExpectedEffectType(
  proposed: IosUiCrawlerActionFrontier["expectedEffectType"],
  role: string,
  title: string,
  risk: ExperimentOperator["risk"],
): NonNullable<IosUiCrawlerActionFrontier["expectedEffectType"]> {
  const inferred = inferExpectedEffectType(role, title);
  if (inferred === "viewport_change") {
    return inferred;
  }
  if (risk === "navigation") {
    return inferred === "overlay" ? "overlay" : "new_scene";
  }
  return proposed ?? inferred;
}

function inferExpectedStateFacts(title: string): string[] {
  if (/语音输入/.test(title)) {
    return ["composer.mode=voice"];
  }
  if (/文本输入/.test(title)) {
    return ["composer.mode=text"];
  }
  if (/切换摄像头|摄像头已后置/.test(title)) {
    return ["camera.facing=toggled"];
  }
  if (/闪光灯/.test(title)) {
    return ["camera.flash=next"];
  }
  return [];
}

function inferUndoHint(title: string): string {
  if (/语音输入/.test(title)) {
    return "点击文本输入切回文本模式";
  }
  if (/文本输入/.test(title)) {
    return "点击语音输入切回语音模式";
  }
  if (/切换摄像头|闪光灯|开关/.test(title)) {
    return "再次点击同一控件恢复或循环状态";
  }
  return "";
}

function inferPriority(role: string, title: string): number {
  if (/搜索|技能|云盘|创作|设置|相册|相机|更多/.test(title)) {
    return 90;
  }
  if (role.toLocaleLowerCase().includes("button")) {
    return 70;
  }
  if (
    role.toLocaleLowerCase().includes("scroll") ||
    role.toLocaleLowerCase().includes("list")
  ) {
    return 60;
  }
  return 30;
}

function stableCandidate(
  candidate: TargetedDiscoveryObservation["candidates"][number],
): boolean {
  const text = primaryCandidateText(candidate);
  return Boolean(
    text &&
    text.length <= 40 &&
    isStableIdentityText(text) &&
    candidate.bounds.width > 0 &&
    candidate.bounds.height > 0 &&
    candidate.source === "ui_dump",
  );
}

interface ViewportDimensions {
  readonly width: number;
  readonly height: number;
}

function crawlerViewport(
  graph: ExecutableUiGraphExperiment,
): ViewportDimensions {
  const profile = graph.deviceProfiles.find(
    (candidate) => candidate.profileId === graph.defaultDeviceProfileId,
  );
  return {
    width: profile?.viewportWidth ?? 414,
    height: profile?.viewportHeight ?? 896,
  };
}

export function businessCandidates(
  observation: TargetedDiscoveryObservation,
  viewport: ViewportDimensions = { width: 414, height: 896 },
): TargetedDiscoveryObservation["candidates"] {
  const visible = observation.candidates
    .filter(stableCandidate)
    .filter((candidate) => candidateWithinViewport(candidate, viewport))
    .sort(
      (left, right) =>
        right.bounds.width * right.bounds.height -
        left.bounds.width * left.bounds.height,
    );
  const selected: TargetedDiscoveryObservation["candidates"][number][] = [];
  const seenTexts = new Set<string>();
  for (const candidate of visible) {
    const text = normalizeText(primaryCandidateText(candidate));
    if (!text || seenTexts.has(text)) {
      continue;
    }
    const containingBusinessRow = selected.find(
      (parent) =>
        isBusinessRow(parent) &&
        boundsContain(parent.bounds, candidate.bounds) &&
        parent.bounds.width * parent.bounds.height >
          candidate.bounds.width * candidate.bounds.height,
    );
    if (containingBusinessRow) {
      continue;
    }
    const sameBounds = selected.find(
      (parent) =>
        Math.abs(parent.bounds.x - candidate.bounds.x) <= 1 &&
        Math.abs(parent.bounds.y - candidate.bounds.y) <= 1 &&
        Math.abs(parent.bounds.width - candidate.bounds.width) <= 1 &&
        Math.abs(parent.bounds.height - candidate.bounds.height) <= 1,
    );
    if (sameBounds) {
      continue;
    }
    seenTexts.add(text);
    selected.push(candidate);
  }
  const verticalRegion = deriveVerticalGestureCandidate(
    undefined,
    observation,
    viewport,
  );
  return verticalRegion ? [...selected, verticalRegion] : selected;
}

function deriveVerticalGestureCandidate(
  frontier: IosUiCrawlerSceneFrontier | undefined,
  observation: TargetedDiscoveryObservation,
  viewport: ViewportDimensions,
): TargetedDiscoveryObservation["candidates"][number] | undefined {
  const stable = observation.candidates.filter(stableCandidate);
  const offscreen = stable.filter(
    (candidate) => !candidateWithinViewport(candidate, viewport),
  );
  if (offscreen.length < 2) {
    return undefined;
  }
  const visible = stable.filter((candidate) =>
    candidateWithinViewport(candidate, viewport),
  );
  const labels = visible
    .filter((candidate) => candidate.bounds.width >= viewport.width * 0.45)
    .map(primaryCandidateText)
    .filter(Boolean)
    .slice(-6);
  const sceneId =
    frontier?.sceneId ??
    observation.matchedSceneId ??
    observation.candidateSceneId;
  return {
    candidateId: `gesture-vertical-${safeSegment(sceneId)}`,
    source: "ui_dump",
    role: "VerticalScrollRegion",
    label: `纵向可滑动区域：${labels.join(" | ") || sceneId}`,
    value: labels.join("|"),
    bounds: {
      x: Math.round(viewport.width * 0.08),
      y: Math.round(viewport.height * 0.18),
      width: Math.round(viewport.width * 0.84),
      height: Math.round(viewport.height * 0.68),
    },
  };
}

function candidateWithinViewport(
  candidate: TargetedDiscoveryObservation["candidates"][number],
  viewport: ViewportDimensions,
): boolean {
  return (
    candidate.bounds.x >= 0 &&
    candidate.bounds.y >= 0 &&
    candidate.bounds.x + candidate.bounds.width <= viewport.width &&
    candidate.bounds.y + candidate.bounds.height <= viewport.height
  );
}

function isBusinessRow(
  candidate: TargetedDiscoveryObservation["candidates"][number],
): boolean {
  const role = candidate.role?.toLocaleLowerCase() ?? "";
  return (
    candidate.bounds.width >= 250 &&
    candidate.bounds.height >= 32 &&
    candidate.bounds.height <= 100 &&
    !role.includes("scroll") &&
    !role.includes("list")
  );
}

function isSkillTitleCandidate(
  candidate: TargetedDiscoveryObservation["candidates"][number],
): boolean {
  return (
    candidate.source === "ui_dump" &&
    candidate.role?.toLocaleLowerCase() === "statictext" &&
    isSkillTitleBounds(candidate.bounds) &&
    primaryCandidateText(candidate).length >= 2 &&
    primaryCandidateText(candidate).length <= 24 &&
    isStableIdentityText(primaryCandidateText(candidate))
  );
}

function isSkillTitleBounds(
  bounds: IosUiCrawlerElementTarget["bounds"],
): boolean {
  return (
    bounds.x >= 70 &&
    bounds.x <= 130 &&
    bounds.y >= 70 &&
    bounds.y <= 900 &&
    bounds.width >= 170 &&
    bounds.width <= 290 &&
    bounds.height >= 22 &&
    bounds.height <= 32
  );
}

function boundsContain(
  parent: IosUiCrawlerElementTarget["bounds"],
  child: IosUiCrawlerElementTarget["bounds"],
): boolean {
  return (
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x + child.width <= parent.x + parent.width &&
    child.y + child.height <= parent.y + parent.height
  );
}

export function relocateTarget(
  target: IosUiCrawlerElementTarget,
  observation: TargetedDiscoveryObservation,
  viewport?: ViewportDimensions,
): TargetedDiscoveryObservation["candidates"][number] | undefined {
  const candidates = viewport
    ? observation.candidates.filter((candidate) =>
        candidateWithinViewport(candidate, viewport),
      )
    : observation.candidates;
  const exact = candidates
    .filter(
      (candidate) =>
        candidate.source === "ui_dump" &&
        !isSettingsOffscreenChildArtifact(target, candidate) &&
        ((target.selector.accessibilityId &&
          candidate.accessibilityId === target.selector.accessibilityId) ||
          (target.selector.label &&
            candidate.label === target.selector.label) ||
          (target.selector.text && candidate.text === target.selector.text)),
    )
    .sort(
      (left, right) =>
        (targetGeometryCompatible(target, right) ? 1 : 0) -
          (targetGeometryCompatible(target, left) ? 1 : 0) ||
        Math.abs(left.bounds.width - target.bounds.width) +
          Math.abs(left.bounds.height - target.bounds.height) -
          (Math.abs(right.bounds.width - target.bounds.width) +
            Math.abs(right.bounds.height - target.bounds.height)),
    )[0];
  if (exact) {
    return exact;
  }
  if (target.selector.role && target.selector.value) {
    const normalizedValue = normalizeText(target.selector.value);
    const byRoleAndValue = candidates
      .filter(
        (candidate) =>
          candidate.source === "ui_dump" &&
          candidate.role === target.selector.role &&
          normalizeText(
            candidate.value ??
              candidate.label ??
              candidate.text ??
              candidate.accessibilityId ??
              "",
          ).includes(normalizedValue),
      )
      .sort(
        (left, right) =>
          Math.abs(
            left.bounds.y +
              left.bounds.height / 2 -
              (target.bounds.y + target.bounds.height / 2),
          ) -
          Math.abs(
            right.bounds.y +
              right.bounds.height / 2 -
              (target.bounds.y + target.bounds.height / 2),
          ),
      )[0];
    if (byRoleAndValue) {
      return byRoleAndValue;
    }
  }
  if (
    target.semanticRole.toLocaleLowerCase().includes("scroll") ||
    target.selector.role === "HorizontalScrollRegion"
  ) {
    const targetItems = regionSemanticItems(
      target.selector.value ?? target.selector.label ?? target.title,
    );
    const targetCenterY = target.bounds.y + target.bounds.height / 2;
    return candidates
      .filter(
        (candidate) =>
          candidate.role === target.selector.role ||
          candidate.role === "HorizontalScrollRegion",
      )
      .map((candidate) => {
        const candidateItems = regionSemanticItems(
          candidate.value ?? candidate.label ?? primaryCandidateText(candidate),
        );
        const overlap = candidateItems.filter((item) =>
          targetItems.includes(item),
        ).length;
        const centerY = candidate.bounds.y + candidate.bounds.height / 2;
        return {
          candidate,
          score:
            overlap * 100 -
            Math.abs(centerY - targetCenterY) -
            Math.abs(candidate.bounds.width - target.bounds.width) * 0.1,
        };
      })
      .sort((left, right) => right.score - left.score)[0]?.candidate;
  }
  const normalizedTitle = normalizeText(target.title);
  return candidates.find(
    (candidate) =>
      candidate.source === "ui_dump" &&
      !isSettingsOffscreenChildArtifact(target, candidate) &&
      normalizeText(primaryCandidateText(candidate)) === normalizedTitle &&
      targetGeometryCompatible(target, candidate),
  );
}

function isSettingsOffscreenChildArtifact(
  target: IosUiCrawlerElementTarget,
  candidate: TargetedDiscoveryObservation["candidates"][number],
): boolean {
  const knownLongPageEntry =
    target.semanticRole === "settings_navigation_entry" ||
    target.elementId === "bot.settings.about_debug.faq";
  return (
    knownLongPageEntry &&
    candidate.bounds.y <= 120 &&
    target.bounds.y >= 400 &&
    candidate.bounds.y < target.bounds.y * 0.5
  );
}

function targetGeometryCompatible(
  target: IosUiCrawlerElementTarget,
  candidate: TargetedDiscoveryObservation["candidates"][number],
): boolean {
  if (target.bounds.width < 250 || target.bounds.height < 40) {
    return true;
  }
  return (
    candidate.bounds.width >= target.bounds.width * 0.8 &&
    candidate.bounds.height >= target.bounds.height * 0.75
  );
}

function regionSemanticItems(value: string): string[] {
  return value
    .replace(/^横向可滑动区域[:：]\s*/, "")
    .split("|")
    .map(normalizeText)
    .filter(Boolean);
}

function observationSceneId(observation: TargetedDiscoveryObservation): string {
  const deterministic = classifyTargetedDiscoveryScene(observation.candidates);
  if (deterministic) {
    return (
      STATE_SCENE_MIGRATIONS[deterministic.sceneId]?.baseSceneId ??
      deterministic.sceneId
    );
  }
  if (
    observation.candidateSceneId &&
    !observation.candidateSceneId.startsWith("discovery.")
  ) {
    return (
      STATE_SCENE_MIGRATIONS[observation.candidateSceneId]?.baseSceneId ??
      observation.candidateSceneId
    );
  }
  if (observationLooksLikeChatDetail(observation)) {
    return "chat.detail";
  }
  const sceneId = observation.matchedSceneId ?? observation.candidateSceneId;
  return STATE_SCENE_MIGRATIONS[sceneId]?.baseSceneId ?? sceneId;
}

function observationLooksLikeChatDetail(
  observation: TargetedDiscoveryObservation,
): boolean {
  const texts = new Set(
    observation.candidates.map((candidate) =>
      normalizeText(primaryCandidateText(candidate)),
    ),
  );
  const hasComposer = [...texts].some(
    (text) =>
      text.includes("发消息") ||
      text.includes("按住说话") ||
      text === "文本输入",
  );
  return (
    hasComposer &&
    texts.has(normalizeText("对话列表")) &&
    (texts.has(normalizeText("更多面板")) ||
      texts.has(normalizeText("语音输入")))
  );
}

function primaryCandidateText(
  candidate: TargetedDiscoveryObservation["candidates"][number],
): string {
  return (
    candidate.label ??
    candidate.text ??
    candidate.value ??
    candidate.accessibilityId ??
    ""
  ).trim();
}

function observationFingerprint(
  observation: TargetedDiscoveryObservation,
): string {
  return createHash("sha1")
    .update(
      JSON.stringify(
        observation.candidates
          .filter(stableCandidate)
          .map((candidate) => [
            candidate.role,
            normalizeText(primaryCandidateText(candidate)),
            Math.round(candidate.bounds.x / 10),
            Math.round(candidate.bounds.y / 10),
          ])
          .sort(),
      ),
    )
    .digest("hex");
}

function compactObservation(
  observation: TargetedDiscoveryObservation,
): unknown {
  return {
    matchedSceneId: observation.matchedSceneId,
    candidateSceneId: observation.candidateSceneId,
    visualTextAnchors: observation.visualTextAnchors,
    candidates: observation.candidates
      .filter(stableCandidate)
      .slice(0, 60)
      .map((candidate) => ({
        role: candidate.role,
        text: primaryCandidateText(candidate),
        bounds: candidate.bounds,
      })),
  };
}

function stableObservationTexts(
  observation: TargetedDiscoveryObservation,
): string[] {
  return [
    ...new Set(
      observation.candidates
        .map(primaryCandidateText)
        .filter(
          (text) =>
            text.length >= 2 && text.length <= 24 && isStableIdentityText(text),
        ),
    ),
  ];
}

function stableAnchors(
  values: readonly string[],
  observation: TargetedDiscoveryObservation,
): string[] {
  const available = stableObservationTexts(observation).map(normalizeText);
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter(
          (value) =>
            isStableIdentityText(value) &&
            available.some((text) => text.includes(normalizeText(value))),
        ),
    ),
  ].slice(0, 5);
}

function nextSceneFrontier(
  state: IosUiCrawlerState,
  sceneIdPrefixes: readonly string[] = [],
): IosUiCrawlerSceneFrontier | undefined {
  return state.sceneFrontiers
    .filter(
      (frontier) =>
        frontier.status === "pending_scan" &&
        sceneMatchesPrefixes(frontier.sceneId, sceneIdPrefixes) &&
        frontier.attempts < state.budgets.maximumAttemptsPerAction,
    )
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        left.createdAt.localeCompare(right.createdAt),
    )[0];
}

export function selectFocusedSceneId(
  state: IosUiCrawlerState,
  excludedSceneId?: string,
  sceneIdPrefixes: readonly string[] = [],
): string | undefined {
  const pendingSceneIds = new Set(
    state.actionFrontiers
      .filter(
        (frontier) =>
          frontier.status === "pending" &&
          sceneMatchesPrefixes(frontier.sceneId, sceneIdPrefixes) &&
          frontier.attempts < state.budgets.maximumAttemptsPerAction,
      )
      .map((frontier) => frontier.sceneId),
  );
  return state.sceneFrontiers
    .filter(
      (frontier) =>
        frontier.status === "scanned" &&
        frontier.sceneId !== excludedSceneId &&
        pendingSceneIds.has(frontier.sceneId),
    )
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        left.createdAt.localeCompare(right.createdAt),
    )[0]?.sceneId;
}

export function maintainFocusedScene(
  state: IosUiCrawlerState,
  focusedSceneId: string | undefined,
  sceneIdPrefixes: readonly string[] = [],
): string | undefined {
  if (
    focusedSceneId &&
    state.actionFrontiers.some(
      (frontier) =>
        frontier.sceneId === focusedSceneId &&
        sceneMatchesPrefixes(frontier.sceneId, sceneIdPrefixes) &&
        frontier.status === "pending" &&
        frontier.attempts < state.budgets.maximumAttemptsPerAction,
    )
  ) {
    return focusedSceneId;
  }
  return selectFocusedSceneId(state, undefined, sceneIdPrefixes);
}

function nextActionFrontier(
  state: IosUiCrawlerState,
  focusedSceneId?: string,
  sceneIdPrefixes: readonly string[] = [],
): IosUiCrawlerActionFrontier | undefined {
  return state.actionFrontiers
    .filter(
      (frontier) =>
        frontier.status === "pending" &&
        sceneMatchesPrefixes(frontier.sceneId, sceneIdPrefixes) &&
        (focusedSceneId === undefined || frontier.sceneId === focusedSceneId) &&
        frontier.attempts < state.budgets.maximumAttemptsPerAction,
    )
    .sort(
      (left, right) =>
        left.sceneDepth - right.sceneDepth ||
        actionSessionPriority(left) - actionSessionPriority(right) ||
        right.priority - left.priority ||
        left.createdAt.localeCompare(right.createdAt),
    )[0];
}

function sceneMatchesPrefixes(
  sceneId: string,
  sceneIdPrefixes: readonly string[],
): boolean {
  return (
    sceneIdPrefixes.length === 0 ||
    sceneIdPrefixes.some((prefix) => sceneId.startsWith(prefix))
  );
}

async function recoverFocusedScene(options: {
  input: NormalizedInput;
  graph: ExecutableUiGraphExperiment;
  fromSceneId: string;
  targetSceneId: string;
  beforeObservation: TargetedDiscoveryObservation;
  outputDir: string;
}): Promise<{
  success: boolean;
  observation?: TargetedDiscoveryObservation;
  issue?: string;
}> {
  await mkdir(options.outputDir, { recursive: true });
  if (
    options.fromSceneId === "skills.detail" &&
    options.targetSceneId === "skills.home"
  ) {
    const closeTarget = options.beforeObservation.candidates
      .filter(
        (candidate) =>
          candidate.source === "ui_dump" || candidate.source === "vision_ocr",
      )
      .find((candidate) => {
        const text = normalizeText(primaryCandidateText(candidate));
        return (
          text === "×" ||
          text === "x" ||
          text.includes("关闭") ||
          text.includes("close")
        );
      });
    if (closeTarget) {
      const point = {
        x: closeTarget.bounds.x + closeTarget.bounds.width / 2,
        y: closeTarget.bounds.y + closeTarget.bounds.height / 2,
      };
      const command = [
        "mobilecli",
        "io",
        "tap",
        "--device",
        options.input.udid,
        `${Math.round(point.x)},${Math.round(point.y)}`,
      ];
      const executed = await runCrawlerCommandWithRetry(
        command,
        options.input.projectRoot,
      );
      await writeJsonAtomic(
        join(options.outputDir, "skills-detail-close.json"),
        {
          target: closeTarget,
          command,
          attempts: executed.attempts,
          result: executed.result,
        },
      );
      if (executed.result.exitCode === 0) {
        await Bun.sleep(options.input.settleMs);
        const observation = await captureTargetedDiscoveryObservation({
          graph: options.graph,
          udid: options.input.udid,
          outputDir: join(options.outputDir, "after-skills-detail-close"),
          index: 0,
          preferredSceneId: options.targetSceneId,
        });
        if (observationSceneId(observation) === options.targetSceneId) {
          return { success: true, observation };
        }
      }
    }
  }
  const reverseOperator = options.graph.operators
    .filter(
      (operator) =>
        operator.fromSceneId === options.fromSceneId &&
        operator.toSceneId === options.targetSceneId &&
        operator.risk === "navigation" &&
        (operator.status === "verified" || operator.status === "candidate"),
    )
    .sort((left, right) => right.reliability - left.reliability)[0];
  if (reverseOperator) {
    const command = compileCrawlerOperatorCommand(
      options.graph,
      reverseOperator,
      options.input.udid,
    );
    if (command) {
      const result = await runCommand(command, options.input.projectRoot);
      await writeJsonAtomic(join(options.outputDir, "reverse-operator.json"), {
        operator: reverseOperator,
        command,
        result,
      });
      if (result.exitCode === 0) {
        await Bun.sleep(reverseOperator.settleMs);
        const observation = await captureTargetedDiscoveryObservation({
          graph: options.graph,
          udid: options.input.udid,
          outputDir: join(options.outputDir, "after-reverse"),
          index: 0,
          preferredSceneId: options.targetSceneId,
        });
        if (observationSceneId(observation) === options.targetSceneId) {
          return { success: true, observation };
        }
      }
    }
  }

  const safeTarget = findLocalRecoveryTarget(
    options.beforeObservation,
    options.targetSceneId,
  );
  if (!safeTarget) {
    return {
      success: false,
      issue: `No local recovery action from ${options.fromSceneId} to ${options.targetSceneId}.`,
    };
  }
  const point = {
    x: safeTarget.bounds.x + safeTarget.bounds.width / 2,
    y: safeTarget.bounds.y + safeTarget.bounds.height / 2,
  };
  const command = [
    "mobilecli",
    "io",
    "tap",
    "--device",
    options.input.udid,
    `${Math.round(point.x)},${Math.round(point.y)}`,
  ];
  const result = await runCommand(command, options.input.projectRoot);
  await writeJsonAtomic(join(options.outputDir, "safe-control.json"), {
    target: safeTarget,
    command,
    result,
  });
  if (result.exitCode !== 0) {
    return {
      success: false,
      issue: `Local recovery control failed: ${result.exitCode}.`,
    };
  }
  await Bun.sleep(options.input.settleMs);
  const observation = await captureTargetedDiscoveryObservation({
    graph: options.graph,
    udid: options.input.udid,
    outputDir: join(options.outputDir, "after-safe-control"),
    index: 0,
    preferredSceneId: options.targetSceneId,
  });
  return {
    success: observationSceneId(observation) === options.targetSceneId,
    observation,
    issue:
      observationSceneId(observation) === options.targetSceneId
        ? undefined
        : `Local recovery observed ${observationSceneId(observation)} instead of ${options.targetSceneId}.`,
  };
}

function findLocalRecoveryTarget(
  observation: TargetedDiscoveryObservation,
  targetSceneId: string,
): TargetedDiscoveryObservation["candidates"][number] | undefined {
  const preferredTexts =
    targetSceneId === "chat.detail"
      ? ["文本输入", "返回", "关闭", "取消", "完成", "对话列表"]
      : ["返回", "关闭", "取消", "完成"];
  return observation.candidates
    .filter((candidate) => candidate.source === "ui_dump")
    .map((candidate) => {
      const text = normalizeText(primaryCandidateText(candidate));
      const exactIndex = preferredTexts.findIndex(
        (token) => text === normalizeText(token),
      );
      const containsIndex = preferredTexts.findIndex((token) =>
        text.includes(normalizeText(token)),
      );
      const role = candidate.role?.toLocaleLowerCase() ?? "";
      return {
        candidate,
        score:
          (exactIndex >= 0 ? 1000 - exactIndex : 0) +
          (containsIndex >= 0 ? 100 - containsIndex : 0) +
          (role.includes("button") ? 50 : 0),
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.candidate;
}

export function compileCrawlerOperatorCommand(
  graph: ExecutableUiGraphExperiment,
  operator: ExperimentOperator,
  udid: string,
): string[] | undefined {
  if (
    operator.operation.type === "tap" ||
    operator.operation.type === "long_press"
  ) {
    const elementId = operator.operation.elementId;
    const element = graph.elements.find(
      (candidate) => candidate.elementId === elementId,
    );
    const binding = element?.bindings
      .filter(
        (candidate) =>
          candidate.deviceProfileId === graph.defaultDeviceProfileId &&
          (candidate.status === "verified" || candidate.status === "candidate"),
      )
      .sort((left, right) => right.reliability - left.reliability)[0];
    const profile = graph.deviceProfiles.find(
      (candidate) => candidate.profileId === graph.defaultDeviceProfileId,
    );
    if (!binding || !profile) {
      return undefined;
    }
    const point = {
      x: binding.normalizedPoint.x * profile.viewportWidth,
      y: binding.normalizedPoint.y * profile.viewportHeight,
    };
    return operator.operation.type === "tap"
      ? [
          "mobilecli",
          "io",
          "tap",
          "--device",
          udid,
          `${Math.round(point.x)},${Math.round(point.y)}`,
        ]
      : [
          "mobilecli",
          "io",
          "longpress",
          "--device",
          udid,
          `${Math.round(point.x)},${Math.round(point.y)}`,
          "--duration",
          String(operator.operation.durationMs),
        ];
  }
  if (operator.operation.type === "swipe") {
    return [
      "mobilecli",
      "io",
      "swipe",
      "--device",
      udid,
      `${Math.round(operator.operation.from.x)},${Math.round(operator.operation.from.y)},${Math.round(operator.operation.to.x)},${Math.round(operator.operation.to.y)}`,
    ];
  }
  return undefined;
}

function replaceSceneFrontier(
  state: IosUiCrawlerState,
  frontier: IosUiCrawlerSceneFrontier,
): IosUiCrawlerState {
  return {
    ...state,
    status: "running",
    updatedAt: new Date().toISOString(),
    sceneFrontiers: state.sceneFrontiers.map((candidate) =>
      candidate.frontierId === frontier.frontierId ? frontier : candidate,
    ),
  };
}

function replaceActionFrontier(
  state: IosUiCrawlerState,
  frontier: IosUiCrawlerActionFrontier,
): IosUiCrawlerState {
  return {
    ...state,
    status: "running",
    updatedAt: new Date().toISOString(),
    actionFrontiers: state.actionFrontiers.map((candidate) =>
      candidate.frontierId === frontier.frontierId ? frontier : candidate,
    ),
  };
}

function finishState(
  state: IosUiCrawlerState,
  stopReason: NonNullable<IosUiCrawlerState["lastSession"]>["stopReason"],
  scannedScenes: number,
  executedActions: number,
  sessionStarted: number,
  coverage: IosUiCrawlerCoverage,
): IosUiCrawlerState {
  const pending =
    state.sceneFrontiers.some(
      (frontier) =>
        frontier.status === "pending_scan" || frontier.status === "scanning",
    ) ||
    state.actionFrontiers.some(
      (frontier) =>
        frontier.status === "pending" ||
        frontier.status === "running" ||
        (frontier.status === "failed" &&
          frontier.attempts < state.budgets.maximumAttemptsPerAction),
    ) ||
    coverage.pageAudit.gaps > 0;
  const now = new Date().toISOString();
  return {
    ...state,
    status: pending ? "paused" : "completed",
    updatedAt: now,
    lastSession: {
      startedAt: new Date(
        Date.now() - (performance.now() - sessionStarted),
      ).toISOString(),
      finishedAt: now,
      scannedScenes,
      executedActions,
      durationMs: performance.now() - sessionStarted,
      stopReason,
    },
  };
}

function normalizeInput(args: IosUiCrawlerInput): NormalizedInput {
  if (!args) {
    throw new TypeError("iOS UI Graph Discovery requires input arguments.");
  }
  const graphPath = resolve(args.graphPath?.trim() || DEFAULT_GRAPH_PATH);
  const resumeStatePath = args.resumeStatePath?.trim()
    ? resolve(args.resumeStatePath)
    : undefined;
  const runId = safeSegment(args.runId?.trim() || timestampForPath());
  const outputDir = resumeStatePath
    ? dirname(resumeStatePath)
    : resolve(
        args.outputDir?.trim() ||
          join(DEFAULT_ARTIFACT_ROOT, "ios-ui-graph-discovery", runId),
      );
  return {
    graphPath,
    projectRoot: resolve(args.projectRoot?.trim() || DEFAULT_PROJECT_ROOT),
    udid: args.udid?.trim() || "00008030-001A286A2229802E",
    startSceneId: args.startSceneId?.trim() || undefined,
    focusElementId: args.focusElementId?.trim() || undefined,
    runId,
    outputDir,
    statePath: resumeStatePath ?? join(outputDir, "state.json"),
    manifestPath: join(outputDir, "manifest.json"),
    coveragePath: join(outputDir, "coverage.json"),
    graphDeltaPath: join(outputDir, "graph-delta.json"),
    reportPath: join(outputDir, "report.html"),
    planOnly: args.planOnly !== false,
    evidenceMigrationOnly: args.evidenceMigrationOnly === true,
    maximumActions: boundedInteger(
      args.maximumActions,
      1,
      500,
      DEFAULT_MAXIMUM_ACTIONS,
    ),
    maximumScenes: boundedInteger(
      args.maximumScenes,
      1,
      200,
      DEFAULT_MAXIMUM_SCENES,
    ),
    maximumDepth: boundedInteger(
      args.maximumDepth,
      0,
      20,
      DEFAULT_MAXIMUM_DEPTH,
    ),
    maximumDurationMinutes: boundedInteger(
      args.maximumDurationMinutes,
      1,
      480,
      DEFAULT_MAXIMUM_DURATION_MINUTES,
    ),
    maximumAttemptsPerAction: boundedInteger(
      args.maximumAttemptsPerAction,
      1,
      5,
      DEFAULT_MAXIMUM_ATTEMPTS,
    ),
    maximumActionsPerScene: boundedInteger(
      args.maximumActionsPerScene,
      1,
      100,
      DEFAULT_MAXIMUM_ACTIONS_PER_SCENE,
    ),
    agentTimeoutMs: boundedInteger(
      args.agentTimeoutMs,
      1_000,
      300_000,
      DEFAULT_AGENT_TIMEOUT_MS,
    ),
    settleMs: boundedInteger(args.settleMs, 100, 10_000, DEFAULT_SETTLE_MS),
    refreshMap: args.refreshMap !== false,
    mapHtmlPath: resolve(
      args.mapHtmlPath?.trim() ||
        "/Users/bytedance/Documents/BDWorkSpace/ios-perf-optimizer/assets/app-regression/com.bot.doubao/ui-map/map.html",
    ),
    sceneIdPrefixes: [
      ...new Set(
        (args.sceneIdPrefixes ?? [])
          .map((prefix) => prefix.trim())
          .filter(Boolean),
      ),
    ],
    model: args.model?.trim() || undefined,
  };
}

async function persistState(
  input: NormalizedInput,
  state: IosUiCrawlerState,
): Promise<void> {
  await writeJsonAtomic(input.statePath, state);
}

async function persistOutputs(
  input: NormalizedInput,
  state: IosUiCrawlerState,
  coverage: IosUiCrawlerCoverage,
): Promise<void> {
  await Promise.all([
    persistState(input, state),
    writeJsonAtomic(input.coveragePath, coverage),
    writeJsonAtomic(input.graphDeltaPath, {
      schemaVersion: "ios-ui-scene-crawler-delta/v1",
      baseline: coverage.baseline,
      current: coverage.current,
      delta: coverage.delta,
    }),
    writeJsonAtomic(input.manifestPath, {
      schemaVersion: "ios-ui-scene-crawler-manifest/v1",
      runId: state.runId,
      graphPath: input.graphPath,
      statePath: input.statePath,
      coveragePath: input.coveragePath,
      graphDeltaPath: input.graphDeltaPath,
      reportPath: input.reportPath,
      generatedAt: new Date().toISOString(),
    }),
    Bun.write(input.reportPath, renderReport(state, coverage)),
  ]);
}

function buildResult(
  input: NormalizedInput,
  state: IosUiCrawlerState,
  coverage: IosUiCrawlerCoverage,
): IosUiCrawlerResult {
  return {
    success: true,
    planOnly: input.planOnly,
    outputDir: input.outputDir,
    graphPath: input.graphPath,
    statePath: input.statePath,
    manifestPath: input.manifestPath,
    coveragePath: input.coveragePath,
    graphDeltaPath: input.graphDeltaPath,
    reportPath: input.reportPath,
    state,
    coverage,
  };
}

function renderReport(
  state: IosUiCrawlerState,
  coverage: IosUiCrawlerCoverage,
): string {
  const sceneRows = state.sceneFrontiers
    .map(
      (frontier) =>
        `<tr><td>${escapeHtml(frontier.sceneId)}</td><td>${frontier.depth}</td><td>${escapeHtml(frontier.status)}</td><td>${frontier.attempts}</td><td>${escapeHtml(frontier.issue ?? "")}</td></tr>`,
    )
    .join("");
  const actionRows = state.actionFrontiers
    .map(
      (frontier) =>
        `<tr><td>${escapeHtml(frontier.sceneId)}</td><td>${escapeHtml(frontier.target.title)}</td><td>${escapeHtml(frontier.actionType)}</td><td>${escapeHtml(frontier.status)}</td><td>${escapeHtml(frontier.effect?.type ?? "")}</td><td>${escapeHtml(frontier.issue ?? "")}</td></tr>`,
    )
    .join("");
  const pageAuditRows = coverage.pageAudit.entries
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.sceneId)}</td><td>${escapeHtml(entry.title)}</td><td>${escapeHtml(entry.status)}</td><td>${escapeHtml(entry.toSceneId ?? "")}</td><td>${escapeHtml(entry.reason)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>iOS Scene Crawler</title><style>body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f7fb;color:#17202a;margin:0}main{max-width:1200px;margin:auto;padding:28px}.card{background:#fff;border:1px solid #dce3eb;border-radius:12px;padding:18px;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.metric{background:#f8fafc;padding:12px;border-radius:8px}.metric b{display:block;font-size:24px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid #e5eaf0}</style></head><body><main><h1>Scene → Element → Action → Effect</h1><section class="card"><div class="grid"><div class="metric">Scenes<b>${coverage.current.sceneCount}</b>${signed(coverage.delta.scenes)}</div><div class="metric">Elements<b>${coverage.current.elementCount}</b>${signed(coverage.delta.elements)}</div><div class="metric">Operators<b>${coverage.current.operatorCount}</b>${signed(coverage.delta.operators)}</div><div class="metric">Page Gaps<b>${coverage.pageAudit.gaps}</b>${escapeHtml(coverage.pageAudit.status)}</div></div><p>Status: <b>${escapeHtml(state.status)}</b></p></section><section class="card"><h2>Page Coverage Audit</h2><p>Covered ${coverage.pageAudit.covered} · Template covered ${coverage.pageAudit.templateCovered} · Blocked ${coverage.pageAudit.blocked} · Gaps ${coverage.pageAudit.gaps}</p><table><thead><tr><th>Scene</th><th>Entry</th><th>Status</th><th>Target Scene</th><th>Reason</th></tr></thead><tbody>${pageAuditRows}</tbody></table></section><section class="card"><h2>Scene Frontiers</h2><table><thead><tr><th>Scene</th><th>Depth</th><th>Status</th><th>Attempts</th><th>Issue</th></tr></thead><tbody>${sceneRows}</tbody></table></section><section class="card"><h2>Element Action Frontiers</h2><table><thead><tr><th>Scene</th><th>Element</th><th>Action</th><th>Status</th><th>Effect</th><th>Issue</th></tr></thead><tbody>${actionRows}</tbody></table></section></main></body></html>`;
}

function snapshotGraph(graph: ExecutableUiGraphExperiment): IosUiGraphSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    sceneCount: graph.scenes.length,
    elementCount: graph.elements.length,
    operatorCount: graph.operators.length,
    taskCount: graph.tasks.length,
    sceneStatusCounts: countStatuses(graph.scenes),
    operatorStatusCounts: countStatuses(graph.operators),
    taskStatusCounts: countStatuses(graph.tasks),
  };
}

function countStatuses(
  entities: readonly { readonly status: ExperimentScene["status"] }[],
): IosUiGraphSnapshot["sceneStatusCounts"] {
  const counts = {
    observed: 0,
    candidate: 0,
    verified: 0,
    stale: 0,
    blocked: 0,
    disabled: 0,
  };
  for (const entity of entities) {
    counts[entity.status] += 1;
  }
  return counts;
}

function graphDelta(
  baseline: IosUiGraphSnapshot,
  current: IosUiGraphSnapshot,
): IosUiCrawlerCoverage["delta"] {
  return {
    scenes: current.sceneCount - baseline.sceneCount,
    elements: current.elementCount - baseline.elementCount,
    operators: current.operatorCount - baseline.operatorCount,
    tasks: current.taskCount - baseline.taskCount,
  };
}

function emptyActionStatusCounts(): Record<IosUiCrawlerFrontierStatus, number> {
  return {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
  };
}

function emptyActionTypeCounts(): Record<IosUiCrawlerActionType, number> {
  return {
    tap: 0,
    long_press: 0,
    swipe_left: 0,
    swipe_right: 0,
    swipe_up: 0,
    swipe_down: 0,
    drag_left: 0,
    drag_right: 0,
    drag_up: 0,
    drag_down: 0,
  };
}

function emptyEffectTypeCounts(): Record<IosUiCrawlerEffect["type"], number> {
  return {
    new_scene: 0,
    overlay: 0,
    state_change: 0,
    viewport_change: 0,
    external_scene: 0,
    no_effect: 0,
  };
}

function mergeBinding(
  bindings: ExperimentElement["bindings"],
  binding: ExperimentElement["bindings"][number],
): ExperimentElement["bindings"] {
  return [
    ...bindings.filter(
      (candidate) => candidate.deviceProfileId !== binding.deviceProfileId,
    ),
    binding,
  ];
}

function crawlerOperatorId(
  frontier: IosUiCrawlerActionFrontier,
  effect: IosUiCrawlerEffect,
): string {
  return `${safeSegment(frontier.sceneId)}.${safeSegment(frontier.target.elementId.split(".").at(-1) ?? "element")}.${frontier.actionType}.${safeSegment(effect.toSceneId)}`;
}

function actionFrontierId(
  sceneId: string,
  target: IosUiCrawlerElementTarget,
  actionType: IosUiCrawlerActionType,
): string {
  return `action.${createHash("sha1")
    .update(
      JSON.stringify([
        sceneId,
        target.elementId,
        actionType,
        target.selector.accessibilityId,
        target.selector.label,
      ]),
    )
    .digest("hex")
    .slice(0, 12)}`;
}

function gestureCoordinates(
  actionType: IosUiCrawlerActionType,
  bounds: IosUiCrawlerElementTarget["bounds"],
  horizontalInset: number,
  verticalInset: number,
): string {
  const points = gesturePoints(
    actionType,
    bounds,
    horizontalInset,
    verticalInset,
  );
  return `${Math.round(points.from.x)},${Math.round(points.from.y)},${Math.round(points.to.x)},${Math.round(points.to.y)}`;
}

export function gesturePoints(
  actionType: IosUiCrawlerActionType,
  bounds: IosUiCrawlerElementTarget["bounds"],
  horizontalInset = Math.max(12, bounds.width * 0.2),
  verticalInset = Math.max(12, bounds.height * 0.2),
): {
  from: { x: number; y: number };
  to: { x: number; y: number };
} {
  const verticalScrollable =
    (actionType === "swipe_up" ||
      actionType === "swipe_down" ||
      actionType === "drag_up" ||
      actionType === "drag_down") &&
    bounds.height < 180;
  if (verticalScrollable) {
    const centerX = Math.min(360, Math.max(54, bounds.x + bounds.width / 2));
    return actionType === "swipe_up" || actionType === "drag_up"
      ? {
          from: { x: centerX, y: 720 },
          to: { x: centerX, y: 230 },
        }
      : {
          from: { x: centerX, y: 230 },
          to: { x: centerX, y: 720 },
        };
  }
  const left = bounds.x + horizontalInset;
  const right = bounds.x + bounds.width - horizontalInset;
  const top = bounds.y + verticalInset;
  const bottom = bounds.y + bounds.height - verticalInset;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  if (actionType.endsWith("left")) {
    return { from: { x: right, y: centerY }, to: { x: left, y: centerY } };
  }
  if (actionType.endsWith("right")) {
    return { from: { x: left, y: centerY }, to: { x: right, y: centerY } };
  }
  if (actionType.endsWith("up")) {
    return { from: { x: centerX, y: bottom }, to: { x: centerX, y: top } };
  }
  return { from: { x: centerX, y: top }, to: { x: centerX, y: bottom } };
}

function isBlockedRisk(risk: ExperimentOperator["risk"]): boolean {
  return ["permission", "mutation", "destructive"].includes(risk);
}

function isTransientMobilecliFailure(result: {
  readonly stdout: string;
  readonly stderr: string;
}): boolean {
  return /(?:unexpected\s+)?EOF|connection reset|broken pipe|timed out|timeout/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

async function runCrawlerCommandWithRetry(
  command: readonly string[],
  cwd: string,
): Promise<{
  result: Awaited<ReturnType<typeof runCommand>>;
  attempts: readonly Awaited<ReturnType<typeof runCommand>>[];
}> {
  let result = await runCommand(command, cwd);
  const attempts = [result];
  for (
    let retry = 1;
    result.exitCode !== 0 && retry <= 2 && isTransientMobilecliFailure(result);
    retry += 1
  ) {
    await Bun.sleep(retry * 300);
    result = await runCommand(command, cwd);
    attempts.push(result);
  }
  return { result, attempts };
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。,.!！?？:：;；"'“”‘’]/g, "");
}

function stableTextSlug(value: string): string {
  const safe = safeSegment(value);
  return (
    safe ||
    `text-${createHash("sha1").update(value).digest("hex").slice(0, 12)}`
  );
}

function stableGraphId(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[._-]{2,}/g, ".");
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(normalized)
    ? normalized
    : `crawler.${fallback}.${createHash("sha1")
        .update(value)
        .digest("hex")
        .slice(0, 10)}`;
}

async function runAgentWithTimeout<TOutput>(
  prompt: string,
  options: AgentOptions,
  timeoutMs: number,
  label: string,
): Promise<TOutput> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new Error(`${label} timed out after ${timeoutMs} ms.`)),
    timeoutMs,
  );
  try {
    return await agent<TOutput>(prompt, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readGraph(path: string): Promise<ExecutableUiGraphExperiment> {
  return readJson<ExecutableUiGraphExperiment>(path);
}

async function writeGraph(
  path: string,
  graph: ExecutableUiGraphExperiment,
): Promise<void> {
  const formatted = await format(JSON.stringify(graph), {
    parser: "json",
    filepath: path,
  });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, formatted, "utf8");
  await rename(temporaryPath, path);
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `Expected an integer between ${minimum} and ${maximum}; got ${value}.`,
    );
  }
  return value;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function timestampForPath(): string {
  return new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}
