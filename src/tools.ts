// SPDX-License-Identifier: MPL-2.0
/**
 * The MCP meta-tools: list / describe / build_url / render / transform.
 *
 * A small fixed surface (compact — scales to the whole catalog without flooding
 * a client's tool picker); per-tool input schemas are returned as data by
 * describe_tool. See plans/mcp-server.md §3.
 */

import { buildInputModel, serializeUrlState, buildEmbedUrl, ENGINE_VERSION } from '@lolly/engine';
import type { ToolManifest } from '../../../engine/src/loader.ts';
import type { ContentBlock, ToolCallResult } from './protocol.ts';
import { listTools, loadToolCached, loadIndex } from './catalog.ts';
import { toolInputSchema } from './schema.ts';
import { render, transform, mimeForFormat, isTextFormat, normFormat } from './render.ts';
import type { RenderOpts } from './render.ts';

const WEB_BASE = (process.env.LOLLY_WEB_BASE || 'https://lolly.tools').replace(/\/$/, '');

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const RENDER_ARGS = {
  toolId: { type: 'string', description: 'The tool id (from lolly_list_tools).' },
  inputs: { type: 'object', description: "The tool's inputs. Get the exact schema from lolly_describe_tool.", additionalProperties: true },
  format: { type: 'string', description: 'Output format (must be one the tool supports). Defaults to the first declared format.' },
  width: { type: 'number', description: 'Output width, in `unit`.' },
  height: { type: 'number', description: 'Output height, in `unit`.' },
  unit: { type: 'string', enum: ['px', 'mm', 'cm', 'in', 'pt'], description: 'Unit for width/height (default px).' },
  dpi: { type: 'number', description: 'Raster DPI for physical units (default 300).' },
};

export const TOOL_DEFS: McpToolDef[] = [
  {
    name: 'lolly_list_tools',
    description: 'List Lolly tools in the on-brand catalog. Filter by free-text q, status, category, format, or capability.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Free-text search over id/name/description.' },
        status: { type: 'string', enum: ['official', 'community', 'experimental'] },
        category: { type: 'string' },
        format: { type: 'string', description: 'Only tools that can output this format.' },
        capability: { type: 'string', description: 'Only tools requiring this capability.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'lolly_describe_tool',
    description: "Get one tool's full input JSON Schema, supported formats, canvas size, status, and example invocations.",
    inputSchema: {
      type: 'object',
      properties: { toolId: RENDER_ARGS.toolId },
      required: ['toolId'],
      additionalProperties: false,
    },
  },
  {
    name: 'lolly_build_url',
    description: 'Build a shareable, editable lolly.tools link (and a raw render URL) for a tool + inputs, without rendering.',
    inputSchema: {
      type: 'object',
      properties: { toolId: RENDER_ARGS.toolId, inputs: RENDER_ARGS.inputs, format: RENDER_ARGS.format, width: RENDER_ARGS.width, height: RENDER_ARGS.height, unit: RENDER_ARGS.unit, dpi: RENDER_ARGS.dpi },
      required: ['toolId'],
      additionalProperties: false,
    },
  },
  {
    name: 'lolly_render',
    description: 'Render a Lolly tool to an on-brand asset (PNG/SVG/PDF/…). Returns the image plus an editable lolly.tools link.',
    inputSchema: {
      type: 'object',
      properties: {
        ...RENDER_ARGS,
        transparentBg: { type: 'boolean', description: 'Remove the background fill (alpha formats).' },
        convertPaths: { type: 'boolean', description: 'Outline text to vector paths in SVG/PDF (default on).' },
        background: { type: 'string', description: 'Override background colour.' },
        colorProfile: { type: 'string', description: "srgb | none | a CMYK press condition (e.g. 'fogra39')." },
        c2pa: { type: 'string', enum: ['off', '7', '30', '90', '365'], description: 'Stamp Content Credentials with the given cert lifetime (days).' },
        password: { type: 'string', description: 'Open-password for standard PDF export (never logged).' },
        link: { type: 'boolean', description: 'Also return the editable lolly.tools link (default true).' },
      },
      required: ['toolId'],
      additionalProperties: false,
    },
  },
  {
    name: 'lolly_transform',
    description: 'Run an on-device file utility (e.g. strip-data, compress-pdf) on a file you provide. Returns the transformed file. Never watermarked.',
    inputSchema: {
      type: 'object',
      properties: {
        toolId: RENDER_ARGS.toolId,
        file: {
          type: 'object',
          description: 'The input file.',
          properties: {
            base64: { type: 'string', description: 'File bytes, base64-encoded.' },
            name: { type: 'string', description: 'Original filename, e.g. photo.jpg.' },
            mime: { type: 'string', description: 'MIME type, e.g. image/jpeg.' },
          },
          required: ['base64'],
          additionalProperties: false,
        },
        inputs: RENDER_ARGS.inputs,
      },
      required: ['toolId', 'file'],
      additionalProperties: false,
    },
  },
];

