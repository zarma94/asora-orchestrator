// Telegram INBOUND listener — natural chat with the ASORA orchestrator, MATT ONLY.
// Long-polls getUpdates; for messages from the allowed chat id it enqueues a `converse`
// job to the local Jobs API, waits, and replies. Others are ignored (identity lock).
// Keeps a short in-memory transcript per session for continuity. Send-gate lives in the
// converse prompt (never sends client-facing / destructive from a chat turn).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from './env.js';
import { safeBaseName, isIngestable, resolveUnderRoot, COMPANIES, createProjectBrain } from './ingest.js';
import { makeRegistry } from './registry.js';
import { makeAccess } from './access.js';
import { resolveBot, inScope } from './botcfg.js';
import { looksImportant } from './salience.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const cfg = loadEnv();
const API = `http://${cfg.API_HOST || '127.0.0.1'}:${cfg.API_PORT || 8787}`;
const KEY = cfg.ORCH_RUNNER_KEY;
const log = (...a) => console.error(new Date().toISOString(), ...a);

const BOT = resolveBot(process.env, cfg);
if (BOT.fatal) { log(`FATAL: ${BOT.fatal}`); process.exit(1); }
const TOKEN = BOT.token;
const ALLOWED = BOT.chat;
const SCOPE = BOT.projects;              // [] = whole brain
const OFFSET_FILE = `/opt/orchestrator/telegram-${BOT.name}.offset`;

if (!TOKEN || !ALLOWED || !KEY) { log(`FATAL: bot '${BOT.name}' needs token, chat id, ORCH_RUNNER_KEY`); process.exit(1); }

const registry = makeRegistry({
  orchestratorDir: cfg.ORCHESTRATOR_DIR, docsRoot: cfg.DOCS_ROOT, reposDir: cfg.REPOS_DIR,
  brainDir: cfg.BRAIN_DIR, configPath: path.join(HERE, '..', 'config', 'projects.json'),
  localConfigPath: cfg.PROJECTS_LOCAL,
});
const access = makeAccess({ configPath: cfg.ACCESS_CONFIG });

// Restricted (non-owner) principal: plain questions ONLY, answered from the role's
// filtered context via a converse-restricted job. Replies go to THEIR chat, never the owner's.
const sendTo = (chatId, text) => { for (let i=0;i<text.length;i+=3900) tg('sendMessage',{chat_id:chatId,text:text.slice(i,i+3900),disable_web_page_preview:true}); };
async function handleRestricted(msg, role){
  const chatId = msg.chat.id;
  if (!msg.text || msg.document || msg.photo){ sendTo(chatId, 'Access denied — this channel only answers questions.'); return; }
  if (msg.text.startsWith('/')){ log(`[access] role=${role} chat=${chatId} DENIED command: ${msg.text.slice(0,40)}`); sendTo(chatId, 'Access denied.'); return; }
  log(`[access] role=${role} chat=${chatId} ask`);
  const job = await postJob('orchestrator', 'converse-restricted', `ROLE: ${role}\nQUESTION: ${msg.text.slice(0,4000)}`);
  if (!job.id){ sendTo(chatId, '(unavailable — try again later)'); return; }
  for (let i=0;i<45;i++){
    await new Promise(s=>setTimeout(s,2000));
    let j2; try { j2 = await getJob(job.id); } catch { continue; }
    if (j2.status==='done'){ sendTo(chatId, String(j2.result?.text || "I don't have access to that information.").slice(0,3900)); return; }
    if (j2.status==='failed'){ sendTo(chatId, 'Access denied.'); return; }
  }
  sendTo(chatId, '(still working — ask again in a minute)');
}

const tg = (m, body) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const send = (text) => { for (let i=0;i<text.length;i+=3900) tg('sendMessage',{chat_id:ALLOWED,text:text.slice(i,i+3900),disable_web_page_preview:true}); };
const typing = () => tg('sendChatAction', { chat_id: ALLOWED, action: 'typing' }).catch(()=>{});

