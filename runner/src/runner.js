// The runner loop: claim → resolve project → deterministic pre → claude in the
// project folder → parse/redact → deterministic post → outcome. Idempotent and
// resumable: session_id survives crashes; stale 'running' jobs requeue.
import fs from 'node:fs';
import path from 'node:path';
import { READ_TOOLS, WRITE_TOOLS } from './jobtypes.js';
import { commitIfChanged } from './gitops.js';
import { runLadder, runDelegation } from './ladder.js';

function listArtifacts(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push({ path: p, bytes: fs.statSync(p).size });
    }
  };
  walk(dir);
  return out.slice(0, 200);
}

export function makeRunner({ cfg, store, registry, jobTypes, execute, redact, log = console.error }) {
  let inFlight = 0;
  let stopped = false;

  async function runJob(job) {
    const typeDef = jobTypes[job.type] ?? null;

    // Resolve the working directory. Typed jobs may pin cwd to the orchestrator
    // meta-project; otherwise the job's project decides.
    const projSlug = typeDef?.cwd === 'orchestrator' ? 'orchestrator' : job.project;
    const proj = await registry.get(projSlug);
    if (!proj || !fs.existsSync(proj.cwd)) {
      await store.transition(job.id, 'failed', 'runner', { error: `unknown or missing project folder: ${projSlug}` });
      return;
    }

    const artifactsDir = path.join(cfg.ARTIFACTS_DIR, job.id);
    fs.mkdirSync(artifactsDir, { recursive: true });

    try {
      // Ladder job type: run the full hub→subagent→specialists→auditor→send-gate
      // pipeline in-process (multiple claude calls). Short-circuits the single-shot path.
      if (typeDef?.ladder) {
        // `delegate` = company-level: the CEO routes to employee(s) then synthesises.
        // `ladder` = project/employee-level: one subagent through the full chain.
        const out = job.type === 'delegate'
          ? await runDelegation({ job, company: (String(job.prompt || '').match(/^COMPANY:\s*([a-z0-9-]+)/i) || [])[1] || null, registry, cfg, execute, redact, artifactsDir, log, store })
          : await runLadder({ job, proj, cfg, execute, redact, artifactsDir, log, store });
        await store.transition(job.id, out.outcome, 'runner', {
          result: out.result, session_id: out.session_id,
          artifacts: listArtifacts(artifactsDir), note: out.note,
        });
        return;
      }

      // 1 · deterministic pre-step (runner-side creds; claude never sees them)
      const pre = typeDef?.pre ? await typeDef.pre(job, { store }) : null;

      // Deterministic job types run pre → post with NO claude call at all
      // (structurally zero Anthropic tokens — e.g. ems-sync).
      if (typeDef?.deterministic) {
        const post = typeDef.post ? redact(await typeDef.post(job, { result: '' }, null, pre, { store })) : null;
        await store.transition(job.id, typeDef.outcome ? typeDef.outcome({}, null) : 'done', 'runner', {
          result: { deterministic: true, pre: redact(pre), post },
          note: 'completed (deterministic)',
        });
        return;
      }

      // 2 · prompt + tool policy
      const prompt = typeDef?.prompt
        ? typeDef.prompt(job, pre)
        : `${job.prompt}\n\nIf you produce files, write them under: ${artifactsDir}`;
      const tools = typeDef?.tools
        ? typeDef.tools(job)
        : (proj.write_mode === 'read-only' ? READ_TOOLS : WRITE_TOOLS);

      // MODEL for this job: per-type override → heavy/light sets by type name → default.
      const HEAVY = new Set(['ingest','ingest-pilot','research','decision','premortem','pre-mortem','auditor','audit','brain-eval-set','pageindex-build','contract-builder']);
      const LIGHT = new Set(['ems-sync','mail-triage','ems-hygiene']);
      const model = typeDef?.model
        ?? (HEAVY.has(job.type) ? cfg.CLAUDE_HEAVY_MODEL
           : LIGHT.has(job.type) ? cfg.CLAUDE_LIGHT_MODEL
           : cfg.CLAUDE_DEFAULT_MODEL);
      // 3 · claude in the project folder (scrubbed env, timeout, budget cap)
      const res = await execute({
        bin: cfg.CLAUDE_BIN,
        cwd: proj.cwd,
        prompt,
        sessionId: job.session_id,
        agentFile: proj.agentFile,
        allowedTools: tools,
        timeoutMin: cfg.JOB_TIMEOUT_MIN,
        maxBudgetUsd: cfg.JOB_MAX_BUDGET_USD,
        env: { ORCH_ARTIFACTS_DIR: artifactsDir },
        model,
      });

      res.result = redact(String(res.result ?? ''));

      if (res.isError) {
        await store.transition(job.id, 'failed', 'runner', {
          error: redact(`claude reported error (exit ${res.exitCode})`),
          session_id: res.sessionId, result: { text: res.result },
        });
        return;
      }

      // 4 · structured output + deterministic post-step (validated fields only)
      const structured = typeDef?.parse ? typeDef.parse(res.result) : null;
      const post = typeDef?.post ? redact(await typeDef.post(job, res, structured, pre, { store })) : null;

      // 5 · write-back checkpoint for git-mode projects
      let checkpoint = null;
      if (proj.write_mode === 'git') {
        checkpoint = await commitIfChanged(proj.cwd, `orchestrator job ${job.id} (${job.type})`).catch((e) => ({ committed: false, reason: e.message }));
      }

      // 6 · outcome
      const outcome = typeDef?.outcome ? typeDef.outcome(res, structured) : 'done';
      await store.transition(job.id, outcome, 'runner', {
        result: { text: res.result, structured, post, checkpoint, cost_usd: res.costUsd },
        session_id: res.sessionId,
        artifacts: listArtifacts(artifactsDir),
        note: outcome === 'needs_approval' ? 'draft awaiting the owner' : 'completed',
      });
    } catch (e) {
      // Transient path: retry once (attempts was already bumped at claim).
      const msg = redact(String(e.message || e));
      if (job.attempts < 2) {
        await store.transition(job.id, 'queued', 'runner', { error: msg, note: 'transient failure — retrying once' });
      } else {
        await store.transition(job.id, 'failed', 'runner', { error: msg });
      }
    }
  }

  async function tick() {
    await store.requeueStale(cfg.STALE_RUNNING_MIN).catch((e) => log(`stale requeue failed: ${e.message}`));
    while (!stopped && inFlight < cfg.RUNNER_CONCURRENCY) {
      const job = await store.claimNext();
      if (!job) break;
      inFlight += 1;
      runJob(job)
        .catch((e) => log(`job ${job.id} crashed: ${e.message}`))
        .finally(() => { inFlight -= 1; });
    }
  }

  return {
    runJob, // exported for tests
    tick,
    start() {
      const t = setInterval(() => tick().catch((e) => log(`tick failed: ${e.message}`)), cfg.POLL_INTERVAL_SEC * 1000);
      tick().catch(() => {});
      return () => { stopped = true; clearInterval(t); };
    },
  };
}
