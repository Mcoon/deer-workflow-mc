import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import { applyAndSave, loadGraph } from "../ios-ui-graph-manager";
import {
  buildStrictRestartCommand,
  parseStrictRestartResult,
} from "../app-graph-exec/workflow";
import {
  buildMobilecliForegroundCommand,
  buildMobilecliScreenshotCommand,
  buildMobilecliUiDumpCommand,
  parseUiDump,
  runCommand,
} from "../ios-regression-kit";
import type { CommandResult } from "../ios-regression-kit";
import type { UiElement } from "../ios-regression-kit/types";
import {
  buildViewportSearchCommand,
  searchViewports,
  viewportSearchAxisForTarget,
} from "../app-graph-exec/viewport-search";
import {
  buildRuntimeRecoveryCommand,
  classifyRuntimeScene,
  decideSceneRecoveryWithAgent,
} from "../app-graph-exec/runtime-recovery";
import type {
  RuntimeCandidate,
  RuntimeObservation,
  RuntimeRecoveryActionType,
  RuntimeSceneAgentEvaluation,
  RuntimeSceneAgentDecision,
} from "../app-graph-exec/runtime-recovery";
import { waitForStableObservation } from "../app-graph-exec/observation-stability";
import type { StableObservationResult } from "../app-graph-exec/observation-stability";

import type {
  AppGraph,
  GraphPatch,
  Scene,
} from "../ios-ui-graph-manager/types";
import type {
  AppGraphDiscoveryInput,
  AppGraphDiscoveryOutput,
  AppGraphDiscoveryRequest,
  AppGraphDiscoveryResult,
  DiscoveryPlan,
  DiscoveryElement,
  DiscoveryObservation,
} from "./types";

export { meta } from "./types";

