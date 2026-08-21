# App Graph 批量验收

[English](./README.md)

这个 Workflow 串行执行结构化用例的 `Plan → Exec`，聚合
`pass/fail/needs_review/blocked`。它会把完整语义 Plan 传给 Exec，不再裁掉 Graph
identity、device profile、Selectors 或最终 Oracles。

单用例的 `goal` 是最佳 Graph intent；未提供时依次尝试 `title` 和 `step`。`expected`
只作为验收说明保存，不会拼进规划目标。参数化 Task 应通过 `parameters` 传值。

```bash
bun run dev -- run examples/app-graph-accept/workflow.ts \
  --input '{
    "case": {
      "case_id": "sidebar-1",
      "title": "打开侧边栏",
      "goal": "打开侧边栏",
      "step": "点击左上角对话列表按钮",
      "expected": "显示搜索、技能和云盘"
    },
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "planOnly": true,
    "outputDir": "/tmp/ios_perf-opt/app-graph-accept"
  }'
```

`planOnly=true` 会完成 Plan 和 Exec 兼容性校验但不操作设备，因此用例 verdict 是
`needs_review`，批次只要没有 `fail/blocked` 仍可成功生成报告。
