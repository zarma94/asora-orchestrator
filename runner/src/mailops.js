// Mail operations — the DETERMINISTIC side of mail-triage. Credentials stay in
// ~/.mail/.env on this box; the claude triage step never touches them and never
// gets network/Bash tools. Reuses the owner's existing tooling unchanged.
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function run(bin, args, { timeoutMs, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs ?? 300_000, maxBuffer: 8 * 1024 * 1024, env: env ?? process.env },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${path.basename(bin)} failed: ${err.message} ${String(stderr).slice(0, 400)}`));
        resolve(String(stdout));
      });
  });
}

export function makeMailOps({ mailDir = path.join(os.homedir(), '.mail'), pythonBin = 'python3' } = {}) {
  return {
    /** Existing hourly auto-clean (auto_all.py), unchanged. Returns its log tail. */
    async autoClean() {
      const out = await run(pythonBin, [path.join(mailDir, 'auto_all.py')], { timeoutMs: 600_000 });
      return out.split('\n').slice(-12).join('\n');
    },

    /** Read+unread mail from the last N days (SINCE), for a retrospective review. PEEK only. */
    async fetchSince({ days = 40, maxPerBox = 80 } = {}) {
      const out = await run(pythonBin, [path.join(HERE, '..', 'bin', 'mail_fetch_json.py'), '--days', String(days), '--max', String(maxPerBox)],
        { timeoutMs: 420_000, env: { ...process.env, MAIL_DIR: mailDir } });
      return JSON.parse(out);
    },

    /** Unread mail across all 3 mailboxes → {messages:[...], errors:[...]} (bodies truncated, PEEK only). */
    async fetchUnread({ maxPerBox = 25 } = {}) {
      const out = await run(pythonBin, [path.join(HERE, '..', 'bin', 'mail_fetch_json.py'), '--max', String(maxPerBox)],
        { timeoutMs: 300_000, env: { ...process.env, MAIL_DIR: mailDir } });
      return JSON.parse(out);
    },

    /** ACTION planning: UID-stable list of a single mailbox's recent mail (PEEK only) so a
     *  plan can reference each message by uid + message_id. mailbox ∈ gmail|ceg|mzk. */
    async listActionable({ mailbox, days = 10, max = 40 } = {}) {
      const out = await run(pythonBin, [path.join(HERE, '..', 'bin', 'mail_action.py'), 'list', '--mailbox', String(mailbox), '--days', String(days), '--max', String(max)],
        { timeoutMs: 120_000, env: { ...process.env, MAIL_DIR: mailDir } });
      return JSON.parse(out);
    },

    /** Execute an APPROVED mail plan (forward via SMTP + archive via IMAP MOVE). Each action
     *  re-verifies the message by Message-ID before acting; dryRun resolves but sends/moves
     *  nothing. Plan = {mailbox, actions:[{op,uid,message_id,to?}]}. Never call un-approved. */
    async execActions({ plan, dryRun = false } = {}) {
      const args = [path.join(HERE, '..', 'bin', 'mail_action.py'), 'exec'];
      if (dryRun) args.push('--dry-run');
      const env = { ...process.env, MAIL_DIR: mailDir };
      const out = await new Promise((resolve, reject) => {
        const cp = execFile(pythonBin, args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env },
          (err, stdout, stderr) => (err ? reject(new Error(`mail_action exec failed: ${err.message} ${String(stderr).slice(0, 400)}`)) : resolve(String(stdout))));
        cp.stdin.write(JSON.stringify(plan)); cp.stdin.end();
      });
      return JSON.parse(out);
    },

    /** Ledger-only check (no network): which of a plan's actions were already done? So the
     *  approval card can show upfront what will be skipped. Authoritative de-dup is in execActions. */
    async checkActions({ plan } = {}) {
      const env = { ...process.env, MAIL_DIR: mailDir };
      const out = await new Promise((resolve, reject) => {
        const cp = execFile(pythonBin, [path.join(HERE, '..', 'bin', 'mail_action.py'), 'check'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env },
          (err, stdout, stderr) => (err ? reject(new Error(`mail_action check failed: ${err.message} ${String(stderr).slice(0, 300)}`)) : resolve(String(stdout))));
        cp.stdin.write(JSON.stringify(plan)); cp.stdin.end();
      });
      return JSON.parse(out);
    },

    /** Phase 2a ingest source-adapter: pull DOCUMENT attachments from IMAP into the
     *  inbox (read-only PEEK; creds stay in ~/.mail). Returns the fetcher's JSON summary
     *  {saved:[...], saved_count, skipped_*, errors}. dryRun scans + reports, writes nothing. */
    async ingestAttachments({ days, accounts, senders, dryRun = false, inbox, ingestDir } = {}) {
      const args = [path.join(HERE, '..', 'bin', 'ingest_mail.py')];
      if (days != null) args.push('--days', String(days));
      if (accounts) args.push('--accounts', String(accounts));
      if (dryRun) args.push('--dry-run');
      const env = { ...process.env, MAIL_DIR: mailDir };
      if (inbox) env.INGEST_INBOX = inbox;
      if (ingestDir) env.INGEST_DIR = ingestDir;
      if (senders != null) env.INGEST_MAIL_SENDERS = String(senders); // From-substring allow-list ('' = all)
      const out = await run(pythonBin, args, { timeoutMs: 420_000, env });
      return JSON.parse(out);
    },
  };
}
