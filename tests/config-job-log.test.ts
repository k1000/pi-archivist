import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, obsidianMemoryPath } from "../lib/config";
import { appendDocumentationJobLog, documentationJobLogPath } from "../lib/job-log";

const originalHome = process.env.HOME;
const root = mkdtempSync(path.join(os.tmpdir(), "archivist-config-test-"));
try {
  const home = path.join(root, "home");
  const repo = path.join(root, "repo-name");
  mkdirSync(path.join(home, ".pi"), { recursive: true });
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  process.env.HOME = home;

  writeFileSync(path.join(home, ".pi", "sherpa.config.json"), JSON.stringify({
    memory: { obsidianVault: path.join(root, "vault") },
  }));
  writeFileSync(path.join(home, ".pi", "archivist.config.json"), JSON.stringify({
    documentationJobs: { logPath: ".global/archivist.jsonl" },
  }));
  writeFileSync(path.join(repo, ".pi", "archivist.config.json"), JSON.stringify({
    model: { provider: "test-provider", id: "test-model" },
    documentationJobs: { logPath: ".project/jobs.jsonl" },
  }));

  const cfg = loadConfig(repo);
  assert.equal(cfg.model.provider, "test-provider");
  assert.equal(cfg.model.id, "test-model");
  assert.equal(cfg.memory.obsidianVault, path.join(root, "vault"));
  assert.equal(obsidianMemoryPath(cfg), path.join(root, "vault", "projects", "repo-name"));

  const logPath = documentationJobLogPath(cfg, repo);
  assert.equal(logPath, path.join(repo, ".project", "jobs.jsonl"));
  appendDocumentationJobLog(cfg, repo, { kind: "unit-test", status: "passed" });
  const line = readFileSync(logPath, "utf8").trim();
  const parsed = JSON.parse(line);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.project, "repo-name");
  assert.equal(parsed.kind, "unit-test");
  assert.equal(parsed.status, "passed");
} finally {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
}

console.log("config/job-log tests passed=11");
