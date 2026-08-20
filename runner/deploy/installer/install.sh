#!/usr/bin/env bash
# ASORA ingest instance — clean-server installer (Ubuntu/Debian, docker present).
# Idempotent: safe to re-run; an existing /opt/orchestrator/.env is NEVER overwritten.
# Non-invasive: loopback-only ports (8787 API, 5434 pg), unique docker name/volume,
# no firewall or nginx changes — safe next to an existing stack (e.g. ACME EMS).
#
# Usage:  sudo bash install.sh            # install / upgrade code in place
#         sudo bash install.sh --check    # preflight only, change nothing
set -euo pipefail

PREFIX=/opt/orchestrator
HERE="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$HERE/runner"          # the runner source shipped inside the tarball
TPL="$HERE/templates"
CHECK_ONLY="${1:-}"

say()  { echo -e "\033[1;32m[asora]\033[0m $*"; }
warn() { echo -e "\033[1;33m[asora]\033[0m $*"; }
die()  { echo -e "\033[1;31m[asora]\033[0m $*" >&2; exit 1; }

# ---------- preflight ----------
[ "$(id -u)" = 0 ] || die "run as root (sudo bash install.sh)"
[ -d "$PAYLOAD" ] || die "payload missing — run from the extracted installer directory"
command -v docker >/dev/null || die "docker is required (this installer does not modify the host's container setup beyond one loopback postgres)"
command -v python3 >/dev/null || die "python3 is required"

# Port conflicts (only if something ELSE already listens there)
for port in 8787 5434; do
  if ss -ltn 2>/dev/null | grep -q ":$port "; then
    if [ "$port" = 5434 ] && docker ps --format '{{.Names}}' | grep -q '^asora-db$'; then
      say "port 5434 is our own asora-db — ok"
    elif [ "$port" = 8787 ] && systemctl is-active -q orchestrator-api 2>/dev/null; then
      say "port 8787 is our own orchestrator-api — ok"
    else
      die "port $port already in use by another service — set a different port before installing"
    fi
  fi
done

# Node >= 20
NODE_OK=false
if command -v node >/dev/null; then
  NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
  [ "$NODE_MAJOR" -ge 20 ] && NODE_OK=true
fi

say "preflight OK (node>=20: $NODE_OK, docker: yes)"
[ "$CHECK_ONLY" = "--check" ] && { say "--check: stopping before any changes"; exit 0; }

# ---------- node 20 (NodeSource) if missing ----------
if [ "$NODE_OK" = false ]; then
  say "installing Node 20 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# ---------- user + dirs ----------
id orchestrator >/dev/null 2>&1 || { say "creating user orchestrator"; useradd -r -m -s /bin/bash orchestrator; }
mkdir -p "$PREFIX"/{runner,brain,inbox,ingest,artifacts,repos,hub/projects}
chown -R orchestrator:orchestrator "$PREFIX"/{brain,inbox,ingest,artifacts,repos,hub}

# ---------- code payload ----------
say "installing runner code"
rsync -a --delete --exclude node_modules "$PAYLOAD"/ "$PREFIX/runner/"
# client configs overwrite the shipped (dev) ones
install -m 644 "$TPL/client-projects.json" "$PREFIX/runner/config/projects.json"
install -m 644 "$TPL/client-schedule.json" "$PREFIX/runner/config/schedule.json"
[ -f "$PREFIX/hub/projects/REGISTRY.md" ] || install -m 644 "$TPL/REGISTRY.md" "$PREFIX/hub/projects/REGISTRY.md"
chmod -R a+rX "$PREFIX/runner"

# ---------- secrets / env (never overwrite an existing .env) ----------
if [ ! -f "$PREFIX/.env" ]; then
  say "generating .env with fresh secrets"
  PGPASS=$(openssl rand -hex 24)
  RUNNERKEY=$(openssl rand -hex 32)
  sed -e "s/__PGPASS__/$PGPASS/" -e "s/__RUNNERKEY__/$RUNNERKEY/" "$TPL/env.template" > "$PREFIX/.env"
  chown root:orchestrator "$PREFIX/.env"; chmod 640 "$PREFIX/.env"
  echo "POSTGRES_PASSWORD=$PGPASS" > "$PREFIX/.env.compose"; chmod 600 "$PREFIX/.env.compose"
else
  say ".env exists — keeping it (code upgrade only)"
fi

# ---------- access rules (hardcoded ACL — root-owned, runner can read but never write) ----------
if [ ! -f "$PREFIX/access.json" ]; then
  install -m 640 -o root -g orchestrator "$TPL/access.json.template" "$PREFIX/access.json"
  say "access.json installed (owner-only until you add roles — edit as root)"
else
  say "access.json exists — keeping it"
fi

# ---------- per-company bots (root-owned; optional — the default single bot works without it) ----------
if [ ! -f "$PREFIX/bots.json" ]; then
  install -m 640 -o root -g orchestrator "$TPL/bots.json.template" "$PREFIX/bots.json"
  say "bots.json template installed — add per-company bots (BotFather token + owner chat id), then: systemctl enable --now orchestrator-telegram@<name>"
else
  say "bots.json exists — keeping it"
fi
install -m 644 "$TPL/orchestrator-telegram@.service" /etc/systemd/system/orchestrator-telegram@.service 2>/dev/null || true

