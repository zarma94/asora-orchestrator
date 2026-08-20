-- Unified personal action board: "what the owner has to do", aggregated from every
-- source (manual, mail triage, EMS tasks, orchestrator job approvals, chat).
-- The dashboard reads this table directly (zero Anthropic tokens); the
-- orchestrator upserts into it. Idempotent per (source, source_ref).

CREATE TABLE IF NOT EXISTS actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,                 -- manual | mail | ems | job | brief | chat
  source_ref   text NULL,                     -- ems task id · 'mailbox:uid' · job id · null (manual)
  title        text NOT NULL,
  detail       text NULL,
  project      text NULL,                      -- slug (free text; not FK — sources vary)
  status       text NOT NULL DEFAULT 'todo'
               CHECK (status IN ('todo','doing','waiting','done','dismissed')),
  needs_me     boolean NOT NULL DEFAULT true,  -- false = orchestrator can/does handle it
  priority     int NOT NULL DEFAULT 0,
  due_at       timestamptz NULL,
  link         text NULL,                      -- deep link back to origin (EMS card, etc.)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per external item; lets sync upsert without duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS actions_source_ref_uq
  ON actions (source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS actions_board_idx ON actions (status, needs_me, priority DESC, created_at);

-- Append-only audit of status changes (matches the jobs/ops discipline).
CREATE TABLE IF NOT EXISTS action_events (
  id          bigserial PRIMARY KEY,
  action_id   uuid NOT NULL REFERENCES actions(id),
  from_status text NULL,
  to_status   text NOT NULL,
  actor       text NOT NULL,                   -- 'dash' (the owner) | 'orchestrator' | 'sync'
  note        text NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_events_action_idx ON action_events (action_id, created_at);
