// Job status state machine. Single source of truth for which transitions exist
// and who may perform them. No delete anywhere, by design.
export const STATUSES = ['queued', 'running', 'done', 'failed', 'needs_approval'];

const RULES = {
  // from → { to → allowed actors }
  queued: { running: ['runner'] },
  running: { done: ['runner'], failed: ['runner'], needs_approval: ['runner'], queued: ['runner'] }, // queued = transient retry
  needs_approval: { queued: ['api'], done: ['api'] }, // approve → requeue for continuation, or mark handled
  failed: { queued: ['api'] },                         // manual retry
  done: {},
};

export function canTransition(from, to, actor) {
  return Boolean(RULES[from] && RULES[from][to] && RULES[from][to].includes(actor));
}