# ---------- Slack front-end (optional; off until tokens + channels are set) ----------
if [ ! -f "$PREFIX/channels.json" ]; then
  install -m 640 -o root -g orchestrator "$TPL/channels.json.template" "$PREFIX/channels.json"
  say "channels.json template installed — map Slack channels, set SLACK_* in .env, then: systemctl enable --now orchestrator-slack"
fi
install -m 644 "$TPL/orchestrator-slack.service" /etc/systemd/system/orchestrator-slack.service 2>/dev/null || true

# ---------- npm deps ----------
say "npm ci (production deps)"
cd "$PREFIX/runner" && sudo -u orchestrator npm ci --omit=dev --no-audit --no-fund

# ---------- python extractors (CVE floor: pdfminer.six >= 20251107) ----------
say "installing python extractors for user orchestrator"
sudo -u orchestrator pip3 install --user --break-system-packages -q markitdown pdfplumber 'pdfminer.six>=20251107' || \
  sudo -u orchestrator pip3 install --user -q markitdown pdfplumber 'pdfminer.six>=20251107'

# ---------- postgres (docker, loopback :5434) ----------
say "starting asora-db (postgres 16, 127.0.0.1:5434)"
install -m 644 "$TPL/docker-compose.asora-db.yml" "$PREFIX/docker-compose.asora-db.yml"
( set -a; . "$PREFIX/.env.compose"; set +a; docker compose -f "$PREFIX/docker-compose.asora-db.yml" up -d )
say "waiting for postgres…"
for i in $(seq 1 30); do docker exec asora-db pg_isready -U asora >/dev/null 2>&1 && break; sleep 2; done
docker exec asora-db pg_isready -U asora >/dev/null || die "postgres did not become ready"

# ---------- migrate ----------
say "applying db schema"
sudo -u orchestrator bash -c "set -a; . $PREFIX/.env; set +a; cd $PREFIX/runner && node src/migrate.js"

# ---------- claude CLI ----------
if ! command -v claude >/dev/null; then
  say "installing claude CLI"
  npm install -g @anthropic-ai/claude-code >/dev/null
fi

# ---------- systemd ----------
say "installing systemd units"
install -m 644 "$TPL/orchestrator-api.service" /etc/systemd/system/orchestrator-api.service
install -m 644 "$TPL/orchestrator-runner.service" /etc/systemd/system/orchestrator-runner.service
install -m 644 "$TPL/orchestrator-telegram.service" /etc/systemd/system/orchestrator-telegram.service
systemctl daemon-reload
systemctl enable --now orchestrator-api orchestrator-runner
if grep -qE '^TELEGRAM_BOT_TOKEN=.+' "$PREFIX/.env"; then
  systemctl enable --now orchestrator-telegram
else
  warn "TELEGRAM_BOT_TOKEN empty — telegram listener NOT enabled (set it in .env, then: systemctl enable --now orchestrator-telegram)"
fi

# ---------- run tests + smoke ----------
say "running unit tests on this box"
( cd "$PREFIX/runner" && sudo -u orchestrator npm test >/dev/null 2>&1 ) && say "unit tests: PASS" || warn "unit tests: FAILED — inspect with: cd $PREFIX/runner && sudo -u orchestrator npm test"
sleep 2
KEY=$(grep -E '^ORCH_RUNNER_KEY=' "$PREFIX/.env" | cut -d= -f2-)
if curl -s -H "Authorization: Bearer $KEY" 127.0.0.1:8787/api/health | grep -q '"ok":true'; then
  say "API health: OK"
else
  warn "API health check failed — journalctl -u orchestrator-api -n 30"
fi

cat <<EOF

$(say "INSTALL COMPLETE — 3 required steps before ingest runs:")

 1. Claude auth (pick one):
      sudo -u orchestrator claude login          # subscription (preferred)
      # or set ANTHROPIC_API_KEY in $PREFIX/.env, then: systemctl restart orchestrator-runner

 2. Point the sweep at the documents (READ-ONLY — originals are never touched):
      edit $PREFIX/.env → INGEST_SOURCE_DIRS=/path/to/documents
      systemctl restart orchestrator-runner orchestrator-api

 3. Dry-run first (see what WOULD be ingested, writes nothing):
      sudo -u orchestrator bash -c 'set -a; . $PREFIX/.env; set +a; python3 $PREFIX/runner/bin/ingest_sweep.py --dry-run' | python3 -m json.tool | head -50

 Then either wait for the hourly sweep (:05) or start the backfill now:
      KEY=\$(grep -E '^ORCH_RUNNER_KEY=' $PREFIX/.env | cut -d= -f2-)
      curl -s -X POST -H "Authorization: Bearer \$KEY" -H "Content-Type: application/json" \\
        -d '{"project":"orchestrator","type":"ingest-sweep","prompt":"start backfill"}' 127.0.0.1:8787/api/jobs

 The sweep batches INGEST_SWEEP_BATCH (default 20) docs/run and SELF-CONTINUES every ~3 min until the corpus is
 drained; changed files re-ingest automatically (latest-wins, verified facts protected).
 Watch progress:  journalctl -u orchestrator-runner -f     Brain: $PREFIX/brain/<project>/wiki/
EOF