/** Tool ids are `[a-z0-9-]` slugs (matches resources.ts); reject anything else so
 *  a crafted id can't escape TOOLS_DIR via `..` (existence-probe / path leak). */
const TOOL_ID_RE = /^[a-z0-9-]+$/;

function textOnly(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): ToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Build the shareable query + URLs for a tool + inputs. */
function buildLinks(manifest: ToolManifest, inputs: Record<string, unknown>, o: { format?: string; width?: number; height?: number; unit?: string; dpi?: number }): { query: string; editUrl: string; renderUrl: string | null } {
  const model = buildInputModel(manifest, { initial: inputs as never });
  const query = serializeUrlState(model, {
    format: o.format ?? null,
    width: o.width ?? null,
    height: o.height ?? null,
    unit: o.unit ?? null,
    dpi: o.dpi ?? null,
  });
  const editUrl = query ? `${WEB_BASE}/#/tool/${manifest.id}?${query}` : `${WEB_BASE}/#/tool/${manifest.id}`;
  const renderUrl = buildEmbedUrl({ toolId: manifest.id, format: o.format ?? manifest.render.formats[0], query });
  return { query, editUrl, renderUrl };
}

function c2paSetting(v: unknown): RenderOpts['c2pa'] {
  if (v === undefined || v === null) return null;
  const s = String(v).toLowerCase();
  if (s === 'off') return { on: false, days: null };
  const n = Number(s);
  return { on: true, days: [7, 30, 90, 365].includes(n) ? n : null };
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    switch (name) {
      case 'lolly_list_tools': {
        const tools = await listTools(args as never);
        const lines = tools.map(t => `• ${t.id} — ${t.name} [${t.status}] · formats: ${(t.formats ?? []).join(', ')} · ${t.width}×${t.height}`);
        const summary = `${tools.length} tool(s):\n${lines.join('\n')}`;
        return {
          content: [
            { type: 'text', text: summary },
            { type: 'text', text: JSON.stringify(tools.map(t => ({ id: t.id, name: t.name, description: t.description, status: t.status, formats: t.formats, width: t.width, height: t.height, exportable: t.exportable })), null, 2) },
          ],
        };
      }

      case 'lolly_describe_tool': {
        const toolId = String(args['toolId'] ?? '');
        if (!toolId) return errorResult('toolId is required.');
        if (!TOOL_ID_RE.test(toolId)) return errorResult(`Invalid toolId: ${toolId}. Use lolly_list_tools.`);
        const tool = await loadToolCached(toolId).catch(() => null);
        if (!tool) return errorResult(`Tool not found: ${toolId}. Use lolly_list_tools.`);
        const m = tool.manifest;
        const schema = toolInputSchema(m);
        const featured = (m as { featured?: { variants?: { label?: string; values?: Record<string, unknown> }[] } }).featured;
        const examples = (featured?.variants ?? []).slice(0, 2).map(v => ({ label: v.label, inputs: v.values }));
        const doc = {
          id: m.id, name: m.name, description: m.description, status: m.status, version: m.version,
          formats: m.render.formats, width: m.render.width, height: m.render.height,
          transform: Boolean(m.hooks?.exportFile),
          note: m.status === 'experimental' ? 'Experimental — exports are watermarked.' : undefined,
          inputSchema: schema,
          examples,
        };
        return textOnly(JSON.stringify(doc, null, 2));
      }

      case 'lolly_build_url': {
        const toolId = String(args['toolId'] ?? '');
        if (!toolId) return errorResult('toolId is required.');
        if (!TOOL_ID_RE.test(toolId)) return errorResult(`Invalid toolId: ${toolId}.`);
        const tool = await loadToolCached(toolId).catch(() => null);
        if (!tool) return errorResult(`Tool not found: ${toolId}.`);
        const inputs = (args['inputs'] as Record<string, unknown>) ?? {};
        const links = buildLinks(tool.manifest, inputs, args as never);
        return textOnly(`Editable link:\n${links.editUrl}\n\nRaw render URL:\n${links.renderUrl ?? '(unavailable)'}`);
      }

      case 'lolly_render': {
        const toolId = String(args['toolId'] ?? '');
        if (!toolId) return errorResult('toolId is required.');
        if (!TOOL_ID_RE.test(toolId)) return errorResult(`Invalid toolId: ${toolId}. Use lolly_list_tools.`);
        const tool = await loadToolCached(toolId).catch(() => null);
        if (!tool) return errorResult(`Tool not found: ${toolId}. Use lolly_list_tools.`);
        const inputs = (args['inputs'] as Record<string, unknown>) ?? {};
        const opts: RenderOpts = {
          format: args['format'] as string | undefined,
          width: args['width'] as number | undefined,
          height: args['height'] as number | undefined,
          unit: args['unit'] as string | undefined,
          dpi: args['dpi'] as number | undefined,
          background: args['background'] as string | undefined,
          colorProfile: args['colorProfile'] as string | undefined,
          transparentBg: args['transparentBg'] as boolean | undefined,
          convertPaths: args['convertPaths'] as boolean | undefined,
          password: args['password'] as string | undefined,
          c2pa: c2paSetting(args['c2pa']),
        };
        const links = buildLinks(tool.manifest, inputs, opts);
        const result = await render(toolId, links.query, opts);

        const provenance = [
          tool.manifest.status === 'experimental' ? 'watermarked (experimental tool)' : 'not watermarked',
          result.warnings.length ? `warnings: ${result.warnings.join('; ')}` : '',
        ].filter(Boolean).join(' · ');

        const header = [
          `Rendered ${toolId} → ${result.format} (${result.bytes.length} bytes, tier ${result.tier}).`,
          args['link'] === false ? '' : `Edit: ${links.editUrl}`,
          `Provenance: ${provenance}`,
        ].filter(Boolean).join('\n');

        const content: ContentBlock[] = [{ type: 'text', text: header }];
        const b64 = Buffer.from(result.bytes).toString('base64');
        const fmt = normFormat(result.format);
        const RASTER = ['png', 'jpg', 'webp', 'avif', 'gif', 'apng'];
        if (RASTER.includes(fmt)) {
          content.push({ type: 'image', data: b64, mimeType: result.mime });
        } else if (fmt === 'svg') {
          // SVG: give a viewable PNG preview + the SVG source as a resource.
          try {
            const preview = await render(toolId, links.query, { ...opts, format: 'png' });
            content.push({ type: 'image', data: Buffer.from(preview.bytes).toString('base64'), mimeType: 'image/png' });
          } catch { /* preview is best-effort */ }
          content.push({ type: 'resource', resource: { uri: `${links.renderUrl ?? `lolly://render/${toolId}.svg`}`, mimeType: 'image/svg+xml', text: new TextDecoder().decode(result.bytes) } });
        } else if (isTextFormat(fmt)) {
          content.push({ type: 'resource', resource: { uri: links.renderUrl ?? `lolly://render/${toolId}.${fmt}`, mimeType: result.mime, text: new TextDecoder().decode(result.bytes) } });
        } else {
          content.push({ type: 'resource', resource: { uri: links.renderUrl ?? `lolly://render/${toolId}.${fmt}`, mimeType: result.mime, blob: b64 } });
        }
        return { content };
      }

      case 'lolly_transform': {
        const toolId = String(args['toolId'] ?? '');
        const file = args['file'] as { base64?: string; name?: string; mime?: string } | undefined;
        if (!toolId) return errorResult('toolId is required.');
        if (!TOOL_ID_RE.test(toolId)) return errorResult(`Invalid toolId: ${toolId}. Use lolly_list_tools.`);
        if (!file?.base64) return errorResult('file.base64 is required.');
        const inputs = (args['inputs'] as Record<string, unknown>) ?? {};
        const res = await transform(toolId, { base64: file.base64, name: file.name, mime: file.mime }, inputs);
        return {
          content: [
            { type: 'text', text: `Transformed ${file.name ?? 'file'} → ${res.filename} (${res.bytes.length} bytes). Not watermarked; no provenance added.` },
            { type: 'resource', resource: { uri: `lolly://transform/${res.filename}`, mimeType: res.mime, blob: Buffer.from(res.bytes).toString('base64') } },
          ],
        };
      }

      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return errorResult(`${name} failed: ${(e as Error).message}`);
  }
}

export async function serverInstructions(): Promise<string> {
  const { tools } = await loadIndex();
  return (
    `Lolly MCP server (engine ${ENGINE_VERSION}) — generate on-brand SUSE creative assets. ` +
    `${tools.length} tools available. Workflow: lolly_list_tools → lolly_describe_tool → lolly_render. ` +
    `Use lolly_build_url for a shareable/editable link without rendering, and lolly_transform for on-device file utilities. ` +
    `Brand assets, tokens, and tool docs are available as resources (lolly://catalog, lolly://tool/{id}, lolly://asset/{id}, lolly://tokens).`
  );
}
