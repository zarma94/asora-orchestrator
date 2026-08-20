// Jobs API entrypoint — binds 127.0.0.1 only. TLS/exposure is host nginx's job.
// Also mounts the ops-runner surface (/api/ops) when OPS_API_KEY is set.
import { loadEnv } from './env.js';
import { makePgStore } from './store.js';
import { makeOpsStore } from './ops-store.js';
import { makePgActionsStore } from './actions-store.js';
import { makeRegistry } from './registry.js';
import { makeTelegram } from './telegram.js';
import { makeApi } from './api.js';
import { makeAccess } from './access.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadEnv();
const store = makePgStore(cfg.DATABASE_URL);
const actions = makePgActionsStore(cfg.DATABASE_URL);
const registry = makeRegistry({
  orchestratorDir: cfg.ORCHESTRATOR_DIR,
  docsRoot: cfg.DOCS_ROOT,
  reposDir: cfg.REPOS_DIR,
  brainDir: cfg.BRAIN_DIR,
  configPath: path.join(HERE, '..', 'config', 'projects.json'),
  localConfigPath: cfg.PROJECTS_LOCAL,
});

// Ops-runner: enabled only when OPS_API_KEY is configured. The API process only
// ENQUEUES ops rows (and notifies the owner on destructive verbs); the separate
// orchestrator-ops service executes them.
let ops = null;
if (cfg.OPS_API_KEY) {
  const opsStore = makeOpsStore(cfg.DATABASE_URL);
  // Approval now surfaces in SLACK (the slack-listener polls awaiting_approval ops and posts
  // Approve/Reject buttons to the holding channel) — no Telegram alert. notify = no-op.
  ops = { opsStore, opsApiKey: cfg.OPS_API_KEY, notify: () => {} };
}

const app = makeApi({ store, apiKey: cfg.ORCH_RUNNER_KEY, registry, ops, actions, dashToken: cfg.DASH_TOKEN, access: makeAccess({ configPath: cfg.ACCESS_CONFIG }) });
app.listen(cfg.API_PORT, cfg.API_HOST, () => {
  console.error(`jobs api listening on ${cfg.API_HOST}:${cfg.API_PORT}${ops ? ' (+ /api/ops)' : ''}`
    + `${cfg.DASH_TOKEN ? ' (+ /dash)' : ' (dash: no token set)'}`);
});
