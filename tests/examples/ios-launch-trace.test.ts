import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildCollectorCommand,
  buildThreadTimelines,
  buildTraceTimelineFromSamples,
  parseTraceTimeline,
  renderLaunchTraceHtml,
} from "../../examples/ios-launch-trace/workflow";
import type { TraceFrame } from "../../examples/ios-launch-trace/types";

describe("iOS Launch Trace report", () => {
  test("passes the Florak iOS build root to the collector", () => {
    const command = buildCollectorCommand({
      repositoryRoot: "/repo/Florak",
      projectRoot: "/repo/Florak/flow/ios",
      buildRoot: "/repo/Florak/flow/ios",
      udid: "device-1",
      bundleId: "com.bot.doubao",
      collectorScriptPath: "/tmp/collect_trace.py",
      python: "python3",
      appPath: "",
      dsymPath: "",
      timeLimit: "20s",
      skipInstall: false,
      outputDir: "/tmp/ios_perf-opt/ios-launch-trace/test",
      targetBinary: "Grace",
      htmlReportPath: "/tmp/report.html",
      maxSamples: 12000,
      maxDepth: 72,
    });

    expect(command).toContain("--project-root");
    expect(command[command.indexOf("--project-root") + 1]).toBe(
      "/repo/Florak/flow/ios",
    );
    expect(command).toContain("--build-root");
    expect(command[command.indexOf("--build-root") + 1]).toBe(
      "/repo/Florak/flow/ios",
    );
  });

  test("merges adjacent frame samples into timeline spans", () => {
    const main = frame("main", "Grace", true);
    const boot = frame("FlowBootManager.start", "Grace", true);
    const objc = frame("objc_msgSend", "libobjc.A.dylib", false);

    const timeline = buildTraceTimelineFromSamples(
      [
        [main, boot],
        [main, boot],
        [main, objc],
      ],
      { totalMainThreadRows: 3, sampleWeightsMs: [1, 1, 1] },
    );

    expect(timeline.renderedSamples).toBe(3);
    expect(timeline.maxDepth).toBe(2);
    expect(timeline.sampleDepths).toEqual([2, 2, 2]);
    expect(timeline.spans).toContainEqual(
      expect.objectContaining({
        name: "main",
        depth: 0,
        startSample: 0,
        endSample: 3,
      }),
    );
    expect(timeline.spans).toContainEqual(
      expect.objectContaining({
        name: "FlowBootManager.start",
        depth: 1,
        startSample: 0,
        endSample: 2,
        startTimeSeconds: 0,
        endTimeSeconds: 2,
        weightMs: 2,
      }),
    );
    expect(timeline.topFrames[0]).toEqual(
      expect.objectContaining({ name: "main", samples: 3 }),
    );
  });

  test("uses real sample times and weights for span durations", () => {
    const main = frame("main", "Grace", true);
    const scene = frame(
      "@objc FlowSceneDelegate.scene(_:willConnectTo:options:)",
      "Grace",
      true,
    );

    const timeline = buildTraceTimelineFromSamples(
      [[main, scene], [main, scene], [main]],
      {
        totalMainThreadRows: 3,
        sampleTimesSeconds: [3.474, 3.475, 3.49],
        sampleWeightsMs: [1, 1, 1],
      },
    );

    expect(timeline.sampleTimesSeconds).toEqual([3.474, 3.475, 3.49]);
    expect(timeline.spans).toContainEqual(
      expect.objectContaining({
        name: "@objc FlowSceneDelegate.scene(_:willConnectTo:options:)",
        startSample: 0,
        endSample: 2,
        startTimeSeconds: 3.474,
        endTimeSeconds: 3.476,
        weightMs: 2,
      }),
    );
  });

  test("excludes later sampling gaps from span wall range", () => {
    const main = frame("main", "Grace", true);

    const timeline = buildTraceTimelineFromSamples([[main], [main]], {
      totalMainThreadRows: 2,
      sampleTimesSeconds: [1, 1.01],
      sampleWeightsMs: [1, 1],
    });

    expect(timeline.spans).toContainEqual(
      expect.objectContaining({
        startSample: 0,
        endSample: 2,
        startTimeSeconds: 1,
        endTimeSeconds: 1.011,
        weightMs: 2,
      }),
    );
  });

  test("renders a self-contained Instruments-style HTML timeline", () => {
    const timeline = buildTraceTimelineFromSamples(
      [
        [
          frame("main", "Grace", true),
          frame("FlowSceneDelegate.scene(_:willConnectTo:)", "Grace", true),
        ],
        [
          frame("main", "Grace", true),
          frame("<script>alert(1)</script>", "Grace", true),
        ],
      ],
      { totalMainThreadRows: 2, warnings: ["source rows are partial"] },
    );

    const html = renderLaunchTraceHtml({
      command: [
        "python3",
        "collect_trace.py",
        "--time-limit",
        "10s",
        "--bundle-id",
        "com.bot.doubao",
      ],
      exitCode: 0,
      generatedAt: "2026-08-11T12:00:00.000Z",
      outputDir: "/tmp/ios_perf-opt/ios-launch-trace/test",
      summaryPath: "/tmp/ios_perf-opt/ios-launch-trace/test/summary.json",
      timeProfilePath:
        "/tmp/ios_perf-opt/ios-launch-trace/test/time_profile.xml",
      summary: {
        success: true,
        bundle_id: "com.bot.doubao",
        symbolication_status: "ready",
        main_thread_rows: 2,
        main_thread_grace_source_rows: 2,
        trace_path: "/tmp/ios_perf-opt/ios-launch-trace/test/launch.trace",
      },
      timeline,
    });

    expect(html).toStartWith("<!DOCTYPE html>");
    expect(html).toContain("iOS Launch Trace Timeline");
    expect(html).toContain("Default Workspace");
    expect(html).toContain("Top Sampled Frames");
    expect(html).toContain("Frame Details");
    expect(html).toContain("timeline-canvas");
    expect(html).toContain("trace-viewer-data");
    expect(html).toContain(".trace-shell {\n      display: block;");
    expect(html).toContain(".timeline {\n      position: absolute;");
    expect(html).toContain("positionViewportCanvas");
    expect(html).toContain("position: fixed;");
    expect(html).toContain("data-zoom-slider");
    expect(html).toContain('min="1" max="6400"');
    expect(html).toContain("const minZoom = 0.01;");
    expect(html).toContain("data-search");
    expect(html).toContain("data-expand-all");
    expect(html).toContain("data-collapse-all");
    expect(html).toContain("data-thread-filter-search");
    expect(html).toContain("data-thread-filter-list");
    expect(html).toContain("data-thread-select-all");
    expect(html).toContain("data-thread-clear");
    expect(html).toContain("data-thread-filter-status");
    expect(html).toContain("function relayout()");
    expect(html).toContain("function toggleGroup(groupId)");
    expect(html).toContain("function toggleThread(threadId)");
    expect(html).toContain("function setAllCollapsed(collapsed)");
    expect(html).toContain("function renderThreadFilter()");
    expect(html).toContain("function applyThreadSelection()");
    expect(html).toContain("selectedThreadIds");
    expect(html).toContain("group.visibleThreads");
    expect(html).toContain("data-search-status");
    expect(html).toContain("data-clear-search");
    expect(html).toContain("function clearSearchQuery()");
    expect(html).toContain("function activateSearchHit(index)");
    expect(html).toContain("updateSearchStatus();");
    expect(html).toContain('event.key !== "Enter"');
    expect(html).toContain("data-mini-window");
    expect(html).toContain("data-frame-name");
    expect(html).toContain("data-detail-name");
    expect(html).toContain("data-detail-thread");
    expect(html).toContain("data-detail-duration");
    expect(html).toContain("data-details-panel hidden");
    expect(html).toContain("function showInspector()");
    expect(html).toContain("function hideInspector()");
    expect(html).toContain("fitTimeline();");
    expect(html).toContain("formatMilliseconds");
    expect(html).toContain("Artifacts");
    expect(html).toContain("source rows are partial");
    expect(html).toContain("FlowSceneDelegate.scene");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<link ");
    expect(html).not.toContain(".timeline {\n      position: sticky;");
    expect(html).not.toContain("OffscreenCanvas");
    expect(html).not.toContain("baseBitmap");
  });

  test("renders collector diagnostics when preflight collection fails", () => {
    const html = renderLaunchTraceHtml({
      command: ["python3", "collect_trace.py", "--time-limit", "10s"],
      exitCode: 2,
      generatedAt: "2026-08-11T12:00:00.000Z",
      outputDir: "/tmp/ios_perf-opt/ios-launch-trace/missing-dsym",
      summaryPath:
        "/tmp/ios_perf-opt/ios-launch-trace/missing-dsym/summary.json",
      timeProfilePath:
        "/tmp/ios_perf-opt/ios-launch-trace/missing-dsym/time_profile.xml",
      summary: {
        success: false,
        error: "missing_dsym",
        message:
          "Grace.app.dSYM is missing. Run flow-ios-dev build_app --symbols-required first.",
        dsym_path:
          "/Users/bytedance/Documents/BDWorkSpace/Dbao/.vscode-out/Grace.app.dSYM",
      },
      stdoutTail: '{"error":"missing_dsym"}',
      timeline: buildTraceTimelineFromSamples([], {
        warnings: ["missing_dsym"],
      }),
    });

    expect(html).toContain("Collector Diagnostics");
    expect(html).toContain("missing_dsym");
    expect(html).toContain("Grace.app.dSYM is missing");
    expect(html).toContain("collector result");
    expect(html).toContain("failed");
  });

  test("renders xctrace export retry diagnostics", () => {
    const html = renderLaunchTraceHtml({
      command: ["python3", "collect_trace.py"],
      exitCode: 0,
      generatedAt: "2026-08-13T03:18:11.000Z",
      outputDir: "/tmp/ios_perf-opt/ios-launch-trace/recovered",
      summaryPath: "/tmp/ios_perf-opt/ios-launch-trace/recovered/summary.json",
      timeProfilePath:
        "/tmp/ios_perf-opt/ios-launch-trace/recovered/time_profile.xml",
      summary: {
        success: true,
        trace_settle: { settled: true },
        export_attempts: {
          toc: [
            {
              attempt: 1,
              returncode: -11,
              stdout_path: "/tmp/export-toc-1.stdout.txt",
              stderr_path: "/tmp/export-toc-1.stderr.txt",
            },
            {
              attempt: 2,
              returncode: 0,
              stdout_path: "/tmp/export-toc-2.stdout.txt",
              stderr_path: "/tmp/export-toc-2.stderr.txt",
            },
          ],
        },
      },
      timeline: buildTraceTimelineFromSamples([], {}),
    });

    expect(html).toContain("trace settled: yes");
    expect(html).toContain("toc export attempt 1: returncode -11");
    expect(html).toContain("toc export attempt 2: returncode 0");
    expect(html).toContain("/tmp/export-toc-1.stderr.txt");
  });

  test("expands Instruments frame and backtrace refs with real sample times", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ios-launch-trace-"));
    const xmlPath = join(dir, "time_profile.xml");
    await writeFile(
      xmlPath,
      `<?xml version="1.0"?>
      <trace-query-result>
        <row>
          <sample-time id="time-1" fmt="00:00.001">1000000</sample-time>
          <weight id="weight-1" fmt="1.00 ms">1000000</weight>
          <thread id="t1" fmt="Main Thread  0x1"></thread>
          <backtrace id="bt1">
            <frame id="leaf" name="FlowBootManager.beforeLaunching()">
              <binary id="b-core" name="GraceCore" path="/Users/bytedance/Documents/BDWorkSpace/Dbao/GraceCore"/>
              <source line="91"><path>./.jojo/repos/FlowBoot/FlowBootManager.swift</path></source>
            </frame>
            <frame id="flow-main" name="flow_main()">
              <binary ref="b-core"/>
              <source line="34"><path>./flow_iOS/Flow/FlowAppDelegate.swift</path></source>
            </frame>
            <frame id="main" name="main">
              <binary id="b-app" name="Grace" path="/Users/bytedance/Documents/BDWorkSpace/Dbao/Grace.app/Grace"/>
            </frame>
          </backtrace>
        </row>
        <row>
          <sample-time ref="time-1"/>
          <thread ref="t1"/>
          <weight ref="weight-1"/>
          <backtrace ref="bt1"/>
        </row>
      </trace-query-result>`,
      "utf8",
    );

    const timeline = await parseTraceTimeline({
      timeProfilePath: xmlPath,
      targetBinary: "Grace",
      maxSamples: 10,
      maxDepth: 10,
      python: "python3",
    });

    expect(timeline.renderedSamples).toBe(2);
    expect(timeline.sampleTimesSeconds).toEqual([0.001, 0.001]);
    expect(timeline.sampleWeightsMs).toEqual([1, 1]);
    expect(timeline.spans).toContainEqual(
      expect.objectContaining({
        name: "main",
        depth: 0,
        startSample: 0,
        endSample: 2,
        weightMs: 2,
        appFrame: true,
      }),
    );
    expect(timeline.spans).toContainEqual(
      expect.objectContaining({
        name: "flow_main()",
        depth: 1,
        startSample: 0,
        endSample: 2,
        appFrame: true,
      }),
    );
  });

  test("builds a time-based timeline per thread", () => {
    const main = frame("main", "Grace", true);
    const worker = frame("dispatch_worker", "libdispatch.dylib", false);

    const threads = buildThreadTimelines([
      {
        threadId: "t1",
        label: "Main Thread 0x1",
        isMain: true,
        totalRows: 2,
        stride: 1,
        sampleTimesSeconds: [0.5, 0.6],
        sampleWeightsMs: [1, 1],
        samples: [[main], [main]],
      },
      {
        threadId: "t2",
        label: "com.apple.root.default-qos",
        isMain: false,
        totalRows: 1,
        stride: 1,
        sampleTimesSeconds: [0.55],
        sampleWeightsMs: [1],
        samples: [[worker]],
      },
    ]);

    expect(threads).toHaveLength(2);
    expect(threads[0]).toEqual(
      expect.objectContaining({
        threadId: "t1",
        isMain: true,
        group: "main",
        maxDepth: 1,
        startSeconds: 0.5,
      }),
    );
    expect(threads[0]?.spans[0]).toEqual(
      expect.objectContaining({ name: "main", startTimeSeconds: 0.5 }),
    );
    expect(threads[1]).toEqual(
      expect.objectContaining({
        threadId: "t2",
        isMain: false,
        group: "other",
      }),
    );
    expect(threads[1]?.spans[0]).toEqual(
      expect.objectContaining({
        name: "dispatch_worker",
        startTimeSeconds: 0.55,
      }),
    );
  });

  test("classifies non-main threads with app frames into the app group", () => {
    const appWork = frame("FlowUploader.flush()", "GraceCore", true);
    const [thread] = buildThreadTimelines([
      {
        threadId: "t9",
        label: "Grace 0x9",
        isMain: false,
        totalRows: 1,
        stride: 1,
        sampleTimesSeconds: [1.2],
        sampleWeightsMs: [1],
        samples: [[appWork]],
      },
    ]);

    expect(thread).toEqual(
      expect.objectContaining({ threadId: "t9", isMain: false, group: "app" }),
    );
  });

  test("parses every sampled thread, not just the main thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ios-launch-trace-threads-"));
    const xmlPath = join(dir, "time_profile.xml");
    await writeFile(
      xmlPath,
      `<?xml version="1.0"?>
      <trace-query-result>
        <row>
          <sample-time id="time-1" fmt="00:00.001">1000000</sample-time>
          <weight id="weight-1" fmt="1.00 ms">1000000</weight>
          <thread id="t1" fmt="Main Thread  0x1"></thread>
          <backtrace id="bt-main">
            <frame id="main-leaf" name="FlowBootManager.beforeLaunching()">
              <binary id="b-core" name="GraceCore" path="/Users/x/Dbao/GraceCore"/>
              <source line="91"><path>./.jojo/repos/FlowBoot/FlowBootManager.swift</path></source>
            </frame>
            <frame id="main-root" name="main">
              <binary id="b-app" name="Grace" path="/Users/x/Dbao/Grace.app/Grace"/>
            </frame>
          </backtrace>
        </row>
        <row>
          <sample-time id="time-2" fmt="00:00.002">2000000</sample-time>
          <weight ref="weight-1"/>
          <thread id="t2" fmt="Thread 0x2 (com.apple.root.default-qos)"></thread>
          <backtrace id="bt-worker">
            <frame id="worker-leaf" name="worker_dispatch">
              <binary id="b-dispatch" name="libdispatch.dylib" path="/usr/lib/system/libdispatch.dylib"/>
            </frame>
          </backtrace>
        </row>
      </trace-query-result>`,
      "utf8",
    );

    const timeline = await parseTraceTimeline({
      timeProfilePath: xmlPath,
      targetBinary: "Grace",
      maxSamples: 10,
      maxDepth: 10,
      python: "python3",
    });

    expect(timeline.threads).toHaveLength(2);
    expect(timeline.threads.map((thread) => thread.isMain)).toContain(true);
    expect(timeline.threads.map((thread) => thread.isMain)).toContain(false);
    const worker = timeline.threads.find((thread) => !thread.isMain);
    expect(worker?.spans.map((span) => span.name)).toContain("worker_dispatch");
    expect(timeline.traceEndSeconds).toBeGreaterThan(
      timeline.traceStartSeconds,
    );
    // Main-thread compatibility fields still describe the main thread only.
    expect(timeline.spans.map((span) => span.name)).toContain("main");
  });

  test("classifies Florak iOS source paths as app frames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ios-launch-trace-florak-"));
    const xmlPath = join(dir, "time_profile.xml");
    await writeFile(
      xmlPath,
      `<?xml version="1.0"?>
      <trace-query-result>
        <row>
          <sample-time id="time-1" fmt="00:00.001">1000000</sample-time>
          <weight id="weight-1" fmt="1.00 ms">1000000</weight>
          <thread id="t1" fmt="Main Thread  0x1"></thread>
          <backtrace id="bt1">
            <frame id="leaf" name="FlowFeature.render()">
              <binary id="b-feature" name="FlowFeature" path="/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios/DerivedData/FlowFeature.framework/FlowFeature"/>
              <source line="42"><path>./flow/ios/Modules/FlowFeature/Render.swift</path></source>
            </frame>
          </backtrace>
        </row>
      </trace-query-result>`,
      "utf8",
    );

    const timeline = await parseTraceTimeline({
      timeProfilePath: xmlPath,
      targetBinary: "Grace",
      maxSamples: 10,
      maxDepth: 10,
      python: "python3",
    });

    expect(timeline.spans[0]).toEqual(
      expect.objectContaining({ name: "FlowFeature.render()", appFrame: true }),
    );
  });
});

function frame(name: string, binary: string, appFrame: boolean): TraceFrame {
  return {
    name,
    binary,
    sourcePath: appFrame ? "/repo/AppDelegate.swift" : "",
    line: appFrame ? "42" : "",
    appFrame,
  };
}
