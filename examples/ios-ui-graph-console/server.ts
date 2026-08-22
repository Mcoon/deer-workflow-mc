import { extname, join, normalize, resolve } from "node:path";
import {
  getReferenceAssetsDir,
  loadGraph,
  resolveGraphAssetPath,
} from "../ios-ui-graph-manager";
import { renderAppGraphMapHtml } from "../app-graph-map-report/workflow";
import { listConnectedIosDevices } from "./devices";

import {
  GraphConsoleRunManager,
  applyGraphCorrectionProposal,
  graphRevision,
  runGraphConsoleChat,
} from "./console";

import type {
  GraphConsoleActionRequest,
  GraphConsoleChatRequest,
  GraphConsoleCorrectionProposal,
  GraphConsoleServerOptions,
} from "./types";

const DEFAULT_WORKFLOW_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_GRAPH_PATH = resolve(
  import.meta.dir,
  "../ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
);
const DEFAULT_MAP_DIRECTORY =
  "/Users/bytedance/Documents/BDWorkSpace/ios-perf-optimizer/assets/app-regression/com.bot.doubao/ui-map";
const DEFAULT_ARTIFACT_ROOT = "/tmp/ios_perf-opt/ios-ui-graph-console";
const ARTIFACT_FILE_ROOT = resolve("/tmp/ios_perf-opt");

interface NormalizedOptions {
  host: string;
  port: number;
  graphPath: string;
  mapDirectory: string;
  artifactRoot: string;
  planWorkflowPath: string;
  execWorkflowPath: string;
  appGraphWorkflowPath: string;
  discoveryWorkflowPath: string;
  udid?: string;
  deviceProfileId?: string;
  agentCwd: string;
  model?: string;
  agentTimeoutMs: number;
  deviceScanner: NonNullable<GraphConsoleServerOptions["deviceScanner"]>;
}

interface ClientRuntimeState {
  status: "ready" | "failed";
  detail: string;
  observedAt: string;
}

