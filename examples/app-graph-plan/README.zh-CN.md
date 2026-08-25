# App Graph 语义规划

[English](./README.md)

这个 Workflow 将自然语言目标和 App Graph v2 编译为不依赖坐标也能理解的语义
Plan。它只读取 Graph、规划路径并写出 `plan.json`，不会操作真机，也不会执行
Plan。

每个执行步骤都保留：

- 当前 Scene 的标题、别名、可见文本锚点和前台 Bundle；
- 动作类型及自然语言说明；
- 目标 Element 的标题、语义角色和有优先级的 Selectors；
- 当前 device profile 的 Binding 状态和可选坐标；
- 实时解析、视觉解析和 Binding fallback 策略；
- 动作完成后预期到达的 Scene 和状态 Effects。

坐标只是低风险步骤的加速提示，不是 Plan 的主语义。即使
`normalizedPoint` 缺失，执行方仍可根据 `fromScene`、`action.description`、
`targetElement.selectors` 和 `expectedOutcome` 完成定位与校验。

## 运行

从仓库根目录运行：

```bash
bun run dev -- run examples/app-graph-plan/workflow.ts \
  --input '{
    "goal": "打开侧边栏",
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "deviceProfileId": "iphone-414x896-portrait",
    "planOnly": true,
    "outputDir": "/tmp/ios_perf-opt/app-graph-plan"
  }'
```

也可以使用已安装的 CLI：

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/app-graph-plan/workflow.ts \
  --input '{
    "goal": "打开侧边栏",
    "planOnly": true
  }'
```

`--input` 必须是完整 JSON。结尾应是 `}'`；不要在引号后追加其他字符。复杂输入也可以
写入 JSON 文件后改用 `--input-file <path>`。

默认 Graph 是相邻 `ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json`，默认输出根目录是
`/tmp/ios_perf-opt/app-graph-plan`。每次运行会在带时间戳的子目录中写入
`plan.json`。

## 带参数的目标

Task 声明必填参数时，通过 `parameters` 传入：

```bash
bun run dev -- run examples/app-graph-plan/workflow.ts \
  --input '{
    "goal": "删除指定文本消息",
    "parameters": {
      "text": "GraphV2 测试消息"
    },
    "planOnly": true,
    "outputDir": "/tmp/ios_perf-opt/app-graph-plan"
  }'
```

输出会同时保留参数化的 `selectorTemplate` 和插值后的 `selectors`。参数化目标及
`selection`、`permission`、`mutation`、`destructive` 风险步骤强制要求实时语义
定位，`allowBindingFallback=false`，不能使用历史坐标执行。

## 如何读取 Plan

成功输出的 Schema 是 `app-graph-semantic-plan/v2`。关键字段如下：

| 字段              | 含义                                               |
| ----------------- | -------------------------------------------------- |
| `resolutionType`  | `matched_task` 或 `matched_scene`                  |
| `resolution`      | 命中的 Task/Scene、置信度和命中文本                |
| `entryScene`      | Plan 假定的默认入口 Scene 及其 Grounding 信息      |
| `targetScene`     | 目标或 Task 最终预期 Scene（若可推断）             |
| `navigationRoute` | 从默认入口到 Task 入口或目标 Scene 的前置导航      |
| `taskSteps`       | Graph Task 原始声明的步骤；Scene 目标时为空        |
| `taskCandidates`  | 候选 Task 及健康度、有效期、目标 Scene 和拒绝原因  |
| `taskResolution`  | 最终 Task 健康度，以及旧 recipe 是复用还是重规划   |
| `resolvedSteps`   | 执行方应消费的完整语义步骤，包含前置导航和自动补桥 |
| `finalOracles`    | 完成整个目标后必须校验的最终条件                   |
| `graphIdentity`   | Graph ID、Schema、revision、更新时间和 App 版本    |
| `planPath`        | 本次落盘的 `plan.json` 绝对路径                    |

旧字段 `route` 作为 `navigationRoute` 的兼容别名保留。`route: []` 只表示默认入口已经
是 Task 的入口，不需要先走额外路径；它不表示没有动作。例如“打开侧边栏”的点击动作
位于 `resolvedSteps`：

```json
{
  "fromScene": {
    "sceneId": "chat.detail",
    "title": "会话页"
  },
  "action": {
    "type": "tap",
    "description": "在「会话页」点击页面左上区域的「对话列表」按钮。"
  },
  "targetElement": {
    "title": "对话列表",
    "semanticRole": "Button",
    "selectors": [
      { "type": "accessibilityIdentifier", "value": "对话列表" },
      { "type": "label", "value": "对话列表" },
      { "type": "role", "value": "Button" }
    ]
  },
  "expectedOutcome": {
    "scene": {
      "sceneId": "chat.sidebar",
      "title": "会话侧边栏"
    }
  }
}
```

## 建议的执行方消费顺序

对每个 `resolvedSteps` 步骤：

1. 使用 `fromScene.anchors` 和 `foregroundBundleId` 确认当前 Scene；
2. 按 `resolutionPolicy.selectorPriority` 在当前 UI 中匹配
   `targetElement.selectors`；
3. 确定性 Selector 未命中且 `allowAgentVisualResolution=true` 时，依据
   Element 标题、角色、`locationHint` 和动作说明进行视觉定位；
4. 只有 `allowBindingFallback=true` 时，才能使用同一 `deviceProfileId` 的
   `binding.normalizedPoint` 作为低风险 fallback；
5. 执行动作并等待 `action.settleMs`；
6. 校验 `expectedOutcome.scene` 和 `expectedOutcome.effects`，最后校验
   `finalOracles`。

其他 device profile 的 Binding 只能生成粗粒度 `locationHint`，不会成为可执行坐标。
执行方还应先验证 `graphIdentity.revision` 和 App 版本，避免消费过期 Plan。

Task 解析不会只看 intent 相似度。Plan 会先合并语义相同的 recipe；多个不同 recipe
分数接近时返回 `task_match_ambiguous`。随后检查 Task 结构、验证 TTL、Graph/真机 App
version、device profile 和依赖摘要。过期的纯导航 Task 可以保留只读最终 Oracles，并按
当前 Graph 重新求到目标 Scene 的路径；过期的业务修改型 Task 安全失败。调用方传入
`runtimeAppVersion` 后，如果版本与 Graph 或 Binding 证据不一致，Plan 仍保留 Selectors
和粗粒度位置提示，但移除可执行坐标并设置 `allowBindingFallback=false`。

## 失败结果

无法安全编译时返回 `app-graph-semantic-plan-failure/v1`，`success=false`，不会返回
空的成功 Plan。常见 `code` 包括：

- `missing_goal`；
- `graph_load_failed`；
- `device_profile_missing`；
- `missing_required_parameters`；
- `unknown_parameters`；
- `task_match_ambiguous`、`task_stale` 或 `task_invalid`；
- `task_entry_unreachable` 或 `target_scene_unreachable`；
- `goal_unresolved`。

调用方应根据 `success` 分支，并展示 `code`、`message` 和 `recoverable`，不要把空路径
当作成功执行。
