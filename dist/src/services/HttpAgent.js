"use strict";
/**
 * Shared HTTP/HTTPS keep-alive agents.
 *
 * Reusing TCP/TLS connections across YouTube and LM Studio calls saves
 * 80–200 ms per request (no fresh handshake), which compounds heavily in a
 * real-time moderation pipeline.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.httpsAgent = exports.httpAgent = void 0;
exports.attachToAxios = attachToAxios;
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const KEEP_ALIVE_MS = 60_000;
const MAX_SOCKETS = 32;
const MAX_FREE_SOCKETS = 16;
exports.httpAgent = new http_1.default.Agent({
    keepAlive: true,
    keepAliveMsecs: KEEP_ALIVE_MS,
    maxSockets: MAX_SOCKETS,
    maxFreeSockets: MAX_FREE_SOCKETS
});
exports.httpsAgent = new https_1.default.Agent({
    keepAlive: true,
    keepAliveMsecs: KEEP_ALIVE_MS,
    maxSockets: MAX_SOCKETS,
    maxFreeSockets: MAX_FREE_SOCKETS
});
function attachToAxios(axiosInstance) {
    if (!axiosInstance?.defaults)
        return;
    axiosInstance.defaults.httpAgent = exports.httpAgent;
    axiosInstance.defaults.httpsAgent = exports.httpsAgent;
}
//# sourceMappingURL=HttpAgent.js.map