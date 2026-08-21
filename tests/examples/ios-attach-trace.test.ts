import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAttachRecordCommand,
  buildTimeProfileExportCommand,
  buildTocExportCommand,
  diagnoseAttachRecordFailure,
  meta,
  observeAttachRecordOutput,
  resolveMainExecutableProcess,
  runXctraceExportWithRetry,
  waitForTraceTreeToSettle,
  type AttachRecordObservation,
} from "../../examples/ios-attach-trace/workflow";

describe("iOS Attach Trace workflow helpers", () => {
  test("describes a 30s attach workflow", () => {
    expect(meta.name).toBe("ios-attach-trace");
    expect(meta.exampleArgs).toEqual(
      expect.objectContaining({
        attachTarget: "Grace",
        timeLimit: "30s",
      }),
    );
    expect(meta.phases.map((phase) => phase.title)).toEqual([
      "Prepare",
      "Attach",
      "Record",
      "Save Trace",
      "Export",
      "Parse",
      "Report",
    ]);
  });

  test("builds an xctrace attach command without launching the app", () => {
    const command = buildAttachRecordCommand({
      template: "Time Profiler",
      udid: "00008030-001A286A2229802E",
      timeLimit: "30s",
      tracePath: "/tmp/ios_perf-opt/ios-attach-trace/run/attach_target.trace",
      attachTarget: "Grace",
    });

    expect(command).toEqual([
      "xcrun",
      "xctrace",
      "record",
      "--template",
      "Time Profiler",
      "--device",
      "00008030-001A286A2229802E",
      "--time-limit",
      "30s",
      "--output",
      "/tmp/ios_perf-opt/ios-attach-trace/run/attach_target.trace",
      "--attach",
      "Grace",
      "--no-prompt",
    ]);
    expect(command).not.toContain("--launch");
  });

  test("builds xctrace export commands matching the launch parser input", () => {
    expect(
      buildTocExportCommand("/tmp/run/attach_target.trace", "/tmp/run/toc.xml"),
    ).toEqual([
      "xcrun",
      "xctrace",
      "export",
      "--input",
      "/tmp/run/attach_target.trace",
      "--toc",
      "--output",
      "/tmp/run/toc.xml",
    ]);

    expect(
      buildTimeProfileExportCommand(
        "/tmp/run/attach_target.trace",
        "/tmp/run/time_profile.xml",
      ),
    ).toEqual([
      "xcrun",
      "xctrace",
      "export",
      "--input",
      "/tmp/run/attach_target.trace",
      "--xpath",
      '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]',
      "--output",
      "/tmp/run/time_profile.xml",
    ]);
  });

  test("retries transient xctrace export crashes and persists attempt logs", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-attach-export-"));
    const calls: string[][] = [];

    const result = await runXctraceExportWithRetry({
      label: "time-profile",
      command: ["xcrun", "xctrace", "export"],
      cwd: "/tmp",
      outputDir,
      attempts: 3,
      retryDelayMs: 0,
      runner: async (command) => {
        calls.push([...command]);
        if (calls.length === 1) {
          return {
            stdout: "first stdout",
            stderr: "Segmentation fault: 11",
            exitCode: -11,
          };
        }
        return {
          stdout: "second stdout",
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(calls).toHaveLength(2);
    expect(result.result.exitCode).toBe(0);
    expect(result.attempts.map((attempt) => attempt.returncode)).toEqual([
      -11, 0,
    ]);
    expect(result.attempts[0]?.stderr_path).toBe(
      join(outputDir, "xctrace-export-time-profile-attempt-1.stderr.txt"),
    );
    await expect(
      readFile(result.attempts[0]!.stderr_path, "utf8"),
    ).resolves.toBe("Segmentation fault: 11");
    await expect(
      readFile(result.attempts[1]!.stdout_path, "utf8"),
    ).resolves.toBe("second stdout");
  });

  test("waits until the trace bundle tree is stable before export", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ios-attach-settle-"));
    const tracePath = join(outputDir, "attach_target.trace");
    await mkdir(join(tracePath, "Data"), { recursive: true });
    await writeFile(join(tracePath, "Data", "trace.data"), "sample", "utf8");

    const result = await waitForTraceTreeToSettle(tracePath, {
      attempts: 3,
      delayMs: 0,
    });

    expect(result.settled).toBe(true);
    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots[0]).toEqual(
      expect.objectContaining({
        attempt: 1,
        file_count: 1,
        total_bytes: 6,
      }),
    );
  });

  test("diagnoses an ambiguous attach target and suggests PIDs", () => {
    const diagnosis = diagnoseAttachRecordFailure(
      {
        exitCode: 20,
        stdout: "",
        stderr: [
          "Provided process 'Grace' is ambiguous",
          "6024 /var/containers/Bundle/Application/A/Grace.app/Grace",
          "5842 /var/containers/Bundle/Application/B/Grace.app/Grace",
        ].join("\n"),
      },
      { attachTarget: "Grace" },
    );

    expect(diagnosis.error).toBe("ambiguous_attach_target");
    expect(diagnosis.message).toContain("6024, 5842");
    expect(diagnosis.message).toContain("attachTarget");
  });

  test("resolves a process name to the latest main app PID", () => {
    const resolution = resolveMainExecutableProcess({
      requestedTarget: "Grace",
      targetBinary: "Grace",
      processes: [
        {
          pid: 5842,
          executable:
            "/private/var/containers/Bundle/Application/OLD/Grace.app/Grace",
        },
        {
          pid: 5975,
          executable:
            "/private/var/containers/Bundle/Application/NEW/Grace.app/PlugIns/DoubaoWidgetExtension.appex/DoubaoWidgetExtension",
        },
        {
          pid: 6043,
          executable:
            "/private/var/containers/Bundle/Application/NEW/Grace.app/Grace",
        },
      ],
    });

    expect(resolution).toEqual(
      expect.objectContaining({
        requestedTarget: "Grace",
        resolvedTarget: "6043",
        strategy: "devicectl_main_executable_latest_pid",
      }),
    );
    expect(resolution?.candidates).toHaveLength(2);
  });

  test("observes attach recording start and finish from streamed xctrace output", () => {
    const phases: string[] = [];
    const observation: AttachRecordObservation = {
      onRecordingStarted: () => phases.push("Record"),
      onRecordingLimitReached: () => phases.push("Save Trace"),
    };

    observeAttachRecordOutput(
      "Starting recording with the Time Profiler template. Atta",
      observation,
    );
    expect(observation.startedAt).toBeUndefined();

    observeAttachRecordOutput(
      "ching to: Grace (6397). Time limit: 30.0 s\nCtrl-C to stop the recording\n",
      observation,
    );
    expect(observation.startedAt).toBeString();
    expect(observation.attachMessage).toBe(
      "Starting recording with the Time Profiler template. Attaching to: Grace (6397). Time limit: 30.0 s",
    );

    observeAttachRecordOutput(
      "Reached specified time limit, ending recording...\n",
      observation,
    );
    expect(observation.finishedAt).toBeString();
    expect(phases).toEqual(["Record", "Save Trace"]);
  });

  test("explains that xctrace saves the trace after the recording limit", () => {
    const observation: AttachRecordObservation = {};

    observeAttachRecordOutput(
      "Starting recording with the Time Profiler template. Attaching to: Grace (6598). Time limit: 10.0 s\n",
      observation,
    );
    observeAttachRecordOutput(
      "Reached specified time limit, ending recording...\nRecording completed. Saving output file...\n",
      observation,
    );

    expect(observation.startedAt).toBeString();
    expect(observation.finishedAt).toBeString();
  });
});
