import './env.js'; // must be the first import — see src/env.js for why
import { initTracing } from './tracing.js';

initTracing();

import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from './tools/index.js';

const tracer = trace.getTracer('satorntcg-mcp-server');

// Above this, a tool call is worth a second look in Jaeger even without
// drilling into its child spans.
const SLOW_TOOL_THRESHOLD_MS = 1000;

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

  return tracer.startActiveSpan(`tool.${tool.name}`, async (span) => {
    span.setAttribute('mcp.tool.name', tool.name);
    span.setAttribute('mcp.tool.args', JSON.stringify(request.params.arguments ?? {}));

    const startedAt = performance.now();

    try {
      const result = await tool.handler(request.params.arguments ?? {});

      // Best-effort row count — most of our tools return { someKey: [...] }
      // or a flat object; only record it when there's an obvious array to count.
      const arrayField = Object.values(result ?? {}).find(Array.isArray);
      if (arrayField) {
        span.setAttribute('mcp.tool.row_count', arrayField.length);
      }

      span.setStatus({ code: SpanStatusCode.OK });
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
      console.error(`Tool error in ${tool.name}: ${err.message}${causeDetail}`);

      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });

      return {
        isError: true,
        content: [{ type: 'text', text: `Error running ${tool.name}: ${err.message}${causeDetail}` }],
      };
    } finally {
      const durationMs = performance.now() - startedAt;
      span.setAttribute('mcp.tool.duration_ms', Math.round(durationMs));
      span.setAttribute('mcp.tool.slow', durationMs > SLOW_TOOL_THRESHOLD_MS);
      span.end();
    }
  });
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
