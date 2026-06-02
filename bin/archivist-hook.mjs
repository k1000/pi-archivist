#!/usr/bin/env node
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, statSync, renameSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const execFile = promisify(execFileCb);

const TECH_DOC_WRITER_SKILL_PATH = "/Users/kamil/Development/_DESERT_BACON/ClearStack/.claude/skills/technical-docs-writer/SKILL.md";

const DEFAULT = {
  enabled: true,
  commitHook: { enabled: true, async: true, recentCommitCount: 12 },
  model: { provider: "minimax", id: "MiniMax-M2.7-highspeed", heuristicOnly: false, fallbackToHeuristics: true, useMainPiModel: false },
  memory: { obsidianVault: "/Users/kamil/Documents/articles", obsidianMemoryPath: "projects/project", scratchpadPath: ".pi-memory/scratchpad" },
  documentationJobs: { logPath: ".pi-memory/archivist-documentation-jobs.jsonl" },
};

function merge(base, over) {
  if (!over || typeof over !== "object") return structuredClone(base);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(base?.[k] ?? {}, v) : v;
  return out;
}
function readJson(file) { try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined; } catch { return undefined; } }
function projectRel(repo) { return `projects/${path.basename(repo).replace(/[^A-Za-z0-9_-]+/g, "-") || "project"}`; }
function loadConfig(repo) {
  let cfg = structuredClone(DEFAULT);
  cfg.memory.obsidianMemoryPath = projectRel(repo);
  for (const sherpa of [readJson(path.join(os.homedir(), ".pi", "sherpa.config.json")), readJson(path.join(repo, ".pi", "sherpa.config.json"))]) {
    // Reuse Sherpa's memory contract only. Archivist must keep its dedicated
    // lower model unless explicitly overridden by .pi/archivist.config.json.
    if (sherpa?.memory) cfg.memory = merge(cfg.memory, sherpa.memory);
  }
  return merge(cfg, readJson(path.join(repo, ".pi", "archivist.config.json")));
}
async function git(repo, args) { const { stdout } = await execFile("git", args, { cwd: repo, maxBuffer: 4 * 1024 * 1024 }); return stdout.trim(); }
function today() { return new Date().toISOString().slice(0, 10); }
function now() { return new Date().toISOString(); }
function slug(v) { return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `commit-${Date.now()}`; }
function obsidianRoot(cfg) { return path.isAbsolute(cfg.memory.obsidianMemoryPath) ? cfg.memory.obsidianMemoryPath : path.join(cfg.memory.obsidianVault, cfg.memory.obsidianMemoryPath); }
function documentationJobLogPath(cfg, repo) {
  const configured = cfg.documentationJobs?.logPath || DEFAULT.documentationJobs.logPath;
  return path.isAbsolute(configured) ? configured : path.join(repo, configured);
}
function appendDocumentationJobLog(cfg, repo, event) {
  try {
    const target = documentationJobLogPath(cfg, repo);
    mkdirSync(path.dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify({ schemaVersion: 1, at: now(), project: path.basename(repo), pid: process.pid, ...event })}\n`);
  } catch (error) {
    console.error(`[archivist] documentation job log failed: ${error?.message || error}`);
  }
}
function docsImpact(files) { return files.some(f => /(^|\/)(readme|docs|doc|adr|changelog)|\.(md|mdx|rst)$/i.test(f)) || files.some(f => /(^|\/)(api|routes?|schema|config|cli|deploy|migrations?|docker|infra|scripts?)\b/i.test(f)); }
function parseCsvLine(line) {
  const cells = []; let current = ""; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') { current += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch === ",") { cells.push(current); current = ""; continue; }
    current += ch;
  }
  cells.push(current); return cells;
}
function csvCell(value) { return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value; }
function readCatalog(root) {
  const target = path.join(root, "catalog.csv");
  if (!existsSync(target)) return [];
  const lines = readFileSync(target, "utf8").split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map(cell => cell.trim());
  return lines.slice(1).map(line => { const cells = parseCsvLine(line); const row = {}; header.forEach((key, index) => row[key] = cells[index] ?? ""); return row; }).filter(row => row.id && row.path);
}
function scoreText(query, text) {
  const words = new Set((query.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []).map(w => w.replace(/^-+|-+$/g, "")));
  let hits = 0; const haystack = text.toLowerCase();
  for (const word of words) if (word && haystack.includes(word)) hits++;
  return words.size ? hits / words.size : 0;
}
function relevantCatalogRows(root, focus) {
  return readCatalog(root).map(row => ({ row, score: scoreText(focus, [row.id, row.type, row.path, row.title, row.summary, row.aliases, row.tags, row.routes, row.keywords, row.related, row.based_on, row.supports, row.implements, row.derives_from].filter(Boolean).join("\n")) }))
    .filter(item => item.score > 0.04).sort((a, b) => b.score - a.score).slice(0, 12).map(item => item.row);
}
const DEFAULT_CATALOG_HEADER = ["id", "scope", "project", "area", "category", "type", "path", "title", "summary", "aliases", "tags", "status", "confidence", "updated", "based_on", "supports", "implements", "derives_from", "related", "applies_research", "applied_by_project", "generalizes_from", "specializes", "routes", "keywords"];
function writeCatalogRows(root, header, rows) {
  const target = path.join(root, "catalog.csv");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, header.join(",") + "\n" + rows.map(row => header.map(key => csvCell(row[key] ?? "")).join(",")).join("\n") + (rows.length ? "\n" : ""));
}
function upsertCatalogRow(root, row) {
  const target = path.join(root, "catalog.csv");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const header = [...new Set([...(existing.trim() ? parseCsvLine(existing.split(/\r?\n/)[0]) : DEFAULT_CATALOG_HEADER), ...Object.keys(row)])];
  const rows = readCatalog(root);
  const idx = rows.findIndex(existingRow => existingRow.id === row.id);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...row };
  else rows.push(row);
  writeCatalogRows(root, header, rows);
}
function generatedOrLowSignalFile(file) {
  return /(^|\/)node_modules\//.test(file)
    || /(^|\/)\.git\//.test(file)
    || /(^|\/)dist\//.test(file)
    || /(^|\/)build\//.test(file)
    || /(^|\/)\.venv\//.test(file)
    || /(^|\/)data\/agent_jobs\.json$/.test(file)
    || /(^|\/)assets\/generated_faces\//.test(file)
    || /\.(png|jpe?g|gif|webp|bmp|rgb565|wav|mp3|m4a|aiff|pyc|o|bin|elf|map)$/i.test(file)
    || /(^|\/)(package-lock|pnpm-lock|yarn\.lock|Cargo\.lock)$/.test(file);
}
function highSignalCommit(input) {
  const files = input.files.filter(file => !generatedOrLowSignalFile(file) && file !== "catalog.csv");
  if (!files.length) return false;
  if (docsImpact(files)) return true;
  if (files.some(file => /(^|\/)(README|AGENTS|CLAUDE)$|(^|\/)(server|firmware|scripts|stick|docs)\//i.test(file))) return true;

  const subject = String(input.message || "").split(/\r?\n/, 1)[0] || "";
  const semanticChange = /^(feat|fix|security|auth|perf|deploy|migration|schema|api|breaking)(\(.+\))?!?:/i.test(subject)
    || /\b(BREAKING CHANGE|security|permission|auth|rbac|rls|migration|schema|api|contract|runtime|deployment)\b/i.test(input.message || "");
  if (!semanticChange) return false;

  return files.some(file => /\.(ts|tsx|js|jsx|mjs|cjs|sql|json|ya?ml|toml)$/i.test(file)
    && /(^|\/)(apps|packages|server|scripts|infra|migrations|schema|routes?|api|workers?)\b/i.test(file));
}
function heuristic(input) {
  if (!highSignalCommit(input)) return "NO_DURABLE_FINDINGS";
  const signalFiles = input.files.filter(file => !generatedOrLowSignalFile(file));
  return ["## Summary", "", `Commit ${input.sha.slice(0, 12)} (${input.message || "no message"}) changed high-signal project files. The git hook could not obtain a dedicated-model synthesis, so this deterministic evidence note preserves source-grounded commit context for later review.`, "", "## Intent Across Recent Commits", "", "See recent commit context below; use this evidence with nearby commits before promoting current-truth wiki updates.", "", "## System Knowledge", "", `High-signal changed files: ${signalFiles.join(", ") || "unknown"}.`, "", "## Documentation Impact", "", `${docsImpact(signalFiles) ? "Possible documentation impact detected from docs/API/config/script paths." : "No direct documentation path detected, but project source files changed."}`, `Catalog navigation: ${input.catalogRows?.length ? input.catalogRows.map(row => `${row.id} -> ${row.path}`).join("; ") : "no matching catalog rows"}`, "", "## Repo Docs Follow-up", "", "Review this commit for current-truth drift if it changed user-visible behavior, runtime configuration, APIs, firmware behavior, or operational scripts.", "", "## Evidence", "", "Recent commits:", "", "```text", input.recent.slice(0, 4000), "```", "", "Commit stats:", "", "```text", input.stats.slice(0, 8000), "```"].join("\n");
}
async function providerConfig(provider) {
  const models = readJson(path.join(os.homedir(), ".pi", "agent", "models.json"));
  return models?.providers?.[provider];
}
let lastModelFallbackReason = "";
function logModelFallback(reason) {
  lastModelFallbackReason = reason;
  console.error(`[archivist] model fallback: ${reason}`);
}
function normalizeModelMarkdown(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return (fenced?.[1] ?? trimmed).trim();
}
function anthropicText(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return normalizeModelMarkdown(blocks.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n"));
}
async function callAnthropicProvider(provider, target, prompt, userContent, apiKeyValue) {
  const url = provider.baseUrl.replace(/\/$/, "") + "/v1/messages";
  const body = { model: target.id, system: prompt, messages: [{ role: "user", content: userContent }], temperature: 0.2, max_tokens: 2048 };
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKeyValue || "1234", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!res.ok) return { ok: false, reason: `${provider.api} ${res.status}: ${(await res.text()).slice(0, 240)}` };
  const text = anthropicText(await res.json());
  if (!text) return { ok: false, reason: `${provider.api} returned no text content` };
  return { ok: true, text };
}

async function callOpenAiProvider(provider, target, prompt, userContent, apiKeyValue) {
  const url = provider.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const body = { model: target.id, messages: [{ role: "system", content: prompt }, { role: "user", content: userContent }], temperature: 0.2, max_tokens: 2048 };
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKeyValue || "1234"}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!res.ok) return { ok: false, reason: `${provider.api || "openai"} ${res.status}: ${(await res.text()).slice(0, 240)}` };
  const text = normalizeModelMarkdown((await res.json())?.choices?.[0]?.message?.content ?? "");
  if (!text) return { ok: false, reason: `${provider.api || "openai"} returned no text content` };
  return { ok: true, text };
}

async function callModelProvider(target, prompt, userContent) {
  const provider = await providerConfig(target.provider);
  if (!provider?.baseUrl) return { ok: false, reason: `provider not found or missing baseUrl: ${target.provider}` };
  const apiKeyValue = provider.apiKey && process.env[provider.apiKey] ? process.env[provider.apiKey] : provider.apiKey;
  if (!apiKeyValue && !provider.baseUrl.includes("127.0.0.1") && !provider.baseUrl.includes("localhost")) return { ok: false, reason: `missing API key for provider: ${target.provider}` };
  try {
    return provider.api === "anthropic-messages"
      ? await callAnthropicProvider(provider, target, prompt, userContent, apiKeyValue)
      : await callOpenAiProvider(provider, target, prompt, userContent, apiKeyValue);
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

function modelFallbackChain(cfg) {
  const configured = Array.isArray(cfg.model.fallbacks) ? cfg.model.fallbacks : [];
  const chain = [
    { provider: cfg.model.provider, id: cfg.model.id },
    ...configured,
    { provider: "olmx", id: "Qwen3.6-35B-A3B-4bit" },
    { provider: "omlxa", id: "gemma-4-e4b-it-4bit" },
  ];
  const seen = new Set();
  return chain.filter(item => {
    const key = `${item.provider}/${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return item.provider && item.id;
  });
}

