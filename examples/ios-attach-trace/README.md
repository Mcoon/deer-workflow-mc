# iOS Attach Trace

This example attaches Time Profiler to an already-running iOS app and writes the
same self-contained HTML timeline used by the launch trace example. It is a
deterministic Workflow for manual interaction captures: start the app first,
run the Workflow, operate the phone while the recording is active, and let
`xctrace` stop after the configured time limit.

## What It Does

1. prepares an output directory under
   `/tmp/ios_perf-opt/ios-attach-trace/`;
2. runs `xcrun xctrace record --template "Time Profiler" --attach <target>` for
   the requested duration;
3. resolves a recursive dSYM search path from explicit input, the newest
   matching `ios-build-install` summary, or a `flow-ios-bitsky` summary, then
   runs `xctrace symbolicate`;
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
    "repositoryRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak",
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "buildRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "developerDir": "/Applications/Xcode_26.app/Contents/Developer",
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

- `repositoryRoot`: Git repository root. For Florak, this is the monorepo root.
- `projectRoot`: target iOS source root.
- `buildRoot`: BitSky root containing `.vscode-out`; defaults to `projectRoot`.
- `developerDir`: optional full Xcode Developer directory used through
  `DEVELOPER_DIR`, without changing system `xcode-select`. Defaults to
  `/Applications/Xcode_26.app/Contents/Developer`; set it explicitly for other
  Xcode installations.
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
  `/tmp/ios_perf-opt/ios-attach-trace/<runId>`.
- `htmlReportPath`: report destination. Defaults to
  `<outputDir>/attach-trace-report.html`.
- `targetBinary`: binary highlighted as app code in the HTML timeline. Defaults
  to `Grace`.
- `symbolSearchPath`: directory recursively searched by `xctrace symbolicate`.
  If omitted, the Workflow first discovers the newest matching
  `/tmp/ios_perf-opt/ios-build-install/*/build-summary.json`, then falls back
  to `/tmp/ios_perf-opt/flow-ios-bitsky/*/summary.json` and its `products/dSYM`.
- `businessBinary`: business framework used for source-coverage validation.
  Defaults to `FlowDebugBasicDynamic` for current BitSky Debug builds.
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
source-level `FlowDebugBasicDynamic` coverage. `symbolicationStatus=ready` means
the exported main-thread stacks actually contain business source locations.
If no matching dSYM directory is found, the Workflow preserves the raw trace
and fails clearly instead of reporting an unsymbolicated export as success.

## Symbolication diagnostics

Do not treat a completed `Symbolicate` phase alone as proof that source symbols
were applied. A valid source-level result has all of these fields in
`summary.json`:

- non-empty `symbol_search_path`;
- `symbol_search_source` equal to `explicit-symbol-search-path`,
  `recent-build-summary`, or `recent-bitsky-summary`;
- non-empty `symbolicated_trace_path`;
- `symbolication_status=ready`;
- `main_thread_grace_source_rows > 0`.

Older Workflow versions could finish successfully with
`symbol_search_source=none`, an empty `symbolicated_trace_path`, and
`symbolication_status=partial`. That means the raw trace was exported without
running `xctrace symbolicate`. The raw `.trace` remains recoverable: rerun
`xctrace symbolicate` with the matching BitSky `products/dSYM` directory, then
export XML from the recovered trace.
