// SPDX-License-Identifier: MPL-2.0
/**
 * The render core — the boundary that makes deployment topology a deploy-time
 * choice (plans/mcp-server.md §5). Two tiers, mirroring the engine/shell split:
 *
 *   Tier A (in-process): svg / emf / eps / data+text formats. jsdom + the engine,
 *     via the headless host. No browser.
 *   Tier A+resvg: svg-native tool → PNG, rasterised by @resvg/resvg-js. No browser.
 *   Tier B (headless Chromium): everything else (HTML-layout raster, pdf, video).
 *     Lazy playwright-core; env-gated so the service runs fully without a browser.
 *
 * `transform()` is the file-in → file-out path for on-device utilities
 * (strip-data, compress-pdf): the tool's exportFile hook produces the bytes.
 */

import {
  createRuntime, parseUrlState, expandQuery,
  C2PA_FORMATS, embedC2pa, ENGINE_VERSION,
  parseDimension, toPixels,
} from '@lolly/engine';
import type { ExportFormat, ExportOpts, Profile, InputFile } from '../../../engine/src/bridge/host-v1.ts';
import { readFile } from 'node:fs/promises';
import { loadToolCached } from './catalog.ts';
import { withHost } from './host.ts';
import { FONTS_DIR, BROWSERS_DIR } from './paths.ts';
import { webShellBase, closeWebShell } from './webshell.ts';

export { closeWebShell };

/** Formats the pure engine can produce without a browser engine. */
const TIER_A = new Set(['svg', 'emf', 'eps', 'eps-cmyk', 'html', 'md', 'txt', 'json', 'csv', 'ics', 'vcf']);

export interface RenderOpts {
  format?: string;
  width?: number;
  height?: number;
  unit?: string;
  dpi?: number;
  background?: string;
  colorProfile?: string;
  transparentBg?: boolean;
  convertPaths?: boolean;
  password?: string;
  c2pa?: { on: boolean; days: number | null } | null;
  profile?: Profile;
}

export interface RenderResult {
  bytes: Uint8Array;
  mime: string;
  format: string;
  /** Which render tier produced the bytes: 'A', 'A(resvg)', or 'B'. */
  tier: string;
  warnings: string[];
}

/** Raised for a caller-facing render problem (bad format, browser not configured). */
export class RenderError extends Error {}

export function normFormat(f: string | null | undefined): string {
  const x = String(f ?? '').toLowerCase();
  return x === 'jpeg' ? 'jpg' : x;
}

export function mimeForFormat(fmt: string): string {
  switch (normFormat(fmt)) {
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'apng': return 'image/apng';
    case 'jpg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'avif': return 'image/avif';
    case 'gif': return 'image/gif';
    case 'pdf': case 'pdf-cmyk': return 'application/pdf';
    case 'emf': return 'image/emf';
    case 'eps': case 'eps-cmyk': return 'application/postscript';
    case 'tiff': case 'cmyk-tiff': return 'image/tiff';
    case 'ico': return 'image/x-icon';
    case 'zip': return 'application/zip';
    case 'webm': return 'video/webm';
    case 'mp4': return 'video/mp4';
    case 'html': return 'text/html';
    case 'md': return 'text/markdown';
    case 'txt': return 'text/plain';
    case 'json': return 'application/json';
    case 'csv': return 'text/csv';
    case 'ics': return 'text/calendar';
    case 'vcf': return 'text/vcard';
    default: return 'application/octet-stream';
  }
}

export function isTextFormat(fmt: string): boolean {
  return ['svg', 'html', 'md', 'txt', 'json', 'csv', 'ics', 'vcf', 'eps', 'eps-cmyk'].includes(normFormat(fmt));
}

/** Target pixel width for the resvg raster path, honouring physical units. */
function targetPx(width: number | undefined, unit: string | undefined, dpi: number | undefined): number | undefined {
  if (!width || width <= 0) return undefined;
  if (!unit || unit === 'px') return Math.round(width);
  const dim = parseDimension(`${width}${unit}`);
  return dim ? Math.round(toPixels(dim, dpi ?? 300)) : Math.round(width);
}

/** ExportOpts for runtime.export, mirroring the CLI's unit-qualifier handling. */
function exportOpts(o: RenderOpts): ExportOpts & { password?: string } {
  const unit = o.unit || 'px';
  const qual = (v: number | undefined): string | number | undefined =>
    (typeof v === 'number' && v > 0 ? (unit !== 'px' ? `${v}${unit}` : v) : undefined);
  const opts: ExportOpts & { password?: string } = { width: qual(o.width), height: qual(o.height) };
  if (unit !== 'px') opts.dpi = o.dpi || 300;
  if (o.background) opts.background = o.background;
  if (o.colorProfile) opts.colorProfile = o.colorProfile;
  if (o.password) opts.password = o.password;
  return opts;
}

