// Dashboard + actions surface. This is the ONLY part of the API meant to be
// reachable from a browser, so nginx exposes just /dash and /api/actions
// publicly; /api/jobs and /api/ops stay loopback-only.
//
// Auth (either):
//   - browser: DASH_TOKEN via ?token= (once) → HttpOnly Secure cookie thereafter
//   - programmatic (orchestrator/Cowork): Bearer ORCH_RUNNER_KEY
// Reads/writes only the actions table — no job/ops powers. Zero Anthropic tokens.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { presentedKey, keyMatches, makeRateLimiter } from './apikey.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const json = (res, body, status = 200) => res.status(status).json(body);
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cookieToken(req) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'dash') return decodeURIComponent(v.join('='));
  }
  return '';
}

const addSchema = z.object({
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().max(2000).optional(),
  project: z.string().trim().max(60).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  due_at: z.string().datetime({ offset: true }).optional(),
});
const patchSchema = z.object({
  status: z.enum(['todo', 'doing', 'waiting', 'done', 'dismissed']).optional(),
  due_at: z.string().datetime({ offset: true }).optional(),
}).refine((o) => o.status || o.due_at, { message: 'nothing to change' });

export function makeDashRouter({ actions, dashToken, runnerKey }) {
  const router = express.Router();
  const rateOk = makeRateLimiter({ max: 600 }); // a polling dashboard is chatty
  let html = '<!doctype html><meta charset=utf-8><title>ASORA</title><body>Dashboard not deployed (dash/index.html missing). API is fine.</body>';
  try { html = fs.readFileSync(path.join(HERE, '..', 'dash', 'index.html'), 'utf8'); } catch { /* dash optional — never crash the API */ }

  const authed = (req) =>
    (dashToken && (cookieToken(req) === dashToken || String(req.query.token || '') === dashToken)) ||
    keyMatches(presentedKey(req), runnerKey);

  router.use((req, res, next) => {
    if (!rateOk(req.socket.remoteAddress || 'unknown')) return json(res, { error: 'too many requests' }, 429);
    next();
  });

  // Landing: ?token= sets the cookie once, then serves the app on the clean URL.
  router.get('/dash', (req, res) => {
    if (dashToken && String(req.query.token || '') === dashToken) {
      res.setHeader('Set-Cookie',
        `dash=${encodeURIComponent(dashToken)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`);
      return res.redirect('/dash');
    }
    if (!authed(req)) return res.status(401).type('html').send('<p>Unauthorized. Open with <code>?token=…</code>.</p>');
    res.type('html').send(html);
  });

  router.get('/dash/data', async (req, res) => {
    if (!authed(req)) return json(res, { error: 'unauthorized' }, 401);
    try {
      const [open, doneToday, stats] = await Promise.all([actions.list({}), actions.doneToday(), actions.stats()]);
      return json(res, { open, doneToday, stats, now: new Date().toISOString() });
    } catch { return json(res, { error: 'request failed' }, 500); }
  });

  router.get('/api/actions', async (req, res) => {
    if (!authed(req)) return json(res, { error: 'unauthorized' }, 401);
    try {
      const list = await actions.list({
        status: req.query.status ? String(req.query.status) : undefined,
        source: req.query.source ? String(req.query.source) : undefined,
        project: req.query.project ? String(req.query.project) : undefined,
        includeDone: req.query.includeDone === 'true',
      });
      return json(res, { actions: list });
    } catch { return json(res, { error: 'request failed' }, 500); }
  });

  router.post('/api/actions', async (req, res) => {
    if (!authed(req)) return json(res, { error: 'unauthorized' }, 401);
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) return json(res, { error: 'invalid request' }, 400);
    try {
      const action = await actions.addManual(parsed.data);
      return json(res, { action }, 201);
    } catch { return json(res, { error: 'request failed' }, 500); }
  });

  router.patch('/api/actions/:id', async (req, res) => {
    if (!authed(req)) return json(res, { error: 'unauthorized' }, 401);
    if (!uuidRe.test(req.params.id)) return json(res, { error: 'not found' }, 404);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return json(res, { error: 'invalid request' }, 400);
    try {
      const action = parsed.data.status
        ? await actions.setStatus(req.params.id, parsed.data.status, 'dash')
        : await actions.snooze(req.params.id, parsed.data.due_at, 'dash');
      return action ? json(res, { action }) : json(res, { error: 'not found' }, 404);
    } catch { return json(res, { error: 'request failed' }, 500); }
  });

  return router;
}
