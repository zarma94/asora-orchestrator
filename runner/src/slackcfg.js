// Slack channel → scope resolution (pure, side-effect-free, testable).
// channels.json (ROOT-owned) maps a Slack channel id to what it controls:
//   { "C0ABC": { "kind": "project",  "projects": ["ceg-stake"],            "label": "ACME Stake" },
//     "C0DEF": { "kind": "company",  "company": "ceg",
//                "projects": ["Sample Project","ceg-stake","SampleRegion-rwa"],    "label": "ACME" },
//     "C0GHI": { "kind": "holding",                                        "label": "Holding" } }
// kind:
//   project  → messages act on the one project (ask scoped to it; /do → that employee directly)
//   company  → the CEO channel: /do delegates to agents/<company>/_HUB.md; ask spans `projects`
//   holding  → whole brain; /do <company|project>
import fs from 'node:fs';

export function loadChannels(configPath) {
  try { const j = JSON.parse(fs.readFileSync(configPath, 'utf8')); return (j && typeof j === 'object') ? j : {}; }
  catch { return {}; }
}

/** Resolve a channel id to its scope, or null if the channel isn't mapped (→ ignore).
 *  `backend` (optional) points a channel at a DIFFERENT instance's Jobs API — e.g. the ACME
 *  channels run against the ACME box (its own Drive-fed brain), reached over a private tunnel:
 *    "backend": { "url": "http://127.0.0.1:8788", "key": "<ACME ORCH_RUNNER_KEY>" }
 *  Absent → the local (orch-box) backend. Keeps each company's data on its own server. */
export function resolveChannel(channels, channelId) {
  const c = channels[channelId];
  if (!c || typeof c !== 'object') return null;
  const projects = Array.isArray(c.projects) ? c.projects.filter((p) => typeof p === 'string') : [];
  const kind = c.kind || (c.company ? 'company' : projects.length ? 'project' : 'holding');
  const backend = (c.backend && c.backend.url && c.backend.key) ? { url: String(c.backend.url), key: String(c.backend.key) } : null;
  return { id: channelId, kind, company: c.company || null, projects, label: c.label || channelId, backend };
}

/** Empty/absent project list = whole brain (holding). Otherwise membership only. */
export function inScope(project, projects) { return !projects || projects.length === 0 || projects.includes(project); }
