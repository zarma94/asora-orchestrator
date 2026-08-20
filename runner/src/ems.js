// EMS Tasks API client (runner-side, deterministic). The EMS key lives ONLY
// here — never in a job's environment or prompt. Writes are throttled and
// retried once on 429 — burst-filing a triage batch trips the EMS rate limiter.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeEmsClient({ baseUrl, apiKey, fetchImpl = fetch, writeGapMs = 6000 }) {
  const enabled = Boolean(baseUrl && apiKey);
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  let lastWrite = 0;

  async function call(path, init = {}) {
    if (!enabled) throw new Error('EMS not configured');
    const isWrite = init.method && init.method !== 'GET';
    if (isWrite) {
      const wait = lastWrite + writeGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastWrite = Date.now();
    }
    let res = await fetchImpl(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (res.status === 429) {
      await sleep(writeGapMs * 3);
      if (isWrite) lastWrite = Date.now();
      res = await fetchImpl(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    }
    if (!res.ok) throw new Error(`EMS ${init.method || 'GET'} ${path} → ${res.status}`);
    return res.json();
  }

  return {
    enabled,
    /** Open tasks, optionally per project board. */
    async openTasks({ project, limit = 200 } = {}) {
      const q = new URLSearchParams({ status: 'open', limit: String(limit) });
      if (project) q.set('project', project);
      return call(`/api/public/tasks?${q}`);
    },
    async createTask({ project, title, summary, description, dueAt, labels }) {
      return call('/api/public/tasks', {
        method: 'POST',
        body: JSON.stringify({ project, title, summary, description, dueAt, labels }),
      });
    },
    async patchTask(id, patch) {
      return call(`/api/public/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    },
  };
}
