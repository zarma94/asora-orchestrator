// Slack front-end — one app, but each channel can talk to a DIFFERENT instance's Jobs API.
// Socket Mode (no public endpoint). channels.json maps a channel → scope + optional `backend`
// {url,key}: project/company/holding channels default to the LOCAL (orch-box) API, while e.g. the
// ACME channels point at the ACME box (its own Google-Drive-fed brain, reached over a private tunnel),
// so each company's data stays on its own server and never goes stale. Slash commands do the
// actions; plain messages route through `assist` (talk → work); held results come back with buttons.
import pkg from '@slack/bolt';
const { App } = pkg;
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
import { loadChannels, resolveChannel, inScope } from './slackcfg.js';
import { COMPANIES } from './ingest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const cfg = loadEnv();
const KEY = cfg.ORCH_RUNNER_KEY;
const LOCAL = { url: `http://${cfg.API_HOST || '127.0.0.1'}:${cfg.API_PORT || 8787}`, key: KEY };
const log = (...a) => console.error(new Date().toISOString(), ...a);

if (!cfg.SLACK_BOT_TOKEN || !cfg.SLACK_APP_TOKEN || !KEY) {
  log('FATAL: need SLACK_BOT_TOKEN (xoxb-), SLACK_APP_TOKEN (xapp-), ORCH_RUNNER_KEY'); process.exit(1);
}

