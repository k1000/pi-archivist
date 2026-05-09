#!/usr/bin/env node
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const execFile = promisify(execFileCb);

const TECH_DOC_WRITER_SKILL_PATH = "/Users/kamil/Development/_DESERT_BACON/ClearStack/.claude/skills/technical-docs-writer/SKILL.md";

const DEFAULT = {
  enabled: true,
  commitHook: { enabled: true, async: true, recentCommitCount: 12 },
  model: { provider: "minimax", id: "MiniMax-M2.7-highspeed", heuristicOnly: false, fallbackToHeuristics: true, useMainPiModel: false },
  memory: { obsidianVault: "/Users/kamil/Documents/articles", obsidianMemoryPath: "projects/project", scratchpadPath: ".pi-memory/scratchpad" },
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
    if (sherpa?.model) cfg.model = merge(cfg.model, sherpa.model);
    if (sherpa?.memory) cfg.memory = merge(cfg.memory, sherpa.memory);
  }
  return merge(cfg, readJson(path.join(repo, ".pi", "archivist.config.json")));
}
async function git(repo, args) { const { stdout } = await execFile("git", args, { cwd: repo, maxBuffer: 4 * 1024 * 1024 }); return stdout.trim(); }
function today() { return new Date().toISOString().slice(0, 10); }
function now() { return new Date().toISOString(); }
function slug(v) { return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `commit-${Date.now()}`; }
function obsidianRoot(cfg) { return path.isAbsolute(cfg.memory.obsidianMemoryPath) ? cfg.memory.obsidianMemoryPath : path.join(cfg.memory.obsidianVault, cfg.memory.obsidianMemoryPath); }
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
function appendCatalogRow(root, row) {
  const target = path.join(root, "catalog.csv");
  const defaultHeader = ["id", "type", "path", "title", "summary", "aliases", "tags", "status", "confidence", "updated", "based_on", "supports", "implements", "derives_from", "related", "routes", "keywords"];
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const header = existing.trim() ? parseCsvLine(existing.split(/\r?\n/)[0]) : defaultHeader;
  if (existing.includes(`${row.id},`) || existing.includes(`"${row.id}",`)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  if (!existing.trim()) writeFileSync(target, header.join(",") + "\n");
  appendFileSync(target, header.map(key => csvCell(row[key] ?? "")).join(",") + "\n");
}
function heuristic(input) {
  return [`# Commit ${input.sha.slice(0, 12)}`, "", `Commit message: ${input.message || "(none)"}`, "", `Changed files: ${input.files.join(", ") || "unknown"}`, "", `Documentation impact: ${docsImpact(input.files) ? "possible" : "not obvious"}`, `Catalog navigation: ${input.catalogRows?.length ? input.catalogRows.map(row => `${row.id} -> ${row.path}`).join("; ") : "no matching catalog rows"}`, "", "## Systemic interpretation", "", "Heuristic fallback was used by the git hook. Run `/archivist_ingest` in pi for dedicated-model synthesis if this commit contains durable project knowledge.", "", "## Recent commit context", "", "```text", input.recent.slice(0, 4000), "```", "", "## Evidence", "", "```text", input.stats.slice(0, 8000), "```"].join("\n");
}
async function providerConfig(provider) {
  const models = readJson(path.join(os.homedir(), ".pi", "agent", "models.json"));
  return models?.providers?.[provider];
}
async function callModel(cfg, input) {
  if (cfg.model.heuristicOnly) return heuristic(input);
  const provider = await providerConfig(cfg.model.provider);
  if (!provider?.baseUrl) return heuristic(input);
  const apiKeyValue = provider.apiKey && process.env[provider.apiKey] ? process.env[provider.apiKey] : provider.apiKey;
  if (!apiKeyValue && !provider.baseUrl.includes("127.0.0.1") && !provider.baseUrl.includes("localhost")) return heuristic(input);
  const prompt = [
    "You are Archivist, the write-side partner to Sherpa. Sherpa handles retrieval/read-side context; Archivist maintains durable long-term memory and documentation.",
    "Use the existing Sherpa catalog service surface (`catalog.csv`) to navigate where documentation lives before deciding what to write. Prefer catalog paths and relationships over folder guessing.",
    "Use Sherpa's existing Obsidian ontology only: wiki/systems, wiki/procedures, wiki/decisions, wiki/concepts, wiki/evidence, journal, inbox. Do not invent new categories.",
    "Analyze the commit together with recent commit context. Extract broader purpose, intent, constraints, and system-level knowledge only when warranted.",
    `When substantial repo-local prose/API/guide/architecture documentation is needed, recommend using the technical doc writer skill at ${TECH_DOC_WRITER_SKILL_PATH}.`,
    "Return concise Markdown with: Summary, Intent Across Recent Commits, System Knowledge, Documentation Impact, Repo Docs Follow-up, Evidence. Be conservative."
  ].join("\n");
  const body = {
    model: cfg.model.id,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: [`Commit: ${input.sha}`, `Message:\n${input.message}`, `Recent commits:\n${input.recent}`, `Changed files:\n${input.files.join("\n")}`, `Relevant catalog rows for navigation:\n${input.catalogRows?.length ? JSON.stringify(input.catalogRows, null, 2) : "(none)"}`, `Stats:\n${input.stats}`, `Diff excerpt:\n${input.diff.slice(0, 24000)}`].join("\n\n") }
    ],
    temperature: 0.2,
    max_tokens: 2048,
  };
  try {
    const url = provider.baseUrl.replace(/\/$/, "") + "/chat/completions";
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKeyValue || "1234"}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!res.ok) return heuristic(input);
    const json = await res.json();
    return json?.choices?.[0]?.message?.content?.trim() || heuristic(input);
  } catch {
    return heuristic(input);
  }
}
async function collect(repo, commit, count) {
  const sha = await git(repo, ["rev-parse", commit]);
  const message = await git(repo, ["log", "-1", "--pretty=%B", sha]);
  const stats = await git(repo, ["show", "--stat", "--name-status", "--format=fuller", sha]);
  const diff = await git(repo, ["show", "--format=", "--find-renames", "--find-copies", sha]);
  const filesRaw = await git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  const recent = await git(repo, ["log", `-${Math.max(1, count)}`, "--date=short", "--pretty=format:%h %ad %s", "--decorate"]);
  return { sha, message, stats, diff, files: filesRaw.split(/\r?\n/).filter(Boolean), recent };
}
function writeMemory(cfg, repo, input, summary) {
  const root = obsidianRoot(cfg);
  const evidenceDir = path.join(root, "wiki", "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, `${slug(`commit-${input.sha.slice(0, 12)}`)}.md`);
  writeFileSync(evidenceFile, ["---", `id: archivist-${input.sha.slice(0, 12)}`, "type: evidence", "source: git-commit", `commit: ${input.sha}`, `created: ${now()}`, `repo: ${path.basename(repo)}`, "---", "", `# Commit ${input.sha.slice(0, 12)}`, "", summary.trim(), ""].join("\n"));
  appendCatalogRow(root, { id: `evidence.archivist-${input.sha.slice(0, 12)}`, type: "evidence", path: path.relative(root, evidenceFile).replace(/\\/g, "/"), title: `Commit ${input.sha.slice(0, 12)}`, summary: `Archivist commit evidence for ${input.sha.slice(0, 12)}`, aliases: input.sha.slice(0, 12), tags: "archivist|git|commit", status: "active", confidence: "medium", updated: today(), based_on: input.sha, routes: input.files.join("|"), keywords: input.files.map(file => path.basename(file)).join("|") });
  const journalDir = path.join(root, "journal");
  mkdirSync(journalDir, { recursive: true });
  const journalFile = path.join(journalDir, `${today()}.md`);
  appendFileSync(journalFile, `\n## Archivist ${input.sha.slice(0, 12)} — ${path.basename(repo)}\n\n${summary.trim()}\n\nEvidence: [[${path.basename(evidenceFile, ".md")}]]\n`);
  if (docsImpact(input.files)) {
    const inbox = path.join(root, "inbox", `archivist-docs-follow-up-${input.sha.slice(0, 12)}.md`);
    mkdirSync(path.dirname(inbox), { recursive: true });
    writeFileSync(inbox, ["---", "type: inbox", "source: archivist", `created: ${now()}`, `repo: ${path.basename(repo)}`, "---", "", "# Archivist docs follow-up", "", `Commit ${input.sha.slice(0, 12)} may require repo-local documentation review. See ${evidenceFile}.`, ""].join("\n"));
  }
  return { evidenceFile, journalFile };
}
function arg(name, fallback) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
const repo = arg("--repo", process.cwd());
const commit = arg("--commit", "HEAD");
const cfg = loadConfig(repo);
if (!cfg.enabled || cfg.commitHook?.enabled === false) process.exit(0);
try {
  const input = await collect(repo, commit, cfg.commitHook?.recentCommitCount || 12);
  input.catalogRows = relevantCatalogRows(obsidianRoot(cfg), [input.message, input.files.join("\n"), input.recent].join("\n"));
  const summary = await callModel(cfg, input);
  const written = writeMemory(cfg, repo, input, summary);
  console.log(`[archivist] ingested ${input.sha.slice(0, 12)} evidence=${written.evidenceFile}`);
} catch (error) {
  console.error(`[archivist] failed: ${error?.stack || error}`);
  process.exitCode = 0;
}
