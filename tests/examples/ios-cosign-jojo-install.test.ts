import { describe, expect, test } from "bun:test";

import {
  buildCosignCommand,
  buildJojoInstallCommand,
  meta,
} from "../../examples/ios-cosign-jojo-install/workflow";

describe("iOS Cosign and JoJo Install workflow helpers", () => {
  test("publishes the Florak example and ordered phases", () => {
    expect(meta.exampleArgs).toEqual(
      expect.objectContaining({
        repositoryRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak",
        projectRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
        target: "Grace",
      }),
    );
    expect(meta.phases.map((item) => item.title)).toEqual([
      "Prepare",
      "Cosign",
      "JoJo Install",
      "Summarize",
    ]);
  });

  test("builds the repository-native cosign command with a device", () => {
    expect(
      buildCosignCommand({
        cosignScriptPath: "/repo/flow/ios/Scripts/cosign.sh",
        udid: "device-1",
      }),
    ).toEqual([
      "/repo/flow/ios/Scripts/cosign.sh",
      "--device-udid",
      "device-1",
    ]);
  });

  test("allows cosign to select the connected device when udid is omitted", () => {
    expect(
      buildCosignCommand({
        cosignScriptPath: "/repo/flow/ios/Scripts/cosign.sh",
      }),
    ).toEqual(["/repo/flow/ios/Scripts/cosign.sh"]);
  });

  test("builds the repository-native JoJo install command", () => {
    expect(
      buildJojoInstallCommand({
        jojoInstallScriptPath: "/repo/flow/ios/jojoInstall.sh",
        target: "Grace",
      }),
    ).toEqual(["/repo/flow/ios/jojoInstall.sh", "Grace"]);
  });
});
