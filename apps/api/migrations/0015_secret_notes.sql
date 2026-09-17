-- Optional per-secret note, encrypted with the same project DEK as the
-- value. Nullable so existing rows stay valid; a note-less secret leaves
-- both columns NULL.
ALTER TABLE secrets ADD COLUMN note_ciphertext bytea;
ALTER TABLE secrets ADD COLUMN note_iv bytea;
