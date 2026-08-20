// Actions store (Postgres) — the unified personal action board. All status
// changes are audited via action_events. The in-memory twin
// (actions-store-memory.js) mirrors this interface for tests.
import pg from 'pg';

const STATUSES = ['todo', 'doing', 'waiting', 'done', 'dismissed'];
export { STATUSES as ACTION_STATUSES };

// Strip NUL — Postgres rejects 0x00 in text/jsonb (mail-sourced titles can carry it).
const clean = (v) => (typeof v === 'string' ? v.replace(/\u0000/g, '') : v);

export function makePgActionsStore(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });

  return {
    /** Idempotent upsert by (source, source_ref). Never resurrects a done/
     *  dismissed item the owner already cleared — only refreshes its content. */
    async upsert({ source, source_ref = null, title, detail = null, project = null, needs_me = true, priority = 0, due_at = null, link = null }) {
      const r = await pool.query(
        `INSERT INTO actions (source, source_ref, title, detail, project, needs_me, priority, due_at, link)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
           title=EXCLUDED.title, detail=EXCLUDED.detail, project=EXCLUDED.project,
           needs_me=EXCLUDED.needs_me, priority=EXCLUDED.priority, due_at=EXCLUDED.due_at,
           link=EXCLUDED.link, updated_at=now()
         RETURNING *, (xmax = 0) AS inserted`,
        [source, source_ref, clean(title), clean(detail), project, needs_me, priority, due_at, link]
      );
      const row = r.rows[0];
      if (row.inserted) {
        await pool.query(
          `INSERT INTO action_events (action_id, from_status, to_status, actor, note) VALUES ($1,NULL,'todo','sync',$2)`,
          [row.id, `from ${source}`]
        );
      }
      return row;
    },

    async addManual({ title, detail = null, project = null, priority = 0, due_at = null }) {
      const r = await pool.query(
        `INSERT INTO actions (source, title, detail, project, needs_me, priority, due_at)
         VALUES ('manual',$1,$2,$3,true,$4,$5) RETURNING *`,
        [clean(title), clean(detail), project, priority, due_at]
      );
      await pool.query(
        `INSERT INTO action_events (action_id, from_status, to_status, actor, note) VALUES ($1,NULL,'todo','dash','manual add')`,
        [r.rows[0].id]
      );
      return r.rows[0];
    },

    async list({ status, source, project, includeDone = false, limit = 500 } = {}) {
      const where = [];
      const args = [];
      const add = (sql, v) => { args.push(v); where.push(`${sql} $${args.length}`); };
      if (status) add('status =', status);
      else if (!includeDone) where.push(`status NOT IN ('done','dismissed')`);
      if (source) add('source =', source);
      if (project) add('project =', project);
      args.push(limit);
      const r = await pool.query(
        `SELECT * FROM actions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY (status='doing') DESC, needs_me DESC, priority DESC,
                  COALESCE(due_at, 'infinity'::timestamptz) ASC, created_at ASC
         LIMIT $${args.length}`,
        args
      );
      return r.rows;
    },

    /** Items closed today, for the "done today" strip. */
    async doneToday() {
      const r = await pool.query(
        `SELECT * FROM actions WHERE status IN ('done','dismissed') AND updated_at >= date_trunc('day', now())
         ORDER BY updated_at DESC LIMIT 100`
      );
      return r.rows;
    },

    async setStatus(id, status, actor = 'dash', note = null) {
      if (!STATUSES.includes(status)) return null;
      const cur = await pool.query('SELECT status FROM actions WHERE id=$1', [id]);
      if (!cur.rows[0]) return null;
      const r = await pool.query(
        `UPDATE actions SET status=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, status]
      );
      await pool.query(
        `INSERT INTO action_events (action_id, from_status, to_status, actor, note) VALUES ($1,$2,$3,$4,$5)`,
        [id, cur.rows[0].status, status, actor, note]
      );
      return r.rows[0];
    },

    async snooze(id, due_at, actor = 'dash') {
      const r = await pool.query(
        `UPDATE actions SET due_at=$2, status=CASE WHEN status='done' THEN 'todo' ELSE status END, updated_at=now()
         WHERE id=$1 RETURNING *`, [id, due_at]
      );
      if (r.rows[0]) await pool.query(
        `INSERT INTO action_events (action_id, from_status, to_status, actor, note) VALUES ($1,$2,$2,$3,'snooze')`,
        [id, r.rows[0].status, actor]
      );
      return r.rows[0] ?? null;
    },

    /** EMS reconcile: mark ems-sourced actions done when their task is no longer
     *  open. keepRefs = the source_refs still open this sync. */
    async closeMissingEmsExcept(keepRefs) {
      const r = await pool.query(
        `SELECT id, source_ref FROM actions
         WHERE source='ems' AND status IN ('todo','doing','waiting')
           AND NOT (source_ref = ANY($1::text[]))`,
        [keepRefs.length ? keepRefs : ['']]
      );
      for (const row of r.rows) await this.setStatus(row.id, 'done', 'sync', 'EMS task closed');
      return r.rows.length;
    },

    async stats() {
      const r = await pool.query(
        `SELECT count(*) FILTER (WHERE status NOT IN ('done','dismissed')) AS open,
                count(*) FILTER (WHERE status NOT IN ('done','dismissed') AND needs_me AND status<>'waiting') AS needs_me,
                count(*) FILTER (WHERE status NOT IN ('done','dismissed') AND (NOT needs_me OR status='waiting')) AS waiting,
                count(*) FILTER (WHERE status IN ('done','dismissed') AND updated_at >= date_trunc('day', now())) AS done_today
         FROM actions`
      );
      return r.rows[0];
    },

    async close() { await pool.end(); },
  };
}
