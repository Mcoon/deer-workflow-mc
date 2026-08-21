# iOS Attach Trace

这个示例会把 Time Profiler attach 到已经运行中的 iOS App，并生成和 launch
trace 示例相同的自包含 HTML 时间线。它适合手动操作采集：先把 App 跑起来，再启动
Workflow，在录制阶段操作手机，等 `xctrace` 到达时间上限后自动停止、导出和渲染。

## 功能

1. 在 `/tmp/ios_perf-opt/ios-attach-trace/` 下准备输出目录；
2. 按指定时长运行 `xcrun xctrace record --template "Time Profiler" --attach <target>`；
3. 导出 `toc.xml` 和 `time_profile.xml`；
4. 复用 launch trace 的 parser 解析 Time Profiler 行；
5. 生成 `attach-trace-report.html`，包含同样的可缩放时间线、frame 详情、Top
   sampled frames 和产物路径。

Workflow 不会安装、启动、终止或控制 App。进入 Collect 阶段前，目标 App 进程必须
已经在设备上运行。

## 运行

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

进入 `Record` 阶段后，等日志出现 `Time Profiler has attached and is recording`
再在手机上操作 App。到达 `timeLimit` 后录制会自动停止。之后 `Save Trace` 阶段可能
还会耗时，因为 `xctrace` 正在写 `.trace` bundle；这段不再是录制时间。随后
Workflow 会导出 XML 并生成 HTML 报告。

## 输入

- `projectRoot`：目标 iOS 工程根目录。
- `udid`：传给 `xctrace` 的真机 UDID。
- `bundleId`：写入 summary 和报告的 bundle identifier，默认
  `com.bot.doubao`。
- `attachTarget`：传给 `xctrace record --attach` 的进程名或 pid。默认使用
  `targetBinary`，通常是 `Grace`。当传入进程名时，Workflow 会先用
  `devicectl` 把正在运行的主 App 进程解析成具体 PID，再 attach 这个 PID。
  如果 `xctrace` 提示进程名有歧义，按失败诊断里列出的数字 PID 重新传入。
- `template`：xctrace template 名称或路径，默认 `Time Profiler`。
- `timeLimit`：录制时长，默认 `30s`。
- `outputDir`：输出目录，默认
  `/tmp/ios_perf-opt/ios-attach-trace/<runId>`。
- `htmlReportPath`：HTML 报告目标路径，默认
  `<outputDir>/attach-trace-report.html`。
- `targetBinary`：HTML 中高亮为业务代码的 binary，默认 `Grace`。
- `maxSamples` / `maxDepth`：大 trace 的渲染上限。

## 输出

一次正常的 attach 采集会在输出目录里生成：

- `attach_target.trace`
- `toc.xml`
- `time_profile.xml`
- `summary.json`
- `attach-trace-report.html`

HTML viewer 和 launch trace 报告保持一致：打开时默认 fit 到全局，支持缩放和搜索，
并把 sample weight 与 wall-clock range 分开显示。

`summary.json` 也会记录 `record.started_at`、`record.finished_at`、
`record.observed_recording_started_at` 和
`record.observed_recording_finished_at`。如果终端里某个阶段看起来很长，可以用这些
字段判断耗时是真正的 Time Profiler 录制、`xctrace` attach 前准备，还是录制结束后的
trace 保存。
