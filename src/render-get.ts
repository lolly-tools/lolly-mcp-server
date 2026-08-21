// SPDX-License-Identifier: MPL-2.0
/**
 * The public GET render endpoint - `GET /tool/<id>.<ext>?<query>`.
 *
 * Answers the exact canonical embed-URL shape `buildEmbedUrl` mints
 * (engine/src/tool-url.ts) with real bytes: a vercel.json rewrite sends
 * `/tool/:id.:ext` to the MCP function and the gateway routes GET/HEAD here. So
 * the embed URLs the Share dialog and `lolly_build_url` already produce become
 * live `<img src>`s in READMEs, wikis and dashboards.
 *
 * Deliberate v1 policy (a design decision, not an implementation detail - see
 * docs/mcp.md and docs/privacy.md, which describe this surface to users):
 *
 *  - PUBLIC and unauthenticated. It renders only public tool + catalog data (the
 *    same bundled tools/ dir the MCP tools read); no accounts, no cookies, no
 *    user state, nothing stored per request.
 *  - Official/community tools only. Anything else (unknown id, experimental
 *    status) gets the SAME 404, so the response never leaks catalog existence
 *    semantics (a 403 would confirm the tool exists).
 *  - Browser-free formats only: TIER_A plus the resvg PNG fast-path for
 *    SVG-native tools (render.ts). Everything else is an honest 400.
 *  - Content Credentials are OFF here, always: a GET render must be
 *    deterministic for its URL so the ETag + CDN cache are honest (C2PA embeds a
 *    fresh signature + timestamp per render, which would make identical URLs
 *    yield different bytes). Time-varying tools simply go stale within s-maxage.
 *  - Every 200 carries `Content-Security-Policy: sandbox`: html/svg output is
 *    tool-authored markup fed by query params and must never execute in the
 *    lolly.tools origin when navigated to directly (as an `<img src>` the header
 *    is moot; this guards direct navigation).
 *  - Rate limiting is a best-effort, per-instance in-memory sliding window per
 *    client IP. Serverless instances share no state, so this is only a backstop.
 *    Real enforcement for a public deployment belongs to platform WAF rules
 *    (e.g. Vercel Firewall), not application code.
 *  - Self-hosters can switch the route off entirely: LOLLY_DISABLE_RENDER_GET=1
 *    makes every /tool/<id>.<ext> URL return 404.
 */

import { createHash } from 'node:crypto';
import { ENGINE_VERSION, expandQuery, parseDimension, toPixels } from '@lolly/engine';
import { loadIndex } from './catalog.ts';
import { TIER_A, render, normFormat, mimeForFormat, isTextFormat, RenderError } from './render.ts';

export interface RenderGetResponse {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array | string;
}

// Same id grammar as engine/src/tool-url.ts ID_RE; the extension is short and
// alphanumeric-with-hyphen (eps-cmyk). Matched as a path SUFFIX so it works
// whether the platform hands us `/tool/x.svg` or `/api/mcp/tool/x.svg`.
const PATH_RE = /\/tool\/([a-z0-9][a-z0-9-]*[a-z0-9])\.([a-z0-9-]{1,12})$/;

/** Recognise a render-GET path. The gateway routes GET/HEAD here when non-null. */
export function matchRenderGetPath(path: string): { toolId: string; ext: string } | null {
  const m = PATH_RE.exec(path);
  return m ? { toolId: m[1]!, ext: m[2]! } : null;
}

// MAX_URL parity with parseEmbedUrl/buildEmbedUrl (engine/src/tool-url.ts): a
// query longer than the longest mintable embed URL is refused outright.
const MAX_QUERY = 4096;
// Sane output bound - caps the resvg raster allocation (physical units convert
// to pixels at `dpi` before the check, so 10000mm can't sneak in a huge raster).
const MAX_EDGE_PX = 10_000;
const MAX_DPI = 1200;

// ── best-effort rate limit (per instance, per client IP) ────────────────────
const RL_WINDOW_MS = 60_000;
const RL_MAX_IPS = 10_000; // bound the map; oldest-inserted evicted beyond this
const rlHits = new Map<string, number[]>();

function rateLimit(ip: string, limit: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  let hits = rlHits.get(ip);
  if (!hits) {
    if (rlHits.size >= RL_MAX_IPS) {
      const oldest = rlHits.keys().next().value;
      if (oldest !== undefined) rlHits.delete(oldest);
    }
    hits = [];
    rlHits.set(ip, hits);
  }
  while (hits.length && hits[0]! <= now - RL_WINDOW_MS) hits.shift();
  if (hits.length >= limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((hits[0]! + RL_WINDOW_MS - now) / 1000)) };
  hits.push(now);
  return { ok: true, retryAfter: 0 };
}

const NO_STORE: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
};

function errorResponse(status: number, error: string, extra: Record<string, string> = {}): RenderGetResponse {
  return { status, headers: { ...NO_STORE, ...extra }, body: JSON.stringify({ error }) };
}

