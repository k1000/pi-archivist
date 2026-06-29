import assert from "node:assert/strict";
import { formatFrontmatter, formatMarkdownNote, slugify, titleFromMarkdown, yamlScalar } from "../lib/markdown-note";

assert.equal(yamlScalar("hello"), '"hello"');
assert.equal(yamlScalar(["a", "b"]), '["a", "b"]');
assert.equal(formatFrontmatter({ id: "concept.demo", tags: ["a", "b"] }), '---\nid: "concept.demo"\ntags: ["a", "b"]\n---');
assert.equal(
  formatMarkdownNote({ title: "Demo" }, ["# Demo", undefined, "", "Body"]),
  '---\ntitle: "Demo"\n---\n\n# Demo\n\nBody',
);
assert.equal(titleFromMarkdown('---\ntitle: "Frontmatter Title"\n---\n\n# Heading', "fallback"), "Frontmatter Title");
assert.equal(titleFromMarkdown("# Heading Title\n\nBody", "fallback"), "Heading Title");
assert.equal(titleFromMarkdown("Body only", "fallback"), "fallback");
assert.equal(slugify("Hello, OKF World!"), "hello-okf-world");
assert.equal(slugify("!!!", "fallback-slug"), "fallback-slug");

console.log("markdown-note tests passed=9");
