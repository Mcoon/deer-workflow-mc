import { AsyncLocalStorage } from "node:async_hooks";

import type { TraceRecorder } from "./recorder";

const traceStorage = new AsyncLocalStorage<TraceRecorder>();

export function getTraceRecorder(): TraceRecorder | undefined {
  return traceStorage.getStore();
}

export function runWithTraceRecorder<T>(
  recorder: TraceRecorder,
  callback: () => T,
): T {
  return traceStorage.run(recorder, callback);
}