async function callModel(cfg, input) {
  lastModelFallbackReason = "";
  if (cfg.model.heuristicOnly) { logModelFallback("heuristicOnly enabled"); return heuristic(input); }
  const prompt = [
    "You are Archivist, the write-side partner to Sherpa. Sherpa handles retrieval/read-side context; Archivist maintains durable long-term memory and documentation.",
    "Use the existing Sherpa catalog service surface (`catalog.csv`) to navigate where documentation lives before deciding what to write. Prefer catalog paths and relationships over folder guessing.",
    "Use Sherpa's existing Obsidian ontology only: wiki/systems, wiki/procedures, wiki/decisions, wiki/concepts, wiki/evidence, journal, inbox. Do not invent new categories.",
    "Analyze the commit together with recent commit context. Extract broader purpose, intent, constraints, and system-level knowledge only when warranted.",
    "Apply an information-purity gate: do not create durable memory for formatting-only changes, generated files, lockfile churn, no-op/config noise, transient fixes with no reusable lesson, or commits that do not teach future agents anything meaningful.",
    `When substantial repo-local prose/API/guide/architecture documentation is needed, recommend using the technical doc writer skill at ${TECH_DOC_WRITER_SKILL_PATH}.`,
    "If there is no durable knowledge worth preserving, return exactly: NO_DURABLE_FINDINGS.",
    "Otherwise return concise Markdown with: Summary, Intent Across Recent Commits, System Knowledge, Documentation Impact, Repo Docs Follow-up, Evidence. Be conservative."
  ].join("\n");
  const userContent = [`Commit: ${input.sha}`, `Message:\n${input.message}`, `Recent commits:\n${input.recent}`, `Changed files:\n${input.files.join("\n")}`, `Relevant catalog rows for navigation:\n${input.catalogRows?.length ? JSON.stringify(input.catalogRows, null, 2) : "(none)"}`, `Stats:\n${input.stats}`, `Diff excerpt:\n${input.diff.slice(0, 24000)}`].join("\n\n");
  const failures = [];
  for (const target of modelFallbackChain(cfg)) {
    const result = await callModelProvider(target, prompt, userContent);
    if (result.ok) {
      if (failures.length) logModelFallback(`primary failed; recovered with ${target.provider}/${target.id}: ${failures.join(" | ").slice(0, 400)}`);
      return result.text;
    }
    failures.push(`${target.provider}/${target.id}: ${result.reason}`);
  }
  logModelFallback(failures.join(" | ").slice(0, 800));
  return heuristic(input);
}
async function collect(repo, commit, count) {
  const sha = await git(repo, ["rev-parse", commit]);
  const message = await git(repo, ["log", "-1", "--pretty=%B", sha]);
  const stats = await git(repo, ["show", "--stat", "--name-status", "--format=fuller", sha]);
  const diff = await git(repo, ["show", "--format=", "--find-renames", "--find-copies", sha]);
  const filesRaw = await git(repo, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha]);
  const recent = await git(repo, ["log", `-${Math.max(1, count)}`, "--date=short", "--pretty=format:%h %ad %s", "--decorate"]);
  return { sha, message, stats, diff, files: filesRaw.split(/\r?\n/).filter(Boolean), recent };
}
function hasDurableCommitKnowledge(summary) {
  const normalized = summary.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "no_durable_findings" || normalized.startsWith("no_durable_findings\n")) return false;
  if (/no durable (knowledge|findings|memory|learning)/i.test(summary)) return false;
  if (/nothing durable (was )?(found|identified|detected)/i.test(summary)) return false;
  if (/heuristic fallback was used/i.test(summary)) return false;
  return true;
}
function writeMemory(cfg, repo, input, summary) {
  if (!hasDurableCommitKnowledge(summary)) return null;
  const root = obsidianRoot(cfg);
  const evidenceDir = path.join(root, "wiki", "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, `${slug(`commit-${input.sha.slice(0, 12)}`)}.md`);
  writeFileSync(evidenceFile, ["---", `id: archivist-${input.sha.slice(0, 12)}`, "type: evidence", "source: git-commit", `commit: ${input.sha}`, `created: ${now()}`, `repo: ${path.basename(repo)}`, `model: ${cfg.model.provider}/${cfg.model.id}`, "model_status: synthesized", "---", "", `# Commit ${input.sha.slice(0, 12)}`, "", summary.trim(), ""].join("\n"));
  upsertCatalogRow(repo, { id: `evidence.archivist-${input.sha.slice(0, 12)}`, scope: "project", project: path.basename(repo), type: "evidence", path: path.relative(repo, evidenceFile).replace(/\\/g, "/"), title: `Commit ${input.sha.slice(0, 12)}`, summary: `Archivist commit evidence for ${input.sha.slice(0, 12)}`, aliases: input.sha.slice(0, 12), tags: "archivist|git|commit", status: "active", confidence: "medium", updated: today(), based_on: input.sha, routes: input.files.join("|"), keywords: input.files.map(file => path.basename(file)).join("|") });
  const journalDir = path.join(root, "journal");
  mkdirSync(journalDir, { recursive: true });
  const journalFile = path.join(journalDir, `${today()}.md`);
  appendFileSync(journalFile, `\n## Archivist ${input.sha.slice(0, 12)} — ${path.basename(repo)}\n\n${summary.trim()}\n\nEvidence: [[${path.basename(evidenceFile, ".md")}]]\n`);
  return { evidenceFile, journalFile };
}
function acquireHookLock(repo, staleMs = 10 * 60 * 1000) {
  const lockDir = path.join(repo, ".pi-memory", "archivist-hook.lock");
  try {
    mkdirSync(path.dirname(lockDir), { recursive: true });
    mkdirSync(lockDir);
    writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: now() }));
    return () => { try { rmLock(lockDir); } catch { /* best effort */ } };
  } catch {
    try {
      const age = Date.now() - statSync(lockDir).mtimeMs;
      if (age > staleMs) {
        rmLock(lockDir);
        mkdirSync(lockDir);
        writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: now(), staleLockRecovered: true }));
        return () => { try { rmLock(lockDir); } catch { /* best effort */ } };
      }
    } catch { /* lock disappeared or cannot stat */ }
    return undefined;
  }
}
function rmLock(lockDir) {
  rmSync(lockDir, { recursive: true, force: true });
}

