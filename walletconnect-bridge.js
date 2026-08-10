'use strict';
/**
 * Live WalletConnect v2 (Sign Client) for Electron main process.
 * Session only — no private keys. User approves txs in their wallet.
 */
const QRCode = require('qrcode');

let SignClient = null;
let client = null;
let pendingApproval = null; // cancel flag
let activeSession = null;
let emit = () => {};

const CHAINS = ['eip155:1', 'eip155:56', 'eip155:137', 'eip155:8453', 'eip155:42161'];
const METHODS = [
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
];
const EVENTS = ['chainChanged', 'accountsChanged'];

function projectId() {
  return (
    process.env.WALLETCONNECT_PROJECT_ID ||
    process.env.REOWN_PROJECT_ID ||
    process.env.WC_PROJECT_ID ||
    ''
  ).trim();
}

function parseAccount(caip) {
  // eip155:1:0xabc…
  const parts = String(caip || '').split(':');
  if (parts.length < 3) return null;
  return {
    chainId: `${parts[0]}:${parts[1]}`,
    address: parts.slice(2).join(':'),
  };
}

function sessionSnapshot(session) {
  if (!session) return null;
  const accounts = session.namespaces?.eip155?.accounts || [];
  const first = parseAccount(accounts[0]);
  return {
    topic: session.topic,
    address: first?.address || null,
    chainId: first?.chainId || null,
    accounts,
    peer: session.peer?.metadata?.name || null,
    expiry: session.expiry,
  };
}

function deepLinkFor(provider, uri) {
  const enc = encodeURIComponent(uri);
  if (provider === 'trust') return `https://link.trustwallet.com/wc?uri=${enc}`;
  if (provider === 'metamask') return `https://metamask.app.link/wc?uri=${enc}`;
  return uri;
}

function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : () => {};
}

async function ensureClient() {
  const pid = projectId();
  if (!pid) {
    const err = new Error(
      'Missing WALLETCONNECT_PROJECT_ID — create a free project at https://cloud.reown.com and set it in .env'
    );
    err.code = 'missing_project_id';
    throw err;
  }
  if (client) return client;

  if (!SignClient) {
    SignClient = require('@walletconnect/sign-client').default || require('@walletconnect/sign-client');
  }

  client = await SignClient.init({
    projectId: pid,
    metadata: {
      name: 'Asuka',
      description: 'Asuka — crypto companion desktop',
      url: 'https://asuka.app',
      icons: ['https://avatars.githubusercontent.com/u/37784886'],
    },
  });

  client.on('session_delete', () => {
    activeSession = null;
    emit('walletconnect-disconnected', {});
  });
  client.on('session_expire', () => {
    activeSession = null;
    emit('walletconnect-disconnected', { reason: 'expired' });
  });

  const sessions = client.session.getAll();
  if (sessions?.length) {
    activeSession = sessions[sessions.length - 1];
  }

  return client;
}

function getStatus() {
  const snap = sessionSnapshot(activeSession);
  if (!snap?.address) {
    return { live: false, mode: null, address: null };
  }
  return {
    live: true,
    mode: 'walletconnect',
    address: snap.address,
    chainId: snap.chainId,
    peer: snap.peer,
    topic: snap.topic,
  };
}

async function startConnect({ provider = 'metamask' } = {}) {
  pendingApproval = { cancelled: false };
  const c = await ensureClient();

  const { uri, approval } = await c.connect({
    optionalNamespaces: {
      eip155: {
        methods: METHODS,
        chains: CHAINS,
        events: EVENTS,
      },
    },
  });

  if (!uri) throw new Error('WalletConnect did not return a pairing URI');

  const qrDataUrl = await QRCode.toDataURL(uri, {
    margin: 2,
    width: 280,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
  const deepLink = deepLinkFor(provider, uri);

  emit('walletconnect-uri', { uri, qrDataUrl, deepLink, provider });

  const wait = (async () => {
    try {
      const session = await approval();
      if (pendingApproval?.cancelled) {
        try { await c.disconnect({ topic: session.topic, reason: { code: 6000, message: 'User cancelled' } }); } catch (_) {}
        return { ok: false, error: 'cancelled' };
      }
      activeSession = session;
      const snap = sessionSnapshot(session);
      emit('walletconnect-connected', snap);
      return { ok: true, ...snap, mode: 'walletconnect', live: true };
    } catch (e) {
      if (pendingApproval?.cancelled) return { ok: false, error: 'cancelled' };
      emit('walletconnect-error', { error: e.message || String(e) });
      return { ok: false, error: e.message || String(e) };
    } finally {
      pendingApproval = null;
    }
  })();

  return { ok: true, uri, qrDataUrl, deepLink, provider, wait };
}

function cancelConnect() {
  if (pendingApproval) pendingApproval.cancelled = true;
  pendingApproval = null;
  emit('walletconnect-cancelled', {});
}

async function disconnect() {
  cancelConnect();
  try {
    const c = client || (projectId() ? await ensureClient() : null);
    if (c && activeSession?.topic) {
      await c.disconnect({
        topic: activeSession.topic,
        reason: { code: 6000, message: 'User disconnected' },
      });
    }
  } catch (_) {}
  activeSession = null;
  emit('walletconnect-disconnected', {});
  return { ok: true };
}

/** Request a method on the live session (e.g. personal_sign / eth_sendTransaction). */
async function request({ method, params, chainId } = {}) {
  if (!client || !activeSession?.topic) {
    return { ok: false, error: 'No live WalletConnect session' };
  }
  const snap = sessionSnapshot(activeSession);
  const chain = chainId || snap.chainId || 'eip155:1';
  try {
    const result = await client.request({
      topic: activeSession.topic,
      chainId: chain,
      request: { method, params },
    });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  projectId,
  setEmitter,
  ensureClient,
  getStatus,
  startConnect,
  cancelConnect,
  disconnect,
  request,
  sessionSnapshot,
  deepLinkFor,
};
