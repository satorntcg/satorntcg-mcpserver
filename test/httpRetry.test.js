import test from 'node:test';
import assert from 'node:assert/strict';

import { SpanStatusCode } from '@opentelemetry/api';
import { node } from '@opentelemetry/sdk-node';

import { fetchWithRetry, parseRetryAfter, backoffDelay, RETRY_DEFAULTS } from '../src/httpRetry.js';
import { createEbayClient } from '../src/ebayClient.js';

// In-memory spans so nothing leaves the process (same setup as agentTracing.test.js).
const exporter = new node.InMemorySpanExporter();
new node.NodeTracerProvider({ spanProcessors: [new node.SimpleSpanProcessor(exporter)] }).register();

const URL_ = 'https://api.example.com/v1/items?q=SECRET_QUERY';
const SECRET = 'Bearer SECRET_TOKEN_VALUE';

// Scripted fetch: each step is a Response factory, an Error to throw, or 'hang'
// (never resolves until the attempt's signal aborts).
function scriptedFetch(steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
    if (step instanceof Error) throw step;
    return step();
  };
  return { fetchImpl, calls };
}

const status = (code, headers = {}) => () => new Response(code === 204 ? null : JSON.stringify({ code }), { status: code, headers });
const ok = () => new Response('{"ok":true}', { status: 200 });

const netError = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

// Fake sleep records requested delays and returns immediately.
function harness(steps, extra = {}) {
  exporter.reset();
  const { fetchImpl, calls } = scriptedFetch(steps);
  const delays = [];
  const opts = {
    retry: true,
    fetchImpl,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    now: () => Date.parse('2026-10-29T12:00:00Z'),
    ...extra,
  };
  return { calls, delays, opts };
}

const onlySpan = () => {
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  return spans[0];
};

test('immediate success: one attempt, no retry events', async () => {
  const { calls, delays, opts } = harness([ok]);
  const res = await fetchWithRetry(URL_, { headers: { Authorization: SECRET } }, opts);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
  const span = onlySpan();
  assert.equal(span.name, 'http.client');
  assert.equal(span.attributes['http.request.resend_count'], 0);
  assert.equal(span.attributes['http.retry.outcome'], 'success');
  assert.equal(span.attributes['http.response.status_code'], 200);
  assert.equal(span.status.code, SpanStatusCode.OK);
  assert.equal(span.events.length, 0);
});

test('429 then success retries with backoff', async () => {
  const { calls, delays, opts } = harness([status(429), ok]);
  const res = await fetchWithRetry(URL_, {}, opts);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [250]); // 0.5 * min(10000, 500 * 2^0)
  const span = onlySpan();
  assert.equal(span.attributes['http.request.resend_count'], 1);
  assert.equal(span.events[0].name, 'http.retry');
  assert.equal(span.events[0].attributes['http.response.status_code'], 429);
  assert.equal(span.events[0].attributes['http.retry.delay_source'], 'backoff');
});

test('503 then success', async () => {
  const { calls, opts } = harness([status(503), ok]);
  const res = await fetchWithRetry(URL_, {}, opts);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test('exhausted retries return the last response after 3 attempts, delays grow', async () => {
  const { calls, delays, opts } = harness([status(502), status(504), status(503)]);
  const res = await fetchWithRetry(URL_, {}, opts);
  assert.equal(res.status, 503);
  assert.equal(calls.length, RETRY_DEFAULTS.maxAttempts);
  assert.deepEqual(delays, [250, 500]);
  const span = onlySpan();
  assert.equal(span.attributes['http.retry.outcome'], 'exhausted');
  assert.equal(span.attributes['http.request.resend_count'], 2);
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.events.length, 2);
});

test('Retry-After in seconds and as an HTTP date replaces the backoff delay', async () => {
  let h = harness([status(429, { 'Retry-After': '2' }), ok]);
  await fetchWithRetry(URL_, {}, h.opts);
  assert.deepEqual(h.delays, [2000]);
  assert.equal(onlySpan().events[0].attributes['http.retry.delay_source'], 'retry-after');

  h = harness([status(503, { 'Retry-After': 'Thu, 29 Oct 2026 12:00:03 GMT' }), ok]);
  await fetchWithRetry(URL_, {}, h.opts);
  assert.deepEqual(h.delays, [3000]);
});

test('Retry-After longer than maxDelayMs stops instead of retrying early', async () => {
  const { calls, delays, opts } = harness([status(429, { 'Retry-After': '3600' }), ok], { maxDelayMs: 5000 });
  const res = await fetchWithRetry(URL_, {}, opts);
  assert.equal(res.status, 429);
  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
  const span = onlySpan();
  assert.equal(span.attributes['http.retry.outcome'], 'retry_after_exceeded');
  assert.equal(span.attributes['http.retry.retry_after_ms'], 3_600_000);
});

test('per-attempt timeout is retried, then thrown once attempts run out', async () => {
  const { calls, opts } = harness(['hang', ok], { timeoutMs: 20 });
  const res = await fetchWithRetry(URL_, {}, opts);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(onlySpan().events[0].attributes['error.type'], 'TIMEOUT');

  const h = harness(['hang'], { timeoutMs: 20 });
  await assert.rejects(fetchWithRetry(URL_, {}, h.opts), { name: 'TimeoutError' });
  assert.equal(h.calls.length, 3);
  const span = onlySpan();
  assert.equal(span.attributes['http.retry.outcome'], 'exhausted');
  assert.equal(span.attributes['error.type'], 'TIMEOUT');
});

test('transient network errors retry; permanent ones do not', async () => {
  let h = harness([netError('ECONNRESET'), ok]);
  assert.equal((await fetchWithRetry(URL_, {}, h.opts)).status, 200);
  assert.equal(h.calls.length, 2);

  h = harness([netError('ENOTFOUND'), ok]);
  await assert.rejects(fetchWithRetry(URL_, {}, h.opts), /fetch failed/);
  assert.equal(h.calls.length, 1);
  assert.equal(onlySpan().attributes['http.retry.outcome'], 'error');
});

test('unsafe methods are never retried, even with retry: true', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const { calls, delays, opts } = harness([status(503), ok]);
    const res = await fetchWithRetry(URL_, { method, body: '{"order":"SECRET_BODY"}' }, opts);
    assert.equal(res.status, 503, method);
    assert.equal(calls.length, 1, method);
    assert.deepEqual(delays, [], method);
    const span = onlySpan();
    assert.equal(span.attributes['http.retry.enabled'], false);
    assert.equal(span.attributes['http.retry.outcome'], 'http_error');
  }

  const h = harness([netError('ECONNRESET'), ok]);
  await assert.rejects(fetchWithRetry(URL_, { method: 'POST' }, h.opts));
  assert.equal(h.calls.length, 1);
});

