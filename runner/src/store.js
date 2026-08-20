// Postgres store. All writes audited via job_events in the same transaction.
// The in-memory twin (store-memory.js) implements the identical interface for
// tests — keep the two in sync when adding methods.
import pg from 'pg';
import { canTransition } from './transitions.js';

// Postgres rejects NUL (0x00) in text/jsonb — strip it from anything persisted
// (mail bodies and model output can carry it).
function stripNul(v) {
  if (typeof v === 'string') return v.replace(/\u0000/g, '');
  if (Array.isArray(v)) return v.map(stripNul);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripNul(x)]));
  return v;
}

export function makePgStore(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });

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
    async createJob({ project, type, prompt, priority = 0, run_at = null, schedule_key = null }, actor = 'api') {
      return withTx(async (c) => {
        const r = await c.query(
          `INSERT INTO jobs (project, type, prompt, priority, run_at, schedule_key)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (schedule_key) WHERE schedule_key IS NOT NULL DO NOTHING
           RETURNING *`,
          [project, type, prompt, priority, run_at, schedule_key]
        );
        const job = r.rows[0] ?? null; // null = schedule occurrence already enqueued
        if (job) {
          await c.query(
            `INSERT INTO job_events (job_id, from_status, to_status, actor, note) VALUES ($1,NULL,'queued',$2,$3)`,
            [job.id, actor, schedule_key ? `scheduled ${schedule_key}` : 'created']
          );
        }
        return job;
      });
    },

    // Create a job PARKED in needs_approval (a proposal awaiting the owner's go-ahead) with
    // a result payload. Unlike createJob (which starts 'queued' and runs immediately),
    // the runner never touches this until an approve transitions it needs_approval→queued.
    async createParked({ project, type, prompt, result = null }, actor = 'propose') {
      return withTx(async (c) => {
        const r = await c.query(
          `INSERT INTO jobs (project, type, prompt, status, result)
           VALUES ($1,$2,$3,'needs_approval',$4) RETURNING *`,
          [project, type, prompt, result]
        );
        const job = r.rows[0];
        await c.query(
          `INSERT INTO job_events (job_id, from_status, to_status, actor, note) VALUES ($1,NULL,'needs_approval',$2,'proposed')`,
          [job.id, actor]
        );
        return job;
      });
    },

    async getJob(id) {
      const r = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
      return r.rows[0] ?? null;
    },

    async listJobs({ status, project, type, limit = 50, offset = 0 } = {}) {
      const where = [];
      const args = [];
      const add = (sql, v) => { args.push(v); where.push(`${sql} $${args.length}`); };
      if (status) add('status =', status);
      if (project) add('project =', project);
      if (type) add('type =', type);
      args.push(limit, offset);
      const r = await pool.query(
        `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY created_at DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args
      );
      return r.rows;
    },

    /** Guarded transition + audit. Returns the updated job, or null if the
     *  transition is not allowed for this actor from the job's current state. */
    async transition(id, to, actor, { result, error, session_id, artifacts, note } = {}) {
      return withTx(async (c) => {
        const cur = await c.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [id]);
        const job = cur.rows[0];
        if (!job || !canTransition(job.status, to, actor)) return null;
        const r = await c.query(
          `UPDATE jobs SET status=$2, updated_at=now(),
             result   = COALESCE($3, result),
             error    = $4,
             session_id = COALESCE($5, session_id),
             artifacts  = COALESCE($6, artifacts),
             attempts   = attempts + CASE WHEN $2 = 'running' THEN 1 ELSE 0 END
           WHERE id=$1 RETURNING *`,
          [id, to, result === undefined ? null : JSON.stringify(stripNul(result)), error == null ? null : stripNul(error),
           session_id ?? null, artifacts === undefined ? null : JSON.stringify(stripNul(artifacts))]
        );
        await c.query(
          `INSERT INTO job_events (job_id, from_status, to_status, actor, note) VALUES ($1,$2,$3,$4,$5)`,
          [id, job.status, to, actor, note ?? null]
        );
        return r.rows[0];
      });
    },

    /** Atomically claim the next due queued job (priority desc, oldest first). */
    async claimNext() {
      return withTx(async (c) => {
        const r = await c.query(
          `UPDATE jobs SET status='running', updated_at=now(), attempts=attempts+1
           WHERE id = (
             SELECT id FROM jobs
             WHERE status='queued' AND (run_at IS NULL OR run_at <= now())
             ORDER BY priority DESC, COALESCE(run_at, created_at) ASC, created_at ASC
             LIMIT 1 FOR UPDATE SKIP LOCKED
           ) RETURNING *`
        );
        const job = r.rows[0] ?? null;
        if (job) {
          await c.query(
            `INSERT INTO job_events (job_id, from_status, to_status, actor, note) VALUES ($1,'queued','running','runner','claimed')`,
            [job.id]
          );
        }
        return job;
      });
    },

    /** Crash recovery: jobs stuck 'running' beyond maxAgeMin go back to queued
     *  (they resume from session_id) — unless already retried, then failed. */
    async requeueStale(maxAgeMin) {
      return withTx(async (c) => {
        const r = await c.query(
          `SELECT * FROM jobs WHERE status='running' AND updated_at < now() - ($1 || ' minutes')::interval FOR UPDATE SKIP LOCKED`,
          [String(maxAgeMin)]
        );
        const out = [];
        for (const job of r.rows) {
          const to = job.attempts >= 2 ? 'failed' : 'queued';
          await c.query(`UPDATE jobs SET status=$2, updated_at=now(), error=CASE WHEN $2='failed' THEN 'stale: runner lost the job' ELSE error END WHERE id=$1`, [job.id, to]);
          await c.query(
            `INSERT INTO job_events (job_id, from_status, to_status, actor, note) VALUES ($1,'running',$2,'runner','stale requeue')`,
            [job.id, to]
          );
          out.push({ id: job.id, to });
        }
        return out;
      });
    },

    /** Drop messages already handled by a previous triage run. */
    async filterUnprocessedMail(messages) {
      if (!messages.length) return [];
      const keys = messages.map((m) => `${m.mailbox} ${m.uid}`);
      const r = await pool.query(
        `SELECT mailbox || ' ' || uid AS k FROM processed_mail WHERE mailbox || ' ' || uid = ANY($1)`,
        [keys]
      );
      const seen = new Set(r.rows.map((row) => row.k));
      return messages.filter((m, i) => !seen.has(keys[i]));
    },

    async markMailProcessed(pairs) {
      for (const p of pairs) {
        await pool.query(
          `INSERT INTO processed_mail (mailbox, uid) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [p.mailbox, p.uid]
        );
      }
    },

    async close() { await pool.end(); },
  };
}
