-- Migration 001 — ops-runner tables. Idempotent; applied by `npm run migrate`
-- AFTER db/schema.sql. Kept identical to the ops_jobs block in db/schema.sql.
-- ============================ ops-runner ============================
-- Queue for the ops-runner: a FIXED verb allow-list (status / sync-restart /
-- migrate) the orchestrator can dispatch on its OWN box. Destructive verbs land
-- 'awaiting_approval' and need a human tap. No delete; every transition audited.
CREATE TABLE IF NOT EXISTS ops_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verb        text NOT NULL,
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','awaiting_approval','running','done','failed')),
  result      jsonb NULL,
  approved_by text NULL,                       -- who tapped approve (destructive verbs)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ops_jobs_claim_idx ON ops_jobs (status, created_at);

-- Append-only audit of every ops-job transition. No update/delete path in code.
CREATE TABLE IF NOT EXISTS ops_job_events (
  id          bigserial PRIMARY KEY,
  ops_job_id  uuid NOT NULL REFERENCES ops_jobs(id),
  from_status text NULL,
  to_status   text NOT NULL,
  actor       text NOT NULL,                   -- 'api' (enqueue/approve) | 'ops' (executor)
  note        text NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ops_job_events_job_idx ON ops_job_events (ops_job_id, created_at);
