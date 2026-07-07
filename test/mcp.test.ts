// SPDX-License-Identifier: MPL-2.0
/**
 * End-to-end smoke test for the MCP server, driven through dispatch() exactly as
 * a transport would. Exercises the browser-free path: list → describe → build_url
 * → render (svg) → render (png via resvg). No Chromium required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/server.ts';
import type { JsonRpcResponse } from '../src/protocol.ts';

let nextId = 1;
async function rpc(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const res = (await dispatch({ jsonrpc: '2.0', id: nextId++, method, params })) as JsonRpcResponse;
  assert.ok(res, `no response for ${method}`);
  assert.ok(!res.error, `${method} errored: ${JSON.stringify(res.error)}`);
  return res.result as Record<string, unknown>;
}

interface ToolResult { content: { type: string; text?: string; mimeType?: string; data?: string }[]; isError?: boolean }
async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const r = (await rpc('tools/call', { name, arguments: args })) as unknown as ToolResult;
  assert.ok(!r.isError, `${name} isError: ${JSON.stringify(r.content)}`);
  return r;
}

test('initialize advertises the server', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal((init['serverInfo'] as { name: string }).name, 'lolly-mcp');
  assert.ok(init['capabilities']);
});

test('tools/list returns the meta-tools', async () => {
  const list = await rpc('tools/list');
  const names = (list['tools'] as { name: string }[]).map(t => t.name);
  for (const n of ['lolly_list_tools', 'lolly_describe_tool', 'lolly_build_url', 'lolly_render', 'lolly_transform']) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
});

test('list_tools finds qr-code', async () => {
  const r = await callTool('lolly_list_tools', { q: 'qr' });
  const text = r.content.map(c => c.text ?? '').join('\n');
  assert.match(text, /qr-code/);
});

test('describe_tool returns a JSON Schema with the url input', async () => {
  const r = await callTool('lolly_describe_tool', { toolId: 'qr-code' });
  const doc = JSON.parse(r.content[0]!.text!);
  assert.ok(doc.inputSchema.properties.url, 'qr-code should declare a url input');
  assert.ok(Array.isArray(doc.formats) && doc.formats.includes('svg'));
});

test('build_url produces a lolly.tools link', async () => {
  const r = await callTool('lolly_build_url', { toolId: 'qr-code', inputs: { url: 'https://suse.com' } });
  const text = r.content[0]!.text!;
  assert.match(text, /tool\/qr-code/);
  assert.match(text, /url=/);
});

test('render qr-code to svg (Tier A, no browser)', async () => {
  const r = await callTool('lolly_render', { toolId: 'qr-code', inputs: { url: 'https://suse.com' }, format: 'svg' });
  const svg = r.content.find(c => c.type === 'resource');
  assert.ok(svg, 'expected an svg resource block');
});

test('render qr-code to png (Tier A + resvg, no browser)', async () => {
  const r = await callTool('lolly_render', { toolId: 'qr-code', inputs: { url: 'https://suse.com', color: '#30ba78' }, format: 'png', width: 256 });
  const img = r.content.find(c => c.type === 'image');
  assert.ok(img && img.mimeType === 'image/png', 'expected a png image block');
  assert.ok((img!.data ?? '').length > 100, 'png should have bytes');
});
