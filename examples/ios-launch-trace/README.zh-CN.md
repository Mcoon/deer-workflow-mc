# iOS Launch Trace

这个示例会采集真机 iOS 启动 Time Profiler trace，并生成一个接近 Instruments
观感的自包含 HTML 时间线。它刻意保持为确定性的采集 Workflow：TypeScript 负责
步骤编排，trace 采集本身不需要 Agent 参与。

## 功能

1. 在 `/Users/bytedance/.ios_pref_optimizer/ios-launch-trace/` 下准备输出目录；
2. 按需安装本地 App、终止旧进程，并直接执行 `xctrace record --launch`；
3. 完成 trace 符号化，导出 `time_profile.xml` 与 `os_signpost.xml`，并对未解析的第一方 frame 执行 fail-closed
   atos 恢复；
4. 生成 `launch-trace-report.html`，包含时间标尺、独立 `os_signpost` 区间轨道、
   线程 flame timeline、Top sampled frames 和产物路径。

终端会把 Workflow 的长耗时步骤显示为独立阶段：`Install`、
`Launch & Record`、`Symbolicate`、`Export` 和 `Backfill Symbols`。其中
`timeLimit` 只计算 xctrace 真正开始录制后的时长；设备握手、trace 保存、符号化、
XML 导出和 atos 回填可能继续耗时，但不会再统一显示成一个不透明的 `Collect`。

Workflow 已在本仓库内自包含，不需要额外 checkout `ios-perf-optimizer`。除非设置
`skipInstall`，否则它会安装传入的 `.app`。运行机仍需有 `python3`，用于仓库内置的
XML 解析与符号恢复辅助逻辑；不需要安装第三方 Python 包。

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

返回 JSON 会包含原始 `.trace`、导出的 XML、Workflow summary 和 HTML report
路径。

## 输入

- `repositoryRoot`：Git 仓库根；Florak 下是 monorepo 根。
- `projectRoot`：目标 iOS 源码根。
- `buildRoot`：包含 `.vscode-out` 的 BitSky 构建根，默认等于 `projectRoot`。
- `developerDir`：可选完整 Xcode Developer 目录，通过 `DEVELOPER_DIR` 注入，
  不修改系统 `xcode-select`。Workflow 先检查 `Xcode_26.app`，再检查标准
  `Xcode.app`；其他 Xcode 安装路径需显式传入。
- `udid`：传给 `xctrace` 的真机 UDID。
- `bundleId`：Time Profiler 启动的 bundle identifier，默认
  `com.bot.doubao`。
- `appPath`：已有 `.app` bundle。不传时使用 Workflow 默认值：
  `<buildRoot>/.vscode-out/Grace.app`。
- `dsymPath`：匹配的 `.app.dSYM`。不传时使用 BitSky 默认路径
  `<buildRoot>/.vscode-out/dSYM/Grace.app.dSYM`。
- `symbolSearchPath`：递归传给 `xctrace symbolicate` 的目录；默认使用
  `dsymPath` 的父目录，通常为 `.vscode-out/dSYM`。
- `timeLimit`：xctrace 采集时长，例如 `20s`。
- `skipInstall`：采集前跳过安装 `.app`。
- `outputDir`：输出目录，默认是
  `/Users/bytedance/.ios_pref_optimizer/ios-launch-trace/<runId>`。
- `htmlReportPath`：HTML 报告目标路径，默认是
  `<outputDir>/launch-trace-report.html`。
- `targetBinary`：HTML 中高亮为业务代码的 binary，默认 `Grace`。
- `businessBinary`：用于校验源码覆盖的 framework，默认
  `FlowDebugBasicDynamic`。
- `maxSamples` / `maxDepth`：大 trace 的渲染上限。默认 `maxSamples` 足够覆盖
  常见 20s / 1ms 的启动 trace；调低后视图会变成近似展示。

## 输出

一次正常的 launch 采集会在输出目录里生成：

- `launch_target.trace`
- `symbolicated.trace`
- `toc.xml`
- `time_profile.xml`
- `os_signpost.xml`
- `summary.json`
- `launch-trace-report.html`

HTML 报告是辅助浏览视图，不能替代 Instruments。点击 frame 时会把 sample
weight 和 wall-clock range 分开显示，避免把 `main` 这类入口 frame 或
`flow_main()` 这类 App wrapper 误看成单个方法的独占耗时。当 `time_profile.xml`
不包含精确时间戳时，报告会按采样行顺序铺开，并用 `timeLimit` 生成近似时间标尺。

Signpost 轨道与 flame graph 共用时间轴；重叠区间会自动分配到不同 lane。点击区间
可以查看名称、subsystem/category、线程、message、起止时间与 duration。报告只展示
本次被启动目标进程产生的 signpost。

如果前置检查在 `xctrace` 启动前失败，例如默认 dSYM 缺失，Workflow 会先写出
HTML 诊断报告，然后以失败退出，不再把这类情况展示成成功采集。
Workflow 确认同一二进制与 dSYM 的 UUID 不一致，或符号状态为 `missing` 时，也会保留原始 trace
并报错。使用 `skipInstall: true` 时，必须提供设备上该构建对应的符号；也可改为
`skipInstall: false`，安装本地 App 后重新采集。Debug 包的 `Grace.app.dSYM`
可能存放 `Grace.debug.dylib` 的符号，必须按 DWARF 二进制名比较 UUID，不能按
dSYM 包名比较。Workflow 会统计 `FlowDebugBasicDynamic`，并展开 XML 中的
frame/backtrace 引用后计算源码覆盖。主线程仍有裸地址时，状态为 `partial`，并记录
未解析及缺少镜像映射的采样数；不能仅凭部分源码覆盖判定全部符号解析成功。

`xctrace --launch` 的早期样本偶尔不会登记 `Grace.debug.dylib` image，导致第一方
frame 没有 binary UUID。Workflow 会对无镜像地址做 fail-closed 回填：只有主地址簇
占比足够高、能从 Mach-O `__TEXT,__text` 推导本次 ASLR 基址、启动锚点匹配且 atos
抽样解析率达到阈值时才写回符号。基址不会固定成 `0x300000000`；不同 launch
可能不同。无法验证的地址继续保留为裸地址。

使用 `skipInstall: true` 时，`xctrace symbolicate` 可能因为 launch trace 完全漏登记
Debug dylib image 而返回 55（`No dSYMs were found or relevant`）。这类特定错误会
回退到原始 trace XML，并继续执行上述 fail-closed atos 校验；校验通过才成功，否则
仍以符号缺失失败，并建议改用 `skipInstall: false` 安装本地配套 App。其他 xctrace
symbolicate 错误不会降级。
