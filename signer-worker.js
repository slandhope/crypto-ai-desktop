'use strict';
/**
 * Signer utility-process entry.
 * Owns wallet-vault.enc encrypt/decrypt + in-memory unlock.
 * Never posts private key material back to the parent.
 */
const { SignerSession } = require('./signer-core');

let session = null;

function reply(id, payload) {
  try {
    process.parentPort.postMessage({ id, ...payload });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('signer reply failed', e.message);
  }
}

function handle(msg) {
  const id = msg?.id;
  try {
    switch (msg?.type) {
      case 'init': {
        if (!msg.vaultPath) return reply(id, { ok: false, error: 'vaultPath required' });
        session = new SignerSession(msg.vaultPath);
        return reply(id, { ok: true, ready: true });
      }
      case 'store': {
        if (!session) return reply(id, { ok: false, error: 'not_init' });
        return reply(id, session.store(msg.projectId, msg.privateKey, msg.pin));
      }
      case 'unlock': {
        if (!session) return reply(id, { ok: false, error: 'not_init' });
        return reply(id, session.unlock(msg.projectId, msg.pin));
      }
      case 'lock': {
        if (!session) return reply(id, { ok: false, error: 'not_init' });
        return reply(id, session.lock(msg.projectId));
      }
      case 'status': {
        if (!session) return reply(id, { ok: false, error: 'not_init' });
        return reply(id, session.status());
      }
      case 'prepare-sign': {
        if (!session) return reply(id, { ok: false, error: 'not_init' });
        return reply(id, session.prepareSign(msg.projectId, msg.intent));
      }
      case 'ping':
        return reply(id, { ok: true, pong: true, pid: process.pid });
      default:
        return reply(id, { ok: false, error: 'unknown_type' });
    }
  } catch (e) {
    return reply(id, { ok: false, error: e.message || String(e) });
  }
}

if (process.parentPort) {
  process.parentPort.on('message', (e) => handle(e.data || e));
  process.parentPort.postMessage({ type: 'signer-boot', ok: true, pid: process.pid });
} else {
  // Allow requiring as module for in-process fallback tests
  module.exports = { handle, getSession: () => session };
}
