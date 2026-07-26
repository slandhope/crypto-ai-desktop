// ═══════════════════════════════════════════════════════════════════
// 🔑 AUTH — verifies Cognito (Google login) tokens on each request.
// Turns the app's bearer token into a TRUSTED user id + email, so the
// credit engine and state sync are tied to a real logged-in person.
//
//   const { authRequired, authOptional, userIdOf } = require('./auth');
//   api.post('/ai/chat', authRequired, handler)   // 401 if no valid token
//   api.get('/something', authOptional, handler)   // sets req.user if present
//
// Env needed (public identifiers, safe in .env):
//   COGNITO_USER_POOL_ID   e.g. eu-north-1_WpZxCS0WY
//   COGNITO_CLIENT_ID      e.g. 5jopcf7b68tqe38cehuq6vv92a
//   AWS_REGION             e.g. eu-north-1
// ═══════════════════════════════════════════════════════════════════
const { CognitoJwtVerifier } = require('aws-jwt-verify');
const { OAuth2Client } = require('google-auth-library');

const POOL_ID   = process.env.COGNITO_USER_POOL_ID || '';
// accept one or more client IDs (comma-separated) — desktop + web + mobile
const CLIENT_IDS = (process.env.COGNITO_CLIENT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
// Google client IDs accepted from the mobile app's native sign-in (comma-separated)
const GOOGLE_CLIENT_IDS = (process.env.GOOGLE_CLIENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const googleClient = new OAuth2Client();

let verifier = null;
if (POOL_ID && CLIENT_IDS.length) {
  verifier = CognitoJwtVerifier.create({
    userPoolId: POOL_ID,
    clientId: CLIENT_IDS.length === 1 ? CLIENT_IDS[0] : CLIENT_IDS,
    tokenUse: 'id',
  });
  console.log('🔑 Cognito verifier ready for pool', POOL_ID, '· clients:', CLIENT_IDS.length);
} else {
  console.warn('⚠️  COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID not set — auth is in TEST MODE (x-user-id header trusted).');
}
if (GOOGLE_CLIENT_IDS.length) console.log('🔑 Google token verification ready · clients:', GOOGLE_CLIENT_IDS.length);

// unify identity across desktop (Cognito) + mobile (Google) by EMAIL.
// Same person, same email → same userId everywhere → same Asuka + data.
function idFromEmail(email) { return 'u_' + Buffer.from(String(email).toLowerCase().trim()).toString('base64url'); }

function extractToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return req.headers['x-id-token'] || null;
}

// try verifying a token as Cognito first, then Google
async function verifyAnyToken(token) {
  // 1. Cognito (desktop / web)
  if (verifier) {
    try {
      const p = await verifier.verify(token);
      return { email: p.email || null, name: p.name || p['cognito:username'] || null, via: 'cognito' };
    } catch (e) { /* fall through to Google */ }
  }
  // 2. Google native (mobile)
  if (GOOGLE_CLIENT_IDS.length) {
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_IDS });
      const p = ticket.getPayload();
      return { email: p.email || null, name: p.name || null, via: 'google' };
    } catch (e) { /* not a valid Google token either */ }
  }
  return null;
}

// resolve a user object from the request, or null
async function resolveUser(req) {
  // TEST MODE: no verifiers configured → trust x-user-id (dev only)
  if (!verifier && !GOOGLE_CLIENT_IDS.length) {
    const uid = req.headers['x-user-id'];
    return uid ? { userId: uid, email: null, testMode: true } : null;
  }
  const token = extractToken(req);
  if (!token) return null;
  const v = await verifyAnyToken(token);
  if (!v || !v.email) return null;               // require email to unify identity
  return {
    userId: idFromEmail(v.email),                // SAME id on desktop + mobile (keyed by email)
    email: v.email,
    name: v.name,
    via: v.via,
  };
}

// middleware: hard-require a valid login
async function authRequired(req, res, next) {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Please sign in.' });
  req.user = user;
  next();
}

// middleware: attach user if present, but don't block
async function authOptional(req, res, next) {
  req.user = await resolveUser(req);
  next();
}

// helper for non-middleware spots
function userIdOf(req) {
  return (req.user && req.user.userId) || req.headers['x-user-id'] || 'anon';
}

module.exports = { authRequired, authOptional, userIdOf, resolveUser };
