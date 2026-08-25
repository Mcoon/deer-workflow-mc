import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import graphJson from "../../examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json";
import { WorkflowRunner } from "@deerwork-ai/deer-workflow/runner";

import {
  buildStrictRestartCommand,
  buildStepCommands,
  parseStrictRestartResult,
  parseForegroundApp,
  parseInstalledAppVersion,
  resolveSemanticStepTarget,
  viewportSearchTargetYRange,
  runGroundCaptureCommand,
  validatePlanAgainstGraph,
} from "../../examples/app-graph-exec/workflow";
import type { AppGraphExecOutput } from "../../examples/app-graph-exec/types";
import type { AppGraphPlanOutput } from "../../examples/app-graph-plan/types";
import type { AppGraph } from "../../examples/ios-ui-graph-manager/types";
import type { AppGraphDiscoveryOutput } from "../../examples/app-graph-discovery/types";
import {
  buildDiscoveryActionCommand,
  buildDiscoveryPatch,
  diagnoseAndRecoverStableDiscovery,
  discoveryCompletionIssue,
  runDiscoveryCaptureCommand,
  resolveDiscoveryExpectedSceneId,
  resolveDiscoveryElement,
  resolveVisibleDiscoveryElement,
  waitForStableDiscoveryObservation,
} from "../../examples/app-graph-discovery/workflow";
import {
  buildViewportSearchCommand,
  isHistoricalViewportHintStep,
  searchViewports,
  viewportSearchAxisForTarget,
} from "../../examples/app-graph-exec/viewport-search";
import { applyPatch } from "../../examples/ios-ui-graph-manager/patch";
import type { AppGraphAcceptOutput } from "../../examples/app-graph-accept/types";
import {
  normalizeCaseVerification,
  resolveCaseVerification,
} from "../../examples/app-graph-accept/workflow";
import type {
  AgentFunction,
  AgentOptions,
} from "@deerwork-ai/deer-workflow/agents";
import {
  buildRuntimeCandidates,
  buildRuntimeRecoveryCommand,
  classifyRuntimeScene,
  decideSceneRecoveryWithAgent,
  persistRuntimeTransition,
  resolveElementWithAgent,
  runtimeSceneMatches,
} from "../../examples/app-graph-exec/runtime-recovery";