export function createGraphConsoleServer(
  options: GraphConsoleServerOptions = {},
) {
  const input = normalizeOptions(options);
  const proposalDirectory = join(input.artifactRoot, "correction-proposals");
  let clientRuntime: ClientRuntimeState | undefined;
  const runManager = new GraphConsoleRunManager({
    graphPath: input.graphPath,
    artifactRoot: join(input.artifactRoot, "runs"),
    planWorkflowPath: input.planWorkflowPath,
    execWorkflowPath: input.execWorkflowPath,
    appGraphWorkflowPath: input.appGraphWorkflowPath,
    discoveryWorkflowPath: input.discoveryWorkflowPath,
    agentCwd: input.agentCwd,
    model: input.model,
    agentTimeoutMs: input.agentTimeoutMs,
    udid: input.udid,
    deviceProfileId: input.deviceProfileId,
    deviceScanner: input.deviceScanner,
  });
  return Bun.serve({
    hostname: input.host,
    port: input.port,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (url.pathname === "/api/health" && request.method === "GET") {
          const graph = await loadGraph(input.graphPath);
          return json({
            ok: true,
            graphPath: input.graphPath,
            graphRevision: await graphRevision(input.graphPath),
            graphNumericRevision: graph.revision,
            clientRuntime,
          });
        }
        const runtimeMatch = url.pathname.match(
          /^\/(?:ui-map\/)?runtime-(ready|failed)$/,
        );
        if (runtimeMatch && request.method === "GET") {
          clientRuntime = {
            status: runtimeMatch[1] === "ready" ? "ready" : "failed",
            detail: url.searchParams.get("detail")?.slice(0, 500) ?? "",
            observedAt: new Date().toISOString(),
          };
          return json({ ok: true });
        }
        if (url.pathname === "/api/graph" && request.method === "GET") {
          return new Response(Bun.file(input.graphPath), {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
              "x-graph-revision": await graphRevision(input.graphPath),
            },
          });
        }
        if (url.pathname === "/api/devices" && request.method === "GET") {
          const devices = await runManager.listDevices();
          const defaultUdid = devices.some((device) => device.id === input.udid)
            ? input.udid
            : devices.length === 1
              ? devices[0]!.id
              : undefined;
          return json({ devices, defaultUdid });
        }
        if (url.pathname === "/api/artifact" && request.method === "GET") {
          return serveArtifact(url.searchParams.get("path"), input.graphPath);
        }
        if (url.pathname === "/api/actions" && request.method === "POST") {
          const body = await readJson<GraphConsoleActionRequest>(request);
          const run = await runManager.enqueue(body);
          return json(run, 202);
        }
        const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
        if (runMatch && request.method === "GET") {
          const run = runManager.get(decodeURIComponent(runMatch[1]!));
          return run ? json(run) : json({ error: "Run not found." }, 404);
        }
        const eventMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
        if (eventMatch && request.method === "GET") {
          const runId = decodeURIComponent(eventMatch[1]!);
          const run = runManager.get(runId);
          if (!run) {
            return json({ error: "Run not found." }, 404);
          }
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              const send = (event: unknown) => {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                );
              };
              for (const event of run.events) {
                send(event);
              }
              const remove = runManager.subscribe(runId, (event) => {
                send(event);
                if (
                  event.type === "run" &&
                  (event.status === "succeeded" || event.status === "failed")
                ) {
                  remove();
                  controller.close();
                }
              });
              request.signal.addEventListener(
                "abort",
                () => {
                  remove();
                  try {
                    controller.close();
                  } catch {
                    // The terminal event may already have closed the stream.
                  }
                },
                { once: true },
              );
              if (run.status === "succeeded" || run.status === "failed") {
                remove();
                controller.close();
              }
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        }
        if (url.pathname === "/api/chat" && request.method === "POST") {
          const body = await readJson<GraphConsoleChatRequest>(request);
          if (!body.message?.trim()) {
            return json({ error: "message is required." }, 400);
          }
          const response = await runGraphConsoleChat({
            graphPath: input.graphPath,
            request: body,
            proposalDirectory,
            agentCwd: input.agentCwd,
            model: input.model,
            timeoutMs: input.agentTimeoutMs,
            signal: request.signal,
          });
          return json(response);
        }
        const correctionMatch = url.pathname.match(
          /^\/api\/corrections\/([^/]+)\/apply$/,
        );
        if (correctionMatch && request.method === "POST") {
          const proposalId = decodeURIComponent(correctionMatch[1]!);
          const proposalPath = join(proposalDirectory, `${proposalId}.json`);
          if (!(await Bun.file(proposalPath).exists())) {
            return json({ error: "Correction proposal not found." }, 404);
          }
          const proposal = JSON.parse(
            await Bun.file(proposalPath).text(),
          ) as GraphConsoleCorrectionProposal;
          if (proposal.proposalId !== proposalId) {
            return json({ error: "Correction proposal ID mismatch." }, 400);
          }
          const result = await applyGraphCorrectionProposal({
            graphPath: input.graphPath,
            proposalPath,
            backupDirectory: join(input.artifactRoot, "graph-backups"),
          });
          return json(result);
        }
        if (request.method === "GET" || request.method === "HEAD") {
          if (
            url.pathname === "/" ||
            url.pathname === "/map.html" ||
            url.pathname === "/ui-map/map.html"
          ) {
            const graph = await loadGraph(input.graphPath);
            const scenes = Object.values(graph.scenes);
            const operators = Object.values(graph.operators);
            const tasks = Object.values(graph.tasks);
            const elements = scenes.flatMap((scene) =>
              Object.values(scene.elements),
            );
            const html = renderAppGraphMapHtml(
              graph,
              "App Graph v2",
              scenes,
              operators,
              tasks,
              elements,
              input.graphPath,
            );
            return request.method === "HEAD"
              ? new Response(null, {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    "cache-control": "no-store, max-age=0",
                  },
                })
              : new Response(html, {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    "cache-control": "no-store, max-age=0",
                  },
                });
          }
          return serveStatic(input.mapDirectory, url.pathname, request.method);
        }
        return json({ error: "Not found." }, 404);
      } catch (error) {
        return json(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          400,
        );
      }
    },
  });
}

async function serveArtifact(
  pathname: string | null,
  graphPath: string,
): Promise<Response> {
  if (!pathname?.trim()) {
    return json({ error: "Artifact path is required." }, 400);
  }
  const filePath = resolveGraphAssetPath(graphPath, pathname);
  const referenceAssetsRoot = getReferenceAssetsDir(graphPath);
  if (
    filePath !== ARTIFACT_FILE_ROOT &&
    !filePath.startsWith(`${ARTIFACT_FILE_ROOT}/`) &&
    filePath !== referenceAssetsRoot &&
    !filePath.startsWith(`${referenceAssetsRoot}/`)
  ) {
    return json(
      {
        error:
          "Artifact path is outside Graph reference assets and /tmp/ios_perf-opt.",
      },
      400,
    );
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return json({ error: "Artifact not found." }, 404);
  }
  return new Response(file, {
    headers: {
      "content-type": contentType(extname(filePath)),
      "cache-control": "no-store, max-age=0",
    },
  });
}

