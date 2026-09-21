#!/usr/bin/env bash
# Release script: build, gate, and tag.
# Usage: VERSION=v1.2.3 ./scripts/ops/release.sh
set -euo pipefail

VERSION="${VERSION:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: VERSION=v1.2.3 ./scripts/ops/release.sh"
  exit 1
fi

echo "=== NexusAPI release $VERSION ==="

# 1. Quality gates
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run db:migration:verify
npm run security:check
npm run secrets:scan

# 2. DB-dependent gates (require DATABASE_URL)
if [ -n "${DATABASE_URL:-}" ]; then
  npm run test:contract
  npm run test:integration
  npm run test:security
  npm run build
else
  echo "WARNING: DATABASE_URL not set; skipping DB-dependent gates"
fi

# 3. Build image
docker build -t "nexusapi:$VERSION" -f infra/Dockerfile .

echo "=== Release $VERSION ready ==="
echo "Image: nexusapi:$VERSION"
echo "Next: canary deploy, then roll out"
