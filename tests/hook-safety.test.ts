import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const bun = process.execPath;
const hook = readFileSync(path.join(root, "bin", "archivist-hook.mjs"), "utf8");
const check = readFileSync(path.join(root, "scripts", "check-extension.ts"), "utf8");
const index = readFileSync(path.join(root, "index.ts"), "utf8");

assert.match(check, /\["node", "--check"/, "extension check should syntax-check hook without executing it");
assert.doesNotMatch(check, /bun", "--syntax-check"/, "Bun syntax-check executed hook top-level logic in this environment");

assert.match(hook, /could not obtain a dedicated-model synthesis/, "hook durable gate should reject heuristic fallback wording");
assert.match(hook, /modelInfo = \{ provider: cfg\.model\.provider, id: cfg\.model\.id, status: "synthesized" \}/, "hook writeMemory should carry explicit model provenance");
assert.match(hook, /model: `\$\{modelResult\.provider\}\/\$\{modelResult\.id\}`/, "hook job log should record the model that actually answered");

assert.match(index, /copyFileSync/, "hook installer should preserve existing hooks before installing Archivist");
assert.match(index, /pre-archivist/, "hook installer should back up pre-existing non-Archivist hooks");

const tmp = mkdtempSync(path.join(os.tmpdir(), "archivist-hook-safety-"));
try {
  const repo = path.join(tmp, "repo");
  mkdirSync(path.join(repo, "apps", "api"), { recursive: true });
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  writeFileSync(path.join(repo, ".pi", "archivist.config.json"), JSON.stringify({
    model: { heuristicOnly: true },
    memory: { obsidianVault: path.join(tmp, "vault") },
  }));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Archivist Test"], { cwd: repo });
  writeFileSync(path.join(repo, "apps", "api", "index.ts"), "export const changed = true;\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "feat(api): change public contract"], { cwd: repo, stdio: "ignore" });

  execFileSync(bun, [path.join(root, "bin", "archivist-hook.mjs"), "--repo", repo, "--commit", "HEAD"], { cwd: repo, stdio: "ignore" });
  const evidenceDir = path.join(tmp, "vault", "projects", "repo", "wiki", "evidence");
  assert.equal(existsSync(evidenceDir) ? readdirSync(evidenceDir).length : 0, 0, "heuristic-only fallback must not write durable evidence");
  const jobLog = readFileSync(path.join(repo, ".pi-memory", "archivist-documentation-jobs.jsonl"), "utf8");
  assert.match(jobLog, /"status":"fallback"/, "heuristic-only fallback should be logged as fallback");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("hook-safety tests passed=9");
