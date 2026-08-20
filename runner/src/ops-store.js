// Postgres store for ops_jobs (the ops-runner queue). Same discipline as the
// Jobs store: every transition audited (ops_job_events) in the same transaction,
// no delete. Twin: ops-store-memory.js (keep the two in sync).
import pg from 'pg';
import { canOpsTransition } from './ops-transitions.js';

export function makeOpsStore(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });

  async function withTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    /** Insert a new ops job at its initial status (queued | awaiting_approval). */
    async createOpsJob({ verb, params = {}, status }, actor = 'api') {
      return withTx(async (c) => {
        const r = await c.query(
          `INSERT INTO ops_jobs (verb, params, status) VALUES ($1,$2,$3) RETURNING *`,
          [verb, JSON.stringify(params || {}), status]
        );
        const job = r.rows[0];
        await c.query(
          `INSERT INTO ops_job_events (ops_job_id, from_status, to_status, actor, note) VALUES ($1,NULL,$2,$3,'created')`,
          [job.id, status, actor]
        );
        return job;
      });
    },

    async getOpsJob(id) {
      const r = await pool.query('SELECT * FROM ops_jobs WHERE id = $1', [id]);
      return r.rows[0] ?? null;
    },

    async listOpsJobs({ status, verb, limit = 50, offset = 0 } = {}) {
      const where = [];
      const args = [];
      const add = (sql, v) => { args.push(v); where.push(`${sql} $${args.length}`); };
      if (status) add('status =', status);
      if (verb) add('verb =', verb);
      args.push(limit, offset);
      const r = await pool.query(
        `SELECT * FROM ops_jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY created_at DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args
      );
      return r.rows;
    },

    /** Guarded transition + audit. Returns updated job or null if not allowed. */
    async transitionOps(id, to, actor, { result, approved_by, note } = {}) {
      return withTx(async (c) => {
        const cur = await c.query('SELECT * FROM ops_jobs WHERE id = $1 FOR UPDATE', [id]);
        const job = cur.rows[0];
        if (!job || !canOpsTransition(job.status, to, actor)) return null;
        const r = await c.query(
          `UPDATE ops_jobs SET status=$2, updated_at=now(),
             result = COALESCE($3, result),
             approved_by = COALESCE($4, approved_by)
           WHERE id=$1 RETURNING *`,
          [id, to, result === undefined ? null : JSON.stringify(result), approved_by ?? null]
        );
        await c.query(
          `INSERT INTO ops_job_events (ops_job_id, from_status, to_status, actor, note) VALUES ($1,$2,$3,$4,$5)`,
          [id, job.status, to, actor, note ?? null]
        );
        return r.rows[0];
      });
    },

    /** Human approval: awaiting_approval → queued (records who approved). */
    async approveOps(id, approved_by) {
      return this.transitionOps(id, 'queued', 'api', { approved_by, note: `approved by ${approved_by}` });
    },

    /** Atomically claim the next queued ops job (oldest first). Concurrency 1. */
    async claimNextOps() {
      return withTx(async (c) => {
        const r = await c.query(
          `UPDATE ops_jobs SET status='running', updated_at=now()
           WHERE id = (
             SELECT id FROM ops_jobs WHERE status='queued'
             ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
           ) RETURNING *`
        );
        const job = r.rows[0] ?? null;
        if (job) {
          await c.query(
            `INSERT INTO ops_job_events (ops_job_id, from_status, to_status, actor, note) VALUES ($1,'queued','running','ops','claimed')`,
            [job.id]
          );
        }
        return job;
      });
    },

    async countsByStatus() {
      const r = await pool.query(`SELECT status, count(*)::int AS n FROM ops_jobs GROUP BY status`);
      const out = {};
      for (const row of r.rows) out[row.status] = row.n;
      return out;
    },

    async jobsQueueDepth() {
      const r = await pool.query(`SELECT status, count(*)::int AS n FROM jobs WHERE status IN ('queued','running') GROUP BY status`);
      const out = { queued: 0, running: 0 };
      for (const row of r.rows) out[row.status] = row.n;
      return out;
    },

    async lastFinished() {
      const r = await pool.query(`SELECT * FROM ops_jobs WHERE status IN ('done','failed') ORDER BY updated_at DESC LIMIT 1`);
      return r.rows[0] ?? null;
    },

    async close() { await pool.end(); },
  };
}
