# waifu.ai — desktop + API server

Electron companion (Asuka), trading dashboard, classroom/study, and the **AWS API** that both PC and phone talk to.

**Repo:** [github.com/slandhope/crypto-ai-desktop](https://github.com/slandhope/crypto-ai-desktop)  
**Mobile repo:** [github.com/slandhope/waifu-ai-mobile](https://github.com/slandhope/waifu-ai-mobile)

## Architecture

```
Phone (waifu-ai-mobile)  ──┐
                             ├──►  scanner-server.js  ──►  Postgres
PC (this repo, Electron)   ──┘         :3000 on EC2
```

| Component | Role |
|-----------|------|
| `main.js` | Electron main — Live2D, IPC, local files |
| `scanner-server.js` | HTTP API — auth, `/state`, `/api/sync`, trading, chat |
| `clarity-routes.js` | Wellness / habits / coach goals |
| `sync-client.js` | PC ↔ cloud (`/state`, chat log, study library) |
| `clarity-sync.js` | PC ↔ cloud (`/api/sync` wellness pull) |
| `db.js` | Postgres — `user_data`, `asuka_state`, credits |

Same Google/Apple login on PC and phone → one user row, shared brain.

## Local dev (desktop)

```bash
npm install
npm start          # or electron .
```

API base defaults to `http://13.51.141.42:3000` via `api-base.js` / env `ASUKA_API_BASE`.

## Deploy API to EC2

Production host: **`13.51.141.42:3000`** (until TLS domain is configured — see `P0-OPS.md`).

### Quick deploy (SSH into EC2)

```bash
# On your Mac — replace KEY and USER with your EC2 key + ubuntu/ec2-user
export EC2_HOST=13.51.141.42
export EC2_KEY=~/.ssh/your-key.pem
export EC2_USER=ubuntu

rsync -avz --exclude node_modules --exclude .git \
  -e "ssh -i $EC2_KEY" \
  ./ $EC2_USER@$EC2_HOST:~/crypto-ai-desktop/

ssh -i $EC2_KEY $EC2_USER@$EC2_HOST << 'EOF'
  cd ~/crypto-ai-desktop
  npm ci --omit=dev
  # pm2 example (adjust to however you run it today):
  pm2 restart scanner-server || pm2 start scanner-server.js --name scanner-server
  pm2 save
EOF
```

Or use the helper script:

```bash
EC2_KEY=~/.ssh/your-key.pem EC2_USER=ubuntu ./scripts/deploy-ec2.sh
```

### After deploy

1. Confirm health: `curl -s http://13.51.141.42:3000/health` (or your health route)
2. Log in on PC and phone with the same account — chat/habits/study should merge
3. Check logs on EC2 if sync fails: `pm2 logs scanner-server`

### Env on server

Copy `.env.example` → `.env` on EC2. Required: Postgres URL, Cognito/JWT verify, Anthropic/Groq keys as used today. See `P0-OPS.md` for TLS and ElevenLabs rotation.

## Repo split

| Change type | Commit here | Commit in mobile |
|-------------|-------------|------------------|
| API routes, DB, sync logic | ✅ | — |
| Electron UI, classroom, trading UI | ✅ | — |
| Expo screens, mobile UX | — | ✅ waifu-ai-mobile |

Always redeploy **this repo’s server** after changing `scanner-server.js`, `clarity-routes.js`, or `db.js`.

## Ops docs

- `P0-OPS.md` — TLS, voice keys, dev panel
- `P2-OPS.md` — process map, trading store
- `FEATURE-INVENTORY.md` — feature status matrix
