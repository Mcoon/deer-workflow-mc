# iOS Build and Install

这个示例会构建带 dSYM 的 flow_iOS App，并把生成的 `.app` 只安装到真机上，
不启动 App。它是 [iOS Launch Trace](../ios-launch-trace/README.zh-CN.md) 的
前置准备 Workflow。

## 功能

1. 运行 `flow-ios-dev/scripts/build_app.py --symbols-required`；
2. 校验构建返回了 `.app`、`.app.dSYM`，且 `symbolication_status` 为 `ready`；
3. 用 `xcrun devicectl device install app` 安装 App；
4. 返回 launch trace 使用的 `appPath`、主壳 `dsymPath`，以及 attach trace
   递归符号化 GraceCore 所需的 `businessDsymPath` 和 `symbolSearchPath`。

它不会调用 `flow-ios-dev deploy.py`、`ios-deploy` 或任何 install-and-run 包装。
安装阶段只安装不启动，后续 Time Profiler 采集仍然可以作为第一次启动。

新 checkout 尚未准备签名或 `.jojo` 依赖时，先运行
[iOS 签名与 JoJo 依赖安装](../ios-cosign-jojo-install/README.zh-CN.md)。本 Workflow
不会隐式初始化依赖。

## 运行

```bash
deer-workflow run ./examples/ios-build-install/workflow.ts \
  --input '{
    "repositoryRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak",
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "buildRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "udid": "00008030-001A286A2229802E",
    "mode": "Debug"
  }'
```

返回 JSON 会包含：

- `appPath`
- `dsymPath`
- `businessDsymPath`
- `symbolSearchPath`
- `symbolicationStatus`
- `buildSummaryPath`
- `installJsonPath`
- `installLogPath`

`dsymPath` 继续表示主壳 `Grace.app.dSYM`，用于兼容 launch collector 的主可执行
文件 UUID 校验。显式调用 `ios-attach-trace` 时可以传 `symbolSearchPath`；不传时，
该 Workflow 会自动读取最近一次匹配项目的 `ios-build-install` summary。

然后把返回路径传给 launch trace：

```bash
deer-workflow run ./examples/ios-launch-trace/workflow.ts \
  --input '{
    "repositoryRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak",
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "buildRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "udid": "00008030-001A286A2229802E",
    "bundleId": "com.bot.doubao",
    "appPath": "<ios-build-install 返回的 appPath>",
    "dsymPath": "<ios-build-install 返回的 dsymPath>",
    "timeLimit": "10s",
    "skipInstall": true
  }'
```

如果你确认前一步安装的就是同一个 `appPath`，trace 步骤可以使用
`skipInstall: true`。

## 输入

- `repositoryRoot`：Git 仓库根；Florak 下是 monorepo 根。
- `projectRoot`：包含 `Modules/`、`Flow/` 和 `Podfile` 的 iOS 源码根。
- `buildRoot`：传给 `flow-ios-dev` 的构建根，默认等于 `projectRoot`。Florak
  没有 MBox workspace，因此也是 `flow/ios`。
- `udid`：只安装到真机时使用的设备 UDID。
- `buildScriptPath`：`build_app.py` 路径，默认指向已安装的 `flow-ios-dev`
  Skill。
- `existingBuildSummaryPath`：复用一次成功的 `build_app.py` JSON summary，跳过
  重建并直接进入校验和 install-only。
- `mode`：`Debug` 或 `Release`，默认 `Debug`。
- `symbolsRequired`：默认 `true`；Time Profiler 场景应保持开启。
- `requireReadySymbols`：默认 `true`；要求主 App dSYM 存在且
  `symbolication_status=ready`。`GraceCore.framework.dSYM` 是 attach trace
  源码级分析的可选增强，不再阻止构建产物安装。
- `noKeepGoing`：传递 `--no-keep-going` 给 `build_app.py`。
- `outputDir`：输出目录，默认在 `/tmp/ios_perf-opt` 下。
- `installTimeoutSeconds`：devicectl 安装超时，默认 `180` 秒。

## 失败行为

构建失败时不会继续安装。`need_cosign` 这类 action 会保留在
`build-summary.json` 里，调用方可以按正常签名修复流程处理后再重试。
