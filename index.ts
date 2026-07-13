import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync, readdirSync, statSync, copyFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createAutoMemoryState, hashAutoMemory, stringifyForAutoMemory, type AutoMemoryState } from "../pi-sherpa/lib/auto-memory";
import { DEFAULT_ARCHIVIST_CONFIG, loadConfig, obsidianMemoryPath, type ArchivistConfig } from "./lib/config";
import { appendDocumentationJobLog, documentationJobLogPath } from "./lib/job-log";
import { archivistMemoryApiConfig, archivistMemoryStore, ingestObsidianDocumentToMemoryApi, memoryApiGet, recordMemoryIngestFailure, triggerObsidianDocumentIngest, triggerObsidianDocumentsFromSyncResult, type MemoryApiStore, type MemoryArtifact, type RetrievalFeedbackRecord } from "./lib/memory-api";
import { formatFrontmatter, titleFromMarkdown } from "./lib/markdown-note";
import { modelSessionAnalysis, writeSessionFindings } from "./lib/session-analysis";
import { prepareDocumentChunks, requestEmbeddings, splitTextChunks } from "./lib/document-chunks";
import { parseGitStatusFiles, parseReflectSyncArgs } from "../pi-sherpa/lib/common";

import { createAutomationState, discoverRunnableAutomations, findRunnableAutomation, formatRunnableAutomation, recordAutomationRun, updateAutomationCandidates, type AutomationState } from "../pi-sherpa/lib/automation";
import { evaluatePersistence } from "../pi-sherpa/lib/preserve";
import { syncReflectMemory } from "../pi-sherpa/lib/memory";
import { writeDistilledSkill } from "./lib/distillation";
import { auditCatalog, catalogMatches, readProjectCatalog, resolveCatalogPath, upsertCatalogRow } from "../pi-sherpa/lib/catalog";
import type { CatalogRow } from "../pi-sherpa/lib/catalog";

const execFileAsync = promisify(execFile);
const TECH_DOC_WRITER_SKILL_PATH = "/Users/kamil/Development/_DESERT_BACON/ClearStack/.claude/skills/technical-docs-writer/SKILL.md";

type DocumentationModelRuntime = { modelRegistry: ExtensionContext["modelRegistry"]; signal: AbortSignal };
function summarizeFeedbackForReview(feedback: RetrievalFeedbackRecord[]) {
  const missing = new Map<string, number>();
  const noisy = new Map<string, number>();
  const queries: string[] = [];
  for (const item of feedback) {
    if (item.query && queries.length < 8 && !queries.includes(item.query)) queries.push(item.query);
    for (const miss of item.missing ?? []) missing.set(miss, (missing.get(miss) ?? 0) + 1);
    for (const id of item.unusedIds ?? []) noisy.set(id, (noisy.get(id) ?? 0) + 1);
  }
  const top = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { queries, missing: top(missing), noisy: top(noisy) };
}

async function writeFeedbackReviewToMemoryApi(store: MemoryApiStore, cfg: ArchivistConfig, cwd: string, feedback: RetrievalFeedbackRecord[], inboxPath: string) {
  const summary = summarizeFeedbackForReview(feedback);
  const now = nowIso();
  const project = path.basename(cwd);
  const reviewId = stableMemoryId("feedback-review", `${today()}\n${JSON.stringify(summary)}`);
  const text = feedbackReviewMarkdown(feedback);
  await store.writeArtifact({
    id: reviewId,
    scope: "project",
    project,
    type: "inbox",
    title: "memory API retrieval feedback graph review",
    summary: `Review candidate from ${feedback.length} Sherpa retrieval feedback records.`,
    text,
    sourcePath: path.relative(cwd, inboxPath).replace(/\\/g, "/"),
    confidence: "medium",
    status: "needs-review",
    tags: ["archivist", "memory-api", "feedback", "needs-review"],
    aliases: ["memory API feedback review", "graph memory feedback"],
    keywords: ["feedback", "missing context", "noisy artifacts", "graph review"],
    createdAt: now,
    updatedAt: now,
  }).catch(() => console.warn("[archivist] write failed"));

  for (const [missingPath] of summary.missing.slice(0, 12)) {
    const fileId = sourceFileArtifactId(missingPath);
    await store.writeArtifact({
      id: fileId,
      scope: "project",
      project,
      type: "source-file",
      title: missingPath,
      summary: `Source-file candidate repeatedly missed by Sherpa retrieval feedback: ${missingPath}`,
      text: missingPath,
      sourcePath: `repo://${missingPath}`,
      confidence: "low",
      status: "needs-review",
      tags: ["source-file", "feedback", "needs-review"],
      aliases: [missingPath, path.basename(missingPath)],
      routes: [missingPath],
      keywords: [missingPath, path.basename(missingPath)],
      createdAt: now,
      updatedAt: now,
    }).catch(() => console.warn("[archivist] write failed"));
    await store.writeRelation({ from: reviewId, relation: "related", to: fileId, confidence: "low", source: inboxPath, createdAt: now }).catch(() => console.warn("[archivist] relation write failed"));
  }

  for (const [noisyId] of summary.noisy.slice(0, 12)) {
    await store.writeRelation({ from: reviewId, relation: "related", to: noisyId, confidence: "low", source: inboxPath, createdAt: now }).catch(() => console.warn("[archivist] relation write failed"));
  }
}

function feedbackReviewMarkdown(feedback: RetrievalFeedbackRecord[]) {
  const summary = summarizeFeedbackForReview(feedback);
  return [
    "Sherpa retrieval feedback indicates possible memory graph maintenance opportunities.",
    "Archivist should treat these as review candidates, not automatic current-truth updates.",
    "",
    `Feedback records reviewed: ${feedback.length}`,
    "",
    "## Repeated missing context",
    ...(summary.missing.length ? summary.missing.map(([item, count]) => `- ${item} (${count}x)`) : ["- none"]),
    "",
    "## Repeated noisy/unused memory API artifacts",
    ...(summary.noisy.length ? summary.noisy.map(([item, count]) => `- ${item} (${count}x)`) : ["- none"]),
    "",
    "## Example queries",
    ...(summary.queries.length ? summary.queries.map((query) => `- ${query}`) : ["- none"]),
    "",
    "## Suggested review actions",
    "- Add aliases/routes for repeated missing paths only when supported by source evidence.",
    "- Add or strengthen graph relations only when a source-grounded bridge exists.",
    "- Mark repeatedly noisy artifacts or edges as needs-review rather than deleting evidence.",
  ].join("\n");
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
  triggerObsidianDocumentIngest(cfg, cwd, target);
  return target;
}

function appendJournalNote(cfg: ArchivistConfig, cwd: string, title: string, text: string) {
  const target = path.join(obsidianMemoryPath(cfg), "journal", `${today()}.md`);
  mkdirSync(path.dirname(target), { recursive: true });
  appendFileSync(target, `\n## ${title} — ${path.basename(cwd)}\n\n${text.trim()}\n`);
  triggerObsidianDocumentIngest(cfg, cwd, target);
  return target;
}

function autoMemoryConfig(cfg: ArchivistConfig, cwd: string) {
  return {
    cwd,
    obsidianVault: cfg.memory.obsidianVault,
    obsidianMemoryPath: obsidianMemoryPath(cfg),
    // Keep scratchpad ownership in Sherpa. Archivist redirects review candidates
    // to durable Obsidian journal (chronological record) instead of inbox.
    appendScratchpadCandidate: (text: string, title?: string) => { appendJournalNote(cfg, cwd, title || "Archivist candidate", text); },
  };
}

async function gitChanged(cwd: string) {
  try { return await git(cwd, ["status", "--short"]); } catch { return ""; }
}

function parsePorcelainStatusFiles(status: string): string[] {
  const files: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^(.{2})\s+(.*)$/);
    if (!match) continue;
    const raw = match[2]?.trim() ?? "";
    const file = (raw.includes(" -> ") ? raw.split(" -> ").pop()!.trim() : raw).replace(/^"|"$/g, "");
    if (file) files.push(file);
  }
  return [...new Set(files)];
}

async function gitChangedFiles(cwd: string) {
  try { return parsePorcelainStatusFiles(await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])); }
  catch { return parseGitStatusFiles(await gitChanged(cwd)); }
}

const DOC_DRIFT_DEDUP_FILE = ".pi-memory/archivist-doc-drift-dedup.jsonl";

function docDriftDedupPath(cwd: string) {
  return path.join(cwd, DOC_DRIFT_DEDUP_FILE);
}

function hasSeenDocDriftAudit(cwd: string, fingerprint: string) {
  const target = docDriftDedupPath(cwd);
  if (!existsSync(target)) return false;
  const lines = readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean).slice(-200);
  return lines.some((line) => {
    try { return JSON.parse(line).fingerprint === fingerprint; }
    catch { return false; }
  });
}

function recordDocDriftAudit(cwd: string, fingerprint: string, result: string) {
  const target = docDriftDedupPath(cwd);
  mkdirSync(path.dirname(target), { recursive: true });
  appendFileSync(target, `${JSON.stringify({ at: nowIso(), fingerprint, result })}\n`);
}

/**
 * Model-based documentation drift audit.
 *
 * Replaces regex heuristics (isSourcePath, isDocumentationPath,
 * findDocumentationCandidates) with the Archivist model reading the
 * actual changed files and diffs to decide if documentation needs updating.
 */
function documentationAuditFingerprint(files: string[], diff: string) {
  const sortedFiles = [...files].sort();
  return createHash("sha256").update(`${sortedFiles.join("\n")}\n---diff---\n${diff}`).digest("hex");
}

function rememberDocAuditHash(state: ArchivistState, hash: string) {
  state.autoMemory.docAuditHashes = [...state.autoMemory.docAuditHashes.slice(-49), hash];
}

function documentationAuditPrompt() {
  return [
    "You are Archivist, a documentation maintenance agent.",
    "Analyze the changed files and their diffs. Decide if repo-local documentation needs updating.",
    "",
    "Return ONLY JSON in this exact shape:",
    '{"needsUpdate": true|false, "reason": "brief explanation", "candidateDocs": ["relative/path/to/doc.md"] }',
    "",
    "Rules:",
    "- needsUpdate=true when code/config changes alter behavior, API, usage, or architecture that is documented",
    "- needsUpdate=false when changes are internal-only, tests, formatting, or clearly don't affect user-facing docs",
    "- candidateDocs should list documentation files that likely need review (max 5); use repo-relative paths only, never absolute paths or ../ traversal",
    "- If no docs exist yet and behavior changed significantly, set needsUpdate=true with empty candidateDocs",
  ].join("\n");
}

function documentationAuditSnippets(cwd: string) {
  const docSnippets: string[] = [];
  for (const rel of ["README.md", "AGENTS.md", "CHANGELOG.md", "docs/README.md"]) {
    const p = path.join(cwd, rel);
    if (existsSync(p)) docSnippets.push(`--- ${rel} ---\n${readFileSync(p, "utf8").slice(0, 4000)}`);
  }
  if (!existsSync(path.join(cwd, "docs"))) return docSnippets;
  for (const name of readdirSync(path.join(cwd, "docs")).slice(0, 30)) {
    if (!/\.(md|mdx|rst)$/i.test(name)) continue;
    const p = path.join(cwd, "docs", name);
    docSnippets.push(`--- docs/${name} ---\n${readFileSync(p, "utf8").slice(0, 3000)}`);
  }
  return docSnippets;
}

function parseDocumentationAuditResponse(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)) as { needsUpdate?: boolean; reason?: string; candidateDocs?: string[] }; }
  catch { return undefined; }
}

async function modelDocumentationDriftDecision(
  cfg: ArchivistConfig,
  cwd: string,
  runtime: { modelRegistry: ExtensionContext["modelRegistry"]; signal: AbortSignal },
  files: string[],
) {
  if (cfg.model.heuristicOnly) return undefined;
  const model = runtime.modelRegistry.find(cfg.model.provider, cfg.model.id);
  if (!model) return undefined;
  const auth = await runtime.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;

  const diff = await git(cwd, ["diff", "--", ...files]).catch(() => "");
  const docSnippets = documentationAuditSnippets(cwd);
  const message: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: [
      `Changed files:\n${files.join("\n")}`,
      `\nDiff excerpt:\n${diff.slice(0, 20000)}`,
      docSnippets.length ? `\nExisting docs:\n${docSnippets.join("\n\n")}` : "\nNo existing documentation found.",
    ].join("\n\n") }],
  };
  const response = await complete(model, { systemPrompt: documentationAuditPrompt(), messages: [message] }, { apiKey: auth.apiKey, headers: auth.headers, signal: runtime.signal });
  if (response.stopReason === "aborted") return undefined;
  const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n").trim();
  return parseDocumentationAuditResponse(text);
}