// ---- Jobs API helpers — `be` (backend {url,key}) selects the instance for THIS channel. ----
const INTERACTIVE = 20;   // chat runs high-priority so it never queues behind background ingest
const hdr = (be) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${be.key}` });
async function postJob(be, project, type, prompt, priority = INTERACTIVE) {
  const r = await fetch(`${be.url}/api/jobs`, { method: 'POST', headers: hdr(be), body: JSON.stringify({ project, type, prompt, priority }) });
  const j = await r.json(); return (j.job || j);
}
async function getJob(be, id) { const g = await (await fetch(`${be.url}/api/jobs/${id}`, { headers: hdr(be) })).json(); return g.job || g; }
async function listJobs(be, qs) { const g = await (await fetch(`${be.url}/api/jobs?${qs}`, { headers: hdr(be) })).json(); return g.jobs || []; }
async function patchJob(be, id, status, note) { return (await (await fetch(`${be.url}/api/jobs/${id}`, { method: 'PATCH', headers: hdr(be), body: JSON.stringify({ status, note }) })).json()); }
async function resolveJob(be, prefix, status) {
  const jobs = await listJobs(be, status ? `status=${status}&limit=50` : 'limit=50');
  const hits = jobs.filter((j) => j.id.startsWith(String(prefix).toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}

// ---- OPS (server actions) — allow-listed verbs on the orch box, approval-gated via Slack.
// The ops surface (/api/ops, OPS_API_KEY) runs an isolated non-root executor with a fixed verb
// allow-list + scoped sudoers; an agent can only REQUEST a vetted verb, and it runs ONLY after
// the owner taps Approve here. No arbitrary commands, no free shell. Ops live on the orch box (local).
const OPS = { url: LOCAL.url, key: cfg.OPS_API_KEY };
const opsHdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${OPS.key}` };
async function opsCreate(verb) { const r = await fetch(`${OPS.url}/api/ops`, { method: 'POST', headers: opsHdr, body: JSON.stringify({ verb }) }); return (await r.json()).job || null; }
async function opsGet(id) { const g = await (await fetch(`${OPS.url}/api/ops/${id}`, { headers: opsHdr })).json(); return g.job || g; }
async function opsApprove(id) { const r = await fetch(`${OPS.url}/api/ops/${id}`, { method: 'PATCH', headers: opsHdr, body: JSON.stringify({ status: 'queued', approved_by: 'matt-slack' }) }); return (await r.json()).job || null; }
function opsApprovalBlocks(verb, id) {
  const desc = verb === 'sync-restart' ? 'Sync the deploy dir + restart the runner and API' : verb === 'migrate' ? 'Run database migrations' : verb;
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `🖥️ *Server action requested:* \`${verb}\`\n${desc}\n_On the orchestrator box. Approve to run._` } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: '✅ Approve & run' }, style: 'primary', action_id: 'ops_approve', value: id },
      { type: 'button', text: { type: 'plain_text', text: '🗑 Cancel' }, action_id: 'ops_reject', value: id },
    ] },
  ];
}
async function pollOpsAndPost(client, channel, id, verb) {
  for (let i = 0; i < 30; i++) {
    await new Promise((s) => setTimeout(s, 4000)); let j; try { j = await opsGet(id); } catch { continue; }
    if (j.status === 'done') { await client.chat.postMessage({ channel, text: `✅ \`${verb}\` done.\n\`\`\`${JSON.stringify(j.result || {}).slice(0, 600)}\`\`\`` }); return; }
    if (j.status === 'failed') { await client.chat.postMessage({ channel, text: `❌ \`${verb}\` failed.\n\`\`\`${JSON.stringify(j.result || {}).slice(0, 600)}\`\`\`` }); return; }
  }
  await client.chat.postMessage({ channel, text: `(\`${verb}\` still running…)` });
}
const postedOps = new Set();   // ops ids already surfaced in Slack (avoid double-posting)
async function handleOps(p, say, client, channel) {
  if (!OPS.key) { await say("Server actions aren't enabled here."); return; }
  if (!p.verb) { await say("That action isn't in the safe allow-list yet. I can: *restart/redeploy the system* (`sync-restart`) or *run a db migration* (`migrate`) — both need your approval. (More actions can be added per-server, allow-listed.)"); return; }
  const oj = await opsCreate(p.verb);
  if (!oj || !oj.id) { await say('(could not queue that action)'); return; }
  postedOps.add(oj.id);
  if (oj.status === 'awaiting_approval') { await say({ text: `Server action needs your approval: ${p.verb}`, blocks: opsApprovalBlocks(p.verb, oj.id) }); }
  else { await say(`🖥️ Running \`${p.verb}\`…`); await pollOpsAndPost(client, channel, oj.id, p.verb); }
}
// Surface ANY awaiting-approval server action in Slack (not Telegram) — covers ops requested by an
// agent or the API, not just via a Slack message. Posts once, to the holding channel, with buttons.
async function opsApprovalPoller(client) {
  if (!OPS.key) return;
  const holding = Object.entries(channelsCfg()).find(([, c]) => (c.kind || (c.company ? 'company' : c.projects ? 'project' : 'holding')) === 'holding')?.[0];
  if (!holding) return;
  setInterval(async () => {
    let jobs; try { jobs = await listOpsAwaiting(); } catch { return; }
    for (const oj of jobs) {
      if (postedOps.has(oj.id)) continue;
      postedOps.add(oj.id);
      try { await client.chat.postMessage({ channel: holding, text: `Server action needs your approval: ${oj.verb}`, blocks: opsApprovalBlocks(oj.verb, oj.id) }); } catch { postedOps.delete(oj.id); }
    }
  }, 15000);
}
async function listOpsAwaiting() { const g = await (await fetch(`${OPS.url}/api/ops?status=awaiting_approval&limit=20`, { headers: opsHdr })).json(); return g.jobs || []; }

import bpkg from '@slack/bolt';
const { LogLevel } = bpkg;
const app = new App({ token: cfg.SLACK_BOT_TOKEN, appToken: cfg.SLACK_APP_TOKEN, socketMode: true, logLevel: process.env.SLACK_DEBUG ? LogLevel.DEBUG : LogLevel.INFO });
const channelsCfg = () => loadChannels(cfg.CHANNELS_CONFIG);
const chan = (id) => resolveChannel(channelsCfg(), id);
const beOf = (c) => (c && c.backend) ? c.backend : LOCAL;   // which instance this channel talks to

function approvalBlocks(text, jobId) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: '✅ Approve' }, style: 'primary', action_id: 'approve_job', value: jobId },
      { type: 'button', text: { type: 'plain_text', text: '🗑 Reject' }, action_id: 'reject_job', value: jobId },
    ] },
  ];
}

