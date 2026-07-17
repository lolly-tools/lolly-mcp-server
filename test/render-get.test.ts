// SPDX-License-Identifier: MPL-2.0
/**
 * The public GET render endpoint (src/render-get.ts) — the scoped-v1 policy:
 * Tier-A + resvg-png formats, official/community tools only, c2pa off, cacheable
 * (ETag/304), best-effort per-IP rate limit, LOLLY_DISABLE_RENDER_GET kill switch.
 * Driven through renderGet() directly (browser-free), plus one pass through the
 * gateway to prove the /tool/<id>.<ext> routing + CORS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { renderGet, matchRenderGetPath } from '../src/render-get.ts';
import { loadIndex } from '../src/catalog.ts';
import { createGateway } from '../src/gateway.ts';

const env = {} as NodeJS.ProcessEnv;
let ipSeq = 0;
const ip = (): string => `10.0.0.${++ipSeq}`;

test('path matcher accepts the embed shape and nothing else', () => {
  assert.deepEqual(matchRenderGetPath('/tool/qr-code.svg'), { toolId: 'qr-code', ext: 'svg' });
  assert.deepEqual(matchRenderGetPath('/api/mcp/tool/qr-code.png'), { toolId: 'qr-code', ext: 'png' });
  assert.equal(matchRenderGetPath('/tool/qr-code'), null);        // pretty path stays SPA-owned
  assert.equal(matchRenderGetPath('/tool/QR.svg'), null);         // id grammar is lowercase
  assert.equal(matchRenderGetPath('/api/mcp'), null);
});

test('happy path: svg render carries bytes + the cache/robots headers', async () => {
  const r = await renderGet('/tool/qr-code.svg', 'url=https%3A%2F%2Fsuse.com', { ip: ip(), env });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type']!, /^image\/svg\+xml/);
  assert.equal(r.headers['cache-control'], 'public, s-maxage=86400, stale-while-revalidate=604800');
  assert.match(r.headers['etag']!, /^"[0-9a-f]{32}"$/);
  assert.equal(r.headers['x-robots-tag'], 'noindex');
  assert.equal(r.headers['content-security-policy'], 'sandbox');
  const text = new TextDecoder().decode(r.body as Uint8Array);
  assert.match(text, /<svg/);
});

test('happy path: png via the resvg fast-path (no browser)', async () => {
  const r = await renderGet('/tool/qr-code.png', 'url=https%3A%2F%2Fsuse.com&width=128', { ip: ip(), env });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  const bytes = r.body as Uint8Array;
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic');
});

test('ETag is stable for a URL and If-None-Match yields 304', async () => {
  const q = 'url=https%3A%2F%2Fsuse.com';
  const a = await renderGet('/tool/qr-code.svg', q, { ip: ip(), env });
  const b = await renderGet('/tool/qr-code.svg', q, { ip: ip(), env });
  assert.equal(a.headers['etag'], b.headers['etag']);
  const cached = await renderGet('/tool/qr-code.svg', q, { ip: ip(), ifNoneMatch: a.headers['etag'], env });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, undefined);
  assert.equal(cached.headers['etag'], a.headers['etag']);
});

test('unknown tool is a 404', async () => {
  const r = await renderGet('/tool/no-such-tool-xyz.svg', '', { ip: ip(), env });
  assert.equal(r.status, 404);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('a non-official/community tool is the same 404 (no existence leak)', async () => {
  const { tools } = await loadIndex();
  const exp = tools.find(t => t.status === 'experimental');
  assert.ok(exp, 'active catalog should carry at least one experimental tool');
  const r = await renderGet(`/tool/${exp!.id}.svg`, '', { ip: ip(), env });
  assert.equal(r.status, 404);
  assert.equal(r.body, JSON.stringify({ error: 'not_found' }));
});

test('formats outside Tier-A + resvg-png are refused with a 400', async () => {
  const r = await renderGet('/tool/qr-code.mp4', '', { ip: ip(), env });
  assert.equal(r.status, 400);
  assert.match(String(r.body), /browser render tier/);
});

test('bad queries are honest 400s (oversize dims, oversize query)', async () => {
  const big = await renderGet('/tool/qr-code.svg', 'width=999999', { ip: ip(), env });
  assert.equal(big.status, 400);
  assert.match(String(big.body), /output cap/);

  const long = await renderGet('/tool/qr-code.svg', `url=${'a'.repeat(5000)}`, { ip: ip(), env });
  assert.equal(long.status, 400);
  assert.match(String(long.body), /Query too long/);
});

test('LOLLY_DISABLE_RENDER_GET=1 turns the whole route into 404s', async () => {
  const off = { LOLLY_DISABLE_RENDER_GET: '1' } as NodeJS.ProcessEnv;
  const r = await renderGet('/tool/qr-code.svg', 'url=https%3A%2F%2Fsuse.com', { ip: ip(), env: off });
  assert.equal(r.status, 404);
});

test('per-IP rate limit answers 429 with Retry-After once the window fills', async () => {
  const limited = { LOLLY_RENDER_GET_RPM: '1' } as NodeJS.ProcessEnv;
  const me = ip();
  const first = await renderGet('/tool/qr-code.svg', 'url=https%3A%2F%2Fsuse.com', { ip: me, env: limited });
  assert.equal(first.status, 200);
  const second = await renderGet('/tool/qr-code.svg', 'url=https%3A%2F%2Fsuse.com', { ip: me, env: limited });
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers['retry-after']) >= 1, 'carries Retry-After seconds');
  // …and another client is unaffected.
  const other = await renderGet('/tool/qr-code.svg', 'url=https%3A%2F%2Fsuse.com', { ip: ip(), env: limited });
  assert.equal(other.status, 200);
});

// ── gateway routing ──────────────────────────────────────────────────────────

interface FakeRes { status: number; headers: Record<string, string>; body: Buffer | undefined }

function drive(url: string, method = 'GET'): Promise<FakeRes> {
  // No MCP secrets in env: proves the render route works OUTSIDE the mcpEnabled gate.
  const handler = createGateway({} as NodeJS.ProcessEnv);
  const req = {
    method, url,
    headers: { host: 'lolly.tools', 'x-forwarded-for': `172.16.0.${++ipSeq}, 10.0.0.1` },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
  return new Promise((resolve, reject) => {
    const out: FakeRes = { status: 0, headers: {}, body: undefined };
    const res = {
      writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.headers = headers ?? {}; return this; },
      end(body?: string | Buffer) { out.body = body === undefined ? undefined : Buffer.from(body); resolve(out); },
    } as unknown as ServerResponse;
    handler(req, res).catch(reject);
  });
}

test('gateway serves GET /tool/<id>.<ext> publicly, with CORS, even with no MCP secrets', async () => {
  const r = await drive('/tool/qr-code.svg?url=https%3A%2F%2Fsuse.com');
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.match(r.headers['content-type']!, /svg/);
  assert.match(r.body!.toString('utf8'), /<svg/);

  // …while everything else on the unconfigured deployment stays a 404.
  const rpc = await drive('/api/mcp', 'POST');
  assert.equal(rpc.status, 404);
});

test('gateway HEAD answers headers only', async () => {
  const r = await drive('/tool/qr-code.svg?url=https%3A%2F%2Fsuse.com', 'HEAD');
  assert.equal(r.status, 200);
  assert.ok(r.headers['etag']);
  assert.equal(r.body, undefined);
});
