import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { metrics as sdkMetrics } from '@opentelemetry/sdk-node';

import { runAgent } from '../agent/agentCore.js';
import {
  DEFAULT_OTLP_METRICS_ENDPOINT,
  DURATION_BUCKETS_MS,
  StderrMetricExporter,
  createAgentMetrics,
  createMetricReader,
} from '../agent/agentMetrics.js';
import { OUTCOMES, createRequestStats, traceAnthropic, traceMcp } from '../agent/agentTracing.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Pull-only reader: collect() returns what has been recorded so far, with no
// exporter or timer involved.
class TestReader extends sdkMetrics.MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}

function setup() {
  const reader = new TestReader();
  const provider = new sdkMetrics.MeterProvider({ readers: [reader] });
  const agentMetrics = createAgentMetrics(provider.getMeter('test'));
  const collect = async () => {
    const { resourceMetrics } = await reader.collect();
    const byName = new Map();
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) byName.set(metric.descriptor.name, metric);
    }
    return byName;
  };
  return { agentMetrics, collect };
}

const points = (metric) => metric?.dataPoints ?? [];

const inventoryTool = {
  name: 'get_inventory_summary',
  description: 'inventory',
  inputSchema: { type: 'object', properties: { name_contains: { type: 'string' } } },
};

function fakeAnthropic(responses) {
  let calls = 0;
  return {
    messages: {
      create: async () => responses[Math.min(calls++, responses.length - 1)],
    },
  };
}

const toolUse = (input) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `t${Math.random()}`, name: 'get_inventory_summary', input }],
  usage: { input_tokens: 10, output_tokens: 5 },
});
const final = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'SECRET_ANSWER' }], usage: { input_tokens: 20, output_tokens: 7 } };

test('a request records agent.requests and agent.request.duration once, with model and outcome', async () => {
  const { agentMetrics, collect } = setup();
  const request = agentMetrics.startRequest('test-model');
  request.end(OUTCOMES.ERROR);
  request.end(OUTCOMES.UNKNOWN); // a second exit path must not double count

  const metrics = await collect();
  const [requests] = points(metrics.get('agent.requests'));
  assert.equal(requests.value, 1);
  assert.deepEqual(requests.attributes, { 'gen_ai.request.model': 'test-model', 'agent.outcome': 'error' });

  const durationMetric = metrics.get('agent.request.duration');
  assert.equal(durationMetric.descriptor.unit, 'ms');
  const [duration] = points(durationMetric);
  assert.equal(duration.value.count, 1);
  assert.ok(duration.value.sum >= 0);
  assert.deepEqual(duration.value.buckets.boundaries, [...DURATION_BUCKETS_MS]);
  assert.deepEqual(duration.attributes, requests.attributes);
});

test('an outcome outside OUTCOMES is recorded as unknown', async () => {
  const { agentMetrics, collect } = setup();
  agentMetrics.startRequest('test-model').end('some free text');
  const [requests] = points((await collect()).get('agent.requests'));
  assert.equal(requests.attributes['agent.outcome'], 'unknown');
});

test('a traced run records actual token usage and tool calls with low-cardinality labels', async () => {
  const { agentMetrics, collect } = setup();
  const stats = createRequestStats();
  let mcpCalls = 0;
  const mcp = {
    callTool: async () => {
      mcpCalls += 1;
      if (mcpCalls === 1) return { content: [{ type: 'text', text: '{"inventory":[{"name":"SECRET_CARD"}]}' }] };
      if (mcpCalls === 2) return { isError: true, content: [{ type: 'text', text: 'boom' }] };
      throw new Error('Request timed out');
    },
  };
  await runAgent({
    anthropic: traceAnthropic(fakeAnthropic([toolUse({ name_contains: 'SECRET_ARG' }), toolUse({}), toolUse({}), final]), stats, agentMetrics),
    mcp: traceMcp(mcp, stats, agentMetrics),
    model: 'test-model',
    question: 'SECRET_QUESTION',
    mcpTools: [inventoryTool],
  });

  const metrics = await collect();
  const [input] = points(metrics.get('agent.tokens.input'));
  const [output] = points(metrics.get('agent.tokens.output'));
  assert.equal(input.value, 10 + 10 + 10 + 20);
  assert.equal(output.value, 5 + 5 + 5 + 7);
  assert.deepEqual(input.attributes, { 'gen_ai.request.model': 'test-model' });

  const toolPoints = points(metrics.get('agent.tool.calls'))
    .map((point) => [point.attributes['mcp.tool.name'], point.attributes['agent.tool.outcome'], point.value])
    .sort();
  // One success; the isError result and the thrown call are both errors.
  assert.deepEqual(toolPoints, [
    ['get_inventory_summary', 'error', 2],
    ['get_inventory_summary', 'success', 1],
  ]);

  const labels = JSON.stringify([...metrics.values()].flatMap((metric) => points(metric).map((point) => point.attributes)));
  for (const secret of ['SECRET_QUESTION', 'SECRET_ARG', 'SECRET_CARD', 'SECRET_ANSWER']) {
    assert.ok(!labels.includes(secret), `${secret} leaked into metric labels`);
  }
});

