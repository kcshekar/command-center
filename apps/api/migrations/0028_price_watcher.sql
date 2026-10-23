-- Phase 2.1b (A6): user-triggered product price watchlist.
--
--   price_watches  — one row per URL the user asked us to watch
--   price_history  — append-only time-series of (watch, timestamp, price)
--
-- A watch is created when the user POSTs a product URL. The worker fetches
-- the current price via Keepa (Amazon) or a per-site fallback, writes the
-- first history point, and the daily poll workflow adds more. Verdict
-- (buy / fair / wait / target) is computed from price_history percentiles
-- at read time; we store the most-recent verdict on price_watches so the
-- UI avoids a window query on every refresh.
--
-- price_history has no org_id/user_id column; RLS uses an EXISTS subquery
-- against price_watches so the tenant check follows the parent.

CREATE TABLE price_watches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  url              text NOT NULL,
  source           text NOT NULL,                           -- 'amazon' | 'flipkart' | 'generic'
  external_id      text,                                    -- ASIN for amazon, SKU/pid for flipkart
  title            text,
  image_url        text,

  currency         text NOT NULL DEFAULT 'INR',
  target_price     numeric(12,2),                           -- optional user-set threshold
  current_price    numeric(12,2),
  current_verdict  text,                                    -- 'buy' | 'fair' | 'wait' | 'target' | NULL
  last_checked_at  timestamptz,

  paused           boolean NOT NULL DEFAULT false,
  note             text,                                    -- user memo
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, url)                                     -- no duplicate watches on the same URL per user
);

CREATE INDEX price_watches_user_idx    ON price_watches(user_id);
CREATE INDEX price_watches_source_ext  ON price_watches(source, external_id);
CREATE INDEX price_watches_due_poll_idx ON price_watches(last_checked_at) WHERE paused = false;

ALTER TABLE price_watches ENABLE ROW LEVEL SECURITY;
CREATE POLICY price_watches_tenant ON price_watches
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON price_watches TO command_center_app;


CREATE TABLE price_history (
  id          bigserial PRIMARY KEY,
  watch_id    uuid NOT NULL REFERENCES price_watches(id) ON DELETE CASCADE,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  price       numeric(12,2) NOT NULL,
  source_meta jsonb NOT NULL DEFAULT '{}'::jsonb            -- raw bits of what the fetcher returned
);

CREATE INDEX price_history_watch_time_idx ON price_history(watch_id, checked_at DESC);

ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY price_history_tenant ON price_history
  USING (
    EXISTS (
      SELECT 1 FROM price_watches w
      WHERE w.id      = price_history.watch_id
        AND w.org_id  = current_setting('app.current_org_id',  true)::uuid
        AND w.user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON price_history TO command_center_app;
GRANT USAGE, SELECT ON SEQUENCE price_history_id_seq TO command_center_app;