// ── Solution A: Debounced hook queue ──
// Instead of dropping commits when another hook is running, queue them.
// The processor drains all queued commits in one cluster call.
const QUEUE_FILE = ".pi-memory/archivist-queue.jsonl";

function enqueueCommit(repo, sha) {
  const target = path.join(repo, QUEUE_FILE);
  mkdirSync(path.dirname(target), { recursive: true });
  appendFileSync(target, `${sha}\n`);
}

function drainQueue(repo) {
  const target = path.join(repo, QUEUE_FILE);
  if (!existsSync(target)) return [];
  const batch = `${target}.${process.pid}.${Date.now()}.batch`;
  try {
    // Atomic handoff: new hook processes can append to a fresh queue file while
    // this processor works on the renamed batch file.
    renameSync(target, batch);
  } catch {
    return [];
  }
  try {
    const raw = readFileSync(batch, "utf8");
    return [...new Set(raw.split(/\r?\n/).filter(Boolean))];
  } finally {
    rmSync(batch, { force: true });
  }
}

async function collectQueuedFiles(repo, shas) {
  const allFiles = new Set();
  for (const sha of shas) {
    const raw = await git(repo, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha]);
    for (const f of raw.split(/\r?\n/).filter(Boolean)) allFiles.add(f);
  }
  return [...allFiles];
}

