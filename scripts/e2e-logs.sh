#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

# Emit canonical build/deploy markers first so next-deploy.ts parses
# deterministic values even when fixture scripts also print similarly-named keys.
if [ -f ".adapter-build.log" ]; then
  BUILD_ID_VALUE="$(grep -E '^BUILD_ID: ' .adapter-build.log | tail -n1 | sed 's/^BUILD_ID: //')"
  DEPLOYMENT_ID_VALUE="$(grep -E '^DEPLOYMENT_ID: ' .adapter-build.log | tail -n1 | sed 's/^DEPLOYMENT_ID: //')"
  IMMUTABLE_ASSET_TOKEN_VALUE="$(grep -E '^IMMUTABLE_ASSET_TOKEN: ' .adapter-build.log | tail -n1 | sed 's/^IMMUTABLE_ASSET_TOKEN: //')"

  if [ -n "$BUILD_ID_VALUE" ]; then
    echo "BUILD_ID: $BUILD_ID_VALUE"
  fi
  if [ -n "$DEPLOYMENT_ID_VALUE" ]; then
    echo "DEPLOYMENT_ID: $DEPLOYMENT_ID_VALUE"
  fi
  if [ -n "$IMMUTABLE_ASSET_TOKEN_VALUE" ]; then
    echo "IMMUTABLE_ASSET_TOKEN: $IMMUTABLE_ASSET_TOKEN_VALUE"
  fi
fi

# Output all log files
for f in .adapter-build.log .next/trace; do
  if [ -f "$f" ]; then
    echo "=== $f ==="
    cat "$f"
    echo ""
  fi
done

# Output any server stdout/stderr logs
for f in .adapter-server.log; do
  if [ -f "$f" ]; then
    echo "=== $f ==="
    cat "$f"
    echo ""
  fi
done
