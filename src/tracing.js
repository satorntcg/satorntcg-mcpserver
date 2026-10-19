// OpenTelemetry wiring for this MCP server and for agent/run-agent.js.
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
//
// NodeSDK also registers the default W3C trace-context propagator, which
// index.js uses to continue a trace the agent passes in a tools/call `_meta`.

import { metrics } from '@opentelemetry/api';
import { NodeSDK, metrics as sdkMetrics, resources } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

export const SHUTDOWN_TIMEOUT_MS = 2000;

// Per-export HTTP deadline for traces, retries included. Below
// SHUTDOWN_TIMEOUT_MS because that timeout only stops waiting: an export still
// in flight keeps the event loop alive, and the OTLP default (10s) let a hung or
// 503ing Jaeger hold a natural exit for that long. A local Jaeger answers in
// milliseconds, so the MCP server's periodic exports aren't affected. The
// standard OTEL_EXPORTER_OTLP_TRACES_TIMEOUT / OTEL_EXPORTER_OTLP_TIMEOUT
// variables still take precedence (e.g. for a slower remote backend).
export const TRACE_EXPORT_TIMEOUT_MS = 1500;
const TRACE_TIMEOUT_ENV_VARS = ['OTEL_EXPORTER_OTLP_TRACES_TIMEOUT', 'OTEL_EXPORTER_OTLP_TIMEOUT'];

let sdk;

// Returns a flush-and-shutdown function whose promise settles within
// SHUTDOWN_TIMEOUT_MS. That bounds the wait, not the process (see below).
// With handleExit (the server's default) it is also wired to SIGTERM/SIGINT
// and to the process running out of work; callers that manage their own exit
// (the agent CLI) pass handleExit: false and call it themselves.
//
// metricReader is optional and only the agent passes one (see
// agent/agentMetrics.js). Without it, no MeterProvider is registered and the
// metrics API stays a no-op, as before.
//
// The MeterProvider is deliberately separate from NodeSDK, which would give
// metrics the same auto-detected resource as traces. That resource includes
// process.command_args (for the agent CLI, the user's question), process.owner,
// host.name and process.pid. The Prometheus exporter turns resource attributes
// into target_info labels, and a per-run pid would also give every CLI run its
// own series, so the Collector could never add runs together. Metrics get only
// service.name (plus the SDK's constant telemetry.sdk.* attributes). Traces
// keep NodeSDK's resource unchanged.
export function initTracing({ serviceName = 'satorntcg-mcp-server', handleExit = true, metricReader } = {}) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces';

  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: endpoint,
      // An explicit timeoutMillis would override the env variables, so it's
      // only passed when neither is set.
      ...(TRACE_TIMEOUT_ENV_VARS.some((name) => process.env[name]?.trim()) ? {} : { timeoutMillis: TRACE_EXPORT_TIMEOUT_MS }),
    }),
    serviceName,
  });

  sdk.start();
  console.error(`OpenTelemetry tracing active — exporting to ${endpoint}`);

  // Same switch NodeSDK.start() honors, so OTEL_SDK_DISABLED turns off both.
  const sdkDisabled = /^true$/i.test(process.env.OTEL_SDK_DISABLED?.trim() ?? '');
  let meterProvider;
  if (metricReader && !sdkDisabled) {
    meterProvider = new sdkMetrics.MeterProvider({
      resource: new resources.Resource({ 'service.name': serviceName }),
      readers: [metricReader],
    });
    metrics.setGlobalMeterProvider(meterProvider);
  }

  // Raced against a timeout because if the OTLP endpoint (e.g. Jaeger) isn't
  // reachable, sdk.shutdown() can otherwise hang indefinitely trying to flush,
  // which would prevent the process from ever terminating.
  // The timer is cleared afterwards so a fast flush doesn't keep the process
  // alive for the rest of the timeout.
  //
  // The race only bounds how long callers wait. An export still in flight when
  // it fires keeps running, and keeps the event loop alive, until its own HTTP
  // timeout. Callers that process.exit() afterwards (the signal handlers) cut it
  // off; a natural exit (the agent CLI, or the server's beforeExit) waits for
  // it, which is why both the trace exporter (TRACE_EXPORT_TIMEOUT_MS) and the
  // agent's metric exporter (agent/agentMetrics.js) set timeoutMillis below
  // this. It's still not a hard deadline: a timeout env variable set higher, or
  // anything else left on the event loop, can keep a natural exit going past it.
  let shutdownPromise;
  const shutdownTracing = () => {
    if (!shutdownPromise) {
      let timer;
      shutdownPromise = Promise.race([
        (async () => {
          // Traces and metrics shut down concurrently, so a slow or hung
          // Collector can't use up the trace flush's share of the timeout.
          //
          // In sdk-metrics 1.x, shutting down a PeriodicExportingMetricReader
          // does not export what was recorded since the last interval, so a
          // short-lived process would lose all of it. Flush explicitly first.
          const shutdownMetrics = async () => {
            await metricReader.forceFlush().catch(() => {});
            await meterProvider.shutdown().catch(() => {});
          };
          await Promise.all([sdk.shutdown().catch(() => {}), meterProvider && shutdownMetrics()]);
        })(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
    }
    return shutdownPromise;
  };

  if (handleExit) {
    // Flush pending spans on shutdown so the last few tool calls aren't lost
    // when Claude Desktop kills the process, always followed by an explicit exit.
    const shutdownAndExit = async () => {
      await shutdownTracing();
      process.exit(0);
    };
    process.on('SIGTERM', shutdownAndExit);
    process.on('SIGINT', shutdownAndExit);

    // An MCP client that closes our stdin (the SDK's StdioClientTransport does
    // this first, before any signal) leaves the process with nothing to do, and
    // it would exit without exporting: the batch processor's timer doesn't keep
    // the event loop alive. beforeExit gives one last chance to flush.
    process.once('beforeExit', () => {
      shutdownTracing();
    });
  }

  return shutdownTracing;
}
