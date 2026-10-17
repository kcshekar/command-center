-- H5a: single-row table holding the worker's own OAuth2 client credentials
-- for calling CC's mint endpoint. The install script seeds it; CC's rotation
-- UI replaces it over localhost. Enforces one row via a check-less singleton
-- pattern (DELETE + INSERT on rotate; UPSERT with fixed id otherwise).

CREATE TABLE worker_identity (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  client_id     text NOT NULL,
  client_secret text NOT NULL,
  cc_base_url   text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