const DEFAULT_OUTPUT_ROOT = join(
  homedir(),
  ".ios_pref_optimizer",
  "app-graph-discovery",
);
const DEFAULT_GRAPH_PATH = resolve(
  dirname(import.meta.path),
  "../ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);
const DEFAULT_BUNDLE_ID = "com.bot.doubao";
const DEFAULT_MAX_DEPTH = 0;
const DEFAULT_MAX_ACTIONS = 1;
const SETTLE_MS = 900;
const STABILITY_POLL_MS = 700;
const MAX_STABILITY_SAMPLES = 6;
const REQUIRED_STABLE_SAMPLES = 2;
const DEFAULT_AGENT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AGENT_RECOVERY_STEPS = 2;
const DEFAULT_MINIMUM_AGENT_CONFIDENCE = 0.75;
const MAX_VIEWPORT_SEARCH_MOVES = 6;
const DEFAULT_AGENT_CWD = resolve(dirname(import.meta.path), "../..");
const SKIP_LABELS = new Set(["", "system", "statusBar", "navigationBar"]);

export default async function appGraphDiscovery(
  args: AppGraphDiscoveryInput,
): Promise<AppGraphDiscoveryOutput> {
  const startedAt = Date.now();
  const graphPath = resolve(args.graphPath?.trim() || DEFAULT_GRAPH_PATH);
  const outputDir = resolve(
    join(
      args.outputDir?.trim() || DEFAULT_OUTPUT_ROOT,
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
  );
  await mkdir(outputDir, { recursive: true });

  let graph: AppGraph;
  try {
    graph = await loadGraph(graphPath);
  } catch {
    return {
      success: false,
      mode: "discovery_failure",
      outputDir,
      code: "graph_load_failed",
      message: `Cannot load graph from ${graphPath}.`,
      recoverable: false,
      evidencePaths: [],
    };
  }
  const requestPath = args.discoveryRequestPath?.trim()
    ? resolve(args.discoveryRequestPath)
    : undefined;
  let request: AppGraphDiscoveryRequest | undefined;
  if (requestPath) {
    try {
      request = JSON.parse(
        await Bun.file(requestPath).text(),
      ) as AppGraphDiscoveryRequest;
    } catch {
      return discoveryFailure({
        outputDir,
        code: "discovery_request_load_failed",
        message: `Cannot load discovery request from ${requestPath}.`,
        recoverable: true,
        evidencePaths: [requestPath],
      });
    }
    const requestIssue = validateDiscoveryRequest(request, graph);
    if (requestIssue) {
      return discoveryFailure({
        outputDir,
        ...requestIssue,
        evidencePaths: [requestPath, ...request.evidencePaths],
      });
    }
  }

  const startSceneId =
    args.startSceneId ??
    request?.startSceneId ??
    resolveDefaultEntrySceneId(graph);
  const focusElementId = args.startElementId ?? request?.focusElementId;
  const goal = (args.goal ?? request?.goal)?.trim();
  if (!focusElementId) {
    return discoveryFailure({
      outputDir,
      code: "missing_discovery_focus",
      message:
        "Targeted Discovery requires startElementId or discoveryRequest.focusElementId. Full-Scene exhaustive exploration is not allowed.",
      recoverable: true,
      evidencePaths: requestPath
        ? [requestPath, ...(request?.evidencePaths ?? [])]
        : [],
    });
  }
  if (!goal) {
    return discoveryFailure({
      outputDir,
      code: "missing_discovery_goal",
      message:
        "Targeted Discovery requires a user goal. Exploration without a goal is not allowed.",
      recoverable: true,
      evidencePaths: requestPath
        ? [requestPath, ...(request?.evidencePaths ?? [])]
        : [],
    });
  }
  // Discovery is a single evidence-backed probe. Multi-page navigation and
  // fallback belong to Exec, where every next action is re-evaluated against
  // the user goal. This prevents a focused probe from becoming a page crawler.
  const maxDepth = Math.max(
    0,
    Math.min(DEFAULT_MAX_DEPTH, args.maxDepth ?? DEFAULT_MAX_DEPTH),
  );
  const maxActions = Math.max(
    0,
    Math.min(DEFAULT_MAX_ACTIONS, args.maxActions ?? DEFAULT_MAX_ACTIONS),
  );
  const expectedSceneId =
    args.expectedSceneId ??
    resolveDiscoveryExpectedSceneId(graph, startSceneId, focusElementId, goal);
  const discoveryPlan = buildDiscoveryPlan({
    graph,
    goal,
    requestPath,
    request,
    startSceneId,
    focusElementId,
    allowStaleFocus: args.allowStaleFocus,
    expectedSceneId,
    maxDepth,
    maxActions,
  });
  const discoveryPlanPath = join(outputDir, "discovery-plan.json");
  await writeFile(
    discoveryPlanPath,
    JSON.stringify(discoveryPlan, null, 2),
    "utf8",
  );

  if (args.planOnly) {
    log(
      `Plan-only mode: ${discoveryPlan.candidates.length} semantic candidate(s) from ${startSceneId}.`,
    );
    const result: AppGraphDiscoveryResult = {
      success: true,
      mode: "discovery",
      planOnly: true,
      outputDir,
      graphPath,
      discoveryPlanPath,
      discoveryRequestPath: requestPath,
      startSceneId,
      scenesDiscovered: 0,
      elementsDiscovered: 0,
      operatorsDiscovered: 0,
      actionsExecuted: 0,
      totalDurationMs: Date.now() - startedAt,
      graphRevision: graph.revision,
      graphUpdated: false,
      evidencePaths: discoveryPlan.evidencePaths,
    };
    return result;
  }

  const udid = args.udid;
  if (!udid) {
    return {
      success: false,
      mode: "discovery_failure",
      outputDir,
      code: "missing_udid",
      message: "UDID is required for device discovery.",
      recoverable: false,
      evidencePaths: [],
    };
  }

  const bundleId = graph.bundleId ?? DEFAULT_BUNDLE_ID;
  const deviceProfile = graph.deviceProfiles[graph.defaultDeviceProfileId];
  if (!deviceProfile) {
    return discoveryFailure({
      outputDir,
      code: "device_profile_missing",
      message: `Default device profile does not exist: ${graph.defaultDeviceProfileId}.`,
      recoverable: false,
      evidencePaths: [],
    });
  }
  let scenesDiscovered = 0;
  let elementsDiscovered = 0;
  let operatorsDiscovered = 0;
  let actionsExecuted = 0;
  let visibilityActionsExecuted = 0;
  const stabilityPath = join(outputDir, "ground-stability.json");
  let agentDiagnosticPath: string | undefined;
  let agentUsed = false;
  let agentConfirmedTarget = false;
  let agentFailureMessage: string | undefined;
  let visibilityRecoveryFailure: string | undefined;
  const visibilitySearchPaths: string[] = [];
  let lastSuccessfulProbe:
    | Omit<DiscoveredTransition, "targetSceneId" | "revivesStaleTarget">
    | undefined;
  const visitedScenes = new Set<string>();
  const discoveredTransitions: DiscoveredTransition[] = [];
  const elementQueue: Array<{
    element: DiscoveryElement;
    graphElementId: string;
    sceneId: string;
    depth: number;
    allowedActions: readonly ("tap" | "long_press" | "swipe")[];
  }> = [];

  phase("Preflight");
  log("Discovery preflight...");

  phase("Reset");
  if (args.skipReset) {
    log("Using the caller-grounded start Scene without another reset.");
  } else {
    log("Cold-launching app...");
    try {
      await resetApp(udid, bundleId, outputDir);
    } catch (err) {
      return {
        success: false,
        mode: "discovery_failure",
        outputDir,
        code: "reset_failed",
        message: `Reset failed: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: true,
        evidencePaths: [],
      };
    }
  }

  phase("Ground");
  log(`Starting discovery from scene: ${startSceneId}`);
  let stability: StableObservationResult<DiscoveryObservation>;
  try {
    stability = await waitForStableDiscoveryObservation({
      udid,
      outputDir,
      prefix: "ground",
      sceneId: startSceneId,
    });
  } catch (error) {
    return discoveryFailure({
      outputDir,
      code: "stable_ground_capture_failed",
      message: `Could not observe the grounded page long enough to determine stability: ${
        error instanceof Error ? error.message : String(error)
      }`,
      recoverable: true,
      evidencePaths: [
        discoveryPlanPath,
        ...(stabilityPath ? [stabilityPath] : []),
        ...(agentDiagnosticPath ? [agentDiagnosticPath] : []),
      ],
    });
  }
  await writeFile(stabilityPath, JSON.stringify(stability, null, 2), "utf8");
  log(
    stability.stable
      ? `Page stable after ${stability.sampleCount} observations (${stability.samples.at(-1)?.strategy ?? "unknown"} fingerprint).`
      : `Page did not stabilize after ${stability.sampleCount} observations; refusing to interact with a moving UI.`,
  );
  if (!stability.stable) {
    return discoveryFailure({
      outputDir,
      code: "page_not_stable",
      message: `The page did not produce ${REQUIRED_STABLE_SAMPLES} consecutive matching observations before the stability budget expired.`,
      recoverable: true,
      evidencePaths: [
        discoveryPlanPath,
        stabilityPath,
        ...visibilitySearchPaths,
      ],
      stabilityPath,
    });
  }
  let currentObservation = stability.observation;

  for (const [
    candidateIndex,
    candidate,
  ] of discoveryPlan.candidates.entries()) {
    let element = resolveVisibleDiscoveryElement(
      currentObservation.elements,
      candidate.elementId,
      candidate.selectors,
      deviceProfile.viewportWidth,
      deviceProfile.viewportHeight,
    );
    if (!element) {
      const axis = viewportSearchAxisForTarget({
        elementId: candidate.elementId,
        semanticRole: candidate.semanticRole,
      });
      const searchDir = join(
        outputDir,
        "visibility-search",
        `${String(candidateIndex + 1).padStart(2, "0")}-${sanitizeId(candidate.elementId)}`,
      );
      try {
        const search = await searchViewports({
          axis,
          initialObservation: currentObservation,
          maximumMoves: MAX_VIEWPORT_SEARCH_MOVES,
          resolveVisibleTarget: (observation) =>
            resolveVisibleDiscoveryElement(
              observation.elements,
              candidate.elementId,
              candidate.selectors,
              deviceProfile.viewportWidth,
              deviceProfile.viewportHeight,
              deviceProfile.viewportHeight * 0.14,
              deviceProfile.viewportHeight * 0.9,
            ),
          moveAndObserve: async (direction, moveIndex, previous) => {
            log(
              `Viewport search ${moveIndex}/${MAX_VIEWPORT_SEARCH_MOVES}: swipe ${direction} by one short segment, wait for stability, then re-check ${candidate.title}.`,
            );
            const command = buildViewportSearchCommand({
              udid,
              axis,
              direction,
              viewportWidth: deviceProfile.viewportWidth,
              viewportHeight: deviceProfile.viewportHeight,
            });
            const recovery = await runCommand(command, process.cwd());
            if (recovery.exitCode !== 0) {
              throw new Error(
                recovery.stderr.trim() ||
                  `Command failed: ${command.join(" ")}`,
              );
            }
            visibilityActionsExecuted += 1;
            const recovered = await waitForStableDiscoveryObservation({
              udid,
              outputDir: searchDir,
              prefix: `${direction}-${String(moveIndex).padStart(2, "0")}`,
              sceneId: startSceneId,
              previousObservation: previous,
              requireChangeFromPrevious: false,
            });
            return {
              observation: recovered.observation,
              stable: recovered.stable,
              changedFromPrevious: recovered.changedFromPrevious,
              fingerprint:
                recovered.samples.at(-1)?.fingerprint ??
                `${direction}-${moveIndex}`,
            };
          },
        });
        currentObservation = search.observation;
        element = search.target ?? null;
        const searchPath = join(searchDir, "viewport-search.json");
        await mkdir(searchDir, { recursive: true });
        await writeFile(
          searchPath,
          JSON.stringify(
            {
              axis,
              targetElementId: candidate.elementId,
              targetTitle: candidate.title,
              stopReason: search.stopReason,
              moves: search.moves,
              finalScreenshotPath: search.observation.screenshotPath,
              finalUiDumpPath: search.observation.uiDumpPath,
            },
            null,
            2,
          ),
          "utf8",
        );
        visibilitySearchPaths.push(searchPath);
        if (element) {
          log(
            `Focus Element ${candidate.elementId} became visible after ${search.moves.length} short viewport move(s).`,
          );
        } else {
          log(
            `Viewport search stopped with ${search.stopReason}; ${candidate.title} was not visible in any inspected screen.`,
          );
        }
      } catch (error) {
        visibilityRecoveryFailure = `Viewport search failed while looking for ${candidate.title}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        log(visibilityRecoveryFailure);
      }
    }
    if (!element) {
      log(
        `Focus Element ${candidate.elementId} did not resolve uniquely in the current UI dump.`,
      );
      continue;
    }
    elementQueue.push({
      element,
      graphElementId: candidate.elementId,
      sceneId: startSceneId,
      depth: 0,
      allowedActions: candidate.allowedActions,
    });
  }

  if (elementQueue.length === 0 && args.allowStaleFocus && expectedSceneId) {
    const agentRecovery = await diagnoseAndRecoverStableDiscovery({
      graph,
      goal,
      expectedSceneId,
      startSceneId,
      focusElementId,
      observation: currentObservation,
      udid,
      outputDir,
      deviceProfile: {
        viewportWidth: deviceProfile.viewportWidth,
        viewportHeight: deviceProfile.viewportHeight,
      },
      agentCwd: resolve(args.agentCwd?.trim() || DEFAULT_AGENT_CWD),
      model: args.model,
      agentTimeoutMs: Math.max(
        1_000,
        args.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      ),
      maximumSteps: Math.max(
        0,
        Math.min(
          4,
          args.maxAgentRecoverySteps ?? DEFAULT_MAX_AGENT_RECOVERY_STEPS,
        ),
      ),
      minimumConfidence: Math.min(
        1,
        Math.max(
          0,
          args.minimumAgentConfidence ?? DEFAULT_MINIMUM_AGENT_CONFIDENCE,
        ),
      ),
      agentRunner: args.agentRunner,
    });
    agentUsed = agentRecovery.agentUsed;
    agentDiagnosticPath = agentRecovery.diagnosticPath;
    currentObservation = agentRecovery.observation;
    actionsExecuted += agentRecovery.actionsExecuted;
    if (agentRecovery.atTarget) {
      agentConfirmedTarget = true;
      const transition = agentRecovery.transition ?? {
        sourceSceneId: startSceneId,
        sourceElementId: "agent.scene_recognition",
        actionType: "none",
        targetSceneId: expectedSceneId,
        before: stability.observation,
        after: currentObservation,
        observationPath: agentDiagnosticPath,
        revivesStaleTarget: true,
      };
      discoveredTransitions.push(transition);
      visitedScenes.add(expectedSceneId);
      scenesDiscovered += 1;
      elementsDiscovered += countNewDiscoveryElements({
        graph,
        sceneId: expectedSceneId,
        observation: currentObservation,
        viewportWidth: deviceProfile.viewportWidth,
        viewportHeight: deviceProfile.viewportHeight,
      });
      if (transition.actionType !== "none") operatorsDiscovered += 1;
    } else {
      agentFailureMessage = agentRecovery.message;
      log(
        `Agent inspected the stable page but could not safely recover ${expectedSceneId}: ${agentRecovery.message}`,
      );
    }
  }
  if (visibilityRecoveryFailure) {
    return discoveryFailure({
      outputDir,
      code: "visibility_recovery_failed",
      message: visibilityRecoveryFailure,
      recoverable: true,
      evidencePaths: [discoveryPlanPath, stabilityPath],
      stabilityPath,
      visibilityActionsExecuted,
      focusElementId,
      focusElementTitle: discoveryPlan.candidates[0]?.title,
      expectedSceneId,
    });
  }

  phase("Explore");
  log(`Exploring (max depth: ${maxDepth}, max actions: ${maxActions})...`);

  while (actionsExecuted < maxActions && elementQueue.length > 0) {
    const next = elementQueue.shift()!;
    if (next.depth > maxDepth) continue;
    const element = next.element;
    const actions = next.allowedActions.map((action) =>
      action === "swipe" ? "swipe_left" : action,
    );

    for (const actionType of actions) {
      if (actionsExecuted >= maxActions) break;

      const actionDir = join(outputDir, `action-${actionsExecuted}`);
      await mkdir(actionDir, { recursive: true });

      log(
        `Action ${actionsExecuted + 1}: ${actionType} on ${element.label || element.elementId} (scene: ${next.sceneId})`,
      );

      const beforeObs = await captureObservation(
        udid,
        actionDir,
        "before",
        next.sceneId,
      );

      const execSuccess = await executeAction(udid, actionType, element);
      actionsExecuted++;
      const stableAfterAction = execSuccess
        ? await waitForStableDiscoveryObservation({
            udid,
            outputDir: actionDir,
            prefix: "after",
            sceneId: next.sceneId,
            previousObservation: beforeObs,
          })
        : undefined;
      const afterObs = stableAfterAction?.observation ?? beforeObs;
      currentObservation = afterObs;
      if (stableAfterAction) {
        await writeFile(
          join(actionDir, "stability.json"),
          JSON.stringify(stableAfterAction, null, 2),
          "utf8",
        );
      }

      const sceneChanged =
        stableAfterAction?.stable === true &&
        detectSceneChange(beforeObs, afterObs);
      if (execSuccess && stableAfterAction?.stable) {
        lastSuccessfulProbe = {
          sourceSceneId: next.sceneId,
          sourceElementId: next.graphElementId,
          actionType,
          before: beforeObs,
          after: afterObs,
          observationPath: join(actionDir, "observation.json"),
        };
      }

      if (execSuccess && sceneChanged) {
        const expectedScene = expectedSceneId
          ? graph.scenes[expectedSceneId]
          : undefined;
        const newSceneId = expectedScene
          ? discoveryObservationMatchesScene(afterObs, expectedScene)
            ? expectedScene.sceneId
            : null
          : findNewSceneId(beforeObs, afterObs);
        if (newSceneId && !visitedScenes.has(newSceneId)) {
          visitedScenes.add(newSceneId);
          scenesDiscovered++;
          log(`  -> New scene: ${newSceneId}`);
          const observationPath = join(actionDir, "observation.json");
          discoveredTransitions.push({
            sourceSceneId: next.sceneId,
            sourceElementId: next.graphElementId,
            actionType,
            targetSceneId: newSceneId,
            before: beforeObs,
            after: afterObs,
            observationPath,
            revivesStaleTarget:
              graph.scenes[newSceneId]?.status === "stale" &&
              newSceneId === expectedSceneId,
          });
          operatorsDiscovered++;

          // Capture every visible Element on the newly observed page, but do
          // not click any of them automatically. A later goal/Plan may select
          // one explicit Element for another targeted probe.
          elementsDiscovered += countNewDiscoveryElements({
            graph,
            sceneId: newSceneId,
            observation: afterObs,
            viewportWidth: deviceProfile.viewportWidth,
            viewportHeight: deviceProfile.viewportHeight,
          });
        }
      }

      await writeFile(
        join(actionDir, "observation.json"),
        JSON.stringify(
          { before: beforeObs, after: afterObs, sceneChanged },
          null,
          2,
        ),
        "utf8",
      );
      // One target, one action, one observed transition. Never enumerate the
      // rest of this page and never continue into the next page implicitly.
      break;
    }
  }

  if (
    expectedSceneId &&
    !agentUsed &&
    !discoveredTransitions.some(
      (transition) => transition.targetSceneId === expectedSceneId,
    )
  ) {
    const agentRecovery = await diagnoseAndRecoverStableDiscovery({
      graph,
      goal,
      expectedSceneId,
      startSceneId,
      focusElementId,
      observation: currentObservation,
      udid,
      outputDir,
      deviceProfile: {
        viewportWidth: deviceProfile.viewportWidth,
        viewportHeight: deviceProfile.viewportHeight,
      },
      agentCwd: resolve(args.agentCwd?.trim() || DEFAULT_AGENT_CWD),
      model: args.model,
      agentTimeoutMs: Math.max(
        1_000,
        args.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      ),
      maximumSteps: Math.max(
        0,
        Math.min(
          4,
          args.maxAgentRecoverySteps ?? DEFAULT_MAX_AGENT_RECOVERY_STEPS,
        ),
      ),
      minimumConfidence: Math.min(
        1,
        Math.max(
          0,
          args.minimumAgentConfidence ?? DEFAULT_MINIMUM_AGENT_CONFIDENCE,
        ),
      ),
      agentRunner: args.agentRunner,
    });
    agentUsed = agentRecovery.agentUsed;
    agentDiagnosticPath = agentRecovery.diagnosticPath;
    agentFailureMessage = agentRecovery.atTarget
      ? undefined
      : agentRecovery.message;
    currentObservation = agentRecovery.observation;
    actionsExecuted += agentRecovery.actionsExecuted;
    agentConfirmedTarget = agentRecovery.atTarget;
    if (agentRecovery.atTarget) {
      discoveredTransitions.push(
        agentRecovery.transition ?? {
          ...(lastSuccessfulProbe ?? {
            sourceSceneId: startSceneId,
            sourceElementId: "agent.scene_recognition",
            actionType: "none",
            before: stability.observation,
            after: currentObservation,
            observationPath: agentDiagnosticPath,
          }),
          targetSceneId: expectedSceneId,
          revivesStaleTarget: true,
        },
      );
      scenesDiscovered += 1;
      elementsDiscovered += countNewDiscoveryElements({
        graph,
        sceneId: expectedSceneId,
        observation: currentObservation,
        viewportWidth: deviceProfile.viewportWidth,
        viewportHeight: deviceProfile.viewportHeight,
      });
      if (agentRecovery.transition?.actionType !== "none") {
        operatorsDiscovered += 1;
      }
    }
  }

  phase("Synthesize");
  log(
    `Synthesizing: ${scenesDiscovered} scenes, ${elementsDiscovered} elements, ${operatorsDiscovered} operators`,
  );
  log(`Total actions: ${actionsExecuted}`);
  const completionIssue = discoveryCompletionIssue({
    focusElementId,
    expectedSceneId,
    actionsExecuted,
    agentConfirmedTarget,
    observedSceneIds: discoveredTransitions.map(
      (transition) => transition.targetSceneId,
    ),
    agentFailureMessage,
    explicitStaleRecovery: Boolean(args.expectedSceneId),
  });
  if (completionIssue) {
    return discoveryFailure({
      outputDir,
      code: completionIssue.code,
      message: completionIssue.message,
      recoverable: true,
      evidencePaths: [
        discoveryPlanPath,
        ...(stabilityPath ? [stabilityPath] : []),
        ...(agentDiagnosticPath ? [agentDiagnosticPath] : []),
      ],
      stabilityPath,
      agentUsed,
      agentDiagnosticPath,
    });
  }

  let patchPath: string | undefined;
  let graphUpdated = false;
  if (
    scenesDiscovered > 0 ||
    elementsDiscovered > 0 ||
    operatorsDiscovered > 0
  ) {
    try {
      const patch = buildDiscoveryPatch({
        graph,
        transitions: discoveredTransitions,
        deviceProfileId: deviceProfile.profileId,
        viewportWidth: deviceProfile.viewportWidth,
        viewportHeight: deviceProfile.viewportHeight,
      });
      if (patchHasChanges(patch)) {
        patchPath = join(outputDir, "graph-patch.json");
        await writeFile(patchPath, JSON.stringify(patch, null, 2), "utf8");
        const applied = await applyAndSave(graphPath, patch);
        graphUpdated = applied.success;
        if (applied.success) {
          log(`Graph updated to revision ${applied.newRevision}`);
        } else {
          log(
            `Graph patch rejected: ${[...applied.conflicts, ...applied.rejected].join("; ")}`,
          );
        }
      } else {
        log(
          "No evidence-backed Graph entities were synthesized; revision unchanged.",
        );
      }
    } catch (err) {
      log(
        `Patch synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  phase("Output");
  const totalDurationMs = Date.now() - startedAt;

  const result: AppGraphDiscoveryResult = {
    success: true,
    mode: "discovery",
    planOnly: false,
    outputDir,
    graphPath,
    discoveryPlanPath,
    discoveryRequestPath: requestPath,
    startSceneId,
    scenesDiscovered,
    elementsDiscovered,
    operatorsDiscovered,
    actionsExecuted,
    visibilityActionsExecuted,
    totalDurationMs,
    patchPath,
    graphRevision: graph.revision + (graphUpdated ? 1 : 0),
    graphUpdated,
    evidencePaths: [
      ...discoveryPlan.evidencePaths,
      discoveryPlanPath,
      ...(patchPath ? [patchPath] : []),
      ...(stabilityPath ? [stabilityPath] : []),
      ...(agentDiagnosticPath ? [agentDiagnosticPath] : []),
      ...visibilitySearchPaths,
    ],
    stabilityPath,
    agentUsed,
    agentDiagnosticPath,
    focusElementId,
    focusElementTitle: discoveryPlan.candidates[0]?.title,
    expectedSceneId,
    observedSceneIds: discoveredTransitions.map(
      (transition) => transition.targetSceneId,
    ),
  };

  const resultPath = join(outputDir, "result.json");
  await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");

  return result;
}

async function resetApp(
  udid: string,
  bundleId: string,
  outputDir: string,
): Promise<void> {
  const result = await runCommand(
    buildStrictRestartCommand(udid, bundleId),
    process.cwd(),
  );
  if (result.exitCode !== 0) {
    throw new Error(`Strict devicectl restart failed: ${result.stderr}`);
  }
  const proof = parseStrictRestartResult(result.stdout);
  await writeFile(
    join(outputDir, "strict-restart-proof.json"),
    JSON.stringify(proof, null, 2),
    "utf8",
  );
  await Bun.sleep(2500);
}

async function captureObservation(
  udid: string,
  outputDir: string,
  prefix: string,
  sceneId: string,
): Promise<DiscoveryObservation> {
  await mkdir(outputDir, { recursive: true });

  const screenshotPath = join(outputDir, `${prefix}-screenshot.png`);
  const uiDumpPath = join(outputDir, `${prefix}-ui-dump.json`);
  const foregroundPath = join(outputDir, `${prefix}-foreground.json`);

  const screenshotCmd = buildMobilecliScreenshotCommand(udid, screenshotPath);
  await runDiscoveryCaptureCommand(screenshotCmd);

  const uiDumpCmd = buildMobilecliUiDumpCommand(udid);
  const dumpResult = await runDiscoveryCaptureCommand(uiDumpCmd);
  await writeFile(uiDumpPath, dumpResult.stdout, "utf8");
  const foregroundResult = await runDiscoveryCaptureCommand(
    buildMobilecliForegroundCommand(udid),
    runCommand,
    3,
    true,
  );
  const foregroundBundleId = foregroundResult.stdout.trim();
  await writeFile(
    foregroundPath,
    JSON.stringify({ foregroundBundleId }, null, 2),
    "utf8",
  );

  let uiElements: UiElement[] = [];
  try {
    uiElements = parseUiDump(dumpResult.stdout);
  } catch {
    log("UI dump parse failed.");
  }

  const elements: DiscoveryElement[] = uiElements
    .filter(
      (el): el is UiElement & { bounds: NonNullable<UiElement["bounds"]> } => {
        return !!el.bounds && el.bounds.width > 0 && el.bounds.height > 0;
      },
    )
    .filter((el) => {
      const label = (el.label ?? "").toLowerCase();
      return !SKIP_LABELS.has(label) && !label.includes("system");
    })
    .map((el) => ({
      elementId: sanitizeId(
        el.accessibilityId ?? el.label ?? `el-${el.bounds!.x}-${el.bounds!.y}`,
      ),
      accessibilityId: el.accessibilityId ?? "",
      label: el.label ?? "",
      text: el.text ?? "",
      value: el.value ?? "",
      role: el.role ?? "",
      x: el.bounds!.x,
      y: el.bounds!.y,
      width: el.bounds!.width,
      height: el.bounds!.height,
    }));

  return {
    sceneId,
    screenshotPath,
    uiDumpPath,
    foregroundPath,
    foregroundBundleId,
    elements,
    uiElements,
    timestamp: new Date().toISOString(),
  };
}

export async function waitForStableDiscoveryObservation(options: {
  readonly udid: string;
  readonly outputDir: string;
  readonly prefix: string;
  readonly sceneId: string;
  readonly previousObservation?: DiscoveryObservation;
  readonly requireChangeFromPrevious?: boolean;
  readonly maximumSamples?: number;
  readonly requiredConsecutiveMatches?: number;
  readonly pollMs?: number;
  readonly capture?: (sampleIndex: number) => Promise<DiscoveryObservation>;
  readonly sleep?: (durationMs: number) => Promise<void>;
}): Promise<StableObservationResult<DiscoveryObservation>> {
  return waitForStableObservation({
    previousObservation: options.previousObservation,
    requireChangeFromPrevious:
      options.requireChangeFromPrevious ?? Boolean(options.previousObservation),
    capture:
      options.capture ??
      ((sampleIndex) =>
        captureObservation(
          options.udid,
          options.outputDir,
          `${options.prefix}-${String(sampleIndex).padStart(2, "0")}`,
          options.sceneId,
        )),
    describe: discoveryStabilityObservation,
    acceptStable: discoveryObservationReady,
    maximumSamples: options.maximumSamples ?? MAX_STABILITY_SAMPLES,
    requiredConsecutiveMatches:
      options.requiredConsecutiveMatches ?? REQUIRED_STABLE_SAMPLES,
    pollMs: options.pollMs ?? STABILITY_POLL_MS,
    sleep: options.sleep,
  });
}

interface DiscoveryAgentDiagnosticEntry {
  readonly attempt: number;
  readonly currentSceneId?: string;
  readonly decision?: RuntimeSceneAgentDecision;
  readonly evaluation?: RuntimeSceneAgentEvaluation;
  readonly command?: readonly string[];
  readonly stableAfterAction?: boolean;
  readonly error?: string;
}

interface DiscoveryAgentRecoveryResult {
  readonly agentUsed: boolean;
  readonly atTarget: boolean;
  readonly actionsExecuted: number;
  readonly observation: DiscoveryObservation;
  readonly diagnosticPath: string;
  readonly finalDecision?: RuntimeSceneAgentDecision;
  readonly message: string;
  readonly transition?: DiscoveredTransition;
}

export async function diagnoseAndRecoverStableDiscovery(options: {
  readonly graph: AppGraph;
  readonly goal: string;
  readonly expectedSceneId: string;
  readonly startSceneId: string;
  readonly focusElementId: string;
  readonly observation: DiscoveryObservation;
  readonly udid: string;
  readonly outputDir: string;
  readonly deviceProfile: {
    readonly viewportWidth: number;
    readonly viewportHeight: number;
  };
  readonly agentCwd: string;
  readonly model?: string;
  readonly agentTimeoutMs: number;
  readonly maximumSteps: number;
  readonly minimumConfidence: number;
  readonly agentRunner?: AppGraphDiscoveryInput["agentRunner"];
}): Promise<DiscoveryAgentRecoveryResult> {
  const diagnosticPath = join(options.outputDir, "agent-scene-recovery.json");
  const expectedScene = options.graph.scenes[options.expectedSceneId];
  const historicalTarget = Object.values(
    options.graph.scenes[options.startSceneId]?.elements ?? {},
  ).find((element) => element.elementId === options.focusElementId);
  if (!expectedScene || options.maximumSteps === 0) {
    const message = !expectedScene
      ? `Expected Scene does not exist: ${options.expectedSceneId}.`
      : "Agent recovery is disabled by the current step budget.";
    await writeFile(
      diagnosticPath,
      JSON.stringify({ agentUsed: false, message, attempts: [] }, null, 2),
      "utf8",
    );
    return {
      agentUsed: false,
      atTarget: false,
      actionsExecuted: 0,
      observation: options.observation,
      diagnosticPath,
      message,
    };
  }

  let observation = options.observation;
  let actionsExecuted = 0;
  let finalDecision: RuntimeSceneAgentDecision | undefined;
  let message = "Agent found no safe high-confidence recovery action.";
  let transition: DiscoveredTransition | undefined;
  const diagnostics: DiscoveryAgentDiagnosticEntry[] = [];
  const previousActions: Array<{
    candidateId: string;
    actionType: RuntimeRecoveryActionType;
  }> = [];
  for (let attempt = 1; attempt <= options.maximumSteps; attempt += 1) {
    const runtimeObservation = discoveryRuntimeObservation(observation);
    const currentMatch = classifyRuntimeScene(
      options.graph,
      runtimeObservation,
    );
    try {
      log(
        `Agent recovery ${attempt}/${options.maximumSteps}: inspecting the stable page for ${options.expectedSceneId}.`,
      );
      let evaluation: RuntimeSceneAgentEvaluation | undefined;
      const choice = await decideSceneRecoveryWithAgent({
        goal: options.goal,
        expectedScene,
        currentSceneId: currentMatch?.sceneId ?? options.startSceneId,
        observation: runtimeObservation,
        viewportWidth: options.deviceProfile.viewportWidth,
        viewportHeight: options.deviceProfile.viewportHeight,
        previousActions,
        cwd: options.agentCwd,
        model: options.model,
        timeoutMs: options.agentTimeoutMs,
        minimumConfidence: options.minimumConfidence,
        agentRunner: options.agentRunner,
        historicalTarget,
        onEvaluation: (value) => {
          evaluation = value;
        },
      });
      if (!choice) {
        finalDecision = evaluation?.decision;
        message =
          evaluation?.rejectionReason ?? evaluation?.decision.reason ?? message;
        diagnostics.push({
          attempt,
          currentSceneId: currentMatch?.sceneId,
          decision: evaluation?.decision,
          evaluation,
          error: message,
        });
        break;
      }
      finalDecision = choice.decision;
      if (choice.decision.status === "at_target") {
        message = choice.decision.reason;
        diagnostics.push({
          attempt,
          currentSceneId: currentMatch?.sceneId,
          decision: choice.decision,
          evaluation,
        });
        break;
      }
      if (
        choice.decision.status === "blocked" ||
        !choice.candidate ||
        choice.decision.actionType === "none"
      ) {
        message = choice.decision.reason;
        diagnostics.push({
          attempt,
          currentSceneId: currentMatch?.sceneId,
          decision: choice.decision,
          evaluation,
        });
        break;
      }

      const before = observation;
      const actionType = choice.decision.actionType;
      const command = buildRuntimeRecoveryCommand(
        options.udid,
        choice.candidate,
        actionType,
      );
      const result = await runCommand(command, process.cwd());
      if (result.exitCode !== 0) {
        message =
          result.stderr.slice(0, 500) || "Agent recovery action failed.";
        diagnostics.push({
          attempt,
          currentSceneId: currentMatch?.sceneId,
          decision: choice.decision,
          evaluation,
          command,
          error: message,
        });
        break;
      }
      actionsExecuted += 1;
      previousActions.push({
        candidateId: choice.candidate.candidateId,
        actionType,
      });
      const stable = await waitForStableDiscoveryObservation({
        udid: options.udid,
        outputDir: join(options.outputDir, "agent-scene-recovery"),
        prefix: `attempt-${String(attempt).padStart(2, "0")}`,
        sceneId: options.startSceneId,
        previousObservation: before,
      });
      observation = stable.observation;
      diagnostics.push({
        attempt,
        currentSceneId: currentMatch?.sceneId,
        decision: choice.decision,
        evaluation,
        command,
        stableAfterAction: stable.stable,
        error: stable.stable
          ? undefined
          : "The page did not stabilize after the Agent recovery action.",
      });
      if (!stable.stable) {
        message = "The page did not stabilize after the Agent recovery action.";
        break;
      }
      transition = {
        sourceSceneId: currentMatch?.sceneId ?? options.startSceneId,
        sourceElementId:
          resolveGraphElementIdForRuntimeCandidate(
            options.graph,
            currentMatch?.sceneId ?? options.startSceneId,
            choice.candidate,
          ) ?? "agent.scene_recovery",
        actionType,
        targetSceneId: options.expectedSceneId,
        before,
        after: observation,
        observationPath: diagnosticPath,
        revivesStaleTarget: true,
      };
      if (discoveryObservationMatchesScene(observation, expectedScene)) {
        finalDecision = {
          status: "at_target",
          candidateId: "",
          actionType: "none",
          confidence: 1,
          reason: `The Agent action exposed anchors for ${options.expectedSceneId}.`,
        };
        message = finalDecision.reason;
        break;
      }
      message = `Agent action completed but ${options.expectedSceneId} is not yet verified.`;
    } catch (error) {
      message = `Agent Scene recovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      diagnostics.push({ attempt, error: message });
      break;
    }
  }

  const atTarget = finalDecision?.status === "at_target";
  await writeFile(
    diagnosticPath,
    JSON.stringify(
      {
        agentUsed: true,
        expectedSceneId: options.expectedSceneId,
        atTarget,
        actionsExecuted,
        finalDecision,
        message,
        attempts: diagnostics,
      },
      null,
      2,
    ),
    "utf8",
  );
  return {
    agentUsed: true,
    atTarget,
    actionsExecuted,
    observation,
    diagnosticPath,
    finalDecision,
    message,
    transition: atTarget ? transition : undefined,
  };
}

function discoveryRuntimeObservation(
  observation: DiscoveryObservation,
): RuntimeObservation {
  return {
    screenshotPath: observation.screenshotPath,
    uiDumpPath: observation.uiDumpPath,
    foregroundPath: observation.foregroundPath ?? observation.uiDumpPath,
    foregroundBundleId: observation.foregroundBundleId ?? DEFAULT_BUNDLE_ID,
    uiElements: observation.uiElements ?? discoveryElementsAsUi(observation),
  };
}

function resolveGraphElementIdForRuntimeCandidate(
  graph: AppGraph,
  sceneId: string,
  candidate: RuntimeCandidate,
): string | undefined {
  const scene = graph.scenes[sceneId];
  if (!scene) return undefined;
  const candidateValues = [
    candidate.accessibilityId,
    candidate.label,
    candidate.text,
    candidate.value,
    candidate.title,
  ]
    .map(normalizeDiscoveryText)
    .filter(Boolean);
  const matches = Object.values(scene.elements).filter((element) => {
    const elementValues = [
      element.title,
      ...element.selectors
        .filter((selector) => selector.type !== "role")
        .map((selector) => selector.value),
    ]
      .map(normalizeDiscoveryText)
      .filter(Boolean);
    return elementValues.some((value) => candidateValues.includes(value));
  });
  return matches.length === 1 ? matches[0]?.elementId : undefined;
}

function discoveryStabilityObservation(observation: DiscoveryObservation) {
  return {
    screenshotPath: observation.screenshotPath,
    uiDumpPath: observation.uiDumpPath,
    uiElements: observation.uiElements ?? discoveryElementsAsUi(observation),
  };
}

function discoveryObservationReady(observation: DiscoveryObservation): boolean {
  const text = observation.elements
    .flatMap((element) => [element.label, element.text, element.value])
    .join(" ");
  return !/加载中|正在加载|loading|请稍候|please wait/i.test(text);
}

function discoveryElementsAsUi(
  observation: DiscoveryObservation,
): readonly UiElement[] {
  return observation.elements.map((element) => ({
    role: element.role,
    accessibilityId: element.accessibilityId,
    label: element.label,
    text: element.text,
    value: element.value,
    bounds: {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    },
  }));
}

export async function runDiscoveryCaptureCommand(
  command: readonly string[],
  commandRunner: (
    command: readonly string[],
    cwd?: string,
  ) => Promise<CommandResult> = runCommand,
  maximumAttempts = 3,
  requireOutput = false,
): Promise<CommandResult> {
  let lastResult: CommandResult | undefined;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    lastResult = await commandRunner(command, process.cwd());
    if (
      lastResult.exitCode === 0 &&
      (!requireOutput || Boolean(lastResult.stdout.trim()))
    ) {
      return lastResult;
    }
    if (attempt < maximumAttempts) await Bun.sleep(250);
  }
  throw new Error(
    `Discovery capture failed after ${maximumAttempts} attempts: ${lastResult?.stderr || command.join(" ")}`,
  );
}

async function executeAction(
  udid: string,
  actionType: string,
  element: DiscoveryElement,
): Promise<boolean> {
  const command = buildDiscoveryActionCommand(udid, actionType, element);
  const result = await runCommand(command, process.cwd());
  return result.exitCode === 0;
}

export function buildDiscoveryActionCommand(
  udid: string,
  actionType: string,
  element: DiscoveryElement,
): string[] {
  const cx = Math.round(element.x + element.width / 2);
  const cy = Math.round(element.y + element.height / 2);
  if (actionType === "swipe_left") {
    return [
      "mobilecli",
      "io",
      "swipe",
      "--device",
      udid,
      `${Math.round(element.x + element.width * 0.8)},${cy},${Math.round(element.x + element.width * 0.2)},${cy}`,
    ];
  }
  if (actionType === "long_press") {
    return [
      "mobilecli",
      "io",
      "longpress",
      "--device",
      udid,
      `${cx},${cy}`,
      "--duration",
      "800",
    ];
  }
  return ["mobilecli", "io", "tap", "--device", udid, `${cx},${cy}`];
}

function detectSceneChange(
  before: DiscoveryObservation,
  after: DiscoveryObservation,
): boolean {
  const beforeIds = new Set(before.elements.map((e) => e.elementId));
  const afterIds = new Set(after.elements.map((e) => e.elementId));

  const newElements = after.elements.filter(
    (e) => !beforeIds.has(e.elementId),
  ).length;
  const removedElements = before.elements.filter(
    (e) => !afterIds.has(e.elementId),
  ).length;
  const totalChange = newElements + removedElements;
  const threshold = Math.max(5, before.elements.length * 0.3);

  return totalChange > threshold;
}

function findNewSceneId(
  before: DiscoveryObservation,
  after: DiscoveryObservation,
): string | null {
  if (after.elements.length === 0) return null;

  const uniqueLabels = new Set(
    after.elements.map((e) => e.label).filter(Boolean),
  );
  if (uniqueLabels.size === 0) return null;

  const sorted = [...uniqueLabels].sort((a, b) => b.length - a.length);
  return sanitizeId(sorted[0]!);
}

function sanitizeId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 64);
}

