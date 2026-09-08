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

Discovery waits for two consecutive stable observations before resolving or
acting on the focus Element. Native pages use semantic UI-layout fingerprints;
WebViews use status-bar-excluded visual similarity. If a stale historical
Element is still missing after the page stabilizes, a bounded read-only Agent
may identify the current Scene and choose only a real safe candidate. Agent
decisions, rejection reasons, and stability samples are persisted alongside
the run evidence.

If the focus Element is not in the safe visible region, Discovery uses the same
state-driven viewport search as Exec. It moves one short segment, waits for a
stable observation, and checks the live selector again. Historical coordinates
never decide scroll direction or count. The per-move fingerprints, directions,
and stop reason are written to `viewport-search.json`.

Compile the discovery plan without touching a device:

```bash
bun run dev -- run examples/app-graph-discovery/workflow.ts \
  --input '{
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "discoveryRequestPath": "/Users/bytedance/.ios_pref_optimizer/app-graph-exec/.../discovery-request.json",
    "planOnly": true,
    "outputDir": "/Users/bytedance/.ios_pref_optimizer/app-graph-discovery"
  }'
```

Callers may instead provide `goal`, `startSceneId`, and required
`startElementId`. Graph
ID or revision drift blocks a stale request. An empty synthesis does not apply
an empty patch or increment the Graph revision.

When a focus Element has one executable Operator, Discovery uses that
Operator's `toSceneId` to verify the transition. Duplicate accessibility nodes
for one list row resolve to the largest overlapping row, while duplicate labels
at separate locations remain ambiguous. A run with no executed action and no
Agent-confirmed target returns `focus_element_unresolved`; it is never reported
as a successful exploration.
