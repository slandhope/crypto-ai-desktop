'use strict';
/**
 * Tool broker — single gate for dangerous OS / messaging / vault actions.
 *
 * Process model:
 *   Renderer ──IPC──► Main ──requestTool──► Broker (policy + confirm)
 *                              │
 *                              ├── OS / messaging execute in main (needs Electron dialog + OS APIs)
 *                              └── Vault keys go to signer utility process (signer-host)
 *
 * The broker itself stays in main for confirms (dialog), but is the ONLY
 * allowlist + confirm entry so AI/command paths cannot bypass policy.
 */
const sec = require('./security-hardening');

/** Tools that always require human confirm */
const DANGEROUS = new Set([
  'imessage-send', 'whatsapp-send', 'tg-post-pin', 'post-marketing',
  'xmgr-post-now', 'docs-write', 'sheet-edit', 'restore-backup',
  'note-create', 'os-lock', 'os-sleep', 'os-empty-trash',
  'buyback-set-burner', 'buyback-unlock', 'walletconnect-request',
  'signer-store', 'signer-unlock', 'signer-prepare-sign',
  'tg-kick', 'tg-ban', 'tg-unban', 'tg-mute', 'tg-unmute',
  'tg-delete-message', 'tg-set-title', 'tg-set-description',
  'tg-approve-join', 'tg-decline-join', 'tg-promote', 'tg-leave',
]);

/** Tools allowed without confirm (reads / paper / status) */
const SAFE = new Set([
  'get-status', 'get-prices', 'paper-trade-status', 'telegram-status',
  'walletconnect-status', 'signer-status',
]);

const auditLog = [];
const AUDIT_CAP = 200;

function audit(entry) {
  auditLog.unshift({ ...entry, at: Date.now() });
  if (auditLog.length > AUDIT_CAP) auditLog.length = AUDIT_CAP;
}

/**
 * @param {string} name
 * @param {{ title?: string, detail?: string, danger?: boolean, skipConfirm?: boolean }} meta
 * @returns {Promise<{ allowed: boolean, cancelled?: boolean, error?: string }>}
 */
async function requestTool(name, meta = {}) {
  const tool = String(name || '');

  if (SAFE.has(tool)) {
    audit({ tool, allowed: true, reason: 'safe' });
    return { allowed: true };
  }

  if (!DANGEROUS.has(tool) && meta.requireAllowlist) {
    audit({ tool, allowed: false, reason: 'not_allowlisted' });
    return { allowed: false, error: 'tool_not_allowlisted' };
  }

  if (!DANGEROUS.has(tool)) {
    // Unknown tools: allow but log (legacy paths); prefer adding to DANGEROUS/SAFE
    audit({ tool, allowed: true, reason: 'unlisted_legacy' });
    return { allowed: true };
  }

  if (meta.skipConfirm) {
    audit({ tool, allowed: false, reason: 'skipConfirm_blocked' });
    return { allowed: false, error: 'skipConfirm_not_permitted' };
  }

  const gate = await sec.gateDangerousAction({
    title: meta.title || `Allow ${tool}?`,
    detail: meta.detail || '',
    danger: meta.danger !== false,
  });

  if (gate) {
    audit({ tool, allowed: false, reason: 'cancelled' });
    return { allowed: false, cancelled: true, error: 'cancelled' };
  }

  audit({ tool, allowed: true, reason: 'confirmed' });
  return { allowed: true };
}

function getAuditLog(limit = 50) {
  return auditLog.slice(0, limit);
}

module.exports = { requestTool, DANGEROUS, SAFE, getAuditLog };
