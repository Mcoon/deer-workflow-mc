# iOS UI Graph 实验

[English](./README.md)

这个 Workflow 接收用户自然语言目标，由 Agent 从 Task 和真实采集的 Scene/Operator
语义图中选择能力、提取参数，再交给确定性 Graph 编译和执行。Task 只是稳定路径缓存，
不是规划门槛；用户不需要知道 `taskId`、Scene、Operator 或点位。

当没有现成 Task 时，Workflow 会继续尝试：

1. 让第二个 Agent 查看有真实证据的 Scene/Operator 语义子图；
2. 如果 evidence-backed navigation Operator 能完整满足目标，生成动态 execution plan；
3. 如果 Graph 能力不完整，先输出 `graph-gap.json` 和 `discovery-packet.json`；
   `planOnly=true` 在这里停止，`planOnly=false` 继续定向探索；
4. 动态路径执行时每个 Operator 后都重新 Grounding，最终再跑 Scene/foreground
   Oracle；
5. 首次真实 before/after 证据会把 Scene/Operator/Binding 标记为事实 `verified`，
   但执行等级为 `guarded`；第二次独立成功后才升级为 `fast`；
6. Scene、Binding、Operator 或 Oracle 失败时输出 `reexploration-packet.json`，不把
   失败路径沉淀进 Graph。

动态组合开放有真实 before/after 证据的 `navigation` Operator。`guarded` 边逐步
重新定位并 Grounding；`fast` 边允许连续执行。mutation、selection、permission 和
destructive 行为仍必须先通过定向探索和真实回放验证。

Graph 将事实可信度与执行可信度分开：

- `status=verified` 表示页面或边已由真机证据证明存在；
- `execution.tier=guarded` 表示可规划执行，但每步必须用当前 UI dump 重定位并验证；
- `execution.tier=fast` 表示已连续成功，可使用 Binding 快速执行；
- `execution.tier=quarantined` 表示连续失败，保留事实知识但暂停自动规划；
- App 版本变化时，即使原来是 `fast`，也会临时按 `guarded` 执行；
- guarded Selector 失效时先按当前 UI dump 确定性匹配，再让 Agent 只能从真实候选中
  选择；成功后保存旧 Selector 历史并更新新 Selector/Binding。

当目标文本唯一命中一个 Scene title/alias 时，Resolver 会直接在 evidence-backed Graph
中搜索路径，不调用 Agent；如果目标边有状态前置条件，规划器会自动插入能产生该状态
事实的同 Scene guarded Operator。例如“打开 AI 写歌”会先插入 ActionBar 横向滑动，再
点击 AI 写歌入口。

当 `planOnly=false` 且 Resolver 返回 `discovery_required` 时，Workflow 会继续进入
`Discover`：

- 沿 verified 路径到已知 frontier；
- 每轮采集 screenshot、UI dump 和 Vision OCR；
- Agent 只能从当前 Observation 的 candidate ID 中选择 `tap`、`long_press`、
  `swipe_left` 或 `swipe_right`；
- 坐标由 candidate bounds 中心确定，Agent 不能生成自由坐标；
- 每步后重新采集并分类 Scene；
- 目标完成必须通过确定性 Oracle，例如 `text_absent`；
- 成功后进入 `Synthesize Graph` 阶段，由 Agent 生成 Scene/Element/Operator/Task
  语义 proposal；
- 确定性校验检查 Observation/Action 覆盖、路径连续性、ID 唯一性、风险和证据锚点；
- proposal 通过后由 Workflow 原子写回 Graph；不通过则记录拒绝原因并使用
  确定性 fallback 写回，不需要外部 Agent 手工修补。

合成阶段会额外生成：

- `graph-synthesis-proposal.json`
- `graph-synthesis-validation.json`
- `targeted-discovery-patch.json`

Agent 不能修改真实动作顺序、风险、坐标或完成 Oracle。只有 Workflow 看到真实
before/after 证据后才写入事实 `verified`。

所有 Agent 调用都有默认 60 秒硬超时，包括 Resolve、探索决策、入口恢复、verifier
编译、Graph synthesis 和规划 A/B。目标页一旦被确定性 Scene 分类命中，Workflow 会
立即从 `Discover` 切换到 `Verify`，不会再调用 Agent 询问一次“是否完成”。verifier
或 synthesis Agent 超时时，会根据已通过的 completion Oracle 和稳定 Scene anchors
生成 deterministic fallback 并继续写回 Graph。

