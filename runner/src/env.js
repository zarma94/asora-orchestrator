// Environment loading — fail closed. The API/runner refuse to start without the
// auth key and DB URL. Secrets never leave this module except where explicitly
// consumed; the claude subprocess gets a scrubbed environment (see claude.js).
import fs from 'node:fs';
import path from 'node:path';

function loadDotenv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function loadEnv({ requireKey = true } = {}) {
  const fileEnv = loadDotenv(process.env.ORCH_ENV_FILE || path.join(process.cwd(), '.env'));

  // NC secrets overlay (guarded): the Nextcloud-synced secrets file may only
  // FILL variables absent from both the box .env and the process env — never
  // override them. The mount is cloud-writable upstream, so box config always
  // wins; to let NC supply a var, omit it from the box .env entirely.
  const docsRoot = process.env.DOCS_ROOT || fileEnv.DOCS_ROOT || '';
  const ncFile = process.env.ORCH_NC_SECRETS_FILE || fileEnv.ORCH_NC_SECRETS_FILE
    || (docsRoot ? path.join(docsRoot, 'Orchestrator', 'secrets', 'orchestrator-runner.env') : '');
  const ncEnv = ncFile ? loadDotenv(ncFile) : {};
  const ncUsed = Object.keys(ncEnv).filter((k) => !(k in fileEnv) && !(k in process.env)).sort();

  const env = { ...Object.fromEntries(ncUsed.map((k) => [k, ncEnv[k]])), ...fileEnv, ...process.env };

  const cfg = {
    DATABASE_URL: env.DATABASE_URL || '',
    ORCH_RUNNER_KEY: env.ORCH_RUNNER_KEY || '',
    OPS_API_KEY: env.OPS_API_KEY || '',        // ops-runner surface (/api/ops); SEPARATE from ORCH_RUNNER_KEY. Empty ⇒ /api/ops disabled.
    API_HOST: env.API_HOST || '127.0.0.1', // localhost-only; TLS is host nginx's job
    API_PORT: Number(env.API_PORT || 8787),
    // Paths
    DOCS_ROOT: env.DOCS_ROOT || '',                    // NC mount root (read-only), holds ASORA/, ACME/, Orchestrator/, ...
    ORCHESTRATOR_DIR: env.ORCHESTRATOR_DIR || (env.DOCS_ROOT ? path.join(env.DOCS_ROOT, 'Orchestrator') : ''),
    REPOS_DIR: env.REPOS_DIR || '/opt/orchestrator/repos',        // git clones (writable)
    BRAIN_DIR: env.BRAIN_DIR || '/opt/orchestrator/brain',        // box-owned WRITABLE wiki (backed up to NC). raw is symlinked in RO.
    ARTIFACTS_DIR: env.ARTIFACTS_DIR || '/opt/orchestrator/artifacts',
    INGEST_INBOX: env.INGEST_INBOX || '/opt/orchestrator/inbox',   // drop files here to ingest into the brain
    INGEST_DIR: env.INGEST_DIR || '/opt/orchestrator/ingest',      // processed-manifest location
    // Access labelling is DETERMINISTIC (never the model's call): ingested pages get this level,
    // never 'public'. Per-project overrides via PROJECT_ACCESS json (e.g. money/legal → management).
    // Local embedder for semantic search (fastembed venv). Empty = semantic off (FTS still works).
    EMBED_PYTHON: env.EMBED_PYTHON || (fs.existsSync('/home/orchestrator/.venvs/embed/bin/python') ? '/home/orchestrator/.venvs/embed/bin/python' : ''),
    // Local voice transcriber (faster-whisper venv). Empty = voice notes not transcribed.
    WHISPER_PYTHON: env.WHISPER_PYTHON || (fs.existsSync('/home/orchestrator/.venvs/whisper/bin/python') ? '/home/orchestrator/.venvs/whisper/bin/python' : ''),
    INGEST_ACCESS_DEFAULT: env.INGEST_ACCESS_DEFAULT || 'internal',
    PROJECT_ACCESS: (() => { try { return JSON.parse(env.PROJECT_ACCESS || '{}'); } catch { return {}; } })(),
    // Gated dev-exec targets — NEVER hardcode a host in the code. {"<name>":{host,user,key,desc}}.
    DEV_TARGETS: (() => { try { return JSON.parse(env.DEV_TARGETS || '{}'); } catch { return {}; } })(),
    // Ingest source-adapter: Gmail/IMAP attachments (Phase 2a; reuses ~/.mail app-password creds)
    INGEST_MAIL_ACCOUNTS: env.INGEST_MAIL_ACCOUNTS || 'gmail,ceg', // mail.py accounts to pull attachments from
    INGEST_MAIL_DAYS: env.INGEST_MAIL_DAYS || '7',                 // SINCE window (string; passed to the fetcher)
    INGEST_MAIL_SENDERS: env.INGEST_MAIL_SENDERS || '',            // optional From-substring allow-list (comma-sep); '' = all senders
    // BOX-authoritative project overlay (auto-created projects); outside the runner dir so deploys never clobber it
    PROJECTS_LOCAL: env.PROJECTS_LOCAL || '/opt/orchestrator/projects.local.json',
    // SampleCo live book — read-only, key-gated dashboard API (real Hyperliquid). Reports R/% only.
    ALPHADESK_BOOK: env.ALPHADESK_BOOK || 'http://THIRD_SERVER_IP:8801/api/book?key=mzk-f21',
    // Backfill sweeper (client installs): colon-separated READ-ONLY source roots; '' = disabled
    INGEST_SOURCE_DIRS: env.INGEST_SOURCE_DIRS || '',
    INGEST_SWEEP_BATCH: Number(env.INGEST_SWEEP_BATCH || 20),
    // Hardcoded access rules (roles/telegram ids/api-key hashes). ROOT-owned file —
    // the runner user must never be able to write it. Missing file = owner-only.
    ACCESS_CONFIG: env.ACCESS_CONFIG || '/opt/orchestrator/access.json',
    // Multi-bot: per-company Telegram bots. ROOT-owned bots.json maps a bot NAME →
    // {token, chat_id, projects[], company}. A listener process picks its bot via
    // BOT_NAME; absent → falls back to the single TELEGRAM_* bot (whole brain).
    BOTS_CONFIG: env.BOTS_CONFIG || '/opt/orchestrator/bots.json',
    BOT_NAME: env.BOT_NAME || '',
    // Slack front-end (Socket Mode). Tokens ROOT-owned in .env; channel→scope map in channels.json.
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN || '',   // xoxb-…
    SLACK_APP_TOKEN: env.SLACK_APP_TOKEN || '',   // xapp-… (connections:write)
    CHANNELS_CONFIG: env.CHANNELS_CONFIG || '/opt/orchestrator/channels.json',
    // Runner behavior
    CLAUDE_BIN: env.CLAUDE_BIN || 'claude',
    // Model policy (CLI aliases, so they track the current version). Runner picks per job type;
    // subscription auth means these consume Max-plan usage, not $ — heavier model = more usage.
    CLAUDE_DEFAULT_MODEL: env.CLAUDE_DEFAULT_MODEL || 'sonnet',
    CLAUDE_HEAVY_MODEL: env.CLAUDE_HEAVY_MODEL || 'opus',
    CLAUDE_LIGHT_MODEL: env.CLAUDE_LIGHT_MODEL || 'haiku',
    RUNNER_CONCURRENCY: Number(env.RUNNER_CONCURRENCY || 2),
    JOB_TIMEOUT_MIN: Number(env.JOB_TIMEOUT_MIN || 30),
    JOB_MAX_BUDGET_USD: Number(env.JOB_MAX_BUDGET_USD || 5),
    STALE_RUNNING_MIN: Number(env.STALE_RUNNING_MIN || 45),
    POLL_INTERVAL_SEC: Number(env.POLL_INTERVAL_SEC || 15),
    SCHEDULE_TZ: env.SCHEDULE_TZ || 'Europe/Ljubljana',
    EMS_HYGIENE_APPLY: env.EMS_HYGIENE_APPLY === 'true', // opt-in: hygiene may PATCH task statuses
    MAIL_DIR: env.MAIL_DIR || '',                        // default ~/.mail (mailops.js)
    PYTHON_BIN: env.PYTHON_BIN || 'python3',
    // CalDAV (read-only, daily brief). Same app-password as the NC WebDAV mount.
    CALDAV_URL: env.CALDAV_URL || '',
    CALDAV_USER: env.CALDAV_USER || '',
    CALDAV_PASS: env.CALDAV_PASS || '',
    // Comma-separated names the brief EXPECTS; missing ones get flagged, never guessed.
    CALDAV_EXPECTED: env.CALDAV_EXPECTED || 'gmail-personal,mzk,ceg',
    // Integrations (all optional; features disable cleanly without them)
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || '',
    CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN || '',
    EMS_BASE_URL: env.EMS_BASE_URL || '',
    EMS_TASKS_API_KEY: env.EMS_TASKS_API_KEY || '',
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID || '',
    DASH_TOKEN: env.DASH_TOKEN || '',                    // dashboard access token (browser cookie)
  };

  cfg.NC_SECRETS_KEYS = ncUsed; // key NAMES loaded from the NC overlay (logged; values never)

  if (!cfg.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (requireKey && !cfg.ORCH_RUNNER_KEY) throw new Error('ORCH_RUNNER_KEY is required (fail closed — no key, no service)');
  // Claude auth vars must reach the subprocess allowlist (claude.js reads
  // process.env, .env is only file-loaded). Subscription login via ~/.claude
  // credentials needs neither — HOME is already passed through.
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    if (cfg[k] && !process.env[k]) process.env[k] = cfg[k];
  }
  return cfg;
}

/** Every secret value that must never appear in logs, results, or artifacts. */
export function secretValues(cfg) {
  return [cfg.ORCH_RUNNER_KEY, cfg.OPS_API_KEY, cfg.EMS_TASKS_API_KEY, cfg.TELEGRAM_BOT_TOKEN, cfg.ANTHROPIC_API_KEY,
    cfg.CLAUDE_CODE_OAUTH_TOKEN, cfg.CALDAV_PASS, cfg.DASH_TOKEN, cfg.DATABASE_URL]
    .filter((v) => v && v.length >= 8);
}
