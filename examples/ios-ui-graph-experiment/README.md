# iOS UI Graph Experiment

[简体中文](./README.zh-CN.md)

This Workflow accepts a natural-language user goal. An Agent resolves it
against Tasks and the real-device-evidenced Scene/Operator graph, then the
deterministic compiler plans and optionally executes device actions. Tasks are
stable path caches, not a planning prerequisite. Users do not need to know
Task IDs, Scenes, Operators, or coordinates.

When no Task matches, the Workflow continues with a bounded fallback:

1. a second Agent sees the evidence-backed Scene/Operator semantic subgraph;
2. a complete evidence-backed navigation path becomes a dynamic execution plan;
3. an incomplete Graph first produces `graph-gap.json` and
   `discovery-packet.json`; `planOnly=true` stops there, while
   `planOnly=false` continues into targeted discovery;
4. dynamic paths ground after every Operator and finish with Scene and
   foreground Oracles;
5. first real before/after evidence marks Scene/Operator/Binding knowledge as
   verified but execution as guarded; a second independent success promotes
   execution to fast;
6. Scene, Binding, Operator, or Oracle failures produce
   `reexploration-packet.json` and are not persisted as valid paths.

Dynamic composition exposes evidence-backed `navigation` Operators. Guarded
edges relocate and ground after every step, while fast edges may execute as a
trusted corridor. Mutation, selection, permission, and destructive behavior
must still go through targeted discovery and real-device replay.

Knowledge confidence and execution confidence are separate:

- `status=verified` means real-device evidence proves the Scene or edge exists;
- `execution.tier=guarded` is plannable but relocates against the current UI
  dump and grounds after every step;
- `execution.tier=fast` has repeated success and may use stored Bindings;
- `execution.tier=quarantined` preserves knowledge but excludes a repeatedly
  failing edge from planning;
- an app-version change temporarily treats prior fast edges as guarded;
- when a guarded Selector drifts, deterministic current-UI matching runs first,
  then an Agent may choose only a real candidate ID. A successful relocation
  archives the old Selector and updates the current Selector and Binding.

When the goal uniquely matches one Scene title or alias, Resolve searches the
evidence-backed Graph locally without an Agent. If the target edge has state
preconditions, planning inserts a same-Scene guarded Operator that establishes
the required state fact. For example, opening AI Song first inserts the
ActionBar swipe that exposes its middle-position entry.

When `planOnly=false` and resolution returns `discovery_required`, the Workflow
continues into `Discover`:

- it follows verified navigation to the known frontier;
- each loop captures a screenshot, UI dump, and Vision OCR;
- the Agent may select only a current Observation candidate ID and `tap`,
  `long_press`, `swipe_left`, or `swipe_right`;
- coordinates come from candidate bounds; the Agent cannot invent them;
- each action is followed by a new Observation and Scene classification;
- deterministic completion evidence such as `text_absent` is required;
- successful discovery enters `Synthesize Graph`, where an Agent proposes
  stable Scene, Element, Operator, and Task semantics;
- deterministic validation checks Observation/Action coverage, path
  continuity, unique IDs, risk, and evidence anchors;
- a valid proposal is atomically persisted by the Workflow; an invalid
  proposal records its rejection and uses the deterministic fallback, without
  an external Agent manually repairing the Graph.

The synthesis stage writes:

- `graph-synthesis-proposal.json`;
- `graph-synthesis-validation.json`;
- `targeted-discovery-patch.json`.

The Agent cannot change real action order, risk, coordinates, or completion
evidence. Only Workflow-observed real before/after evidence writes verified
knowledge.

Every Agent call has a default hard timeout of 60 seconds, including Resolve,
discovery decisions, entry recovery, verifier compilation, Graph synthesis,
and planning evaluation. Once deterministic Scene classification recognizes
the requested target, the Workflow immediately leaves `Discover` for `Verify`
instead of asking the Agent to confirm completion again. A timed-out verifier
or synthesis call falls back to the already-proved completion Oracle and
stable Scene anchors.

The Workflow always returns and persists a JSON result for both business
success and failure. A failed execution no longer throws after writing an
otherwise hidden result. Every failure includes a stable contract:

```json
{
  "success": false,
  "failure": {
    "code": "targeted_discovery_incomplete",
    "stage": "Discover",
    "message": "The requested outcome was not proven.",
    "recoverable": true,
    "evidencePaths": ["/tmp/ios_perf-opt/.../discovery-result.json"]
  }
}
```

Targeted Discovery failures retain `mode=targeted_discovery` plus their
Observations, Actions, commands, and Graph evidence. Earlier Load, Resolve,
Plan, Preflight, or Reset exceptions return `mode=workflow_failure`. The CLI
finishes with `workflow:end`. Default mode writes the final JSON to stdout;
`--print` keeps its JSONL-only event contract and points to the persisted
result through `resultPath`. Callers should branch on `success` and use
`failure.code` and `failure.evidencePaths` for recovery instead of relying on
a process exception.