async function auditDocumentationDrift(
  state: ArchivistState,
  cfg: ArchivistConfig,
  cwd: string,
  runtime: { modelRegistry: ExtensionContext["modelRegistry"]; signal: AbortSignal },
  changedFilesOverride?: string[],
) {
  const files = changedFilesOverride ?? await gitChangedFiles(cwd);
  if (!files.length) return { needed: false, reason: "no changes" };

  const fingerprintDiff = await git(cwd, ["diff", "--", ...[...files].sort()]).catch(() => "");
  const persistentFingerprint = documentationAuditFingerprint(files, fingerprintDiff);
  const hash = hashAutoMemory(`archivist-doc-audit\n${persistentFingerprint}`);
  if (state.autoMemory.docAuditHashes.includes(hash)) return { needed: false, reason: "already audited", changedSources: files };
  if (hasSeenDocDriftAudit(cwd, persistentFingerprint)) return { needed: false, reason: "identical documentation drift already evaluated", changedSources: files };

  const parsed = await modelDocumentationDriftDecision(cfg, cwd, runtime, files);
  if (parsed && !parsed.needsUpdate) {
    rememberDocAuditHash(state, hash);
    recordDocDriftAudit(cwd, persistentFingerprint, "no_update");
    return { needed: false, reason: parsed.reason || "model decided no update needed", changedSources: files };
  }

  rememberDocAuditHash(state, hash);
  recordDocDriftAudit(cwd, persistentFingerprint, "needs_update");
  return { needed: true, hash, changedSources: files, candidates: safeExistingDocCandidates(cwd, parsed?.candidateDocs).slice(0, 8) };
}
function documentationAuditMessage(audit: { changedSources?: string[]; candidates?: string[] }) {
  const sources = audit.changedSources ?? [];
  const docs = audit.candidates ?? [];
  return [
    "## Archivist Documentation Audit",
    "",
    "Archivist detected code/config changes without accompanying documentation updates.",
    "Archivist will handle the documentation maintenance path using its dedicated model; the main agent should not edit repo docs for this audit.",
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

function documentationMaintenanceReport(handled: { handled?: boolean; applied?: string[]; failures?: string[]; result?: DocumentationMaintenanceResult }) {
  const applied = [...new Set(handled.applied ?? [])];
  const failures = handled.failures ?? [];
  const decision = handled.result?.decision ?? "handoff";
  return [
    "## Archivist Documentation Maintenance Complete",
    "",
    `Decision: ${decision}`,
    `Summary: ${handled.result?.summary ?? "(none)"}`,
    "",
    "### Updated documentation",
    ...(applied.length ? applied.map((file) => `- ${file}`) : ["- None"]),
    "",
    "### Skipped/failed updates",
    ...(failures.length ? failures.map((failure) => `- ${failure}`) : ["- None"]),
    "",
    handled.handled
      ? "Archivist completed documentation maintenance asynchronously using its dedicated model."
      : "Archivist could not safely apply documentation changes automatically; a handoff was written to the Archivist inbox.",
  ].join("\n");
}

type DocumentationUpdate = {
  path?: string;
  oldText?: string;
  newText?: string;
  reason?: string;
};

type DocumentationMaintenanceResult = {
  decision?: "updated" | "no_update" | "handoff";
  summary?: string;
  updates?: DocumentationUpdate[];
  handoff?: string;
};

function parseJsonCandidate(candidate: string): any | undefined {
  const sanitized = candidate.trim().replace(/^\uFEFF/, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (!sanitized) return undefined;
  try { return JSON.parse(sanitized); } catch { return undefined; }
}

function balancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function extractJsonObject(text: string): any | undefined {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1] ?? "");
  candidates.push(text);

  for (const candidate of candidates) {
    const direct = parseJsonCandidate(candidate);
    if (direct) return direct;
    for (const object of balancedJsonObjects(candidate)) {
      const parsed = parseJsonCandidate(object);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

function safeRepoRelativePath(cwd: string, candidate: string): string | undefined {
  if (!candidate || path.isAbsolute(candidate)) return undefined;
  const resolved = path.resolve(cwd, candidate);
  const rel = path.relative(cwd, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.replace(/\\/g, "/");
}

function safeExistingDocCandidates(cwd: string, candidates: string[] = []): string[] {
  return [...new Set(candidates
    .map((candidate) => safeRepoRelativePath(cwd, candidate))
    .filter((candidate): candidate is string => !!candidate && existsSync(path.join(cwd, candidate))))];
}

async function documentationMaintenanceModelAuth(runtime: DocumentationModelRuntime, cfg: ArchivistConfig, audit: { changedSources?: string[]; candidates?: string[] }) {
  if (cfg.model.heuristicOnly) return { error: { decision: "handoff" as const, summary: "Archivist model is configured as heuristic-only.", handoff: documentationAuditMessage(audit) } };
  const model = runtime.modelRegistry.find(cfg.model.provider, cfg.model.id);
  if (!model) return { error: { decision: "handoff" as const, summary: `Archivist model not found: ${cfg.model.provider}/${cfg.model.id}`, handoff: documentationAuditMessage(audit) } };
  const auth = await runtime.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return { error: { decision: "handoff" as const, summary: auth.ok ? `No API key for ${model.provider}` : auth.error, handoff: documentationAuditMessage(audit) } };
  return { model, auth };
}

function documentationMaintenancePrompt() {
  return [
    "You are Archivist, Sherpa's write-side documentation maintenance agent.",
    "Use the dedicated Archivist model only; do not delegate repo documentation decisions to the main coding agent.",
    "Decide whether the changed source/config files require repo-local documentation updates.",
    "If a small, source-grounded update is needed, return exact text replacements for existing documentation files.",
    "If substantial prose/API/architecture documentation is needed, do not author it; return a technical-doc-writer handoff instead.",
    "If no repo documentation update is warranted, return no_update with a brief reason.",
    "Return ONLY strict JSON matching this shape, with no markdown fences or commentary:",
    '{ "decision": "updated|no_update|handoff", "summary": "...", "updates": [{ "path": "docs/file.md", "oldText": "exact existing text", "newText": "replacement text", "reason": "..." }], "handoff": "optional markdown" }',
    "Rules: update only files included in Candidate docs; oldText must be copied exactly from provided doc content; keep changes minimal and factual; escape newlines inside JSON strings as \\n.",
  ].join("\n");
}

function documentationMaintenanceRepairPrompt() {
  return [
    "You repair invalid JSON for Archivist documentation maintenance.",
    "Return ONLY strict valid JSON matching this shape:",
    '{ "decision": "updated|no_update|handoff", "summary": "...", "updates": [{ "path": "docs/file.md", "oldText": "exact existing text", "newText": "replacement text", "reason": "..." }], "handoff": "optional markdown" }',
    "Do not add markdown fences or commentary. Escape newlines inside JSON strings as \\n. If the previous output cannot be safely repaired, return a handoff decision with a brief summary.",
  ].join("\n");
}

function documentationMaintenanceMessage(changedSources: string[], candidates: string[], diff: string, docs: string): UserMessage {
  return {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: [
      `Changed source/config files:\n${changedSources.join("\n")}`,
      `Candidate docs:\n${candidates.join("\n") || "(none)"}`,
      `Source diff:\n${diff.slice(0, 30000)}`,
      `Current candidate doc excerpts:\n${docs || "(none)"}`,
    ].join("\n\n") }],
  };
}

function textFromModelResponse(response: Awaited<ReturnType<typeof complete>>) {
  return response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n").trim();
}

async function repairDocumentationMaintenanceJson(runtime: DocumentationModelRuntime, auth: { apiKey: string; headers?: Record<string, string> }, model: any, text: string) {
  const repairMessage: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: `Previous invalid output:\n${text.slice(0, 8000)}` }],
  };
  const repair = await complete(model, { systemPrompt: documentationMaintenanceRepairPrompt(), messages: [repairMessage] }, { apiKey: auth.apiKey, headers: auth.headers, signal: runtime.signal });
  if (repair.stopReason === "aborted") return undefined;
  const repairedText = textFromModelResponse(repair);
  const repaired = extractJsonObject(repairedText) as DocumentationMaintenanceResult | undefined;
  return repaired ? { ...repaired, summary: repaired.summary ? `${repaired.summary} (JSON repaired after invalid first response.)` : "JSON repaired after invalid first response." } : undefined;
}

async function modelDocumentationMaintenance(runtime: DocumentationModelRuntime, cfg: ArchivistConfig, cwd: string, audit: { changedSources?: string[]; candidates?: string[] }): Promise<DocumentationMaintenanceResult> {
  const ready = await documentationMaintenanceModelAuth(runtime, cfg, audit);
  if (ready.error) return ready.error;

  const changedSources = audit.changedSources ?? [];
  const candidates = safeExistingDocCandidates(cwd, audit.candidates).slice(0, 8);
  const diff = await git(cwd, ["diff", "--", ...changedSources]).catch(() => "");
  const docs = candidates.map((file) => `--- DOC ${file} ---\n${readFileSync(path.join(cwd, file), "utf8").slice(0, 18000)}`).join("\n\n");
  const message = documentationMaintenanceMessage(changedSources, candidates, diff, docs);
  const response = await complete(ready.model, { systemPrompt: documentationMaintenancePrompt(), messages: [message] }, { apiKey: ready.auth.apiKey, headers: ready.auth.headers, signal: runtime.signal });
  if (response.stopReason === "aborted") return { decision: "handoff", summary: "Archivist model call aborted.", handoff: documentationAuditMessage(audit) };

  const text = textFromModelResponse(response);
  const parsed = extractJsonObject(text) as DocumentationMaintenanceResult | undefined;
  if (parsed) return parsed;
  const repaired = await repairDocumentationMaintenanceJson(runtime, ready.auth, ready.model, text);
  if (repaired) return repaired;
  return { decision: "handoff", summary: "Archivist model returned unparsable documentation maintenance output after one repair attempt.", handoff: `${documentationAuditMessage(audit)}\n\nRaw model output:\n\n${text.slice(0, 4000)}` };
}

function startDocumentationMaintenanceJob(cfg: ArchivistConfig, cwd: string, audit: { changedSources?: string[]; candidates?: string[] }) {
  const jobId = stableMemoryId("doc-job", `${nowIso()}\n${audit.changedSources?.join("\n") ?? ""}\n${audit.candidates?.join("\n") ?? ""}`);
  appendDocumentationJobLog(cfg, cwd, {
    jobId,
    kind: "documentation-maintenance",
    status: "started",
    trigger: "documentation-drift",
    changedSources: audit.changedSources ?? [],
    candidateDocs: audit.candidates ?? [],
    model: `${cfg.model.provider}/${cfg.model.id}`,
  });
  return jobId;
}

function applyDocumentationUpdates(cwd: string, result: DocumentationMaintenanceResult, allowedDocs: Set<string>) {
  const applied: string[] = [];
  const failures: string[] = [];
  if (result.decision !== "updated") return { applied, failures };

  for (const update of result.updates ?? []) {
    if (!update.path || !update.oldText || update.newText === undefined) continue;
    const safeUpdatePath = safeRepoRelativePath(cwd, update.path);
    if (!safeUpdatePath || !allowedDocs.has(safeUpdatePath)) {
      failures.push(`${update.path}: not in Archivist candidate docs`);
      continue;
    }
    const target = path.join(cwd, safeUpdatePath);
    if (!existsSync(target)) {
      failures.push(`${update.path}: file does not exist`);
      continue;
    }
    const current = readFileSync(target, "utf8");
    const count = current.split(update.oldText).length - 1;
    if (count !== 1) {
      failures.push(`${update.path}: oldText matched ${count} times`);
      continue;
    }
    writeFileSync(target, current.replace(update.oldText, update.newText));
    applied.push(safeUpdatePath);
  }
  return { applied, failures };
}

function finishAppliedDocumentationUpdates(cfg: ArchivistConfig, cwd: string, jobId: string, result: DocumentationMaintenanceResult, applied: string[], failures: string[]) {
  appendJournalNote(cfg, cwd, "Documentation drift handled", [`Archivist applied documentation updates with ${cfg.model.provider}/${cfg.model.id}.`, `Summary: ${result.summary ?? "(none)"}`, "", "Updated docs:", ...[...new Set(applied)].map((file) => `- ${file}`), failures.length ? "" : undefined, failures.length ? "Skipped/failed updates:" : undefined, ...failures.map((failure) => `- ${failure}`)].filter(Boolean).join("\n"));
  appendDocumentationJobLog(cfg, cwd, { jobId, kind: "documentation-maintenance", status: "completed", decision: result.decision, summary: result.summary ?? "", applied: [...new Set(applied)], failures });
}

function finishDocumentationHandoff(cfg: ArchivistConfig, cwd: string, jobId: string, audit: { changedSources?: string[]; candidates?: string[] }, result: DocumentationMaintenanceResult, failures: string[]) {
  const note = [result.handoff || documentationAuditMessage(audit), failures.length ? "\nSkipped/failed updates:" : "", ...failures.map((failure) => `- ${failure}`)].join("\n");
  const inboxNote = appendInboxNote(cfg, cwd, "Documentation drift technical-doc-writer handoff", note);
  appendDocumentationJobLog(cfg, cwd, { jobId, kind: "documentation-maintenance", status: "handoff", decision: result.decision ?? "handoff", summary: result.summary ?? "", handoff: inboxNote, applied: [], failures });
}

