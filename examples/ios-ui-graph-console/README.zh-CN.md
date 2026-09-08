# iOS UI Graph v2 控制台

[English](./README.md)

这个本地 Bun 服务为 canonical App Graph v2 Map 提供控制 API。它使用同一份
`ios-executable-ui-graph/v2` 驱动：

- Task、Scene、Operator 的“仅规划”会调用 App Graph Plan；
- “执行”调用统一 `app-graph` Workflow，由它负责 `Plan → Exec → 目标驱动 Agent 恢复 / 有限 re-Plan`；
- 只有输入用户目标并选中明确 Element 后，“继续探索”才能调用 App Graph Discovery；
  Scene 级全页探索被禁止，单次探索只执行一个目标动作；
- 破坏性 Task/Operator 必须二次确认；
- Graph 纠错使用文件哈希防并发覆盖，并递增 Graph 数字 revision，使旧 Plan 失效；
- 所有运行仍受单设备队列保护，并通过 `/api/runs` 和 SSE 暴露进度。

Map 顶栏提供 `Agent` 对话面板，调用 `/api/chat` 并附带当前 Graph 节点上下文。
Scene、Operator、Task 和 Element 均可从右键菜单执行到目标、基于目标继续定向探索，或
复制 ID。Element 的“执行到这里”由服务端规范化成所属 Scene；非 Element 的 Explore
请求不会直接进入 Discovery，必须先选出基准 Scene 下的明确 Element。
`stale` Scene 不提供普通规划或执行，而显示“重新探索恢复”。恢复流程只复用已有历史入边，
先到达仍有效的来源 Scene，再对历史入口 Element 执行一次定向探测；只有新观测重新匹配
目标 Scene，才将该 Scene、入口 Element 和 Operator 恢复为 candidate。

先生成 Graph v2 Map：

```bash
bun run dev -- run examples/app-graph-map-report/workflow.ts \
  --input '{
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "htmlPath": "/Users/bytedance/.ios_pref_optimizer/app-graph-map/map.html"
  }'
```

再启动 Console，并让它服务该 Map 目录：

```bash
IOS_UI_GRAPH_MAP_DIRECTORY=/Users/bytedance/.ios_pref_optimizer/app-graph-map \
IOS_UI_GRAPH_PATH=/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json \
IOS_UI_GRAPH_CONSOLE_UDID=<device-udid> \
IOS_UI_GRAPH_CONSOLE_DEVICE_PROFILE_ID=iphone-414x896-portrait \
bun run examples/ios-ui-graph-console/server.ts
```

打开 `http://127.0.0.1:18765/ui-map/map.html`。选中 Scene、Operator 或 Task 后，右侧
可以仅规划或执行。Element 可以继续定向探索，执行必须选择
引用它的明确 Operator。若未设置 UDID，Plan 仍可使用，Exec/Discovery 会返回缺少设备的
结构化错误。

页面顶栏会通过 `mobilecli devices --platform ios --type real` 扫描在线真机。只有一台设备时
会自动选中；多台设备时可从下拉框切换，也可以点击“刷新设备”。所选 UDID 会随每个
Exec/Discovery 请求提交，服务端在串行设备队列内再次确认设备在线。环境变量
`IOS_UI_GRAPH_CONSOLE_UDID` 只作为默认选择，不再是页面执行的必要前提。

普通静态服务器或 `file://` 打开 Map 时仍可浏览，但控制按钮会显示 Console 未连接。
Console 服务会针对 `map.html` 实时读取 canonical Graph；执行、探索或 correction 造成 revision
变化时，页面通过 `/api/health.graphNumericRevision` 检测新版本，但不自动重载，而是在顶栏
显示“Graph rXX · 刷新”。当前 Agent 对话会一直
保留，并可继续基于原 Task 向 Agent 追问；旧版本页面在刷新前不会继续提交执行或探索。
最近 50 条纯文本消息和所选节点保存在当前浏览器标签页的会话存储中，主动刷新后仍会恢复。

canonical Graph 是一个可迁移的数据包：

```text
examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/
├── graph.json
├── indexes/
└── reference-assets/<scene-id>/<content-hash>/
    ├── screenshot.png
    ├── ui-dump.json
    └── ocr.json（可选）
```

`graph.json` 中的 `referenceAssets` 使用相对于该文件的路径。单次运行仍将原始证据写入
`/Users/bytedance/.ios_pref_optimizer`；只有写入 Graph 的 Scene 证据会按内容哈希晋级到
`reference-assets`，每个 Scene 最多保留三组有效证据。因此复制整个 Graph 数据包后，
截图不会依赖原机器的 `/tmp` 或用户目录。
