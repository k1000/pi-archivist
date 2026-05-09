import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createAutoMemoryState, hashAutoMemory, stringifyForAutoMemory, writeAutoMemoryArtifact, type AutoMemoryState } from "../pi-sherpa/lib/auto-memory";
import { classifyTaskOutcome, suggestVerificationCommands } from "../pi-sherpa/lib/lifecycle";
import { createAutomationState, discoverRunnableAutomations, findRunnableAutomation, formatRunnableAutomation, recordAutomationRun, updateAutomationCandidates, type AutomationState } from "../pi-sherpa/lib/automation";
import { evaluatePersistence } from "../pi-sherpa/lib/preserve";
import { syncReflectMemory } from "../pi-sherpa/lib/memory";
import { writeDistilledSkill } from "../pi-sherpa/lib/distillation";

const execFileAsync = promisify(execFile);
const TECH_DOC_WRITER_SKILL_PATH = "/Users/kamil/Development/_DESERT_BACON/ClearStack/.claude/skills/technical-docs-writer/SKILL.md";

const DEFAULT_ARCHIVIST_CONFIG = {
  enabled: true,
  commitHook: { enabled: true, async: true, recentCommitCount: 12 },
  model: {
    provider: "minimax",
    id: "MiniMax-M2.7-highspeed",
    useMainPiModel: false,
    heuristicOnly: false,
    fallbackToHeuristics: true,
  },
  memory: {
    obsidianVault: "/Users/kamil/Documents/articles",
    obsidianMemoryPath: "projects/project",
    scratchpadPath: ".pi-memory/scratchpad",
  },
  repoDocs: { mode: "propose" },
};

type ArchivistConfig = typeof DEFAULT_ARCHIVIST_CONFIG;

function mergeConfig<T>(base: T, over: any): T {
  if (!over || typeof over !== "object") return structuredClone(base);
  const out: any = Array.isArray(base) ? [...base] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? mergeConfig((base as any)?.[k] ?? {}, v) : v;
  }
  return out;
}

function projectMemoryRel(cwd: string) {
  const name = path.basename(cwd).replace(/[^A-Za-z0-9_-]+/g, "-") || "project";
  return `projects/${name}`;
}

function readJsonIfExists(file: string) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined; }
  catch { return undefined; }
}

function loadConfig(cwd: string): ArchivistConfig {
  const cfg = structuredClone(DEFAULT_ARCHIVIST_CONFIG);
  cfg.memory.obsidianMemoryPath = projectMemoryRel(cwd);

  // Reuse Sherpa's existing memory/model configuration as the base contract.
  const globalSherpa = readJsonIfExists(path.join(process.env.HOME || "/Users/kamil", ".pi", "sherpa.config.json"));
  const projectSherpa = readJsonIfExists(path.join(cwd, ".pi", "sherpa.config.json"));
  for (const sherpa of [globalSherpa, projectSherpa]) {
    if (sherpa?.model) (cfg as any).model = mergeConfig(cfg.model, sherpa.model);
    if (sherpa?.memory) (cfg as any).memory = mergeConfig(cfg.memory, sherpa.memory);
  }

  const projectArchivist = readJsonIfExists(path.join(cwd, ".pi", "archivist.config.json"));
  return mergeConfig(cfg, projectArchivist);
}

function obsidianMemoryPath(cfg: ArchivistConfig) {
  const configured = cfg.memory.obsidianMemoryPath || DEFAULT_ARCHIVIST_CONFIG.memory.obsidianMemoryPath;
  return path.isAbsolute(configured) ? configured : path.join(cfg.memory.obsidianVault, configured);
}


type ArchivistState = {
  autoMemory: AutoMemoryState;
  automation: AutomationState;
  lifecycleHashes: string[];
};

function createArchivistState(): ArchivistState {
  return { autoMemory: createAutoMemoryState(), automation: createAutomationState(), lifecycleHashes: [] };
}

function memoryPaths(cfg: ArchivistConfig, cwd: string) {
  return {
    cwd,
    extensionMemoryDir: path.join(path.dirname(__filename), "..", "pi-sherpa", "memory"),
    obsidianVault: cfg.memory.obsidianVault,
    obsidianMemoryPath: obsidianMemoryPath(cfg),
  };
}

