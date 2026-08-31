# iOS Functional Regression

这个 Workflow 消费已经验证通过的 case 资产，使用 `mobilecli` 在同一台 iPhone 上
串行执行所有 case，并输出逐 case 证据和 HTML 汇总报告。

它不会在执行时让 Agent 重新理解操作步骤，也不会使用 Midscene 临场猜测控件。

## Navigate Action

已知页面路径可以只声明目标页面：

```json
{
  "actionId": "go-to-image-send-ready",
  "type": "navigate",
  "targetPage": "图片发送确认页",
  "allowCategories": ["navigation", "selection"]
}
```

Workflow 会在执行前读取 `graph.json`，把 `navigate` 展开为固定的
terminate/launch/tap/wait/snapshot actions。执行阶段不会临场重新规划，也不会调用
模型。

`mutation` 不会被默认允许。要执行发送、删除等副作用动作，case 必须显式包含后续
action，或在导航时显式允许 `mutation`。

## 运行 P0 Smoke

```bash
deer-workflow run /Users/bytedance/Documents/deer-workflow-mc/examples/ios-functional-regression/workflow.ts \
  --input '{
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "udid": "00008030-001A286A2229802E",
    "bundleId": "com.bot.doubao",
    "caseSetPath": "/Users/bytedance/Documents/BDWorkSpace/ios-perf-optimizer/assets/app-regression/com.bot.doubao/cases/doubao-message-regression.cases.json",
    "priorities": ["P0"]
  }'
```

也可以用 `tags` 或 `caseIds` 过滤：

```json
{
  "tags": ["message"],
  "caseIds": ["send-text", "send-image"]
}
```

## 执行策略

- 运行前再次校验 `pageId`、`controlId` 和 tap guard。
- 每个 case、每个设备动作严格串行。
- 点击时优先匹配当前 UI dump 的 selector。
- UI dump 无法匹配时，只有当前页面已验证并且 device profile 一致，才使用坐标
  binding。
- 每个关键断言都会采集截图和 UI dump。
- 匹配歧义、页面不一致、控件缺失时 fail fast，不猜测点击。

## 录屏

第一版的硬证据是逐步骤截图和 UI dump。`captureVideo=true` 当前会明确拒绝执行，
因为独立的 `mobilecli screenrecord` 与输入命令会争用同一设备锁。后续应由设备层
提供一个单一持锁会话，在同一会话里同时采集视频并执行输入，不能在 Workflow 内
并发两个 `mobilecli` 进程。

## 输出

```text
/tmp/ios_perf-opt/ios-functional-regression/<run_id>/
  case-run/<case_id>/
    *.png
    *.ui.json
    *.stdout.txt
    *.stderr.txt
    result.json
  summary.json
  functional-regression-report.html
```
