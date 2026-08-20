// Write-back checkpointing for write_mode='git' projects: commit whatever the
// job changed in the clone. The commit is the known-good state; the Mac pulls.
import { execFile } from 'node:child_process';

const git = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });

export async function commitIfChanged(cwd, message) {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { committed: false, reason: 'not a git repo' };
  }
  const status = await git(cwd, ['status', '--porcelain']);
  if (!status) return { committed: false, reason: 'no changes' };
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', message]);
  const sha = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  return { committed: true, sha };
}