// --- ASORA-wide human-output guard. Every job result shown in a channel goes through humanText().
// LLM jobs store the FORMATTED deliverable at result.post.text and the RAW model stdout at
// result.text — we prefer post.text. If what we'd show still looks like code/JSON (a model that
// ignored its formatting instructions), we refuse to dump it and show a neutral line instead.
// This is the single choke point so NO path — mail, converse, ladder, ops — can ever leak code.
function looksLikeCode(t) {
  const s = String(t || '').trim();
  if (/^```/.test(s)) return true;                                       // fenced code block
  if (/^[[{][\s\S]*[\]}]$/.test(s) && /["'][\w-]+["']\s*:/.test(s)) return true;  // bare JSON object/array
  return false;
}
function humanText(job, fallback = '(done — nothing to show)') {
  const R = (job && job.result) || {};
  for (const c of [R.post && R.post.text, R.text]) {
    const s = String(c == null ? '' : c).trim();
    if (s && !looksLikeCode(s)) return s;
  }
  return fallback;
}

// Poll a running job (on the channel's backend) and post the outcome (buttons if it needs approval).
async function pollAndPost(be, client, channel, id, label) {
  for (let i = 0; i < 90; i++) {
    await new Promise((s) => setTimeout(s, 10000));
    let j; try { j = await getJob(be, id); } catch { continue; }
    const st = j.status;
    if (st !== 'done' && st !== 'needs_approval' && st !== 'failed') continue;
    if (st === 'failed') { await client.chat.postMessage({ channel, text: `❌ Failed — ${label} (job ${id.slice(0, 8)})\n${String(j.error || '').slice(0, 300)}` }); return; }
    const L = j.result?.ladder || {};
    const stages = (L.stages || []).map((s) => `${s.stage}:${s.verdict}`).join(' · ');
    const deliverable = humanText(j, '(no output)').slice(0, 2800);
    if (st === 'needs_approval') {
      // Two very different reasons a job lands here:
      //  • escalated/blocked → it's a REPORT ("couldn't finish"), nothing to approve → no buttons, auto-close.
      //  • a real held draft/proposal → show Approve/Reject.
      if (j.result?.ladder?.escalated === true) {
        await client.chat.postMessage({ channel, text: `⚠️ Couldn't finish — ${label} (job ${id.slice(0, 8)})\n${stages ? `_${stages}_\n` : ''}\n${deliverable}\n\n_This is a report, not something to approve — nothing will run. Tell me what to change or give me what it needs._` });
        try { await patchJob(be, id, 'done', 'escalation surfaced to the owner — no action to approve'); } catch { /* leave parked if close fails */ }
      } else {
        await client.chat.postMessage({ channel, text: `🟡 Needs your approval — ${label}`, blocks: approvalBlocks(`🟡 *${label}* — job \`${id.slice(0, 8)}\`\n${stages ? `_${stages}_\n` : ''}\n${deliverable}`, id) });
      }
    } else {
      await client.chat.postMessage({ channel, text: `✅ Done — ${label} (job ${id.slice(0, 8)})\n${stages ? `_${stages}_\n` : ''}\n${deliverable}` });
    }
    return;
  }
  await client.chat.postMessage({ channel, text: `(still running — ${label} job ${id.slice(0, 8)})` });
}

// A mail-plan job produces parked mail-exec proposal(s). Poll it, then post each plan as an
// approval card — NOTHING sends or moves until the owner taps Approve (→ doApprove runs the mail-exec).
async function pollAndPostPlan(be, client, channel, id, label) {
  for (let i = 0; i < 45; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    let j; try { j = await getJob(be, id); } catch { continue; }
    if (j.status === 'failed') { await client.chat.postMessage({ channel, text: `❌ Couldn't build the mail plan (job ${id.slice(0, 8)}).` }); return; }
    if (j.status !== 'done') continue;
    // LLM jobs put the post() return under result.post; result.text is the RAW model output — never post that.
    const R = j.result || {};
    const props = R.post?.proposals || R.proposals || [];
    if (!props.length) { await client.chat.postMessage({ channel, text: String(R.post?.text || 'Nothing to do.').slice(0, 2000) }); return; }
    for (const pr of props) {
      await client.chat.postMessage({ channel, text: `🟡 Approve these ${label} mail actions?`, blocks: approvalBlocks(`🟡 *${label} — mail actions*\n${pr.summary}\n\n_Nothing sends or moves until you tap Approve._`, pr.id) });
    }
    return;
  }
  await client.chat.postMessage({ channel, text: '(mail planning timed out)' });
}