无论业务执行成功还是失败，Workflow 都会正常返回一份 JSON 结果并写入
`result.json`；失败不会再通过抛异常丢失最终结果。失败结果统一包含：

```json
{
  "success": false,
  "failure": {
    "code": "targeted_discovery_incomplete",
    "stage": "Discover",
    "message": "未能证明目标已完成",
    "recoverable": true,
    "evidencePaths": ["/tmp/ios_perf-opt/.../discovery-result.json"]
  }
}
```

已进入 Targeted Discovery 的结果仍保留 `mode=targeted_discovery`、Observation、
Action、command 和 Graph evidence；Load、Resolve、Plan、Preflight、Reset 等早期
异常返回 `mode=workflow_failure`。CLI 生命周期以 `workflow:end` 结束；普通模式在
stdout 输出最终 JSON，`--print` 模式继续只输出 JSONL 事件，并通过日志中的
`resultPath` 指向落盘的同一结果。调用方应根据 `success` 判断业务成败，并使用
`failure.code` 和 `failure.evidencePaths` 进行恢复，而不是依赖进程异常。

最终验证采用“Agent 编译、确定性执行”：

- Agent 根据目标和最终 screenshot/OCR/UI dump/foreground/Scene 证据生成 typed
  assertions；
- 执行器只支持 `all_text_visible`、`any_text_visible`、`text_absent`、
  `scene_current`、`foreground_bundle` 和 `region_stable`；
- 旧 Oracle 与 typed assertions 冲突时分类为 `oracle_stale`、`uncertain`、
  `path_failed` 或 `evidence_insufficient`，不让 Agent 自由输出 PASS；
- 编译后的 verifier 写入 Task。candidate 和 verified verifier 都直接复用，只有
  `stale` 才重新调用 Agent；
- 普通快速执行仍只在最终 Verify 调用证据引擎，不在每个点击后调用 Agent。

如果真实动作已经完成，但后续发现 Oracle 或 Graph synthesis 有 bug，可以使用已有证据
离线恢复：

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-experiment/workflow.ts \
  --input '{
    "replayDiscoveryResultPath": "/tmp/ios_perf-opt/.../discovery-result.json",
    "runId": "discovery-replay"
  }'
```

该模式只执行 `Load → Verify → Synthesize Graph`，不会重做设备动作；它不能用于没有
真实 Observation/action 证据的任务。

如果 Workflow 把某个中间状态错误地判成成功，可以把错误结果作为反例直接纠正
Graph，而不是只改写自然语言目标：

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-experiment/workflow.ts \
  --input '{
    "goal": "将字号设置成最大",
    "planOnly": true,
    "correction": {
      "sourceResultPath": "/tmp/ios_perf-opt/ios-ui-graph-experiment/20260816150952/result.json",
      "feedback": "确认最大字号后必须点击重启；App 退出后还要重新拉起并回到会话页，才算真正生效。"
    }
  }'
```

`correction` 会读取当次命中的 Task 和执行证据，原子写入
`graph-correction-patch.json`，撤销旧的成功计数和 verifier，将 Task 降回 candidate，
再补充正确动作和 Oracle。当前最大字号 Task 已纠正为 5 步：

1. 进入 Bot 设置；
2. 进入字号与背景；
3. 选择最大字号；
4. 确认；
5. 点击“重启”，证明旧 PID 退出，通过 `xcrun devicectl` 拉起新 PID，并 Ground 回
   `chat.detail`。

“重启生效 / 新的字体大小在重启后生效”现在只是中间检查点，不再是最终成功 Oracle。
最终必须同时满足 `scene_current=chat.detail` 和
`foreground_bundle=com.bot.doubao`。

横向滑动不会让 Agent 猜区域：执行器会把同一水平带上的多个真实 UI 元素聚合成
`HorizontalScrollRegion`。swipe 只能作用于该候选；ActionBar 滚动目标禁止 tap 或
long-press 条目。连续滑动后区域可见项集合不再变化时，以 `region_stable` 作为到达
边界的完成证据。

破坏性 candidate Task 会标记 `requiresFixtureReplay=true`。即使显式
`allowCandidate=true` 也不能在普通业务会话中自动二次执行；必须使用隔离、可重建
Fixture 再验证。

安全 targeted discovery 路径第一次真实 PASS 会把 navigation Operator、目标 Scene 和
对应 Binding 写为事实 `verified + guarded`；第二次独立成功后将执行等级升级为
`fast`。Task 可继续保持 candidate，作为路径缓存独立演进。相同 evidence path 的离线
replay 只用于修复 Oracle/语义合成，不累计成功次数。

