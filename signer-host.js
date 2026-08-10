'use strict';
/**
 * Main-process host for the signer utility process.
 * Falls back to in-process SignerSession if utilityProcess is unavailable.
 */
const path = require('path');
const { SignerSession } = require('./signer-core');

let child = null;
let fallback = null;
let vaultPath = null;
let reqId = 0;
const pending = new Map();
let mode = 'none'; // 'utility' | 'inprocess' | 'none'

function settle(id, data) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(data);
}

function callWorker(type, payload = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const id = ++reqId;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'signer_timeout' });
    }, timeoutMs);
    pending.set(id, { resolve, timer });

    if (mode === 'utility' && child) {
      try {
        child.postMessage({ id, type, ...payload });
      } catch (e) {
        settle(id, { ok: false, error: e.message });
      }
      return;
    }

    if (mode === 'inprocess' && fallback) {
      try {
        let res;
        switch (type) {
          case 'init': res = { ok: true, ready: true }; break;
          case 'store': res = fallback.store(payload.projectId, payload.privateKey, payload.pin); break;
          case 'unlock': res = fallback.unlock(payload.projectId, payload.pin); break;
          case 'lock': res = fallback.lock(payload.projectId); break;
          case 'status': res = fallback.status(); break;
          case 'prepare-sign': res = fallback.prepareSign(payload.projectId, payload.intent); break;
          case 'ping': res = { ok: true, pong: true, mode: 'inprocess' }; break;
          default: res = { ok: false, error: 'unknown_type' };
        }
        settle(id, res);
      } catch (e) {
        settle(id, { ok: false, error: e.message });
      }
      return;
    }

    settle(id, { ok: false, error: 'signer_not_started' });
  });
}

function startInProcess(vp) {
  vaultPath = vp;
  fallback = new SignerSession(vp);
  mode = 'inprocess';
  console.warn('🔐 Signer running in-process fallback (utilityProcess unavailable)');
  return { ok: true, mode };
}

async function start(vp) {
  vaultPath = vp;
  if (child || (mode === 'inprocess' && fallback)) {
    return { ok: true, mode, already: true };
  }

  try {
    const { utilityProcess, app } = require('electron');
    if (!utilityProcess?.fork) return startInProcess(vp);

    const workerPath = path.join(__dirname, 'signer-worker.js');
    child = utilityProcess.fork(workerPath, [], {
      serviceName: 'asuka-signer',
      stdio: 'pipe',
    });

    child.on('message', (data) => {
      if (data?.id != null) settle(data.id, data);
      else if (data?.type === 'signer-boot') {
        // ready
      }
    });
    child.on('exit', (code) => {
      console.warn('🔐 Signer utility process exited', code);
      child = null;
      mode = 'none';
      for (const [id] of pending) settle(id, { ok: false, error: 'signer_exited' });
    });

    // Wait briefly for spawn
    await new Promise((r) => {
      if (child) {
        child.once('spawn', r);
        setTimeout(r, 800);
      } else r();
    });

    mode = 'utility';
    const init = await callWorker('init', { vaultPath: vp });
    if (!init.ok) {
      try { child?.kill?.(); } catch (_) {}
      child = null;
      return startInProcess(vp);
    }
    console.log('🔐 Signer utility process ready (pid isolation)');
    return { ok: true, mode: 'utility' };
  } catch (e) {
    console.warn('🔐 Signer utilityProcess failed:', e.message);
    return startInProcess(vp);
  }
}

async function ensure(vp) {
  if (mode === 'none') await start(vp || vaultPath);
  return mode !== 'none';
}

async function storeKey(projectId, privateKey, pin) {
  await ensure();
  return callWorker('store', { projectId, privateKey, pin });
}

async function unlock(projectId, pin) {
  await ensure();
  return callWorker('unlock', { projectId, pin });
}

async function lock(projectId) {
  await ensure();
  return callWorker('lock', { projectId });
}

async function status() {
  if (mode === 'none') return { ok: false, error: 'signer_not_started', mode };
  const st = await callWorker('status');
  return { ...st, mode };
}

async function prepareSign(projectId, intent) {
  await ensure();
  return callWorker('prepare-sign', { projectId, intent });
}

function getMode() {
  return mode;
}

module.exports = {
  start,
  ensure,
  storeKey,
  unlock,
  lock,
  status,
  prepareSign,
  getMode,
};
