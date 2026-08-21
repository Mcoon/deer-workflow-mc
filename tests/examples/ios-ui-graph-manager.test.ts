import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyAndSave,
  promoteReferenceAsset,
  resolveGraphAssetPath,
  retainValidReferenceAssets,
} from "../../examples/ios-ui-graph-manager";
import { planRoute } from "../../examples/ios-ui-graph-manager/route";
import { validateGraph } from "../../examples/ios-ui-graph-manager/validate";
import type { AppGraph } from "../../examples/ios-ui-graph-manager/types";

const minimalGraph: AppGraph = {
  schemaVersion: "ios-executable-ui-graph/v2",
  graphId: "test",
  bundleId: "com.test",
  revision: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  deviceProfiles: {
    "iphone-test": {
      profileId: "iphone-test",
      viewportWidth: 414,
      viewportHeight: 896,
    },
  },
  defaultDeviceProfileId: "iphone-test",
  defaultResetStrategyId: "reset.default",
  resetStrategies: [
    {
      strategyId: "reset.default",
      entrySceneId: "chat.detail",
      steps: [
        { type: "terminate_app", bundleId: "com.test" },
        { type: "wait", durationMs: 500 },
        { type: "launch_app", bundleId: "com.test" },
        { type: "wait", durationMs: 2500 },
      ],
    },
  ],
  scenes: {
    "chat.detail": {
      sceneId: "chat.detail",
      parentSceneId: null,
      status: "verified",
      title: "Chat",
      aliases: [],
      visualTextAnchors: ["Chat"],
      referenceAssets: [],
      elements: {
        "chat.input": {
          elementId: "chat.input",
          title: "Message Input",
          semanticRole: "input",
          status: "verified",
          selectors: [{ type: "label", value: "Message" }],
          bindings: {
            "iphone-test": {
              deviceProfileId: "iphone-test",
              normalizedPoint: { x: 0.5, y: 0.9 },
              source: "ui_dump",
              status: "verified",
            },
          },
        },
      },
    },
  },
  operators: {
    "chat.tap_input": {
      operatorId: "chat.tap_input",
      fromSceneId: "chat.detail",
      toSceneId: "chat.detail",
      operation: { type: "tap", elementId: "chat.input" },
      effects: [{ type: "state_change", key: "focused", value: true }],
      status: "verified",
      executionStats: { pass: 1, fail: 0 },
    },
  },
  tasks: {},
};

describe("validateGraph", () => {
  it("passes a valid graph", () => {
    const result = validateGraph(minimalGraph);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects non-object", () => {
    const result = validateGraph(null);
    expect(result.valid).toBe(false);
  });

  it("rejects wrong schema version", () => {
    const result = validateGraph({ ...minimalGraph, schemaVersion: "wrong" });
    expect(result.valid).toBe(false);
  });

  it("rejects missing graphId", () => {
    const result = validateGraph({ ...minimalGraph, graphId: "" });
    expect(result.valid).toBe(false);
  });

  it("rejects missing bundleId", () => {
    const result = validateGraph({ ...minimalGraph, bundleId: "" });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid revision", () => {
    const result = validateGraph({ ...minimalGraph, revision: 0 });
    expect(result.valid).toBe(false);
  });

  it("validates scene with element mismatch", () => {
    const g = JSON.parse(JSON.stringify(minimalGraph)) as Record<
      string,
      unknown
    >;
    ((g as Record<string, unknown>).scenes as Record<string, unknown>)[
      "chat.detail"
    ] = {
      ...minimalGraph.scenes["chat.detail"],
      sceneId: "wrong",
    };
    const result = validateGraph(g as unknown as AppGraph);
    expect(result.valid).toBe(false);
  });

  it("validates operator fromSceneId missing", () => {
    const g = JSON.parse(JSON.stringify(minimalGraph)) as Record<
      string,
      unknown
    >;
    ((g as Record<string, unknown>).operators as Record<string, unknown>)[
      "chat.tap_input"
    ] = {
      ...minimalGraph.operators["chat.tap_input"],
      fromSceneId: "nonexistent",
    };
    const result = validateGraph(g as unknown as AppGraph);
    expect(result.valid).toBe(false);
  });

  it("accepts a Scene with an external foreground bundle", () => {
    const graph = JSON.parse(JSON.stringify(minimalGraph)) as AppGraph;
    const scenes = graph.scenes as Record<string, AppGraph["scenes"][string]>;
    scenes["external.browser"] = {
      sceneId: "external.browser",
      parentSceneId: null,
      foregroundBundleId: "com.apple.mobilesafari",
      status: "verified",
      title: "External Browser",
      aliases: [],
      visualTextAnchors: ["Example"],
      referenceAssets: [],
      elements: {},
    };

    expect(validateGraph(graph).valid).toBe(true);
  });

  it("rejects an empty external foreground bundle", () => {
    const graph = JSON.parse(JSON.stringify(minimalGraph)) as AppGraph;
    const scene = graph.scenes["chat.detail"] as unknown as {
      foregroundBundleId?: string;
    };
    scene.foregroundBundleId = "";

    expect(validateGraph(graph).valid).toBe(false);
  });
});

