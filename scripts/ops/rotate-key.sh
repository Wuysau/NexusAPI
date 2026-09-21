#!/usr/bin/env bash
# Key rotation script: rotate the KMS master key version.
# Usage: NEW_VERSION=2 ./scripts/ops/rotate-key.sh
set -euo pipefail

NEW_VERSION="${NEW_VERSION:-}"
if [ -z "$NEW_VERSION" ]; then
  echo "Usage: NEW_VERSION=2 ./scripts/ops/rotate-key.sh"
  exit 1
fi

echo "=== KMS key rotation to version $NEW_VERSION ==="
echo "Prerequisite: provision the new KMS key in the secrets manager."
echo "Prerequisite: re-encrypt all credential DEKs with the new master key."

# 1. Update the environment
export KMS_KEY_VERSION="$NEW_VERSION"

# 2. Restart the application (picks up the new KMS version)
echo "Restarting app with KMS_KEY_VERSION=$NEW_VERSION..."
docker compose -f infra/docker-compose.prod.yml up -d app

# 3. Verify: the app starts and can decrypt credentials
echo "Verifying..."
sleep 5
if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
  echo "PASS: app is healthy with KMS version $NEW_VERSION"
else
  echo "FAIL: app did not start cleanly. Check logs."
  exit 1
fi

echo "=== KMS rotation to version $NEW_VERSION complete ==="
echo "Next: verify a gateway request succeeds, then retire the old version."