let transcript = []; // last turns, in memory
function readOffset(){ try { return parseInt(fs.readFileSync(OFFSET_FILE,'utf8'),10)||0; } catch { return 0; } }
function writeOffset(o){ try { fs.writeFileSync(OFFSET_FILE,String(o)); } catch {} }

async function ask(userText){
  transcript.push(`the owner: ${userText}`);
  const convo = transcript.slice(-12).join('\n');
  const r = await fetch(`${API}/api/jobs`, { method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${KEY}`},
    body: JSON.stringify({ project:'orchestrator', type:'converse', prompt: convo}) });
  const j = await r.json(); const id = (j.job||j).id;
  if (!id) return `(couldn't queue — ${JSON.stringify(j).slice(0,120)})`;
  for (let i=0;i<60;i++){
    await new Promise(s=>setTimeout(s,2000)); typing();
    const g = await (await fetch(`${API}/api/jobs/${id}`,{headers:{Authorization:`Bearer ${KEY}`}})).json();
    const job = g.job||g;
    if (job.status==='done'){ const t=(job.result&&job.result.text)||'(no reply)'; transcript.push(`You: ${t}`); return t; }
    if (job.status==='failed') return `(job failed: ${String(job.error||'').slice(0,150)})`;
    if (job.status==='needs_approval') return `(this needs your approval — check the dashboard)`;
  }
  return "(still working — I will follow up; ask me again in a moment)";
}

async function postJob(project, type, prompt){
  const r = await fetch(`${API}/api/jobs`, { method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${KEY}`},
    body: JSON.stringify({ project, type, prompt }) });
  const j = await r.json(); return (j.job||j);
}
async function getJob(id){
  const g = await (await fetch(`${API}/api/jobs/${id}`,{headers:{Authorization:`Bearer ${KEY}`}})).json();
  return g.job||g;
}
async function listJobs(qs){
  const g = await (await fetch(`${API}/api/jobs?${qs}`,{headers:{Authorization:`Bearer ${KEY}`}})).json();
  return g.jobs||[];
}
async function patchJob(id, status, note){
  const r = await fetch(`${API}/api/jobs/${id}`, { method:'PATCH',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${KEY}`},
    body: JSON.stringify({ status, note }) });
  return (await r.json());
}
// Resolve a short id prefix (the owner types the first 8 chars) to a full job id, within a status.
async function resolveJob(prefix, status){
  const jobs = await listJobs(status ? `status=${status}&limit=50` : 'limit=50');
  const hits = jobs.filter(j => j.id.startsWith(prefix.toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}

// ---- APPROVAL LOOP (send-gate lives here): act on held drafts from Telegram ----
// /pending — list needs_approval  ·  /show <id> — full draft  ·  /approve <id> —
// mark handled (does NOT send; sending stays the owner's action, rule 2)  ·  /reject <id> [why].
async function handlePropose(){
  // Scoped bots scan only their projects and render the result IN THIS thread (NOPUSH).
  const prompt = `${SCOPE.length ? `SCOPE: ${SCOPE.join(',')}\n` : ''}NOPUSH scan`;
  const job = await postJob('orchestrator', 'propose', prompt);
  if(!job.id){ send('(could not start the scan)'); return; }
  send('🧭 Scanning — proposals shortly (then /approve the ones you want).');
  for(let i=0;i<24;i++){
    await new Promise(s=>setTimeout(s,5000));
    let j; try { j = await getJob(job.id); } catch { continue; }
    if(j.status==='done'){
      const ps = j.result?.post?.proposals || [];
      if(!ps.length){ send('Nothing actionable stands out right now.'); return; }
      const lines = ps.map(p=>`• ${p.id.slice(0,8)} [${p.project}] ${String(p.task).slice(0,84)}`);
      send(`🧭 I can do these — /approve <id> (or /reject <id>):\n${lines.join('\n')}\n\n/show <id> for detail.`);
      return;
    }
    if(j.status==='failed'){ send('(scan failed — try again)'); return; }
  }
  send('(scan still running — /pending in a moment)');
}
async function handlePending(){
  const jobs = (await listJobs('status=needs_approval&limit=50')).filter(j=>inScope(j.project, SCOPE));
  if (!jobs.length){ send('✅ Nothing awaiting approval.'); return; }
  const lines = jobs.map(j => {
    const isProposal = j.result?.proposal && !j.result?.text;
    const kind = isProposal ? '🧭 do?' : '📄 draft';
    const sum = isProposal ? j.result.proposal.task
      : (j.result?.ladder?.summary || String(j.result?.text||'').slice(0,60) || j.type);
    return `• ${j.id.slice(0,8)} ${kind} [${j.project}] ${String(sum).replace(/\n/g,' ').slice(0,66)}`;
  });
  send(`🟡 ${jobs.length} awaiting you (🧭 = approve to DO it · 📄 = a draft to clear):\n${lines.join('\n')}\n\n/show <id> · /approve <id> · /reject <id> [reason]`);
}
async function handleShow(text){
  const m = text.match(/^\/show\s+(\S+)/i); if(!m){ send('Usage: /show <id>'); return; }
  const job = await resolveJob(m[1]) || await getJob(m[1]).catch(()=>null);
  if(!job || !job.id){ send('No job with that id.'); return; }
  if(!inScope(job.project, SCOPE)){ send('That item belongs to another company\'s bot.'); return; }
  const deliverable = job.result?.text || job.result?.ladder?.summary || '(no text)';
  send(`📄 ${job.id.slice(0,8)} [${job.project}] status:${job.status}\n\n${String(deliverable).slice(0,3600)}`);
}
async function handleApprove(text){
  const m = text.match(/^\/approve\s+(\S+)/i); if(!m){ send('Usage: /approve <id>'); return; }
  const job = await resolveJob(m[1], 'needs_approval'); if(!job){ send('No unique pending job with that id — /pending to list.'); return; }
  if(!inScope(job.project, SCOPE)){ send('That item belongs to another company\'s bot.'); return; }
  const isProposal = job.result?.proposal && !job.result?.text;
  if (isProposal){
    // A proposed task: approving RUNS it (needs_approval → queued → the runner executes the ladder).
    const r = await patchJob(job.id, 'queued', 'approved by the owner — executing');
    if(!r.job){ send(`(couldn't start: ${JSON.stringify(r).slice(0,120)})`); return; }
    send(`▶️ On it — ${job.project}: ${String(job.result.proposal.task).slice(0,90)}\njob ${job.id.slice(0,8)}. I'll report back (client-facing output will come back for a final OK).`);
    await pollAndReport(job.id, job.project);
  } else {
    // A completed draft: approving marks it handled. It does NOT send (rule: sending is the owner's).
    const r = await patchJob(job.id, 'done', 'approved by the owner via Telegram');
    if(r.job) send(`✅ Approved & cleared: ${job.id.slice(0,8)} [${job.project}].\nMarks it handled — does NOT send. Sending stays your action (copy from /show).`);
    else send(`(couldn't approve: ${JSON.stringify(r).slice(0,120)})`);
  }
}
async function handleReject(text){
  const m = text.match(/^\/reject\s+(\S+)(?:\s+([\s\S]+))?/i); if(!m){ send('Usage: /reject <id> [reason]'); return; }
  const job = await resolveJob(m[1], 'needs_approval'); if(!job){ send('No unique pending job with that id — /pending to list.'); return; }
  if(!inScope(job.project, SCOPE)){ send('That item belongs to another company\'s bot.'); return; }
  const r = await patchJob(job.id, 'done', `rejected by the owner: ${(m[2]||'no reason given').slice(0,200)}`);
  if(r.job) send(`🗑 Rejected & cleared: ${job.id.slice(0,8)} [${job.project}]. Nothing was sent.`);
  else send(`(couldn't reject: ${JSON.stringify(r).slice(0,120)})`);
}

// ---- INGEST entry points (the owner-only, same governed pipeline as the mail adapter) ----
// Files land in INGEST_INBOX/<sub>/ then an `ingest` job routes + stores them
// (trust:unverified, never overwrites verified facts). mtime is pre-aged 10s so the
// scanner's mid-write stability guard doesn't skip a file we fully wrote ourselves.
function saveToInbox(sub, name, buf){
  const dir = path.join(cfg.INGEST_INBOX, sub);
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, name);
  for (let i=1; fs.existsSync(dest) && i<100; i+=1) dest = path.join(dir, `${i}-${name}`);
  fs.writeFileSync(dest, buf);
  const t = new Date(Date.now() - 10_000);
  fs.utimesSync(dest, t, t);
  return dest;
}

// A document sent to the bot → download (Telegram bot API caps downloads at 20 MB) → inbox → ingest.
async function handleDocument(msg){
  const doc = msg.document;
  const name = safeBaseName(doc.file_name || 'document');
  if (!isIngestable(name)){
    send(`Can't ingest "${name}" — supported: pdf, docx, xlsx, pptx, md, txt, csv, html, eml, msg, rtf, epub. (Images need OCR — not yet.)`);
    return;
  }
  if ((doc.file_size || 0) > 20 * 1024 * 1024){
    send(`"${name}" is over Telegram's 20 MB bot download limit — drop it on Nextcloud and use /ingest <path>.`);
    return;
  }
  const gf = await (await tg('getFile', { file_id: doc.file_id })).json();
  const fp = gf?.result?.file_path;
  if (!fp){ send('(could not fetch that file from Telegram — try sending it again)'); return; }
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${fp}`);
  if (!res.ok){ send(`(file download failed: HTTP ${res.status} — try again)`); return; }
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = saveToInbox('telegram', name, buf);
  const job = await postJob('orchestrator', 'ingest', `ingest Telegram upload: ${name}`);
  if (!job.id){ send(`Saved ${name} to the inbox but couldn't queue the ingest job — it will be picked up by the next ingest run.`); return; }
  send(`📥 Got ${name} (${Math.round(buf.length/1024)} KB) → inbox.\nIngest job queued (${job.id.slice(0,8)}) — it routes the doc to the right project brain, stored as trust:unverified. I'll message you the result.`);
  log(`telegram doc ingested: ${dest}`);
}

// /newproject <company> <slug> [name] — accept the router's suggestion (or create
// pre-emptively): makes the brain under the master company, then moves everything
// parked in _unrouted/ back into the inbox and re-queues ingest so those files get
// routed now that the project exists.
async function handleNewProject(text){
  let company, slug, name;
  if (BOT.company) {
    // Scoped bot: the company is fixed → /newproject <slug> [name]
    const m = text.match(/^\/newproject\s+(\S+)(?:\s+(.+))?$/i);
    if (!m){ send(`Usage (on the ${BOT.label} bot): /newproject <slug> [name]\ne.g. /newproject zanzibar Zanzibar Beach Villas`); return; }
    company = BOT.company; slug = m[1].toLowerCase(); name = (m[2] || '').trim();
  } else {
    const m = text.match(/^\/newproject\s+(\S+)\s+(\S+)(?:\s+(.+))?$/i);
    if (!m){ send(`Usage: /newproject <company> <slug> [name]\ncompanies: ${Object.keys(COMPANIES).join(', ')}\ne.g. /newproject ceg zanzibar Zanzibar Beach Villas`); return; }
    company = m[1].toLowerCase(); slug = m[2].toLowerCase(); name = (m[3] || '').trim();
  }
  if (await registry.has(slug)) { send(`❌ Project ${slug} already exists — route docs to it directly (send them to me or /ingest).`); return; }
  const configPath = cfg.PROJECTS_LOCAL; // box-owned overlay — deploys never touch it
  const r = createProjectBrain({ brainDir: cfg.BRAIN_DIR, configPath, slug, company, name, reason: 'created by the owner via /newproject', source: 'telegram' });
  if (!r.ok){ send(`❌ ${r.error}`); return; }
  registry.invalidate();
  // Re-queue parked files so the router retries them against the new project.
  const un = path.join(cfg.INGEST_INBOX, '_unrouted');
  let moved = 0;
  try {
    for (const f of fs.readdirSync(un)){
      const src = path.join(un, f);
      try { if (!fs.statSync(src).isFile()) continue; } catch { continue; }
      let dest = path.join(cfg.INGEST_INBOX, f);
      for (let i=1; fs.existsSync(dest) && i<100; i+=1) dest = path.join(cfg.INGEST_INBOX, `${i}-${f}`);
      fs.renameSync(src, dest); moved += 1;
    }
  } catch { /* no _unrouted yet */ }
  let tail = '';
  if (moved){
    const job = await postJob('orchestrator', 'ingest', `re-route ${moved} parked file(s) after creating project ${slug}`);
    tail = `\n${moved} parked file(s) re-queued for routing (job ${job.id ? job.id.slice(0,8) : 'FAILED'}).`;
  }
  send(`🆕 Project ${slug} created under ${company.toUpperCase()}${name ? ` (${name})` : ''} — brain at brain/${slug}/wiki, stored trust:unverified as docs arrive.${tail}\nReminder: add a ${slug} row to projects/REGISTRY.md on the Mac when convenient.`);
}

// /ingest <path> — pull a file (or a folder's top-level files, max 25) from the
// Nextcloud mount into the inbox and queue the governed ingest. Paths resolve
// under DOCS_ROOT only (traversal-guarded).
async function handleIngestCmd(text){
  const m = text.match(/^\/ingest\s+(.+)/i);
  if (!m){ send('Usage: /ingest <path under Nextcloud>\ne.g. /ingest ACME/Morocco - Sample Project/07 Buyers/newdoc.pdf\n(or a folder — its top-level documents get ingested)'); return; }
  const rel = m[1].trim();
  const p = resolveUnderRoot(cfg.DOCS_ROOT, rel);
  if (!p){ send('That path escapes the Nextcloud root — give a path relative to it (no ..).'); return; }
  let st; try { st = fs.statSync(p); } catch { send(`Not found on Nextcloud: ${rel}\n(paths are relative to the NC root and case-sensitive; Mac→NC sync can lag ~15 min)`); return; }
  let files = [];
  if (st.isDirectory()){
    files = fs.readdirSync(p)
      .filter((f) => !f.startsWith('.') && isIngestable(f))
      .map((f) => path.join(p, f))
      .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } })
      .slice(0, 25);
  } else {
    if (!isIngestable(p)){ send(`Unsupported file type: ${path.basename(p)}`); return; }
    files = [p];
  }
  if (!files.length){ send('No ingestable documents at that path.'); return; }
  const copied = []; const skippedBig = [];
  for (const f of files){
    const s = fs.statSync(f);
    if (s.size > 50 * 1024 * 1024){ skippedBig.push(path.basename(f)); continue; }
    copied.push(path.basename(saveToInbox('nc', safeBaseName(path.basename(f)), fs.readFileSync(f))));
  }
  if (!copied.length){ send(`Nothing copied${skippedBig.length ? ` (${skippedBig.length} file(s) over 50 MB)` : ''}.`); return; }
  const job = await postJob('orchestrator', 'ingest', `ingest ${copied.length} file(s) pulled from NC: ${rel}`);
  send(`📥 Copied ${copied.length} file(s) from Nextcloud → inbox:\n${copied.slice(0,10).join('\n')}${copied.length>10?`\n…+${copied.length-10} more`:''}${skippedBig.length?`\nSkipped (>50 MB): ${skippedBig.join(', ')}`:''}\nIngest job queued (${job.id ? job.id.slice(0,8) : 'FAILED'}) — I'll message you the result.`);
}

