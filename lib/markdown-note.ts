export function yamlScalar(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(", ")}]`;
  return JSON.stringify(String(value ?? ""));
}

export function formatFrontmatter(frontmatter: Record<string, unknown>): string {
  return ["---", ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${yamlScalar(value)}`), "---"].join("\n");
}

export function formatMarkdownNote(frontmatter: Record<string, unknown>, bodyLines: Array<string | undefined>): string {
  return [formatFrontmatter(frontmatter), "", ...bodyLines.filter((line) => line !== undefined)].join("\n");
}

export function titleFromMarkdown(text: string, fallback: string): string {
  const frontmatterTitle = text.match(/^---[\s\S]*?\ntitle:\s*["']?([^"'\n]+)["']?[\s\S]*?\n---/i)?.[1]?.trim();
  if (frontmatterTitle) return frontmatterTitle;
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback;
}

export function slugify(value: string, fallback = "note"): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}
