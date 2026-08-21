// SPDX-License-Identifier: MPL-2.0
/**
 * Generate a JSON Schema for a tool's `inputs` object from its manifest.
 *
 * We run the engine's buildInputModel first so the schema reflects EXACTLY what
 * the runtime accepts - including the synthetic `transparentBg` / `convertPaths`
 * export toggles the engine injects and resolved defaults. Then map each
 * InputModelItem by type. Keep in lock-step with engine/src/inputs.ts InputType
 * and schemas/tool.schema.json. See plans/77-mcp-server.md section 4.
 */

import { buildInputModel } from '@lolly/engine';
import type { ToolManifest } from '../../../engine/src/loader.ts';
import type { InputModelItem, BlockFieldSpec } from '../../../engine/src/inputs.ts';

export type JsonSchema = Record<string, unknown>;

function describe(i: { label?: string; help?: string }): string | undefined {
  const s = [i.label, i.help].filter(Boolean).join(' - ');
  return s || undefined;
}

function withMeta(schema: JsonSchema, item: InputModelItem, extraDesc?: string): JsonSchema {
  const base = describe(item);
  const desc = [base, extraDesc].filter(Boolean).join(' ');
  if (desc) schema['description'] = desc;
  if (item.default !== undefined) schema['default'] = item.default as unknown;
  return schema;
}

function numberField(f: BlockFieldSpec): JsonSchema {
  const s: JsonSchema = { type: 'number' };
  if (f.min !== undefined) s['minimum'] = f.min;
  if (f.max !== undefined) s['maximum'] = f.max;
  if (f.default !== undefined) s['default'] = f.default;
  if (f.label) s['description'] = f.label;
  return s;
}

function blockFieldSchema(f: BlockFieldSpec): JsonSchema {
  switch (f.type) {
    case 'number': return numberField(f);
    case 'boolean': return { type: 'boolean', ...(f.label ? { description: f.label } : {}) };
    case 'select': {
      const values = (f.options ?? []).map(o => o.value);
      return { type: 'string', ...(values.length ? { enum: values } : {}), ...(f.label ? { description: f.label } : {}) };
    }
    default: return { type: 'string', ...(f.label ? { description: f.label } : {}) };
  }
}

function schemaForInput(item: InputModelItem): JsonSchema {
  switch (item.type) {
    case 'text':
    case 'longtext': {
      const s: JsonSchema = { type: 'string' };
      if (item.maxLength) s['maxLength'] = item.maxLength;
      if (item.minLength) s['minLength'] = item.minLength;
      if (item.pattern) s['pattern'] = item.pattern;
      return withMeta(s, item);
    }
    case 'url':
      return withMeta({ type: 'string', format: 'uri' }, item);
    case 'number': {
      const s: JsonSchema = { type: 'number' };
      if (item.min !== undefined) s['minimum'] = item.min;
      if (item.max !== undefined) s['maximum'] = item.max;
      return withMeta(s, item);
    }
    case 'boolean':
      return withMeta({ type: 'boolean' }, item);
    case 'color':
      return withMeta({ type: 'string' }, item, 'Hex colour (e.g. #30ba78) or a {token.path} brand-token alias.');
    case 'select': {
      const values = (item.options ?? []).map(o => o.value);
      const labels = (item.options ?? []).map(o => (o.label ? `${o.value} (${o.label})` : o.value)).join(', ');
      return withMeta({ type: 'string', ...(values.length ? { enum: values } : {}) }, item, labels ? `Options: ${labels}.` : undefined);
    }
    case 'date':
      return withMeta({ type: 'string', format: 'date' }, item);
    case 'time':
    case 'datetime-local':
      return withMeta({ type: 'string' }, item);
    case 'asset':
      return withMeta({ type: 'string' }, item, 'An asset id (e.g. suse/logo/primary), a Lolly tool URL, or a data: URL.');
    case 'vector': {
      const properties: Record<string, JsonSchema> = {};
      for (const f of item.fields ?? []) properties[f.id] = numberField(f);
      return withMeta({ type: 'object', properties, additionalProperties: false }, item);
    }
    case 'blocks': {
      const properties: Record<string, JsonSchema> = {};
      for (const f of item.fields ?? []) properties[f.id] = blockFieldSchema(f);
      return withMeta({ type: 'array', items: { type: 'object', properties, additionalProperties: true } }, item);
    }
    default:
      return withMeta({ type: 'string' }, item);
  }
}

/**
 * The JSON Schema for a tool's `inputs` argument. `file`-typed inputs are always
 * omitted here - binary content is never URL-expressible and, for transform
 * tools, arrives via the top-level `file` argument of lolly_transform.
 */
export function toolInputSchema(manifest: ToolManifest): JsonSchema {
  const model = buildInputModel(manifest);
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const item of model) {
    if (item.type === 'file') continue;
    properties[item.id] = schemaForInput(item);
    // bindToProfile inputs are pre-fillable from the caller's identity, so never
    // force them as required even when the manifest marks them so.
    if (item.required && !item.bindToProfile) required.push(item.id);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** The id of a tool's single `file` input, if any (for lolly_transform). */
export function fileInputId(manifest: ToolManifest): string | null {
  return (manifest.inputs ?? []).find(i => i.type === 'file')?.id ?? null;
}
