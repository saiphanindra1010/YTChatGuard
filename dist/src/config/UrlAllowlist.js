"use strict";
/**
 * Validates LM Studio / local AI base URLs to reduce SSRF from server-side fetches.
 * Allows only http(s) without embedded credentials, resolving to loopback or private (RFC1918-style) hosts.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPrivateHost = isPrivateHost;
exports.assertSafeLocalUrl = assertSafeLocalUrl;
const net_1 = __importDefault(require("net"));
const PRIVATE_V4 = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./
];
function isPrivateHost(hostname) {
    if (!hostname)
        return false;
    if (hostname === 'localhost')
        return true;
    const family = net_1.default.isIP(hostname);
    if (family === 4) {
        return PRIVATE_V4.some((re) => re.test(hostname));
    }
    if (family === 6) {
        const h = hostname.toLowerCase();
        return (h === '::1' ||
            h.startsWith('fe80:') ||
            h.startsWith('fc') ||
            h.startsWith('fd'));
    }
    return false;
}
function assertSafeLocalUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
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
//# sourceMappingURL=UrlAllowlist.js.map