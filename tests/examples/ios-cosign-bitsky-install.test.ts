import { describe, expect, test } from "bun:test";

import {
  buildBitskyInstallCommand,
  buildBundleInstallCommand,
  buildCosignCommand,
  meta,
} from "../../examples/ios-cosign-bitsky-install/workflow";
import { meta as compatibilityMeta } from "../../examples/ios-cosign-jojo-install/workflow";

describe("iOS Cosign and BitSky Install workflow helpers", () => {
  test("publishes the Florak example and ordered phases", () => {
    expect(meta.name).toBe("ios-cosign-bitsky-install");
    expect(meta.exampleArgs).toEqual(
      expect.objectContaining({
        repositoryRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak",
        projectRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
        target: "Grace",
        configuration: "Debug",
      }),
    );
    expect(meta.phases.map((item) => item.title)).toEqual([
      "Prepare",
      "Cosign",
      "Ruby Dependencies",
      "BitSky Install",
      "Summarize",
    ]);
  });

  test("keeps the legacy module path as a BitSky compatibility entry", () => {
    expect(compatibilityMeta.name).toBe("ios-cosign-jojo-install");
    expect(compatibilityMeta.description).toContain("BitSky");
  });

  test("builds non-interactive cosign for an explicit device", () => {
    expect(
      buildCosignCommand({
        cosignScriptPath: "/repo/flow/ios/Scripts/cosign.sh",
        udid: "device-1",
      }),
    ).toEqual([
      "/repo/flow/ios/Scripts/cosign.sh",
      "--no-interactive",
      "--device-udid",
      "device-1",
    ]);
  });

  test("installs Ruby dependencies through Orbit", () => {
    expect(buildBundleInstallCommand()).toEqual(["orbit", "bundle", "install"]);
  });

  test("builds the BitSky install command for Cici Inhouse", () => {
    expect(
      buildBitskyInstallCommand({ target: "Cici", configuration: "Inhouse" }),
    ).toEqual([
      "orbit",
      "bundle",
      "exec",
      "bitsky_install",
      "--target",
      "cici",
      "--mode",
      "Inhouse",
    ]);
  });
});
