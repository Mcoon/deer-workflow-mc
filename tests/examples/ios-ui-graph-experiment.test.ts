import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import graphJson from "../../examples/ios-ui-graph-experiment/graph.json";
import fullGraphJson from "../../examples/ios-ui-graph-experiment/graph-chat-full.json";
import {
  buildSemanticCards,
  applyOperatorExecutionOutcome,
  classifyVerifierOutcome,
  compileOperatorStep,
  compileExperimentPlan,
  classifyTargetedDiscoveryScene,
  deterministicTargetedDiscoveryCompletion,
  deriveHorizontalGestureCandidates,
  evaluateVerifierAssertions,
  findVerifiedEntryRecoveryOperators,
  findDeterministicReplayCompletion,
  isStableIdentityText,
  isPlannableOperator,
  isRetryableDiscoveryCaptureFailure,
  matchesVisibleTextOracle,
  operatorExecutionTier,
  parseInstalledAppVersion,
  parseStrictRestartResult,
  parseWaitLaunchResult,
  meta,
  recognizeScene,
  recognizeSceneByVisualText,
  resolveSemanticGoal,
  selectDiscoveryUiElements,
  persistCandidateTask,
  promoteCandidateReplay,
  persistTaskVerifier,
  persistTargetedDiscoveryGraphPatch,
  targetedDiscoverySemanticPrefix,
  targetedDiscoverySafetyIssue,
  validateGraphSynthesisProposal,
  verifyTargetedDiscoveryCompletion,
  writeDiscoveryArtifacts,
} from "../../examples/ios-ui-graph-experiment/workflow";

import type { AgentFunction } from "@deerwork-ai/deer-workflow/agents";
import type { AgentOptions } from "@deerwork-ai/deer-workflow/agents";
import type { WorkflowEvent } from "@deerwork-ai/deer-workflow/events";
import { WorkflowRunner } from "@deerwork-ai/deer-workflow/runner";
import type {
  ExecutableUiGraphExperiment,
  ExperimentVerifierSpec,
  IosUiGraphExperimentResult,
  IosUiGraphWorkflowFailureResult,
  IosUiTargetedDiscoveryResult,
  TargetedDiscoveryAction,
  TargetedDiscoveryObservation,
} from "../../examples/ios-ui-graph-experiment/types";

const graph = graphJson as ExecutableUiGraphExperiment;
const fullGraph = fullGraphJson as unknown as ExecutableUiGraphExperiment;
type WorkflowResult =
  | IosUiGraphExperimentResult
  | IosUiTargetedDiscoveryResult
  | IosUiGraphWorkflowFailureResult;
const workflowPath = join(
  process.cwd(),
  "examples/ios-ui-graph-experiment/workflow.ts",
);

