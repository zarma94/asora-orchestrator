// In-memory store — test double implementing the exact store.js interface.
// Lets the API, runner, and scheduler logic be tested without Postgres.
import { randomUUID } from 'node:crypto';
import { canTransition } from './transitions.js';

export function makeMemoryStore() {
  const jobs = new Map();
  const events = [];
  const scheduleKeys = new Set();

  const audit = (job_id, from_status, to_status, actor, note) =>
    events.push({ job_id, from_status, to_status, actor, note: note ?? null, created_at: new Date() });

  return {
    _jobs: jobs,
    _events: events,

    async createJob({ project, type, prompt, priority = 0, run_at = null, schedule_key = null }, actor = 'api') {
      if (schedule_key) {
        if (scheduleKeys.has(schedule_key)) return null;
        scheduleKeys.add(schedule_key);
      }
      const job = {
        id: randomUUID(), project, type, prompt, status: 'queued', priority,
        run_at: run_at ? new Date(run_at) : null, result: null, session_id: null,
        artifacts: null, error: null, attempts: 0, schedule_key,
        created_at: new Date(), updated_at: new Date(),
      };
      jobs.set(job.id, job);
      audit(job.id, null, 'queued', actor, schedule_key ? `scheduled ${schedule_key}` : 'created');
      return { ...job };
    },

    async getJob(id) {
      const j = jobs.get(id);
      return j ? { ...j } : null;
    },

    async listJobs({ status, project, type, limit = 50, offset = 0 } = {}) {
      return [...jobs.values()]
        .filter((j) => (!status || j.status === status) && (!project || j.project === project) && (!type || j.type === type))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(offset, offset + limit)
        .map((j) => ({ ...j }));
    },

    async transition(id, to, actor, { result, error, session_id, artifacts, note } = {}) {
      const job = jobs.get(id);
      if (!job || !canTransition(job.status, to, actor)) return null;
      const from = job.status;
      job.status = to;
      job.updated_at = new Date();
      if (result !== undefined) job.result = result;
      job.error = error ?? null;
      if (session_id != null) job.session_id = session_id;
      if (artifacts !== undefined) job.artifacts = artifacts;
      if (to === 'running') job.attempts += 1;
      audit(id, from, to, actor, note);
      return { ...job };
    },

    async claimNext() {
      const now = Date.now();
      const due = [...jobs.values()]
        .filter((j) => j.status === 'queued' && (!j.run_at || j.run_at.getTime() <= now))
        .sort((a, b) => b.priority - a.priority
          || (a.run_at ?? a.created_at) - (b.run_at ?? b.created_at)
          || a.created_at - b.created_at);
      const job = due[0];
      if (!job) return null;
      job.status = 'running';
      job.attempts += 1;
      job.updated_at = new Date();
      audit(job.id, 'queued', 'running', 'runner', 'claimed');
      return { ...job };
    },

    async requeueStale(maxAgeMin) {
      const cutoff = Date.now() - maxAgeMin * 60_000;
      const out = [];
      for (const job of jobs.values()) {
        if (job.status !== 'running' || job.updated_at.getTime() >= cutoff) continue;
        const to = job.attempts >= 2 ? 'failed' : 'queued';
        if (to === 'failed') job.error = 'stale: runner lost the job';
        job.status = to;
        job.updated_at = new Date();
        audit(job.id, 'running', to, 'runner', 'stale requeue');
        out.push({ id: job.id, to });
      }
      return out;
    },

    _processedMail: new Set(),

    async filterUnprocessedMail(messages) {
      return messages.filter((m) => !this._processedMail.has(`${m.mailbox}:${m.uid}`));
    },

    async markMailProcessed(pairs) {
      for (const p of pairs) this._processedMail.add(`${p.mailbox}:${p.uid}`);
    },

    async close() {},
  };
}
