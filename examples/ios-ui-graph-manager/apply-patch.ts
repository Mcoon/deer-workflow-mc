#!/usr/bin/env bun
import { applyAndSave } from "./index";
import { readFileSync } from "node:fs";

const graphPath = process.argv[2];
const patchPath = process.argv[3];

if (!graphPath || !patchPath) {
  console.error("Usage: bun run apply-patch.ts <graph-path> <patch-path>");
  process.exit(1);
}

const patch = JSON.parse(readFileSync(patchPath, "utf8"));
const result = await applyAndSave(graphPath, patch);

console.log(JSON.stringify(result, null, 2));
if (result.success) {
  console.log(`\n✓ Patch applied. New revision: ${result.newRevision}`);
} else {
  console.log(`\n✗ Patch failed. Conflicts: ${result.conflicts.join(", ")}`);
  process.exit(1);
}