function appendInboxNote(cfg: ArchivistConfig, cwd: string, title: string, text: string) {
  const root = obsidianMemoryPath(cfg);
  const target = path.join(root, "inbox", `${slug(title)}-${Date.now()}.md`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, [
    "---",
    "type: inbox",
    "source: archivist",
    `created: ${nowIso()}`,
    `repo: ${path.basename(cwd)}`,
    "---",
    "",
    `# ${title}`,
    "",
    text.trim(),
    "",
  ].join("\n"));
  return target;
}

function appendJournalNote(cfg: ArchivistConfig, cwd: string, title: string, text: string) {
  const target = path.join(obsidianMemoryPath(cfg), "journal", `${today()}.md`);
  mkdirSync(path.dirname(target), { recursive: true });
  appendFileSync(target, `\n## ${title} — ${path.basename(cwd)}\n\n${text.trim()}\n`);
  return target;
}

function autoMemoryConfig(cfg: ArchivistConfig, cwd: string) {
  return {
    cwd,
    obsidianVault: cfg.memory.obsidianVault,
    obsidianMemoryPath: obsidianMemoryPath(cfg),
    // Keep scratchpad ownership in Sherpa. Archivist redirects review candidates
    // to durable Obsidian inbox instead of appending .pi-memory/scratchpad.
    appendScratchpadCandidate: (text: string, title?: string) => { appendInboxNote(cfg, cwd, title || "Archivist candidate", text); },
  };
}

function parseGitStatusFiles(status: string) {
  const files: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const candidate = parts[parts.length - 1]?.replace(/^"|"$/g, "");
    if (candidate) files.push(candidate);
  }
  return [...new Set(files)];
}
function isDocumentationPath(file: string) { return /(^|\/)(readme|docs?|adr|changelog|agents)\b|\.(md|mdx|rst)$/i.test(file); }
function isSourcePath(file: string) {
  if (isDocumentationPath(file)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|sh|sql|json|toml|yaml|yml|env|ini|config)$/i.test(file)
    || /(^|\/)(package\.json|Dockerfile|docker-compose|Makefile|migrations?|scripts?|config|schema|routes?)\b/i.test(file);
}
async function gitChanged(cwd: string) {
  try { return await git(cwd, ["status", "--short"]); } catch { return ""; }
}
function findDocumentationCandidates(cwd: string, changedSources: string[]) {
  const candidates = new Set<string>();
  for (const rel of ["README.md", "docs/README.md", "AGENTS.md", "CHANGELOG.md"]) if (existsSync(path.join(cwd, rel))) candidates.add(rel);
  const terms = changedSources.flatMap((file) => file.split(/[\\/._-]+/).filter((part) => part.length >= 4)).slice(0, 20);
  const roots = ["docs"];
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).slice(0, 200)) {
      const full = path.join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) visit(full);
        else if (/\.(md|mdx|rst)$/i.test(name)) {
          const raw = readFileSync(full, "utf8").toLowerCase();
          if (!terms.length || terms.some((term) => raw.includes(term.toLowerCase()))) candidates.add(path.relative(cwd, full));
        }
      } catch { /* ignore */ }
    }
  };
  for (const root of roots) visit(path.join(cwd, root));
  return [...candidates].slice(0, 8);
}
async function auditDocumentationDrift(state: ArchivistState, cfg: ArchivistConfig, cwd: string, changedFilesOverride?: string[]) {
  const status = await gitChanged(cwd);
  const files = changedFilesOverride ?? parseGitStatusFiles(status);
  const changedSources = files.filter(isSourcePath);
  if (!changedSources.length) return { needed: false, reason: "no source changes" };
  const changedDocs = files.filter(isDocumentationPath);
  if (changedDocs.length) return { needed: false, reason: "documentation changed with source", changedSources, changedDocs };
  const hash = hashAutoMemory(`archivist-doc-audit\n${changedSources.sort().join("\n")}`);
  if (state.autoMemory.docAuditHashes.includes(hash)) return { needed: false, reason: "already audited", changedSources };
  const candidates = findDocumentationCandidates(cwd, changedSources);
  appendInboxNote(cfg, cwd, "Documentation drift audit", [
    "Archivist detected source/config changes without documentation changes.",
    "",
    "Changed source/config files:",
    ...changedSources.map((file) => `- ${file}`),
    "",
    candidates.length ? "Likely documentation to review:" : "No obvious documentation file found; decide whether README/docs need a note.",
    ...candidates.map((file) => `- ${file}`),
  ].join("\n"));
  state.autoMemory.docAuditHashes = [...state.autoMemory.docAuditHashes.slice(-49), hash];
  return { needed: true, hash, changedSources, candidates };
}
function documentationAuditMessage(audit: { changedSources?: string[]; candidates?: string[] }) {
  const sources = audit.changedSources ?? [];
  const docs = audit.candidates ?? [];
  return [
    "## Archivist Documentation Audit",
    "",
    "Archivist detected code/config changes without accompanying documentation updates.",
    "Review whether docs should be updated before considering the task complete.",
    "Policy source: Sherpa DOCUMENTATION.md, now enforced by Archivist write-side maintenance.",
    `Technical doc writer skill for substantial doc authoring: ${TECH_DOC_WRITER_SKILL_PATH}`,
    "",
    "### Changed source/config files",
    ...(sources.length ? sources.map((file) => `- ${file}`) : ["- (none listed)"]),
    "",
    docs.length ? "### Likely documentation to review" : "### Documentation to review",
    ...(docs.length ? docs.map((file) => `- ${file}`) : ["- No obvious doc file found; check README/docs if behavior or usage changed."]),
  ].join("\n");
}

