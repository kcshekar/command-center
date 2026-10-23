-- Phase 1.5 — Knowledge Memory layer. Replaces the file-based doc store that
-- the pre-2026 plan assumed with a DB-only, per-user-with-opt-in-share table
-- that the automations (A1 News, A3 Prep, A7 Profile, A8 Learning) can read
-- and write through plain SQL. OKF frontmatter (type, title, tags, source,
-- source_id, related) becomes columns; everything else lives in metadata jsonb.
--
-- Keyword search works today via the generated tsvector + GIN. Embeddings
-- (pgvector + HNSW) land in migration 0032 — kept separate so this one works
-- on Postgres instances where pgvector isn't installed yet.
--
-- RLS: SELECT = own OR org-shared. INSERT/UPDATE/DELETE = own only. The split
-- is modeled as separate per-command policies rather than one FOR ALL so the
-- shared-read case can't be abused to mutate someone else's row.

CREATE TABLE knowledge_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  type            text NOT NULL DEFAULT 'note',               -- 'note' | 'journal' | 'brief' | 'news' | 'profile' | ...
  title           text NOT NULL,
  body            text,                                       -- markdown
  tags            text[] NOT NULL DEFAULT '{}',
  source          text NOT NULL DEFAULT 'user',               -- 'user' | 'a1.news' | 'a3.prep' | ...
  source_id       text,                                       -- idempotency when ingested
  related         uuid[] NOT NULL DEFAULT '{}',               -- links to other items (Neo4j is A4 phase 3)

  shared_with_org boolean NOT NULL DEFAULT false,

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  tsv             tsvector GENERATED ALWAYS AS (
                    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))
                  ) STORED,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_items_user_idx   ON knowledge_items(user_id);
CREATE INDEX knowledge_items_type_idx   ON knowledge_items(type);
CREATE INDEX knowledge_items_tags_gin   ON knowledge_items USING gin(tags);
CREATE INDEX knowledge_items_tsv_gin    ON knowledge_items USING gin(tsv);
CREATE INDEX knowledge_items_shared_idx ON knowledge_items(org_id) WHERE shared_with_org = true;

-- Idempotency for ingestion sources. Partial so user-authored items (source_id
-- NULL) can be created freely.
CREATE UNIQUE INDEX knowledge_items_source_dedup
  ON knowledge_items (user_id, source, source_id)
  WHERE source_id IS NOT NULL;

ALTER TABLE knowledge_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_items_select ON knowledge_items FOR SELECT
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND (
      user_id = current_setting('app.current_user_id', true)::uuid
      OR shared_with_org = true
    )
  );

CREATE POLICY knowledge_items_insert ON knowledge_items FOR INSERT
  WITH CHECK (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

CREATE POLICY knowledge_items_update ON knowledge_items FOR UPDATE
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

CREATE POLICY knowledge_items_delete ON knowledge_items FOR DELETE
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_items TO command_center_app;
