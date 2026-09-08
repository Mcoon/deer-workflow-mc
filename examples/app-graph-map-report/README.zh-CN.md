# App Graph v2 Map

[English](./README.md)

这个 Workflow 将 `ios-executable-ui-graph/v2` 渲染为交互式 HTML。Map 展示 Scene、
Element、Operator、Task、风险、状态和 revision；通过 iOS UI Graph Console 服务打开
时，还能直接调用 Plan、Exec、Discovery 和 Graph Agent。

新版 HTML 复用了 v1 的交互模型：

- 顶栏 `Agent` 打开 Graph 对话面板；消息连到 `/api/chat`，会携带当前选中的
  Scene/Element/Operator/Task 上下文；
- Scene 节点、Operator 连线、Task 卡片，以及 Scene 详情中的 Element/Operator 都支持
  右键菜单：`执行到这里`、`基于这里继续探索`、`复制 ID`；
- Element 的“执行到这里”表示安全到达其所属 Scene，不会猜测并点击未指定的业务动作；
  要执行具体 Element 动作，应选择引用它的 Operator；
- 从 Scene/Operator/Task 继续探索时，先解析基准 Scene，再让用户选择该 Scene 内的明确
  Element；最终仍是 user goal + Element 的单次深度 0 Discovery，不会恢复全页 crawler。

```bash
bun run dev -- run examples/app-graph-map-report/workflow.ts \
  --input '{
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "htmlPath": "/Users/bytedance/.ios_pref_optimizer/app-graph-map/map.html"
  }'
```

静态打开时只提供浏览能力。需要控制 API 时，按
[Console 文档](../ios-ui-graph-console/README.zh-CN.md)启动本地服务。
Scene 不提供全页探索。Element 的“继续探索”会先要求输入用户目标，并只执行一次
深度 0 的定向动作。

通过 Console 服务打开时，`map.html` 每次都从 canonical Graph 即时渲染，而不是读取旧的
静态快照；Graph numeric revision 变化后页面自动 reload，因此 runtime-learning 新增或晋级的
Task 会立即出现在左侧列表。`file://` 仍使用生成时的只读快照。
