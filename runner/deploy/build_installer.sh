#!/usr/bin/env bash
# Build the client-installer tarball from the runner source tree (run on the Mac).
# Output: ~/Documents/Orchestrator/dist/asora-ingest-installer-YYYYMMDD.tar.gz
set -euo pipefail

RUNNER="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$RUNNER/../dist"
STAGE="$(mktemp -d)/asora-ingest-installer"
mkdir -p "$STAGE/runner" "$DIST"

# Runner payload: source + configs + lockfile + tests (run on the box post-install).
rsync -a \
  --include='src/***' --include='bin/***' --include='db/***' --include='config/***' \
  --include='jobtypes/***' --include='dash/***' --include='test/***' \
  --include='package.json' --include='package-lock.json' \
  --exclude='*' \
  "$RUNNER/" "$STAGE/runner/"

# Installer + templates
cp "$RUNNER/deploy/installer/install.sh" "$STAGE/install.sh"
cp "$RUNNER/deploy/installer/README.md" "$STAGE/README.md"
rsync -a "$RUNNER/deploy/installer/templates/" "$STAGE/templates/"
chmod +x "$STAGE/install.sh"

OUT="$DIST/asora-ingest-installer-$(date +%Y%m%d).tar.gz"
tar -czf "$OUT" -C "$(dirname "$STAGE")" "$(basename "$STAGE")"
echo "built: $OUT"
tar -tzf "$OUT" | head -15
echo "…"
echo "files: $(tar -tzf "$OUT" | wc -l | tr -d ' ')  size: $(du -h "$OUT" | cut -f1)"
