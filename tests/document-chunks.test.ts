import assert from "node:assert/strict";
import { prepareDocumentChunks, requestEmbeddings, splitTextChunks } from "../lib/document-chunks";

const originalKey = process.env.EMBEDDING_API_KEY;
const originalBaseUrl = process.env.EMBEDDING_BASE_URL;
const originalModel = process.env.EMBEDDING_MODEL;

try {
  const chunks = splitTextChunks("# Intro\n\nalpha. beta. gamma.\n\n# Details\n\ndelta epsilon zeta", 24, 4);
  assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
  assert.ok(chunks.every((chunk) => chunk.trim() === chunk && chunk.length > 0), "expected trimmed non-empty chunks");

  delete process.env.EMBEDDING_API_KEY;
  assert.deepEqual(await requestEmbeddings(["alpha"]), [], "expected no embeddings without API key");

  process.env.EMBEDDING_API_KEY = "test-key";
  process.env.EMBEDDING_BASE_URL = "https://fake-embedding.local/v1/";
  process.env.EMBEDDING_MODEL = "fake-embedding-model";
  const calls: Array<{ url: string; body: any; authorization?: string }> = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body, authorization: init?.headers ? (init.headers as Record<string, string>).authorization : undefined });
    return new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0.2, 0.3] },
        { index: 0, embedding: [0.1, 0.4] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const embeddings = await requestEmbeddings(["first", "second"], { fetchImpl: fakeFetch as typeof fetch });
  assert.deepEqual(embeddings, [[0.1, 0.4], [0.2, 0.3]], "expected embeddings sorted by response index");
  assert.equal(calls[0]!.url, "https://fake-embedding.local/v1/embeddings");
  assert.equal(calls[0]!.authorization, "Bearer test-key");
  assert.deepEqual(calls[0]!.body, { model: "fake-embedding-model", input: ["first", "second"] });

  await assert.rejects(
    requestEmbeddings(["bad input"], { fetchImpl: (async () => new Response("quota exceeded", { status: 429 })) as typeof fetch }),
    /Embedding request failed: 429 quota exceeded/,
    "expected embedding API failures to include status and response body",
  );

  await assert.rejects(
    requestEmbeddings(["missing data"], { fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch }),
    /Embedding response did not include data array/,
    "expected missing data array to be rejected",
  );
  await assert.rejects(
    requestEmbeddings(["missing embedding"], { fetchImpl: (async () => new Response(JSON.stringify({ data: [{ index: 0 }] }), { status: 200 })) as typeof fetch }),
    /Embedding response item did not include embedding array/,
    "expected missing embedding array to be rejected",
  );

  const failingFetch = async () => new Response("quota exceeded", { status: 429 });
  await assert.rejects(
    async () => {
      const chunksForIngest = splitTextChunks("alpha beta gamma");
      await requestEmbeddings(chunksForIngest, { fetchImpl: failingFetch as typeof fetch });
    },
    /Embedding request failed: 429 quota exceeded/,
    "expected ingestion embedding failures to propagate instead of silently writing unembedded chunks",
  );

  const prepared = prepareDocumentChunks({
    artifact: { id: "source.demo", scope: "research", area: "ai", title: "Demo Doc", sourcePath: "sources/demo.md" },
    sourceText: "alpha beta gamma\n\nsecond section",
    embeddings: [[0.1, 0.2]],
    createdAt: "2026-05-19T00:00:00.000Z",
  });
  assert.equal(prepared.chunks.length, 1);
  assert.equal(prepared.relations.length, 1);
  assert.deepEqual(prepared.chunks[0], {
    id: "source.demo.chunk.0",
    artifactId: "source.demo",
    scope: "research",
    project: undefined,
    area: "ai",
    chunkIndex: 0,
    text: "alpha beta gamma\n\nsecond section",
    sectionPath: "Demo Doc",
    embedding: [0.1, 0.2],
    sourcePath: "sources/demo.md",
  });
  assert.deepEqual(prepared.relations[0], {
    from: "source.demo",
    relation: "has_chunk",
    to: "source.demo.chunk.0",
    weight: 1,
    confidence: "high",
    source: "sources/demo.md",
    createdAt: "2026-05-19T00:00:00.000Z",
  });
} finally {
  if (originalKey === undefined) delete process.env.EMBEDDING_API_KEY; else process.env.EMBEDDING_API_KEY = originalKey;
  if (originalBaseUrl === undefined) delete process.env.EMBEDDING_BASE_URL; else process.env.EMBEDDING_BASE_URL = originalBaseUrl;
  if (originalModel === undefined) delete process.env.EMBEDDING_MODEL; else process.env.EMBEDDING_MODEL = originalModel;
}

console.log("document-chunks tests passed=7");
