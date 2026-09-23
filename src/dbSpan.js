// Wraps a single Supabase call in its own child span, nested under the
// active `tool.<name>` span that index.js starts for the whole request.
// Node's OTel context propagation (AsyncLocalStorage) carries the active
// span across the await inside a tool handler, so no context needs to be
// passed in explicitly here — this just needs to run inside that handler.
//
// This turns a slow tool call from "was it MCP overhead or the DB?" into
// a direct read off the trace: the db.query child span's own duration is
// the DB round-trip; whatever's left over in the parent tool.* span is
// everything else the handler did.
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('satorntcg-mcp-server');

// queryFn must return a Supabase query builder / thenable — not already
// awaited — so this can time the actual request.
export async function withDbSpan(table, queryFn) {
  return tracer.startActiveSpan('db.query', async (span) => {
    span.setAttribute('db.system', 'postgresql');
    span.setAttribute('db.table', table);

    try {
      const result = await queryFn();

      if (result?.error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.message });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
        if (Array.isArray(result?.data)) {
          span.setAttribute('db.row_count', result.data.length);
        }
      }

      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
