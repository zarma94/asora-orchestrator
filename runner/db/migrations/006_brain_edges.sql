-- Lightweight knowledge graph: typed relations over the brain, for MULTI-HOP relational
-- queries that flat [[wikilinks]] can't answer ("who connects to ACME Stake", "what's blocked
-- by X"). NOT a graph DB, NOT a replacement for the wiki — a queryable edge table the LLM fills
-- from the wiki (graph-build) and reads at query time. Edges are trust:unverified like any
-- LLM-derived fact; the wiki page stays the source of truth.
CREATE TABLE IF NOT EXISTS brain_edges (
  id          bigserial PRIMARY KEY,
  project     text NOT NULL,
  subject     text NOT NULL,                 -- entity (person, company, project, contract, deal…)
  relation    text NOT NULL,                 -- owns | part-of | works-with | party-to | depends-on | blocks | introduced-by | located-in | involves | contradicts | related-to
  object      text NOT NULL,
  note        text NULL,                      -- short qualifier (amount, date, role)
  source_page text NULL,                      -- wiki page the edge was derived from
  trust       text NOT NULL DEFAULT 'unverified',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS brain_edges_uq  ON brain_edges (project, lower(subject), relation, lower(object));
CREATE INDEX IF NOT EXISTS brain_edges_subj ON brain_edges (lower(subject));
CREATE INDEX IF NOT EXISTS brain_edges_obj  ON brain_edges (lower(object));
CREATE INDEX IF NOT EXISTS brain_edges_proj ON brain_edges (project);
