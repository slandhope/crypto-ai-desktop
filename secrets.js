// ═══════════════════════════════════════════════════════════════════
// 🔐 SECRETS — one vault for all keys.
// Production: pulls from AWS Secrets Manager (one JSON secret, all keys).
// Local/testing: falls back to process.env / .env automatically.
//
// Usage:   const { getSecret } = require('./secrets');
//          const key = await getSecret('ANTHROPIC_API_KEY');
//
// Env that controls it:
//   AWS_SECRET_NAME   name of the secret in Secrets Manager (e.g. "asuka/keys")
//   AWS_REGION        e.g. "eu-north-1"
//   If AWS_SECRET_NAME is unset → pure .env mode (great for local dev).
// ═══════════════════════════════════════════════════════════════════
require('dotenv').config();

let _cache = null;          // cached secret bundle
let _cacheAt = 0;
const CACHE_MS = 5 * 60 * 1000;   // refetch from AWS at most every 5 min

async function loadFromAWS() {
  const name = process.env.AWS_SECRET_NAME;
  const region = process.env.AWS_REGION || 'eu-north-1';
  if (!name) return null;                     // no AWS configured → skip
  try {
    // lazy-require so local dev doesn't need the SDK installed
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({ region });
    const out = await client.send(new GetSecretValueCommand({ SecretId: name }));
    if (out.SecretString) return JSON.parse(out.SecretString);
  } catch (e) {
    console.warn('🔐 Secrets Manager unavailable, using .env fallback:', e.message);
  }
  return null;
}

async function ensureLoaded() {
  const fresh = _cache && (Date.now() - _cacheAt < CACHE_MS);
  if (fresh) return _cache;
  const aws = await loadFromAWS();
  // merge: AWS values win, .env fills any gaps
  _cache = { ...process.env, ...(aws || {}) };
  _cacheAt = Date.now();
  return _cache;
}

/** Get one secret by name. Returns undefined if not found anywhere. */
async function getSecret(key) {
  const bundle = await ensureLoaded();
  return bundle[key];
}

/** Get several at once: getSecrets(['A','B']) → { A, B } */
async function getSecrets(keys) {
  const bundle = await ensureLoaded();
  const out = {};
  for (const k of keys) out[k] = bundle[k];
  return out;
}

/** Synchronous best-effort (env only) — for code paths that can't await. */
function getSecretSync(key) {
  if (_cache && _cache[key] !== undefined) return _cache[key];
  return process.env[key];
}

/** Force a refetch (e.g. after rotating a key). */
function invalidate() { _cache = null; _cacheAt = 0; }

module.exports = { getSecret, getSecrets, getSecretSync, invalidate };
