#!/usr/bin/env bash
# One-shot deploy of the action-board dashboard onto the box. Idempotent.
# Run from the Mac:  ssh your-server 'bash -s' < deploy/deploy-dashboard.sh
# (code must already be rsync'd to /opt/orchestrator/runner)
set -euo pipefail
ENV=/opt/orchestrator/.env

# 1 · dashboard token (only generate if absent — never rotate silently)
if ! grep -q '^DASH_TOKEN=..' "$ENV"; then
  sed -i '/^DASH_TOKEN=/d' "$ENV"
  echo "DASH_TOKEN=$(openssl rand -hex 32)" >> "$ENV"
  chown root:orchestrator "$ENV"; chmod 640 "$ENV"
  echo "DASH_TOKEN generated"
else
  echo "DASH_TOKEN already set — kept"
fi

# 2 · migrate (adds the actions tables; idempotent)
cd /opt/orchestrator/runner
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true
sudo -u orchestrator ORCH_ENV_FILE="$ENV" node src/migrate.js

# 3 · restart services
systemctl restart orchestrator-api orchestrator-runner
sleep 3
echo "api:    $(systemctl is-active orchestrator-api)"
echo "runner: $(systemctl is-active orchestrator-runner)"

# 4 · nginx site + TLS (only if not already enabled)
if [ ! -e /etc/nginx/sites-enabled/orchestrator.asoracore.com ]; then
  cp /opt/orchestrator/runner/deploy/nginx-orchestrator.conf /etc/nginx/sites-available/orchestrator.asoracore.com
  ln -sf /etc/nginx/sites-available/orchestrator.asoracore.com /etc/nginx/sites-enabled/
  nginx -t && systemctl reload nginx
  echo "nginx site enabled — now run: certbot --nginx -d orchestrator.asoracore.com"
else
  echo "nginx site already enabled"
fi

# 5 · print the dashboard URL (token included — paste into browser once)
TOKEN=$(grep '^DASH_TOKEN=' "$ENV" | cut -d= -f2)
echo "DASHBOARD: https://orchestrator.asoracore.com/dash?token=${TOKEN}"
