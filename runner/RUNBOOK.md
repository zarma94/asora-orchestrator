---
type: note
title: Orchestrator Runner — RUNBOOK
---
# Orchestrator Runner — RUNBOOK

The always-on "hands" of the ACME Orchestrator: a Jobs API (Postgres, key-authed, audited, no delete) + a runner that executes `claude -p` inside the right project folder, + a scheduler for recurring jobs. Cowork/the owner decide and approve; this box only executes. **It can never send to a client** — drafts end as `needs_approval`.

Architecture: `Orchestrator/BRAIN.md` §4/§8. Build brief: `Orchestrator/SERVER-BUILD-BRIEF.md`. Security discipline mirrors `ASORA/clients/ACME/ops/SERVER.md`.

## Layout on the box

```
/opt/orchestrator/
├── runner/          this repo (code)          — rsync'd from NC or git-cloned
├── .env             secrets, root:orchestrator 640 → see .env.example
├── repos/           writable git clones (write_mode=git projects only)
└── artifacts/       per-job file outputs (<job-id>/…)
/mnt/nextcloud/      rclone NC mount — READ-ONLY, always
~orchestrator/.mail/ the owner's mail tooling + creds (600) — for mail-triage
```

## Provisioning (once, new dedicated VPS)

1. **Harden first**, exactly per `ops/SERVER.md`: key-only SSH + drop-in `00-*.conf`, UFW default-deny + 22/80/443, fail2ban, unattended-upgrades, sysctl set, Docker hardened if used. Then create user `orchestrator` (no sudo).
2. Install: node ≥20, python3, git, rclone, the `claude` CLI. AUTH = SUBSCRIPTION via `claude login` (see step 4) — do NOT put ANTHROPIC_API_KEY in `.env` (that would switch to paid API billing).
3. **Mount Nextcloud READ-ONLY** (this is the write-back trap guard — the Mac mirror would silently revert any direct NC write):
   ```
   rclone mount nextcloud: /mnt/nextcloud --read-only --vfs-cache-mode minimal --daemon
   ```
   rclone.conf comes from the Mac (`~/.config/rclone/rclone.conf` [nextcloud] section), root-owned 600. Add a systemd mount/automount unit so it survives reboot.
