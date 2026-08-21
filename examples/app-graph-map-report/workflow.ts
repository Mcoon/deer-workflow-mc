import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import { loadGraph, resolveGraphAssetPath } from "../ios-ui-graph-manager";
import type {
  AppGraph,
  Scene,
  Operator,
  Task,
} from "../ios-ui-graph-manager/types";

export const meta = {
  name: "app-graph-map-report",
  description:
    "Render v2 App Graph as interactive Obsidian-style force-directed HTML map",
  phases: [{ title: "Load" }, { title: "Render" }, { title: "Output" }],
  exampleArgs: {
    graphPath:
      "../ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    htmlPath: "/tmp/ios_perf-opt/app-graph-map/map.html",
  },
};

interface MapReportInput {
  readonly graphPath: string;
  readonly htmlPath: string;
  readonly title?: string;
}

export default async function appGraphMapReport(args: MapReportInput) {
  const graphPath = resolve(args.graphPath);
  const htmlPath = resolve(args.htmlPath);
  const title = args.title ?? "App Graph v2";

  phase("Load");
  log(`Loading graph: ${graphPath}`);
  const graph = await loadGraph(graphPath);

  const scenes = Object.values(graph.scenes);
  const operators = Object.values(graph.operators);
  const tasks = Object.values(graph.tasks);
  const elements = Object.values(graph.scenes).flatMap((s) =>
    Object.values(s.elements),
  );

  log(
    `${scenes.length} scenes, ${elements.length} elements, ${operators.length} operators, ${tasks.length} tasks`,
  );

  phase("Render");
  const html = renderAppGraphMapHtml(
    graph,
    title,
    scenes,
    operators,
    tasks,
    elements,
    graphPath,
  );

  phase("Output");
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, html, "utf8");
  log(`Map written to ${htmlPath}`);

  return {
    success: true,
    htmlPath,
    sceneCount: scenes.length,
    elementCount: elements.length,
    operatorCount: operators.length,
    taskCount: tasks.length,
  };
}

