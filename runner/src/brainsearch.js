// Brain full-text search — the recall layer (closes ASORA's grep-only gap; matches the FTS
// retrieval Hermes uses). Indexes per-project wiki pages into Postgres FTS and answers ranked,
// access-capped queries. Native Postgres, no API key. The LLM synthesis stays in the jobtypes;
// this only RETRIEVES the right pages to read.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ACCESS_ORDER = ['public', 'sales', 'internal', 'management'];

// OR-of-terms tsquery from a natural question (safe lexemes) — recall over strict AND matching.
function orTerms(query) {
  const terms = String(query || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter((w) => w.length > 2).slice(0, 14);
  return terms.length ? [...new Set(terms)].join(' | ') : null;
}

export function makeBrainSearch(databaseUrl, brainDir, embedPython = null) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

  // Local embedder (fastembed venv) — semantic recall on top of lexical FTS. No API key.
  function embed(texts) {
    return new Promise((resolve) => {
      if (!embedPython || !Array.isArray(texts) || !texts.length) return resolve(null);
      const cp = execFile(embedPython, [path.join(HERE, '..', 'bin', 'embed.py')],
        { timeout: 180_000, maxBuffer: 128 * 1024 * 1024 },
        (err, stdout) => { if (err) return resolve(null); try { resolve(JSON.parse(stdout)); } catch { resolve(null); } });
      cp.stdin.write(JSON.stringify(texts)); cp.stdin.end();
    });
  }
  const cosine = (a, b) => { let d = 0, na = 0, nb = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / ((Math.sqrt(na) * Math.sqrt(nb)) || 1); };

  function pagesOf(project) {
    const wiki = path.join(brainDir, project, 'wiki');
    const out = [];
    const walk = (dir, rel = '') => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, r);
        else if (e.name.endsWith('.md')) {
          try {
            const t = fs.readFileSync(p, 'utf8');
            const access = ((t.match(/^access:[ \t]*(\w+)/mi) || [])[1] || 'internal').toLowerCase();
            const title = ((t.match(/^title:[ \t]*(.+)$/mi) || [])[1]
                        || (t.match(/^#[ \t]+(.+)$/m) || [])[1]
                        || e.name.replace(/\.md$/, '')).trim().slice(0, 200);
            out.push({ path: r, title, access: ACCESS_ORDER.includes(access) ? access : 'internal', body: t.slice(0, 60000) });
          } catch { /* unreadable — skip */ }
        }
      }
    };
    walk(wiki);
    return out;
  }

  return {
    async reindexProject(project) {
      const pages = pagesOf(project);
      const paths = pages.map((p) => p.path);
      await pool.query('DELETE FROM brain_pages WHERE project=$1 AND path <> ALL($2::text[])', [project, paths.length ? paths : ['']]);
      for (const pg2 of pages) {
        await pool.query(
          `INSERT INTO brain_pages (project,path,title,access,body,updated_at) VALUES ($1,$2,$3,$4,$5,now())
           ON CONFLICT (project,path) DO UPDATE SET title=EXCLUDED.title, access=EXCLUDED.access, body=EXCLUDED.body, updated_at=now(),
             embedding = CASE WHEN brain_pages.body IS DISTINCT FROM EXCLUDED.body THEN NULL ELSE brain_pages.embedding END`,
          [project, pg2.path, pg2.title, pg2.access, pg2.body]);
      }
      await this.embedMissing(project);      // fill in embeddings for new/changed pages
      return pages.length;
    },
    // Embed any pages missing a vector (new or body-changed). Batched; no-op if embedder off.
    async embedMissing(project = null) {
      if (!embedPython) return 0;
      const args = project ? [project] : [];
      const r = await pool.query(`SELECT id, title, left(body, 1600) AS body FROM brain_pages WHERE embedding IS NULL${project ? ' AND project=$1' : ''} LIMIT 800`, args);
      if (!r.rows.length) return 0;
      const vecs = await embed(r.rows.map((x) => `${x.title || ''}\n${x.body || ''}`.slice(0, 1800)));
      if (!vecs || vecs.length !== r.rows.length) return 0;
      for (let i = 0; i < r.rows.length; i++) await pool.query('UPDATE brain_pages SET embedding=$1 WHERE id=$2', [JSON.stringify(vecs[i]), r.rows[i].id]);
      return r.rows.length;
    },
    async reindexAll() {
      let projects = [];
      try { projects = fs.readdirSync(brainDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* no brain */ }
      let pages = 0;
      for (const p of projects) pages += await this.reindexProject(p);
      return { projects: projects.length, pages };
    },
    // Ranked, access-capped search. maxAccess = the caller's clearance ('management' = owner/full).
    async search(query, { project = null, maxAccess = 'management', limit = 8 } = {}) {
      // OR-of-terms so a natural question matches pages sharing SOME words; ts_rank then
      // floats the best match (more terms + higher frequency) to the top. Sanitised to safe lexemes.
      const tsq = orTerms(query);
      if (!tsq) return [];
      const capIdx = ACCESS_ORDER.indexOf(maxAccess);
      const allowed = ACCESS_ORDER.slice(0, capIdx < 0 ? ACCESS_ORDER.length : capIdx + 1);
      const args = [tsq];
      let where = "tsv @@ to_tsquery('simple', $1)";
      if (project) { args.push(project); where += ` AND project = $${args.length}`; }
      args.push(allowed); where += ` AND access = ANY($${args.length}::text[])`;
      args.push(limit);
      const r = await pool.query(
        `SELECT project, path, title, access,
                ts_rank(tsv, to_tsquery('simple',$1)) AS rank,
                ts_headline('simple', body, to_tsquery('simple',$1),
                            'MaxWords=32,MinWords=16,MaxFragments=1') AS snippet
           FROM brain_pages WHERE ${where}
          ORDER BY rank DESC LIMIT $${args.length}`, args);
      return r.rows.map((x) => ({ ...x, rank: Number(x.rank).toFixed(4) }));
    },
    // SEMANTIC search — embed the query, cosine over stored page vectors (concept-match beyond keywords).
    async semanticSearch(query, { project = null, maxAccess = 'management', limit = 8 } = {}) {
      if (!embedPython || !String(query || '').trim()) return [];
      const qv = (await embed([String(query).slice(0, 1800)]) || [])[0];
      if (!qv) return [];
      const capIdx = ACCESS_ORDER.indexOf(maxAccess);
      const allowed = ACCESS_ORDER.slice(0, capIdx < 0 ? ACCESS_ORDER.length : capIdx + 1);
      const args = [allowed]; let where = 'embedding IS NOT NULL AND access = ANY($1::text[])';
      if (project) { args.push(project); where += ` AND project=$${args.length}`; }
      const r = await pool.query(`SELECT project,path,title,access,embedding FROM brain_pages WHERE ${where}`, args);
      return r.rows.map((x) => ({ project: x.project, path: x.path, title: x.title, access: x.access, score: cosine(qv, x.embedding) }))
        .sort((a, b) => b.score - a.score).slice(0, limit).map((x) => ({ ...x, score: Number(x.score).toFixed(4) }));
    },
    // HYBRID — FTS (lexical) + semantic (concept), normalised and summed. The retrieval converse uses.
    async hybridSearch(query, { project = null, maxAccess = 'management', limit = 8 } = {}) {
      const [fts, sem] = await Promise.all([
        this.search(query, { project, maxAccess, limit: 12 }).catch(() => []),
        this.semanticSearch(query, { project, maxAccess, limit: 12 }).catch(() => []),
      ]);
      const key = (x) => `${x.project}/${x.path}`;
      const ftsMax = Math.max(1e-6, ...fts.map((x) => Number(x.rank)));
      const merged = new Map();
      for (const x of fts) merged.set(key(x), { project: x.project, path: x.path, title: x.title, access: x.access, s: 0.5 * (Number(x.rank) / ftsMax) });
      for (const x of sem) { const k = key(x); const add = 0.5 * Number(x.score); const p = merged.get(k); if (p) p.s += add; else merged.set(k, { project: x.project, path: x.path, title: x.title, access: x.access, s: add }); }
      return [...merged.values()].sort((a, b) => b.s - a.s).slice(0, limit);
    },
    // --- cross-session recall: index past conversational/task jobs (Q + A) and search them ---
    async reindexSessions({ days = 120, limit = 3000 } = {}) {
      const r = await pool.query(
        `SELECT id, type, project, prompt, result, created_at FROM jobs
          WHERE status='done' AND type IN ('converse','assist','ladder','delegate','capture','mail-check','mail-plan','dev-plan')
            AND created_at > now() - ($1::text || ' days')::interval
          ORDER BY created_at DESC LIMIT $2`, [String(days), limit]);
      let n = 0;
      for (const j of r.rows) {
        const res = j.result || {};
        const ans = res.text || (res.post && res.post.text) || (res.post && res.post.reply) || '';
        const body = `${String(j.prompt || '').slice(0, 2000)}\n\n${String(ans).slice(0, 3500)}`.trim();
        if (body.length < 25) continue;
        await pool.query(
          `INSERT INTO session_index (job_id, type, project, ts, body) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (job_id) DO UPDATE SET body=EXCLUDED.body, ts=EXCLUDED.ts, project=EXCLUDED.project`,
          [j.id, j.type, j.project, j.created_at, body]);
        n += 1;
      }
      await pool.query("DELETE FROM session_index WHERE ts < now() - interval '180 days'");
      return n;
    },
    // Recall relevant PRIOR exchanges. Blends match rank with recency so newer memories win ties.
    async searchSessions(query, { project = null, limit = 4 } = {}) {
      const tsq = orTerms(query);
      if (!tsq) return [];
      const args = [tsq];
      let where = "tsv @@ to_tsquery('simple', $1)";
      if (project) { args.push(project); where += ` AND (project = $${args.length} OR project IS NULL)`; }
      args.push(limit);
      const r = await pool.query(
        `SELECT job_id, type, project, ts,
                ts_rank(tsv, to_tsquery('simple',$1))
                  * (1.0 / (1 + EXTRACT(EPOCH FROM (now()-ts))/2592000.0)) AS score,
                ts_headline('simple', body, to_tsquery('simple',$1),
                            'MaxWords=40,MinWords=20,MaxFragments=1') AS snippet
           FROM session_index WHERE ${where}
          ORDER BY score DESC LIMIT $${args.length}`, args);
      return r.rows;
    },
    // ---- lightweight knowledge graph (typed edges over the brain) ----
    async upsertEdges(project, edges) {
      if (!Array.isArray(edges) || !edges.length) return 0;
      let n = 0;
      for (const e of edges) {
        const subj = String(e.subject || e.s || '').trim().slice(0, 200);
        const rel = String(e.relation || e.r || '').trim().toLowerCase().slice(0, 40);
        const obj = String(e.object || e.o || '').trim().slice(0, 200);
        if (!subj || !rel || !obj || subj.toLowerCase() === obj.toLowerCase()) continue;
        try {
          await pool.query(
            `INSERT INTO brain_edges (project, subject, relation, object, note, source_page)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (project, lower(subject), relation, lower(object))
             DO UPDATE SET note=EXCLUDED.note, source_page=EXCLUDED.source_page, updated_at=now()`,
            [project, subj, rel, obj,
             e.note ? String(e.note).slice(0, 300) : null,
             (e.source_page || e.page) ? String(e.source_page || e.page).slice(0, 300) : null]);
          n += 1;
        } catch { /* skip bad edge */ }
      }
      return n;
    },
    async queryEdges(query, { project = null, limit = 25 } = {}) {
      const terms = (String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/gi) || []).slice(0, 8);
      if (!terms.length) return [];
      const args = terms.map((t) => `%${t}%`);
      const conds = args.map((_, i) => `lower(subject) LIKE $${i + 1} OR lower(object) LIKE $${i + 1}`).join(' OR ');
      let where = `(${conds})`;
      if (project) { args.push(project); where += ` AND project = $${args.length}`; }
      args.push(limit);
      const r = await pool.query(
        `SELECT subject, relation, object, note, project, source_page FROM brain_edges WHERE ${where} LIMIT $${args.length}`, args);
      return r.rows;
    },
    async close() { try { await pool.end(); } catch { /* ignore */ } },
  };
}