async function validateConfig(cfg, repo) {
  const provider = await providerConfig(cfg.model.provider);
  const apiKeyValue = provider?.apiKey && process.env[provider.apiKey] ? process.env[provider.apiKey] : provider?.apiKey;
  const checks = [
    { name: "enabled", ok: cfg.enabled !== false, detail: String(cfg.enabled !== false) },
    { name: "commitHook", ok: cfg.commitHook?.enabled !== false, detail: String(cfg.commitHook?.enabled !== false) },
    { name: "provider", ok: !!provider?.baseUrl, detail: provider?.baseUrl || `missing provider ${cfg.model.provider}` },
    { name: "model", ok: !!provider?.models?.some?.(model => model.id === cfg.model.id), detail: `${cfg.model.provider}/${cfg.model.id}` },
    { name: "apiKey", ok: !!apiKeyValue || provider?.baseUrl?.includes("127.0.0.1") || provider?.baseUrl?.includes("localhost"), detail: provider?.apiKey ? "configured" : "not required/local or missing" },
    { name: "memoryPath", ok: !!obsidianRoot(cfg), detail: obsidianRoot(cfg) },
    { name: "jobLog", ok: !!documentationJobLogPath(cfg, repo), detail: documentationJobLogPath(cfg, repo) },
  ];
  const ok = checks.every(check => check.ok);
  console.log(JSON.stringify({ ok, repo, model: `${cfg.model.provider}/${cfg.model.id}`, checks }, null, 2));
  return ok;
}
function printReliabilityStatus(cfg, repo, limit = 100) {
  const target = documentationJobLogPath(cfg, repo);
  if (!existsSync(target)) {
    console.log(`[archivist] reliability: no job log yet (${target})`);
    return;
  }
  const entries = readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(500, limit))).map(line => {
    try { return JSON.parse(line); } catch { return undefined; }
  }).filter(Boolean);
  const counts = (field) => entries.reduce((acc, entry) => {
    const key = entry?.[field] || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const concerning = entries.filter(entry => ["failed", "fallback"].includes(entry?.status)).slice(-10);
  console.log(JSON.stringify({
    log: target,
    entriesReviewed: entries.length,
    model: `${cfg.model.provider}/${cfg.model.id}`,
    statusCounts: counts("status"),
    kindCounts: counts("kind"),
    recentFailuresOrFallbacks: concerning.map(entry => ({ at: entry.at, kind: entry.kind, status: entry.status, reason: entry.error || entry.reason })),
  }, null, 2));
}

async function smokeModel(cfg) {
  lastModelFallbackReason = "";
  const provider = await providerConfig(cfg.model.provider);
  if (!provider?.baseUrl) throw new Error(`provider not found or missing baseUrl: ${cfg.model.provider}`);
  const apiKeyValue = provider.apiKey && process.env[provider.apiKey] ? process.env[provider.apiKey] : provider.apiKey;
  if (!apiKeyValue && !provider.baseUrl.includes("127.0.0.1") && !provider.baseUrl.includes("localhost")) throw new Error(`missing API key for provider: ${cfg.model.provider}`);
  const prompt = "Reply with exactly: ARCHIVIST_MODEL_OK";
  if (provider.api === "anthropic-messages") {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKeyValue || "1234", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: cfg.model.id, messages: [{ role: "user", content: prompt }], max_tokens: 512 }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`${provider.api} ${res.status}: ${(await res.text()).slice(0, 240)}`);
    const text = anthropicText(await res.json());
    if (!text.includes("ARCHIVIST_MODEL_OK")) throw new Error(`unexpected model response: ${text.slice(0, 160)}`);
    return { ok: true, api: provider.api, model: `${cfg.model.provider}/${cfg.model.id}`, text };
  }
  const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKeyValue || "1234"}` },
    body: JSON.stringify({ model: cfg.model.id, messages: [{ role: "user", content: prompt }], max_tokens: 512 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${provider.api || "openai"} ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const json = await res.json();
  const text = normalizeModelMarkdown(json?.choices?.[0]?.message?.content ?? "");
  if (!text.includes("ARCHIVIST_MODEL_OK")) throw new Error(`unexpected model response: ${text.slice(0, 160)}`);
  return { ok: true, api: provider.api || "openai", model: `${cfg.model.provider}/${cfg.model.id}`, text };
}
function printHelp() {
  console.log([
    "Archivist hook",
    "",
    "Usage:",
    "  archivist-hook.mjs --repo <path> --commit <commit-ish>",
    "  archivist-hook.mjs --repo <path> --smoke-model",
    "  archivist-hook.mjs --repo <path> --reliability-status [--limit N]",
    "  archivist-hook.mjs --repo <path> --validate-config",
    "",
    "Options:",
    "  --repo <path>             Repository root. Defaults to current working directory.",
    "  --commit <commit-ish>     Commit to ingest. Defaults to HEAD.",
    "  --smoke-model             Verify configured dedicated model/provider endpoint.",
    "  --reliability-status      Print JSON summary of recent Archivist job log entries.",
    "  --validate-config         Validate provider/model/key/path configuration without calling the model.",
    "  --limit <N>               Reliability status entry limit. Defaults to 100.",
    "  --help                    Show this help.",
  ].join("\n"));
}
function arg(name, fallback) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}
const repo = arg("--repo", process.cwd());
const commit = arg("--commit", "HEAD");
const cfg = loadConfig(repo);
if (process.argv.includes("--validate-config")) {
  const ok = await validateConfig(cfg, repo);
  process.exit(ok ? 0 : 1);
}
if (!cfg.enabled || cfg.commitHook?.enabled === false) process.exit(0);
if (process.argv.includes("--reliability-status")) {
  printReliabilityStatus(cfg, repo, Number(arg("--limit", "100")) || 100);
  process.exit();
}
if (process.argv.includes("--smoke-model")) {
  const releaseSmokeLock = acquireHookLock(repo, 2 * 60 * 1000);
  if (!releaseSmokeLock) {
    appendDocumentationJobLog(cfg, repo, { kind: "model-smoke-test", status: "skipped", trigger: "archivist-hook --smoke-model", model: `${cfg.model.provider}/${cfg.model.id}`, reason: "another Archivist hook is already running" });
    console.log("[archivist] model smoke test skipped because another hook is already running");
    process.exit(0);
  }
  try {
    const result = await smokeModel(cfg);
    appendDocumentationJobLog(cfg, repo, { kind: "model-smoke-test", status: "passed", trigger: "archivist-hook --smoke-model", model: result.model, api: result.api });
    console.log(`[archivist] model smoke test passed: ${result.model} api=${result.api}`);
  } catch (error) {
    appendDocumentationJobLog(cfg, repo, { kind: "model-smoke-test", status: "failed", trigger: "archivist-hook --smoke-model", model: `${cfg.model.provider}/${cfg.model.id}`, error: error?.message || String(error) });
    console.error(`[archivist] model smoke test failed: ${error?.message || error}`);
    process.exitCode = 1;
  } finally {
    releaseSmokeLock();
  }
  process.exit();
}
const queuedCommit = await git(repo, ["rev-parse", commit]).catch(() => commit);
enqueueCommit(repo, queuedCommit);
const releaseHookLock = acquireHookLock(repo);
if (!releaseHookLock) {
  appendDocumentationJobLog(cfg, repo, { kind: "commit-ingest", status: "queued", trigger: "post-commit-hook", commit: queuedCommit, reason: "another Archivist processor is running" });
  console.log(`[archivist] queued ${String(queuedCommit).slice(0, 12)} for active processor`);
  process.exit(0);
}
try {
  let batches = 0;
  while (batches++ < 20) {
    const queuedShas = drainQueue(repo);
    if (!queuedShas.length) break;
    const anchor = queuedShas[queuedShas.length - 1];
    const input = await collect(repo, anchor, Math.max(cfg.commitHook?.recentCommitCount || 12, queuedShas.length));
    input.files = await collectQueuedFiles(repo, queuedShas);
    if (queuedShas.length > 1) {
      const batchLog = await git(repo, ["log", "--date=short", "--pretty=format:%h %ad %s", ...queuedShas]).catch(() => queuedShas.join("\n"));
      const batchStats = await git(repo, ["show", "--stat", "--name-status", "--format=fuller", ...queuedShas]).catch(() => input.stats);
      const batchDiff = await git(repo, ["show", "--format=", "--find-renames", "--find-copies", ...queuedShas]).catch(() => input.diff);
      input.message = `Queued Archivist commit batch (${queuedShas.length} commits), anchored at ${anchor}\n\n${input.message}`;
      input.recent = batchLog;
      input.stats = batchStats;
      input.diff = batchDiff;
    }
    if (!highSignalCommit(input)) {
      appendDocumentationJobLog(cfg, repo, { kind: "commit-ingest", status: "skipped", trigger: "post-commit-hook", commit: anchor, queuedCommits: queuedShas, files: input.files, reason: "low-signal queued commit batch; hook model call skipped", highSignal: false, model: `${cfg.model.provider}/${cfg.model.id}` });
      console.log(`[archivist] skipped queued batch ${anchor.slice(0, 12)} low-signal (${queuedShas.length} commits)`);
      continue;
    }
    input.catalogRows = relevantCatalogRows(repo, [input.message, input.files.join("\n"), input.recent].join("\n"));
    const summary = await callModel(cfg, input);
    const written = writeMemory(cfg, repo, input, summary);
    if (!written) {
      appendDocumentationJobLog(cfg, repo, { kind: "commit-ingest", status: lastModelFallbackReason ? "fallback" : "skipped", trigger: "post-commit-hook", commit: input.sha, queuedCommits: queuedShas, files: input.files, reason: lastModelFallbackReason || "no durable knowledge passed information-purity gate", highSignal: highSignalCommit(input), model: `${cfg.model.provider}/${cfg.model.id}` });
      console.log(`[archivist] skipped queued batch ${input.sha.slice(0, 12)} no durable knowledge`);
    } else {
      appendDocumentationJobLog(cfg, repo, { kind: "commit-ingest", status: "written", trigger: "post-commit-hook", commit: input.sha, queuedCommits: queuedShas, files: input.files, evidenceFile: written.evidenceFile, journalFile: written.journalFile, model: `${cfg.model.provider}/${cfg.model.id}`, modelStatus: lastModelFallbackReason ? "fallback" : "synthesized" });
      console.log(`[archivist] ingested queued batch ${input.sha.slice(0, 12)} (${queuedShas.length} commits) evidence=${written.evidenceFile}`);
    }
  }
} catch (error) {
  appendDocumentationJobLog(cfg, repo, { kind: "commit-ingest", status: "failed", trigger: "post-commit-hook", commit: queuedCommit, error: error?.message || String(error) });
  console.error(`[archivist] failed: ${error?.stack || error}`);
  process.exitCode = 0;
} finally {
  releaseHookLock();
}
