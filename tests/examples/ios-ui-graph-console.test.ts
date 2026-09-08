import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

import graphJson from "../../examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json";
import {
  GraphConsoleRunManager,
  applyGraphCorrectionProposal,
  graphRevision,
  normalizeActionRequest,
  resolveStaleSceneRecoveryEntry,
  runGraphConsoleChat,
  validateActionRequest,
  workflowInvocation,
  workflowFailureMessage,
  workflowSuccessMessage,
} from "../../examples/ios-ui-graph-console/console";
import { createGraphConsoleServer } from "../../examples/ios-ui-graph-console/server";
import { parseMobilecliDevicesOutput } from "../../examples/ios-ui-graph-console/devices";

import type { AgentFunction } from "@deerwork-ai/deer-workflow/agents";
import type { AppGraph } from "../../examples/ios-ui-graph-manager/types";

const graph = graphJson as AppGraph;

describe("iOS UI Graph Console", () => {
  test("summarizes successful exploration with concrete action and Graph counts", () => {
    expect(
      workflowSuccessMessage({
        success: true,
        mode: "discovery",
        actionsExecuted: 1,
        visibilityActionsExecuted: 0,
        scenesDiscovered: 1,
        elementsDiscovered: 4,
        graphUpdated: true,
        graphRevision: 75,
        focusElementTitle: "通知设置",
        observedSceneIds: ["bot.settings.notification_settings"],
      }),
    ).toBe(
      "Exploration completed: 1 target action(s), 0 visibility action(s), 1 target Scene(s), 4 new Element(s); Graph updated. Graph r75. Focus: 通知设置. Reached: bot.settings.notification_settings.",
    );
  });

  test("summarizes whether successful execution changed the Graph", () => {
    expect(
      workflowSuccessMessage({
        success: true,
        mode: "app_graph",
        graphUpdated: true,
        finalExec: { graphUpdated: true, graphRevision: 95 },
      }),
    ).toBe(
      "执行成功。Graph 已更新到 r95，请刷新页面查看新的 Task、截图或 Binding。",
    );
    expect(
      workflowSuccessMessage({
        success: true,
        mode: "app_graph",
        graphUpdated: false,
      }),
    ).toBe("执行成功。Graph 未变化，无需刷新。");
  });

  test("summarizes failed exploration with focus and visibility progress", () => {
    expect(
      workflowFailureMessage({
        success: false,
        code: "visibility_recovery_failed",
        message: "UI dump failed after scrolling.",
        visibilityActionsExecuted: 1,
        focusElementTitle: "未成年人模式",
        expectedSceneId: "bot.settings.minor_mode",
      }),
    ).toBe(
      "visibility_recovery_failed: UI dump failed after scrolling. Focus: 未成年人模式. Visibility actions: 1. Expected: bot.settings.minor_mode.",
    );
  });

  test("routes explicit Plan and scoped exploration without semantic shell commands", () => {
    const options = {
      graphPath: "/tmp/graph.json",
      planWorkflowPath: "/tmp/plan.ts",
      execWorkflowPath: "/tmp/exec.ts",
      appGraphWorkflowPath: "/tmp/app-graph.ts",
      discoveryWorkflowPath: "/tmp/discovery.ts",
    };
    expect(
      workflowInvocation(
        {
          action: "plan",
          target: { kind: "task", id: "message.send_text" },
          parameters: { text: "你好" },
        },
        options,
        "/tmp/run-task",
      ),
    ).toEqual({
      path: "/tmp/plan.ts",
      args: {
        graphPath: "/tmp/graph.json",
        outputDir: "/tmp/run-task/plan",
        goal: "message.send_text",
        planOnly: true,
        parameters: { text: "你好" },
        deviceProfileId: undefined,
        target: { kind: "task", id: "message.send_text" },
      },
    });
    expect(
      workflowInvocation(
        {
          action: "plan",
          target: { kind: "scene", id: "bot.settings" },
        },
        options,
        "/tmp/run-scene",
      ).args,
    ).toMatchObject({
      goal: "bot.settings",
      planOnly: true,
      target: { kind: "scene", id: "bot.settings" },
    });
    expect(
      workflowInvocation(
        {
          action: "plan",
          target: { kind: "operator", id: "chat.open_bot_settings" },
        },
        options,
        "/tmp/run-operator",
      ).args,
    ).toMatchObject({
      goal: "执行 Operator chat.open_bot_settings",
      planOnly: true,
      target: { kind: "operator", id: "chat.open_bot_settings" },
    });
    expect(
      workflowInvocation(
        {
          action: "explore",
          goal: "打开侧边栏",
          target: {
            kind: "element",
            id: "chat.sidebar_entry",
          },
        },
        options,
        "/tmp/run-explore",
      ).args,
    ).toMatchObject({
      goal: "打开侧边栏",
      startElementId: "chat.sidebar_entry",
      maxActions: 1,
      maxDepth: 0,
    });
  });

  test("normalizes Task and Operator exploration to their resulting Scene", () => {
    expect(
      normalizeActionRequest(graph, {
        action: "execute",
        target: { kind: "scene", id: "bot.settings.sound" },
      }),
    ).toMatchObject({
      target: { kind: "scene", id: "bot.settings.sound" },
      goal: "打开声音设置",
    });
    expect(
      normalizeActionRequest(graph, {
        action: "execute",
        target: { kind: "element", id: "chat.sidebar_entry" },
      }).target,
    ).toEqual({ kind: "scene", id: "chat.detail" });
    expect(
      normalizeActionRequest(graph, {
        action: "explore",
        target: { kind: "operator", id: "chat.open_bot_settings" },
      }).target,
    ).toEqual({ kind: "scene", id: "bot.settings" });
    expect(
      normalizeActionRequest(graph, {
        action: "explore",
        target: { kind: "task", id: "skills.open_from_chat_sidebar" },
      }).target,
    ).toEqual({ kind: "scene", id: "skills.home" });
  });

  test("requires stale Scene recovery instead of ordinary execution", () => {
    const staleGraph = structuredClone(graph);
    (staleGraph.scenes["chat.sidebar"] as { status: string }).status = "stale";
    (staleGraph.operators["chat.open_sidebar"] as { status: string }).status =
      "stale";
    expect(() =>
      validateActionRequest(staleGraph, {
        action: "execute",
        target: { kind: "scene", id: "chat.sidebar" },
      }),
    ).toThrow("Use stale Scene recovery");
    expect(() =>
      validateActionRequest(staleGraph, {
        action: "recover",
        target: { kind: "scene", id: "chat.sidebar" },
      }),
    ).not.toThrow();
    const recoveryEntry = resolveStaleSceneRecoveryEntry(
      staleGraph,
      "chat.sidebar",
    );
    expect(recoveryEntry).toBeDefined();
    expect(
      staleGraph.scenes[recoveryEntry!.sourceSceneId]?.elements[
        recoveryEntry!.elementId
      ],
    ).toBeDefined();
  });

  test("routes Execute through the unified App Graph Workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-ui-graph-console-unified-"));
    const graphPath = join(root, "graph.json");
    const unifiedPath = join(root, "app-graph.ts");
    const orderPath = join(root, "order.txt");
    const flowModuleUrl = pathToFileURL(
      join(import.meta.dir, "../../src/flow/index.ts"),
    ).href;
    await writeFile(graphPath, JSON.stringify(graph), "utf8");
    await writeFile(
      unifiedPath,
      `import { writeFile } from "node:fs/promises"; import { phase } from ${JSON.stringify(flowModuleUrl)}; export const meta={name:"unified-stub",description:"unified stub",phases:[{title:"Work"}],exampleArgs:{}}; export default async function(args){phase("Work");await writeFile(${JSON.stringify(orderPath)},JSON.stringify(args));return {success:true,mode:"app_graph"};}`,
      "utf8",
    );
    const manager = new GraphConsoleRunManager({
      graphPath,
      artifactRoot: join(root, "runs"),
      planWorkflowPath: join(root, "missing-plan.ts"),
      execWorkflowPath: join(root, "missing-exec.ts"),
      appGraphWorkflowPath: unifiedPath,
      discoveryWorkflowPath: join(root, "missing-discovery.ts"),
    });
    try {
      const run = await manager.enqueue({
        action: "execute",
        target: { kind: "task", id: "chat.open_sidebar" },
        udid: "device-1",
      });
      await waitForRun(manager, run.runId);
      expect(JSON.parse(await readFile(orderPath, "utf8"))).toMatchObject({
        goal: "chat.open_sidebar",
        target: { kind: "task", id: "chat.open_sidebar" },
        planOnly: false,
        udid: "device-1",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a selected device that is no longer online", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-ui-graph-console-device-"));
    const graphPath = join(root, "graph.json");
    const workflowPath = join(root, "app-graph.ts");
    await writeFile(graphPath, JSON.stringify(graph), "utf8");
    await writeFile(
      workflowPath,
      "export default async function(){return {success:true};}",
      "utf8",
    );
    const manager = new GraphConsoleRunManager({
      graphPath,
      artifactRoot: join(root, "runs"),
      planWorkflowPath: workflowPath,
      execWorkflowPath: workflowPath,
      appGraphWorkflowPath: workflowPath,
      discoveryWorkflowPath: workflowPath,
      deviceScanner: async () => [],
    });
    try {
      const queued = await manager.enqueue({
        action: "execute",
        target: { kind: "task", id: "chat.open_sidebar" },
        udid: "offline-device",
      });
      const failed = await waitForRunStatus(manager, queued.runId, "failed");
      expect(failed.error).toBe(
        "Selected iOS device is not online: offline-device.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("blocks Scene-wide exploration and routes explicit Element exploration", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ios-ui-graph-console-explore-chain-"),
    );
    const graphPath = join(root, "graph.json");
    const planWorkflowPath = join(root, "plan.ts");
    const execWorkflowPath = join(root, "exec.ts");
    const discoveryWorkflowPath = join(root, "discovery.ts");
    const orderPath = join(root, "order.txt");
    const flowModuleUrl = pathToFileURL(
      join(import.meta.dir, "../../src/flow/index.ts"),
    ).href;
    await writeFile(graphPath, JSON.stringify(graph), "utf8");
    await writeFile(
      planWorkflowPath,
      `import { appendFile } from "node:fs/promises"; import { phase } from ${JSON.stringify(flowModuleUrl)}; export const meta={name:"plan-stub",description:"plan stub",phases:[{title:"Plan"}],exampleArgs:{}}; export default async function(args){phase("Plan");await appendFile(${JSON.stringify(orderPath)},"plan:"+args.target.id+"\\n");return {schemaVersion:"app-graph-semantic-plan/v2",success:true,mode:"plan",goal:args.goal,resolvedSteps:[{}]};}`,
      "utf8",
    );
    await writeFile(
      execWorkflowPath,
      `import { appendFile } from "node:fs/promises"; import { phase } from ${JSON.stringify(flowModuleUrl)}; export const meta={name:"exec-stub",description:"exec stub",phases:[{title:"Exec"}],exampleArgs:{}}; export default async function(args){phase("Exec");await appendFile(${JSON.stringify(orderPath)},"exec:"+args.plan.goal+"\\n");return {success:true,mode:"exec",verdict:"pass"};}`,
      "utf8",
    );
    await writeFile(
      discoveryWorkflowPath,
      `import { appendFile } from "node:fs/promises"; import { phase } from ${JSON.stringify(flowModuleUrl)}; export const meta={name:"discovery-stub",description:"discovery stub",phases:[{title:"Discover"}],exampleArgs:{}}; export default async function(args){phase("Discover");await appendFile(${JSON.stringify(orderPath)},"discover:"+args.startSceneId+":"+String(args.skipReset)+"\\n");return {success:true,mode:"discovery"};}`,
      "utf8",
    );
    const manager = new GraphConsoleRunManager({
      graphPath,
      artifactRoot: join(root, "runs"),
      planWorkflowPath,
      execWorkflowPath,
      appGraphWorkflowPath: execWorkflowPath,
      discoveryWorkflowPath,
    });
    try {
      await expect(
        manager.enqueue({
          action: "explore",
          target: { kind: "scene", id: "bot.settings" },
        }),
      ).rejects.toThrow("explicit Element");
      await expect(
        manager.enqueue({
          action: "explore",
          target: { kind: "element", id: "chat.sidebar_entry" },
        }),
      ).rejects.toThrow("user goal");
      const run = await manager.enqueue({
        action: "explore",
        goal: "打开侧边栏",
        target: { kind: "element", id: "chat.sidebar_entry" },
        udid: "device-1",
      });
      await waitForRun(manager, run.runId);
      expect((await readFile(orderPath, "utf8")).trim().split("\n")).toEqual([
        "plan:chat.detail",
        "exec:chat.detail",
        "discover:chat.detail:true",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes runs through one device queue and streams Workflow phases", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-ui-graph-console-queue-"));
    const graphPath = join(root, "graph.json");
    const workflowPath = join(root, "workflow.ts");
    const orderPath = join(root, "order.txt");
    const flowModuleUrl = pathToFileURL(
      join(import.meta.dir, "../../src/flow/index.ts"),
    ).href;
    await writeFile(graphPath, JSON.stringify(graph), "utf8");
    await writeFile(
      workflowPath,
      `import { appendFile } from "node:fs/promises";
import { phase } from ${JSON.stringify(flowModuleUrl)};
export const meta={name:"queue-test",description:"queue test workflow",phases:[{title:"Work"}],exampleArgs:{}};
export default async function(args){phase("Work");await appendFile(${JSON.stringify(orderPath)}, "start:"+args.outputDir+"\\n");await Bun.sleep(30);await appendFile(${JSON.stringify(orderPath)}, "end:"+args.outputDir+"\\n");return {success:true,outputDir:args.outputDir};}`,
      "utf8",
    );
    const manager = new GraphConsoleRunManager({
      graphPath,
      artifactRoot: join(root, "runs"),
      planWorkflowPath: workflowPath,
      execWorkflowPath: workflowPath,
      appGraphWorkflowPath: workflowPath,
      discoveryWorkflowPath: workflowPath,
    });
    try {
      const first = await manager.enqueue({
        action: "plan",
        target: { kind: "scene", id: "chat.detail" },
      });
      const second = await manager.enqueue({
        action: "plan",
        target: { kind: "scene", id: "chat.detail" },
      });
      await waitForRun(manager, first.runId);
      await waitForRun(manager, second.runId);
      const order = (await readFile(orderPath, "utf8")).trim().split("\n");
      expect(order).toEqual([
        `start:${first.outputDir}/plan`,
        `end:${first.outputDir}/plan`,
        `start:${second.outputDir}/plan`,
        `end:${second.outputDir}/plan`,
      ]);
      expect(
        manager
          .get(first.runId)
          ?.events.some(
            (event) =>
              event.workflowEvent?.type === "workflow:phase:start" &&
              event.workflowEvent.phase === "Work",
          ),
      ).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("creates and atomically applies a safe Agent correction proposal", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ios-ui-graph-console-correction-"),
    );
    const graphPath = join(root, "graph.json");
    const proposalDirectory = join(root, "proposals");
    await writeFile(graphPath, JSON.stringify(graph), "utf8");
    const revision = await graphRevision(graphPath);
    const agentRunner: AgentFunction = async <TOutput>() =>
      ({
        kind: "correction_proposal",
        message: "建议修正页面名称。",
        action: "",
        targetKind: "scene",
        targetId: "bot.settings.font_background",
        correctionSummary: "修正字号页面名称",
        requiresExploration: false,
        explorationGoal: "",
        evidencePaths: [],
        changes: [
          {
            entityKind: "scene",
            entityId: "bot.settings.font_background",
            field: "title",
            stringValue: "字号与背景",
            listValue: [],
            reason: "用户纠正页面名称。",
          },
        ],
      }) as TOutput;
    try {
      const response = await runGraphConsoleChat({
        graphPath,
        request: {
          message: "这个页面应该叫字号与背景",
          target: { kind: "scene", id: "bot.settings.font_background" },
          graphRevision: revision,
        },
        proposalDirectory,
        agentCwd: root,
        agentRunner,
      });
      expect(response.kind).toBe("correction_proposal");
      expect(response.proposal?.changes).toHaveLength(1);
      const result = await applyGraphCorrectionProposal({
        graphPath,
        proposalPath: join(
          proposalDirectory,
          `${response.proposal!.proposalId}.json`,
        ),
        backupDirectory: join(root, "backups"),
      });
      const patched = JSON.parse(await readFile(graphPath, "utf8")) as AppGraph;
      expect(patched.scenes["bot.settings.font_background"]?.title).toBe(
        "字号与背景",
      );
      expect(patched.revision).toBe(graph.revision + 1);
      expect(result.graphRevision).not.toBe(revision);
      expect(await Bun.file(result.backupPath).exists()).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves the Agent exploration goal for the executable action", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ios-ui-graph-console-agent-explore-"),
    );
    const graphPath = join(root, "graph.json");
    const staleGraph = structuredClone(graph);
    (staleGraph.scenes["chat.sidebar"] as { status: string }).status = "stale";
    await writeFile(graphPath, JSON.stringify(staleGraph), "utf8");
    const agentRunner: AgentFunction = async <TOutput>() =>
      ({
        kind: "explore",
        message: "可以基于侧边栏入口验证打开路径。",
        action: "explore",
        targetKind: "element",
        targetId: "chat.sidebar_entry",
        correctionSummary: "",
        requiresExploration: true,
        explorationGoal: "打开侧边栏并确认搜索入口",
        evidencePaths: [],
        changes: [],
      }) as TOutput;
    try {
      const response = await runGraphConsoleChat({
        graphPath,
        request: {
          message: "帮我验证这个入口",
          target: { kind: "element", id: "chat.sidebar_entry" },
        },
        proposalDirectory: join(root, "proposals"),
        agentCwd: root,
        agentRunner,
      });
      expect(response).toMatchObject({
        kind: "explore",
        action: "explore",
        goal: "打开侧边栏并确认搜索入口",
        target: { kind: "element", id: "chat.sidebar_entry" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("converts an Agent execute suggestion for a stale Scene into recovery", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ios-ui-graph-console-agent-stale-"),
    );
    const graphPath = join(root, "graph.json");
    const staleGraph = structuredClone(graph);
    (staleGraph.scenes["chat.sidebar"] as { status: string }).status = "stale";
    await writeFile(graphPath, JSON.stringify(staleGraph), "utf8");
    const agentRunner: AgentFunction = async <TOutput>() =>
      ({
        kind: "execute",
        message: "可以执行到该页面查看错误。",
        action: "execute",
        targetKind: "scene",
        targetId: "chat.sidebar",
        correctionSummary: "",
        requiresExploration: false,
        explorationGoal: "重新验证 PPT 生成面板",
        evidencePaths: [],
        changes: [],
      }) as TOutput;
    try {
      const response = await runGraphConsoleChat({
        graphPath,
        request: {
          message: "执行到这里看报错原因",
          target: { kind: "scene", id: "chat.sidebar" },
        },
        proposalDirectory: join(root, "proposals"),
        agentCwd: root,
        agentRunner,
      });
      expect(response).toMatchObject({
        kind: "recover",
        action: "recover",
        target: { kind: "scene", id: "chat.sidebar" },
        goal: "重新验证 PPT 生成面板",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects stale correction proposals after the Graph revision changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-ui-graph-console-stale-"));
    const graphPath = join(root, "graph.json");
    const proposalPath = join(root, "proposal.json");
    await writeFile(graphPath, JSON.stringify(graph), "utf8");
    const revision = await graphRevision(graphPath);
    await writeFile(
      proposalPath,
      JSON.stringify({
        schemaVersion: "ios-ui-graph-correction-proposal/v1",
        proposalId: "stale-proposal",
        graphRevision: revision,
        summary: "stale",
        evidencePaths: [],
        changes: [
          {
            entityKind: "scene",
            entityId: "chat.detail",
            field: "title",
            value: "会话页面",
            reason: "test",
          },
        ],
        requiresExploration: false,
        explorationGoal: "",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await writeFile(
      graphPath,
      JSON.stringify({ ...graph, appName: `${graph.appName}-changed` }),
      "utf8",
    );
    try {
      await expect(
        applyGraphCorrectionProposal({
          graphPath,
          proposalPath,
          backupDirectory: join(root, "backups"),
        }),
      ).rejects.toThrow("Graph changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serves the generated map and revision-aware Graph API", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-ui-graph-console-server-"));
    const artifactDirectory = await mkdtemp(
      "/tmp/ios_perf-opt/ios-ui-graph-console-test-",
    );
    const graphPath = join(root, "graph.json");
    const mapDirectory = join(root, "ui-map");
    const screenshotPath = join(artifactDirectory, "screen.png");
    const relativeScreenshotPath = join(
      "reference-assets",
      "chat.detail",
      "test",
      "screenshot.png",
    );
    await Bun.write(graphPath, JSON.stringify(graph));
    await Bun.write(
      join(mapDirectory, "map.html"),
      "<main>Graph Console</main>",
    );
    await Bun.write(screenshotPath, new Uint8Array([137, 80, 78, 71]));
    await Bun.write(
      join(root, relativeScreenshotPath),
      new Uint8Array([137, 80, 78, 71]),
    );
    const server = createGraphConsoleServer({
      host: "127.0.0.1",
      port: 0,
      graphPath,
      mapDirectory,
      artifactRoot: join(root, "artifacts"),
      deviceScanner: async () => [
        {
          id: "device-1",
          name: "Test iPhone",
          platform: "ios",
          type: "real",
          version: "18.7",
          state: "online",
          model: "iPhone12,1",
        },
      ],
    });
    try {
      const health = await fetch(new URL("/api/health", server.url));
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        ok: true,
        graphPath,
        graphRevision: await graphRevision(graphPath),
        graphNumericRevision: graph.revision,
      });

      const devices = await fetch(new URL("/api/devices", server.url));
      expect(devices.status).toBe(200);
      expect(await devices.json()).toEqual({
        devices: [
          {
            id: "device-1",
            name: "Test iPhone",
            platform: "ios",
            type: "real",
            version: "18.7",
            state: "online",
            model: "iPhone12,1",
          },
        ],
        defaultUdid: "device-1",
      });

      const map = await fetch(new URL("/ui-map/map.html", server.url));
      expect(map.status).toBe(200);
      expect(map.headers.get("cache-control")).toBe("no-store, max-age=0");
      const mapHtml = await map.text();
      expect(mapHtml).toContain(
        `Graph v2 · ${graph.graphId} · r${graph.revision}`,
      );
      expect(mapHtml).toContain(`Tasks (${Object.keys(graph.tasks).length})`);

      const screenshot = await fetch(
        new URL(
          `/api/artifact?path=${encodeURIComponent(screenshotPath)}`,
          server.url,
        ),
      );
      expect(screenshot.status).toBe(200);
      expect(screenshot.headers.get("content-type")).toBe("image/png");
      expect(screenshot.headers.get("cache-control")).toBe(
        "no-store, max-age=0",
      );
      expect(new Uint8Array(await screenshot.arrayBuffer())).toEqual(
        new Uint8Array([137, 80, 78, 71]),
      );

      const relativeScreenshot = await fetch(
        new URL(
          `/api/artifact?path=${encodeURIComponent(relativeScreenshotPath)}`,
          server.url,
        ),
      );
      expect(relativeScreenshot.status).toBe(200);

      const missingScreenshot = await fetch(
        new URL(
          `/api/artifact?path=${encodeURIComponent(join(artifactDirectory, "missing.png"))}`,
          server.url,
        ),
      );
      expect(missingScreenshot.status).toBe(404);
      expect(await missingScreenshot.json()).toEqual({
        error: "Artifact not found.",
      });

      const outsideScreenshot = await fetch(
        new URL(
          `/api/artifact?path=${encodeURIComponent(join(root, "outside.png"))}`,
          server.url,
        ),
      );
      expect(outsideScreenshot.status).toBe(400);
      expect(await outsideScreenshot.json()).toEqual({
        error:
          "Artifact path is outside Graph reference assets and ~/.ios_pref_optimizer.",
      });

      const blockedArtifact = await fetch(
        new URL(
          `/api/artifact?path=${encodeURIComponent("/etc/passwd")}`,
          server.url,
        ),
      );
      expect(blockedArtifact.status).toBe(400);
      expect(await blockedArtifact.json()).toEqual({
        error:
          "Artifact path is outside Graph reference assets and ~/.ios_pref_optimizer.",
      });

      const runtimeReady = await fetch(
        new URL("/ui-map/runtime-ready?detail=interactive", server.url),
      );
      expect(runtimeReady.status).toBe(200);
      expect(
        await fetch(new URL("/api/health", server.url)).then((response) =>
          response.json(),
        ),
      ).toMatchObject({
        clientRuntime: {
          status: "ready",
          detail: "interactive",
        },
      });

      const invalid = await fetch(new URL("/api/actions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "execute",
          target: { kind: "scene", id: "missing.scene" },
        }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        error: "scene does not exist: missing.scene.",
      });
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  });
});

describe("iOS device discovery", () => {
  test("parses only online real iOS devices from mobilecli", () => {
    expect(
      parseMobilecliDevicesOutput(
        JSON.stringify({
          status: "ok",
          data: {
            devices: [
              {
                id: "real-online",
                name: "iPhone",
                platform: "ios",
                type: "real",
                version: "18.7.8",
                state: "online",
                model: "iPhone12,1",
              },
              {
                id: "real-offline",
                platform: "ios",
                type: "real",
                state: "offline",
              },
              {
                id: "simulator",
                platform: "ios",
                type: "simulator",
                state: "online",
              },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        id: "real-online",
        name: "iPhone",
        platform: "ios",
        type: "real",
        version: "18.7.8",
        state: "online",
        model: "iPhone12,1",
      },
    ]);
  });
});

async function waitForRun(
  manager: GraphConsoleRunManager,
  runId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = manager.get(runId);
    if (run?.status === "succeeded" || run?.status === "failed") {
      expect(run.status, run.error ?? JSON.stringify(run.result)).toBe(
        "succeeded",
      );
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Run did not finish: ${runId}.`);
}

async function waitForRunStatus(
  manager: GraphConsoleRunManager,
  runId: string,
  status: "succeeded" | "failed",
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = manager.get(runId);
    if (run?.status === status) return run;
    await Bun.sleep(10);
  }
  throw new Error(`Run did not reach ${status}: ${runId}.`);
}