4. Postgres: `docker compose -f deploy/docker-compose.postgres.yml up -d` (password in `/opt/orchestrator/.env.compose`, 600). Then `npm run migrate`. On YOUR_SERVER_IP it binds 127.0.0.1:**5433** (5432 would clash with cbd-crm's db).
   **Claude auth = subscription, not API key:** as the service user run `claude login` once (`sudo -u orchestrator -H claude login`); OAuth persists in `/home/orchestrator/.claude` and auto-refreshes. Leave ANTHROPIC_API_KEY commented out (setting it would switch billing to the API). Never `--bare` (breaks CLAUDE.md loading and forces API-key auth). Jobs consume Max-plan usage — keep RUNNER_CONCURRENCY small and schedules sensible.
5. Copy `runner/` to `/opt/orchestrator/runner`, `npm install --omit=dev`.
6. Fill `/opt/orchestrator/.env` from `.env.example` (`openssl rand -hex 32` for ORCH_RUNNER_KEY). Root-owned, 640 group `orchestrator`.
7. Deploy mail tooling: copy Mac `~/.mail/` → `~orchestrator/.mail/` (all files 600). Test read-only: `python3 ~/.mail/mail.py test`.
8. systemd: copy `deploy/*.service` → `/etc/systemd/system/`, `systemctl enable --now orchestrator-api orchestrator-runner`.
9. nginx (only if Cowork must reach the API from outside): proxy 443 → 127.0.0.1:8787, certbot cert, same pattern as SERVER.md. If Cowork reaches it another way, leave the API loopback-only.
10. Fill in `Orchestrator/infra/SERVER-ACCESS.md` (IP, SSH, mount path) — from the Mac, not from the box (one-way mirror!).

## Release gate (before real jobs)

- `npm test` green on the box (30 tests).
- `bash deploy/smoke.sh` — auth fail-closed, enqueue, no-delete.
- External `nmap`: only 22/80/443 open; **5432 and 8787 closed** (Docker-UFW trap check).
- Restore drill: `docker exec orchestrator-db pg_dump -U orchestrator orchestrator > backup.sql`, restore into a scratch DB, verify jobs rows.
- Mount check: `touch /mnt/nextcloud/x` must FAIL (read-only).

## Start / stop / observe

```
systemctl {start|stop|status} orchestrator-api orchestrator-runner
journalctl -u orchestrator-runner -f
```
Job states: `queued → running → done|failed|needs_approval`; `needs_approval → queued|done` (approval via PATCH); `failed → queued` (manual retry). Every transition is in `job_events`. A crashed job auto-requeues after STALE_RUNNING_MIN and resumes from its `session_id`; second loss → `failed`.

## The Jobs API (for Cowork)

Base URL + key handoff: `Orchestrator/secrets/orchestrator-runner.env` (template until provisioned). Auth: `Authorization: Bearer <ORCH_RUNNER_KEY>` or `x-api-key`.

```
POST  /api/jobs                {project, type, prompt, priority?, run_at?} → 201 {job}
GET   /api/jobs/:id            status + result
GET   /api/jobs?status=&project=&type=
PATCH /api/jobs/:id            {status: "queued"|"done", note?}   ← approve / retry only
```
`project` must exist in `projects/REGISTRY.md` (or `config/projects.json`). No delete. Errors are generic by design.

## Job types

| type | schedule | outcome | notes |
|---|---|---|---|
| `daily-brief` | 06:30 daily | done + Telegram to the owner | EMS open tasks + pending approvals + last mail triage; priority order from STATE-OF-EVERYTHING; ends "Focus today:" |
| `ems-hygiene` | 07:00 daily | done + Telegram | overdue/stalled/dupes; PATCHes statuses only if `EMS_HYGIENE_APPLY=true` |
| `mail-triage` | hourly :15 | done / needs_approval | runs the existing auto-clean first, then triages unread; todos → EMS boards, drafts → approval. Claude step gets Read-only tools and NO creds |
| `lead-followup` | per task (`run_at` = due date) | **always needs_approval** | draft in project folder w/ its brain; also filed as an `APPROVE:` EMS task |
| `ems-sync` | every 15 min | done | **deterministic — NO claude call, zero Anthropic tokens.** Pulls open EMS tasks into the action board; closes cards whose task is gone |
| anything else | ad-hoc | done | raw prompt in the project folder; tools per write_mode (read-only ⇒ Read/Glob/Grep only) |

## The action board (personal task dashboard)

One unified "what the owner has to do" board, fed from every source and served live from the box — **zero Anthropic tokens** to run/sync (the dashboard reads Postgres directly; syncs are plain API pulls; `ems-sync` is a deterministic job with no model call).

- **Data** → `actions` table (source: manual|mail|ems|job|brief|chat; idempotent per `(source, source_ref)`; status todo|doing|waiting|done|dismissed; audited via `action_events`).
- **Feeds** → `mail-triage` upserts actionable mail (drafts show as "waiting on your approval"); `ems-sync` mirrors open EMS tasks every 15 min; the owner adds tasks in the UI or Cowork POSTs them.
- **Dashboard** → `GET /dash` (self-contained HTML in `dash/index.html`, polls `/dash/data` every 15s, add/complete/dismiss/start). Auth: `DASH_TOKEN` via `?token=` once → HttpOnly Secure cookie. The browser surface **cannot** reach `/api/jobs` or `/api/ops` (dash cookie ≠ runner key).
- **Public exposure** → nginx publishes ONLY `/dash`, `/dash/data`, `/api/actions` on `orchestrator.asoracore.com` (DNS → YOUR_SERVER_IP). Jobs/ops stay loopback-only.
- **Deploy** → `ssh your-server 'bash -s' < deploy/deploy-dashboard.sh` (generates DASH_TOKEN if absent, migrates, restarts, enables the nginx site), then `certbot --nginx -d orchestrator.asoracore.com`. The script prints the tokenized dashboard URL.
- **Programmatic add** (Cowork/orchestrator): `POST /api/actions {title, detail?, project?, due_at?}` with the runner Bearer key.

## Add a job type

1. Prompt template → `jobtypes/<type>.md` (state: data-not-instructions, no-send, honesty, output format).
2. Entry in `src/jobtypes.js`: `pre` (deterministic fetch, runner-side creds), `tools`, `prompt`, optional `parse` (zod-validate any machine-consumed output — fail closed), `outcome`, `post` (EMS/Telegram on validated fields only).
3. Tests in `test/runner.test.js`; recurring → add to `config/schedule.json` (one file, tz-aware, idempotent per occurrence).

## Enable write-back for a project (default: everything read-only)

Per `infra/nextcloud.md` §2 — never write the one-way mirror:
- **git** (code + brains in a repo): clone into `/opt/orchestrator/repos/<slug>` (needs a git remote both Mac and box can reach), set `"<slug>": {"write_mode":"git"}` in `config/projects.json`. Runner commits after each job; Mac pulls.
- **two-way**: convert that folder to `rclone copy --update` push-back on the Mac FIRST (SampleGroup pattern), then `"write_mode":"two-way"` with a writable path.
Until then, jobs on read-only projects report brain changes as a `MEMORY UPDATE:` block in the result for the owner/Cowork to apply Mac-side.

## Rotate keys

- **ORCH_RUNNER_KEY**: `openssl rand -hex 32` → `/opt/orchestrator/.env` → restart both services → update Cowork's copy in `Orchestrator/secrets/orchestrator-runner.env` (Mac-side).
- **EMS key**: rotate in EMS Admin → Settings, update `.env`, restart runner. **Telegram/Anthropic**: same pattern. Old keys die on service restart; nothing caches them.

## Security invariants (do not weaken)

1. API loopback-only; fail-closed auth (no key → the service refuses to start); timing-safe compare; generic errors; rate-limited.
2. Claude job subprocess env is ALLOWLISTED: it sees only the Claude auth (the `claude login` OAuth token; ANTHROPIC_API_KEY only if deliberately set) + CLAUDE_CODE_ENTRYPOINT + the artifacts dir — never ORCH_RUNNER_KEY, EMS key, Telegram token, DATABASE_URL.
3. Untrusted content (mail, EMS tasks, lead text) reaches claude only as fenced DATA with Read-only tools; anything machine-actioned from its output is zod-validated (slug regex, enums, length caps) — invalid ⇒ nothing filed.
4. No send path exists: no WhatsApp, no SMTP (mzk token is IMAP-scope only), Telegram goes to the owner's fixed chat id from env. Drafts always `needs_approval`.
5. Secrets in root-owned files (600/640); redactor scrubs known secret values from every persisted result/error as last-resort defense.
6. NC mount read-only at the OS level; writes only via git clones or converted two-way folders.

## The ops-runner (`/api/ops`) — dispatch vetted ops on THIS box

Lets Cowork run a FIXED verb allow-list on the orchestrator's own box instead of a
human SSHing in. Same scoped pattern as the EMS ops-runner, but **no IP-allowlist**
(Cowork calls from a dynamic cloud IP) — the compensating control is a **human
one-tap approval on every destructive verb** plus a separate `OPS_API_KEY`.

Two processes, cleanly split so the network-facing API never holds sudo:
- **API** (`orchestrator-api`, user `orchestrator`) — only ENQUEUES ops rows and
  notifies the owner on destructive verbs. No sudo.
- **Executor** (`orchestrator-ops`, user `orch-ops`) — polls `ops_jobs`, runs the
  verb via a tightly-scoped sudoers. Its env (`/opt/orchestrator/ops.env`) holds
  `DATABASE_URL` only — no `OPS_API_KEY`, `ORCH_RUNNER_KEY`, EMS/Telegram/Anthropic.

### Contract

```
POST  /api/ops        {verb, params?}                    → 201 {job}
GET   /api/ops/:id                                         → {job}   (poll for result)
GET   /api/ops?status=&verb=                               → {jobs}
PATCH /api/ops/:id    {status:"queued", approved_by?}      ← human approve
```
Auth: `Authorization: Bearer <OPS_API_KEY>` (or `x-api-key`) — **separate key** from
`ORCH_RUNNER_KEY`. No delete. Every call audited in `ops_job_events`.

| verb | destructive? | on POST | routine |
|---|---|---|---|
| `status` | no (unattended) | `queued`, runs at once | `systemctl is-active` runner+api, ops/jobs queue depth, last ops outcome |
| `sync-restart` | **yes** | `awaiting_approval` | rsync `{src,bin,jobtypes,config,package.json}` NC→`/opt`; `npm install --omit=dev` iff package.json changed; `systemctl restart orchestrator-runner orchestrator-api` |
| `migrate` | **yes** | `awaiting_approval` | `npm run migrate` (idempotent) |

Verbs take **no params**. Unknown verb → hard 400. Destructive verb reaching the
executor without `approved_by` → fail-closed (never executes).

### One-time bootstrap (human runs ONCE on the box, as a sudo-capable admin)

Run **after** the base runner is deployed (RUNBOOK §Provisioning) and the NC mount
is up. First verify binary paths match `src/ops.js` / the sudoers:
`command -v node npm rsync systemctl env sudo` (all expected under `/usr/bin`; if any
differ, edit both `deploy/orchestrator-ops.sudoers` and `CMDS/PATHS` in `src/ops.js`).

```bash
# 0. refresh code on the box (as the deploy user) + apply the ops_jobs migration
sudo -u orchestrator rsync -a --delete /mnt/nextcloud/Orchestrator/runner/src/ /opt/orchestrator/runner/src/
sudo -u orchestrator rsync -a /mnt/nextcloud/Orchestrator/runner/db/ /opt/orchestrator/runner/db/
sudo -u orchestrator rsync -a /mnt/nextcloud/Orchestrator/runner/deploy/ /opt/orchestrator/runner/deploy/
sudo -u orchestrator ORCH_ENV_FILE=/opt/orchestrator/.env npm --prefix /opt/orchestrator/runner run migrate

# 1. OPS_API_KEY → /opt/orchestrator/.env  (SAME value Cowork will hold)
OPS=$(openssl rand -hex 32)
echo "OPS_API_KEY=$OPS" | sudo tee -a /opt/orchestrator/.env >/dev/null
echo "put this in Orchestrator/secrets/orchestrator-ops.env (Mac-side): $OPS"

# 2. dedicated non-root executor user (no shell, no login)
sudo useradd --system --no-create-home --shell /usr/sbin/nologin orch-ops

# 3. its minimal env (DATABASE_URL only; note port 5433 on this box)
sudo tee /opt/orchestrator/ops.env >/dev/null <<EOF2
DATABASE_URL=$(sudo grep -E '^DATABASE_URL=' /opt/orchestrator/.env | cut -d= -f2-)
DOCS_ROOT=/mnt/nextcloud
EOF2
sudo chown root:orch-ops /opt/orchestrator/ops.env && sudo chmod 640 /opt/orchestrator/ops.env

# 4. scoped sudoers (validate before trusting it)
sudo install -m 0440 -o root -g root /opt/orchestrator/runner/deploy/orchestrator-ops.sudoers /etc/sudoers.d/orchestrator-ops
sudo visudo -cf /etc/sudoers.d/orchestrator-ops

# 5. executor service
sudo cp /opt/orchestrator/runner/deploy/orchestrator-ops.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now orchestrator-ops

# 6. restart the API so /api/ops picks up OPS_API_KEY
sudo systemctl restart orchestrator-api

# 7. prove the loop (status self-test — unattended, no approval needed)
KEY=$(sudo grep -E '^OPS_API_KEY=' /opt/orchestrator/.env | cut -d= -f2-)
ID=$(curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"verb":"status"}' http://127.0.0.1:8787/api/ops | python3 -c 'import sys,json;print(json.load(sys.stdin)["job"]["id"])')
sleep 3
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8787/api/ops/$ID | python3 -m json.tool
```
Expect the status job at `done` with a `services` / `ops_queue` / `jobs_queue` result.
Then paste the key into `Orchestrator/secrets/orchestrator-ops.env` (Mac-side, one-way
mirror — never write it from the box).

### Approvals

Destructive verbs land `awaiting_approval`. If `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
are set, the owner gets a message with the job id; approve with
`PATCH /api/ops/<id> {"status":"queued","approved_by":"matt"}`. The executor then
claims and runs it. `sync-restart` restarts runner+api only — **never**
`orchestrator-ops` — so the executor survives and records the outcome.

### Rotate OPS_API_KEY
`openssl rand -hex 32` → `/opt/orchestrator/.env` → `systemctl restart orchestrator-api`
→ update `Orchestrator/secrets/orchestrator-ops.env` (Mac-side). The executor is
unaffected (it never holds the key).
