English | [简体中文](./README.zh-CN.md)

# iOS Cosign and BitSky Install

This Workflow prepares a Flow iOS checkout for BitSky device builds. It runs,
in order, repository-native cosign, `orbit bundle install`, and
`bitsky_install`. It does not build, install, or launch the app.

```bash
deer-workflow run ./examples/ios-cosign-bitsky-install/workflow.ts \
  --input '{
    "repositoryRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak",
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "udid": "00008030-001A286A2229802E",
    "target": "Grace",
    "configuration": "Debug",
    "developerDir": "/Applications/Xcode_26.app/Contents/Developer"
  }'
```

Outputs are written under
`/tmp/ios_perf-opt/ios-cosign-bitsky-install/<runId>/`. Continue with
[`ios-build-install`](../ios-build-install/README.md) to build dSYMs and install
without launching.

The old `examples/ios-cosign-jojo-install/workflow.ts` path is retained as a
compatibility entry point and now delegates to this BitSky Workflow.
