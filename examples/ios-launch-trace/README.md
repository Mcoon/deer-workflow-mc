# iOS Launch Trace

This example collects a real-device iOS launch Time Profiler trace and writes a
self-contained HTML timeline inspired by Instruments. It is intentionally a
deterministic collection Workflow: TypeScript owns the steps, and no Agent is
needed for the trace capture itself.

## What it does

1. prepares an output directory under
   `/Users/bytedance/.ios_pref_optimizer/ios-launch-trace/`;
2. runs the existing `flow-ios-trace-collection` `collect_trace.py` script in
   `launch` mode;
3. reads `summary.json` and `time_profile.xml`;
4. renders `launch-trace-report.html` with a time ruler, density strip,
   main-thread flame timeline, top sampled frames, and artifact paths.

The Workflow does not modify `ios-perf-optimizer` or the target app. The
collector may install the supplied `.app` unless `skipInstall` is set.

## Run

```bash
deer-workflow run ./examples/ios-launch-trace/workflow.ts \
  --input '{
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
    "udid": "00008030-001A286A2229802E",
    "bundleId": "com.bot.doubao",
    "timeLimit": "20s"
  }'
```

The returned JSON includes the raw `.trace` bundle, exported XML paths, the
collector summary, and the HTML report path.

## Inputs

- `projectRoot`: target iOS project root.
- `udid`: real-device UDID passed to `xctrace`.
- `bundleId`: bundle identifier launched under Time Profiler. Defaults to
  `com.bot.doubao`.
- `collectorScriptPath`: path to `collect_trace.py`. Defaults to the local
  `ios-perf-optimizer` checkout.
- `appPath`: existing `.app` bundle. If omitted, the collector uses its
  flow_iOS default: `<projectRoot parent>/.vscode-out/Grace.app`.
- `dsymPath`: matching `.app.dSYM`. If omitted, the collector uses its flow_iOS
  default: `<projectRoot parent>/.vscode-out/Grace.app.dSYM`. The Workflow does
  not scan for dSYM bundles; pass an absolute `dsymPath` when the build artifact
  lives elsewhere.
- `timeLimit`: xctrace recording limit, such as `20s`.
- `skipInstall`: skip installing the `.app` before trace collection.
- `outputDir`: output directory. Defaults to
  `/Users/bytedance/.ios_pref_optimizer/ios-launch-trace/<runId>`.
- `htmlReportPath`: report destination. Defaults to
  `<outputDir>/launch-trace-report.html`.
- `targetBinary`: binary highlighted as app code in the HTML timeline. Defaults
  to `Grace`.
- `maxSamples` / `maxDepth`: rendering limits for large traces. The default
  `maxSamples` is high enough for common 20s / 1ms launch traces; lowering it
  makes the view approximate.

## Output

For a normal launch collection, the output directory contains:

- `launch_target.trace`
- `toc.xml`
- `time_profile.xml`
- `summary.json`
- `launch-trace-report.html`

The HTML report is a browsing aid, not a replacement for Instruments. Frame
details show sample weight separately from wall-clock range so entry frames such
as `main` and app wrappers such as `flow_main()` are not mistaken for a single
method's exclusive runtime. When `time_profile.xml` does not expose precise
timestamps, samples are laid out in row order with an approximate time ruler
based on `timeLimit`.

If the collector fails before `xctrace` starts, such as when the default dSYM is
missing, the Workflow writes the HTML diagnostics report and then exits with a
failure instead of reporting a successful collection.
