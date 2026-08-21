# App Graph Unified Workflow

[简体中文](./README.zh-CN.md)

This is the user-facing entry for App Graph v2. Callers provide one `goal`; the
Workflow internally runs Plan and Exec with goal-driven bounded Graph/Agent
recovery and evidence-backed candidate learning. When learning changes the
Graph but the target remains incomplete, it may re-Plan and re-Exec. It never
starts an unfocused full-Scene crawler automatically.

Device execution starts with strict `devicectl` PID proof. Agent recovery may
choose only one goal-relevant action per recognized Scene; repeated actions or
no observable progress stop immediately. Standalone Discovery requires both a
user goal and one explicit Element, executes one action at depth zero, and
never continues clicking on the newly opened page.

Plan only:

```bash
bun run dev -- run examples/app-graph/workflow.ts \
  --input '{
    "goal": "打开侧边栏",
    "planOnly": true
  }'
```

Execute on a device:

```bash
bun run dev -- run examples/app-graph/workflow.ts \
  --input '{
    "goal": "打开侧边栏",
    "udid": "00008030-001A286A2229802E",
    "deviceProfileId": "iphone-414x896-portrait",
    "planOnly": false
  }'
```

The final output is one `app-graph-workflow-result/v1` or
`app-graph-workflow-failure/v1`. The lower-level Plan, Exec, Discovery, and
Accept Workflows remain available for debugging and batch cases.

`maximumRecoveryRounds` defaults to `0`, so a failed Exec returns immediately.
When callers explicitly enable retries, later rounds preserve the current
grounded session and never perform another strict restart.

## Runtime learning and fast execution

A successful Scene route without an existing Task is persisted through one
revision-safe `runtime-learning.json` patch. The first independent success
creates a candidate/guarded Task. A second success promotes the Task, its
Operators, and device-profile Bindings to verified/fast. Later executions on
the same App version and profile reuse the complete recipe, including learned
swipes, and retain only final Ground/Oracle evidence. A failed fast result is
downgraded to guarded before a safe cold-reset fallback.
