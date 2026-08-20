// Ops-runner verb executor for the ORCHESTRATOR box itself (YOUR_SERVER_IP).
// Lets Cowork dispatch a FIXED allow-list of vetted ops (status / sync-restart /
// migrate) instead of a human SSHing in. No arbitrary exec — only named verbs,
// each a fixed routine. Runs as the dedicated non-root user `orch-ops` under a
// tightly-scoped sudoers (deploy/orchestrator-ops.sudoers) — never the API user.
//
// ================================ PRE-MORTEM ================================
// Top risks (this box has NO IP-allowlist — the caller is Cowork on a dynamic
// cloud IP) and the concrete guard for each:
//
//  1. VERB ALLOW-LIST BYPASS → VERBS below is a closed map. Both the API
//     (ops-api.js: z.enum(VERB_NAMES)) and this executor reject any verb not in
//     it (hard 400 / fail-closed 'unknown verb'). Verbs take NO shell input:
//     every command is a fixed argv run via execFile (shell:false) — nothing
//     from params is ever interpolated into a command.
//  2. SUDOERS TOO BROAD → the executor only ever runs the exact argvs in CMDS
//     below, and deploy/orchestrator-ops.sudoers whitelists those 1:1 with no
//     wildcards and no user-supplied arguments. `status` needs no sudo at all.
//     Keep CMDS and the sudoers file in lockstep (both list absolute paths).
//  3. LEAKED OPS_API_KEY → with no IP-allowlist, the compensating control is the
//     HUMAN one-tap approval on EVERY destructive verb: sync-restart/migrate are
//     created 'awaiting_approval' and can only reach 'queued' via the approve
//     PATCH. A leaked key can read `status` or *request* a restart, but can
//     never execute one. Plus: timing-safe key compare, generic errors, every
//     call audited in ops_job_events. (Fast-follow: short-lived signed tokens.)
//  4. SELF-RESTART KILLING THE IN-FLIGHT JOB → sync-restart restarts ONLY
//     orchestrator-runner + orchestrator-api, never orchestrator-ops. This
//     executor is a separate service, so it survives the restart and writes the
//     result straight to Postgres (also unaffected) — the job always reaches
//     done/failed.
//  5. MIGRATION FAILURE → `migrate` is `npm run migrate` = idempotent
//     CREATE ... IF NOT EXISTS, and it restarts NOTHING. On non-zero exit the job
//     goes 'failed' with captured (redacted) stderr; no partial/destructive
//     state, safe to re-run.
// ===========================================================================

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

// Absolute binary paths. Verify on the box with `command -v <bin>` and, if any
// differ, update BOTH here and deploy/orchestrator-ops.sudoers (they must match).
export const PATHS = {
  npm: '/usr/bin/npm',
  rsync: '/usr/bin/rsync',
  systemctl: '/usr/bin/systemctl',
  sudo: '/usr/bin/sudo',
  env: '/usr/bin/env',
};

const SRC = '/mnt/nextcloud/Orchestrator/runner'; // read-only NC mount (source of truth)
const DST = '/opt/orchestrator/runner';           // deploy dir (owned by `orchestrator`)
const ENV_FILE = '/opt/orchestrator/.env';        // root:orchestrator 640 — holds DATABASE_URL
const RUNAS = 'orchestrator';                     // file ops run as this user (correct ownership)
const RSYNC_DIRS = ['src', 'bin', 'jobtypes', 'config'];

// Exact argvs — MUST match deploy/orchestrator-ops.sudoers 1:1.
export const CMDS = {
  rsyncDir: (name) => [PATHS.sudo, '-u', RUNAS, PATHS.rsync, '-a', '--delete', `${SRC}/${name}/`, `${DST}/${name}/`],
  rsyncPkg: [PATHS.sudo, '-u', RUNAS, PATHS.rsync, '-a', `${SRC}/package.json`, `${DST}/package.json`],
  npmInstall: [PATHS.sudo, '-u', RUNAS, PATHS.npm, 'install', '--omit=dev', '--prefix', DST],
  migrate: [PATHS.sudo, '-u', RUNAS, PATHS.env, `ORCH_ENV_FILE=${ENV_FILE}`, PATHS.npm, '--prefix', DST, 'run', 'migrate'],
  restart: [PATHS.sudo, PATHS.systemctl, 'restart', 'orchestrator-runner', 'orchestrator-api'],
  isActive: [PATHS.systemctl, 'is-active', 'orchestrator-api', 'orchestrator-runner'],
};

// execFile-based command runner (NO shell), fixed timeout, both streams captured.
export function makeRunCmd({ defaultTimeoutMs = 180_000 } = {}) {
  return (argv, { timeoutMs = defaultTimeoutMs } = {}) =>
    new Promise((resolve) => {
      execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut: Boolean(err && err.killed),
        });
      });
    });
}

const tail = (s, n = 800) => (s ? String(s).trim().slice(-n) : '');
function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

// ---- Verb routines (each does exactly one vetted thing) ----

