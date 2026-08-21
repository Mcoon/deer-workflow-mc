import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import { applyAndSave, loadGraph } from "../ios-ui-graph-manager";
import {
  buildStrictRestartCommand,
  parseStrictRestartResult,
} from "../app-graph-exec/workflow";
import {
  buildMobilecliScreenshotCommand,
  buildMobilecliUiDumpCommand,
  parseUiDump,
  runCommand,
} from "../ios-regression-kit";
import type { CommandResult } from "../ios-regression-kit";
import type { UiElement } from "../ios-regression-kit/types";
import { buildHorizontalVisibilityRecoveryCommands } from "../app-graph-exec/visibility-recovery";

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

const DEFAULT_OUTPUT_ROOT = "/tmp/ios_perf-opt/app-graph-discovery";
const DEFAULT_GRAPH_PATH = resolve(
  dirname(import.meta.path),
  "../ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);
const DEFAULT_BUNDLE_ID = "com.bot.doubao";
const DEFAULT_MAX_DEPTH = 0;
const DEFAULT_MAX_ACTIONS = 1;
const SETTLE_MS = 900;
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
  const discoveryPlan = buildDiscoveryPlan({
    graph,
    goal,
    requestPath,
    request,
    startSceneId,
    focusElementId,
    allowStaleFocus: args.allowStaleFocus,
    expectedSceneId: args.expectedSceneId,
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
  let currentObservation = await captureObservation(
    udid,
    outputDir,
    "start",
    startSceneId,
  );

  for (const candidate of discoveryPlan.candidates) {
    let element = resolveDiscoveryElement(
      currentObservation.elements,
      candidate.elementId,
      candidate.selectors,
    );
    if (!element && args.allowStaleFocus) {
      const recoveryCommands = buildHorizontalVisibilityRecoveryCommands({
        graph,
        sceneId: startSceneId,
        focusElementId: candidate.elementId,
        udid,
        maxAttempts: 3,
      });
      for (const [index, command] of recoveryCommands.entries()) {
        log(
          `Visibility recovery ${index + 1}/${recoveryCommands.length}: ${command.join(" ")}`,
        );
        const recovery = await runCommand(command, process.cwd());
        if (recovery.exitCode !== 0) break;
        await Bun.sleep(SETTLE_MS);
        currentObservation = await captureObservation(
          udid,
          outputDir,
          `visibility-${String(index + 1).padStart(2, "0")}`,
          startSceneId,
        );
        element = resolveDiscoveryElement(
          currentObservation.elements,
          candidate.elementId,
          candidate.selectors,
        );
        if (element) break;
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
      await Bun.sleep(SETTLE_MS);

      const afterObs = await captureObservation(
        udid,
        actionDir,
        "after",
        next.sceneId,
      );

      const sceneChanged = detectSceneChange(beforeObs, afterObs);

      if (execSuccess && sceneChanged) {
        const expectedScene = args.expectedSceneId
          ? graph.scenes[args.expectedSceneId]
          : undefined;
        const newSceneId =
          expectedScene &&
          discoveryObservationMatchesScene(afterObs, expectedScene)
            ? expectedScene.sceneId
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
              Boolean(args.expectedSceneId) &&
              newSceneId === args.expectedSceneId,
          });
          operatorsDiscovered++;

          // Capture every visible Element on the newly observed page, but do
          // not click any of them automatically. A later goal/Plan may select
          // one explicit Element for another targeted probe.
          elementsDiscovered += afterObs.elements.length;
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

  phase("Synthesize");
  log(
    `Synthesizing: ${scenesDiscovered} scenes, ${elementsDiscovered} elements, ${operatorsDiscovered} operators`,
  );
  log(`Total actions: ${actionsExecuted}`);
  if (
    args.expectedSceneId &&
    !discoveredTransitions.some(
      (transition) => transition.targetSceneId === args.expectedSceneId,
    )
  ) {
    return discoveryFailure({
      outputDir,
      code: "stale_scene_not_observed",
      message: `The historical entry did not reproduce stale Scene ${args.expectedSceneId}.`,
      recoverable: true,
      evidencePaths: [discoveryPlanPath],
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
    totalDurationMs,
    patchPath,
    graphRevision: graph.revision + (graphUpdated ? 1 : 0),
    graphUpdated,
    evidencePaths: [
      ...discoveryPlan.evidencePaths,
      discoveryPlanPath,
      ...(patchPath ? [patchPath] : []),
    ],
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

  const screenshotCmd = buildMobilecliScreenshotCommand(udid, screenshotPath);
  await runDiscoveryCaptureCommand(screenshotCmd);

  const uiDumpCmd = buildMobilecliUiDumpCommand(udid);
  const dumpResult = await runDiscoveryCaptureCommand(uiDumpCmd);
  await writeFile(uiDumpPath, dumpResult.stdout, "utf8");

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
    elements,
    timestamp: new Date().toISOString(),
  };
}

export async function runDiscoveryCaptureCommand(
  command: readonly string[],
  commandRunner: (
    command: readonly string[],
    cwd?: string,
  ) => Promise<CommandResult> = runCommand,
  maximumAttempts = 3,
): Promise<CommandResult> {
  let lastResult: CommandResult | undefined;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    lastResult = await commandRunner(command, process.cwd());
    if (lastResult.exitCode === 0) return lastResult;
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
    }
  }
  return null;
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
      const sourceScene = options.graph.scenes[transition.sourceSceneId];
      const sourceElement = sourceScene?.elements[transition.sourceElementId];
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
    }
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
}): AppGraphDiscoveryOutput {
  return {
    success: false,
    mode: "discovery_failure",
    outputDir: options.outputDir,
    code: options.code,
    message: options.message,
    recoverable: options.recoverable,
    evidencePaths: options.evidencePaths,
  };
}