describe("iOS UI executable graph experiment", () => {
  test("returns and persists a structured JSON result for unexpected Workflow failures", async () => {
    const outputDir = await mkdtemp(
      join(tmpdir(), "ios-ui-graph-failure-result-"),
    );
    const runner = new WorkflowRunner({ logWriter: () => {} });
    const events: WorkflowEvent[] = [];
    const removeListener = runner.on((event) => events.push(event));
    try {
      const result = await runner.run<WorkflowResult>(workflowPath, {
        graphPath: join(outputDir, "missing-graph.json"),
        outputDir,
        goal: "打开设置页面",
        planOnly: true,
      });
      const persisted = JSON.parse(
        await readFile(join(outputDir, "result.json"), "utf8"),
      ) as typeof result;

      expect(result).toEqual(persisted);
      expect(result).toMatchObject({
        success: false,
        mode: "workflow_failure",
        planOnly: true,
        outputDir,
        resultPath: join(outputDir, "result.json"),
        failure: {
          code: "load_failed",
          stage: "Load",
          recoverable: false,
        },
      });
      expect(result.failure?.message.length).toBeGreaterThan(0);
      expect(events.at(-1)?.type).toBe("workflow:end");
      expect(
        events.some((event) => event.type === "workflow:error"),
      ).toBeFalse();
    } finally {
      removeListener();
      runner.dispose();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("returns a structured targeted-discovery result when replay verification fails", async () => {
    const outputDir = await mkdtemp(
      join(tmpdir(), "ios-ui-graph-replay-failure-"),
    );
    const graphPath = join(outputDir, "graph.json");
    const sourcePath = join(outputDir, "source-discovery-result.json");
    const replayOutputDir = join(outputDir, "replay");
    const runner = new WorkflowRunner({ logWriter: () => {} });
    const observation = makeDiscoveryObservation("observation-00", [
      ["ui-title", "ui_dump", "字号与背景"],
    ]);
    await Promise.all([
      writeFile(graphPath, JSON.stringify(graph), "utf8"),
      writeFile(
        sourcePath,
        JSON.stringify({
          success: false,
          mode: "targeted_discovery",
          outputDir,
          graphPath,
          graphGapPath: join(outputDir, "graph-gap.json"),
          discoveryPacketPath: join(outputDir, "discovery-packet.json"),
          resultPath: sourcePath,
          goalResolution: {
            mode: "agent_discovery",
            resolutionType: "discovery_required",
            goal: "将字号设置成最大",
            parameters: {},
            confidence: 0.9,
            reason: "Replay fixture.",
            durationMs: 1,
          },
          initialGrounding: {
            matchedSceneId: "chat.detail",
            matchedBy: "ui_dump_anchors",
            durationMs: 1,
          },
          observations: [observation],
          actions: [],
          commands: [],
          completionEvidence: ["Fixture claims completion."],
          completionOracle: {
            type: "text_visible",
            value: "重启生效 && 新的字体大小在重启后生效",
          },
          issue: "Fixture did not complete.",
        }),
        "utf8",
      ),
    ]);

    try {
      const result = await runner.run<WorkflowResult>(workflowPath, {
        graphPath,
        outputDir: replayOutputDir,
        replayDiscoveryResultPath: sourcePath,
      });
      const persisted = JSON.parse(
        await readFile(
          join(replayOutputDir, "replayed-discovery-result.json"),
          "utf8",
        ),
      ) as typeof result;

      expect(result).toEqual(persisted);
      expect(result).toMatchObject({
        success: false,
        mode: "targeted_discovery",
        failure: {
          code: "replay_completion_verification_failed",
          stage: "Verify",
          recoverable: true,
        },
      });
    } finally {
      runner.dispose();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("declares grounding, fast execution, and final verification phases", () => {
    expect(meta.name).toBe("ios-ui-graph-experiment");
    expect(meta.phases.map((phase) => phase.title)).toEqual([
      "Load",
      "Resolve",
      "Plan",
      "Evaluate Agent",
      "Preflight",
      "Reset",
      "Ground",
      "Recover Entry",
      "Discover",
      "Synthesize Graph",
      "Refresh Map",
      "Execute",
      "Verify",
      "Report",
    ]);
  });

  test("retries only transient mobilecli capture transport failures", () => {
    expect(
      isRetryableDiscoveryCaptureFailure(
        'RPC call device.dump.ui failed: Post "http://localhost:8100/rpc": EOF',
      ),
    ).toBe(true);
    expect(
      isRetryableDiscoveryCaptureFailure(
        "Error accepting new connection: use of closed network connection",
      ),
    ).toBe(true);
    expect(
      isRetryableDiscoveryCaptureFailure(
        "error reading dtx connection unexpected EOF",
      ),
    ).toBe(true);
    expect(isRetryableDiscoveryCaptureFailure("device is not connected")).toBe(
      false,
    );
  });

  test("keeps visible lower-page controls when the UI tree exceeds the candidate limit", () => {
    const crowdedTop = Array.from({ length: 120 }, (_, index) => ({
      role: "StaticText",
      label: `顶部元素 ${index}`,
      bounds: { x: 16, y: 40 + (index % 20), width: 120, height: 20 },
    }));
    const faq = {
      role: "StaticText",
      label: "豆包购物及钱包功能FAQ",
      bounds: { x: 16, y: 711, width: 186, height: 20 },
    };

    const selected = selectDiscoveryUiElements([...crowdedTop, faq], 896, 100);

    expect(selected).toContain(faq);
    expect(selected).toHaveLength(100);
  });

  test("compiles verified profile bindings into a three-step fast plan", () => {
    const task = graph.tasks.find(
      (candidate) => candidate.taskId === "message.send_text",
    );
    expect(task).toBeDefined();

    const plan = compileExperimentPlan({
      graph,
      task: task!,
      parameters: { text: "graph实验" },
      udid: "device-1",
      allowCandidate: true,
    });

    expect(plan.steps).toHaveLength(3);
    expect(plan.steps.map((step) => step.operatorId)).toEqual([
      "chat.focus_composer",
      "chat.set_draft_text",
      "chat.submit_text_message",
    ]);
    expect(plan.steps[0]?.command).toEqual([
      "mobilecli",
      "io",
      "tap",
      "--device",
      "device-1",
      "184,822",
    ]);
    expect(plan.steps[1]?.command).toEqual([
      "mobilecli",
      "io",
      "text",
      "--device",
      "device-1",
      "graph实验",
    ]);
    expect(plan.steps[2]?.command).toEqual([
      "mobilecli",
      "io",
      "tap",
      "--device",
      "device-1",
      "361,795",
    ]);
    expect(plan.referenceAssets).toHaveLength(2);
    expect(plan.referenceAssets[0]?.screenshotPath).toContain(
      "chat_detail.png",
    );
  });

  test("keeps reference screenshots out of semantic cards unless requested", () => {
    const semanticOnly = buildSemanticCards(graph, false);
    const withReferences = buildSemanticCards(graph, true);

    expect(
      semanticOnly.every((card) => card.referenceAssets === undefined),
    ).toBeTrue();
    expect(
      withReferences.some(
        (card) =>
          card.referenceAssets?.some((asset) =>
            asset.screenshotPath?.endsWith("chat_detail.png"),
          ) === true,
      ),
    ).toBeTrue();
  });

  test("grounds chat scenes from deterministic anchors without screenshots", () => {
    expect(
      recognizeScene(
        graph,
        [
          {
            role: "StaticText",
            label: "发消息或按住说话...",
            bounds: { x: 66, y: 810, width: 236, height: 24 },
          },
        ],
        "chat.detail",
      ),
    ).toBe("chat.detail");

    expect(
      recognizeScene(
        graph,
        [
          {
            role: "Button",
            accessibilityId: "Send",
            label: "发送",
            bounds: { x: 310, y: 770, width: 102, height: 49 },
          },
        ],
        "chat.detail.keyboard",
      ),
    ).toBe("chat.detail.keyboard");
  });

  test("grounds the chat scene from visual text anchors compiled from references", () => {
    expect(
      recognizeSceneByVisualText(
        graph,
        ["豆包", "发消息或按住说话…", "快速", "AI 创作"],
        "chat.detail",
      ),
    ).toBe("chat.detail");
  });

  test("does not let short generic visual anchors match longer unrelated text", () => {
    expect(
      recognizeSceneByVisualText(
        fullGraph,
        ["选择对话", "删除", "取消"],
        "photo.preview",
      ),
    ).not.toBe("photo.preview");
  });

  test("normalizes OCR chevrons when recognizing the chat Scene", () => {
    expect(
      recognizeSceneByVisualText(
        fullGraph,
        ["豆包〉", "发消息或按住说话…", "AI 生成可能有误"],
        "chat.detail",
      ),
    ).toBe("chat.detail");
  });

  test("compiles every verified full chat Task in verified-only mode", () => {
    const parametersByTask: Record<string, Record<string, string>> = {
      "message.send_text": { text: "hello" },
      "photo.capture_and_ask": { question: "这是什么？" },
      "photo.select_only": {},
      "chat.load_more": {},
      "chat.enable_auto_read": {},
      "bot.open_settings": {},
    };

    const requiredTaskIds = [
      "message.send_text",
      "photo.capture_and_ask",
      "photo.select_only",
      "chat.load_more",
      "chat.enable_auto_read",
      "bot.open_settings",
    ];
    expect(
      requiredTaskIds.every((taskId) =>
        fullGraph.tasks.some((task) => task.taskId === taskId),
      ),
    ).toBeTrue();
    for (const task of fullGraph.tasks.filter(
      (candidate) => candidate.status === "verified",
    )) {
      const plan = compileExperimentPlan({
        graph: fullGraph,
        task,
        parameters: parametersByTask[task.taskId] ?? {},
        udid: "device-1",
        allowCandidate: false,
      });
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(
        plan.steps.every((step) => step.command[0] === "mobilecli"),
      ).toBeTrue();
    }
  });

  test("compiles the load-more gesture using the verified inverted-list direction", () => {
    const task = fullGraph.tasks.find(
      (candidate) => candidate.taskId === "chat.load_more",
    );
    expect(task).toBeDefined();
    const plan = compileExperimentPlan({
      graph: fullGraph,
      task: task!,
      parameters: {},
      udid: "device-1",
      allowCandidate: false,
    });
    expect(plan.steps[0]?.command).toEqual([
      "mobilecli",
      "io",
      "swipe",
      "--device",
      "device-1",
      "207,240,207,690",
    ]);
  });

  test("compiles state-preconditioned Operators only after prior state effects", () => {
    const task = fullGraph.tasks.find(
      (candidate) => candidate.taskId === "chat.actionbar_scroll_end",
    );
    expect(task).toBeDefined();
    expect(
      compileExperimentPlan({
        graph: fullGraph,
        task: task!,
        parameters: {},
        udid: "test-device",
        allowCandidate: true,
      }).steps,
    ).toHaveLength(3);

    const invalidTask = {
      ...task!,
      operatorIds: task!.operatorIds.slice(1),
    };
    expect(() =>
      compileExperimentPlan({
        graph: fullGraph,
        task: invalidTask,
        parameters: {},
        udid: "test-device",
        allowCandidate: true,
      }),
    ).toThrow("unsatisfied state preconditions");
  });

  test("automatically bridges a Task to the next Operator entry Scene", () => {
    const task = fullGraph.tasks.find(
      (candidate) => candidate.taskId === "bot.open_memory_settings",
    );
    expect(task).toBeDefined();

    const plan = compileExperimentPlan({
      graph: fullGraph,
      task: task!,
      parameters: {},
      udid: "test-device",
      allowCandidate: true,
    });

    expect(plan.steps.map((step) => step.operatorId)).toEqual([
      "chat.open_bot_settings",
      "bot.settings.4af36fac773f.tap.bot.settings.memory",
    ]);
    expect(plan.steps.map((step) => step.expectedToSceneId)).toEqual([
      "bot.settings",
      "bot.settings.memory",
    ]);
  });

  test("plans evidence-backed guarded Operators without requiring a Task promotion", () => {
    const source = fullGraph.operators.find(
      (operator) => operator.operatorId === "chat.open_bot_settings",
    )!;
    const guarded = {
      ...source,
      status: "candidate" as const,
      execution: {
        tier: "guarded" as const,
        successfulExecutions: 1,
        failedExecutions: 0,
        consecutiveSuccessfulExecutions: 1,
        consecutiveFailedExecutions: 0,
        evidencePaths: ["/tmp/before.json", "/tmp/after.json"],
        lastValidatedAt: "2026-08-16T00:00:00.000Z",
      },
    };

    expect(isPlannableOperator(guarded)).toBeTrue();
    expect(operatorExecutionTier(guarded)).toBe("guarded");
    expect(
      isPlannableOperator({
        ...guarded,
        execution: { ...guarded.execution, evidencePaths: [] },
      }),
    ).toBeFalse();
  });

  test("forces live resolution for a parameterized gesture Selector", () => {
    const sourceOperator = fullGraph.operators.find(
      (candidate) => candidate.operatorId === "chat.open_bot_settings",
    )!;
    const sourceElement = fullGraph.elements.find(
      (candidate) => candidate.elementId === "chat.bot_settings_entry",
    )!;
    const operator = {
      ...sourceOperator,
      operatorId: "chat.long_press_parameterized_text",
      operation: {
        type: "long_press" as const,
        elementId: "chat.parameterized_text",
        durationMs: 1200,
      },
    };
    const element = {
      ...sourceElement,
      elementId: "chat.parameterized_text",
      selector: { text: "$parameters.text", role: "StaticText" },
      bindings: [],
    };
    const profile = fullGraph.deviceProfiles[0]!;
    const step = compileOperatorStep({
      graph: fullGraph,
      operator,
      index: 0,
      parameters: { text: "本次唯一测试消息" },
      udid: "device-1",
      deviceProfileId: profile.profileId,
      profile,
      elements: new Map([[element.elementId, element]]),
      allowCandidate: true,
    });

    expect(step.resolvedElementSelector).toEqual({
      text: "本次唯一测试消息",
      role: "StaticText",
    });
    expect(step.liveResolutionRequired).toBeTrue();
    expect(step.requiresLiveResolution).toBeTrue();
    expect(step.command).toEqual(["/usr/bin/false"]);
    expect(element.selector.text).toBe("$parameters.text");
  });

  test("learns guarded, fast, and quarantined execution tiers", () => {
    const operator = {
      ...fullGraph.operators.find(
        (candidate) => candidate.operatorId === "chat.open_bot_settings",
      )!,
      status: "candidate" as const,
      execution: {
        tier: "guarded" as const,
        successfulExecutions: 1,
        failedExecutions: 0,
        consecutiveSuccessfulExecutions: 1,
        consecutiveFailedExecutions: 0,
        evidencePaths: ["/tmp/observed.json"],
      },
    };
    const graphWithGuarded = {
      ...fullGraph,
      operators: fullGraph.operators.map((candidate) =>
        candidate.operatorId === operator.operatorId ? operator : candidate,
      ),
    };
    const fast = applyOperatorExecutionOutcome({
      graph: graphWithGuarded,
      operatorId: operator.operatorId,
      success: true,
      evidencePath: "/tmp/success.json",
      appVersion: "2.0",
    });
    const fastOperator = fast.operators.find(
      (candidate) => candidate.operatorId === operator.operatorId,
    )!;
    expect(fastOperator.execution?.tier).toBe("fast");
    expect(operatorExecutionTier(fastOperator, "2.0")).toBe("fast");
    expect(operatorExecutionTier(fastOperator, "2.1")).toBe("guarded");

    const firstFailure = applyOperatorExecutionOutcome({
      graph: fast,
      operatorId: operator.operatorId,
      success: false,
      evidencePath: "/tmp/failure-1.json",
    });
    expect(
      firstFailure.operators.find(
        (candidate) => candidate.operatorId === operator.operatorId,
      )?.execution?.tier,
    ).toBe("guarded");
    const secondFailure = applyOperatorExecutionOutcome({
      graph: firstFailure,
      operatorId: operator.operatorId,
      success: false,
      evidencePath: "/tmp/failure-2.json",
    });
    const quarantined = secondFailure.operators.find(
      (candidate) => candidate.operatorId === operator.operatorId,
    )!;
    expect(quarantined.execution?.tier).toBe("quarantined");
    expect(quarantined.status).toBe("verified");
    expect(isPlannableOperator(quarantined)).toBeFalse();
  });

  test("records a changed live Selector and Binding after guarded success", () => {
    const operator = fullGraph.operators.find(
      (candidate) => candidate.operatorId === "chat.open_bot_settings",
    )!;
    const updated = applyOperatorExecutionOutcome({
      graph: fullGraph,
      operatorId: operator.operatorId,
      success: true,
      evidencePath: "/tmp/grounding.json",
      appVersion: "2.0",
      liveResolution: {
        matchedBy: "agent",
        deviceProfileId: "iphone-414x896-portrait",
        selector: {
          accessibilityId: "豆包设置",
          label: "豆包设置",
          role: "Button",
        },
        normalizedPoint: { x: 0.5, y: 0.08 },
        evidencePath: "/tmp/live-resolution.json",
      },
    });
    const element = updated.elements.find(
      (candidate) => candidate.elementId === "chat.bot_settings_entry",
    )!;
    expect(element.selector.accessibilityId).toBe("豆包设置");
    expect(element.selectorHistory?.at(-1)?.selector.accessibilityId).toBe(
      "豆包，打开设置页",
    );
    expect(element.bindings[0]?.appVersion).toBe("2.0");
    expect(element.bindings[0]?.normalizedPoint).toEqual({ x: 0.5, y: 0.08 });
  });

  test("parses the installed app version from mobilecli inventory shapes", () => {
    expect(
      parseInstalledAppVersion(
        JSON.stringify({
          status: "ok",
          data: [
            {
              CFBundleIdentifier: "com.bot.doubao",
              CFBundleShortVersionString: "9.1.0",
              CFBundleVersion: "901001",
            },
          ],
        }),
        "com.bot.doubao",
      ),
    ).toBe("9.1.0+901001");
    expect(
      parseInstalledAppVersion(
        JSON.stringify({
          apps: [
            {
              bundleId: "com.bot.doubao",
              shortVersion: "9.2.0",
              buildVersion: "902000",
            },
          ],
        }),
        "com.bot.doubao",
      ),
    ).toBe("9.2.0+902000");
    expect(
      parseInstalledAppVersion("not-json", "com.bot.doubao"),
    ).toBeUndefined();
  });

  test("rejects a disconnected Task when no verified bridge exists", () => {
    const task = fullGraph.tasks.find(
      (candidate) => candidate.taskId === "bot.open_memory_settings",
    )!;
    const disconnectedGraph: ExecutableUiGraphExperiment = {
      ...fullGraph,
      operators: fullGraph.operators.filter(
        (operator) => operator.operatorId !== "chat.open_bot_settings",
      ),
    };

    expect(() =>
      compileExperimentPlan({
        graph: disconnectedGraph,
        task,
        parameters: {},
        udid: "test-device",
        allowCandidate: true,
      }),
    ).toThrow("no verified navigation bridge exists");
  });

  test("finds a verified navigation path from a restored Scene to the Task entry", () => {
    expect(
      findVerifiedEntryRecoveryOperators(
        fullGraph,
        "bot.settings",
        "chat.detail",
      ),
    ).toEqual(["bot.return_to_chat"]);
    expect(
      findVerifiedEntryRecoveryOperators(
        fullGraph,
        "chat.detail",
        "chat.detail",
      ),
    ).toEqual([]);
  });

  test("does not use state-preconditioned navigation for generic entry recovery", () => {
    const conditionalGraph: ExecutableUiGraphExperiment = {
      ...fullGraph,
      operators: [
        ...fullGraph.operators,
        {
          operatorId: "conditional.navigation",
          title: "Conditional navigation",
          fromSceneId: "camera.capture",
          toSceneId: "chat.detail",
          operation: {
            type: "tap",
            elementId: "camera.close",
          },
          settleMs: 900,
          risk: "navigation",
          status: "verified",
          reliability: 1,
          preconditions: ["camera.flash=auto"],
          effects: ["scene.current=chat.detail"],
          postconditions: ["scene.current=chat.detail"],
        },
      ],
    };

    expect(
      findVerifiedEntryRecoveryOperators(
        conditionalGraph,
        "camera.capture",
        "chat.detail",
      ),
    ).not.toEqual(["conditional.navigation"]);
  });

  test("does not use mutation or selection Operators for entry recovery", () => {
    expect(
      findVerifiedEntryRecoveryOperators(
        fullGraph,
        "chat.detail.keyboard",
        "chat.detail",
      ),
    ).toBeNull();
    expect(
      findVerifiedEntryRecoveryOperators(
        fullGraph,
        "photo.preview",
        "photo.selected",
      ),
    ).toBeNull();
  });

  test("requires strict devicectl proof of a new app process", () => {
    expect(
      parseStrictRestartResult(
        JSON.stringify({
          schemaVersion: "ios-ui-devicectl-restart/v1",
          bundleId: "com.bot.doubao",
          oldPids: [101],
          terminatedPids: [101],
          newPid: 202,
          currentPids: [202],
          success: true,
        }),
      ),
    ).toEqual({
      bundleId: "com.bot.doubao",
      oldPids: [101],
      terminatedPids: [101],
      newPid: 202,
      currentPids: [202],
      success: true,
    });
    expect(() =>
      parseStrictRestartResult(
        JSON.stringify({
          schemaVersion: "ios-ui-devicectl-restart/v1",
          bundleId: "com.bot.doubao",
          oldPids: [101],
          terminatedPids: [101],
          newPid: 101,
          currentPids: [101],
          success: true,
        }),
      ),
    ).toThrow("did not prove a new app process");
    expect(() =>
      parseStrictRestartResult(
        JSON.stringify({
          schemaVersion: "ios-ui-devicectl-restart/v1",
          bundleId: "com.bot.doubao",
          oldPids: [101],
          terminatedPids: [101],
          newPid: 202,
          currentPids: [101, 202],
          success: true,
        }),
      ),
    ).toThrow("did not prove a new app process");
  });

  test("restarts through devicectl PID termination without mobilecli lifecycle commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "devicectl-restart-test-"));
    const fakeXcrunPath = join(directory, "xcrun");
    const statePath = join(directory, "state.txt");
    const logPath = join(directory, "commands.log");
    await Promise.all([
      writeFile(statePath, "0\n", "utf8"),
      writeFile(logPath, "", "utf8"),
      writeFile(
        fakeXcrunPath,
        `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_XCRUN_LOG"
output=""
args=("$@")
for ((index=0; index<\${#args[@]}; index++)); do
  if [[ "\${args[$index]}" == "--json-output" ]]; then
    output="\${args[$((index+1))]}"
  fi
done
state="$(cat "$FAKE_XCRUN_STATE")"
if [[ "$*" == *"device info apps"* ]]; then
  printf '%s\\n' '{"result":{"apps":[{"bundleIdentifier":"com.bot.doubao","url":"file:///private/var/containers/Bundle/Application/TEST/Grace.app"}]}}' > "$output"
elif [[ "$*" == *"device info processes"* ]]; then
  if [[ "$state" == "0" ]]; then
    printf '%s\\n' '{"result":{"runningProcesses":[{"processIdentifier":101,"executable":"/private/var/containers/Bundle/Application/TEST/Grace.app/Grace"}]}}' > "$output"
  elif [[ "$state" == "1" ]]; then
    printf '%s\\n' '{"result":{"runningProcesses":[]}}' > "$output"
  else
    printf '%s\\n' '{"result":{"runningProcesses":[{"processIdentifier":202,"executable":"/private/var/containers/Bundle/Application/TEST/Grace.app/Grace"}]}}' > "$output"
  fi
elif [[ "$*" == *"device process terminate"* ]]; then
  printf '1\\n' > "$FAKE_XCRUN_STATE"
  printf '%s\\n' '{"result":{}}' > "$output"
elif [[ "$*" == *"device process launch"* ]]; then
  printf '2\\n' > "$FAKE_XCRUN_STATE"
  printf '%s\\n' '{"result":{"process":{"processIdentifier":202}}}' > "$output"
else
  echo "Unexpected command: $*" >&2
  exit 2
fi
`,
        "utf8",
      ),
    ]);
    await chmod(fakeXcrunPath, 0o755);
    try {
      const subprocess = Bun.spawn(
        [
          "python3",
          join(
            process.cwd(),
            "examples/ios-ui-graph-experiment/devicectl_restart.py",
          ),
          "--device",
          "test-device",
          "--bundle-id",
          "com.bot.doubao",
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            FAKE_XCRUN_STATE: statePath,
            FAKE_XCRUN_LOG: logPath,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      const commandLog = await readFile(logPath, "utf8");

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(parseStrictRestartResult(stdout)).toMatchObject({
        oldPids: [101],
        terminatedPids: [101],
        newPid: 202,
        currentPids: [202],
      });
      expect(commandLog).toContain(
        "device process terminate --device test-device --pid 101 --kill",
      );
      expect(commandLog).toContain(
        "device process launch --device test-device --terminate-existing",
      );
      expect(commandLog).not.toContain("mobilecli");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("taps restart, proves the old PID exited, and relaunches through devicectl", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "devicectl-wait-launch-test-"),
    );
    const fakeXcrunPath = join(directory, "xcrun");
    const fakeMobilecliPath = join(directory, "mobilecli");
    const statePath = join(directory, "state.txt");
    const logPath = join(directory, "commands.log");
    await Promise.all([
      writeFile(statePath, "0\n", "utf8"),
      writeFile(logPath, "", "utf8"),
      writeFile(
        fakeMobilecliPath,
        `#!/bin/bash
set -euo pipefail
printf 'mobilecli %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
printf '1\\n' > "$FAKE_PROCESS_STATE"
printf '%s\\n' '{"status":"ok"}'
`,
        "utf8",
      ),
      writeFile(
        fakeXcrunPath,
        `#!/bin/bash
set -euo pipefail
printf 'xcrun %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
output=""
args=("$@")
for ((index=0; index<\${#args[@]}; index++)); do
  if [[ "\${args[$index]}" == "--json-output" ]]; then
    output="\${args[$((index+1))]}"
  fi
done
state="$(cat "$FAKE_PROCESS_STATE")"
if [[ "$*" == *"device info apps"* ]]; then
  printf '%s\\n' '{"result":{"apps":[{"bundleIdentifier":"com.bot.doubao","url":"file:///private/var/containers/Bundle/Application/TEST/Grace.app"}]}}' > "$output"
elif [[ "$*" == *"device info processes"* ]]; then
  if [[ "$state" == "0" ]]; then
    printf '%s\\n' '{"result":{"runningProcesses":[{"processIdentifier":101}]}}' > "$output"
  elif [[ "$state" == "1" ]]; then
    printf '%s\\n' '{"result":{"runningProcesses":[]}}' > "$output"
  else
    printf '%s\\n' '{"result":{"runningProcesses":[{"processIdentifier":202}]}}' > "$output"
  fi
elif [[ "$*" == *"device process launch"* ]]; then
  printf '2\\n' > "$FAKE_PROCESS_STATE"
  printf '%s\\n' '{"result":{"process":{"processIdentifier":202}}}' > "$output"
else
  echo "Unexpected command: $*" >&2
  exit 2
fi
`,
        "utf8",
      ),
    ]);
    await Promise.all([
      chmod(fakeXcrunPath, 0o755),
      chmod(fakeMobilecliPath, 0o755),
    ]);
    try {
      const subprocess = Bun.spawn(
        [
          "python3",
          join(
            process.cwd(),
            "examples/ios-ui-graph-experiment/devicectl_wait_launch.py",
          ),
          "--device",
          "test-device",
          "--bundle-id",
          "com.bot.doubao",
          "--tap-point",
          "274,495",
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            FAKE_PROCESS_STATE: statePath,
            FAKE_COMMAND_LOG: logPath,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      const commandLog = await readFile(logPath, "utf8");

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(parseWaitLaunchResult(stdout)).toMatchObject({
        oldPids: [101],
        newPid: 202,
        currentPids: [202],
      });
      expect(commandLog).toContain(
        "mobilecli io tap --device test-device 274,495",
      );
      expect(commandLog).toContain(
        "xcrun devicectl device process launch --device test-device --terminate-existing",
      );
      expect(commandLog.indexOf("mobilecli io tap")).toBeLessThan(
        commandLog.indexOf("device process launch"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses an Agent to resolve a natural-language goal into a verified Task", async () => {
    let capturedPrompt = "";
    const agentRunner: AgentFunction = async <TOutput>(prompt: string) => {
      capturedPrompt = prompt;
      return {
        requestType: "execute_task",
        targetId: "message.send_text",
        parameters: [{ name: "text", value: "你好" }],
        confidence: 0.97,
        reason: "The user asked to send a text message.",
      } as TOutput;
    };

    const resolution = await resolveSemanticGoal({
      graph: fullGraph,
      goal: "帮我发一条消息说你好",
      parameters: {},
      cwd: "/tmp",
      minimumConfidence: 0.8,
      agentRunner,
    });

    expect(resolution.mode).toBe("agent_task");
    expect(resolution.resolutionType).toBe("verified_task");
    expect(resolution.taskId).toBe("message.send_text");
    expect(resolution.parameters).toEqual({ text: "你好" });
    expect(resolution.confidence).toBe(0.97);
    expect(capturedPrompt).toContain("Available Tasks");
    expect(capturedPrompt).toContain("photo.capture_and_ask");
    expect(capturedPrompt).not.toContain("normalizedPoint");
    expect(capturedPrompt).not.toContain("chat.focus_composer");
  });

  test("keeps explicit taskId as a deterministic debugging override", async () => {
    let agentCalled = false;
    const agentRunner: AgentFunction = async () => {
      agentCalled = true;
      throw new Error("Agent should not run.");
    };

    const resolution = await resolveSemanticGoal({
      graph: fullGraph,
      taskId: "photo.capture_and_ask",
      goal: "",
      parameters: { question: "这是什么？" },
      cwd: "/tmp",
      minimumConfidence: 0.8,
      agentRunner,
    });

    expect(agentCalled).toBeFalse();
    expect(resolution.mode).toBe("explicit_task");
    expect(resolution.taskId).toBe("photo.capture_and_ask");
    expect(resolution.parameters).toEqual({ question: "这是什么？" });
  });

  test("plans an explicit Scene path without calling an Agent", async () => {
    let agentCalled = false;
    const agentRunner: AgentFunction = async () => {
      agentCalled = true;
      throw new Error("Agent should not run.");
    };

    const resolution = await resolveSemanticGoal({
      graph: fullGraph,
      sceneId: "bot.settings",
      goal: "",
      parameters: {},
      cwd: "/tmp",
      minimumConfidence: 0.8,
      agentRunner,
    });

    expect(agentCalled).toBeFalse();
    expect(resolution.mode).toBe("explicit_scene");
    expect(resolution.operatorIds).toEqual(["chat.open_bot_settings"]);
    expect(resolution.targetSceneId).toBe("bot.settings");
    expect(resolution.promptBytes).toBe(0);
  });

  test("plans an explicit Operator with its entry path without calling an Agent", async () => {
    let agentCalled = false;
    const agentRunner: AgentFunction = async () => {
      agentCalled = true;
      throw new Error("Agent should not run.");
    };

    const resolution = await resolveSemanticGoal({
      graph: fullGraph,
      operatorId: "chat.open_bot_settings",
      goal: "",
      parameters: {},
      cwd: "/tmp",
      minimumConfidence: 0.8,
      agentRunner,
    });

    expect(agentCalled).toBeFalse();
    expect(resolution.mode).toBe("explicit_operator");
    expect(resolution.operatorIds).toEqual(["chat.open_bot_settings"]);
    expect(resolution.targetSceneId).toBe("bot.settings");
    expect(resolution.promptBytes).toBe(0);
  });

  test("resolves an exact Task intent locally without calling an Agent", async () => {
    let agentCalled = false;
    const agentRunner: AgentFunction = async () => {
      agentCalled = true;
      throw new Error("Agent should not run.");
    };

    const resolution = await resolveSemanticGoal({
      graph: fullGraph,
      goal: " 打开侧边栏，然后进入技能页面。 ",
      parameters: {},
      cwd: "/tmp",
      minimumConfidence: 0.8,
      agentRunner,
    });

    expect(agentCalled).toBeFalse();
    expect(resolution.mode).toBe("exact_intent");
    expect(resolution.resolutionType).toBe("verified_task");
    expect(resolution.taskId).toBe("skills.open_from_chat_sidebar");
    expect(resolution.promptBytes).toBe(0);
  });

  test("resolves a safe candidate Task for candidate replay", async () => {
    const candidateGraph: ExecutableUiGraphExperiment = {
      ...fullGraph,
      tasks: fullGraph.tasks.map((task) =>
        task.taskId === "skills.open_from_chat_sidebar"
          ? {
              ...task,
              status: "candidate",
              validation: {
                ...task.validation!,
                successfulExecutions: 1,
                requiresFixtureReplay: false,
              },
            }
          : task,
      ),
    };
    const agentRunner: AgentFunction = async <TOutput>() =>
      ({
        requestType: "execute_task",
        targetId: "skills.open_from_chat_sidebar",
        parameters: [],
        confidence: 0.98,
        reason: "The candidate Task reaches the requested skills page.",
      }) as TOutput;

    const resolution = await resolveSemanticGoal({
      graph: candidateGraph,
      goal: "去技能中心看看",
      parameters: {},
      cwd: "/tmp",
      minimumConfidence: 0.8,
      agentRunner,
    });

    expect(resolution.mode).toBe("agent_task");
    expect(resolution.resolutionType).toBe("candidate_task");
    expect(resolution.taskId).toBe("skills.open_from_chat_sidebar");
  });

  test("blocks low-confidence semantic resolution before execution", async () => {
    const agentRunner: AgentFunction = async <TOutput>() =>
      ({
        requestType: "execute_task",
        targetId: "photo.select_only",
        parameters: [],
        confidence: 0.42,
        reason: "The request may refer to either camera or album.",
      }) as TOutput;

    expect(
      resolveSemanticGoal({
        graph: fullGraph,
        goal: "帮我处理一张图片",
        parameters: {},
        cwd: "/tmp",
        minimumConfidence: 0.8,
        agentRunner,
      }),
    ).rejects.toThrow("below the execution threshold");
  });

  test("aborts a stalled semantic Agent at the configured timeout", async () => {
    const agentRunner: AgentFunction = async <TOutput>(
      _prompt: string,
      options?: AgentOptions,
    ) =>
      new Promise<TOutput>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        );
      });

    expect(
      resolveSemanticGoal({
        graph: fullGraph,
        goal: "执行一个 Graph 中不存在的未知操作",
        parameters: {},
        cwd: "/tmp",
        minimumConfidence: 0.8,
        timeoutMs: 10,
        agentRunner,
      }),
    ).rejects.toThrow("timed out after 10 ms");
  });

  test("rejects parameters outside the selected Task contract", async () => {
    const agentRunner: AgentFunction = async <TOutput>() =>
      ({
        requestType: "execute_task",
        targetId: "chat.load_more",
        parameters: [{ name: "direction", value: "up" }],
        confidence: 0.94,
        reason: "The user wants older messages.",
      }) as TOutput;

    expect(
      resolveSemanticGoal({
        graph: fullGraph,
        goal: "加载更早的消息",
        parameters: {},
        cwd: "/tmp",
        minimumConfidence: 0.8,
        agentRunner,
      }),
    ).rejects.toThrow("unknown parameter direction");
  });

  test("composes verified navigation Operators when no Task matches", async () => {
    let call = 0;
    const agentRunner: AgentFunction = async <TOutput>() => {
      call += 1;
      return (
        call === 1
          ? {
              requestType: "unsupported",
              targetId: "",
              parameters: [],
              confidence: 0.99,
              reason: "No verified Task only opens the media panel.",
            }
          : {
              resolutionType: "composed_path",
              operatorIds: ["chat.open_more_panel"],
              targetSceneId: "chat.media_panel",
              proposedTaskTitle: "打开快捷媒体面板",
              desiredOutcome: "到达会话快捷媒体面板",
              knownFrontierSceneId: "chat.media_panel",
              missingCapabilities: [],
              suggestedExplorationActions: [],
              confidence: 0.96,
              reason:
                "The verified navigation Operator reaches the requested Scene.",
            }
      ) as TOutput;
    };

    const resolution = await resolveSemanticGoal({
      graph: {
        ...fullGraph,
        tasks: fullGraph.tasks.filter(
          (task) => task.taskId !== "dynamic.chat.open_more_panel",
        ),
      },
      goal: "打开快捷媒体面板",
      parameters: {},
      cwd: "/tmp",
      minimumConfidence: 0.8,
      agentRunner,
    });

    expect(call).toBe(2);
    expect(resolution.mode).toBe("agent_composed");
    expect(resolution.resolutionType).toBe("composed_path");
    expect(resolution.operatorIds).toEqual(["chat.open_more_panel"]);
    expect(resolution.targetSceneId).toBe("chat.media_panel");
  });

  test("composes guarded state preparation before reaching a Scene without a Task", async () => {
    const agentRunner: AgentFunction = async () => {
      throw new Error("The unique Scene path should resolve without an Agent.");
    };

    const resolution = await resolveSemanticGoal({
      graph: fullGraph,
      goal: "打开 AI 写歌",
      parameters: {},
      cwd: "/tmp",
      minimumConfidence: 0.8,
      agentRunner,
    });

    expect(resolution.mode).toBe("semantic_scene");
    expect(resolution.resolutionType).toBe("composed_path");
    expect(resolution.operatorIds).toEqual([
      "chat.actionbar_scroll_end.1.swipe_left.horizontalscrollregion",
      "chat.detail.AI.tap.chat.ai_song",
    ]);
    const task = {
      taskId: "test.open.ai-song",
      title: "打开 AI 写歌",
      summary: "测试 guarded state composition",
      intents: ["打开 AI 写歌"],
      parameters: {},
      entrySceneId: "chat.detail",
      operatorIds: resolution.operatorIds!,
      finalOracles: [
        { type: "scene_current" as const, sceneId: "chat.ai_song" },
      ],
      status: "candidate" as const,
    };
    const plan = compileExperimentPlan({
      graph: fullGraph,
      task,
      parameters: {},
      udid: "test-device",
      allowCandidate: true,
    });
    expect(plan.steps.map((step) => step.executionTier)).toEqual([
      "guarded",
      "guarded",
    ]);
  });

  test("returns a targeted discovery gap when verified Operators are insufficient", async () => {
    let call = 0;
    const agentRunner: AgentFunction = async <TOutput>() => {
      call += 1;
      return (
        call === 1
          ? {
              requestType: "unsupported",
              targetId: "",
              parameters: [],
              confidence: 0.99,
              reason: "No Task deletes a conversation.",
            }
          : {
              resolutionType: "discovery_required",
              operatorIds: [],
              targetSceneId: "",
              proposedTaskTitle: "",
              desiredOutcome: "删除当前会话",
              knownFrontierSceneId: "chat.detail",
              missingCapabilities: [
                "conversation delete entry",
                "delete confirmation Operator",
                "conversation removed Oracle",
              ],
              suggestedExplorationActions: [
                "inspect the chat detail menu",
                "capture the confirmation dialog",
              ],
              confidence: 0.95,
              reason: "The verified Graph has no delete capability.",
            }
      ) as TOutput;
    };

    const resolution = await resolveSemanticGoal({
      graph: fullGraph,
      goal: "删除当前会话",
      parameters: {},
      cwd: "/tmp",
      minimumConfidence: 0.8,
      agentRunner,
    });

    expect(call).toBe(2);
    expect(resolution.mode).toBe("agent_discovery");
    expect(resolution.resolutionType).toBe("discovery_required");
    expect(resolution.knownFrontierSceneId).toBe("chat.detail");
    expect(resolution.missingCapabilities).toContain(
      "delete confirmation Operator",
    );
  });

  test("rejects composed paths containing mutation Operators", async () => {
    let call = 0;
    const agentRunner: AgentFunction = async <TOutput>() => {
      call += 1;
      return (
        call === 1
          ? {
              requestType: "unsupported",
              targetId: "",
              parameters: [],
              confidence: 0.99,
              reason: "No matching Task.",
            }
          : {
              resolutionType: "composed_path",
              operatorIds: [
                "chat.focus_composer",
                "chat.set_draft_text",
                "chat.submit_text_message",
              ],
              targetSceneId: "chat.detail",
              proposedTaskTitle: "非法动态发送",
              desiredOutcome: "发送消息",
              knownFrontierSceneId: "chat.detail",
              missingCapabilities: [],
              suggestedExplorationActions: [],
              confidence: 0.99,
              reason: "Attempted to compose a mutating path.",
            }
      ) as TOutput;
    };

    expect(
      resolveSemanticGoal({
        graph: fullGraph,
        goal: "组合发送一条消息",
        parameters: {},
        cwd: "/tmp",
        minimumConfidence: 0.8,
        agentRunner,
      }),
    ).rejects.toThrow("not a continuous evidence-backed navigation edge");
  });

  test("writes targeted Graph gap and discovery packet artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-graph-gap-test-"));
    try {
      const artifacts = await writeDiscoveryArtifacts({
        graph: fullGraph,
        outputDir,
        resolution: {
          mode: "agent_discovery",
          resolutionType: "discovery_required",
          goal: "删除当前会话",
          parameters: {},
          confidence: 0.95,
          reason: "The Graph has no delete capability.",
          desiredOutcome: "删除当前会话",
          knownFrontierSceneId: "chat.detail",
          missingCapabilities: ["delete Operator", "removed Oracle"],
          suggestedExplorationActions: ["inspect the chat detail menu"],
          durationMs: 1,
        },
      });

      const gap = JSON.parse(
        await readFile(artifacts.graphGapPath, "utf8"),
      ) as {
        schemaVersion: string;
        knownFrontierSceneId: string;
        missingCapabilities: string[];
      };
      const packet = JSON.parse(
        await readFile(artifacts.discoveryPacketPath, "utf8"),
      ) as {
        schemaVersion: string;
        frontier: { sceneId: string };
        constraints: string[];
      };

      expect(gap.schemaVersion).toBe("ios-ui-graph-gap/v1");
      expect(gap.knownFrontierSceneId).toBe("chat.detail");
      expect(gap.missingCapabilities).toContain("delete Operator");
      expect(packet.schemaVersion).toBe("ios-ui-targeted-discovery-packet/v1");
      expect(packet.frontier.sceneId).toBe("chat.detail");
      expect(packet.constraints.length).toBeGreaterThan(0);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("promotes a dynamically composed Task only after two successful executions", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-candidate-task-test-"));
    const graphPath = join(outputDir, "graph.json");
    const initialGraph: ExecutableUiGraphExperiment = {
      ...fullGraph,
      tasks: fullGraph.tasks.filter(
        (task) => task.taskId !== "dynamic.chat.open_more_panel",
      ),
    };
    const candidateTask = {
      taskId: "dynamic.chat.open_more_panel",
      title: "打开快捷媒体面板",
      summary: "到达会话快捷媒体面板",
      intents: ["打开快捷媒体面板"],
      parameters: {},
      entrySceneId: "chat.detail",
      operatorIds: ["chat.open_more_panel"],
      finalOracles: [
        { type: "scene_current" as const, sceneId: "chat.media_panel" },
        {
          type: "foreground_bundle" as const,
          bundleId: "com.bot.doubao",
        },
      ],
      status: "candidate" as const,
    };
    try {
      await writeFile(graphPath, `${JSON.stringify(initialGraph)}\n`, "utf8");
      await persistCandidateTask({
        graph: initialGraph,
        graphPath,
        task: candidateTask,
        goal: "打开快捷媒体面板",
        evidencePath: join(outputDir, "result-1.json"),
        outputDir,
      });
      const first = JSON.parse(await readFile(graphPath, "utf8")) as {
        tasks: Array<{
          taskId: string;
          status: string;
          validation?: { successfulExecutions: number };
        }>;
      };
      const firstTask = first.tasks.find(
        (task) => task.taskId === candidateTask.taskId,
      );
      expect(firstTask?.status).toBe("candidate");
      expect(firstTask?.validation?.successfulExecutions).toBe(1);

      await persistCandidateTask({
        graph: first as unknown as ExecutableUiGraphExperiment,
        graphPath,
        task: candidateTask,
        goal: "打开快捷媒体面板",
        evidencePath: join(outputDir, "result-2.json"),
        outputDir,
      });
      const second = JSON.parse(await readFile(graphPath, "utf8")) as {
        tasks: Array<{
          taskId: string;
          status: string;
          validation?: { successfulExecutions: number };
        }>;
      };
      const secondTask = second.tasks.find(
        (task) => task.taskId === candidateTask.taskId,
      );
      expect(secondTask?.status).toBe("verified");
      expect(secondTask?.validation?.successfulExecutions).toBe(2);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("classifies Agent verifier and legacy Oracle outcomes deterministically", () => {
    expect(
      classifyVerifierOutcome({
        agentSuccess: true,
        legacySuccess: true,
        pathSuccess: true,
      }),
    ).toBe("pass");
    expect(
      classifyVerifierOutcome({
        agentSuccess: true,
        legacySuccess: false,
        pathSuccess: true,
      }),
    ).toBe("oracle_stale");
    expect(
      classifyVerifierOutcome({
        agentSuccess: false,
        legacySuccess: true,
        pathSuccess: true,
      }),
    ).toBe("uncertain");
    expect(
      classifyVerifierOutcome({
        agentSuccess: true,
        legacySuccess: true,
        pathSuccess: false,
      }),
    ).toBe("path_failed");
    expect(
      classifyVerifierOutcome({
        agentSuccess: false,
        legacySuccess: false,
        pathSuccess: true,
      }),
    ).toBe("evidence_insufficient");
  });

  test("executes typed Agent verifier assertions against deterministic evidence", () => {
    const results = evaluateVerifierAssertions(
      [
        {
          assertionId: "sidebar-anchors",
          type: "all_text_visible",
          values: ["搜索", "云盘"],
        },
        {
          assertionId: "sidebar-scene",
          type: "scene_current",
          sceneId: "chat.sidebar",
        },
        {
          assertionId: "foreground",
          type: "foreground_bundle",
          bundleId: "com.bot.doubao",
        },
      ],
      {
        goal: "打开侧边栏",
        currentSceneId: "chat.sidebar",
        texts: ["搜索", "技能", "云盘"],
        foregroundBundle: "com.bot.doubao",
        regionItems: [],
        evidencePaths: ["/tmp/final.png"],
      },
    );

    expect(results.every((result) => result.success)).toBeTrue();
  });

  test("persists a compiled verifier on an existing Task", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-task-verifier-test-"));
    const graphPath = join(outputDir, "graph.json");
    const task = fullGraph.tasks.find(
      (candidate) => candidate.taskId === "message.send_text",
    )!;
    const verifier: ExperimentVerifierSpec = {
      schemaVersion: "ios-ui-agent-verifier/v1",
      status: "candidate",
      source: "agent_compiled",
      assertions: [
        {
          assertionId: "foreground",
          type: "foreground_bundle",
          bundleId: fullGraph.bundleId,
        },
      ],
      reason: "The app remains foreground after sending.",
      confidence: 0.9,
      successfulExecutions: 1,
      evidencePaths: [join(outputDir, "result.json")],
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    try {
      await writeFile(graphPath, `${JSON.stringify(fullGraph)}\n`, "utf8");
      const patchPath = await persistTaskVerifier({
        graph: fullGraph,
        graphPath,
        task,
        verifier,
        outputDir,
      });
      const patched = JSON.parse(await readFile(graphPath, "utf8")) as {
        tasks: Array<{
          taskId: string;
          verifier?: ExperimentVerifierSpec;
        }>;
      };
      expect(patchPath).toBe(join(outputDir, "task-verifier-patch.json"));
      expect(
        patched.tasks.find((candidate) => candidate.taskId === task.taskId)
          ?.verifier,
      ).toEqual(verifier);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("promotes a safe candidate replay without Graph synthesis", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-candidate-replay-"));
    const graphPath = join(outputDir, "graph.json");
    const candidateTask = {
      ...fullGraph.tasks.find(
        (task) => task.taskId === "skills.open_from_chat_sidebar",
      )!,
      status: "candidate" as const,
      validation: {
        source: "targeted_discovery" as const,
        sourceGoals: ["打开侧边栏，然后进入技能页面"],
        successfulExecutions: 1,
        evidencePaths: [join(outputDir, "result-1.json")],
        lastValidatedAt: "2026-08-15T00:00:00.000Z",
        requiresFixtureReplay: false,
      },
    };
    const candidateGraph: ExecutableUiGraphExperiment = {
      ...fullGraph,
      scenes: fullGraph.scenes.map((scene) =>
        scene.sceneId === "skills.home"
          ? { ...scene, status: "candidate" }
          : scene,
      ),
      elements: fullGraph.elements.map((element) =>
        element.elementId === "chat.sidebar.skills.entry"
          ? {
              ...element,
              bindings: element.bindings.map((binding) => ({
                ...binding,
                status: "candidate",
                reliability: 0.7,
              })),
            }
          : element,
      ),
      operators: fullGraph.operators.map((operator) =>
        candidateTask.operatorIds.includes(operator.operatorId)
          ? { ...operator, status: "candidate", reliability: 0.7 }
          : operator,
      ),
      tasks: fullGraph.tasks.map((task) =>
        task.taskId === candidateTask.taskId ? candidateTask : task,
      ),
    };
    const verifier: ExperimentVerifierSpec = {
      ...candidateTask.verifier!,
      status: "candidate",
      successfulExecutions: 2,
    };
    try {
      await writeFile(graphPath, `${JSON.stringify(candidateGraph)}\n`, "utf8");
      const patchPath = await promoteCandidateReplay({
        graph: candidateGraph,
        graphPath,
        task: candidateTask,
        verifier,
        goal: "打开侧边栏，然后进入技能页面",
        evidencePath: join(outputDir, "result-2.json"),
        outputDir,
      });
      const patched = JSON.parse(
        await readFile(graphPath, "utf8"),
      ) as ExecutableUiGraphExperiment;
      const promoted = patched.tasks.find(
        (task) => task.taskId === candidateTask.taskId,
      );
      expect(patchPath).toBe(join(outputDir, "candidate-replay-patch.json"));
      expect(promoted?.status).toBe("verified");
      expect(promoted?.validation?.successfulExecutions).toBe(2);
      expect(
        patched.operators
          .filter((operator) =>
            candidateTask.operatorIds.includes(operator.operatorId),
          )
          .every((operator) => operator.status === "verified"),
      ).toBeTrue();
      expect(
        patched.elements
          .find((element) => element.elementId === "chat.sidebar.skills.entry")
          ?.bindings.every((binding) => binding.status === "verified"),
      ).toBeTrue();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("requires target-menu evidence before destructive targeted discovery", () => {
    const deleteCandidate = {
      candidateId: "ui-delete",
      source: "ui_dump" as const,
      role: "Button",
      label: "删除",
      bounds: { x: 100, y: 200, width: 50, height: 40 },
    };
    const decision = {
      status: "action" as const,
      candidateId: "ui-delete",
      actionType: "tap" as const,
      durationMs: 500,
      targetElementTitle: "删除消息",
      targetSemanticRole: "delete_message",
      operatorTitle: "删除最后一条消息",
      risk: "destructive" as const,
      expectedOutcome: "message.deleted=true",
      sceneTitle: "消息操作菜单",
      visualTextAnchors: ["删除"],
      completionEvidence: [],
      completionOracleType: "none" as const,
      completionOracleValue: "",
      reason: "Delete the selected message.",
    };

    expect(
      targetedDiscoverySafetyIssue({
        goal: "删除最后1条消息",
        decision,
        candidate: deleteCandidate,
        previousActions: [],
      }),
    ).toContain("prior target-menu evidence");
    expect(
      targetedDiscoverySafetyIssue({
        goal: "删除最后1条消息",
        decision,
        candidate: deleteCandidate,
        previousActions: [
          {
            stepId: "discover-01-long_press",
            purpose: "advance_goal",
            actionType: "long_press",
            candidateId: "ocr-message",
            targetText: "你好",
            targetElementTitle: "最后一条消息",
            targetSemanticRole: "last_message",
            operatorTitle: "长按最后一条消息",
            risk: "interaction",
            expectedOutcome: "message.menu.visible=true",
            expectedSceneTitle: "消息操作菜单",
            expectedVisualTextAnchors: ["删除"],
            command: [],
            fromSceneId: "chat.detail",
            toSceneId: "discovery.message_menu",
            beforeObservationId: "observation-00",
            afterObservationId: "observation-01",
            exitCode: 0,
          },
        ],
      }),
    ).toBeNull();
  });

  test("enforces deterministic swipe-only safety for ActionBar scrolling", () => {
    const itemCandidate = {
      candidateId: "ui-actionbar-item",
      source: "ui_dump" as const,
      role: "Button",
      label: "AI 创作",
      bounds: { x: 100, y: 720, width: 80, height: 44 },
    };
    const regionCandidate = {
      candidateId: "gesture-horizontal-1",
      source: "ui_dump" as const,
      role: "HorizontalScrollRegion",
      label: "横向可滑动区域：快速 | AI 创作 | 帮我写作",
      value: "快速|AI 创作|帮我写作",
      bounds: { x: 20, y: 710, width: 360, height: 64 },
    };
    const baseDecision = {
      status: "action" as const,
      candidateId: itemCandidate.candidateId,
      actionType: "tap" as const,
      durationMs: 500,
      targetElementTitle: "AI 创作",
      targetSemanticRole: "actionbar_item",
      operatorTitle: "操作 ActionBar",
      risk: "interaction" as const,
      expectedOutcome: "actionbar.changed=true",
      sceneTitle: "会话页",
      visualTextAnchors: [],
      completionEvidence: [],
      completionOracleType: "none" as const,
      completionOracleValue: "",
      reason: "Move ActionBar.",
    };

    expect(
      targetedDiscoverySafetyIssue({
        goal: "滑动actionbar到最后",
        decision: baseDecision,
        candidate: itemCandidate,
        previousActions: [],
      }),
    ).toContain("only allow swipe");
    expect(
      targetedDiscoverySafetyIssue({
        goal: "滑动actionbar到最后",
        decision: {
          ...baseDecision,
          actionType: "swipe_left",
        },
        candidate: itemCandidate,
        previousActions: [],
      }),
    ).toContain("HorizontalScrollRegion");
    expect(
      targetedDiscoverySafetyIssue({
        goal: "滑动actionbar到最后",
        decision: {
          ...baseDecision,
          candidateId: regionCandidate.candidateId,
          actionType: "swipe_left",
        },
        candidate: regionCandidate,
        previousActions: [],
      }),
    ).toBeNull();
  });

  test("verifies targeted discovery completion from deterministic observations", async () => {
    const before = makeDiscoveryObservation("observation-00", [
      ["ocr-message", "vision_ocr", "你好"],
    ]);
    const after = makeDiscoveryObservation("observation-01", [
      ["ocr-other", "vision_ocr", "其他消息"],
    ]);

    expect(
      await verifyTargetedDiscoveryCompletion({
        oracle: { type: "text_absent", value: "你好" },
        initialObservation: before,
        currentObservation: after,
      }),
    ).toBeTrue();
    expect(
      await verifyTargetedDiscoveryCompletion({
        oracle: { type: "text_visible", value: "你好" },
        initialObservation: before,
        currentObservation: after,
      }),
    ).toBeFalse();
  });

  test("classifies message deletion overlays before generic Graph Scenes", () => {
    expect(
      classifyTargetedDiscoveryScene(
        makeDiscoveryObservation("menu", [
          ["ui-more", "ui_dump", "更多"],
          ["ui-export", "ui_dump", "导出为文档"],
          ["ui-report", "ui_dump", "反馈与举报"],
          ["ui-delete", "ui_dump", "删除"],
        ]).candidates,
      )?.sceneId,
    ).toBe("chat.message_more_menu");
    expect(
      classifyTargetedDiscoveryScene(
        makeDiscoveryObservation("confirm", [
          ["ui-title", "ui_dump", "是否删除已选消息？"],
          ["ui-warning", "ui_dump", "删除后，消息内容无法恢复。"],
          ["ui-delete", "ui_dump", "删除"],
        ]).candidates,
      )?.sceneId,
    ).toBe("chat.message_delete_confirmation");
  });

  test("classifies the sidebar from its unique visible anchors", () => {
    const sidebar = makeDiscoveryObservation("sidebar", [
      ["ui-search", "ui_dump", "搜索"],
      ["ui-skills", "ui_dump", "技能"],
      ["ui-drive", "ui_dump", "云盘"],
      ["ui-chat-list", "ui_dump", "对话列表"],
      ["ui-hold-to-talk", "ui_dump", "按住说话"],
      ["ui-more-panel", "ui_dump", "更多面板"],
    ]);

    expect(classifyTargetedDiscoveryScene(sidebar.candidates)?.sceneId).toBe(
      "chat.sidebar",
    );
  });

  test("classifies the writing assistant overlay above the chat composer", () => {
    const writingAssistant = makeDiscoveryObservation("writing-assistant", [
      ["ui-title", "ui_dump", "帮我写作"],
      ["ui-close", "ui_dump", "关闭"],
      ["ui-text-mode", "ui_dump", "文本输入"],
      ["ui-hold-to-talk", "ui_dump", "按住说话"],
      ["ui-chat-list", "ui_dump", "对话列表"],
    ]);

    expect(
      classifyTargetedDiscoveryScene(writingAssistant.candidates)?.sceneId,
    ).toBe("chat.write_assistant.panel");
  });

  test("classifies the PPT generation overlay above the chat composer", () => {
    const pptPanel = makeDiscoveryObservation("ppt-panel", [
      ["ui-title", "ui_dump", "PPT 生成"],
      ["ui-length", "ui_dump", "篇幅"],
      ["ui-close", "ui_dump", "关闭"],
      ["ui-input", "ui_dump", "输入主题及要求..."],
      ["ui-chat-list", "ui_dump", "对话列表"],
    ]);

    expect(classifyTargetedDiscoveryScene(pptPanel.candidates)?.sceneId).toBe(
      "chat.ppt.generate.panel",
    );
  });

  test("classifies sidebar search before the generic sidebar", () => {
    const sidebarSearch = makeDiscoveryObservation("sidebar-search", [
      ["ui-cancel", "ui_dump", "取消"],
      ["ui-all", "ui_dump", "全部"],
      ["ui-message", "ui_dump", "消息"],
      ["ui-drive", "ui_dump", "云盘"],
      ["ui-recent", "ui_dump", "最近对话"],
      ["ui-skills", "ui_dump", "技能"],
    ]);

    expect(
      classifyTargetedDiscoveryScene(sidebarSearch.candidates)?.sceneId,
    ).toBe("chat.sidebar.search");
  });

  test("classifies media panel, notification settings, and photo picker", () => {
    const mediaPanel = makeDiscoveryObservation("media-panel", [
      ["ui-close", "ui_dump", "关闭面板"],
      ["ui-album", "ui_dump", "相册"],
      ["ui-file", "ui_dump", "文件"],
    ]);
    const notificationSettings = makeDiscoveryObservation("notification", [
      ["ui-back", "ui_dump", "返回"],
      ["ui-title", "ui_dump", "通知设置"],
    ]);
    const photoPicker = makeDiscoveryObservation("photo-picker", [
      ["ui-all", "ui_dump", "所有照片"],
      ["ui-close", "ui_dump", "关闭"],
      ["ui-photo", "ui_dump", "未选中，照片，2026 年 7 月 28 日"],
    ]);

    expect(classifyTargetedDiscoveryScene(mediaPanel.candidates)?.sceneId).toBe(
      "chat.media_panel",
    );
    expect(
      classifyTargetedDiscoveryScene(notificationSettings.candidates)?.sceneId,
    ).toBe("bot.settings.notification_settings");
    expect(
      classifyTargetedDiscoveryScene(photoPicker.candidates)?.sceneId,
    ).toBe("photo.picker");
  });

  test("classifies newly discovered picker and cloud-drive Scenes", () => {
    const filePicker = makeDiscoveryObservation("file-picker", [
      ["ui-title", "ui_dump", "选择文件"],
      ["ui-drive", "ui_dump", "打开云盘"],
      ["ui-upload", "ui_dump", "上传本地文件"],
    ]);
    const cloudFiles = makeDiscoveryObservation("cloud-files", [
      ["ui-title", "ui_dump", "云盘文件"],
      ["ui-search", "ui_dump", "搜索"],
      ["ui-empty", "ui_dump", "未搜索到相关结果"],
    ]);
    const albumSelector = makeDiscoveryObservation("album-selector", [
      ["ui-all", "ui_dump", "所有照片"],
      ["ui-shot", "ui_dump", "截屏"],
      ["ui-recent", "ui_dump", "最近存储"],
    ]);
    const photoPreview = makeDiscoveryObservation("photo-preview", [
      ["ui-back", "ui_dump", "返回"],
      ["ui-select", "ui_dump", "选择"],
      ["ui-next", "ui_dump", "下一步"],
    ]);
    const photoCrop = makeDiscoveryObservation("photo-crop", [
      ["ui-cancel", "ui_dump", "取消"],
      ["ui-rotate", "ui_dump", "逆时针旋转"],
      ["ui-done", "ui_dump", "完成"],
    ]);

    expect(classifyTargetedDiscoveryScene(filePicker.candidates)?.sceneId).toBe(
      "file.picker",
    );
    expect(classifyTargetedDiscoveryScene(cloudFiles.candidates)?.sceneId).toBe(
      "cloud.drive.files.empty",
    );
    expect(
      classifyTargetedDiscoveryScene(albumSelector.candidates)?.sceneId,
    ).toBe("photo.album.selector");
    expect(
      classifyTargetedDiscoveryScene(photoPreview.candidates)?.sceneId,
    ).toBe("photo.preview");
    expect(classifyTargetedDiscoveryScene(photoCrop.candidates)?.sceneId).toBe(
      "camera.photo_crop",
    );
  });

  test("classifies settings overlays and sound Scenes", () => {
    const modeMenu = makeDiscoveryObservation("mode-menu", [
      ["ui-fast", "ui_dump", "快速"],
      ["ui-expert", "ui_dump", "专家"],
      ["ui-turbo", "ui_dump", "工作任务 Turbo"],
      ["ui-pro", "ui_dump", "工作任务 Pro"],
    ]);
    const sound = makeDiscoveryObservation("sound", [
      ["ui-cancel", "ui_dump", "取消"],
      ["ui-use", "ui_dump", "使用"],
      ["ui-title", "ui_dump", "声音"],
      ["ui-background", "ui_dump", "后台声音朗读"],
    ]);
    const cloneVoice = makeDiscoveryObservation("clone-voice", [
      ["ui-title", "ui_dump", "克隆我的声音"],
      ["ui-record", "ui_dump", "录制自己的声音"],
      ["ui-confirm", "ui_dump", "确认录制"],
    ]);
    const memoryMenu = makeDiscoveryObservation("memory-menu", [
      ["ui-delete", "ui_dump", "删除全部记忆"],
    ]);
    const memory = makeDiscoveryObservation("memory", [
      ["ui-title", "ui_dump", "记忆"],
      ["ui-more", "ui_dump", "更多"],
      ["ui-description", "ui_dump", "豆包会自动从对话中提取内容优化回复"],
    ]);

    expect(classifyTargetedDiscoveryScene(modeMenu.candidates)?.sceneId).toBe(
      "bot.settings.default_mode_menu",
    );
    expect(classifyTargetedDiscoveryScene(sound.candidates)?.sceneId).toBe(
      "bot.settings.sound",
    );
    expect(classifyTargetedDiscoveryScene(cloneVoice.candidates)?.sceneId).toBe(
      "bot.settings.sound.clone_my_voice",
    );
    expect(classifyTargetedDiscoveryScene(memoryMenu.candidates)?.sceneId).toBe(
      "bot.settings.memory.more_menu",
    );
    expect(classifyTargetedDiscoveryScene(memory.candidates)?.sceneId).toBe(
      "bot.settings.memory",
    );
  });

  test("recognizes the sidebar despite OCR drift in nonessential labels", () => {
    expect(
      recognizeSceneByVisualText(
        fullGraph,
        ["Q 搜索", "S技能", "Al 创作", "云盘", "用户 876180〉"],
        "chat.sidebar",
      ),
    ).toBe("chat.sidebar");
  });

  test("rejects account-specific and timestamp text as stable identity anchors", () => {
    expect(isStableIdentityText("搜索")).toBeTrue();
    expect(isStableIdentityText("用户876180")).toBeFalse();
    expect(isStableIdentityText("User 876180")).toBeFalse();
    expect(isStableIdentityText("18:22")).toBeFalse();
  });

  test("classifies the cloud drive empty state from stable content anchors", () => {
    const cloudDrive = makeDiscoveryObservation("cloud-drive", [
      ["ui-recent", "ui_dump", "最近"],
      ["ui-mine", "ui_dump", "我的"],
      ["ui-empty", "ui_dump", "这里还没有任何文件"],
    ]);

    expect(classifyTargetedDiscoveryScene(cloudDrive.candidates)?.sceneId).toBe(
      "cloud.drive.recent.empty",
    );
  });

  test("classifies and completes the skills page without another Agent round", () => {
    const skills = makeDiscoveryObservation("skills", [
      ["ui-title", "ui_dump", "技能"],
      ["ui-stock", "ui_dump", "个股研究"],
      ["ui-valuation", "ui_dump", "估值建模"],
      ["ui-market", "ui_dump", "市场热点分析"],
    ]);

    expect(classifyTargetedDiscoveryScene(skills.candidates)?.sceneId).toBe(
      "skills.home",
    );
    expect(
      deterministicTargetedDiscoveryCompletion({
        goal: "打开侧边栏，然后进入技能页面",
        observation: skills,
      }),
    ).toEqual({
      oracle: {
        type: "text_visible",
        value: "技能 && 个股研究 && 估值建模",
      },
      evidence: [
        "技能页面标题可见。",
        "稳定技能条目“个股研究”和“估值建模”可见。",
      ],
    });
  });

  test("does not complete maximum font size before the required restart", () => {
    const observation = makeDiscoveryObservation("font-restart", [
      ["ui-title", "ui_dump", "字号与背景"],
      ["ui-restart-title", "ui_dump", "重启生效"],
      ["ui-restart-message", "ui_dump", "新的字体大小在重启后生效"],
      ["ui-restart", "ui_dump", "重启"],
    ]);
    const actions: TargetedDiscoveryAction[] = [
      {
        stepId: "discover-01-tap",
        purpose: "advance_goal",
        actionType: "tap",
        candidateId: "ui-font-max",
        targetText: "大",
        targetElementTitle: "大",
        targetSemanticRole: "Button",
        operatorTitle: "选择最大字号",
        risk: "selection",
        expectedOutcome: "将字号调整到最大。",
        expectedSceneTitle: "字号与背景设置",
        expectedVisualTextAnchors: ["字号与背景"],
        command: [],
        fromSceneId: "bot.settings.font_background",
        toSceneId: "bot.settings.font_background",
        beforeObservationId: "observation-00",
        afterObservationId: "observation-01",
        exitCode: 0,
      },
      {
        stepId: "discover-02-tap",
        purpose: "advance_goal",
        actionType: "tap",
        candidateId: "ui-confirm",
        targetText: "确认",
        targetElementTitle: "确认",
        targetSemanticRole: "Button",
        operatorTitle: "确认字号设置",
        risk: "mutation",
        expectedOutcome: "确认最大字号。",
        expectedSceneTitle: "字号重启提示",
        expectedVisualTextAnchors: ["重启生效"],
        command: [],
        fromSceneId: "bot.settings.font_background",
        toSceneId: "bot.settings.font_background.restart_prompt",
        beforeObservationId: "observation-01",
        afterObservationId: "font-restart",
        exitCode: 0,
      },
    ];

    expect(
      deterministicTargetedDiscoveryCompletion({
        goal: "将字号设置成最大",
        observation,
      }),
    ).toBeNull();
    expect(
      deterministicTargetedDiscoveryCompletion({
        goal: "将字号设置成最大",
        observation,
        actions,
      }),
    ).toBeNull();
  });

  test("does not truncate font discovery at the restart prompt", () => {
    const initial = makeDiscoveryObservation("observation-00", [
      ["ui-title", "ui_dump", "字号与背景"],
      ["ui-max", "ui_dump", "大"],
    ]);
    const selected = makeDiscoveryObservation("observation-01", [
      ["ui-title", "ui_dump", "字号与背景"],
      ["ui-reset", "ui_dump", "恢复默认"],
    ]);
    const completed = makeDiscoveryObservation("observation-02", [
      ["ui-restart-title", "ui_dump", "重启生效"],
      ["ui-restart-message", "ui_dump", "新的字体大小在重启后生效"],
      ["ui-restart", "ui_dump", "重启"],
    ]);
    const unrelated = makeDiscoveryObservation("observation-03", [
      ["ui-weather", "ui_dump", "天气"],
    ]);
    const baseAction = {
      purpose: "advance_goal" as const,
      actionType: "tap" as const,
      targetElementTitle: "目标",
      targetSemanticRole: "Button",
      operatorTitle: "动作",
      risk: "selection" as const,
      expectedSceneTitle: "字号与背景设置",
      expectedVisualTextAnchors: [],
      command: [],
      fromSceneId: "bot.settings.font_background",
      toSceneId: "bot.settings.font_background",
      exitCode: 0,
    };
    const actions: TargetedDiscoveryAction[] = [
      {
        ...baseAction,
        stepId: "discover-01-tap",
        candidateId: "ui-max",
        targetText: "大",
        expectedOutcome: "将字号调整到最大。",
        beforeObservationId: "observation-00",
        afterObservationId: "observation-01",
      },
      {
        ...baseAction,
        stepId: "discover-02-tap",
        candidateId: "ui-confirm",
        targetText: "确认",
        risk: "mutation",
        expectedOutcome: "确认最大字号。",
        beforeObservationId: "observation-01",
        afterObservationId: "observation-02",
      },
      {
        ...baseAction,
        stepId: "discover-03-tap",
        candidateId: "ui-restart",
        targetText: "重启",
        risk: "mutation",
        expectedOutcome: "重启 App。",
        beforeObservationId: "observation-02",
        afterObservationId: "observation-03",
      },
    ];

    expect(
      findDeterministicReplayCompletion({
        goal: "将字号设置成最大",
        observations: [initial, selected, completed, unrelated],
        actions,
      }),
    ).toBeUndefined();
  });

  test("requires PID proof when applying a restart-dependent setting", () => {
    expect(
      parseWaitLaunchResult(
        JSON.stringify({
          schemaVersion: "ios-ui-devicectl-wait-launch/v1",
          bundleId: "com.bot.doubao",
          oldPids: [101],
          newPid: 202,
          currentPids: [202],
          success: true,
        }),
      ),
    ).toEqual({
      bundleId: "com.bot.doubao",
      oldPids: [101],
      newPid: 202,
      currentPids: [202],
      success: true,
    });
    expect(() =>
      parseWaitLaunchResult(
        JSON.stringify({
          schemaVersion: "ios-ui-devicectl-wait-launch/v1",
          bundleId: "com.bot.doubao",
          oldPids: [101],
          newPid: 202,
          currentPids: [101, 202],
          success: true,
        }),
      ),
    ).toThrow("did not prove old-process exit");
  });

  test("uses a stable semantic Task ID for maximum font size", () => {
    expect(targetedDiscoverySemanticPrefix("将字号设置成最大")).toBe(
      "bot.settings.set_max_font_size",
    );
    expect(targetedDiscoverySemanticPrefix("把聊天字体调到最大")).toBe(
      "bot.settings.set_max_font_size",
    );
  });

  test("compiles the corrected maximum-font Task through restart and relaunch", () => {
    const task = fullGraph.tasks.find(
      (candidate) => candidate.taskId === "bot.settings.set_max_font_size",
    );
    expect(task).toBeDefined();

    const plan = compileExperimentPlan({
      graph: fullGraph,
      task: task!,
      parameters: {},
      udid: "device-1",
      allowCandidate: true,
    });

    expect(plan.steps.map((step) => step.operatorId)).toEqual([
      "chat.open_bot_settings",
      "bot.settings.fabd3ffe8b28.tap.bot.settings.font_background",
      "bot.settings.font_background.select_max_font",
      "bot.settings.font_background.confirm_max_font",
      "bot.settings.font_background.restart_and_relaunch",
    ]);
    expect(plan.steps.at(-1)).toMatchObject({
      operation: {
        type: "tap_restart_app",
        elementId: "bot.settings.font_background.restart_prompt.restart",
        bundleId: "com.bot.doubao",
      },
      expectedFromSceneId: "bot.settings.font_background.restart_prompt",
      expectedToSceneId: "chat.detail",
      executionTier: "guarded",
    });
    expect(plan.finalOracles).toEqual([
      { type: "scene_current", sceneId: "chat.detail" },
      { type: "foreground_bundle", bundleId: "com.bot.doubao" },
    ]);
  });

  test("classifies a deeper skills-list viewport from title-row geometry", () => {
    const observation = makeDiscoveryObservation("skills-deep", []);
    const skillsDeep: TargetedDiscoveryObservation = {
      ...observation,
      candidates: [
        {
          candidateId: "ui-title",
          source: "ui_dump",
          role: "StaticText",
          label: "技能",
          bounds: { x: 190, y: 60, width: 34, height: 20 },
        },
        ...["行业分析报告", "合同起草", "法律合规评估"].map((label, index) => ({
          candidateId: `ui-skill-${index}`,
          source: "ui_dump" as const,
          role: "StaticText",
          label,
          bounds: {
            x: 92,
            y: 82 + index * 86,
            width: 246,
            height: 25,
          },
        })),
      ],
    };

    expect(classifyTargetedDiscoveryScene(skillsDeep.candidates)?.sceneId).toBe(
      "skills.home",
    );
  });

  test("classifies a skill detail before the skills list", () => {
    const detail = makeDiscoveryObservation("skill-detail", [
      ["ui-skills", "ui_dump", "技能"],
      ["ui-stock", "ui_dump", "个股研究"],
      ["ui-valuation", "ui_dump", "估值建模"],
      ["ui-unsupported", "ui_dump", "完整内容暂不支持展示"],
      ["ui-add", "ui_dump", "添加"],
    ]);

    expect(classifyTargetedDiscoveryScene(detail.candidates)?.sceneId).toBe(
      "skills.detail",
    );
    expect(
      classifyTargetedDiscoveryScene(
        makeDiscoveryObservation("installed-skill-detail", [
          ["ui-skills", "ui_dump", "技能"],
          ["ui-stock", "ui_dump", "个股研究"],
          ["ui-valuation", "ui_dump", "估值建模"],
          ["ui-unsupported", "ui_dump", "完整内容暂不支持展示"],
          ["ui-try", "ui_dump", "在对话中试用"],
          ["ui-delete", "ui_dump", "删除"],
        ]).candidates,
      )?.sceneId,
    ).toBe("skills.detail");
  });

  test("classifies ActionBar middle and end variants from visible items", () => {
    expect(
      classifyTargetedDiscoveryScene(
        makeDiscoveryObservation("middle", [
          ["ui-photo", "ui_dump", "照片动起来"],
          ["ui-song", "ui_dump", "AI写歌"],
          ["ui-ppt", "ui_dump", "PPT 生成"],
          ["ui-translate", "ui_dump", "同声传译"],
        ]).candidates,
      )?.sceneId,
    ).toBe("chat.detail.actionbar_middle");
    expect(
      classifyTargetedDiscoveryScene(
        makeDiscoveryObservation("end", [
          ["ui-image", "ui_dump", "豆包 P 图"],
          ["ui-museum", "ui_dump", "博物馆讲解"],
          ["ui-study", "ui_dump", "豆包爱学"],
        ]).candidates,
      )?.sceneId,
    ).toBe("chat.detail.actionbar_end");
  });

  test("classifies the AI creation discovery page before camera-like layouts", () => {
    expect(
      classifyTargetedDiscoveryScene(
        makeDiscoveryObservation("image-generation-panel", [
          ["ui-reference", "ui_dump", "参考图"],
          ["ui-model", "ui_dump", "模型 4.5"],
          ["ui-ratio", "ui_dump", "比例 自动"],
          ["ui-play", "ui_dump", "玩法"],
          ["ui-input", "ui_dump", "描述你想要创作的内容..."],
        ]).candidates,
      )?.sceneId,
    ).toBe("chat.image_generation.panel");
    expect(
      classifyTargetedDiscoveryScene(
        makeDiscoveryObservation("ai-creation", [
          ["ui-close", "ui_dump", "关闭"],
          ["ui-discover", "ui_dump", "发现"],
          ["ui-video", "ui_dump", "视频"],
          ["ui-commerce", "ui_dump", "带货模板"],
          ["ui-image-edit", "ui_dump", "P 图"],
          ["ui-pet", "ui_dump", "萌宠"],
          ["ui-generate", "ui_dump", "图片生成"],
          ["ui-animate", "ui_dump", "照片动起来"],
          ["ui-more", "ui_dump", "更多面板"],
        ]).candidates,
      )?.sceneId,
    ).toBe("chat.ai_creation.discovery");
  });

  test("classifies customer service, debug, privacy, and permission dialogs", () => {
    const classify = (id: string, labels: string[]) =>
      classifyTargetedDiscoveryScene(
        makeDiscoveryObservation(
          id,
          labels.map(
            (label, index) =>
              [`ui-${index}`, "ui_dump", label] as [string, "ui_dump", string],
          ),
        ).candidates,
      )?.sceneId;

    expect(
      classify("customer-service", [
        "客服中心",
        "常用工具",
        "AI角色备份",
        "大家常问",
        "意见反馈",
        "在线咨询",
      ]),
    ).toBe("bot.settings.customer_service");
    expect(
      classify("online-consult", [
        "豆包小助手",
        "为你解答豆包使用问题（内容由AI生成）",
        "请输入您想咨询的问题...",
        "意见反馈",
        "反馈历史",
      ]),
    ).toBe("bot.settings.customer_service.online_consult");
    expect(
      classify("buy-before-ask", [
        "我的订单",
        "打开更多操作",
        "关闭当前页面",
        "更多面板",
      ]),
    ).toBe("chat.buy_before_ask");
    expect(
      classify("buy-before-ask-more-menu", [
        "关闭更多操作",
        "我的订单",
        "关闭当前页面",
        "按预算挑",
      ]),
    ).toBe("chat.buy_before_ask.more_menu");
    expect(
      classify("ai-song", ["AI 写歌", "开始写歌", "bar more", "bar exit"]),
    ).toBe("chat.ai_song");
    expect(
      classify("ai-song-more-menu", ["AI写歌", "重新进入", "关于", "问题反馈"]),
    ).toBe("chat.ai_song.more_menu");
    expect(
      classify("volcengine-console", [
        "火山方舟 - 首页",
        "快速接入",
        "接入模型",
        "示例代码",
      ]),
    ).toBe("volcengine.ark.console.home");
    expect(
      classify("volcengine-survey", [
        "火山方舟 - 首页",
        "【火山方舟】产品的推荐意愿度",
        "您还有哪些意见或建议？",
        "提交",
      ]),
    ).toBe("volcengine.ark.feedback.survey");
    expect(
      classify("volcengine-experience", [
        "火山方舟 - 体验",
        "欢迎来到",
        "精选",
        "语言",
        "Doubao-Seedance-2.5",
      ]),
    ).toBe("volcengine.ark.console.experience");
    expect(
      classify("about-debug", [
        "关于豆包 Debug",
        "用户协议",
        "隐私政策",
        "关于豆包大模型",
      ]),
    ).toBe("bot.settings.about_debug");
    expect(
      classify("privacy-summary", [
        "隐私政策简明版",
        "豆包《隐私政策》简明版",
        "更新时间：2024年11月28日",
        "我们如何收集、使用信息",
      ]),
    ).toBe("bot.settings.about_debug.privacy_summary");
    expect(
      classify("infringement-complaint", [
        "豆包侵权投诉指引",
        "豆包侵权投诉指引FAQ",
        "导言",
      ]),
    ).toBe("bot.settings.about_debug.infringement_complaint");
    expect(
      classify("shopping-wallet-faq", [
        "豆包购物及钱包功能FAQ",
        "1、豆包购物及钱包相关功能的提供者",
        "豆包隐私政策",
      ]),
    ).toBe("bot.settings.about_debug.shopping_wallet_faq");
    expect(
      classify("app-permissions", [
        "权限清单",
        "NSFaceIDUsageDescription",
        "NSCameraUsageDescription",
      ]),
    ).toBe("bot.settings.about_debug.app_permissions");
    expect(
      classify("personal-information-list", [
        "个人信息收集清单",
        "个人信息列表",
        "个人资料",
        "当前设备信息",
      ]),
    ).toBe("bot.settings.personal_information_collection_list");
    expect(
      classify("personal-profile", [
        "个人资料",
        "选择时间范围",
        "最近 7 天",
        "手机号收集情况说明",
        "信息内容：",
      ]),
    ).toBe("bot.settings.personal_information_collection.personal_profile");
    expect(
      classify("app-info", [
        "应用信息",
        "选择时间范围",
        "最近 7 天",
        "APP名称收集情况说明",
      ]),
    ).toBe("bot.settings.personal_information_collection.app_info");
    expect(
      classify("current-device-info", [
        "当前设备信息",
        "IDFA收集情况说明",
        "信息内容：",
      ]),
    ).toBe("bot.settings.personal_information_collection.current_device_info");
    expect(
      classify("time-range-menu", [
        "选择时间范围",
        "最近 7 天",
        "最近一月",
        "最近一年",
        "取消",
      ]),
    ).toBe("bot.settings.personal_information_collection.time_range_menu");
    expect(
      classify("third-party-information-list", [
        "第三方信息共享清单",
        "一、第三方SDK目录",
        "合作方隐私政策",
        "官网链接：",
      ]),
    ).toBe("bot.settings.third_party_information_sharing_list");
    expect(
      classify("privacy-permissions", [
        "隐私与权限",
        "数据权限",
        "系统权限",
        "黑名单",
      ]),
    ).toBe("bot.settings.privacy.permissions");
    expect(
      classify("microphone-dialog", ["麦克风权限", "取消", "去设置"]),
    ).toBe("bot.settings.privacy.permissions.microphone.permission.dialog");
  });

  test("classifies the Volcengine home WebView separately from model about", () => {
    const volcengine = makeDiscoveryObservation("volcengine-home", [
      ["ui-title", "ui_dump", "火山引擎-你的AI云"],
      ["ui-build", "ui_dump", "立即构建"],
      ["ui-service", "ui_dump", "一站式大模型服务平台"],
      ["ui-why", "ui_dump", "为什么选火山"],
    ]);

    expect(classifyTargetedDiscoveryScene(volcengine.candidates)?.sceneId).toBe(
      "bot.settings.about_debug.model_about.volcengine_home",
    );
  });

  test("classifies Volcengine quickstart and API example documents", () => {
    const quickstart = makeDiscoveryObservation("ark-quickstart", [
      ["ui-title", "ui_dump", "快速入门 - 火山方舟 - 火山引擎"],
      ["ui-beginner", "ui_dump", "快速入门（新手版）"],
      ["ui-duration", "ui_dump", "数分钟内完成你的首次 API 调用。"],
      ["ui-key", "ui_dump", "获取并配置 API Key"],
    ]);
    const apiExamples = makeDiscoveryObservation("ark-api-examples", [
      ["ui-api-key", "ui_dump", "ARK_API_KEY"],
      ["ui-sdk", "ui_dump", "volcenginesdkarkruntime"],
      ["ui-base-url", "ui_dump", "base_url"],
      ["ui-input-image", "ui_dump", "支持输入图片的模型系列是哪个？"],
    ]);

    expect(classifyTargetedDiscoveryScene(quickstart.candidates)?.sceneId).toBe(
      "volcengine.ark.docs.quickstart",
    );
    expect(
      classifyTargetedDiscoveryScene(apiExamples.candidates)?.sceneId,
    ).toBe("volcengine.ark.docs.api_examples");
  });

  test("validates stable Agent Graph synthesis against discovery evidence", () => {
    const before = makeDiscoveryObservation("observation-00", [
      ["ui-message", "ui_dump", "最后一条消息"],
    ]);
    const after = makeDiscoveryObservation("observation-01", [
      ["ui-copy", "ui_dump", "复制"],
      ["ui-read", "ui_dump", "朗读"],
      ["ui-ask", "ui_dump", "追问"],
      ["ui-more", "ui_dump", "更多"],
    ]);
    const action: TargetedDiscoveryAction = {
      stepId: "discover-01-long_press",
      purpose: "advance_goal",
      actionType: "long_press",
      candidateId: "ui-message",
      targetText: "最后一条消息",
      targetElementTitle: "最后一条消息",
      targetSemanticRole: "last_message",
      operatorTitle: "长按最后一条消息",
      risk: "interaction",
      expectedOutcome: "message.menu.visible=true",
      expectedSceneTitle: "消息操作菜单",
      expectedVisualTextAnchors: ["复制", "朗读", "追问", "更多"],
      command: [],
      fromSceneId: "chat.detail",
      toSceneId: "chat.message_action_menu",
      beforeObservationId: before.observationId,
      afterObservationId: after.observationId,
      exitCode: 0,
    };
    const valid = validateGraphSynthesisProposal({
      graph: fullGraph,
      observations: [before, after],
      actions: [action],
      proposal: {
        taskId: "message.delete_last",
        taskTitle: "删除最后一条消息",
        taskSummary: "长按最后一条消息并打开操作菜单。",
        scenes: [
          {
            observationId: before.observationId,
            sceneId: "chat.detail",
            title: "会话页",
            aliases: [],
            visualTextAnchors: [],
          },
          {
            observationId: after.observationId,
            sceneId: "chat.message_action_menu",
            title: "消息操作菜单",
            aliases: [],
            visualTextAnchors: ["复制", "朗读", "追问", "更多"],
          },
        ],
        actions: [
          {
            stepId: action.stepId,
            elementId: "message.delete_last.target_message",
            elementTitle: "最后一条消息",
            semanticRole: "last_message",
            operatorId: "message.delete_last.open_action_menu",
            operatorTitle: "长按最后一条消息",
            fromSceneId: "chat.detail",
            toSceneId: "chat.message_action_menu",
            effect: "message.menu.visible=true",
          },
        ],
        reason: "Stable semantic naming follows the observed message menu.",
      },
    });
    const invalid = validateGraphSynthesisProposal({
      graph: fullGraph,
      observations: [before, after],
      actions: [action],
      proposal: {
        taskId: "discovery.1",
        taskTitle: "探索",
        taskSummary: "generic",
        scenes: [
          {
            observationId: before.observationId,
            sceneId: "chat.detail",
            title: "会话页",
            aliases: [],
            visualTextAnchors: [],
          },
          {
            observationId: after.observationId,
            sceneId: "photo.picker",
            title: "错误页面",
            aliases: [],
            visualTextAnchors: ["复制"],
          },
        ],
        actions: [
          {
            stepId: action.stepId,
            elementId: "item",
            elementTitle: "item",
            semanticRole: "item",
            operatorId: "item",
            operatorTitle: "item",
            fromSceneId: "chat.detail",
            toSceneId: "photo.picker",
            effect: "unknown",
          },
        ],
        reason: "generic",
      },
    });

    expect(valid.valid).toBeTrue();
    expect(invalid.valid).toBeFalse();
    expect(
      invalid.issues.some((issue) => issue.includes("generic")),
    ).toBeTrue();
    expect(
      invalid.issues.some((issue) =>
        issue.includes("deterministic classification"),
      ),
    ).toBeTrue();
  });

  test("allows Agent Graph synthesis to reuse an equivalent existing navigation edge", () => {
    const before = makeDiscoveryObservation("observation-00", [
      ["ui-sidebar", "ui_dump", "对话列表"],
    ]);
    const after = makeDiscoveryObservation("observation-01", [
      ["ui-search", "ui_dump", "搜索"],
      ["ui-skills", "ui_dump", "技能"],
      ["ui-drive", "ui_dump", "云盘"],
      ["ui-user", "ui_dump", "用户876180"],
    ]);
    const action: TargetedDiscoveryAction = {
      stepId: "discover-01-tap",
      purpose: "advance_goal",
      actionType: "tap",
      candidateId: "ui-sidebar",
      targetText: "对话列表",
      targetElementTitle: "对话列表",
      targetSemanticRole: "Button",
      operatorTitle: "打开侧边栏",
      risk: "navigation",
      expectedOutcome: "scene.current=chat.sidebar",
      expectedSceneTitle: "会话侧边栏",
      expectedVisualTextAnchors: ["搜索", "技能", "云盘"],
      command: [],
      fromSceneId: "chat.detail",
      toSceneId: "chat.sidebar",
      beforeObservationId: before.observationId,
      afterObservationId: after.observationId,
      exitCode: 0,
    };

    const validation = validateGraphSynthesisProposal({
      graph: fullGraph,
      observations: [before, after],
      actions: [action],
      proposal: {
        taskId: "cloud_drive.open_from_chat_sidebar",
        taskTitle: "打开侧边栏进入云盘",
        taskSummary: "复用侧边栏入口后进入云盘。",
        scenes: [
          {
            observationId: before.observationId,
            sceneId: "chat.detail",
            title: "会话页",
            aliases: [],
            visualTextAnchors: [],
          },
          {
            observationId: after.observationId,
            sceneId: "chat.sidebar",
            title: "会话侧边栏",
            aliases: [],
            visualTextAnchors: ["搜索", "技能", "云盘"],
          },
        ],
        actions: [
          {
            stepId: action.stepId,
            elementId: "chat.sidebar_entry",
            elementTitle: "对话列表",
            semanticRole: "Button",
            operatorId: "chat.open_sidebar",
            operatorTitle: "打开侧边栏",
            fromSceneId: "chat.detail",
            toSceneId: "chat.sidebar",
            effect: "scene.current=chat.sidebar",
          },
        ],
        reason: "The observed action is the existing sidebar edge.",
      },
    });

    expect(validation).toEqual({ valid: true, issues: [] });
  });

  test("derives a bounded horizontal swipe region from one UI band", () => {
    const candidates: TargetedDiscoveryObservation["candidates"] = [
      ["快速", 20],
      ["AI 创作", 110],
      ["帮我写作", 210],
      ["买前问豆包", 310],
    ].map(([label, x], index) => ({
      candidateId: `ui-${index + 1}`,
      source: "ui_dump" as const,
      role: "Button",
      label: String(label),
      bounds: { x: Number(x), y: 720, width: 80, height: 44 },
    }));

    const regions = deriveHorizontalGestureCandidates(candidates);

    expect(regions).toHaveLength(1);
    expect(regions[0]?.role).toBe("HorizontalScrollRegion");
    expect(regions[0]?.value).toContain("快速");
    expect(regions[0]?.value).toContain("买前问豆包");
    expect(regions[0]?.bounds.width).toBeGreaterThan(300);
  });

  test("uses a stable horizontal region as a completion Oracle", async () => {
    const region = {
      candidateId: "gesture-horizontal-1",
      source: "ui_dump" as const,
      role: "HorizontalScrollRegion",
      label: "横向可滑动区域：快速 | AI 创作 | 帮我写作",
      value: "快速|AI 创作|帮我写作",
      bounds: { x: 20, y: 720, width: 360, height: 60 },
    };
    const initial = {
      ...makeDiscoveryObservation("observation-00", []),
      candidates: [region],
    };
    const current = {
      ...makeDiscoveryObservation("observation-01", []),
      candidates: [region],
    };

    expect(
      await verifyTargetedDiscoveryCompletion({
        oracle: { type: "region_stable", value: region.value },
        initialObservation: initial,
        currentObservation: current,
      }),
    ).toBeTrue();
  });

  test("treats && in text_visible as a conjunction of visible anchors", async () => {
    const initial = makeDiscoveryObservation("observation-00", []);
    const sidebar = makeDiscoveryObservation("observation-01", [
      ["ui-search", "ui_dump", "搜索"],
      ["ui-skills", "ui_dump", "技能"],
      ["ui-drive", "ui_dump", "云盘"],
      ["ui-user", "ui_dump", "用户876180"],
    ]);

    expect(
      await verifyTargetedDiscoveryCompletion({
        oracle: {
          type: "text_visible",
          value: "搜索 && 技能 && 云盘 && 用户876180",
        },
        initialObservation: initial,
        currentObservation: sidebar,
      }),
    ).toBeTrue();
    expect(
      matchesVisibleTextOracle(
        ["技能", "个股研究", "估值建模"],
        "技能 && 个股研究 && 估值建模",
      ),
    ).toBeTrue();
  });

  test("persists a discovered horizontal scroll as a swipe Operator", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-targeted-swipe-test-"));
    const graphPath = join(outputDir, "graph.json");
    const initialGraph: ExecutableUiGraphExperiment = {
      ...fullGraph,
      elements: fullGraph.elements.filter(
        (element) =>
          !element.elementId.startsWith("chat.actionbar_scroll_end."),
      ),
      operators: fullGraph.operators.filter(
        (operator) =>
          !operator.operatorId.startsWith("chat.actionbar_scroll_end."),
      ),
      tasks: fullGraph.tasks.filter(
        (task) => task.taskId !== "chat.actionbar_scroll_end",
      ),
    };
    const region = {
      candidateId: "gesture-horizontal-1",
      source: "ui_dump" as const,
      role: "HorizontalScrollRegion",
      label: "横向可滑动区域：快速 | AI 创作 | 帮我写作",
      value: "快速|AI 创作|帮我写作",
      bounds: { x: 20, y: 720, width: 360, height: 60 },
    };
    const before = {
      ...makeDiscoveryObservation("observation-00", []),
      candidates: [region],
    };
    const after = {
      ...makeDiscoveryObservation("observation-01", []),
      candidates: [region],
    };
    const action: TargetedDiscoveryAction = {
      stepId: "discover-01-swipe_left",
      purpose: "advance_goal",
      actionType: "swipe_left",
      candidateId: region.candidateId,
      targetText: region.label,
      targetElementTitle: "ActionBar 横向区域",
      targetSemanticRole: "actionbar_scroll_region",
      operatorTitle: "向左滑动 ActionBar",
      risk: "interaction",
      expectedOutcome: "actionbar.visible_items.changed=true",
      expectedSceneTitle: "会话页 ActionBar 末尾态",
      expectedVisualTextAnchors: [],
      command: [
        "mobilecli",
        "io",
        "swipe",
        "--device",
        "device-1",
        "337,750,63,750",
      ],
      fromSceneId: "chat.detail",
      toSceneId: "chat.detail",
      beforeObservationId: before.observationId,
      afterObservationId: after.observationId,
      exitCode: 0,
    };
    try {
      await writeFile(graphPath, `${JSON.stringify(initialGraph)}\n`, "utf8");
      const patch = await persistTargetedDiscoveryGraphPatch({
        graph: initialGraph,
        graphPath,
        outputDir,
        goal: "滑动actionbar到最后",
        observations: [before, after],
        actions: [action],
        completionOracle: {
          type: "region_stable",
          value: region.value,
        },
        completionEvidence: ["ActionBar items remained stable after swipe."],
        evidencePath: join(outputDir, "discovery-result.json"),
        deviceProfileId: initialGraph.defaultDeviceProfileId,
        synthesisProposal: {
          taskId: "chat.actionbar.reach_end",
          taskTitle: "滑动 ActionBar 到末尾",
          taskSummary: "向左滑动 ActionBar，直到可见项集合稳定。",
          scenes: [
            {
              observationId: before.observationId,
              sceneId: "chat.detail",
              title: "会话页",
              aliases: [],
              visualTextAnchors: [],
            },
            {
              observationId: after.observationId,
              sceneId: "chat.detail.actionbar_end_test",
              title: "会话页 ActionBar 测试末尾态",
              aliases: [],
              visualTextAnchors: [],
            },
          ],
          actions: [
            {
              stepId: action.stepId,
              elementId: "chat.actionbar.test_scroll_region",
              elementTitle: "ActionBar 横向滑动区域",
              semanticRole: "actionbar_scroll_region",
              operatorId: "chat.actionbar.swipe_to_end_test",
              operatorTitle: "向左滑动 ActionBar 到测试末尾",
              fromSceneId: "chat.detail",
              toSceneId: "chat.detail.actionbar_end_test",
              effect: "actionbar.end_visible=true",
            },
          ],
          reason: "Stable semantic synthesis for the observed ActionBar path.",
        },
      });
      const patched = JSON.parse(await readFile(graphPath, "utf8")) as {
        operators: Array<{
          operatorId: string;
          operation: { type: string; from?: unknown; to?: unknown };
        }>;
      };
      const operator = patched.operators.find(
        (item) => item.operatorId === "chat.actionbar.swipe_to_end_test",
      );
      expect(patch.candidateTaskId).toBe("chat.actionbar.reach_end");
      expect(operator?.operation.type).toBe("swipe");
      expect(operator?.operation.from).toEqual({ x: 337, y: 750 });
      expect(operator?.operation.to).toEqual({ x: 63, y: 750 });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("persists targeted discovery entities as candidate Graph data", async () => {
    const outputDir = await mkdtemp(
      join(tmpdir(), "ios-targeted-discovery-test-"),
    );
    const graphPath = join(outputDir, "graph.json");
    const before = makeDiscoveryObservation("observation-00", [
      ["ui-message", "ui_dump", "最后一条消息"],
    ]);
    const after = makeDiscoveryObservation("observation-01", [
      ["ui-delete", "ui_dump", "删除"],
    ]);
    const final = makeDiscoveryObservation("observation-02", [
      ["ui-chat", "ui_dump", "发消息或按住说话"],
    ]);
    const actions: TargetedDiscoveryAction[] = [
      {
        stepId: "discover-01-long_press",
        purpose: "advance_goal",
        actionType: "long_press",
        candidateId: "ui-message",
        targetText: "最后一条消息",
        targetElementTitle: "最后一条消息",
        targetSemanticRole: "last_message",
        operatorTitle: "长按最后一条消息",
        risk: "interaction",
        expectedOutcome: "message.menu.visible=true",
        expectedSceneTitle: "消息操作菜单",
        expectedVisualTextAnchors: ["删除"],
        command: [],
        fromSceneId: "chat.detail",
        toSceneId: "discovery.observation-01",
        beforeObservationId: "observation-00",
        afterObservationId: "observation-01",
        exitCode: 0,
      },
      {
        stepId: "discover-02-tap",
        purpose: "advance_goal",
        actionType: "tap",
        candidateId: "ui-delete",
        targetText: "删除",
        targetElementTitle: "删除消息",
        targetSemanticRole: "delete_message",
        operatorTitle: "删除最后一条消息",
        risk: "destructive",
        expectedOutcome: "message.deleted=true",
        expectedSceneTitle: "会话页",
        expectedVisualTextAnchors: ["发消息或按住说话"],
        command: [],
        fromSceneId: "discovery.observation-01",
        toSceneId: "chat.detail",
        beforeObservationId: "observation-01",
        afterObservationId: "observation-02",
        exitCode: 0,
      },
    ];
    try {
      await writeFile(graphPath, `${JSON.stringify(fullGraph)}\n`, "utf8");
      const patch = await persistTargetedDiscoveryGraphPatch({
        graph: fullGraph,
        graphPath,
        outputDir,
        goal: "删除最后1条消息",
        observations: [before, after, final],
        actions,
        completionOracle: { type: "text_absent", value: "最后一条消息" },
        completionEvidence: ["最后一条消息已不可见"],
        evidencePath: join(outputDir, "discovery-result.json"),
        deviceProfileId: fullGraph.defaultDeviceProfileId,
      });
      const patched = JSON.parse(await readFile(graphPath, "utf8")) as {
        elements: Array<{
          elementId: string;
          bindings: Array<{ status: string }>;
        }>;
        operators: Array<{ operatorId: string; status: string }>;
        tasks: Array<{
          taskId: string;
          status: string;
          validation?: { source: string };
        }>;
      };
      const task = patched.tasks.find(
        (item) => item.taskId === patch.candidateTaskId,
      );
      expect(patch.candidateTaskId).toBe("message.delete_last");
      expect(task?.status).toBe("candidate");
      expect(task?.validation?.source).toBe("targeted_discovery");
      expect(
        patched.operators
          .filter((item) => item.operatorId.startsWith("discovery."))
          .every((item) => item.status === "candidate"),
      ).toBeTrue();
      expect(
        patched.elements
          .filter((item) => item.elementId.startsWith("discovery."))
          .every((item) =>
            item.bindings.every((binding) => binding.status === "candidate"),
          ),
      ).toBeTrue();
      const executablePatched = JSON.parse(
        await readFile(graphPath, "utf8"),
      ) as ExecutableUiGraphExperiment;
      const candidateTask = executablePatched.tasks.find(
        (item) => item.taskId === patch.candidateTaskId,
      );
      expect(candidateTask).toBeDefined();
      expect(() =>
        compileExperimentPlan({
          graph: executablePatched,
          task: candidateTask!,
          parameters: {},
          udid: "device-1",
          allowCandidate: false,
        }),
      ).toThrow("requires an isolated fixture replay");
      const replayPlan = compileExperimentPlan({
        graph: {
          ...executablePatched,
          tasks: executablePatched.tasks.map((task) =>
            task.taskId === candidateTask!.taskId
              ? {
                  ...task,
                  validation: {
                    ...task.validation!,
                    requiresFixtureReplay: false,
                  },
                }
              : task,
          ),
        },
        task: {
          ...candidateTask!,
          validation: {
            ...candidateTask!.validation!,
            requiresFixtureReplay: false,
          },
        },
        parameters: {},
        udid: "device-1",
        allowCandidate: true,
      });
      expect(replayPlan.steps[0]?.command.slice(0, 3)).toEqual([
        "mobilecli",
        "io",
        "longpress",
      ]);
      expect(() =>
        compileExperimentPlan({
          graph: executablePatched,
          task: candidateTask!,
          parameters: {},
          udid: "device-1",
          allowCandidate: true,
        }),
      ).toThrow("requires an isolated fixture replay");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("promotes a safe targeted discovery path after two distinct successful executions", async () => {
    const outputDir = await mkdtemp(
      join(tmpdir(), "ios-targeted-promotion-test-"),
    );
    const graphPath = join(outputDir, "graph.json");
    const before = makeDiscoveryObservation("promotion-before", [
      ["ui-entry", "ui_dump", "测试入口"],
    ]);
    const after = makeDiscoveryObservation("promotion-after", [
      ["ui-destination", "ui_dump", "测试目标页"],
    ]);
    const action: TargetedDiscoveryAction = {
      stepId: "discover-01-tap",
      purpose: "advance_goal",
      actionType: "tap",
      candidateId: "ui-entry",
      targetText: "测试入口",
      targetElementTitle: "测试入口",
      targetSemanticRole: "Button",
      operatorTitle: "进入测试目标页",
      risk: "navigation",
      expectedOutcome: "scene.current=test.destination",
      expectedSceneTitle: "测试目标页",
      expectedVisualTextAnchors: ["测试目标页"],
      command: [],
      fromSceneId: "chat.detail",
      toSceneId: "test.destination",
      beforeObservationId: before.observationId,
      afterObservationId: after.observationId,
      exitCode: 0,
    };
    const proposal = {
      taskId: "test.open.destination",
      taskTitle: "打开测试目标页",
      taskSummary: "从会话页打开测试目标页。",
      scenes: [
        {
          observationId: before.observationId,
          sceneId: "chat.detail",
          title: "会话页",
          aliases: [],
          visualTextAnchors: [],
        },
        {
          observationId: after.observationId,
          sceneId: "test.destination",
          title: "测试目标页",
          aliases: [],
          visualTextAnchors: ["测试目标页"],
        },
      ],
      actions: [
        {
          stepId: action.stepId,
          elementId: "test.destination.entry",
          elementTitle: "测试入口",
          semanticRole: "Button",
          operatorId: "test.open.destination",
          operatorTitle: "进入测试目标页",
          fromSceneId: "chat.detail",
          toSceneId: "test.destination",
          effect: "scene.current=test.destination",
        },
      ],
      reason: "Stable test navigation semantics.",
    };
    try {
      await writeFile(graphPath, `${JSON.stringify(fullGraph)}\n`, "utf8");
      await persistTargetedDiscoveryGraphPatch({
        graph: fullGraph,
        graphPath,
        outputDir,
        goal: "打开测试目标页",
        observations: [before, after],
        actions: [action],
        completionOracle: {
          type: "text_visible",
          value: "测试目标页",
        },
        completionEvidence: ["测试目标页可见"],
        evidencePath: join(outputDir, "result-1.json"),
        deviceProfileId: fullGraph.defaultDeviceProfileId,
        synthesisProposal: proposal,
      });
      const first = JSON.parse(
        await readFile(graphPath, "utf8"),
      ) as ExecutableUiGraphExperiment;
      expect(
        first.tasks.find((task) => task.taskId === proposal.taskId)?.status,
      ).toBe("candidate");

      await persistTargetedDiscoveryGraphPatch({
        graph: first,
        graphPath,
        outputDir,
        goal: "打开测试目标页",
        observations: [before, after],
        actions: [action],
        completionOracle: {
          type: "text_visible",
          value: "测试目标页",
        },
        completionEvidence: ["测试目标页再次可见"],
        evidencePath: join(outputDir, "result-2.json"),
        deviceProfileId: first.defaultDeviceProfileId,
        synthesisProposal: proposal,
      });
      const second = JSON.parse(
        await readFile(graphPath, "utf8"),
      ) as ExecutableUiGraphExperiment;
      const task = second.tasks.find(
        (candidate) => candidate.taskId === proposal.taskId,
      );
      const operator = second.operators.find(
        (candidate) => candidate.operatorId === "test.open.destination",
      );
      const element = second.elements.find(
        (candidate) => candidate.elementId === "test.destination.entry",
      );
      expect(task?.status).toBe("verified");
      expect(task?.validation?.successfulExecutions).toBe(2);
      expect(operator?.status).toBe("verified");
      expect(
        element?.bindings.every((binding) => binding.status === "verified"),
      ).toBeTrue();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("rejects caller parameters outside an explicit Task contract", async () => {
    expect(
      resolveSemanticGoal({
        graph: fullGraph,
        taskId: "chat.load_more",
        goal: "",
        parameters: { direction: "up" },
        cwd: "/tmp",
        minimumConfidence: 0.8,
      }),
    ).rejects.toThrow("does not accept parameter direction");
  });
});

function makeDiscoveryObservation(
  observationId: string,
  candidates: Array<[string, "ui_dump" | "vision_ocr", string]>,
): TargetedDiscoveryObservation {
  return {
    observationId,
    screenshotPath: `/tmp/${observationId}.png`,
    uiDumpPath: `/tmp/${observationId}.json`,
    ocrPath: `/tmp/${observationId}.ocr.json`,
    matchedSceneId:
      observationId === "observation-00" || observationId === "observation-02"
        ? "chat.detail"
        : null,
    candidateSceneId: `discovery.${observationId}`,
    candidateSceneTitle: `探索 ${observationId}`,
    visualTextAnchors: candidates.map((item) => item[2]),
    candidates: candidates.map(([candidateId, source, text], index) => ({
      candidateId,
      source,
      role: source === "ui_dump" ? "Button" : "TextObservation",
      label: source === "ui_dump" ? text : undefined,
      text: source === "vision_ocr" ? text : undefined,
      bounds: { x: 20 + index * 20, y: 100, width: 80, height: 30 },
    })),
  };
}
