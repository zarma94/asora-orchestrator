// src/ingest.js — ingest pipeline helpers (dependency-free: node built-ins + a python
// extractor subprocess). Phase 1: scan an inbox folder, extract text, and the jobtype
// routes each doc to a project + dispatches an `ingest-doc` job that assesses & stores it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Formats we can read as plain text directly (no external deps).
const TEXT_EXT = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.log', '.html', '.htm', '.xml', '.yaml', '.yml']);
// Formats that need the python extractor (markitdown / pdfplumber).
const EXTRACT_EXT = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.doc', '.rtf', '.epub', '.eml', '.msg']);

/** True if the ingest pipeline can extract text from this file (by extension). */
export function isIngestable(file) {
  const ext = path.extname(String(file)).toLowerCase();
  return TEXT_EXT.has(ext) || EXTRACT_EXT.has(ext);
}

/** Collapse an UNTRUSTED filename to a flat safe basename (mirror of the python
 *  safe_name in bin/ingest_mail.py: no path components, no NUL, conservative charset). */
export function safeBaseName(name) {
  const base = path.basename(String(name || 'file').replace(/\0/g, ''));
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'file';
  return cleaned.slice(0, 120);
}

/** Resolve rel against root; return the absolute path only if it stays INSIDE root
 *  (path-traversal guard for user-supplied paths). Absolute paths inside root pass. */
export function resolveUnderRoot(root, rel) {
  if (!root) return null;
  const p = path.resolve(root, String(rel || ''));
  return p.startsWith(path.resolve(root) + path.sep) ? p : null;
}

/** List not-yet-processed files under inboxDir (recursive), capped. Skips dotfiles,
 *  _done/ + _unrouted/, and files modified < stableMs ago (may still be mid-write —
 *  the watch-folder "stability threshold" pattern; a partial file would ingest truncated). */
export function scanInbox(inboxDir, processedSet, maxFiles = 25, stableMs = 5000) {
  const out = [];
  if (!fs.existsSync(inboxDir)) return out;
  const cutoff = Date.now() - stableMs;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (out.length >= maxFiles) return;
      if (ent.name.startsWith('.') || ent.name === '_done' || ent.name === '_unrouted') continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (processedSet.has(p)) continue;
      try { if (fs.statSync(p).mtimeMs > cutoff) continue; } catch { continue; }
      out.push(p);
    }
  };
  walk(inboxDir);
  return out.slice(0, maxFiles);
}

/** Move a file into inboxDir/<sub>/ (flat; suffix on name collision). Returns the
 *  new path, or null if the move failed (caller leaves it for the next run). */
function moveToSub(inboxDir, sub, file) {
  try {
    const dir = path.join(inboxDir, sub);
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, path.basename(file));
    for (let i = 1; fs.existsSync(dest) && i < 100; i += 1) {
      dest = path.join(dir, `${i}-${path.basename(file)}`);
    }
    fs.renameSync(file, dest);
    return dest;
  } catch { return null; }
}

/** Unrouted/noise → inboxDir/_unrouted/ for human triage. */
export function moveToUnrouted(inboxDir, file) { return moveToSub(inboxDir, '_unrouted', file); }

/** Routed → inboxDir/_done/ the moment its ingest-doc is enqueued: the scanner skips
 *  _done, so a re-scan can never double-route it, and the original is preserved for
 *  audit/recovery if the store step later fails (nothing is silently lost). */
export function moveToDone(inboxDir, file) { return moveToSub(inboxDir, '_done', file); }

/** Extract plain text from a file. Text formats read directly; binaries via the python
 *  extractor. Returns null if unsupported or extraction failed (caller skips + reports). */
export function readDocText(file, { pythonBin = 'python3', extractor, maxChars = 40000 } = {}) {
  const ext = path.extname(file).toLowerCase();
  // NUL bytes in extracted text poison Postgres inserts (UTF8 0x00) → the whole ingest
  // routing job fails, losing a batch. Strip them (+ other C0 control chars bar \t\n\r).
  const clean = (s) => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, maxChars);
  try {
    if (TEXT_EXT.has(ext)) return clean(fs.readFileSync(file, 'utf8'));
    if (EXTRACT_EXT.has(ext)) {
      if (!extractor || !fs.existsSync(extractor)) return null;
      const r = spawnSync(pythonBin, [extractor, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
      if (r.status === 0 && r.stdout && r.stdout.trim()) return clean(r.stdout);
      return null;
    }
  } catch { return null; }
  return null;
}

/** processed manifest = jsonl of {file,...}. Returns a Set of processed file paths. */
export function loadProcessed(manifestPath) {
  const set = new Set();
  try {
    for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.file) set.add(o.file); } catch { /* skip */ }
    }
  } catch { /* no manifest yet */ }
  return set;
}

export function markProcessed(manifestPath, entries) {
  if (!entries.length) return;
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const lines = entries.map((e) => JSON.stringify({ file: e.file, project: e.project || null, note: 'ingested' }));
  fs.appendFileSync(manifestPath, lines.join('\n') + '\n');
}

// ---- Router plan v2: route / new-project / ask / skip ----

/** Master companies a NEW project can be created under. folder = the NC top-level dir.
 *  Client instances override via env INGEST_COMPANIES (JSON of the same shape) —
 *  a ACME install, for example, ships only { ceg: {...} }. */
