# iOS Build and Install

This example builds a flow_iOS app with dSYM artifacts and installs the built
`.app` on a real device without launching it. It is designed as the preparation
Workflow for [iOS Launch Trace](../ios-launch-trace/README.md).

## What it does

1. runs `flow-ios-dev/scripts/build_app.py --symbols-required`;
2. validates that the build returned an `.app`, a `.app.dSYM`, and
   `symbolication_status: "ready"`;
3. installs the app with `xcrun devicectl device install app`;
4. returns `appPath` and the main-app `dsymPath` for launch traces, plus
   `businessDsymPath` and `symbolSearchPath` for recursively symbolicating
   attach traces that execute inside `GraceCore`.

It does not call `flow-ios-dev deploy.py`, `ios-deploy`, or any install-and-run
wrapper. The install phase is install-only so the first launch can still be the
later Time Profiler collection.

## Run

```bash
deer-workflow run ./examples/ios-build-install/workflow.ts \
  --input '{
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
    "udid": "00008030-001A286A2229802E",
    "mode": "Debug"
  }'
```

The returned JSON includes:

- `appPath`
- `dsymPath`
- `businessDsymPath`
- `symbolSearchPath`
- `symbolicationStatus`
- `buildSummaryPath`
- `installJsonPath`
- `installLogPath`

`dsymPath` remains the main `Grace.app.dSYM` for compatibility with the launch
collector's main-executable UUID check. Pass `symbolSearchPath` to
`ios-attach-trace` when invoking it explicitly; if omitted, that Workflow
automatically discovers the newest matching `ios-build-install` summary.

Then run launch trace with the returned paths:

```bash
deer-workflow run ./examples/ios-launch-trace/workflow.ts \
  --input '{
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
    "udid": "00008030-001A286A2229802E",
    "bundleId": "com.bot.doubao",
    "appPath": "<appPath from ios-build-install>",
    "dsymPath": "<dsymPath from ios-build-install>",
    "timeLimit": "10s",
    "skipInstall": true
  }'
```

Use `skipInstall: true` in the trace step when you trust that the preceding
install used the same returned `appPath`.

## Inputs

- `projectRoot`: target iOS project root.
- `udid`: real-device UDID used for install-only deployment.
- `buildScriptPath`: path to `build_app.py`. Defaults to the installed
  `flow-ios-dev` Skill path.
- `mode`: `Debug` or `Release`. Defaults to `Debug`.
- `symbolsRequired`: defaults to `true`; keep it enabled for Time Profiler.
- `requireReadySymbols`: defaults to `true`; fails if dSYM metadata is missing
  or partial.
- `noKeepGoing`: passes `--no-keep-going` to `build_app.py`.
- `outputDir`: output directory. Defaults to `/tmp/ios_perf-opt`.
- `installTimeoutSeconds`: devicectl install timeout. Defaults to `180`.

## Failure behavior

Build failures stop before install. Common actions such as `need_cosign` are
preserved in `build-summary.json` so the caller can run the normal signing
repair flow before retrying.
