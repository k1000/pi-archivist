import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ARCHIVIST_CONFIG, type ArchivistConfig } from "../lib/config";
import { archivistMemoryApiConfig, ingestObsidianDocumentToMemoryApi, memoryApiAuthStatus, MemoryApiStore, memoryApiHeaders, mirrorArtifactToMemoryApi, recordMemoryIngestFailure } from "../lib/memory-api";

const originalToken = process.env.SHERPA_MEMORY_API_TOKEN;
const originalMemoryToken = process.env.MEMORY_API_TOKEN;
const originalFetch = globalThis.fetch;
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
  delete process.env.MEMORY_API_TOKEN;
  assert.equal(memoryApiHeaders(cfg).Authorization, "Basic dev-token");
  assert.deepEqual(memoryApiAuthStatus(cfg), { configured: true, source: "localhost-dev-token", tokenEnv: "SHERPA_MEMORY_API_TOKEN" });
  cfg.memoryApi.url = "https://api.enquirer.app";
  assert.deepEqual(memoryApiAuthStatus(cfg), { configured: false, source: "none", tokenEnv: "SHERPA_MEMORY_API_TOKEN" });
  process.env.SHERPA_MEMORY_API_TOKEN = "secret-token";
  assert.equal(memoryApiHeaders(cfg).Authorization, "Basic secret-token");
  assert.deepEqual(memoryApiAuthStatus(cfg), { configured: true, source: "tokenEnv:SHERPA_MEMORY_API_TOKEN", tokenEnv: "SHERPA_MEMORY_API_TOKEN" });

  let fetchMethod = "";
  let fetchBody: any = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    fetchMethod = String(init?.method ?? "GET");
    fetchBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify([{ artifact: { id: "a1", title: "A" }, score: 0.7 }]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const results = await new MemoryApiStore(cfg.memoryApi).search({ text: "hello", limit: 3 });
  assert.equal(fetchMethod, "POST");
  assert.deepEqual(fetchBody, { text: "hello", limit: 3 });
  assert.equal(results[0]?.artifact.id, "a1");

  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  assert.deepEqual(await new MemoryApiStore(cfg.memoryApi).search({ text: "hello" }), []);

  await mirrorArtifactToMemoryApi(cfg, { id: "broken", title: "Broken" }, cwd);
  const mirrorFailureLog = path.join(cwd, ".pi-memory", "archivist-inquirer-ingest-failures.jsonl");
  assert.equal(existsSync(mirrorFailureLog), true);

  recordMemoryIngestFailure(cwd, "/tmp/missing.md", new Error("boom"));
  const failureLines = readFileSync(path.join(cwd, ".pi-memory", "archivist-inquirer-ingest-failures.jsonl"), "utf8").trim().split("\n");
  const failure = JSON.parse(failureLines[failureLines.length - 1]);
  assert.equal(failure.file, "/tmp/missing.md");
  assert.equal(failure.error, "boom");
} finally {
  if (originalToken === undefined) delete process.env.SHERPA_MEMORY_API_TOKEN; else process.env.SHERPA_MEMORY_API_TOKEN = originalToken;
  if (originalMemoryToken === undefined) delete process.env.MEMORY_API_TOKEN; else process.env.MEMORY_API_TOKEN = originalMemoryToken;
  globalThis.fetch = originalFetch;
  rmSync(cwd, { recursive: true, force: true });
}

console.log("memory-api tests passed=15");
