---
name: archivist
description: Maintain durable project documentation and long-term memory using the Archivist pi extension. Use when the user mentions Archivist, knowledge extraction, extracting lessons from papers/books/articles/repos, commit-triggered documentation, Sherpa write-side memory, Obsidian project memory maintenance, catalog.csv navigation, reflection preservation, distillation, documentation audits, safe automations, or installing the Archivist git hook.
---

# Archivist

Archivist is Sherpa's write-side partner.

- Sherpa reads, ranks, and delivers context.
- Archivist manages durable write-side memory, documentation, reflection preservation, distillation, and safe automations.

## Operating doctrine

Before non-trivial Archivist work, follow:

`/Users/kamil/.pi/agent/extensions/archivist/prompts/OPERATING_DOCTRINE.md`

This doctrine defines role boundaries, project-vs-research knowledge scope, memory-layer semantics, current-truth vs historical-evidence rules, catalog maintenance rules, confidence levels, commit-cluster synthesis, review escalation, and technical-doc-writer handoff format.

## Principles

0. When the task is knowledge extraction — e.g. extracting reusable lessons from papers, books, articles, external docs, reports, codebases, or research artifacts — invoke Archivist and file the durable synthesis into Obsidian/project memory instead of leaving it only in chat or repo-local scratch docs.
1. Use Sherpa's existing memory structure; do not invent new folders or categories.
2. Distinguish project-related knowledge from reusable research knowledge before choosing a destination. Research knowledge should use a mostly flat `research/<area>/` layout with strong metadata/tags/relationships instead of forced directory taxonomies; subfolders are allowed for unified sources or research attempts such as books, courses, paper series, campaigns, or chapter-like collections. Use the global machine-readable taxonomy `/Users/kamil/Documents/articles/taxonomy.csv` so projects and research can link bidirectionally with consistent labels and relationship names.
3. Use the existing catalog service surface, `catalog.csv`, to navigate where documentation lives.
4. Use Obsidian as the primary system documentation store.
5. Automatically ingest every Archivist-created or Archivist-updated Obsidian Markdown note into Inquirer Memory API. Archivist must never connect to SurrealDB or a local database directly; Inquirer owns the backing database.
6. Sherpa keeps the repo-local scratchpad; Archivist writes review queues and candidates to Obsidian `inbox`/`journal`.
7. Update repo-local documentation only when it already exists and is clearly affected; otherwise create an Obsidian inbox follow-up.
8. Use a dedicated lower model for Archivist, never the main Pi model.
9. Treat a commit as evidence, but synthesize intent across nearby commits because individual commits are often atomic.
10. For team-developed projects, commit scanning is even more important: use merge commits, author context, branch names, changed-file clusters, and nearby commits to reconstruct distributed intent and undocumented decisions in the codebase.
11. Do not absorb the technical doc writer role. When substantial repo-local prose, API docs, guides, or architecture explanations need to be authored, coordinate with the dedicated technical doc writer skill at `/Users/kamil/Development/_DESERT_BACON/ClearStack/.claude/skills/technical-docs-writer/SKILL.md`; Archivist should decide timing/routing/location and maintain memory/catalog bookkeeping.

## Bootstrap existing projects

When Archivist is introduced to an existing project, first bootstrap the project catalog. Use the bootstrap policy prompt:

`/Users/kamil/.pi/agent/extensions/archivist/prompts/BOOTSTRAP.md`

Bootstrap should scan important documentation roots, preserve existing catalog rows, add missing `catalog.csv` entries, and create Obsidian inbox follow-ups for unclear/stale docs.

## Commands

```text
/archivist:status           — Show config and hook status
/archivist:bootstrap        — Bootstrap project catalog and durable memory structure
/archivist:install-hook     — Install async git post-commit hook
/archivist:sync-reflect    — Sync reflect captures into Archivist/Sherpa memory
/archivist:docs:audit      — Audit whether changed code/config needs documentation updates
/archivist:docs:trail      — Show recent Archivist documentation job log entries; supports status= and kind= filters
/archivist:model:smoke-test — Verify Archivist can call its configured dedicated model
/archivist:reliability:status — Summarize recent Archivist job failures/fallbacks
/archivist:cluster         — Synthesize recent commits as one evidence cluster
/archivist:graph:audit     — Use existing graphify-out to suggest catalog improvements
/archivist:catalog:audit   — Audit the repo-local catalog for broken/duplicate rows
/archivist:automations     — List safe project automations Archivist can run
```

## Memory Routing

Archivist routes knowledge by scope:

- **Project knowledge** (project-specific, bounded to one repo) → `wiki/procedures/` in project Obsidian memory
- **Research knowledge** (cross-project, reusable) → `research/<domain>/` in the Obsidian research vault

Research domains include: `ai`, `llm`, `agent`, `agents`, `software-engineering`, `trading`, `finance`, `backtesting`, `python`, `typescript`, `git`, `documentation`, `operations`, `testing`, `refactoring`, `architecture`, etc.

Distillation uses the `domain` parameter to decide routing. Set `domain` to a cross-project area to route to research/. Set `targetPath` for explicit placement.

## Tools

Use `archivist_ingest` to manually archive a commit:

```json
{
  "commit": "HEAD",
  "recentCommitCount": 12,
  "dryRun": false
}
```

Additional tools:

- `archivist_preserve` — preserve/discard reflection gate
- `archivist_distill` — write distilled procedures to Obsidian
- `archivist_run_automation` — run safe registered automations

## Expected outputs

Archivist writes into Sherpa-compatible locations:

- `wiki/evidence/commit-<sha>.md`
- `journal/<yyyy-mm-dd>.md`
- `catalog.csv` row for new evidence
- Obsidian `inbox` item when repo-local docs may need review
- repo-local `.pi-memory/archivist-documentation-jobs.jsonl` trail for commit ingests, documentation maintenance, distillation, preservation, and bootstrap jobs

## Configuration

Project override path:

```text
.pi/archivist.config.json
```

Keep the model dedicated/lower, for example:

```json
{
  "model": {
    "provider": "minimax",
    "id": "MiniMax-M2.7-highspeed",
    "useMainPiModel": false
  },
  "documentationJobs": {
    "logPath": ".pi-memory/archivist-documentation-jobs.jsonl"
  }
}
```
