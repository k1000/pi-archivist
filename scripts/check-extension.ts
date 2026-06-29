#!/usr/bin/env bun
/**
 * @sherpa-purpose Run Pi Archivist extension smoke checks with Bun
 * @sherpa-timeout 180000
 * @sherpa-side-effects none
 * @sherpa-safe true
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const archivistDir = path.resolve(__dirname, "..");

if (!existsSync(archivistDir)) {
  throw new Error(`Archivist extension directory not found: ${archivistDir}`);
}

console.log("▶ hook syntax");
const syntax = Bun.spawnSync(["node", "--check", path.join(archivistDir, "bin", "archivist-hook.mjs")], {
  cwd: archivistDir,
  stdout: "inherit",
  stderr: "inherit",
});
if (syntax.exitCode !== 0) process.exit(syntax.exitCode);

console.log("▶ hook help");
const help = Bun.spawnSync(["bun", path.join(archivistDir, "bin", "archivist-hook.mjs"), "--help"], {
  cwd: archivistDir,
  stdout: "inherit",
  stderr: "inherit",
});
if (help.exitCode !== 0) process.exit(help.exitCode);

console.log("\n✅ Pi Archivist Bun checks passed");
