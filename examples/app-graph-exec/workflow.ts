import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import { evaluateTaskHealth, loadGraph } from "../ios-ui-graph-manager";
import { planRoute } from "../ios-ui-graph-manager";
import {
  buildMobilecliForegroundCommand,
  buildMobilecliScreenshotCommand,
  buildMobilecliUiDumpCommand,
  centerOfBounds,
  parseUiDump,
  runCommand,
} from "../ios-regression-kit";

import type {
  AppGraph,
  SelectorEntry,
  TaskOracle,
} from "../ios-ui-graph-manager/types";
import type { AppGraphPlanResult, ResolvedStep } from "../app-graph-plan/types";
import type { UiElement, UiSelector } from "../ios-regression-kit/types";
import { compileRouteSteps } from "../app-graph-plan/workflow";
import {
  buildRuntimeRecoveryCommand,
  classifyRuntimeScene,
  decideSceneRecoveryWithAgent,
  persistAgentSceneRecognition,
  persistRuntimeTransition,
  resolveElementWithAgent,
  runtimeObservationsEquivalent,
  runtimeSceneMatches,
} from "./runtime-recovery";
import type {
  RuntimeElementAgentDecision,
  RuntimeCandidate,
  RuntimeRecoveryActionType,
  RuntimeObservation,
} from "./runtime-recovery";
import type {
  AppGraphExecFailure,
  AppGraphExecInput,
  AppGraphExecOutput,
  AppGraphExecResult,
  ExecStepRecord,
  FinalOracleResult,
  RuntimeRecoveryActionRecord,
} from "./types";
import {
  persistFastFailureLearning,
  persistSuccessfulExecutionLearning,
  promoteSceneReferenceAssets,
} from "./learning";
import { compileFastRecipe, executeFastRecipe } from "./fast-path";
import { waitForStableObservation } from "./observation-stability";
import type { StableObservationResult } from "./observation-stability";
import {
  buildViewportSearchCommand,
  isHistoricalViewportHintStep,
  searchViewports,
  viewportSearchAxisForTarget,
} from "./viewport-search";

export { meta } from "./types";

