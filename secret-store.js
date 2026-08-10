// Encrypted at-rest secrets via Electron safeStorage (OS keychain-backed).
// Never write API keys / tokens to plaintext .env or settings JSON from the UI.
'use strict';

const fs = require('fs');
const path = require('path');

function userDataDir() {
  try {
    const { app } = require('electron');
    return app.getPath('userData');
  } catch (_) {
    return path.join(require('os').homedir(), '.asuka-secrets');
  }
}

function storePath(name) {
  return path.join(userDataDir(), `${name}.secret`);
}

function encryptionAvailable() {
  try {
    const { safeStorage } = require('electron');
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

function saveSecret(name, obj) {
  if (!encryptionAvailable()) {
    return { ok: false, error: 'secure_storage_unavailable' };
  }
  const { safeStorage } = require('electron');
  const blob = safeStorage.encryptString(JSON.stringify(obj));
  const p = storePath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, blob, { mode: 0o600 });
  return { ok: true, storage: 'safeStorage' };
}

function loadSecret(name) {
  try {
    if (!encryptionAvailable()) return null;
    const { safeStorage } = require('electron');
    const p = storePath(name);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(p)));
  } catch (_) {
    return null;
  }
}

function deleteSecret(name) {
  try { fs.unlinkSync(storePath(name)); } catch (_) {}
}

function applyEnv(map) {
  for (const [k, v] of Object.entries(map || {})) {
    if (v != null && v !== '') process.env[k] = String(v);
  }
}

/** Binance keys — replace .env writes from the dashboard */
function saveBinanceKeys({ apiKey, secret, testnet }) {
  const payload = {
    apiKey: String(apiKey || '').trim(),
    secret: String(secret || '').trim(),
    testnet: !!testnet,
  };
  const r = saveSecret('binance', payload);
  if (!r.ok) return r;
  if (testnet) {
    applyEnv({ BINANCE_TESTNET_API_KEY: payload.apiKey, BINANCE_TESTNET_SECRET: payload.secret });
  } else {
    applyEnv({ BINANCE_API_KEY: payload.apiKey, BINANCE_SECRET: payload.secret });
  }
  return r;
}

function loadBinanceKeys() {
  const s = loadSecret('binance');
  if (s?.apiKey && s?.secret) {
    if (s.testnet) applyEnv({ BINANCE_TESTNET_API_KEY: s.apiKey, BINANCE_TESTNET_SECRET: s.secret });
    else applyEnv({ BINANCE_API_KEY: s.apiKey, BINANCE_SECRET: s.secret });
    return s;
  }
  // migrate from env once
  const apiKey = process.env.BINANCE_API_KEY || process.env.BINANCE_TESTNET_API_KEY;
  const secret = process.env.BINANCE_SECRET || process.env.BINANCE_TESTNET_SECRET;
  if (apiKey && secret) {
    const testnet = !!(process.env.BINANCE_TESTNET_API_KEY && !process.env.BINANCE_API_KEY);
    saveBinanceKeys({ apiKey, secret, testnet });
    return { apiKey, secret, testnet };
  }
  return null;
}

/** Cognito / auth tokens */
function saveAuthTokens(tokens) {
  return saveSecret('auth', tokens);
}

function loadAuthTokens() {
  return loadSecret('auth');
}

function clearAuthTokens() {
  deleteSecret('auth');
}

/** X / Twitter manager credentials */
function saveXCreds(creds) {
  return saveSecret('x-manager', creds);
}

function loadXCreds() {
  return loadSecret('x-manager');
}

/** Telegram session string */
function saveTelegramSession(data) {
  return saveSecret('telegram', data);
}

function loadTelegramSession() {
  return loadSecret('telegram');
}

/** Strip known secret fields before writing settings.json */
const SETTINGS_SECRET_KEYS = [
  'binanceKey', 'binanceSecret', 'binanceApiKey', 'binanceApiSecret',
  'coingeckoKey', 'moralisKey', 'youtubeKey', 'etherscanKey',
  'elevenLabsKey', 'elevenLabsVoiceId',
];

function scrubSettingsSecrets(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = { ...settings };
  for (const k of SETTINGS_SECRET_KEYS) {
    if (out[k]) delete out[k];
  }
  return out;
}

module.exports = {
  encryptionAvailable,
  saveSecret,
  loadSecret,
  deleteSecret,
  saveBinanceKeys,
  loadBinanceKeys,
  saveAuthTokens,
  loadAuthTokens,
  clearAuthTokens,
  saveXCreds,
  loadXCreds,
  saveTelegramSession,
  loadTelegramSession,
  scrubSettingsSecrets,
  SETTINGS_SECRET_KEYS,
};
