// Compatibility entry point. New callers should use ios-cosign-bitsky-install.
export {
  buildBitskyInstallCommand,
  buildBundleInstallCommand,
  buildCosignCommand,
} from "../ios-cosign-bitsky-install/workflow";
export { default } from "../ios-cosign-bitsky-install/workflow";

export const meta = {
  name: "ios-cosign-jojo-install",
  description:
    "Deprecated compatibility path that runs the iOS Cosign and BitSky Install Workflow without invoking JoJo.",
  phases: [
    { title: "Prepare" },
    { title: "Cosign" },
    { title: "Ruby Dependencies" },
    { title: "BitSky Install" },
    { title: "Summarize" },
  ],
  exampleArgs: {
    repositoryRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak",
    projectRoot: "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    udid: "00008030-001A286A2229802E",
    target: "Grace",
    configuration: "Debug",
    developerDir: "/Applications/Xcode_26.app/Contents/Developer",
  },
};
