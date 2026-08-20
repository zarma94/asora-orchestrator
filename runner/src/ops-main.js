// Ops-runner executor entrypoint. Runs as the DEDICATED NON-ROOT user `orch-ops`
// (systemd: orchestrator-ops.service), NOT as the API/runner user. Its env is
// /opt/orchestrator/ops.env — DATABASE_URL only, NO ORCH_RUNNER_KEY / OPS_API_KEY
// / EMS / Telegram / Anthropic secret (no verb needs them). It polls ops_jobs,
// runs the matching vetted verb (via the scoped sudoers), writes the result.
import { loadEnv } from './env.js';
import { makeOpsStore } from './ops-store.js';
import { makeRedactor } from './redact.js';
import { makeOpsExecutor, makeRunCmd } from './ops.js';

// requireKey:false — this process never holds the API key; it only needs the DB.
const cfg = loadEnv({ requireKey: false });
const opsStore = makeOpsStore(cfg.DATABASE_URL);
const redact = makeRedactor([cfg.DATABASE_URL]); // scrub the DB URL from any persisted result
const runCmd = makeRunCmd();
const executor = makeOpsExecutor({ opsStore, runCmd, redact });

const pollSec = cfg.POLL_INTERVAL_SEC || 15;
const stop = executor.start(pollSec);
console.error(`ops executor up: poll=${pollSec}s (verbs: status, sync-restart, migrate)`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stop();
    opsStore.close().finally(() => process.exit(0));
  });
}
