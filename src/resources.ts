// SPDX-License-Identifier: MPL-2.0
/**
 * MCP resources — read-only brand context so an agent can be on-brand instead of
 * guessing: the catalog, per-tool docs, brand assets, and design tokens.
 * See plans/mcp-server.md §3.2.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTokenSet } from '@lolly/engine';
import { ASSET_INDEX, REPO_ROOT } from './paths.ts';
import { loadIndex, loadToolCached } from './catalog.ts';
import { toolInputSchema } from './schema.ts';
import { withHost } from './host.ts';

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export const RESOURCES = [
  { uri: 'lolly://catalog', name: 'Tool catalog', description: 'The full generated Lolly tool index.', mimeType: 'application/json' },
  { uri: 'lolly://tokens', name: 'Brand design tokens', description: 'On-brand colour swatches (DTCG) with names and CMYK.', mimeType: 'application/json' },
];

export const RESOURCE_TEMPLATES = [
  { uriTemplate: 'lolly://tool/{id}', name: 'Tool details', description: 'A tool manifest summary + input JSON Schema + examples.', mimeType: 'application/json' },
  { uriTemplate: 'lolly://asset/{id}', name: 'Brand asset', description: 'A catalog asset (logo, palette, font) resolved to bytes.', mimeType: 'application/octet-stream' },
];

interface AssetIndex {
  assets: { id: string; type: string; name?: string; tags?: string[]; formats: { format: string; url: string }[] }[];
}

async function tokensResource(uri: string): Promise<ResourceContent> {
  const idx = JSON.parse(await readFile(ASSET_INDEX, 'utf8')) as AssetIndex;
  const tokenAsset = idx.assets.find(a => a.type === 'tokens');
  if (!tokenAsset) return { uri, mimeType: 'application/json', text: JSON.stringify({ colors: [], note: 'No tokens asset in catalog.' }) };
  const doc = JSON.parse(await readFile(join(REPO_ROOT, tokenAsset.formats[0]!.url.replace(/^\//, '')), 'utf8'));
  const set = createTokenSet(doc);
  return { uri, mimeType: 'application/json', text: JSON.stringify({ colors: set.colors() }, null, 2) };
}

function parseDataUrl(url: string): { mime: string; base64: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  return { mime: m[1] || 'application/octet-stream', base64: m[2] ? m[3]! : Buffer.from(decodeURIComponent(m[3]!)).toString('base64') };
}

async function assetResource(uri: string, id: string): Promise<ResourceContent> {
  return withHost({}, async (_dom, host) => {
    const ref = await host.assets.get(id);
    const parsed = parseDataUrl(ref.url);
    if (!parsed) return { uri, mimeType: 'application/json', text: JSON.stringify({ id: ref.id, type: ref.type, format: ref.format, meta: ref.meta }) };
    if (parsed.mime.startsWith('image/svg') || parsed.mime.startsWith('text/') || parsed.mime === 'application/json') {
      return { uri, mimeType: parsed.mime, text: Buffer.from(parsed.base64, 'base64').toString('utf8') };
    }
    return { uri, mimeType: parsed.mime, blob: parsed.base64 };
  });
}

export async function readResource(uri: string): Promise<ResourceContent> {
  if (uri === 'lolly://catalog') {
    const idx = await loadIndex();
    return { uri, mimeType: 'application/json', text: JSON.stringify(idx, null, 2) };
  }
  if (uri === 'lolly://tokens') return tokensResource(uri);

  const toolMatch = /^lolly:\/\/tool\/([a-z0-9-]+)$/.exec(uri);
  if (toolMatch) {
    const tool = await loadToolCached(toolMatch[1]!).catch(() => null);
    if (!tool) throw new Error(`Tool not found: ${toolMatch[1]}`);
    const m = tool.manifest;
    return {
      uri, mimeType: 'application/json',
      text: JSON.stringify({ id: m.id, name: m.name, description: m.description, status: m.status, formats: m.render.formats, width: m.render.width, height: m.render.height, inputSchema: toolInputSchema(m) }, null, 2),
    };
  }

  const assetMatch = /^lolly:\/\/asset\/(.+)$/.exec(uri);
  if (assetMatch) return assetResource(uri, decodeURIComponent(assetMatch[1]!));

  throw new Error(`Unknown resource: ${uri}`);
}