export function resolveDiscoveryElement(
  elements: readonly DiscoveryElement[],
  graphElementId: string,
  selectors: readonly { readonly type: string; readonly value: string }[],
): DiscoveryElement | null {
  const direct = elements.filter(
    (element) => element.elementId === graphElementId,
  );
  if (direct.length === 1) return direct[0]!;
  const priority = [
    "accessibilityIdentifier",
    "label",
    "text",
    "value",
    "role",
  ];
  for (const type of priority) {
    for (const selector of selectors.filter((entry) => entry.type === type)) {
      const expected = normalizeDiscoveryText(selector.value);
      const matches = elements.filter((element) =>
        discoveryElementValues(element, type).some(
          (value) => normalizeDiscoveryText(value) === expected,
        ),
      );
      if (matches.length === 1) return matches[0]!;
      const preferred = selectOverlappingDiscoveryTarget(matches);
      if (preferred) return preferred;
    }
  }
  return null;
}

export function resolveVisibleDiscoveryElement(
  elements: readonly DiscoveryElement[],
  graphElementId: string,
  selectors: readonly { readonly type: string; readonly value: string }[],
  viewportWidth: number,
  viewportHeight: number,
  minimumCenterY = 0,
  maximumCenterY = viewportHeight,
): DiscoveryElement | null {
  const matches = discoverySelectorMatches(elements, graphElementId, selectors);
  const visible = matches.filter((element) =>
    discoveryElementWithinViewport(
      element,
      viewportWidth,
      viewportHeight,
      minimumCenterY,
      maximumCenterY,
    ),
  );
  const onlyTopCoordinateShadows =
    visible.length > 0 &&
    visible.every(
      (element) => element.y + element.height / 2 < viewportHeight * 0.2,
    ) &&
    matches.some((element) => element.y + element.height / 2 >= viewportHeight);
  if (onlyTopCoordinateShadows) return null;
  if (visible.length === 1) return visible[0]!;
  return selectOverlappingDiscoveryTarget(visible);
}

