-- Migration 003 — brain full-text search (recall layer). Idempotent.
-- ASORA was grep-only; this adds ranked Postgres FTS over the per-project wiki pages so
-- agents retrieve the RIGHT pages instead of blind grep. Native Postgres FTS — no new
-- dependency, no API key. 'simple' config = language-agnostic (EN/DE/SL mix). Access-capped
-- at query time (deterministic, same policy as the brain). No delete path beyond reindex.
CREATE TABLE IF NOT EXISTS brain_pages (
  id         serial PRIMARY KEY,
  project    text NOT NULL,
  path       text NOT NULL,                        -- rel path under the project wiki
  title      text NULL,
  access     text NOT NULL DEFAULT 'internal',
  body       text NOT NULL DEFAULT '',
  tsv        tsvector GENERATED ALWAYS AS (
               setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
               setweight(to_tsvector('simple', coalesce(body, '')),  'B')
             ) STORED,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project, path)
);
CREATE INDEX IF NOT EXISTS brain_pages_tsv_idx     ON brain_pages USING GIN (tsv);
CREATE INDEX IF NOT EXISTS brain_pages_project_idx ON brain_pages (project);
