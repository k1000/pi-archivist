# Archivist Extension

Archivist is the write-side partner to Sherpa.

- **Sherpa**: read-side context retrieval and delivery.
- **Archivist**: write-side long-term memory, documentation maintenance, reflection preservation, distillation, and safe automation management.

Archivist reuses Sherpa configuration where possible:

- model defaults from `.pi/sherpa.config.json` or `~/.pi/sherpa.config.json`
- memory paths from Sherpa's `memory` config
- Obsidian directory ontology: `wiki/systems`, `wiki/procedures`, `wiki/decisions`, `wiki/concepts`, `wiki/evidence`, `journal`, `inbox`
- `catalog.csv` as the catalog service/navigation surface for documentation locations

## Dedicated model

Archivist never uses the main Pi model. It uses its configured lower model:

```json
{
  "model": {
    "provider": "minimax",
    "id": "MiniMax-M2.7-highspeed",
    "useMainPiModel": false
  }
}
```

Project override: `.pi/archivist.config.json`.

## Operating doctrine

Archivist behavior is governed by:

`/Users/kamil/.pi/agent/extensions/archivist/prompts/OPERATING_DOCTRINE.md`

The doctrine defines role boundaries, project-vs-research knowledge scope, memory-layer semantics, current-truth vs historical-evidence rules, catalog maintenance rules, confidence levels, commit-cluster synthesis, review escalation, and technical-doc-writer handoff format. Research knowledge uses a mostly flat `research/<area>/` layout with strong metadata, tags, aliases, routes, and relationships rather than forced directory taxonomies. Subfolders are allowed when they represent a unified source or research attempt, such as a book, course, paper series, benchmark suite, campaign, or chapter-like collection.

## Ownership boundary

Sherpa keeps the repo-local scratchpad and read-side retrieval. Archivist is the manager for durable write-side memory and documentation. Review queues and candidates are written to Obsidian `inbox`/`journal`, not to `.pi-memory/scratchpad`.

Archivist should remain aware of the dedicated technical doc writer skill without absorbing it. Archivist decides when docs need work, where they belong, and how memory/catalog bookkeeping is maintained; the technical doc writer should be used for substantial repo-local prose, API docs, guides, migration notes, or architecture explanations.

Technical doc writer skill path: `/Users/kamil/Development/_DESERT_BACON/ClearStack/.claude/skills/technical-docs-writer/SKILL.md`.

## Existing project bootstrap

When Archivist is installed into an existing project, run a bootstrap pass before relying on commit-time maintenance. Bootstrap policy prompt:

`/Users/kamil/.pi/agent/extensions/archivist/prompts/BOOTSTRAP.md`

The bootstrap pass should scan important documentation roots, relevant commit history, and project configuration; create or refresh `catalog.csv`; preserve valid existing rows; and create Obsidian `inbox` follow-ups for unclear or stale documentation. For team-developed projects, commit history is especially important because distributed intent, review decisions, and subsystem ownership are often encoded across related commits rather than in one obvious document.

## Commands

- `/archivist:install-hook` — install async `.git/hooks/post-commit`
- `/archivist:status` — show configured model, memory root, and hook state
- `/archivist:sync-reflect` — sync reflect captures into Obsidian memory
- `/archivist:docs:audit` — audit changed source/config for documentation drift
- `/archivist:automations` — list safe project automations

## Tools

- `archivist_ingest` — ingest a commit manually, including recent commit context
- `archivist_preserve` — apply the preserve/discard gate and route reflect captures
- `archivist_distill` — write distilled procedures into the semantic wiki
- `archivist_run_automation` — run safe registered project automations

## Git hook

The post-commit hook runs `bin/archivist-hook.mjs` asynchronously and logs to `.git/archivist.log`. It is conservative: it writes Obsidian evidence/journal notes and updates `catalog.csv`; repo-local docs follow-up is recorded in Obsidian `inbox`.