const DEFAULT_COMPANIES = {
  ceg: { folder: 'ACME', desc: 'ACME Group AG — company/tax setups, real estate (Sample Project Morocco, Sample Project B, SampleRegion), ACME Stake tokenisation, broker platform, client work' },
  mzk: { folder: 'SampleGroup', desc: 'SampleGroup Group — holding & app company (mzk-group.com)' },
  asora: { folder: 'ASORA', desc: 'ASORA — the AI orchestrator/agency and its client instances' },
  SampleCo: { folder: 'SampleCo', desc: 'SampleCo — trading systems, strategies, live engines' },
};
export const COMPANIES = (() => {
  try {
    const raw = process.env.INGEST_COMPANIES;
    if (raw) {
      const j = JSON.parse(raw);
      const ok = j && typeof j === 'object' && Object.entries(j).every(([k, v]) => /^[a-z0-9-]{2,30}$/.test(k) && v && typeof v.folder === 'string');
      if (ok && Object.keys(j).length) return j;
    }
  } catch { /* bad override → defaults */ }
  return DEFAULT_COMPANIES;
})();

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Parse the router's last ```json array into a validated action plan.
 *  Entries: {file, action:'route', project} | {file, action:'new-project', slug, company,
 *  name, reason, confidence:'high'|'low'} | {file, action:'ask', question, candidates[]} |
 *  {file, action:'skip'}. Invalid entries are dropped (untrusted model output). */
export function parseRoutePlan(text, validSlugs) {
  const m = [...String(text).matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (!m.length) return null;
  let arr;
  try { arr = JSON.parse(m[m.length - 1][1]); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const valid = new Set(validSlugs);
  const out = [];
  for (const x of arr) {
    if (!x || typeof x.file !== 'string') continue;
    if (x.action === 'route' && valid.has(x.project)) {
      out.push({ file: x.file, action: 'route', project: x.project });
    } else if (x.action === 'new-project' && SLUG_RE.test(String(x.slug || '')) && !valid.has(x.slug) && COMPANIES[x.company]) {
      out.push({
        file: x.file, action: 'new-project', slug: x.slug, company: x.company,
        name: String(x.name || x.slug).slice(0, 80), reason: String(x.reason || '').slice(0, 300),
        confidence: x.confidence === 'high' ? 'high' : 'low',
      });
    } else if (x.action === 'ask') {
      out.push({
        file: x.file, action: 'ask',
        question: String(x.question || 'where does this belong?').slice(0, 300),
        candidates: Array.isArray(x.candidates) ? x.candidates.filter((c) => valid.has(c)).slice(0, 5) : [],
      });
    } else if (x.action === 'skip') {
      out.push({ file: x.file, action: 'skip' });
    }
  }
  return out;
}

/** Atomic read-modify-write of the projects.json overlay (tmp + rename). */
function updateProjectsJson(configPath, mutate) {
  const cur = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  mutate(cur);
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n');
  fs.renameSync(tmp, configPath);
}

/** Create a NEW project brain under a master company: brain/<slug>/wiki (index + log)
 *  + a projects.json overlay entry (write_mode: brain). Box-side only — the human adds
 *  the REGISTRY.md row later (noted in the log). Returns {ok} or {ok:false, error}. */
export function createProjectBrain({ brainDir, configPath, slug, company, name = '', reason = '', source = '' }) {
  if (!SLUG_RE.test(String(slug || ''))) return { ok: false, error: `invalid slug: ${slug}` };
  const comp = COMPANIES[company];
  if (!comp) return { ok: false, error: `unknown company: ${company} (use ${Object.keys(COMPANIES).join('/')})` };
  const cur = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  if (cur[slug]) return { ok: false, error: `project ${slug} already exists` };
  const wiki = path.join(brainDir, slug, 'wiki');
  const today = new Date().toISOString().slice(0, 10);
  const title = name || slug;
  // Order matters for crash/permission-failure reruns: dir → REGISTER (atomic json) →
  // scaffold. A rerun after a mid-way failure is then caught by the dupe check above
  // instead of appending a second "project created" log entry.
  fs.mkdirSync(wiki, { recursive: true });
  updateProjectsJson(configPath, (c) => { c[slug] = { write_mode: 'brain', folder: comp.folder, company, name: title }; });
  if (!fs.existsSync(path.join(wiki, 'index.md'))) {
    fs.writeFileSync(path.join(wiki, 'index.md'),
      `# ${title} — brain index\n\nCompany: ${company.toUpperCase()} · created ${today}${reason ? ` · why: ${reason}` : ''}\n\nPages: (none yet — first ingest pending)\n`);
  }
  fs.appendFileSync(path.join(wiki, 'log.md'),
    `\n## ${today} — project created\nCreated under ${company.toUpperCase()}${source ? ` from \`${source}\`` : ''}. ${reason}\nNOTE: box-created — add a row to projects/REGISTRY.md on the Mac when convenient.\n`);
  return { ok: true, slug, company, wiki };
}

/** Flip an EXISTING registry project to a writable brain (overlay + wiki dir). */
export function enableBrainMode({ brainDir, configPath, slug }) {
  fs.mkdirSync(path.join(brainDir, slug, 'wiki'), { recursive: true });
  updateProjectsJson(configPath, (c) => { c[slug] = { ...(c[slug] || {}), write_mode: 'brain' }; });
  return { ok: true, slug };
}

/** Parse the router's last ```json array; keep only entries whose project is a valid slug. */
export function parseRoute(text, validSlugs) {
  const m = [...String(text).matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (!m.length) return null;
  let arr;
  try { arr = JSON.parse(m[m.length - 1][1]); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const valid = new Set(validSlugs);
  return arr
    .filter((x) => x && typeof x.file === 'string' && valid.has(x.project))
    .map((x) => ({ file: x.file, project: x.project }));
}
