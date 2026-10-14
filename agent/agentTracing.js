// OpenTelemetry spans for agent/run-agent.js. Instead of adding tracing to
// agent/agentCore.js (which stays free of tracing imports so its tests need no
// OTel setup), this wraps the two clients runAgent() is given: every
// messages.create() and every callTool() then gets a child span under the
// active agent.request span, and runAgent() itself runs unchanged.
//
// Only @opentelemetry/api is imported here. The SDK and exporter are set up by
// src/tracing.js's initTracing(); without it these spans are no-ops.
//
// What is recorded: model IDs, token counts, stop reasons, tool names, argument
// key names, round numbers, status and durations. What is never recorded: the
// API key, the question or system prompt, message content, argument values, or
// anything from a tool result (rows, counts, text).

import { context, propagation, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('satorntcg-agent');

// Spans that have started and not yet ended, so endOpenSpans() can close them if
// the process is interrupted mid-request.
const openSpans = new Set();

// Runs fn(span) inside an active span. The span is ended whether fn returns or
// throws, and a throw is recorded and rethrown unchanged.
export function withSpan(name, options, fn) {
  return tracer.startActiveSpan(name, options, async (span) => {
    openSpans.add(span);
    const startedAt = performance.now();
    try {
      return await fn(span);
    } catch (error) {
      markError(span, error);
      throw error;
    } finally {
      span.setAttribute('agent.duration_ms', Math.round(performance.now() - startedAt));
      if (openSpans.delete(span)) span.end();
    }
  });
}

export function markError(span, errorOrMessage) {
  if (errorOrMessage instanceof Error) {
    span.recordException(errorOrMessage);
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorOrMessage.message });
  } else {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(errorOrMessage) });
  }
}

// Ends every span still open (innermost first), with an error status. Used on
// SIGINT/SIGTERM so an interrupted request still shows up in Jaeger.
export function endOpenSpans(reason) {
  for (const span of [...openSpans].reverse()) {
    openSpans.delete(span);
    markError(span, reason);
    span.end();
  }
}

// Per-request counters shared by the two wrappers below.
//
// agentCore's loop is sequential: Claude call N carries the results of tool
// round N-1 (0 = the initial question), and the tools Claude requests in that
// response make up round N. Counting Claude calls is therefore enough to label
// both, and agent.round on a tool span matches the "round N" in diagnostics.
//
// Tokens are summed from each response that actually came back, so a request
// that fails partway still reports what its completed calls used. outcome is
// filled in from recordAgentResult()/recordAgentFailure() so the request
// metrics carry the same agent.outcome as the span.
export function createRequestStats() {
  return { claudeCalls: 0, inputTokens: 0, outputTokens: 0, outcome: OUTCOMES.UNKNOWN };
}

const usageAttributes = (usage = {}) => {
  const attributes = {
    'gen_ai.usage.input_tokens': usage.input_tokens ?? 0,
    'gen_ai.usage.output_tokens': usage.output_tokens ?? 0,
  };
  // Present only when prompt caching applies.
  if (usage.cache_read_input_tokens != null) {
    attributes['gen_ai.usage.cache_read_input_tokens'] = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens != null) {
    attributes['gen_ai.usage.cache_creation_input_tokens'] = usage.cache_creation_input_tokens;
  }
  return attributes;
};

// Same messages.create() signature and return value as the real client; only the
// part of the Anthropic client runAgent() uses is exposed. agentMetrics (from
// agent/agentMetrics.js) is optional.
export function traceAnthropic(anthropic, stats, agentMetrics) {
  return {
    messages: {
      create(params, options) {
        const round = stats.claudeCalls;
        stats.claudeCalls += 1;
        return withSpan(
          'claude.messages.create',
          {
            kind: SpanKind.CLIENT,
            attributes: {
              'gen_ai.system': 'anthropic',
              'gen_ai.request.model': params.model,
              'gen_ai.request.max_tokens': params.max_tokens,
              'agent.round': round,
              'agent.claude_call': round + 1,
            },
          },
          async (span) => {
            const response = await anthropic.messages.create(params, options);
            stats.inputTokens += response.usage?.input_tokens ?? 0;
            stats.outputTokens += response.usage?.output_tokens ?? 0;
            agentMetrics?.recordTokens(params.model, response.usage);
            span.setAttributes({
              'gen_ai.response.model': response.model ?? params.model,
              'gen_ai.response.finish_reasons': [String(response.stop_reason)],
              'agent.tool_use_count': response.content?.filter((block) => block.type === 'tool_use').length ?? 0,
              ...usageAttributes(response.usage),
            });
            span.setStatus({ code: SpanStatusCode.OK });
            return response;
          },
        );
      },
    },
  };
}

