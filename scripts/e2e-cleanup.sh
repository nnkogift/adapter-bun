#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

# 1. Stop the server
PID_FILE=".adapter-server.pid"
if [ -f "$PID_FILE" ]; then
  while IFS= read -r SERVER_PID; do
    if [ -z "$SERVER_PID" ]; then
      continue
    fi
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
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# 2. Output server logs
if [ -f ".adapter-server.log" ]; then
  PERSIST_SERVER_LOG_PATH="${ADAPTER_BUN_PERSIST_SERVER_LOG:-/tmp/adapter-bun-last-server.log}"
  cp ".adapter-server.log" "$PERSIST_SERVER_LOG_PATH" 2>/dev/null || true
  echo "=== .adapter-server.log ==="
  cat ".adapter-server.log"
  echo ""
fi