function parseSyncArgs(args?: string) {
  const parts = args?.trim() ? args.trim().split(/\s+/) : [];
  const out: { refId?: string; destination?: string; dryRun?: boolean; since?: string } = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "--dry-run") out.dryRun = true;
    if (part === "--ref-id") out.refId = parts[++i];
    if (part === "--destination") out.destination = parts[++i];
    if (part === "--since") out.since = parts[++i];
  }
  return out;
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

function today() { return new Date().toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }
function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `commit-${Date.now()}`;
}
function hasDocsImpact(files: string[]) {
  return files.some((file) => /(^|\/)(readme|docs|doc|adr|changelog)|\.(md|mdx|rst)$/i.test(file))
    || files.some((file) => /(^|\/)(api|routes?|schema|config|cli|deploy|migrations?|docker|infra|scripts?)\b/i.test(file));
}

type CatalogRow = Record<string, string>;
function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') { current += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch === ",") { cells.push(current); current = ""; continue; }
    current += ch;
  }
  cells.push(current);
  return cells;
}
function csvCell(value: string) { return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value; }
function readCatalog(root: string): CatalogRow[] {
  const target = path.join(root, "catalog.csv");
  if (!existsSync(target)) return [];
  const lines = readFileSync(target, "utf8").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]!).map((cell) => cell.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: CatalogRow = {};
    header.forEach((key, index) => { row[key] = cells[index] ?? ""; });
    return row;
  }).filter((row) => row.id && row.path);
}
function scoreText(query: string, text: string) {
  const words = new Set((query.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []).map((w) => w.replace(/^-+|-+$/g, "")));
  let hits = 0;
  const haystack = text.toLowerCase();
  for (const word of words) if (word && haystack.includes(word)) hits++;
  return words.size ? hits / words.size : 0;
}
function relevantCatalogRows(root: string, focus: string) {
  return readCatalog(root)
    .map((row) => ({ row, score: scoreText(focus, [row.id, row.type, row.path, row.title, row.summary, row.aliases, row.tags, row.routes, row.keywords, row.related, row.based_on, row.supports, row.implements, row.derives_from].filter(Boolean).join("\n")) }))
    .filter((item) => item.score > 0.04)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((item) => item.row);
}
function appendCatalogRow(root: string, row: CatalogRow) {
  const target = path.join(root, "catalog.csv");
  const defaultHeader = ["id", "type", "path", "title", "summary", "aliases", "tags", "status", "confidence", "updated", "based_on", "supports", "implements", "derives_from", "related", "routes", "keywords"];
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const header = existing.trim() ? parseCsvLine(existing.split(/\r?\n/)[0]!) : defaultHeader;
  if (existing.includes(`${row.id},`) || existing.includes(`\"${row.id}\",`)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  if (!existing.trim()) writeFileSync(target, header.join(",") + "\n");
  appendFileSync(target, header.map((key) => csvCell(row[key] ?? "")).join(",") + "\n");
}

function heuristicSummary(input: { commit: string; message: string; stats: string; files: string[]; recent: string; catalogRows?: CatalogRow[] }) {
  const docs = hasDocsImpact(input.files);
  return [
    `# Commit ${input.commit.slice(0, 12)}`,
    "",
    `Commit message: ${input.message || "(none)"}`,
    "",
    `Changed files: ${input.files.length ? input.files.join(", ") : "unknown"}`,
    "",
    `Documentation impact: ${docs ? "possible" : "not obvious"}`,
    `Catalog navigation: ${input.catalogRows?.length ? input.catalogRows.map((row) => `${row.id} -> ${row.path}`).join("; ") : "no matching catalog rows"}`,
    "",
    "## Systemic interpretation",
    "",
    "Heuristic fallback was used because the dedicated Archivist model was unavailable or disabled. Review this commit with nearby branch history to decide whether Sherpa long-term memory or repo-local docs should be updated.",
    "",
    "## Evidence",
    "",
    "```text",
    input.stats.slice(0, 8000),
    "```",
  ].join("\n");
}

async function modelSummary(ctx: ExtensionContext, cfg: ArchivistConfig, input: { commit: string; message: string; stats: string; diff: string; files: string[]; recent: string; catalogRows: CatalogRow[] }) {
  if (cfg.model.heuristicOnly) return heuristicSummary(input);
  const model = ctx.modelRegistry.find(cfg.model.provider, cfg.model.id);
  if (!model) {
    if (cfg.model.fallbackToHeuristics) return heuristicSummary(input);
    throw new Error(`Archivist model not found: ${cfg.model.provider}/${cfg.model.id}`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    if (cfg.model.fallbackToHeuristics) return heuristicSummary(input);
    throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  }
  const prompt = [
    "You are Archivist, the write-side partner to Sherpa.",
    "Sherpa handles retrieval/read-side context. Archivist maintains durable long-term memory and documentation.",
    "Use the existing Sherpa catalog service surface (`catalog.csv`) to navigate where documentation lives before deciding what to write. Prefer catalog paths and relationships over folder guessing.",
    "Use Sherpa's existing Obsidian memory ontology only: wiki/systems, wiki/procedures, wiki/decisions, wiki/concepts, wiki/evidence, journal, inbox. Do not invent new categories.",
    "Analyze this commit together with recent commit context. Single commits can be atomic; extract the broader purpose, intent, constraints, and system-level knowledge only when warranted.",
    `When substantial repo-local prose/API/guide/architecture documentation is needed, do not write it yourself; recommend using the technical doc writer skill at ${TECH_DOC_WRITER_SKILL_PATH}.`,
    "Return concise Markdown with sections: Summary, Intent Across Recent Commits, System Knowledge, Documentation Impact, Repo Docs Follow-up, Evidence. Be conservative; do not overclaim.",
  ].join("\n");
  const message: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: [
      `Commit: ${input.commit}`,
      `Message:\n${input.message}`,
      `Recent commits:\n${input.recent}`,
      `Changed files:\n${input.files.join("\n")}`,
      `Relevant catalog rows for navigation:\n${input.catalogRows.length ? JSON.stringify(input.catalogRows, null, 2) : "(none)"}`,
      `Stats:\n${input.stats}`,
      `Diff excerpt:\n${input.diff.slice(0, 24000)}`,
    ].join("\n\n") }],
  };
  const response = await complete(model, { systemPrompt: prompt, messages: [message] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal });
  if (response.stopReason === "aborted") return heuristicSummary(input);
  const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n").trim();
  return text || heuristicSummary(input);
}