// Wraps callTool() and passes the tool span's trace context to the server in the
// request's `_meta` (W3C traceparent/tracestate keys), which src/index.js extracts
// so its tool.<name> span becomes this span's child. agentCore never sets `_meta`
// itself, so nothing of its own is overwritten.
export function traceMcp(mcp, stats, agentMetrics) {
  return {
    callTool(params, resultSchema, options) {
      return withSpan(
        `mcp.call_tool ${params.name}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'mcp.tool.name': params.name,
            // Key names only; values can carry text from the user's question.
            'mcp.tool.arg_keys': Object.keys(params.arguments ?? {}),
            'agent.round': stats.claudeCalls,
          },
        },
        async (span) => {
          const carrier = {};
          propagation.inject(context.active(), carrier);
          let result;
          try {
            result = await mcp.callTool({ ...params, _meta: { ...params._meta, ...carrier } }, resultSchema, options);
          } catch (error) {
            span.setAttribute('agent.tool.status', 'mcp_error');
            agentMetrics?.recordToolCall(params.name, false);
            throw error;
          }
          agentMetrics?.recordToolCall(params.name, !result.isError);
          if (result.isError) {
            span.setAttribute('agent.tool.status', 'tool_error');
            // The error text is tool output, so only a fixed message is recorded.
            markError(span, 'tool returned isError');
          } else {
            span.setAttribute('agent.tool.status', 'ok');
            span.setStatus({ code: SpanStatusCode.OK });
          }
          return result;
        },
      );
    },
  };
}

// agent.outcome values. Only the ones a run can be observed to produce are ever
// recorded; see classifyOutcome().
export const OUTCOMES = Object.freeze({
  ANSWERED: 'answered',
  CLARIFICATION: 'clarification',
  UNSUPPORTED: 'unsupported',
  ERROR: 'error',
  UNKNOWN: 'unknown',
});

// Maps a finished runAgent() result to an agent.outcome.
//
// 'error' when the run failed to finish: max_tool_rounds (the CLI exits 1 and
// the answer may be incomplete). Everything else is 'unknown'. agentCore returns
// only free text, with no structured signal saying whether that text is an
// answer, a clarifying question, or a refusal to do something the tools can't,
// and stop_reason 'end_turn' is the same in all three cases. Telling them apart
// would mean guessing from the text or from whether tools were called, which is
// exactly what this attribute must not do. Making answered/clarification/
// unsupported observable needs the model to report it in a structured way
// (e.g. a final-response tool or schema), which is an agent behavior change.
export function classifyOutcome(result) {
  if (result.stopReason === 'max_tool_rounds') return OUTCOMES.ERROR;
  return OUTCOMES.UNKNOWN;
}

// Request-level attributes set when agent.request starts. agent.outcome begins
// as 'unknown' so a run interrupted by a signal, which never reaches either
// record* function below, still carries the attribute.
export function requestStartAttributes(model) {
  return { 'gen_ai.request.model': model, 'agent.outcome': OUTCOMES.UNKNOWN };
}

// Token totals for the request span. Named agent.usage.* rather than
// gen_ai.usage.* so a backend that sums gen_ai.usage.* across spans doesn't
// count every token twice (once on the Claude span, once on this total).
const totalUsageAttributes = (inputTokens, outputTokens) => ({
  'agent.usage.input_tokens': inputTokens,
  'agent.usage.output_tokens': outputTokens,
});

// Records a run that failed before runAgent() returned (MCP setup failure, an
// Anthropic API error, an unexpected throw). Tokens are what completed Claude
// calls reported. Tool counts are left unset: without runAgent()'s result they
// would have to be reconstructed, and an absent attribute is more honest than a
// reconstructed one. Returns the outcome recorded.
export function recordAgentFailure(span, stats) {
  stats.outcome = OUTCOMES.ERROR;
  span.setAttributes({
    'agent.outcome': OUTCOMES.ERROR,
    ...totalUsageAttributes(stats.inputTokens, stats.outputTokens),
  });
  return OUTCOMES.ERROR;
}

// Records the outcome of runAgent() on the request span. Tool uses that agentCore
// rejected before execution (not allowlisted, invalid arguments) never reach
// callTool(), so they appear here as span events instead of child spans.
// Returns the outcome recorded.
export function recordAgentResult(span, result) {
  const outcome = classifyOutcome(result);
  span.setAttributes({
    'agent.outcome': outcome,
    'agent.stop_reason': String(result.stopReason),
    // Tool uses Claude requested that the agent handled, executed or rejected.
    // Tool uses in a response cut off by max_tool_rounds were never handled and
    // aren't counted, matching the diagnostics block.
    'agent.tool_call_count': result.toolCalls.length,
    // Rounds of tool execution whose results were sent back to Claude.
    'agent.tool_round_count': result.rounds,
    ...totalUsageAttributes(result.usage.input_tokens, result.usage.output_tokens),
  });
  for (const call of result.toolCalls) {
    if (call.status === 'rejected') {
      span.addEvent('tool_use_rejected', { 'mcp.tool.name': String(call.name), 'agent.round': call.round });
    }
  }
  return outcome;
}
