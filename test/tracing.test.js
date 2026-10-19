import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { SHUTDOWN_TIMEOUT_MS, TRACE_EXPORT_TIMEOUT_MS } from '../src/tracing.js';
import { startHungServer, startStatusServer } from './otlpTestServers.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Ends one span in a child process (initTracing() registers global providers),
// with traces going to tracesUrl and no metrics. Two ways out, matching the two
// processes that share src/tracing.js:
// - 'shutdown': handleExit false and an explicit await shutdown(), like
//   agent/run-agent.js.
// - 'beforeExit': the default handleExit and no shutdown call, so the process
//   just runs out of work, like the MCP server once its client closes stdin.
// Returns the child's wall time.
async function runTraceChild({ tracesUrl, mode, extraEnv = {} }) {
  const url = pathToFileURL(path.join(repoRoot, 'src/tracing.js')).href;
  const script =
    mode === 'shutdown'
      ? `
        const { initTracing } = await import(${JSON.stringify(url)});
        const { trace } = await import('@opentelemetry/api');
        const shutdown = initTracing({ serviceName: 'satorntcg-agent', handleExit: false });
        trace.getTracer('test').startSpan('trace-test-span').end();
        await shutdown();
      `
      : `
        const { initTracing } = await import(${JSON.stringify(url)});
        const { trace } = await import('@opentelemetry/api');
        initTracing();
        trace.getTracer('test').startSpan('trace-test-span').end();
      `;
  const startedAt = performance.now();
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot, // so the child resolves @opentelemetry/api from this repo
    env: { PATH: process.env.PATH, OTEL_EXPORTER_OTLP_ENDPOINT: tracesUrl, ...extraEnv },
    timeout: 30000,
  });
  return performance.now() - startedAt;
}

// The OTLP default timeout is 10s. The child also spends up to a second or so
// starting up, so anything under this means TRACE_EXPORT_TIMEOUT_MS applied.
const PROMPT_EXIT_MS = 6000;

const serviceNameOf = (body) =>
  JSON.parse(body).resourceSpans[0].resource.attributes.find((attribute) => attribute.key === 'service.name').value.stringValue;

test('the trace exporter times out below the shutdown wait', () => {
  assert.ok(TRACE_EXPORT_TIMEOUT_MS > 0 && TRACE_EXPORT_TIMEOUT_MS < SHUTDOWN_TIMEOUT_MS, `${TRACE_EXPORT_TIMEOUT_MS}ms`);
});

for (const [mode, serviceName] of [
  ['shutdown', 'satorntcg-agent'],
  ['beforeExit', 'satorntcg-mcp-server'],
]) {
  test(`a healthy trace endpoint receives the span exactly once (${mode})`, async () => {
    const jaeger = await startStatusServer(200);
    try {
      const elapsed = await runTraceChild({ tracesUrl: `${jaeger.origin}/v1/traces`, mode });
      assert.equal(jaeger.requests.length, 1, 'expected exactly one trace export');
      const [{ path: requestPath, body }] = jaeger.requests;
      assert.equal(requestPath, '/v1/traces');
      assert.match(body, /trace-test-span/);
      assert.equal(serviceNameOf(body), serviceName);
      assert.ok(elapsed < PROMPT_EXIT_MS, `process took ${Math.round(elapsed)}ms to exit`);
    } finally {
      jaeger.close();
    }
  });

  test(`a hung trace endpoint does not keep the process alive past the export timeout (${mode})`, async () => {
    const jaeger = await startHungServer();
    try {
      const elapsed = await runTraceChild({ tracesUrl: `${jaeger.origin}/v1/traces`, mode });
      assert.equal(jaeger.connections(), 1, 'the trace export should have reached the hung endpoint once');
      assert.ok(elapsed < PROMPT_EXIT_MS, `process took ${Math.round(elapsed)}ms to exit`);
    } finally {
      jaeger.close();
    }
  });
}

test('a 503ing trace endpoint stops retrying at the export timeout', async () => {
  const jaeger = await startStatusServer(503);
  try {
    const elapsed = await runTraceChild({ tracesUrl: `${jaeger.origin}/v1/traces`, mode: 'shutdown' });
    // First attempt plus the retries that fit in 1.5s (backoff starts at ~1s).
    // The default 10s deadline allows about 6.
    assert.ok(jaeger.requests.length >= 1 && jaeger.requests.length <= 3, `${jaeger.requests.length} attempts`);
    assert.ok(jaeger.requests.every((request) => request.path === '/v1/traces'));
    assert.ok(elapsed < PROMPT_EXIT_MS, `process took ${Math.round(elapsed)}ms to exit`);
  } finally {
    jaeger.close();
  }
});

test('OTEL_EXPORTER_OTLP_TRACES_TIMEOUT still overrides the default trace export timeout', async () => {
  const jaeger = await startHungServer();
  try {
    const elapsed = await runTraceChild({
      tracesUrl: `${jaeger.origin}/v1/traces`,
      mode: 'shutdown',
      extraEnv: { OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '4000' },
    });
    // The natural exit waits for the export's own (4s) timeout, past both the
    // 1.5s default and the 2s shutdown wait.
    assert.ok(elapsed >= 3500 && elapsed < 9000, `process took ${Math.round(elapsed)}ms to exit`);
  } finally {
    jaeger.close();
  }
});
