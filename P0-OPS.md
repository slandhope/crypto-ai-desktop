# P0 ops notes (TLS + voice) — crypto untouched

## TLS (H1)
Code is ready; **you still need a certificate on EC2** (or a reverse proxy).

1. Put nginx/Caddy/ALB in front of `:3000` with a real cert (Let's Encrypt + domain).
2. On the server env:
   - `REQUIRE_TLS=1` — API rejects non-HTTPS (trusts `X-Forwarded-Proto` from the proxy)
   - Optional native HTTPS: `SSL_KEY_PATH` + `SSL_CERT_PATH` if Node terminates TLS itself
3. On desktop (and mobile later) set:
   - `ASUKA_API_BASE=https://your.domain`
   - `ASUKA_REQUIRE_HTTPS=1` — clients refuse to talk plain HTTP to production

Until that is live, unpackaged `electron .` can still use `http://13.51.141.42:3000` (warns). **Packaged builds refuse remote HTTP** unless `ASUKA_ALLOW_INSECURE_API=1`. See also `scripts/nginx-asuka-tls.conf.example`.

## Voice (H4) — you own this
ElevenLabs subscription / key rotation is on you (not blocked by code). When ready:

1. Create a new key at elevenlabs.io
2. Update **AWS Secrets Manager** secret `ELEVENLABS_API_KEY` (and any `.env` fallback on EC2)
3. Restart `scanner-server`
4. Confirm `/ai/voice` no longer returns `voice_failed` / `ElevenLabs 401`

## Dev panel (C4)
- Binds **127.0.0.1** by default (not `0.0.0.0`)
- Default password `Asuka2026!` **removed**
- First start generates a password into `asuka-data/dev-state.json` (printed once), or set `DEV_PANEL_PASSWORD`
- On EC2: firewall / do not publish port 3001; prefer not running the panel in production

## Auth (H2)
- Tokens with `email_verified !== true` are rejected (403 `email_unverified`)
- If Google Cognito users get locked out, fix Cognito attribute mapping so Google emails are verified, or temporarily set nothing — do **not** re-open unverified emails in production
