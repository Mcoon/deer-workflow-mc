import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { phase } from "@deerwork-ai/deer-workflow/flow";
import { log } from "@deerwork-ai/deer-workflow/logging";

import { readJsonIfExists, writeJsonAtomic } from "../ios-regression-kit";

import type {
  ExperimentElement,
  ExecutableUiGraphExperiment,
  ExperimentOperator,
  ExperimentScene,
} from "../ios-ui-graph-experiment/types";
import type { IosUiCrawlerState } from "../ios-ui-graph-discovery/types";
import type {
  IosUiSemanticMapReportInput,
  IosUiSemanticMapReportResult,
} from "./types";

export const meta = {
  name: "ios-ui-semantic-map-report",
  description:
    "Renders an executable iOS UI graph as an interactive Scene, Element, Operator, and Task HTML map.",
  phases: [
    { title: "Load" },
    { title: "Prepare Assets" },
    { title: "Render" },
    { title: "Report" },
  ],
  exampleArgs: {
    graphPath:
      "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-experiment/graph-chat-full.json",
    htmlPath:
      "/Users/bytedance/Documents/BDWorkSpace/ios-perf-optimizer/assets/app-regression/com.bot.doubao/ui-map/map.html",
  },
};

interface PreparedGraph extends ExecutableUiGraphExperiment {
  readonly scenes: readonly ExperimentScene[];
}

interface SemanticMapCoverage {
  readonly scannedScenes: number;
  readonly blockedScenes: number;
  readonly pendingScenes: number;
  readonly completedActions: number;
  readonly blockedActions: number;
  readonly backlogActions: number;
  readonly skippedActions: number;
  readonly sessionCount?: number;
}

export default async function iosUiSemanticMapReport(
  args: IosUiSemanticMapReportInput,
): Promise<IosUiSemanticMapReportResult> {
  const input = normalizeInput(args);

  phase("Load");
  const graph = JSON.parse(
    await Bun.file(input.graphPath).text(),
  ) as ExecutableUiGraphExperiment;
  validateGraph(graph);
  const discoveryState = input.discoveryStatePath
    ? await readJsonIfExists<IosUiCrawlerState>(input.discoveryStatePath)
    : null;
  const coverage = discoveryState
    ? summarizeDiscoveryCoverage(discoveryState)
    : undefined;

  phase("Prepare Assets");
  await Promise.all([
    mkdir(dirname(input.htmlPath), { recursive: true }),
    mkdir(dirname(input.scriptPath), { recursive: true }),
    mkdir(input.assetsDirectory, { recursive: true }),
    mkdir(dirname(input.graphOutputPath), { recursive: true }),
    mkdir(dirname(input.summaryPath), { recursive: true }),
  ]);
  const preparedGraph = await prepareReferenceAssets({
    graph,
    htmlPath: input.htmlPath,
    assetsDirectory: input.assetsDirectory,
  });
  await writeJsonAtomic(input.graphOutputPath, preparedGraph);
  const generatedAt = new Date().toISOString();

  phase("Render");
  const rendered = externalizeInteractiveScript(
    renderExecutableUiGraphHtml(preparedGraph, input.title, coverage, {
      revision: generatedAt,
      summaryFileName: basename(input.summaryPath),
    }),
  );
  await Promise.all([
    writeFile(input.htmlPath, rendered.html, "utf8"),
    writeFile(input.scriptPath, rendered.script, "utf8"),
    copyFile(
      new URL("./obsidian-map.css", import.meta.url),
      join(dirname(input.htmlPath), "obsidian-map.css"),
    ),
    copyFile(
      new URL("./obsidian-map.js", import.meta.url),
      join(dirname(input.htmlPath), "obsidian-map.js"),
    ),
  ]);

  phase("Report");
  const summary = {
    schemaVersion: "ios-ui-semantic-map-report/v1",
    generatedAt,
    graphId: graph.graphId,
    graphPath: input.graphPath,
    graphOutputPath: input.graphOutputPath,
    htmlPath: input.htmlPath,
    scriptPath: input.scriptPath,
    assetsDirectory: input.assetsDirectory,
    sceneCount: graph.scenes.length,
    elementCount: graph.elements.length,
    operatorCount: graph.operators.length,
    taskCount: graph.tasks.length,
    stateVariantCount: graph.scenes.reduce(
      (total, scene) => total + (scene.stateVariants?.length ?? 0),
      0,
    ),
    verifiedSceneCount: graph.scenes.filter(
      (scene) => scene.status === "verified",
    ).length,
    verifiedOperatorCount: graph.operators.filter(
      (operator) => operator.status === "verified",
    ).length,
    guardedOperatorCount: graph.operators.filter(
      (operator) => operator.execution?.tier === "guarded",
    ).length,
    fastOperatorCount: graph.operators.filter(
      (operator) =>
        operator.execution?.tier === "fast" ||
        (operator.status === "verified" && !operator.execution),
    ).length,
    quarantinedOperatorCount: graph.operators.filter(
      (operator) => operator.execution?.tier === "quarantined",
    ).length,
    verifiedTaskCount: graph.tasks.filter((task) => task.status === "verified")
      .length,
    coverage,
  };
  await writeJsonAtomic(input.summaryPath, summary);
  log(
    [
      "## Executable iOS UI semantic map ready",
      `- **Graph:** \`${input.graphOutputPath}\``,
      `- **HTML:** \`${input.htmlPath}\``,
      `- **Scenes:** ${summary.sceneCount}`,
      `- **Elements:** ${summary.elementCount}`,
      `- **Operators:** ${summary.operatorCount}`,
      `- **Execution tiers:** ${summary.fastOperatorCount} fast · ${summary.guardedOperatorCount} guarded · ${summary.quarantinedOperatorCount} quarantined`,
      `- **Tasks:** ${summary.taskCount}`,
      `- **State Variants:** ${summary.stateVariantCount}`,
    ].join("\n"),
  );

  return {
    success: true,
    graphPath: input.graphPath,
    graphOutputPath: input.graphOutputPath,
    htmlPath: input.htmlPath,
    scriptPath: input.scriptPath,
    assetsDirectory: input.assetsDirectory,
    summaryPath: input.summaryPath,
    sceneCount: summary.sceneCount,
    elementCount: summary.elementCount,
    operatorCount: summary.operatorCount,
    taskCount: summary.taskCount,
    stateVariantCount: summary.stateVariantCount,
  };
}

interface NormalizedInput {
  graphPath: string;
  htmlPath: string;
  scriptPath: string;
  graphOutputPath: string;
  assetsDirectory: string;
  summaryPath: string;
  discoveryStatePath?: string;
  title: string;
}

function normalizeInput(args: IosUiSemanticMapReportInput): NormalizedInput {
  if (!args) {
    throw new TypeError("iOS UI Semantic Map Report requires input arguments.");
  }
  const graphPath = resolve(requiredText(args.graphPath, "graphPath"));
  const htmlPath = resolve(requiredText(args.htmlPath, "htmlPath"));
  const mapDirectory = dirname(htmlPath);
  return {
    graphPath,
    htmlPath,
    discoveryStatePath: args.discoveryStatePath?.trim()
      ? resolve(args.discoveryStatePath)
      : undefined,
    scriptPath: resolve(
      args.scriptPath?.trim() || join(mapDirectory, "semantic-map.js"),
    ),
    graphOutputPath: resolve(
      args.graphOutputPath?.trim() ||
        join(mapDirectory, "executable-graph.json"),
    ),
    assetsDirectory: resolve(
      args.assetsDirectory?.trim() || join(mapDirectory, "semantic-map-assets"),
    ),
    summaryPath: resolve(
      args.summaryPath?.trim() ||
        join(mapDirectory, "semantic-map-summary.json"),
    ),
    title: args.title?.trim() || "iOS Executable UI Graph",
  };
}

async function prepareReferenceAssets(options: {
  graph: ExecutableUiGraphExperiment;
  htmlPath: string;
  assetsDirectory: string;
}): Promise<PreparedGraph> {
  const scenes: ExperimentScene[] = [];
  for (const scene of options.graph.scenes) {
    const assets = [];
    for (const [index, asset] of scene.referenceAssets.entries()) {
      if (
        !asset.screenshotPath ||
        !(await Bun.file(asset.screenshotPath).exists())
      ) {
        assets.push(asset);
        continue;
      }
      const extension =
        basename(asset.screenshotPath).split(".").at(-1) || "png";
      const targetPath = join(
        options.assetsDirectory,
        `${safeSegment(scene.sceneId)}-${index + 1}.${extension}`,
      );
      await copyFile(asset.screenshotPath, targetPath);
      assets.push({
        ...asset,
        screenshotPath: relative(dirname(options.htmlPath), targetPath),
      });
    }
    scenes.push({ ...scene, referenceAssets: assets });
  }
  return { ...options.graph, scenes };
}