Final verification follows an Agent-compiled, deterministic-execution model:

- the Agent compiles typed assertions from the goal and final
  screenshot/OCR/UI-dump/foreground/Scene evidence;
- the executor supports only `all_text_visible`, `any_text_visible`,
  `text_absent`, `scene_current`, `foreground_bundle`, and `region_stable`;
- conflicts with legacy Oracles are classified as `oracle_stale`, `uncertain`,
  `path_failed`, or `evidence_insufficient`; the Agent never emits a free-form
  PASS verdict;
- the compiled verifier is cached in the Task. Candidate and verified specs
  are reused directly and only a `stale` verifier is recompiled;
- normal fast execution invokes this evidence engine at final Verify, not after
  every click.

When real actions completed but a later Oracle or synthesis bug is fixed, the
Workflow can replay existing evidence without touching the device:

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-experiment/workflow.ts \
  --input '{
    "replayDiscoveryResultPath": "/tmp/ios_perf-opt/.../discovery-result.json",
    "runId": "discovery-replay"
  }'
```

Replay runs `Load → Verify → Synthesize Graph` only. It requires real
Observation and action evidence and cannot manufacture an unexecuted result.

When a Workflow incorrectly marks an intermediate state as success, pass the
incorrect result back as a counterexample instead of merely rephrasing the
goal:

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-experiment/workflow.ts \
  --input '{
    "goal": "Set the font size to maximum",
    "planOnly": true,
    "correction": {
      "sourceResultPath": "/tmp/ios_perf-opt/ios-ui-graph-experiment/20260816150952/result.json",
      "feedback": "After confirming the maximum size, tap Restart. Relaunch the app after it exits and ground back to the chat page before declaring success."
    }
  }'
```

`correction` resolves the Task from the prior result, atomically writes
`graph-correction-patch.json`, resets the incorrect validation count and
verifier, demotes the Task to candidate, and adds the corrected action and
Oracle. The corrected maximum-font Task has five steps: open Bot settings,
open font/background settings, select maximum, confirm, then tap Restart,
prove the old PID exited, launch a new PID through `xcrun devicectl`, and
ground back to `chat.detail`.

The restart-required prompt is now an intermediate checkpoint, not the final
Oracle. Completion requires both `scene_current=chat.detail` and
`foreground_bundle=com.bot.doubao`.

Horizontal gestures do not rely on Agent-generated regions. The executor
derives a `HorizontalScrollRegion` from multiple real UI elements in one
horizontal band. Swipe actions may target only that candidate, and ActionBar
scroll goals reject taps or long presses on individual items. A repeated swipe
whose visible-item set no longer changes produces `region_stable` completion
evidence.

Destructive candidate Tasks are marked `requiresFixtureReplay=true`. They
cannot be replayed in ordinary business data even with `allowCandidate=true`;
verification requires an isolated, rebuildable fixture.

A safe targeted-discovery path writes navigation Operators, target Scenes, and
Bindings as `verified + guarded` after its first real PASS. A second independent
success promotes execution to `fast`. Tasks remain separately promotable path
caches. Offline replay of the same evidence path may repair Oracles or semantic
synthesis but does not increment validation counts.

The command can run from any directory, including `/tmp`. The semantic Agent
always starts in the trusted Deer Workflow Git repository instead of inheriting
the caller's current directory. Optional `projectRoot` only controls the
working directory for device commands.

The default `graph-chat-full.json` covers:

- reset and launch to the chat entry scene;
- Agent-backed natural-language Task selection and parameter extraction;
- deterministic initial grounding from UI dump anchors;
- verified navigation recovery when the app restores a non-entry Scene,
  followed by a second grounding check;
- verified Operator sequence compilation;
- fast execution from verified device-profile bindings;
- final screenshot/UI-dump and foreground verification;
- pre-device blocking for low confidence, unknown Tasks, invalid parameters,
  and missing required parameters.

## Semantic Plan

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-experiment/workflow.ts \
  --input '{
    "goal": "Send a text message saying hello",
    "planOnly": true
  }'
```

The Workflow writes `goal-resolution.json` with the selected Task, extracted
parameters, confidence, and reason. `plan.json` contains the deterministic
device action plan.

Dynamic composition and discovery additionally write:

- `candidate-task-proposal.json` before device execution;
- `candidate-task-patch.json` after a successful candidate/verified update;
- `composed-path-validation/` with post-Operator Scene grounding;
- `graph-gap.json` with the known frontier and missing capabilities;
- `discovery-packet.json` with bounded Agent exploration instructions;
- `reexploration-packet.json` when an existing Task, Scene, path, or Oracle
  needs correction.

## Semantic Device Execution

Device execution uses `mobilecli` and must run under the repository's
same-device ownership and serialization policy:

```bash
deer-workflow run \
  /Users/bytedance/Documents/deer-workflow-mc/examples/ios-ui-graph-experiment/workflow.ts \
  --input '{
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
    "udid": "00008030-001A286A2229802E",
    "goal": "Send a text message saying graph device test",
    "planOnly": false
  }'
