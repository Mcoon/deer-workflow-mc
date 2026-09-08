# App Graph Semantic Plan

[简体中文](./README.zh-CN.md)

This Workflow compiles a natural-language goal and an App Graph v2 into a
coordinate-optional semantic Plan. It only reads the Graph, plans a route, and
writes `plan.json`; it does not operate a device or execute the Plan.

Every executable step retains:

- the current Scene title, aliases, visible text anchors, and foreground bundle;
- the operation type and a human-readable action description;
- the target Element title, semantic role, and prioritized selectors;
- Binding state and optional coordinates for the requested device profile;
- live, visual, and Binding-fallback resolution policy;
- the expected destination Scene and state effects.

Coordinates are acceleration hints for low-risk steps, not the primary Plan
semantics. When `normalizedPoint` is absent, an executor can still use
`fromScene`, `action.description`, `targetElement.selectors`, and
`expectedOutcome` to locate, act, and verify.

## Run

Run from the repository root:

```bash
bun run dev -- run examples/app-graph-plan/workflow.ts \
  --input '{
    "goal": "打开侧边栏",
    "graphPath": "/Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json",
    "deviceProfileId": "iphone-414x896-portrait",
    "planOnly": true,
    "outputDir": "/Users/bytedance/.ios_pref_optimizer/app-graph-plan"
  }'
```

Or use an installed CLI:

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/app-graph-plan/workflow.ts \
  --input '{
    "goal": "打开侧边栏",
    "planOnly": true
  }'
```

`--input` must contain complete JSON. End the argument with `}'`; do not append
another character after the closing quote. For complex inputs, write the JSON
to a file and use `--input-file <path>`.

The adjacent `ios-ui-graph-manager/graphs/com.bot.doubao.chat-full-v2/graph.json` is the default
Graph. The default output root is `/Users/bytedance/.ios_pref_optimizer/app-graph-plan`. Each run
writes `plan.json` under a timestamped child directory.

## Parameterized goals

Pass Task parameters through `parameters`:

```bash
bun run dev -- run examples/app-graph-plan/workflow.ts \
  --input '{
    "goal": "删除指定文本消息",
    "parameters": {
      "text": "GraphV2 测试消息"
    },
    "planOnly": true,
    "outputDir": "/Users/bytedance/.ios_pref_optimizer/app-graph-plan"
  }'
```

The result preserves both the parameterized `selectorTemplate` and the
interpolated `selectors`. Parameterized targets and steps with `selection`,
`permission`, `mutation`, or `destructive` risk require live semantic
resolution and set `allowBindingFallback=false`; historical coordinates cannot
execute them.

## Read the Plan

A successful result uses `app-graph-semantic-plan/v2`. Its important fields
are:

| Field             | Meaning                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `resolutionType`  | `matched_task` or `matched_scene`                                                       |
| `resolution`      | Matched Task/Scene, confidence, and matched text                                        |
| `entryScene`      | Default entry Scene assumed by the Plan, with grounding context                         |
| `targetScene`     | Requested or inferred final Scene, when available                                       |
| `navigationRoute` | Pre-navigation from the default entry to the Task entry or target Scene                 |
| `taskSteps`       | Original Graph Task declaration; empty for a Scene goal                                 |
| `taskCandidates`  | Top intent matches with health, expiry, target Scene, and rejection reasons             |
| `taskResolution`  | Selected Task health and whether its stored recipe was reused or replanned              |
| `resolvedSteps`   | Complete semantic steps for the executor, including pre-navigation and inserted bridges |
| `finalOracles`    | Conditions that must hold after the complete goal                                       |
| `graphIdentity`   | Graph ID, schema, revision, update time, and App version                                |
| `planPath`        | Absolute path of the persisted `plan.json`                                              |

The legacy `route` field remains as an alias of `navigationRoute`. An empty
`route` means the default entry is already the Task entry and no pre-navigation
is needed; it does not mean there is no action. For example, the action for
“打开侧边栏” is in `resolvedSteps`:

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

## Recommended executor order

For each item in `resolvedSteps`:

1. confirm the current Scene with `fromScene.anchors` and
   `foregroundBundleId`;
2. match `targetElement.selectors` in the current UI according to
   `resolutionPolicy.selectorPriority`;
3. when deterministic selectors miss and `allowAgentVisualResolution=true`,
   use the Element title, role, `locationHint`, and action description for
   visual resolution;
4. use `binding.normalizedPoint` only when `allowBindingFallback=true` and the
   Binding belongs to the same `deviceProfileId`;
5. perform the operation and wait for `action.settleMs`;
6. verify `expectedOutcome.scene` and `expectedOutcome.effects`, then verify
   `finalOracles` after the last step.

A Binding from another device profile can provide only a coarse
`locationHint`; it never becomes an executable coordinate. Executors should
also validate `graphIdentity.revision` and the App version before consuming a
potentially stale Plan.

Task resolution does not trust intent similarity alone. It deduplicates
semantically equivalent recipes, rejects close matches with different recipes
as `task_match_ambiguous`, and evaluates structural dependencies, validation
TTL, Graph/runtime App version, and device profile. A stale navigation-only
Task can be replanned from the current Graph to its target Scene while keeping
its read-only final Oracles; stale mutating Tasks fail closed. When a runtime
App version is provided and differs from the Graph or Binding evidence, the
Plan keeps selectors and coarse location hints but removes executable
coordinates and sets `allowBindingFallback=false`.

## Failure result

When the goal cannot be compiled safely, the Workflow returns
`app-graph-semantic-plan-failure/v1` with `success=false`; it does not return an
empty successful Plan. Common `code` values include:

- `missing_goal`;
- `graph_load_failed`;
- `device_profile_missing`;
- `missing_required_parameters`;
- `unknown_parameters`;
- `task_match_ambiguous`, `task_stale`, or `task_invalid`;
- `task_entry_unreachable` or `target_scene_unreachable`;
- `goal_unresolved`.

Callers should branch on `success` and surface `code`, `message`, and
`recoverable` instead of treating an empty route as successful execution.
