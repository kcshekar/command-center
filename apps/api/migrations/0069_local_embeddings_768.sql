-- P2.0: embeddings move from OpenAI text-embedding-3-small (1536) to local
-- Ollama nomic-embed-text (768), so knowledge items never leave the box.
-- Old vectors can't be converted; they're dropped and the hourly embedder
-- sweep re-embeds everything (embedding IS NULL is exactly what it scans).
DROP INDEX IF EXISTS knowledge_items_embedding_hnsw;
ALTER TABLE knowledge_items
  ALTER COLUMN embedding TYPE vector(768) USING NULL::vector(768);
CREATE INDEX knowledge_items_embedding_hnsw
  ON knowledge_items USING hnsw (embedding vector_cosine_ops);
