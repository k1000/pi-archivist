export type ChunkArtifact = {
  id: string;
  scope: "project" | "research" | "transcendental";
  project?: string;
  area?: string;
  title?: string;
  sourcePath?: string;
};

export type PreparedDocumentChunk = {
  id: string;
  artifactId: string;
  scope: ChunkArtifact["scope"];
  project?: string;
  area?: string;
  chunkIndex: number;
  text: string;
  sectionPath?: string;
  embedding?: number[];
  sourcePath?: string;
};

export type PreparedChunkRelation = {
  from: string;
  relation: "has_chunk";
  to: string;
  weight: number;
  confidence: "high";
  source?: string;
  createdAt?: string;
};

export type PreparedDocumentChunks = {
  chunks: PreparedDocumentChunk[];
  relations: PreparedChunkRelation[];
};

export async function requestEmbeddings(texts: string[], options: { fetchImpl?: typeof fetch } = {}): Promise<number[][]> {
  const apiKey = process.env.EMBEDDING_API_KEY;
  if (!apiKey || !texts.length) return [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = process.env.EMBEDDING_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!response.ok) throw new Error(`Embedding request failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
  if (!Array.isArray(payload.data)) throw new Error("Embedding response did not include data array.");
  return payload.data.sort((a, b) => Number(a.index) - Number(b.index)).map((item) => {
    if (!Array.isArray(item.embedding)) throw new Error("Embedding response item did not include embedding array.");
    return item.embedding.map(Number);
  });
}

export function splitTextChunks(text: string, maxChars = 1800, overlap = 200) {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n\n", end), text.lastIndexOf("\n", end), text.lastIndexOf(". ", end));
      if (boundary > start + Math.floor(maxChars * 0.5)) end = boundary + 1;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.slice(0, 80);
}

export function prepareDocumentChunks(input: {
  artifact: ChunkArtifact;
  sourceText: string;
  embeddings?: number[][];
  createdAt?: string;
}): PreparedDocumentChunks {
  const texts = splitTextChunks(input.sourceText);
  const chunks = texts.map((text, index) => ({
    id: `${input.artifact.id}.chunk.${index}`,
    artifactId: input.artifact.id,
    scope: input.artifact.scope,
    project: input.artifact.project,
    area: input.artifact.area,
    chunkIndex: index,
    text,
    sectionPath: input.artifact.title,
    embedding: input.embeddings?.[index],
    sourcePath: input.artifact.sourcePath,
  }));
  const relations = chunks.map((chunk) => ({
    from: input.artifact.id,
    relation: "has_chunk" as const,
    to: chunk.id,
    weight: 1,
    confidence: "high" as const,
    source: input.artifact.sourcePath,
    createdAt: input.createdAt,
  }));
  return { chunks, relations };
}