const DEFAULT_GRAPH_PATH = resolve(
  dirname(import.meta.path),
  "../ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);
const DEFAULT_OUTPUT_ROOT = "/tmp/ios_perf-opt/app-graph-exec";
const DEFAULT_BUNDLE_ID = "com.bot.doubao";
const STRICT_RESTART_SOURCE_PATH = resolve(
  dirname(import.meta.path),
  "../ios-regression-kit/devicectl_restart.py",
);
const DEFAULT_AGENT_TIMEOUT_MS = 60_000;
const DEFAULT_MAXIMUM_AGENT_RECOVERY_STEPS = 4;
const DEFAULT_MINIMUM_AGENT_CONFIDENCE = 0.75;
const MAX_VIEWPORT_SEARCH_MOVES = 6;
const SCENE_SETTLE_POLL_MS = 700;
const MAX_SCENE_SETTLE_SAMPLES = 6;
const REQUIRED_STABLE_SAMPLES = 2;
const DEFAULT_AGENT_CWD = resolve(dirname(import.meta.path), "../..");

export default async function appGraphExec(
  args: AppGraphExecInput,
): Promise<AppGraphExecOutput> {
  const startedAt = Date.now();
  const goal = args.goal?.trim();
  const plan = args.plan;
  if (!goal || !plan) {
    return fail({
      outputDir: args.outputDir ?? DEFAULT_OUTPUT_ROOT,
      goal: goal ?? "",
      code: "missing_plan",
      message: "goal and a successful semantic Plan are required.",
      recoverable: false,
    });
  }

  const outputDir = resolve(
    join(
      args.outputDir?.trim() || DEFAULT_OUTPUT_ROOT,
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
  );
  await mkdir(outputDir, { recursive: true });

  phase("Load");
  const graphPath = resolve(args.graphPath?.trim() || DEFAULT_GRAPH_PATH);
  let graph: AppGraph;
  try {
    graph = await loadGraph(graphPath);
  } catch {
    return fail({
      outputDir,
      goal,
      code: "graph_load_failed",
      message: `Cannot load graph from ${graphPath}.`,
      recoverable: false,
    });
  }

  phase("Preflight");
  const requestedProfileId =
    args.deviceProfileId ??
    plan.deviceProfileId ??
    graph.defaultDeviceProfileId;
  const planIssue = validatePlanAgainstGraph(plan, graph, requestedProfileId);
  if (planIssue) {
    return fail({
      outputDir,
      goal,
      code: planIssue.code,
      message: planIssue.message,
      recoverable: planIssue.recoverable,
    });
  }
  if (args.learningPlan) {
    const learningPlanIssue = validatePlanAgainstGraph(
      args.learningPlan,
      graph,
      requestedProfileId,
    );
    if (learningPlanIssue || !sameExecutionRecipe(plan, args.learningPlan)) {
      return fail({
        outputDir,
        goal,
        code: "learning_plan_mismatch",
        message:
          learningPlanIssue?.message ??
          "Learning Plan must match the executable Plan except for acceptance-only final Oracles.",
        recoverable: false,
      });
    }
  }
  const deviceProfile = graph.deviceProfiles[requestedProfileId]!;
  const agentTimeoutMs = Math.max(
    1_000,
    args.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
  );
  const maxAgentRecoverySteps = Math.max(
    0,
    Math.min(
      12,
      args.maxAgentRecoverySteps ?? DEFAULT_MAXIMUM_AGENT_RECOVERY_STEPS,
    ),
  );
  const minimumAgentConfidence = Math.min(
    1,
    Math.max(
      0,
      args.minimumAgentConfidence ?? DEFAULT_MINIMUM_AGENT_CONFIDENCE,
    ),
  );
  const agentCwd = resolve(args.agentCwd?.trim() || DEFAULT_AGENT_CWD);
  const allowLearning = args.allowLearning !== false;
  const commandRunner = args.commandRunner ?? runCommand;
  const planOnly = args.planOnly === true;
  const steps: ExecStepRecord[] = [];
  const evidencePaths: string[] = [plan.planPath];
  if (planOnly) {
    const result = execResult({
      outputDir,
      goal,
      plan,
      planOnly: true,
      verdict: "needs_review",
      verdictReason:
        "Plan validated against the current Graph; device execution was skipped.",
      steps,
      totalDurationMs: Date.now() - startedAt,
      graphRevision: graph.revision,
      finalOracleResults: [],
      recoveryActions: [],
      graphUpdated: false,
      graphPatchPaths: [],
      evidencePaths,
    });
    await writeFile(
      join(outputDir, "result.json"),
      JSON.stringify(result, null, 2),
      "utf8",
    );
    return result;
  }

  const udid = args.udid?.trim();
  if (!udid) {
    return fail({
      outputDir,
      goal,
      code: "missing_udid",
      message: "UDID is required for device execution.",
      recoverable: false,
    });
  }
  let runtimeAppVersion = args.runtimeAppVersion?.trim() || undefined;
  if (!runtimeAppVersion && args.runtimeAppVersionChecked !== true) {
    try {
      const installedApps = await runGroundCaptureCommand(
        ["mobilecli", "apps", "list", "--device", udid],
        commandRunner,
        3,
        true,
      );
      if (installedApps.exitCode === 0) {
        runtimeAppVersion = parseInstalledAppVersion(
          installedApps.stdout,
          graph.bundleId || DEFAULT_BUNDLE_ID,
        );
      }
    } catch {
      log(
        "Installed App version was unavailable; fast execution remains disabled.",
      );
    }
  }
  const matchedTask = plan.matchedTaskId
    ? graph.tasks[plan.matchedTaskId]
    : undefined;
  const runtimeTaskHealth = matchedTask
    ? evaluateTaskHealth({
        graph,
        task: matchedTask,
        deviceProfileId: requestedProfileId,
        runtimeAppVersion,
      })
    : undefined;
  const planProvesCurrentStaleReplan =
    runtimeTaskHealth?.status === "stale" &&
    plan.taskResolution?.health === "stale" &&
    plan.taskResolution.recipeReused === false &&
    plan.runtimeAppVersion === runtimeAppVersion;
  if (
    runtimeTaskHealth?.status === "invalid" ||
    (runtimeTaskHealth?.status === "stale" && !planProvesCurrentStaleReplan)
  ) {
    return fail({
      outputDir,
      goal,
      code: "task_replan_required",
      message: `Task ${matchedTask?.taskId ?? plan.matchedTaskId} is ${runtimeTaskHealth.status}: ${runtimeTaskHealth.reasons.join(", ")}. Re-plan with the current runtime App version before execution.`,
      recoverable: true,
      graphAppVersion: graph.appVersion,
      runtimeAppVersion,
      taskHealth: runtimeTaskHealth.status,
      taskHealthReasons: runtimeTaskHealth.reasons,
    });
  }

  phase("Reset");
  if (args.skipReset) {
    log("Continuing the current grounded session without another restart.");
  } else {
    try {
      await resetApp(
        udid,
        graph.bundleId || DEFAULT_BUNDLE_ID,
        outputDir,
        commandRunner,
      );
    } catch (error) {
      return fail({
        outputDir,
        goal,
        code: "reset_failed",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      });
    }
  }

  phase("Ground");
  let fastFallbackUsed = false;
  try {
    if (runtimeAppVersion) {
      await writeFile(
        join(outputDir, "runtime-app.json"),
        JSON.stringify(
          { bundleId: graph.bundleId, appVersion: runtimeAppVersion },
          null,
          2,
        ),
        "utf8",
      );
      evidencePaths.push(join(outputDir, "runtime-app.json"));
      if (
        runtimeAppVersion &&
        graph.appVersion &&
        runtimeAppVersion !== graph.appVersion
      ) {
        log(
          `Runtime App ${runtimeAppVersion} differs from Graph ${graph.appVersion}; disabling fast execution and validating live UI in guarded mode.`,
        );
      }
    }
  } catch {
    log(
      "Runtime App version was unavailable; fast execution remains subject to Task health gates.",
    );
  }
  const fastRecipe =
    args.preferFastPath !== false && runtimeTaskHealth?.status === "fresh"
      ? compileFastRecipe({
          graph,
          plan,
          deviceProfileId: requestedProfileId,
          udid,
          runtimeAppVersion,
        })
      : null;
  if (fastRecipe) {
    phase("Execute Steps");
    log(`Executing learned fast recipe for ${fastRecipe.task.taskId}.`);
    const fastDirectory = join(outputDir, "fast-path");
    await mkdir(fastDirectory, { recursive: true });
    const fastExecution = await executeFastRecipe({
      recipe: fastRecipe,
      outputDir: fastDirectory,
      commandRunner,
    });
    try {
      const fastEvidence = await captureGround(
        udid,
        fastDirectory,
        "final",
        commandRunner,
      );
      const fastOracleResults = fastExecution.success
        ? evaluateFinalOracles(
            plan.finalOracles,
            fastEvidence,
            graph,
            new Set(),
          )
        : [];
      const fastPassed =
        fastExecution.success &&
        fastOracleResults.length === plan.finalOracles.length &&
        fastOracleResults.every((oracle) => oracle.supported && oracle.success);
      if (fastPassed) {
        const fastSteps = fastExecution.records.map((record) => ({
          ...record,
          outcomeVerified: true,
        }));
        evidencePaths.push(
          fastEvidence.screenshotPath,
          fastEvidence.uiDumpPath,
          fastEvidence.foregroundPath,
        );
        phase("Verify");
        phase("Learn");
        log("Fast recipe passed final Ground and Oracles.");

        const targetSceneId = plan.finalOracles.find(
          (oracle) => oracle.type === "scene_current" && oracle.sceneId,
        )?.sceneId;
        let fastGraphUpdated = false;
        if (allowLearning && targetSceneId && graph.scenes[targetSceneId]) {
          log(`Promoting final scene reference assets for ${targetSceneId}.`);
          const promotion = await promoteSceneReferenceAssets({
            graphPath,
            graph,
            sceneId: targetSceneId,
            screenshotPath: fastEvidence.screenshotPath,
            uiDumpPath: fastEvidence.uiDumpPath,
            ocrPath: fastEvidence.ocrPath,
          });
          if (promotion.graphUpdated) {
            graph = await loadGraph(graphPath);
            fastGraphUpdated = true;
            log(
              `Graph updated with new reference assets for ${targetSceneId}.`,
            );
          }
        }

        phase("Output");
        const result = execResult({
          outputDir,
          goal,
          plan,
          planOnly: false,
          verdict: "pass",
          verdictReason: "Learned fast recipe and final Oracles passed.",
          steps: fastSteps,
          totalDurationMs: Date.now() - startedAt,
          graphRevision: graph.revision,
          graphAppVersion: graph.appVersion,
          runtimeAppVersion,
          taskHealth: runtimeTaskHealth?.status,
          taskHealthReasons: runtimeTaskHealth?.reasons,
          finalOracleResults: fastOracleResults,
          recoveryActions: [],
          graphUpdated: fastGraphUpdated,
          graphPatchPaths: [],
          evidencePaths,
          executionMode: "fast",
          fastFallbackUsed: false,
        });
        await writeFile(
          join(outputDir, "result.json"),
          JSON.stringify(result, null, 2),
          "utf8",
        );
        return result;
      }
      const downgraded = await persistFastFailureLearning({
        graphPath,
        graph,
        taskId: fastRecipe.task.taskId,
        deviceProfileId: requestedProfileId,
        runtimeAppVersion,
        outputDir,
        evidencePath: fastEvidence.uiDumpPath,
        failure:
          fastExecution.error ?? "Fast recipe did not satisfy final Oracles.",
      });
      graph = downgraded.graph;
      fastFallbackUsed = true;
      log(
        `Fast recipe did not satisfy final Oracles; falling back to guarded execution. ${fastExecution.error ?? ""}`,
      );
    } catch (error) {
      fastFallbackUsed = true;
      log(
        `Fast recipe verification failed; falling back to guarded execution: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      await resetApp(
        udid,
        graph.bundleId || DEFAULT_BUNDLE_ID,
        join(outputDir, "fast-fallback-reset"),
        commandRunner,
      );
    } catch (error) {
      return fail({
        outputDir,
        goal,
        code: "fast_fallback_reset_failed",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      });
    }
    phase("Ground");
  }
  let evidence: GroundEvidence;
  try {
    evidence = await captureGround(udid, outputDir, "ground", commandRunner);
  } catch (error) {
    return fail({
      outputDir,
      goal,
      code: "ground_capture_failed",
      message: error instanceof Error ? error.message : String(error),
      recoverable: true,
    });
  }
  evidencePaths.push(
    evidence.screenshotPath,
    evidence.uiDumpPath,
    evidence.foregroundPath,
  );
  const recoveryActions: RuntimeRecoveryActionRecord[] = [];
  const graphPatchPaths: string[] = [];
  const pendingAgentElementLearnings: Array<{
    stepIndex: number;
    candidate: RuntimeCandidate;
    observation: RuntimeObservation;
  }> = [];
  let graphUpdated = false;
  const entryRecovery = await ensureRuntimeScene({
    goal,
    expectedSceneId: plan.entrySceneId,
    nextStep: plan.resolvedSteps[0],
    reason: "scene_unknown",
    graphPath,
    graph,
    evidence,
    udid,
    deviceProfileId: requestedProfileId,
    viewportWidth: deviceProfile.viewportWidth,
    viewportHeight: deviceProfile.viewportHeight,
    parameters: plan.parameters,
    outputDir,
    recoveryActions,
    graphPatchPaths,
    allowLearning,
    maxAgentRecoverySteps,
    agentTimeoutMs,
    minimumAgentConfidence,
    agentCwd,
    model: args.model,
    agentRunner: args.agentRunner,
    commandRunner,
    runtimeAppVersion,
  });
  graph = entryRecovery.graph;
  evidence = entryRecovery.evidence;
  graphUpdated ||= entryRecovery.graphUpdated;
  if (!entryRecovery.success) {
    return fail({
      outputDir,
      goal,
      code: "entry_scene_unresolved",
      message:
        entryRecovery.error ??
        `Cannot ground entry Scene ${plan.entrySceneId}.`,
      recoverable: true,
      discoveryRequestPath: await writeSceneDiscoveryRequest({
        outputDir,
        goal,
        plan,
        graph,
        expectedSceneId: plan.entrySceneId,
        evidence,
        failure: entryRecovery.error ?? "Entry Scene grounding failed.",
      }),
      recoveryActions,
      graphUpdated,
      graphPatchPaths,
    });
  }
  let verifiedCurrentSceneId: string | undefined = plan.entrySceneId;

  phase("Execute Steps");
  let discoveryRequestPath: string | undefined;
  let runtimeFailure:
    | {
        readonly code: string;
        readonly message: string;
        readonly recoverable: boolean;
      }
    | undefined;
  for (const [index, step] of plan.resolvedSteps.entries()) {
    if (isHistoricalViewportHintStep(plan.resolvedSteps, index)) {
      log(
        `Step ${index + 1}/${plan.resolvedSteps.length}: skipping historical same-Scene viewport gesture; the next semantic target will be located by live viewport search.`,
      );
      steps.push(skippedViewportStepRecord(step, index));
      continue;
    }
    const evidenceBeforeStep = evidence;
    const stepEntry =
      verifiedCurrentSceneId === step.fromSceneId
        ? {
            success: true,
            graph,
            evidence,
            graphUpdated: false,
          }
        : await ensureRuntimeScene({
            goal,
            expectedSceneId: step.fromSceneId,
            nextStep: step,
            reason: "route_missing",
            graphPath,
            graph,
            evidence,
            udid,
            deviceProfileId: requestedProfileId,
            viewportWidth: deviceProfile.viewportWidth,
            viewportHeight: deviceProfile.viewportHeight,
            parameters: plan.parameters,
            outputDir,
            recoveryActions,
            graphPatchPaths,
            allowLearning,
            maxAgentRecoverySteps,
            agentTimeoutMs,
            minimumAgentConfidence,
            agentCwd,
            model: args.model,
            agentRunner: args.agentRunner,
            commandRunner,
            runtimeAppVersion,
          });
    graph = stepEntry.graph;
    evidence = stepEntry.evidence;
    graphUpdated ||= stepEntry.graphUpdated;
    if (!stepEntry.success) {
      discoveryRequestPath = await writeSceneDiscoveryRequest({
        outputDir,
        goal,
        plan,
        graph,
        expectedSceneId: step.fromSceneId,
        evidence,
        failure: stepEntry.error ?? "Step entry Scene grounding failed.",
      });
      evidencePaths.push(discoveryRequestPath);
      runtimeFailure = {
        code: "step_scene_unresolved",
        message:
          stepEntry.error ?? `Cannot ground step Scene ${step.fromSceneId}.`,
        recoverable: true,
      };
      break;
    }
    const stepDir = join(
      outputDir,
      `step-${String(index + 1).padStart(2, "0")}`,
    );
    await mkdir(stepDir, { recursive: true });
    log(
      `Step ${index + 1}/${plan.resolvedSteps.length}: ${step.action.description}`,
    );
    const executed = await executeSemanticStep({
      step,
      stepIndex: index,
      stepDir,
      udid,
      deviceProfileId: requestedProfileId,
      viewportWidth: deviceProfile.viewportWidth,
      viewportHeight: deviceProfile.viewportHeight,
      evidence,
      goal,
      currentSceneId: step.fromSceneId,
      graphPath,
      graph,
      outputDir,
      allowLearning,
      patchIndex: graphPatchPaths.length,
      agentTimeoutMs,
      minimumAgentConfidence,
      agentCwd,
      model: args.model,
      agentRunner: args.agentRunner,
      commandRunner,
      runtimeAppVersion,
    });
    const record = executed.record;
    graph = executed.graph;
    graphUpdated ||= executed.graphUpdated;
    if (executed.patchPath) graphPatchPaths.push(executed.patchPath);
    steps.push(record);
    evidencePaths.push(join(stepDir, "record.json"));
    if (record.viewportSearchPath) {
      evidencePaths.push(record.viewportSearchPath);
    }
    if (!record.success) {
      discoveryRequestPath = await writeDiscoveryRequest({
        outputDir,
        goal,
        plan,
        graph,
        step,
        record,
        evidence,
      });
      evidencePaths.push(discoveryRequestPath);
      runtimeFailure = {
        code:
          record.resolutionSource === "unresolved"
            ? "element_unresolved"
            : "step_execution_failed",
        message: record.error ?? `Step ${step.operatorId} failed.`,
        recoverable: true,
      };
      break;
    }
    if (step.action.settleMs > 0) await Bun.sleep(step.action.settleMs);
    let stableAfterStep: StableObservationResult<GroundEvidence>;
    try {
      stableAfterStep = await waitForStableGround({
        udid,
        outputDir: stepDir,
        prefix: "post-step",
        previousEvidence: evidenceBeforeStep,
        commandRunner,
      });
      evidence = stableAfterStep.observation;
      await writeFile(
        join(stepDir, "stability.json"),
        JSON.stringify(stableAfterStep, null, 2),
        "utf8",
      );
      log(
        `Step ${index + 1} page ${
          stableAfterStep.stable ? "stabilized" : "did not stabilize"
        } after ${stableAfterStep.sampleCount} observations (${
          stableAfterStep.samples.at(-1)?.strategy ?? "unknown"
        }).`,
      );
    } catch (error) {
      const failedRecord: ExecStepRecord = {
        ...record,
        success: false,
        outcomeVerified: false,
        error: `Post-step capture failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
      steps[steps.length - 1] = failedRecord;
      await writeFile(
        join(stepDir, "record.json"),
        JSON.stringify(failedRecord, null, 2),
        "utf8",
      );
      discoveryRequestPath = await writeDiscoveryRequest({
        outputDir,
        goal,
        plan,
        graph,
        step,
        record: failedRecord,
        evidence,
      });
      evidencePaths.push(discoveryRequestPath);
      runtimeFailure = {
        code: "post_step_capture_failed",
        message: failedRecord.error ?? "Post-step capture failed.",
        recoverable: true,
      };
      break;
    }
    if (!stableAfterStep.stable) {
      const failedRecord: ExecStepRecord = {
        ...record,
        success: false,
        outcomeVerified: false,
        error: `Page did not stabilize after ${stableAfterStep.sampleCount} post-step observations.`,
      };
      steps[steps.length - 1] = failedRecord;
      await writeFile(
        join(stepDir, "record.json"),
        JSON.stringify(failedRecord, null, 2),
        "utf8",
      );
      discoveryRequestPath = await writeDiscoveryRequest({
        outputDir,
        goal,
        plan,
        graph,
        step,
        record: failedRecord,
        evidence,
      });
      evidencePaths.push(discoveryRequestPath, join(stepDir, "stability.json"));
      runtimeFailure = {
        code: "page_not_stable",
        message: failedRecord.error ?? "Page did not stabilize.",
        recoverable: true,
      };
      break;
    }
    let outcomeVerified = verifyExpectedScene(
      step,
      evidence,
      graph,
      evidenceBeforeStep,
    );
    if (!outcomeVerified && step.expectedOutcome.scene) {
      const recovery = await ensureRuntimeScene({
        goal,
        expectedSceneId: step.expectedOutcome.scene.sceneId,
        nextStep: plan.resolvedSteps[index + 1],
        reason: "route_failed",
        graphPath,
        graph,
        evidence,
        udid,
        deviceProfileId: requestedProfileId,
        viewportWidth: deviceProfile.viewportWidth,
        viewportHeight: deviceProfile.viewportHeight,
        parameters: plan.parameters,
        outputDir,
        recoveryActions,
        graphPatchPaths,
        allowLearning,
        maxAgentRecoverySteps,
        agentTimeoutMs,
        minimumAgentConfidence,
        agentCwd,
        model: args.model,
        agentRunner: args.agentRunner,
        commandRunner,
        runtimeAppVersion,
      });
      graph = recovery.graph;
      evidence = recovery.evidence;
      graphUpdated ||= recovery.graphUpdated;
      outcomeVerified = recovery.success;
    }
    if (outcomeVerified && executed.pendingAgentResolution) {
      pendingAgentElementLearnings.push({
        stepIndex: index,
        candidate: executed.pendingAgentResolution.candidate,
        observation: executed.pendingAgentResolution.observation,
      });
    }
    const completedRecord = { ...record, outcomeVerified };
    steps[steps.length - 1] = completedRecord;
    await writeFile(
      join(stepDir, "record.json"),
      JSON.stringify(completedRecord, null, 2),
      "utf8",
    );
    evidencePaths.push(
      evidence.screenshotPath,
      evidence.uiDumpPath,
      evidence.foregroundPath,
    );
    if (!outcomeVerified) {
      discoveryRequestPath = await writeDiscoveryRequest({
        outputDir,
        goal,
        plan,
        graph,
        step,
        record: completedRecord,
        evidence,
      });
      evidencePaths.push(discoveryRequestPath);
      runtimeFailure = {
        code: "target_scene_unresolved",
        message: `Step ${step.operatorId} did not reach ${
          step.expectedOutcome.scene?.sceneId ?? "the expected Scene"
        }.`,
        recoverable: true,
      };
      break;
    }
    verifiedCurrentSceneId = step.toSceneId ?? step.fromSceneId;
  }

  if (runtimeFailure) {
    phase("Output");
    const failure = fail({
      outputDir,
      goal,
      code: runtimeFailure.code,
      message: runtimeFailure.message,
      recoverable: runtimeFailure.recoverable,
      partialSteps: steps,
      discoveryRequestPath,
      recoveryActions,
      graphUpdated,
      graphPatchPaths,
    });
    await writeFile(
      join(outputDir, "result.json"),
      JSON.stringify(failure, null, 2),
      "utf8",
    );
    return failure;
  }

  phase("Verify");
  const allStepsSucceeded =
    steps.length === plan.resolvedSteps.length &&
    steps.every((step) => step.success && step.outcomeVerified);
  const finalOracleResults = allStepsSucceeded
    ? evaluateFinalOracles(
        plan.finalOracles,
        evidence,
        graph,
        new Set(
          recoveryActions
            .filter((action) => action.success && action.actionType === "none")
            .map((action) => action.targetSceneId),
        ),
      )
    : [];
  const allOraclesPassed =
    finalOracleResults.length === plan.finalOracles.length &&
    finalOracleResults.every((oracle) => oracle.success);
  const hasUnsupportedOracle = finalOracleResults.some(
    (oracle) => !oracle.supported,
  );
  const verdict: AppGraphExecResult["verdict"] = allStepsSucceeded
    ? hasUnsupportedOracle
      ? "needs_review"
      : allOraclesPassed
        ? "pass"
        : "fail"
    : steps.some((step) => step.resolutionSource === "unresolved")
      ? "needs_review"
      : recoveryActions.some((action) => !action.success)
        ? "needs_review"
        : "blocked";
  const verdictReason =
    verdict === "pass"
      ? "All semantic steps and final Oracles passed."
      : hasUnsupportedOracle
        ? "One or more final Oracles require visual review."
        : verdict === "fail"
          ? "One or more final Oracles failed."
          : (steps.find((step) => !step.success || !step.outcomeVerified)
              ?.error ?? "Semantic execution did not complete.");

  phase("Learn");
  let learningPatchPath: string | undefined;
  if (allowLearning && verdict === "pass") {
    const learned = await persistSuccessfulExecutionLearning({
      graphPath,
      graph,
      plan: args.learningPlan ?? plan,
      goal,
      steps,
      deviceProfileId: requestedProfileId,
      runtimeAppVersion,
      outputDir,
      evidencePath: evidence.uiDumpPath,
      finalSceneEvidence: {
        screenshotPath: evidence.screenshotPath,
        uiDumpPath: evidence.uiDumpPath,
        ocrPath: evidence.ocrPath,
      },
      agentElementResolutions: pendingAgentElementLearnings,
    });
    graph = learned.graph;
    graphUpdated ||= learned.graphUpdated;
    learningPatchPath = learned.patchPath;
    if (learningPatchPath) graphPatchPaths.push(learningPatchPath);
    log(
      learned.graphUpdated
        ? learned.taskId
          ? `Learned ${learned.taskId} as ${learned.taskStatus}/${learned.executionTier}.`
          : "Learned execution evidence and Scene assets without creating a reusable Task."
        : "Execution passed; runtime learning patch was not applied.",
    );
  } else if (allowLearning) {
    log("Learning skipped because execution did not pass.");
  }

  phase("Output");
  const result = execResult({
    outputDir,
    goal,
    plan,
    planOnly: false,
    verdict,
    verdictReason,
    steps,
    totalDurationMs: Date.now() - startedAt,
    graphRevision: graph.revision,
    graphAppVersion: graph.appVersion,
    runtimeAppVersion,
    taskHealth: runtimeTaskHealth?.status,
    taskHealthReasons: runtimeTaskHealth?.reasons,
    finalOracleResults,
    recoveryActions,
    graphUpdated,
    graphPatchPaths,
    learningPatchPath,
    discoveryRequestPath,
    evidencePaths,
    executionMode: "guarded",
    fastFallbackUsed,
  });
  await writeFile(
    join(outputDir, "result.json"),
    JSON.stringify(result, null, 2),
    "utf8",
  );
  return result;
}

function skippedViewportStepRecord(
  step: ResolvedStep,
  stepIndex: number,
): ExecStepRecord {
  const timestamp = new Date().toISOString();
  return {
    stepIndex,
    operatorId: step.operatorId,
    action: step.operation.type,
    actionDescription:
      "Historical viewport hint skipped; live viewport search resolves the following semantic target.",
    targetElementId: step.operation.elementId,
    resolutionSource: "operation",
    commands: [],
    visibilityRecoveryCommands: [],
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    exitCode: 0,
    success: true,
    agentUsed: false,
    bindingUsed: "operation",
    expectedSceneId: step.toSceneId ?? undefined,
    outcomeVerified: true,
  };
}

export function validatePlanAgainstGraph(
  plan: AppGraphPlanResult,
  graph: AppGraph,
  deviceProfileId: string,
): { code: string; message: string; recoverable: boolean } | null {
  if (plan.schemaVersion !== "app-graph-semantic-plan/v2") {
    return {
      code: "unsupported_plan_schema",
      message: `Unsupported Plan schema: ${String(plan.schemaVersion)}.`,
      recoverable: false,
    };
  }
  if (plan.graphIdentity.graphId !== graph.graphId) {
    return {
      code: "plan_graph_mismatch",
      message: `Plan graph ${plan.graphIdentity.graphId} does not match ${graph.graphId}.`,
      recoverable: false,
    };
  }
  if (plan.graphIdentity.revision !== graph.revision) {
    return {
      code: "stale_plan",
      message: `Plan revision ${plan.graphIdentity.revision} does not match current revision ${graph.revision}. Re-plan before execution.`,
      recoverable: true,
    };
  }
  if (
    plan.graphIdentity.appVersion &&
    graph.appVersion &&
    plan.graphIdentity.appVersion !== graph.appVersion
  ) {
    return {
      code: "plan_app_version_mismatch",
      message: `Plan app version ${plan.graphIdentity.appVersion} does not match ${graph.appVersion}. Re-plan before execution.`,
      recoverable: true,
    };
  }
  if (plan.deviceProfileId !== deviceProfileId) {
    return {
      code: "device_profile_mismatch",
      message: `Plan profile ${plan.deviceProfileId} cannot execute as ${deviceProfileId}. Re-plan for that profile.`,
      recoverable: true,
    };
  }
  if (!graph.deviceProfiles[deviceProfileId]) {
    return {
      code: "device_profile_missing",
      message: `Graph does not define device profile ${deviceProfileId}.`,
      recoverable: false,
    };
  }
  return null;
}

function sameExecutionRecipe(
  executionPlan: AppGraphPlanResult,
  learningPlan: AppGraphPlanResult,
): boolean {
  return (
    executionPlan.graphIdentity.graphId ===
      learningPlan.graphIdentity.graphId &&
    executionPlan.graphIdentity.revision ===
      learningPlan.graphIdentity.revision &&
    executionPlan.matchedTaskId === learningPlan.matchedTaskId &&
    executionPlan.entrySceneId === learningPlan.entrySceneId &&
    executionPlan.targetSceneId === learningPlan.targetSceneId &&
    JSON.stringify(executionPlan.taskSteps) ===
      JSON.stringify(learningPlan.taskSteps) &&
    JSON.stringify(executionPlan.resolvedSteps) ===
      JSON.stringify(learningPlan.resolvedSteps) &&
    JSON.stringify(executionPlan.parameters) ===
      JSON.stringify(learningPlan.parameters)
  );
}

interface GroundEvidence {
  readonly screenshotPath: string;
  readonly uiDumpPath: string;
  readonly foregroundPath: string;
  readonly foregroundBundleId: string;
  readonly foregroundAppVersion?: string;
  readonly uiElements: readonly UiElement[];
  readonly ocrPath?: string;
}

interface StepResolution {
  readonly source: ExecStepRecord["resolutionSource"];
  readonly point?: { readonly x: number; readonly y: number };
  readonly bindingUsed: ExecStepRecord["bindingUsed"];
  readonly matchedElement?: UiElement;
  readonly error?: string;
}

export function resolveSemanticStepTarget(options: {
  step: ResolvedStep;
  uiElements: readonly UiElement[];
  deviceProfileId: string;
  viewportWidth: number;
  viewportHeight: number;
  deferBindingFallback?: boolean;
  minimumTargetY?: number;
  maximumTargetY?: number;
  runtimeAppVersion?: string;
  graphAppVersion?: string;
  requireVersionMatch?: boolean;
}): StepResolution {
  const { step } = options;
  if (step.operation.type === "swipe" || step.operation.type === "input_text") {
    return { source: "operation", bindingUsed: "operation" };
  }
  const selectorMatches = resolveSelectorMatchesByPriority(
    options.uiElements,
    step.targetElement?.selectors ?? [],
    step.resolutionPolicy.selectorPriority,
  );
  const matched = selectPreferredTargetMatch(
    selectorMatches,
    step,
    options.viewportWidth,
    options.viewportHeight,
  );
  if (
    matched?.bounds &&
    pointWithinViewport(
      centerOfBounds(matched.bounds),
      options.viewportWidth,
      options.viewportHeight,
      options.minimumTargetY,
      options.maximumTargetY,
    )
  ) {
    return {
      source: "live_selector",
      point: centerOfBounds(matched.bounds),
      bindingUsed: "selector",
      matchedElement: matched,
    };
  }
  if (step.resolutionPolicy.allowAgentVisualResolution && step.targetElement) {
    const visualMatches = options.uiElements.filter(
      (element) =>
        visuallyMatches(element, step) &&
        Boolean(
          element.bounds &&
          pointWithinViewport(
            centerOfBounds(element.bounds),
            options.viewportWidth,
            options.viewportHeight,
            options.minimumTargetY,
            options.maximumTargetY,
          ),
        ),
    );
    if (visualMatches.length === 1 && visualMatches[0]?.bounds) {
      return {
        source: "visual_semantic",
        point: centerOfBounds(visualMatches[0].bounds),
        bindingUsed: "visual",
        matchedElement: visualMatches[0],
      };
    }
  }
  if (
    !options.deferBindingFallback &&
    step.resolutionPolicy.allowBindingFallback &&
    (!options.requireVersionMatch ||
      (Boolean(options.runtimeAppVersion) &&
        Boolean(options.graphAppVersion) &&
        options.runtimeAppVersion === options.graphAppVersion &&
        step.binding.appVersion === options.runtimeAppVersion)) &&
    step.binding.deviceProfileId === options.deviceProfileId &&
    step.binding.normalizedPoint &&
    step.binding.normalizedPoint.x >= 0 &&
    step.binding.normalizedPoint.x < 1 &&
    step.binding.normalizedPoint.y >= 0 &&
    step.binding.normalizedPoint.y < 1
  ) {
    return {
      source: "binding_fallback",
      point: {
        x: step.binding.normalizedPoint.x * options.viewportWidth,
        y: step.binding.normalizedPoint.y * options.viewportHeight,
      },
      bindingUsed:
        step.binding.status === "verified" ? "verified" : "candidate",
    };
  }
  return {
    source: "unresolved",
    bindingUsed: "missing",
    error: step.resolutionPolicy.liveResolutionRequired
      ? `Live semantic resolution is required for ${step.operatorId}; current selectors did not resolve uniquely.`
      : `No live semantic target or permitted profile Binding resolved ${step.operatorId}.`,
  };
}

function pointWithinViewport(
  point: { readonly x: number; readonly y: number },
  viewportWidth: number,
  viewportHeight: number,
  minimumY = 0,
  maximumY = viewportHeight,
): boolean {
  return (
    point.x >= 0 &&
    point.x < viewportWidth &&
    point.y >= minimumY &&
    point.y < maximumY
  );
}

export function viewportSearchTargetYRange(viewportHeight: number): {
  readonly minimumY: number;
  readonly maximumY: number;
} {
  return {
    minimumY: viewportHeight * 0.14,
    // Keep taps clear of the iOS home-indicator gesture area without
    // discarding legitimate controls in the last visible content row.
    maximumY: viewportHeight - Math.max(32, viewportHeight * 0.04),
  };
}

export function buildStepCommands(options: {
  step: ResolvedStep;
  udid: string;
  point?: { readonly x: number; readonly y: number };
}): string[][] {
  const { step, udid, point } = options;
  switch (step.operation.type) {
    case "tap":
      if (!point) return [];
      return [["mobilecli", "io", "tap", "--device", udid, pointText(point)]];
    case "tap_restart_app":
      if (!point) return [];
      return [
        ["mobilecli", "io", "tap", "--device", udid, pointText(point)],
        ["sleep", "2"],
        [
          "mobilecli",
          "apps",
          "launch",
          "--device",
          udid,
          step.operation.bundleId ?? DEFAULT_BUNDLE_ID,
        ],
      ];
    case "long_press":
      if (!point) return [];
      return [
        [
          "mobilecli",
          "io",
          "longpress",
          "--device",
          udid,
          pointText(point),
          "--duration",
          String(step.operation.durationMs ?? 800),
        ],
      ];
    case "input_text":
      return [
        [
          "mobilecli",
          "io",
          "text",
          "--device",
          udid,
          step.operation.value ?? "",
        ],
      ];
    case "swipe":
      if (!step.operation.from || !step.operation.to) return [];
      return [
        [
          "mobilecli",
          "io",
          "swipe",
          "--device",
          udid,
          `${pointText(step.operation.from)},${pointText(step.operation.to)}`,
        ],
      ];
    default:
      return [];
  }
}

async function executeSemanticStep(options: {
  step: ResolvedStep;
  stepIndex: number;
  stepDir: string;
  udid: string;
  deviceProfileId: string;
  viewportWidth: number;
  viewportHeight: number;
  evidence: GroundEvidence;
  goal: string;
  currentSceneId: string;
  graphPath: string;
  graph: AppGraph;
  outputDir: string;
  allowLearning: boolean;
  patchIndex: number;
  agentTimeoutMs: number;
  minimumAgentConfidence: number;
  agentCwd: string;
  model?: string;
  agentRunner?: AppGraphExecInput["agentRunner"];
  commandRunner: NonNullable<AppGraphExecInput["commandRunner"]>;
  runtimeAppVersion?: string;
}): Promise<{
  record: ExecStepRecord;
  graph: AppGraph;
  graphUpdated: boolean;
  patchPath?: string;
  pendingAgentResolution?: {
    readonly candidate: RuntimeCandidate;
    readonly observation: RuntimeObservation;
  };
}> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const graph = options.graph;
  const graphUpdated = false;
  let currentEvidence = options.evidence;
  const visibilityRecoveryCommands: string[][] = [];
  let viewportSearchPath: string | undefined;
  let resolution = resolveSemanticStepTarget({
    step: options.step,
    uiElements: currentEvidence.uiElements,
    deviceProfileId: options.deviceProfileId,
    viewportWidth: options.viewportWidth,
    viewportHeight: options.viewportHeight,
    deferBindingFallback: true,
    runtimeAppVersion: options.runtimeAppVersion,
    graphAppVersion: graph.appVersion,
    requireVersionMatch: true,
  });
  if (
    resolution.source === "unresolved" &&
    options.step.targetElement &&
    (options.step.operation.type === "tap" ||
      options.step.operation.type === "long_press")
  ) {
    const axis = viewportSearchAxisForTarget({
      elementId: options.step.targetElement.elementId,
      semanticRole: options.step.targetElement.semanticRole,
    });
    const targetYRange = viewportSearchTargetYRange(options.viewportHeight);
    const searchDir = join(options.stepDir, "visibility-recovery");
    try {
      const search = await searchViewports({
        axis,
        initialObservation: currentEvidence,
        maximumMoves: MAX_VIEWPORT_SEARCH_MOVES,
        resolveVisibleTarget: (evidence) => {
          const candidate = resolveSemanticStepTarget({
            step: options.step,
            uiElements: evidence.uiElements,
            deviceProfileId: options.deviceProfileId,
            viewportWidth: options.viewportWidth,
            viewportHeight: options.viewportHeight,
            deferBindingFallback: true,
            minimumTargetY: targetYRange.minimumY,
            maximumTargetY: targetYRange.maximumY,
            runtimeAppVersion: options.runtimeAppVersion,
            graphAppVersion: graph.appVersion,
            requireVersionMatch: true,
          });
          return candidate.source === "unresolved" ? null : candidate;
        },
        moveAndObserve: async (direction, moveIndex, previous) => {
          log(
            `Step ${options.stepIndex + 1} viewport search ${moveIndex}/${MAX_VIEWPORT_SEARCH_MOVES}: swipe ${direction} by one short segment, wait for stability, then re-check ${options.step.targetElement?.title ?? options.step.operatorId}.`,
          );
          const command = buildViewportSearchCommand({
            udid: options.udid,
            axis,
            direction,
            viewportWidth: options.viewportWidth,
            viewportHeight: options.viewportHeight,
          });
          const commandResult = await options.commandRunner(
            command,
            process.cwd(),
          );
          visibilityRecoveryCommands.push(command);
          if (commandResult.exitCode !== 0) {
            throw new Error(
              commandResult.stderr.trim() ||
                `Command failed: ${command.join(" ")}`,
            );
          }
          const stable = await waitForStableGround({
            udid: options.udid,
            outputDir: searchDir,
            prefix: `${direction}-${String(moveIndex).padStart(2, "0")}`,
            previousEvidence: previous,
            requireChangeFromPrevious: false,
            commandRunner: options.commandRunner,
          });
          return {
            observation: stable.observation,
            stable: stable.stable,
            changedFromPrevious: stable.changedFromPrevious,
            fingerprint:
              stable.samples.at(-1)?.fingerprint ?? `${direction}-${moveIndex}`,
          };
        },
      });
      currentEvidence = search.observation;
      resolution = search.target ?? {
        source: "unresolved",
        bindingUsed: "missing",
        error: `Viewport search stopped with ${search.stopReason}; ${options.step.targetElement.title} was not visible in the inspected screens.`,
      };
      await mkdir(searchDir, { recursive: true });
      viewportSearchPath = join(searchDir, "viewport-search.json");
      await writeFile(
        viewportSearchPath,
        JSON.stringify(
          {
            axis,
            targetElementId: options.step.targetElement.elementId,
            targetTitle: options.step.targetElement.title,
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
    } catch (searchError) {
      resolution = {
        source: "unresolved",
        bindingUsed: "missing",
        error: `Viewport search failed: ${
          searchError instanceof Error
            ? searchError.message
            : String(searchError)
        }`,
      };
    }
  }
  let agentDecision: RuntimeElementAgentDecision | undefined;
  let pendingAgentResolution:
    | {
        candidate: RuntimeCandidate;
        observation: RuntimeObservation;
      }
    | undefined;
  if (
    resolution.source === "unresolved" &&
    options.step.targetElement &&
    options.step.resolutionPolicy.allowAgentVisualResolution
  ) {
    try {
      const agentResolution = await resolveElementWithAgent({
        goal: options.goal,
        currentSceneId: options.currentSceneId,
        step: options.step,
        observation: currentEvidence,
        viewportWidth: options.viewportWidth,
        viewportHeight: options.viewportHeight,
        cwd: options.agentCwd,
        model: options.model,
        timeoutMs: options.agentTimeoutMs,
        minimumConfidence: options.minimumAgentConfidence,
        agentRunner: options.agentRunner,
      });
      if (agentResolution) {
        agentDecision = agentResolution.decision;
        resolution = {
          source: "agent_selector",
          point: centerOfBounds(agentResolution.candidate.bounds),
          bindingUsed: "agent",
          matchedElement: {
            role: agentResolution.candidate.role,
            accessibilityId: agentResolution.candidate.accessibilityId,
            label: agentResolution.candidate.label,
            text: agentResolution.candidate.text,
            value: agentResolution.candidate.value,
            bounds: agentResolution.candidate.bounds,
          },
        };
        pendingAgentResolution = {
          candidate: agentResolution.candidate,
          observation: currentEvidence,
        };
      }
    } catch (error) {
      resolution = {
        source: "unresolved",
        bindingUsed: "missing",
        error: `Agent element resolution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  if (resolution.source === "unresolved") {
    const bindingResolution = resolveSemanticStepTarget({
      step: options.step,
      uiElements: [],
      deviceProfileId: options.deviceProfileId,
      viewportWidth: options.viewportWidth,
      viewportHeight: options.viewportHeight,
      runtimeAppVersion: options.runtimeAppVersion,
      graphAppVersion: graph.appVersion,
      requireVersionMatch: true,
    });
    if (
      bindingResolution.source === "binding_fallback" &&
      visibilityRecoveryCommands.length === 0
    ) {
      resolution = bindingResolution;
    } else if (visibilityRecoveryCommands.length > 0) {
      resolution = {
        source: "unresolved",
        bindingUsed: "missing",
        error: `Scrollable target ${options.step.targetElement?.elementId ?? options.step.operatorId} did not become visible; historical coordinate fallback is unsafe.`,
      };
    }
  }
  const commands = buildStepCommands({
    step: options.step,
    udid: options.udid,
    point: resolution.point,
  });
  let exitCode = commands.length > 0 ? 0 : -1;
  let error = resolution.error;
  for (const command of commands) {
    const commandResult = await options.commandRunner(command, process.cwd());
    exitCode = commandResult.exitCode;
    if (exitCode !== 0) {
      error =
        commandResult.stderr.slice(0, 500) ||
        `Command failed: ${command.join(" ")}`;
      break;
    }
  }
  if (commands.length === 0 && !error) {
    error = `Operation ${options.step.operation.type} could not be compiled.`;
  }
  const record: ExecStepRecord = {
    stepIndex: options.stepIndex,
    operatorId: options.step.operatorId,
    action: options.step.operation.type,
    actionDescription: options.step.action.description,
    targetElementId: options.step.operation.elementId,
    normalizedPoint: resolution.point
      ? {
          x: resolution.point.x / options.viewportWidth,
          y: resolution.point.y / options.viewportHeight,
        }
      : undefined,
    resolutionSource: resolution.source,
    commands,
    visibilityRecoveryCommands,
    viewportSearchPath,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exitCode,
    success: exitCode === 0,
    error,
    screenshotPath: currentEvidence.screenshotPath,
    uiDumpPath: currentEvidence.uiDumpPath,
    agentUsed: resolution.source === "agent_selector",
    bindingUsed: resolution.bindingUsed,
    expectedSceneId: options.step.expectedOutcome.scene?.sceneId,
    outcomeVerified: options.step.expectedOutcome.scene === null,
  };
  await writeFile(
    join(options.stepDir, "record.json"),
    JSON.stringify(record, null, 2),
    "utf8",
  );
  if (agentDecision) {
    await writeFile(
      join(options.stepDir, "agent-element-resolution.json"),
      JSON.stringify(agentDecision, null, 2),
      "utf8",
    );
  }
  return {
    record,
    graph,
    graphUpdated,
    pendingAgentResolution,
  };
}

interface EnsureRuntimeSceneResult {
  readonly success: boolean;
  readonly graph: AppGraph;
  readonly evidence: GroundEvidence;
  readonly graphUpdated: boolean;
  readonly error?: string;
}

async function ensureRuntimeScene(options: {
  goal: string;
  expectedSceneId: string;
  nextStep?: ResolvedStep;
  reason: "scene_unknown" | "route_missing" | "route_failed";
  graphPath: string;
  graph: AppGraph;
  evidence: GroundEvidence;
  udid: string;
  deviceProfileId: string;
  viewportWidth: number;
  viewportHeight: number;
  parameters: Readonly<Record<string, string>>;
  outputDir: string;
  recoveryActions: RuntimeRecoveryActionRecord[];
  graphPatchPaths: string[];
  allowLearning: boolean;
  maxAgentRecoverySteps: number;
  agentTimeoutMs: number;
  minimumAgentConfidence: number;
  agentCwd: string;
  model?: string;
  agentRunner?: AppGraphExecInput["agentRunner"];
  commandRunner: NonNullable<AppGraphExecInput["commandRunner"]>;
  runtimeAppVersion?: string;
}): Promise<EnsureRuntimeSceneResult> {
  let graph = options.graph;
  let evidence = options.evidence;
  let graphUpdated = false;
  if (
    options.recoveryActions.some(
      (action) =>
        action.success &&
        action.actionType === "none" &&
        action.targetSceneId === options.expectedSceneId,
    )
  ) {
    return { success: true, graph, evidence, graphUpdated };
  }
  if (runtimeSceneMatches(graph, options.expectedSceneId, evidence)) {
    return { success: true, graph, evidence, graphUpdated };
  }

  try {
    const stable = await waitForStableGround({
      udid: options.udid,
      outputDir: join(options.outputDir, "runtime-scene-ground"),
      prefix: String(options.recoveryActions.length + 1).padStart(2, "0"),
      commandRunner: options.commandRunner,
    });
    evidence = stable.observation;
    await writeFile(
      join(
        options.outputDir,
        "runtime-scene-ground",
        `${String(options.recoveryActions.length + 1).padStart(2, "0")}-stability.json`,
      ),
      JSON.stringify(stable, null, 2),
      "utf8",
    );
    if (!stable.stable) {
      return {
        success: false,
        graph,
        evidence,
        graphUpdated,
        error: `Page did not stabilize before recovery toward ${options.expectedSceneId}.`,
      };
    }
    if (runtimeSceneMatches(graph, options.expectedSceneId, evidence)) {
      return { success: true, graph, evidence, graphUpdated };
    }
  } catch (error) {
    return {
      success: false,
      graph,
      evidence,
      graphUpdated,
      error: `Stable Scene observation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let currentMatch = classifyRuntimeScene(graph, evidence);
  if (currentMatch && currentMatch.sceneId !== options.expectedSceneId) {
    const route = planRoute(
      graph,
      currentMatch.sceneId,
      options.expectedSceneId,
    );
    const safeRoute =
      route &&
      route.every((routeStep) => {
        const operator = graph.operators[routeStep.operatorId];
        return (
          operator &&
          ["navigation", "interaction"].includes(operator.risk ?? "interaction")
        );
      });
    if (route && safeRoute) {
      const routeSteps = compileRouteSteps({
        graph,
        route,
        deviceProfileId: options.deviceProfileId,
        runtimeAppVersion: options.runtimeAppVersion,
        parameters: options.parameters,
      });
      for (const [routeIndex, routeStep] of routeSteps.entries()) {
        const routeDir = join(
          options.outputDir,
          "runtime-graph-route",
          `${String(options.recoveryActions.length + 1).padStart(2, "0")}-${routeStep.operatorId}`,
        );
        await mkdir(routeDir, { recursive: true });
        const executed = await executeSemanticStep({
          step: routeStep,
          stepIndex: routeIndex,
          stepDir: routeDir,
          udid: options.udid,
          deviceProfileId: options.deviceProfileId,
          viewportWidth: options.viewportWidth,
          viewportHeight: options.viewportHeight,
          evidence,
          goal: options.goal,
          currentSceneId: routeStep.fromSceneId,
          graphPath: options.graphPath,
          graph,
          outputDir: options.outputDir,
          allowLearning: options.allowLearning,
          patchIndex: options.graphPatchPaths.length,
          agentTimeoutMs: options.agentTimeoutMs,
          minimumAgentConfidence: options.minimumAgentConfidence,
          agentCwd: options.agentCwd,
          model: options.model,
          agentRunner: options.agentRunner,
          commandRunner: options.commandRunner,
          runtimeAppVersion: options.runtimeAppVersion,
        });
        graph = executed.graph;
        graphUpdated ||= executed.graphUpdated;
        if (executed.patchPath)
          options.graphPatchPaths.push(executed.patchPath);
        if (!executed.record.success) {
          break;
        }
        if (routeStep.action.settleMs > 0) {
          await Bun.sleep(routeStep.action.settleMs);
        }
        const stableRoute = await waitForStableGround({
          udid: options.udid,
          outputDir: routeDir,
          prefix: "post-route",
          previousEvidence: evidence,
          commandRunner: options.commandRunner,
        });
        evidence = stableRoute.observation;
        await writeFile(
          join(routeDir, "stability.json"),
          JSON.stringify(stableRoute, null, 2),
          "utf8",
        );
        const routeOutcomeVerified = Boolean(
          stableRoute.stable &&
          routeStep.toSceneId &&
          runtimeSceneMatches(graph, routeStep.toSceneId, evidence),
        );
        options.recoveryActions.push({
          recoveryIndex: options.recoveryActions.length,
          reason: "graph_route",
          goal: options.goal,
          expectedSceneId: options.expectedSceneId,
          sourceSceneId: routeStep.fromSceneId,
          targetSceneId: routeStep.toSceneId ?? routeStep.fromSceneId,
          candidateId:
            routeStep.targetElement?.elementId ?? routeStep.operatorId,
          candidateTitle:
            routeStep.targetElement?.title ?? routeStep.operatorId,
          actionType: runtimeActionType(routeStep.operation.type),
          command: executed.record.commands[0] ?? [],
          agentReason: "Known Graph route.",
          confidence: 1,
          beforeScreenshotPath: executed.record.screenshotPath ?? "",
          beforeUiDumpPath: executed.record.uiDumpPath ?? "",
          afterScreenshotPath: evidence.screenshotPath,
          afterUiDumpPath: evidence.uiDumpPath,
          success: executed.record.success && routeOutcomeVerified,
          error: routeOutcomeVerified
            ? executed.record.error
            : `Graph route did not reach ${routeStep.toSceneId ?? "the expected Scene"}.`,
        });
        if (!routeOutcomeVerified) break;
      }
      if (runtimeSceneMatches(graph, options.expectedSceneId, evidence)) {
        return { success: true, graph, evidence, graphUpdated };
      }
      currentMatch = classifyRuntimeScene(graph, evidence);
    }
  }

  const previousAgentActions: Array<{
    candidateId: string;
    actionType: RuntimeRecoveryActionType;
  }> = [];
  const attemptedSourceScenes = new Set<string>();
  let lastError = `Graph could not reach ${options.expectedSceneId}.`;
  for (let attempt = 0; attempt < options.maxAgentRecoverySteps; attempt += 1) {
    const expectedScene = graph.scenes[options.expectedSceneId];
    if (!expectedScene) {
      return {
        success: false,
        graph,
        evidence,
        graphUpdated,
        error: `Expected Scene does not exist: ${options.expectedSceneId}.`,
      };
    }
    const before = evidence;
    const sourceSceneId = currentMatch?.sceneId;
    if (sourceSceneId && attemptedSourceScenes.has(sourceSceneId)) {
      lastError =
        `Agent recovery already tried one goal-directed action from ${sourceSceneId}; ` +
        "refusing to keep probing the same Scene.";
      break;
    }
    if (sourceSceneId) attemptedSourceScenes.add(sourceSceneId);
    try {
      const choice = await decideSceneRecoveryWithAgent({
        goal: options.goal,
        expectedScene,
        currentSceneId: sourceSceneId,
        nextStep: options.nextStep,
        observation: before,
        viewportWidth: options.viewportWidth,
        viewportHeight: options.viewportHeight,
        previousActions: previousAgentActions,
        cwd: options.agentCwd,
        model: options.model,
        timeoutMs: options.agentTimeoutMs,
        minimumConfidence: options.minimumAgentConfidence,
        agentRunner: options.agentRunner,
      });
      if (!choice) {
        lastError = "Agent found no safe high-confidence recovery action.";
        log(lastError);
        break;
      }
      if (choice.decision.status === "blocked") {
        lastError = `Agent inspected the stable page but found no safe recovery action: ${choice.decision.reason}`;
        log(lastError);
        options.recoveryActions.push({
          recoveryIndex: options.recoveryActions.length,
          reason: sourceSceneId ? options.reason : "scene_unknown",
          goal: options.goal,
          expectedSceneId: options.expectedSceneId,
          sourceSceneId: sourceSceneId ?? "unknown",
          targetSceneId: sourceSceneId ?? "unknown",
          candidateId: "",
          candidateTitle: "",
          actionType: "none",
          command: [],
          agentReason: choice.decision.reason,
          confidence: choice.decision.confidence,
          beforeScreenshotPath: before.screenshotPath,
          beforeUiDumpPath: before.uiDumpPath,
          afterScreenshotPath: evidence.screenshotPath,
          afterUiDumpPath: evidence.uiDumpPath,
          success: false,
          error: lastError,
        });
        break;
      }
      if (choice.decision.status === "at_target") {
        log(
          `Agent recognized ${options.expectedSceneId} at confidence ${choice.decision.confidence.toFixed(2)}: ${choice.decision.reason}`,
        );
        const recognized = await persistAgentSceneRecognition({
          graphPath: options.graphPath,
          graph,
          sceneId: options.expectedSceneId,
          observation: evidence,
          outputDir: options.outputDir,
          patchIndex: options.graphPatchPaths.length,
          deviceProfileId: options.deviceProfileId,
          allowLearning: options.allowLearning,
        });
        graph = recognized.graph;
        graphUpdated ||= recognized.graphUpdated;
        if (recognized.patchPath) {
          options.graphPatchPaths.push(recognized.patchPath);
        }
        options.recoveryActions.push({
          recoveryIndex: options.recoveryActions.length,
          reason: sourceSceneId ? options.reason : "scene_unknown",
          goal: options.goal,
          expectedSceneId: options.expectedSceneId,
          sourceSceneId: sourceSceneId ?? "unknown",
          targetSceneId: options.expectedSceneId,
          candidateId: "",
          candidateTitle: expectedScene.title,
          actionType: "none",
          command: [],
          agentReason: choice.decision.reason,
          confidence: choice.decision.confidence,
          beforeScreenshotPath: before.screenshotPath,
          beforeUiDumpPath: before.uiDumpPath,
          afterScreenshotPath: evidence.screenshotPath,
          afterUiDumpPath: evidence.uiDumpPath,
          success: true,
        });
        return { success: true, graph, evidence, graphUpdated };
      }
      if (!choice.candidate || choice.decision.actionType === "none") {
        lastError = "Agent returned an invalid recovery action.";
        break;
      }
      const command = buildRuntimeRecoveryCommand(
        options.udid,
        choice.candidate,
        choice.decision.actionType,
      );
      log(
        `Agent selected ${choice.decision.actionType} on ${choice.candidate.title} at confidence ${choice.decision.confidence.toFixed(2)}.`,
      );
      const result = await options.commandRunner(command, process.cwd());
      if (result.exitCode !== 0) {
        lastError =
          result.stderr.slice(0, 500) || "Agent recovery command failed.";
      }
      const actionDir = join(
        options.outputDir,
        "runtime-agent-recovery",
        String(options.recoveryActions.length + 1).padStart(2, "0"),
      );
      const stableAfterAgent = await waitForStableGround({
        udid: options.udid,
        outputDir: actionDir,
        prefix: "after",
        previousEvidence: before,
        commandRunner: options.commandRunner,
      });
      evidence = stableAfterAgent.observation;
      await writeFile(
        join(actionDir, "stability.json"),
        JSON.stringify(stableAfterAgent, null, 2),
        "utf8",
      );
      if (result.exitCode !== 0) {
        options.recoveryActions.push({
          recoveryIndex: options.recoveryActions.length,
          reason: sourceSceneId ? options.reason : "scene_unknown",
          goal: options.goal,
          expectedSceneId: options.expectedSceneId,
          sourceSceneId: sourceSceneId ?? "unknown",
          targetSceneId: sourceSceneId ?? "unknown",
          candidateId: choice.candidate.candidateId,
          candidateTitle: choice.candidate.title,
          actionType: choice.decision.actionType,
          command,
          agentReason: choice.decision.reason,
          confidence: choice.decision.confidence,
          beforeScreenshotPath: before.screenshotPath,
          beforeUiDumpPath: before.uiDumpPath,
          afterScreenshotPath: evidence.screenshotPath,
          afterUiDumpPath: evidence.uiDumpPath,
          success: false,
          error: lastError,
        });
        break;
      }
      if (!stableAfterAgent.stable) {
        lastError = "Page did not stabilize after the Agent recovery action.";
        options.recoveryActions.push({
          recoveryIndex: options.recoveryActions.length,
          reason: sourceSceneId ? options.reason : "scene_unknown",
          goal: options.goal,
          expectedSceneId: options.expectedSceneId,
          sourceSceneId: sourceSceneId ?? "unknown",
          targetSceneId: sourceSceneId ?? "unknown",
          candidateId: choice.candidate.candidateId,
          candidateTitle: choice.candidate.title,
          actionType: choice.decision.actionType,
          command,
          agentReason: choice.decision.reason,
          confidence: choice.decision.confidence,
          beforeScreenshotPath: before.screenshotPath,
          beforeUiDumpPath: before.uiDumpPath,
          afterScreenshotPath: evidence.screenshotPath,
          afterUiDumpPath: evidence.uiDumpPath,
          success: false,
          error: lastError,
        });
        break;
      }
      if (runtimeObservationsEquivalent(before, evidence)) {
        lastError = "Agent recovery action produced no observable UI progress.";
        options.recoveryActions.push({
          recoveryIndex: options.recoveryActions.length,
          reason: sourceSceneId ? options.reason : "scene_unknown",
          goal: options.goal,
          expectedSceneId: options.expectedSceneId,
          sourceSceneId: sourceSceneId ?? "unknown",
          targetSceneId: sourceSceneId ?? "unknown",
          candidateId: choice.candidate.candidateId,
          candidateTitle: choice.candidate.title,
          actionType: choice.decision.actionType,
          command,
          agentReason: choice.decision.reason,
          confidence: choice.decision.confidence,
          beforeScreenshotPath: before.screenshotPath,
          beforeUiDumpPath: before.uiDumpPath,
          afterScreenshotPath: evidence.screenshotPath,
          afterUiDumpPath: evidence.uiDumpPath,
          success: false,
          error: lastError,
        });
        break;
      }
      const persisted = await persistRuntimeTransition({
        graphPath: options.graphPath,
        graph,
        sourceSceneId,
        before,
        candidate: choice.candidate,
        actionType: choice.decision.actionType,
        after: evidence,
        outputDir: options.outputDir,
        patchIndex: options.graphPatchPaths.length,
        deviceProfileId: options.deviceProfileId,
        allowLearning: options.allowLearning,
      });
      graph = persisted.graph;
      graphUpdated ||= persisted.graphUpdated;
      options.graphPatchPaths.push(...persisted.patchPaths);
      currentMatch = classifyRuntimeScene(graph, evidence);
      const success = runtimeSceneMatches(
        graph,
        options.expectedSceneId,
        evidence,
      );
      options.recoveryActions.push({
        recoveryIndex: options.recoveryActions.length,
        reason: sourceSceneId ? options.reason : "scene_unknown",
        goal: options.goal,
        expectedSceneId: options.expectedSceneId,
        sourceSceneId: persisted.sourceSceneId,
        targetSceneId: persisted.targetSceneId,
        candidateId: choice.candidate.candidateId,
        candidateTitle: choice.candidate.title,
        actionType: choice.decision.actionType,
        command,
        agentReason: choice.decision.reason,
        confidence: choice.decision.confidence,
        beforeScreenshotPath: before.screenshotPath,
        beforeUiDumpPath: before.uiDumpPath,
        afterScreenshotPath: evidence.screenshotPath,
        afterUiDumpPath: evidence.uiDumpPath,
        success,
        error: result.exitCode === 0 ? undefined : lastError,
      });
      previousAgentActions.push({
        candidateId: choice.candidate.candidateId,
        actionType: choice.decision.actionType,
      });
      if (success) {
        return { success: true, graph, evidence, graphUpdated };
      }
      lastError = `Agent action reached ${persisted.targetSceneId}, not ${options.expectedSceneId}.`;
    } catch (error) {
      lastError = `Agent Scene recovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      break;
    }
  }
  return { success: false, graph, evidence, graphUpdated, error: lastError };
}

function runtimeActionType(
  operationType: string,
): RuntimeRecoveryActionRecord["actionType"] {
  if (operationType === "long_press") return "long_press";
  if (operationType === "swipe") return "swipe_left";
  return "tap";
}

async function resetApp(
  udid: string,
  bundleId: string,
  outputDir: string,
  commandRunner: NonNullable<AppGraphExecInput["commandRunner"]>,
): Promise<void> {
  const result = await commandRunner(
    buildStrictRestartCommand(udid, bundleId),
    process.cwd(),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Strict devicectl restart failed: ${result.stderr.slice(0, 1_000)}`,
    );
  }
  const proof = parseStrictRestartResult(result.stdout);
  await writeFile(
    join(outputDir, "strict-restart-proof.json"),
    JSON.stringify(proof, null, 2),
    "utf8",
  );
  await Bun.sleep(2_500);
}

export function buildStrictRestartCommand(
  udid: string,
  bundleId: string,
): string[] {
  return [
    "python3",
    STRICT_RESTART_SOURCE_PATH,
    "--device",
    udid,
    "--bundle-id",
    bundleId,
  ];
}

export function parseStrictRestartResult(output: string): {
  readonly schemaVersion: "ios-ui-devicectl-restart/v1";
  readonly success: true;
  readonly bundleId: string;
  readonly oldPids: readonly number[];
  readonly newPid: number;
  readonly currentPids: readonly number[];
  readonly executedCommands?: readonly (readonly string[])[];
} {
  const parsed = JSON.parse(output) as {
    schemaVersion?: unknown;
    success?: unknown;
    bundleId?: unknown;
    oldPids?: unknown;
    newPid?: unknown;
    currentPids?: unknown;
    executedCommands?: unknown;
  };
  if (
    parsed.schemaVersion !== "ios-ui-devicectl-restart/v1" ||
    parsed.success !== true ||
    typeof parsed.bundleId !== "string" ||
    !Array.isArray(parsed.oldPids) ||
    !parsed.oldPids.every(Number.isInteger) ||
    !Number.isInteger(parsed.newPid) ||
    !Array.isArray(parsed.currentPids) ||
    !parsed.currentPids.every(Number.isInteger) ||
    (parsed.executedCommands !== undefined &&
      (!Array.isArray(parsed.executedCommands) ||
        !parsed.executedCommands.every(
          (command) =>
            Array.isArray(command) &&
            command.every((argument) => typeof argument === "string"),
        ))) ||
    parsed.oldPids.includes(parsed.newPid as number) ||
    !parsed.currentPids.includes(parsed.newPid as number)
  ) {
    throw new Error("Strict devicectl restart returned invalid PID proof.");
  }
  return parsed as ReturnType<typeof parseStrictRestartResult>;
}

async function captureGround(
  udid: string,
  outputDir: string,
  prefix: string,
  commandRunner: NonNullable<AppGraphExecInput["commandRunner"]>,
): Promise<GroundEvidence> {
  await mkdir(outputDir, { recursive: true });
  const screenshotPath = join(outputDir, `${prefix}-screenshot.png`);
  const uiDumpPath = join(outputDir, `${prefix}-ui-dump.json`);
  const foregroundPath = join(outputDir, `${prefix}-foreground.json`);
  const screenshot = await runGroundCaptureCommand(
    buildMobilecliScreenshotCommand(udid, screenshotPath),
    commandRunner,
  );
  if (screenshot.exitCode !== 0) {
    throw new Error(
      `Screenshot capture failed: ${screenshot.stderr.slice(0, 500)}`,
    );
  }
  const foreground = await runGroundCaptureCommand(
    buildMobilecliForegroundCommand(udid),
    commandRunner,
    3,
    true,
  );
  const dump = await runGroundCaptureCommand(
    buildMobilecliUiDumpCommand(udid),
    commandRunner,
    3,
    true,
  );
  if (foreground.exitCode !== 0 || !foreground.stdout.trim()) {
    throw new Error(
      `Foreground capture failed: ${foreground.stderr.slice(0, 500) || "empty bundle"}`,
    );
  }
  if (dump.exitCode !== 0 || !dump.stdout.trim()) {
    throw new Error(
      `UI dump capture failed: ${dump.stderr.slice(0, 500) || "empty UI dump"}`,
    );
  }
  await writeFile(uiDumpPath, dump.stdout, "utf8");
  const foregroundApp = parseForegroundApp(foreground.stdout);
  const foregroundBundleId = foregroundApp.bundleId;
  await writeFile(
    foregroundPath,
    JSON.stringify(
      { foregroundBundleId, appVersion: foregroundApp.appVersion },
      null,
      2,
    ),
    "utf8",
  );
  return {
    screenshotPath,
    uiDumpPath,
    foregroundPath,
    foregroundBundleId,
    foregroundAppVersion: foregroundApp.appVersion,
    uiElements: parseUiDump(dump.stdout),
  };
}

export function parseInstalledAppVersion(
  output: string,
  bundleId: string,
): string | undefined {
  try {
    const parsed = JSON.parse(output) as {
      readonly data?: readonly {
        readonly packageName?: unknown;
        readonly version?: unknown;
      }[];
    };
    const app = parsed.data?.find(
      (candidate) => candidate.packageName === bundleId,
    );
    return typeof app?.version === "string"
      ? app.version.trim() || undefined
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseForegroundApp(output: string): {
  readonly bundleId: string;
  readonly appVersion?: string;
} {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed) as {
      readonly data?: {
        readonly packageName?: unknown;
        readonly version?: unknown;
      };
    };
    const bundleId =
      typeof parsed.data?.packageName === "string"
        ? parsed.data.packageName.trim()
        : "";
    if (bundleId) {
      return {
        bundleId,
        appVersion:
          typeof parsed.data?.version === "string"
            ? parsed.data.version.trim() || undefined
            : undefined,
      };
    }
  } catch {
    // Older mobilecli versions may return only the bundle identifier.
  }
  return { bundleId: trimmed };
}

export async function runGroundCaptureCommand(
  command: readonly string[],
  commandRunner: NonNullable<AppGraphExecInput["commandRunner"]>,
  maximumAttempts = 3,
  requireOutput = false,
): Promise<
  Awaited<ReturnType<NonNullable<AppGraphExecInput["commandRunner"]>>>
> {
  let lastResult: Awaited<
    ReturnType<NonNullable<AppGraphExecInput["commandRunner"]>>
  > | null = null;
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
  return (
    lastResult ?? {
      stdout: "",
      stderr: `Capture command did not run: ${command.join(" ")}`,
      exitCode: 1,
    }
  );
}

async function waitForStableGround(options: {
  readonly udid: string;
  readonly outputDir: string;
  readonly prefix: string;
  readonly previousEvidence?: GroundEvidence;
  readonly requireChangeFromPrevious?: boolean;
  readonly commandRunner: NonNullable<AppGraphExecInput["commandRunner"]>;
}): Promise<StableObservationResult<GroundEvidence>> {
  return waitForStableObservation({
    previousObservation: options.previousEvidence,
    requireChangeFromPrevious:
      options.requireChangeFromPrevious ?? Boolean(options.previousEvidence),
    capture: (sampleIndex) =>
      captureGround(
        options.udid,
        options.outputDir,
        `${options.prefix}-${String(sampleIndex).padStart(2, "0")}`,
        options.commandRunner,
      ),
    describe: (observation) => observation,
    acceptStable: groundObservationReady,
    maximumSamples: MAX_SCENE_SETTLE_SAMPLES,
    requiredConsecutiveMatches: REQUIRED_STABLE_SAMPLES,
    pollMs: SCENE_SETTLE_POLL_MS,
  });
}

function groundObservationReady(observation: GroundEvidence): boolean {
  const text = observation.uiElements
    .flatMap((element) => [element.label, element.text, element.value])
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return !/加载中|正在加载|loading|请稍候|please wait/i.test(text);
}

function resolveSelectorMatchesByPriority(
  elements: readonly UiElement[],
  selectors: readonly SelectorEntry[],
  priority: readonly SelectorEntry["type"][],
): UiElement[] {
  const hasSemanticSelector = selectors.some(
    (selector) => selector.type !== "role",
  );
  for (const selectorType of priority) {
    if (selectorType === "role" && hasSemanticSelector) continue;
    for (const selector of selectors.filter(
      (candidate) => candidate.type === selectorType,
    )) {
      const uiSelector = selectorEntryToUiSelector(selector);
      const matches = elements.filter((element) =>
        uiElementMatchesSelector(element, uiSelector),
      );
      if (matches.length > 0) return matches;
    }
  }
  return [];
}

function uiElementMatchesSelector(
  element: UiElement,
  selector: UiSelector,
): boolean {
  if (selector.accessibilityId) {
    return stableTextVariantMatches(
      element.accessibilityId ?? "",
      selector.accessibilityId,
    );
  }
  if (selector.label) {
    return stableTextVariantMatches(element.label ?? "", selector.label);
  }
  if (selector.text) {
    return [element.text, element.label, element.value].some((value) =>
      stableTextVariantMatches(value ?? "", selector.text ?? ""),
    );
  }
  if (selector.value) {
    return stableTextVariantMatches(element.value ?? "", selector.value);
  }
  if (selector.role) {
    return normalizeText(element.role ?? "") === normalizeText(selector.role);
  }
  return false;
}

function stableTextVariantMatches(actual: string, expected: string): boolean {
  const normalizedActual = normalizeText(actual);
  const normalizedExpected = normalizeText(expected);
  if (!normalizedExpected || !normalizedActual.startsWith(normalizedExpected)) {
    return false;
  }
  if (normalizedActual === normalizedExpected) return true;
  return /^[\s·•|/／\-—–:：]/.test(
    normalizedActual.slice(normalizedExpected.length),
  );
}

function selectPreferredTargetMatch(
  matches: readonly UiElement[],
  step: ResolvedStep,
  viewportWidth: number,
  viewportHeight: number,
): UiElement | null {
  const visible = matches.filter((element) =>
    Boolean(
      element.bounds &&
      pointWithinViewport(
        centerOfBounds(element.bounds),
        viewportWidth,
        viewportHeight,
      ),
    ),
  );
  if (visible.length === 0) return null;
  const onlyTopCoordinateShadows =
    visible.every((element) => {
      const center = centerOfBounds(element.bounds!);
      return center.y < viewportHeight * 0.2;
    }) &&
    matches.some((element) => {
      if (!element.bounds) return false;
      return centerOfBounds(element.bounds).y >= viewportHeight;
    });
  if (onlyTopCoordinateShadows) return null;
  const byArea = [...visible].sort((left, right) => {
    const leftArea = left.bounds ? left.bounds.width * left.bounds.height : 0;
    const rightArea = right.bounds
      ? right.bounds.width * right.bounds.height
      : 0;
    return rightArea - leftArea;
  });
  if (
    byArea.length > 1 &&
    byArea.every((candidate) =>
      uiBoundsOverlap(byArea[0]!.bounds!, candidate.bounds!),
    )
  ) {
    return byArea[0]!;
  }
  const band = expectedTargetBand(step);
  const scored = visible
    .map((element) => ({
      element,
      score: locationBandScore(element, band, viewportWidth, viewportHeight),
    }))
    .sort((left, right) => right.score - left.score);
  const first = scored[0];
  const second = scored[1];
  if (!first || (second && second.score === first.score)) return null;
  return first.element;
}

function uiBoundsOverlap(
  left: NonNullable<UiElement["bounds"]>,
  right: NonNullable<UiElement["bounds"]>,
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

function expectedTargetBand(
  step: ResolvedStep,
): "top" | "middle" | "bottom" | null {
  const region = step.targetElement?.locationHint?.region ?? "";
  if (region.startsWith("top")) return "top";
  if (region.startsWith("bottom")) return "bottom";
  if (region.includes("center") || region.includes("middle")) return "middle";
  return null;
}

function locationBandScore(
  element: UiElement,
  band: ReturnType<typeof expectedTargetBand>,
  viewportWidth: number,
  viewportHeight: number,
): number {
  if (!element.bounds) return Number.NEGATIVE_INFINITY;
  const center = centerOfBounds(element.bounds);
  const horizontalCenter = 1 - Math.abs(center.x / viewportWidth - 0.5);
  const vertical = center.y / viewportHeight;
  if (band === "top") return (1 - vertical) * 10 + horizontalCenter;
  if (band === "bottom") return vertical * 10 + horizontalCenter;
  if (band === "middle")
    return (1 - Math.abs(vertical - 0.5)) * 10 + horizontalCenter;
  return horizontalCenter;
}

function selectorEntryToUiSelector(selector: SelectorEntry): UiSelector {
  if (selector.type === "accessibilityIdentifier") {
    return { accessibilityId: selector.value };
  }
  return { [selector.type]: selector.value };
}

function visuallyMatches(element: UiElement, step: ResolvedStep): boolean {
  const title = normalizeText(step.targetElement?.title ?? "");
  const role = normalizeText(step.targetElement?.semanticRole ?? "");
  const values = [
    element.accessibilityId,
    element.label,
    element.text,
    element.value,
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeText);
  const titleMatched =
    Boolean(title) && values.some((value) => value === title);
  const roleMatched = !role || normalizeText(element.role ?? "") === role;
  return titleMatched && roleMatched;
}

function verifyExpectedScene(
  step: ResolvedStep,
  evidence: GroundEvidence,
  graph: AppGraph,
  before?: GroundEvidence,
): boolean {
  const expected = step.expectedOutcome.scene;
  if (!expected) return true;
  if (
    step.operation.type === "swipe" &&
    step.fromSceneId === step.toSceneId &&
    expected.sceneId === step.fromSceneId &&
    before &&
    !runtimeObservationsEquivalent(before, evidence)
  ) {
    const scene = graph.scenes[expected.sceneId];
    const expectedBundle = scene?.foregroundBundleId ?? graph.bundleId;
    return evidence.foregroundBundleId.includes(expectedBundle);
  }
  return sceneMatches(expected.sceneId, evidence, graph);
}

function sceneMatches(
  sceneId: string,
  evidence: GroundEvidence,
  graph: AppGraph,
): boolean {
  return runtimeSceneMatches(graph, sceneId, evidence);
}

function evaluateFinalOracles(
  oracles: readonly TaskOracle[],
  evidence: GroundEvidence,
  graph: AppGraph,
  agentConfirmedSceneIds: ReadonlySet<string>,
): FinalOracleResult[] {
  const observed = observedTexts(evidence.uiElements);
  return oracles.map((oracle) => {
    let success = false;
    let supported = true;
    let expected =
      oracle.value ?? oracle.sceneId ?? oracle.bundleId ?? oracle.type;
    let actual = observed.join(" | ");
    if (oracle.type === "foreground_bundle") {
      success =
        Boolean(oracle.bundleId) &&
        evidence.foregroundBundleId.includes(oracle.bundleId!);
      actual = evidence.foregroundBundleId;
    } else if (oracle.type === "scene_current") {
      success =
        Boolean(oracle.sceneId) &&
        (sceneMatches(oracle.sceneId!, evidence, graph) ||
          agentConfirmedSceneIds.has(oracle.sceneId!));
      actual = success ? oracle.sceneId! : "scene_not_matched";
    } else if (
      oracle.type === "text_visible" ||
      oracle.type === "ui_text_visible"
    ) {
      const value = normalizeText(oracle.value ?? "");
      success = Boolean(value) && observed.some((item) => item.includes(value));
    } else if (
      oracle.type === "text_absent" ||
      oracle.type === "ui_text_absent"
    ) {
      const value = normalizeText(oracle.value ?? "");
      success =
        Boolean(value) && !observed.some((item) => item.includes(value));
    } else if (
      oracle.type === "all_text_visible" ||
      oracle.type === "any_text_visible"
    ) {
      const values = (oracle.values ?? []).map(normalizeText).filter(Boolean);
      expected = values.join(" | ");
      success =
        values.length > 0 &&
        (oracle.type === "all_text_visible"
          ? values.every((value) =>
              observed.some((item) => item.includes(value)),
            )
          : values.some((value) =>
              observed.some((item) => item.includes(value)),
            ));
    } else {
      supported = false;
      expected = `${oracle.type} requires visual evidence`;
      actual = "unsupported_by_deterministic_exec";
    }
    return { type: oracle.type, supported, success, expected, actual };
  });
}

async function writeDiscoveryRequest(options: {
  outputDir: string;
  goal: string;
  plan: AppGraphPlanResult;
  graph: AppGraph;
  step: ResolvedStep;
  record: ExecStepRecord;
  evidence: GroundEvidence;
}): Promise<string> {
  const path = join(options.outputDir, "discovery-request.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        schemaVersion: "app-graph-discovery-request/v1",
        goal: options.goal,
        graphIdentity: currentGraphIdentity(options.plan, options.graph),
        failedStep: options.step,
        failure: options.record.error ?? "Expected outcome was not observed.",
        startSceneId: options.step.fromSceneId,
        focusElementId: options.step.targetElement?.elementId,
        evidencePaths: [
          options.evidence.screenshotPath,
          options.evidence.uiDumpPath,
          options.evidence.foregroundPath,
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return path;
}

async function writeSceneDiscoveryRequest(options: {
  outputDir: string;
  goal: string;
  plan: AppGraphPlanResult;
  graph: AppGraph;
  expectedSceneId: string;
  evidence: GroundEvidence;
  failure: string;
}): Promise<string> {
  const path = join(options.outputDir, "discovery-request.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        schemaVersion: "app-graph-discovery-request/v1",
        goal: options.goal,
        graphIdentity: currentGraphIdentity(options.plan, options.graph),
        failure: options.failure,
        startSceneId: options.expectedSceneId,
        evidencePaths: [
          options.evidence.screenshotPath,
          options.evidence.uiDumpPath,
          options.evidence.foregroundPath,
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return path;
}

function currentGraphIdentity(
  plan: AppGraphPlanResult,
  graph: AppGraph,
): AppGraphPlanResult["graphIdentity"] {
  return {
    graphId: graph.graphId,
    schemaVersion: graph.schemaVersion,
    revision: graph.revision,
    updatedAt: graph.updatedAt,
    appVersion: graph.appVersion ?? plan.graphIdentity.appVersion,
  };
}

function observedTexts(elements: readonly UiElement[]): string[] {
  return [
    ...new Set(
      elements
        .flatMap((element) => [
          element.accessibilityId,
          element.label,
          element.text,
          element.value,
        ])
        .filter((value): value is string => Boolean(value))
        .map(normalizeText)
        .filter(Boolean),
    ),
  ];
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function pointText(point: { readonly x: number; readonly y: number }): string {
  return `${Math.round(point.x)},${Math.round(point.y)}`;
}

function fail(options: {
  outputDir: string;
  goal: string;
  code: string;
  message: string;
  recoverable: boolean;
  partialSteps?: readonly ExecStepRecord[];
  discoveryRequestPath?: string;
  recoveryActions?: readonly RuntimeRecoveryActionRecord[];
  graphUpdated?: boolean;
  graphPatchPaths?: readonly string[];
  graphAppVersion?: string;
  runtimeAppVersion?: string;
  taskHealth?: string;
  taskHealthReasons?: readonly string[];
}): AppGraphExecFailure {
  return {
    success: false,
    mode: "exec_failure",
    outputDir: options.outputDir,
    goal: options.goal,
    code: options.code,
    message: options.message,
    recoverable: options.recoverable,
    evidencePaths: options.discoveryRequestPath
      ? [options.discoveryRequestPath]
      : [],
    partialSteps: options.partialSteps,
    discoveryRequestPath: options.discoveryRequestPath,
    recoveryActions: options.recoveryActions,
    graphUpdated: options.graphUpdated,
    graphPatchPaths: options.graphPatchPaths,
    graphAppVersion: options.graphAppVersion,
    runtimeAppVersion: options.runtimeAppVersion,
    taskHealth: options.taskHealth,
    taskHealthReasons: options.taskHealthReasons,
  };
}

function execResult(options: {
  outputDir: string;
  goal: string;
  plan: AppGraphPlanResult;
  planOnly: boolean;
  verdict: AppGraphExecResult["verdict"];
  verdictReason: string;
  steps: readonly ExecStepRecord[];
  totalDurationMs: number;
  graphRevision: number;
  graphAppVersion?: string;
  runtimeAppVersion?: string;
  taskHealth?: string;
  taskHealthReasons?: readonly string[];
  finalOracleResults: readonly FinalOracleResult[];
  recoveryActions: readonly RuntimeRecoveryActionRecord[];
  graphUpdated: boolean;
  graphPatchPaths: readonly string[];
  learningPatchPath?: string;
  discoveryRequestPath?: string;
  evidencePaths: readonly string[];
  executionMode?: AppGraphExecResult["executionMode"];
  fastFallbackUsed?: boolean;
}): AppGraphExecResult {
  return {
    success: options.verdict === "pass",
    mode: "exec",
    planOnly: options.planOnly,
    outputDir: options.outputDir,
    goal: options.goal,
    matchedTaskId: options.plan.matchedTaskId,
    verdict: options.verdict,
    verdictReason: options.verdictReason,
    executionMode: options.executionMode,
    fastFallbackUsed: options.fastFallbackUsed,
    steps: options.steps,
    totalDurationMs: options.totalDurationMs,
    graphRevision: options.graphRevision,
    graphAppVersion: options.graphAppVersion,
    runtimeAppVersion: options.runtimeAppVersion,
    taskHealth: options.taskHealth,
    taskHealthReasons: options.taskHealthReasons,
    planSchemaVersion: options.plan.schemaVersion,
    planPath: options.plan.planPath,
    finalOracleResults: options.finalOracleResults,
    recoveryActions: options.recoveryActions,
    graphUpdated: options.graphUpdated,
    graphPatchPaths: options.graphPatchPaths,
    learningPatchPath: options.learningPatchPath,
    discoveryRequestPath: options.discoveryRequestPath,
    evidencePaths: options.evidencePaths,
  };
}