```

Artifacts are written under:

```text
/tmp/ios_perf-opt/ios-ui-graph-experiment/<run_id>/
```

The normal execution path uses one screenshot plus locally compiled Vision OCR
anchors for initial grounding and one screenshot plus Vision OCR for final
verification. The three trusted-corridor actions use compiled historical
bindings without screenshots or Agent calls between actions. The Agent only
maps the initial user goal to a Task; it does not participate in step-by-step
clicking.

App launch may restore the previous screen instead of `chat.detail`. When
grounding recognizes another Scene, the Workflow enters `Recover Entry`: it
finds the shortest path using verified `navigation` Operators only, executes
it, and grounds again. Mutation, selection, permission, and destructive
Operators are never used for entry recovery. Plans and evidence are stored
under `entry-recovery/`.

Reset no longer uses `mobilecli apps terminate/launch`. Historical real-device
evidence showed those commands could report success while the visible page and
process had not actually restarted. Reset now uses a strict `xcrun devicectl`
PID protocol:

1. resolve the installed app path with `device info apps --bundle-id`;
2. list every old PID by filtering `device info processes` on that path;
3. terminate every PID with `device process terminate --pid <pid> --kill`;
4. require every old PID to disappear;
5. launch with `device process launch --terminate-existing` and read the new
   PID;
6. require the new PID to differ from all old PIDs and appear in the final
   process list.

Foreground bundle identity is no longer accepted as restart proof. The proof
is written to `reset-strict-restart-proof.json` or
`discovery-reset-strict-restart-proof.json`.

Reference screenshots and UI dumps are retained in the graph as evidence and
fallback context. They are excluded from semantic cards by default.

`taskId`, `parameters`, and `graphPath` remain available as low-level debugging
overrides, not as the normal user interface.

## Full Chat Graph

`graph-chat-full.json` is the current verified chat-page graph. It adds:

- photo capture and question sending;
- existing-photo selection without sending;
- older-message scrolling;
- auto read-aloud enablement;
- current-bot settings navigation;
- camera permission and settings return support edges.
- a candidate “open sidebar → select Cloud Drive → Cloud Drive empty state”
  path with an Agent-compiled cached verifier.

On 2026-08-15, the pure semantic command
`打开侧边栏然后点击云盘进入云盘` executed two Workflow-owned taps, reached
the view containing `最近 / 我的 / 这里还没有任何文件`, and passed
`all_text_visible(["最近","我的","这里还没有任何文件"])`. Graph synthesis
reused `chat.open_sidebar` and added `cloud.drive.recent.empty`,
`chat.sidebar.open.cloud.drive`, and
`cloud.drive.open.from.chat.sidebar`. The first evidence remains candidate
until a second independent real execution succeeds.

The command `打开侧边栏，然后进入技能页面` also exposed a stalled verifier:
device actions and final evidence had completed, but an unbounded `codex exec`
waited for roughly seven minutes. The Workflow now classifies
`技能 / 个股研究 / 估值建模 / 市场热点分析` as `skills.home`, transitions to
Verify immediately, and can compile deterministic typed assertions. A forced
one-second Graph-synthesis timeout replay finished in about 1.2 seconds and
persisted `chat.sidebar.skills.entry`, `chat.sidebar.open.skills`, and
`skills.open_from_chat_sidebar` while reusing `chat.open_sidebar`.

A second independent device run under
`/tmp/ios_perf-opt/ios-ui-graph-experiment/20260815120138/` then promoted the
Task, Scene, Operator, Binding, and verifier to verified. That run still took
about 2m09 because it started while the Task was candidate: the Resolver
exposed verified capabilities only, so it repeated targeted discovery. The
largest costs were about 31s of semantic resolution, 37s of two discovery
decisions, 15s of device reset, and 21s of Graph synthesis. Subsequent matching
goals can use the verified path.

The Workflow now resolves normalized exact intents locally before calling an
Agent; whitespace and common Chinese/English punctuation do not affect the
match. Safe candidate Tasks are also visible to semantic resolution and use a
`candidate_replay` plan: existing Operators and Bindings are replayed with
post-step grounding, then validation is promoted without Discover or Graph
synthesis.

The verified skills path completed in 30.3s: Resolve 0.22ms, Plan 0.36ms,
Reset 16.55s, Ground 1.89s, two-step Execute 4.71s, and Verify 5.89s. No
Discover or Synthesize Graph phase ran.

The original six core Tasks compile in verified-only mode. Dynamically
composed Tasks start as candidate and become verified only after the same path
passes two real executions. Device evidence and the completion audit are
stored under:

```text
/tmp/ios_perf-opt/ios-ui-graph-full-20260815/
```
