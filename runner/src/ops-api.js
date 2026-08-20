// Ops-runner API — mounted at /api/ops, authed with OPS_API_KEY (SEPARATE from
// the Jobs API's ORCH_RUNNER_KEY). No IP-allowlist on this box (caller = Cowork
// on a dynamic cloud IP); the compensating control is the human approval on
// destructive verbs. Verb allow-list validated server-side; unknown → hard 400.
// No delete. Every call audited via the store.
import express from 'express';
import { z } from 'zod';
import { presentedKey, keyMatches, makeRateLimiter } from './apikey.js';
import { VERB_NAMES, isDestructive } from './ops.js';

const json = (res, body, status = 200) => res.status(status).json(body);
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({
  verb: z.enum(VERB_NAMES),                 // allow-list: unknown verb → hard reject
  params: z.record(z.any()).optional(),
});

// Approval PATCH: the ONLY way an awaiting_approval job reaches 'queued'.
const patchSchema = z.object({
  status: z.literal('queued'),
  approved_by: z.string().trim().min(1).max(120).optional(),
});

export function makeOpsRouter({ opsStore, opsApiKey, notify }) {
  const router = express.Router();
  const rateOk = makeRateLimiter();

  router.use((req, res, next) => {
    if (!rateOk(req.socket.remoteAddress || 'unknown')) return json(res, { error: 'too many requests' }, 429);
    if (!keyMatches(presentedKey(req), opsApiKey)) return json(res, { error: 'unauthorized' }, 401);
    next();
  });

  // POST /api/ops  {verb, params?}
  router.post('/', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return json(res, { error: 'invalid request' }, 400); // unknown verb lands here
    const { verb, params } = parsed.data;
    if (params && Object.keys(params).length) return json(res, { error: 'verb takes no params' }, 400);
    const destructive = isDestructive(verb);
    const status = destructive ? 'awaiting_approval' : 'queued';
    try {
      const job = await opsStore.createOpsJob({ verb, params: {}, status }, 'api');
      if (destructive && typeof notify === 'function') {
        Promise.resolve(notify(job)).catch(() => {}); // fire-and-forget; never blocks or leaks
      }
      return json(res, { job }, 201);
    } catch {
      return json(res, { error: 'request failed' }, 500);
    }
  });

  // GET /api/ops?status=&verb=
  router.get('/', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    try {
      const jobs = await opsStore.listOpsJobs({
        status: req.query.status ? String(req.query.status) : undefined,
        verb: req.query.verb ? String(req.query.verb) : undefined,
        limit, offset,
      });
      return json(res, { jobs, limit, offset });
    } catch {
      return json(res, { error: 'request failed' }, 500);
    }
  });

  // GET /api/ops/:id
  router.get('/:id', async (req, res) => {
    if (!uuidRe.test(req.params.id)) return json(res, { error: 'not found' }, 404);
    const job = await opsStore.getOpsJob(req.params.id).catch(() => null);
    return job ? json(res, { job }) : json(res, { error: 'not found' }, 404);
  });

  // PATCH /api/ops/:id  {status:"queued", approved_by?}  ← human approval only
  router.patch('/:id', async (req, res) => {
    if (!uuidRe.test(req.params.id)) return json(res, { error: 'not found' }, 404);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return json(res, { error: 'invalid request' }, 400);
    try {
      const job = await opsStore.approveOps(req.params.id, parsed.data.approved_by ?? 'matt-patch');
      if (!job) return json(res, { error: 'invalid transition' }, 409); // not awaiting_approval
      return json(res, { job });
    } catch {
      return json(res, { error: 'request failed' }, 500);
    }
  });

  // Anything else (incl. DELETE): generic 404. No delete endpoint by design.
  router.use((_req, res) => json(res, { error: 'not found' }, 404));

  return router;
}
