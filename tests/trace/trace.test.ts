import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

import { bindAgent } from "../../src/agents/agent";
import type { Agent } from "../../src/agents/types";
import { runTracedCommand } from "../../src/trace/command";
import { runWithTraceRecorder } from "../../src/trace/context";
import { TraceRecorder } from "../../src/trace/recorder";
import type { TraceEntry } from "../../src/trace/types";

describe("Workflow trace", () => {
  test("uses the persistent per-user trace root by default", () => {
    const recorder = new TraceRecorder("trace-default-root.ts");
    expect(recorder.outputDirectory).toStartWith(
      join(homedir(), ".ios_pref_optimizer", "deer-workflow-traces"),
    );
  });

  test("captures commands and redacts sensitive arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "deer-trace-command-"));
    const recorder = new TraceRecorder("trace-command-test.ts", {
      rootDirectory: root,
    });
    try {
      await recorder.initialize({ token: "secret-input" });
      recorder.record("workflow:event", {
        type: "workflow:phase:start",
        phase: "Ground",
      });
      const result = await runWithTraceRecorder(recorder, () =>
        runTracedCommand([
          process.execPath,
          "-e",
          'console.log("hello"); console.error("warning")',
          "--token",
          "secret-value",
        ]),
      );
      expect(result.exitCode).toBe(0);
      recorder.record("workflow:event", {
        type: "log",
        phase: "Ground",
        message: "Located current Scene: chat.detail",
      });
      recorder.record("workflow:event", {
        type: "workflow:phase:end",
        phase: "Ground",
        durationMs: 1234,
      });
      const shared = { value: "reused" };
      recorder.record("workflow:result", { left: shared, right: shared });
      recorder.record("workflow:event", {
        type: "log",
        phase: "Plan Route",
        message: "Plan: matched_task · navigation 2 · executable steps 3",
      });
      const artifacts = await recorder.finalizeSuccess({ ok: true });
      const entries = await readEntries(artifacts.tracePath);
      expect(entries.map((entry) => entry.kind)).toContain("command:start");
      expect(entries.map((entry) => entry.kind)).toContain("command:end");
      const contents = await readFile(artifacts.tracePath, "utf8");
      expect(contents).toContain("hello");
      expect(contents).toContain("warning");
      expect(contents).not.toContain("secret-value");
      expect(contents).not.toContain("secret-input");
      expect(contents).toContain("[REDACTED]");
      const html = await readFile(artifacts.htmlPath, "utf8");
      expect(html).toContain("简洁视图");
      expect(html).toContain("完整视图");
      expect(html).toContain("命令完成");
      expect(html).toContain("定位当前页面");
      expect(html).toContain("规划路径");
      const logTitle = extractLogTitle(html);
      expect(
        logTitle("Plan: matched_task · navigation 2 · executable steps 3"),
      ).toBe("执行计划：来源 已验证任务；导航 2 步；操作 3 步");
      expect(
        logTitle("Matched Task: runtime.task.example (confidence: 1.00)"),
      ).toBe("命中任务：runtime.task.example（置信度 1.00）");
      expect(html).toContain(".status-pill{background:#065f46}");
      expect(html).toContain("原始数据");
      expectInlineScriptsToParse(html);
      const renderedText = renderTraceText(html);
      expect(renderedText).toContain("本次未使用 Agent");
      expect(renderedText).toContain("确定性执行，未使用 Agent");
      expect(renderedText).toContain("命令结果：");
      expect(renderedText).toContain("Located current Scene: chat.detail");
      expect(renderedText).toContain("状态：成功");
      expect(renderedText).toContain("完整结果：");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures Agent prompt, schema, response, and failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "deer-trace-agent-"));
    const recorder = new TraceRecorder("trace-agent-test.ts", {
      rootDirectory: root,
    });
    const runtime: Agent = {
      async run<TOutput>(prompt: string): Promise<TOutput> {
        if (prompt === "fail") throw new Error("agent failed");
        return { ok: true, prompt } as TOutput;
      },
    };
    const tracedAgent = bindAgent(runtime);
    try {
      await recorder.initialize({});
      recorder.record("workflow:event", {
        type: "workflow:phase:start",
        phase: "Discover",
      });
      await runWithTraceRecorder(recorder, async () => {
        expect(
          await tracedAgent<{ ok: boolean; prompt: string }>("inspect", {
            model: "test-model",
            cwd: root,
            sandbox: "read-only",
            schema: { type: "object" },
          }),
        ).toEqual({ ok: true, prompt: "inspect" });
        await expect(tracedAgent("fail")).rejects.toThrow("agent failed");
      });
      recorder.record("workflow:event", {
        type: "workflow:phase:end",
        phase: "Discover",
        durationMs: 321,
      });
      const shared = { value: "reused" };
      recorder.record("workflow:result", { left: shared, right: shared });
      const artifacts = await recorder.finalizeSuccess({ ok: true });
      const entries = await readEntries(artifacts.tracePath);
      const starts = entries.filter((entry) => entry.kind === "agent:start");
      const ends = entries.filter((entry) => entry.kind === "agent:end");
      expect(starts).toHaveLength(2);
      expect(ends).toHaveLength(2);
      expect(starts[0]?.payload).toMatchObject({
        prompt: "inspect",
        model: "test-model",
        sandbox: "read-only",
        schema: { type: "object" },
      });
      expect(ends[0]?.payload).toMatchObject({
        response: { ok: true, prompt: "inspect" },
      });
      expect(ends[1]?.payload).toMatchObject({
        error: { message: "agent failed" },
      });
      const html = await readFile(artifacts.htmlPath, "utf8");
      expect(html).toContain("Agent 请求");
      expect(html).toContain("Agent 回复");
      expectInlineScriptsToParse(html);
      const renderedText = renderTraceText(html);
      expect(renderedText).toContain("本次使用了 Agent：共 2 次");
      expect(renderedText).toContain("发生在「目标驱动探索」阶段");
      expect(renderedText).toContain("执行方式：使用 Agent（2 次）");
      expect(renderedText).toContain("Agent 结果：");
      expect(renderedText).toContain("所属阶段：目标驱动探索");
      const latest = await readEntries(artifacts.tracePath);
      expect(
        latest.find(
          (entry) =>
            entry.kind === "workflow:result" &&
            typeof entry.payload === "object" &&
            entry.payload !== null &&
            "left" in entry.payload,
        )?.payload,
      ).toEqual({
        left: { value: "reused" },
        right: { value: "reused" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function readEntries(path: string): Promise<TraceEntry[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceEntry);
}

function expectInlineScriptsToParse(html: string): void {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((match) => !match[1]?.includes("application/json"))
    .map((match) => match[2])
    .filter((source): source is string => Boolean(source?.trim()));
  expect(scripts.length).toBeGreaterThan(0);
  for (const source of scripts) {
    expect(() => new Function(source)).not.toThrow();
  }
}

function renderTraceText(html: string): string {
  interface TestNode {
    textContent: string;
    innerHTML: string;
    className: string;
    dataset: Record<string, string>;
    children: TestNode[];
    append: (...children: TestNode[]) => void;
    appendChild: (child: TestNode) => void;
    replaceChildren: (...children: TestNode[]) => void;
    onclick?: () => void;
    open?: boolean;
  }
  const createNode = (textContent = ""): TestNode => {
    const node: TestNode = {
      textContent,
      innerHTML: "",
      className: "",
      dataset: {},
      children: [],
      append: (...children) => node.children.push(...children),
      appendChild: (child) => void node.children.push(child),
      replaceChildren: (...children) => {
        node.children = children;
      },
    };
    return node;
  };
  const nodes = new Map<string, TestNode>();
  for (const id of [
    "trace-data",
    "summary-data",
    "entries",
    "filters",
    "view-toggle",
    "toolbar-note",
    "summary-grid",
    "summary-raw",
    "agent-usage",
  ]) {
    nodes.set(id, createNode());
  }
  for (const id of ["trace-data", "summary-data"]) {
    const match = html.match(
      new RegExp(
        `<script type="application/json" id="${id}">([\\s\\S]*?)<\\/script>`,
      ),
    );
    if (!match?.[1]) throw new Error(`Trace HTML ${id} is missing`);
    nodes.get(id)!.textContent = match[1];
  }
  const script = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((match) => !match[1]?.includes("application/json"))
    .map((match) => match[2])
    .find((source) => source?.includes("renderSummary();render();"));
  if (!script) throw new Error("Trace HTML runtime is missing");
  const document = {
    getElementById(id: string): TestNode {
      const node = nodes.get(id);
      if (!node) throw new Error(`Unexpected test element: ${id}`);
      return node;
    },
    createElement(): TestNode {
      return createNode();
    },
  };
  new Function("document", script)(document);
  const flatten = (node: TestNode): string =>
    [
      node.textContent,
      node.innerHTML.replace(/<[^>]+>/g, ""),
      ...node.children.map((child) => flatten(child)),
    ].join("\n");
  return ["summary-grid", "agent-usage", "entries"]
    .map((id) => flatten(nodes.get(id)!))
    .join("\n");
}

function extractLogTitle(html: string): (message: string) => string {
  const script = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((match) => !match[1]?.includes("application/json"))
    .map((match) => match[2])
    .find((source) => source?.includes("function logTitle"));
  const functions = script?.match(
    /function planSource[\s\S]*?(?=function workflowInfo)/,
  )?.[0];
  if (!functions) throw new Error("Trace HTML log formatter is missing");
  return new Function(`${functions}; return logTitle;`)() as (
    message: string,
  ) => string;
}