命令可以从任意目录运行，包括 `/tmp`。语义 Agent 固定在 Deer Workflow 仓库这个可信
Git 目录中启动，不会把调用者当前目录误当成 Agent `cwd`。可选 `projectRoot` 只用于
设备命令的执行目录，不参与 Agent 信任判断。

默认加载 `graph-chat-full.json`，覆盖：

- reset + launch 到会话入口 Scene；
- Agent 自然语言 Task 选择和参数提取；
- 使用 UI dump anchor 做确定性初始 Grounding；
- App 恢复到非入口 Scene 时，通过 verified navigation Operator 自动回到 Task 入口并
  二次 Grounding；
- 将目标 Task 编译成 verified Operator 序列；
- 使用同 device profile 的 verified Binding 快速执行；
- 最终 screenshot/UI dump 和前台 App 验证；
- 低置信、未知 Task、非法参数和缺失必填参数在操作设备前阻断。

## 纯语义规划

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-experiment/workflow.ts \
  --input '{
    "goal": "帮我发一条消息说你好",
    "planOnly": true
  }'
```

Workflow 会写出 `goal-resolution.json`，记录 Agent 选择的 Task、参数、置信度和理由；
`plan.json` 保存随后编译的确定性设备动作。

动态组合或探索还会写出：

- `candidate-task-proposal.json`：尚未执行的候选 Task；
- `candidate-task-patch.json`：真实 PASS 后写回 Graph 的 candidate/verified 变更；
- `composed-path-validation/`：每步 Operator 后的 Scene Grounding；
- `graph-gap.json`：Graph 已知前沿与缺失能力；
- `discovery-packet.json`：定向 Agent 探索约束和预期产物；
- `reexploration-packet.json`：已有 Task/Scene/路径/Oracle 失败后的纠正材料。

## 纯语义真机执行

真机执行使用 `mobilecli`，必须遵守仓库的同设备 owner 和串行锁约束：

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-experiment/workflow.ts \
  --input '{
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
    "udid": "00008030-001A286A2229802E",
    "goal": "帮我发一条消息说 graph 真机实验",
    "planOnly": false
  }'
```

其他例子：

```text
拍一张照片，然后问它这是什么
从相册里选择一张照片，但不要发送
帮我加载更早的消息
打开自动播报
进入当前豆包的设置页
```

运行产物统一写入：

```text
/tmp/ios_perf-opt/ios-ui-graph-experiment/<run_id>/
```

正常执行用一次 screenshot + 本地 Vision OCR 视觉文本锚点完成 Grounding，用一次
screenshot + Vision OCR 做最终验证；中间三步 Trusted Corridor 直接使用编译后的
历史 Binding，不逐步截图，也不调用 Agent。Agent 只在执行开始前将自然语言映射为
Task，不参与逐步点击。

冷启动可能恢复上次页面，并不保证直接进入 `chat.detail`。如果 Grounding 命中其他
Scene，Workflow 会进入 `Recover Entry`：只在 verified `navigation` Operator 中搜索
最短路径，执行后再次 Grounding；mutation、selection、permission 和 destructive
Operator 不会用于入口恢复。恢复计划和证据写入 `entry-recovery/`。

Reset 不再使用 `mobilecli apps terminate/launch`。历史证据表明 iOS 真机上这两个命令
可能返回成功，但页面与进程实际没有完成重启。现在 Reset 使用
`xcrun devicectl` 的严格 PID 流程：

1. `device info apps --bundle-id` 获取 App 安装路径；
2. `device info processes --filter executable.path BEGINSWITH ...` 获取全部旧 PID；
3. 对每个 PID 执行 `device process terminate --pid <pid> --kill`；
4. 重查进程列表，要求全部旧 PID 消失；
5. `device process launch --terminate-existing` 启动并读取新 PID；
6. 要求新 PID 不属于旧 PID，且存在于启动后的进程列表。

只有这份 PID proof 通过后 Reset 才成功；foreground bundle 不再作为“已重启”的证明。
证据写入 `reset-strict-restart-proof.json` 或
`discovery-reset-strict-restart-proof.json`。

Graph 会保留参考 screenshot/UI dump 作为证据和 fallback，但默认不把它们放入语义
卡片或热规划路径。

`taskId`、`parameters` 和 `graphPath` 仍可作为底层调试覆盖，但不是普通用户入口。

## 完整会话 Graph

`graph-chat-full.json` 是当前已验证的完整会话页 Graph，新增：

