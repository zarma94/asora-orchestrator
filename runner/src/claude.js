// claude -p subprocess wrapper. Security invariants:
//  - scrubbed environment: the job process NEVER sees ORCH_RUNNER_KEY, the EMS
//    key, Telegram token, or DATABASE_URL (lethal-trifecta guard);
//  - hard timeout kill + per-job budget cap;
//  - stdout/stderr redacted before anything is persisted.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// The prompt goes via STDIN, not argv — large injected DATA blocks (mail
// bodies, task lists) overflow the argv/env size limit (spawn E2BIG).
export function buildArgs({ sessionId, agentFile, allowedTools, maxBudgetUsd, model }) {
  const args = ['-p', '--output-format', 'json'];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);
  args.push('--allowedTools', allowedTools);
  if (agentFile && fs.existsSync(agentFile)) args.push('--append-system-prompt-file', agentFile);
  if (maxBudgetUsd > 0) args.push('--max-budget-usd', String(maxBudgetUsd));
  return args;
}

export function scrubbedEnv(base = process.env, extra = {}) {
  // Allowlist, not blocklist: only what the CLI needs to run.
  const keep = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM',
    // Auth: subscription OAuth preferred (claude login on the box → ~/.claude
    // credentials via HOME, or a CLAUDE_CODE_OAUTH_TOKEN); API key = paid fallback.
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_ENTRYPOINT'];
  const env = {};
  for (const k of keep) if (base[k]) env[k] = base[k];
  return { ...env, ...extra };
}

/**
 * Run one claude job. Returns {ok, result, sessionId, isError, raw} or throws
 * on transient failure (spawn error, timeout, unparseable output) — the caller
 * retries those once.
 */
export function runClaude({ bin, cwd, prompt, sessionId, agentFile, allowedTools, timeoutMin, maxBudgetUsd, env, model }) {
  const args = buildArgs({ sessionId, agentFile, allowedTools, maxBudgetUsd, model });
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: scrubbedEnv(process.env, env), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); // child may exit before we finish writing
    child.stdin.end(prompt);
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMin * 60_000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (err.length > 20_000) err = err.slice(-20_000); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`spawn failed: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`job timed out after ${timeoutMin} min`));
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        return reject(new Error(`claude exited ${code} with unparseable output: ${err.slice(0, 500) || out.slice(0, 500)}`));
      }
      resolve({
        ok: code === 0 && !parsed.is_error,
        isError: Boolean(parsed.is_error),
        result: parsed.result ?? '',
        sessionId: parsed.session_id ?? null,
        costUsd: parsed.total_cost_usd ?? null,
        exitCode: code,
      });
    });
  });
}
