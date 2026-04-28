/**
 * Validates LM Studio / local AI base URLs to reduce SSRF from server-side fetches.
 * Allows only http(s) without embedded credentials, resolving to loopback or private (RFC1918-style) hosts.
 */

const net = require('net');

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./
];

function isPrivateHost(hostname) {
  if (!hostname) return false;
  if (hostname === 'localhost') return true;
  const family = net.isIP(hostname);
  if (family === 4) {
    return PRIVATE_V4.some((re) => re.test(hostname));
  }
  if (family === 6) {
    const h = hostname.toLowerCase();
    return (
      h === '::1' ||
      h.startsWith('fe80:') ||
      h.startsWith('fc') ||
      h.startsWith('fd')
    );
  }
  return false;
}

/**
 * @param {string} raw
 * @returns {URL}
 */
function assertSafeLocalUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http(s) is allowed');
  }
  if (u.username || u.password) {
    throw new Error('Credentials in URL are not allowed');
  }
  if (!isPrivateHost(u.hostname)) {
    throw new Error('URL must point to localhost or a private network address');
  }
  return u;
}

module.exports = { assertSafeLocalUrl, isPrivateHost };