/** Tier A: hydrate the tool and export via the engine's own path (no browser). */
async function renderTierA(
  toolId: string,
  values: Record<string, unknown>,
  fmt: string,
  opts: ExportOpts,
  profile: Profile,
): Promise<{ bytes: Uint8Array; mime: string }> {
  return withHost(profile, async (dom, host) => {
    const tool = await loadToolCached(toolId);
    const runtime = await createRuntime(tool, host, values as never);
    const canvas = dom.window.document.getElementById('canvas');
    if (!canvas) throw new RenderError('render canvas missing');
    canvas.innerHTML = runtime.getHydrated();
    const blob = await runtime.export(canvas as unknown as Element, fmt as ExportFormat, opts);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, mime: blob.type || mimeForFormat(fmt) };
  });
}

/** Rasterise an SVG string to PNG via resvg. Text renders from catalog fonts. */
async function svgToPng(svg: string, width: number | undefined, background: string | undefined): Promise<Uint8Array> {
  const { Resvg } = await import('@resvg/resvg-js');
  const r = new Resvg(svg, {
    ...(background ? { background } : {}),
    fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
    font: { fontDirs: [FONTS_DIR], loadSystemFonts: true },
  });
  return r.render().asPng();
}

// ── Tier B: headless Chromium (lazy, env-gated, pooled) ──────────────────────

let browserPromise: Promise<import('playwright-core').Browser> | null = null;

async function getBrowser(): Promise<import('playwright-core').Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const channel = process.env.LOLLY_BROWSER_CHANNEL; // e.g. 'chrome'
      const executablePath = process.env.LOLLY_BROWSER_PATH;
      // Resolve Chromium from this package's scoped install (services/mcp/.browsers,
      // via `npm run install:browser`) unless the deployment pins its own browser —
      // an installed OS channel, an explicit binary, or a preset browsers path.
      if (!channel && !executablePath) {
        process.env.PLAYWRIGHT_BROWSERS_PATH ??= BROWSERS_DIR;
      }
      const { chromium } = await import('playwright-core');
      try {
        return await chromium.launch({
          ...(channel ? { channel } : {}),
          ...(executablePath ? { executablePath } : {}),
          args: ['--no-sandbox'],
        });
      } catch (err) {
        const msg = (err as Error).message || '';
        if (/executable doesn't exist|Executable doesn't exist|please run/i.test(msg)) {
          // On a hosted/serverless deployment (no browser by design) the dev "install a
          // browser" advice is noise — steer the caller to the browser-free formats that
          // DO render here. Keep the actionable install hint for local / self-host dev.
          const hosted = !!process.env.VERCEL || process.env.LOLLY_MCP_HOSTED === '1';
          throw new RenderError(
            hosted
              ? `This format needs the browser render tier, which isn't enabled on this hosted ` +
                `endpoint. What renders here: vector formats (svg, eps, emf), the data formats ` +
                `(html, md, json, csv, ics, vcf), and png for SVG-native tools. Try svg — it works ` +
                `for every tool — or png for a simple vector tool (e.g. qr-code).`
              : `Chromium is not installed for the Tier-B render path. Run ` +
                `\`npm run install:browser\` (downloads Chromium into services/mcp/.browsers), ` +
                `or point LOLLY_BROWSER_CHANNEL / LOLLY_BROWSER_PATH at an existing browser.`,
          );
        }
        throw err;
      }
    })().catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  const b = browserPromise;
  browserPromise = null;
  if (b) { try { (await b).close(); } catch { /* ignore */ } }
}

/** Reserved params we set ourselves on the export URL — cleared from the inbound
 *  query first so the caller's opts win. `c2pa` is dropped because render() stamps
 *  Content Credentials AFTER the browser returns (one path for both tiers). */
const EXPORT_URL_RESERVED = ['format', 'export', 'copy', 'width', 'w', 'height', 'h', 'unit', 'dpi', 'password', 'profile', 'c2pa', 'preview', 'options'];

