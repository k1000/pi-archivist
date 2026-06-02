import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type SessionAnalysisConfig = {
  model: {
    provider: string;
    id: string;
    heuristicOnly: boolean;
    fallbackToHeuristics: boolean;
  };
  memory: {
    obsidianVault: string;
    obsidianMemoryPath: string;
  };
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function obsidianMemoryPath(cfg: SessionAnalysisConfig) {
  const configured = cfg.memory.obsidianMemoryPath;
  return path.isAbsolute(configured)
    ? configured
    : path.join(cfg.memory.obsidianVault, configured);
}

/**
 * Use the Archivist dedicated model to read session content and extract
 * durable findings. Replaces the naive regex-based extractor that only
 * matched imperative keywords ("must", "should", etc.) and missed research
 * conclusions, metrics, and emergent patterns.
 */
export async function modelSessionAnalysis(
  runtime: { modelRegistry: ExtensionContext["modelRegistry"]; signal: AbortSignal },
  cfg: SessionAnalysisConfig,
  input: { reason: string; rawText: string },
): Promise<string> {
  if (cfg.model.heuristicOnly) return "";
  const model = runtime.modelRegistry.find(cfg.model.provider, cfg.model.id);
  if (!model) return "";
  const auth = await runtime.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return "";

  const prompt = [
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

  const message: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [
      {
        type: "text",
        text: `Session event: ${input.reason}\n\n--- Session content ---\n${input.rawText.slice(0, 30000)}`,
      },
    ],
  };

  const response = await complete(
    model,
    { systemPrompt: prompt, messages: [message] },
    { apiKey: auth.apiKey, headers: auth.headers, signal: runtime.signal },
  );
  if (response.stopReason === "aborted") return "";
  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  return text || "";
}

function hasDurableSessionFindings(findings: string): boolean {
  const normalized = findings.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "no_durable_findings") return false;
  if (/no durable (structural )?(learning|findings|knowledge|memory)/i.test(findings)) return false;
  if (/nothing durable (was )?(found|identified|detected)/i.test(findings)) return false;
  if (/event recorded for audit continuity/i.test(findings)) return false;
  if (/decided no repo-local documentation update is required/i.test(findings)) return false;
  if (/no .*documentation update .*required/i.test(findings)) return false;
  return true;
}

/**
 * Write extracted session findings to the journal.
 */
export function writeSessionFindings(
  cfg: SessionAnalysisConfig,
  _cwd: string,
  reason: string,
  findings: string,
): string | null {
  if (!hasDurableSessionFindings(findings)) return null;
  const root = obsidianMemoryPath(cfg);
  const target = path.join(root, "journal", `${today()}.md`);
  mkdirSync(path.dirname(target), { recursive: true });
  const entry = [
    `\n## ${new Date().toISOString()} — ${reason}`,
    "",
    "### Session findings",
    findings,
    "",
  ].join("\n");
  appendFileSync(target, entry);
  return target;
}
