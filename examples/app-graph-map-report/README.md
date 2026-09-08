# App Graph v2 Map

[简体中文](./README.zh-CN.md)

This Workflow renders an `ios-executable-ui-graph/v2` as interactive HTML. The
Map shows Scenes, Elements, Operators, Tasks, risk, status, and revision. When
served by iOS UI Graph Console it also invokes Plan, Exec, Discovery, and a
Graph Agent chat panel. Scene nodes, Operator links, Task cards, and
Element/Operator entries in details have a context menu for Execute Here,
Continue Discovery From Here, and Copy ID.

Execute Here on an Element safely targets its owning Scene instead of guessing
an unspecified business action. Discovery from Scene/Operator/Task first
resolves the anchor Scene, then requires the user to select one explicit
Element. The final request remains one goal-scoped, depth-zero Discovery action.

```bash
bun run dev -- run examples/app-graph-map-report/workflow.ts \
  --input '{
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "htmlPath": "/Users/bytedance/.ios_pref_optimizer/app-graph-map/map.html"
  }'
```

Static serving remains read-only. Follow the
[Console documentation](../ios-ui-graph-console/README.md) to enable the local
control API.
