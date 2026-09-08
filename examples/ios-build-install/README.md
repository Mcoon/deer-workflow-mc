English | [简体中文](./README.zh-CN.md)

# iOS Build and Install

This Workflow builds a physical-device Flow iOS app through BitSky, exports the
App and dSYMs into `<buildRoot>/.vscode-out`, verifies code signing and matching
UUIDs, then installs the App without launching it. dSYM generation is enabled
by default for trace-ready builds.

Prepare a fresh checkout first with
[`ios-cosign-bitsky-install`](../ios-cosign-bitsky-install/README.md).

```bash
deer-workflow run ./examples/ios-build-install/workflow.ts \
  --input '{
    "repositoryRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak",
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "buildRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "udid": "00008030-001A286A2229802E",
    "target": "Grace",
    "mode": "Debug"
  }'
```

`developerDir` is optional. The Workflow checks
`/Applications/Xcode_26.app/Contents/Developer` first and falls back to
`/Applications/Xcode.app/Contents/Developer`; pass it explicitly for another
Xcode installation.

The build command is equivalent to:

```bash
orbit bundle exec bitsky_build \
  --target grace --configuration Debug --sdk os --archs arm64 --dsym \
  --output <buildRoot>/.vscode-out
```

Stable artifacts:

- App: `.vscode-out/Grace.app`
- Main dSYM: `.vscode-out/dSYM/Grace.app.dSYM`
- Recursive symbols: `.vscode-out/dSYM`
- Workflow summary: `/Users/bytedance/.ios_pref_optimizer/ios-build-install/<runId>/build-summary.json`

For Debug builds, the main dSYM matches `Grace.debug.dylib`; the Workflow checks
both the app stub and Debug dylib UUIDs. The default business binary for attach
trace is `FlowDebugBasicDynamic`. Set `symbolsRequired: false` for an ordinary
device build without dSYM; `requireReadySymbols` then defaults to false. Use
`reuseExistingArtifacts: true` to validate and reinstall current `.vscode-out`
artifacts without rebuilding.

The install phase only invokes `xcrun devicectl device install app`; it never
launches the App.
