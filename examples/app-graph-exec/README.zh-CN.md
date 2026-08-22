# App Graph 语义执行

[English](./README.md)

这个 Workflow 消费 `app-graph-semantic-plan/v2` 的完整成功结果，并在真机上串行执行
`resolvedSteps`。执行顺序是：实时 Selector → 唯一视觉语义匹配 → 同 device profile
且策略允许的 Binding fallback。参数化或高风险步骤不会使用历史坐标。

## 运行时闭环

真实执行严格按以下顺序恢复：

1. 采集当前 screenshot、UI dump 和 foreground，以 Graph Scene anchors 分类当前页面；
2. 已知当前 Scene 但不在步骤要求的 Scene 时，优先执行 Graph 中的安全
   navigation/interaction route；
3. 到达步骤 Scene 后，按 Selector priority 定位目标 Element。目标不在安全可点击区域时，
   执行器进入统一 viewport search：当前屏检查一次，每次短距离移动一段，等待稳定后重新采
   UI dump 并检查；遇到重复/未变化 viewport 才判定边界并换向，找到目标、双边到界或耗尽
   6 次动作预算时停止。历史目标坐标不参与方向和次数决策；导航栏附近的坐标影子也不能
   作为可点击目标；
   Graph 中历史遗留的同 Scene swipe 只视为 viewport 提示，不再原样回放；下一语义目标由
   实时逐段搜索定位。包含这种固定 swipe 的 recipe 不进入 fast path；
4. 每次 tap/swipe 后连续采样页面，只有两次连续观测稳定才验证结果或进入恢复。原生页面
   使用语义 UI 布局指纹；WebView 页面比较去掉系统状态栏后的主体视觉相似度，避免时间、
   电量和微小渲染抖动造成误判。截图、foreground、UI dump 的瞬时设备通道错误最多重试
   三次；
5. Selector 和确定性 title/role 都无法唯一命中时，启动只读 Agent。Agent 只能从当前
   UI dump 的真实 candidate ID 中选择 Element，不能生成坐标；
6. 元素 Agent 无法高置信定位后，只有 Plan 明确允许的低风险步骤才能使用同 profile
   Binding；参数化和高风险步骤直接失败；
7. 如果当前页面无法用 Graph 分类，或者 Graph 无已知安全 route，页面恢复 Agent 可结合
   用户 goal、目标 Scene、下一步动作和当前真实候选，选择一次安全 tap/swipe。同一已识别
   Scene 最多尝试一次，不会换一个控件继续探测。Agent 仍
   不能生成坐标，且发送、支付、授权、删除、账号修改、发布、安装等候选会被过滤；
8. 每次恢复动作后重新采证、分类 Scene。新 Scene/Element 写为 `observed`，新
   Operator/Binding 写为 `candidate`，保留 before/after evidence；不会因为 Agent 一次判断
   直接晋级 verified；
9. Agent 可高置信返回 `at_target`，表示当前证据已是目标 Scene，不需要额外点击；本轮
   记录该判断和证据，但不会直接覆盖 verified anchors；
10. Graph、元素 Agent、页面 Agent 和策略允许的 Binding 都无法完成时，返回结构化错误及
    `discovery-request.json`。
    Agent 明确返回 `blocked` 或候选被安全校验拒绝时，原始决定和拒绝原因都会保留。

页面 Agent 默认最多尝试 4 步，可用 `maxAgentRecoverySteps` 调整；默认最低置信度
`0.75`，可用 `minimumAgentConfidence` 调整。这个上限是跨不同页面的总预算；重复候选、
同一已识别 Scene 第二次动作或相邻两次 UI 无变化都会提前终止。所有 Agent 调用默认 60 秒超时，可用
`agentTimeoutMs` 调整。`allowLearning=false` 会保留本轮恢复证据，但不更新 Graph。

Exec 在第一次 Ground 前必须取得严格重启证明：终止旧 PID、拉起不同的新 PID，并确认
新 PID 仍存在。任何一步不成立都会返回 `reset_failed`，不进入后续恢复。
Element Agent 的 selector/binding 学习会延迟到目标 Scene 验证通过之后；命令 exit 0 但
页面未变化时不会更新 Graph。

Exec 会在执行前校验 Graph ID、revision、App 版本和 device profile；任何一项漂移都会
要求重新 Plan。Swipe 使用 Plan 中完整的 `from/to`，最终 verdict 来自步骤预期 Scene 和
`finalOracles`，不能只凭命令退出码通过。无法实时解析的步骤会写出
`discovery-request.json`，供 App Graph Discovery 定向补图。

结果中的 `recoveryActions` 记录 Graph route 和 Agent 恢复动作；`graphUpdated` 表示本轮
是否更新 Graph，`graphPatchPaths` 指向所有 runtime candidate patch。

通常由 Accept 或 Console 自动传入完整 Plan。调试时也可以把 Plan Workflow 的 JSON
结果作为 `plan` 传入：

```bash
bun run dev -- run examples/app-graph-exec/workflow.ts \
  --input-file /tmp/ios_perf-opt/app-graph-exec-input.json
```

输入文件示例：

```json
{
  "goal": "打开侧边栏",
  "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
  "udid": "<device-udid>",
  "plan": {
    "schemaVersion": "app-graph-semantic-plan/v2",
    "success": true
  }
}
```

上面的 `plan` 只是结构示意，实际必须传入 Plan Workflow 返回的完整对象。先使用
`planOnly=true` 可以只校验 Plan 与当前 Graph 的兼容性，不操作设备。

## Guarded 与 Fast

Exec 默认先以 guarded 证据重放学习路径。两次独立成功后，Task、Operator 和同 profile
Binding 进入 fast；fast 只在 App version/profile 一致、所有 recipe step 均 verified/fast 时
启用。fast 仍执行一次严格重启和最终 Ground/Oracle，但省略每一步的 screenshot/UI dump。
最终验证失败会写 `fast-failure-downgrade.json`，降回 guarded 后重新建立冷启基线执行。
