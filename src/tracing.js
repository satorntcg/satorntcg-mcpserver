// OpenTelemetry wiring — STUBBED, not yet active.
//
// Plan: once the server works end-to-end with real tools, wrap each tool
// handler in a span here (tool name, arg summary, row count, duration, errors)
// and export via OTLP to a local Jaeger instance for a trace-waterfall demo.
//
// To activate:
//   npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
//   uncomment the block below, and import + call initTracing() as the very
//   first line of src/index.js (before any other imports run).
//
// export function initTracing() {
//   const { NodeSDK } = require('@opentelemetry/sdk-node');
//   const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
//   const sdk = new NodeSDK({
//     traceExporter: new OTLPTraceExporter({
//       url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
//     }),
//     serviceName: 'satorntcg-mcp-server',
//   });
//   sdk.start();
// }

export function initTracing() {
  // no-op until activated — safe to call unconditionally from index.js
}
