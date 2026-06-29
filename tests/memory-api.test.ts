import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ARCHIVIST_CONFIG, type ArchivistConfig } from "../lib/config";
import { archivistMemoryApiConfig, ingestObsidianDocumentToMemoryApi, memoryApiHeaders, recordMemoryIngestFailure } from "../lib/memory-api";

const originalToken = process.env.SHERPA_MEMORY_API_TOKEN;
const cwd = mkdtempSync(path.join(os.tmpdir(), "archivist-memory-api-test-"));
try {
  const cfg = structuredClone(DEFAULT_ARCHIVIST_CONFIG) as ArchivistConfig;
  cfg.memoryApi = { ...cfg.memoryApi, enabled: false, url: "http://localhost:9999" };
  assert.equal(archivistMemoryApiConfig(cfg).url, "http://localhost:9999");

  const disabled = await ingestObsidianDocumentToMemoryApi(cfg, cwd, path.join(cwd, "note.md"));
  assert.deepEqual(disabled, { ingested: false, reason: "memory API mirror is disabled" });

  cfg.memoryApi.enabled = true;
  const nonMarkdown = await ingestObsidianDocumentToMemoryApi(cfg, cwd, path.join(cwd, "note.txt"));
  assert.deepEqual(nonMarkdown, { ingested: false, reason: "not a markdown document" });

  delete process.env.SHERPA_MEMORY_API_TOKEN;
  assert.equal(memoryApiHeaders(cfg).Authorization, "Basic dev-token");
  process.env.SHERPA_MEMORY_API_TOKEN = "secret-token";
  assert.equal(memoryApiHeaders(cfg).Authorization, "Basic secret-token");

  recordMemoryIngestFailure(cwd, "/tmp/missing.md", new Error("boom"));
  const failure = JSON.parse(readFileSync(path.join(cwd, ".pi-memory", "archivist-inquirer-ingest-failures.jsonl"), "utf8").trim());
  assert.equal(failure.file, "/tmp/missing.md");
  assert.equal(failure.error, "boom");
} finally {
  if (originalToken === undefined) delete process.env.SHERPA_MEMORY_API_TOKEN; else process.env.SHERPA_MEMORY_API_TOKEN = originalToken;
  rmSync(cwd, { recursive: true, force: true });
}

console.log("memory-api tests passed=8");
