#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

# 1. Pick a random available port
PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")

# 2. Add adapter-bun as file: dependency
node -e "
const pkg=JSON.parse(require('fs').readFileSync('package.json','utf8'));
pkg.dependencies=pkg.dependencies||{};
pkg.dependencies['adapter-bun']='file:${ADAPTER_BUN_DIR}';
require('fs').writeFileSync('package.json',JSON.stringify(pkg,null,2));
" >&2

# 3. Install dependencies
bun install --no-frozen-lockfile >&2

# 4. Set adapter path
export NEXT_ADAPTER_PATH="${ADAPTER_BUN_DIR}/dist/src/adapter.js"

# 5. Build (NEXT_ADAPTER_PATH tells Next.js to use our adapter)
bun --bun next build 2>&1 | tee "$NEXT_TEST_DIR/.adapter-build.log" >&2

# 6. Generate build ID markers for logs script
BUILD_ID=$(cat ".next/BUILD_ID" 2>/dev/null || echo "unknown")
echo "BUILD_ID: $BUILD_ID" >> "$NEXT_TEST_DIR/.adapter-build.log"
echo "DEPLOYMENT_ID: bun-adapter-$BUILD_ID" >> "$NEXT_TEST_DIR/.adapter-build.log"
echo "IMMUTABLE_ASSET_TOKEN: bun-adapter-token" >> "$NEXT_TEST_DIR/.adapter-build.log"

# 7. Start server on random port
PORT=$PORT bun bun-dist/server.js >> "$NEXT_TEST_DIR/.adapter-server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$NEXT_TEST_DIR/.adapter-server.pid"

# 8. Wait for server to be ready
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "http://localhost:${PORT}/" 2>/dev/null; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then echo "Server died" >&2; exit 1; fi
  sleep 1
done

# 9. Output URL (only thing on stdout)
echo "http://localhost:${PORT}"
