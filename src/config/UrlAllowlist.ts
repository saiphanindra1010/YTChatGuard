/**
 * Validates LM Studio / local AI base URLs to reduce SSRF from server-side fetches.
 * Allows only http(s) without embedded credentials, resolving to loopback or private (RFC1918-style) hosts.
 */

import net from 'net';

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./
];

export function isPrivateHost(hostname: string): boolean {
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

export type SafeLocalUrlOptions = {
  /** When true, only localhost / 127.* / ::1 — not LAN (192.168.x, etc.). */
  localhostOnly?: boolean;
};

/** True loopback hostnames only (used when `localhostOnly` is set on URL checks). */
export function isLoopbackHost(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname.toLowerCase() === 'localhost') return true;
  const family = net.isIP(hostname);
  if (family === 4) {
    return /^127\./.test(hostname);
  }
  if (family === 6) {
    const h = hostname.toLowerCase();
    return h === '::1';
  }
  return false;
}

export function assertSafeLocalUrl(
  raw: string,
  opts: SafeLocalUrlOptions = {}
): URL {
  let u: URL;
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
  if (opts.localhostOnly) {
    if (!isLoopbackHost(u.hostname)) {
      throw new Error(
        'LM Studio URL must use localhost or 127.* (or ::1): enable private LAN URLs by turning off app.lmStudioUrlsLocalhostOnly in settings.'
      );
    }
  } else if (!isPrivateHost(u.hostname)) {
    throw new Error('URL must point to localhost or a private network address');
  }
  return u;
}