async function collectCommit(cwd: string, commit: string, recentCount: number) {
  const sha = await git(cwd, ["rev-parse", commit]);
  const message = await git(cwd, ["log", "-1", "--pretty=%B", sha]);
  const stats = await git(cwd, ["show", "--stat", "--name-status", "--format=fuller", sha]);
  const diff = await git(cwd, ["show", "--format=", "--find-renames", "--find-copies", sha]);
  const filesRaw = await git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  const recent = await git(cwd, ["log", `-${Math.max(1, recentCount)}`, "--date=short", "--pretty=format:%h %ad %s", "--decorate"]);
  return { sha, message, stats, diff, files: filesRaw.split(/\r?\n/).filter(Boolean), recent };
}

function writeMemory(cfg: ArchivistConfig, cwd: string, commit: string, summary: string, files: string[]) {
  const root = obsidianMemoryPath(cfg);
  const evidenceDir = path.join(root, "wiki", "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const title = `Commit ${commit.slice(0, 12)}`;
  const evidenceFile = path.join(evidenceDir, `${slug(title)}.md`);
  const note = [
    "---",
    `id: archivist-${commit.slice(0, 12)}`,
    "type: evidence",
    "source: git-commit",
    `commit: ${commit}`,
    `created: ${nowIso()}`,
    `repo: ${path.basename(cwd)}`,
    "---",
    "",
    `# ${title}`,
    "",
    summary.trim(),
    "",
  ].join("\n");
  writeFileSync(evidenceFile, note);
  appendCatalogRow(root, {
    id: `evidence.archivist-${commit.slice(0, 12)}`,
    type: "evidence",
    path: path.relative(root, evidenceFile).replace(/\\/g, "/"),
    title,
    summary: `Archivist commit evidence for ${commit.slice(0, 12)}`,
    aliases: commit.slice(0, 12),
    tags: "archivist|git|commit",
    status: "active",
    confidence: "medium",
    updated: today(),
    based_on: commit,
    routes: files.join("|"),
    keywords: files.map((file) => path.basename(file)).join("|"),
  });

  const journalDir = path.join(root, "journal");
  mkdirSync(journalDir, { recursive: true });
  const journalFile = path.join(journalDir, `${today()}.md`);
  appendFileSync(journalFile, `\n## Archivist ${commit.slice(0, 12)} — ${path.basename(cwd)}\n\n${summary.trim()}\n\nEvidence: [[${path.basename(evidenceFile, ".md")}]]\n`);

  if (hasDocsImpact(files)) {
    appendInboxNote(cfg, cwd, "Archivist docs follow-up", `Commit ${commit.slice(0, 12)} may require repo-local documentation review. See ${evidenceFile}.`);
  }

  return { evidenceFile, journalFile };
}

const ingestSchema = Type.Object({
  commit: Type.Optional(Type.String({ description: "Commit-ish to ingest, default HEAD" })),
  recentCommitCount: Type.Optional(Type.Number({ description: "Number of recent commits to include for intent/context" })),
  dryRun: Type.Optional(Type.Boolean({ description: "Analyze without writing Obsidian/project memory" })),
});
type IngestParams = Static<typeof ingestSchema>;

const preserveSchema = Type.Object({
  refId: Type.String(),
  type: Type.String(),
  title: Type.String(),
  summary: Type.String(),
  importance: Type.String(),
  tags: Type.Array(Type.String()),
  storage: Type.Optional(Type.String()),
});
type PreserveParams = Static<typeof preserveSchema>;
const distillSchema = Type.Object({
  trigger: Type.String(),
  task: Type.String(),
  outcome: Type.String(),
  context: Type.Optional(Type.String()),
  domain: Type.Optional(Type.String()),
  targetPath: Type.Optional(Type.String()),
});
type DistillParams = Static<typeof distillSchema>;
const runAutomationSchema = Type.Object({
  name: Type.String({ description: "Automation name or command from package.json/scripts" }),
  dryRun: Type.Optional(Type.Boolean({ description: "Only show the resolved automation command" })),
});
type RunAutomationParams = Static<typeof runAutomationSchema>;

export default function (pi: ExtensionAPI) {
  let state: ArchivistState = createArchivistState();

  pi.on("agent_end", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) return;
    const raw = stringifyForAutoMemory(event.messages ?? ctx.sessionManager.getEntries().slice(-12));
    const result = writeAutoMemoryArtifact(state.autoMemory, autoMemoryConfig(cfg, ctx.cwd), "agent_end", raw);
    if (result.written && result.candidates.length && ctx.hasUI) ctx.ui.setStatus("archivist", `📚 memory: ${result.candidates.length} candidate(s)`);

    const automationCandidates = updateAutomationCandidates(state.automation, raw, 3, ctx.cwd);
    for (const candidate of automationCandidates) {
      appendInboxNote(cfg, ctx.cwd, "Automation candidate", `${candidate.markdown}\n\nPolicy source: Sherpa AUTOMATION.md, now maintained by Archivist.`);
    }
    if (automationCandidates.length && ctx.hasUI) ctx.ui.notify(`Archivist detected ${automationCandidates.length} automation candidate(s)`, "info");

    const outcome = classifyTaskOutcome(raw);
    const status = await gitChanged(ctx.cwd);
    const changedFiles = parseGitStatusFiles(status);
    const lifecycleHash = hashAutoMemory(`archivist-lifecycle\n${outcome.outcome}\n${changedFiles.sort().join("\n")}`);
    if (!state.lifecycleHashes.includes(lifecycleHash) && (changedFiles.length || outcome.outcome !== "unknown")) {
      const verification = suggestVerificationCommands(changedFiles);
      appendJournalNote(cfg, ctx.cwd, "Task lifecycle summary", [
        `Outcome: ${outcome.outcome}`,
        `Reason: ${outcome.reason}`,
        "",
        changedFiles.length ? "Changed files:" : "Changed files: none detected",
        ...changedFiles.slice(0, 30).map((file) => `- ${file}`),
        "",
        verification.commands.length ? "Suggested verification:" : "Suggested verification: none",
        ...verification.commands.map((item) => `- \`${item.command}\` — ${item.reason}`),
        verification.docsReview ? "- Documentation review recommended." : "- Documentation review not required by heuristic.",
        verification.routesReview ? "- routes.csv review recommended." : "- routes.csv review not required by heuristic.",
      ].join("\n"));
      state.lifecycleHashes = [...state.lifecycleHashes.slice(-49), lifecycleHash];
    }


    const audit = await auditDocumentationDrift(state, cfg, ctx.cwd);
    if (audit.needed) {
      if (ctx.hasUI) ctx.ui.notify("Archivist detected possible documentation drift", "warning");
      pi.sendMessage({ customType: "archivist-doc-audit", content: documentationAuditMessage(audit), display: true, details: audit }, { triggerTurn: true, deliverAs: "steer" });
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) return;
    const raw = stringifyForAutoMemory(event.compactionEntry ?? ctx.sessionManager.getEntries().slice(-20));
    writeAutoMemoryArtifact(state.autoMemory, autoMemoryConfig(cfg, ctx.cwd), "session_compact", raw);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) return;
    const raw = stringifyForAutoMemory({ reason: event.reason, recent: ctx.sessionManager.getEntries().slice(-20) });
    writeAutoMemoryArtifact(state.autoMemory, autoMemoryConfig(cfg, ctx.cwd), `session_shutdown:${event.reason}`, raw);
  });

  pi.registerTool({
    name: "archivist_ingest",
    label: "Archivist Ingest",
    description: "Analyze a git commit using Archivist's dedicated lower model and write durable memory using Sherpa's existing Obsidian/project-memory structure.",
    promptSnippet: "Analyze git commits and maintain Sherpa-compatible long-term memory/write-side documentation.",
    promptGuidelines: ["Use archivist_ingest when the user asks to archive, document, or preserve commit-derived project knowledge."],
    parameters: ingestSchema,
    async execute(_toolCallId, params: IngestParams, _signal, onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      if (!cfg.enabled) return { content: [{ type: "text", text: "Archivist is disabled." }], details: { enabled: false } };
      onUpdate?.({ content: [{ type: "text", text: "Archivist collecting git commit context…" }] });
      const commit = await collectCommit(ctx.cwd, params.commit || "HEAD", params.recentCommitCount || cfg.commitHook.recentCommitCount);
      onUpdate?.({ content: [{ type: "text", text: `Archivist analyzing ${commit.sha.slice(0, 12)} with ${cfg.model.provider}/${cfg.model.id}…` }] });
      const catalogRows = relevantCatalogRows(obsidianMemoryPath(cfg), [commit.message, commit.files.join("\n"), commit.recent].join("\n"));
      const summary = await modelSummary(ctx, cfg, { commit: commit.sha, message: commit.message, stats: commit.stats, diff: commit.diff, files: commit.files, recent: commit.recent, catalogRows });
      if (params.dryRun) return { content: [{ type: "text", text: summary }], details: { dryRun: true, commit: commit.sha, model: cfg.model } };
      const written = writeMemory(cfg, ctx.cwd, commit.sha, summary, commit.files);
      return { content: [{ type: "text", text: [`Archivist ingested ${commit.sha.slice(0, 12)}`, `Model: ${cfg.model.provider}/${cfg.model.id}`, `Evidence: ${written.evidenceFile}`, `Journal: ${written.journalFile}`].join("\n") }], details: { commit: commit.sha, ...written } };
    },
  });


  pi.registerTool({
    name: "archivist_preserve",
    label: "Archivist Preserve",
    description: "Evaluate a reflection for persistence value and write it through Archivist's Sherpa-compatible memory backend.",
    parameters: preserveSchema,
    async execute(_toolCallId, params: PreserveParams, _signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      const decision = evaluatePersistence({ type: params.type, title: params.title, summary: params.summary, importance: params.importance, tags: params.tags });
      if (decision.decision === "discard") {
        return { content: [{ type: "text", text: [`🚫 Discarded: "${params.title}"`, "", `Reason: ${decision.reason}`, `Confidence: ${decision.confidence}`].join("\n") }], details: { decision: "discard", reason: decision.reason, confidence: decision.confidence } };
      }
      const dest = params.storage && params.storage !== "auto" ? params.storage : decision.destination;
      if (dest === "none") return { content: [{ type: "text", text: `⏭ Skipped: "${params.title}" — not worth persisting` }], details: { decision: "discard", reason: decision.reason, refId: params.refId } };
      const syncResult = await syncReflectMemory(memoryPaths(cfg, ctx.cwd), { refId: params.refId, destination: dest });
      return { content: [{ type: "text", text: [`✅ Persisted: "${params.title}"`, "", `Destination: ${dest}`, `Confidence: ${decision.confidence}`, "", `Reason: ${decision.reason}`, "", syncResult].join("\n") }], details: { decision: "persist", destination: dest, refId: params.refId, confidence: decision.confidence } };
    },
  });

  pi.registerTool({
    name: "archivist_distill",
    label: "Archivist Distill",
    description: "Write distilled procedures/lessons into Sherpa-compatible Obsidian project memory.",
    parameters: distillSchema,
    async execute(_toolCallId, params: DistillParams, _signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      const distill = writeDistilledSkill({ trigger: params.trigger, task: params.task, outcome: params.outcome, context: params.context, domain: params.domain, targetPath: params.targetPath }, ctx.cwd, obsidianMemoryPath(cfg));
      appendCatalogRow(obsidianMemoryPath(cfg), {
        id: `procedure.${distill.slug}`,
        type: "procedure",
        path: path.relative(obsidianMemoryPath(cfg), distill.skillPath).replace(/\\/g, "/"),
        title: params.task.slice(0, 100),
        summary: params.outcome.slice(0, 180),
        aliases: distill.slug,
        tags: ["archivist", "distillation", params.domain ?? "general"].join("|"),
        status: "active",
        confidence: "medium",
        updated: today(),
        keywords: [params.task, params.domain ?? "general"].join("|"),
      });
      return { content: [{ type: "text", text: [`🧪 Distilled: ${params.task}`, "", `Skill: ${distill.skillPath}`, `Scope: ${distill.destination}`].join("\n") }], details: { slug: distill.slug, skillPath: distill.skillPath, destination: distill.destination } };
    },
  });

  pi.registerTool({
    name: "archivist_run_automation",
    label: "Archivist Run Automation",
    description: "Run a safe registered project automation from package.json or scripts/. Unsafe or approval-required automations are refused.",
    parameters: runAutomationSchema,
    async execute(_toolCallId, params: RunAutomationParams, _signal, _onUpdate, ctx) {
      const automation = findRunnableAutomation(ctx.cwd, params.name);
      if (!automation) {
        const available = discoverRunnableAutomations(ctx.cwd).filter((item) => item.safety === "safe").slice(0, 20).map((item) => `- ${formatRunnableAutomation(item, state.automation.runStats[item.name])}`).join("\n");
        return { content: [{ type: "text", text: `Automation not found: ${params.name}\n\nSafe automations:\n${available || "(none)"}` }], details: { found: false } };
      }
      if (automation.safety !== "safe") return { content: [{ type: "text", text: `Refused automation '${automation.name}' because safety=${automation.safety}. Ask the user to approve and run manually.` }], details: { found: true, automation } };
      if (params.dryRun) return { content: [{ type: "text", text: `Dry run: ${automation.command}` }], details: { found: true, automation, dryRun: true } };
      const start = Date.now();
      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-lc", automation.command], { cwd: automation.cwd, timeout: automation.timeoutMs ?? 120_000, maxBuffer: 1_000_000 });
        recordAutomationRun(state.automation, automation, "passed", Date.now() - start);
        return { content: [{ type: "text", text: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "Automation completed with no output" }], details: { found: true, automation, stats: state.automation.runStats[automation.name] } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordAutomationRun(state.automation, automation, "failed", Date.now() - start, message);
        return { content: [{ type: "text", text: `Automation failed: ${message}` }], details: { found: true, automation, stats: state.automation.runStats[automation.name] } };
      }
    },
  });

  pi.registerCommand("archivist:automations", { description: "List safe project automations Archivist can run", handler: async (_args, ctx) => {
    const automations = discoverRunnableAutomations(ctx.cwd);
    const lines = automations.map((automation) => `- ${formatRunnableAutomation(automation, state.automation.runStats[automation.name])}`).slice(0, 80);
    ctx.ui.notify(lines.length ? lines.join("\n") : "No project automations discovered", "info");
  }});

  pi.registerCommand("archivist:sync-reflect", { description: "Sync reflect captures into Archivist/Sherpa-compatible memory", handler: async (args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    try { ctx.ui.notify(await syncReflectMemory(memoryPaths(cfg, ctx.cwd), parseSyncArgs(args)), "success"); }
    catch (e: any) { ctx.ui.notify(`Archivist reflect sync failed: ${e.message ?? e}`, "error"); }
  }});

  pi.registerCommand("archivist:docs:audit", { description: "Audit whether changed code/config needs documentation updates", handler: async (_args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const audit = await auditDocumentationDrift(state, cfg, ctx.cwd);
    if (audit.needed) {
      ctx.ui.notify("Archivist detected possible documentation drift", "warning");
      pi.sendMessage({ customType: "archivist-doc-audit", content: documentationAuditMessage(audit), display: true, details: audit }, { triggerTurn: true, deliverAs: "steer" });
    } else ctx.ui.notify(`Archivist documentation audit: ${audit.reason}`, "info");
  }});

  pi.registerCommand("archivist:install-hook", { description: "Install an async git post-commit hook for Archivist", handler: async (_args, ctx) => {
    try {
      const gitDir = await git(ctx.cwd, ["rev-parse", "--git-dir"]);
      const hookPath = path.isAbsolute(gitDir) ? path.join(gitDir, "hooks", "post-commit") : path.join(ctx.cwd, gitDir, "hooks", "post-commit");
      const hookScript = path.join(path.dirname(__filename), "bin", "archivist-hook.mjs");
      mkdirSync(path.dirname(hookPath), { recursive: true });
      const block = [
        "#!/bin/sh",
        "# Installed by pi Archivist extension. Runs asynchronously and never blocks commits.",
        "if [ -n \"$ARCHIVIST_SKIP\" ]; then exit 0; fi",
        `ARCHIVIST_SKIP=1 node ${JSON.stringify(hookScript)} --repo \"$(git rev-parse --show-toplevel)\" --commit HEAD >> \"$(git rev-parse --git-dir)/archivist.log\" 2>&1 &`,
        "exit 0",
        "",
      ].join("\n");
      writeFileSync(hookPath, block);
      chmodSync(hookPath, 0o755);
      ctx.ui.notify(`Archivist post-commit hook installed: ${hookPath}`, "success");
    } catch (e: any) {
      ctx.ui.notify(`Archivist hook install failed: ${e.message ?? e}`, "error");
    }
  }});

  pi.registerCommand("archivist:status", { description: "Show Archivist config and hook status", handler: async (_args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    let hook = "unknown";
    try {
      const gitDir = await git(ctx.cwd, ["rev-parse", "--git-dir"]);
      const hookPath = path.isAbsolute(gitDir) ? path.join(gitDir, "hooks", "post-commit") : path.join(ctx.cwd, gitDir, "hooks", "post-commit");
      hook = existsSync(hookPath) && readFileSync(hookPath, "utf8").includes("archivist-hook.mjs") ? `installed (${hookPath})` : `not installed (${hookPath})`;
    } catch { hook = "not a git repo"; }
    ctx.ui.notify([`Archivist: ${cfg.enabled ? "enabled" : "disabled"}`, `Model: ${cfg.model.provider}/${cfg.model.id} (dedicated; main Pi model is not used)`, `Memory: ${obsidianMemoryPath(cfg)}`, `Hook: ${hook}`].join("\n"), "info");
  }});
}
