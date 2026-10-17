-- Legacy credential table superseded by external_credentials (migration 0002).
-- Code stopped reading it when A1 shipped. gmail_history_cursors has a FK to it
-- that we drop first; the cursor data (last_history_id) stays, now keyed by
-- user_email as a plain text column with no referential link to the
-- credential store (ponytail: external_credentials has a composite PK that
-- can't be a simple FK target; the cursor is a weak-reference lookup).

ALTER TABLE gmail_history_cursors DROP CONSTRAINT IF EXISTS gmail_history_cursors_user_email_fkey;
DROP TABLE IF EXISTS google_oauth_tokens;
