# iOS App 语义 Graph 探索

[English](./README.md)

这个 Workflow 对整个 App 做**有界、可恢复、低风险**的语义 Graph 自动探索。它从
冷启动入口 Scene 开始，扫描当前 Scene 的全部稳定可交互 Element，为每个 Element
生成适用 Action，执行后观察 Effect；发现新 Scene 后递归扫描。

三个新体系 Workflow 的关系：

```text
ios-ui-graph-discovery
  Scene → Element → Action → Effect 递归爬图
        ↓ canonical Graph
ios-ui-graph-experiment
  用户目标快速执行 / candidate replay / 定向补洞
        ↓
ios-ui-semantic-map-report
  HTML 可视化
```

## 核心能力

- `state.json` 持久化，支持 `resumeStatePath` 中断恢复；
- 两级队列：`SceneFrontier` 与 `ElementActionFrontier`；
- 从默认冷启动入口 Scene 自动开始；
- 每个 Scene 只做一次语义扫描，区分稳定控件和动态内容；
- 自动推断 `tap`、`long_press`、方向 swipe 和方向 drag 的适用性；
- Action 执行前恢复到正确 Scene，并在 live UI 中重新定位 Element；
- 探索以当前页面为中心：同一 Scene 的 pending Action 全部优先于下一 Scene；
- 一个 session 只在入口或局部恢复失败时冷启；Action 进入子页面后优先使用反向
  Operator、返回/关闭/取消/完成控件回到 focused Scene；
- 保存 before/action/after 证据，分类新页面、overlay、状态变化、滚动变化、外部页面或
  无效果；
- 有完整 before/after 且 Effect 非 `no_effect` 的真机 Action 会立即把 Scene、
  Operator 和 Binding 写为事实 `verified`，并以 `execution.tier=guarded` 开放给规划；
- 历史 Graph 也会根据 crawler `state.json` 中的 completed before/after 证据自动迁移，
  缺证据的语义推测边仍保持 candidate；
- guarded 边首次用于用户执行时逐步重定位和 Grounding；重复成功后由执行 Workflow
  升级为 fast，连续失败则隔离而不删除页面知识；
- 发送、删除、支付、发布、授权等副作用目标自动 blocked；
- 新 Scene 自动入队并递归扩展；
- Scene/Element/Action 使用稳定签名去重；
- 输出 Graph delta、模块覆盖率和 HTML report；
- 继续写同一份 `graph-chat-full.json`，不建立第二份 Graph。

## 先看计划

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-discovery/workflow.ts \
  --input '{
    "maximumActions": 4,
    "maximumScenes": 5,
    "maximumDepth": 2,
    "maximumDurationMinutes": 10,
    "planOnly": true
  }'
```

`planOnly=true` 不操作设备，只生成：

已有 crawler `state.json` 可以使用严格离线的证据迁移模式。它只读取 Graph 与 completed
before/after 证据、写入 `verified + guarded` 执行信任并刷新 HTML；不会运行 Agent、
Preflight 或 mobilecli：

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-discovery/workflow.ts \
  --input '{
    "resumeStatePath": "/tmp/ios_perf-opt/ios-ui-graph-discovery/doubao-app-crawl-v1/state.json",
    "evidenceMigrationOnly": true
  }'
```

```text
state.json
manifest.json
coverage.json
graph-delta.json
report.html
```

## 执行一个小批次

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-discovery/workflow.ts \
  --input '{
    "maximumActions": 2,
    "maximumScenes": 1,
    "maximumDepth": 1,
    "maximumDurationMinutes": 10,
    "planOnly": false
  }'
```

## 恢复

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-discovery/workflow.ts \
  --input '{
    "resumeStatePath": "/tmp/ios_perf-opt/ios-ui-graph-discovery/<run_id>/state.json",
    "maximumActions": 8,
    "maximumScenes": 5,
    "planOnly": false
  }'
```

之前处于 `scanning/running` 的 Scene/Action frontier 会恢复为 pending；失败且未达到
最大尝试次数的 frontier 也会重新入队。已完成、blocked 或达到上限的组合不会重复。

P0 仍建议每次只扫描 1 个 Scene、执行 1–3 个 Action，观察 Scene 去重、安全策略和
恢复质量，再逐步扩大深度与预算。

## 页面会话

crawler 会选定一个 `focusedSceneId`：

```text
扫描 chat.detail
→ 生成 chat.detail 的全部 Action
→ 逐个执行
→ 每个 Action 后局部返回 chat.detail
→ chat.detail Action 耗尽
→ 才扫描 chat.sidebar / bot.settings / chat.media_panel
```

局部恢复优先级：

