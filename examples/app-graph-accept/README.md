# App Graph Batch Accept

[简体中文](./README.zh-CN.md)

This Workflow runs structured cases serially through `Plan → Exec` and
aggregates `pass`, `fail`, `needs_review`, and `blocked` verdicts. It passes the
complete semantic Plan to Exec, preserving Graph identity, device profile,
selectors, and final Oracles.
For device runs, it resolves the installed version for the Graph's `bundleId`
before planning the first case and passes that version through every Plan and
Exec call. This keeps Task freshness and Binding fallback decisions consistent
across the whole batch.

An explicit case `goal` is the preferred Graph intent; otherwise Accept tries
`title` and then `step`. `expected` is not concatenated into the planning goal,
but it becomes the verification source when `verify` and `oracles` are absent.
Simple text conditions are compiled deterministically and complex conditions
use a read-only Agent. Callers can also provide machine-checkable criteria in
`verify` (preferred) or `oracles`.
Accept normalizes `verify` into Graph `TaskOracle` entries, merges and
deduplicates them with `oracles` and the Plan's `finalOracles`, then passes the
complete Plan to Exec. Unsupported `verify` conditions block the case instead
of being silently ignored. Pass parameterized Task values through `parameters`.

```bash
bun run dev -- run examples/app-graph-accept/workflow.ts \
  --input '{
    "case": {
      "case_id": "sidebar-1",
      "title": "打开侧边栏",
      "goal": "打开侧边栏",
      "step": "点击左上角对话列表按钮",
      "expected": "显示搜索、技能和云盘",
      "verify": {
        "checks": [
          { "type": "visible", "text": "搜索" },
          "显示技能、云盘"
        ]
      }
    },
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "planOnly": true,
    "outputDir": "/Users/bytedance/.ios_pref_optimizer/app-graph-accept"
  }'
```

`verify` accepts one condition, an array, or an `oracles`, `conditions`,
`assertions`, or `checks` wrapper. Structured conditions support all/any text
visible, absent text, current Scene, foreground Bundle, visual change, and
region stability. Short text conditions such as `显示搜索、技能` and
`不显示“错误提示”` are also supported. Visual-change and region-stability
conditions are preserved but currently produce `needs_review` in deterministic
Exec. Each case result records normalized conditions and parse issues in
`verification`.
Accept uses guarded execution. Case-only Oracles affect only that run's verdict
and are not learned into or used to downgrade reusable Graph Tasks.

With `planOnly=true`, Plan and Exec compatibility are validated without device
operations, so the case verdict is `needs_review`.
