import assert from "node:assert/strict";
import { convertOkfToArchivist, validateOkfArtifact } from "../lib/okf";

const artifact = {
  id: "concept.okf-archivist-adapter",
  type: "principle",
  title: "OKF Archivist Adapter",
  summary: "OKF can be converted into Archivist Markdown, frontmatter, and catalog rows.",
  aliases: ["Open Knowledge Format adapter", "OKF import"],
  tags: ["archivist", "okf", "knowledge-format"],
  confidence: "high",
  status: "active",
  relations: [
    { type: "based_on", target: "concept.semantic-memory-ontology" },
    { relation: "supports", to: "decision.archivist-okf-interchange" },
  ],
  related: "system.archivist|system.sherpa-extension",
  evidence: ["Manual architecture review"],
  content: "Archivist keeps Markdown and catalog.csv canonical while OKF acts as an interchange representation.",
};

assert.deepEqual(validateOkfArtifact(artifact), []);

const converted = convertOkfToArchivist(artifact, { path: "wiki/concepts/okf-archivist-adapter.md", now: "2026-06-29" });
assert.equal(converted.id, "concept.okf-archivist-adapter");
assert.equal(converted.type, "concept", "principle should normalize to Archivist concept");
assert.equal(converted.frontmatter.confidence, "high");
assert.deepEqual(converted.frontmatter.based_on, ["concept.semantic-memory-ontology"]);
assert.deepEqual(converted.frontmatter.supports, ["decision.archivist-okf-interchange"]);
assert.deepEqual(converted.frontmatter.related, ["system.archivist", "system.sherpa-extension"]);
assert.equal(converted.catalogRow.path, "wiki/concepts/okf-archivist-adapter.md");
assert.equal(converted.catalogRow.updated, "2026-06-29");
assert.equal(converted.catalogRow.last_updated, undefined);
assert.equal(converted.catalogRow.aliases, "Open Knowledge Format adapter|OKF import");
assert.equal(converted.catalogRow.tags, "archivist|okf|knowledge-format");
assert.equal(converted.catalogRow.based_on, "concept.semantic-memory-ontology");
assert.equal(converted.catalogRow.supports, "decision.archivist-okf-interchange");
assert.ok(converted.markdown.startsWith("---\nid: \"concept.okf-archivist-adapter\""));
assert.ok(converted.markdown.includes("## Current truth"));
assert.ok(converted.markdown.includes("Generated from OKF"));

const evidence = convertOkfToArchivist({
  id: "evidence.commit-example",
  type: "evidence",
  title: "Commit Example",
  summary: "Evidence artifacts use the singular Archivist evidence folder.",
}, { now: "2026-06-29" });
assert.equal(evidence.catalogRow.path, "wiki/evidence/commit-example.md");

assert.throws(
  () => convertOkfToArchivist({ id: "missing.title" }),
  /Invalid OKF artifact: OKF artifact requires title or name/,
);

console.log("okf tests passed=15");