function discoverySelectorMatches(
  elements: readonly DiscoveryElement[],
  graphElementId: string,
  selectors: readonly { readonly type: string; readonly value: string }[],
): DiscoveryElement[] {
  const direct = elements.filter(
    (element) => element.elementId === graphElementId,
  );
  if (direct.length > 0) return direct;
  const priority = [
    "accessibilityIdentifier",
    "label",
    "text",
    "value",
    "role",
  ];
  for (const type of priority) {
    for (const selector of selectors.filter((entry) => entry.type === type)) {
      const expected = normalizeDiscoveryText(selector.value);
      const matches = elements.filter((element) =>
        discoveryElementValues(element, type).some(
          (value) => normalizeDiscoveryText(value) === expected,
        ),
      );
      if (matches.length > 0) return matches;
    }
  }
  return [];
}

function selectOverlappingDiscoveryTarget(
  matches: readonly DiscoveryElement[],
): DiscoveryElement | null {
  if (matches.length < 2) return null;
  const sorted = [...matches].sort(
    (left, right) => right.width * right.height - left.width * left.height,
  );
  const container = sorted[0]!;
  const overlapping = sorted.every((candidate) =>
    discoveryBoundsOverlap(container, candidate),
  );
  return overlapping ? container : null;
}

function discoveryBoundsOverlap(
  left: DiscoveryElement,
  right: DiscoveryElement,
): boolean {
  const overlapWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  );
  return overlapWidth * overlapHeight > 0;
}

