# iOS UI Graph v2 Console

[简体中文](./README.zh-CN.md)

This local Bun service adds a control API to the canonical App Graph v2 Map. A
single `ios-executable-ui-graph/v2` drives the complete flow:

- Plan on a Task, Scene, or Operator invokes App Graph Plan;
- Execute calls the unified `app-graph` Workflow, which owns Plan, Exec,
  goal-driven Agent recovery, and bounded re-Plan;
- Continue Discovery requires a user goal and one explicit Element, then runs
  one targeted action; full-Scene exhaustive exploration is forbidden;
- destructive Tasks and Operators require confirmation;
- correction writes use a file-hash concurrency check and increment the numeric
  Graph revision so old Plans become stale;
- a single-device queue protects runs, with status available through `/api/runs`
  and SSE.

The Map header includes an Agent chat panel backed by `/api/chat` and the
currently selected Graph target. Scene nodes, Operator links, Task cards, and
Element entries expose a context menu for Execute Here, Continue Discovery
From Here, and Copy ID. Element execution is normalized to its owning Scene; a
non-Element exploration anchor must be resolved to one explicit Element before
Discovery can run.
Stale Scenes do not expose ordinary Plan or Execute actions. Their Recover
action reuses one historical incoming edge, reaches its still-active source
Scene, and performs one targeted probe on the historical entry Element. The
Scene, Element, and Operator return as candidates only when the new observation
matches the stale target Scene.

Generate the Graph v2 Map first:

```bash
bun run dev -- run examples/app-graph-map-report/workflow.ts \
  --input '{
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "htmlPath": "/tmp/ios_perf-opt/app-graph-map/map.html"
  }'
```

Start Console with that Map directory:

```bash
IOS_UI_GRAPH_MAP_DIRECTORY=/tmp/ios_perf-opt/app-graph-map \
IOS_UI_GRAPH_PATH=/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json \
IOS_UI_GRAPH_CONSOLE_UDID=<device-udid> \
IOS_UI_GRAPH_CONSOLE_DEVICE_PROFILE_ID=iphone-414x896-portrait \
bun run examples/ios-ui-graph-console/server.ts
```

Open `http://127.0.0.1:18765/ui-map/map.html`. Select a Scene, Operator, or Task
to Plan or Execute it. Elements support targeted discovery only; execution
requires an explicit Operator. Without a configured
UDID, Plan remains available while Exec and Discovery return structured
missing-device failures.

The header discovers online physical iOS devices through
`mobilecli devices --platform ios --type real`. A single device is selected
automatically; multiple devices can be switched from the selector or refreshed
manually. Exec and Discovery submit the selected UDID, and the server verifies
that it is still online inside the serialized device queue.
`IOS_UI_GRAPH_CONSOLE_UDID` is now only a default selection.

The Map remains browsable from a generic static server or `file://`, but the
controls report that Console is disconnected.
When the Graph revision changes, the page preserves the current Agent
conversation and shows a manual `Graph rXX · Refresh` button instead of
reloading automatically. The selected Task can still be discussed with the
Agent while execution and exploration remain blocked until that explicit
refresh replaces the stale page data. The latest 50 text messages and selected
node are restored from tab-scoped session storage after a manual refresh.

The canonical Graph is a portable data package:

```text
examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/
├── graph.json
├── indexes/
└── reference-assets/<scene-id>/<content-hash>/
    ├── screenshot.png
    ├── ui-dump.json
    └── ocr.json (optional)
```

`referenceAssets` paths in `graph.json` are relative to that file. Raw run
artifacts remain under `/tmp/ios_perf-opt`; only Scene evidence written to the
Graph is promoted into the content-addressed `reference-assets` directory,
with at most three valid references retained per Scene. Copying the Graph
package therefore does not depend on another machine's temporary or user
directory paths.