/** Build the `#/tool/<id>?…` URL that makes the web shell auto-export on load. */
function exportUrl(base: string, toolId: string, query: string, fmt: string, o: RenderOpts): string {
  const p = new URLSearchParams(query);
  for (const k of EXPORT_URL_RESERVED) p.delete(k);
  p.set('format', fmt);
  const unit = o.unit || 'px';
  if (o.width && o.width > 0) p.set('width', String(o.width));
  if (o.height && o.height > 0) p.set('height', String(o.height));
  if (unit !== 'px') { p.set('unit', unit); p.set('dpi', String(o.dpi || 300)); }
  // CMYK press condition for pdf-cmyk / cmyk-tiff (the app's `profile` reserved param).
  if (o.colorProfile) p.set('profile', o.colorProfile);
  // Standard-PDF password is applied by the app during export (clear-text in URL by
  // design — same as a share link); strong locks aren't a Tier-B concern here.
  if (o.password && (fmt === 'pdf')) p.set('password', o.password);
  p.set('export', '1'); // presence flag → immediate download on load
  const q = p.toString();
  const tmpl = process.env.LOLLY_TOOL_URL_TEMPLATE || `${base}/#/tool/{id}?{query}`;
  return tmpl.replace('{id}', encodeURIComponent(toolId)).replace('{query}', q);
}

/** How long to wait for the download to arrive. Video records in real time. */
function exportTimeoutMs(fmt: string): number {
  const f = normFormat(fmt);
  if (f === 'webm' || f === 'mp4' || f === 'gif' || f === 'apng') return 180_000;
  if (f === 'pdf' || f === 'pdf-cmyk' || f === 'cmyk-tiff' || f === 'tiff') return 90_000;
  return 60_000;
}

/**
 * Tier B render — the full browser export pipeline (M1). Serves/points at a real
 * Lolly web shell (webShellBase: local built dist, or LOLLY_WEB_BASE), drives the
 * scoped Chromium to the tool with `?…&format=<fmt>&export`, and captures the bytes
 * the app's own export path downloads — so HTML-layout raster, pdf (incl. CMYK +
 * marks), and video all render exactly as a user's Download would. No canvas
 * screenshot: this is the real export, honouring the full param contract.
 */
async function renderTierB(
  toolId: string,
  query: string,
  fmt: string,
  o: RenderOpts,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const base = await webShellBase();
  const url = exportUrl(base, toolId, query, fmt, o);
  let browser: import('playwright-core').Browser;
  try {
    browser = await getBrowser();
  } catch (e) {
    if (e instanceof RenderError) throw e;
    throw new RenderError(`Tier-B browser unavailable: ${(e as Error).message}`);
  }
  const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  try {
    const page = await ctx.newPage();
    const downloadP = page.waitForEvent('download', { timeout: exportTimeoutMs(fmt) });
    // 'commit' returns as soon as navigation starts; the export fires later, after
    // the tool mounts + settles (onInit, fonts). waitForEvent above is the real gate.
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    let download: Awaited<typeof downloadP>;
    try {
      download = await downloadP;
    } catch {
      throw new RenderError(
        `Tool "${toolId}" produced no "${fmt}" export within the time limit — the tool may ` +
        `have failed to render, or the format isn't supported in the browser. Check the inputs.`,
      );
    }
    const path = await download.path();
    if (!path) throw new RenderError(`Tier-B download for "${toolId}" yielded no file.`);
    const bytes = new Uint8Array(await readFile(path));
    await download.delete().catch(() => {});
    return { bytes, mime: mimeForFormat(fmt) };
  } finally {
    await ctx.close();
  }
}

async function stampC2pa(bytes: Uint8Array, fmt: string, toolName: string, toolId: string, o: RenderOpts): Promise<Uint8Array> {
  const days = o.c2pa?.days ?? 30;
  const profile = o.profile ?? {};
  const stamped = await embedC2pa(bytes, fmt as ExportFormat, {
    title: toolName,
    claimGenerator: 'Lolly lolly.tools',
    generatorInfo: { name: 'Lolly', version: ENGINE_VERSION },
    environment: { surface: 'mcp', engine: 'node', os: process.platform, format: fmt, tool: toolId },
    ...(profile.useDetails === true && profile.firstname
      ? { author: { name: [profile.firstname, profile.lastname].filter(Boolean).join(' '), ...(profile.email ? { email: profile.email } : {}) } }
      : {}),
    dates: { notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + days * 86_400_000) },
  });
  return stamped;
}

/**
 * Render a tool to bytes. `query` is a plain (or packed `z=`) URL query — the
 * shared param contract. Explicit opts override anything parsed from the query.
 */
