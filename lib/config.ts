import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_ARCHIVIST_CONFIG = {
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
  documentationJobs: {
    logPath: ".pi-memory/archivist-documentation-jobs.jsonl",
  },
  researchLinks: {
    sageSourceId: "source.fe51221f6743ee52",
  },
  // Archivist writes durable Markdown to Obsidian, then mirrors it through
  // the Inquirer Memory API. The API owns the backing database; Archivist does
  // not connect to SurrealDB or any local database directly.
  memoryApi: {
    enabled: true,
    mode: "memory-api",
    url: "https://api.enquirer.app",
    namespace: "pi",
    database: "memory",
    tokenEnv: "SHERPA_MEMORY_API_TOKEN",
  },
};

export type ArchivistConfig = typeof DEFAULT_ARCHIVIST_CONFIG & {
  memoryApi?: typeof DEFAULT_ARCHIVIST_CONFIG.memoryApi & Record<string, unknown>;
  memoryStore?: Record<string, unknown>;
};

function mergeConfig<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object") return structuredClone(base);
  const out: any = Array.isArray(base) ? [...base] : { ...(base as any) };
  for (const [key, value] of Object.entries(over)) {
    out[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeConfig((base as any)?.[key] ?? {}, value)
      : value;
  }
  return out;
}

function projectMemoryRel(cwd: string): string {
  const name = path.basename(cwd).replace(/[^A-Za-z0-9_-]+/g, "-") || "project";
  return `projects/${name}`;
}

function readJsonIfExists(file: string): unknown {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined; }
  catch { return undefined; }
}

function memoryApiFromLegacySurreal(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return { enabled: true, mode: "memory-api", url: value };
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const legacy = value as Record<string, unknown>;
  const url = legacy.url ?? legacy.endpoint ?? legacy.baseUrl;
  if (typeof url !== "string" || !url.trim()) return undefined;
  return {
    enabled: legacy.enabled ?? true,
    mode: "memory-api",
    url,
    tokenEnv: legacy.tokenEnv,
    token: legacy.token,
  };
}

function applyLegacyMemoryStoreAlias<T extends ArchivistConfig>(cfg: T): T {
  const legacy = memoryApiFromLegacySurreal((cfg.memoryStore as any)?.surreal);
  if (!legacy) return cfg;
  return { ...cfg, memoryApi: mergeConfig(cfg.memoryApi ?? DEFAULT_ARCHIVIST_CONFIG.memoryApi, legacy) };
}

export function loadConfig(cwd: string): ArchivistConfig {
  const cfg = structuredClone(DEFAULT_ARCHIVIST_CONFIG) as ArchivistConfig;
  cfg.memory.obsidianMemoryPath = projectMemoryRel(cwd);

  // Reuse Sherpa's existing memory configuration as the base contract.
  // Do not inherit Sherpa's model: Archivist must stay on its own dedicated
  // lower model unless explicitly overridden by .pi/archivist.config.json.
  const home = process.env.HOME || "/Users/kamil";
  const globalSherpa = readJsonIfExists(path.join(home, ".pi", "sherpa.config.json"));
  const projectSherpa = readJsonIfExists(path.join(cwd, ".pi", "sherpa.config.json"));
  for (const sherpa of [globalSherpa, projectSherpa] as any[]) {
    if (sherpa?.memory) (cfg as any).memory = mergeConfig(cfg.memory, sherpa.memory);
    if (sherpa?.memoryStore?.surreal) (cfg as any).memoryStore = mergeConfig((cfg as any).memoryStore ?? {}, { surreal: sherpa.memoryStore.surreal });
  }

  const globalArchivist = readJsonIfExists(path.join(home, ".pi", "archivist.config.json"));
  const projectArchivist = readJsonIfExists(path.join(cwd, ".pi", "archivist.config.json"));
  return applyLegacyMemoryStoreAlias(mergeConfig(mergeConfig(cfg, globalArchivist), projectArchivist));
}

export function obsidianMemoryPath(cfg: ArchivistConfig): string {
  const configured = cfg.memory.obsidianMemoryPath || DEFAULT_ARCHIVIST_CONFIG.memory.obsidianMemoryPath;
  return path.isAbsolute(configured) ? configured : path.join(cfg.memory.obsidianVault, configured);
}
