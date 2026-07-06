import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_ARCHIVIST_CONFIG, type ArchivistConfig } from "./config";
import { titleFromMarkdown } from "./markdown-note";

// Errors are logged via console.warn rather than swallowed silently.
// Callers that deliberately want silent-fail behaviour use this marker.
export function apiSilent<T>(): (e: unknown) => T {
  return (e: unknown) => { try { console.warn("[archivist-api] write failed:", e instanceof Error ? e.message : String(e)); } catch {} return undefined as T; };
}

export type MemoryArtifact = Record<string, unknown> & {
  id: string;
  scope?: string;
  project?: string;
  area?: string;
  type?: string;
  title?: string;
  summary?: string;
  text?: string;
};

export type MemoryRelation = Record<string, unknown> & {
  from: string;
  relation: string;
  to: string;
};

export type RetrievalFeedbackRecord = Record<string, unknown> & {
  query?: string;
  missing?: string[];
  unusedIds?: string[];
};

export type ArchivistMemoryApiConfig = NonNullable<ArchivistConfig["memoryApi"]>;

export class MemoryApiStore {
  constructor(private readonly cfg: ArchivistMemoryApiConfig) {}

  async writeArtifact(artifact: MemoryArtifact): Promise<any> {
    return await memoryApiPostRaw(this.cfg, "/api/v1/memory/ingest", { artifact, sourceText: String(artifact.text ?? artifact.summary ?? artifact.title ?? "") });
  }

  async writeRelation(relation: MemoryRelation): Promise<any> {
    return await memoryApiPostRaw(this.cfg, "/api/v1/memory/ingest", { relation });
  }

