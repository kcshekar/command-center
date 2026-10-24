-- Phase 1.5 (deferred): add pgvector + embedding column + HNSW index to the
-- knowledge_items table from 0031.
--
-- Run this only after pgvector is installed on the Postgres server. On macOS
-- with Homebrew Postgres 15:
--   brew install pgvector
--   restart Postgres
-- On Debian/Ubuntu:
--   apt install postgresql-15-pgvector
--
-- Until this migration lands, text search works via the tsvector column from
-- 0031; the API's hasEmbedding flag just always returns false.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE knowledge_items
  ADD COLUMN embedding vector(1536);

-- Cosine distance is the standard for OpenAI/Anthropic text embeddings.
CREATE INDEX knowledge_items_embedding_hnsw
  ON knowledge_items USING hnsw (embedding vector_cosine_ops);