describe("planRoute", () => {
  it("ignores stale, blocked, and disabled operators", () => {
    const graph = JSON.parse(JSON.stringify(minimalGraph)) as AppGraph;
    const routeGraph = graph as unknown as {
      scenes: Record<string, AppGraph["scenes"][string]>;
      operators: Record<string, AppGraph["operators"][string]>;
    };
    routeGraph.scenes.target = {
      sceneId: "target",
      parentSceneId: "chat.detail",
      status: "verified",
      title: "Target",
      aliases: [],
      visualTextAnchors: ["Target"],
      referenceAssets: [],
      elements: {},
    };
    for (const status of ["stale", "blocked", "disabled"] as const) {
      routeGraph.operators[`chat.${status}`] = {
        operatorId: `chat.${status}`,
        fromSceneId: "chat.detail",
        toSceneId: "target",
        operation: { type: "tap", elementId: "chat.input" },
        effects: [],
        status,
        executionStats: { pass: 0, fail: 0 },
      };
    }

    expect(planRoute(graph, "chat.detail", "target")).toBeNull();

    routeGraph.operators["chat.verified"] = {
      operatorId: "chat.verified",
      fromSceneId: "chat.detail",
      toSceneId: "target",
      operation: { type: "tap", elementId: "chat.input" },
      effects: [],
      status: "verified",
      executionStats: { pass: 1, fail: 0 },
    };

    expect(
      planRoute(graph, "chat.detail", "target")?.map((step) => step.operatorId),
    ).toEqual(["chat.verified"]);
  });
});

describe("reference assets", () => {
  it("promotes assets beside the Graph with stable relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "graph-assets-"));
    const graphPath = join(root, "graph.json");
    const screenshotPath = join(root, "runtime-screen.png");
    const uiDumpPath = join(root, "runtime-ui.json");
    await writeFile(screenshotPath, new Uint8Array([137, 80, 78, 71]));
    await writeFile(uiDumpPath, JSON.stringify({ label: "Chat" }));
    try {
      const first = await promoteReferenceAsset({
        graphPath,
        sceneId: "chat.detail",
        screenshotPath,
        uiDumpPath,
      });
      const second = await promoteReferenceAsset({
        graphPath,
        sceneId: "chat.detail",
        screenshotPath,
        uiDumpPath,
      });

      expect(second).toEqual(first);
      expect(first.screenshot).toMatch(
        /^reference-assets\/chat.detail\/[a-f0-9]{16}\/screenshot.png$/,
      );
      expect(
        await readFile(resolveGraphAssetPath(graphPath, first.uiDump), "utf8"),
      ).toBe(JSON.stringify({ label: "Chat" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops missing and duplicate references while respecting the limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "graph-assets-retain-"));
    const graphPath = join(root, "graph.json");
    const screenshotPath = join(root, "screen.png");
    const uiDumpPath = join(root, "ui.json");
    await writeFile(screenshotPath, new Uint8Array([1]));
    await writeFile(uiDumpPath, "{}");
    try {
      const valid = { screenshot: screenshotPath, uiDump: uiDumpPath };
      expect(
        await retainValidReferenceAssets({
          graphPath,
          assets: [
            { screenshot: join(root, "missing.png"), uiDump: uiDumpPath },
            valid,
            valid,
          ],
          maxReferences: 1,
        }),
      ).toEqual([valid]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists patch references as Graph-relative assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "graph-assets-patch-"));
    const graphPath = join(root, "graph.json");
    const screenshotPath = join(root, "runtime-screen.png");
    const uiDumpPath = join(root, "runtime-ui.json");
    await writeFile(graphPath, JSON.stringify(minimalGraph));
    await writeFile(screenshotPath, new Uint8Array([137, 80, 78, 71]));
    await writeFile(uiDumpPath, "{}");
    try {
      const result = await applyAndSave(graphPath, {
        schemaVersion: "ios-ui-graph-patch/v2",
        graphId: minimalGraph.graphId,
        baseRevision: minimalGraph.revision,
        source: "discovery",
        scenes: {
          "chat.detail": {
            sceneId: "chat.detail",
            referenceAssets: [
              { screenshot: screenshotPath, uiDump: uiDumpPath },
            ],
          },
        },
      });
      const saved = JSON.parse(await readFile(graphPath, "utf8")) as AppGraph;
      const reference = saved.scenes["chat.detail"]!.referenceAssets[0]!;

      expect(result.success).toBe(true);
      expect(reference.screenshot.startsWith("reference-assets/")).toBe(true);
      expect(
        await Bun.file(
          resolveGraphAssetPath(graphPath, reference.screenshot),
        ).exists(),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