async function completeDocumentationDrift(runtime: DocumentationModelRuntime, cfg: ArchivistConfig, cwd: string, audit: { changedSources?: string[]; candidates?: string[] }) {
  const jobId = startDocumentationMaintenanceJob(cfg, cwd, audit);
  try {
    const result = await modelDocumentationMaintenance(runtime, cfg, cwd, audit);
    const allowedDocs = new Set(safeExistingDocCandidates(cwd, audit.candidates));
    const { applied, failures } = applyDocumentationUpdates(cwd, result, allowedDocs);

    if (applied.length) {
      finishAppliedDocumentationUpdates(cfg, cwd, jobId, result, applied, failures);
      return { handled: true, applied, failures, result };
    }

    if (result.decision === "no_update") {
      // Do not write durable memory for no-op documentation reviews. These are
      // operationally useful in the moment but usually become journal noise.
      appendDocumentationJobLog(cfg, cwd, { jobId, kind: "documentation-maintenance", status: "completed", decision: result.decision, summary: result.summary ?? "", applied: [], failures });
      return { handled: true, applied, failures, result };
    }

    finishDocumentationHandoff(cfg, cwd, jobId, audit, result, failures);
    return { handled: false, applied, failures, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendDocumentationJobLog(cfg, cwd, { jobId, kind: "documentation-maintenance", status: "failed", error: message });
    throw error;
  }
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

function normalizeCatalogPathForCompare(value: string) {
  return value.replace(/^repo:\/\//, "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function catalogCoversPath(cwd: string, targetRel: string) {
  const normalizedTarget = normalizeCatalogPathForCompare(targetRel);
  for (const row of readProjectCatalog(cwd)) {
    const rowPath = normalizeCatalogPathForCompare(row.path ?? "");
    if (!rowPath) continue;
    try {
      const resolved = resolveCatalogPath(cwd, row.path);
      if (existsSync(resolved) && statSync(resolved).isDirectory()) {
        const relDir = normalizeCatalogPathForCompare(path.relative(cwd, resolved));
        if (normalizedTarget === relDir || normalizedTarget.startsWith(`${relDir}/`)) return true;
      }
    } catch { /* ignore broken catalog rows */ }
    if (normalizedTarget === rowPath) return true;
  }
  return false;
}

function graphifySourceCandidates(node: any) {
  return [node?.path, node?.file, node?.source, node?.source_path, node?.file_path, node?.filepath, node?.uri, node?.id];
}

function validGraphifySourceCandidate(value: string) {
  if (/^https?:\/\//i.test(value)) return false;
  return /\.(md|mdx|txt|rst|py|ts|tsx|js|jsx|json|yaml|yml|toml|csv|pdf)$/i.test(value) || value.includes("/");
}

function extractGraphifySourcePath(node: any): string | undefined {
  for (const raw of graphifySourceCandidates(node)) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = raw.trim();
    if (validGraphifySourceCandidate(value)) return value;
  }
  return undefined;
}

function graphifyTargetRoot(cwd: string, targetArg?: string) {
  const target = targetArg?.trim();
  if (!target) return cwd;
  return path.isAbsolute(target) ? target : path.join(cwd, target);
}

function graphifyGraphParts(graph: any) {
  return {
    nodes: Array.isArray(graph?.nodes) ? graph.nodes : Array.isArray(graph) ? graph : [],
    edges: Array.isArray(graph?.edges) ? graph.edges : Array.isArray(graph?.links) ? graph.links : [],
  };
}

function graphifySourceCounts(cwd: string, targetRoot: string, nodes: any[]) {
  const sourceCounts = new Map<string, number>();
  for (const node of nodes) {
    const source = extractGraphifySourcePath(node);
    if (!source) continue;
    const abs = path.isAbsolute(source) ? source : path.resolve(targetRoot, source.replace(/^repo:\/\//, ""));
    const rel = normalizeCatalogPathForCompare(path.relative(cwd, abs));
    if (rel && !rel.startsWith("..")) sourceCounts.set(rel, (sourceCounts.get(rel) ?? 0) + 1);
  }
  return sourceCounts;
}

function graphifySuggestedDirectoryRows(cwd: string, sourceCounts: Map<string, number>) {
  const dirCounts = new Map<string, number>();
  for (const rel of sourceCounts.keys()) {
    const dir = normalizeCatalogPathForCompare(path.dirname(rel));
    if (dir && dir !== ".") dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }
  return [...dirCounts.entries()]
    .filter(([dir, count]) => count >= 3 && !catalogCoversPath(cwd, dir))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([dir, fileCount]) => ({ dir, fileCount }));
}

function graphifyHotFiles(cwd: string, sourceCounts: Map<string, number>) {
  return [...sourceCounts.entries()]
    .filter(([rel]) => !catalogCoversPath(cwd, rel) && /(^|\/)(readme|index)\.(md|mdx|txt|rst)$/i.test(rel))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([file, nodeCount]) => ({ file, nodeCount }));
}

function auditGraphifyOutput(cwd: string, targetArg?: string) {
  const targetRoot = graphifyTargetRoot(cwd, targetArg);
  const outDir = path.join(targetRoot, "graphify-out");
  const graphPath = path.join(outDir, "graph.json");
  const reportPath = path.join(outDir, "GRAPH_REPORT.md");
  if (!existsSync(graphPath)) return { ok: false as const, targetRoot, outDir, graphPath, reportPath, reason: "graphify-out/graph.json not found" };

  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  const { nodes, edges } = graphifyGraphParts(graph);
  const sourceCounts = graphifySourceCounts(cwd, targetRoot, nodes);
  const suggestedDirectoryRows = graphifySuggestedDirectoryRows(cwd, sourceCounts);
  const hotFiles = graphifyHotFiles(cwd, sourceCounts);

  return { ok: true as const, targetRoot, outDir, graphPath, reportPath, nodes: nodes.length, edges: edges.length, sourceFiles: sourceCounts.size, suggestedDirectoryRows, hotFiles };
}

function today() { return new Date().toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }
function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `commit-${Date.now()}`;
}

function heuristicSummary(input: { commit: string; message: string; stats: string; files: string[]; recent: string; catalogRows?: CatalogRow[] }) {
  return [
    `# Commit ${input.commit.slice(0, 12)}`,
    "",
    `Commit message: ${input.message || "(none)"}`,
    "",
    `Changed files: ${input.files.length ? input.files.join(", ") : "unknown"}`,
    "",
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
    "Apply an information-purity gate: do not create durable memory for formatting-only changes, generated files, lockfile churn, no-op/config noise, transient fixes with no reusable lesson, or commits that do not teach future agents anything meaningful.",
    `When substantial repo-local prose/API/guide/architecture documentation is needed, do not write it yourself; recommend using the technical doc writer skill at ${TECH_DOC_WRITER_SKILL_PATH}.`,
    "If there is no durable knowledge worth preserving, return exactly: NO_DURABLE_FINDINGS.",
    "Otherwise return concise Markdown with sections: Summary, Intent Across Recent Commits, System Knowledge, Documentation Impact, Repo Docs Follow-up, Evidence. Be conservative; do not overclaim.",
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
  const text = normalizeModelMarkdown(response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n"));
  return text || heuristicSummary(input);
}

async function collectCommit(cwd: string, commit: string, recentCount: number) {
  const sha = await git(cwd, ["rev-parse", commit]);
  const message = await git(cwd, ["log", "-1", "--pretty=%B", sha]);
  const stats = await git(cwd, ["show", "--stat", "--name-status", "--format=fuller", sha]);
  const diff = await git(cwd, ["show", "--format=", "--find-renames", "--find-copies", sha]);
  const filesRaw = await git(cwd, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha]);
  const recent = await git(cwd, ["log", `-${Math.max(1, recentCount)}`, "--date=short", "--pretty=format:%h %ad %s", "--decorate"]);
  return { sha, message, stats, diff, files: filesRaw.split(/\r?\n/).filter(Boolean), recent };
}

function isHeuristicCommitSummary(summary: string): boolean {
  return /heuristic fallback was used/i.test(summary)
    || /could not obtain a dedicated-model synthesis/i.test(summary);
}

function hasDurableCommitKnowledge(summary: string): boolean {
  const normalized = summary.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "no_durable_findings" || normalized.startsWith("no_durable_findings\n")) return false;
  if (/no durable (knowledge|findings|memory|learning)/i.test(summary)) return false;
  if (/nothing durable (was )?(found|identified|detected)/i.test(summary)) return false;
  if (isHeuristicCommitSummary(summary)) return false;
  return true;
}

function writeMemory(cfg: ArchivistConfig, cwd: string, commit: string, summary: string, files: string[]) {
  if (!hasDurableCommitKnowledge(summary)) return null;
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
    `model: ${cfg.model.provider}/${cfg.model.id}`,
    "model_status: synthesized",
    "---",
    "",
    `# ${title}`,
    "",
    summary.trim(),
    "",
  ].join("\n");
  writeFileSync(evidenceFile, note);
  triggerObsidianDocumentIngest(cfg, cwd, evidenceFile);

  // Catalog lives in the project repo; references both repo files and Obsidian pages.
  const relativeEvidencePath = path.relative(cwd, evidenceFile).replace(/\\/g, "/");
  upsertCatalogRow(cwd, {
    id: `evidence.archivist-${commit.slice(0, 12)}`,
    scope: "project",
    project: path.basename(cwd),
    type: "evidence",
    path: relativeEvidencePath,
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
  triggerObsidianDocumentIngest(cfg, cwd, journalFile);

  return { evidenceFile, journalFile, id: `evidence.archivist-${commit.slice(0, 12)}`, title, summary: summary.trim(), relativeEvidencePath };
}

type CommitCluster = {
  shas: string[];
  recent: string;
  files: string[];
  stats: string;
  diff: string;
};

async function collectCommitCluster(cwd: string, count: number): Promise<CommitCluster> {
  const safeCount = Math.max(2, Math.min(50, count));
  const shas = (await git(cwd, ["rev-list", `--max-count=${safeCount}`, "HEAD"])).split(/\r?\n/).filter(Boolean);
  const range = shas.length > 1 ? `${shas[shas.length - 1]}^..HEAD` : "HEAD";
  const recent = await git(cwd, ["log", `-${safeCount}`, "--date=short", "--pretty=format:%h %ad %s", "--decorate"]);
  const stats = await git(cwd, ["show", "--stat", "--name-status", "--format=fuller", ...shas]).catch(() => recent);
  const diff = await git(cwd, ["diff", "--find-renames", "--find-copies", range]).catch(() => "");
  const filesRaw = await git(cwd, ["show", "--format=", "--name-only", ...shas]).catch(() => "");
  const files = [...new Set(filesRaw.split(/\r?\n/).filter(Boolean))];
  return { shas, recent, files, stats, diff };
}

async function modelClusterSummary(ctx: ExtensionContext, cfg: ArchivistConfig, cluster: CommitCluster) {
  if (cfg.model.heuristicOnly) return "NO_DURABLE_FINDINGS";
  const model = ctx.modelRegistry.find(cfg.model.provider, cfg.model.id);
  if (!model) throw new Error(`Archivist model not found: ${cfg.model.provider}/${cfg.model.id}`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  const prompt = [
    "You are Archivist, Sherpa's write-side project memory steward.",
    "Analyze this cluster of recent commits as one change narrative, not as isolated atomic commits.",
    "Write durable memory only if the cluster reveals reusable system knowledge, a changed contract, an architectural decision, or documentation drift.",
    "Skip pure internal refactor/test/catalog churn with exactly: NO_DURABLE_FINDINGS.",
    "If useful, return concise Markdown with sections: Summary, Intent Across Commits, System Knowledge, Documentation Impact, Follow-up, Evidence.",
  ].join("\n");
  const message: UserMessage = { role: "user", timestamp: Date.now(), content: [{ type: "text", text: [
    `Commits:\n${cluster.recent}`,
    `Changed files:\n${cluster.files.join("\n")}`,
    `Stats:\n${cluster.stats.slice(0, 12000)}`,
    `Diff excerpt:\n${cluster.diff.slice(0, 30000)}`,
  ].join("\n\n") }] };
  const response = await complete(model, { systemPrompt: prompt, messages: [message] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal });
  if (response.stopReason === "aborted") return "NO_DURABLE_FINDINGS";
  return normalizeModelMarkdown(response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n"));
}

function writeClusterMemory(cfg: ArchivistConfig, cwd: string, cluster: CommitCluster, summary: string) {
  if (!hasDurableCommitKnowledge(summary)) return null;
  const root = obsidianMemoryPath(cfg);
  const evidenceDir = path.join(root, "wiki", "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const head = cluster.shas[0]?.slice(0, 12) ?? "unknown";
  const tail = cluster.shas[cluster.shas.length - 1]?.slice(0, 12) ?? head;
  const title = `Commit cluster ${tail}..${head}`;
  const evidenceFile = path.join(evidenceDir, `${slug(title)}.md`);
  const note = ["---", `id: archivist-cluster-${tail}-${head}`, "type: evidence", "source: git-commit-cluster", `commits: ${cluster.shas.join("|")}`, `created: ${nowIso()}`, `repo: ${path.basename(cwd)}`, `model: ${cfg.model.provider}/${cfg.model.id}`, "model_status: synthesized", "---", "", `# ${title}`, "", summary.trim(), ""].join("\n");
  writeFileSync(evidenceFile, note);
  triggerObsidianDocumentIngest(cfg, cwd, evidenceFile);
  const relativeEvidencePath = path.relative(cwd, evidenceFile).replace(/\\/g, "/");
  const artifactId = `evidence.archivist-cluster-${tail}-${head}`;
  upsertCatalogRow(cwd, { id: artifactId, scope: "project", project: path.basename(cwd), type: "evidence", path: relativeEvidencePath, title, summary: `Archivist commit-cluster evidence for ${tail}..${head}`, aliases: `${tail}|${head}`, tags: "archivist|git|commit-cluster", status: "active", confidence: "medium", updated: today(), based_on: cluster.shas.join("|"), routes: cluster.files.join("|"), keywords: cluster.files.map((file) => path.basename(file)).join("|") });
  const journalFile = path.join(root, "journal", `${today()}.md`);
  mkdirSync(path.dirname(journalFile), { recursive: true });
  appendFileSync(journalFile, `\n## Archivist cluster ${tail}..${head} — ${path.basename(cwd)}\n\n${summary.trim()}\n\nEvidence: [[${path.basename(evidenceFile, ".md")}]]\n`);
  triggerObsidianDocumentIngest(cfg, cwd, journalFile);
  return { evidenceFile, journalFile, id: artifactId, title, summary: summary.trim(), relativeEvidencePath };
}

function stableMemoryId(prefix: string, value: string) {
  return `${prefix}.${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function sourceFileArtifactId(file: string) {
  return `source-file.${file.replace(/[^A-Za-z0-9_.-]+/g, ".").replace(/^\.+|\.+$/g, "")}`;
}

async function writeDocumentChunks(store: MemoryApiStore, cfg: ArchivistConfig, artifact: MemoryArtifact, sourceText: string) {
  void cfg;
  const chunks = splitTextChunks(sourceText);
  const embeddings = await requestEmbeddings(chunks);
  const prepared = prepareDocumentChunks({ artifact, sourceText, embeddings, createdAt: nowIso() });
  for (const chunk of prepared.chunks) await store.writeChunk?.(chunk).catch(() => console.warn("[archivist] chunk write failed"));
  for (const relation of prepared.relations) await store.writeRelation(relation).catch(() => console.warn("[archivist] relation write failed"));
  return { chunks: chunks.length, embeddings: embeddings.length };
}

function extractGraphEntities(text: string): string[] {
  const candidates = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g)) candidates.add(match[0]);
  for (const match of text.matchAll(/`([^`]{3,80})`/g)) candidates.add(match[1]!.trim());
  for (const match of text.matchAll(/\b(?:[a-z0-9]+[-_/.:]){1,}[a-z0-9_.-]+\b/gi)) candidates.add(match[0]);
  return [...candidates]
    .map((item) => item.replace(/^repo:\/\//, "").trim())
    .filter((item) => item.length >= 3 && item.length <= 80)
    .filter((item) => !/^(summary|evidence|documentation|intent|system|commit)$/i.test(item))
    .slice(0, 16);
}

async function writeEntityMentions(store: MemoryApiStore, project: string, fromId: string, text: string, source: string, now: string) {
  for (const entity of extractGraphEntities(text)) {
    const entityId = stableMemoryId("entity", entity.toLowerCase());
    await store.writeArtifact({
      id: entityId,
      scope: "project",
      project,
      type: "entity",
      title: entity,
      summary: `Entity mentioned in Archivist memory: ${entity}`,
      text: entity,
      confidence: "medium",
      status: "active",
      tags: ["entity"],
      aliases: [entity],
      keywords: [entity],
      createdAt: now,
      updatedAt: now,
    }).catch(() => console.warn("[archivist] write failed"));
    await store.writeRelation({ from: fromId, relation: "mentions", to: entityId, confidence: "medium", source, createdAt: now }).catch(() => console.warn("[archivist] write failed"));
  }
}

function extractSourceGroundedClaims(summary: string): string[] {
  const lines = summary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const claims: string[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/^[-*]\s+/, "").replace(/^#+\s+/, "").trim();
    if (cleaned.length < 35 || cleaned.length > 260) continue;
    if (/^(summary|evidence|documentation impact|repo docs follow-up|system knowledge|intent across recent commits)$/i.test(cleaned)) continue;
    if (/^(no durable|no repo|none\b|n\/a\b|heuristic fallback)/i.test(cleaned)) continue;
    if (!/[.。]$/.test(cleaned) && !/\b(is|are|adds|uses|keeps|moves|creates|updates|requires|depends|routes|stores|writes|reads)\b/i.test(cleaned)) continue;
    claims.push(cleaned);
    if (claims.length >= 8) break;
  }
  return [...new Set(claims)];
}

function normalizeModelMarkdown(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function researchAreaFromPath(file: string) {
  const parts = file.replace(/\\/g, "/").split("/");
  const idx = parts.lastIndexOf("research");
  return idx >= 0 ? parts[idx + 1] : undefined;
}

function sourceDocumentContext(cwd: string, resolved: string, raw: string, now: string) {
  const area = researchAreaFromPath(resolved);
  const scope = area ? "research" as const : "project" as const;
  const project = scope === "project" ? path.basename(cwd) : undefined;
  const rel = path.relative(cwd, resolved).replace(/\\/g, "/");
  const title = titleFromMarkdown(raw, path.basename(resolved));
  return {
    area,
    scope,
    project,
    rel,
    title,
    artifactId: stableMemoryId("source", resolved),
    sourcePath: rel.startsWith("..") ? resolved : rel,
    sourceHash: createHash("sha256").update(raw).digest("hex"),
    now,
  };
}

function sourceDocumentArtifact(ctx: ReturnType<typeof sourceDocumentContext>, raw: string): MemoryArtifact {
  return {
    id: ctx.artifactId,
    scope: ctx.scope,
    project: ctx.project,
    area: ctx.area,
    category: ctx.area === "ai" ? "agent-memory" : undefined,
    type: "source",
    title: ctx.title,
    summary: `Source document mirrored by Archivist: ${ctx.title}`,
    text: raw.slice(0, 24000),
    sourcePath: ctx.sourcePath,
    sourceHash: ctx.sourceHash,
    confidence: "medium",
    status: "active",
    tags: ["archivist", "source", ctx.area ?? "project"],
    aliases: [ctx.title, path.basename(ctx.sourcePath)],
    routes: [ctx.title, path.basename(ctx.sourcePath)],
    keywords: [ctx.title, path.basename(ctx.sourcePath), ...(ctx.area ? [ctx.area] : [])],
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

async function writeSourceDocumentClaims(store: ReturnType<typeof archivistMemoryStore>, cwd: string, resolved: string, raw: string, ctx: ReturnType<typeof sourceDocumentContext>) {
  if (!store) return 0;
  let claims = 0;
  for (const claim of extractSourceGroundedClaims(raw).slice(0, 12)) {
    const claimId = stableMemoryId("claim", `${resolved}\n${claim}`);
    await store.writeArtifact({
      id: claimId,
      scope: ctx.scope,
      project: ctx.project,
      area: ctx.area,
      category: ctx.area === "ai" ? "agent-memory" : undefined,
      type: "claim",
      title: claim.slice(0, 100),
      summary: claim,
      text: claim,
      sourcePath: ctx.sourcePath,
      sourceHash: ctx.sourceHash,
      confidence: "medium",
      status: "active",
      tags: ["claim", "archivist", ctx.area ?? "project"],
      aliases: [claim.slice(0, 80)],
      keywords: claim.split(/\W+/).filter((word) => word.length > 4).slice(0, 16),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    }).catch(() => console.warn("[archivist] write failed"));
    await store.writeRelation({ from: ctx.artifactId, relation: "supports", to: claimId, confidence: "medium", source: resolved, createdAt: ctx.now }).catch(() => console.warn("[archivist] write failed"));
    await writeEntityMentions(store, ctx.project ?? path.basename(cwd), claimId, claim, resolved, ctx.now);
    claims++;
  }
  return claims;
}

async function mirrorSourceDocumentToMemoryApi(cfg: ArchivistConfig, cwd: string, file: string) {
  const store = archivistMemoryStore(cfg);
  if (!store) return { mirrored: false, reason: "memory API disabled" };
  const resolved = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return { mirrored: false, reason: `Source file not found: ${file}` };

  const raw = readFileSync(resolved, "utf8");
  const ctx = sourceDocumentContext(cwd, resolved, raw, nowIso());
  const artifact = sourceDocumentArtifact(ctx, raw);
  await store.writeArtifact(artifact);
  const chunkStats = await writeDocumentChunks(store, cfg, artifact, raw);
  await writeEntityMentions(store, ctx.project ?? path.basename(cwd), ctx.artifactId, raw.slice(0, 12000), resolved, ctx.now);
  const claims = await writeSourceDocumentClaims(store, cwd, resolved, raw, ctx);
  return { mirrored: true, artifactId: ctx.artifactId, title: ctx.title, claims, ...chunkStats };
}

async function mirrorCommitEvidenceToMemoryApi(cfg: ArchivistConfig, cwd: string, written: NonNullable<ReturnType<typeof writeMemory>>, commit: string, files: string[]) {
  const store = archivistMemoryStore(cfg);
  if (!store) return;
  const project = path.basename(cwd);
  const now = nowIso();
  await store.writeArtifact({
    id: written.id,
    scope: "project",
    project,
    type: "evidence",
    title: written.title,
    summary: `Archivist commit evidence for ${commit.slice(0, 12)}`,
    text: written.summary,
    sourcePath: written.relativeEvidencePath,
    sourceHash: commit,
    confidence: "medium",
    status: "active",
    tags: ["archivist", "git", "commit"],
    aliases: [commit.slice(0, 12)],
    routes: files,
    keywords: files.map((file) => path.basename(file)),
    createdAt: now,
    updatedAt: now,
  }).catch(() => console.warn("[archivist] write failed"));

  await writeEntityMentions(store, project, written.id, written.summary, commit, now);

  for (const file of files.slice(0, 80)) {
    const fileId = sourceFileArtifactId(file);
    await store.writeArtifact({
      id: fileId,
      scope: "project",
      project,
      type: "source-file",
      title: file,
      summary: `Source file touched by Archivist-ingested commits: ${file}`,
      text: [file, path.basename(file), path.dirname(file)].join("\n"),
      sourcePath: `repo://${file}`,
      confidence: "high",
      status: "active",
      tags: ["source-file", "repo"],
      aliases: [file, path.basename(file)],
      routes: [file],
      keywords: [file, path.basename(file), path.dirname(file)],
      createdAt: now,
      updatedAt: now,
    }).catch(() => console.warn("[archivist] write failed"));
    await store.writeRelation({
      from: written.id,
      relation: "based_on",
      to: fileId,
      confidence: "high",
      source: commit,
      createdAt: now,
    }).catch(() => console.warn("[archivist] write failed"));
  }

  if (cfg.researchLinks.sageSourceId && /\b(SAGE|GraphRAG|agent memory|graph memory|memory API)\b/i.test(written.summary)) {
    await store.writeRelation({
      from: written.id,
      relation: "applies_research",
      to: cfg.researchLinks.sageSourceId,
      confidence: "medium",
      source: commit,
      createdAt: now,
    }).catch(() => console.warn("[archivist] write failed"));
  }

  for (const claim of extractSourceGroundedClaims(written.summary)) {
    const claimId = stableMemoryId("claim", `${commit}\n${claim}`);
    await store.writeArtifact({
      id: claimId,
      scope: "project",
      project,
      type: "claim",
      title: claim.slice(0, 100),
      summary: claim,
      text: claim,
      sourcePath: written.relativeEvidencePath,
      sourceHash: commit,
      confidence: "medium",
      status: "active",
      tags: ["claim", "archivist", "git"],
      aliases: [claim.slice(0, 80)],
      routes: files,
      keywords: [...files.map((file) => path.basename(file)), ...claim.split(/\W+/).filter((word) => word.length > 4).slice(0, 12)],
      createdAt: now,
      updatedAt: now,
    }).catch(() => console.warn("[archivist] write failed"));
    await store.writeRelation({
      from: written.id,
      relation: "supports",
      to: claimId,
      confidence: "medium",
      source: commit,
      createdAt: now,
    }).catch(() => console.warn("[archivist] write failed"));
    await writeEntityMentions(store, project, claimId, claim, commit, now);
  }
}

function triggerCommitEvidenceMirror(cfg: ArchivistConfig, cwd: string, written: NonNullable<ReturnType<typeof writeMemory>>, commit: string, files: string[]) {
  void mirrorCommitEvidenceToMemoryApi(cfg, cwd, written, commit, files)
    .catch((error) => recordMemoryIngestFailure(cwd, written.evidenceFile, error));
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

type PreserveWriteResult = {
  destination: string;
  file?: string;
  relativePath?: string;
  catalogId?: string;
  indexed?: boolean;
  indexMode?: string;
  indexWarning?: string;
};

function semanticPreserveType(type: string) {
  if (type === "pattern" || type === "automation") return { folder: "procedures", pageType: "procedure" };
  if (type === "process") return { folder: "decisions", pageType: "decision" };
  return { folder: "concepts", pageType: "concept" };
}

function formatPreserveNote(params: PreserveParams, pageType: string): string {
  const frontmatter: Record<string, unknown> = {
    id: params.refId,
    type: pageType,
    importance: params.importance || "medium",
    tags: params.tags || [],
    source: "archivist_preserve",
    created: nowIso(),
  };
  return [
    formatFrontmatter(frontmatter),
    "",
    `# ${params.title}`,
    "",
    params.summary,
    "",
    `Reflect ID: ${params.refId}`,
    "",
  ].join("\n");
}

function writePreserveNote(cfg: ArchivistConfig, params: PreserveParams) {
  const semantic = semanticPreserveType(params.type);
  const dir = path.join(obsidianMemoryPath(cfg), "wiki", semantic.folder);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${slug(params.title || params.refId)}.md`);
  writeFileSync(target, formatPreserveNote(params, semantic.pageType));
  if (!existsSync(target) || !readFileSync(target, "utf8").includes(params.refId)) {
    throw new Error(`preservation verification failed: note was not written with refId ${params.refId}`);
  }
  return { target, pageType: semantic.pageType };
}

function upsertPreserveCatalogRow(cwd: string, params: PreserveParams, target: string, pageType: string) {
  const relativePath = path.relative(cwd, target).replace(/\\/g, "/");
  const catalogId = `reflect.${params.refId}`;
  upsertCatalogRow(cwd, {
    id: catalogId,
    scope: "project",
    project: path.basename(cwd),
    type: pageType,
    path: relativePath,
    title: params.title,
    summary: params.summary.slice(0, 240),
    aliases: params.refId,
    tags: Array.isArray(params.tags) ? params.tags.join("|") : "reflect",
    status: "active",
    confidence: params.importance || "medium",
    updated: today(),
    based_on: params.refId,
    routes: [params.title, ...(params.tags || [])].filter(Boolean).join("|"),
    keywords: [params.refId, params.type || "", params.importance || ""].filter(Boolean).join("|"),
  });
  return { relativePath, catalogId };
}

async function indexPreserveNote(cfg: ArchivistConfig, cwd: string, destination: string, target: string, relativePath: string, catalogId: string): Promise<PreserveWriteResult> {
  try {
    const ingest = await ingestObsidianDocumentToMemoryApi(cfg, cwd, target);
    return {
      destination,
      file: target,
      relativePath,
      catalogId,
      indexed: Boolean((ingest as any)?.ingested),
      indexMode: (ingest as any)?.mode,
      indexWarning: (ingest as any)?.ingested ? undefined : ((ingest as any)?.reason || "Inquirer ingest did not report success"),
    };
  } catch (error) {
    recordMemoryIngestFailure(cwd, target, error);
    return {
      destination,
      file: target,
      relativePath,
      catalogId,
      indexed: false,
      indexWarning: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeAndIndexPreservedReflection(cfg: ArchivistConfig, cwd: string, params: PreserveParams, destination: string): Promise<PreserveWriteResult> {
  if (destination !== "obsidian") {
    throw new Error(`archivist_preserve cannot verify durable indexed writes for destination: ${destination}`);
  }

  const { target, pageType } = writePreserveNote(cfg, params);
  const { relativePath, catalogId } = upsertPreserveCatalogRow(cwd, params, target, pageType);
  return indexPreserveNote(cfg, cwd, destination, target, relativePath, catalogId);
}

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

  function sendArchivistMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0]) {
    try { pi.sendMessage(message, { triggerTurn: false }); } catch { /* Extension runner may be stale after reload/session replacement. */ }
  }

  // Deliberately do not run Archivist maintenance on every agent/task end.
  // Archivist is session-level/commit-hook maintenance, not part of the main
  // agent's per-task critical path.
  pi.on("agent_end", async (_event, _ctx) => {});

  /**
   * Resolve model auth for Archivist's sidecar model.
   */
  async function resolveArchivistModelAuth(cfg: ArchivistConfig, runtime: { modelRegistry: ExtensionContext["modelRegistry"] }): Promise<{ model: { provider: string; id: string; api: string; baseUrl?: string }; auth: { apiKey: string; headers?: Record<string, string> } } | null> {
    if (cfg.model.heuristicOnly) return null;
    const model = runtime.modelRegistry.find(cfg.model.provider, cfg.model.id);
    if (!model) return null;
    const auth = await runtime.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return null;
    return { model: { provider: cfg.model.provider, id: cfg.model.id, api: model.api, baseUrl: model.baseUrl }, auth: { apiKey: auth.apiKey, headers: auth.headers } };
  }

  /**
   * Run Archivist's session analysis in a background subprocess so Pi TUI stays responsive.
   */
  function runBackgroundSessionAnalysis(cfg: ArchivistConfig, cwd: string, reason: string, rawText: string, ctx: ExtensionContext) {
    const notify = createSafeNotifier(ctx);
    const workerScript = path.join(path.dirname(__filename), "..", "pi-sherpa", "scripts", "background-model-worker.ts");

    resolveArchivistModelAuth(cfg, { modelRegistry: ctx.modelRegistry }).then((modelAuth) => {
      if (!modelAuth) {
        // heuristicOnly: skip session analysis
        return;
      }

      const systemPrompt = [
        "You are Archivist, the write-side partner to Sherpa.",
        "You are a guardian of information purity: protect durable memory from noise, clutter, no-op records, and low-value audit chatter.",
        "You analyze coding session content and extract durable knowledge worth preserving.",
        "",
        "Extract ONLY findings that would still matter in 3 months and would make a future user/agent glad the note exists:",
        "- Decisions made and their rationale",
        "- Research conclusions with specific numbers/metrics",
        "- Patterns discovered (what worked, what didn't)",
        "- Configuration values that produced results",
        "- Architectural or design insights",
        "- Bugs root-caused and fixes applied",
        "",
        "IGNORE:",
        "- Routine tool invocations (ls, grep, cat)",
        "- Transient errors that were immediately fixed",
        "- Todo items without resolution",
        "- Chat pleasantries or process noise",
        "- Status chatter, progress pings, and audit-continuity records",
        "- No-op reviews or decisions that nothing needed changing",
        "",
        "Never produce audit-continuity notes, no-op review notes, or statements that nothing durable was found.",
        "Return concise bullet points. If nothing durable was found, return exactly: NO_DURABLE_FINDINGS",
      ].join("\n");

      const input = JSON.stringify({
        model: modelAuth.model,
        auth: modelAuth.auth,
        systemPrompt,
        messageText: `Session event: ${reason}\n\n--- Session content ---\n${rawText.slice(0, 30000)}`,
        timeoutMs: 15_000,
      });

      execFileAsync("bun", ["run", workerScript, "session-analysis", input], { cwd, timeout: 20_000, maxBuffer: 100_000 })
        .then(({ stdout }) => {
          try {
            const result = JSON.parse(stdout.trim());
            if (result.aborted || result.error || !result.text) return;
            const findings = result.text;
            if (findings && findings !== "NO_DURABLE_FINDINGS") {
              const written = writeSessionFindings(cfg, cwd, reason, findings);
              if (written) {
                triggerObsidianDocumentIngest(cfg, cwd, written);
                appendDocumentationJobLog(cfg, cwd, { kind: "session-findings", status: "written", trigger: reason, output: written, model: `${cfg.model.provider}/${cfg.model.id}` });
                notify?.(`Archivist extracted session findings → journal`, "success");
              }
            }
          } catch { /* background worker result parse failed silently */ }
        })
        .catch(() => { /* background worker failed silently */ });
    }).catch(() => { /* model auth resolution failed silently */ });
  }

  // Session compaction is a good low-interference point for Archivist:
  // preserve the compacted context and run documentation maintenance
  // asynchronously without blocking or steering the main agent.
  // Shared handler for session lifecycle events (compact + shutdown).
  function handleSessionEvent(reason: string, rawText: string, ctx: ExtensionContext) {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) return;
    const runtime = { modelRegistry: ctx.modelRegistry, signal: ctx.signal };
    const notify = createSafeNotifier(ctx);

    // Model-based session analysis runs in a background child process so
    // Pi's TUI remains responsive during session lifecycle events.
    runBackgroundSessionAnalysis(cfg, ctx.cwd, reason, rawText, ctx);

    // Documentation drift audit — already fire-and-forget but model calls
    // still tie up the event loop. Delegate to background worker too.
    const cwdForDocsAudit = ctx.cwd;
    void (async () => {
      // Fast deterministic check first (git diff, fingerprint).
      const files = await gitChangedFiles(cwdForDocsAudit).catch(() => [] as string[]);
      if (!files.length) return;

      const fingerprintDiff = await git(cwdForDocsAudit, ["diff", "--", ...[...files].sort()]).catch(() => "");
      const persistentFingerprint = documentationAuditFingerprint(files, fingerprintDiff);
      const hash = hashAutoMemory(`archivist-doc-audit\n${persistentFingerprint}`);
      if (state?.autoMemory?.docAuditHashes?.includes(hash)) return;
      if (hasSeenDocDriftAudit(cwdForDocsAudit, persistentFingerprint)) return;

      // Model-dependent audit decision runs via background worker.
      runBackgroundDocAudit(cfg, cwdForDocsAudit, runtime, reason, files, hash, persistentFingerprint, ctx, notify);
    })().catch(() => { /* deterministics-only path failed silently */ });
  }

  /**
   * Run documentation drift decision in a background child process.
   */
  function runBackgroundDocAudit(
    cfg: ArchivistConfig,
    cwd: string,
    runtime: { modelRegistry: ExtensionContext["modelRegistry"]; signal: AbortSignal },
    reason: string,
    files: string[],
    hash: string,
    persistentFingerprint: string,
    ctx: ExtensionContext,
    notify: ReturnType<typeof createSafeNotifier>,
  ) {
    const workerScript = path.join(path.dirname(__filename), "..", "pi-sherpa", "scripts", "background-model-worker.ts");

    resolveArchivistModelAuth(cfg, runtime).then((modelAuth) => {
      if (!modelAuth) {
        // heuristicOnly — mark as seen and return
        rememberDocAuditHash(state, hash);
        recordDocDriftAudit(cwd, persistentFingerprint, "skipped");
        return;
      }

      const diff = git(cwd, ["diff", "--", ...files]).catch(() => "").then((diffOut) => {
        const docSnippets = documentationAuditSnippets(cwd);
        const auditPrompt = [
          "You are an expert documentation auditor reviewing code changes.",
          "",
          "Determine if the following code changes need documentation updates.",
          "",
          `Changed files:\n${files.join("\n")}`,
          `\nDiff excerpt:\n${diffOut.slice(0, 20000)}`,
          docSnippets.length ? `\nExisting docs:\n${docSnippets.join("\n\n")}` : "\nNo existing documentation found.",
          "",
          `Return ONLY JSON: { "needsUpdate": boolean, "candidateDocs": string[], "reason": "why" }`,
        ].join("\n");

        const input = JSON.stringify({
          model: modelAuth.model,
          auth: modelAuth.auth,
          systemPrompt: auditPrompt,
          messageText: "Determine if documentation updates are needed.",
          timeoutMs: 15_000,
        });

        execFileAsync("bun", ["run", workerScript, "session-analysis", input], { cwd, timeout: 20_000, maxBuffer: 100_000 })
          .then(({ stdout }) => {
            try {
              const result = JSON.parse(stdout.trim());
              if (result.aborted || result.error || !result.text) {
                // Model unavailable — skip audit silently
                rememberDocAuditHash(state, hash);
                recordDocDriftAudit(cwd, persistentFingerprint, "no_update");
                return;
              }

              // Try to parse the audit decision from the response
              const auditResponse = parseDocumentationAuditResponse(result.text);
              if (auditResponse && !auditResponse.needsUpdate) {
                if (state) {
                  rememberDocAuditHash(state, hash);
                  recordDocDriftAudit(cwd, persistentFingerprint, "no_update");
                }
                return;
              }

              // Needs update — run the actual maintenance path
              if (state) {
                rememberDocAuditHash(state, hash);
                recordDocDriftAudit(cwd, persistentFingerprint, "needs_update");
              }

              const candidates = safeExistingDocCandidates(cwd, auditResponse?.candidateDocs).slice(0, 8);
              const audit = { needed: true, hash, changedSources: files, candidates };

              notify?.(`Archivist ${reason} documentation maintenance started asynchronously`, "info");
              completeDocumentationDrift(runtime, cfg, cwd, audit)
                .then((handled) => {
                  const applied = handled.applied?.length ? ` Updated: ${[...new Set(handled.applied)].join(", ")}` : "";
                  const suffix = handled.handled ? applied || " No repo-doc update needed." : " Handoff written to Archivist inbox.";
                  notify?.(`Archivist ${reason} documentation maintenance complete.${suffix}`, handled.handled ? "success" : "warning");
                  sendArchivistMessage({
                    customType: "archivist-doc-maintenance-complete",
                    content: documentationMaintenanceReport(handled),
                    display: true,
                    details: handled,
                  });
                })
                .catch((error) => {
                  const message = error instanceof Error ? error.message : String(error);
                  appendInboxNote(cfg, cwd, "Documentation drift async failure", `Archivist ${reason} asynchronous documentation maintenance failed.\n\n${message}`);
                  notify?.(`Archivist ${reason} documentation maintenance failed: ${message}`, "error");
                });
            } catch {
              rememberDocAuditHash(state, hash);
              recordDocDriftAudit(cwd, persistentFingerprint, "no_update");
            }
          })
          .catch(() => {
            // Background worker unavailable — skip silently
            rememberDocAuditHash(state, hash);
            recordDocDriftAudit(cwd, persistentFingerprint, "no_update");
          });
      });
    }).catch(() => {
      // Model auth failed — skip silently
      rememberDocAuditHash(state, hash);
      recordDocDriftAudit(cwd, persistentFingerprint, "no_update");
    });
  }

  pi.on("session_compact", async (event, ctx) => {
    const raw = stringifyForAutoMemory(event.compactionEntry ?? ctx.sessionManager.getEntries().slice(-20));
    handleSessionEvent("session_compact", raw, ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const raw = stringifyForAutoMemory({ reason: event.reason, recent: ctx.sessionManager.getEntries().slice(-20) });
    handleSessionEvent(`session_shutdown:${event.reason}`, raw, ctx);
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
      const catalogRows = catalogMatches(ctx.cwd, [commit.message, commit.files.join("\n"), commit.recent].join("\n"), { limit: 12, threshold: 0.04 }).map((m) => m.row);
      const summary = await modelSummary(ctx, cfg, { commit: commit.sha, message: commit.message, stats: commit.stats, diff: commit.diff, files: commit.files, recent: commit.recent, catalogRows });
      const heuristicFallback = isHeuristicCommitSummary(summary);
      if (params.dryRun) {
        appendDocumentationJobLog(cfg, ctx.cwd, { kind: "commit-ingest", status: heuristicFallback ? "fallback" : "dry-run", trigger: "archivist_ingest", commit: commit.sha, files: commit.files, model: `${cfg.model.provider}/${cfg.model.id}` });
        return { content: [{ type: "text", text: summary }], details: { dryRun: true, commit: commit.sha, model: cfg.model, heuristicFallback } };
      }
      const written = heuristicFallback ? null : writeMemory(cfg, ctx.cwd, commit.sha, summary, commit.files);
      if (!written) {
        const reason = heuristicFallback ? "dedicated model unavailable or aborted; heuristic summary not persisted" : "no durable knowledge passed information-purity gate";
        appendDocumentationJobLog(cfg, ctx.cwd, { kind: "commit-ingest", status: heuristicFallback ? "fallback" : "skipped", trigger: "archivist_ingest", commit: commit.sha, files: commit.files, reason, model: `${cfg.model.provider}/${cfg.model.id}` });
        return { content: [{ type: "text", text: `Archivist skipped ${commit.sha.slice(0, 12)} — ${reason}.` }], details: { commit: commit.sha, skipped: true, heuristicFallback } };
      }
      appendDocumentationJobLog(cfg, ctx.cwd, { kind: "commit-ingest", status: "written", trigger: "archivist_ingest", commit: commit.sha, files: commit.files, evidenceFile: written.evidenceFile, journalFile: written.journalFile, catalogId: written.id, model: `${cfg.model.provider}/${cfg.model.id}`, modelStatus: "synthesized" });
      triggerCommitEvidenceMirror(cfg, ctx.cwd, written, commit.sha, commit.files);
      return { content: [{ type: "text", text: [`Archivist ingested ${commit.sha.slice(0, 12)}`, `Model: ${cfg.model.provider}/${cfg.model.id}`, `Evidence: ${written.evidenceFile}`, `Journal: ${written.journalFile}`, `Inquirer ingest: queued asynchronously`].join("\n") }], details: { commit: commit.sha, ...written, inquirerIngestQueued: true } };
    },
  });

  pi.registerCommand("archivist:cluster", { description: "Synthesize recent commits as one Archivist evidence cluster. Usage: /archivist:cluster [count] [dry-run]", handler: async (args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) { ctx.ui.notify("Archivist is disabled.", "warning"); return; }
    const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const count = Math.max(2, Math.min(50, Number(tokens.find((token) => /^\d+$/.test(token))) || cfg.commitHook.recentCommitCount || 12));
    const dryRun = tokens.includes("dry-run") || tokens.includes("--dry-run");
    try {
      ctx.ui.notify(`Archivist cluster synthesis running for last ${count} commits…`, "info");
      const cluster = await collectCommitCluster(ctx.cwd, count);
      const summary = await modelClusterSummary(ctx, cfg, cluster);
      if (dryRun) {
        appendDocumentationJobLog(cfg, ctx.cwd, { kind: "commit-cluster", status: "dry-run", trigger: "archivist:cluster", commits: cluster.shas, files: cluster.files, model: `${cfg.model.provider}/${cfg.model.id}` });
        ctx.ui.notify(summary.slice(0, 4000), "info");
        return;
      }
      const written = writeClusterMemory(cfg, ctx.cwd, cluster, summary);
      if (!written) {
        appendDocumentationJobLog(cfg, ctx.cwd, { kind: "commit-cluster", status: "skipped", trigger: "archivist:cluster", commits: cluster.shas, files: cluster.files, reason: "no durable knowledge passed information-purity gate", model: `${cfg.model.provider}/${cfg.model.id}` });
        ctx.ui.notify("Archivist cluster skipped — no durable knowledge passed the information-purity gate.", "info");
        return;
      }
      appendDocumentationJobLog(cfg, ctx.cwd, { kind: "commit-cluster", status: "written", trigger: "archivist:cluster", commits: cluster.shas, files: cluster.files, evidenceFile: written.evidenceFile, journalFile: written.journalFile, catalogId: written.id, model: `${cfg.model.provider}/${cfg.model.id}`, modelStatus: "synthesized" });
      ctx.ui.notify(`Archivist cluster written: ${written.evidenceFile}`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendDocumentationJobLog(cfg, ctx.cwd, { kind: "commit-cluster", status: "failed", trigger: "archivist:cluster", error: message, model: `${cfg.model.provider}/${cfg.model.id}` });
      ctx.ui.notify(`Archivist cluster synthesis failed: ${message}`, "error");
    }
  }});

  pi.registerTool({
    name: "archivist_preserve",
    label: "Archivist Preserve",
    description: "Evaluate a reflection for persistence value and write it through Archivist's Sherpa-compatible memory backend.",
    parameters: preserveSchema,
    async execute(_toolCallId, params: PreserveParams, _signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      const decision = evaluatePersistence({ type: params.type, title: params.title, summary: params.summary, importance: params.importance, tags: params.tags });
      if (decision.decision === "discard") {
        appendDocumentationJobLog(cfg, ctx.cwd, { kind: "reflection-preserve", status: "discarded", trigger: "archivist_preserve", refId: params.refId, title: params.title, reason: decision.reason, confidence: decision.confidence });
        return { content: [{ type: "text", text: [`🚫 Discarded: "${params.title}"`, "", `Reason: ${decision.reason}`, `Confidence: ${decision.confidence}`].join("\n") }], details: { decision: "discard", reason: decision.reason, confidence: decision.confidence } };
      }
      const dest = params.storage && params.storage !== "auto" ? params.storage : decision.destination;
      if (dest === "none") {
        appendDocumentationJobLog(cfg, ctx.cwd, { kind: "reflection-preserve", status: "skipped", trigger: "archivist_preserve", refId: params.refId, title: params.title, reason: decision.reason, confidence: decision.confidence });
        return { content: [{ type: "text", text: `⏭ Skipped: "${params.title}" — not worth persisting` }], details: { decision: "discard", reason: decision.reason, refId: params.refId } };
      }

      let writeResult: PreserveWriteResult;
      try {
        writeResult = await writeAndIndexPreservedReflection(cfg, ctx.cwd, params, dest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendDocumentationJobLog(cfg, ctx.cwd, { kind: "reflection-preserve", status: "failed", trigger: "archivist_preserve", refId: params.refId, title: params.title, destination: dest, reason: message, confidence: decision.confidence });
        return { content: [{ type: "text", text: [`❌ Not preserved: "${params.title}"`, "", message].join("\n") }], details: { decision: "error", destination: dest, refId: params.refId, error: message } };
      }

      const status = writeResult.indexed ? "persisted_indexed" : "persisted_index_pending";
      appendDocumentationJobLog(cfg, ctx.cwd, { kind: "reflection-preserve", status, trigger: "archivist_preserve", refId: params.refId, title: params.title, destination: dest, confidence: decision.confidence, file: writeResult.file, indexed: writeResult.indexed, indexWarning: writeResult.indexWarning });
      const header = writeResult.indexed ? "✅ Preserved and indexed" : "⚠️ Preserved, but Inquirer indexing is not confirmed";
      return { content: [{ type: "text", text: [
        `${header}: "${params.title}"`,
        "",
        `Destination: ${dest}`,
        `Confidence: ${decision.confidence}`,
        writeResult.file ? `File: ${writeResult.file}` : undefined,
        writeResult.file ? `Obsidian URI: obsidian://open?path=${encodeURIComponent(writeResult.file)}` : undefined,
        writeResult.catalogId ? `Catalog ID: ${writeResult.catalogId}` : undefined,
        writeResult.indexed ? `Inquirer: indexed${writeResult.indexMode ? ` (${writeResult.indexMode})` : ""}` : `Inquirer: not confirmed${writeResult.indexWarning ? ` — ${writeResult.indexWarning}` : ""}`,
        "",
        `Reason: ${decision.reason}`,
      ].filter(Boolean).join("\n") }], details: { decision: "persist", destination: dest, refId: params.refId, confidence: decision.confidence, ...writeResult } };
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
      triggerObsidianDocumentIngest(cfg, ctx.cwd, distill.skillPath);
      const relativeSkillPath = path.relative(ctx.cwd, distill.skillPath).replace(/\\/g, "/");
      const artifactId = `procedure.${distill.slug}`;
      upsertCatalogRow(ctx.cwd, {
        id: artifactId,
        scope: "project",
        project: path.basename(ctx.cwd),
        type: "procedure",
        path: relativeSkillPath,
        title: params.task.slice(0, 100),
        summary: params.outcome.slice(0, 180),
        aliases: distill.slug,
        tags: ["archivist", "distillation", params.domain ?? "general"].join("|"),
        status: "active",
        confidence: "medium",
        updated: today(),
        keywords: [params.task, params.domain ?? "general"].join("|"),
      });
      const store = archivistMemoryStore(cfg);
      if (store) void (async () => {
        const now = nowIso();
        await store.writeArtifact({
          id: artifactId,
          scope: "project",
          project: path.basename(ctx.cwd),
          type: "procedure",
          category: params.domain,
          title: params.task.slice(0, 100),
          summary: params.outcome.slice(0, 180),
          text: [params.trigger, params.task, params.outcome, params.context].filter(Boolean).join("\n\n"),
          sourcePath: relativeSkillPath,
          confidence: "medium",
          status: "active",
          tags: ["archivist", "distillation", params.domain ?? "general"],
          aliases: [distill.slug],
          keywords: [params.task, params.domain ?? "general"],
          createdAt: now,
          updatedAt: now,
        });
        if (params.targetPath) {
          const fileId = sourceFileArtifactId(params.targetPath);
          await store.writeArtifact({
            id: fileId,
            scope: "project",
            project: path.basename(ctx.cwd),
            type: "source-file",
            title: params.targetPath,
            summary: `Source file associated with distilled procedure: ${params.targetPath}`,
            text: [params.targetPath, path.basename(params.targetPath), path.dirname(params.targetPath)].join("\n"),
            sourcePath: `repo://${params.targetPath}`,
            confidence: "high",
            status: "active",
            tags: ["source-file", "repo"],
            aliases: [params.targetPath, path.basename(params.targetPath)],
            routes: [params.targetPath],
            keywords: [params.targetPath, path.basename(params.targetPath), path.dirname(params.targetPath)],
            createdAt: now,
            updatedAt: now,
          });
          await store.writeRelation({ from: artifactId, relation: "implements", to: fileId, confidence: "medium", source: relativeSkillPath, createdAt: now });
        }
        await writeEntityMentions(store, path.basename(ctx.cwd), artifactId, [params.trigger, params.task, params.outcome, params.context].filter(Boolean).join("\n\n"), relativeSkillPath, now);
      })().catch((error) => recordMemoryIngestFailure(ctx.cwd, distill.skillPath, error));
      appendDocumentationJobLog(cfg, ctx.cwd, { kind: "distillation", status: "written", trigger: "archivist_distill", task: params.task, outcome: params.outcome, skillPath: distill.skillPath, destination: distill.destination, catalogId: artifactId });
      return { content: [{ type: "text", text: [`🧪 Distilled: ${params.task}`, "", `Skill: ${distill.skillPath}`, `Scope: ${distill.destination}`, `Inquirer ingest: queued asynchronously`].join("\n") }], details: { slug: distill.slug, skillPath: distill.skillPath, destination: distill.destination, inquirerIngestQueued: true } };
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
    try {
      const syncResult = await syncReflectMemory(memoryPaths(cfg, ctx.cwd), parseReflectSyncArgs(args));
      triggerObsidianDocumentsFromSyncResult(cfg, ctx.cwd, syncResult);
      ctx.ui.notify(syncResult, "success");
    }
    catch (e: any) { ctx.ui.notify(`Archivist reflect sync failed: ${e.message ?? e}`, "error"); }
  }});

  pi.registerCommand("archivist:catalog:audit", { description: "Audit the repo-local catalog shared by Archivist and Sherpa", handler: async (_args, ctx) => {
    const audit = auditCatalog(ctx.cwd);
    const lines = [
      "## Archivist Catalog Audit",
      "",
      `Catalog: ${audit.catalogPath}`,
      `Rows: ${audit.rows}`,
      `Directory rows: ${audit.directoryRows}`,
      `File rows: ${audit.fileRows}`,
      `Broken paths: ${audit.brokenPaths.length}`,
      `Duplicate ids: ${audit.duplicateIds.length}`,
      `Rows missing summaries: ${audit.missingSummaries.length}`,
      `Likely over-indexed dirs: ${audit.likelyOverIndexedDirs.length}`,
      "",
      ...audit.brokenPaths.slice(0, 10).map((b) => `- Broken: ${b.id} -> ${b.path}`),
      ...audit.likelyOverIndexedDirs.slice(0, 10).map((d) => `- Over-indexed? ${d.dir}: ${d.fileRows} direct file rows`),
    ];
    ctx.ui.notify(lines.join("\n"), audit.brokenPaths.length ? "warning" : "info");
  }});

  pi.registerCommand("archivist:graph:audit", { description: "Use existing graphify-out to suggest catalog improvements without writing noise", handler: async (args, ctx) => {
    try {
      const targetArg = args?.trim() || undefined;
      const audit = auditGraphifyOutput(ctx.cwd, targetArg);
      if (!audit.ok) {
        ctx.ui.notify([
          "## Archivist Graphify Audit",
          "",
          `Target: ${audit.targetRoot}`,
          `Missing: ${audit.graphPath}`,
          "",
          "Run Graphify first on a selected doc/artifact corpus, for example:",
          "graphify docs/ --no-viz",
          "",
          "Archivist will then use graphify-out/graph.json as discovery input for directory-first catalog suggestions.",
        ].join("\n"), "warning");
        return;
      }
      const lines = [
        "## Archivist Graphify Audit",
        "",
        `Target: ${audit.targetRoot}`,
        `Graph: ${audit.graphPath}`,
        `Nodes: ${audit.nodes}`,
        `Edges: ${audit.edges}`,
        `Source files detected: ${audit.sourceFiles}`,
        `Suggested directory rows: ${audit.suggestedDirectoryRows.length}`,
        `Suggested hot file rows: ${audit.hotFiles.length}`,
        "",
        "### Directory-first catalog candidates",
        ...(audit.suggestedDirectoryRows.length ? audit.suggestedDirectoryRows.map((d) => `- repo://${d.dir}/ (${d.fileCount} graph source files)`) : ["- none"]),
        "",
        "### Hot direct file candidates",
        ...(audit.hotFiles.length ? audit.hotFiles.map((f) => `- repo://${f.file} (${f.nodeCount} graph nodes)`) : ["- none"]),
        "",
        "No catalog rows were written. Archivist should write only curated, meaningful rows after review.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    } catch (e: any) {
      ctx.ui.notify(`Archivist graph audit failed: ${e.message ?? e}`, "error");
    }
  }});

  pi.registerCommand("archivist:docs:trail", { description: "Show recent Archivist documentation job log entries. Usage: /archivist:docs:trail [limit] [status=<status>] [kind=<kind>]", handler: async (args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const target = documentationJobLogPath(cfg, ctx.cwd);
    const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const limitToken = tokens.find((token) => /^\d+$/.test(token));
    const statusFilter = tokens.find((token) => token.startsWith("status="))?.slice("status=".length) || tokens.find((token) => ["written", "skipped", "fallback", "failed", "completed", "handoff", "passed"].includes(token));
    const kindFilter = tokens.find((token) => token.startsWith("kind="))?.slice("kind=".length);
    const limit = Math.max(1, Math.min(100, Number(limitToken) || 20));
    if (!existsSync(target)) {
      ctx.ui.notify(`Archivist documentation job log is empty: ${target}`, "info");
      return;
    }
    const entries = readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
      try { return { line, parsed: JSON.parse(line) as { status?: string; kind?: string } }; }
      catch { return { line, parsed: undefined }; }
    }).filter((entry) => !statusFilter || entry.parsed?.status === statusFilter)
      .filter((entry) => !kindFilter || entry.parsed?.kind === kindFilter)
      .slice(-limit);
    const filterText = [statusFilter ? `status=${statusFilter}` : undefined, kindFilter ? `kind=${kindFilter}` : undefined].filter(Boolean).join(" ") || "none";
    ctx.ui.notify([`Archivist documentation job log: ${target}`, `Filter: ${filterText}`, "", ...entries.map((entry) => entry.line)].join("\n"), "info");
  }});

  pi.registerCommand("archivist:reliability:status", { description: "Summarize recent Archivist job reliability from the documentation job log", handler: async (args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const target = documentationJobLogPath(cfg, ctx.cwd);
    const limit = Math.max(1, Math.min(500, Number(args?.trim()) || 100));
    if (!existsSync(target)) {
      ctx.ui.notify(`Archivist reliability: no job log yet (${target})`, "info");
      return;
    }
    const entries = readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
      try { return JSON.parse(line) as { at?: string; kind?: string; status?: string; model?: string; reason?: string; error?: string }; }
      catch { return undefined; }
    }).filter((entry): entry is { at?: string; kind?: string; status?: string; model?: string; reason?: string; error?: string } => !!entry);
    const byStatus = new Map<string, number>();
    const byKind = new Map<string, number>();
    for (const entry of entries) {
      byStatus.set(entry.status ?? "unknown", (byStatus.get(entry.status ?? "unknown") ?? 0) + 1);
      byKind.set(entry.kind ?? "unknown", (byKind.get(entry.kind ?? "unknown") ?? 0) + 1);
    }
    const concerning = entries.filter((entry) => ["failed", "fallback"].includes(entry.status ?? "")).slice(-10);
    const formatCounts = (values: Map<string, number>) => [...values.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => `- ${key}: ${value}`);
    ctx.ui.notify([
      "## Archivist Reliability Status",
      "",
      `Log: ${target}`,
      `Entries reviewed: ${entries.length}`,
      `Configured model: ${cfg.model.provider}/${cfg.model.id}`,
      "",
      "### Status counts",
      ...formatCounts(byStatus),
      "",
      "### Kind counts",
      ...formatCounts(byKind),
      "",
      "### Recent failures/fallbacks",
      ...(concerning.length ? concerning.map((entry) => `- ${entry.at ?? "unknown"} ${entry.kind ?? "unknown"}/${entry.status ?? "unknown"}: ${entry.error ?? entry.reason ?? "(no reason)"}`) : ["- none"]),
    ].join("\n"), concerning.length ? "warning" : "success");
  }});

  pi.registerCommand("archivist:docs:audit", { description: "Audit whether changed code/config needs documentation updates", handler: async (_args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const runtime = { modelRegistry: ctx.modelRegistry, signal: ctx.signal };
    const audit = await auditDocumentationDrift(state, cfg, ctx.cwd, runtime);
    if (audit.needed) {
      ctx.ui.notify("Archivist detected possible documentation drift; handling asynchronously with dedicated Archivist model", "warning");
      const cwd = ctx.cwd;
      const runtime = { modelRegistry: ctx.modelRegistry, signal: ctx.signal };
      const notify = createSafeNotifier(ctx);
      void completeDocumentationDrift(runtime, cfg, cwd, audit)
        .then((handled) => {
          const applied = handled.applied?.length ? ` Updated: ${[...new Set(handled.applied)].join(", ")}` : "";
          const suffix = handled.handled ? applied || " No repo-doc update needed." : " Handoff written to Archivist inbox.";
          notify?.(`Archivist async documentation maintenance complete.${suffix}`, handled.handled ? "success" : "warning");
          sendArchivistMessage({
            customType: "archivist-doc-maintenance-complete",
            content: documentationMaintenanceReport(handled),
            display: true,
            details: handled,
          });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          appendInboxNote(cfg, cwd, "Documentation drift async failure", `Archivist asynchronous documentation maintenance failed.\n\n${message}`);
          notify?.(`Archivist async documentation maintenance failed: ${message}`, "error");
        });
    } else {
      appendDocumentationJobLog(cfg, ctx.cwd, { kind: "documentation-audit", status: "completed", trigger: "archivist:docs:audit", needed: false, reason: audit.reason, changedSources: audit.changedSources ?? [] });
      ctx.ui.notify(`Archivist documentation audit: ${audit.reason}`, "info");
    }
  }});

  pi.registerCommand("archivist:install-hook", { description: "Install an async git post-commit hook for Archivist", handler: async (_args, ctx) => {
    try {
      const gitDir = await git(ctx.cwd, ["rev-parse", "--git-dir"]);
      const hookPath = path.isAbsolute(gitDir) ? path.join(gitDir, "hooks", "post-commit") : path.join(ctx.cwd, gitDir, "hooks", "post-commit");
      const hookScript = path.join(path.dirname(__filename), "bin", "archivist-hook.mjs");
      mkdirSync(path.dirname(hookPath), { recursive: true });
      const existingHook = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "";
      const backupPath = existingHook.trim() && !existingHook.includes("archivist-hook.mjs") ? `${hookPath}.pre-archivist-${Date.now()}` : undefined;
      if (backupPath) copyFileSync(hookPath, backupPath);
      const block = [
        "#!/bin/sh",
        "# Installed by pi Archivist extension. Runs asynchronously and never blocks commits.",
        backupPath ? `if [ -x ${JSON.stringify(backupPath)} ]; then ${JSON.stringify(backupPath)} \"$@\" || exit $?; fi` : undefined,
        "if [ -n \"$ARCHIVIST_SKIP\" ]; then exit 0; fi",
        "if command -v bun >/dev/null 2>&1; then ARCHIVIST_RUNTIME=bun; else ARCHIVIST_RUNTIME=node; fi",
        `ARCHIVIST_SKIP=1 \"$ARCHIVIST_RUNTIME\" ${JSON.stringify(hookScript)} --repo \"$(git rev-parse --show-toplevel)\" --commit HEAD >> \"$(git rev-parse --git-dir)/archivist.log\" 2>&1 &`,
        "exit 0",
        "",
      ].filter((line): line is string => Boolean(line)).join("\n");
      writeFileSync(hookPath, block);
      chmodSync(hookPath, 0o755);
      if (backupPath) chmodSync(backupPath, 0o755);
      ctx.ui.notify(`Archivist post-commit hook installed: ${hookPath}${backupPath ? ` (existing hook backed up to ${backupPath})` : ""}`, "success");
    } catch (e: any) {
      ctx.ui.notify(`Archivist hook install failed: ${e.message ?? e}`, "error");
    }
  }});

  pi.registerCommand("archivist:memory:record-transcendental", { description: "Record a cross-project transcendental memory: <title> :: <memory>", handler: async (args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const store = archivistMemoryStore(cfg);
    if (!store) { ctx.ui.notify("memory API mirror is disabled for Archivist.", "warning"); return; }
    const raw = args?.trim() ?? "";
    const [titleRaw, ...bodyParts] = raw.split("::");
    const title = titleRaw?.trim();
    const body = bodyParts.join("::").trim();
    if (!title || !body) { ctx.ui.notify("Usage: /archivist:memory:record-transcendental <title> :: <memory>", "warning"); return; }
    const now = nowIso();
    const id = stableMemoryId("transcendental", `${title}\n${body}`);
    try {
      await store.writeArtifact({
        id,
        scope: "transcendental",
        type: "concept",
        title,
        summary: body.slice(0, 240),
        text: body,
        confidence: "medium",
        status: "active",
        tags: ["transcendental", "cross-project", "principle"],
        aliases: [title],
        routes: [title, "transcendental memory"],
        keywords: [title, ...body.split(/\W+/).filter((word) => word.length > 4).slice(0, 16)],
        createdAt: now,
        updatedAt: now,
      });
      await writeEntityMentions(store, path.basename(ctx.cwd), id, `${title}\n${body}`, "transcendental-memory", now);
      ctx.ui.notify(`Transcendental memory recorded: ${id}`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Transcendental memory write failed: ${message}`, "error");
    }
  }});

  pi.registerCommand("archivist:memory:research-links", { description: "Verify configured research source links in the memory API", handler: async (_args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const store = archivistMemoryStore(cfg);
    if (!store) { ctx.ui.notify("memory API mirror is disabled for Archivist.", "warning"); return; }
    const links = Object.entries(cfg.researchLinks ?? {}).filter(([, id]) => typeof id === "string" && id);
    if (!links.length) { ctx.ui.notify("No Archivist researchLinks configured.", "info"); return; }
    const lines = ["## Archivist Research Links", ""];
    for (const [name, id] of links) {
      const results = await store.search({ text: String(id), limit: 5 }).catch(() => []);
      const exact = results.find((result) => result.artifact.id === id);
      lines.push(`- ${name}: ${id} — ${exact ? `${exact.artifact.type} ${exact.artifact.title}` : "not found by search"}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
  }});

  pi.registerCommand("archivist:memory:ingest-source", { description: "Mirror a source/research Markdown file into the memory API graph", handler: async (args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const target = args?.trim();
    if (!target) { ctx.ui.notify("Usage: /archivist:memory:ingest-source <path-to-markdown>", "warning"); return; }
    ctx.ui.notify(`memory API source ingest queued asynchronously: ${target}`, "info");
    void mirrorSourceDocumentToMemoryApi(cfg, ctx.cwd, target).then((result) => {
      if (!result.mirrored) { ctx.ui.notify(result.reason || "Source document was not mirrored.", "warning"); return; }
      ctx.ui.notify(`memory API source mirrored: ${result.title} (${result.claims} claims, ${result.chunks ?? 0} chunks, ${result.embeddings ?? 0} embeddings)`, "success");
    }).catch((error) => {
      recordMemoryIngestFailure(ctx.cwd, target, error);
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`memory API source ingest failed: ${message}`, "error");
    });
  }});

  pi.registerCommand("archivist:memory:retry-failed-ingests", { description: "Retry failed Archivist Obsidian Markdown ingests into the memory API. Usage: /archivist:memory:retry-failed-ingests [limit]", handler: async (args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const limit = Math.max(1, Math.min(500, Number(args?.trim()) || 100));
    const failureLog = path.join(ctx.cwd, ".pi-memory", "archivist-inquirer-ingest-failures.jsonl");
    if (!existsSync(failureLog)) { ctx.ui.notify(`No Archivist ingest failure log found: ${failureLog}`, "info"); return; }
    const entries = readFileSync(failureLog, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit);
    const files = [...new Set(entries.map((line) => {
      try { return JSON.parse(line).file as string | undefined; }
      catch { return undefined; }
    }).filter((file): file is string => !!file && file.endsWith(".md")))];
    if (!files.length) { ctx.ui.notify(`No Markdown ingest failures found in last ${entries.length} entries.`, "info"); return; }

    ctx.ui.notify(`Retrying ${files.length} Archivist failed ingests…`, "info");
    let retried = 0;
    let indexed = 0;
    const failures: string[] = [];
    for (const file of files) {
      if (!existsSync(file)) { failures.push(`${file}: file no longer exists`); continue; }
      retried++;
      try {
        const result = await ingestObsidianDocumentToMemoryApi(cfg, ctx.cwd, file);
        if ((result as any)?.ingested) indexed++;
        else failures.push(`${file}: ${(result as any)?.reason || "ingest did not report success"}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${file}: ${message}`);
        recordMemoryIngestFailure(ctx.cwd, file, error);
      }
    }
    appendDocumentationJobLog(cfg, ctx.cwd, { kind: "memory-ingest-retry", status: failures.length ? "completed_with_failures" : "completed", trigger: "archivist:memory:retry-failed-ingests", scanned: entries.length, candidates: files.length, retried, indexed, failures: failures.slice(0, 20) });
    ctx.ui.notify([
      "## Archivist Failed Ingest Retry",
      "",
      `Failure log: ${failureLog}`,
      `Scanned entries: ${entries.length}`,
      `Candidate Markdown files: ${files.length}`,
      `Retried: ${retried}`,
      `Indexed: ${indexed}`,
      `Failures: ${failures.length}`,
      ...failures.slice(0, 10).map((failure) => `- ${failure}`),
    ].join("\n"), failures.length ? "warning" : "success");
  }});

  pi.registerCommand("archivist:memory:vector-status", { description: "Audit memory API chunk/vector embedding readiness", handler: async (_args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    try {
      const health = await memoryApiGet(cfg, "/api/v1/memory/health");
      const warnings = Array.isArray(health.warnings) ? health.warnings : [];
      ctx.ui.notify(
        `memory API vector status: backend=${health.backend ?? "unknown"}, chunks=${health.chunks ?? 0}, embedded=${health.embedded ?? 0}, vectorIndex=${health.vectorIndex ? "yes" : "no"}, dimension=${health.embeddingDimension ?? "unknown"}${warnings.length ? `; warnings: ${warnings.join(", ")}` : ""}`,
        warnings.length ? "warning" : "success",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`memory API vector status failed: ${message}`, "error");
    }
  }});

  pi.registerCommand("archivist:model:smoke-test", { description: "Verify Archivist can call its configured dedicated model", handler: async (_args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const model = ctx.modelRegistry.find(cfg.model.provider, cfg.model.id);
    if (!model) { ctx.ui.notify(`Archivist model not found: ${cfg.model.provider}/${cfg.model.id}`, "error"); return; }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) { ctx.ui.notify(`Archivist model auth unavailable: ${auth.ok ? "missing API key" : auth.error}`, "error"); return; }
    const message: UserMessage = { role: "user", timestamp: Date.now(), content: [{ type: "text", text: "Reply with exactly: ARCHIVIST_MODEL_OK" }] };
    try {
      const response = await complete(model, { systemPrompt: "You are a smoke-test endpoint. Follow the user's instruction exactly.", messages: [message] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal });
      const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n").trim();
      const ok = response.stopReason !== "aborted" && text.includes("ARCHIVIST_MODEL_OK");
      appendDocumentationJobLog(cfg, ctx.cwd, { kind: "model-smoke-test", status: ok ? "passed" : "failed", trigger: "archivist:model:smoke-test", model: `${cfg.model.provider}/${cfg.model.id}`, stopReason: response.stopReason, response: text.slice(0, 200) });
      ctx.ui.notify(ok ? `Archivist model smoke test passed: ${cfg.model.provider}/${cfg.model.id}` : `Archivist model smoke test failed: ${text || response.stopReason}`, ok ? "success" : "error");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendDocumentationJobLog(cfg, ctx.cwd, { kind: "model-smoke-test", status: "failed", trigger: "archivist:model:smoke-test", model: `${cfg.model.provider}/${cfg.model.id}`, error: message });
      ctx.ui.notify(`Archivist model smoke test failed: ${message}`, "error");
    }
  }});

  pi.registerCommand("archivist:memory:smoke-test", { description: "Write and read a small Archivist/Sherpa memory API artifact", handler: async (_args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const store = archivistMemoryStore(cfg);
    if (!store) { ctx.ui.notify("memory API mirror is disabled for Archivist.", "warning"); return; }
    const id = `smoke.${path.basename(ctx.cwd)}.${Date.now()}`;
    try {
      await store.writeArtifact({
        id,
        scope: "project",
        project: path.basename(ctx.cwd),
        type: "evidence",
        title: "Archivist memory API smoke test",
        summary: "Verifies Archivist can write and Sherpa-compatible memory store can read memory API artifacts.",
        text: "memory-api archivist sherpa smoke test memory artifact",
        confidence: "low",
        status: "needs-review",
        tags: ["archivist", "memory-api", "smoke-test"],
        aliases: ["memory-api smoke test"],
        routes: ["memory-api", "memory-store"],
        keywords: ["archivist", "sherpa", "memory-api"],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      const artifact = await memoryApiGet(cfg, `/api/v1/memory/artifacts/${encodeURIComponent(id)}`);
      const found = artifact?.id === id;
      ctx.ui.notify(found ? `memory API smoke test passed: ${id}` : `memory API smoke test wrote ${id}, but read-back returned a different artifact.`, found ? "success" : "warning");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`memory API smoke test failed: ${message}`, "error");
    }
  }});

  pi.registerCommand("archivist:memory:feedback-audit", { description: "Summarize Sherpa memory API retrieval feedback into an Archivist inbox review candidate", handler: async (args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const store = archivistMemoryStore(cfg);
    if (!store) { ctx.ui.notify("memory API mirror is disabled for Archivist.", "warning"); return; }
    const limit = Number(args?.trim()) || 50;
    try {
      const feedback = await store.recentFeedback(limit);
      if (!feedback.length) { ctx.ui.notify("No memory API retrieval feedback found.", "info"); return; }
      const summary = summarizeFeedbackForReview(feedback);
      if (!summary.missing.length && !summary.noisy.length) { ctx.ui.notify("memory API feedback has no repeated missing/noisy signals to review.", "info"); return; }
      const target = appendInboxNote(cfg, ctx.cwd, "memory API retrieval feedback graph review", feedbackReviewMarkdown(feedback));
      await writeFeedbackReviewToMemoryApi(store, cfg, ctx.cwd, feedback, target);
      ctx.ui.notify(`Archivist feedback audit written: ${target}`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Archivist memory API feedback audit failed: ${message}`, "error");
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
    const memoryApi = archivistMemoryApiConfig(cfg);
    ctx.ui.notify([`Archivist: ${cfg.enabled ? "enabled" : "disabled"}`, `Model: ${cfg.model.provider}/${cfg.model.id} (dedicated; main Pi model is not used)`, `Memory: ${obsidianMemoryPath(cfg)}`, `Documentation job log: ${documentationJobLogPath(cfg, ctx.cwd)}`, `Inquirer Memory API mirror: ${memoryApi.enabled ? memoryApi.url : "disabled"}`, `Hook: ${hook}`].join("\n"), "info");
  }});

  pi.registerCommand("archivist:bootstrap", { description: "Bootstrap Archivist project catalog and durable memory structure for this repo", handler: async (_args, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const bootstrapPromptPath = path.join(path.dirname(__filename), "prompts", "BOOTSTRAP.md");
    const bootstrapPrompt = existsSync(bootstrapPromptPath) ? readFileSync(bootstrapPromptPath, "utf8") : "Bootstrap the project catalog: scan docs, commits, and existing catalog entries. Create or update catalog.csv with high-signal routes.";
    const runtime = { modelRegistry: ctx.modelRegistry, signal: ctx.signal };
    const model = runtime.modelRegistry.find(cfg.model.provider, cfg.model.id);
    if (!model) { ctx.ui.notify(`Archivist model not found: ${cfg.model.provider}/${cfg.model.id}`, "error"); return; }
    const auth = await runtime.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) { ctx.ui.notify(`No API key for ${model.provider}: ${auth.error}`, "error"); return; }
    ctx.ui.notify("Archivist bootstrap running with dedicated model…", "info");

    // Gather project context
    const recent = await git(ctx.cwd, ["log", "-20", "--date=short", "--pretty=format:%h %ad %s", "--decorate"]).catch(() => "");
    const status = await gitChanged(ctx.cwd);
    const changedFiles = await gitChangedFiles(ctx.cwd);
    const existingCatalog = readProjectCatalog(ctx.cwd);
    const docSnippets: string[] = [];
    const addSnippet = (rel: string, max = 3000) => {
      const p = path.join(ctx.cwd, rel);
      if (existsSync(p) && statSync(p).isFile()) docSnippets.push(`--- ${rel} ---\n${readFileSync(p, "utf8").slice(0, max)}`);
    };
    const walkMarkdown = (relDir: string, maxFiles = 40) => {
      const root = path.join(ctx.cwd, relDir);
      if (!existsSync(root) || !statSync(root).isDirectory()) return [] as string[];
      const found: string[] = [];
      const walk = (dir: string) => {
        if (found.length >= maxFiles) return;
        for (const name of readdirSync(dir).sort()) {
          if (found.length >= maxFiles) return;
          const abs = path.join(dir, name);
          const rel = path.relative(ctx.cwd, abs).replace(/\\/g, "/");
          if (statSync(abs).isDirectory()) walk(abs);
          else if (/\.(md|mdx|rst)$/i.test(name)) found.push(rel);
        }
      };
      walk(root);
      return found;
    };
    const priorityDocs = ["README.md", "AGENTS.md", "CLAUDE.md", "CHANGELOG.md", "docs/README.md", ...walkMarkdown("docs")];
    for (const rel of [...new Set(priorityDocs)]) addSnippet(rel, 3500);

    const configSnippets: string[] = [];
    for (const rel of ["package.json", "bunfig.toml", "tsconfig.json", "Dockerfile", "docker-compose.yml", ".pi/sherpa.config.json", ".pi/archivist.config.json"]) {
      const p = path.join(ctx.cwd, rel);
      if (existsSync(p) && statSync(p).isFile()) configSnippets.push(`--- ${rel} ---\n${readFileSync(p, "utf8").slice(0, 2500)}`);
    }

    const entrypointSnippets: string[] = [];
    for (const rel of ["src/server/index.ts", "src/server/core.ts", "src/server/public/client.js", "src/cli/send.ts"]) {
      const p = path.join(ctx.cwd, rel);
      if (existsSync(p) && statSync(p).isFile()) entrypointSnippets.push(`--- ${rel} ---\n${readFileSync(p, "utf8").slice(0, 2500)}`);
    }

    const memoryRoot = obsidianMemoryPath(cfg);
    const memorySnippets: string[] = [];
    for (const rel of ["schema.md", ...walkMarkdown(path.relative(ctx.cwd, path.join(memoryRoot, "wiki")).replace(/\\/g, "/"), 24), ...walkMarkdown(path.relative(ctx.cwd, path.join(memoryRoot, "inbox")).replace(/\\/g, "/"), 12)]) {
      const p = path.isAbsolute(rel) ? rel : path.join(ctx.cwd, rel);
      if (existsSync(p) && statSync(p).isFile()) memorySnippets.push(`--- ${path.relative(ctx.cwd, p).replace(/\\/g, "/")} ---\n${readFileSync(p, "utf8").slice(0, 2200)}`);
    }

    const message: UserMessage = {
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: [
        `Project: ${path.basename(ctx.cwd)}`,
        `CWD: ${ctx.cwd}`,
        ``,
        `Recent commits:\n${recent || "(none)"}`,
        ``,
        `Changed files (git status):\n${changedFiles.join("\n") || "(none)"}`,
        ``,
        `Existing catalog rows: ${existingCatalog.length}`,
        existingCatalog.length ? JSON.stringify(existingCatalog.map(r => ({ id: r.id, type: r.type, path: r.path, title: r.title })), null, 2).slice(0, 3000) : "",
        ``,
        `Project docs:\n${docSnippets.join("\n\n") || "(none)"}`,
        ``,
        `Project config/build files:\n${configSnippets.join("\n\n") || "(none)"}`,
        ``,
        `Main entrypoint excerpts:\n${entrypointSnippets.join("\n\n") || "(none)"}`,
        ``,
        `Existing Obsidian project memory excerpts:\n${memorySnippets.join("\n\n").slice(0, 12000) || "(none)"}`,
      ].join("\n\n") }],
    };

    const response = await complete(model, { systemPrompt: bootstrapPrompt, messages: [message] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal });
    if (response.stopReason === "aborted") { ctx.ui.notify("Archivist bootstrap aborted.", "warning"); return; }
    const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n").trim();

    // Parse catalog.csv updates from the response.
    // Primary: match a ```csv block and extract its CSV content.
    // Fallback: scan all ``` blocks and pick the first that looks like CSV (has a header row
    // with 'id' and 'path' columns).
    const allBlocks = [...text.matchAll(/```(?:csv)?\n?([\s\S]*?)\n?```/gi)];
    const csvBlock = allBlocks.find((m) => {
      const inner = (m[1] ?? "").trim();
      return /^id[,|\s]/.test(inner) || /[,|\s]path[,|\s]/.test(inner);
    });
    const catalogLines = (csvBlock?.[1] ?? "").split(/\r?\n/).filter((l) => l.trim());
    let rowsAdded = 0;
    if (catalogLines.length > 1) {
      const header = catalogLines[0]!;
      const body = catalogLines.slice(1);
      const catalogPath = path.join(ctx.cwd, "catalog.csv");
      mkdirSync(path.dirname(catalogPath), { recursive: true });
      const existing = existingCatalog.map(r => r.id);
      for (const line of body) {
        const cells = line.split(",").map(c => c.replace(/^"|"$/g, "").trim());
        const row: Record<string, string> = {};
        header.split(",").forEach((key, i) => { row[key.trim()] = cells[i] ?? ""; });
        if (row.id && !existing.includes(row.id)) {
          upsertCatalogRow(ctx.cwd, row);
          rowsAdded++;
        }
      }
    }

    const summary = text.slice(0, 3000);
    appendJournalNote(cfg, ctx.cwd, "Archivist bootstrap", [summary, rowsAdded ? `\nCatalog rows added: ${rowsAdded}` : "\nNo new catalog rows added."].join(""));
    appendDocumentationJobLog(cfg, ctx.cwd, { kind: "bootstrap", status: "completed", trigger: "archivist:bootstrap", rowsAdded, summary: summary.slice(0, 800) });
    ctx.ui.notify([`Archivist bootstrap complete.`, rowsAdded ? `Rows added: ${rowsAdded}` : "No new catalog rows.", "", summary.slice(0, 800)].join("\n"), "success");
    sendArchivistMessage({ customType: "archivist-bootstrap-complete", content: summary, display: true });
  }});
}
