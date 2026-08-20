#!/usr/bin/env bash
# Smoke test on the box after deploy (real Postgres + real API). Safe: creates
# one job in a throwaway state and verifies auth + audit; nothing executes
# unless the runner service is running and the project resolves.
set -euo pipefail
ENV_FILE="${ORCH_ENV_FILE:-/opt/orchestrator/.env}"
KEY=$(grep -E '^ORCH_RUNNER_KEY=' "$ENV_FILE" | cut -d= -f2-)
PORT=$(grep -E '^API_PORT=' "$ENV_FILE" | cut -d= -f2- || true); PORT=${PORT:-8787}
BASE="http://127.0.0.1:${PORT}"

echo "1. no key → 401 (fail closed)"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/jobs")" = "401"

echo "2. wrong key → 401"
test "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-api-key: wrong' "$BASE/api/jobs")" = "401"

echo "3. health with key → 200"
test "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/health")" = "200"

echo "4. enqueue a far-future job (won't execute) → 201"
RES=$(curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"project":"orchestrator","type":"smoke","prompt":"smoke test — ignore","run_at":"2099-01-01T00:00:00Z"}' \
  "$BASE/api/jobs")
ID=$(echo "$RES" | python3 -c 'import sys,json;print(json.load(sys.stdin)["job"]["id"])')
echo "   job $ID"

echo "5. fetch it back"
curl -s -H "Authorization: Bearer $KEY" "$BASE/api/jobs/$ID" | python3 -c 'import sys,json;j=json.load(sys.stdin)["job"];assert j["status"]=="queued";print("   status queued ok")'

echo "6. DELETE must not exist → 404"
test "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $KEY" "$BASE/api/jobs/$ID")" = "404"

echo "ALL SMOKE CHECKS PASSED"
