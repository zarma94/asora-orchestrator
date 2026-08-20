// Shared API-key auth helpers (used by both the Jobs API and the ops router).
// Timing-safe compare, fail-closed on any empty/mismatched key.
import { timingSafeEqual } from 'node:crypto';

export function presentedKey(req) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const xkey = req.headers['x-api-key'];
  return typeof xkey === 'string' ? xkey.trim() : '';
}

export function keyMatches(presented, expected) {
  if (!presented || !expected) return false; // fail closed
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Minimal fixed-window per-IP rate limit (same pattern as the Jobs API).
export function makeRateLimiter({ windowMs = 60_000, max = 240 } = {}) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const slot = hits.get(ip);
    if (!slot || now - slot.start > windowMs) {
      hits.set(ip, { start: now, n: 1 });
      return true;
    }
    slot.n += 1;
    return slot.n <= max;
  };
}
