# iOS Functional Regression

This Workflow consumes a validated regression case set and executes every
selected case serially with `mobilecli`. It does not let an Agent or Midscene
reinterpret actions during execution.

Known routes may use a `navigate` action. The Workflow expands it from
`graph.json` before execution, so the device runner still consumes only
deterministic actions. Mutation edges are never enabled implicitly.

Live UI dump bounds are preferred. Same-profile coordinate bindings are a
fallback only after page verification. Per-step screenshots and UI dumps are
the current evidence baseline. Continuous recording is intentionally rejected
until device management can expose one serialized session that records and
performs input without competing `mobilecli` processes.

See [`README.zh-CN.md`](./README.zh-CN.md) for a complete command.
