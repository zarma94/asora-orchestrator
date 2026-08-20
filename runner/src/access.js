// Deterministic access-control layer (hardcoded rules, enforced OUTSIDE the model).
// Research-locked design (OWASP LLM02:2025, NIST 800-207 default-deny, Progent/Minim):
//   - the LLM never decides authorization — this module does, in code, before any call;
//   - restricted principals never get retrieval tools — context is pre-filtered HERE
//     and injected, so the model cannot see what the role cannot see;
//   - fail-closed everywhere: unknown principal → deny; unlabeled page → 'internal';
//     missing/broken config → owner-only (no restricted access at all).
//
// Config: ACCESS_CONFIG json, ROOT-OWNED (the runner user must not be able to write it):
// {
//   "roles": {
//     "sales": { "projects": ["Sample Project"], "clearance": ["public", "sales"], "actions": ["ask"] }
//   },
//   "telegram": { "123456789": "sales" },
//   "api_keys": { "<sha256 hex of the key>": "sales" }
// }
// The owner needs no entry: ORCH_RUNNER_KEY and TELEGRAM_CHAT_ID stay the owner
// principal (full access, existing behavior). 'owner' cannot be assigned in config.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ACCESS_LEVELS = ['public', 'sales', 'internal', 'management']; // ascending sensitivity
const DEFAULT_LEVEL = 'internal'; // unlabeled page = internal (fail-closed)

export function makeAccess({ configPath }) {
  let cfg = null;
  let loadedAt = 0;

  function load() {
    if (Date.now() - loadedAt < 60_000 && cfg) return cfg;
    loadedAt = Date.now();
    cfg = { roles: {}, telegram: {}, api_keys: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [name, r] of Object.entries(raw.roles ?? {})) {
          if (name === 'owner' || !r || typeof r !== 'object') continue; // 'owner' is not configurable
          cfg.roles[name] = {
            projects: Array.isArray(r.projects) ? r.projects.map(String) : [],
            clearance: Array.isArray(r.clearance) ? r.clearance.filter((c) => ACCESS_LEVELS.includes(c)) : ['public'],
            actions: Array.isArray(r.actions) ? r.actions.map(String) : ['ask'],
          };
        }
        for (const [id, role] of Object.entries(raw.telegram ?? {})) {
          if (cfg.roles[role]) cfg.telegram[String(id)] = role;
        }
        for (const [hash, role] of Object.entries(raw.api_keys ?? {})) {
          if (cfg.roles[role] && /^[a-f0-9]{64}$/.test(hash)) cfg.api_keys[hash] = role;
        }
      }
    } catch { /* missing/broken config → empty maps → owner-only (fail-closed) */ }
    return cfg;
  }

  return {
    /** Telegram chat id → role name, or null (deny). Owner id is handled by the caller. */
    telegramRole(chatId) {
      return load().telegram[String(chatId)] ?? null;
    },
    /** Presented API key → role name, or null (deny). Owner key is handled by the caller. */
    apiKeyRole(presentedKey) {
      if (!presentedKey) return null;
      const h = crypto.createHash('sha256').update(String(presentedKey)).digest('hex');
      return load().api_keys[h] ?? null;
    },
    /** May `role` perform `action` ('ask' for now) on `project`? Deterministic, default-deny. */
    can(role, action, project) {
      const r = load().roles[role];
      if (!r) return false;
      if (!r.actions.includes(action)) return false;
      return r.projects.includes(project);
    },
    /** Projects this role may query, intersected with what actually exists. */
    allowedProjects(role, allSlugs) {
      const r = load().roles[role];
      if (!r) return [];
      return r.projects.filter((p) => allSlugs.includes(p));
    },
    clearanceOf(role) {
      return load().roles[role]?.clearance ?? [];
    },
    hasRoles() { return Object.keys(load().roles).length > 0; },
  };
}

/** Read a wiki page's access level from its frontmatter/head. Unlabeled → 'internal'. */
export function pageAccessLevel(content) {
  const head = String(content).slice(0, 800);
  const m = head.match(/^\s*access:\s*([a-z]+)\s*$/mi);
  const level = m ? m[1].toLowerCase() : DEFAULT_LEVEL;
  return ACCESS_LEVELS.includes(level) ? level : DEFAULT_LEVEL;
}

/** Deterministically assemble the ONLY context a restricted role may see:
 *  for each allowed project, wiki pages whose access level is within the role's
 *  clearance. index.md first, size-capped. The caller injects this into a NO-TOOLS
 *  model call — the model never touches the filesystem. */
export function buildRestrictedContext({ brainDir, projects, clearance, maxChars = 60_000 }) {
  const parts = [];
  let used = 0;
  const withheld = [];
  for (const slug of projects) {
    const wiki = path.join(brainDir, slug, 'wiki');
    let files = [];
    try {
      files = fs.readdirSync(wiki).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
    } catch { continue; }
    files.sort((a, b) => (a === 'index.md' ? -1 : b === 'index.md' ? 1 : a.localeCompare(b)));
    for (const f of files) {
      let content = '';
      try { content = fs.readFileSync(path.join(wiki, f), 'utf8'); } catch { continue; }
      const level = pageAccessLevel(content);
      if (!clearance.includes(level)) { withheld.push(`${slug}/${f}`); continue; }
      const chunk = `\n=== ${slug}/wiki/${f} (access: ${level}) ===\n${content}`;
      if (used + chunk.length > maxChars) { withheld.push(`${slug}/${f} (size cap)`); continue; }
      parts.push(chunk);
      used += chunk.length;
    }
  }
  return { context: parts.join('\n'), pages: parts.length, withheld };
}
