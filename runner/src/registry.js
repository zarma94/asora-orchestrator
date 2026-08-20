// Project map: parses Orchestrator/projects/REGISTRY.md verbatim (single source
// of truth), overlaid with config/projects.json (write modes, extra meta-slugs
// like 'orchestrator'). Reparsed on an interval so Mac-side registry edits
// arrive without a restart.
import fs from 'node:fs';
import path from 'node:path';

/** "ACME/ACME Stake (Sample Deal...)" → "ACME/ACME Stake"; "SampleGroup (app code ...)" → "SampleGroup" */
function stripParen(s) {
  return s.replace(/\s*\(.*$/s, '').trim();
}

export function parseRegistryMd(md) {
  const out = {};
  for (const line of md.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // | slug | folder | brain | agent | ems |  → cells[1..5]
    if (cells.length < 6) continue;
    const slug = cells[1];
    if (!slug || slug === 'Slug' || /^-+$/.test(slug.replace(/\s/g, '-'))) continue;
    if (/^[-: ]+$/.test(cells[1])) continue;
    out[slug] = {
      slug,
      folder: stripParen(cells[2]),
      brain: stripParen(cells[3]),
      agent: cells[4].startsWith('agents/') ? cells[4].split(' ')[0] : null,
      ems_board: (() => {
        const board = stripParen(cells[5] ?? '').split('·')[0].trim();
        return board && !['—', '-'].includes(board) ? board : null;
      })(),
    };
  }
  return out;
}

export function makeRegistry({ orchestratorDir, docsRoot, reposDir, brainDir, configPath, localConfigPath, ttlMs = 60_000 }) {
  let cache = null;
  let loadedAt = 0;

  function load() {
    const registryPath = path.join(orchestratorDir, 'projects', 'REGISTRY.md');
    const base = parseRegistryMd(fs.readFileSync(registryPath, 'utf8'));
    let overrides = {};
    if (configPath && fs.existsSync(configPath)) {
      overrides = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    // BOX-authoritative overlay (auto-created projects / brain enablements). Lives
    // OUTSIDE the deployed runner dir so a Mac→box deploy never overwrites it.
    // Per-slug: local keys win over config keys.
    if (localConfigPath && fs.existsSync(localConfigPath)) {
      const local = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
      for (const slug of Object.keys(local)) {
        overrides[slug] = { ...(overrides[slug] ?? {}), ...local[slug] };
      }
    }
    const merged = {};
    for (const slug of new Set([...Object.keys(base), ...Object.keys(overrides)])) {
      const o = overrides[slug] ?? {};
      const b = base[slug] ?? {};
      const entry = {
        slug,
        folder: o.folder ?? b.folder ?? null,
        brain: o.brain ?? b.brain ?? null,
        agent: o.agent ?? b.agent ?? null,
        ems_board: o.ems_board ?? b.ems_board ?? null,
        // write_mode: 'read-only' (default; runs on the RO NC mount) |
        //             'git' (runs in a writable clone under REPOS_DIR) |
        //             'two-way' (folder converted to rclone copy --update) |
        //             'brain' (box-OWNED writable wiki at BRAIN_DIR/<slug>; raw symlinked in RO; backed up to NC)
        write_mode: o.write_mode ?? 'read-only',
      };
      if (!entry.folder) continue;
      entry.rawPath = path.join(docsRoot, entry.folder); // read-only source docs (NC mount)
      entry.cwd = entry.write_mode === 'git' ? path.join(reposDir, slug)
        : entry.write_mode === 'brain' ? path.join(brainDir || '/opt/orchestrator/brain', slug)
        : path.join(docsRoot, entry.folder);
      entry.agentFile = entry.agent ? path.join(orchestratorDir, entry.agent) : null;
      merged[slug] = entry;
    }
    return merged;
  }

  return {
    async all() {
      if (!cache || Date.now() - loadedAt > ttlMs) {
        cache = load();
        loadedAt = Date.now();
      }
      return cache;
    },
    /** Drop the cache — call after writing projects.json (e.g. a new project brain)
     *  so a just-created slug resolves without waiting out the TTL. */
    invalidate() { cache = null; },
    async get(slug) {
      return (await this.all())[slug] ?? null;
    },
    async has(slug) {
      return Boolean(await this.get(slug));
    },
    /** slug → EMS board (for filing tasks); unknown/boardless → general-tasks */
    async emsBoard(slug) {
      const e = await this.get(slug);
      return e?.ems_board ?? 'general-tasks';
    },
  };
}
