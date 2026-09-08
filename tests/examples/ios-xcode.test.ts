import { describe, expect, test } from "bun:test";

import { resolveDeveloperDirectory } from "../../examples/ios-xcode";

describe("iOS Xcode discovery", () => {
  test("prefers Xcode 26 and falls back to the standard Xcode app", () => {
    expect(
      resolveDeveloperDirectory(undefined, (path) =>
        path.startsWith("/Applications/Xcode_26.app/"),
      ),
    ).toBe("/Applications/Xcode_26.app/Contents/Developer");
    expect(
      resolveDeveloperDirectory(
        undefined,
        (path) => path === "/Applications/Xcode.app/Contents/Developer",
      ),
    ).toBe("/Applications/Xcode.app/Contents/Developer");
  });

  test("validates an explicit path before falling back", () => {
    expect(
      resolveDeveloperDirectory(
        "/opt/Xcode.app/Contents/Developer",
        (path) => path === "/opt/Xcode.app/Contents/Developer",
      ),
    ).toBe("/opt/Xcode.app/Contents/Developer");
    expect(() =>
      resolveDeveloperDirectory(
        "/missing/Xcode.app/Contents/Developer",
        () => false,
      ),
    ).toThrow("No Xcode Developer directory was found");
  });
});