```text
verified/candidate 反向 navigation Operator
→ 当前 UI 的返回 / 关闭 / 取消 / 完成 / 页面开关
→ 冷启动 + recovery path 兜底
```

真机连续 Action 验证中，从 `bot.settings` 到下一条 `chat.detail` Action 使用了
`bot.return_to_chat`，产物为 `local-recovery/reverse-operator.json`；同一 session
后续 Action 没有生成 `restore/reset-*`。

## 恢复修复与 Map 刷新

- 进入语音输入态后，crawler 会识别 `文本输入`，并从真实 UI dump 回填
  `chat.detail.voice_input.return_to_text`，用于
  `chat.detail.voice.input → chat.detail` 的局部恢复。
- `HorizontalScrollRegion` 不再依赖易漂移的完整 label/value；live 重定位会结合 role、
  垂直位置、区域宽度和子项语义重叠度匹配 ActionBar / 输入工具栏。
- before/after 指纹相同会确定性归类为 `no_effect`，不会写入 Operator。历史 candidate
  navigation 自环会被清理，其已完成 frontier 会重新入队，等待真实 Effect 重验。
- screenshot/UI dump 遇到 WDA tunnel `EOF`、`unexpected EOF`、连接重置等瞬时传输
  故障时，会串行短退避重试 3 次，并保存每次 stdout/stderr；持续性错误仍会终止
  session。
- Reset 后先 Ground 当前 Scene；如果 App 恢复在相机照片预览等持久页面，会先使用
  可见的返回/关闭/取消/完成控件安全回到入口 Scene，再 replay recovery Operator。
- Graph 清理在 checkpoint 前再次执行，保证输出 Map 不包含已知 navigation 自环或
  横向 scroll 被误判为跨页面导航的 candidate 边。
- 每次 checkpoint 默认执行 `Refresh Map`，用 canonical Graph 重新生成默认
  `map.html`、`executable-graph.json` 和 summary；可用 `refreshMap=false` 关闭，或用
  `mapHtmlPath` 指定输出位置。

`map.html` 仍是可独立打开的静态产物，但通过 HTTP 打开时会每 2 秒读取
`semantic-map-summary.json` 的 revision；Workflow 更新 Graph 与 Map 后，已经打开的
页面会自动 reload。`file://` 或禁用脚本的预览环境继续保留完整静态首屏，但不会轮询。

## Page Session V2：Scene 与 State 分离

完整页面、sheet、菜单和系统页面继续建为 Scene；同一页面内的状态不再展开成 Scene：

```text
Scene: camera.capture
State Variants:
  camera.flash=auto
  camera.flash=on
  camera.facing=front

Scene: chat.detail
State Variants:
  composer.mode=voice
  actionbar.position=middle
  actionbar.position=end
```

历史 `chat.detail.voice.input`、ActionBar middle/end、camera flash/facing 等 candidate
Scene 会自动迁入基础 Scene 的 `stateVariants`。相关 Operator 改为基础 Scene 自环，
并使用 `preconditions`、`effects` 和 `postconditions` 保存状态事实；Task 的
`scene_current` Oracle 同步指向基础 Scene。

页面扫描 Agent 现在一次输出 Element、适用 Action、预计 Effect、required/expected
state facts 和 undo hint。执行顺序为：

```text
同页 state_change / viewport_change
→ 普通交互
→ new_scene / overlay / external_scene
→ blocked
```

同页 toggle、swipe、drag 的 after Observation 只采 UI dump，不再默认截图和 OCR；
UI dump 指纹变化且 Scan 已明确 Effect 类型时，也不再逐 Action 调 Agent。只有新页面、
overlay 或语义不确定时才采完整 screenshot + UI dump + Vision OCR，并按需调用
Effect Agent。

这样 `liveSceneId` 会稳定保留在基础 Scene，同页 Action 不会因为 flash、facing、
voice mode 或 scroll position 变化而触发完整 terminate/launch/replay。带状态
`preconditions` 的 Operator 也不会被通用入口寻路盲用。

## 长列表与屏外 Element

UI dump 可能包含当前 viewport 外的 Element。crawler 不再直接使用这些屏外坐标：

1. Action 恢复到目标 Scene；
2. 仅在目标真实进入 viewport 后允许 tap/long-press；
3. 若目标只存在于屏外，按列表方向有限滚动并重新采集 UI dump；
4. 长列表目标暂时不存在时，做有界双向搜索，不无限滚动；
5. viewport 不再变化或达到搜索上限后，将 frontier 留作 backlog。

设置页验证了该机制：恢复到页面顶部后，crawler 会先滚到 `钱包`、`我的订单`、
`隐私与权限` 等行所在 viewport，再按 live bounds 执行，不再点击 `y > viewport`
的历史坐标。技能页则保持同一 Page Session，在多个 viewport 之间搜索标题。

