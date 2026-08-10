# Architecture leftovers

## Process map (desktop)
```
Renderer (no Node)
    │ IPC
    ▼
Main (orchestrator, AI, WC, dialogs)
    ├── tool-broker.js     allowlist + confirm + audit  ✅ all dangerous IPC routed
    ├── signer-host.js ──► signer-worker.js (utilityProcess)
    │                      owns wallet-vault.enc decrypt in memory
    ├── trading-store.js   paper/snipes (file on desktop)
    └── butler / OS APIs   after broker allows
```

## Server
```
scanner-server
    ├── trading-store.js ──► Postgres trading_blobs (+ JSON mirror)
    └── db.js / asuka_state / credits
```

## Done
- Signer utility process
- Tool-broker gates all former `gateDangerousAction` IPC sites
- Paper + snipes + daily signals → `trading_blobs` on server (O2)

## Telegram group host
1. `TELEGRAM_BOT_TOKEN` + bot is group **admin** (delete, ban/restrict, pin, invite)
2. Pair bot via `/start` + code; register/discover groups
3. Telegram tab → **Group host presence**: Light (default) / Silent / Full
4. Safety: spam auto-delete+mute; kick/ban never auto; quiet hours UTC 01–08; hourly reply caps