// ---- slash commands (scope + backend come from the invoking channel) ----
app.command('/do', async ({ command, ack, respond, client }) => {
  await ack();
  const c = chan(command.channel_id);
  if (!c) { await respond("This channel isn't mapped — add it to channels.json."); return; }
  const be = beOf(c);
  const task = command.text.trim();
  if (!task) { await respond('Usage: /do <task>'); return; }
  const parts = task.split(/\s+/); const first = parts[0].toLowerCase(); const remainder = parts.slice(1).join(' ');
  if (c.kind === 'project' && c.projects[0]) {
    const job = await postJob(be, c.projects[0], 'ladder', task);
    await respond(`🚀 ${c.projects[0]} — running…`); pollAndPost(be, client, command.channel_id, job.id, c.projects[0]); return;
  }
  if (c.kind === 'company' && c.company) {
    if (remainder && inScope(first, c.projects)) {
      const job = await postJob(be, first, 'ladder', remainder);
      await respond(`🚀 ${first} — running…`); pollAndPost(be, client, command.channel_id, job.id, first); return;
    }
    const job = await postJob(be, 'orchestrator', 'delegate', `COMPANY: ${c.company}\nTASK: ${task}`);
    await respond(`🏢 ${c.company.toUpperCase()} CEO is routing this to the team…`); pollAndPost(be, client, command.channel_id, job.id, `${c.company} CEO`); return;
  }
  if (COMPANIES[first] && remainder) { const job = await postJob(be, 'orchestrator', 'delegate', `COMPANY: ${first}\nTASK: ${remainder}`); await respond(`🏢 ${first.toUpperCase()} CEO routing…`); pollAndPost(be, client, command.channel_id, job.id, `${first} CEO`); return; }
  if (remainder) { const job = await postJob(be, first, 'ladder', remainder); await respond(`🚀 ${first} — running…`); pollAndPost(be, client, command.channel_id, job.id, first); return; }
  await respond('Usage: /do <company|project> <task>');
});

app.command('/propose', async ({ command, ack, respond, client }) => {
  await ack();
  const c = chan(command.channel_id); if (!c) { await respond('Channel not mapped.'); return; }
  const be = beOf(c);
  const prompt = `${c.projects.length ? `SCOPE: ${c.projects.join(',')}\n` : ''}NOPUSH scan`;
  const job = await postJob(be, 'orchestrator', 'propose', prompt);
  await respond('🧭 Scanning — proposals shortly.');
  for (let i = 0; i < 24; i++) {
    await new Promise((s) => setTimeout(s, 5000)); let j; try { j = await getJob(be, job.id); } catch { continue; }
    if (j.status === 'done') {
      const ps = j.result?.post?.proposals || [];
      if (!ps.length) { await client.chat.postMessage({ channel: command.channel_id, text: 'Nothing actionable stands out right now.' }); return; }
      const lines = ps.map((p) => `• \`${p.id.slice(0, 8)}\` [${p.project}] ${String(p.task).slice(0, 90)}`);
      await client.chat.postMessage({ channel: command.channel_id, text: `🧭 I can do these — /approve <id>:\n${lines.join('\n')}` }); return;
    }
    if (j.status === 'failed') { await client.chat.postMessage({ channel: command.channel_id, text: '(scan failed)' }); return; }
  }
});

app.command('/pending', async ({ command, ack, respond }) => {
  await ack();
  const c = chan(command.channel_id); if (!c) { await respond('Channel not mapped.'); return; }
  const be = beOf(c);
  const jobs = (await listJobs(be, 'status=needs_approval&limit=50')).filter((j) => inScope(j.project, c.projects));
  if (!jobs.length) { await respond('✅ Nothing awaiting approval here.'); return; }
  const lines = jobs.map((j) => { const isP = j.result?.proposal && !j.result?.text; return `• \`${j.id.slice(0, 8)}\` ${isP ? '🧭 do?' : '📄 draft'} [${j.project}] ${String(isP ? j.result.proposal.task : (j.result?.ladder?.summary || '')).slice(0, 64)}`; });
  await respond(`🟡 ${jobs.length} awaiting you:\n${lines.join('\n')}\n/approve <id> · /reject <id>`);
});

