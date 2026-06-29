import { formatFrontmatter, slugify } from "./markdown-note";

export type OkfRelationInput = {
  type?: unknown;
  relation?: unknown;
  predicate?: unknown;
  target?: unknown;
  to?: unknown;
  object?: unknown;
  confidence?: unknown;
  source?: unknown;
};

export type OkfArtifactInput = Record<string, unknown> & {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  name?: unknown;
  summary?: unknown;
  description?: unknown;
  aliases?: unknown;
  tags?: unknown;
  status?: unknown;
  confidence?: unknown;
  updated?: unknown;
  last_updated?: unknown;
  content?: unknown;
  body?: unknown;
  evidence?: unknown;
  relations?: unknown;
  relationships?: unknown;
};

export type ArchivistOkfConversion = {
  id: string;
  type: string;
  title: string;
  summary: string;
  frontmatter: Record<string, unknown>;
  markdown: string;
  catalogRow: Record<string, string>;
};

const RELATION_FIELDS = ["related", "based_on", "supports", "implements", "derives_from", "supersedes", "contradicts"] as const;
const TYPE_MAP: Record<string, string> = {
  system: "system",
  procedure: "procedure",
  process: "procedure",
  decision: "decision",
  concept: "concept",
  principle: "concept",
  pattern: "concept",
  evidence: "evidence",
  source: "evidence",
  claim: "concept",
};

const FOLDER_MAP: Record<string, string> = {
  system: "systems",
  procedure: "procedures",
  decision: "decisions",
  concept: "concepts",
  evidence: "evidence",
};

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter((item): item is string => Boolean(item));
  const scalar = asString(value);
  if (!scalar) return [];
  return scalar.split(/[|,]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeType(value: unknown): string {
  const raw = asString(value)?.toLowerCase();
  return raw ? (TYPE_MAP[raw] ?? raw) : "concept";
}

function relationTargets(input: OkfArtifactInput, field: string): string[] {
  const direct = list(input[field]);
  const relationBlocks = [input.relations, input.relationships].flatMap((value) => Array.isArray(value) ? value : []);
  const fromBlocks = relationBlocks.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const rel = raw as OkfRelationInput;
    const relationType = asString(rel.type) || asString(rel.relation) || asString(rel.predicate);
    if (relationType !== field) return [];
    return list(rel.target ?? rel.to ?? rel.object);
  });
  return [...new Set([...direct, ...fromBlocks])];
}

export function validateOkfArtifact(input: unknown): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["OKF artifact must be a JSON object"];
  const artifact = input as OkfArtifactInput;
  if (!asString(artifact.id)) errors.push("OKF artifact requires a stable string id");
  if (!asString(artifact.title ?? artifact.name)) errors.push("OKF artifact requires title or name");
  if (!asString(artifact.summary ?? artifact.description)) errors.push("OKF artifact requires summary or description");
  const confidence = asString(artifact.confidence);
  if (confidence && !["low", "medium", "high"].includes(confidence)) errors.push("confidence must be low, medium, or high when provided");
  return errors;
}

export function convertOkfToArchivist(input: OkfArtifactInput, options: { path?: string; now?: string } = {}): ArchivistOkfConversion {
  const errors = validateOkfArtifact(input);
  if (errors.length) throw new Error(`Invalid OKF artifact: ${errors.join("; ")}`);

  const id = asString(input.id)!;
  const type = normalizeType(input.type);
  const title = asString(input.title ?? input.name)!;
  const summary = asString(input.summary ?? input.description)!;
  const aliases = list(input.aliases);
  const tags = list(input.tags);
  const status = asString(input.status) || "active";
  const confidence = asString(input.confidence) || "medium";
  const lastUpdated = asString(input.last_updated ?? input.updated) || (options.now ?? new Date().toISOString().slice(0, 10));
  const relationshipMap = Object.fromEntries(RELATION_FIELDS.map((field) => [field, relationTargets(input, field)]));
  const related = relationshipMap.related as string[];
  const body = asString(input.content ?? input.body) || summary;
  const evidence = list(input.evidence);
  const pathValue = options.path || `wiki/${FOLDER_MAP[type] ?? "concepts"}/${slugify(title, "okf-artifact")}.md`;

  const frontmatter: Record<string, unknown> = {
    id,
    type,
    title,
    summary,
    aliases,
    tags,
    status,
    confidence,
    last_updated: lastUpdated,
    ...relationshipMap,
    okf_source: true,
  };

  const markdown = [
    formatFrontmatter(frontmatter),
    "",
    `# ${title}`,
    "",
    aliases.length ? `Aliases: ${aliases.join(", ")}  ` : undefined,
    `Use when: ${summary}  `,
    related.length ? `Related: ${related.map((target) => `[[${target}]]`).join(", ")}` : undefined,
    "",
    "## Current truth",
    "",
    body,
    "",
    "## Evidence",
    "",
    ...(evidence.length ? evidence.map((item) => `- ${item}`) : ["- Imported from OKF artifact."]),
    "",
    "## Maintenance notes",
    "",
    "- Generated from OKF; keep catalog.csv and typed relationships synchronized when edited.",
  ].filter((line) => line !== undefined).join("\n");

  const catalogRow: Record<string, string> = {
    id,
    type,
    path: pathValue,
    title,
    summary,
    aliases: aliases.join("|"),
    tags: tags.join("|"),
    status,
    confidence,
    updated: lastUpdated,
    related: related.join("|"),
    based_on: (relationshipMap.based_on as string[]).join("|"),
    supports: (relationshipMap.supports as string[]).join("|"),
    implements: (relationshipMap.implements as string[]).join("|"),
    derives_from: (relationshipMap.derives_from as string[]).join("|"),
    supersedes: (relationshipMap.supersedes as string[]).join("|"),
    contradicts: (relationshipMap.contradicts as string[]).join("|"),
    routes: [...new Set([title, ...aliases, ...tags])].join("|"),
    keywords: [id, type, ...tags].join("|"),
  };

  return { id, type, title, summary, frontmatter, markdown, catalogRow };
}

export function parseOkfJson(raw: string): OkfArtifactInput {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) throw new Error("Expected one OKF artifact object; arrays are not supported by this adapter yet");
  return parsed as OkfArtifactInput;
}
