import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import graphJson from "../../examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json";
import { WorkflowRunner } from "@deerwork-ai/deer-workflow/runner";

import type { AgentFunction } from "@deerwork-ai/deer-workflow/agents";
import type { AppGraphWorkflowOutput } from "../../examples/app-graph/types";
import type { AppGraph } from "../../examples/ios-ui-graph-manager/types";
import { normalizeGoal } from "../../examples/app-graph/workflow";

const graph = graphJson as AppGraph;
const graphPath = join(
  process.cwd(),
  "examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);
const workflowPath = join(process.cwd(), "examples/app-graph/workflow.ts");

describe("App Graph unified workflow", () => {
  test("normalizes unmatched smart quotes around a natural-language goal", () => {
    expect(normalizeGoal("打开帮助与反馈”")).toBe("打开帮助与反馈");
    expect(normalizeGoal("“打开侧边栏”")).toBe("打开侧边栏");
  });
  test("returns a semantic Plan from one plan-only invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-unified-plan-"));
    try {
      const result = await runUnified({
        goal: "打开侧边栏",
        graphPath,
        outputDir: root,
        planOnly: true,
      });
      expect(result).toMatchObject({
        schemaVersion: "app-graph-workflow-result/v1",
        success: true,
        mode: "app_graph",
        planOnly: true,
        verdict: "plan_ready",
        finalPlan: {
          schemaVersion: "app-graph-semantic-plan/v2",
          matchedTaskId: "chat.open_sidebar",
          graphRevision: graph.revision,
        },
      });
      expect(result.rounds).toHaveLength(1);
      expect(await Bun.file(result.resultPath).exists()).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs Plan to Exec from one invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-unified-exec-"));
    const temporaryGraphPath = join(root, "graph.json");
    await writeFile(temporaryGraphPath, JSON.stringify(graph), "utf8");
    let state: "before" | "after" = "before";
    const commandRunner = fakeCommandRunner(
      () => state,
      (value) => {
        state = value;
      },
    );
    const agentRunner: AgentFunction = async <TOutput>() =>
      ({
        status: "matched",
        candidateId: "ui-4",
        confidence: 0.96,
        reason: "The fourth candidate is the renamed sidebar entry.",
      }) as TOutput;
    try {
      const result = await runUnified({
        goal: "打开侧边栏",
        graphPath: temporaryGraphPath,
        udid: "fake-device",
        outputDir: root,
        planOnly: false,
        maximumRecoveryRounds: 0,
        agentRunner,
        commandRunner,
      });
      expect(result).toMatchObject({
        success: true,
        mode: "app_graph",
        verdict: "pass",
        graphUpdated: true,
        finalExec: {
          success: true,
          verdict: "pass",
          steps: [{ resolutionSource: "agent_selector" }],
        },
      });
      expect(result.rounds).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("stops immediately when strict restart proof fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-strict-reset-fail-"));
    const commands: string[][] = [];
    let agentCalls = 0;
    const commandRunner = async (command: readonly string[]) => {
      commands.push([...command]);
      return {
        stdout: "",
        stderr: "CoreDevice strict restart unavailable",
        exitCode: 1,
      };
    };
    const agentRunner: AgentFunction = async <TOutput>() => {
      agentCalls += 1;
      return {} as TOutput;
    };
    try {
      const result = await runUnified({
        goal: "打开侧边栏",
        graphPath,
        udid: "fake-device",
        outputDir: root,
        planOnly: false,
        agentRunner,
        commandRunner,
      });
      expect(result).toMatchObject({
        success: false,
        mode: "app_graph_failure",
        code: "reset_failed",
      });
      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual([
        "mobilecli",
        "apps",
        "list",
        "--device",
        "fake-device",
      ]);
      expect(commands[1]?.[0]).toBe("python3");
      expect(commands[1]?.[1]).toContain(
        "ios-regression-kit/devicectl_restart.py",
      );
      expect(agentCalls).toBe(0);
      expect(result.rounds).toHaveLength(1);
      expect(result.rounds[0]?.execResult).toMatchObject({
        mode: "exec_failure",
        code: "reset_failed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves the installed version for the Graph bundle instead of a fixed App", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-custom-bundle-"));
    const temporaryGraphPath = join(root, "graph.json");
    const customGraph = structuredClone(graph) as AppGraph;
    (customGraph as unknown as { bundleId: string }).bundleId =
      "com.example.custom";
    await writeFile(temporaryGraphPath, JSON.stringify(customGraph), "utf8");
    const commands: string[][] = [];
    const commandRunner = async (command: readonly string[]) => {
      commands.push([...command]);
      if (command[0] === "mobilecli") {
        return {
          stdout: JSON.stringify({
            data: [
              { packageName: "com.bot.doubao", version: "14.7.0" },
              { packageName: "com.example.custom", version: "14.8.0" },
            ],
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "reset failed", exitCode: 1 };
    };
    try {
      const result = await runUnified({
        goal: "打开侧边栏",
        graphPath: temporaryGraphPath,
        udid: "fake-device",
        outputDir: root,
        planOnly: false,
        commandRunner,
      });
      expect(result.success).toBeFalse();
      expect(result.rounds[0]?.planResult).toMatchObject({
        success: true,
        runtimeAppVersion: "14.8.0",
      });
      expect(
        commands.filter((command) => command[0] === "mobilecli"),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not repeat a successful business action after Exec learning", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-unified-replan-"));
    const temporaryGraphPath = join(root, "graph.json");
    await writeFile(temporaryGraphPath, JSON.stringify(graph), "utf8");
    let state: "before" | "after" = "before";
    const commandRunner = fakeCommandRunner(
      () => state,
      (value) => {
        state = value;
      },
    );
    let agentCalls = 0;
    const agentRunner: AgentFunction = async <TOutput>() => {
      agentCalls += 1;
      return {
        status: "matched",
        candidateId: "ui-4",
        confidence: 0.96,
        reason: "The fourth candidate is the renamed sidebar entry.",
      } as TOutput;
    };
    try {
      const first = await runUnified({
        goal: "打开侧边栏",
        graphPath: temporaryGraphPath,
        udid: "fake-device",
        outputDir: root,
        planOnly: false,
        maximumRecoveryRounds: 1,
        agentRunner,
        commandRunner,
      });
      expect(first.success).toBeTrue();
      if (!first.success) return;
      expect(agentCalls).toBe(1);
      const updated = JSON.parse(
        await readFile(temporaryGraphPath, "utf8"),
      ) as AppGraph;
      expect(updated.revision).toBe(graph.revision + 1);
      expect(first.finalPlan.graphRevision).toBe(graph.revision);
      expect(first.rounds).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("retries without issuing a second strict restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-retry-no-reset-"));
    const temporaryGraphPath = join(root, "graph.json");
    await writeFile(temporaryGraphPath, JSON.stringify(graph), "utf8");
    let restartCalls = 0;
    let dumpCalls = 0;
    const commandRunner = async (command: readonly string[]) => {
      if (command[0] === "python3") {
        restartCalls += 1;
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
        const outputPath = command[command.indexOf("-o") + 1];
        if (outputPath) await writeFile(outputPath, "fake-image", "utf8");
      }
      if (command[1] === "apps" && command[2] === "foreground") {
        return { stdout: "com.bot.doubao\n", stderr: "", exitCode: 0 };
      }
      if (command[1] === "dump" && command[2] === "ui") {
        dumpCalls += 1;
        const nodes =
          dumpCalls <= 2
            ? [
                element("豆包", 1, 1),
                element("AI 生成可能有误 注意核实", 1, 20),
                element("发消息或按住说话...", 1, 40),
                element("全新侧栏入口", 20, 60),
              ]
            : [
                element("搜索", 1, 1),
                element("技能", 1, 20),
                element("云盘", 1, 40),
              ];
        return { stdout: JSON.stringify(nodes), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    let agentCalls = 0;
    const agentRunner: AgentFunction = async <TOutput>() => {
      agentCalls += 1;
      return {
        status: "matched",
        candidateId: "ui-4",
        confidence: 0.96,
        reason: "target",
      } as TOutput;
    };
    try {
      await runUnified({
        goal: "打开侧边栏",
        graphPath: temporaryGraphPath,
        udid: "fake-device",
        outputDir: root,
        planOnly: false,
        maximumRecoveryRounds: 1,
        agentRunner,
        commandRunner,
      });
      expect(restartCalls).toBe(1);
      expect(agentCalls).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

async function runUnified(
  args: Readonly<Record<string, unknown>>,
): Promise<AppGraphWorkflowOutput> {
  const runner = new WorkflowRunner({ logWriter: () => undefined });
  try {
    return await runner.run<AppGraphWorkflowOutput>(workflowPath, args);
  } finally {
    runner.dispose();
  }
}

function fakeCommandRunner(
  readState: () => "before" | "after",
  writeState: (value: "before" | "after") => void,
) {
  return async (command: readonly string[]) => {
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
        readState() === "before"
          ? [
              element("豆包", 1, 1),
              element("AI 生成可能有误 注意核实", 1, 20),
              element("发消息或按住说话...", 1, 40),
              {
                ...element("全新侧栏入口", 20, 60),
                accessibilityId: "sidebar-v2",
                bounds: { x: 20, y: 60, width: 40, height: 20 },
              },
            ]
          : [
              element("搜索", 1, 1),
              element("技能", 1, 20),
              element("云盘", 1, 40),
            ];
      return { stdout: JSON.stringify(nodes), stderr: "", exitCode: 0 };
    }
    if (command[1] === "io" && command[2] === "tap") {
      writeState("after");
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

function element(label: string, x: number, y: number) {
  return {
    role: "Button",
    accessibilityId: label,
    label,
    bounds: { x, y, width: 80, height: 40 },
  };
}
