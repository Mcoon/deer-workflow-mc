# iOS App Semantic Graph Discovery

[简体中文](./README.zh-CN.md)

This Workflow expands the canonical executable iOS Graph through a bounded,
resumable, low-risk Scene crawler. It cold-launches to the entry Scene, scans
stable interactive Elements, generates applicable Actions, observes Effects,
and recursively enqueues newly discovered Scenes.

```text
ios-ui-graph-discovery
  Scene → Element → Action → Effect recursive crawl
        ↓ canonical Graph
ios-ui-graph-experiment
  user execution / candidate replay / targeted repair
        ↓
ios-ui-semantic-map-report
  interactive HTML
```

The Workflow provides:

- resumable `state.json`;
- Scene and ElementAction frontiers;
- cold-launch entry bootstrapping and Scene recovery paths;
- page-centered sessions that exhaust one Scene's Actions before scanning the
  next Scene;
- local recovery through reverse navigation Operators or safe
  back/close/cancel/done controls, with cold launch only as fallback;
- Agent-backed Scene understanding and action applicability;
- tap, long-press, directional swipe, and directional drag candidates;
- before/action/after evidence and Effect classification;
- real-device Actions with complete before/after evidence and a non-`no_effect`
  Effect immediately write Scene, Operator, and Binding knowledge as verified,
  with `execution.tier=guarded` available to planning;
- existing Graph data is migrated only when crawler `state.json` contains the
  completed before/after evidence; unevidenced semantic guesses remain
  candidate;
- guarded edges relocate and ground during user execution, become fast after
  repeated success, and are quarantined after repeated failures without
  deleting the discovered page knowledge;
- recursive enqueue for new Scenes;
- Scene, Element, and ElementAction deduplication;
- deterministic blocking for send, delete, payment, publish, authorization,
  and other side-effect goals;
- Graph delta, module coverage, and HTML reporting;
- one shared `graph-chat-full.json`.

Plan without touching a device:

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

Existing crawler evidence can be migrated in a strict offline mode. It reads
only the Graph and completed before/after evidence, writes
`verified + guarded` execution trust, and refreshes the HTML without running an
Agent, Preflight, or mobilecli:

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-discovery/workflow.ts \
  --input '{
    "resumeStatePath": "/tmp/ios_perf-opt/ios-ui-graph-discovery/doubao-app-crawl-v1/state.json",
    "evidenceMigrationOnly": true
  }'
```

Run a bounded smoke:

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

Resume with:

```json
{
  "resumeStatePath": "/tmp/ios_perf-opt/ios-ui-graph-discovery/<run_id>/state.json",
  "maximumActions": 8,
  "maximumScenes": 5,
  "planOnly": false
}
```

P0 should remain bounded to one scanned Scene and one to three Actions per
session until Scene deduplication, recovery, and safety quality are well
established.

The crawler maintains a focused Scene. Actions from that Scene are exhausted
before another Scene is scanned. After an Action enters a child page or
overlay, recovery prefers:

```text
reverse verified/candidate navigation Operator
→ visible back/close/cancel/done control
→ cold launch plus recovery path fallback
```

In the device smoke, the next `chat.detail` Action after visiting
`bot.settings` used `bot.return_to_chat`; its evidence is stored under
`local-recovery/reverse-operator.json`, and no `restore/reset-*` chain was
created for the subsequent Action.

## Recovery Repairs And Map Refresh

- In voice-input mode, the crawler recognizes `文本输入` and backfills
  `chat.detail.voice_input.return_to_text` from real UI-dump evidence for the
  `chat.detail.voice.input → chat.detail` local recovery path.
- `HorizontalScrollRegion` relocation no longer depends on a drifting complete
  label or value. It matches the live ActionBar or composer toolbar using role,
  vertical position, region width, and semantic child-item overlap.
- Identical deterministic before/after fingerprints become `no_effect` and do
  not create an Operator. Historical candidate navigation self-loops are
  pruned, and their completed frontiers are requeued for a real Effect retry.
- Screenshot and UI-dump capture retries transient WDA tunnel `EOF`,
  `unexpected EOF`, connection-reset, and broken-pipe failures up to three
  times with serial backoff. Every attempt keeps its stdout and stderr, while
  persistent failures still stop the session.
- Reset is followed by entry Grounding. If launch restores a persistent page
  such as camera photo preview, the crawler uses a visible
  back/close/cancel/done control to reach the entry Scene before replaying
  recovery Operators.
- Graph cleanup runs again before checkpoint output, so the generated Map does
  not retain known candidate navigation self-loops or horizontal-scroll edges
  misclassified as cross-page navigation.
- Every checkpoint runs `Refresh Map` by default and regenerates the canonical
  `map.html`, `executable-graph.json`, and summary. Set `refreshMap=false` to
  disable it or `mapHtmlPath` to override the output.

`map.html` remains a self-contained static artifact. When served over HTTP, it
polls the revision in `semantic-map-summary.json` every two seconds and reloads
after the Workflow updates the Graph and Map. `file://` and script-disabled
previews keep the complete static first paint but do not poll.

## Page Session V2: Scenes Versus State

Full pages, sheets, menus, and system surfaces remain Scenes. State within one
page no longer expands into separate Scenes:

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

