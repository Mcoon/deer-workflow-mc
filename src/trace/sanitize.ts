const SENSITIVE_KEY =
  /(^|[_-])(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|session)([_-]|$)/i;
const SENSITIVE_FLAG =
  /^(--?(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|session))$/i;

export function sanitizeTraceValue(
  value: unknown,
  maximumTextCharacters: number,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return truncateText(redactSecrets(value), maximumTextCharacters);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return value ?? null;
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((entry) =>
      sanitizeTraceValue(entry, maximumTextCharacters, seen),
    );
    seen.delete(value);
    return output;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : sanitizeTraceValue(entry, maximumTextCharacters, seen);
  }
  seen.delete(value);
  return output;
}

export function sanitizeCommand(command: readonly string[]): string[] {
  const output: string[] = [];
  let redactNext = false;
  for (const argument of command) {
    if (redactNext) {
      output.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    const equals = argument.indexOf("=");
    if (equals > 0 && SENSITIVE_FLAG.test(argument.slice(0, equals))) {
      output.push(`${argument.slice(0, equals)}=[REDACTED]`);
      continue;
    }
    output.push(redactSecrets(argument));
    redactNext = SENSITIVE_FLAG.test(argument);
  }
  return output;
}

function truncateText(value: string, maximum: number): unknown {
  if (value.length <= maximum) return value;
  return {
    text: value.slice(0, maximum),
    truncated: true,
    originalCharacters: value.length,
  };
}

function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(
      /\b(authorization|cookie|password|passwd|secret|token|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]",
    );
}
