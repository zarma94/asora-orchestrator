// In-memory twin of actions-store.js — for tests, no Postgres.
import { randomUUID } from 'node:crypto';
import { ACTION_STATUSES } from './actions-store.js';

export function makeMemoryActionsStore() {
  const rows = new Map();
  const events = [];
  const key = (source, ref) => `${source}${ref}`;
  const byRef = new Map();
  const audit = (action_id, from_status, to_status, actor, note) =>
    events.push({ action_id, from_status, to_status, actor, note: note ?? null, created_at: new Date() });

  return {
    _rows: rows, _events: events,

    async upsert({ source, source_ref = null, title, detail = null, project = null, needs_me = true, priority = 0, due_at = null, link = null }) {
      if (source_ref != null && byRef.has(key(source, source_ref))) {
        const row = rows.get(byRef.get(key(source, source_ref)));
        Object.assign(row, { title, detail, project, needs_me, priority, due_at, link, updated_at: new Date() });
        return { ...row, inserted: false };
      }
      const row = {
        id: randomUUID(), source, source_ref, title, detail, project,
        status: 'todo', needs_me, priority, due_at: due_at ? new Date(due_at) : null, link,
        created_at: new Date(), updated_at: new Date(),
      };
      rows.set(row.id, row);
      if (source_ref != null) byRef.set(key(source, source_ref), row.id);
      audit(row.id, null, 'todo', 'sync', `from ${source}`);
      return { ...row, inserted: true };
    },

    async addManual({ title, detail = null, project = null, priority = 0, due_at = null }) {
      const row = {
        id: randomUUID(), source: 'manual', source_ref: null, title, detail, project,
        status: 'todo', needs_me: true, priority, due_at: due_at ? new Date(due_at) : null, link: null,
        created_at: new Date(), updated_at: new Date(),
      };
      rows.set(row.id, row);
      audit(row.id, null, 'todo', 'dash', 'manual add');
      return { ...row };
    },

    async list({ status, source, project, includeDone = false, limit = 500 } = {}) {
      return [...rows.values()]
        .filter((r) => (status ? r.status === status : includeDone || !['done', 'dismissed'].includes(r.status))
          && (!source || r.source === source) && (!project || r.project === project))
        .sort((a, b) => (b.status === 'doing') - (a.status === 'doing')
          || (b.needs_me - a.needs_me) || (b.priority - a.priority)
          || (a.due_at ?? Infinity) - (b.due_at ?? Infinity) || a.created_at - b.created_at)
        .slice(0, limit).map((r) => ({ ...r }));
    },

    async doneToday() {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      return [...rows.values()].filter((r) => ['done', 'dismissed'].includes(r.status) && r.updated_at >= start).map((r) => ({ ...r }));
    },

    async setStatus(id, status, actor = 'dash', note = null) {
      if (!ACTION_STATUSES.includes(status)) return null;
      const row = rows.get(id);
      if (!row) return null;
      const from = row.status;
      row.status = status; row.updated_at = new Date();
      audit(id, from, status, actor, note);
      return { ...row };
    },

    async snooze(id, due_at, actor = 'dash') {
      const row = rows.get(id);
      if (!row) return null;
      row.due_at = new Date(due_at);
      if (row.status === 'done') row.status = 'todo';
      row.updated_at = new Date();
      audit(id, row.status, row.status, actor, 'snooze');
      return { ...row };
    },

    async closeMissingEmsExcept(keepRefs) {
      const keep = new Set(keepRefs);
      let n = 0;
      for (const row of rows.values()) {
        if (row.source === 'ems' && ['todo', 'doing', 'waiting'].includes(row.status) && !keep.has(row.source_ref)) {
          await this.setStatus(row.id, 'done', 'sync', 'EMS task closed'); n += 1;
        }
      }
      return n;
    },

    async stats() {
      const open = [...rows.values()].filter((r) => !['done', 'dismissed'].includes(r.status));
      const start = new Date(); start.setHours(0, 0, 0, 0);
      return {
        open: String(open.length),
        needs_me: String(open.filter((r) => r.needs_me && r.status !== 'waiting').length),
        waiting: String(open.filter((r) => !r.needs_me || r.status === 'waiting').length),
        done_today: String([...rows.values()].filter((r) => ['done', 'dismissed'].includes(r.status) && r.updated_at >= start).length),
      };
    },

    async close() {},
  };
}