// /do <project> <task>  (alias /ladder) — run a real task through the full ladder.
// Acks immediately, polls in the background (does NOT block the Telegram loop),
// then reports the outcome. Client-facing work still stops at needs_approval (send-gate).
async function handleLadder(text){
  const rest = text.replace(/^\/(?:do|ladder)\s+/i,'').trim();
  if (!rest){ send('Usage: /do <task> — I route it to the right team member.\nOr /do <project> <task> to target one directly.'); return; }
  const parts = rest.split(/\s+/);
  const first = parts[0].toLowerCase();
  const remainder = parts.slice(1).join(' ');
  // Direct-to-employee: first token is a real project AND in this bot's scope.
  if (remainder && inScope(first, SCOPE) && await registry.has(first)){
    const job = await postJob(first, 'ladder', remainder);
    if (!job.id){ send(`(couldn't queue: ${JSON.stringify(job).slice(0,160)})`); return; }
    send(`🚀 ${first} — running the ladder…\njob ${job.id.slice(0,8)}`);
    await pollAndReport(job.id, first);
    return;
  }
  // Otherwise → hand the whole task to a CEO, who delegates to the team.
  const company = BOT.company || (COMPANIES[first] ? first : null);
  if (!company){ send(`Which company? On a company bot: /do <task>.\nOn the main bot: /do <company> <task> (${Object.keys(COMPANIES).join('/')}) or /do <project> <task>.`); return; }
  const delegTask = BOT.company ? rest : remainder;   // main bot: drop the company token
  if (!delegTask){ send(`Usage: /do ${company} <task>`); return; }
  const job = await postJob('orchestrator', 'delegate', `COMPANY: ${company}\nTASK: ${delegTask}`);
  if (!job.id){ send('(could not dispatch to the CEO)'); return; }
  send(`🏢 ${company.toUpperCase()} CEO is routing this to the team…\njob ${job.id.slice(0,8)}`);
  await pollAndReport(job.id, `${company} CEO`);
}

