# App Graph Semantic Exec

[简体中文](./README.zh-CN.md)

This Workflow consumes a complete successful `app-graph-semantic-plan/v2`
result and executes its `resolvedSteps` serially on a device. Resolution order
is live selector, unique visual-semantic match, then a same-device-profile
Binding fallback only when the Plan policy permits it. Parameterized and
high-risk steps never use historical coordinates.

When a target is not safely visible, Exec performs a bounded, state-driven
viewport search. It checks the current screen, makes one short scroll, waits
for stability, and resolves the live selector again. A repeated or unchanged
viewport marks a boundary and causes a direction change; the search stops only
when the target is visible, both boundaries are observed, or the six-move
budget is exhausted. Historical target coordinates never choose the direction
or number of scrolls. Tap and long-press points must be inside the safe content
area, excluding navigation-bar coordinate shadows.
Historical same-Scene swipe steps are viewport hints, not executable routes:
guarded execution skips them and locates the following semantic target through
the live viewport search. Recipes containing a fixed swipe are ineligible for
the fast path.

## Runtime recovery loop

Execution first grounds the current Scene from screenshot, UI dump, and
foreground evidence. A known safe Graph route is preferred. In the required
Scene, current selectors and deterministic title/role matching run before a
read-only Element Agent. The Agent may select only a real current candidate ID
and cannot emit coordinates. A same-profile Binding is considered only after
Agent resolution fails and only when the Plan policy permits it.

After every tap or swipe, Exec samples the page until two consecutive
observations are stable before it verifies the outcome or starts recovery.
Native pages use semantic UI layout fingerprints. WebView pages use visual
similarity for the page body while excluding the system status bar, so clocks
and tiny rendering noise do not cause false instability. Capture commands are
retried up to three times for transient device-tunnel failures.

When the current Scene is unknown or no safe Graph route exists, a bounded
Scene Agent may combine the user goal, expected Scene, next planned action, and
current candidates to choose one safe tap or swipe. Sending, payment, permission
approval, deletion, account mutation, publishing, installation, and similar
candidates are excluded. Each action is followed by a fresh observation. New
Scenes and Elements are persisted as `observed`; new Operators and Bindings are
`candidate`. Element relocation is persisted only after the expected Scene is
proven, so an exit-zero tap without a UI outcome cannot update the Graph. A
single Agent decision never writes verified knowledge.

The Scene Agent may return `at_target` when current evidence already represents
the expected Scene. If Graph, Element Agent, Scene Agent, and a policy-approved
Binding all fail, Exec returns a structured error and
`discovery-request.json`. `recoveryActions`, `graphUpdated`, and
`graphPatchPaths` make the recovery and learning chain auditable.
An explicit Agent `blocked` result is retained with its reason rather than
being collapsed into a generic unresolved error.

Exec validates Graph ID, revision, App version, and device profile before any
device action. Swipe preserves the Plan's complete `from/to` operation, and the
verdict comes from expected Scenes and `finalOracles`, not command exit codes
alone. An unresolved step writes `discovery-request.json` for targeted App Graph
Discovery.

Accept and Console normally pass the complete Plan automatically. For
debugging, place the full Plan result in an input file and run:

```bash
bun run dev -- run examples/app-graph-exec/workflow.ts \
  --input-file /tmp/ios_perf-opt/app-graph-exec-input.json
```

Use `planOnly=true` to validate the Plan against the current Graph without
operating the device.
