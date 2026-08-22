import { describe, expect, test } from "bun:test";

import {
  buildAppCommand,
  installOnlyCommand,
  resolveSymbolPaths,
} from "../../examples/ios-build-install/workflow";

describe("iOS Build and Install workflow helpers", () => {
  test("builds a flow-ios-dev command that requests dSYM output", () => {
    expect(
      buildAppCommand({
        python: "python3",
        buildScriptPath:
          "/Users/bytedance/.agents/skills/flow-ios-dev/scripts/build_app.py",
        projectRoot: "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
        mode: "Debug",
        noKeepGoing: false,
        symbolsRequired: true,
      }),
    ).toEqual([
      "python3",
      "/Users/bytedance/.agents/skills/flow-ios-dev/scripts/build_app.py",
      "--project-root",
      "/Users/bytedance/Documents/BDWorkSpace/Dbao/flow_iOS",
      "--mode",
      "Debug",
      "--symbols-required",
    ]);
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
});