// Poll a running job (~15 min) and report the outcome to Telegram. Shared by /do and
// approved proposals. needs_approval (client-facing) → shown with /approve hint.
async function pollAndReport(id, project){
  for (let i=0;i<90;i++){
    await new Promise(s=>setTimeout(s,10000));
    let j2; try { j2 = await getJob(id); } catch { continue; }
    const st = j2.status;
    if (st!=='done' && st!=='needs_approval' && st!=='failed') continue;
    if (st==='failed'){ send(`❌ Failed — ${project} (job ${id.slice(0,8)})\n${String(j2.error||'').slice(0,300)}`); return; }
    const L = j2.result?.ladder || {};
    const stages = (L.stages||[]).map(s=>`${s.stage}:${s.verdict}`).join(' · ');
    const wb = L.mode ? `${L.mode} — delegated to: ${(L.assignments||[]).join(', ')}`
      : (L.write_back?.written ? 'saved to brain' : (L.write_back?.reason || 'not written'));
    const head = st==='needs_approval' ? `🟡 Needs your approval — ${project}` : `✅ Done — ${project}`;
    const deliverable = String(j2.result?.text || '').slice(0, 2800);
    const foot = st==='needs_approval' ? `\n\n→ /approve ${id.slice(0,8)}  ·  /reject ${id.slice(0,8)} [reason]  (approve marks it handled; it does NOT send)` : '';
    send(`${head}\njob ${id.slice(0,8)}\nstages: ${stages}\nwrite-back: ${wb}\n\n${deliverable}${foot}`);
    return;
  }
  send(`(still running — ${project} job ${id.slice(0,8)}; ask me for it later)`);
}