app.command('/approve', async ({ command, ack, respond, client }) => { await ack(); await doApprove(command.channel_id, command.text.trim(), respond, client); });
app.command('/reject', async ({ command, ack, respond }) => {
  await ack();
  const c = chan(command.channel_id); const be = beOf(c);
  const [id, ...why] = command.text.trim().split(/\s+/);
  const job = await resolveJob(be, id, 'needs_approval'); if (!job) { await respond('No unique pending job with that id.'); return; }
  if (!canApprove(c, job)) { await respond('That item belongs to another channel.'); return; }
  const r = await patchJob(be, job.id, 'done', `rejected by the owner: ${(why.join(' ') || 'no reason').slice(0, 200)}`);
  await respond(r.job ? `🗑 Rejected \`${job.id.slice(0, 8)}\` — nothing sent.` : '(could not reject)');
});
app.command('/remember', async ({ command, ack, respond }) => {
  await ack();
  const c = chan(command.channel_id); const be = beOf(c); const fact = command.text.trim();
  if (!fact) { await respond('Usage: /remember <fact>'); return; }
  const job = await postJob(be, 'orchestrator', 'capture', `FORCE SCOPE: ${(c?.projects || []).join(',')}\n${fact}`);
  await respond(job.id ? '📌 Capturing that…' : '(could not capture)');
});

// Can this channel act on this job? Project channels: strict project scope. Company channels
// also own their delegate jobs (project 'orchestrator', but `COMPANY: <slug>` in the prompt).
// The holding channel oversees everything.
function canApprove(c, job) {
  if (!c) return true;
  if (c.kind === 'holding') return true;
  if (inScope(job.project, c.projects)) return true;
  if (c.company && job.project === c.company) return true;
  const m = String(job.prompt || '').match(/^COMPANY:\s*([\w-]+)/mi);
  return !!(c.company && m && m[1].toLowerCase() === c.company.toLowerCase());
}

async function doApprove(channelId, idText, respond, client) {
  log('approve tap', { channel: channelId, id: String(idText).slice(0, 8) });
  const c = chan(channelId); const be = beOf(c);
  const job = await resolveJob(be, idText, 'needs_approval');
  if (!job) { log('approve → no unique pending job', String(idText).slice(0, 8)); await respond('No unique pending job with that id.'); return; }
  if (!canApprove(c, job)) { log('approve → out of scope', { id: job.id.slice(0, 8), project: job.project, ch: channelId }); await respond('That item belongs to another channel.'); return; }
  const isProposal = job.result?.proposal && !job.result?.text;
  if (isProposal) {
    const r = await patchJob(be, job.id, 'queued', 'approved by the owner — executing');
    if (!r.job) { log('approve → requeue rejected', job.id.slice(0, 8)); await respond('(could not start)'); return; }
    log('approve → executing', job.id.slice(0, 8));
    await respond(`▶️ On it — ${job.project}. I'll report back.`); pollAndPost(be, client, channelId, job.id, job.project);
  } else {
    const r = await patchJob(be, job.id, 'done', 'approved by the owner via Slack');
    log('approve → mark handled', { id: job.id.slice(0, 8), ok: !!r.job });
    await respond(r.job ? `✅ Approved \`${job.id.slice(0, 8)}\` — marks it handled; does NOT send (copy the draft to send).` : '(could not approve)');
  }
}

// ---- interactive buttons ----
app.action('approve_job', async ({ ack, body, action, client, respond }) => { await ack(); await doApprove(body.channel?.id, action.value, async (t) => respond({ text: t, replace_original: false }), client); });
app.action('reject_job', async ({ ack, body, action, respond }) => {
  await ack();
  const be = beOf(chan(body.channel?.id));
  const job = await resolveJob(be, action.value, 'needs_approval'); if (!job) { await respond({ text: 'Already handled.', replace_original: false }); return; }
  await patchJob(be, job.id, 'done', 'rejected by the owner via Slack button');
  await respond({ text: `🗑 Rejected \`${job.id.slice(0, 8)}\` — nothing sent.`, replace_original: false });
});

// ---- ops action buttons (server actions run ONLY after this approve) ----
app.action('ops_approve', async ({ ack, body, action, client, respond }) => {
  await ack();
  const oj = await opsApprove(action.value);
  if (!oj) { await respond({ text: 'Already handled or expired.', replace_original: false }); return; }
  await respond({ text: `▶️ Approved — running \`${oj.verb}\`…`, replace_original: false });
  await pollOpsAndPost(client, body.channel?.id, action.value, oj.verb);
});
app.action('ops_reject', async ({ ack, respond }) => { await ack(); await respond({ text: '🗑 Cancelled — nothing ran on the server.', replace_original: false }); });

