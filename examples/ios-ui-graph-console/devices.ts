import type { GraphConsoleDevice } from "./types";

export async function listConnectedIosDevices(
  timeoutMs = 10_000,
): Promise<readonly GraphConsoleDevice[]> {
  const subprocess = Bun.spawn(
    ["mobilecli", "devices", "--platform", "ios", "--type", "real"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => subprocess.kill(), timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        stderr.trim() || `mobilecli devices exited with code ${exitCode}.`,
      );
    }
    return parseMobilecliDevicesOutput(stdout);
  } finally {
    clearTimeout(timer);
  }
}

export function parseMobilecliDevicesOutput(
  stdout: string,
): readonly GraphConsoleDevice[] {
  const payload = JSON.parse(stdout) as unknown;
  if (!isRecord(payload) || payload.status !== "ok") {
    throw new Error("mobilecli devices returned an invalid status.");
  }
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.devices)) {
    throw new Error("mobilecli devices returned an invalid payload.");
  }
  return data.devices
    .filter(isRecord)
    .filter(
      (device) =>
        device.platform === "ios" &&
        device.type === "real" &&
        device.state === "online" &&
        typeof device.id === "string" &&
        device.id.trim().length > 0,
    )
    .map((device) => ({
      id: String(device.id),
      name: stringValue(device.name, "iOS Device"),
      platform: "ios" as const,
      type: "real" as const,
      version: stringValue(device.version, "unknown"),
      state: "online",
      model: stringValue(device.model, "unknown"),
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