async function loop(){
  let offset = readOffset();
  log(`telegram bot '${BOT.label}' up. chat=${ALLOWED}, scope=${SCOPE.length ? SCOPE.join(',') : 'ALL'}, api=${API}`);
  for(;;){
    try{
      const u = await (await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=30&offset=${offset+1}`)).json();
      for (const up of (u.result||[])){
        offset = up.update_id; writeOffset(offset);
        const msg = up.message; if (!msg) continue;
        if (String(msg.chat.id) !== ALLOWED){
          // Not the owner. Known restricted role → filtered Q&A only. Unknown → ignore (default-deny).
          const role = access.telegramRole(msg.chat.id);
          if (role) handleRestricted(msg, role).catch(e=>log('restricted error', e.message));
          else log(`ignored msg from ${msg.chat.id}`);
          continue;
        }
        if (msg.document){
          handleDocument(msg).catch(e=>{ log('doc ingest error', e.message); send('(error ingesting that file — try again)'); });
          continue;
        }
        if (msg.photo){
          send('Images need OCR — not supported yet. Send it as a PDF/document, or put it on Nextcloud and use /ingest <path>.');
          continue;
        }
        if (!msg.text) continue;
        const text = msg.text;
        if (/^\/(do|ladder)\b/i.test(text)) {
          handleLadder(text).catch(e=>{ log('ladder error', e.message); send('(error dispatching that task)'); });
        } else if (/^\/ingest\b/i.test(text)) {
          handleIngestCmd(text).catch(e=>{ log('ingest cmd error', e.message); send('(error running /ingest — try again)'); });
        } else if (/^\/newproject\b/i.test(text)) {
          handleNewProject(text).catch(e=>{ log('newproject error', e.message); send('(error creating the project — try again)'); });
        } else if (/^\/propose\b/i.test(text)) {
          handlePropose().catch(e=>{ log('propose error', e.message); send('(error starting the scan)'); });
        } else if (/^\/pending\b/i.test(text)) {
          handlePending().catch(e=>{ log('pending error', e.message); send('(error listing pending)'); });
        } else if (/^\/show\b/i.test(text)) {
          handleShow(text).catch(e=>{ log('show error', e.message); send('(error)'); });
        } else if (/^\/approve\b/i.test(text)) {
          handleApprove(text).catch(e=>{ log('approve error', e.message); send('(error approving)'); });
        } else if (/^\/reject\b/i.test(text)) {
          handleReject(text).catch(e=>{ log('reject error', e.message); send('(error rejecting)'); });
        } else if (/^\/help\b/i.test(text)) {
          send(`WHAT I CAN DO${SCOPE.length?` — ${BOT.label}${BOT.company?` CEO`:''} (${SCOPE.join(', ')})`:''}\n• Ask me anything — I answer from the brain\n• /do <task> — I route it to the right team member and run it${BOT.company?'':' (main bot: /do <company> <task>)'}\n• /do <project> <task> — target one employee directly\n• /propose — I scan ${SCOPE.length?'this company':'the brain'} and suggest what I can do; /approve to run\n• /pending — awaiting you (🧭 approve to DO · 📄 draft to clear) · /show · /approve · /reject <id> [reason]\n• Send a document, or /ingest <Nextcloud path> — files into the brain\n• /newproject ${BOT.company?'<slug> [name]':'<company> <slug> [name]'}\n\nClient-facing sends are ALWAYS held for your OK.`);
        } else if (/^\/remember\b/i.test(text)) {
          const fact = text.replace(/^\/remember\s+/i,'').trim();
          if (!fact){ send('Usage: /remember <the fact to store>'); }
          else { postJob('orchestrator','capture', `FORCE SCOPE: ${SCOPE.join(',')}\n${fact}`).then(j=>send(j.id?'📌 Capturing that…':'(could not capture)')).catch(()=>send('(capture error)')); }
        } else {
          typing();
          // Salience gate: quietly turn important chatter into brain memory (non-blocking,
          // cheap pre-filter first so casual messages cost nothing). Q&A still runs below.
          if (looksImportant(text)) postJob('orchestrator','capture', `SCOPE: ${SCOPE.join(',')}\n${text}`).catch(()=>{});
          try { send(await ask(text)); } catch(e){ log('ask error', e.message); send('(error handling that — try again)'); }
        }
      }
    } catch(e){ log('poll error', e.message); await new Promise(s=>setTimeout(s,5000)); }
  }
}

// Only start polling when run as the entrypoint (so tests can import resolveBot/inScope).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) loop();
