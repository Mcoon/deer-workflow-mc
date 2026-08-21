import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import graphJson from "../../examples/ios-ui-graph-experiment/graph-chat-full.json";
import {
  externalizeInteractiveScript,
  renderExecutableUiGraphHtml,
} from "../../examples/ios-ui-semantic-map-report/workflow";

import type { ExecutableUiGraphExperiment } from "../../examples/ios-ui-graph-experiment/types";

const graph = graphJson as unknown as ExecutableUiGraphExperiment;

describe("iOS UI Semantic Map Report", () => {
  test("renders executable graph entities, tasks, and safe interactive script", () => {
    const html = renderExecutableUiGraphHtml(graph, "Test Semantic Map");

    expect(html).toContain("Test Semantic Map");
    expect(html).toContain(
      `${graph.scenes.length} Scenes · ${graph.elements.length} Elements · ${graph.scenes.reduce((total, scene) => total + (scene.stateVariants?.length ?? 0), 0)} States · ${graph.operators.length} Operators · ${graph.tasks.length} Tasks`,
    );
    expect(html).toContain('id="executable-graph-data"');
    expect(html).toContain("Executable Tasks");
    expect(html).toContain("photo.capture_and_ask");
    expect(html).toContain("chat.scroll_to_older_messages");
    expect(html).toContain("camera.permission");
    expect(html).toContain("Reference Screenshot");
    expect(html).toContain("State Variants");
    expect(html).toContain("composer.mode=voice");
    expect(html).toContain("Preconditions");
    expect(html).toContain("Agent Verifier");
    expect(html).toContain("cloud-drive-content-visible");
    expect(html).toContain("selectTask(task.taskId)");
    expect(html).toContain("selectOperator(op.operatorId)");
    expect(html).toContain("搜索 Scene / Element / Operator / Task");
    expect(html).toContain(`Elements · ${graph.elements.length}`);
    expect(html).toContain(
      `States · ${graph.scenes.reduce((total, scene) => total + (scene.stateVariants?.length ?? 0), 0)}`,
    );
    expect(html).toContain(`Operators · ${graph.operators.length}`);
    expect(html).toContain("Chat &amp; Messaging");
    expect(html).toContain("Bot Settings");
    expect(html).toContain("Photos &amp; Files");
    expect(html).toContain("Cloud Drive");

    const noScriptHtml = html.replace(
      /<script(?: [^>]*)?>[\s\S]*?<\/script>/g,
      "",
    );
    expect(
      Array.from(noScriptHtml.matchAll(/class="task-card"/g)),
    ).toHaveLength(graph.tasks.length);
    expect(
      Array.from(noScriptHtml.matchAll(/class="zoom-toggle"/g)),
    ).toHaveLength(5);
    expect(
      Array.from(noScriptHtml.matchAll(/class="node scene verified"/g)),
    ).toHaveLength(
      graph.scenes.filter((scene) => scene.status === "verified").length,
    );
    expect(Array.from(noScriptHtml.matchAll(/class="edge /g))).toHaveLength(
      graph.operators.length,
    );
    expect(
      Array.from(noScriptHtml.matchAll(/class="entity-row element-row"/g)),
    ).toHaveLength(graph.elements.length);
    expect(
      Array.from(noScriptHtml.matchAll(/class="entity-row state-row"/g)),
    ).toHaveLength(
      graph.scenes.reduce(
        (total, scene) => total + (scene.stateVariants?.length ?? 0),
        0,
      ),
    );
    expect(
      Array.from(noScriptHtml.matchAll(/class="entity-row operator-row /g)),
    ).toHaveLength(graph.operators.length);
    expect(Array.from(noScriptHtml.matchAll(/id="detail-task-/g))).toHaveLength(
      graph.tasks.length,
    );
    expect(
      Array.from(noScriptHtml.matchAll(/id="detail-scene-/g)),
    ).toHaveLength(graph.scenes.length);
    expect(
      Array.from(noScriptHtml.matchAll(/id="detail-operator-/g)),
    ).toHaveLength(graph.operators.length);
    expect(
      Array.from(noScriptHtml.matchAll(/id="detail-element-/g)),
    ).toHaveLength(graph.elements.length);
    expect(
      Array.from(noScriptHtml.matchAll(/id="detail-state-/g)),
    ).toHaveLength(
      graph.scenes.reduce(
        (total, scene) => total + (scene.stateVariants?.length ?? 0),
        0,
      ),
    );
    expect(noScriptHtml).toContain('href="#detail-task-photo.capture_and_ask"');
    expect(noScriptHtml).toContain(
      'data-task-id="chat.enable_auto_read" data-task-path="4"',
    );
    expect(noScriptHtml).toContain(
      'id="detail-task-chat.enable_auto_read" data-task-target="4"',
    );
    expect(noScriptHtml).toContain(
      '.layout:has(.detail-card[data-task-target="4"]:target) #map .edge',
    );
    expect(noScriptHtml).toMatch(
      /class="edge interaction" data-task-paths="4"[^>]*><title>chat\.enable_auto_read<\/title>/,
    );
    const chatDetailTaskPaths = graph.tasks
      .map((task, index) =>
        task.entrySceneId === "chat.detail" ||
        task.operatorIds.some((operatorId) => {
          const operator = graph.operators.find(
            (candidate) => candidate.operatorId === operatorId,
          );
          return (
            operator?.fromSceneId === "chat.detail" ||
            operator?.toSceneId === "chat.detail"
          );
        })
          ? index
          : null,
      )
      .filter((index): index is number => index !== null)
      .join(" ");
    expect(noScriptHtml).toMatch(
      new RegExp(
        `class="node scene verified" data-task-paths="${chatDetailTaskPaths}"[^>]*><rect[^>]*><\\/rect><text[^>]*>会话页<\\/text>`,
      ),
    );
    const botSettingsTaskPaths = graph.tasks
      .map((task, index) =>
        task.entrySceneId === "bot.settings" ||
        task.operatorIds.some((operatorId) => {
          const operator = graph.operators.find(
            (candidate) => candidate.operatorId === operatorId,
          );
          return (
            operator?.fromSceneId === "bot.settings" ||
            operator?.toSceneId === "bot.settings"
          );
        })
          ? index
          : null,
      )
      .filter((index): index is number => index !== null)
      .join(" ");
    expect(noScriptHtml).toMatch(
      new RegExp(
        `class="node scene verified" data-task-paths="${botSettingsTaskPaths}"[^>]*><rect[^>]*><\\/rect><text[^>]*>当前 Bot 设置页<\\/text>`,
      ),
    );
    expect(noScriptHtml).toContain('href="#detail-scene-camera.permission"');
    expect(noScriptHtml).toContain(
      'href="#detail-operator-chat.scroll_to_older_messages"',
    );
    expect(noScriptHtml).toContain("拍照发送并询问这是什么");
    expect(noScriptHtml).toContain("相机权限弹窗");
    expect(noScriptHtml).toContain("当前 Bot 设置页");

    const scripts = Array.from(
      html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g),
      (match) => match[1] ?? "",
    );
    expect(scripts).toHaveLength(2);
    expect(() => new Function(scripts.at(-1) ?? "")).not.toThrow();
  });

  test("escapes graph content before embedding", () => {
    const unsafeGraph: ExecutableUiGraphExperiment = {
      ...graph,
      appName: "<script>alert(1)</script>",
      scenes: [
        {
          ...graph.scenes[0]!,
          title: "<img src=x onerror=alert(1)>",
        },
      ],
    };
    const html = renderExecutableUiGraphHtml(unsafeGraph);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("\\u003cscript");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  test("externalizes the interactive runtime for CSP-restricted previews", () => {
    const rendered = externalizeInteractiveScript(
      renderExecutableUiGraphHtml(graph, "Live Map", undefined, {
        revision: "2026-08-16T01:55:55.273Z",
        summaryFileName: "semantic-map-summary.json",
      }),
    );

    expect(rendered.html).toContain(
      '<link rel="stylesheet" href="obsidian-map.css?v=2026-08-16T01%3A55%3A55.273Z">',
    );
    expect(rendered.html).toContain(
      '<script src="obsidian-map.js?v=2026-08-16T01%3A55%3A55.273Z" defer></script>',
    );
    expect(rendered.html).not.toContain(
      '<script src="semantic-map.js" defer></script>',
    );
    expect(rendered.html).not.toContain("const graph=JSON.parse");
    expect(rendered.script).toContain("const graph=JSON.parse");
    expect(rendered.html).toContain(
      'meta name="semantic-map-revision" content="2026-08-16T01:55:55.273Z"',
    );
    expect(rendered.script).toContain(
      'summaryFileName="semantic-map-summary.json"',
    );
    expect(rendered.script).toContain("setInterval(async");
    expect(rendered.script).toContain("location.reload()");
    expect(() => new Function(rendered.script)).not.toThrow();

    const noScriptHtml = rendered.html.replace(
      /<script(?: [^>]*)?>[\s\S]*?<\/script>/g,
      "",
    );
    expect(
      Array.from(noScriptHtml.matchAll(/class="task-card"/g)),
    ).toHaveLength(graph.tasks.length);
  });

  test("ships the Graph console context menu and Agent control bridge", async () => {
    const runtime = await readFile(
      join(
        import.meta.dir,
        "../../examples/ios-ui-semantic-map-report/obsidian-map.js",
      ),
      "utf8",
    );

    expect(runtime).toContain('id="og-context-menu"');
    expect(runtime).toContain('data-context-action="execute"');
    expect(runtime).toContain('data-context-action="explore"');
    expect(runtime).toContain('data-context-action="copy"');
    expect(runtime).toContain("复制唯一 ID");
    expect(runtime).toContain('id="og-console-form"');
    expect(runtime).toContain('id="og-console-input"');
    expect(runtime).toContain('fetchJson("/api/actions"');
    expect(runtime).toContain('fetchJson("/api/chat"');
    expect(runtime).toContain("/api/corrections/");
    expect(runtime).toContain("new EventSource(");
    expect(runtime).toContain('addEventListener("contextmenu"');
    expect(runtime).toContain("navigator.clipboard");
    expect(runtime).not.toContain("child_process");
    expect(runtime).not.toContain("Bun.spawn");
  });
});