增量扫描会优先保留大尺寸业务行，过滤其内部图标、重复文本和说明文案。技能列表使用
标题行的几何特征识别可点击 Element；技能描述只作为语义证据，不生成 tap frontier。

## 技能页模板化

技能列表中的具体技能不会各自展开为独立 Scene：

```text
Scene: skills.home
  Element: 个股研究 / 合同起草 / UI 设计 / ...
  Operator: tap <skill>

Scene: skills.detail
  State Variant: skill.name=个股研究
  State Variant: skill.name=合同起草
  State Variant: skill.name=UI 设计
```

技能详情页安装前显示 `添加`，安装后显示 `在对话中试用 / 删除`；两者都会归类为
`skills.detail`。`添加` 和 `删除` 属于 mutation/destructive，探索时 blocked。
真实功能边单独表示为：

```text
skills.detail --在对话中试用--> chat.detail
effect: chat.mode=new
```

详情页通过 OCR `×` 安全关闭并回到原列表 viewport，后续技能继续使用同一页面会话。

## 2026-08-16 当前 frontier 收敛页面地图

长期 run：

```text
/tmp/ios_perf-opt/ios-ui-graph-discovery/doubao-app-crawl-v1/
```

当前设备、当前账号、当前 App 版本和当前安全策略下的最新 canonical Graph：

- 85 Scene；
- 924 Element；
- 433 Operator；
- 13 Task；
- 113 State Variant；
- 80 个 Scene frontier 已扫描；
- 2 个消息菜单 Scene 依赖匹配 fixture，按 conditional coverage 标为 blocked；
- 597 个 Action completed、146 个 blocked、282 个 skipped；
- 0 个 pending/failed Action；
- 0 个 pending/failed Scene frontier；
- 0 个跨 Scene 复用的 Element ID；
- Page Audit 为 `complete_with_blocks`：
  - 145 个页面入口 covered；
  - 15 个模板实例 template-covered；
  - 38 个风险或当前状态不可达入口 blocked；
  - 0 gap。

`complete_with_blocks` 和 0 pending frontier 不表示所有账号、实验、隐藏开关、数据
fixture、授权状态、付费流程和未来 App 版本的绝对全集；它表示本次 run 已发现的稳定
入口已经全部被覆盖、模板化或显式阻断，当前 resumable frontier 已经收敛。

本轮新增或补齐了 AI 创作发现页、帮我写作面板、AI 写歌及关于页、PPT 生成面板、
图片生成面板、买前问豆包及更多菜单、豆包爱学、博物馆讲解通话页、隐私与权限、
客服中心、关于豆包 Debug 及法律/信息文档、个人信息清单详情与时间范围菜单、我的
智能设备，以及火山方舟控制台、文档、问卷、体验页、火山引擎官网和产品与服务页。

探索链路同时完成以下收敛：

1. Scene 扫描后立即把全部稳定 Element 写入 Graph，不再等待 Action 成功后才落元素；
2. 已到达但难稳定重放的 Scene，使用当前 run 的 screenshot/UI dump 由 Agent 离线理解，
   再生成 Element 和安全 Action；
3. ActionBar 与设置行使用“可读前缀 + 标题哈希”的稳定 ID，避免
   `AI 创作 / AI写歌` 或多个设置行共享 Element ID；
4. Tab、Toggle、Scroll、明确返回/关闭等语义确定动作合成 candidate Operator；
5. 通话、权限、Debug、账号、支付/订阅、用户相册、生成、分享、反馈和促销等操作只
   进入 inventory，不自动执行；
6. 技能详情继续模板化，动态推荐文案只作为语义证据，不膨胀 Action 队列。
7. Element ID 强制按 Scene namespace，并自动迁移历史 Graph、Operator 和 frontier，
   避免 `nav.back`、`content.scroll` 等通用 ID 被后扫描页面覆盖；
8. Graph swipe recovery 坐标统一取整，满足 `mobilecli` 的整数坐标约束；
9. Element ID 修复和去重时保留 live before/after 证据，不让语义迁移重新制造 pending。

Graph checkpoint 已自动刷新默认 Map：

```text
http://127.0.0.1:18765/ui-map/map.html
```

需要执行、继续探索或 Agent 对话时，应使用 Graph Console 提供这个地址，而不是普通
Python 静态服务器：

```bash
bun run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-console/server.ts
```

当前结果已通过定向 discovery/crawler 测试、TypeScript typecheck、`git diff --check`、
稳定 plan-only 复跑和 Map 重新生成。发布或正式交接前仍应执行完整 `bun run check`。
