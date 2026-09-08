# iOS Launch Trace

This example collects a real-device iOS launch Time Profiler trace and writes a
self-contained HTML timeline inspired by Instruments. It is intentionally a
deterministic collection Workflow: TypeScript owns the steps, and no Agent is
needed for the trace capture itself.

## What it does

1. prepares an output directory under
   `/Users/bytedance/.ios_pref_optimizer/ios-launch-trace/`;
2. installs the local App when requested, terminates the old process, and runs
   `xctrace record --launch` directly;
3. symbolicates the trace, exports `summary.json` and `time_profile.xml`, and
   performs fail-closed atos recovery for unresolved first-party frames;
4. renders `launch-trace-report.html` with a time ruler, density strip,
   main-thread flame timeline, top sampled frames, and artifact paths.

The terminal exposes the Workflow's long-running work as separate phases:
`Install`, `Launch & Record`, `Symbolicate`, `Export`, and `Backfill Symbols`.
The configured `timeLimit` starts only after xctrace completes its launch
handshake; trace saving, symbolication, XML export, and atos recovery may take
longer but are no longer hidden behind a single opaque `Collect` phase.

The Workflow is self-contained in this repository and does not require an
`ios-perf-optimizer` checkout. It may install the supplied `.app` unless
`skipInstall` is set. The machine still needs `python3` for the bundled XML
parser and symbol-recovery helper; only Python's standard library is used.

## Run

```bash
deer-workflow run ./examples/ios-launch-trace/workflow.ts \
  --input '{
    "repositoryRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak",
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "buildRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "udid": "00008030-001A286A2229802E",
    "bundleId": "com.bot.doubao",
    "timeLimit": "20s"
  }'
```

The returned JSON includes the raw `.trace` bundle, exported XML paths, the
Workflow summary, and the HTML report path.

## Inputs

- `repositoryRoot`: Git repository root. For Florak, this is the monorepo root.
- `projectRoot`: target iOS source root.
- `buildRoot`: BitSky root containing `.vscode-out`; defaults to `projectRoot`.
- `developerDir`: optional full Xcode Developer directory used through
  `DEVELOPER_DIR`, without changing system `xcode-select`. The Workflow checks
  `Xcode_26.app` first, then `Xcode.app`; set it explicitly for other installs.
- `udid`: real-device UDID passed to `xctrace`.
- `bundleId`: bundle identifier launched under Time Profiler. Defaults to
  `com.bot.doubao`.
- `appPath`: existing `.app` bundle. If omitted, the Workflow uses
  `<buildRoot>/.vscode-out/Grace.app`.
- `dsymPath`: matching `.app.dSYM`. If omitted, the Workflow uses the BitSky
  default `<buildRoot>/.vscode-out/dSYM/Grace.app.dSYM`.
- `symbolSearchPath`: directory recursively supplied to `xctrace symbolicate`;
  defaults to the parent of `dsymPath`, normally `.vscode-out/dSYM`.
- `timeLimit`: xctrace recording limit, such as `20s`.
- `skipInstall`: skip installing the `.app` before trace collection.
- `outputDir`: output directory. Defaults to
  `/Users/bytedance/.ios_pref_optimizer/ios-launch-trace/<runId>`.
- `htmlReportPath`: report destination. Defaults to
  `<outputDir>/launch-trace-report.html`.
- `targetBinary`: binary highlighted as app code in the HTML timeline. Defaults
  to `Grace`.
- `businessBinary`: framework used to validate source coverage. Defaults to
  `FlowDebugBasicDynamic`.
- `maxSamples` / `maxDepth`: rendering limits for large traces. The default
  `maxSamples` is high enough for common 20s / 1ms launch traces; lowering it
  makes the view approximate.

## Output

For a normal launch collection, the output directory contains:

- `launch_target.trace`
- `symbolicated.trace`
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

If preflight fails before `xctrace` starts, such as when the default dSYM is
missing, the Workflow writes the HTML diagnostics report and then exits with a
failure instead of reporting a successful collection. A verified image/dSYM
UUID mismatch or a `missing` symbolication status also fails with diagnostics while
preserving the raw trace. With `skipInstall: true`, supply symbols from the exact
installed build; otherwise use `skipInstall: false` to install the local App
before collecting again. Debug builds may put `Grace.debug.dylib` symbols inside
`Grace.app.dSYM`; compare UUIDs by the DWARF binary name, not the bundle name.
The Workflow includes `FlowDebugBasicDynamic` and expands XML frame/backtrace
references when counting source-symbol coverage. If any main-thread samples still
contain raw addresses, the Workflow reports `partial` and records unresolved
and unmapped sample counts; source coverage alone does not mean full symbolication.

Early `xctrace --launch` samples can omit the `Grace.debug.dylib` image record,
leaving first-party frames without a binary UUID. The Workflow recovers such
frames only when a dominant unmapped address cluster, a Mach-O-derived ASLR
base, expected bootstrap anchors, and a high-confidence atos probe all agree.
The load address is inferred per launch and is not fixed to `0x300000000`;
unverified addresses remain raw.

With `skipInstall: true`, xctrace can return 55 (`No dSYMs were found or
relevant`) when the launch trace omits the Debug dylib image entirely. Only
that specific error falls back to raw-trace XML plus the same fail-closed atos
validation. The run succeeds only if validation passes; otherwise it still
fails and callers should use `skipInstall: false` to install the matching App.
Other xctrace symbolication errors remain fatal.
