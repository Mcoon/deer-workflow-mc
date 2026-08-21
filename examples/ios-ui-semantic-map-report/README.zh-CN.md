# iOS UI 语义 Graph 报告

[English](./README.md)

这个 Workflow 将可执行 iOS UI Graph 渲染为交互式 HTML，展示：

- 四个纯 HTML/CSS 视图：
  - `Graph`：按 Chat、Skills、Settings、Camera、Photos & Files、Cloud Drive 分区；
  - `Elements`：默认视图，直接列出全部 Element、角色、Binding 状态和 Operator 使用数；
  - `States`：展开全部 State Variant 和事实；
  - `Operators`：按 Scene 和风险分类列出全部 Operator；
- 按风险分类的 Operator 转换边；
- verified Task 的执行顺序；
- 点击 Task 后高亮对应 Operator 路径和经过的 Scene；
- selector、Binding、Effect 和 Postcondition；
- 复制到 HTML 相邻目录的参考截图。
- 可选接入 crawler `state.json`，展示 scanned、conditional blocked、completed action、
  backlog 和 skipped 覆盖统计。
- Obsidian 风格关系图，支持节点拖动、画布平移缩放、Task 路径高亮、Scene 详情和节点
  右键菜单；
- 可选连接 Graph Console，实现精确执行、定向继续探索、Agent 对话、Workflow 阶段
  事件和纠错提案。

HTML 中仍保留完整静态实体内容；默认 Obsidian 关系图通过生成的 JavaScript 和 CSS
资源提供画布交互。使用
[iOS UI Graph 控制台](../ios-ui-graph-console/README.zh-CN.md) 提供页面时，右键动作和
Agent 对话会调用现有 Workflow；普通静态服务器只提供只读 Graph。

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-semantic-map-report/workflow.ts \
  --input '{
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-experiment/graph-chat-full.json",
    "htmlPath": "/Users/bytedance/Documents/BDWorkSpace/ios-perf-optimizer/assets/app-regression/com.bot.doubao/ui-map/map.html",
    "discoveryStatePath": "/tmp/ios_perf-opt/ios-ui-graph-discovery/doubao-app-crawl-v1/state.json"
  }'
```

生成后启动交互控制服务：

```bash
bun run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-console/server.ts
```

然后打开 `http://127.0.0.1:18765/ui-map/map.html`。
