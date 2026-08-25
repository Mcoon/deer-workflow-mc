import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowRunner } from "@deerwork-ai/deer-workflow/runner";

const workflowPath = join(
  process.cwd(),
  "examples/app-graph-map-report/workflow.ts",
);
const graphPath = join(
  process.cwd(),
  "examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);

describe("App Graph v2 Map", () => {
  test("renders Agent chat and right-click actions for Graph nodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-graph-map-v2-"));
    const htmlPath = join(root, "map.html");
    const runner = new WorkflowRunner({ logWriter: () => undefined });
    try {
      const result = await runner.run<{ success: boolean; htmlPath: string }>(
        workflowPath,
        { graphPath, htmlPath },
      );
      expect(result.success).toBeTrue();
      const html = await readFile(htmlPath, "utf8");
      expect(html).toContain('id="agent-panel"');
      expect(html).toContain('id="agent-form"');
      expect(html).toContain('id="device-select"');
      expect(html).toContain('id="device-refresh"');
      expect(html).toContain('id="graph-refresh"');
      expect(html).toContain(
        "position:fixed;z-index:60;right:16px;bottom:16px",
      );
      expect(html).toMatch(/Graph r\d+ 已同步/);
      expect(html).toContain("加载 Graph r");
      expect(html).toContain("graphRefresh.disabled = false");
      expect(html).toContain(
        "grid-template-columns:clamp(220px,15vw,280px) minmax(0,1fr) clamp(340px,21vw,400px)",
      );
      expect(html).toContain("#scene-filter{flex:0 1 220px;width:220px");
      expect(html).toContain("width:100vw;max-width:100vw;min-width:0");
      expect(html).toContain(".details>*{min-width:0;max-width:100%}");
      expect(html).toContain("table-layout:fixed");
      expect(html).toContain('fetchJson("/api/devices"');
      expect(html).toContain('id="context-menu"');
      expect(html).toContain('data-context-action="execute"');
      expect(html).toContain('data-context-action="explore"');
      expect(html).toContain('data-context-action="copy"');
      expect(html).toContain("执行到这里");
      expect(html).toContain("基于这里继续探索");
      expect(html).toContain('fetchJson("/api/chat"');
      expect(html).toContain('fetchJson("/api/actions"');
      expect(html).toContain(
        "if (!consoleAvailable && !(await refreshConsoleStatus()))",
      );
      expect(html).toContain(
        'window.addEventListener("focus", () => void refreshConsoleStatus())',
      );
      expect(html).toContain(
        "setInterval(() => void refreshConsoleStatus(), 5000)",
      );
      expect(html).toContain('node.on("contextmenu"');
      expect(html).toContain('link.on("contextmenu"');
      expect(html).toContain("navigator.clipboard");
      expect(html).toContain("openElementChoices");
      expect(html).toContain("重新到达并采集当前页面");
      expect(html).toContain("探索元素：");
      expect(html).toContain("重新探索恢复");
      expect(html).toContain('recover:s.status==="stale"');
      expect(html).toContain("appendThinkingMessage");
      expect(html).toContain("replaceAgentMessage");
      expect(html).toContain("persistAgentSession");
      expect(html).toContain("restoreAgentSession");
      expect(html).toContain("sessionStorage.setItem(agentSessionKey");
      expect(html).not.toContain("setTimeout(() => location.reload()");
      expect(html).toContain("Graph 已更新。请先点击右下角的加载按钮");
      expect(html).toContain("刷新并查看新 Graph");
      expect(html).toContain("Graph 未变化，无需刷新");
      expect(html).not.toContain("child_process");
      expect(html).not.toContain("Bun.spawn");
      const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
        .filter((match) => !match[1]?.includes("application/json"))
        .map((match) => match[2])
        .filter((source) => source?.trim());
      expect(scripts.length).toBeGreaterThan(0);
      for (const source of scripts) {
        expect(() => new Function(source!)).not.toThrow();
      }
    } finally {
      runner.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
