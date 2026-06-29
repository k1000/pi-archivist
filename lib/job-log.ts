import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DEFAULT_ARCHIVIST_CONFIG, type ArchivistConfig } from "./config";

function nowIso(): string {
  return new Date().toISOString();
}

export function documentationJobLogPath(cfg: ArchivistConfig, cwd: string): string {
  const configured = cfg.documentationJobs?.logPath || DEFAULT_ARCHIVIST_CONFIG.documentationJobs.logPath;
  return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
}

export function appendDocumentationJobLog(cfg: ArchivistConfig, cwd: string, event: Record<string, unknown>): void {
  try {
    const target = documentationJobLogPath(cfg, cwd);
    mkdirSync(path.dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify({ schemaVersion: 1, at: nowIso(), project: path.basename(cwd), pid: process.pid, ...event })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[archivist] documentation job log failed: ${message}`);
  }
}
