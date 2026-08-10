'use strict';
/**
 * Pure vault crypto — used only inside the signer process (or in-process fallback).
 * Main / AI must never import decrypt for buyback keys.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadVault(vaultPath) {
  try {
    if (!fs.existsSync(vaultPath)) return {};
    return JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveVault(vaultPath, data) {
  const dir = path.dirname(vaultPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const tmp = vaultPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, vaultPath);
}

function encryptKey(plainKey, pin) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(pin), salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
  const enc = Buffer.concat([cipher.update(String(plainKey), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: enc.toString('hex'),
  };
}

function decryptKey(entry, pin) {
  try {
    const derived = crypto.scryptSync(String(pin), Buffer.from(entry.salt, 'hex'), 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', derived, Buffer.from(entry.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.data, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch (_) {
    return null;
  }
}

/** In-memory session for unlocked projects — never serialized. */
class SignerSession {
  constructor(vaultPath) {
    this.vaultPath = vaultPath;
    this._unlocked = new Map(); // projectId → { key, at }
  }

  store(projectId, privateKey, pin) {
    if (!projectId || !privateKey || !pin || String(pin).length < 4) {
      return { ok: false, error: 'Need projectId, private key, and PIN (4+ chars)' };
    }
    const vault = loadVault(this.vaultPath);
    vault[projectId] = encryptKey(privateKey, pin);
    saveVault(this.vaultPath, vault);
    // Do not keep plaintext after store
    this._unlocked.delete(projectId);
    return { ok: true };
  }

  unlock(projectId, pin) {
    const vault = loadVault(this.vaultPath);
    if (!vault[projectId]) return { ok: false, error: 'No burner saved for this project' };
    const key = decryptKey(vault[projectId], pin);
    if (!key) return { ok: false, error: 'Wrong PIN' };
    this._unlocked.set(projectId, { key, at: Date.now() });
    return { ok: true, unlocked: true };
  }

  lock(projectId) {
    if (projectId) this._unlocked.delete(projectId);
    else this._unlocked.clear();
    return { ok: true };
  }

  status() {
    return {
      ok: true,
      vaultPath: this.vaultPath,
      unlocked: [...this._unlocked.keys()],
      stored: Object.keys(loadVault(this.vaultPath)),
    };
  }

  has(projectId) {
    return this._unlocked.has(projectId);
  }

  /**
   * Export key ONLY for signing inside this process.
   * Host API must never expose this over IPC to main.
   */
  _getKeyForSign(projectId) {
    return this._unlocked.get(projectId)?.key || null;
  }

  /** Scaffold — real chain broadcast is Phase 5; proves key never leaves signer. */
  prepareSign(projectId, intent = {}) {
    if (!this._unlocked.has(projectId)) {
      return { ok: false, error: 'locked', needsUnlock: true };
    }
    const key = this._getKeyForSign(projectId);
    if (!key) return { ok: false, error: 'locked' };
    // Touch key length only — never return key material
    return {
      ok: true,
      mode: 'scaffold',
      projectId,
      intent: intent || {},
      keyFingerprint: crypto.createHash('sha256').update(key).digest('hex').slice(0, 12),
      note: 'Signer holds key in utility process; on-chain broadcast not enabled yet.',
    };
  }
}

module.exports = { SignerSession, encryptKey, decryptKey, loadVault, saveVault };
