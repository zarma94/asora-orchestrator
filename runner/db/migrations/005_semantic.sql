-- Migration 005 — semantic recall. Store a per-page embedding vector (local fastembed model,
-- no API key) so retrieval can concept-match beyond keywords. jsonb array of floats; cosine is
-- computed in Node (small corpus, no pgvector dependency). NULL until embedded; re-embedded when
-- a page's body changes. Idempotent.
ALTER TABLE brain_pages ADD COLUMN IF NOT EXISTS embedding jsonb;
