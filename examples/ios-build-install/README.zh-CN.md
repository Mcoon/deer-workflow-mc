[English](./README.md) | 简体中文

# iOS Build and Install

该 Workflow 使用 BitSky 构建 Flow iOS 真机 App，把 App 和 dSYM 导出到
`<buildRoot>/.vscode-out`，校验签名及 UUID 后通过 `devicectl` 只安装、不启动。
用于 trace 时默认生成 dSYM。

新 checkout 请先运行
[`ios-cosign-bitsky-install`](../ios-cosign-bitsky-install/README.zh-CN.md)。

```bash
deer-workflow run ./examples/ios-build-install/workflow.ts \
  --input '{
    "repositoryRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak",
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "buildRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "udid": "00008030-001A286A2229802E",
    "target": "Grace",
    "mode": "Debug",
    "developerDir": "/Applications/Xcode_26.app/Contents/Developer"
  }'
```

等价构建命令：

```bash
orbit bundle exec bitsky_build \
  --target grace --configuration Debug --sdk os --archs arm64 --dsym \
  --output <buildRoot>/.vscode-out
```

稳定产物：

- App：`.vscode-out/Grace.app`
- 主 dSYM：`.vscode-out/dSYM/Grace.app.dSYM`
- 递归符号目录：`.vscode-out/dSYM`
- Workflow summary：`/tmp/ios_perf-opt/ios-build-install/<runId>/build-summary.json`

Debug 构建的主 dSYM 匹配 `Grace.debug.dylib`，Workflow 会同时检查 App stub 与
Debug dylib UUID。Attach Trace 默认业务二进制为 `FlowDebugBasicDynamic`。普通真机包
可传 `symbolsRequired: false` 关闭 dSYM，此时 `requireReadySymbols` 默认同步关闭。
传 `reuseExistingArtifacts: true` 可跳过构建，重新校验并安装 `.vscode-out` 产物。

安装阶段只调用 `xcrun devicectl device install app`，不会启动 App。