test('tool names outside the allowlist are collapsed to "other"', async () => {
  const { agentMetrics, collect } = setup();
  agentMetrics.recordToolCall('anything the model made up', false);
  const [point] = points((await collect()).get('agent.tool.calls'));
  assert.deepEqual(point.attributes, { 'mcp.tool.name': 'other', 'agent.tool.outcome': 'error' });
});

test('missing usage counts are skipped, not recorded as zero', async () => {
  const { agentMetrics, collect } = setup();
  agentMetrics.recordTokens('test-model', undefined);
  agentMetrics.recordTokens('test-model', { output_tokens: 3 });
  const metrics = await collect();
  assert.equal(points(metrics.get('agent.tokens.input')).length, 0);
  assert.equal(points(metrics.get('agent.tokens.output'))[0].value, 3);
});

test('createMetricReader supports otlp, console and none, and warns on anything else', () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(createMetricReader({}, warn), undefined);
  assert.equal(createMetricReader({ OTEL_METRICS_EXPORTER: 'none' }, warn), undefined);
  assert.ok(createMetricReader({ OTEL_METRICS_EXPORTER: 'console' }, warn) instanceof sdkMetrics.PeriodicExportingMetricReader);
  assert.equal(warnings.length, 0);

  assert.ok(createMetricReader({ OTEL_METRICS_EXPORTER: 'otlp' }, warn) instanceof sdkMetrics.PeriodicExportingMetricReader);
  assert.match(warnings.pop(), new RegExp(DEFAULT_OTLP_METRICS_ENDPOINT));
  createMetricReader({ OTEL_METRICS_EXPORTER: 'OTLP', OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:1234/v1/metrics' }, warn);
  assert.match(warnings.pop(), /127\.0\.0\.1:1234/);

  assert.equal(createMetricReader({ OTEL_METRICS_EXPORTER: 'prometheus' }, warn), undefined);
  assert.match(warnings.pop(), /prometheus.*not supported/);
});

test('the OTLP metrics endpoint never falls back to the traces endpoint', () => {
  const warnings = [];
  // The repo's .env sets the traces endpoint to Jaeger's full URL.
  createMetricReader(
    { OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318/v1/traces' },
    (message) => warnings.push(message),
  );
  assert.match(warnings[0], /localhost:4319\/v1\/metrics/);
});

test('StderrMetricExporter writes one JSON line per data point', async () => {
  const lines = [];
  const reader = new sdkMetrics.PeriodicExportingMetricReader({
    exporter: new StderrMetricExporter((text) => lines.push(...text.trimEnd().split('\n'))),
    exportIntervalMillis: 60000,
  });
  const provider = new sdkMetrics.MeterProvider({ readers: [reader] });
  const agentMetrics = createAgentMetrics(provider.getMeter('test'));
  agentMetrics.recordToolCall('get_latest_prices', true);
  agentMetrics.startRequest('test-model').end(OUTCOMES.UNKNOWN);
  await reader.forceFlush();
  await provider.shutdown();

  const parsed = lines.map((line) => JSON.parse(line.replace(/^\[metrics\] /, '')));
  assert.deepEqual(parsed.map((entry) => entry.name).sort(), ['agent.request.duration', 'agent.requests', 'agent.tool.calls']);
  const duration = parsed.find((entry) => entry.name === 'agent.request.duration');
  assert.equal(duration.unit, 'ms');
  assert.equal(duration.value.count, 1);
});

test('StderrMetricExporter reports success only after the write has finished', async () => {
  let finishWrite;
  const exporter = new StderrMetricExporter(() => new Promise((resolve) => { finishWrite = resolve; }));
  const reader = new sdkMetrics.PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 });
  const provider = new sdkMetrics.MeterProvider({ readers: [reader] });
  createAgentMetrics(provider.getMeter('test')).startRequest('test-model').end(OUTCOMES.UNKNOWN);

  let flushed = false;
  const flush = reader.forceFlush().then(() => { flushed = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(flushed, false, 'flush finished before the stderr write did');
  finishWrite();
  await flush;
  assert.equal(flushed, true);
  await provider.shutdown();
});

// Mirrors the two manual checks: a direct answer ("What does cost basis
// mean?") and a clarifying question ("Show me my best cards"), each a separate
// CLI process, so each starts its own cumulative counters at 0.
test('a request with no tool calls records requests, duration and tokens, and no tool-call series', async () => {
  for (const usage of [{ input_tokens: 1296, output_tokens: 298 }, { input_tokens: 1294, output_tokens: 125 }]) {
    const { agentMetrics, collect } = setup();
    const stats = createRequestStats();
    const request = agentMetrics.startRequest('test-model');
    const mcp = { callTool: async () => assert.fail('no tool should be called') };
    const result = await runAgent({
      anthropic: traceAnthropic(
        fakeAnthropic([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'answer' }], usage }]),
        stats,
        agentMetrics,
      ),
      mcp: traceMcp(mcp, stats, agentMetrics),
      model: 'test-model',
      question: 'q',
      mcpTools: [inventoryTool],
    });
    request.end(stats.outcome);
    assert.equal(result.toolCalls.length, 0);

    const metrics = await collect();
    assert.equal(points(metrics.get('agent.requests'))[0].value, 1);
    assert.equal(points(metrics.get('agent.request.duration'))[0].value.count, 1);
    // Same numbers runAgent() reports in the diagnostics block.
    assert.equal(points(metrics.get('agent.tokens.input'))[0].value, result.usage.input_tokens);
    assert.equal(points(metrics.get('agent.tokens.output'))[0].value, result.usage.output_tokens);
    assert.equal(points(metrics.get('agent.tool.calls')).length, 0);
  }
});

