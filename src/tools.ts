// SPDX-License-Identifier: MPL-2.0
/**
 * The MCP meta-tools: list / describe / build_url / render / transform / verify —
 * plus the catalog-derived prompts (server.ts prompts/*).
 *
 * A small fixed surface (compact — scales to the whole catalog without flooding
 * a client's tool picker); per-tool input schemas are returned as data by
 * describe_tool. See plans/mcp-server.md §3.
 */

import { buildInputModel, serializeUrlState, buildEmbedUrl, ENGINE_VERSION, verifyC2pa, c2paTrustAnchors, extractFileMetadata } from '@lolly/engine';
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

const FILE_ARG = {
  type: 'object',
  description: 'The input file.',
  properties: {
    base64: { type: 'string', description: 'File bytes, base64-encoded.' },
    name: { type: 'string', description: 'Original filename, e.g. photo.jpg.' },
    mime: { type: 'string', description: 'MIME type, e.g. image/jpeg.' },
  },
  required: ['base64'],
  additionalProperties: false,
};

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
        file: FILE_ARG,
        inputs: RENDER_ARGS.inputs,
      },
      required: ['toolId', 'file'],
      additionalProperties: false,
    },
  },
  {
    name: 'lolly_verify',
    description: "Verify a file's Content Credentials (C2PA) on-device: was it genuinely made with Lolly, who signed it, and has it changed since export. Returns the verdict, signer identity, edit history, and embedded file metadata (EXIF/XMP) as text + JSON. Bytes in, verdict out — nothing leaves the server.",
    inputSchema: {
      type: 'object',
      properties: { file: FILE_ARG },
      required: ['file'],
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

type ExampleVariant = { label?: string; theme?: string; values?: Record<string, unknown> };

/** Example looks for a tool: top-level `examples`, else the deprecated `featured.variants` alias. */
function exampleLooks(m: ToolManifest, cap: number): { label?: string; inputs?: Record<string, unknown> }[] {
  const t = m as ToolManifest & { examples?: ExampleVariant[]; featured?: { variants?: ExampleVariant[] } };
  const ex = t.examples?.length ? t.examples : (t.featured?.variants ?? []);
  return ex.slice(0, cap).map(v => ({ ...(v.label ? { label: v.label } : {}), inputs: v.values }));
}

// Every claim/signer string is attacker-controlled bytes from the file being checked.
// Strip control characters so a crafted manifest can't smuggle escape sequences into
// the agent-facing report (same hygiene as shells/cli/src/validate.ts).
const clean = (v: unknown) => String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

type VerifyReport = Awaited<ReturnType<typeof verifyC2pa>>;

/** The CLI's `lolly validate` verdict ladder (shells/cli/src/validate.ts), as a slug + headline. */
function verifyVerdict(report: VerifyReport): { verdict: string; headline: string } {
  const fails = report.checks.filter(c => !c.ok && c.code !== 'signingCredential.untrusted');
  const expiredOnly = fails.length === 1 && fails[0]!.code === 'signingCredential.expired';
  if (report.madeWithLolly) return { verdict: 'made-with-lolly', headline: 'Made with Lolly — credential intact, file unchanged since export' };
  if (report.delivered && report.trusted) return { verdict: 'delivered-by-lolly', headline: 'Delivered by Lolly — verified authentic official asset; delivered by Lolly, not created by it' };
  if (report.likelyMadeWithLolly) return { verdict: 'likely-made-with-lolly', headline: "Likely made with Lolly — the credential's own content checks out and records a Lolly export, but this file's bytes no longer match it" };
  if (expiredOnly) return { verdict: 'credential-expired', headline: 'Credential expired — the file still matches what was signed; the one-year on-device certificate has lapsed' };
  if (report.state === 'valid') return { verdict: 'credential-intact', headline: 'Credential intact — signed on-device (integrity, not identity)' };
  if (report.state === 'invalid') return { verdict: 'credential-broken', headline: 'Credential broken — the file no longer matches what was signed' };
  return { verdict: 'no-credential', headline: 'No Content Credentials found' };
}

/** Human-readable verify report — the same facts `lolly validate` prints. */
function verifyText(name: string, report: VerifyReport, headline: string): string {
  const lines = [`${name}${report.format ? `  [${report.format}]` : ''}`, headline];
  if (report.reason && report.state !== 'invalid') lines.push(`  ${clean(report.reason)}`);
  if (report.claim && !report.madeWithLolly) {
    lines.push(report.trusted
      ? "  (fields below are the CA-verified signer's own claim)"
      : '  (fields below are self-asserted by whoever signed the file)');
  }
  if (report.claim) {
    const c = report.claim;
    const s: Partial<NonNullable<VerifyReport['signer']>> = report.signer || {};
    const env: Record<string, string | number | boolean> = report.environment || {};
    const signedAt = c.actions?.find(a => a.when)?.when;
    const generator = c.generatorInfo?.name
      ? `${c.generatorInfo.name}${c.generatorInfo.version ? ' ' + c.generatorInfo.version : ''}`
      : c.claimGenerator;
    const id = report.signer?.identity;
    const facts: Array<[string, unknown]> = [
      ['Title', c.title],
      ['Identity', report.trusted && id
        && `${id.email || s.commonName}${id.issuer ? ` — verified by ${id.issuer}` : ''}`],
      ['Tool', env.tool],
      ['Produced by', report.author && `${report.author.name}${report.author.email ? ` <${report.author.email}>` : ''}`],
      [report.delivered ? 'Delivered by' : 'Made with', generator],
      ['Signed', signedAt],
      ['Where', [env.surface, env.engine, env.os].filter(Boolean).join(' · ')],
      ['Signer', s.commonName], ['Issuer', s.organization && `${s.organization}${s.selfSigned ? ' (self-signed)' : ''}`],
      ['Algorithm', s.alg], ['Manifest', c.manifestLabel],
    ];
    for (const [k, v] of facts) if (v) lines.push(`  ${k.padEnd(11)} ${clean(v)}`);
  }
  const history = report.history ?? [];
  if (history.length) {
    lines.push('Edit history (incl. ingredient/parent manifests):');
    for (const h of history) {
      const who = h.softwareAgent || h.generator;
      lines.push(`  – ${clean(h.action)}${h.when ? ` @ ${clean(h.when)}` : ''}${who ? ` (${clean(who)})` : ''}${h.description ? ` — ${clean(h.description)}` : ''}`);
    }
  }
  for (const chk of report.checks) {
    const mark = chk.ok ? '✓' : chk.code === 'signingCredential.untrusted' ? 'ℹ' : '✕';
    lines.push(`  ${mark} ${clean(chk.code)} — ${clean(chk.explanation)}`);
  }
  return lines.join('\n');
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
        const examples = exampleLooks(m, 2);
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

      case 'lolly_verify': {
        const file = args['file'] as { base64?: string; name?: string; mime?: string } | undefined;
        if (!file?.base64) return errorResult('file.base64 is required.');
        const bytes = Uint8Array.from(Buffer.from(file.base64, 'base64'));
        // The vendored C2PA trust list, so recognised signers read as trusted here
        // exactly as they do in `lolly validate` and the web /valid view.
        const report = await verifyC2pa(bytes, { trustAnchors: [...c2paTrustAnchors()] });
        let metadata: ReturnType<typeof extractFileMetadata> | null = null;
        try { metadata = extractFileMetadata(bytes); } catch { /* best-effort — the verdict stands alone */ }
        const { verdict, headline } = verifyVerdict(report);
        return {
          content: [
            { type: 'text', text: verifyText(file.name ?? 'file', report, headline) },
            { type: 'text', text: JSON.stringify({ verdict, report, metadata }, null, 2) },
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
    `Use lolly_build_url for a shareable/editable link without rendering, lolly_transform for on-device file utilities, ` +
    `and lolly_verify to check a file's Content Credentials (C2PA). ` +
    `Brand assets, tokens, and tool docs are available as resources (lolly://catalog, lolly://assets, lolly://tool/{id}, ` +
    `lolly://tool/{id}/preview, lolly://asset/{id}, lolly://tokens).`
  );
}

// ── Prompts — catalog-derived guided invocations (server.ts prompts/*) ────────
// One prompt per featured tool plus a generic guided workflow, all derived from
// the live catalog at request time (no hardcoded tool lists — new tools get
// prompts for free when they're featured).

export interface McpPromptArg { name: string; description?: string; required?: boolean }
export interface McpPromptDef { name: string; description?: string; arguments?: McpPromptArg[] }
export interface McpPromptMessage { role: 'user' | 'assistant'; content: ContentBlock }
export interface McpPromptResult { description?: string; messages: McpPromptMessage[] }

const GENERIC_PROMPT = 'create-branded-asset';

const GENERIC_PROMPT_DEF: McpPromptDef = {
  name: GENERIC_PROMPT,
  description: 'Guided workflow: turn a plain-language brief into an on-brand asset with the right Lolly tool.',
  arguments: [
    { name: 'brief', description: 'What to make, in plain language (content, audience, occasion).', required: true },
    { name: 'format', description: 'Preferred output format (e.g. svg, png, pdf).' },
  ],
};

async function toolPromptDef(toolId: string): Promise<McpPromptDef> {
  const { manifest: m } = await loadToolCached(toolId);
  const schema = toolInputSchema(m);
  const props = (schema['properties'] ?? {}) as Record<string, { description?: string }>;
  const required = new Set((schema['required'] as string[] | undefined) ?? []);
  // Required inputs first (stable within groups), capped so the prompt stays a
  // small form — the message itself points at lolly_describe_tool for the rest.
  const ids = Object.keys(props).sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  const promptArgs: McpPromptArg[] = ids.slice(0, 10).map(pid => ({
    name: pid,
    ...(props[pid]?.description ? { description: props[pid]!.description } : {}),
    ...(required.has(pid) ? { required: true } : {}),
  }));
  const featured = (m as { featured?: { blurb?: string } }).featured;
  return {
    name: m.id,
    description: featured?.blurb || m.description || m.name,
    ...(promptArgs.length ? { arguments: promptArgs } : {}),
  };
}

export async function listPrompts(): Promise<McpPromptDef[]> {
  const { tools } = await loadIndex();
  const prompts: McpPromptDef[] = [GENERIC_PROMPT_DEF];
  for (const t of tools.filter(t => t.featured)) {
    // A featured tool whose manifest fails to load just drops out of the list.
    const def = await toolPromptDef(t.id).catch(() => null);
    if (def) prompts.push(def);
  }
  return prompts;
}

/** Resolve one prompt to its messages. Returns null for an unknown name. */
export async function getPrompt(name: string, args: Record<string, string> = {}): Promise<McpPromptResult | null> {
  if (name === GENERIC_PROMPT) {
    const { tools } = await loadIndex();
    const listing = tools.map(t => `• ${t.id} — ${t.name}${t.description ? `: ${t.description}` : ''}`).join('\n');
    const head = [
      "You are creating an on-brand asset with Lolly (the brand's constraint-first asset generator).",
      args['brief'] ? `Brief: ${args['brief']}` : 'No brief was provided — ask the user what they need first.',
      ...(args['format'] ? [`Preferred format: ${args['format']}`] : []),
    ].join('\n');
    const text =
      `${head}\n\nWorkflow:\n` +
      '1. Pick the best-fitting tool from the catalog below (or call lolly_list_tools to search).\n' +
      '2. Call lolly_describe_tool with its toolId for the exact input schema and examples.\n' +
      '3. Call lolly_render with the toolId, your inputs, and a supported format.\n' +
      '4. Share the returned editable lolly.tools link so the user can fine-tune the result.\n\n' +
      `Catalog:\n${listing}`;
    return { description: GENERIC_PROMPT_DEF.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
  }

  if (!TOOL_ID_RE.test(name)) return null;
  const tool = await loadToolCached(name).catch(() => null);
  if (!tool) return null;
  // Only featured tools are LISTED, but any valid tool id resolves — so a client's
  // pinned prompt keeps working if curation changes.
  const m = tool.manifest;
  const looks = exampleLooks(m, 3);
  const given = Object.entries(args).filter(([, v]) => v !== undefined && v !== '');
  const text = [
    `Create an on-brand asset with the Lolly tool "${m.id}" (${m.name}).`,
    ...(m.description ? [m.description] : []),
    '',
    'Steps:',
    `1. Call lolly_describe_tool with toolId "${m.id}" for the exact input JSON Schema.`,
    `2. Choose inputs${looks.length ? " — example looks that show the tool's range:" : '.'}`,
    ...(looks.length ? [JSON.stringify(looks, null, 2)] : []),
    `3. Call lolly_render with toolId "${m.id}" and a format from: ${m.render.formats.join(', ')}.`,
    ...(given.length ? ['', 'User-provided inputs to honour:', JSON.stringify(Object.fromEntries(given), null, 2)] : []),
  ].join('\n');
  const featured = (m as { featured?: { blurb?: string } }).featured;
  return {
    description: featured?.blurb || m.description || m.name,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}
