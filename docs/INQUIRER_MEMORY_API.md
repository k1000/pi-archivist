# Inquirer Memory API Integration

Archivist does not connect to SurrealDB or any local database directly.

Durable notes are written to Obsidian first. Archivist then mirrors created or updated Markdown notes through the Inquirer Memory API so Sherpa can retrieve them through graph/vector memory.

Default endpoint:

```json
{
  "memoryApi": {
    "enabled": true,
    "mode": "memory-api",
    "url": "https://api.enquirer.app",
    "tokenEnv": "SHERPA_MEMORY_API_TOKEN"
  }
}
```

Supported API operations are HTTP-only:

- `POST /api/v1/memory/ingest-vault`
- `POST /api/v1/memory/ingest`
- `GET /api/v1/memory/health`
- `GET /api/v1/memory/artifacts/:id`
- `GET /api/v1/memory/retrieval-feedback`

The API may use SurrealDB internally, but that backend is owned by Inquirer. Archivist should not ship schema application, DB startup, or direct database maintenance commands. Local database scripts belong in the Inquirer project or isolated backend integration tests, not in the Archivist extension.

For local API development, override `memoryApi.url` explicitly in a private config; do not add local database startup/schema assets to Archivist.

Backward compatibility: older configs may still use `memoryStore.surreal`; Archivist treats that value strictly as a Memory API endpoint configuration.
