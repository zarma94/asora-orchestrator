// In-memory twin of ops-store.js for tests. Implements the identical interface.
import { randomUUID } from 'node:crypto';
import { canOpsTransition } from './ops-transitions.js';

export function makeMemoryOpsStore({ jobsQueue = { queued: 0, running: 0 } } = {}) {
  const jobs = new Map();
  const events = [];
  const audit = (ops_job_id, from_status, to_status, actor, note) =>
    events.push({ ops_job_id, from_status, to_status, actor, note: note ?? null, created_at: new Date() });

  return {
    _jobs: jobs,
    _events: events,

    async createOpsJob({ verb, params = {}, status }, actor = 'api') {
      const job = {
        id: randomUUID(), verb, params: params || {}, status,
        result: null, approved_by: null, created_at: new Date(), updated_at: new Date(),
      };
      jobs.set(job.id, job);
      audit(job.id, null, status, actor, 'created');
      return { ...job };
    },

    async getOpsJob(id) { const j = jobs.get(id); return j ? { ...j } : null; },

    async listOpsJobs({ status, verb, limit = 50, offset = 0 } = {}) {
      return [...jobs.values()]
        .filter((j) => (!status || j.status === status) && (!verb || j.verb === verb))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(offset, offset + limit)
        .map((j) => ({ ...j }));
    },

    async transitionOps(id, to, actor, { result, approved_by, note } = {}) {
      const job = jobs.get(id);
      if (!job || !canOpsTransition(job.status, to, actor)) return null;
      const from = job.status;
      job.status = to;
      job.updated_at = new Date();
      if (result !== undefined) job.result = result;
      if (approved_by != null) job.approved_by = approved_by;
      audit(id, from, to, actor, note);
      return { ...job };
    },

    async approveOps(id, approved_by) {
      return this.transitionOps(id, 'queued', 'api', { approved_by, note: `approved by ${approved_by}` });
    },

    async claimNextOps() {
      const due = [...jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.created_at - b.created_at);
      const job = due[0];
      if (!job) return null;
      job.status = 'running';
      job.updated_at = new Date();
      audit(job.id, 'queued', 'running', 'ops', 'claimed');
      return { ...job };
    },

    async countsByStatus() {
      const out = {};
      for (const j of jobs.values()) out[j.status] = (out[j.status] || 0) + 1;
      return out;
    },

    async jobsQueueDepth() { return { ...jobsQueue }; },

    async lastFinished() {
      return [...jobs.values()].filter((j) => j.status === 'done' || j.status === 'failed')
        .sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
    },

    async close() {},
  };
}