Historical candidate Scenes for voice input, ActionBar middle/end, camera
flash, and camera facing are migrated into the base Scene's `stateVariants`.
Their Operators become base-Scene self-transitions and preserve state through
`preconditions`, `effects`, and `postconditions`. Task `scene_current` Oracles
are migrated to the base Scene as well.

The Scene-scan Agent now returns Element actions together with predicted Effect
type, required and expected state facts, and an undo hint. Execution order is:

```text
same-Scene state_change / viewport_change
→ ordinary interaction
→ new_scene / overlay / external_scene
→ blocked
```

After a same-Scene toggle, swipe, or drag, the crawler captures UI dump only
instead of screenshot plus OCR. When the UI-dump fingerprint changes and the
scan already predicted the Effect, no per-Action Effect Agent call is needed.
Full screenshot, UI dump, Vision OCR, and optional Effect Agent reasoning are
reserved for new pages, overlays, or semantic uncertainty.

This keeps `liveSceneId` on the base Scene, so flash, facing, voice mode, and
scroll-position changes do not trigger terminate/launch/replay. Operators with
state `preconditions` are also excluded from generic entry recovery.

## Long Lists And Off-Screen Elements

UI dumps may include Elements outside the current viewport. The crawler never
taps those historical coordinates directly. It first brings the target into
the live viewport through bounded scrolling and captures a new UI dump. A
long-list target that is temporarily absent is searched in both directions
with a fixed attempt limit; an unchanged viewport or exhausted search leaves a
resumable backlog instead of scrolling forever.

Incremental scans prefer large business rows and drop their decorative icon
children, duplicate text nodes, and descriptive copy. On the skills page, only
title-row geometry becomes an Action target; descriptions remain semantic
evidence.

## Templated Skill Details

Individual skills share one `skills.detail` Scene and use state facts:

```text
skills.home --tap skill--> skills.detail
skills.detail State Variants:
  skill.name=Public Company Analysis
  skill.name=Contract Drafting
  skill.name=UI Design
```

Both the pre-install `Add` state and the installed `Try in chat / Delete` state
classify as `skills.detail`. Add and Delete remain blocked side effects. The
real feature edge is:

```text
skills.detail --Try in chat--> chat.detail
effect: chat.mode=new
```

The crawler closes a skill detail through the OCR-visible `×` and returns to
the same list viewport before continuing.

## 2026-08-16 Current Frontier-Complete Page Map

The resumable run lives at:

```text
/tmp/ios_perf-opt/ios-ui-graph-discovery/doubao-app-crawl-v1/
```

For the current device, account, App version, and safety policy, the latest
canonical Graph contains:

- 85 Scenes;
- 924 Elements;
- 433 Operators;
- 13 Tasks;
- 113 State Variants;
- 80 scanned Scene frontiers;
- 2 conditionally blocked message-menu Scenes that require a matching fixture;
- 597 completed, 146 blocked, and 282 skipped Actions;
- zero pending or failed Actions;
- zero pending or failed Scene frontiers;
- zero Element IDs shared across different Scenes;
- a `complete_with_blocks` Page Audit:
  - 145 covered entries;
  - 15 template-covered instances;
  - 38 risk-blocked or currently unavailable entries;
  - zero gaps.

`complete_with_blocks` and zero pending frontiers do not claim an absolute
union across every account, experiment, hidden feature flag, data fixture,
authorization state, paid flow, or future App version. They mean that every
stable entry discovered in this run is covered, template-covered, or explicitly
blocked, and that the current resumable frontier has converged.

New or completed areas include AI Creation discovery, Writing Assistant, AI
Song, PPT generation, image generation, Buy Before Ask and its menu, Doubao
Learning, the museum-guide call page, Privacy and Permissions, Customer
Service, About Doubao Debug and its legal/information documents, personal
information inventory details and time-range menu, Smart Devices, Volcengine
Ark console/docs/survey/experience surfaces, the Volcengine home page, and its
Products and Services page.

The crawler now also:

1. persists all stable Elements immediately after Scene understanding;
2. lets an Agent understand current-run screenshot/UI-dump evidence offline
   when a dynamic Scene is hard to replay;
3. uses readable-plus-hash identities for ActionBar and settings-row Elements;
4. synthesizes candidate Operators for semantically certain tabs, toggles,
   scrolling, and explicit back/close controls;
5. inventories but never executes calls, permissions, debug/account changes,
   payment/subscription, personal media, generation, sharing, feedback, or
   promotion actions;
6. keeps templated skills and dynamic recommendation text from inflating the
   Action queue;
7. namespaces Element identity by Scene and migrates historical Graph,
   Operator, and frontier references so one page cannot overwrite another
   page's `nav.back`, `content.scroll`, or other generic IDs;
8. compiles Graph swipe recovery coordinates to integers required by
   `mobilecli`;
9. preserves live before/after evidence while semantic Element IDs are
   repaired or deduplicated.

The checkpoint refreshed the default Map:

```text
http://127.0.0.1:18765/ui-map/map.html
```

Serve that URL with the Graph Console rather than a generic Python static
server when execution, continued exploration, or Agent chat is needed:

```bash
bun run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-console/server.ts
```

The current result was validated with focused discovery/crawler tests,
TypeScript type-checking, `git diff --check`, a stable plan-only replay, and a
fresh Map render. Run `bun run check` before release or handoff.