// ---- plain messages: talk like an employee. `assist` (on the channel's backend) routes intent. ----
async function pollText(be, id) { for (let i = 0; i < 40; i++) { await new Promise((s) => setTimeout(s, 2000)); let j; try { j = await getJob(be, id); } catch { continue; } if (j.status === 'done') return humanText(j, '(no answer)'); if (j.status === 'failed') return '(error)'; } return '(still working…)'; }
// Transcribe a Slack voice note locally (faster-whisper venv → text). No API key.
async function transcribeSlackAudio(file, say) {
  if (!cfg.WHISPER_PYTHON) return '';
  const url = file.url_private_download || file.url_private;
  if (!url) return '';
  await say('🎧 transcribing your voice note…').catch(() => {});
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.SLACK_BOT_TOKEN}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (String(file.name || 'a.m4a').split('.').pop() || 'm4a').toLowerCase().replace(/[^a-z0-9]/g, '') || 'm4a';
  const tmp = `/tmp/vn-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  fs.writeFileSync(tmp, buf);
  const text = await new Promise((resolve) => {
    execFile(cfg.WHISPER_PYTHON, [path.join(HERE, '..', 'bin', 'transcribe.py'), tmp],
      { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  if (text) await say(`📝 heard: "${text.slice(0, 240)}"`).catch(() => {});
  return text;
}

app.message(async ({ message, say, client }) => {
  if (process.env.SLACK_DEBUG) log('MSG event', { ch: message.channel, subtype: message.subtype, bot: !!message.bot_id, files: (message.files || []).length, text: String(message.text || '').slice(0, 40) });
  if (message.bot_id) return;                                        // ignore bot echoes
  let text = String(message.text || '').trim();
  // VOICE: transcribe an audio attachment and treat the transcript as the message.
  if (!text && Array.isArray(message.files)) {
    const audio = message.files.find((f) => String(f.mimetype || '').startsWith('audio/') || /\.(m4a|mp3|ogg|wav|mp4|aac|webm|opus)$/i.test(f.name || ''));
    if (audio) { try { text = await transcribeSlackAudio(audio, say); } catch (e) { log('voice error', e.message); } }
  }
  if (!text) return;                                                 // system/empty/edited with nothing to act on
  const c = chan(message.channel);
  if (!c) { if (process.env.SLACK_DEBUG) log('MSG dropped — unmapped channel', message.channel); return; }  // unmapped channel → ignore
  if (text.startsWith('/')) return;                                 // slash handled elsewhere
  const be = beOf(c);
  try {
    const a = await postJob(be, 'orchestrator', 'assist', `KIND: ${c.kind}\nCOMPANY: ${c.company || ''}\nSCOPE: ${c.projects.join(',')}\nSOURCE: slack ${c.label}\nMESSAGE: ${text}`);
    for (let i = 0; i < 30; i++) {
      await new Promise((s) => setTimeout(s, 2000)); let j; try { j = await getJob(be, a.id); } catch { continue; }
      if (j.status === 'failed') { return; }
      if (j.status !== 'done') continue;
      const p = j.result?.post || {};
      if (p.reply) { await say(p.reply); return; }
      if (p.job_kind === 'ops') { await handleOps(p, say, client, message.channel); return; }
      if (p.job_kind === 'task') { await say(`🛠 On it…`); await pollAndPost(be, client, message.channel, p.job_id, c.label); return; }
      if (p.job_kind === 'mailplan') { await say('📬 Reading your inbox and building the plan…'); await pollAndPostPlan(be, client, message.channel, p.job_id, c.label); return; }
      if (p.job_kind === 'question') { await say((await pollText(be, p.job_id)).slice(0, 3500)); return; }
      if (p.job_kind === 'fact') { await say(`📌 Noted: ${String(p.fact || '').slice(0, 200)}`); return; }
      return;
    }
  } catch (e) { log('assist error', e.message); }
});

(async () => { await app.start(); opsApprovalPoller(app.client); log(`Slack listener up (Socket Mode). channels=${cfg.CHANNELS_CONFIG}`); })();
