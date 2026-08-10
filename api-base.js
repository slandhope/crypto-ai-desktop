// Single source of truth for the product API base URL (desktop clients).
// Production builds refuse plain HTTP to remote hosts unless ASUKA_ALLOW_INSECURE_API=1.
function getApiBase() {
  const raw = (process.env.ASUKA_API_BASE || '').trim().replace(/\/$/, '')
    || 'http://13.51.141.42:3000';
  const requireHttps = process.env.ASUKA_REQUIRE_HTTPS === '1'
    || process.env.ASUKA_REQUIRE_HTTPS === 'true'
    || (isPackaged() && process.env.ASUKA_ALLOW_INSECURE_API !== '1');

  if (requireHttps && !raw.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(raw)) {
    throw new Error(
      'Refusing insecure API base "' + raw + '". Set ASUKA_API_BASE=https://your.domain '
      + '(and ASUKA_REQUIRE_HTTPS=1). For local/dev only: ASUKA_ALLOW_INSECURE_API=1'
    );
  }
  if (raw.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(raw)) {
    console.warn('⚠️  ASUKA_API_BASE is plain HTTP — tokens & memory travel in cleartext. Set https:// + ASUKA_REQUIRE_HTTPS=1');
  }
  return raw;
}

function isPackaged() {
  try {
    const { app } = require('electron');
    return !!(app && app.isPackaged);
  } catch (_) {
    return false;
  }
}

module.exports = { getApiBase };