function discoveryElementValues(
  element: DiscoveryElement,
  selectorType: string,
): readonly string[] {
  if (selectorType === "accessibilityIdentifier") {
    return [element.accessibilityId];
  }
  if (selectorType === "label") return [element.label];
  if (selectorType === "text")
    return [element.text, element.label, element.value];
  if (selectorType === "value") return [element.value];
  if (selectorType === "role") return [element.role];
  return [];
}

function normalizeDiscoveryText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

interface DiscoveredTransition {
  readonly sourceSceneId: string;
  readonly sourceElementId: string;
  readonly actionType: string;
  readonly targetSceneId: string;
  readonly before: DiscoveryObservation;
  readonly after: DiscoveryObservation;
  readonly observationPath: string;
  readonly revivesStaleTarget?: boolean;
}

export function buildDiscoveryPatch(options: {
  graph: AppGraph;
  transitions: readonly DiscoveredTransition[];
  deviceProfileId: string;
  viewportWidth: number;
  viewportHeight: number;
}): GraphPatch {
  const scenes: NonNullable<GraphPatch["scenes"]> = {};
  const operators: NonNullable<GraphPatch["operators"]> = {};
  const evidencePaths = new Set<string>();
  for (const transition of options.transitions) {
    evidencePaths.add(transition.observationPath);
    evidencePaths.add(transition.after.screenshotPath);
    evidencePaths.add(transition.after.uiDumpPath);
    const existingTargetScene = options.graph.scenes[transition.targetSceneId];
    const sourceScene = options.graph.scenes[transition.sourceSceneId];
    const sourceElement = sourceScene?.elements[transition.sourceElementId];
    if (!existingTargetScene) {
      scenes[transition.targetSceneId] = {
        sceneId: transition.targetSceneId,
        parentSceneId: null,
        status: "observed",
        title: discoverySceneTitle(transition.after, transition.targetSceneId),
        aliases: [],
        visualTextAnchors: discoveryAnchors(transition.after),
        referenceAssets: [
          {
            screenshot: transition.after.screenshotPath,
            uiDump: transition.after.uiDumpPath,
          },
        ],
        elements: Object.fromEntries(
          transition.after.elements.map((element) => {
            const elementId = discoveredElementId(
              transition.targetSceneId,
              element,
            );
            return [
              elementId,
              {
                elementId,
                title:
                  element.label ||
                  element.text ||
                  element.accessibilityId ||
                  elementId,
                semanticRole: element.role || "Unknown",
                status: "observed",
                selectors: discoverySelectors(element),
                bindings: {
                  [options.deviceProfileId]: {
                    deviceProfileId: options.deviceProfileId,
                    normalizedPoint: {
                      x: clamp01(
                        (element.x + element.width / 2) / options.viewportWidth,
                      ),
                      y: clamp01(
                        (element.y + element.height / 2) /
                          options.viewportHeight,
                      ),
                    },
                    source: "ui_dump",
                    status: "candidate",
                    observedAt: transition.after.timestamp,
                  },
                },
              },
            ];
          }),
        ),
      };
    } else if (
      existingTargetScene.status === "stale" &&
      transition.revivesStaleTarget
    ) {
      scenes[transition.targetSceneId] = {
        ...existingTargetScene,
        sceneId: transition.targetSceneId,
        status: "candidate",
        expiredVersion: undefined,
        referenceAssets: [
          ...existingTargetScene.referenceAssets,
          {
            screenshot: transition.after.screenshotPath,
            uiDump: transition.after.uiDumpPath,
          },
        ],
      };
      if (sourceScene && sourceElement?.status === "stale") {
        scenes[sourceScene.sceneId] = {
          ...sourceScene,
          sceneId: sourceScene.sceneId,
          elements: {
            ...sourceScene.elements,
            [sourceElement.elementId]: {
              ...sourceElement,
              status: "candidate",
              expiredVersion: undefined,
            },
          },
        };
      }
    } else {
      const mergedElements = { ...existingTargetScene.elements };
      let addedElement = false;
      for (const element of newDiscoveryElements({
        graph: options.graph,
        sceneId: transition.targetSceneId,
        observation: transition.after,
        viewportWidth: options.viewportWidth,
        viewportHeight: options.viewportHeight,
      })) {
        const elementId = uniqueDiscoveredElementId(
          transition.targetSceneId,
          element,
          mergedElements,
        );
        mergedElements[elementId] = discoveryGraphElement(
          elementId,
          element,
          options.deviceProfileId,
          options.viewportWidth,
          options.viewportHeight,
          transition.after.timestamp,
        );
        addedElement = true;
      }
      if (addedElement) {
        scenes[transition.targetSceneId] = {
          ...existingTargetScene,
          sceneId: existingTargetScene.sceneId,
          elements: mergedElements,
          referenceAssets: [
            ...existingTargetScene.referenceAssets,
            {
              screenshot: transition.after.screenshotPath,
              uiDump: transition.after.uiDumpPath,
            },
          ],
        };
      }
    }
    if (transition.actionType === "none" || !sourceElement) continue;
    const existingEquivalent = Object.values(options.graph.operators).find(
      (operator) =>
        operator.fromSceneId === transition.sourceSceneId &&
        operator.toSceneId === transition.targetSceneId &&
        operator.operation.elementId === transition.sourceElementId &&
        discoveryOperationType(transition.actionType) ===
          operator.operation.type,
    );
    if (existingEquivalent) {
      if (existingEquivalent.status === "stale") {
        operators[existingEquivalent.operatorId] = {
          ...existingEquivalent,
          status: "candidate",
          executionStats: {
            ...existingEquivalent.executionStats,
            pass: existingEquivalent.executionStats.pass + 1,
            lastExecutedAt: transition.after.timestamp,
          },
        };
      }
      continue;
    }
    const operatorId = discoveredOperatorId(transition);
    operators[operatorId] = {
      operatorId,
      fromSceneId: transition.sourceSceneId,
      toSceneId: transition.targetSceneId,
      operation: discoveryOperation(transition),
      effects: [
        {
          type: "scene_change",
          key: "scene.current",
          value: transition.targetSceneId,
        },
      ],
      status: "candidate",
      executionStats: { pass: 0, fail: 0 },
      risk: "navigation",
      settleMs: SETTLE_MS,
    };
  }
  return {
    schemaVersion: "ios-ui-graph-patch/v2",
    graphId: options.graph.graphId,
    baseRevision: options.graph.revision,
    source: "discovery",
    scenes: Object.keys(scenes).length ? scenes : undefined,
    operators: Object.keys(operators).length ? operators : undefined,
    evidencePaths: [...evidencePaths],
  };
}