const graph = graphJson as AppGraph;
const graphPath = join(
  process.cwd(),
  "examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);
const planWorkflowPath = join(
  process.cwd(),
  "examples/app-graph-plan/workflow.ts",
);
const execWorkflowPath = join(
  process.cwd(),
  "examples/app-graph-exec/workflow.ts",
);
const discoveryWorkflowPath = join(
  process.cwd(),
  "examples/app-graph-discovery/workflow.ts",
);
const acceptWorkflowPath = join(
  process.cwd(),
  "examples/app-graph-accept/workflow.ts",
);

describe("App Graph Plan pipeline", () => {
  test("resolves live selectors before a permitted coordinate fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-pipeline-selector-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开侧边栏",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const step = plan.resolvedSteps[0]!;
      const resolution = resolveSemanticStepTarget({
        step,
        uiElements: [
          {
            role: "Button",
            accessibilityId: "对话列表",
            label: "对话列表",
            bounds: { x: 10, y: 20, width: 40, height: 30 },
          },
        ],
        deviceProfileId: plan.deviceProfileId,
        viewportWidth: 414,
        viewportHeight: 896,
      });
      expect(resolution).toMatchObject({
        source: "live_selector",
        bindingUsed: "selector",
        point: { x: 30, y: 35 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls through selector priority when the accessibility identifier drifts", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-pipeline-label-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开侧边栏",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const resolution = resolveSemanticStepTarget({
        step: plan.resolvedSteps[0]!,
        uiElements: [
          {
            role: "Button",
            accessibilityId: "sidebar-entry-v2",
            label: "对话列表",
            bounds: { x: 10, y: 20, width: 40, height: 30 },
          },
        ],
        deviceProfileId: plan.deviceProfileId,
        viewportWidth: 414,
        viewportHeight: 896,
      });
      expect(resolution).toMatchObject({
        source: "live_selector",
        bindingUsed: "selector",
        point: { x: 30, y: 35 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("matches a stable selector with a delimited presentation suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-selector-suffix-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开侧边栏，然后进入技能页面",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const step = plan.resolvedSteps.at(-1)!;
      expect(
        resolveSemanticStepTarget({
          step,
          uiElements: [
            {
              role: "StaticText",
              accessibilityId: "技能 · 连接器",
              label: "技能 · 连接器",
              bounds: { x: 60, y: 198, width: 101, height: 20 },
            },
            uiElement("技能包", 16, 330),
          ],
          deviceProfileId: plan.deviceProfileId,
          viewportWidth: 414,
          viewportHeight: 896,
        }),
      ).toMatchObject({
        source: "live_selector",
        point: { x: 110.5, y: 208 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an old Plan Binding when the runtime App version changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-runtime-version-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开侧边栏",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      expect(
        resolveSemanticStepTarget({
          step: plan.resolvedSteps[0]!,
          uiElements: [],
          deviceProfileId: plan.deviceProfileId,
          viewportWidth: 414,
          viewportHeight: 896,
          runtimeAppVersion: "99.0.0",
          graphAppVersion: graph.appVersion,
          requireVersionMatch: true,
        }),
      ).toMatchObject({
        source: "unresolved",
        bindingUsed: "missing",
      });
      expect(
        resolveSemanticStepTarget({
          step: plan.resolvedSteps[0]!,
          uiElements: [],
          deviceProfileId: plan.deviceProfileId,
          viewportWidth: 414,
          viewportHeight: 896,
          graphAppVersion: graph.appVersion,
          requireVersionMatch: true,
        }),
      ).toMatchObject({
        source: "unresolved",
        bindingUsed: "missing",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("permits a Plan Binding only when runtime, Graph, and Binding versions match", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-binding-version-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开侧边栏",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const step = plan.resolvedSteps[0]!;
      const versionedStep = {
        ...step,
        binding: { ...step.binding, appVersion: graph.appVersion },
      };
      expect(
        resolveSemanticStepTarget({
          step: versionedStep,
          uiElements: [],
          deviceProfileId: plan.deviceProfileId,
          viewportWidth: 414,
          viewportHeight: 896,
          runtimeAppVersion: graph.appVersion,
          graphAppVersion: graph.appVersion,
          requireVersionMatch: true,
        }),
      ).toMatchObject({
        source: "binding_fallback",
        bindingUsed: "verified",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("scrolls toward an offscreen selector instead of tapping outside the viewport", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-offscreen-target-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开帮助与反馈",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const originalStep = plan.resolvedSteps.at(-1)!;
      const step = {
        ...originalStep,
        targetElement: originalStep.targetElement
          ? {
              ...originalStep.targetElement,
              locationHint: {
                region: "bottom_center" as const,
                description: "页面底部中间区域",
                sourceDeviceProfileId: plan.deviceProfileId,
              },
            }
          : undefined,
      };
      const offscreen = {
        role: "StaticText",
        accessibilityId: "帮助与反馈",
        label: "帮助与反馈",
        bounds: { x: 20, y: 1380, width: 374, height: 72 },
      };
      const conflictingChild = {
        ...offscreen,
        bounds: { x: 16, y: 92, width: 262, height: 44 },
      };
      expect(
        resolveSemanticStepTarget({
          step,
          uiElements: [offscreen, conflictingChild],
          deviceProfileId: plan.deviceProfileId,
          viewportWidth: 414,
          viewportHeight: 896,
          deferBindingFallback: true,
        }),
      ).toMatchObject({ source: "unresolved" });
      expect(
        buildViewportSearchCommand({
          udid: "device-1",
          axis: "vertical",
          direction: "up",
          viewportWidth: 414,
          viewportHeight: 896,
        }),
      ).toEqual([
        "mobilecli",
        "io",
        "swipe",
        "--device",
        "device-1",
        "207,573,207,466",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts a visible bottom link above the iOS home-indicator safe area", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-bottom-link-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开帮助与反馈",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const baseStep = plan.resolvedSteps.at(-1)!;
      const step = {
        ...baseStep,
        targetElement: {
          elementId: "bot.settings.row.item-29917a18",
          title: "《个人信息清单》",
          semanticRole: "settings_navigation_entry",
          status: "verified" as const,
          selectors: [
            {
              type: "accessibilityIdentifier" as const,
              value: "《个人信息清单》",
            },
            { type: "label" as const, value: "《个人信息清单》" },
            { type: "role" as const, value: "Button" },
          ],
          selectorTemplate: [
            {
              type: "accessibilityIdentifier" as const,
              value: "《个人信息清单》",
            },
            { type: "label" as const, value: "《个人信息清单》" },
            { type: "role" as const, value: "Button" },
          ],
          locationHint: {
            region: "bottom_center" as const,
            description: "页面底部中间区域",
            sourceDeviceProfileId: plan.deviceProfileId,
          },
        },
      };
      const targetYRange = viewportSearchTargetYRange(896);
      const resolution = resolveSemanticStepTarget({
        step,
        uiElements: [
          {
            role: "Button",
            accessibilityId: "《个人信息清单》",
            label: "《个人信息清单》",
            bounds: { x: 90, y: 803, width: 98, height: 29 },
          },
        ],
        deviceProfileId: plan.deviceProfileId,
        viewportWidth: 414,
        viewportHeight: 896,
        deferBindingFallback: true,
        minimumTargetY: targetYRange.minimumY,
        maximumTargetY: targetYRange.maximumY,
      });

      expect(targetYRange.minimumY).toBeCloseTo(125.44);
      expect(targetYRange.maximumY).toBeCloseTo(860.16);
      expect(resolution).toMatchObject({
        source: "live_selector",
        point: { x: 139, y: 817.5 },
        bindingUsed: "selector",
      });
      expect(
        resolveSemanticStepTarget({
          step,
          uiElements: [
            {
              role: "Button",
              accessibilityId: "《个人信息清单》",
              label: "《个人信息清单》",
              bounds: { x: 90, y: 870, width: 98, height: 20 },
            },
          ],
          deviceProfileId: plan.deviceProfileId,
          viewportWidth: 414,
          viewportHeight: 896,
          deferBindingFallback: true,
          minimumTargetY: targetYRange.minimumY,
          maximumTargetY: targetYRange.maximumY,
        }),
      ).toMatchObject({ source: "unresolved" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("treats a matching local-coordinate child as the shadow of an offscreen row", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-local-shadow-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开隐私和权限",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const step = plan.resolvedSteps.at(-1)!;
      const offscreenRow = {
        role: "StaticText",
        accessibilityId: "隐私与权限",
        label: "隐私与权限",
        bounds: { x: 16, y: 1332, width: 382, height: 56 },
      };
      const localCoordinateChild = {
        ...offscreenRow,
        bounds: { x: 16, y: 92, width: 262, height: 44 },
      };
      expect(
        resolveSemanticStepTarget({
          step,
          uiElements: [offscreenRow, localCoordinateChild],
          deviceProfileId: plan.deviceProfileId,
          viewportWidth: 414,
          viewportHeight: 896,
          deferBindingFallback: true,
        }),
      ).toMatchObject({ source: "unresolved" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never falls back to coordinates when live resolution is required", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-pipeline-risk-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "删除指定文本消息",
        parameters: { text: "GraphV2 测试消息" },
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const original = plan.resolvedSteps[0]!;
      const unsafeHistoricalStep = {
        ...original,
        binding: {
          deviceProfileId: plan.deviceProfileId,
          status: "verified" as const,
          normalizedPoint: { x: 0.5, y: 0.5 },
        },
        normalizedPoint: { x: 0.5, y: 0.5 },
      };
      const resolution = resolveSemanticStepTarget({
        step: unsafeHistoricalStep,
        uiElements: [],
        deviceProfileId: plan.deviceProfileId,
        viewportWidth: 414,
        viewportHeight: 896,
      });
      expect(resolution.source).toBe("unresolved");
      expect(resolution.bindingUsed).toBe("missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses a bounded Agent candidate when the planned Element cannot be resolved deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-agent-element-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开侧边栏",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      let prompt = "";
      const agentRunner: AgentFunction = async <TOutput>(value: string) => {
        prompt = value;
        return {
          status: "matched",
          candidateId: "ui-2",
          confidence: 0.93,
          reason: "The second button represents the sidebar entry.",
        } as TOutput;
      };
      const result = await resolveElementWithAgent({
        goal: plan.goal,
        currentSceneId: "chat.detail",
        step: plan.resolvedSteps[0]!,
        observation: observation([
          uiElement("无关按钮", 10, 20),
          uiElement("新版侧栏入口", 100, 20),
        ]),
        viewportWidth: 414,
        viewportHeight: 896,
        cwd: process.cwd(),
        timeoutMs: 1_000,
        minimumConfidence: 0.75,
        agentRunner,
      });
      expect(result?.candidate).toMatchObject({
        candidateId: "ui-2",
        title: "新版侧栏入口",
      });
      expect(prompt).toContain(
        "Choose candidateId only from Current candidates",
      );
      expect(prompt).not.toContain("normalizedPoint");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs the complete Exec loop through Agent Element recovery and candidate Graph learning", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-agent-exec-loop-"));
    const temporaryGraphPath = join(root, "graph.json");
    let state: "before" | "after" = "before";
    await writeFile(temporaryGraphPath, JSON.stringify(graph), "utf8");
    const commandLog: string[][] = [];
    const commandRunner = async (command: readonly string[]) => {
      commandLog.push([...command]);
      if (command[0] === "python3") {
        return {
          stdout: JSON.stringify({
            schemaVersion: "ios-ui-devicectl-restart/v1",
            success: true,
            bundleId: "com.bot.doubao",
            oldPids: [101],
            newPid: 202,
            currentPids: [202],
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command[1] === "screenshot") {
        const outputIndex = command.indexOf("-o");
        const outputPath =
          outputIndex >= 0 ? command[outputIndex + 1] : undefined;
        if (outputPath) await writeFile(outputPath, "fake-image", "utf8");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command[1] === "apps" && command[2] === "foreground") {
        return { stdout: "com.bot.doubao\n", stderr: "", exitCode: 0 };
      }
      if (command[1] === "dump" && command[2] === "ui") {
        const nodes =
          state === "before"
            ? [
                uiElement("豆包", 1, 1),
                uiElement("AI 生成可能有误 注意核实", 1, 20),
                uiElement("发消息或按住说话...", 1, 40),
                {
                  ...uiElement("全新侧栏入口", 20, 60),
                  accessibilityId: "sidebar-v2",
                  bounds: { x: 20, y: 60, width: 40, height: 20 },
                },
              ]
            : [
                uiElement("搜索", 1, 1),
                uiElement("技能", 1, 20),
                uiElement("云盘", 1, 40),
              ];
        return { stdout: JSON.stringify(nodes), stderr: "", exitCode: 0 };
      }
      if (command[1] === "io" && command[2] === "tap") {
        state = "after";
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开侧边栏",
        graphPath: temporaryGraphPath,
        outputDir: join(root, "plan"),
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const agentRunner: AgentFunction = async <TOutput>() =>
        ({
          status: "matched",
          candidateId: "ui-4",
          confidence: 0.96,
          reason: "The fourth candidate is the renamed sidebar entry.",
        }) as TOutput;
      const exec = await runWorkflow<AppGraphExecOutput>(execWorkflowPath, {
        goal: plan.goal,
        plan,
        graphPath: temporaryGraphPath,
        udid: "fake-device",
        outputDir: join(root, "exec"),
        planOnly: false,
        agentRunner,
        agentTimeoutMs: 1_000,
        commandRunner,
      });
      expect(exec).toMatchObject({
        success: true,
        mode: "exec",
        verdict: "pass",
        graphUpdated: true,
        steps: [
          {
            resolutionSource: "agent_selector",
            agentUsed: true,
            bindingUsed: "agent",
            success: true,
            outcomeVerified: true,
          },
        ],
      });
      if (exec.mode !== "exec") return;
      expect(exec.graphRevision).toBeGreaterThanOrEqual(graph.revision + 1);
      expect(exec.graphPatchPaths).toHaveLength(1);
      const updatedGraph = JSON.parse(
        await readFile(temporaryGraphPath, "utf8"),
      ) as AppGraph;
      expect(
        updatedGraph.scenes["chat.detail"]?.elements["chat.sidebar_entry"]
          ?.selectors,
      ).toContainEqual({ type: "label", value: "全新侧栏入口" });
      expect(commandLog).toContainEqual([
        "mobilecli",
        "io",
        "tap",
        "--device",
        "fake-device",
        "40,70",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("waits for a delayed target Scene before starting Agent recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-delayed-scene-"));
    const temporaryGraphPath = join(root, "graph.json");
    await writeFile(temporaryGraphPath, JSON.stringify(graph), "utf8");
    let state: "before" | "loading" = "before";
    let loadingCaptures = 0;
    let agentCalls = 0;
    const commandRunner = async (command: readonly string[]) => {
      if (command[0] === "python3") {
        state = "before";
        return {
          stdout: JSON.stringify({
            schemaVersion: "ios-ui-devicectl-restart/v1",
            success: true,
            bundleId: "com.bot.doubao",
            oldPids: [101],
            newPid: 202,
            currentPids: [202],
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command[1] === "screenshot") {
        const outputIndex = command.indexOf("-o");
        const outputPath =
          outputIndex >= 0 ? command[outputIndex + 1] : undefined;
        if (outputPath) await writeFile(outputPath, "fake-image", "utf8");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command[1] === "apps" && command[2] === "foreground") {
        return { stdout: "com.bot.doubao\n", stderr: "", exitCode: 0 };
      }
      if (command[1] === "dump" && command[2] === "ui") {
        if (state === "loading") loadingCaptures += 1;
        const targetVisible = state === "loading" && loadingCaptures >= 2;
        const nodes = targetVisible
          ? [
              uiElement("搜索", 1, 1),
              uiElement("技能", 1, 20),
              uiElement("云盘", 1, 40),
            ]
          : [
              uiElement("豆包", 1, 1),
              uiElement("AI 生成可能有误 注意核实", 1, 20),
              uiElement("发消息或按住说话...", 1, 40),
              {
                ...uiElement("对话列表", 20, 60),
                accessibilityId: "对话列表",
              },
            ];
        return { stdout: JSON.stringify(nodes), stderr: "", exitCode: 0 };
      }
      if (command[1] === "io" && command[2] === "tap") state = "loading";
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const agentRunner: AgentFunction = async <TOutput>() => {
      agentCalls += 1;
      return { status: "blocked" } as TOutput;
    };
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开侧边栏",
        graphPath: temporaryGraphPath,
        outputDir: join(root, "plan"),
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const exec = await runWorkflow<AppGraphExecOutput>(execWorkflowPath, {
        goal: plan.goal,
        plan,
        graphPath: temporaryGraphPath,
        udid: "fake-device",
        outputDir: join(root, "exec"),
        planOnly: false,
        allowLearning: false,
        preferFastPath: false,
        agentRunner,
        commandRunner,
      });

      expect(exec).toMatchObject({
        success: true,
        mode: "exec",
        verdict: "pass",
      });
      // The target must be observed twice consecutively before the next step.
      expect(loadingCaptures).toBe(3);
      expect(agentCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("replaces a historical same-Scene swipe with live viewport search", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-same-scene-state-"));
    const temporaryGraphPath = join(root, "graph.json");
    await writeFile(temporaryGraphPath, JSON.stringify(graph), "utf8");
    let state: "chat" | "settings-top" | "settings-scrolled" | "privacy" =
      "chat";
    let agentCalls = 0;
    const commandRunner = async (command: readonly string[]) => {
      if (command[0] === "python3") {
        state = "chat";
        return {
          stdout: JSON.stringify({
            schemaVersion: "ios-ui-devicectl-restart/v1",
            success: true,
            bundleId: "com.bot.doubao",
            oldPids: [101],
            newPid: 202,
            currentPids: [202],
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command[1] === "screenshot") {
        const outputIndex = command.indexOf("-o");
        const outputPath =
          outputIndex >= 0 ? command[outputIndex + 1] : undefined;
        if (outputPath) await writeFile(outputPath, "fake-image", "utf8");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command[1] === "apps" && command[2] === "foreground") {
        return { stdout: "com.bot.doubao\n", stderr: "", exitCode: 0 };
      }
      if (command[1] === "dump" && command[2] === "ui") {
        const nodes =
          state === "chat"
            ? [
                uiElement("豆包", 1, 1),
                uiElement("AI 生成可能有误 注意核实", 1, 20),
                uiElement("发消息或按住说话...", 1, 40),
                {
                  ...uiElement("豆包，打开设置页", 180, 40),
                  accessibilityId: "豆包，打开设置页",
                },
              ]
            : state === "settings-top"
              ? [
                  uiElement("豆包账号管理", 1, 20),
                  uiElement("豆包专业版", 1, 80),
                  uiElement("豆包形象", 1, 140),
                  uiElement("通知设置", 1, 200),
                  uiElement("回答展示相关视频", 1, 260),
                ]
              : state === "settings-scrolled"
                ? [
                    {
                      ...uiElement("隐私与权限", 16, 300),
                      accessibilityId: "隐私与权限",
                    },
                  ]
                : [
                    uiElement("隐私与权限", 1, 20),
                    uiElement("数据权限", 1, 80),
                    uiElement("帮助模型改进效果", 1, 110),
                    uiElement("个性化内容推荐", 1, 125),
                    uiElement("系统权限", 1, 140),
                  ];
        return { stdout: JSON.stringify(nodes), stderr: "", exitCode: 0 };
      }
      if (command[1] === "io" && command[2] === "swipe") {
        state = "settings-scrolled";
      }
      if (command[1] === "io" && command[2] === "tap") {
        state = state === "chat" ? "settings-top" : "privacy";
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const agentRunner: AgentFunction = async <TOutput>() => {
      agentCalls += 1;
      return { status: "blocked" } as TOutput;
    };
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开隐私和权限",
        graphPath: temporaryGraphPath,
        outputDir: join(root, "plan"),
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const swipeStep = plan.resolvedSteps.find(
        (step) => step.operation.type === "swipe",
      );
      const privacyStep = plan.resolvedSteps.find(
        (step) => step.toSceneId === "bot.settings.privacy.permissions",
      );
      const settingsStep = plan.resolvedSteps.find(
        (step) => step.toSceneId === "bot.settings",
      );
      expect(settingsStep).toBeDefined();
      expect(swipeStep).toBeUndefined();
      expect(privacyStep).toBeDefined();
      const exec = await runWorkflow<AppGraphExecOutput>(execWorkflowPath, {
        goal: plan.goal,
        plan,
        graphPath: temporaryGraphPath,
        udid: "fake-device",
        outputDir: join(root, "exec"),
        planOnly: false,
        allowLearning: false,
        preferFastPath: false,
        agentRunner,
        agentTimeoutMs: 1_000,
        commandRunner,
      });
      expect(exec).toMatchObject({
        success: true,
        mode: "exec",
        verdict: "pass",
        recoveryActions: [],
      });
      if (!exec.success) return;
      expect(
        exec.steps.some(
          (step) => (step.visibilityRecoveryCommands?.length ?? 0) > 0,
        ),
      ).toBeTrue();
      expect(agentCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("rejects missing, low-confidence, and unsafe Agent Element choices", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "app-graph-agent-element-reject-"),
    );
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开侧边栏",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const decisions = [
        {
          status: "matched",
          candidateId: "missing",
          confidence: 0.99,
          reason: "missing",
        },
        {
          status: "matched",
          candidateId: "ui-1",
          confidence: 0.2,
          reason: "low",
        },
        {
          status: "matched",
          candidateId: "ui-1",
          confidence: 0.99,
          reason: "unsafe",
        },
      ];
      for (const decision of decisions) {
        const agentRunner: AgentFunction = async <TOutput>() =>
          decision as TOutput;
        const result = await resolveElementWithAgent({
          goal: plan.goal,
          currentSceneId: "chat.detail",
          step: plan.resolvedSteps[0]!,
          observation: observation([uiElement("删除全部", 10, 20)]),
          viewportWidth: 414,
          viewportHeight: 896,
          cwd: process.cwd(),
          timeoutMs: 1_000,
          minimumConfidence: 0.75,
          agentRunner,
        });
        expect(result).toBeNull();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("compiles the complete swipe and blocks stale Plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-pipeline-swipe-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "查看更早消息",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      expect(
        buildStepCommands({
          step: plan.resolvedSteps[0]!,
          udid: "device-1",
        }),
      ).toEqual([
        ["mobilecli", "io", "swipe", "--device", "device-1", "207,240,207,690"],
      ]);
      expect(
        validatePlanAgainstGraph(
          {
            ...plan,
            graphIdentity: {
              ...plan.graphIdentity,
              revision: plan.graphIdentity.revision - 1,
            },
          },
          graph,
          plan.deviceProfileId,
        ),
      ).toMatchObject({ code: "stale_plan", recoverable: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires strict devicectl PID proof for reset", () => {
    expect(buildStrictRestartCommand("device-1", "com.bot.doubao")).toEqual([
      "python3",
      expect.stringContaining("ios-regression-kit/devicectl_restart.py"),
      "--device",
      "device-1",
      "--bundle-id",
      "com.bot.doubao",
    ]);
    expect(
      parseStrictRestartResult(
        JSON.stringify({
          schemaVersion: "ios-ui-devicectl-restart/v1",
          success: true,
          bundleId: "com.bot.doubao",
          oldPids: [101],
          newPid: 202,
          currentPids: [202],
        }),
      ),
    ).toMatchObject({ oldPids: [101], newPid: 202, currentPids: [202] });
    expect(() =>
      parseStrictRestartResult(
        JSON.stringify({
          schemaVersion: "ios-ui-devicectl-restart/v1",
          success: true,
          bundleId: "com.bot.doubao",
          oldPids: [101],
          newPid: 101,
          currentPids: [101],
        }),
      ),
    ).toThrow("invalid PID proof");
  });

  test("requires re-planning before resetting when runtime Task health is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-exec-replan-"));
    const commands: string[][] = [];
    const commandRunner = async (command: readonly string[]) => {
      commands.push([...command]);
      return {
        stdout: JSON.stringify({
          data: [{ packageName: graph.bundleId, version: "99.0.0" }],
        }),
        stderr: "",
        exitCode: 0,
      };
    };
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开侧边栏",
        graphPath,
        outputDir: join(root, "plan"),
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const result = await runWorkflow<AppGraphExecOutput>(execWorkflowPath, {
        goal: plan.goal,
        plan,
        graphPath,
        udid: "fake-device",
        outputDir: join(root, "exec"),
        commandRunner,
      });
      expect(result).toMatchObject({
        success: false,
        mode: "exec_failure",
        code: "task_replan_required",
        taskHealth: "stale",
        runtimeAppVersion: "99.0.0",
      });
      expect(commands).toEqual([
        ["mobilecli", "apps", "list", "--device", "fake-device"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("validates a complete Plan in Exec plan-only mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-pipeline-exec-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "打开侧边栏",
        graphPath,
        outputDir: join(root, "plan"),
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const exec = await runWorkflow<AppGraphExecOutput>(execWorkflowPath, {
        goal: plan.goal,
        plan,
        graphPath,
        outputDir: join(root, "exec"),
        planOnly: true,
      });
      expect(exec).toMatchObject({
        mode: "exec",
        planOnly: true,
        verdict: "needs_review",
        graphRevision: graph.revision,
        planSchemaVersion: "app-graph-semantic-plan/v2",
        planPath: plan.planPath,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts a zero-step Scene Plan when the target is already the entry Scene", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-pipeline-zero-step-"));
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "chat.detail",
        target: { kind: "scene", id: "chat.detail" },
        graphPath,
        outputDir: join(root, "plan"),
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      expect(plan.resolvedSteps).toEqual([]);
      const exec = await runWorkflow<AppGraphExecOutput>(execWorkflowPath, {
        goal: plan.goal,
        plan,
        graphPath,
        outputDir: join(root, "exec"),
        planOnly: true,
      });
      expect(exec).toMatchObject({
        mode: "exec",
        planOnly: true,
        verdict: "needs_review",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("compiles an Exec discovery request without mutating the Graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-pipeline-discovery-"));
    const temporaryGraphPath = join(root, "graph.json");
    const requestPath = join(root, "discovery-request.json");
    await writeFile(temporaryGraphPath, JSON.stringify(graph), "utf8");
    await writeFile(
      requestPath,
      JSON.stringify({
        schemaVersion: "app-graph-discovery-request/v1",
        goal: "打开侧边栏",
        graphIdentity: { graphId: graph.graphId, revision: graph.revision },
        startSceneId: "chat.detail",
        focusElementId: "chat.sidebar_entry",
        failure: "selector drift",
        evidencePaths: ["/tmp/ios_perf-opt/failure/ui.json"],
      }),
      "utf8",
    );
    try {
      const result = await runWorkflow<AppGraphDiscoveryOutput>(
        discoveryWorkflowPath,
        {
          graphPath: temporaryGraphPath,
          discoveryRequestPath: requestPath,
          outputDir: join(root, "discovery"),
          planOnly: true,
          maxDepth: 5,
          maxActions: 200,
        },
      );
      expect(result.success).toBeTrue();
      if (!result.success) return;
      expect(result).toMatchObject({
        mode: "discovery",
        planOnly: true,
        graphRevision: graph.revision,
        graphUpdated: false,
        startSceneId: "chat.detail",
      });
      const discoveryPlan = JSON.parse(
        await readFile(result.discoveryPlanPath, "utf8"),
      );
      expect(discoveryPlan).toMatchObject({
        schemaVersion: "app-graph-discovery-plan/v1",
        goal: "打开侧边栏",
        focusElementId: "chat.sidebar_entry",
        budgets: { maxDepth: 0, maxActions: 1 },
        candidates: [
          {
            elementId: "chat.sidebar_entry",
            operatorIds: ["chat.open_sidebar"],
          },
        ],
      });
      expect(
        JSON.parse(await readFile(temporaryGraphPath, "utf8")).revision,
      ).toBe(graph.revision);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects full-Scene Discovery without an explicit focus Element", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-discovery-no-focus-"));
    try {
      const result = await runWorkflow<AppGraphDiscoveryOutput>(
        discoveryWorkflowPath,
        {
          graphPath,
          startSceneId: "chat.detail",
          outputDir: root,
          planOnly: true,
        },
      );
      expect(result).toMatchObject({
        success: false,
        mode: "discovery_failure",
        code: "missing_discovery_focus",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects targeted Discovery without a user goal", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-discovery-no-goal-"));
    try {
      const result = await runWorkflow<AppGraphDiscoveryOutput>(
        discoveryWorkflowPath,
        {
          graphPath,
          startSceneId: "chat.detail",
          startElementId: "chat.sidebar_entry",
          outputDir: root,
          planOnly: true,
        },
      );
      expect(result).toMatchObject({
        success: false,
        mode: "discovery_failure",
        code: "missing_discovery_goal",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Discovery resolves Graph selectors and compiles a complete swipe", () => {
    const element = {
      elementId: "runtime-id",
      accessibilityId: "对话列表",
      label: "对话列表",
      text: "",
      value: "",
      role: "Button",
      x: 10,
      y: 20,
      width: 100,
      height: 40,
    };
    expect(
      resolveDiscoveryElement([element], "chat.sidebar_entry", [
        { type: "accessibilityIdentifier", value: "对话列表" },
      ]),
    ).toEqual(element);
    expect(
      buildDiscoveryActionCommand("device-1", "swipe_left", element),
    ).toEqual([
      "mobilecli",
      "io",
      "swipe",
      "--device",
      "device-1",
      "90,40,30,40",
    ]);
  });

  test("Discovery prefers the overlapping full row for duplicate child text", () => {
    const row = {
      elementId: "row",
      accessibilityId: "通知设置",
      label: "通知设置",
      text: "",
      value: "",
      role: "StaticText",
      x: 16,
      y: 652,
      width: 382,
      height: 56,
    };
    const child = {
      ...row,
      elementId: "child",
      x: 80,
      y: 658,
      width: 262,
      height: 44,
    };
    expect(
      resolveDiscoveryElement([row, child], "bot.settings.row.item-64676dfd", [
        { type: "label", value: "通知设置" },
      ]),
    ).toEqual(row);

    expect(
      resolveDiscoveryElement(
        [row, { ...child, x: 500 }],
        "bot.settings.row.item-64676dfd",
        [{ type: "label", value: "通知设置" }],
      ),
    ).toBeNull();
  });

  test("Discovery infers the known target Scene for one focused Element action", () => {
    expect(
      resolveDiscoveryExpectedSceneId(
        graph,
        "bot.settings",
        "bot.settings.row.item-64676dfd",
        "探索通知设置",
      ),
    ).toBe("bot.settings.notification_settings");
  });

  test("Discovery scrolls toward a real offscreen row instead of tapping its local-coordinate shadow", () => {
    const offscreen = {
      elementId: "minor-row",
      accessibilityId: "未成年人模式",
      label: "未成年人模式",
      text: "",
      value: "",
      role: "StaticText",
      x: 16,
      y: 1076,
      width: 382,
      height: 56,
    };
    const shadow = {
      ...offscreen,
      elementId: "minor-shadow",
      y: 92,
      width: 262,
      height: 44,
    };
    const selectors = [{ type: "label", value: "未成年人模式" }];
    expect(
      resolveVisibleDiscoveryElement(
        [offscreen, shadow],
        "bot.settings.row.item-207b4043",
        selectors,
        414,
        896,
      ),
    ).toBeNull();
    expect(
      viewportSearchAxisForTarget({
        elementId: "bot.settings.row.item-207b4043",
        semanticRole: "StaticText",
      }),
    ).toBe("vertical");
    expect(
      resolveVisibleDiscoveryElement(
        [
          {
            ...offscreen,
            y: 51,
          },
        ],
        "bot.settings.row.item-207b4043",
        selectors,
        414,
        896,
        896 * 0.14,
      ),
    ).toBeNull();
  });

  test("Discovery never reports success when no focused action ran", () => {
    expect(
      discoveryCompletionIssue({
        focusElementId: "bot.settings.row.item-64676dfd",
        expectedSceneId: "bot.settings.notification_settings",
        actionsExecuted: 0,
        agentConfirmedTarget: false,
        observedSceneIds: [],
        explicitStaleRecovery: false,
      }),
    ).toEqual({
      code: "focus_element_unresolved",
      message:
        "Focus Element bot.settings.row.item-64676dfd was not resolved and no exploration action was executed.",
    });
  });

  test("uses the shared horizontal viewport gesture for an ActionBar Element", () => {
    expect(
      buildViewportSearchCommand({
        udid: "device-1",
        axis: viewportSearchAxisForTarget({
          elementId: "chat.detail.actionbar.ppt-dac81d06",
          semanticRole: "Button",
        }),
        direction: "left",
        viewportWidth: 414,
        viewportHeight: 896,
        horizontalCenterY: 762,
      }),
    ).toEqual([
      "mobilecli",
      "io",
      "swipe",
      "--device",
      "device-1",
      "257,762,157,762",
    ]);
  });

  test("viewport search returns a target from the current screen without moving", async () => {
    const moved: string[] = [];
    const result = await searchViewports({
      axis: "vertical",
      initialObservation: "target",
      resolveVisibleTarget: (screen) =>
        screen === "target" ? { id: "wanted" } : null,
      moveAndObserve: async (direction) => {
        moved.push(direction);
        return {
          observation: "unexpected",
          stable: true,
          changedFromPrevious: true,
          fingerprint: "unexpected",
        };
      },
    });

    expect(result.stopReason).toBe("found");
    expect(result.moves).toEqual([]);
    expect(moved).toEqual([]);
  });

  test("viewport search checks every screen and finds a target after one forward move", async () => {
    const screens = ["first", "target"];
    const result = await searchViewports({
      axis: "vertical",
      initialObservation: screens[0]!,
      resolveVisibleTarget: (screen) =>
        screen === "target" ? { id: "wanted" } : null,
      moveAndObserve: async (direction, moveIndex) => ({
        observation: screens[moveIndex]!,
        stable: true,
        changedFromPrevious: true,
        fingerprint: screens[moveIndex]!,
      }),
    });

    expect(result.stopReason).toBe("found");
    expect(result.target).toEqual({ id: "wanted" });
    expect(result.moves.map((move) => move.direction)).toEqual(["up"]);
  });

  test("viewport search reverses only after observing a boundary", async () => {
    const directions: string[] = [];
    const sequence = [
      { screen: "bottom", changed: false },
      { screen: "middle", changed: true },
      { screen: "target", changed: true },
    ];
    const result = await searchViewports({
      axis: "vertical",
      initialObservation: "start",
      resolveVisibleTarget: (screen) =>
        screen === "target" ? { id: "wanted" } : null,
      moveAndObserve: async (direction, moveIndex) => {
        directions.push(direction);
        const next = sequence[moveIndex - 1]!;
        return {
          observation: next.screen,
          stable: true,
          changedFromPrevious: next.changed,
          fingerprint: next.screen,
        };
      },
    });

    expect(result.stopReason).toBe("found");
    expect(directions).toEqual(["up", "down", "down"]);
  });

  test("viewport search stops after both boundaries without consulting target coordinates", async () => {
    const result = await searchViewports({
      axis: "vertical",
      initialObservation: { name: "start", historicalY: 10_000 },
      resolveVisibleTarget: () => null,
      moveAndObserve: async (direction) => ({
        observation: { name: direction, historicalY: -10_000 },
        stable: true,
        changedFromPrevious: false,
        fingerprint: direction,
      }),
    });

    expect(result.stopReason).toBe("boundaries_reached");
    expect(result.moves.map((move) => move.direction)).toEqual(["up", "down"]);
  });

  test("viewport search respects its move budget when neither boundary is reached", async () => {
    const result = await searchViewports({
      axis: "horizontal",
      initialObservation: 0,
      maximumMoves: 3,
      resolveVisibleTarget: () => null,
      moveAndObserve: async (direction, moveIndex) => ({
        observation: moveIndex,
        stable: true,
        changedFromPrevious: true,
        fingerprint: `${direction}-${moveIndex}`,
      }),
    });

    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.moves.map((move) => move.direction)).toEqual([
      "left",
      "left",
      "left",
    ]);
  });

  test("treats every consecutive same-Scene swipe before a semantic target as a hint", () => {
    const steps = [
      {
        fromSceneId: "chat.detail",
        toSceneId: "chat.detail",
        operation: { type: "swipe" },
      },
      {
        fromSceneId: "chat.detail",
        toSceneId: "chat.detail",
        operation: { type: "swipe" },
      },
      {
        fromSceneId: "chat.detail",
        toSceneId: "chat.buy_before_ask",
        operation: { type: "tap" },
        targetElement: { elementId: "buy-before-ask" },
      },
    ];
    expect(isHistoricalViewportHintStep(steps, 0)).toBeTrue();
    expect(isHistoricalViewportHintStep(steps, 1)).toBeTrue();
    expect(isHistoricalViewportHintStep(steps, 2)).toBeFalse();
  });

  test("retries transient Discovery capture failures", async () => {
    let attempts = 0;
    const result = await runDiscoveryCaptureCommand(
      ["mobilecli", "screenshot"],
      async () => {
        attempts += 1;
        return attempts < 3
          ? { stdout: "", stderr: "transport unavailable", exitCode: 1 }
          : { stdout: "captured", stderr: "", exitCode: 0 };
      },
    );

    expect(attempts).toBe(3);
    expect(result.stdout).toBe("captured");
  });

  test("retries transient Exec ground capture failures", async () => {
    let attempts = 0;
    const result = await runGroundCaptureCommand(
      ["mobilecli", "screenshot"],
      async () => {
        attempts += 1;
        return attempts < 3
          ? { stdout: "", stderr: "tunnel unavailable", exitCode: 1 }
          : { stdout: "captured", stderr: "", exitCode: 0 };
      },
    );
    expect(attempts).toBe(3);
    expect(result.stdout).toBe("captured");
  });

  test("reads the runtime App version from mobilecli foreground JSON", () => {
    expect(
      parseForegroundApp(
        JSON.stringify({
          status: "ok",
          data: { packageName: "com.bot.doubao", version: "14.8.0" },
        }),
      ),
    ).toEqual({ bundleId: "com.bot.doubao", appVersion: "14.8.0" });
    expect(parseForegroundApp("com.bot.doubao\n")).toEqual({
      bundleId: "com.bot.doubao",
    });
  });

  test("reads the installed App version from mobilecli app inventory", () => {
    expect(
      parseInstalledAppVersion(
        JSON.stringify({
          status: "ok",
          data: [
            { packageName: "com.example.other", version: "1.0" },
            { packageName: "com.bot.doubao", version: "14.8.0" },
          ],
        }),
        "com.bot.doubao",
      ),
    ).toBe("14.8.0");
  });

  test("waits through loading until two consecutive stable observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-stability-"));
    const sequence = [
      discoveryObservation(root, "loading", [uiElement("加载中", 10, 20)]),
      discoveryObservation(root, "stable-1", [uiElement("首页", 10, 20)]),
      discoveryObservation(root, "stable-2", [uiElement("首页", 10, 20)]),
    ];
    let captures = 0;
    try {
      for (const observation of sequence) {
        await writeFile(
          observation.screenshotPath,
          observation.sceneId.startsWith("stable")
            ? "stable-image"
            : "loading-image",
          "utf8",
        );
      }
      const stable = await waitForStableDiscoveryObservation({
        udid: "fake-device",
        outputDir: root,
        prefix: "sample",
        sceneId: "chat.detail",
        maximumSamples: 3,
        pollMs: 0,
        sleep: async () => undefined,
        capture: async () => sequence[captures++]!,
      });
      expect(stable).toMatchObject({
        stable: true,
        sampleCount: 3,
        consecutiveMatches: 2,
      });
      expect(stable.observation.sceneId).toBe("stable-2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records a bounded Agent diagnosis when a stable stale Scene cannot recover", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-agent-diagnostic-"));
    const current = discoveryObservation(root, "stable-home", [
      uiElement("火山方舟 - 首页", 40, 48),
      uiElement("返回", 16, 58),
    ]);
    const agentRunner: AgentFunction = async <TOutput>() =>
      ({
        status: "blocked",
        candidateId: "",
        actionType: "none",
        confidence: 0.94,
        reason: "No safe visible candidate leads to the stale experience page.",
      }) as TOutput;
    try {
      await writeFile(current.screenshotPath, "stable-image", "utf8");
      const result = await diagnoseAndRecoverStableDiscovery({
        graph,
        goal: "打开火山方舟体验页",
        expectedSceneId: "volcengine.ark.console.experience",
        startSceneId: "volcengine.ark.console.home",
        focusElementId: "volcengine.ark.console.home.experience_entry",
        observation: current,
        udid: "fake-device",
        outputDir: root,
        deviceProfile: { viewportWidth: 414, viewportHeight: 896 },
        agentCwd: process.cwd(),
        agentTimeoutMs: 1_000,
        maximumSteps: 2,
        minimumConfidence: 0.75,
        agentRunner,
      });
      expect(result).toMatchObject({
        agentUsed: true,
        atTarget: false,
        actionsExecuted: 0,
        finalDecision: { status: "blocked", actionType: "none" },
      });
      expect(
        JSON.parse(await readFile(result.diagnosticPath, "utf8")),
      ).toMatchObject({
        agentUsed: true,
        atTarget: false,
        message:
          "No safe visible candidate leads to the stale experience page.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Discovery synthesizes observed Scenes and candidate Operators from real transitions", () => {
    const before = {
      sceneId: "chat.detail",
      screenshotPath: "/tmp/ios_perf-opt/before.png",
      uiDumpPath: "/tmp/ios_perf-opt/before.json",
      timestamp: "2026-08-19T00:00:00.000Z",
      elements: [],
    };
    const afterElement = {
      elementId: "runtime-new",
      accessibilityId: "新页面按钮",
      label: "新页面按钮",
      text: "",
      value: "",
      role: "Button",
      x: 20,
      y: 40,
      width: 80,
      height: 40,
    };
    const after = {
      sceneId: "new-scene",
      screenshotPath: "/tmp/ios_perf-opt/after.png",
      uiDumpPath: "/tmp/ios_perf-opt/after.json",
      timestamp: "2026-08-19T00:00:01.000Z",
      elements: [afterElement],
    };
    const patch = buildDiscoveryPatch({
      graph,
      transitions: [
        {
          sourceSceneId: "chat.detail",
          sourceElementId: "chat.sidebar_entry",
          actionType: "tap",
          targetSceneId: "new-scene",
          before,
          after,
          observationPath: "/tmp/ios_perf-opt/observation.json",
        },
      ],
      deviceProfileId: "iphone-414x896-portrait",
      viewportWidth: 414,
      viewportHeight: 896,
    });
    expect(patch.scenes?.["new-scene"]).toMatchObject({
      status: "observed",
      elements: {
        "new-scene.新页面按钮": {
          status: "observed",
          bindings: {
            "iphone-414x896-portrait": { status: "candidate" },
          },
        },
      },
    });
    expect(Object.values(patch.operators ?? {})[0]).toMatchObject({
      fromSceneId: "chat.detail",
      toSceneId: "new-scene",
      status: "candidate",
      risk: "navigation",
    });
    expect(applyPatch(graph, patch).success).toBeTrue();
  });

  test("revives a stale Scene path only for an explicit recovery observation", () => {
    const staleGraph = structuredClone(graph);
    const scene = staleGraph.scenes["chat.sidebar"]!;
    const operator = staleGraph.operators["chat.open_sidebar"]!;
    const element =
      staleGraph.scenes["chat.detail"]!.elements["chat.sidebar_entry"]!;
    (scene as { status: string }).status = "stale";
    (operator as { status: string }).status = "stale";
    (element as { status: string }).status = "stale";
    const transition = {
      sourceSceneId: "chat.detail",
      sourceElementId: "chat.sidebar_entry",
      actionType: "tap",
      targetSceneId: "chat.sidebar",
      before: {
        sceneId: "chat.detail",
        screenshotPath: "/tmp/ios_perf-opt/before.png",
        uiDumpPath: "/tmp/ios_perf-opt/before.json",
        timestamp: "2026-08-21T00:00:00.000Z",
        elements: [],
      },
      after: {
        sceneId: "chat.sidebar",
        screenshotPath: "/tmp/ios_perf-opt/after.png",
        uiDumpPath: "/tmp/ios_perf-opt/after.json",
        timestamp: "2026-08-21T00:00:01.000Z",
        elements: [],
      },
      observationPath: "/tmp/ios_perf-opt/observation.json",
      revivesStaleTarget: true,
    };
    const patch = buildDiscoveryPatch({
      graph: staleGraph,
      transitions: [transition],
      deviceProfileId: "iphone-414x896-portrait",
      viewportWidth: 414,
      viewportHeight: 896,
    });

    expect(patch.scenes?.["chat.sidebar"]?.status).toBe("candidate");
    expect(
      patch.scenes?.["chat.detail"]?.elements?.["chat.sidebar_entry"]?.status,
    ).toBe("candidate");
    expect(patch.operators?.["chat.open_sidebar"]?.status).toBe("candidate");
  });

  test("classifies a known Scene before invoking runtime recovery", () => {
    const match = classifyRuntimeScene(
      graph,
      observation([
        uiElement("豆包", 10, 20),
        uiElement("AI 生成可能有误 注意核实", 10, 80),
        uiElement("发消息或按住说话...", 10, 140),
      ]),
    );
    expect(match?.sceneId).toBe("chat.detail");
  });

  test("matches a long settings Scene from the stable anchors visible in one viewport", () => {
    expect(
      runtimeSceneMatches(
        graph,
        "bot.settings",
        observation([
          uiElement("豆包账号管理", 10, 100),
          uiElement("豆包形象", 10, 220),
          uiElement("通知设置", 10, 340),
        ]),
      ),
    ).toBe(true);
  });

  test("matches a Scene title with a delimited presentation suffix", () => {
    expect(
      runtimeSceneMatches(
        graph,
        "skills.home",
        observation([
          uiElement("技能 · 连接器", 156, 60),
          uiElement("技能包", 16, 160),
        ]),
      ),
    ).toBe(true);
  });

  test("lets the Scene Agent choose only a real safe candidate and supports at_target", async () => {
    const current = observation([
      uiElement("设置", 10, 20),
      uiElement("删除全部", 10, 80),
    ]);
    const actionAgent: AgentFunction = async <TOutput>() =>
      ({
        status: "action",
        candidateId: "ui-1",
        actionType: "tap",
        confidence: 0.94,
        reason: "Settings moves toward the requested page.",
      }) as TOutput;
    const action = await decideSceneRecoveryWithAgent({
      goal: "打开设置",
      expectedScene: graph.scenes["bot.settings"]!,
      currentSceneId: "chat.detail",
      observation: current,
      previousActions: [],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      minimumConfidence: 0.75,
      agentRunner: actionAgent,
    });
    expect(action?.candidate?.title).toBe("设置");
    expect(
      buildRuntimeRecoveryCommand(
        "device-1",
        action!.candidate!,
        action!.decision.actionType as "tap",
      ),
    ).toEqual(["mobilecli", "io", "tap", "--device", "device-1", "50,40"]);
    expect(
      await decideSceneRecoveryWithAgent({
        goal: "打开设置",
        expectedScene: graph.scenes["bot.settings"]!,
        currentSceneId: "chat.detail",
        observation: current,
        previousActions: [{ candidateId: "ui-1", actionType: "tap" }],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        minimumConfidence: 0.75,
        agentRunner: actionAgent,
      }),
    ).toBeNull();

    const atTargetAgent: AgentFunction = async <TOutput>() =>
      ({
        status: "at_target",
        candidateId: "",
        actionType: "none",
        confidence: 0.91,
        reason: "The current page is already the requested Scene.",
      }) as TOutput;
    const atTarget = await decideSceneRecoveryWithAgent({
      goal: "打开设置",
      expectedScene: graph.scenes["bot.settings"]!,
      observation: current,
      previousActions: [],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      minimumConfidence: 0.75,
      agentRunner: atTargetAgent,
    });
    expect(atTarget?.candidate).toBeUndefined();
    expect(atTarget?.decision).toMatchObject({
      status: "at_target",
      actionType: "none",
    });

    const blockedAgent: AgentFunction = async <TOutput>() =>
      ({
        status: "blocked",
        candidateId: "",
        actionType: "none",
        confidence: 0.96,
        reason: "The stable page exposes no safe goal-relevant control.",
      }) as TOutput;
    const blocked = await decideSceneRecoveryWithAgent({
      goal: "打开体验页",
      expectedScene: graph.scenes["volcengine.ark.console.experience"]!,
      observation: current,
      previousActions: [],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      minimumConfidence: 0.75,
      agentRunner: blockedAgent,
    });
    expect(blocked?.decision).toMatchObject({
      status: "blocked",
      actionType: "none",
      reason: "The stable page exposes no safe goal-relevant control.",
    });

    const offscreenAgent: AgentFunction = async <TOutput>(prompt: string) => {
      expect(prompt).not.toContain("离屏隐私入口");
      return {
        status: "action",
        candidateId: "ui-2",
        actionType: "tap",
        confidence: 0.97,
        reason: "Attempted to select an offscreen candidate.",
      } as TOutput;
    };
    expect(
      await decideSceneRecoveryWithAgent({
        goal: "打开隐私与权限",
        expectedScene: graph.scenes["bot.settings.privacy.permissions"]!,
        currentSceneId: "bot.settings",
        observation: observation([
          uiElement("设置", 10, 20),
          uiElement("离屏隐私入口", 16, 1332),
        ]),
        viewportWidth: 414,
        viewportHeight: 896,
        previousActions: [],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        minimumConfidence: 0.75,
        agentRunner: offscreenAgent,
      }),
    ).toBeNull();
  });

  test("writes a new runtime Scene and candidate Operator only when the UI changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-runtime-patch-"));
    const temporaryGraphPath = join(root, "graph.json");
    await writeFile(temporaryGraphPath, JSON.stringify(graph), "utf8");
    const candidate = buildRuntimeCandidates([uiElement("新入口", 10, 20)])[0]!;
    try {
      const changed = await persistRuntimeTransition({
        graphPath: temporaryGraphPath,
        graph,
        sourceSceneId: "chat.detail",
        before: observation([uiElement("新入口", 10, 20)]),
        candidate,
        actionType: "tap",
        after: observation([uiElement("全新页面标题", 10, 20)]),
        outputDir: root,
        patchIndex: 0,
        deviceProfileId: "iphone-414x896-portrait",
        allowLearning: true,
      });
      expect(changed.graphUpdated).toBeTrue();
      expect(changed.patchPaths.length).toBeGreaterThan(0);
      expect(changed.graph.revision).toBe(graph.revision + 1);
      expect(
        Object.values(changed.graph.operators).some(
          (operator) =>
            operator.fromSceneId === "chat.detail" &&
            operator.status === "candidate",
        ),
      ).toBeTrue();

      const unchanged = await persistRuntimeTransition({
        graphPath: temporaryGraphPath,
        graph: changed.graph,
        sourceSceneId: "chat.detail",
        before: observation([uiElement("没有变化", 10, 20)]),
        candidate,
        actionType: "tap",
        after: observation([uiElement("没有变化", 10, 20)]),
        outputDir: root,
        patchIndex: changed.patchPaths.length,
        deviceProfileId: "iphone-414x896-portrait",
        allowLearning: true,
      });
      expect(unchanged.targetSceneId).toBe("chat.detail");
      expect(unchanged.graphUpdated).toBeFalse();

      const sameSceneExpanded = await persistRuntimeTransition({
        graphPath: temporaryGraphPath,
        graph: changed.graph,
        sourceSceneId: "chat.detail",
        before: observation([
          uiElement("豆包", 10, 20),
          uiElement("AI 生成可能有误 注意核实", 10, 80),
          uiElement("发消息或按住说话...", 10, 140),
          uiElement("展开", 10, 200),
        ]),
        candidate,
        actionType: "tap",
        after: observation([
          uiElement("豆包", 10, 20),
          uiElement("AI 生成可能有误 注意核实", 10, 80),
          uiElement("发消息或按住说话...", 10, 140),
          uiElement("展开", 10, 200),
          uiElement("新出现的安全入口", 10, 260),
        ]),
        outputDir: root,
        patchIndex: changed.patchPaths.length,
        deviceProfileId: "iphone-414x896-portrait",
        allowLearning: true,
      });
      expect(sameSceneExpanded.targetSceneId).toBe("chat.detail");
      expect(sameSceneExpanded.graphUpdated).toBeTrue();
      expect(
        Object.values(
          sameSceneExpanded.graph.scenes["chat.detail"]!.elements,
        ).some((element) => element.title === "新出现的安全入口"),
      ).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Accept chooses a precise planning goal and preserves the semantic Plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-pipeline-accept-"));
    try {
      const result = await runWorkflow<AppGraphAcceptOutput>(
        acceptWorkflowPath,
        {
          case: {
            case_id: "sidebar-1",
            title: "打开侧边栏",
            step: "点击左上角对话列表按钮",
            expected: "显示搜索、技能和云盘",
            oracles: [{ type: "ui_text_visible", value: "测试额外断言" }],
          },
          graphPath,
          outputDir: root,
          planOnly: true,
        },
      );
      expect(result.success).toBeTrue();
      if (result.mode !== "accept") return;
      expect(result.cases[0]).toMatchObject({
        selectedPlanningGoal: "打开侧边栏",
        expected: "显示搜索、技能和云盘",
        verdict: "needs_review",
        planResult: {
          schemaVersion: "app-graph-semantic-plan/v2",
          matchedTaskId: "chat.open_sidebar",
          graphIdentity: { revision: graph.revision },
          finalOracles: [
            ...graph.tasks["chat.open_sidebar"]!.finalOracles,
            { type: "ui_text_visible", value: "测试额外断言" },
          ],
        },
        execResult: {
          planSchemaVersion: "app-graph-semantic-plan/v2",
        },
      });
      expect(result.cases[0]?.warnings).toEqual([]);
      expect(result.cases[0]?.planResult?.success).toBeTrue();
      if (result.cases[0]?.planResult?.success) {
        expect(result.cases[0].planResult.planPath).toContain(
          "plan-with-case-oracles.json",
        );
        expect(
          await Bun.file(result.cases[0].planResult.planPath).exists(),
        ).toBeTrue();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Accept normalizes verify aliases, wrappers, text, and duplicate oracles", () => {
    expect(
      normalizeCaseVerification({
        case_id: "verify-normalization",
        title: "校验侧边栏",
        step: "打开侧边栏",
        expected: "搜索可见且错误提示不可见",
        oracles: [{ type: "ui_text_visible", value: "搜索" }],
        verify: {
          assertions: [
            { type: "visible", text: "搜索" },
            "不显示“错误提示”",
            { kind: "scene", scene_id: "chat.sidebar" },
            { checkType: "foreground", bundle_id: "com.bot.doubao" },
          ],
        },
      }),
    ).toEqual({
      supplied: true,
      sources: ["oracles", "verify"],
      oracles: [
        { type: "ui_text_visible", value: "搜索" },
        { type: "ui_text_absent", value: "错误提示" },
        { type: "scene_current", sceneId: "chat.sidebar" },
        { type: "foreground_bundle", bundleId: "com.bot.doubao" },
      ],
      issues: [],
      compiler: "deterministic",
    });
    expect(
      normalizeCaseVerification({
        case_id: "semantic-dedupe",
        title: "语义去重",
        step: "保持当前页面",
        expected: "搜索可见",
        oracles: [{ type: "text_visible", value: "搜索" }],
        verify: { type: "visible", value: "搜索" },
      }).oracles,
    ).toEqual([{ type: "text_visible", value: "搜索" }]);
    expect(
      normalizeCaseVerification({
        case_id: "partial-natural-language",
        title: "复杂验证条件",
        step: "保持当前页面",
        expected: "",
        verify:
          "名称下方显示“AI 生成可能有误 注意核实”，并展示通话入口和朗读入口",
      }).issues,
    ).toEqual([
      'verify: unsupported natural-language condition "名称下方显示“AI 生成可能有误 注意核实”，并展示通话入口和朗读入口"',
    ]);
  });

  test("Accept blocks an unsupported verify condition instead of silently ignoring it", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "app-graph-accept-invalid-verify-"),
    );
    try {
      const result = await runWorkflow<AppGraphAcceptOutput>(
        acceptWorkflowPath,
        {
          case: {
            case_id: "unsupported-verify",
            title: "打开侧边栏",
            step: "点击左上角对话列表按钮",
            expected: "页面颜色符合设计稿",
            verify: { type: "color_matches_design", value: "blue" },
          },
          graphPath,
          outputDir: root,
          planOnly: true,
        },
      );
      expect(result).toMatchObject({
        success: false,
        mode: "accept",
        summary: { blocked: 1 },
        cases: [
          {
            verdict: "blocked",
            verification: {
              supplied: true,
              oracles: [],
            },
          },
        ],
      });
      if (result.mode !== "accept") return;
      expect(result.cases[0]?.reason).toContain(
        "unsupported verification object",
      );
      expect(result.cases[0]?.planResult).toBeUndefined();
      expect(result.cases[0]?.verificationPath).toEndWith(
        "unsupported-verify/verification.json",
      );
      expect(
        await Bun.file(result.cases[0]!.verificationPath!).exists(),
      ).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Accept executes mocked cases and lets verify conditions decide pass and fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-accept-verify-exec-"));
    const temporaryGraphPath = join(root, "graph.json");
    const caseSetPath = join(root, "cases.json");
    const isolatedGraph = structuredClone(graph) as AppGraph;
    (isolatedGraph.tasks as Record<string, AppGraph["tasks"][string]>)[
      "mock.verify.chat"
    ] = {
      taskId: "mock.verify.chat",
      intents: ["校验会话页验收条件"],
      entrySceneId: "chat.detail",
      steps: [],
      finalOracles: [
        { type: "scene_current", sceneId: "chat.detail" },
        { type: "foreground_bundle", bundleId: graph.bundleId },
      ],
      status: "verified",
      parameters: {},
    };
    await writeFile(temporaryGraphPath, JSON.stringify(isolatedGraph), "utf8");
    await writeFile(
      caseSetPath,
      JSON.stringify({
        cases: [
          {
            case_id: "verify-pass",
            title: "验证条件通过",
            goal: "校验会话页验收条件",
            step: "保持在会话页",
            expected: "专项验收标记可见且错误提示不可见",
            oracles: [{ type: "ui_text_visible", value: "专项验收标记" }],
            verify: {
              checks: [
                { type: "visible", text: "专项验收标记" },
                "不显示“错误提示”",
                {
                  type: "all_text_visible",
                  values: ["专项验收标记", "豆包"],
                },
                {
                  type: "any_text_visible",
                  values: ["不存在的候选", "专项验收标记"],
                },
              ],
            },
          },
          {
            case_id: "verify-fail",
            title: "验证条件失败",
            goal: "校验会话页验收条件",
            step: "保持在会话页",
            expected: "缺失验收标记可见",
            verify: {
              type: "any_text_visible",
              values: ["缺失验收标记", "另一个缺失标记"],
            },
          },
        ],
      }),
      "utf8",
    );
    const commandRunner = mockAcceptCommandRunner(root, [
      "豆包",
      "AI 生成可能有误 注意核实",
      "发消息或按住说话...",
      "专项验收标记",
    ]);
    try {
      const result = await runWorkflow<AppGraphAcceptOutput>(
        acceptWorkflowPath,
        {
          caseSetPath,
          graphPath: temporaryGraphPath,
          udid: "fake-device",
          outputDir: root,
          planOnly: false,
          allowDiscovery: true,
          runtimeAppVersion: graph.appVersion,
          commandRunner,
        },
      );
      expect(result).toMatchObject({
        success: false,
        mode: "accept",
        summary: { total: 2, pass: 1, fail: 1, blocked: 0 },
      });
      if (result.mode !== "accept") return;
      const passed = result.cases.find((item) => item.caseId === "verify-pass");
      const failed = result.cases.find((item) => item.caseId === "verify-fail");
      expect(passed).toMatchObject({
        verdict: "pass",
        verification: {
          sources: ["oracles", "verify"],
          oracles: [
            { type: "ui_text_visible", value: "专项验收标记" },
            { type: "ui_text_absent", value: "错误提示" },
            {
              type: "all_text_visible",
              values: ["专项验收标记", "豆包"],
            },
            {
              type: "any_text_visible",
              values: ["不存在的候选", "专项验收标记"],
            },
          ],
          issues: [],
        },
      });
      expect(passed?.verificationPath).toEndWith(
        "verify-pass/verification.json",
      );
      expect(passed?.planResult?.success).toBeTrue();
      if (passed?.planResult?.success) {
        expect(
          passed.planResult.finalOracles.filter(
            (oracle) =>
              oracle.type === "ui_text_visible" &&
              oracle.value === "专项验收标记",
          ),
        ).toHaveLength(1);
      }
      expect(passed?.execResult?.mode).toBe("exec");
      if (passed?.execResult?.mode === "exec") {
        expect(passed.execResult.finalOracleResults).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "ui_text_visible",
              expected: "专项验收标记",
              success: true,
            }),
            expect.objectContaining({
              type: "ui_text_absent",
              expected: "错误提示",
              success: true,
            }),
            expect.objectContaining({
              type: "all_text_visible",
              expected: "专项验收标记 | 豆包",
              success: true,
            }),
            expect.objectContaining({
              type: "any_text_visible",
              expected: "不存在的候选 | 专项验收标记",
              success: true,
            }),
          ]),
        );
      }
      expect(failed).toMatchObject({ verdict: "fail" });
      expect(failed?.execResult?.mode).toBe("exec");
      if (failed?.execResult?.mode === "exec") {
        expect(failed.execResult.finalOracleResults).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "any_text_visible",
              expected: "缺失验收标记 | 另一个缺失标记",
              success: false,
            }),
          ]),
        );
      }
      const persistedGraph = JSON.parse(
        await readFile(temporaryGraphPath, "utf8"),
      ) as AppGraph;
      expect(persistedGraph.tasks["mock.verify.chat"]?.finalOracles).toEqual([
        { type: "scene_current", sceneId: "chat.detail" },
        { type: "foreground_bundle", bundleId: graph.bundleId },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("Accept compiles a simple expected result into machine-checkable oracles", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "app-graph-pipeline-accept-warning-"),
    );
    try {
      const result = await runWorkflow<AppGraphAcceptOutput>(
        acceptWorkflowPath,
        {
          case: {
            case_id: "sidebar-warning",
            title: "打开侧边栏",
            step: "点击左上角对话列表按钮",
            expected: "显示搜索、技能和云盘",
          },
          graphPath,
          outputDir: root,
          planOnly: true,
        },
      );
      expect(result.mode).toBe("accept");
      if (result.mode !== "accept") return;
      expect(result.cases[0]?.warnings).toEqual([]);
      expect(result.cases[0]?.verification).toMatchObject({
        supplied: true,
        sources: ["expected"],
        compiler: "deterministic",
        oracles: [
          { type: "ui_text_visible", value: "搜索" },
          { type: "ui_text_visible", value: "技能" },
          { type: "ui_text_visible", value: "云盘" },
        ],
        issues: [],
      });
      expect(result.cases[0]?.planResult?.success).toBeTrue();
      if (result.cases[0]?.planResult?.success) {
        expect(result.cases[0].planResult.finalOracles).toEqual(
          graph.tasks["chat.open_sidebar"]!.finalOracles,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Accept uses a read-only Agent to compile complex expected conditions", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "app-graph-accept-agent-verify-"),
    );
    let prompt = "";
    let sandbox = "";
    const agentRunner: AgentFunction = async <TOutput>(
      value: string,
      options?: AgentOptions,
    ) => {
      prompt = value;
      sandbox = options?.sandbox ?? "";
      return {
        status: "compiled",
        reason: "Converted all explicitly named UI conditions.",
        oracles: [
          {
            type: "all_text_visible",
            value: "",
            values: ["AI 生成可能有误 注意核实", "通话入口", "朗读入口"],
            sceneId: "",
            bundleId: "",
            maximumSsim: 0,
          },
        ],
      } as TOutput;
    };
    try {
      const plan = await runWorkflow<AppGraphPlanOutput>(planWorkflowPath, {
        goal: "会话页",
        graphPath,
        outputDir: join(root, "plan"),
        planOnly: true,
      });
      expect(plan.success).toBeTrue();
      if (!plan.success) return;
      const verification = await resolveCaseVerification({
        structuredCase: {
          case_id: "complex-expected",
          title: "主 bot 导航栏信息可见",
          goal: "会话页",
          step: "查看主 bot 导航栏",
          expected:
            "名称下方显示“AI 生成可能有误 注意核实”，并展示通话入口和朗读入口。",
        },
        plan,
        agentCwd: root,
        timeoutMs: 1_000,
        agentRunner,
      });
      expect(verification).toEqual({
        supplied: true,
        sources: ["expected"],
        oracles: [
          {
            type: "all_text_visible",
            values: ["AI 生成可能有误 注意核实", "通话入口", "朗读入口"],
          },
        ],
        issues: [],
        compiler: "agent",
        reason: "Converted all explicitly named UI conditions.",
      });
      expect(sandbox).toBe("read-only");
      expect(prompt).toContain("never return only a partial interpretation");
      expect(prompt).toContain("主 bot 导航栏信息可见");
      const mixed = await resolveCaseVerification({
        structuredCase: {
          case_id: "mixed-verify",
          title: "混合验证",
          step: "保持在会话页",
          expected: "",
          verify: [
            { type: "visible", text: "豆包" },
            "布局完整且入口间距符合设计",
          ],
        },
        plan,
        agentCwd: root,
        timeoutMs: 1_000,
        agentRunner,
      });
      expect(mixed).toMatchObject({
        supplied: true,
        sources: ["verify"],
        compiler: "agent",
        issues: [],
        oracles: expect.arrayContaining([
          { type: "ui_text_visible", value: "豆包" },
        ]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Accept resolves the installed App version before planning device cases", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-accept-version-"));
    const commands: string[][] = [];
    const commandRunner = async (command: readonly string[]) => {
      commands.push([...command]);
      if (command[0] === "mobilecli") {
        return {
          stdout: JSON.stringify({
            data: [{ packageName: graph.bundleId, version: graph.appVersion }],
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "reset failed", exitCode: 1 };
    };
    try {
      const result = await runWorkflow<AppGraphAcceptOutput>(
        acceptWorkflowPath,
        {
          case: {
            case_id: "sidebar-version",
            title: "打开侧边栏",
            step: "点击左上角对话列表按钮",
            expected: "显示搜索、技能和云盘",
          },
          graphPath,
          udid: "fake-device",
          outputDir: root,
          planOnly: false,
          commandRunner,
        },
      );
      expect(result.mode).toBe("accept");
      if (result.mode !== "accept") return;
      expect(result.cases[0]?.planResult).toMatchObject({
        success: true,
        runtimeAppVersion: graph.appVersion,
      });
      expect(
        commands.filter((command) => command[0] === "mobilecli"),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function runWorkflow<T>(
  workflowPath: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const runner = new WorkflowRunner({ logWriter: () => undefined });
  try {
    return await runner.run<T>(workflowPath, args);
  } finally {
    runner.dispose();
  }
}

function uiElement(label: string, x: number, y: number) {
  return {
    role: "Button",
    accessibilityId: label,
    label,
    bounds: { x, y, width: 80, height: 40 },
  };
}

function mockAcceptCommandRunner(root: string, labels: readonly string[]) {
  return async (command: readonly string[]) => {
    if (command[0] === "python3") {
      return {
        stdout: JSON.stringify({
          schemaVersion: "ios-ui-devicectl-restart/v1",
          success: true,
          bundleId: graph.bundleId,
          oldPids: [101],
          newPid: 202,
          currentPids: [202],
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (command[1] === "screenshot") {
      const outputIndex = command.indexOf("-o");
      const outputPath =
        outputIndex >= 0 ? command[outputIndex + 1] : undefined;
      if (outputPath) await writeFile(outputPath, "fake-image", "utf8");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command[1] === "apps" && command[2] === "foreground") {
      return { stdout: graph.bundleId, stderr: "", exitCode: 0 };
    }
    if (command[1] === "dump" && command[2] === "ui") {
      return {
        stdout: JSON.stringify(
          labels.map((label, index) => uiElement(label, 20, 40 + index * 50)),
        ),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

function observation(uiElements: readonly ReturnType<typeof uiElement>[]) {
  return {
    screenshotPath: "/tmp/ios_perf-opt/runtime/screen.png",
    uiDumpPath: "/tmp/ios_perf-opt/runtime/ui.json",
    foregroundPath: "/tmp/ios_perf-opt/runtime/foreground.json",
    foregroundBundleId: "com.bot.doubao",
    uiElements,
  };
}

function discoveryObservation(
  root: string,
  sceneId: string,
  uiElements: readonly ReturnType<typeof uiElement>[],
) {
  return {
    sceneId,
    screenshotPath: join(root, `${sceneId}.png`),
    uiDumpPath: join(root, `${sceneId}.json`),
    foregroundPath: join(root, `${sceneId}-foreground.json`),
    foregroundBundleId: "com.bot.doubao",
    elements: uiElements.map((element) => ({
      elementId: element.accessibilityId,
      accessibilityId: element.accessibilityId,
      label: element.label,
      text: "",
      value: "",
      role: element.role,
      x: element.bounds.x,
      y: element.bounds.y,
      width: element.bounds.width,
      height: element.bounds.height,
    })),
    uiElements,
    timestamp: "2026-08-22T00:00:00.000Z",
  };
}
