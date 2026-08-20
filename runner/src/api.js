// Jobs API — same spine as the EMS Tasks API: key-gated (Bearer or x-api-key,
// timing-safe), rate-limited, zod-validated, generic errors, no delete.
// Binds 127.0.0.1 only (server.js); TLS is host nginx's job.
//
// The ops-runner surface (/api/ops) is mounted FIRST with its OWN key
// (OPS_API_KEY) so the Jobs-API key (ORCH_RUNNER_KEY) never authorizes ops and
// vice-versa. See ops-api.js.
import express from 'express';
import { z } from 'zod';
import { STATUSES } from './transitions.js';
import { presentedKey, keyMatches, makeRateLimiter } from './apikey.js';
import { makeOpsRouter } from './ops-api.js';
import { makeDashRouter } from './dash-api.js';

export { presentedKey }; // re-export for backwards compatibility

const json = (res, body, status = 200) => res.status(status).json(body);

const createSchema = z.object({
  project: z.string().trim().min(1).max(100),
  type: z.string().trim().min(1).max(60),
  prompt: z.string().trim().min(1).max(20_000),
  priority: z.number().int().min(-100).max(100).optional(),
  run_at: z.string().datetime({ offset: true }).optional(),
});

const patchSchema = z.object({
  status: z.enum(['queued', 'done']), // approve (needs_approval→queued|done) or retry (failed→queued)
  note: z.string().trim().max(1000).optional(),
});

export function makeApi({ store, apiKey, registry, ops, actions, dashToken, access = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Ops-runner surface — its own key + auth, mounted before the Jobs auth so
  // /api/ops requests are fully handled here and never see ORCH_RUNNER_KEY.
  if (ops && ops.opsStore && ops.opsApiKey) {
    app.use('/api/ops', makeOpsRouter(ops));
  }

  // Dashboard + actions surface — own cookie/token auth (or the runner key),
  // mounted before the Jobs guard. This is the only browser-facing surface;
  // nginx publishes only /dash and /api/actions.
  if (actions) {
    app.use(makeDashRouter({ actions, dashToken, runnerKey: apiKey }));
  }

  const rateOk = makeRateLimiter();
  app.use((req, res, next) => {
    if (!rateOk(req.socket.remoteAddress || 'unknown')) return json(res, { error: 'too many requests' }, 429);
    const presented = presentedKey(req);
    if (keyMatches(presented, apiKey)) { req.principal = { role: 'owner' }; return next(); }
    // Non-owner keys: deterministic role lookup (sha256 hash in ACCESS_CONFIG).
    // Default-deny: no match → 401. Restricted principals never reach owner routes.
    const role = access?.apiKeyRole(presented) ?? null;
    if (role) { req.principal = { role, restricted: true }; return next(); }
    return json(res, { error: 'unauthorized' }, 401);
  });

  app.get('/api/health', (_req, res) => json(res, { ok: true }));

  app.post('/api/jobs', async (req, res) => {
    if (req.principal?.restricted) {
      // Restricted role: the ONLY thing it can create is a restricted question.
      // Type/prompt are coerced server-side — client-supplied type is ignored.
      const q = String(req.body?.prompt ?? '').trim().slice(0, 4000);
      if (!q) return json(res, { error: 'invalid request' }, 400);
      console.error(`[access] role=${req.principal.role} ask (api)`);
      const job = await store.createJob({ project: 'orchestrator', type: 'converse-restricted', prompt: `ROLE: ${req.principal.role}\nQUESTION: ${q}` }, 'api');
      return json(res, { job: { id: job.id, status: job.status } }, 201);
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return json(res, { error: 'invalid request' }, 400);
    try {
      if (registry && !(await registry.has(parsed.data.project))) return json(res, { error: 'unknown project' }, 400);
      const job = await store.createJob(parsed.data, 'api');
      return json(res, { job }, 201);
    } catch {
      return json(res, { error: 'request failed' }, 500);
    }
  });

  app.get('/api/jobs', async (req, res) => {
    if (req.principal?.restricted) return json(res, { error: 'forbidden' }, 403); // no listing for restricted roles
    const { status, project, type } = req.query;
    if (status && !STATUSES.includes(String(status))) return json(res, { error: 'invalid request' }, 400);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    try {
      const jobs = await store.listJobs({
        status: status ? String(status) : undefined,
        project: project ? String(project) : undefined,
        type: type ? String(type) : undefined,
        limit, offset,
      });
      return json(res, { jobs, limit, offset });
    } catch {
      return json(res, { error: 'request failed' }, 500);
    }
  });

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  app.get('/api/jobs/:id', async (req, res) => {
    if (!uuidRe.test(req.params.id)) return json(res, { error: 'not found' }, 404);
    const job = await store.getJob(req.params.id).catch(() => null);
    if (!job) return json(res, { error: 'not found' }, 404);
    if (req.principal?.restricted) {
      // A restricted role may only read its OWN restricted questions.
      const mine = job.type === 'converse-restricted' && String(job.prompt || '').startsWith(`ROLE: ${req.principal.role}\n`);
      if (!mine) return json(res, { error: 'not found' }, 404);
      return json(res, { job: { id: job.id, status: job.status, result: job.result?.text ?? null, error: job.error } });
    }
    return json(res, { job });
  });

  app.patch('/api/jobs/:id', async (req, res) => {
    if (req.principal?.restricted) return json(res, { error: 'forbidden' }, 403);
    if (!uuidRe.test(req.params.id)) return json(res, { error: 'not found' }, 404);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return json(res, { error: 'invalid request' }, 400);
    try {
      const job = await store.transition(req.params.id, parsed.data.status, 'api', { note: parsed.data.note ?? 'via API' });
      if (!job) return json(res, { error: 'invalid transition' }, 409);
      return json(res, { job });
    } catch {
      return json(res, { error: 'request failed' }, 500);
    }
  });

  // Anything else (incl. DELETE): generic 404. No delete endpoint by design.
  app.use((_req, res) => json(res, { error: 'not found' }, 404));

  return app;
}