export function renderAppGraphMapHtml(
  graph: AppGraph,
  title: string,
  scenes: Scene[],
  operators: Operator[],
  tasks: Task[],
  elements: {
    elementId: string;
    title: string;
    semanticRole: string;
    status: string;
  }[],
  graphPath?: string,
): string {
  const renderedGraph = graphPath
    ? {
        ...graph,
        scenes: Object.fromEntries(
          Object.entries(graph.scenes).map(([sceneId, scene]) => [
            sceneId,
            {
              ...scene,
              referenceAssets: scene.referenceAssets.map((asset) => ({
                screenshot: resolveGraphAssetPath(graphPath, asset.screenshot),
                uiDump: resolveGraphAssetPath(graphPath, asset.uiDump),
                ...(asset.ocr
                  ? { ocr: resolveGraphAssetPath(graphPath, asset.ocr) }
                  : {}),
              })),
            },
          ]),
        ),
      }
    : graph;
  const graphJson = JSON.stringify(renderedGraph).replace(/</g, "\\u003c");

  const taskList = tasks
    .map((t) => {
      const st = t.status;
      return `<button class="task-card" data-task-id="${esc(t.taskId)}" data-entry="${esc(t.entrySceneId)}" data-steps="${esc(JSON.stringify(t.steps.map((s) => s.operatorId)))}">
      <div class="task-title">${esc(t.intents?.[0] ?? t.taskId)}</div>
      <div class="task-id">${esc(t.taskId)}</div>
      <div class="task-meta">${t.steps.length} steps · <span class="pill ${st}">${st}</span></div>
    </button>`;
    })
    .join("");

  const sceneList = scenes
    .map((s) => `<option value="${esc(s.sceneId)}">${esc(s.title)}</option>`)
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(graph.appName ?? graph.bundleId)}</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e2e8f0;background:#0f172a}
*{box-sizing:border-box;margin:0;padding:0}
body{overflow:hidden;height:100vh}
.app{height:100vh;display:grid;grid-template-rows:48px 1fr}
header{display:flex;align-items:center;gap:12px;padding:0 14px;background:#1e293b;border-bottom:1px solid #334155;z-index:10}
h1{font-size:14px;margin:0;white-space:nowrap;color:#f1f5f9}
.meta{color:#94a3b8;font-size:10px;white-space:nowrap}
.toolbar{margin-left:auto;display:flex;align-items:center;gap:6px}
.toolbar input{width:200px;height:30px;border:1px solid #475569;border-radius:6px;padding:0 10px;font-size:11px;background:#1e293b;color:#e2e8f0}
.toolbar select{height:30px;border:1px solid #475569;border-radius:6px;padding:0 8px;font-size:11px;background:#1e293b;color:#e2e8f0}
.toolbar .device-select{max-width:280px;border-color:#0f766e}
.toolbar button{height:30px;padding:0 10px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;border-radius:6px;cursor:pointer;font-size:11px}
.toolbar button:hover{background:#334155}
.toolbar button.active{background:#2563eb;border-color:#2563eb}
.toolbar button.graph-refresh{display:none;border-color:#d97706;color:#fde68a;background:#78350f}.toolbar button.graph-refresh.visible{display:block}
.agent-toggle{border-color:#6366f1!important;color:#c4b5fd!important}
.layout{display:grid;grid-template-columns:260px minmax(0,1fr) 340px;min-height:0}
.sidebar{background:#1e293b;overflow:auto;padding:12px;border-right:1px solid #334155}
.sidebar h2{font-size:13px;margin:0 0 10px;color:#cbd5e1}
.task-card{width:100%;padding:8px;text-align:left;margin:0 0 5px;display:block;border:1px solid #334155;background:#0f172a;border-radius:6px;cursor:pointer;color:#e2e8f0;font-family:inherit;transition:all .15s}
.task-card:hover{border-color:#60a5fa;background:#1e3a5f}
.task-card.selected{border-color:#2563eb;background:#1e3a5f;box-shadow:0 0 0 2px #2563eb40}
.task-title{font-size:12px;font-weight:650}.task-id{font:9px ui-monospace,SFMono-Regular,Menlo,monospace;color:#94a3b8;margin-top:2px}.task-meta{font-size:9px;color:#94a3b8;margin-top:3px}
.details{background:#1e293b;overflow:auto;padding:14px;border-left:1px solid #334155}
.details h2{font-size:14px;margin:0 0 10px;color:#cbd5e1}
.graph-container{position:relative;overflow:hidden;background:radial-gradient(ellipse at center,#1e293b 0%,#0f172a 70%)}
.graph-container svg{width:100%;height:100%}
.graph-container canvas{position:absolute;top:0;left:0;pointer-events:none}
.graph-hint{position:absolute;right:12px;top:10px;z-index:3;background:#1e293bdd;border:1px solid #475569;border-radius:6px;padding:5px 8px;font-size:10px;color:#94a3b8}
.graph-legend{position:absolute;left:12px;bottom:12px;z-index:3;display:flex;gap:10px;font-size:10px;color:#94a3b8}
.legend-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px}
.legend-dot.nav{background:#60a5fa}.legend-dot.interact{background:#34d399}.legend-dot.select{background:#a78bfa}.legend-dot.mutate{background:#f87171}.legend-dot.permit{background:#fbbf24}
.node circle{stroke-width:2;cursor:pointer;transition:stroke-width .15s,stroke .15s}
.node circle.scene-verified{fill:#065f46;stroke:#34d399}
.node circle.scene-candidate{fill:#78350f;stroke:#fbbf24}
.node circle.scene-observed{fill:#1e3a5f;stroke:#60a5fa}
.node circle.scene-stale{fill:#7f1d1d;stroke:#f87171}
.node circle.scene-blocked{fill:#334155;stroke:#64748b}
.node circle.scene-disabled{fill:#1e293b;stroke:#475569}
.node text{font-size:10px;fill:#cbd5e1;pointer-events:none;text-anchor:middle}
.node text.sub{font-size:8px;fill:#64748b}
.node:hover circle{stroke-width:3.5}
.node.selected circle{stroke:#e2e8f0;stroke-width:3.5;filter:drop-shadow(0 0 6px #60a5fa)}
.node.dimmed{opacity:.12}
.node.highlighted circle{stroke:#a78bfa;stroke-width:3.5;filter:drop-shadow(0 0 6px #a78bfa)}
.link{stroke:#475569;stroke-width:1;stroke-opacity:.6;fill:none;cursor:pointer}
.link:hover{stroke:#60a5fa;stroke-width:2}
.link.dimmed{opacity:.05}
.link.highlighted{stroke:#a78bfa;stroke-width:2.5;stroke-opacity:1;filter:drop-shadow(0 0 3px #a78bfa)}
.link.navigation{stroke:#60a5fa}.link.interaction{stroke:#34d399}.link.selection{stroke:#a78bfa}.link.mutation,.link.destructive{stroke:#f87171}.link.permission{stroke:#fbbf24}
.link-label{font-size:7px;fill:#94a3b8;pointer-events:none;text-anchor:middle}
.pill{display:inline-block;padding:2px 6px;border-radius:999px;font-size:9px;font-weight:650}
.pill.verified{background:#065f46;color:#6ee7b7}.pill.candidate{background:#78350f;color:#fcd34d}.pill.observed{background:#1e3a5f;color:#93c5fd}.pill.stale{background:#7f1d1d;color:#fca5a5}.pill.blocked,.pill.disabled{background:#334155;color:#94a3b8}
.kv{display:grid;grid-template-columns:90px 1fr;gap:5px;font-size:11px;margin:8px 0}.kv b{color:#94a3b8}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;word-break:break-all}
.preview{display:block;width:100%;max-height:260px;object-fit:contain;background:#0f172a;border:1px solid #334155;border-radius:6px;margin-top:8px}
.muted{color:#64748b;font-size:11px}
.empty-state{text-align:center;padding:30px;color:#475569;font-size:12px}
.anchor-tag{font-size:9px;padding:2px 6px;background:#1e3a5f;color:#93c5fd;border-radius:4px;border:1px solid #1e40af;margin:2px;display:inline-block}
.console-actions{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.console-actions button{border:1px solid #475569;background:#0f172a;color:#e2e8f0;border-radius:6px;padding:6px 9px;font-size:10px;cursor:pointer}.console-actions button:hover{background:#334155}.console-actions button.danger{border-color:#ef4444;color:#fca5a5}.console-status{font-size:10px;line-height:1.45;padding:8px;border:1px solid #334155;background:#0f172a;border-radius:6px;white-space:pre-wrap;word-break:break-word}.console-status.ok{border-color:#059669}.console-status.error{border-color:#dc2626}
.context-menu{position:fixed;z-index:80;display:none;width:250px;padding:7px;background:#111827;border:1px solid #475569;border-radius:9px;box-shadow:0 16px 45px #020617aa}.context-menu.open{display:block}.context-title{padding:5px 8px 8px;color:#94a3b8;font:9px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}.context-menu button{width:100%;display:block;padding:8px;border:0;border-radius:6px;background:transparent;color:#e2e8f0;text-align:left;font-size:11px;cursor:pointer}.context-menu button:hover{background:#334155}.context-subtitle{padding:8px;color:#94a3b8;font-size:9px;border-top:1px solid #334155}.context-submenu{max-height:260px;overflow:auto}.context-submenu button small{display:block;color:#64748b;font:8px ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:2px}
.agent-panel{position:fixed;z-index:70;right:16px;bottom:16px;width:min(440px,calc(100vw - 32px));height:min(620px,calc(100vh - 80px));display:none;grid-template-rows:auto auto 1fr auto auto;background:#111827;border:1px solid #475569;border-radius:12px;box-shadow:0 20px 70px #020617cc;overflow:hidden}.agent-panel.open{display:grid}.agent-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#1e293b;border-bottom:1px solid #334155}.agent-header strong{font-size:12px}.agent-service{font-size:9px;color:#94a3b8;margin-left:8px}.agent-service.connected{color:#6ee7b7}.agent-service.offline{color:#fca5a5}.agent-close{border:0;background:transparent;color:#94a3b8;font-size:18px;cursor:pointer}.agent-context{padding:8px 12px;background:#0f172a;color:#93c5fd;font:9px ui-monospace,SFMono-Regular,Menlo,monospace;border-bottom:1px solid #334155;word-break:break-all}.agent-messages{overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}.agent-message{padding:8px 9px;border-radius:8px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word}.agent-message.system{background:#1e293b;color:#94a3b8}.agent-message.user{align-self:flex-end;max-width:88%;background:#1d4ed8;color:#eff6ff}.agent-message.agent{background:#312e81;color:#e0e7ff}.agent-message.error{background:#7f1d1d;color:#fecaca}.agent-message button,.proposal button{margin-top:7px;border:1px solid #6366f1;background:#1e1b4b;color:#e0e7ff;border-radius:6px;padding:6px 8px;cursor:pointer}.run-log{max-height:130px;overflow:auto;border-top:1px solid #334155;padding:7px 10px;background:#0f172a}.run-event{display:flex;justify-content:space-between;gap:8px;font-size:9px;color:#cbd5e1;padding:3px 0}.run-event small{color:#64748b}.agent-form{display:grid;grid-template-columns:1fr auto;gap:8px;padding:10px;border-top:1px solid #334155;background:#1e293b}.agent-form textarea{resize:none;border:1px solid #475569;border-radius:7px;background:#0f172a;color:#e2e8f0;padding:8px;font:11px inherit}.agent-form>button{border:1px solid #6366f1;background:#4f46e5;color:white;border-radius:7px;padding:0 12px;cursor:pointer}.agent-form.busy{opacity:.65}.proposal{margin-top:7px;padding:8px;border:1px solid #6366f1;border-radius:7px}.proposal ul{padding-left:16px;margin-top:5px}
.element-choice-list{display:flex;flex-direction:column;gap:5px;max-height:240px;overflow:auto;margin-top:8px}.element-choice-list button{margin-top:0;text-align:left}.element-choice-list small{display:block;color:#94a3b8;font:8px ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:2px}.element-choice-list .recapture{border-color:#0f766e;background:#064e3b;color:#d1fae5}
.agent-message.thinking{background:#1e293b;color:#cbd5e1}.thinking-dots::after{content:"";display:inline-block;width:1.2em;text-align:left;animation:thinking-dots 1.2s steps(4,end) infinite}@keyframes thinking-dots{0%{content:""}25%{content:"."}50%{content:".."}75%,100%{content:"..."}}
table{width:100%;border-collapse:collapse;font-size:10px;background:#0f172a;border-radius:6px;overflow:hidden;border:1px solid #334155}
th{text-align:left;padding:6px 8px;background:#1e293b;color:#94a3b8;font-weight:650;font-size:9px;text-transform:uppercase;letter-spacing:.5px}
td{padding:5px 8px;border-top:1px solid #1e293b}tr:hover{background:#1e293b}
</style>
</head>
<body>
<div class="app">
<header>
  <h1>${esc(title)}</h1>
  <span class="meta" data-graph-version="v2">Graph v2 · ${esc(graph.graphId)} · r${graph.revision}</span>
  <span class="meta">${scenes.length} Scenes · ${elements.length} Elements · ${operators.length} Operators · ${tasks.length} Tasks</span>
  <div class="toolbar">
    <select id="device-select" class="device-select" title="执行设备"><option value="">正在扫描设备…</option></select>
    <button id="device-refresh" title="刷新设备列表">刷新设备</button>
    <button id="graph-refresh" class="graph-refresh" title="Graph 已更新，手动刷新页面">Graph 已更新 · 刷新</button>
    <select id="scene-filter"><option value="">All Scenes</option>${sceneList}</select>
    <input id="search" placeholder="Search...">
    <button id="agent-toggle" class="agent-toggle">Agent</button>
    <button id="center-root">Center</button>
    <button id="clear">Clear</button>
  </div>
</header>
<div class="layout">
  <aside class="sidebar">
    <h2>Tasks (${tasks.length})</h2>
    <div id="task-list">${taskList || '<div class="empty-state">No tasks</div>'}</div>
  </aside>
  <main class="graph-container" id="graph-container">
    <svg id="graph"></svg>
    <div class="graph-hint">Scroll to zoom · Drag to pan · Click node to select</div>
    <div class="graph-legend">
      <span><span class="legend-dot nav"></span>navigation</span>
      <span><span class="legend-dot interact"></span>interaction</span>
      <span><span class="legend-dot select"></span>selection</span>
      <span><span class="legend-dot mutate"></span>mutation</span>
      <span><span class="legend-dot permit"></span>permission</span>
    </div>
  </main>
  <aside class="details" id="details">
    <h2>Overview</h2>
    <div class="kv"><b>Graph ID</b><span class="mono">${esc(graph.graphId)}</span><b>Bundle</b><span class="mono">${esc(graph.bundleId)}</span><b>Version</b><span>${esc(graph.appVersion ?? "unknown")}</span><b>Revision</b><span>${graph.revision}</span><b>Scenes</b><span>${scenes.length}</span><b>Elements</b><span>${elements.length}</span><b>Operators</b><span>${operators.length}</span><b>Tasks</b><span>${tasks.length}</span></div>
    <div class="muted" style="margin-top:10px">Click a node or task to see details.</div>
  </aside>
</div>
</div>
<div class="context-menu" id="context-menu" role="menu">
  <div class="context-title" id="context-title"></div>
  <button type="button" data-context-action="execute">执行到这里</button>
  <button type="button" data-context-action="explore">基于这里继续探索</button>
  <button type="button" data-context-action="copy">复制 ID</button>
  <div class="context-submenu" id="context-submenu"></div>
</div>
<section class="agent-panel" id="agent-panel">
  <header class="agent-header"><div><strong>Graph Agent</strong><span class="agent-service" id="agent-service">连接中</span></div><button class="agent-close" id="agent-close" type="button" aria-label="关闭 Agent">×</button></header>
  <div class="agent-context" id="agent-context">未选择节点</div>
  <div class="agent-messages" id="agent-messages"><div class="agent-message system">可询问 Graph、执行到节点、定向探索，或提交纠错建议。</div></div>
  <div class="run-log" id="run-log"></div>
  <form class="agent-form" id="agent-form"><textarea id="agent-input" rows="2" placeholder="例如：从这个页面怎么打开云盘？"></textarea><button type="submit">发送</button></form>
</section>
<script type="application/json" id="graph-data">${graphJson}</script>
<script>
(function() {
  const graph = JSON.parse(document.getElementById("graph-data").textContent);
  const sceneMap = graph.scenes || {};
  const operatorMap = graph.operators || {};
  const taskMap = graph.tasks || {};

  const container = document.getElementById("graph-container");
  const svg = d3.select("#graph");
  const details = document.getElementById("details");
  const taskList = document.getElementById("task-list");
  const search = document.getElementById("search");
  const sceneFilter = document.getElementById("scene-filter");
  const deviceSelect = document.getElementById("device-select");
  const graphRefresh = document.getElementById("graph-refresh");
  const contextMenu = document.getElementById("context-menu");
  const contextTitle = document.getElementById("context-title");
  const contextSubmenu = document.getElementById("context-submenu");
  const agentPanel = document.getElementById("agent-panel");
  const agentService = document.getElementById("agent-service");
  const agentContext = document.getElementById("agent-context");
  const agentMessages = document.getElementById("agent-messages");
  const runLog = document.getElementById("run-log");
  const agentForm = document.getElementById("agent-form");
  const agentInput = document.getElementById("agent-input");
  let selectedTarget = null;
  let graphRevision = "";
  let loadedGraphRevision = graph.revision;
  let consoleAvailable = false;
  let selectedUdid = "";
  let graphStale = false;
  let contextTarget = null;
  let restoringAgentSession = false;
  const agentSessionKey = "ios-ui-graph-console.agent-session." + graph.graphId;

  const width = container.clientWidth;
  const height = container.clientHeight;

  svg.attr("viewBox", [0, 0, width, height]);

  const g = svg.append("g");

  // Build graph data
  const sceneIds = Object.keys(sceneMap);
  const nodes = sceneIds.map(id => {
    const s = sceneMap[id];
    const elCount = Object.keys(s.elements || {}).length;
    const opsOut = Object.values(operatorMap).filter(o => o.fromSceneId === id).length;
    const opsIn = Object.values(operatorMap).filter(o => o.toSceneId === id).length;
    return {
      id,
      title: s.title || id,
      status: s.status || "observed",
      elementCount: elCount,
      outCount: opsOut,
      inCount: opsIn,
      anchors: s.visualTextAnchors || [],
      parentSceneId: s.parentSceneId,
      radius: 8 + Math.min(elCount * 2, 30) + Math.min((opsOut + opsIn) * 2, 20),
      x: width / 2 + (Math.random() - 0.5) * 200,
      y: height / 2 + (Math.random() - 0.5) * 200,
    };
  });

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const elementEntries = new Map();
  for (const scene of Object.values(sceneMap)) {
    for (const element of Object.values(scene.elements || {})) {
      elementEntries.set(element.elementId, { scene, element });
    }
  }

  function entityTitle(target) {
    if (target.kind === "scene") return sceneMap[target.id]?.title || target.id;
    if (target.kind === "element") return elementEntries.get(target.id)?.element?.title || target.id;
    if (target.kind === "operator") return operatorMap[target.id]?.operatorId || target.id;
    return taskMap[target.id]?.intents?.[0] || target.id;
  }

  function typedId(target) { return target.kind + ":" + target.id; }

  function sceneForTarget(target) {
    if (target.kind === "scene") return sceneMap[target.id] ? target.id : null;
    if (target.kind === "element") return elementEntries.get(target.id)?.scene?.sceneId || null;
    if (target.kind === "operator") {
      const op = operatorMap[target.id];
      return op?.toSceneId || op?.fromSceneId || null;
    }
    const task = taskMap[target.id];
    const finalOp = task?.steps?.length ? operatorMap[task.steps.at(-1).operatorId] : null;
    return finalOp?.toSceneId || finalOp?.fromSceneId || task?.entrySceneId || null;
  }

  function operatorsForElement(elementId) {
    const entry = elementEntries.get(elementId);
    return Object.values(operatorMap).filter(op =>
      op.fromSceneId === entry?.scene?.sceneId && op.operation?.elementId === elementId
    );
  }

  function elementsForScene(sceneId) {
    return Object.values(sceneMap[sceneId]?.elements || {}).filter(element =>
      !["stale", "blocked", "disabled"].includes(element.status)
    );
  }

  const links = [];
  for (const op of Object.values(operatorMap)) {
    if (!nodeById.has(op.fromSceneId)) continue;
    const target = op.toSceneId || op.fromSceneId;
    if (!nodeById.has(target)) continue;
    const risk = op.risk || "navigation";
    links.push({
      source: op.fromSceneId,
      target,
      operatorId: op.operatorId,
      type: op.operation.type,
      risk,
      status: op.status,
    });
  }

  // Deduplicate links
  const linkMap = new Map();
  for (const l of links) {
    const key = l.source + "->" + l.target;
    if (!linkMap.has(key)) linkMap.set(key, l);
  }
  const uniqueLinks = [...linkMap.values()];

  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(uniqueLinks).id(d => d.id).distance(120))
    .force("charge", d3.forceManyBody().strength(-300))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius(d => d.radius + 5))
    .on("tick", ticked);

  const link = g.append("g")
    .selectAll("line")
    .data(uniqueLinks)
    .join("line")
    .attr("class", d => "link " + (d.risk || "navigation"))
    .attr("data-operator-id", d => d.operatorId);

  const node = g.append("g")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", d => "node scene-" + d.status)
    .attr("data-scene-id", d => d.id)
    .call(d3.drag()
      .on("start", dragstarted)
      .on("drag", dragged)
      .on("end", dragended));

  node.append("circle")
    .attr("r", d => d.radius)
    .attr("class", d => "scene-" + d.status);

  node.append("text")
    .attr("dy", d => -d.radius - 4)
    .text(d => d.title.length > 20 ? d.title.substring(0, 18) + "..." : d.title);

  node.append("text")
    .attr("class", "sub")
    .attr("dy", d => -d.radius + 12)
    .text(d => d.elementCount + " el · " + d.outCount + " out");

  node.on("click", (event, d) => {
    event.stopPropagation();
    selectScene(d.id);
  });

  node.on("contextmenu", (event, d) => {
    openContextMenu(event, { kind: "scene", id: d.id });
  });

  link.on("click", (event, d) => {
    event.stopPropagation();
    selectOperator(d.operatorId);
  });

  link.on("contextmenu", (event, d) => {
    openContextMenu(event, { kind: "operator", id: d.operatorId });
  });

  svg.on("click", () => clearSelection());

  // Zoom
  const zoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .on("zoom", (event) => { g.attr("transform", event.transform); });
  svg.call(zoom);

  function ticked() {
    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);
    node.attr("transform", d => "translate(" + d.x + "," + d.y + ")");
  }

  function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }

  function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  function esc(s) { return String(s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function pill(s) { return '<span class="pill '+s+'">'+esc(s)+'</span>'; }
  function openAgent() { agentPanel.classList.add("open"); agentInput.focus(); persistAgentSession(); }
  function closeAgent() { agentPanel.classList.remove("open"); persistAgentSession(); }
  function updateAgentContext() {
    agentContext.textContent = selectedTarget
      ? entityTitle(selectedTarget) + " · " + typedId(selectedTarget)
      : "未选择节点";
    persistAgentSession();
  }
  function appendAgentMessage(kind, text, content) {
    const message = document.createElement("div");
    message.className = "agent-message " + kind;
    if (text) { const body = document.createElement("div"); body.textContent = text; message.appendChild(body); }
    if (content) message.appendChild(content);
    agentMessages.appendChild(message);
    agentMessages.scrollTop = agentMessages.scrollHeight;
    if (kind !== "thinking") persistAgentSession();
    return message;
  }
  function appendThinkingMessage() {
    const message = appendAgentMessage("thinking", "");
    const body = document.createElement("span");
    body.className = "thinking-dots";
    body.textContent = "思考中";
    message.appendChild(body);
    return message;
  }
  function replaceAgentMessage(message, kind, text, content) {
    message.className = "agent-message " + kind;
    message.replaceChildren();
    if (text) { const body = document.createElement("div"); body.textContent = text; message.appendChild(body); }
    if (content) message.appendChild(content);
    agentMessages.scrollTop = agentMessages.scrollHeight;
    persistAgentSession();
    return message;
  }
  function persistAgentSession() {
    if (restoringAgentSession) return;
    try {
      const messages = [...agentMessages.querySelectorAll(".agent-message")]
        .filter(message => !message.classList.contains("thinking"))
        .slice(-50)
        .map(message => ({
          kind: ["system", "user", "agent", "error"].find(kind => message.classList.contains(kind)) || "system",
          text: message.textContent || "",
        }));
      sessionStorage.setItem(agentSessionKey, JSON.stringify({
        selectedTarget,
        messages,
        open: agentPanel.classList.contains("open"),
      }));
    } catch {}
  }
  function restoreAgentSession() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(agentSessionKey) || "null");
      if (!saved || typeof saved !== "object") return;
      restoringAgentSession = true;
      agentMessages.replaceChildren();
      for (const message of Array.isArray(saved.messages) ? saved.messages : []) {
        if (message && typeof message.text === "string") {
          appendAgentMessage(message.kind || "system", message.text);
        }
      }
      if (saved.selectedTarget && typeof saved.selectedTarget.id === "string") {
        try { selectTarget(saved.selectedTarget); } catch {}
      }
      if (saved.open) agentPanel.classList.add("open");
    } catch {
      sessionStorage.removeItem(agentSessionKey);
    } finally {
      restoringAgentSession = false;
    }
  }
  function setAgentBusy(busy) {
    agentForm.classList.toggle("busy", busy);
    agentInput.disabled = busy;
    agentForm.querySelector('button[type="submit"]').disabled = busy;
  }
  async function fetchJson(path, options) {
    const response = await fetch(path, { ...(options || {}), headers: { "content-type": "application/json", ...((options || {}).headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Request failed: " + response.status);
    return { body, response };
  }
  async function refreshDevices() {
    if (location.protocol === "file:") return;
    const previous = selectedUdid || localStorage.getItem("ios-ui-graph-console.udid") || "";
    try {
      const { body } = await fetchJson("/api/devices", { cache: "no-store" });
      const devices = Array.isArray(body.devices) ? body.devices : [];
      deviceSelect.replaceChildren();
      if (!devices.length) {
        deviceSelect.append(new Option("未发现在线 iOS 真机", ""));
        selectedUdid = "";
        return;
      }
      for (const device of devices) {
        const label = device.name + " · iOS " + device.version + " · " + device.model + " · " + device.id;
        deviceSelect.append(new Option(label, device.id));
      }
      const preferred = devices.find(device => device.id === previous)?.id || body.defaultUdid || devices[0].id;
      deviceSelect.value = preferred;
      selectedUdid = preferred;
      localStorage.setItem("ios-ui-graph-console.udid", preferred);
    } catch (error) {
      deviceSelect.replaceChildren(new Option("设备扫描失败", ""));
      selectedUdid = "";
      console.warn(error);
    }
  }
  function openContextMenu(event, target) {
    event.preventDefault();
    event.stopPropagation();
    contextTarget = target;
    contextTitle.textContent = entityTitle(target) + " · " + typedId(target);
    contextSubmenu.replaceChildren();
    const execute = contextMenu.querySelector(
      '[data-context-action="execute"], [data-context-action="recover"]',
    );
    const staleScene =
      target.kind === "scene" && sceneMap[target.id]?.status === "stale";
    execute.dataset.contextAction = staleScene ? "recover" : "execute";
    execute.textContent = staleScene
      ? "重新探索恢复"
      : target.kind === "element"
        ? "执行到元素所在页面"
        : "执行到这里";
    contextMenu.classList.add("open");
    contextMenu.style.left = Math.min(event.clientX, innerWidth - 260) + "px";
    contextMenu.style.top = Math.min(event.clientY, innerHeight - 190) + "px";
  }
  function closeContextMenu() { contextMenu.classList.remove("open"); contextSubmenu.replaceChildren(); }
  function selectTarget(target) {
    if (target.kind === "scene") selectScene(target.id);
    else if (target.kind === "element") selectElement(target.id);
    else if (target.kind === "operator") selectOperator(target.id);
    else selectTask(target.id);
  }
  function openElementChoices(target, goal) {
    const sceneId = sceneForTarget(target);
    const elements = sceneId ? elementsForScene(sceneId) : [];
    if (!sceneId) {
      appendAgentMessage("error", "该节点无法解析出可探索的 Scene。");
      openAgent();
      closeContextMenu();
      return;
    }
    closeContextMenu();
    openAgent();
    const choices = document.createElement("div");
    choices.className = "element-choice-list";
    const recapture = document.createElement("button");
    recapture.type = "button";
    recapture.className = "recapture";
    recapture.innerHTML = "重新到达并采集当前页面<small>" + esc(sceneId) + "</small>";
    recapture.addEventListener("click", () => {
      choices.querySelectorAll("button").forEach(button => { button.disabled = true; });
      void startAction("execute", { kind: "scene", id: sceneId }, { goal });
    });
    choices.appendChild(recapture);
    for (const element of elements) {
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = "探索元素：" + esc(element.title || element.elementId) + "<small>" + esc(element.elementId) + "</small>";
      button.addEventListener("click", () => {
        choices.querySelectorAll("button").forEach(button => { button.disabled = true; });
        void startAction("explore", { kind: "element", id: element.elementId }, { goal });
      });
      choices.appendChild(button);
    }
    appendAgentMessage("agent", "选择下一步。截图或页面状态不正确时，直接重新到达并采集；要探索新路径时，再选择明确元素。", choices);
  }
  function consoleControls(target, options) {
    const allowPlan = options?.plan !== false;
    const allowExecute = options?.execute !== false;
    const allowExplore = options?.explore === true;
    const allowRecover = options?.recover === true;
    const destructive = options?.destructive === true;
    selectedTarget = target;
    updateAgentContext();
    return '<div class="console-actions">'
      +(allowPlan?'<button data-console-action="plan">仅规划</button>':'')
      +(allowExecute?'<button class="'+(destructive?'danger':'')+'" data-console-action="execute">执行</button>':'')
      +(allowExplore?'<button data-console-action="explore">继续探索</button>':'')
      +(allowRecover?'<button data-console-action="recover">重新探索恢复</button>':'')
      +'</div><div class="console-status" data-console-status>正在检查 Console…</div>';
  }
  async function refreshConsoleStatus() {
    const host = details.querySelector("[data-console-status]");
    if (location.protocol === "file:") {
      if (host) {
        host.textContent = "静态浏览模式：请通过 iOS UI Graph Console 服务打开后再规划或执行。";
      }
      return false;
    }
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Console health check failed");
      graphRevision = body.graphRevision || graphRevision;
      if (Number.isInteger(body.graphNumericRevision) && body.graphNumericRevision !== loadedGraphRevision) {
        graphStale = true;
        graphRefresh.classList.add("visible");
        graphRefresh.textContent = "Graph r" + body.graphNumericRevision + " · 刷新";
      }
      consoleAvailable = true;
      agentService.textContent = "已连接";
      agentService.className = "agent-service connected";
      if (host) {
        host.className = "console-status ok";
        host.textContent = "Console 已连接 · Graph r" + graph.revision + " · 选择操作后查看运行状态。";
      }
      if (!selectedUdid) await refreshDevices();
      return true;
    } catch (error) {
      consoleAvailable = false;
      agentService.textContent = "只读模式";
      agentService.className = "agent-service offline";
      if (host) {
        host.className = "console-status error";
        host.textContent = "Console 未连接：" + String(error?.message || error);
      }
      return false;
    }
  }
  async function runConsoleAction(action) {
    const host = details.querySelector("[data-console-status]");
    if (!host || !selectedTarget) return;
    if (graphStale) {
      host.className = "console-status error";
      host.textContent = "Graph 已更新。请先点击顶栏的刷新按钮。";
      return;
    }
    const operator = selectedTarget.kind === "operator" ? operatorMap[selectedTarget.id] : null;
    const task = selectedTarget.kind === "task" ? taskMap[selectedTarget.id] : null;
    const destructive = operator?.risk === "destructive" || (task?.steps||[]).some(step => operatorMap[step.operatorId]?.risk === "destructive");
    let confirmed = false;
    let goal = "";
    if (action === "explore") {
      goal = String(window.prompt("这次探索要完成什么目标？", "") || "").trim();
      if (!goal) {
        host.className = "console-status error";
        host.textContent = "继续探索必须先输入用户目标。";
        return;
      }
    }
    if (action === "execute" && destructive) {
      confirmed = window.confirm("这是破坏性操作，确认在当前设备执行？");
      if (!confirmed) return;
    }
    if (action !== "plan" && !selectedUdid) {
      host.className = "console-status error";
      host.textContent = "未选择在线 iOS 真机，请刷新设备列表后重试。";
      return;
    }
    host.className = "console-status";
    host.textContent = "正在提交 " + action + " · " + selectedTarget.kind + ":" + selectedTarget.id;
    try {
      const response = await fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, target: selectedTarget, goal, graphRevision, confirmed, udid: action === "plan" ? undefined : selectedUdid }),
      });
      const run = await response.json();
      if (!response.ok) throw new Error(run.error || "Action request failed");
      host.textContent = "已排队 · " + run.runId;
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 400));
        const poll = await fetch("/api/runs/" + encodeURIComponent(run.runId), { cache: "no-store" });
        const current = await poll.json();
        if (!poll.ok) throw new Error(current.error || "Run status failed");
        host.textContent = current.status + " · " + current.runId + (current.error ? "\\n" + current.error : "");
        if (current.status === "succeeded" || current.status === "failed") {
          host.className = "console-status " + (current.status === "succeeded" ? "ok" : "error");
          host.textContent += "\\n" + JSON.stringify(current.result || {}, null, 2);
          break;
        }
      }
    } catch (error) {
      host.className = "console-status error";
      host.textContent = String(error?.message || error);
    }
  }
  async function startAction(action, target, options) {
    options = options || {};
    openAgent();
    closeContextMenu();
    if (!consoleAvailable && !(await refreshConsoleStatus())) {
      appendAgentMessage("error", "Graph Console Server 未连接，当前只能查看和复制 ID。");
      return;
    }
    if (graphStale) {
      appendAgentMessage("error", "Graph 已更新。请先点击顶栏的刷新按钮，当前对话会保留到你主动刷新为止。");
      return;
    }
    if (action === "explore" && target.kind !== "element") {
      const goal = String(options.goal || window.prompt("这次探索要完成什么目标？", "") || "").trim();
      if (!goal) { appendAgentMessage("error", "继续探索必须输入用户目标。"); return; }
      openElementChoices(target, goal);
      return;
    }
    if (action === "execute" && target.kind === "element") {
      const sceneId = sceneForTarget(target);
      if (!sceneId) { appendAgentMessage("error", "无法解析 Element 所属 Scene。"); return; }
      target = { kind: "scene", id: sceneId };
    }
    let goal = String(options.goal || "").trim();
    if (action === "explore" && !goal) {
      goal = String(window.prompt("这次探索要完成什么目标？", "") || "").trim();
      if (!goal) { appendAgentMessage("error", "继续探索必须输入用户目标。"); return; }
    }
    let confirmed = options.confirmed === true;
    let parameters = options.parameters || {};
    const task = target.kind === "task" ? taskMap[target.id] : null;
    for (const [name, definition] of Object.entries(task?.parameters || {})) {
      if (!definition.required || parameters[name]) continue;
      const value = window.prompt("请输入参数 " + name);
      if (value === null || !value.trim()) { appendAgentMessage("error", "参数 " + name + " 不能为空。"); return; }
      parameters = { ...parameters, [name]: value.trim() };
    }
    const operator = target.kind === "operator" ? operatorMap[target.id] : null;
    const destructive = operator?.risk === "destructive" || (task?.steps || []).some(step => operatorMap[step.operatorId]?.risk === "destructive");
    if (action !== "plan" && !selectedUdid) {
      appendAgentMessage("error", "未选择在线 iOS 真机，请刷新设备列表后重试。");
      return;
    }
    if (action === "execute" && destructive && !confirmed) {
      confirmed = window.confirm("这是破坏性操作，确认在当前设备执行？");
      if (!confirmed) return;
    }
    appendAgentMessage("user", (action === "execute" ? "执行到 " : "基于目标探索 " + goal + " · ") + typedId(target));
    runLog.replaceChildren();
    setAgentBusy(true);
    try {
      const { body: run } = await fetchJson("/api/actions", { method: "POST", body: JSON.stringify({ action, target, goal, graphRevision, confirmed, parameters, udid: action === "plan" ? undefined : selectedUdid }) });
      appendAgentMessage("system", "Run " + run.runId + " 已进入设备串行队列。");
      watchRun(run.runId);
    } catch (error) {
      setAgentBusy(false);
      appendAgentMessage("error", String(error?.message || error));
    }
  }
  function watchRun(runId) {
    const events = new EventSource("/api/runs/" + encodeURIComponent(runId) + "/events");
    events.onmessage = message => {
      const event = JSON.parse(message.data);
      const row = document.createElement("div");
      row.className = "run-event " + (event.status || "");
      const workflow = event.workflowEvent || {};
      row.innerHTML = "<span>" + esc(workflow.phase || event.status || workflow.type || "run") + "</span><small>" + esc(workflow.message || event.message || "") + "</small>";
      runLog.appendChild(row);
      runLog.scrollTop = runLog.scrollHeight;
      if (event.type === "run" && ["succeeded", "failed"].includes(event.status)) {
        events.close();
        setAgentBusy(false);
        if (event.status === "succeeded") {
          appendAgentMessage("agent", event.message || event.status);
        } else {
          void fetchJson("/api/runs/" + encodeURIComponent(runId))
            .then(({ body }) => {
              const result = body.result || {};
              const detail = [result.code, result.message].filter(Boolean).join(": " );
              appendAgentMessage("error", detail || body.error || event.message || event.status);
            })
            .catch(() => appendAgentMessage("error", event.message || event.status));
        }
        setTimeout(() => void refreshConsoleStatus(), 300);
      }
    };
    events.onerror = () => { events.close(); setAgentBusy(false); };
  }
  function renderAgentResponse(response, message) {
    if (response.kind === "correction_proposal" && response.proposal) {
      const card = document.createElement("div");
      card.className = "proposal";
      const title = document.createElement("strong");
      title.textContent = response.proposal.summary;
      card.appendChild(title);
      const list = document.createElement("ul");
      for (const change of response.proposal.changes || []) {
        const item = document.createElement("li");
        item.textContent = change.entityKind + ":" + change.entityId + " · " + change.field + " → " + (Array.isArray(change.value) ? change.value.join("、") : change.value);
        list.appendChild(item);
      }
      card.appendChild(list);
      const button = document.createElement("button");
      button.type = "button";
      if (response.proposal.requiresExploration) {
        button.textContent = "先定向探索验证";
        button.addEventListener("click", () => {
          const target = response.target || selectedTarget;
          if (target) void startAction("explore", target, { goal: response.proposal.explorationGoal });
        });
      } else {
        button.textContent = "应用修改";
        button.addEventListener("click", () => void applyCorrection(response.proposal.proposalId, button));
      }
      card.appendChild(button);
      if (message) replaceAgentMessage(message, "agent", response.message, card);
      else appendAgentMessage("agent", response.message, card);
      return;
    }
    let actions = null;
    if (response.action && response.target) {
      actions = document.createElement("div");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = response.action === "execute" ? "执行到这个节点" : response.action === "plan" ? "规划到这个节点" : response.action === "recover" ? "重新探索恢复" : "基于这个节点继续探索";
      button.addEventListener("click", () => {
        void startAction(response.action, response.target, { goal: response.goal });
      });
      actions.appendChild(button);
    }
    if (message) replaceAgentMessage(message, "agent", response.message, actions);
    else appendAgentMessage("agent", response.message, actions);
  }
  async function applyCorrection(proposalId, button) {
    button.disabled = true;
    try {
      const { body } = await fetchJson("/api/corrections/" + encodeURIComponent(proposalId) + "/apply", { method: "POST", body: "{}" });
      graphStale = true;
      appendAgentMessage("system", "已应用 " + body.appliedChangeCount + " 项修改。Graph 有新版本，可点击顶栏按钮刷新。");
      graphRefresh.classList.add("visible");
      graphRefresh.textContent = "Graph 已更新 · 刷新";
    } catch (error) {
      button.disabled = false;
      appendAgentMessage("error", String(error?.message || error));
    }
  }
  function artifactUrl(path) {
    const value = String(path || "").trim();
    if (!value) return "";
    if (/^https?:[/][/]/.test(value) || value.startsWith("/api/")) return value;
    if (value.startsWith("/")) {
      return location.protocol === "file:"
        ? "file://" + value
        : "/api/artifact?path=" + encodeURIComponent(value);
    }
    return value;
  }
  async function renderScenePreview(scene) {
    const host = details.querySelector("[data-scene-preview]");
    if (!host) return;
    const urls = [...new Set(
      (scene.referenceAssets || [])
        .map(asset => artifactUrl(asset?.screenshot))
        .filter(Boolean),
    )];
    if (!urls.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.style.marginTop = "8px";
      empty.textContent = "暂无参考截图";
      host.replaceChildren(empty);
      return;
    }
    const loading = document.createElement("div");
    loading.className = "muted";
    loading.style.marginTop = "8px";
    loading.textContent = "正在加载参考截图…";
    host.replaceChildren(loading);
    let index = 0;
    const tryNext = async () => {
      if (index >= urls.length) {
        const failure = document.createElement("div");
        failure.className = "muted";
        failure.style.marginTop = "8px";
        failure.textContent = "参考截图加载失败（已尝试 " + urls.length + " 个证据文件）";
        host.replaceChildren(failure);
        return;
      }
      const url = urls[index++];
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok || !String(response.headers.get("content-type") || "").startsWith("image/")) {
          await tryNext();
          return;
        }
        const image = document.createElement("img");
        image.className = "preview";
        image.loading = "eager";
        image.alt = scene.title || scene.sceneId;
        image.addEventListener("error", () => void tryNext(), { once: true });
        image.src = URL.createObjectURL(await response.blob());
        host.replaceChildren(image);
      } catch {
        await tryNext();
      }
    };
    await tryNext();
  }

  function selectScene(id) {
    clearSelection();
    const s = sceneMap[id];
    if (!s) return;
    selectedTarget = {kind:"scene",id:s.sceneId};
    updateAgentContext();
    node.filter(d => d.id === id).classed("selected", true);

    const els = Object.values(s.elements || {});
    const opsOut = Object.values(operatorMap).filter(o => o.fromSceneId === id);
    const opsIn = Object.values(operatorMap).filter(o => o.toSceneId === id);
    const unavailable = ["stale", "blocked", "disabled"].includes(s.status);

    details.innerHTML = '<h2>'+esc(s.title)+'</h2>'
      +'<div class="kv"><b>Scene ID</b><span class="mono">'+esc(s.sceneId)+'</span><b>Status</b><span>'+pill(s.status)+'</span><b>Parent</b><span class="mono">'+esc(s.parentSceneId||"none")+'</span><b>Elements</b><span>'+els.length+'</span><b>Outgoing</b><span>'+opsOut.length+'</span><b>Incoming</b><span>'+opsIn.length+'</span></div>'
      +consoleControls({kind:"scene",id:s.sceneId},{plan:!unavailable,execute:!unavailable,explore:false,recover:s.status==="stale"})
      +'<div data-scene-preview></div>'
      +'<h3 style="margin-top:10px;font-size:11px;color:#94a3b8">Anchors</h3><div>'+(s.visualTextAnchors||[]).map(a => '<span class="anchor-tag">'+esc(a)+'</span>').join("")+'</div>'
      +'<h3 style="margin-top:10px;font-size:11px;color:#94a3b8">Elements ('+els.length+')</h3><div style="font-size:10px">'+els.map(e => '<span class="mono" style="cursor:pointer;color:#93c5fd" data-el-id="'+esc(e.elementId)+'">'+esc(e.elementId)+'</span> · '+esc(e.title)+' · '+pill(e.status)+'<br>').join("")+'</div>'
      +'<h3 style="margin-top:10px;font-size:11px;color:#94a3b8">Outgoing Operators ('+opsOut.length+')</h3><div style="font-size:10px">'+opsOut.map(o => '<span class="mono" style="cursor:pointer;color:#93c5fd" data-op-id="'+esc(o.operatorId)+'">'+esc(o.operatorId)+'</span> → '+esc(o.toSceneId||"self")+' · '+esc(o.operation.type)+'<br>').join("")+'</div>';
    void renderScenePreview(s);
    void refreshConsoleStatus();

    // Scroll to scene in sidebar
    const opt = sceneFilter.querySelector('option[value="'+CSS.escape(id)+'"]');
    if (opt) { sceneFilter.value = id; }
  }

  function selectOperator(id) {
    clearSelection();
    link.filter(d => d.operatorId === id).classed("highlighted", true);
    const op = operatorMap[id];
    if (!op) return;
    selectedTarget = {kind:"operator",id:op.operatorId};
    updateAgentContext();
    details.innerHTML = '<h2>'+esc(op.operatorId)+'</h2>'
      +'<div class="kv"><b>Operator ID</b><span class="mono">'+esc(op.operatorId)+'</span><b>Type</b><span>'+esc(op.operation.type)+'</span><b>From</b><span class="mono">'+esc(op.fromSceneId)+'</span><b>To</b><span class="mono">'+esc(op.toSceneId||"self")+'</span><b>Status</b><span>'+pill(op.status)+'</span><b>Risk</b><span>'+esc(op.risk||"none")+'</span></div>'
      +consoleControls({kind:"operator",id:op.operatorId},{execute:true,explore:false,destructive:op.risk==="destructive"})
      +'<h3 style="margin-top:10px;font-size:11px;color:#94a3b8">Effects</h3><div style="font-size:10px" class="mono">'+esc(JSON.stringify(op.effects||[],null,2))+'</div>';
    void refreshConsoleStatus();
  }

  function selectElement(id) {
    clearSelection();
    let scene = null, element = null;
    for (const candidate of Object.values(sceneMap)) {
      if (candidate.elements?.[id]) { scene = candidate; element = candidate.elements[id]; break; }
    }
    if (!scene || !element) return;
    selectedTarget = {kind:"element",id:element.elementId};
    updateAgentContext();
    const operators = Object.values(operatorMap).filter(op => op.fromSceneId === scene.sceneId && op.operation?.elementId === id);
    details.innerHTML = '<h2>'+esc(element.title||element.elementId)+'</h2>'
      +'<div class="kv"><b>Element ID</b><span class="mono">'+esc(element.elementId)+'</span><b>Scene</b><span class="mono">'+esc(scene.sceneId)+'</span><b>Role</b><span>'+esc(element.semanticRole)+'</span><b>Status</b><span>'+pill(element.status)+'</span></div>'
      +consoleControls({kind:"element",id:element.elementId},{execute:false,explore:true})
      +'<h3 style="margin-top:10px;font-size:11px;color:#94a3b8">Selectors</h3><div class="mono" style="font-size:9px">'+esc(JSON.stringify(element.selectors||[],null,2))+'</div>'
      +'<h3 style="margin-top:10px;font-size:11px;color:#94a3b8">Operators</h3><div style="font-size:10px">'+operators.map(op => '<span class="mono" style="cursor:pointer;color:#93c5fd" data-op-id="'+esc(op.operatorId)+'">'+esc(op.operatorId)+'</span><br>').join("")+'</div>';
    void refreshConsoleStatus();
  }

  function selectTask(taskId) {
    clearSelection();
    const t = taskMap[taskId];
    if (!t) return;
    selectedTarget = {kind:"task",id:t.taskId};
    updateAgentContext();
    const stepOps = (t.steps || []).map(s => s.operatorId);
    const stepScenes = new Set();
    stepScenes.add(t.entrySceneId);
    for (const opId of stepOps) {
      const op = operatorMap[opId];
      if (op) { stepScenes.add(op.fromSceneId); if (op.toSceneId) stepScenes.add(op.toSceneId); }
    }

    node.classed("highlighted", d => stepScenes.has(d.id));
    node.classed("dimmed", d => !stepScenes.has(d.id));
    link.classed("highlighted", d => stepOps.includes(d.operatorId));
    link.classed("dimmed", d => !stepOps.includes(d.operatorId));

    const steps = (t.steps||[]).map(s => {
      const op = operatorMap[s.operatorId];
      return op ? '<li><span class="mono" style="cursor:pointer;color:#93c5fd" data-op-id="'+esc(op.operatorId)+'">'+esc(op.operatorId)+'</span> · '+esc(op.operation.type)+' → '+esc(op.toSceneId||"self")+'</li>' : '<li><span class="mono">'+esc(s.operatorId)+'</span></li>';
    }).join("");

    details.innerHTML = '<h2>'+esc(t.intents?.[0]||t.taskId)+'</h2>'
      +'<div class="kv"><b>Task ID</b><span class="mono">'+esc(t.taskId)+'</span><b>Status</b><span>'+pill(t.status)+'</span><b>Entry</b><span class="mono">'+esc(t.entrySceneId)+'</span><b>Steps</b><span>'+(t.steps||[]).length+'</span></div>'
      +consoleControls({kind:"task",id:t.taskId},{execute:true,explore:false,destructive:(t.steps||[]).some(step => operatorMap[step.operatorId]?.risk==="destructive")})
      +'<h3 style="margin-top:10px;font-size:11px;color:#94a3b8">Intents</h3><div>'+(t.intents||[]).map(i => '<span class="anchor-tag">'+esc(i)+'</span>').join(" ")+'</div>'
      +'<h3 style="margin-top:10px;font-size:11px;color:#94a3b8">Steps</h3><ol style="font-size:10px;padding-left:16px">'+steps+'</ol>'
      +'<h3 style="margin-top:10px;font-size:11px;color:#94a3b8">Oracles</h3><div style="font-size:9px" class="mono">'+esc(JSON.stringify(t.finalOracles||[],null,2))+'</div>';
    void refreshConsoleStatus();
  }

  function clearSelection() {
    selectedTarget = null;
    updateAgentContext();
    node.classed("selected", false).classed("highlighted", false).classed("dimmed", false);
    link.classed("highlighted", false).classed("dimmed", false);
    document.querySelectorAll(".task-card.selected").forEach(c => c.classList.remove("selected"));
    details.innerHTML = '<h2>Overview</h2><div class="kv"><b>Graph ID</b><span class="mono">'+esc(graph.graphId)+'</span><b>Bundle</b><span class="mono">'+esc(graph.bundleId)+'</span><b>Scenes</b><span>'+Object.keys(sceneMap).length+'</span><b>Operators</b><span>'+Object.keys(operatorMap).length+'</span><b>Tasks</b><span>'+Object.keys(taskMap).length+'</span></div><div class="muted" style="margin-top:10px">Click a node, link, or task to see details.</div>';
  }

  // Task list click
  taskList.addEventListener("click", e => {
    const card = e.target.closest(".task-card");
    if (!card) return;
    selectTask(card.dataset.taskId);
    card.classList.add("selected");
  });
  taskList.addEventListener("contextmenu", e => {
    const card = e.target.closest(".task-card");
    if (card) openContextMenu(e, { kind: "task", id: card.dataset.taskId });
  });

  // Inline element/operator clicks in details
  details.addEventListener("click", e => {
    const action = e.target.closest("[data-console-action]")?.dataset.consoleAction;
    if (action) { void runConsoleAction(action); return; }
    const elId = e.target.closest("[data-el-id]")?.dataset.elId;
    if (elId) {
      selectElement(elId);
      return;
    }
    const opId = e.target.closest("[data-op-id]")?.dataset.opId;
    if (opId) selectOperator(opId);
  });
  details.addEventListener("contextmenu", e => {
    const elId = e.target.closest("[data-el-id]")?.dataset.elId;
    if (elId) { openContextMenu(e, { kind: "element", id: elId }); return; }
    const opId = e.target.closest("[data-op-id]")?.dataset.opId;
    if (opId) openContextMenu(e, { kind: "operator", id: opId });
  });

  // Search
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    node.classed("dimmed", d => {
      if (!q) return false;
      const hay = [d.id, d.title, ...d.anchors].join(" ").toLowerCase();
      return !hay.includes(q);
    });
    link.classed("dimmed", d => {
      if (!q) return false;
      return !(d.source.id || d.source).toLowerCase().includes(q) && !(d.target.id || d.target).toLowerCase().includes(q);
    });
    document.querySelectorAll(".task-card").forEach(c => {
      c.style.display = !q || c.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });

  // Scene filter
  sceneFilter.addEventListener("change", () => {
    const val = sceneFilter.value;
    if (!val) {
      node.classed("dimmed", false).classed("selected", false);
      link.classed("dimmed", false);
      clearSelection();
      return;
    }
    selectScene(val);
    node.classed("dimmed", d => d.id !== val);
    link.classed("dimmed", d => (d.source.id || d.source) !== val && (d.target.id || d.target) !== val);
    node.filter(d => d.id === val).classed("selected", true);
  });

  // Center
  document.getElementById("center-root").addEventListener("click", () => {
    svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
  });

  document.getElementById("clear").addEventListener("click", () => {
    search.value = "";
    sceneFilter.selectedIndex = 0;
    search.dispatchEvent(new Event("input"));
    sceneFilter.dispatchEvent(new Event("change"));
    clearSelection();
  });

  document.getElementById("agent-toggle").addEventListener("click", () => {
    agentPanel.classList.toggle("open");
    if (agentPanel.classList.contains("open")) agentInput.focus();
  });
  document.getElementById("agent-close").addEventListener("click", closeAgent);
  graphRefresh.addEventListener("click", () => location.reload());
  document.getElementById("device-refresh").addEventListener("click", () => void refreshDevices());
  deviceSelect.addEventListener("change", () => {
    selectedUdid = deviceSelect.value;
    if (selectedUdid) localStorage.setItem("ios-ui-graph-console.udid", selectedUdid);
  });
  contextMenu.addEventListener("click", event => {
    const button = event.target.closest("[data-context-action]");
    if (!button || !contextTarget) return;
    const action = button.dataset.contextAction;
    if (action === "copy") {
      const value = contextTarget.id;
      navigator.clipboard.writeText(value)
        .then(() => { appendAgentMessage("system", "已复制 ID：" + value); openAgent(); })
        .catch(() => { appendAgentMessage("error", "复制失败，请手动复制：" + value); openAgent(); });
      closeContextMenu();
      return;
    }
    if (action === "explore") {
      const goal = String(window.prompt("这次探索要完成什么目标？", "") || "").trim();
      if (!goal) { appendAgentMessage("error", "继续探索必须输入用户目标。"); openAgent(); closeContextMenu(); return; }
      if (contextTarget.kind === "element") void startAction("explore", contextTarget, { goal });
      else openElementChoices(contextTarget, goal);
      return;
    }
    if (action === "execute" || action === "recover") void startAction(action, contextTarget);
  });
  document.addEventListener("pointerdown", event => {
    if (!event.target.closest("#context-menu")) closeContextMenu();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeContextMenu();
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && document.activeElement === agentInput) agentForm.requestSubmit();
  });
  agentForm.addEventListener("submit", async event => {
    event.preventDefault();
    const message = agentInput.value.trim();
    if (!message) return;
    openAgent();
    appendAgentMessage("user", message);
    const thinkingMessage = appendThinkingMessage();
    agentInput.value = "";
    if (!consoleAvailable && !(await refreshConsoleStatus())) {
      replaceAgentMessage(thinkingMessage, "error", "Graph Console Server 未连接，无法启动 Agent。");
      return;
    }
    setAgentBusy(true);
    try {
      const { body } = await fetchJson("/api/chat", { method: "POST", body: JSON.stringify({ message, target: selectedTarget, graphRevision }) });
      renderAgentResponse(body, thinkingMessage);
    } catch (error) {
      replaceAgentMessage(thinkingMessage, "error", String(error?.message || error));
    } finally { setAgentBusy(false); }
  });
  restoreAgentSession();
  void refreshConsoleStatus();
  window.addEventListener("focus", () => void refreshConsoleStatus());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshConsoleStatus();
  });
  setInterval(() => void refreshConsoleStatus(), 5000);

  // Resize
  window.addEventListener("resize", () => {
    const w = container.clientWidth, h = container.clientHeight;
    svg.attr("viewBox", [0, 0, w, h]);
    simulation.force("center", d3.forceCenter(w / 2, h / 2)).alpha(0.3).restart();
  });
})();
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}
