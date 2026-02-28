#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

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

