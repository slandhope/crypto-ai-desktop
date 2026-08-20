#!/usr/bin/env bash
# Deploy scanner-server to EC2. Set EC2_HOST, EC2_USER, EC2_KEY before running.
set -euo pipefail

EC2_HOST="${EC2_HOST:-13.51.141.42}"
EC2_USER="${EC2_USER:-ubuntu}"
EC2_KEY="${EC2_KEY:?Set EC2_KEY to your .pem path}"
REMOTE_DIR="${REMOTE_DIR:-~/crypto-ai-desktop}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Syncing $ROOT to $EC2_USER@$EC2_HOST:$REMOTE_DIR"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude asuka-data \
  --exclude '*.log' \
  -e "ssh -i $EC2_KEY -o StrictHostKeyChecking=accept-new" \
  "$ROOT/" "$EC2_USER@$EC2_HOST:$REMOTE_DIR/"

echo "→ Installing deps and restarting scanner-server"
ssh -i "$EC2_KEY" -o StrictHostKeyChecking=accept-new "$EC2_USER@$EC2_HOST" bash -s << EOF
  set -e
  cd $REMOTE_DIR
  npm ci --omit=dev 2>/dev/null || npm install --omit=dev
  if command -v pm2 >/dev/null; then
    pm2 restart scanner-server 2>/dev/null || pm2 start scanner-server.js --name scanner-server
    pm2 save
  else
    echo "pm2 not found — start manually: node scanner-server.js"
  fi
EOF

echo "✓ Deploy finished. Test: curl -s http://$EC2_HOST:3000/health || curl -s http://$EC2_HOST:3000/"
