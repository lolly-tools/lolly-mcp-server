// SPDX-License-Identifier: MPL-2.0
/**
 * Catalog access: the generated tool index (cheap, for list_tools) and the
 * per-tool manifest (loaded via the engine's loadTool, for describe/render).
 *
 * The index carries enough to list tools (id/name/formats/dims/status/…) but
 * NOT input specs — those live only in each tool.json, so describe/render call
 * loadToolCached(). See plans/77-mcp-server.md §7.
 */

import { readFile } from 'node:fs/promises';
import { loadTool } from '@lolly/engine';
import { CATALOG_INDEX, fetchToolFile } from './paths.ts';

export interface CatalogEntry {
  id: string;
  name: string;
  description?: string;
  version: string;
  status: string;
  category?: string;
  capabilities?: string[];
  privacy?: string;
  formats: string[];
  width?: number;
  height?: number;
  unit?: string;
  exportable?: boolean;
  icon?: string;
  preview?: string;
  personalized?: boolean;
  featured?: unknown;
}

export interface CatalogIndex {
  version: string;
  generatedAt: string;
  tools: CatalogEntry[];
}

export type LoadedTool = Awaited<ReturnType<typeof loadTool>>;

let indexCache: Promise<CatalogIndex> | null = null;

/** The generated tool registry. Cached for the process (tools are static in prod). */
export function loadIndex(): Promise<CatalogIndex> {
  return (indexCache ??= readFile(CATALOG_INDEX, 'utf8').then(s => JSON.parse(s) as CatalogIndex));
}

const toolCache = new Map<string, Promise<LoadedTool>>();

/** Load + validate a tool's manifest/template/hooks, cached by id. */
export function loadToolCached(id: string): Promise<LoadedTool> {
  let p = toolCache.get(id);
  if (!p) {
    p = loadTool(id, fetchToolFile);
    toolCache.set(id, p);
    p.catch(() => toolCache.delete(id)); // don't cache failures
  }
  return p;
}

export interface ListFilter {
  q?: string;
  status?: string;
  category?: string;
  format?: string;
  capability?: string;
}

/** Filter the catalog for list_tools. All filters AND together. */
export async function listTools(filter: ListFilter = {}): Promise<CatalogEntry[]> {
  const { tools } = await loadIndex();
  const q = filter.q?.trim().toLowerCase();
  return tools.filter(t => {
    if (filter.status && t.status !== filter.status) return false;
    if (filter.category && t.category !== filter.category) return false;
    if (filter.format && !(t.formats ?? []).map(f => f.toLowerCase()).includes(filter.format.toLowerCase())) return false;
    if (filter.capability && !(t.capabilities ?? []).includes(filter.capability)) return false;
    if (q) {
      const hay = `${t.id} ${t.name} ${t.description ?? ''} ${t.category ?? ''} ${(t.formats ?? []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
