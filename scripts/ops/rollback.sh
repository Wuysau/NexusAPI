#!/usr/bin/env bash
# Rollback script: redeploy the previous image.
# Usage: PREV_VERSION=v1.2.2 ./scripts/ops/rollback.sh
set -euo pipefail

PREV_VERSION="${PREV_VERSION:-}"
if [ -z "$PREV_VERSION" ]; then
  echo "Usage: PREV_VERSION=v1.2.2 ./scripts/ops/rollback.sh"
  exit 1
fi

echo "=== Rolling back to nexusapi:$PREV_VERSION ==="
echo "NOTE: The database is NOT rolled back. Ledger entries are immutable."
echo "NOTE: Compensating entries are used for money recovery, not history deletion."

# Redeploy the previous image
export IMAGE_TAG="$PREV_VERSION"
docker compose -f infra/docker-compose.prod.yml up -d app worker gateway

echo "=== Rollback to $PREV_VERSION deployed ==="
echo "Verify: curl http://localhost:3000/api/health"
echo "Verify: docker compose -f infra/docker-compose.prod.yml logs --tail=50 app"
