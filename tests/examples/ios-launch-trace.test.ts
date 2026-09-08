import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildInstallCommand,
  buildLaunchRecordCommand,
  buildOsSignpostExportCommand,
  buildTerminateCommand,
  buildThreadTimelines,
  buildTraceTimelineFromSamples,
  buildXctraceSymbolicateCommand,
  isRecoverableMissingImageSymbolication,
  meta,
  observeLaunchRecordOutput,
  parseTraceTimeline,
  recoverLaunchSymbols,
  renderLaunchTraceHtml,
  validateLaunchSymbolication,
} from "../../examples/ios-launch-trace/workflow";
import type {
  IosLaunchTraceResult,
  LaunchTraceSummary,
  TraceFrame,
} from "../../examples/ios-launch-trace/types";

describe("iOS Launch Trace report", () => {
  test("shows self-contained launch collection stages", () => {
    expect(meta.phases.map((item) => item.title)).toEqual([
      "Prepare",
      "Install",
      "Launch & Record",
      "Symbolicate",
      "Export",
      "Backfill Symbols",
      "Parse",
      "Report",
    ]);
  });

  test("observes the real launch recording window from xctrace output", () => {
    const observation: {
      pendingLine?: string;
      startedAt?: string;
      finishedAt?: string;
    } = { pendingLine: "" };

    observeLaunchRecordOutput("Launching pro", observation);
    observeLaunchRecordOutput(
      "cess: Grace\nReached specified time limit, ending recording...\n",
      observation,
    );

    expect(observation.startedAt).toBeDefined();
    expect(observation.finishedAt).toBeDefined();
  });

  test("builds the install, terminate, launch, and symbolication commands", () => {
    expect(
      buildInstallCommand({ udid: "device-1", appPath: "/tmp/Grace.app" }),
    ).toEqual([
      "xcrun",
      "devicectl",
      "device",
      "install",
      "app",
      "--device",
      "device-1",
      "/tmp/Grace.app",
    ]);
    expect(
      buildTerminateCommand({
        udid: "device-1",
        pid: 6823,
      }),
    ).toEqual(expect.arrayContaining(["terminate", "--pid", "6823", "--kill"]));
    expect(
      buildLaunchRecordCommand({
        udid: "device-1",
        bundleId: "com.bot.doubao",
        timeLimit: "20s",
        tracePath: "/tmp/launch.trace",
      }),
    ).toEqual(expect.arrayContaining(["--launch", "--", "com.bot.doubao"]));
    expect(
      buildXctraceSymbolicateCommand({
        tracePath: "/tmp/launch.trace",
        symbolicatedTracePath: "/tmp/symbolicated.trace",
        symbolSearchPath: "/tmp/dSYM",
      }),
    ).toEqual(expect.arrayContaining(["symbolicate", "--dsym", "/tmp/dSYM"]));
    expect(
      buildOsSignpostExportCommand("/tmp/launch.trace", "/tmp/os_signpost.xml"),
    ).toEqual(
      expect.arrayContaining([
        "--xpath",
        '/trace-toc/run[@number="1"]/data/table[@schema="os-signpost"]',
      ]),
    );
  });

  test("only treats xctrace 55 missing-image symbolication as recoverable", () => {
    expect(
      isRecoverableMissingImageSymbolication({
        exitCode: 55,
        stdout: "",
        stderr: "No dSYMs were found or relevant to this trace",
      }),
    ).toBe(true);
    expect(
      isRecoverableMissingImageSymbolication({
        exitCode: 55,
        stdout: "",
        stderr: "trace is corrupted",
      }),
    ).toBe(false);
  });

  test("runs bundled UUID-aware atos recovery without an external checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ios-launch-recovery-"));
    const binDir = join(dir, "bin");
    const dsymPath = join(dir, "Grace.app.dSYM");
    const dwarfDir = join(dsymPath, "Contents/Resources/DWARF");
    const dwarfPath = join(dwarfDir, "FlowDebugBasicDynamic");
    const xmlPath = join(dir, "time_profile.xml");
    await mkdir(binDir, { recursive: true });
    await mkdir(dwarfDir, { recursive: true });
    await writeFile(dwarfPath, "stub");
    await writeFile(
      join(binDir, "dwarfdump"),
      '#!/bin/sh\necho "UUID: AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE (arm64) $2"\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(binDir, "atos"),
      '#!/bin/sh\necho "FlowBoot.start() (in FlowDebugBasicDynamic) (Start.swift:42)"\n',
      { mode: 0o755 },
    );
    await writeFile(
      xmlPath,
      `<?xml version="1.0"?>
      <trace-query-result>
        <binary id="business" name="FlowDebugBasicDynamic" UUID="AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" load-addr="0x100000000"/>
        <row><thread id="main" fmt="Main Thread"/><backtrace>
          <frame name="0x100001000"><binary ref="business"/></frame>
        </backtrace></row>
      </trace-query-result>`,
    );

    const result = await recoverLaunchSymbols({
      python: "python3",
      timeProfilePath: xmlPath,
      symbolSearchPath: dir,
      dsymPath,
      targetBinary: "Grace",
      businessBinary: "FlowDebugBasicDynamic",
      projectRoot: dir,
      developerDir: "",
      environment: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });

    expect(result.backfill.resolved_frames).toBe(1);
    expect(result.coverage.main_thread_grace_source_rows).toBe(1);
    expect(result.coverage.main_thread_unresolved_rows).toBe(0);
    expect(await readFile(xmlPath, "utf8")).toContain("FlowBoot.start()");
  });

  test("runs the self-contained launch workflow without an external checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ios-launch-self-contained-"));
    const binDir = join(dir, "bin");
    const appPath = join(dir, "build/.vscode-out/Grace.app");
    const dsymPath = join(dir, "build/.vscode-out/dSYM/Grace.app.dSYM");
    const dwarfDir = join(dsymPath, "Contents/Resources/DWARF");
    const outputDir = join(dir, "output");
    await mkdir(binDir, { recursive: true });
    await mkdir(appPath, { recursive: true });
    await mkdir(dwarfDir, { recursive: true });
    await writeFile(join(dwarfDir, "FlowDebugBasicDynamic"), "stub");
    await writeFile(
      join(binDir, "dwarfdump"),
      '#!/bin/sh\necho "UUID: AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE (arm64) $2"\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(binDir, "xcrun"),
      `#!/bin/sh
set -eu
if [ "$1" = "devicectl" ]; then exit 0; fi
shift
action="$1"
shift
output=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--output" ]; then output="$argument"; fi
  previous="$argument"
done
if [ "$action" = "record" ]; then
  mkdir -p "$output"
  echo trace > "$output/data"
  echo "Launching process: Grace"
  echo "Reached specified time limit, ending recording..."
  exit 0
fi
if [ "$action" = "symbolicate" ]; then
  mkdir -p "$output"
  echo trace > "$output/data"
  exit 0
fi
if [ "$action" = "export" ]; then
  if printf '%s\n' "$@" | grep -q -- '--toc'; then
    echo '<trace-toc/>' > "$output"
  else
    cat > "$output" <<'XML'
<trace-query-result>
  <row><sample-time id="time">1000000</sample-time><weight id="weight">1000000</weight><thread id="main" fmt="Main Thread"/><backtrace>
    <frame name="FlowBoot.start()"><binary name="FlowDebugBasicDynamic" UUID="AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"/><source line="42"><path>Start.swift</path></source></frame>
  </backtrace></row>
</trace-query-result>
XML
  fi
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );

    const workflowPath = new URL(
      "../../examples/ios-launch-trace/workflow.ts",
      import.meta.url,
    ).pathname;
    const args = {
      projectRoot: dir,
      buildRoot: join(dir, "build"),
      udid: "device-1",
      appPath,
      dsymPath,
      symbolSearchPath: dirname(dsymPath),
      outputDir,
    };
    try {
      const subprocess = Bun.spawn(
        [
          process.execPath,
          "run",
          "src/cli.ts",
          "run",
          workflowPath,
          "--input",
          JSON.stringify(args),
        ],
        {
          cwd: new URL("../..", import.meta.url).pathname,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout) as IosLaunchTraceResult;
      expect(result.success).toBe(true);
      expect(result.command).toContain("--launch");
      expect(result.symbolicationStatus).toBe("ready");
      expect(await readFile(result.htmlReportPath, "utf8")).toContain(
        "iOS Launch Trace Timeline",
      );
      expect(JSON.parse(await readFile(result.summaryPath, "utf8"))).toEqual(
        expect.objectContaining({ success: true }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    timeline.signposts = [
      {
        id: "66",
        name: "MessagingDataController.refresh",
        subsystem: "com.bot.doubao",
        category: "MessagingDataController",
        message: "messageCount=20",
        process: "Grace (10)",
        beginThread: "Main Thread",
        endThread: "Main Thread",
        kind: "interval",
        incomplete: false,
        startTimeSeconds: 0.2,
        endTimeSeconds: 0.45,
        durationMs: 250,
        lane: 0,
      },
    ];

    const html = renderLaunchTraceHtml({
      command: [
        "xcrun",
        "xctrace",
        "record",
        "--time-limit",
        "10s",
        "--launch",
        "--",
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
    expect(html).toContain("os_signpost records");
    expect(html).toContain("MessagingDataController.refresh");
    expect(html).toContain("function drawSignpostTrack");
    expect(html).toContain("function selectSignpost");
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

  test("renders collection diagnostics when preflight fails", () => {
    const html = renderLaunchTraceHtml({
      command: ["xcrun", "xctrace", "record", "--time-limit", "10s"],
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
          "Grace.app.dSYM is missing. Run flow-ios-bitsky --dsym or ios-build-install first.",
        dsym_path:
          "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios/.vscode-out/dSYM/Grace.app.dSYM",
      },
      stdoutTail: '{"error":"missing_dsym"}',
      timeline: buildTraceTimelineFromSamples([], {
        warnings: ["missing_dsym"],
      }),
    });

    expect(html).toContain("Collection Diagnostics");
    expect(html).toContain("missing_dsym");
    expect(html).toContain("Grace.app.dSYM is missing");
    expect(html).toContain("collection result");
    expect(html).toContain("failed");
  });

  test("renders xctrace export retry diagnostics", () => {
    const html = renderLaunchTraceHtml({
      command: ["xcrun", "xctrace", "record"],
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

  test("parses and pairs target-process os_signpost intervals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ios-launch-signposts-"));
    const timeProfilePath = join(dir, "time_profile.xml");
    const osSignpostPath = join(dir, "os_signpost.xml");
    await writeFile(
      timeProfilePath,
      `<?xml version="1.0"?><trace-query-result><row>
        <sample-time>1000000000</sample-time><weight>1000000</weight>
        <thread id="t1" fmt="Main Thread"/><backtrace><frame name="main"><binary name="Grace"/></frame></backtrace>
      </row></trace-query-result>`,
    );
    await writeFile(
      osSignpostPath,
      `<?xml version="1.0"?><trace-query-result>
        <row><event-time id="time-begin">1100000000</event-time><thread id="thread" fmt="Main Thread (Grace, pid: 10)"/><process id="process" fmt="Grace (10)"/><event-type id="begin" fmt="Begin">Begin</event-type><os-signpost-identifier id="identifier" fmt="0x42">66</os-signpost-identifier><signpost-name id="name" fmt="MessagingDataController.refresh">MessagingDataController.refresh</signpost-name><subsystem id="subsystem" fmt="com.bot.doubao">com.bot.doubao</subsystem><category id="category" fmt="MessagingDataController">MessagingDataController</category></row>
        <row><event-time>1350000000</event-time><thread ref="thread"/><process ref="process"/><event-type id="end" fmt="End">End</event-type><os-signpost-identifier ref="identifier"/><signpost-name ref="name"/><subsystem ref="subsystem"/><category ref="category"/><os-log-metadata fmt="messageCount=20"/></row>
        <row><event-time>1200000000</event-time><thread fmt="Other"/><process fmt="OtherApp (11)"/><event-type ref="begin"/><os-signpost-identifier fmt="0x9">9</os-signpost-identifier><signpost-name fmt="Ignored">Ignored</signpost-name></row>
      </trace-query-result>`,
    );

    const timeline = await parseTraceTimeline({
      timeProfilePath,
      osSignpostPath,
      targetBinary: "Grace",
      maxSamples: 10,
      maxDepth: 10,
      python: "python3",
    });

    expect(timeline.signposts).toEqual([
      expect.objectContaining({
        id: "66",
        name: "MessagingDataController.refresh",
        kind: "interval",
        incomplete: false,
        startTimeSeconds: 1.1,
        endTimeSeconds: 1.35,
        durationMs: 250,
        lane: 0,
      }),
    ]);
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

  test("classifies the BitSky Debug dylib as an app frame without source metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ios-launch-trace-bitsky-debug-"));
    const xmlPath = join(dir, "time_profile.xml");
    await writeFile(
      xmlPath,
      `<?xml version="1.0"?>
      <trace-query-result><row>
        <sample-time id="time-1" fmt="00:00.001">1000000</sample-time>
        <weight id="weight-1" fmt="1.00 ms">1000000</weight>
        <thread id="t1" fmt="Main Thread 0x1"></thread>
        <backtrace><frame name="FlowBoot.start()">
          <binary name="Grace.debug.dylib" path="/private/Grace.app/Grace.debug.dylib"/>
        </frame></backtrace>
      </row></trace-query-result>`,
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
      expect.objectContaining({ binary: "Grace.debug.dylib", appFrame: true }),
    );
  });
});

describe("iOS launch symbolication validation", () => {
  test.each([
    {
      name: "rejects a successful collection result with missing symbols",
      summary: {
        success: true,
        symbolication_status: "missing",
      },
      error: "missing_symbols",
    },
    {
      name: "accepts ready Debug symbols with a separate launcher UUID",
      summary: {
        success: true,
        symbolication_status: "ready",
        dsym_uuid: "DEBUG-UUID",
        trace_target_uuids: {
          Grace: "STUB-UUID",
          FlowDebugBasicDynamic: "BUSINESS-UUID",
        },
        symbol_uuids: { FlowDebugBasicDynamic: ["BUSINESS-UUID"] },
        main_thread_source_rows_by_binary: { FlowDebugBasicDynamic: 3 },
      },
      error: "",
    },
    {
      name: "preserves partial symbolication without comparing different images",
      summary: {
        success: true,
        symbolication_status: "partial",
        dsym_uuid: "DEBUG-UUID",
        trace_grace_uuid: "STUB-UUID",
        trace_target_uuids: { Grace: "STUB-UUID" },
        main_thread_source_rows_by_binary: { Grace: 1 },
      },
      error: "",
    },
    {
      name: "preserves a verified same-image UUID mismatch",
      summary: {
        success: false,
        symbolication_status: "mismatch",
        error: "dsym_uuid_mismatch",
        message: "FlowDebugBasicDynamic UUID mismatch",
        trace_target_uuids: { FlowDebugBasicDynamic: "RECORDED-UUID" },
        symbol_uuids: { FlowDebugBasicDynamic: ["OTHER-UUID"] },
        main_thread_source_rows_by_binary: { FlowDebugBasicDynamic: 1 },
      },
      error: "dsym_uuid_mismatch",
    },
    {
      name: "preserves an existing collection failure",
      summary: { success: false, error: "install_failed" },
      error: "install_failed",
    },
  ])("$name", ({ summary: fixture, error }) => {
    const summary = fixture as LaunchTraceSummary;
    validateLaunchSymbolication(summary);
    expect(summary.success).toBe(!error);
    if (error) {
      expect(summary.error).toBe(error);
      if (error === "dsym_uuid_mismatch") {
        expect(summary.message).toContain("FlowDebugBasicDynamic");
      }
    }
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