async function runStatus({ runCmd, store }) {
  const r = await runCmd(CMDS.isActive, { timeoutMs: 15_000 }); // non-zero if any inactive — that's fine
  const lines = r.stdout.trim().split('\n');
  const services = {
    'orchestrator-api': (lines[0] || 'unknown').trim(),
    'orchestrator-runner': (lines[1] || 'unknown').trim(),
  };
  const ops_queue = await store.countsByStatus();
  const jobs_queue = await store.jobsQueueDepth();
  const last = await store.lastFinished();
  return {
    ok: true,
    verb: 'status',
    services,
    ops_queue,
    jobs_queue,
    last_ops_job: last ? { id: last.id, verb: last.verb, status: last.status, at: last.updated_at } : null,
    checked_at: new Date().toISOString(),
  };
}

async function runSyncRestart({ runCmd }) {
  const steps = [];
  const fail = (msg) => ({ ok: false, verb: 'sync-restart', error: msg, steps });
  const pkgDst = `${DST}/package.json`;
  const before = sha256File(pkgDst);

  for (const d of RSYNC_DIRS) {
    const r = await runCmd(CMDS.rsyncDir(d), { timeoutMs: 120_000 });
    steps.push({ step: `rsync ${d}`, code: r.code, err: r.code ? tail(r.stderr) : undefined });
    if (r.code) return fail(`rsync ${d} failed`);
  }
  const rp = await runCmd(CMDS.rsyncPkg, { timeoutMs: 60_000 });
  steps.push({ step: 'rsync package.json', code: rp.code, err: rp.code ? tail(rp.stderr) : undefined });
  if (rp.code) return fail('rsync package.json failed');

  const after = sha256File(pkgDst);
  const pkgChanged = before !== after;
  if (pkgChanged) {
    const ni = await runCmd(CMDS.npmInstall, { timeoutMs: 300_000 });
    steps.push({ step: 'npm install --omit=dev', code: ni.code, err: ni.code ? tail(ni.stderr) : undefined });
    if (ni.code) return fail('npm install failed');
  } else {
    steps.push({ step: 'npm install', skipped: true, reason: 'package.json unchanged' });
  }

  // Restarts orchestrator-runner + orchestrator-api ONLY (never orchestrator-ops):
  // this executor survives and records the outcome below (pre-mortem #4).
  const rs = await runCmd(CMDS.restart, { timeoutMs: 60_000 });
  steps.push({ step: 'systemctl restart runner+api', code: rs.code, err: rs.code ? tail(rs.stderr) : undefined });
  if (rs.code) return fail('service restart failed');

  return { ok: true, verb: 'sync-restart', pkgChanged, steps };
}

async function runMigrate({ runCmd }) {
  const r = await runCmd(CMDS.migrate, { timeoutMs: 120_000 });
  if (r.code) return { ok: false, verb: 'migrate', code: r.code, error: tail(r.stderr) || tail(r.stdout) };
  return { ok: true, verb: 'migrate', output: tail(r.stdout) };
}

// Closed verb allow-list. Anything not here is rejected at both the API and the
// executor (defense in depth).
export const VERBS = {
  status: { destructive: false, run: runStatus },
  'sync-restart': { destructive: true, run: runSyncRestart },
  migrate: { destructive: true, run: runMigrate },
};
export const VERB_NAMES = Object.keys(VERBS);
export function isDestructive(verb) { return Boolean(VERBS[verb]?.destructive); }

// The executor loop (poller model): claim → run the matching verb → write result.
// Concurrency 1: destructive ops never overlap.
export function makeOpsExecutor({ opsStore, runCmd, redact = (x) => x, log = console.error }) {
  let stopped = false;
  let inFlight = false;

  async function runOne(job) {
    const def = VERBS[job.verb];
    if (!def) { // allow-list guard (pre-mortem #1) — should never happen (API validated)
      await opsStore.transitionOps(job.id, 'failed', 'ops', { result: { ok: false, error: 'unknown verb' }, note: 'rejected: not in allow-list' });
      return;
    }
    if (def.destructive && !job.approved_by) { // fail-closed (pre-mortem #3)
      await opsStore.transitionOps(job.id, 'failed', 'ops', { result: { ok: false, error: 'destructive verb reached executor without approval' }, note: 'fail-closed' });
      return;
    }
    try {
      const result = await def.run({ job, runCmd, store: opsStore, redact });
      const to = result && result.ok !== false ? 'done' : 'failed';
      await opsStore.transitionOps(job.id, to, 'ops', { result: redact(result), note: `verb ${job.verb} ${to}` });
    } catch (e) {
      await opsStore.transitionOps(job.id, 'failed', 'ops', { result: { ok: false, error: redact(String(e && e.message || e)) }, note: 'verb threw' });
    }
  }

  async function tick() {
    if (inFlight || stopped) return;
    const job = await opsStore.claimNextOps();
    if (!job) return;
    inFlight = true;
    try { await runOne(job); } finally { inFlight = false; }
  }

  return {
    runOne, // exported for tests
    tick,
    start(pollSec = 10) {
      const t = setInterval(() => tick().catch((e) => log(`ops tick failed: ${e.message}`)), pollSec * 1000);
      tick().catch(() => {});
      return () => { stopped = true; clearInterval(t); };
    },
  };
}
