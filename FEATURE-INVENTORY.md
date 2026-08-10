# Feature inventory — real vs simulated (from Asymmetrica review §3.5)

Update when marketing or launch claims change. Crypto rows are marked **discuss** — do not change trading claims without a product decision.

| Feature | Status | Gate / notes |
|---------|--------|----------------|
| Companion chat (Claude via backend) | **Functional** | Auth + credits |
| Memory + sync (`/state`) | **Functional** | Wipe guard + batched extract |
| Voice TTS | **Partial** | Needs working ElevenLabs key (ops) |
| Care / bond / shop cosmetics | **Functional** | Coin packs: test grants only when unpackaged |
| Study / whiteboard / flashcards | **Functional** | Needs local manim/ffmpeg for video lessons |
| Manim video lessons | **Partial** | Local toolchain required |
| Butler reads (Messages, calendar, notes) | **Functional** | Human confirm for sends |
| Butler sends (iMessage / WhatsApp) | **Functional** | Human confirm required |
| Watch Together (live frames) | **Functional** | Gemini Live token |
| Paper trading / scanners / swarm | **Discuss** | Paper/testnet; server paper book in Postgres `trading_blobs` |
| Spot/futures live mainnet | **Absent** | Testnet helpers only |
| Track / grade / Moralis | **Functional** | Needs `MORALIS_API_KEY`; paper copy polls tracked+influencer |
| Wallet address link | **Functional** | Paste address fallback |
| WalletConnect live | **Functional** | Needs `WALLETCONNECT_PROJECT_ID` (cloud.reown.com); QR + MetaMask/Trust deep link |
| Auto-Launch Desk | **Simulated** | Paper until keys (P4) |
| Custom domains / Porkbun | **Simulated** | Test mode |
| Token site builder | **Partial** | Placeholders |
| Buyback burner | **Partial** | Encrypted in signer utility process; unlock never returns key to main; auto→approve |
| TG user connect + groups | **Functional** | Needs `TELEGRAM_API_ID` / `HASH` |
| TG chart vision | **Functional** | Live + past when `chartAnalysis` on (daily image cap) |
| TG group admin | **Functional** | Bot must be group admin; kick/ban/mute/delete/pin/title/joins + desktop UI |
| TG human host / mod | **Functional** | Modes silent/light/full; anti-spam; welcomes; @replies; rate-limited hype |
| Screen chart (Cmd+Shift+A) | **Functional** | Claude vision |
| Grok voice agent | **Stub** | Disabled |
| Payments / Stripe | **Stub** | Placeholder URLs; no processor |
| Mobile Coach chat | **Server alias ready** | Client still in `waifu-ai-mobile` |
| Mobile keys in bundle | **Open** | Fix in mobile repo |

## Ops checklist (not features)
- TLS on EC2 + `ASUKA_API_BASE=https://…`
- `API_ONLY=1` for API boxes; separate scanner worker
- `RDS_CA_PATH` + `rejectUnauthorized: true`
- RDS automated backups
