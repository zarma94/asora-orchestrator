# ASORA — an orchestrator brain you can self-host

ASORA is a self-hosted **orchestrator**: a governed brain that knows your world, reaches your
systems, and **deploys agents to do the work** — with review, verification and an audit gate before
anything leaves the building. It runs on your own server against your Claude subscription (or API).

This repository is an **empty shell**. It ships the framework — the runner, the job pipeline, the
agent ladder, the brain structure and templates — with **none of anyone's data, prompts, credentials
or company names**. You install it, point it at your own storage and channels, and populate your own
brain.

## What's in the box

- **Runner** (`runner/src`) — a Jobs API + scheduler that executes `claude` jobs, resumable across
  restarts, with a typed set of job kinds (`runner/jobtypes.js`, `runner/jobtypes/`).
- **Agent ladder** (`runner/src/ladder.js`) — deploy a task through *subagent → security → reviewer →
  hub-verify → auditor*, then a company hub can delegate across a team of project agents.
- **Brain** — a routed, index-first store of human-readable markdown (project wikis + memory), with
  provenance and trust tags. This shell contains the *structure and templates only*.
- **Installer & deploy templates** (`runner/deploy/`) — systemd units, nginx, Postgres/Docker, and an
  `.env` template. All values are placeholders.

## Quick start

```bash
cd runner
cp .env.example .env         # fill in your own values (DB, keys, storage)
npm install
# see runner/RUNBOOK.md for the full setup (DB, systemd, channels, brain)
```

Bring your own: a server, a Postgres database, a `claude` login (subscription or API key), and your
own content. Nothing in this repo is pre-populated.

## Security

- No secrets, no personal or company data, and no git history are included.
- `.env`, keys, `node_modules/`, and all data/brain/memory directories are git-ignored.
- Never commit a real `.env` — copy `.env.example` and keep your copy out of version control.

## License

MIT — see `LICENSE`.
