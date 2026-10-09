import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

// Discovery-only test: it never calls a tool, so these placeholders are never used
// to reach a real service. They exist because supabaseClient.js throws at import
// time without them. src/env.js still loads the real .env, but dotenv does not
// override variables that are already set, so these values win. The SDK only
// forwards a minimal default environment (PATH etc.) plus what's listed here, so
// credentials in the parent shell don't leak into the child either.
const placeholderEnv = {
  SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_KEY: 'placeholder-not-a-real-key',
  TCGPLAYER_COOKIE: 'placeholder-not-a-real-cookie',
  OTEL_SDK_DISABLED: 'true',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9/v1/traces',
};

test('tools/list exposes get_inventory_summary with its input schema', async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: placeholderEnv,
    stderr: 'pipe', // keep the server's startup logs out of the test output
  });
  const client = new Client({ name: 'satorntcg-mcp-test', version: '0.0.0' });

  // close() shuts down the transport, which ends and then kills the server process.
  t.after(() => client.close());

  await client.connect(transport);
  const { tools } = await client.listTools();

  const tool = tools.find((candidate) => candidate.name === 'get_inventory_summary');
  assert.ok(tool, 'get_inventory_summary should be listed');
  assert.equal(typeof tool.description, 'string');
  assert.ok(tool.description.trim().length > 0, 'description should be non-empty');
  assert.ok(tool.inputSchema?.properties?.sort_by, 'inputSchema should define sort_by');
  assert.ok(tool.inputSchema?.properties?.limit, 'inputSchema should define limit');
});
