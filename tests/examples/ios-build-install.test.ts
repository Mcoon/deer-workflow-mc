import { describe, expect, test } from "bun:test";

import {
  assertBuildReady,
  buildBitskyCommand,
  installOnlyCommand,
  resolveSymbolPaths,
  reusedArtifactOutput,
} from "../../examples/ios-build-install/workflow";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("iOS Build and Install workflow helpers", () => {
  test("builds a BitSky device command that requests dSYM output", () => {
    expect(
      buildBitskyCommand({
        buildRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
        target: "Grace",
        mode: "Debug",
        symbolsRequired: true,
        keepGoing: false,
      }),
    ).toEqual([
      "orbit",
      "bundle",
      "exec",
      "bitsky_build",
      "--target",
      "grace",
      "--configuration",
      "Debug",
      "--sdk",
      "os",
      "--archs",
      "arm64",
      "--dsym",
      "--output",
      "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios/.vscode-out",
    ]);
  });

  test("omits dSYM unless requested and supports keep-going", () => {
    const command = buildBitskyCommand({
      buildRoot: "/repo/flow/ios",
      target: "Cici",
      mode: "Release",
      symbolsRequired: false,
      keepGoing: true,
    });

    expect(command).toContain("cici");
    expect(command).toContain("--keep_going");
    expect(command).not.toContain("--dsym");
  });

  test("builds an install-only devicectl command without launching the app", () => {
    const command = installOnlyCommand({
      appPath: "/tmp/Grace.app",
      udid: "00008030-001A286A2229802E",
      timeoutSeconds: 180,
      jsonPath: "/tmp/install.json",
      logPath: "/tmp/install.log",
    });

    expect(command).toEqual([
      "xcrun",
      "devicectl",
      "device",
      "install",
      "app",
      "--device",
      "00008030-001A286A2229802E",
      "/tmp/Grace.app",
      "--timeout",
      "180",
      "--json-output",
      "/tmp/install.json",
      "--log-output",
      "/tmp/install.log",
    ]);
    expect(command).not.toContain("launch");
    expect(command).not.toContain("deploy.py");
  });

  test("returns the BitSky app dSYM and recursive business symbol path", () => {
    expect(
      resolveSymbolPaths({
        exported_dsym_path: "/repo/flow/ios/.vscode-out/dSYM/Grace.app.dSYM",
        dsym_path: "/repo/flow/ios/.vscode-out/dSYM/Grace.app.dSYM",
        dsym_paths: [
          "/repo/flow/ios/.vscode-out/dSYM/Grace.app.dSYM",
          "/repo/flow/ios/.vscode-out/dSYM/FlowDebugBasicDynamic.framework.dSYM",
        ],
        dsym_metadata: [
          {
            path: "/repo/flow/ios/.vscode-out/dSYM/FlowDebugBasicDynamic.framework.dSYM",
            binary_name: "FlowDebugBasicDynamic",
          },
        ],
      }),
    ).toEqual({
      primary: "/repo/flow/ios/.vscode-out/dSYM/Grace.app.dSYM",
      all: [
        "/repo/flow/ios/.vscode-out/dSYM/Grace.app.dSYM",
        "/repo/flow/ios/.vscode-out/dSYM/FlowDebugBasicDynamic.framework.dSYM",
      ],
      business:
        "/repo/flow/ios/.vscode-out/dSYM/FlowDebugBasicDynamic.framework.dSYM",
      searchRoot: "/repo/flow/ios/.vscode-out/dSYM",
    });
  });

  test("accepts a ready main app dSYM when the optional business dSYM is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-build-main-dsym-"));
    const appPath = join(root, "Grace.app");
    const dsymPath = join(root, "dSYM", "Grace.app.dSYM");
    await mkdir(appPath);
    await mkdir(dsymPath, { recursive: true });

    await expect(
      assertBuildReady({
        buildExitCode: 0,
        buildOutput: { success: true },
        appPath,
        dsymPath,
        requireReadySymbols: true,
        symbolicationStatus: "ready",
        buildSummaryPath: join(root, "build-summary.json"),
      }),
    ).resolves.toBeUndefined();
  });

  test("reuses the exported .vscode-out artifacts without rebuilding", async () => {
    const buildRoot = await mkdtemp(join(tmpdir(), "ios-build-reuse-"));
    const artifactDir = join(buildRoot, ".vscode-out");
    await mkdir(join(artifactDir, "Grace.app"), { recursive: true });
    await mkdir(join(artifactDir, "dSYM", "Grace.app.dSYM"), {
      recursive: true,
    });
    await mkdir(
      join(artifactDir, "dSYM", "FlowDebugBasicDynamic.framework.dSYM"),
      { recursive: true },
    );

    const output = await reusedArtifactOutput({ buildRoot, target: "Grace" });

    expect(output.success).toBe(true);
    expect(output.app_path).toBe(join(artifactDir, "Grace.app"));
    expect(output.exported_dsym_path).toBe(
      join(artifactDir, "dSYM", "Grace.app.dSYM"),
    );
    expect(output.symbol_search_path).toBe(join(artifactDir, "dSYM"));
    expect(output.dsym_paths).toContain(
      join(artifactDir, "dSYM", "FlowDebugBasicDynamic.framework.dSYM"),
    );
    expect(output.symbolication_status).toBe("ready");
  });

  test("reports unknown symbolication when the reused dSYM is absent", async () => {
    const buildRoot = await mkdtemp(join(tmpdir(), "ios-build-reuse-nodsym-"));
    await mkdir(join(buildRoot, ".vscode-out", "Grace.app"), {
      recursive: true,
    });

    const output = await reusedArtifactOutput({ buildRoot, target: "Grace" });

    expect(output.success).toBe(true);
    expect(output.exported_dsym_path).toBeUndefined();
    expect(output.symbolication_status).toBe("unknown");
  });

  test("fails clearly when reuse is requested but no artifact exists", async () => {
    const buildRoot = await mkdtemp(join(tmpdir(), "ios-build-reuse-missing-"));

    await expect(
      reusedArtifactOutput({ buildRoot, target: "Grace" }),
    ).rejects.toThrow(/does not exist/u);
  });
});
