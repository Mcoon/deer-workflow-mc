# App Graph Batch Accept

[简体中文](./README.zh-CN.md)

This Workflow runs structured cases serially through `Plan → Exec` and
aggregates `pass`, `fail`, `needs_review`, and `blocked` verdicts. It passes the
complete semantic Plan to Exec, preserving Graph identity, device profile,
selectors, and final Oracles.

An explicit case `goal` is the preferred Graph intent; otherwise Accept tries
`title` and then `step`. `expected` remains acceptance context and is not
concatenated into the planning goal. Pass parameterized Task values through
`parameters`.

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

With `planOnly=true`, Plan and Exec compatibility are validated without device
operations, so the case verdict is `needs_review`.
