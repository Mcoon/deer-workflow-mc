# iOS UI Semantic Map Report

[简体中文](./README.zh-CN.md)

This Workflow renders an executable iOS UI graph as an interactive HTML map.
It shows:

- four HTML/CSS-first views:
  - `Graph`, grouped into Chat, Skills, Settings, Camera, Photos & Files, and
    Cloud Drive modules;
  - `Elements`, the default view with every Element, role, Binding status, and
    Operator usage count;
  - `States`, with every State Variant and fact expanded;
  - `Operators`, grouped by Scene and risk;
- Operator transition edges grouped by risk;
- verified Task execution sequences;
- Task selection that highlights its Operator path and traversed Scenes;
- selectors, bindings, effects, and postconditions;
- reference screenshots copied beside the HTML report.
- optional crawler-state coverage for scanned Scenes, conditional blocks,
  completed Actions, backlog, and skipped candidates.
- an Obsidian-style relationship view with node dragging, canvas pan/zoom,
  Task-path highlighting, Scene details, and node context menus;
- an optional Graph Console connection for exact execution, scoped continued
  exploration, Agent chat, Workflow phase events, and correction proposals.

The report keeps complete static entity content in the HTML, while the default
Obsidian relationship view uses its generated JavaScript and CSS assets for
canvas interaction. When served by the
[iOS UI Graph Console](../ios-ui-graph-console/README.md), right-click actions
and Agent chat call the existing Workflows. A generic static server remains a
read-only Graph viewer.

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-semantic-map-report/workflow.ts \
  --input '{
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-experiment/graph-chat-full.json",
    "htmlPath": "/Users/bytedance/Documents/BDWorkSpace/ios-perf-optimizer/assets/app-regression/com.bot.doubao/ui-map/map.html",
    "discoveryStatePath": "/tmp/ios_perf-opt/ios-ui-graph-discovery/doubao-app-crawl-v1/state.json"
  }'
```

Start the interactive control service after generation:

```bash
bun run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-console/server.ts
```

Then open `http://127.0.0.1:18765/ui-map/map.html`.