  async search(query: { text: string; limit?: number }): Promise<Array<{ artifact: MemoryArtifact; score?: number }>> {
    try {
      const params = new URLSearchParams({ q: query.text, limit: String(query.limit ?? 10) });
      const result = await memoryApiGetRaw(this.cfg, `/api/v1/memory/search?${params.toString()}`);
      return Array.isArray(result?.results) ? result.results : Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }

  async recentFeedback(limit = 50): Promise<RetrievalFeedbackRecord[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    const result = await memoryApiGetRaw(this.cfg, `/api/v1/memory/retrieval-feedback?${params.toString()}`);
    return Array.isArray(result?.feedback) ? result.feedback : Array.isArray(result) ? result : [];
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableMemoryId(prefix: string, value: string): string {
  return `${prefix}.${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function archivistMemoryApiConfig(cfg: ArchivistConfig): ArchivistMemoryApiConfig {
  return cfg.memoryApi ?? DEFAULT_ARCHIVIST_CONFIG.memoryApi;
}

export function archivistMemoryStore(cfg: ArchivistConfig): MemoryApiStore | undefined {
  const memoryCfg = archivistMemoryApiConfig(cfg);
  return memoryCfg.enabled ? new MemoryApiStore(memoryCfg) : undefined;
}

export async function mirrorArtifactToMemoryApi(cfg: ArchivistConfig, artifact: MemoryArtifact): Promise<void> {
  const store = archivistMemoryStore(cfg);
  if (!store) return;
  await store.writeArtifact(artifact).catch(() => undefined);
}

function cloudflareAccessCookie(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    const dir = path.join(homedir(), ".cloudflared");
    if (!existsSync(dir)) return undefined;
    const tokenFile = readdirSync(dir).find((name) => name.startsWith(`${host}-`) && name.endsWith("-token"));
    if (!tokenFile) return undefined;
    const token = readFileSync(path.join(dir, tokenFile), "utf8").trim();
    return token ? `CF_Authorization=${token}` : undefined;
  } catch {
    return undefined;
  }
}

function memoryApiHeadersForConfig(memoryCfg: ArchivistMemoryApiConfig): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Archivist/1.0 (pi-coding-agent)" };
  const token = (memoryCfg as any).token
    || ((memoryCfg as any).tokenEnv ? process.env[(memoryCfg as any).tokenEnv] : undefined)
    || process.env.SHERPA_MEMORY_API_TOKEN
    || process.env.MEMORY_API_TOKEN
    || (memoryCfg.url.includes("127.0.0.1") || memoryCfg.url.includes("localhost") ? "dev-token" : undefined);
  if (token) headers.Authorization = `Basic ${token}`;
  const cfCookie = cloudflareAccessCookie(memoryCfg.url);
  if (cfCookie) headers.Cookie = cfCookie;
  return headers;
}

export function memoryApiHeaders(cfg: ArchivistConfig): Record<string, string> {
  return memoryApiHeadersForConfig(archivistMemoryApiConfig(cfg));
}

function memoryApiCanReadLocalVault(cfg: ArchivistConfig): boolean {
  try {
    const host = new URL(archivistMemoryApiConfig(cfg).url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

async function memoryApiGetRaw(memoryCfg: ArchivistMemoryApiConfig, apiPath: string, timeoutMs = 5000): Promise<any> {
  if (!memoryCfg.enabled) throw new Error("memory API mirror is disabled");
  const response = await fetch(`${memoryCfg.url.replace(/\/$/, "")}${apiPath}`, {
    headers: memoryApiHeadersForConfig(memoryCfg),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`memory API ${response.status}: ${await response.text()}`);
  return await response.json();
}

async function memoryApiPostRaw(memoryCfg: ArchivistMemoryApiConfig, apiPath: string, body: unknown, timeoutMs = 30000): Promise<any> {
  if (!memoryCfg.enabled) throw new Error("memory API mirror is disabled");
  const response = await fetch(`${memoryCfg.url.replace(/\/$/, "")}${apiPath}`, {
    method: "POST",
    headers: memoryApiHeadersForConfig(memoryCfg),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`memory API ${response.status}: ${await response.text()}`);
  return await response.json();
}

export async function memoryApiGet(cfg: ArchivistConfig, apiPath: string): Promise<any> {
  return await memoryApiGetRaw(archivistMemoryApiConfig(cfg), apiPath);
}

export async function memoryApiPost(cfg: ArchivistConfig, apiPath: string, body: unknown, timeoutMs = 30000): Promise<any> {
  return await memoryApiPostRaw(archivistMemoryApiConfig(cfg), apiPath, body, timeoutMs);
}

export async function ingestObsidianDocumentToMemoryApi(cfg: ArchivistConfig, cwd: string, file: string): Promise<{ ingested: boolean; reason?: string; path?: string; mode?: string }> {
  const memoryCfg = archivistMemoryApiConfig(cfg);
  if (!memoryCfg.enabled) return { ingested: false, reason: "memory API mirror is disabled" };
  if (!file.endsWith(".md")) return { ingested: false, reason: "not a markdown document" };
  const resolved = path.resolve(file);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return { ingested: false, reason: `document not found: ${file}` };
  const project = path.basename(cwd);
  const vault = path.resolve(cfg.memory.obsidianVault);
  const rel = path.relative(vault, resolved).replace(/\\/g, "/");
  const inVault = !rel.startsWith("..") && !path.isAbsolute(rel);
  if (inVault && memoryApiCanReadLocalVault(cfg)) {
    await memoryApiPost(cfg, "/api/v1/memory/ingest-vault", {
      vaultPath: vault,
      includePaths: [rel],
      limit: 1,
      dryRun: false,
      scope: "project",
      project,
      tags: ["obsidian", "vault-ingest", "archivist"],
    });
    return { ingested: true, path: rel, mode: "vault" };
  }

  const raw = readFileSync(resolved, "utf8");
  const title = titleFromMarkdown(raw, path.basename(resolved, ".md"));
  const artifactId = stableMemoryId("archivist-note", resolved);
  const sourcePath = inVault ? rel : resolved;
  await memoryApiPost(cfg, "/api/v1/memory/ingest", {
    artifact: {
      id: artifactId,
      scope: "project",
      project,
      type: "obsidian-note",
      title,
      text: raw.slice(0, 24000),
      sourcePath,
      sourceHash: createHash("sha256").update(raw).digest("hex"),
      confidence: "medium",
      status: "active",
      tags: ["obsidian", "archivist"],
      aliases: [title, path.basename(resolved)],
      routes: inVault ? [rel, resolved] : [resolved],
      keywords: [title, path.basename(resolved), ...(inVault ? [rel] : [])],
    },
    sourceText: raw.slice(0, 5000),
    options: {
      chunk: true,
      embed: true,
      extractJsonLd: false,
      disambiguate: false,
      linkMentions: false,
      semanticGraph: false,
      applyGraphPatches: false,
    },
  }, 120000);
  return { ingested: true, path: sourcePath, mode: "direct" };
}

export function recordMemoryIngestFailure(cwd: string, file: string, error: unknown): void {
  try {
    const logFile = path.join(cwd, ".pi-memory", "archivist-inquirer-ingest-failures.jsonl");
    mkdirSync(path.dirname(logFile), { recursive: true });
    const message = error instanceof Error ? error.message : String(error);
    appendFileSync(logFile, `${JSON.stringify({ at: nowIso(), file, error: message })}\n`);
    // Also emit to stderr so failures are visible in extension logs. Do not
    // create an Obsidian inbox note here: that could recurse into another ingest.
    console.warn(`[archivist] Inquirer ingest failed for ${file}: ${message}`);
  } catch {
    // Last-resort best effort only; do not break the primary Archivist write.
  }
}

export function triggerObsidianDocumentIngest(cfg: ArchivistConfig, cwd: string, file: string | null | undefined): void {
  if (!file) return;
  void ingestObsidianDocumentToMemoryApi(cfg, cwd, file).catch((error) => recordMemoryIngestFailure(cwd, file, error));
}

export function triggerObsidianDocumentsFromSyncResult(cfg: ArchivistConfig, cwd: string, syncResult: string): void {
  for (const match of syncResult.matchAll(/->\s+([^\n]+\.md)\b/g)) {
    const rawPath = match[1]?.trim();
    if (!rawPath || rawPath.includes(" (dry-run)")) continue;
    triggerObsidianDocumentIngest(cfg, cwd, path.resolve(cwd, rawPath));
  }
}
