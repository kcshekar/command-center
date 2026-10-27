-- N14: the dependency inventory ("memory of dependencies"). Rebuilt for a
-- lockfile only when its hash changes; the weekly scan checks these
-- name@version pairs against OSV.dev. Worker-private, like Gmail cursors.
CREATE TABLE dep_lockfiles (
  path       text PRIMARY KEY,           -- relative to the repo root, e.g. "bun.lock"
  sha256     text NOT NULL,
  packages   int NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dep_inventory (
  lockfile text NOT NULL REFERENCES dep_lockfiles(path) ON DELETE CASCADE,
  name     text NOT NULL,
  version  text NOT NULL,
  PRIMARY KEY (lockfile, name, version)
);
