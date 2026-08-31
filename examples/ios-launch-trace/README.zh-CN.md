# iOS Launch Trace

这个示例会采集真机 iOS 启动 Time Profiler trace，并生成一个接近 Instruments
观感的自包含 HTML 时间线。它刻意保持为确定性的采集 Workflow：TypeScript 负责
步骤编排，trace 采集本身不需要 Agent 参与。

## 功能

1. 在 `/tmp/ios_perf-opt/ios-launch-trace/` 下准备输出目录；
2. 以 `launch` 模式运行已有的 `flow-ios-trace-collection`
   `collect_trace.py` 脚本；
3. 读取 `summary.json` 和 `time_profile.xml`；
4. 生成 `launch-trace-report.html`，包含时间标尺、采样密度条、主线程
   flame timeline、Top sampled frames 和产物路径。

Workflow 不会修改 `ios-perf-optimizer` 或目标 App。除非设置 `skipInstall`，否则
底层 collector 可能会安装传入的 `.app`。

## 运行

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

返回 JSON 会包含原始 `.trace`、导出的 XML、collector summary 和 HTML report
路径。

## 输入

- `repositoryRoot`：Git 仓库根；Florak 下是 monorepo 根。
- `projectRoot`：目标 iOS 源码根。
- `buildRoot`：包含 `.vscode-out` 的构建根，默认等于 `projectRoot`。
- `udid`：传给 `xctrace` 的真机 UDID。
- `bundleId`：Time Profiler 启动的 bundle identifier，默认
  `com.bot.doubao`。
- `collectorScriptPath`：`collect_trace.py` 路径，默认指向本机
  `ios-perf-optimizer` checkout。
- `appPath`：已有 `.app` bundle。不传时使用 collector 默认值：
  `<buildRoot>/.vscode-out/Grace.app`。
- `dsymPath`：匹配的 `.app.dSYM`。不传时使用 collector 默认值：
  `<buildRoot>/.vscode-out/Grace.app.dSYM`。Workflow 不会主动扫描
  dSYM；如果构建产物在别处，需要显式传绝对路径 `dsymPath`。
- `timeLimit`：xctrace 采集时长，例如 `20s`。
- `skipInstall`：采集前跳过安装 `.app`。
- `outputDir`：输出目录，默认是
  `/tmp/ios_perf-opt/ios-launch-trace/<runId>`。
- `htmlReportPath`：HTML 报告目标路径，默认是
  `<outputDir>/launch-trace-report.html`。
- `targetBinary`：HTML 中高亮为业务代码的 binary，默认 `Grace`。
- `maxSamples` / `maxDepth`：大 trace 的渲染上限。默认 `maxSamples` 足够覆盖
  常见 20s / 1ms 的启动 trace；调低后视图会变成近似展示。

## 输出

一次正常的 launch 采集会在输出目录里生成：

- `launch_target.trace`
- `toc.xml`
- `time_profile.xml`
- `summary.json`
- `launch-trace-report.html`

HTML 报告是辅助浏览视图，不能替代 Instruments。点击 frame 时会把 sample
weight 和 wall-clock range 分开显示，避免把 `main` 这类入口 frame 或
`flow_main()` 这类 App wrapper 误看成单个方法的独占耗时。当 `time_profile.xml`
不包含精确时间戳时，报告会按采样行顺序铺开，并用 `timeLimit` 生成近似时间标尺。

如果 collector 在 `xctrace` 启动前失败，例如默认 dSYM 缺失，Workflow 会先写出
HTML 诊断报告，然后以失败退出，不再把这类情况展示成成功采集。
