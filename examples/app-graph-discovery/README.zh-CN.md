# App Graph 定向探索

[English](./README.md)

这个 Workflow 从一个已知 Scene 或 Exec 失败产生的
`app-graph-discovery-request/v1` 开始定向探索。它先生成
`app-graph-discovery-plan/v1`，列出用户 goal、焦点 Element、Selectors、已有 Operator、
允许动作、预算和证据路径。

这个 Workflow 不是页面爬虫。它强制要求 `goal` 和一个明确的焦点 Element，每次只执行
一个与 goal 对应的动作，记录一次 before/after 转换后立即停止；即使进入新页面，也只
采集新页面可见 Element，不会继续点击。多页面目标应交给统一 `app-graph` Workflow，
由 Exec 在每一步后重新 Ground，并根据 goal 决定下一步或返回结构化错误。

只查看探索计划，不操作设备：

```bash
bun run dev -- run examples/app-graph-discovery/workflow.ts \
  --input '{
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "discoveryRequestPath": "/tmp/ios_perf-opt/app-graph-exec/.../discovery-request.json",
    "planOnly": true,
    "outputDir": "/tmp/ios_perf-opt/app-graph-discovery"
  }'
```

也可以直接传 `goal`、`startSceneId` 和必填 `startElementId`。请求中的 Graph ID/revision 不匹配
时会阻断，避免把旧失败证据写到新 Graph。没有合成出 evidence-backed Scene、Operator
或 Task 时不会应用空 patch，也不会无意义递增 Graph revision。
