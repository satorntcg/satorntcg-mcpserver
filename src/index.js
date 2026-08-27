import './env.js'; // must be the first import — see src/env.js for why
import { initTracing } from './tracing.js';

initTracing(); // no-op until OTel is activated — see src/tracing.js

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from './tools/index.js';

const server = new Server(
  { name: 'satorntcg-mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    const result = await tool.handler(request.params.arguments ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    // err.cause carries the real underlying reason (e.g. ETIMEDOUT, ENOTFOUND,
    // ECONNREFUSED) when a fetch fails — the top-level message alone is just
    // the generic "fetch failed" and hides what actually happened.
    const causeDetail = err.cause
      ? ` | cause: ${err.cause.code ?? ''} ${err.cause.message ?? err.cause}`
      : '';
    console.error(`Tool error in ${tool.name}:`, err.message, causeDetail, err.cause);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error running ${tool.name}: ${err.message}${causeDetail}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('satorntcg-mcp-server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
