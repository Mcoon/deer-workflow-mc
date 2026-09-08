import { existsSync } from "node:fs";
import { resolve } from "node:path";

const VERSIONED_DEVELOPER_DIR = "/Applications/Xcode_26.app/Contents/Developer";
const STANDARD_DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";

/**
 * Resolves an installed Xcode Developer directory.
 *
 * @param requested - Optional preferred Xcode Developer directory.
 * @param pathExists - Filesystem predicate overridden by unit tests.
 * @returns The first existing requested, versioned, or standard Xcode path.
 * @throws When none of the candidate Xcode installations exists.
 */
export function resolveDeveloperDirectory(
  requested?: string,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const candidates = [
    requested?.trim() ? resolve(requested.trim()) : "",
    VERSIONED_DEVELOPER_DIR,
    STANDARD_DEVELOPER_DIR,
  ].filter(
    (candidate, index, values) =>
      Boolean(candidate) && values.indexOf(candidate) === index,
  );
  const found = candidates.find(pathExists);
  if (found) {
    return found;
  }
  throw new Error(
    `No Xcode Developer directory was found. Checked: ${candidates.join(", ")}. ` +
      "Install Xcode or pass developerDir explicitly.",
  );
}
