# iOS Build and Install

这个示例会构建带 dSYM 的 flow_iOS App，并把生成的 `.app` 只安装到真机上，
不启动 App。它是 [iOS Launch Trace](../ios-launch-trace/README.zh-CN.md) 的
前置准备 Workflow。

## 功能

1. 运行 `flow-ios-dev/scripts/build_app.py --symbols-required`；
2. 校验构建返回了 `.app`、`.app.dSYM`，且 `symbolication_status` 为 `ready`；
3. 用 `xcrun devicectl device install app` 安装 App；
4. 返回可以直接传给 launch trace Workflow 的 `appPath` 和 `dsymPath`。

它不会调用 `flow-ios-dev deploy.py`、`ios-deploy` 或任何 install-and-run 包装。
安装阶段只安装不启动，后续 Time Profiler 采集仍然可以作为第一次启动。

## 运行

```bash
deer-workflow run ./examples/ios-build-install/workflow.ts \
  --input '{
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
    "udid": "00008030-001A286A2229802E",
    "mode": "Debug"
  }'
```

返回 JSON 会包含：

- `appPath`
- `dsymPath`
- `symbolicationStatus`
- `buildSummaryPath`
- `installJsonPath`
- `installLogPath`

然后把返回路径传给 launch trace：

```bash
deer-workflow run ./examples/ios-launch-trace/workflow.ts \
  --input '{
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
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

- `projectRoot`：目标 iOS 工程根目录。
- `udid`：只安装到真机时使用的设备 UDID。
- `buildScriptPath`：`build_app.py` 路径，默认指向已安装的 `flow-ios-dev`
  Skill。
- `mode`：`Debug` 或 `Release`，默认 `Debug`。
- `symbolsRequired`：默认 `true`；Time Profiler 场景应保持开启。
- `requireReadySymbols`：默认 `true`；dSYM 元数据缺失或不完整时失败。
- `noKeepGoing`：传递 `--no-keep-going` 给 `build_app.py`。
- `outputDir`：输出目录，默认在 `/tmp/ios_perf-opt` 下。
- `installTimeoutSeconds`：devicectl 安装超时，默认 `180` 秒。

## 失败行为

构建失败时不会继续安装。`need_cosign` 这类 action 会保留在
`build-summary.json` 里，调用方可以按正常签名修复流程处理后再重试。
