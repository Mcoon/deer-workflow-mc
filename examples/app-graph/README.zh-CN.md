# App Graph 统一入口

[English](./README.md)

这是新版 Graph 的用户入口。日常不需要手工串 Plan、Exec：只传一个
`goal`，Workflow 内部自动完成：

```text
Plan → Exec
         ├─ Graph/Agent 目标驱动运行时恢复（同一已识别 Scene 最多一次）
         ├─ 新 Scene/Element/Operator candidate 写回
         └─ Graph 有证据更新但目标未完成时 re-Plan / re-Exec
```

只规划、不操作设备：

```bash
bun run dev -- run examples/app-graph/workflow.ts \
  --input '{
    "goal": "打开侧边栏",
    "planOnly": true
  }'
```

真实执行：

```bash
bun run dev -- run examples/app-graph/workflow.ts \
  --input '{
    "goal": "打开侧边栏",
    "udid": "00008030-001A286A2229802E",
    "deviceProfileId": "iphone-414x896-portrait",
    "planOnly": false
  }'
```

可选参数：

- `graphPath`：默认使用相邻 Graph Manager 的 `graphs/com.bot.doubao.chat-full-v2/graph.json`；
- `parameters`：参数化 Task，例如 `{ "text": "GraphV2 测试消息" }`；
- `target`：按明确 Task/Scene/Operator ID 执行；
- `allowLearning`：默认 `true`，允许把新 Selector/Scene/Operator 作为 candidate 写回；
- `maximumRecoveryRounds`：默认 `0`，失败直接返回；显式设为正数才允许复用当前会话做
  re-Plan/re-Exec，后续轮次不会再次 Reset；
- `maxAgentRecoverySteps`：Exec 页面 Agent 默认最多 `4` 步；
- `minimumAgentConfidence`：默认 `0.75`；
- `agentTimeoutMs`：每次 Agent 调用默认 `60000`。

最终只返回一份 `app-graph-workflow-result/v1` 或
`app-graph-workflow-failure/v1`。`rounds` 保留每轮 Plan/Exec，
`finalPlan` 和 `finalExec` 是最终结果。

真实执行会在 Plan 前按 Graph 自己的 `bundleId` 查询已安装 App 版本，并把版本贯穿传给
Plan 与 Exec。版本不一致时，旧 Task recipe 和旧 Binding 坐标都不能进入 fast path；版本
无法取得时也保持 guarded，依赖当前页面的实时语义定位。

页面 Agent 每一步都以用户 goal、目标 Scene 和下一步计划为约束；连续无进展或重复动作
立即停止，同一已识别 Scene 不会继续试第二个控件。失败后返回 `discovery-request.json`，
不会自动启动全页 crawler。独立 Discovery 只接受用户 goal + 明确 Element focus，且固定
为一次动作、深度 0；进入新页面只采集可见元素，不继续点击。

Workflow 会清理 goal 首尾误输入的中英文引号。普通执行默认不自动 Retry；调用方显式
开启 Retry 时，后续轮次沿用当前 Ground 状态，不会再次重启 App。离屏 Element 由 Exec
根据 exact selector 和 `locationHint` 先滚动到可见位置，再进行点击。

真实执行先运行 `devicectl` 严格重启：旧 PID 必须消失，新 PID 必须不同且仍在进程列表，
否则直接返回 `reset_failed`，不会 Ground、调用 Agent 或操作页面。

`Plan / Exec / Discovery / Accept` 仍保留为内部或调试 Workflow；普通单目标调用使用本入口。

## 自动沉淀与快路径

无现成 Task 的 Scene 路径成功后，`Learn` 会用一个 revision-safe `runtime-learning.json`
同时更新 Task、Operator、Binding 和成功统计：

- 第一次独立成功：生成 `candidate` Task，execution tier 为 `guarded`；
- 第二次独立成功：Task/Operator/Binding 晋级 `verified/fast`；
- 后续同 App version、同 device profile 调用：严格重启后可复用已验证的完整语义 recipe，
  省略逐步 UI dump，只在最后做一次 Ground/Oracle；
- fast 最终验证失败：Task/Operator/Binding 自动降回 `guarded`，重新严格重启并安全执行。

滚动只作为本次寻找离屏 Element 的运行时观测，不再固化为“向上滑 N 次”的 Task 步骤。
执行时总是先检查当前屏，再短距离滑动一屏、等待稳定并重新检查，直到找到语义目标或到界。
因此成功沉淀的是稳定的语义路径，不是孤立点击坐标或历史 swipe 次数。

Task 复用还经过健康度门禁：TTL、App version、device profile、依赖摘要都一致时才是
`fresh`；历史或证据不完整的是 `guarded`；过期或依赖变化的是 `stale`；结构断裂的是
`invalid`。过期的纯导航 Task 会丢弃旧 recipe，按当前 Graph 重新规划到目标 Scene；包含
业务修改动作的过期 Task 则安全失败。语义重复的 runtime Task 会合并，诊断文案和内部 ID
不会进入 intent 索引，多个不同 recipe 分数接近时返回歧义错误，不会随便选一个。