- 拍照并带问题发送；
- 选择一张现有照片但不发送；
- 滚动展示更早消息；
- 打开自动朗读；
- 进入当前 Bot 设置页；
- 相机权限和设置页返回等支持边。
- candidate 路径“打开侧边栏 → 点击云盘 → 云盘空状态”，以及由 Agent 编译并缓存的
  typed verifier。

2026-08-15 真机纯语义命令：

```text
打开侧边栏然后点击云盘进入云盘
```

Workflow 自动执行 `(30,70)` 打开侧边栏、`(75,276)` 点击云盘，最终识别到
“最近 / 我的 / 这里还没有任何文件”。Agent verifier
`all_text_visible(["最近","我的","这里还没有任何文件"])` PASS；Graph synthesis
复用已有 `chat.open_sidebar`，新增 `cloud.drive.recent.empty`、
`chat.sidebar.open.cloud.drive` 和 Task `cloud.drive.open.from.chat.sidebar`。
第一次证据仍保持 candidate，后续第二次独立真实 PASS 才升级 verified。

证据：

```text
/tmp/ios_perf-opt/ios-ui-graph-experiment/sidebar-open-cloud-drive-agent-verifier-20260815/
/tmp/ios_perf-opt/ios-ui-graph-experiment/sidebar-cloud-drive-replay-repair-20260815/
```

同日“打开侧边栏，然后进入技能页面”在设备动作完成后，旧实现卡在无超时的 Agent
verifier `codex exec` 约 7 分钟。修复后：

- `技能 / 个股研究 / 估值建模 / 市场热点分析` 确定性分类为 `skills.home`；
- 目标命中后立即进入 `Verify`；
- completion Oracle 为 `技能 && 个股研究 && 估值建模`；
- verifier fallback 为 `all_text_visible` + `foreground_bundle`；
- Graph synthesis 超时 1 秒的强制回放在约 1.2 秒内完成；
- Graph 复用 `chat.open_sidebar`，新增 `chat.sidebar.skills.entry`、
  `chat.sidebar.open.skills` 和 `skills.open_from_chat_sidebar`；
- 相同真实 evidence replay 不增加 Task 成功次数；随后第二次独立真机执行写入
  `/tmp/ios_perf-opt/ios-ui-graph-experiment/20260815120138/`，将 Task、Scene、
  Operator、Binding 和 verifier 一起升级为 verified。

第二次真机执行总耗时约 2 分 09 秒，仍走 targeted discovery，因为 run 开始时 Task
还是 candidate，Resolver 只暴露 verified Task/Operator。耗时主要来自两层语义解析
约 31 秒、两次探索决策约 37 秒、设备 Reset 约 15 秒和 Graph synthesis 约 21 秒。
该 run 完成后，相同目标才具备 verified 快路径。

当前已落地：

- Resolve 先做 normalized exact-intent 本地匹配，空格和中英文标点差异不影响命中；
- exact intent Resolve 不调用 Agent，实测约 `0.22ms`；
- Agent 语义匹配也可看到已成功一次且非 destructive 的安全 candidate Task；
- Plan 为 candidate 自动选择 `candidate_replay`，复用已有 Operator/Binding，并在每步
  后 Grounding；
- candidate replay 成功后只更新 validation/verifier 并原子晋级，不再 Discover 或
  Graph synthesis；
- verified 快路径实测总耗时 `30.3s`，Resolve `0.22ms`、Plan `0.36ms`、Reset
  `16.55s`、Ground `1.89s`、两步 Execute `4.71s`、Verify `5.89s`；
- 快路径没有 `Discover` 和 `Synthesize Graph`。

证据：

```text
/tmp/ios_perf-opt/ios-ui-graph-experiment/skills-exact-intent-plan-20260815/
/tmp/ios_perf-opt/ios-ui-graph-experiment/skills-verified-fast-path-20260815/
```

证据：

```text
/tmp/ios_perf-opt/ios-ui-graph-experiment/20260815113107/
/tmp/ios_perf-opt/ios-ui-graph-experiment/20260815120138/
/tmp/ios_perf-opt/ios-ui-graph-experiment/skills-page-replay-stable-ids-20260815/
```

原始六个核心 Task 均可在 verified-only 模式编译。动态组合产生的 Task 从 candidate
开始，只有相同路径两次真实 PASS 后才升级 verified。真机证据与完成审计位于：

```text
/tmp/ios_perf-opt/ios-ui-graph-full-20260815/
```
