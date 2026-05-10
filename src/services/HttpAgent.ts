/**
 * Shared HTTP/HTTPS keep-alive agents.
 *
 * Reusing TCP/TLS connections across YouTube and LM Studio calls saves
 * 80–200 ms per request (no fresh handshake), which compounds heavily in a
 * real-time moderation pipeline.
 */

import http from 'http';
import https from 'https';
import type { AxiosInstance } from 'axios';

const KEEP_ALIVE_MS = 60_000;
const MAX_SOCKETS = 32;
const MAX_FREE_SOCKETS = 16;

export const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: KEEP_ALIVE_MS,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS
});

export const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: KEEP_ALIVE_MS,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS
});

export function attachToAxios(axiosInstance: AxiosInstance | null | undefined): void {
  if (!axiosInstance?.defaults) return;
  axiosInstance.defaults.httpAgent = httpAgent;
  axiosInstance.defaults.httpsAgent = httpsAgent;
}
