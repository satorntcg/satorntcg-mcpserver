// OpenTelemetry metrics for agent/run-agent.js, alongside the spans in
// agent/agentTracing.js.
//
// Instruments are created by createAgentMetrics(), not at import time: unlike
// tracers, the @opentelemetry/api global meter has no proxy, so a meter fetched
// before initTracing() registers the SDK would stay a no-op forever.
//
// Labels are kept low-cardinality: model ID, outcome, and the name of an
// allowlisted tool. Never the question, card names, argument values, or any
// per-request ID.

import { metrics } from '@opentelemetry/api';
import { AggregationTemporalityPreference, OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { core, metrics as sdkMetrics } from '@opentelemetry/sdk-node';

import { ALLOWED_TOOLS } from './agentCore.js';
import { OUTCOMES } from './agentTracing.js';

// A run takes seconds (server spawn plus one or more Claude calls), well past
// the SDK's default buckets, which top out at 10s and are mostly under 1s.
export const DURATION_BUCKETS_MS = Object.freeze([250, 500, 1000, 2500, 5000, 10000, 20000, 30000, 60000, 120000]);

const KNOWN_OUTCOMES = new Set(Object.values(OUTCOMES));

// Anything outside the allowlist is collapsed so a model-chosen name can never
// create a new series. agentCore rejects such names before MCP anyway, so this
// is a guard, not something expected to happen.
const toolLabel = (name) => (ALLOWED_TOOLS.includes(name) ? name : 'other');
const outcomeLabel = (outcome) => (KNOWN_OUTCOMES.has(outcome) ? outcome : OUTCOMES.UNKNOWN);

export function createAgentMetrics(meter = metrics.getMeter('satorntcg-agent')) {
  const requests = meter.createCounter('agent.requests', {
    description: 'Agent requests that finished, successfully or not',
    unit: '{request}',
  });
  const duration = meter.createHistogram('agent.request.duration', {
    description: 'Wall time of an agent request, from MCP server spawn to shutdown',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [...DURATION_BUCKETS_MS] },
  });
  const toolCalls = meter.createCounter('agent.tool.calls', {
    description: 'MCP tools/call executions made by the agent',
    unit: '{call}',
  });
  const inputTokens = meter.createCounter('agent.tokens.input', {
    description: 'Input tokens reported by the Anthropic API (usage.input_tokens)',
    unit: '{token}',
  });
  const outputTokens = meter.createCounter('agent.tokens.output', {
    description: 'Output tokens reported by the Anthropic API (usage.output_tokens)',
    unit: '{token}',
  });

  return {
    // Returns a handle whose end(outcome) records agent.requests and
    // agent.request.duration exactly once, however many exit paths call it.
    startRequest(model) {
      const startedAt = performance.now();
      let ended = false;
      return {
        end(outcome) {
          if (ended) return;
          ended = true;
          const attributes = { 'gen_ai.request.model': model, 'agent.outcome': outcomeLabel(outcome) };
          requests.add(1, attributes);
          duration.record(performance.now() - startedAt, attributes);
        },
      };
    },

    // Called once per Anthropic response with its usage block. A missing count
    // is skipped rather than recorded as 0.
    recordTokens(model, usage) {
      const attributes = { 'gen_ai.request.model': model };
      if (Number.isFinite(usage?.input_tokens)) inputTokens.add(usage.input_tokens, attributes);
      if (Number.isFinite(usage?.output_tokens)) outputTokens.add(usage.output_tokens, attributes);
    },

    // ok is false for both an isError tool result and a protocol failure.
    recordToolCall(toolName, ok) {
      toolCalls.add(1, { 'mcp.tool.name': toolLabel(toolName), 'agent.tool.outcome': ok ? 'success' : 'error' });
    },
  };
}

// Resolves once the text has been handed to the OS. stderr writes can be
// asynchronous (TTYs on Windows, pipes on macOS), and the signal handler in
// run-agent.js calls process.exit() right after the flush, which would drop
// writes still queued.
const writeStderr = (text) => new Promise((resolve) => process.stderr.write(text, () => resolve()));

// Writes each data point as one JSON line on stderr. The SDK's own
// ConsoleMetricExporter prints to stdout, where it would mix with the agent's
// answer, and it dumps whole objects rather than one line per series.
export class StderrMetricExporter {
  // write(text) gets every line of one export at once and may return a promise;
  // the export only reports success after it settles.
  constructor(write = writeStderr) {
    this.write = write;
  }

  export(resourceMetrics, resultCallback) {
    const lines = [];
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        for (const point of metric.dataPoints) {
          const value =
            typeof point.value === 'number'
              ? point.value
              : { count: point.value.count, sum: point.value.sum, min: point.value.min, max: point.value.max };
          lines.push(
            `[metrics] ${JSON.stringify({
              name: metric.descriptor.name,
              unit: metric.descriptor.unit,
              attributes: point.attributes,
              value,
            })}\n`,
          );
        }
      }
    }
    if (lines.length === 0) {
      resultCallback({ code: core.ExportResultCode.SUCCESS });
      return;
    }
    Promise.resolve(this.write(lines.join('')))
      .then(() => resultCallback({ code: core.ExportResultCode.SUCCESS }))
      .catch((error) => resultCallback({ code: core.ExportResultCode.FAILED, error }));
  }

  forceFlush() {
    return Promise.resolve();
  }

  shutdown() {
    return Promise.resolve();
  }
}

// The Collector from observability/docker-compose.yml. Not 4318: that is
// Jaeger's OTLP port, and Jaeger has no metrics receiver.
export const DEFAULT_OTLP_METRICS_ENDPOINT = 'http://localhost:4319/v1/metrics';

// A CLI run is shorter than this; the final export happens on the flush in
// src/tracing.js's shutdown. The interval only matters for very long runs.
const EXPORT_INTERVAL_MS = 60000;

// Picks the metric reader from the standard OTEL_METRICS_EXPORTER variable.
// Returns undefined (no metrics SDK at all; instruments stay no-ops) when it is
// unset, 'none', or unsupported.
//
// 'otlp' sends to OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, or
// DEFAULT_OTLP_METRICS_ENDPOINT. The URL is always passed explicitly: the
// exporter's own fallback would derive it from OTEL_EXPORTER_OTLP_ENDPOINT,
// which this repo sets to Jaeger's full traces URL, giving
// .../v1/traces/v1/metrics on Jaeger's port.
//
// OTLP uses DELTA temporality: each run is a new process whose cumulative
// counters would start from 0 again, so the Collector's delta_to_cumulative
// processor adds the runs together instead (see observability/otel-collector.yaml).
export function createMetricReader(env = process.env, warn = (message) => console.error(message)) {
  const exporterName = env.OTEL_METRICS_EXPORTER;
  const name = exporterName?.trim().toLowerCase();
  if (!name || name === 'none') return undefined;
  if (name === 'console') {
    return new sdkMetrics.PeriodicExportingMetricReader({
      exporter: new StderrMetricExporter(),
      exportIntervalMillis: EXPORT_INTERVAL_MS,
    });
  }
  if (name === 'otlp') {
    const url = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim() || DEFAULT_OTLP_METRICS_ENDPOINT;
    warn(`OpenTelemetry metrics active — exporting to ${url}`);
    return new sdkMetrics.PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url, temporalityPreference: AggregationTemporalityPreference.DELTA }),
      exportIntervalMillis: EXPORT_INTERVAL_MS,
    });
  }
  warn(
    `OTEL_METRICS_EXPORTER=${exporterName} is not supported by agent/run-agent.js (only "otlp", "console" or "none"); metrics are not exported.`,
  );
  return undefined;
}
