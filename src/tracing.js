// OpenTelemetry wiring for this MCP server.
//
// This must be its own module and must be imported FIRST in index.js, for the
// same reason src/env.js has to be: ES modules evaluate all `import`
// statements (in declaration order) before any of the importing file's own
// top-level code runs. initTracing() has to register the trace provider
// before anything else in the process starts creating spans.
//
// This does NOT auto-instrument the Supabase client's HTTP calls — it sets up
// manual spans around each tool call in index.js instead, which is enough to
// see per-tool latency, row counts, and errors without pulling in the
// heavier undici/http auto-instrumentation packages.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

let sdk;

export function initTracing() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces';

  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    serviceName: 'satorntcg-mcp-server',
  });

  sdk.start();
  console.error(`OpenTelemetry tracing active — exporting to ${endpoint}`);

  // Flush pending spans on shutdown so the last few tool calls aren't lost
  // when Claude Desktop kills the process. This is raced against a timeout
  // and always followed by an explicit exit — if the OTLP endpoint (e.g.
  // Jaeger) isn't reachable, sdk.shutdown() can otherwise hang indefinitely
  // trying to flush, which would prevent the process from ever terminating.
  const shutdown = async () => {
    await Promise.race([
      sdk.shutdown().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
