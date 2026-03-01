#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

# 1. Stop the server
PID_FILE=".adapter-server.pid"
if [ -f "$PID_FILE" ]; then
  SERVER_PID=$(cat "$PID_FILE")
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    # Wait up to 5 seconds for graceful shutdown
    for i in $(seq 1 50); do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
      sleep 0.1
    done
    # Force kill if still running
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      kill -9 "$SERVER_PID" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
fi

# 2. Output server logs
if [ -f ".adapter-server.log" ]; then
  echo "=== .adapter-server.log ==="
  cat ".adapter-server.log"
  echo ""
fi
