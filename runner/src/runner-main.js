// Runner entrypoint: one process runs the job loop + the scheduler tick.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, secretValues } from './env.js';
import { makePgStore } from './store.js';
import { makeRegistry } from './registry.js';
import { makeRedactor } from './redact.js';
import { makeEmsClient } from './ems.js';
import { makeTelegram } from './telegram.js';
import { makeMailOps } from './mailops.js';
import { makeBrainSearch } from './brainsearch.js';
import { makeCaldav } from './caldav.js';
import { makePgActionsStore } from './actions-store.js';
import { makeJobTypes } from './jobtypes.js';
import { makeRunner } from './runner.js';
import { makeScheduler } from './scheduler.js';
import { runClaude } from './claude.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadEnv();
const store = makePgStore(cfg.DATABASE_URL);
const registry = makeRegistry({
  orchestratorDir: cfg.ORCHESTRATOR_DIR,
  docsRoot: cfg.DOCS_ROOT,
  reposDir: cfg.REPOS_DIR,
  brainDir: cfg.BRAIN_DIR,
  configPath: path.join(HERE, '..', 'config', 'projects.json'),
  localConfigPath: cfg.PROJECTS_LOCAL,
});
const redact = makeRedactor(secretValues(cfg));
const ems = makeEmsClient({ baseUrl: cfg.EMS_BASE_URL, apiKey: cfg.EMS_TASKS_API_KEY });
const telegram = makeTelegram({ botToken: cfg.TELEGRAM_BOT_TOKEN, chatId: cfg.TELEGRAM_CHAT_ID });
const mailOps = makeMailOps({ ...(cfg.MAIL_DIR ? { mailDir: cfg.MAIL_DIR } : {}), pythonBin: cfg.PYTHON_BIN });
const caldav = makeCaldav({ baseUrl: cfg.CALDAV_URL, user: cfg.CALDAV_USER, pass: cfg.CALDAV_PASS });
const actions = makePgActionsStore(cfg.DATABASE_URL);
const brainSearch = makeBrainSearch(cfg.DATABASE_URL, cfg.BRAIN_DIR, cfg.EMBED_PYTHON);
const jobTypes = makeJobTypes({ cfg, ems, telegram, mailOps, registry, caldav, actions, brainSearch });

const runner = makeRunner({ cfg, store, registry, jobTypes, execute: runClaude, redact });
const scheduler = makeScheduler({ store, schedulePath: path.join(HERE, '..', 'config', 'schedule.json') });

const stopRunner = runner.start();
const stopScheduler = scheduler.start(60);
console.error(`runner up: concurrency=${cfg.RUNNER_CONCURRENCY}, poll=${cfg.POLL_INTERVAL_SEC}s, tz=${cfg.SCHEDULE_TZ}, telegram=${telegram.enabled ? 'enabled' : 'off'}, ems=${ems.enabled ? 'enabled' : 'off'}, caldav=${caldav.enabled ? 'enabled' : 'off'}, dash=${cfg.DASH_TOKEN ? 'enabled' : 'off'}, ncSecrets=${cfg.NC_SECRETS_KEYS.length ? cfg.NC_SECRETS_KEYS.join('+') : 'none'}`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopRunner();
    stopScheduler();
    store.close().finally(() => process.exit(0));
  });
}
