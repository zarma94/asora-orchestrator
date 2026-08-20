// Ops-job status state machine (separate from the Jobs API state machine).
// Destructive verbs land in 'awaiting_approval' and can ONLY leave it via the
// human approve PATCH ('api'). No delete anywhere, by design.
export const OPS_STATUSES = ['queued', 'awaiting_approval', 'running', 'done', 'failed'];

const RULES = {
  // from → { to → allowed actors }
  awaiting_approval: { queued: ['api'] },          // human one-tap approval only
  queued:            { running: ['ops'] },          // executor claims it
  running:           { done: ['ops'], failed: ['ops'] },
  done:              {},
  failed:            {},
};

export function canOpsTransition(from, to, actor) {
  return Boolean(RULES[from] && RULES[from][to] && RULES[from][to].includes(actor));
}
