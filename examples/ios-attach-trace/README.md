# iOS Attach Trace

This example attaches Time Profiler to an already-running iOS app and writes the
same self-contained HTML timeline used by the launch trace example. It is a
deterministic Workflow for manual interaction captures: start the app first,
run the Workflow, operate the phone while the recording is active, and let
`xctrace` stop after the configured time limit.

## What It Does

1. prepares an output directory under
   `/Users/bytedance/.ios_pref_optimizer/ios-attach-trace/`;
2. runs `xcrun xctrace record --template "Time Profiler" --attach <target>` for
   the requested duration;
3. resolves a recursive dSYM search path from explicit input or the newest
   matching `ios-build-install` summary, then runs `xctrace symbolicate`;
4. exports `toc.xml` and `time_profile.xml` from the symbolicated trace;
5. parses the exported Time Profiler rows with the launch trace parser;
6. renders `attach-trace-report.html` with the same zoomable timeline, frame
   details, top sampled frames, and artifact paths.

The Workflow does not install, launch, terminate, or otherwise control the app.
The app process must already be running on the target device before the Collect
phase starts.

## Run

```bash
deer-workflow run ./examples/ios-attach-trace/workflow.ts \
  --input '{
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
    "udid": "00008030-001A286A2229802E",
    "bundleId": "com.bot.doubao",
    "attachTarget": "Grace",
    "timeLimit": "30s"
  }'
```

During the `Record` phase, wait until the log prints `Time Profiler has
attached and is recording`, then operate the app on the phone. The recording
stops when `timeLimit` elapses. After that, `Save Trace` may still take time
while `xctrace` writes the `.trace` bundle; this is no longer recording time.
The Workflow then exports and renders the report.

## Inputs

- `projectRoot`: target iOS project root.
- `udid`: real-device UDID passed to `xctrace`.
- `bundleId`: bundle identifier recorded in the summary and report. Defaults to
  `com.bot.doubao`.
- `attachTarget`: process name or pid passed to `xctrace record --attach`.
  Defaults to `targetBinary`, usually `Grace`. When a process name is used,
  the Workflow first resolves the running main app process to a concrete PID
  with `devicectl` and attaches to that PID.
  If `xctrace` reports that the process name is ambiguous, re-run with the
  numeric PID shown in the failure diagnostics.
- `template`: xctrace template name or path. Defaults to `Time Profiler`.
- `timeLimit`: recording limit, defaults to `30s`.
- `outputDir`: output directory. Defaults to
  `/Users/bytedance/.ios_pref_optimizer/ios-attach-trace/<runId>`.
- `htmlReportPath`: report destination. Defaults to
  `<outputDir>/attach-trace-report.html`.
- `targetBinary`: binary highlighted as app code in the HTML timeline. Defaults
  to `Grace`.
- `symbolSearchPath`: directory recursively searched by `xctrace symbolicate`.
  If omitted, the Workflow discovers the newest matching
  `/tmp/ios_perf-opt/ios-build-install/*/build-summary.json` and uses the
  directory containing `GraceCore.framework.dSYM`.
- `businessBinary`: business framework used for source-coverage validation.
  Defaults to `<targetBinary>Core`, normally `GraceCore`.
- `maxSamples` / `maxDepth`: rendering limits for large traces.

## Output

For a normal attach collection, the output directory contains:

- `attach_target.trace`
- `symbolicated.trace` when a symbol search path is available
- `toc.xml`
- `time_profile.xml`
- `summary.json`
- `attach-trace-report.html`

The HTML viewer has the same behavior as the launch trace report: it opens
fitted to the full trace, supports zoom/search, and shows sample weight
separately from wall-clock range.

`summary.json` also records the `record.started_at`, `record.finished_at`,
`record.observed_recording_started_at`, and
`record.observed_recording_finished_at` timestamps. Use these fields to confirm
whether a long-looking `Collect` phase was actual Time Profiler recording time
or setup time before `xctrace` attached.
It also records the selected symbol search path, its resolution source, and
source-level `GraceCore` coverage. `symbolicationStatus=ready` now means the
exported main-thread stacks actually contain `GraceCore` source locations.
