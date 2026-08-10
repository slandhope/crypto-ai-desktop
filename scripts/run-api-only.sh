#!/usr/bin/env bash
# Example: API process without scanner loops (O1 process split).
# Terminal A (API):
#   API_ONLY=1 REQUIRE_TLS=1 REQUIRE_AUTH=1 node scanner-server.js
# Terminal B (scanner worker — same file for now, schedulers only):
#   # future: node scanner-worker.js
#   # until then, run a second host without API_ONLY, or keep combined on one box.
set -euo pipefail
export API_ONLY=1
exec node "$(dirname "$0")/../scanner-server.js"