export function renderExecutableUiGraphHtml(
  graph: ExecutableUiGraphExperiment,
  title = "iOS Executable UI Graph",
  coverage?: SemanticMapCoverage,
  liveReload?: {
    readonly revision: string;
    readonly summaryFileName: string;
  },
): string {
  const graphJson = safeEmbeddedJson(graph);
  const staticTaskCards = renderStaticTaskCards(graph);
  const staticGraph = renderStaticGraphSvg(graph);
  const elementBoard = renderEntityBoard(graph, "elements");
  const stateBoard = renderEntityBoard(graph, "states");
  const operatorBoard = renderEntityBoard(graph, "operators");
  const staticDetails = renderStaticDetails(graph);
  const zoomCss = renderStaticZoomCss(staticGraph.width, staticGraph.height);
  const taskPathCss = renderStaticTaskPathCss(graph);
  const sceneCount = graph.scenes.length;
  const elementCount = graph.elements.length;
  const operatorCount = graph.operators.length;
  const taskCount = graph.tasks.length;
  const stateVariantCount = graph.scenes.reduce(
    (total, scene) => total + (scene.stateVariants?.length ?? 0),
    0,
  );
  const coveragePanel = renderCoveragePanel(graph, coverage);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="semantic-map-revision" content="${escapeHtml(liveReload?.revision ?? "")}">
<title>${escapeHtml(title)} · ${escapeHtml(graph.appName)}</title>
<style>
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17202a;background:#eef2f6}
*{box-sizing:border-box}body{margin:0;overflow:hidden}.app{height:100vh;display:grid;grid-template-rows:62px 1fr}
header{display:flex;align-items:center;gap:14px;padding:0 18px;background:#fff;border-bottom:1px solid #d9e0e8;box-shadow:0 1px 5px #1f293714;z-index:4}
h1{font-size:17px;margin:0;white-space:nowrap}.meta{color:#64748b;font-size:12px;white-space:nowrap}.status{color:#047857;font-weight:650}
.toolbar{margin-left:auto;display:flex;align-items:center;gap:8px}.toolbar input{width:260px;height:34px;border:1px solid #cbd5e1;border-radius:7px;padding:0 10px}.toolbar button,.task-card{border:1px solid #cbd5e1;background:#fff;border-radius:7px;cursor:pointer}.runtime{font-size:10px;padding:4px 7px;border-radius:999px;background:#fef3c7;color:#92400e}.runtime.ready{background:#d1fae5;color:#065f46}.runtime.failed{background:#fee2e2;color:#991b1b;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toolbar button{height:34px;padding:0 11px}.layout{display:grid;grid-template-columns:270px minmax(0,1fr) 360px;min-height:0}
.tasks,.details{background:#fff;overflow:auto}.tasks{border-right:1px solid #d9e0e8;padding:14px}.details{border-left:1px solid #d9e0e8;padding:18px}
.tasks h2,.details h2{font-size:15px;margin:0 0 12px}.task-card{width:100%;padding:10px;text-align:left;margin:0 0 8px;display:block;text-decoration:none;color:inherit}.task-card:hover,.task-card.selected{border-color:#2563eb;background:#eff6ff}.task-title{font-size:13px;font-weight:650}.task-id{font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:#64748b;margin-top:4px}.task-meta{font-size:10px;color:#64748b;margin-top:5px}
.workspace{position:relative;min-width:0;min-height:0;background:linear-gradient(135deg,#f8fafc,#e8eef5)}.view-toggle,.zoom-toggle{position:absolute;opacity:0;pointer-events:none}.view-controls{position:absolute;z-index:5;left:12px;top:10px;display:flex;gap:4px;padding:5px;background:#ffffffef;border:1px solid #cbd5e1;border-radius:9px;box-shadow:0 2px 8px #0f172a1a}.view-controls label{font-size:10px;padding:6px 9px;border-radius:6px;cursor:pointer;color:#475569;white-space:nowrap}.view-controls label:hover{background:#e2e8f0}#view-graph:checked~.view-controls label[for=view-graph],#view-elements:checked~.view-controls label[for=view-elements],#view-states:checked~.view-controls label[for=view-states],#view-operators:checked~.view-controls label[for=view-operators]{background:#2563eb;color:#fff}
.view-layers{position:absolute;inset:0}.view-layer{display:none;position:absolute;inset:0;overflow:auto;padding:58px 18px 24px}#view-graph:checked~.view-layers .graph-view,#view-elements:checked~.view-layers .elements-view,#view-states:checked~.view-layers .states-view,#view-operators:checked~.view-layers .operators-view{display:block}.graph-view{padding:0}.zoom-controls{position:absolute;z-index:3;left:354px;top:10px;display:flex;gap:4px;padding:5px;background:#ffffffeb;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 2px 8px #0f172a1a}.zoom-controls label{font-size:10px;padding:5px 7px;border-radius:5px;cursor:pointer;color:#475569}.zoom-controls label:hover{background:#e2e8f0}.canvas-scroll{position:absolute;inset:0;overflow:auto;padding:58px 24px 24px;scroll-behavior:smooth}.canvas-scale{transform-origin:top left;transition:width .16s ease,height .16s ease}.canvas-scale svg{display:block;width:100%;height:100%;touch-action:pan-x pan-y}.canvas-hint{position:absolute;right:14px;top:13px;z-index:3;background:#ffffffdf;border:1px solid #cbd5e1;border-radius:7px;padding:5px 8px;font-size:10px;color:#64748b}
${zoomCss}
.edge{fill:none;stroke-width:2.2;marker-end:url(#arrow);cursor:pointer}.edge.navigation{stroke:#2563eb}.edge.interaction{stroke:#0891b2}.edge.selection{stroke:#7c3aed}.edge.mutation{stroke:#db2777}.edge.permission{stroke:#d97706}.edge.support{stroke:#64748b;stroke-dasharray:6 5}.edge.dim{opacity:.08}.edge.highlight{stroke-width:4;filter:url(#glow)}
.contains{stroke:#cbd5e1;stroke-width:1.2;stroke-dasharray:3 4;fill:none}.contains.dim{opacity:.08}
.module-band{fill:#f8fafc;stroke:#cbd5e1;stroke-width:1.2;rx:14}.module-title{font-size:15px;font-weight:700;fill:#334155}.module-meta{font-size:10px;fill:#64748b}.node{cursor:pointer}.node rect{rx:9;stroke-width:1.7}.node.scene rect{fill:#fff;stroke:#2563eb}.node.element rect{fill:#fff;stroke:#94a3b8}.node.scene.verified rect{stroke:#059669}.node.element.verified rect{stroke:#64748b}.node.selected rect{stroke:#e11d48;stroke-width:3.5}.node.dim{opacity:.1}.node.highlight rect{stroke:#7c3aed;stroke-width:3}
${taskPathCss}
.node text{pointer-events:none;fill:#17202a;font-size:12px}.node .sub{fill:#64748b;font-size:9.5px}.node .badge{fill:#047857;font-size:9px;font-weight:650}
.legend{display:flex;gap:8px;flex-wrap:wrap;font-size:10px;color:#64748b}.dot{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:3px}.nav{background:#2563eb}.interact{background:#0891b2}.select{background:#7c3aed}.mutate{background:#db2777}.permit{background:#d97706}
.coverage{margin:0 0 14px;padding:10px;border:1px solid #dbe3ec;border-radius:9px;background:#f8fafc}.coverage h3{font-size:12px;margin:0 0 8px}.coverage-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}.coverage-stat{background:#fff;border:1px solid #e2e8f0;border-radius:7px;padding:7px}.coverage-value{font-size:17px;font-weight:750;color:#0f172a}.coverage-label{font-size:9px;color:#64748b;margin-top:2px}
.inventory{display:grid;gap:18px}.module-section{border:1px solid #d6dee8;background:#ffffffd9;border-radius:12px;padding:14px;box-shadow:0 2px 8px #0f172a0d}.module-heading{display:flex;align-items:baseline;gap:8px;margin-bottom:10px}.module-heading h2{font-size:15px;margin:0}.module-heading span{font-size:10px;color:#64748b}.scene-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:10px}.scene-card{border:1px solid #dbe3ec;background:#fff;border-radius:10px;padding:10px;min-width:0}.scene-card.verified{border-color:#86c9ad}.scene-card-header{display:flex;justify-content:space-between;gap:8px;text-decoration:none;color:inherit}.scene-card-title{font-size:12px;font-weight:700}.scene-card-id{font:9px ui-monospace,SFMono-Regular,Menlo,monospace;color:#64748b;margin-top:3px;overflow:hidden;text-overflow:ellipsis}.scene-card-counts{font-size:9px;color:#64748b;white-space:nowrap}.entity-list{display:grid;gap:5px;margin-top:9px}.entity-row{display:block;text-decoration:none;color:#334155;border:1px solid #e2e8f0;border-radius:7px;padding:6px 7px;background:#f8fafc;font-size:10px}.entity-row:hover{border-color:#60a5fa;background:#eff6ff}.entity-title{font-weight:650}.entity-meta{color:#64748b;font-size:9px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.state-row{border-color:#ddd6fe;background:#faf5ff}.operator-row.navigation{border-left:4px solid #2563eb}.operator-row.interaction{border-left:4px solid #0891b2}.operator-row.selection{border-left:4px solid #7c3aed}.operator-row.mutation,.operator-row.destructive{border-left:4px solid #db2777}
.kv{display:grid;grid-template-columns:104px 1fr;gap:7px;font-size:12px;margin:8px 0}.kv b{color:#475569}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}
.pill{display:inline-block;padding:3px 7px;border:1px solid #d7dee7;border-radius:999px;font-size:10px;margin:2px 3px 2px 0}.preview{display:block;width:100%;max-height:360px;object-fit:contain;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px}.list{font-size:12px;padding-left:18px}.list li{margin:6px 0}.muted{color:#64748b;font-size:12px}.sequence{counter-reset:step;list-style:none;padding:0}.sequence li{counter-increment:step;padding:7px 8px 7px 34px;position:relative;border-left:2px solid #bfdbfe;margin-left:10px;font-size:11px}.sequence li:before{content:counter(step);position:absolute;left:-12px;top:6px;background:#2563eb;color:#fff;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:10px}.detail-card{display:none;scroll-margin-top:10px}.detail-card:target{display:block}.details:has(.detail-card:target) .detail-default{display:none}.detail-card h2{padding-top:2px}.back-top{display:inline-block;margin-top:12px;font-size:11px;color:#2563eb;text-decoration:none}
@media(max-width:1050px){.layout{grid-template-columns:220px minmax(0,1fr)}.details{display:none}.toolbar input{width:180px}}
</style>
</head>
<body>
<div class="app">
<header>
  <h1>${escapeHtml(title)}</h1>
  <span class="meta">${escapeHtml(graph.appName)} · ${escapeHtml(graph.graphId)}</span>
  <span class="meta status">${sceneCount} Scenes · ${elementCount} Elements · ${stateVariantCount} States · ${operatorCount} Operators · ${taskCount} Tasks</span>
  <div class="legend"><span><i class="dot nav"></i>navigation</span><span><i class="dot interact"></i>interaction</span><span><i class="dot select"></i>selection</span><span><i class="dot mutate"></i>mutation</span><span><i class="dot permit"></i>permission</span></div>
  <div class="toolbar"><span class="runtime" id="runtime-status">Interactive JS: loading</span><input id="search" placeholder="搜索 Scene / Element / Operator / Task"><button id="fit">Fit</button><button id="clear">Clear</button></div>
</header>
<div class="layout">
  <aside class="tasks"><h2>Coverage</h2>${coveragePanel}<h2>Executable Tasks</h2><div id="task-list">${staticTaskCards}</div></aside>
  <main class="workspace"><input class="view-toggle" type="radio" name="view" id="view-graph"><input class="view-toggle" type="radio" name="view" id="view-elements" checked><input class="view-toggle" type="radio" name="view" id="view-states"><input class="view-toggle" type="radio" name="view" id="view-operators"><div class="view-controls"><label for="view-graph">Graph · ${sceneCount}</label><label for="view-elements">Elements · ${elementCount}</label><label for="view-states">States · ${stateVariantCount}</label><label for="view-operators">Operators · ${operatorCount}</label></div><div class="view-layers"><section class="view-layer graph-view"><input class="zoom-toggle" type="radio" name="zoom" id="zoom-50"><input class="zoom-toggle" type="radio" name="zoom" id="zoom-75"><input class="zoom-toggle" type="radio" name="zoom" id="zoom-100" checked><input class="zoom-toggle" type="radio" name="zoom" id="zoom-150"><input class="zoom-toggle" type="radio" name="zoom" id="zoom-200"><div class="zoom-controls"><label for="zoom-50">50%</label><label for="zoom-75">75%</label><label for="zoom-100">100%</label><label for="zoom-150">150%</label><label for="zoom-200">200%</label></div><div class="canvas-hint">Task 路径高亮 · 模块分区 · 滚动平移</div><div class="canvas-scroll"><div class="canvas-scale">${staticGraph.svg}</div></div></section><section class="view-layer elements-view">${elementBoard}</section><section class="view-layer states-view">${stateBoard}</section><section class="view-layer operators-view">${operatorBoard}</section></div></main>
  <aside class="details" id="details"><div class="detail-default"><h2>Graph Details</h2><p class="muted">默认展示全部 Element。可切换 Graph、States 和 Operators；点击任一实体查看完整详情。</p><div class="kv"><b>Scenes</b><span>${sceneCount}</span><b>Elements</b><span>${elementCount}</span><b>State Variants</b><span>${stateVariantCount}</span><b>Operators</b><span>${operatorCount}</span><b>Tasks</b><span>${taskCount}</span></div></div>${staticDetails}</aside>
</div>
</div>
<script type="application/json" id="executable-graph-data">${graphJson}</script>
<script>
const runtimeStatus=document.getElementById("runtime-status");
function runtimeBeacon(name,detail=""){fetch(name+"?detail="+encodeURIComponent(detail)+"&ts="+Date.now(),{cache:"no-store"}).catch(()=>{})}
window.addEventListener("error",event=>{runtimeStatus.textContent="Interactive JS: FAILED · "+event.message;runtimeStatus.className="runtime failed";runtimeStatus.title=event.error?.stack||event.message;runtimeBeacon("runtime-failed",event.message)});
const graph=JSON.parse(document.getElementById("executable-graph-data").textContent);
const mapRevision=${JSON.stringify(liveReload?.revision ?? "")},summaryFileName=${JSON.stringify(liveReload?.summaryFileName ?? "")};
if(false){
const svg=document.getElementById("map"),details=document.getElementById("details"),taskList=document.getElementById("task-list"),ns="http://www.w3.org/2000/svg";
taskList.replaceChildren();while(svg.firstChild)svg.removeChild(svg.firstChild);
const sceneById=new Map(graph.scenes.map(x=>[x.sceneId,x])),elementById=new Map(graph.elements.map(x=>[x.elementId,x])),operatorById=new Map(graph.operators.map(x=>[x.operatorId,x])),taskById=new Map(graph.tasks.map(x=>[x.taskId,x]));
const outgoing=new Map();for(const op of graph.operators){if(!outgoing.has(op.fromSceneId))outgoing.set(op.fromSceneId,[]);outgoing.get(op.fromSceneId).push(op)}
const depths=new Map([["chat.detail",0]]),queue=["chat.detail"];while(queue.length){const id=queue.shift(),d=depths.get(id)||0;for(const op of outgoing.get(id)||[]){if(op.toSceneId===id)continue;if(!depths.has(op.toSceneId)){depths.set(op.toSceneId,d+1);queue.push(op.toSceneId)}}}
let maxDepth=Math.max(0,...depths.values());for(const scene of graph.scenes){if(!depths.has(scene.sceneId))depths.set(scene.sceneId,++maxDepth)}
const scenesByDepth=new Map();for(const scene of graph.scenes){const d=depths.get(scene.sceneId)||0;if(!scenesByDepth.has(d))scenesByDepth.set(d,[]);scenesByDepth.get(d).push(scene)}
const elementsByScene=new Map();for(const el of graph.elements){if(!elementsByScene.has(el.sceneId))elementsByScene.set(el.sceneId,[]);elementsByScene.get(el.sceneId).push(el)}
const sceneW=210,sceneH=70,elementW=176,elementH=42,gapX=390,gapY=68,elementGap=50,positions=new Map();
for(const [depth,scenes] of [...scenesByDepth.entries()].sort((a,b)=>a[0]-b[0])){let y=36;scenes.sort((a,b)=>a.sceneId.localeCompare(b.sceneId));for(const scene of scenes){const x=38+depth*gapX;positions.set("scene:"+scene.sceneId,{x,y,w:sceneW,h:sceneH});const els=(elementsByScene.get(scene.sceneId)||[]).sort((a,b)=>a.elementId.localeCompare(b.elementId));els.forEach((el,i)=>positions.set("element:"+el.elementId,{x:x+16,y:y+sceneH+20+i*elementGap,w:elementW,h:elementH}));y+=Math.max(gapY+sceneH,sceneH+30+els.length*elementGap+50)}}
const boxes=[...positions.values()],width=Math.max(1100,...boxes.map(p=>p.x+p.w))+120,height=Math.max(720,...boxes.map(p=>p.y+p.h))+100;let view=[0,0,width,height];svg.setAttribute("viewBox",view.join(" "));
const defs=document.createElementNS(ns,"defs");defs.innerHTML='<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="context-stroke"/></marker><filter id="glow"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';svg.appendChild(defs);
const edgeEls=new Map(),nodeEls=new Map();
function right(p){return{x:p.x+p.w,y:p.y+p.h/2}}function left(p){return{x:p.x,y:p.y+p.h/2}}function bottom(p){return{x:p.x+p.w/2,y:p.y+p.h}}function top(p){return{x:p.x+p.w/2,y:p.y}}
function operatorKind(op){if(op.risk==="mutation")return"mutation";if(op.risk==="selection")return"selection";if(op.operatorId.includes("permission"))return"permission";if(op.risk==="navigation")return"navigation";return"interaction"}
function drawPath(from,to,klass,id,label){const a=right(from),b=left(to),dx=Math.max(42,Math.abs(b.x-a.x)/2);const path=document.createElementNS(ns,"path");path.setAttribute("d",from===to?"":("M "+a.x+" "+a.y+" C "+(a.x+dx)+" "+a.y+", "+(b.x-dx)+" "+b.y+", "+b.x+" "+b.y));path.setAttribute("class",klass);path.dataset.id=id;const title=document.createElementNS(ns,"title");title.textContent=label;path.appendChild(title);svg.appendChild(path);return path}
for(const el of graph.elements){const s=positions.get("scene:"+el.sceneId),e=positions.get("element:"+el.elementId);if(!s||!e)continue;const path=document.createElementNS(ns,"path"),a=bottom(s),b=top(e);path.setAttribute("d","M "+a.x+" "+a.y+" L "+b.x+" "+b.y);path.setAttribute("class","contains");svg.appendChild(path)}
for(const op of graph.operators){const elementOperation=op.operation.type==="tap"||op.operation.type==="long_press",target=elementOperation?positions.get("element:"+op.operation.elementId):positions.get("scene:"+op.fromSceneId),to=positions.get("scene:"+op.toSceneId);if(!target||!to)continue;let path;if(op.fromSceneId===op.toSceneId){const p=target;path=document.createElementNS(ns,"path");path.setAttribute("d","M "+(p.x+p.w)+" "+(p.y+p.h/2)+" C "+(p.x+p.w+90)+" "+(p.y-45)+", "+(p.x+p.w+90)+" "+(p.y+p.h+45)+", "+(p.x+p.w)+" "+(p.y+p.h/2));path.setAttribute("class","edge "+operatorKind(op));path.dataset.id=op.operatorId;svg.appendChild(path)}else path=drawPath(target,to,"edge "+operatorKind(op),op.operatorId,op.operatorId);path.addEventListener("click",event=>{event.stopPropagation();selectOperator(op.operatorId)});edgeEls.set(op.operatorId,path)}
function drawNode(kind,id,title,sub,status){const p=positions.get(kind+":"+id);if(!p)return;const g=document.createElementNS(ns,"g");g.setAttribute("class","node "+kind+" "+status);g.setAttribute("transform","translate("+p.x+","+p.y+")");g.dataset.id=id;g.dataset.kind=kind;const r=document.createElementNS(ns,"rect");r.setAttribute("width",p.w);r.setAttribute("height",p.h);const t=document.createElementNS(ns,"text");t.setAttribute("x","10");t.setAttribute("y",kind==="scene"?"25":"17");t.textContent=short(title,kind==="scene"?25:22);const s=document.createElementNS(ns,"text");s.setAttribute("x","10");s.setAttribute("y",kind==="scene"?"48":"33");s.setAttribute("class","sub");s.textContent=short(sub,kind==="scene"?28:24);const b=document.createElementNS(ns,"text");b.setAttribute("x",p.w-10);b.setAttribute("y","15");b.setAttribute("text-anchor","end");b.setAttribute("class","badge");b.textContent=status;g.append(r,t,s,b);g.addEventListener("click",event=>{event.stopPropagation();kind==="scene"?selectScene(id):selectElement(id)});svg.appendChild(g);nodeEls.set(kind+":"+id,g)}
for(const scene of graph.scenes)drawNode("scene",scene.sceneId,scene.title,scene.sceneId,scene.status);for(const el of graph.elements)drawNode("element",el.elementId,el.title,el.semanticRole,el.bindings.some(x=>x.status==="verified")?"verified":"candidate");
for(const task of graph.tasks){const button=document.createElement("button");button.className="task-card";button.dataset.taskId=task.taskId;button.innerHTML='<div class="task-title">'+esc(task.title)+'</div><div class="task-id">'+esc(task.taskId)+'</div><div class="task-meta">'+task.operatorIds.length+' steps · '+esc(task.status)+'</div>';button.addEventListener("click",()=>selectTask(task.taskId));taskList.appendChild(button)}
function clearSelection(){for(const el of nodeEls.values())el.classList.remove("selected","highlight","dim");for(const el of edgeEls.values())el.classList.remove("highlight","dim");document.querySelectorAll(".task-card").forEach(x=>x.classList.remove("selected"))}
function selectTask(id){clearSelection();const task=taskById.get(id);if(!task)return;const opIds=new Set(task.operatorIds),sceneIds=new Set([task.entrySceneId]),elementIds=new Set();for(const opId of task.operatorIds){const op=operatorById.get(opId);if(!op)continue;sceneIds.add(op.fromSceneId);sceneIds.add(op.toSceneId);if(op.operation.type==="tap"||op.operation.type==="long_press")elementIds.add(op.operation.elementId)}for(const [key,el] of nodeEls){const [kind,nodeId]=key.split(/:(.*)/s);const keep=kind==="scene"?sceneIds.has(nodeId):elementIds.has(nodeId);el.classList.toggle("highlight",keep);el.classList.toggle("dim",!keep)}for(const [opId,el] of edgeEls){el.classList.toggle("highlight",opIds.has(opId));el.classList.toggle("dim",!opIds.has(opId))}document.querySelector('[data-task-id="'+cssEsc(id)+'"]')?.classList.add("selected");renderTask(task)}
function selectScene(id){clearSelection();nodeEls.get("scene:"+id)?.classList.add("selected");renderScene(sceneById.get(id))}
function selectElement(id){clearSelection();nodeEls.get("element:"+id)?.classList.add("selected");renderElement(elementById.get(id))}
function selectOperator(id){clearSelection();edgeEls.get(id)?.classList.add("highlight");renderOperator(operatorById.get(id))}
function renderTask(task){const validation=task.validation?'<h3>Validation</h3><div class="kv"><b>Source</b><span>'+esc(task.validation.source)+'</span><b>Successful Runs</b><span>'+task.validation.successfulExecutions+'</span><b>Fixture Replay</b><span>'+(task.validation.requiresFixtureReplay?"required":"not required")+'</span><b>Completion</b><span class="mono">'+esc(JSON.stringify(task.validation.completionOracle||{}))+'</span></div>':"",verifier=task.verifier?'<h3>Agent Verifier</h3><div class="kv"><b>Status</b><span>'+esc(task.verifier.status)+'</span><b>Confidence</b><span>'+task.verifier.confidence+'</span><b>Successful Runs</b><span>'+task.verifier.successfulExecutions+'</span><b>Assertions</b><span class="mono">'+esc(JSON.stringify(task.verifier.assertions))+'</span></div>':"";details.innerHTML='<h2>'+esc(task.title)+'</h2><div class="kv"><b>Task ID</b><span class="mono">'+esc(task.taskId)+'</span><b>Status</b><span>'+esc(task.status)+'</span><b>Entry Scene</b><span class="mono">'+esc(task.entrySceneId)+'</span><b>Summary</b><span>'+esc(task.summary)+'</span></div><h3>Execution Sequence</h3><ol class="sequence">'+task.operatorIds.map(id=>'<li><span class="mono">'+esc(id)+'</span><br>'+esc(operatorById.get(id)?.title||"")+'</li>').join("")+'</ol><h3>Final Oracles</h3><ul class="list">'+task.finalOracles.map(x=>'<li class="mono">'+esc(JSON.stringify(x))+'</li>').join("")+'</ul>'+verifier+validation+'<h3>Intents</h3><div>'+task.intents.map(x=>'<span class="pill">'+esc(x)+'</span>').join("")+'</div>'}
function renderScene(scene){if(!scene)return;const els=elementsByScene.get(scene.sceneId)||[],ops=outgoing.get(scene.sceneId)||[],shot=scene.referenceAssets.find(x=>x.screenshotPath)?.screenshotPath,variants=scene.stateVariants||[];details.innerHTML='<h2>'+esc(scene.title)+'</h2><div class="kv"><b>Scene ID</b><span class="mono">'+esc(scene.sceneId)+'</span><b>Status</b><span>'+esc(scene.status)+'</span><b>Elements</b><span>'+els.length+'</span><b>Outgoing</b><span>'+ops.length+'</span><b>State Variants</b><span>'+variants.length+'</span></div>'+(shot?'<h3>Reference Screenshot</h3><img class="preview" src="'+esc(shot)+'">':'')+'<h3>Visual Anchors</h3><div>'+((scene.visualTextAnchors||[]).map(x=>'<span class="pill">'+esc(x)+'</span>').join("")||'<span class="muted">none</span>')+'</div><h3>State Variants</h3><ul class="list">'+(variants.map(x=>'<li><b>'+esc(x.title)+'</b><br><span class="mono">'+esc(x.facts.join(" · "))+'</span><br>'+x.visualTextAnchors.map(a=>'<span class="pill">'+esc(a)+'</span>').join("")+'</li>').join("")||'<li class="muted">none</li>')+'</ul><h3>Elements</h3><ul class="list">'+els.map(x=>'<li><span class="mono">'+esc(x.elementId)+'</span> · '+esc(x.title)+'</li>').join("")+'</ul><h3>Outgoing Operators</h3><ul class="list">'+ops.map(x=>'<li><span class="mono">'+esc(x.operatorId)+'</span> → '+esc(x.toSceneId)+'</li>').join("")+'</ul>'}
function renderElement(el){if(!el)return;const users=graph.operators.filter(x=>(x.operation.type==="tap"||x.operation.type==="long_press")&&x.operation.elementId===el.elementId);details.innerHTML='<h2>'+esc(el.title)+'</h2><div class="kv"><b>Element ID</b><span class="mono">'+esc(el.elementId)+'</span><b>Scene</b><span class="mono">'+esc(el.sceneId)+'</span><b>Role</b><span>'+esc(el.semanticRole)+'</span><b>Selector</b><span class="mono">'+esc(JSON.stringify(el.selector))+'</span></div><h3>Bindings</h3><ul class="list">'+el.bindings.map(x=>'<li><span class="mono">'+esc(x.deviceProfileId)+'</span><br>'+esc(JSON.stringify(x.normalizedPoint))+' · '+esc(x.status)+' · reliability '+x.reliability+'</li>').join("")+'</ul><h3>Used By Operators</h3><ul class="list">'+users.map(x=>'<li class="mono">'+esc(x.operatorId)+'</li>').join("")+'</ul>'}
function renderOperator(op){if(!op)return;const execution=op.execution||{tier:op.status==="verified"?"fast":"guarded",successfulExecutions:0,failedExecutions:0};details.innerHTML='<h2>'+esc(op.title)+'</h2><div class="kv"><b>Operator ID</b><span class="mono">'+esc(op.operatorId)+'</span><b>Transition</b><span class="mono">'+esc(op.fromSceneId)+' → '+esc(op.toSceneId)+'</span><b>Risk</b><span>'+esc(op.risk)+'</span><b>Knowledge Status</b><span>'+esc(op.status)+'</span><b>Execution Tier</b><span>'+esc(execution.tier)+'</span><b>Successful Runs</b><span>'+execution.successfulExecutions+'</span><b>Failed Runs</b><span>'+execution.failedExecutions+'</span><b>Reliability</b><span>'+op.reliability+'</span><b>Operation</b><span class="mono">'+esc(JSON.stringify(op.operation))+'</span><b>Settle</b><span>'+op.settleMs+'ms</span></div><h3>Preconditions</h3><ul class="list">'+((op.preconditions||[]).map(x=>'<li class="mono">'+esc(x)+'</li>').join("")||'<li class="muted">none</li>')+'</ul><h3>Effects</h3><ul class="list">'+op.effects.map(x=>'<li class="mono">'+esc(x)+'</li>').join("")+'</ul><h3>Postconditions</h3><ul class="list">'+op.postconditions.map(x=>'<li class="mono">'+esc(x)+'</li>').join("")+'</ul>'}
function short(v,n){const s=String(v||"");return s.length<=n?s:s.slice(0,n-3)+"..."}function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}function cssEsc(v){return globalThis.CSS?.escape?globalThis.CSS.escape(v):String(v).replaceAll('"',"")}
document.getElementById("search").addEventListener("input",event=>{const q=event.target.value.trim().toLowerCase();for(const [key,el] of nodeEls){const [kind,id]=key.split(/:(.*)/s),data=kind==="scene"?sceneById.get(id):elementById.get(id),stateTerms=kind==="scene"?(data?.stateVariants||[]).flatMap(x=>[x.title,...x.facts,...x.visualTextAnchors]):[],hay=[id,data?.title,data?.semanticRole,...(data?.aliases||[]),...stateTerms].filter(Boolean).join(" ").toLowerCase();el.style.opacity=!q||hay.includes(q)?"1":".12"}document.querySelectorAll(".task-card").forEach(el=>{const t=taskById.get(el.dataset.taskId),hay=[t?.taskId,t?.title,t?.summary,...(t?.intents||[])].filter(Boolean).join(" ").toLowerCase();el.style.opacity=!q||hay.includes(q)?"1":".25"})});
document.getElementById("clear").addEventListener("click",()=>{clearSelection();details.innerHTML='<h2>Graph Details</h2><p class="muted">点击左侧 Task、中心 Scene/Element 或 Operator 边查看完整信息。</p>'});document.getElementById("fit").addEventListener("click",()=>{view=[0,0,width,height];svg.setAttribute("viewBox",view.join(" "))});
let drag=false,moved=false,sx=0,sy=0,lx=0,ly=0;svg.addEventListener("pointerdown",e=>{drag=true;moved=false;sx=lx=e.clientX;sy=ly=e.clientY;svg.setPointerCapture?.(e.pointerId)});svg.addEventListener("pointermove",e=>{if(!drag)return;if(Math.hypot(e.clientX-sx,e.clientY-sy)<4)return;moved=true;const kx=view[2]/svg.clientWidth,ky=view[3]/svg.clientHeight;view[0]-=(e.clientX-lx)*kx;view[1]-=(e.clientY-ly)*ky;lx=e.clientX;ly=e.clientY;svg.setAttribute("viewBox",view.join(" "))});svg.addEventListener("pointerup",e=>{drag=false;svg.releasePointerCapture?.(e.pointerId)});svg.addEventListener("wheel",e=>{e.preventDefault();const f=e.deltaY>0?1.12:.89,r=svg.getBoundingClientRect(),rx=(e.clientX-r.left)/r.width,ry=(e.clientY-r.top)/r.height;view[0]+=view[2]*rx*(1-f);view[1]+=view[3]*ry*(1-f);view[2]*=f;view[3]*=f;svg.setAttribute("viewBox",view.join(" "))},{passive:false});
}
const search=document.getElementById("search");
function filterStaticMap(){const q=search.value.trim().toLowerCase();document.querySelectorAll(".entity-row,.scene-card,.task-card").forEach(el=>{el.style.display=!q||el.textContent.toLowerCase().includes(q)?"":"none"});document.querySelectorAll(".module-section").forEach(section=>{const visible=[...section.querySelectorAll(".scene-card")].some(card=>card.style.display!=="none");section.style.display=!q||visible?"":"none"})}
search.addEventListener("input",filterStaticMap);
document.getElementById("clear").addEventListener("click",()=>{search.value="";filterStaticMap();location.hash=""});
document.getElementById("fit").addEventListener("click",()=>{document.getElementById("view-graph").checked=true;document.getElementById("zoom-100").checked=true});
if(mapRevision&&summaryFileName&&location.protocol.startsWith("http"))setInterval(async()=>{try{const response=await fetch(summaryFileName+"?ts="+Date.now(),{cache:"no-store"});if(!response.ok)return;const summary=await response.json();if(summary.generatedAt&&summary.generatedAt!==mapRevision)location.reload()}catch{}},2000);
runtimeStatus.textContent="Interactive JS: READY";runtimeStatus.className="runtime ready";runtimeBeacon("runtime-ready");
</script>
</body>
</html>`;
}

export function externalizeInteractiveScript(html: string): {
  html: string;
  script: string;
} {
  const scripts = Array.from(
    html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g),
  );
  const interactive = scripts.at(-1);
  if (!interactive || interactive.index === undefined) {
    throw new Error(
      "Executable semantic map is missing its interactive script.",
    );
  }
  const source = interactive[0];
  const script = interactive[1] ?? "";
  const revision = html
    .match(/<meta name="semantic-map-revision" content="([^"]+)">/)?.[1]
    ?.trim();
  const assetVersion = revision ? `?v=${encodeURIComponent(revision)}` : "";
  const replacement = `<link rel="stylesheet" href="obsidian-map.css${assetVersion}">\n<script src="obsidian-map.js${assetVersion}" defer></script>`;
  return {
    html: `${html.slice(0, interactive.index)}${replacement}${html.slice(
      interactive.index + source.length,
    )}`,
    script,
  };
}

function renderStaticTaskCards(graph: ExecutableUiGraphExperiment): string {
  return graph.tasks
    .map(
      (task, taskIndex) =>
        `<a class="task-card" href="#detail-task-${safeSegment(task.taskId)}" data-task-id="${escapeHtml(task.taskId)}" data-task-path="${taskIndex}"><div class="task-title">${escapeHtml(task.title)}</div><div class="task-id">${escapeHtml(task.taskId)}</div><div class="task-meta">${task.operatorIds.length} steps · ${escapeHtml(task.status)}</div></a>`,
    )
    .join("");
}

function summarizeDiscoveryCoverage(
  state: IosUiCrawlerState,
): SemanticMapCoverage {
  return {
    scannedScenes: state.sceneFrontiers.filter(
      (frontier) => frontier.status === "scanned",
    ).length,
    blockedScenes: state.sceneFrontiers.filter(
      (frontier) => frontier.status === "blocked",
    ).length,
    pendingScenes: state.sceneFrontiers.filter(
      (frontier) =>
        frontier.status === "pending_scan" ||
        frontier.status === "scanning" ||
        frontier.status === "failed",
    ).length,
    completedActions: state.actionFrontiers.filter(
      (frontier) => frontier.status === "completed",
    ).length,
    blockedActions: state.actionFrontiers.filter(
      (frontier) => frontier.status === "blocked",
    ).length,
    backlogActions: state.actionFrontiers.filter(
      (frontier) =>
        frontier.status === "pending" ||
        frontier.status === "running" ||
        frontier.status === "failed",
    ).length,
    skippedActions: state.actionFrontiers.filter(
      (frontier) => frontier.status === "skipped",
    ).length,
    sessionCount: state.sessionCount,
  };
}

function renderCoveragePanel(
  graph: ExecutableUiGraphExperiment,
  coverage?: SemanticMapCoverage,
): string {
  const stateVariantCount = graph.scenes.reduce(
    (total, scene) => total + (scene.stateVariants?.length ?? 0),
    0,
  );
  const stats = coverage
    ? [
        [coverage.scannedScenes, "scanned scenes"],
        [coverage.blockedScenes, "conditional blocked"],
        [coverage.completedActions, "completed actions"],
        [coverage.backlogActions, "action backlog"],
        [coverage.skippedActions, "deduped / skipped"],
        [stateVariantCount, "state variants"],
      ]
    : [
        [
          graph.scenes.filter((scene) => scene.status === "verified").length,
          "verified scenes",
        ],
        [
          graph.scenes.filter((scene) => scene.status === "candidate").length,
          "candidate scenes",
        ],
        [
          graph.operators.filter((operator) => operator.status === "verified")
            .length,
          "verified operators",
        ],
        [
          graph.operators.filter((operator) => operator.status === "candidate")
            .length,
          "candidate operators",
        ],
        [graph.elements.length, "elements"],
        [stateVariantCount, "state variants"],
      ];
  return `<section class="coverage"><h3>${coverage ? `Crawler · ${coverage.sessionCount ?? 0} sessions` : "Graph Coverage"}</h3><div class="coverage-grid">${stats.map(([value, label]) => `<div class="coverage-stat"><div class="coverage-value">${value}</div><div class="coverage-label">${label}</div></div>`).join("")}</div></section>`;
}

interface MapModule {
  readonly moduleId:
    | "chat"
    | "skills"
    | "settings"
    | "camera"
    | "photo-files"
    | "cloud-drive"
    | "other";
  readonly title: string;
  readonly sceneIds: readonly string[];
}

function collectMapModules(graph: ExecutableUiGraphExperiment): MapModule[] {
  const definitions = [
    {
      moduleId: "chat" as const,
      title: "Chat & Messaging",
      matches: (sceneId: string) => sceneId.startsWith("chat."),
    },
    {
      moduleId: "skills" as const,
      title: "Skills",
      matches: (sceneId: string) => sceneId.startsWith("skills."),
    },
    {
      moduleId: "settings" as const,
      title: "Bot Settings",
      matches: (sceneId: string) => sceneId.startsWith("bot.settings"),
    },
    {
      moduleId: "camera" as const,
      title: "Camera",
      matches: (sceneId: string) => sceneId.startsWith("camera."),
    },
    {
      moduleId: "photo-files" as const,
      title: "Photos & Files",
      matches: (sceneId: string) =>
        sceneId.startsWith("photo.") || sceneId.startsWith("file."),
    },
    {
      moduleId: "cloud-drive" as const,
      title: "Cloud Drive",
      matches: (sceneId: string) => sceneId.startsWith("cloud.drive"),
    },
  ];
  const assigned = new Set<string>();
  const modules: MapModule[] = definitions.map((definition) => {
    const sceneIds = graph.scenes
      .filter((scene) => definition.matches(scene.sceneId))
      .map((scene) => scene.sceneId);
    for (const sceneId of sceneIds) {
      assigned.add(sceneId);
    }
    return {
      moduleId: definition.moduleId,
      title: definition.title,
      sceneIds,
    };
  });
  const otherSceneIds = graph.scenes
    .map((scene) => scene.sceneId)
    .filter((sceneId) => !assigned.has(sceneId));
  if (otherSceneIds.length > 0) {
    modules.push({
      moduleId: "other",
      title: "Other",
      sceneIds: otherSceneIds,
    });
  }
  return modules.filter((module) => module.sceneIds.length > 0);
}

function renderEntityBoard(
  graph: ExecutableUiGraphExperiment,
  kind: "elements" | "states" | "operators",
): string {
  const sceneById = new Map(
    graph.scenes.map((scene) => [scene.sceneId, scene]),
  );
  const modules = collectMapModules(graph);
  return `<div class="inventory">${modules
    .map((module) => {
      const sceneCards = module.sceneIds
        .map((sceneId) => {
          const scene = sceneById.get(sceneId)!;
          const elements = graph.elements.filter(
            (element) => element.sceneId === sceneId,
          );
          const variants = scene.stateVariants ?? [];
          const operators = graph.operators.filter(
            (operator) => operator.fromSceneId === sceneId,
          );
          const entities =
            kind === "elements"
              ? elements.map((element) => renderElementRow(element, graph))
              : kind === "states"
                ? variants.map(
                    (variant, index) =>
                      `<a class="entity-row state-row" href="#detail-state-${safeSegment(scene.sceneId)}-${index}"><div class="entity-title">${escapeHtml(variant.title)}</div><div class="entity-meta">${escapeHtml(variant.facts.join(" · ") || "visual state")}</div></a>`,
                  )
                : operators.map(
                    (operator) =>
                      `<a class="entity-row operator-row ${escapeHtml(operator.risk)}" href="#detail-operator-${safeSegment(operator.operatorId)}"><div class="entity-title">${escapeHtml(operator.title)}</div><div class="entity-meta">${escapeHtml(operator.toSceneId)} · ${escapeHtml(operator.status)} · ${escapeHtml(operator.risk)}</div></a>`,
                  );
          if (entities.length === 0 && kind !== "elements") {
            return "";
          }
          return `<article class="scene-card ${escapeHtml(scene.status)}"><a class="scene-card-header" href="#detail-scene-${safeSegment(scene.sceneId)}"><div><div class="scene-card-title">${escapeHtml(scene.title)}</div><div class="scene-card-id">${escapeHtml(scene.sceneId)}</div></div><div class="scene-card-counts">${elements.length} el · ${variants.length} st · ${operators.length} op</div></a><div class="entity-list">${entities.join("") || '<span class="muted">No stable elements</span>'}</div></article>`;
        })
        .filter(Boolean)
        .join("");
      const elementCount = graph.elements.filter((element) =>
        module.sceneIds.includes(element.sceneId),
      ).length;
      const stateCount = graph.scenes
        .filter((scene) => module.sceneIds.includes(scene.sceneId))
        .reduce(
          (total, scene) => total + (scene.stateVariants?.length ?? 0),
          0,
        );
      const operatorCount = graph.operators.filter((operator) =>
        module.sceneIds.includes(operator.fromSceneId),
      ).length;
      return `<section class="module-section" data-module="${module.moduleId}"><div class="module-heading"><h2>${escapeHtml(module.title)}</h2><span>${module.sceneIds.length} scenes · ${elementCount} elements · ${stateCount} states · ${operatorCount} operators</span></div><div class="scene-grid">${sceneCards || '<span class="muted">No entities in this view</span>'}</div></section>`;
    })
    .join("")}</div>`;
}

function renderElementRow(
  element: ExperimentElement,
  graph: ExecutableUiGraphExperiment,
): string {
  const usedBy = graph.operators.filter(
    (operator) =>
      (operator.operation.type === "tap" ||
        operator.operation.type === "long_press") &&
      operator.operation.elementId === element.elementId,
  ).length;
  const bindingStatus = element.bindings.some(
    (binding) => binding.status === "verified",
  )
    ? "verified"
    : "candidate";
  return `<a class="entity-row element-row" href="#detail-element-${safeSegment(element.elementId)}"><div class="entity-title">${escapeHtml(element.title)}</div><div class="entity-meta">${escapeHtml(element.semanticRole)} · ${bindingStatus} binding · ${usedBy} operators</div></a>`;
}

function renderStaticGraphSvg(graph: ExecutableUiGraphExperiment): {
  svg: string;
  width: number;
  height: number;
} {
  const taskPaths = collectTaskPathMemberships(graph);
  const modules = collectMapModules(graph);
  const positions = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();
  const sceneWidth = 238;
  const sceneHeight = 94;
  const columns = 3;
  const moduleX = 36;
  const moduleWidth = 900;
  const moduleGap = 30;
  const sceneGapX = 278;
  const sceneGapY = 126;
  let moduleY = 34;
  const moduleBands: string[] = [];
  for (const module of modules) {
    const scenes = module.sceneIds
      .map((sceneId) => graph.scenes.find((scene) => scene.sceneId === sceneId))
      .filter((scene): scene is ExperimentScene => Boolean(scene))
      .sort((left, right) => left.sceneId.localeCompare(right.sceneId));
    const rows = Math.ceil(scenes.length / columns);
    const moduleHeight = 76 + rows * sceneGapY + 18;
    const moduleElementCount = graph.elements.filter((element) =>
      module.sceneIds.includes(element.sceneId),
    ).length;
    const moduleStateCount = scenes.reduce(
      (total, scene) => total + (scene.stateVariants?.length ?? 0),
      0,
    );
    const moduleOperatorCount = graph.operators.filter((operator) =>
      module.sceneIds.includes(operator.fromSceneId),
    ).length;
    moduleBands.push(
      `<g class="module"><rect class="module-band" x="${moduleX}" y="${moduleY}" width="${moduleWidth}" height="${moduleHeight}"></rect><text class="module-title" x="${moduleX + 18}" y="${moduleY + 27}">${escapeHtml(module.title)}</text><text class="module-meta" x="${moduleX + 18}" y="${moduleY + 47}">${scenes.length} scenes · ${moduleElementCount} elements · ${moduleStateCount} states · ${moduleOperatorCount} operators</text></g>`,
    );
    for (const [index, scene] of scenes.entries()) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      positions.set(scene.sceneId, {
        x: moduleX + 34 + column * sceneGapX,
        y: moduleY + 64 + row * sceneGapY,
        width: sceneWidth,
        height: sceneHeight,
      });
    }
    moduleY += moduleHeight + moduleGap;
  }
  const boxes = [...positions.values()];
  const width = Math.max(1020, ...boxes.map((box) => box.x + box.width)) + 80;
  const height = Math.max(760, moduleY) + 40;
  const paths: string[] = [];
  for (const operator of graph.operators) {
    const from = positions.get(operator.fromSceneId);
    const to = positions.get(operator.toSceneId);
    if (!from || !to) {
      continue;
    }
    const kind = staticOperatorKind(operator);
    if (operator.fromSceneId === operator.toSceneId) {
      const startX = from.x + from.width;
      const centerY = from.y + from.height / 2;
      paths.push(
        `<a href="#detail-operator-${safeSegment(operator.operatorId)}"><path class="edge ${kind}" data-task-paths="${taskPathIndexes(taskPaths.operatorIndexes, operator.operatorId)}" d="M ${startX} ${centerY} C ${startX + 54} ${from.y - 28}, ${startX + 54} ${from.y + from.height + 28}, ${startX} ${centerY}"><title>${escapeHtml(operator.operatorId)}</title></path></a>`,
      );
      continue;
    }
    const fromCenter = {
      x: from.x + from.width / 2,
      y: from.y + from.height / 2,
    };
    const toCenter = {
      x: to.x + to.width / 2,
      y: to.y + to.height / 2,
    };
    const horizontal =
      Math.abs(toCenter.x - fromCenter.x) >=
      Math.abs(toCenter.y - fromCenter.y);
    const startX = horizontal
      ? toCenter.x >= fromCenter.x
        ? from.x + from.width
        : from.x
      : fromCenter.x;
    const startY = horizontal
      ? fromCenter.y
      : toCenter.y >= fromCenter.y
        ? from.y + from.height
        : from.y;
    const endX = horizontal
      ? toCenter.x >= fromCenter.x
        ? to.x
        : to.x + to.width
      : toCenter.x;
    const endY = horizontal
      ? toCenter.y
      : toCenter.y >= fromCenter.y
        ? to.y
        : to.y + to.height;
    const control = Math.max(
      36,
      horizontal ? Math.abs(endX - startX) / 2 : Math.abs(endY - startY) / 2,
    );
    paths.push(
      `<a href="#detail-operator-${safeSegment(operator.operatorId)}"><path class="edge ${kind}" data-task-paths="${taskPathIndexes(taskPaths.operatorIndexes, operator.operatorId)}" d="${horizontal ? `M ${startX} ${startY} C ${startX + Math.sign(endX - startX) * control} ${startY}, ${endX - Math.sign(endX - startX) * control} ${endY}, ${endX} ${endY}` : `M ${startX} ${startY} C ${startX} ${startY + Math.sign(endY - startY) * control}, ${endX} ${endY - Math.sign(endY - startY) * control}, ${endX} ${endY}`}"><title>${escapeHtml(operator.operatorId)}</title></path></a>`,
    );
  }
  const sceneNodes = graph.scenes.map((scene) => {
    const position = positions.get(scene.sceneId)!;
    const elementCount = graph.elements.filter(
      (element) => element.sceneId === scene.sceneId,
    ).length;
    const stateCount = scene.stateVariants?.length ?? 0;
    const outgoingCount = graph.operators.filter(
      (operator) => operator.fromSceneId === scene.sceneId,
    ).length;
    return `<a href="#detail-scene-${safeSegment(scene.sceneId)}"><g class="node scene ${escapeHtml(scene.status)}" data-task-paths="${taskPathIndexes(taskPaths.sceneIndexes, scene.sceneId)}" transform="translate(${position.x},${position.y})"><rect width="${position.width}" height="${position.height}"></rect><text x="12" y="27">${escapeHtml(shortText(scene.title, 29))}</text><text class="sub" x="12" y="49">${escapeHtml(shortText(scene.sceneId, 32))}</text><text class="badge" x="${position.width - 12}" y="18" text-anchor="end">${escapeHtml(scene.status)}</text><text class="sub" x="12" y="70">${elementCount} elements · ${stateCount} states</text><text class="sub" x="12" y="85">${outgoingCount} outgoing operators</text></g></a>`;
  });
  return {
    svg: `<svg id="map" aria-label="iOS executable semantic UI graph" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="context-stroke"></path></marker></defs>${moduleBands.join("")}${paths.join("")}${sceneNodes.join("")}</svg>`,
    width,
    height,
  };
}

function renderStaticZoomCss(width: number, height: number): string {
  const levels = [
    ["zoom-50", 0.5],
    ["zoom-75", 0.75],
    ["zoom-100", 1],
    ["zoom-150", 1.5],
    ["zoom-200", 2],
  ] as const;
  return levels
    .map(
      ([id, scale]) =>
        `#${id}:checked~.canvas-scroll .canvas-scale{width:${Math.round(width * scale)}px;height:${Math.round(height * scale)}px}`,
    )
    .join("");
}

function renderStaticTaskPathCss(graph: ExecutableUiGraphExperiment): string {
  return graph.tasks
    .map(
      (_, taskIndex) =>
        `.layout:has(.detail-card[data-task-target="${taskIndex}"]:target) .task-card{opacity:.32}.layout:has(.detail-card[data-task-target="${taskIndex}"]:target) .task-card[data-task-path="${taskIndex}"]{opacity:1;border-color:#2563eb;background:#eff6ff;box-shadow:0 0 0 2px #bfdbfe}.layout:has(.detail-card[data-task-target="${taskIndex}"]:target) #map .edge,.layout:has(.detail-card[data-task-target="${taskIndex}"]:target) #map .node{opacity:.08;transition:opacity .16s ease}.layout:has(.detail-card[data-task-target="${taskIndex}"]:target) #map .edge[data-task-paths~="${taskIndex}"],.layout:has(.detail-card[data-task-target="${taskIndex}"]:target) #map .node[data-task-paths~="${taskIndex}"]{opacity:1}.layout:has(.detail-card[data-task-target="${taskIndex}"]:target) #map .edge[data-task-paths~="${taskIndex}"]{stroke-width:5;filter:drop-shadow(0 0 3px #7c3aed)}.layout:has(.detail-card[data-task-target="${taskIndex}"]:target) #map .node[data-task-paths~="${taskIndex}"] rect{stroke:#7c3aed;stroke-width:3.2;filter:drop-shadow(0 0 3px #a78bfa)}`,
    )
    .join("");
}

function renderStaticDetails(graph: ExecutableUiGraphExperiment): string {
  const tasks = graph.tasks
    .map((task, taskIndex) => {
      const sequence = task.operatorIds
        .map((operatorId) => {
          const operator = graph.operators.find(
            (candidate) => candidate.operatorId === operatorId,
          );
          return `<li><span class="mono">${escapeHtml(operatorId)}</span><br>${escapeHtml(operator?.title ?? "")}</li>`;
        })
        .join("");
      const validation = task.validation
        ? `<h3>Validation</h3><div class="kv"><b>Source</b><span>${escapeHtml(task.validation.source)}</span><b>Successful Runs</b><span>${task.validation.successfulExecutions}</span><b>Fixture Replay</b><span>${task.validation.requiresFixtureReplay ? "required" : "not required"}</span><b>Completion</b><span class="mono">${escapeHtml(JSON.stringify(task.validation.completionOracle ?? {}))}</span></div>`
        : "";
      const verifier = task.verifier
        ? `<h3>Agent Verifier</h3><div class="kv"><b>Status</b><span>${escapeHtml(task.verifier.status)}</span><b>Confidence</b><span>${task.verifier.confidence}</span><b>Successful Runs</b><span>${task.verifier.successfulExecutions}</span><b>Assertions</b><span class="mono">${escapeHtml(JSON.stringify(task.verifier.assertions))}</span></div>`
        : "";
      return `<section class="detail-card" id="detail-task-${safeSegment(task.taskId)}" data-task-target="${taskIndex}"><h2>${escapeHtml(task.title)}</h2><div class="kv"><b>Task ID</b><span class="mono">${escapeHtml(task.taskId)}</span><b>Status</b><span>${escapeHtml(task.status)}</span><b>Entry Scene</b><span class="mono">${escapeHtml(task.entrySceneId)}</span><b>Summary</b><span>${escapeHtml(task.summary)}</span></div><h3>Execution Sequence</h3><ol class="sequence">${sequence}</ol><h3>Final Oracles</h3><ul class="list">${task.finalOracles.map((oracle) => `<li class="mono">${escapeHtml(JSON.stringify(oracle))}</li>`).join("")}</ul>${verifier}${validation}<a class="back-top" href="#">返回总览</a></section>`;
    })
    .join("");
  const scenes = graph.scenes
    .map((scene) => {
      const elements = graph.elements.filter(
        (element) => element.sceneId === scene.sceneId,
      );
      const operators = graph.operators.filter(
        (operator) => operator.fromSceneId === scene.sceneId,
      );
      const screenshot = scene.referenceAssets.find(
        (asset) => asset.screenshotPath,
      )?.screenshotPath;
      const variants = scene.stateVariants ?? [];
      return `<section class="detail-card" id="detail-scene-${safeSegment(scene.sceneId)}"><h2>${escapeHtml(scene.title)}</h2><div class="kv"><b>Scene ID</b><span class="mono">${escapeHtml(scene.sceneId)}</span><b>Status</b><span>${escapeHtml(scene.status)}</span><b>Elements</b><span>${elements.length}</span><b>Outgoing</b><span>${operators.length}</span><b>State Variants</b><span>${variants.length}</span></div>${screenshot ? `<h3>Reference Screenshot</h3><img class="preview" src="${escapeHtml(screenshot)}">` : ""}<h3>Visual Anchors</h3><div>${(scene.visualTextAnchors ?? []).map((anchor) => `<span class="pill">${escapeHtml(anchor)}</span>`).join("")}</div><h3>State Variants</h3><ul class="list">${variants.map((variant) => `<li><b>${escapeHtml(variant.title)}</b><br><span class="mono">${escapeHtml(variant.facts.join(" · "))}</span><br>${variant.visualTextAnchors.map((anchor) => `<span class="pill">${escapeHtml(anchor)}</span>`).join("")}</li>`).join("") || '<li class="muted">none</li>'}</ul><h3>Elements</h3><ul class="list">${elements.map((element) => `<li><span class="mono">${escapeHtml(element.elementId)}</span> · ${escapeHtml(element.title)}</li>`).join("")}</ul><h3>Outgoing Operators</h3><ul class="list">${operators.map((operator) => `<li><a href="#detail-operator-${safeSegment(operator.operatorId)}" class="mono">${escapeHtml(operator.operatorId)}</a> → ${escapeHtml(operator.toSceneId)}</li>`).join("")}</ul><a class="back-top" href="#">返回总览</a></section>`;
    })
    .join("");
  const elements = graph.elements
    .map((element) => {
      const operators = graph.operators.filter(
        (operator) =>
          (operator.operation.type === "tap" ||
            operator.operation.type === "long_press") &&
          operator.operation.elementId === element.elementId,
      );
      return `<section class="detail-card" id="detail-element-${safeSegment(element.elementId)}"><h2>${escapeHtml(element.title)}</h2><div class="kv"><b>Element ID</b><span class="mono">${escapeHtml(element.elementId)}</span><b>Scene</b><span><a href="#detail-scene-${safeSegment(element.sceneId)}" class="mono">${escapeHtml(element.sceneId)}</a></span><b>Role</b><span>${escapeHtml(element.semanticRole)}</span><b>Selector</b><span class="mono">${escapeHtml(JSON.stringify(element.selector))}</span></div><h3>Bindings</h3><ul class="list">${element.bindings.map((binding) => `<li><b>${escapeHtml(binding.deviceProfileId)}</b><br><span class="mono">${escapeHtml(JSON.stringify(binding.normalizedPoint))}</span><br>${escapeHtml(binding.status)} · ${escapeHtml(binding.source)} · reliability ${binding.reliability}</li>`).join("") || '<li class="muted">none</li>'}</ul><h3>Used By Operators</h3><ul class="list">${operators.map((operator) => `<li><a href="#detail-operator-${safeSegment(operator.operatorId)}" class="mono">${escapeHtml(operator.operatorId)}</a><br>${escapeHtml(operator.title)}</li>`).join("") || '<li class="muted">none</li>'}</ul><a class="back-top" href="#">返回总览</a></section>`;
    })
    .join("");
  const states = graph.scenes
    .flatMap((scene) =>
      (scene.stateVariants ?? []).map((variant, index) => {
        const screenshot = variant.referenceAssets?.find(
          (asset) => asset.screenshotPath,
        )?.screenshotPath;
        return `<section class="detail-card" id="detail-state-${safeSegment(scene.sceneId)}-${index}"><h2>${escapeHtml(variant.title)}</h2><div class="kv"><b>Base Scene</b><span><a href="#detail-scene-${safeSegment(scene.sceneId)}" class="mono">${escapeHtml(scene.sceneId)}</a></span><b>Facts</b><span class="mono">${escapeHtml(variant.facts.join(" · ") || "visual state")}</span><b>Anchors</b><span>${variant.visualTextAnchors.map((anchor) => `<span class="pill">${escapeHtml(anchor)}</span>`).join("") || "none"}</span></div>${screenshot ? `<h3>Reference Screenshot</h3><img class="preview" src="${escapeHtml(screenshot)}">` : ""}<h3>Reference Assets</h3><ul class="list">${(variant.referenceAssets ?? []).map((asset) => `<li class="mono">${escapeHtml(asset.screenshotPath ?? asset.uiDumpPath ?? asset.recordPath ?? "unknown")}</li>`).join("") || '<li class="muted">none</li>'}</ul><a class="back-top" href="#">返回总览</a></section>`;
      }),
    )
    .join("");
  const operators = graph.operators
    .map(
      (operator) =>
        `<section class="detail-card" id="detail-operator-${safeSegment(operator.operatorId)}"><h2>${escapeHtml(operator.title)}</h2><div class="kv"><b>Operator ID</b><span class="mono">${escapeHtml(operator.operatorId)}</span><b>Transition</b><span class="mono">${escapeHtml(operator.fromSceneId)} → ${escapeHtml(operator.toSceneId)}</span><b>Risk</b><span>${escapeHtml(operator.risk)}</span><b>Knowledge Status</b><span>${escapeHtml(operator.status)}</span><b>Execution Tier</b><span>${escapeHtml(operator.execution?.tier ?? (operator.status === "verified" ? "fast" : "guarded"))}</span><b>Successful Runs</b><span>${operator.execution?.successfulExecutions ?? 0}</span><b>Failed Runs</b><span>${operator.execution?.failedExecutions ?? 0}</span><b>Reliability</b><span>${operator.reliability}</span><b>Operation</b><span class="mono">${escapeHtml(JSON.stringify(operator.operation))}</span></div><h3>Preconditions</h3><ul class="list">${(operator.preconditions ?? []).map((condition) => `<li class="mono">${escapeHtml(condition)}</li>`).join("") || '<li class="muted">none</li>'}</ul><h3>Effects</h3><ul class="list">${operator.effects.map((effect) => `<li class="mono">${escapeHtml(effect)}</li>`).join("")}</ul><h3>Postconditions</h3><ul class="list">${operator.postconditions.map((condition) => `<li class="mono">${escapeHtml(condition)}</li>`).join("")}</ul><a class="back-top" href="#">返回总览</a></section>`,
    )
    .join("");
  return `${tasks}${scenes}${elements}${states}${operators}`;
}

function collectTaskPathMemberships(graph: ExecutableUiGraphExperiment): {
  sceneIndexes: ReadonlyMap<string, ReadonlySet<number>>;
  operatorIndexes: ReadonlyMap<string, ReadonlySet<number>>;
} {
  const operatorById = new Map(
    graph.operators.map((operator) => [operator.operatorId, operator]),
  );
  const sceneIndexes = new Map<string, Set<number>>();
  const operatorIndexes = new Map<string, Set<number>>();
  const addIndex = (
    memberships: Map<string, Set<number>>,
    entityId: string,
    taskIndex: number,
  ): void => {
    const indexes = memberships.get(entityId) ?? new Set<number>();
    indexes.add(taskIndex);
    memberships.set(entityId, indexes);
  };
  for (const [taskIndex, task] of graph.tasks.entries()) {
    addIndex(sceneIndexes, task.entrySceneId, taskIndex);
    for (const operatorId of task.operatorIds) {
      const operator = operatorById.get(operatorId);
      if (!operator) {
        continue;
      }
      addIndex(operatorIndexes, operatorId, taskIndex);
      addIndex(sceneIndexes, operator.fromSceneId, taskIndex);
      addIndex(sceneIndexes, operator.toSceneId, taskIndex);
    }
  }
  return { sceneIndexes, operatorIndexes };
}

function taskPathIndexes(
  memberships: ReadonlyMap<string, ReadonlySet<number>>,
  entityId: string,
): string {
  return [...(memberships.get(entityId) ?? [])].join(" ");
}

function staticOperatorKind(operator: ExperimentOperator): string {
  if (operator.risk === "mutation") {
    return "mutation";
  }
  if (operator.risk === "selection") {
    return "selection";
  }
  if (operator.operatorId.includes("permission")) {
    return "permission";
  }
  if (operator.risk === "navigation") {
    return "navigation";
  }
  return "interaction";
}

function shortText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}

function validateGraph(graph: ExecutableUiGraphExperiment): void {
  if (graph.schemaVersion !== "ios-executable-ui-graph-experiment/v1") {
    throw new Error(`Unsupported executable graph: ${graph.schemaVersion}.`);
  }
  const sceneIds = new Set(graph.scenes.map((scene) => scene.sceneId));
  const elementIds = new Set(
    graph.elements.map((element) => element.elementId),
  );
  const operatorIds = new Set(
    graph.operators.map((operator) => operator.operatorId),
  );
  for (const element of graph.elements) {
    if (!sceneIds.has(element.sceneId)) {
      throw new Error(
        `Element ${element.elementId} references unknown Scene ${element.sceneId}.`,
      );
    }
  }
  for (const operator of graph.operators) {
    if (
      !sceneIds.has(operator.fromSceneId) ||
      !sceneIds.has(operator.toSceneId)
    ) {
      throw new Error(
        `Operator ${operator.operatorId} references an unknown Scene.`,
      );
    }
    if (
      (operator.operation.type === "tap" ||
        operator.operation.type === "long_press") &&
      !elementIds.has(operator.operation.elementId)
    ) {
      throw new Error(
        `Operator ${operator.operatorId} references unknown Element ${operator.operation.elementId}.`,
      );
    }
  }
  for (const task of graph.tasks) {
    for (const operatorId of task.operatorIds) {
      if (!operatorIds.has(operatorId)) {
        throw new Error(
          `Task ${task.taskId} references unknown Operator ${operatorId}.`,
        );
      }
    }
  }
}

function safeEmbeddedJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requiredText(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new TypeError(`iOS UI Semantic Map Report requires ${name}.`);
  }
  return trimmed;
}

function safeSegment(value: string): string {
  return (
    value.replaceAll(/[^A-Za-z0-9_.-]+/g, "-").replaceAll(/^-+|-+$/g, "") ||
    "item"
  );
}
