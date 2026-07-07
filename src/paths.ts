// SPDX-License-Identifier: MPL-2.0
/**
 * Filesystem anchors for the MCP server.
 *
 * The server reads tool source (tools/<id>/) and the generated catalog from the
 * monorepo, exactly as the CLI does — REPO_ROOT is resolved relative to this
 * file. When this package is split into its own repo (see plans/mcp-server.md),
 * only these constants + how tool files are fetched need to change: point
 * fetchToolFile at a vendored snapshot or a remote catalog sync.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root holding tools/ + catalog/. In the monorepo this is three
// levels up from this file. In a bundled serverless function (Vercel) the source
// layout is gone but the data dirs are preserved under the task cwd via
// vercel.json `includeFiles`, so fall back to process.cwd(). LOLLY_ROOT overrides
// both (useful in containers where the data lives at a fixed path).
function resolveRoot(): string {
  const marker = (root: string): boolean => existsSync(join(root, 'catalog', 'tools', 'index.json'));
  if (process.env.LOLLY_ROOT && marker(process.env.LOLLY_ROOT)) return process.env.LOLLY_ROOT;
  const rel = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  if (marker(rel)) return rel;
  if (marker(process.cwd())) return process.cwd();
  return process.env.LOLLY_ROOT || rel;
}

export const REPO_ROOT = resolveRoot();
export const TOOLS_DIR = join(REPO_ROOT, 'tools');
export const CATALOG_INDEX = join(REPO_ROOT, 'catalog', 'tools', 'index.json');
export const ASSET_INDEX = join(REPO_ROOT, 'catalog', 'assets', 'index.json');
export const FONTS_DIR = join(REPO_ROOT, 'catalog', 'fonts');

// Scoped Chromium install for the Tier-B (headless-browser) render path. Anchored
// to THIS package's root — not the monorepo — so it travels with the repo split
// (plans/mcp-server.md). `npm run install:browser` downloads Chromium here; the
// installer and render.ts point PLAYWRIGHT_BROWSERS_PATH at it. An explicit
// PLAYWRIGHT_BROWSERS_PATH (container system cache, prebuilt image) always wins.
export const BROWSERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.browsers');

/** The `fetchFile` loadTool() expects: resolve a tool-relative path to its text. */
export function fetchToolFile(path: string): Promise<string> {
  return readFile(join(TOOLS_DIR, path), 'utf8');
}
