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

Discovery 会等到连续两次页面观测稳定后，才解析或操作焦点 Element。原生页面使用语义
UI 布局指纹；WebView 使用排除系统状态栏后的主体视觉相似度。如果页面稳定后历史
Element 仍缺失，受限只读 Agent 可以判断当前 Scene，并且只能选择当前真实、安全的
candidate。稳定采样、Agent 原始决定和安全校验拒绝原因都会随本次执行证据落盘。

焦点 Element 不在安全可点击区域时，Discovery 与 Exec 使用同一个状态驱动 viewport
search：当前屏先检查，每次只做一段短距离滑动，等待页面稳定后重新检查 live Selector；
viewport 重复或无变化才视为边界并换向。历史坐标不决定方向和次数，每步 fingerprint、
方向和停止原因写入 `viewport-search.json`。

只查看探索计划，不操作设备：

```bash
bun run dev -- run examples/app-graph-discovery/workflow.ts \
  --input '{
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "discoveryRequestPath": "/Users/bytedance/.ios_pref_optimizer/app-graph-exec/.../discovery-request.json",
    "planOnly": true,
    "outputDir": "/Users/bytedance/.ios_pref_optimizer/app-graph-discovery"
  }'
```

也可以直接传 `goal`、`startSceneId` 和必填 `startElementId`。请求中的 Graph ID/revision 不匹配
时会阻断，避免把旧失败证据写到新 Graph。没有合成出 evidence-backed Scene、Operator
或 Task 时不会应用空 patch，也不会无意义递增 Graph revision。

如果 focus Element 只有一个可执行 Operator，Discovery 会自动用该 Operator 的
`toSceneId` 验证跳转结果。同一列表行存在整行与行内文字两个同名 AX 节点时，只在两者
几何重叠时选择面积更大的整行；真正位于不同位置的同名控件仍视为歧义。没有执行任何
动作且 Agent 也未确认目标时返回 `focus_element_unresolved`，不会再返回零动作成功。
