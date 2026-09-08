# Changelog

## Unreleased

- Moved default Workflow and CLI trace artifacts from the temporary directory
  to the persistent `~/.ios_pref_optimizer` root.
- Added shared Xcode Developer-directory detection across iOS signing, build,
  launch-trace, and attach-trace workflows, with `Xcode.app` fallback.
- Made attach trace discover complete dSYMs directly from the current
  `<buildRoot>/.vscode-out/dSYM` before consulting build summaries.
- Made iOS launch tracing self-contained in the TypeScript Workflow by running
  `devicectl` and `xctrace` directly, including UUID-aware fail-closed symbol
  recovery, without requiring an external `ios-perf-optimizer` checkout.
- Replaced the legacy Flow iOS JoJo preparation and build paths with BitSky,
  exported trace-ready App/dSYM artifacts to `.vscode-out`, and taught launch
  and attach traces to consume BitSky Debug symbols.
- Made attach trace discover matching `flow-ios-bitsky` summaries directly and
  fail clearly when no dSYM search directory is available instead of reporting
  an unsymbolicated export as a successful run.
- Fixed iOS attach traces to consume the complete dSYM set from the latest
  matching build, run `xctrace symbolicate` before export, and validate
  GraceCore source coverage instead of treating the main app dSYM as sufficient.
- Consolidated iOS App Graph execution on the v2 Plan/Exec/Discovery/Accept
  pipeline and removed the legacy executable Graph, crawler, semantic-map, and
  archived workflow bundles.
- Added consecutive page-stability checks, WebView body similarity, transient
  device-capture retries, and auditable bounded Agent recovery before App Graph
  execution advances or learns a transition.
- Fixed targeted Element exploration to execute overlapping full-row controls,
  verify the known Operator destination, and reject zero-action false success.
- Replaced coordinate-directed offscreen recovery in App Graph Exec and
  Discovery with a shared state-driven viewport search that re-checks the live
  selector after each short gesture, detects boundaries, reverses direction,
  and records an auditable search trace.
- Stopped replaying historical same-Scene swipe coordinates in guarded and fast
  execution; the following semantic target now drives live viewport search.
- Made `allowLearning=false` suppress fast-path reference-asset promotion as
  well as ordinary runtime learning.
- Removed the general-purpose `deer-workflow agent` CLI command. Agent runtime
  selection remains available on `deer-workflow create`.

## 0.2.0 - 2026-07-27

- Added `ClaudeAgent`, a built-in Agent Harness backed by Claude Code CLI, with
  text and JSON Schema output, sandbox mapping, cancellation, and actionable
  installation errors.
- Added `--agent codex|claude` to the `agent` and `create` CLI commands, with
  Codex remaining the default runtime.

## 0.1.0 - 2026-07-26

- Added an interactive `🦌 Deer Workflow` TUI for long-running CLI commands.
  Workflow runs show metadata-backed phase states beside live Markdown logs,
  while default-mode redirected stderr retains JSONL events.
- Added `deer-workflow run --print` / `-p` as the recommended server and
  automation interface, exposing a stdout-only JSONL Workflow Event Stream.
- Added runtime validation and `workflow:meta` events for Workflow metadata.
- Improved Workflow generation feedback and examples, including an immediate
  source placeholder and a self-contained interactive HTML output for Deep
  Research.

## 0.0.1 - 2026-07-26

- Initial public release of the deterministic TypeScript Workflow runtime,
  including Agent adapters, Flow primitives, lifecycle events, logging, and the
  reusable Workflow Runner.
- Added the `deer-workflow` CLI for running and generating Workflows, together
  with the
  [bundled Workflow Creator Skill](./skills/workflow-creator/), runnable
  examples, and bilingual documentation.