// The real exit path: initTracing()'s shutdown function must export metrics
// recorded moments before a short-lived process exits. Runs in a child process
// because initTracing() registers global providers.
test('initTracing shutdown flushes metrics before a short-lived process exits', async () => {
  const url = (file) => pathToFileURL(path.join(repoRoot, file)).href;
  const script = `
    const { initTracing } = await import(${JSON.stringify(url('src/tracing.js'))});
    const { createAgentMetrics, createMetricReader } = await import(${JSON.stringify(url('agent/agentMetrics.js'))});
    const shutdown = initTracing({ serviceName: 'test', handleExit: false, metricReader: createMetricReader({ OTEL_METRICS_EXPORTER: 'console' }) });
    createAgentMetrics().startRequest('test-model').end('error');
    await shutdown();
  `;
  const { stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9/v1/traces' },
    timeout: 15000,
  });
  const requestLine = stderr.split('\n').find((line) => line.includes('"name":"agent.requests"'));
  assert.ok(requestLine, `no agent.requests line in stderr:\n${stderr}`);
  assert.match(requestLine, /"agent.outcome":"error"/);
});

// What the Collector receives: a real OTLPMetricExporter in a child process
// (initTracing() registers global providers), posting to a throwaway local
// receiver instead of the Collector. The child gets a fake question on its
// command line, which NodeSDK's process detector would put in the resource.
test('otlp export sends delta metrics with only service.name as the resource, flushed at shutdown', async () => {
  const bodies = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      bodies.push({ path: req.url, contentType: req.headers['content-type'], body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const url = (file) => pathToFileURL(path.join(repoRoot, file)).href;
  const script = `
    const { initTracing } = await import(${JSON.stringify(url('src/tracing.js'))});
    const { createAgentMetrics, createMetricReader } = await import(${JSON.stringify(url('agent/agentMetrics.js'))});
    const shutdown = initTracing({ serviceName: 'satorntcg-agent', handleExit: false, metricReader: createMetricReader(process.env) });
    const m = createAgentMetrics();
    const request = m.startRequest('test-model');
    m.recordTokens('test-model', { input_tokens: 1296, output_tokens: 298 });
    m.recordToolCall('get_inventory_summary', true);
    request.end('unknown');
    await shutdown();
  `;
  try {
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, 'SECRET_QUESTION'], {
      env: {
        PATH: process.env.PATH,
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${receiver.address().port}/v1/metrics`,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9/v1/traces',
      },
      timeout: 15000,
    });
  } finally {
    receiver.close();
  }

  assert.equal(bodies.length, 1, 'expected exactly one metrics export, at shutdown');
  const [{ path: requestPath, contentType, body }] = bodies;
  assert.equal(requestPath, '/v1/metrics');
  assert.match(contentType, /json/);
  assert.ok(!body.includes('SECRET_QUESTION'), 'command line leaked into the metrics export');

  const [resourceMetrics] = JSON.parse(body).resourceMetrics;
  // service.name plus the SDK's constant telemetry.sdk.* attributes, which are
  // the same on every run. Nothing per-process (pid, argv, owner, host).
  const resourceKeys = resourceMetrics.resource.attributes.map((attribute) => attribute.key).sort();
  assert.deepEqual(resourceKeys, ['service.name', 'telemetry.sdk.language', 'telemetry.sdk.name', 'telemetry.sdk.version']);
  assert.equal(
    resourceMetrics.resource.attributes.find((attribute) => attribute.key === 'service.name').value.stringValue,
    'satorntcg-agent',
  );
  const exported = new Map(resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).map((metric) => [metric.name, metric]));
  assert.deepEqual([...exported.keys()].sort(), [
    'agent.request.duration',
    'agent.requests',
    'agent.tokens.input',
    'agent.tokens.output',
    'agent.tool.calls',
  ]);
  const DELTA = 1; // OTLP AggregationTemporality enum
  for (const metric of exported.values()) {
    assert.equal((metric.sum ?? metric.histogram).aggregationTemporality, DELTA, `${metric.name} is not delta`);
  }
  const [inputPoint] = exported.get('agent.tokens.input').sum.dataPoints;
  assert.equal(Number(inputPoint.asInt ?? inputPoint.asDouble), 1296);
});