function discoveryGraphElement(
  elementId: string,
  element: DiscoveryElement,
  deviceProfileId: string,
  viewportWidth: number,
  viewportHeight: number,
  observedAt: string,
) {
  return {
    elementId,
    title:
      element.label || element.text || element.accessibilityId || elementId,
    semanticRole: element.role || "Unknown",
    status: "candidate" as const,
    selectors: discoverySelectors(element),
    bindings: {
      [deviceProfileId]: {
        deviceProfileId,
        normalizedPoint: {
          x: clamp01((element.x + element.width / 2) / viewportWidth),
          y: clamp01((element.y + element.height / 2) / viewportHeight),
        },
        source: "ui_dump" as const,
        status: "candidate" as const,
        observedAt,
      },
    },
  };
}

function countNewDiscoveryElements(options: {
  readonly graph: AppGraph;
  readonly sceneId: string;
  readonly observation: DiscoveryObservation;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): number {
  return newDiscoveryElements(options).length;
}

function newDiscoveryElements(options: {
  readonly graph: AppGraph;
  readonly sceneId: string;
  readonly observation: DiscoveryObservation;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): DiscoveryElement[] {
  const candidates = dedupeDiscoveryElementsForGraph(
    options.observation.elements.filter(
      (element) =>
        discoveryElementWithinViewport(
          element,
          options.viewportWidth,
          options.viewportHeight,
        ) && !isSystemOrSceneChromeElement(element, options.viewportHeight),
    ),
  );
  const scene = options.graph.scenes[options.sceneId];
  if (!scene) return candidates;
  return candidates.filter(
    (element) =>
      !Object.values(scene.elements).some((existing) =>
        graphElementMatchesDiscoveryElement(existing, element),
      ),
  );
}

function discoveryElementWithinViewport(
  element: DiscoveryElement,
  viewportWidth: number,
  viewportHeight: number,
  minimumCenterY = 0,
  maximumCenterY = viewportHeight,
): boolean {
  const centerX = element.x + element.width / 2;
  const centerY = element.y + element.height / 2;
  return (
    centerX >= 0 &&
    centerX < viewportWidth &&
    centerY >= minimumCenterY &&
    centerY < maximumCenterY
  );
}

function isSystemOrSceneChromeElement(
  element: DiscoveryElement,
  viewportHeight: number,
): boolean {
  if (element.y < Math.min(44, viewportHeight * 0.06)) return true;
  if (/^(\d{1,2}:\d{2}|勿扰模式|moon\.fill)$/i.test(element.label)) {
    return true;
  }
  return element.role === "StaticText" && element.y < viewportHeight * 0.12;
}

function dedupeDiscoveryElementsForGraph(
  elements: readonly DiscoveryElement[],
): DiscoveryElement[] {
  const grouped = new Map<string, DiscoveryElement>();
  for (const element of elements) {
    const key = [
      element.role,
      element.accessibilityId,
      element.label,
      element.text,
      element.value,
    ]
      .map(normalizeDiscoveryText)
      .join("|");
    const existing = grouped.get(key);
    if (
      !existing ||
      element.width * element.height > existing.width * existing.height
    ) {
      grouped.set(key, element);
    }
  }
  return [...grouped.values()];
}

function graphElementMatchesDiscoveryElement(
  existing: Scene["elements"][string],
  observed: DiscoveryElement,
): boolean {
  const existingValues = [
    existing.title,
    ...existing.selectors
      .filter((selector) => selector.type !== "role")
      .map((selector) => selector.value),
  ]
    .map(normalizeDiscoveryText)
    .filter(Boolean);
  const observedValues = [
    observed.accessibilityId,
    observed.label,
    observed.text,
    observed.value,
  ]
    .map(normalizeDiscoveryText)
    .filter(Boolean);
  return existingValues.some((value) => observedValues.includes(value));
}

function uniqueDiscoveredElementId(
  sceneId: string,
  element: DiscoveryElement,
  existing: Scene["elements"],
): string {
  const base = discoveredElementId(sceneId, element);
  if (!existing[base]) return base;
  let suffix = 2;
  while (existing[`${base}-${suffix}`]) suffix += 1;
  return `${base}-${suffix}`;
}

function discoveryOperation(transition: DiscoveredTransition) {
  const type = discoveryOperationType(transition.actionType);
  if (type === "long_press") {
    return {
      type,
      elementId: transition.sourceElementId,
      durationMs: 800,
    } as const;
  }
  if (type === "swipe") {
    const element = transition.before.elements.find(
      (candidate) =>
        discoveredElementId(transition.sourceSceneId, candidate) ===
          transition.sourceElementId ||
        candidate.elementId === transition.sourceElementId,
    );
    const y = Math.round(element ? element.y + element.height / 2 : 400);
    return {
      type,
      elementId: transition.sourceElementId,
      from: {
        x: Math.round(element ? element.x + element.width * 0.8 : 300),
        y,
      },
      to: {
        x: Math.round(element ? element.x + element.width * 0.2 : 100),
        y,
      },
    } as const;
  }
  return { type, elementId: transition.sourceElementId } as const;
}

function discoveryOperationType(
  actionType: string,
): "tap" | "long_press" | "swipe" {
  if (actionType === "long_press") return "long_press";
  if (actionType === "swipe_left") return "swipe";
  return "tap";
}

function discoveredOperatorId(transition: DiscoveredTransition): string {
  return [
    "discovery",
    transition.sourceSceneId,
    transition.sourceElementId,
    transition.actionType,
    transition.targetSceneId,
  ]
    .map(sanitizeId)
    .join(".")
    .slice(0, 180);
}

function discoveredElementId(
  sceneId: string,
  element: DiscoveryElement,
): string {
  return `${sceneId}.${sanitizeId(
    element.accessibilityId ||
      element.label ||
      element.text ||
      element.elementId ||
      "element",
  )}`.slice(0, 180);
}

function discoverySceneTitle(
  observation: DiscoveryObservation,
  fallback: string,
): string {
  return (
    observation.elements
      .flatMap((element) => [element.label, element.text])
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)[0] ?? fallback
  );
}

function discoveryAnchors(
  observation: DiscoveryObservation,
): readonly string[] {
  return [
    ...new Set(
      observation.elements
        .flatMap((element) => [element.label, element.text])
        .map((value) => value.trim())
        .filter((value) => value.length >= 2 && value.length <= 40),
    ),
  ].slice(0, 6);
}

function discoveryObservationMatchesScene(
  observation: DiscoveryObservation,
  scene: Scene,
): boolean {
  const observed = new Set(
    observation.elements
      .flatMap((element) => [
        element.accessibilityId,
        element.label,
        element.text,
        element.value,
      ])
      .map(normalizeDiscoveryText)
      .filter(Boolean),
  );
  const anchors = scene.visualTextAnchors
    .map(normalizeDiscoveryText)
    .filter(Boolean);
  const matchedAnchors = anchors.filter((anchor) =>
    [...observed].some(
      (value) => value.includes(anchor) || anchor.includes(value),
    ),
  );
  const nameMatched = [scene.title, ...scene.aliases]
    .map(normalizeDiscoveryText)
    .some((name) => observed.has(name));
  const confidence =
    (anchors.length ? matchedAnchors.length / anchors.length : 0) +
    (nameMatched ? 0.2 : 0);
  return confidence >= 0.6;
}

function discoverySelectors(element: DiscoveryElement) {
  const selectors: Array<{
    type: "accessibilityIdentifier" | "label" | "text" | "value" | "role";
    value: string;
  }> = [];
  if (element.accessibilityId) {
    selectors.push({
      type: "accessibilityIdentifier",
      value: element.accessibilityId,
    });
  }
  if (element.label) selectors.push({ type: "label", value: element.label });
  if (element.text) selectors.push({ type: "text", value: element.text });
  if (element.value) selectors.push({ type: "value", value: element.value });
  if (element.role) selectors.push({ type: "role", value: element.role });
  return selectors;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function buildDiscoveryPlan(options: {
  graph: AppGraph;
  goal: string;
  requestPath?: string;
  request?: AppGraphDiscoveryRequest;
  startSceneId: string;
  focusElementId?: string;
  allowStaleFocus?: boolean;
  expectedSceneId?: string;
  maxDepth: number;
  maxActions: number;
}): DiscoveryPlan {
  const scene = options.graph.scenes[options.startSceneId];
  if (!scene) {
    throw new Error(`Start Scene does not exist: ${options.startSceneId}.`);
  }
  if (!options.focusElementId) {
    throw new Error("Targeted Discovery requires a focus Element.");
  }
  if (!scene.elements[options.focusElementId]) {
    throw new Error(
      `Focus Element ${options.focusElementId} does not exist in ${scene.sceneId}.`,
    );
  }
  const elements = [scene.elements[options.focusElementId]!];
  const candidates = elements
    .filter(
      (element) =>
        (options.allowStaleFocus && element.status === "stale") ||
        !["stale", "blocked", "disabled"].includes(element.status),
    )
    .map((element) => {
      const operators = Object.values(options.graph.operators).filter(
        (operator) =>
          operator.fromSceneId === scene.sceneId &&
          operator.operation.elementId === element.elementId,
      );
      const allowedActions = new Set<"tap" | "long_press" | "swipe">();
      for (const operator of operators) {
        if (operator.operation.type === "tap") allowedActions.add("tap");
        if (operator.operation.type === "long_press") {
          allowedActions.add("long_press");
        }
        if (operator.operation.type === "swipe") allowedActions.add("swipe");
      }
      if (allowedActions.size === 0) {
        allowedActions.add("tap");
      }
      const preferredAction = discoveryActionForGoal(options.goal);
      const orderedActions = [...allowedActions].sort((left, right) =>
        left === preferredAction ? -1 : right === preferredAction ? 1 : 0,
      );
      return {
        elementId: element.elementId,
        title: element.title,
        semanticRole: element.semanticRole,
        status: element.status,
        selectors: element.selectors,
        operatorIds: operators.map((operator) => operator.operatorId),
        allowedActions: orderedActions,
      };
    });
  return {
    schemaVersion: "app-graph-discovery-plan/v1",
    graphId: options.graph.graphId,
    graphRevision: options.graph.revision,
    goal: options.goal,
    requestPath: options.requestPath,
    startSceneId: scene.sceneId,
    focusElementId: options.focusElementId,
    allowStaleFocus: options.allowStaleFocus,
    expectedSceneId: options.expectedSceneId,
    candidates,
    budgets: { maxDepth: options.maxDepth, maxActions: options.maxActions },
    evidencePaths: options.request?.evidencePaths ?? [],
  };
}

function discoveryActionForGoal(goal: string): "tap" | "long_press" | "swipe" {
  if (/长按|long[ _-]?press/i.test(goal)) return "long_press";
  if (/滑动|左滑|右滑|上滑|下滑|swipe|scroll/i.test(goal)) return "swipe";
  return "tap";
}

export function resolveDiscoveryExpectedSceneId(
  graph: AppGraph,
  startSceneId: string,
  focusElementId: string,
  goal: string,
): string | undefined {
  const candidates = Object.values(graph.operators)
    .filter(
      (operator) =>
        operator.fromSceneId === startSceneId &&
        operator.operation.elementId === focusElementId &&
        Boolean(operator.toSceneId) &&
        !["stale", "blocked", "disabled"].includes(operator.status),
    )
    .sort((left, right) => {
      const preferredAction = discoveryActionForGoal(goal);
      const leftPreferred =
        discoveryOperationType(preferredAction) === left.operation.type ? 1 : 0;
      const rightPreferred =
        discoveryOperationType(preferredAction) === right.operation.type
          ? 1
          : 0;
      return (
        rightPreferred - leftPreferred ||
        right.executionStats.pass - left.executionStats.pass ||
        left.operatorId.localeCompare(right.operatorId)
      );
    });
  const targetSceneIds = [
    ...new Set(
      candidates
        .map((operator) => operator.toSceneId)
        .filter((sceneId): sceneId is string => Boolean(sceneId)),
    ),
  ];
  return targetSceneIds.length === 1 ? targetSceneIds[0] : undefined;
}

export function discoveryCompletionIssue(options: {
  readonly focusElementId: string;
  readonly expectedSceneId?: string;
  readonly actionsExecuted: number;
  readonly agentConfirmedTarget: boolean;
  readonly observedSceneIds: readonly string[];
  readonly agentFailureMessage?: string;
  readonly explicitStaleRecovery: boolean;
}): { readonly code: string; readonly message: string } | null {
  if (options.actionsExecuted === 0 && !options.agentConfirmedTarget) {
    return {
      code: "focus_element_unresolved",
      message: `Focus Element ${options.focusElementId} was not resolved and no exploration action was executed.`,
    };
  }
  if (
    options.expectedSceneId &&
    !options.agentConfirmedTarget &&
    !options.observedSceneIds.includes(options.expectedSceneId)
  ) {
    return {
      code: options.explicitStaleRecovery
        ? "stale_scene_not_observed"
        : "target_scene_not_observed",
      message: options.agentFailureMessage
        ? `The page stabilized, but the selected Element did not reach expected Scene ${options.expectedSceneId}. Agent diagnosis: ${options.agentFailureMessage}`
        : `The page stabilized, but the selected Element did not reach expected Scene ${options.expectedSceneId}.`,
    };
  }
  return null;
}

export function validateDiscoveryRequest(
  request: AppGraphDiscoveryRequest,
  graph: AppGraph,
): { code: string; message: string; recoverable: boolean } | null {
  if (request.schemaVersion !== "app-graph-discovery-request/v1") {
    return {
      code: "unsupported_discovery_request",
      message: `Unsupported discovery request: ${String(request.schemaVersion)}.`,
      recoverable: false,
    };
  }
  if (request.graphIdentity?.graphId !== graph.graphId) {
    return {
      code: "discovery_graph_mismatch",
      message: "Discovery request belongs to a different Graph.",
      recoverable: false,
    };
  }
  if (request.graphIdentity.revision !== graph.revision) {
    return {
      code: "stale_discovery_request",
      message: `Discovery request revision ${request.graphIdentity.revision} does not match current revision ${graph.revision}.`,
      recoverable: true,
    };
  }
  return null;
}

function resolveDefaultEntrySceneId(graph: AppGraph): string {
  return (
    graph.resetStrategies.find(
      (strategy) => strategy.strategyId === graph.defaultResetStrategyId,
    )?.entrySceneId ?? "chat.detail"
  );
}

function patchHasChanges(patch: GraphPatch): boolean {
  return Boolean(
    Object.keys(patch.scenes ?? {}).length ||
    Object.keys(patch.operators ?? {}).length ||
    Object.keys(patch.tasks ?? {}).length,
  );
}

function discoveryFailure(options: {
  outputDir: string;
  code: string;
  message: string;
  recoverable: boolean;
  evidencePaths: readonly string[];
  stabilityPath?: string;
  agentUsed?: boolean;
  agentDiagnosticPath?: string;
  visibilityActionsExecuted?: number;
  focusElementId?: string;
  focusElementTitle?: string;
  expectedSceneId?: string;
}): AppGraphDiscoveryOutput {
  return {
    success: false,
    mode: "discovery_failure",
    outputDir: options.outputDir,
    code: options.code,
    message: options.message,
    recoverable: options.recoverable,
    evidencePaths: options.evidencePaths,
    stabilityPath: options.stabilityPath,
    agentUsed: options.agentUsed,
    agentDiagnosticPath: options.agentDiagnosticPath,
    visibilityActionsExecuted: options.visibilityActionsExecuted,
    focusElementId: options.focusElementId,
    focusElementTitle: options.focusElementTitle,
    expectedSceneId: options.expectedSceneId,
  };
}
