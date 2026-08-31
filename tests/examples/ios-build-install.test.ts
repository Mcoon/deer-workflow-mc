import { describe, expect, test } from "bun:test";

import {
  assertBuildReady,
  buildAppCommand,
  installOnlyCommand,
  resolveSymbolPaths,
} from "../../examples/ios-build-install/workflow";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("iOS Build and Install workflow helpers", () => {
  test("builds a flow-ios-dev command that requests dSYM output", () => {
    expect(
      buildAppCommand({
        python: "python3",
        buildScriptPath:
          "/Users/bytedance/.agents/skills/flow-ios-dev/scripts/build_app.py",
        buildRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
        mode: "Debug",
        noKeepGoing: false,
        symbolsRequired: true,
      }),
    ).toEqual([
      "python3",
      "/Users/bytedance/.agents/skills/flow-ios-dev/scripts/build_app.py",
      "--project-root",
      "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
      "--mode",
      "Debug",
      "--symbols-required",
    ]);
  });

  test("keeps projectRoot as the legacy build root fallback", () => {
    const command = buildAppCommand({
      python: "python3",
      buildScriptPath: "/tmp/build_app.py",
      projectRoot: "/legacy/flow_iOS",
      mode: "Release",
      noKeepGoing: true,
      symbolsRequired: false,
    });

    expect(command).toContain("/legacy/flow_iOS");
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

  test("returns the main dSYM and a recursive business symbol search path", () => {
    expect(
      resolveSymbolPaths({
        exported_dsym_path:
          "/Users/bytedance/Documents/BDWorkSpace/Dbao/.vscode-out/Grace.app.dSYM",
        dsym_path: "/private/var/tmp/bazel-out/bin/flow_iOS/Grace.app.dSYM",
        dsym_paths: [
          "/private/var/tmp/bazel-out/bin/flow_iOS/Grace.app.dSYM",
          "/tmp/Debug-iphoneos/GraceCore.framework.dSYM",
        ],
        dsym_metadata: [
          {
            path: "/tmp/Debug-iphoneos/GraceCore.framework.dSYM",
            binary_name: "GraceCore",
          },
        ],
      }),
    ).toEqual({
      primary:
        "/Users/bytedance/Documents/BDWorkSpace/Dbao/.vscode-out/Grace.app.dSYM",
      all: [
        "/Users/bytedance/Documents/BDWorkSpace/Dbao/.vscode-out/Grace.app.dSYM",
        "/private/var/tmp/bazel-out/bin/flow_iOS/Grace.app.dSYM",
        "/tmp/Debug-iphoneos/GraceCore.framework.dSYM",
      ],
      business: "/tmp/Debug-iphoneos/GraceCore.framework.dSYM",
      searchRoot: "/tmp/Debug-iphoneos",
    });
  });

  test("accepts a ready main app dSYM when the optional business dSYM is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ios-build-main-dsym-"));
    const appPath = join(root, "Grace.app");
    const dsymPath = join(root, "Grace.app.dSYM");
    await mkdir(appPath);
    await mkdir(dsymPath);

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
});
