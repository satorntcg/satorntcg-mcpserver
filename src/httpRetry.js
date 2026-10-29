// fetch() with bounded retries for safe, read-only requests, plus one OpenTelemetry
// client span per logical request.
//
// Retries are off unless the caller passes `retry: true`, and even then only GET,
// HEAD and OPTIONS are ever retried. A POST/PUT/PATCH/DELETE always gets exactly one
// attempt, so side-effecting calls (print_packing_slip, create_tcgplayer_order, the
// eBay OAuth token POST) can't be sent twice by this module.
//
// The final Response is returned as-is, ok or not; callers keep their own `!res.ok`
// handling. Only network errors (including the per-attempt timeout) are thrown.
//
// Telemetry never records headers (they carry credentials), bodies or the query
// string: only method, host, path, status codes, attempt counts and timings.
//
// No Supabase or dotenv imports, so tests can load this directly. Without a
// registered tracer provider the @opentelemetry/api calls are no-ops.
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('satorntcg-mcp-server');

export const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Transient socket/DNS failures worth another try. ENOTFOUND, ECONNREFUSED and TLS
// errors are left out on purpose: they usually mean misconfiguration, not a blip.
export const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'TIMEOUT', // our own per-attempt timeout, see errorCode()
]);

export const RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 3, // total attempts, not retries
  timeoutMs: 20_000, // per attempt
  baseDelayMs: 500,
  maxDelayMs: 10_000, // cap for both backoff and Retry-After
});

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry-After is either delta-seconds or an HTTP date. Returns milliseconds to wait
// (0 for a date in the past), or null when the header is missing or unparseable.
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

// Full jitter: a random delay between 0 and min(maxDelay, base * 2^retryIndex).
// retryIndex is 0 for the first retry.
export function backoffDelay(retryIndex, { baseDelayMs, maxDelayMs }, random = Math.random) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** retryIndex);
  return Math.round(random() * ceiling);
}

// Undici puts the real reason in err.cause.code; "fetch failed" alone says nothing.
function errorCode(err) {
  if (err?.name === 'TimeoutError') return 'TIMEOUT';
  return err?.cause?.code ?? err?.code ?? err?.name ?? 'UNKNOWN';
}

function safeUrlParts(url) {
  try {
    const u = new URL(String(url));
    return { 'server.address': u.hostname, 'url.path': u.pathname };
  } catch {
    return {};
  }
}

async function discardBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed or closed */
  }
}

// opts: { retry, maxAttempts, timeoutMs, baseDelayMs, maxDelayMs, fetchImpl, sleep,
//         random, now, spanName }
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const {
    retry = false,
    maxAttempts = RETRY_DEFAULTS.maxAttempts,
    timeoutMs = RETRY_DEFAULTS.timeoutMs,
    baseDelayMs = RETRY_DEFAULTS.baseDelayMs,
    maxDelayMs = RETRY_DEFAULTS.maxDelayMs,
    fetchImpl = fetch,
    sleep = defaultSleep,
    random = Math.random,
    now = Date.now,
    spanName = 'http.client',
  } = opts;

  const method = (init.method ?? 'GET').toUpperCase();
  const retryEnabled = retry === true && SAFE_METHODS.has(method);
  const attemptLimit = retryEnabled ? Math.max(1, Math.floor(maxAttempts)) : 1;
  const callerSignal = init.signal;

  return tracer.startActiveSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.request.method': method,
        ...safeUrlParts(url),
        'http.retry.enabled': retryEnabled,
        'http.retry.max_attempts': attemptLimit,
      },
    },
    async (span) => {
      const startedAt = now();
      let attempt = 0;
      let outcome = 'success';

      const finish = () => {
        span.setAttribute('http.request.resend_count', attempt - 1);
        span.setAttribute('http.retry.total_elapsed_ms', Math.round(now() - startedAt));
        span.setAttribute('http.retry.outcome', outcome);
        span.end();
      };

      // Records one retry and waits for it. Returns false if the caller aborted
      // during the wait.
      const waitForRetry = async (delayMs, source, failure) => {
        span.addEvent('http.retry', {
          'http.retry.attempt': attempt,
          ...failure,
          'http.retry.delay_ms': delayMs,
          'http.retry.delay_source': source,
        });
        await sleep(delayMs);
        return !callerSignal?.aborted;
      };

      try {
        for (;;) {
          attempt += 1;
          const attemptSignal = callerSignal
            ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs);

          let res;
          try {
            res = await fetchImpl(url, { ...init, method, signal: attemptSignal });
          } catch (err) {
            const code = errorCode(err);
            const callerAborted = callerSignal?.aborted === true;
            const canRetry = !callerAborted && RETRYABLE_ERROR_CODES.has(code) && attempt < attemptLimit;
            if (canRetry) {
              const delay = backoffDelay(attempt - 1, { baseDelayMs, maxDelayMs }, random);
              if (await waitForRetry(delay, 'backoff', { 'error.type': code })) continue;
            }
            if (callerAborted || callerSignal?.aborted) outcome = 'aborted';
            else if (!RETRYABLE_ERROR_CODES.has(code) || !retryEnabled) outcome = 'error';
            else outcome = 'exhausted';
            span.setAttribute('error.type', code);
            span.recordException({ name: err?.name ?? 'Error', message: err?.message ?? String(err) });
            span.setStatus({ code: SpanStatusCode.ERROR, message: code });
            throw err;
          }

          span.setAttribute('http.response.status_code', res.status);
          if (res.ok) {
            span.setStatus({ code: SpanStatusCode.OK });
            return res;
          }

          const retryable = RETRYABLE_STATUSES.has(res.status);
          if (!retryable || !retryEnabled) {
            outcome = 'http_error';
          } else if (attempt >= attemptLimit) {
            outcome = 'exhausted';
          } else {
            const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now());
            if (retryAfterMs != null && retryAfterMs > maxDelayMs) {
              // The server asked for a longer wait than we allow; retrying sooner
              // would just burn another call (eBay's daily-quota 429 is like this).
              outcome = 'retry_after_exceeded';
              span.setAttribute('http.retry.retry_after_ms', retryAfterMs);
            } else {
              const delay = retryAfterMs ?? backoffDelay(attempt - 1, { baseDelayMs, maxDelayMs }, random);
              const source = retryAfterMs != null ? 'retry-after' : 'backoff';
              await discardBody(res);
              if (await waitForRetry(delay, source, { 'http.response.status_code': res.status })) continue;
              outcome = 'aborted';
              span.setStatus({ code: SpanStatusCode.ERROR, message: 'aborted' });
              throw callerSignal.reason;
            }
          }

          span.setAttribute('error.type', String(res.status));
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.status}` });
          return res;
        }
      } finally {
        finish();
      }
    }
  );
}
