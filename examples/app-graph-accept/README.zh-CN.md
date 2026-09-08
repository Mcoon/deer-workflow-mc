# App Graph 批量验收

[English](./README.md)

这个 Workflow 串行执行结构化用例的 `Plan → Exec`，聚合
`pass/fail/needs_review/blocked`。它会把完整语义 Plan 传给 Exec，不再裁掉 Graph
identity、device profile、Selectors 或最终 Oracles。
真机执行时，它会在第一个 case 规划前按 Graph 的 `bundleId` 查询已安装 App 版本，并把
该版本透传给每个 Plan 和 Exec，保证整批 Task 健康度与 Binding fallback 判断一致。

单用例的 `goal` 是最佳 Graph intent；未提供时依次尝试 `title` 和 `step`。`expected`
不会拼进规划目标，但会作为未显式提供 `verify/oracles` 时的验收条件来源。简单文本条件由
确定性规则转换，复杂条件交给只读 Agent 编译；也可以直接提供 `verify`（推荐）或
`oracles`。Accept 会将它们规范化为 Graph `TaskOracle`，与
`oracles` 及 Plan 自带的 `finalOracles` 合并、去重后再交给 Exec。无法识别的 `verify`
会阻断该 case，不会被静默忽略。参数化 Task 应通过 `parameters` 传值。

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

`verify` 兼容单个条件、条件数组以及 `oracles`、`conditions`、`assertions`、`checks`
包装对象。结构化条件支持文本全部/任一可见、文本不可见、当前 Scene、前台 Bundle、
视觉变化和区域稳定；简短自然语言支持例如 `显示搜索、技能`、`不显示“错误提示”`。
视觉变化和区域稳定会保留，但当前确定性执行器会将它们标为 `needs_review`。规范化结果与
解析问题会写入每个 case 的 `verification` 字段。
Accept 使用 guarded execution 执行验收，case 专用 Oracle 只影响本次 verdict，不会写入或
降级 Graph 中的可复用 Task。

`planOnly=true` 会完成 Plan 和 Exec 兼容性校验但不操作设备，因此用例 verdict 是
`needs_review`，批次只要没有 `fail/blocked` 仍可成功生成报告。