export async function render(toolId: string, query: string, o: RenderOpts = {}): Promise<RenderResult> {
  const tool = await loadToolCached(toolId);
  const formats = (tool.manifest.render.formats ?? []).map(f => f.toLowerCase());
  const supported = new Set<string>();
  for (const f of formats) { supported.add(f); if (f === 'jpeg') supported.add('jpg'); if (f === 'jpg') supported.add('jpeg'); }

  const q = await expandQuery(query);
  const st = parseUrlState(q, tool.manifest);
  const fmt = normFormat(o.format ?? st.format ?? formats[0] ?? 'svg');
  if (!supported.has(fmt)) {
    throw new RenderError(`Tool "${toolId}" does not support format "${fmt}". Supported: ${formats.join(', ')}`);
  }
  // Map jpeg↔jpg to what the engine's ExportFormat expects.
  const exportFmt = fmt === 'jpg' && !formats.includes('jpg') ? 'jpg' : fmt;

  const values: Record<string, unknown> = { ...st.values };
  if (o.transparentBg !== undefined) values['transparentBg'] = o.transparentBg;
  if (o.convertPaths !== undefined) values['convertPaths'] = o.convertPaths;

  const merged: RenderOpts = {
    ...o,
    width: o.width ?? st.width ?? undefined,
    height: o.height ?? st.height ?? undefined,
    unit: o.unit ?? st.unit ?? undefined,
    dpi: o.dpi ?? st.dpi ?? undefined,
    password: o.password ?? st.password ?? undefined,
    c2pa: o.c2pa ?? st.c2pa ?? null,
  };
  const profile = o.profile ?? {};
  const warnings: string[] = [];
  // Open-password is only wired through for standard `pdf` (see exportUrl); the
  // CMYK press path drops it, so the returned PDF would be UNprotected. Say so.
  if (merged.password && exportFmt === 'pdf-cmyk') {
    warnings.push('Password is not applied for pdf-cmyk — the returned PDF is not protected. Use format "pdf" for an open-password.');
  }
  let out: { bytes: Uint8Array; mime: string; tier: string };

  if (TIER_A.has(exportFmt)) {
    const r = await renderTierA(toolId, values, exportFmt, exportOpts(merged), profile);
    out = { ...r, tier: 'A' };
  } else if (exportFmt === 'png' && formats.includes('svg')) {
    // SVG-native fast path: engine SVG → resvg PNG, no browser.
    try {
      const svg = await renderTierA(toolId, values, 'svg', exportOpts({ ...merged, width: undefined, height: undefined, unit: 'px' }), profile);
      const px = targetPx(merged.width, merged.unit, merged.dpi);
      const png = await svgToPng(new TextDecoder().decode(svg.bytes), px, merged.background);
      out = { bytes: png, mime: 'image/png', tier: 'A(resvg)' };
    } catch (e) {
      warnings.push(`SVG→PNG fast path unavailable (${(e as Error).message}); trying the browser tier.`);
      out = { ...(await renderTierB(toolId, q, exportFmt, merged)), tier: 'B' };
    }
  } else {
    out = { ...(await renderTierB(toolId, q, exportFmt, merged)), tier: 'B' };
  }

  let bytes = out.bytes;
  if (merged.c2pa?.on && C2PA_FORMATS.includes(exportFmt as ExportFormat) && !(exportFmt === 'pdf' && merged.password)) {
    try { bytes = await stampC2pa(bytes, exportFmt, tool.manifest.name, toolId, merged); }
    catch (e) { warnings.push(`Content Credentials not attached — ${(e as Error).message}`); }
  } else if (merged.c2pa?.on) {
    warnings.push(`Format "${fmt}" cannot carry Content Credentials — skipped.`);
  }

  return { bytes, mime: out.mime, format: fmt, tier: out.tier, warnings };
}

export interface FileArg {
  base64: string;
  name?: string;
  mime?: string;
}

/** Transform path: file in → file out via a tool's exportFile hook. */
export async function transform(
  toolId: string,
  file: FileArg,
  inputs: Record<string, unknown> = {},
  profile: Profile = {},
): Promise<{ bytes: Uint8Array; filename: string; mime: string }> {
  const tool = await loadToolCached(toolId);
  if (!tool.manifest.hooks?.exportFile) {
    throw new RenderError(`Tool "${toolId}" is not a transform (file-in/file-out) tool.`);
  }
  const { fileInputId } = await import('./schema.ts');
  const inputId = fileInputId(tool.manifest);
  if (!inputId) throw new RenderError(`Tool "${toolId}" declares no file input.`);

  const bytes = Uint8Array.from(Buffer.from(file.base64, 'base64'));
  const fileRef: InputFile = {
    __file: true,
    name: file.name || 'input',
    mime: file.mime || 'application/octet-stream',
    size: bytes.length,
    bytes,
    url: null,
  };
  const values: Record<string, unknown> = { ...inputs, [inputId]: fileRef };

  return withHost(profile, async (_dom, host) => {
    const runtime = await createRuntime(tool, host, values as never);
    const res = await (runtime as unknown as { exportFile: () => Promise<{ bytes: Uint8Array; filename?: string }> }).exportFile();
    const filename = res.filename || `${toolId}-output`;
    const ext = filename.includes('.') ? filename.split('.').pop()! : '';
    return { bytes: res.bytes, filename, mime: mimeForFormat(ext) };
  });
}
