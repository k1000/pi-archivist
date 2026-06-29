# OKF Integration

Archivist can consume Open Knowledge Format (OKF) as an interchange representation, while keeping its existing canonical storage model:

```text
OKF JSON -> Archivist Markdown + YAML frontmatter -> catalog.csv -> Inquirer Memory API ingest
```

Markdown notes and `catalog.csv` remain canonical because Sherpa retrieval and Archivist maintenance already depend on them as the project memory control plane.

## Adapter

The adapter lives in:

```text
lib/okf.ts
```

It provides:

- `validateOkfArtifact(input)` — checks that an OKF-like object has enough stable metadata for durable memory.
- `convertOkfToArchivist(input, options)` — converts one OKF artifact into:
  - Markdown note content,
  - YAML frontmatter object,
  - `catalog.csv` row object.
- `parseOkfJson(raw)` — parses one JSON object. Arrays are intentionally not supported yet.

## Supported OKF fields

The adapter is deliberately tolerant and accepts common OKF-like field names:

| OKF field | Archivist field |
|---|---|
| `id` | `id` |
| `type` | normalized `type` |
| `title` / `name` | `title` |
| `summary` / `description` | `summary` |
| `aliases` | `aliases` |
| `tags` | `tags` |
| `status` | `status` |
| `confidence` | `confidence` |
| `updated` / `last_updated` | frontmatter `last_updated`; catalog row `updated` |
| `content` / `body` | Markdown current-truth body |
| `evidence` | Evidence section bullets |

Relationship fields are mapped directly when present:

- `related`
- `based_on`
- `supports`
- `implements`
- `derives_from`
- `supersedes`
- `contradicts`

The adapter also accepts relationship objects in `relations` or `relationships`:

```json
{
  "relations": [
    { "type": "based_on", "target": "source.example" },
    { "relation": "supports", "to": "decision.example" }
  ]
}
```

## CLI smoke usage

```bash
bun scripts/okf-convert.ts validate artifact.okf.json
bun scripts/okf-convert.ts to-md artifact.okf.json --path wiki/concepts/example.md
bun scripts/okf-convert.ts to-catalog-json artifact.okf.json --path wiki/concepts/example.md
```

Package aliases:

```bash
bun run test:okf
bun run okf validate artifact.okf.json
```

## Current limits

- Only one OKF artifact object is handled at a time.
- The adapter does not write files or mutate `catalog.csv`; it prepares deterministic outputs for existing Archivist write paths.
- The adapter intentionally does not replace Markdown or `catalog.csv` as canonical storage.