async function serveStatic(
  mapDirectory: string,
  pathname: string,
  method: string,
): Promise<Response> {
  const relativePath =
    pathname === "/" || pathname === "/map.html"
      ? "map.html"
      : normalize(decodeURIComponent(pathname))
          .replace(/^[/\\]+/, "")
          .replace(/^ui-map[/\\]/, "");
  const filePath = resolve(mapDirectory, relativePath);
  if (
    filePath !== resolve(mapDirectory) &&
    !filePath.startsWith(`${resolve(mapDirectory)}/`)
  ) {
    return json({ error: "Invalid path." }, 400);
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return json({ error: "Not found." }, 404);
  }
  const headers = {
    "content-type": contentType(extname(filePath)),
    "cache-control": "no-store, max-age=0",
  };
  return method === "HEAD"
    ? new Response(null, { headers })
    : new Response(file, { headers });
}

function normalizeOptions(
  options: GraphConsoleServerOptions,
): NormalizedOptions {
  return {
    host: options.host?.trim() || "127.0.0.1",
    port: options.port ?? 18765,
    graphPath: resolve(options.graphPath?.trim() || DEFAULT_GRAPH_PATH),
    mapDirectory: resolve(
      options.mapDirectory?.trim() || DEFAULT_MAP_DIRECTORY,
    ),
    artifactRoot: resolve(
      options.artifactRoot?.trim() || DEFAULT_ARTIFACT_ROOT,
    ),
    planWorkflowPath: resolve(
      options.planWorkflowPath?.trim() ||
        join(DEFAULT_WORKFLOW_ROOT, "examples/app-graph-plan/workflow.ts"),
    ),
    execWorkflowPath: resolve(
      options.execWorkflowPath?.trim() ||
        join(DEFAULT_WORKFLOW_ROOT, "examples/app-graph-exec/workflow.ts"),
    ),
    appGraphWorkflowPath: resolve(
      options.appGraphWorkflowPath?.trim() ||
        join(DEFAULT_WORKFLOW_ROOT, "examples/app-graph/workflow.ts"),
    ),
    discoveryWorkflowPath: resolve(
      options.discoveryWorkflowPath?.trim() ||
        join(DEFAULT_WORKFLOW_ROOT, "examples/app-graph-discovery/workflow.ts"),
    ),
    udid: options.udid?.trim() || undefined,
    deviceProfileId: options.deviceProfileId?.trim() || undefined,
    agentCwd: resolve(options.agentCwd?.trim() || DEFAULT_WORKFLOW_ROOT),
    model: options.model?.trim() || undefined,
    agentTimeoutMs: Math.max(1_000, options.agentTimeoutMs ?? 60_000),
    deviceScanner: options.deviceScanner ?? listConnectedIosDevices,
  };
}

async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) {
    throw new Error("JSON request body is required.");
  }
  return JSON.parse(text) as T;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

function contentType(extension: string): string {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    }[extension.toLocaleLowerCase()] ?? "application/octet-stream"
  );
}

if (import.meta.main) {
  const server = createGraphConsoleServer({
    host: Bun.env.IOS_UI_GRAPH_CONSOLE_HOST,
    port: Bun.env.IOS_UI_GRAPH_CONSOLE_PORT
      ? Number(Bun.env.IOS_UI_GRAPH_CONSOLE_PORT)
      : undefined,
    graphPath: Bun.env.IOS_UI_GRAPH_PATH,
    mapDirectory: Bun.env.IOS_UI_GRAPH_MAP_DIRECTORY,
    artifactRoot: Bun.env.IOS_UI_GRAPH_CONSOLE_ARTIFACT_ROOT,
    udid: Bun.env.IOS_UI_GRAPH_CONSOLE_UDID,
    deviceProfileId: Bun.env.IOS_UI_GRAPH_CONSOLE_DEVICE_PROFILE_ID,
    model: Bun.env.IOS_UI_GRAPH_CONSOLE_MODEL,
    agentTimeoutMs: Bun.env.IOS_UI_GRAPH_CONSOLE_AGENT_TIMEOUT_MS
      ? Number(Bun.env.IOS_UI_GRAPH_CONSOLE_AGENT_TIMEOUT_MS)
      : undefined,
  });
  console.log(`iOS UI Graph Console: ${server.url}`);
}
