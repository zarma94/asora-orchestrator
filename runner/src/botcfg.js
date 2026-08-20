// Multi-bot config resolution — pure, side-effect-free (safe to import in tests).
// A listener process picks its bot via BOT_NAME → an entry in bots.json (per-company
// token + owner chat + project scope). No BOT_NAME → the single TELEGRAM_* bot over
// the whole brain (backward-compatible).
import fs from 'node:fs';

export function resolveBot(env, config) {
  const name = env.BOT_NAME || config.BOT_NAME || '';
  if (name) {
    let bots;
    try { bots = JSON.parse(fs.readFileSync(config.BOTS_CONFIG, 'utf8')); }
    catch (e) { return { fatal: `cannot read ${config.BOTS_CONFIG}: ${e.message}` }; }
    const b = bots[name];
    if (!b || !b.token || !b.chat_id) return { fatal: `bot '${name}' missing/invalid in ${config.BOTS_CONFIG}` };
    return { name, token: b.token, chat: String(b.chat_id), projects: Array.isArray(b.projects) ? b.projects : [], company: b.company || null, label: b.label || name };
  }
  return { name: 'main', token: config.TELEGRAM_BOT_TOKEN, chat: String(config.TELEGRAM_CHAT_ID || ''), projects: [], company: null, label: 'main' };
}

/** Is `project` within this bot's scope? Empty/absent scope = whole brain. */
export function inScope(project, scope) { return !scope || scope.length === 0 || scope.includes(project); }
