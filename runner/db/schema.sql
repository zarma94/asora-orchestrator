-- Orchestrator Jobs API — schema (idempotent; run via npm run migrate)
-- Same discipline as the EMS spine: no delete, every transition audited.

CREATE TABLE IF NOT EXISTS jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project       text NOT NULL,
  type          text NOT NULL,
  prompt        text NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed','needs_approval')),
  priority      int  NOT NULL DEFAULT 0,
  run_at        timestamptz NULL,             -- null = now
  result        jsonb NULL,
  session_id    text NULL,                    -- claude -p session for --resume
  artifacts     jsonb NULL,                   -- [{path, bytes}] under ARTIFACTS_DIR/<job id>
  error         text NULL,
  attempts      int  NOT NULL DEFAULT 0,
  schedule_key  text NULL,                    -- '<schedule id>:<YYYY-MM-DD>' for recurring dedupe
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One job per recurring-schedule occurrence, ever.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_schedule_key_uq ON jobs (schedule_key) WHERE schedule_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (status, run_at, priority DESC, created_at);

-- Append-only audit of every status transition. No update/delete path exists in code.
CREATE TABLE IF NOT EXISTS job_events (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs(id),
  from_status text NULL,
  to_status   text NOT NULL,
  actor       text NOT NULL,                  -- 'api' | 'runner' | 'scheduler'
  note        text NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events (job_id, created_at);

-- Mail-triage bookkeeping: mail is fetched read-only (PEEK, never marked seen),
-- so successfully-handled (mailbox, uid) pairs are recorded here to avoid
-- re-filing the same todos every hour. Failed filings are NOT recorded → retried.
CREATE TABLE IF NOT EXISTS processed_mail (
  mailbox      text NOT NULL,
  uid          text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox, uid)
);
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
