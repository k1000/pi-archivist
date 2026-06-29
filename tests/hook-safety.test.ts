import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const hook = readFileSync(path.join(root, "bin", "archivist-hook.mjs"), "utf8");
const check = readFileSync(path.join(root, "scripts", "check-extension.ts"), "utf8");
const index = readFileSync(path.join(root, "index.ts"), "utf8");

assert.match(check, /\["node", "--check"/, "extension check should syntax-check hook without executing it");
assert.doesNotMatch(check, /bun", "--syntax-check"/, "Bun syntax-check executed hook top-level logic in this environment");

assert.match(hook, /could not obtain a dedicated-model synthesis/, "hook durable gate should reject heuristic fallback wording");
assert.match(hook, /modelStatus = "synthesized"/, "hook writeMemory should carry explicit model provenance");
assert.match(hook, /lastModelFallbackReason \? "fallback" : "synthesized"/, "hook should mark fallback evidence provenance accurately");

assert.match(index, /copyFileSync/, "hook installer should preserve existing hooks before installing Archivist");
assert.match(index, /pre-archivist/, "hook installer should back up pre-existing non-Archivist hooks");

console.log("hook-safety tests passed=7");
