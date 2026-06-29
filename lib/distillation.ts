import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatFrontmatter, slugify } from "./markdown-note";

export type DistilledSkillInput = {
  trigger: string;
  task: string;
  outcome: string;
  context?: string;
  domain?: string;
  targetPath?: string;
};

export type DistilledSkillWrite = {
  slug: string;
  skillPath: string;
  destination: "obsidian";
};

export function writeDistilledSkill(input: DistilledSkillInput, cwd: string, obsidianMemoryRoot: string): DistilledSkillWrite {
  const slug = slugify(input.task || input.trigger || input.outcome, `distillation-${Date.now()}`);
  const dir = path.join(obsidianMemoryRoot, "wiki", "procedures");
  const skillPath = path.join(dir, `${slug}.md`);
  const now = new Date().toISOString();
  const title = input.task.slice(0, 100) || slug;
  const frontmatter = {
    id: `procedure.${slug}`,
    type: "procedure",
    title,
    summary: input.outcome.slice(0, 220),
    aliases: [slug],
    tags: ["archivist", "distillation", input.domain ?? "general"],
    status: "active",
    confidence: "medium",
    last_updated: now.slice(0, 10),
    related: input.targetPath ? [input.targetPath] : [],
    source: "archivist_distill",
  };

  const body = [
    formatFrontmatter(frontmatter),
    "",
    `# ${title}`,
    "",
    `Aliases: ${slug}  `,
    `Use when: ${input.trigger}`,
    "",
    "## Current truth",
    "",
    input.outcome,
    "",
    "## Steps",
    "",
    input.context?.trim() || "- Apply this distilled lesson when the trigger condition appears.",
    "",
    "## Evidence",
    "",
    `- Distilled by Archivist for project ${path.basename(cwd)} at ${now}.`,
    input.targetPath ? `- Related target path: \`${input.targetPath}\`.` : undefined,
    "",
    "## Maintenance notes",
    "",
    "- Keep this procedure current when the underlying workflow or target path changes.",
  ].filter((line) => line !== undefined).join("\n");

  mkdirSync(dir, { recursive: true });
  writeFileSync(skillPath, body);
  return { slug, skillPath, destination: "obsidian" };
}