test('retries are off by default', async () => {
  const { calls, opts } = harness([status(503), ok], { retry: undefined });
  const res = await fetchWithRetry(URL_, {}, opts);
  assert.equal(res.status, 503);
  assert.equal(calls.length, 1);
});

test('a caller abort is not retried', async () => {
  const controller = new AbortController();
  const { calls, opts } = harness(['hang', ok]);
  const pending = fetchWithRetry(URL_, { signal: controller.signal }, opts);
  controller.abort(new Error('caller gave up'));
  await assert.rejects(pending, /caller gave up/);
  assert.equal(calls.length, 1);
  assert.equal(onlySpan().attributes['http.retry.outcome'], 'aborted');
});

test('telemetry records no credentials, bodies or query strings', async () => {
  const { opts } = harness([status(503), netError('ECONNRESET'), status(500)]);
  await fetchWithRetry(URL_, { headers: { Authorization: SECRET, Cookie: 'SECRET_COOKIE' } }, opts);
  const span = onlySpan();
  const dump = JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status });
  for (const secret of ['SECRET_TOKEN_VALUE', 'SECRET_COOKIE', 'SECRET_QUERY', 'Authorization', 'Bearer']) {
    assert.ok(!dump.includes(secret), `span leaked ${secret}`);
  }
  assert.equal(span.attributes['url.path'], '/v1/items');
  assert.equal(span.attributes['server.address'], 'api.example.com');
  assert.equal(typeof span.attributes['http.retry.total_elapsed_ms'], 'number');
});

test('parseRetryAfter and backoffDelay', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  assert.equal(parseRetryAfter('5', now), 5000);
  assert.equal(parseRetryAfter('Thu, 29 Oct 2026 12:00:10 GMT', now), 10_000);
  assert.equal(parseRetryAfter('Thu, 29 Oct 2026 11:00:00 GMT', now), 0); // past date
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(null, now), null);

  const cfg = { baseDelayMs: 500, maxDelayMs: 1500 };
  assert.equal(backoffDelay(0, cfg, () => 1), 500);
  assert.equal(backoffDelay(1, cfg, () => 1), 1000);
  assert.equal(backoffDelay(5, cfg, () => 1), 1500); // capped
  assert.equal(backoffDelay(3, cfg, () => 0), 0);
});

test('eBay searchPage recovers from a 503; token POST is not retried', async () => {
  exporter.reset();
  let searchCalls = 0;
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('oauth2/token')) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }));
    }
    searchCalls += 1;
    if (searchCalls === 1) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ itemSummaries: [{ itemId: '1' }], total: 1 }));
  };
  const ebay = createEbayClient({
    fetchImpl,
    env: { EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 's' },
    retryOptions: { sleep: async () => {} },
  });
  const page = await ebay.searchPage({ q: 'sorcery', filter: '' });
  assert.equal(page.items.length, 1);
  assert.equal(searchCalls, 2);

  assert.equal(tokenCalls, 1);

  let calls = 0;
  const failingToken = createEbayClient({
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 503 });
    },
    env: { EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 's' },
    retryOptions: { sleep: async () => {} },
  });
  await assert.rejects(failingToken.getToken(), /OAuth token request failed: HTTP 503/);
  assert.equal(calls, 1);
});
