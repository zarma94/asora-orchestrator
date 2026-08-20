-- Migration 004 — cross-session recall. Idempotent.
-- Indexes past conversational/task jobs (Q + A) so agents can recall "what did we decide about X"
-- across sessions — the FTS5 session-search Hermes has, on Postgres. Native FTS, no API key.
CREATE TABLE IF NOT EXISTS session_index (
  job_id  uuid PRIMARY KEY,
  type    text NOT NULL,
  project text NULL,
  ts      timestamptz NOT NULL DEFAULT now(),
  body    text NOT NULL DEFAULT '',
  tsv     tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED
);
CREATE INDEX IF NOT EXISTS session_index_tsv_idx ON session_index USING GIN (tsv);
CREATE INDEX IF NOT EXISTS session_index_ts_idx  ON session_index (ts DESC);
