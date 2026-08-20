# ASORA ingest instance — installer

Turns a clean(ish) Ubuntu/Debian server with docker into a self-contained ASORA
ingest brain: it sweeps a documents tree, routes every document with an LLM, and
stores the facts into per-project markdown wikis under `/opt/orchestrator/brain/`.

## What it installs
- system user `orchestrator`, everything under `/opt/orchestrator/`
- Node 20 (NodeSource, only if missing) + the runner (`npm ci`, express/pg/zod)
- python extractors (markitdown, pdfplumber, **pdfminer.six ≥ 20251107** — CVE-2025-64512 floor)
- postgres 16 in docker: container `asora-db`, **127.0.0.1:5434**, volume `asora-pgdata`
- systemd: `orchestrator-api` (loopback :8787), `orchestrator-runner` (resource-capped
  MemoryMax=3G/CPUQuota=150%), `orchestrator-telegram` (only enabled if a token is set)
- claude CLI (auth is YOUR step: `sudo -u orchestrator claude login` or an API key)

Non-invasive by design: loopback-only ports, unique names, no firewall/nginx changes —
safe next to an existing stack (e.g. the ACME EMS).

## Install
```bash
tar xzf asora-ingest-installer-*.tar.gz && cd asora-ingest-installer
sudo bash install.sh --check     # preflight only
sudo bash install.sh             # install (idempotent; .env never overwritten)
```
Then follow the 3 printed steps: claude auth → set `INGEST_SOURCE_DIRS` → dry-run → start.

## How ingest behaves (governance is baked in)
- **Backfill**: `ingest-sweep` copies batches (default 20) from `INGEST_SOURCE_DIRS`
  into the inbox — **source originals are never modified** — then self-requeues every
  ~3 min until the whole corpus is drained. Hourly schedule keeps it current after that:
  changed files re-sweep (mtime) and reconcile as UPDATEs (latest-wins).
- **Routing**: the LLM router sends each doc to an existing project, creates a NEW
  project brain under a master company when confident, asks the owner on Telegram when
  not, and parks noise in `inbox/_unrouted/`.
- **Storage**: every fact lands `trust: unverified` with a source pointer; a verified
  fact is NEVER overwritten — contradictions go to a `## DISPUTED` block.
- **No silent loss**: a doc is manifest-marked only when its store job SUCCEEDS;
  routed originals are preserved in `inbox/_done/`.
- **No autonomous deletes, no outbound sends.** The API listens on loopback only.

## Access control (hardcoded roles)
Enforcement is a **deterministic policy layer outside the model** (OWASP LLM02:2025 /
NIST 800-207 default-deny): the LLM never decides authorization, and restricted users'
model calls run with **no tools** — only pre-filtered context is injected, so the model
physically cannot see what the role cannot see.

- Rules live in `/opt/orchestrator/access.json` — **root-owned**; the runner reads it but
  can never write it. Missing file / unknown principal / unlabeled page ⇒ **deny**.
- A role = allowed projects + clearance levels (`public < sales < internal < management`)
  + actions (`ask`). Wiki pages carry `access: <level>` frontmatter (ingest writes it;
  unlabeled ⇒ `internal`).
- Principals: Telegram chat ids (restricted users may ONLY ask questions — every command
  or document is rejected with "Access denied") and API keys (stored as sha256 hashes;
  such keys can only create restricted questions and read their own answers).
- Example: a salesperson mapped to role `sales` asking about company financials gets
  "I don't have access to that information." — the financial pages (`internal`/
  `management`) were never in their model's context at all. All denials are logged.

## Per-company Telegram bots (optional)
Run a separate bot per company/project so each lives in its own chat thread. It's N bot
front-ends over ONE shared brain/runner backend.
- Edit `/opt/orchestrator/bots.json` (root-owned): each key is a `BOT_NAME` → `{token,
  chat_id, company, projects[], label}`. Create the bot in **@BotFather** for the token;
  `chat_id` is the owner's numeric id.
- Start it: `systemctl enable --now orchestrator-telegram@<name>` (one process per bot).
- Each bot is **scoped**: `/do`, `/pending`, `/propose`, `/newproject` only touch its
  `projects`; out-of-scope ids are refused ("belongs to another company's bot").
- The default single bot (`TELEGRAM_*` in `.env`, service `orchestrator-telegram`) still
  runs and covers ALL projects — leave it or disable it once per-company bots are up.

## Slack front-end (optional — recommended for a multi-company org)
Channel-per-project/company, with the org structure as your sidebar. Same backend; Socket
Mode means no public endpoint.
1. Create a Slack workspace + an app (api.slack.com/apps → From scratch).
2. Socket Mode ON → App-Level Token (`xapp-…`, scope `connections:write`).
3. Bot Token Scopes: `chat:write`, `commands`, `channels:history`, `channels:read`,
   `groups:history`, `groups:read`, `app_mentions:read`, `files:read`. Install → Bot Token (`xoxb-…`).
4. Slash commands: `/do /propose /pending /approve /reject /remember` (Request URL unused in
   Socket Mode — any placeholder). Enable Interactivity (buttons).
5. Event Subscriptions (bot): `message.channels`, `message.groups`, `app_mention`.
6. Put both tokens in `.env` (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`), map channels in
   `/opt/orchestrator/channels.json` (root-owned; channel id → project/company scope), invite
   the bot to each channel, then `systemctl enable --now orchestrator-slack`.
- A **project channel** acts on one project; a **company channel** (`kind:"company"`) is the CEO —
  `/do` delegates to the team, `/propose` spans the company; a **holding channel** spans everything.
- `needs_approval` results arrive with **Approve/Reject buttons**. Plain messages are answered AND
  run through the **salience gate** (important chatter → brain; casual → ignored).

## Day-2
- Watch: `journalctl -u orchestrator-runner -f` · brain: `/opt/orchestrator/brain/<slug>/wiki/`
- Jobs API: `curl -s -H "Authorization: Bearer $KEY" 127.0.0.1:8787/api/jobs`
- New master companies / instance identity: `INGEST_COMPANIES` in `.env` (JSON)
- Upgrade: extract the new tarball, `sudo bash install.sh` again (code is replaced,
  `.env`, brain, manifests and the local project overlay survive)
- Auto-created projects live in `/opt/orchestrator/projects.local.json`; promote
  permanent ones into `hub/projects/REGISTRY.md`

## Known limits (deliberate)
- Scanned/image PDFs are parked in `_unrouted/` (no OCR yet)
- Telegram document uploads cap at 20 MB (bot API); sweep files cap at 50 MB
- Sweep skips `_archive/`, hidden and 0-byte files, and files modified < 60 s ago
