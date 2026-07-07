// SPDX-License-Identifier: MPL-2.0
/**
 * The single (req, res) handler mounted both on Vercel (api/mcp/[...path].js, via
 * vercel-entry.ts) and by the standalone HTTP server (http.ts). It routes:
 *
 *   OPTIONS *                                     → CORS preflight
 *   GET  /.well-known/oauth-protected-resource    → resource metadata  (oauth.ts)
 *   GET  /.well-known/oauth-authorization-server   → AS metadata        (oauth.ts)
 *   POST …/register  …/authorize  …/token          → the OAuth flow     (oauth.ts)
 *   GET  …/authorize                               → consent page
 *   POST …/mcp  (or /api/mcp)                       → JSON-RPC dispatch  (server.ts)
 *
 * Routing is by path SUFFIX (…endsWith('/register') etc.), so it is robust to
 * however Vercel presents the path after the well-known rewrites — and to the
 * standalone `/mcp` mount. The JSON-RPC endpoint is gated by oauth.isAuthorized;
 * a 401 carries `WWW-Authenticate` pointing at the resource metadata, which is
 * what makes a spec client (claude.ai) begin the OAuth dance.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { dispatch } from './server.ts';
import type { JsonRpcRequest } from './protocol.ts';
import {
  authorizationServerMetadata, authorizeGet, authorizePost, isAuthorized,
  protectedResourceMetadata, register, token, type Result,
} from './oauth.ts';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version',
  // Expose the 401 challenge so a browser-side MCP client can read where to auth.
  'access-control-expose-headers': 'WWW-Authenticate',
};

const MAX_BODY = 32 * 1024 * 1024; // 32 MB — room for base64 file uploads to transform tools.

function readBody(req: IncomingMessage): Promise<string> {
  // Vercel's Node helper may have pre-parsed the body; prefer the raw stream but
  // fall back to a materialised req.body (string/Buffer/object).
  const pre = (req as unknown as { body?: unknown }).body;
  if (pre !== undefined && pre !== null && typeof (req as unknown as { on?: unknown }).on !== 'function') {
    return Promise.resolve(typeof pre === 'string' || Buffer.isBuffer(pre) ? String(pre) : JSON.stringify(pre));
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function baseUrlOf(req: IncomingMessage): string {
  const host = String(req.headers.host || 'localhost');
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0]!.trim();
  const proto = fwd || (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

function send(res: ServerResponse, r: Result): void {
  const headers: Record<string, string> = { ...CORS, ...(r.headers || {}) };
  if (r.redirect) { res.writeHead(r.status, { ...headers, location: r.redirect }); res.end(); return; }
  if (r.json !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8';
    res.writeHead(r.status, headers); res.end(JSON.stringify(r.json)); return;
  }
  headers['content-type'] = 'text/html; charset=utf-8';
  res.writeHead(r.status, headers); res.end(r.html || ''); return;
}

const formToObject = (raw: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(raw));

export function createGateway(env: NodeJS.ProcessEnv = process.env): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const method = req.method || 'GET';
    if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    const url = new URL(req.url || '/', 'http://internal');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const base = baseUrlOf(req);

    // ── discovery (GET) ──────────────────────────────────────────────────────
    if (method === 'GET' && path.includes('oauth-authorization-server')) return send(res, authorizationServerMetadata(base));
    if (method === 'GET' && path.includes('oauth-protected-resource')) return send(res, protectedResourceMetadata(base));

    // ── OAuth endpoints ──────────────────────────────────────────────────────
    if (path.endsWith('/register')) {
      if (method !== 'POST') return send(res, { status: 405, headers: { allow: 'POST' }, json: { error: 'method_not_allowed' } });
      let body: Record<string, unknown> = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, { status: 400, json: { error: 'invalid_request', error_description: 'body is not JSON' } }); }
      return send(res, await register(body, env));
    }
    if (path.endsWith('/authorize')) {
      const q = Object.fromEntries(url.searchParams) as Record<string, string>;
      if (method === 'GET') return send(res, await authorizeGet(q, env));
      if (method === 'POST') {
        let form: Record<string, string>;
        try { form = formToObject(await readBody(req)); } catch { return send(res, { status: 400, json: { error: 'invalid_request', error_description: 'could not read request body' } }); }
        return send(res, await authorizePost({ ...q, ...form }, env));
      }
      return send(res, { status: 405, headers: { allow: 'GET, POST' }, json: { error: 'method_not_allowed' } });
    }
    if (path.endsWith('/token')) {
      if (method !== 'POST') return send(res, { status: 405, headers: { allow: 'POST' }, json: { error: 'method_not_allowed' } });
      let form: Record<string, string>;
      try { form = formToObject(await readBody(req)); } catch { return send(res, { status: 400, json: { error: 'invalid_request', error_description: 'could not read request body' } }); }
      return send(res, await token(form, env));
    }

    // ── the MCP JSON-RPC endpoint ────────────────────────────────────────────
    if (path.endsWith('/mcp')) {
      if (method !== 'POST') { res.writeHead(405, { ...CORS, allow: 'POST, OPTIONS' }); res.end(); return; }
      if (!(await isAuthorized(req.headers['authorization'] as string | undefined, env))) {
        res.writeHead(401, {
          ...CORS,
          'content-type': 'application/json',
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
        return;
      }
      let msg: JsonRpcRequest;
      try { msg = JSON.parse((await readBody(req)) || 'null') as JsonRpcRequest; }
      catch { res.writeHead(200, { ...CORS, 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
      const response = await dispatch(msg);
      if (!response) { res.writeHead(202, CORS); res.end(); return; } // notification
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    res.writeHead(404, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path }));
  };
}
