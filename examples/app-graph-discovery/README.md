# App Graph Targeted Discovery

[简体中文](./README.zh-CN.md)

This Workflow starts from a known Scene or an
`app-graph-discovery-request/v1` emitted by a failed Exec step. It first writes
an `app-graph-discovery-plan/v1` containing the user goal, focused Element,
selectors, known Operators, allowed actions, budgets, and evidence paths.

This Workflow is not a page crawler. It requires a `goal` and one explicit
focus Element, executes one goal-relevant action, records one before/after
transition, and stops. If that action opens a new page, visible Elements are
captured but never clicked automatically. Multi-page goals belong to the
unified `app-graph` Workflow, where Exec grounds after every step and either
chooses another goal-relevant action or returns a structured error.

Compile the discovery plan without touching a device:

```bash
bun run dev -- run examples/app-graph-discovery/workflow.ts \
  --input '{
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "discoveryRequestPath": "/tmp/ios_perf-opt/app-graph-exec/.../discovery-request.json",
    "planOnly": true,
    "outputDir": "/tmp/ios_perf-opt/app-graph-discovery"
  }'
```

Callers may instead provide `goal`, `startSceneId`, and required
`startElementId`. Graph
ID or revision drift blocks a stale request. An empty synthesis does not apply
an empty patch or increment the Graph revision.