/** width/height/dpi bounds on the (already-expanded) query. Returns an error string or null. */
function dimensionError(params: URLSearchParams): string | null {
  const rawDpi = params.get('dpi');
  const dpi = rawDpi != null ? Number(rawDpi) : 300;
  if (rawDpi != null && (!Number.isFinite(dpi) || dpi <= 0 || dpi > MAX_DPI)) return `dpi must be between 1 and ${MAX_DPI}`;
  const unit = (params.get('unit') || 'px').toLowerCase();
  for (const [name, alias] of [['width', 'w'], ['height', 'h']] as const) {
    const raw = params.get(name) ?? params.get(alias);
    if (raw == null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return `${name} must be a positive number`;
    let px = n;
    if (unit !== 'px') {
      const dim = parseDimension(`${n}${unit}`);
      if (dim) px = toPixels(dim, dpi);
    }
    if (px > MAX_EDGE_PX) return `${name} exceeds the ${MAX_EDGE_PX}px output cap`;
  }
  return null;
}

/** True when `ifNoneMatch` (a comma-separated header value) contains `etag`. */
function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(',').some(t => t.trim().replace(/^W\//, '') === etag);
}

export interface RenderGetOpts {
  /** First-hop client IP (x-forwarded-for), for the best-effort rate limit. */
  ip: string;
  ifNoneMatch?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Handle `GET /tool/<id>.<ext>?<query>`. `path` is the URL pathname, `query` the
 * raw query string (no leading '?'). Pure of the transport: the gateway writes
 * the returned status/headers/body (dropping the body for HEAD).
 */
export async function renderGet(path: string, query: string, opts: RenderGetOpts): Promise<RenderGetResponse> {
  const env = opts.env ?? process.env;
  if (env.LOLLY_DISABLE_RENDER_GET === '1') return errorResponse(404, 'not_found');

  const match = matchRenderGetPath(path);
  if (!match) return errorResponse(404, 'not_found');

  const fmt = normFormat(match.ext); // FORMAT_EXT parity: 'jpeg' collapses to 'jpg'
  const pngRequested = fmt === 'png';
  if (!TIER_A.has(fmt) && !pngRequested) {
    return errorResponse(400, `Format "${fmt}" needs the browser render tier, which this public endpoint does not run. ` +
      `Available here: ${[...TIER_A].join(', ')} - plus png for SVG-native tools.`);
  }

  if (query.length > MAX_QUERY) return errorResponse(400, `Query too long (max ${MAX_QUERY} characters).`);

  // Same load-boundary expansion as the app/CLI: packed z= links work here too.
  const expanded = await expandQuery(query);
  const params = new URLSearchParams(expanded);
  const dimErr = dimensionError(params);
  if (dimErr) return errorResponse(400, dimErr);

  // Existence + status from the generated catalog index (cheap; no tool files
  // touched for garbage ids). Non-official/community is the SAME 404 as unknown.
  const index = await loadIndex();
  const entry = index.tools.find(t => t.id === match.toolId);
  if (!entry || (entry.status !== 'official' && entry.status !== 'community')) {
    return errorResponse(404, 'not_found');
  }
  const formats = (entry.formats ?? []).map(f => f.toLowerCase());
  if (pngRequested && !formats.includes('svg')) {
    return errorResponse(400, 'png is only served for SVG-native tools on this endpoint - request svg, or use the app for full raster.');
  }

  // Renders are deterministic for their URL (c2pa forced off below), so a strong
  // ETag over (engine + catalog build + canonical URL) is honest. Catalog or
  // engine updates roll every ETag - over-invalidation, never staleness.
  const etag = `"${createHash('sha256')
    .update(`${ENGINE_VERSION}|${index.version}|${index.generatedAt}|${match.toolId}.${fmt}?${expanded}`)
    .digest('hex').slice(0, 32)}"`;
  const cacheHeaders: Record<string, string> = {
    'cache-control': 'public, s-maxage=86400, stale-while-revalidate=604800',
    etag,
    'x-robots-tag': 'noindex',
  };
  if (etagMatches(opts.ifNoneMatch, etag)) return { status: 304, headers: cacheHeaders };

  // Rate-limit actual renders only (304s and refusals above cost ~nothing).
  const limit = Number(env.LOLLY_RENDER_GET_RPM) > 0 ? Number(env.LOLLY_RENDER_GET_RPM) : 60;
  const rl = rateLimit(opts.ip || 'unknown', limit);
  if (!rl.ok) return errorResponse(429, 'Too many renders from this address - slow down.', { 'retry-after': String(rl.retryAfter) });

  let result;
  try {
    // c2pa OFF (never from the query): see the module comment - determinism is
    // what makes the ETag + CDN cache correct. format comes from the path
    // extension, which is authoritative over any `format=` query param.
    // noBrowser keeps the "browser-free formats only" policy honest: without it a
    // fast-path failure would silently fall through to a full Chromium render on
    // deployments that configured a browser for the AUTHENTICATED MCP tools.
    result = await render(match.toolId, expanded, { format: fmt, c2pa: { on: false, days: null }, noBrowser: true });
  } catch (e) {
    if (e instanceof RenderError) return errorResponse(400, e.message);
    return errorResponse(500, `Render failed: ${(e as Error).message}`);
  }

  const mime = result.mime || mimeForFormat(fmt);
  return {
    status: 200,
    headers: {
      ...cacheHeaders,
      'content-type': isTextFormat(fmt) && !mime.includes('charset') ? `${mime}; charset=utf-8` : mime,
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="${match.toolId}.${fmt}"`,
    },
    body: result.bytes,
  };
}
