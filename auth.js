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

const POOL_ID   = process.env.COGNITO_USER_POOL_ID || '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';

let verifier = null;
if (POOL_ID && CLIENT_ID) {
  // verify ID tokens (they carry email/name); accept access tokens too
  verifier = CognitoJwtVerifier.create({
    userPoolId: POOL_ID,
    clientId: CLIENT_ID,
    tokenUse: 'id',          // id token → has email + name claims
  });
  console.log('🔑 Cognito verifier ready for pool', POOL_ID);
} else {
  console.warn('⚠️  COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID not set — auth is in TEST MODE (x-user-id header trusted). Set them in .env to enforce real login.');
}

function extractToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return req.headers['x-id-token'] || null;
}

// resolve a user object from the request, or null
async function resolveUser(req) {
  // TEST MODE: no verifier configured → trust x-user-id (dev only)
  if (!verifier) {
    const uid = req.headers['x-user-id'];
    return uid ? { userId: uid, email: null, testMode: true } : null;
  }
  const token = extractToken(req);
  if (!token) return null;
  try {
    const payload = await verifier.verify(token);
    return {
      userId: payload.sub,               // stable Cognito user id (same across devices)
      email: payload.email || null,
      name: payload.name || payload['cognito:username'] || null,
    };
  } catch (e) {
    return null;                          // invalid/expired token
  }
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
