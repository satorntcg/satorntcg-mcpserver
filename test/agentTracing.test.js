import test from 'node:test';
import assert from 'node:assert/strict';

import { SpanStatusCode } from '@opentelemetry/api';
import { node } from '@opentelemetry/sdk-node';

import { MAX_TOOL_ROUNDS, runAgent } from '../agent/agentCore.js';
import {
  OUTCOMES,
  createRequestStats,
  endOpenSpans,
  recordAgentFailure,
  recordAgentResult,
  requestStartAttributes,
  traceAnthropic,
  traceMcp,
  withSpan,
} from '../agent/agentTracing.js';

// In-memory provider instead of src/tracing.js's OTLP exporter, so nothing leaves
// the process. register() also installs the AsyncLocalStorage context manager and
// W3C propagator, the same defaults NodeSDK uses.
const exporter = new node.InMemorySpanExporter();
new node.NodeTracerProvider({ spanProcessors: [new node.SimpleSpanProcessor(exporter)] }).register();

const inventoryTool = {
  name: 'get_inventory_summary',
  description: 'inventory',
  inputSchema: { type: 'object', properties: { sort_by: { type: 'string' }, limit: { type: 'integer' } } },
};

const QUESTION = 'Show me my 5 most profitable cards SECRET_QUESTION';
const ROW_TEXT = '{"inventory":[{"name":"SECRET_CARD_ROW"}]}';

const toolUseResponse = (blocks) => ({
  model: 'test-model',
  stop_reason: 'tool_use',
  content: blocks.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })),
  usage: { input_tokens: 10, output_tokens: 5 },
});
const finalResponse = (text) => ({
  model: 'test-model',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 3 },
});

function fakeAnthropic(responses) {
  let calls = 0;
  return {
    messages: {
      create: async () => {
        const response = responses[Math.min(calls, responses.length - 1)];
        calls += 1;
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
}

function fakeMcp(result = { content: [{ type: 'text', text: ROW_TEXT }] }) {
  const calls = [];
  return {
    calls,
    callTool: async (params) => {
      calls.push(params);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

// Runs one traced agent request the way run-agent.js does.
async function tracedRun({ responses, mcpResult, maxRounds = MAX_TOOL_ROUNDS }) {
  exporter.reset();
  const mcp = fakeMcp(mcpResult);
  const result = await withSpan('agent.request', { attributes: requestStartAttributes('test-model') }, async (span) => {
    const stats = createRequestStats();
    try {
      const runResult = await runAgent({
        anthropic: traceAnthropic(fakeAnthropic(responses), stats),
        mcp: traceMcp(mcp, stats),
        model: 'test-model',
        question: QUESTION,
        mcpTools: [inventoryTool],
        maxRounds,
      });
      recordAgentResult(span, runResult);
      return runResult;
    } catch (error) {
      recordAgentFailure(span, stats);
      throw error;
    }
  });
  return { result, mcp, spans: exporter.getFinishedSpans() };
}

const byName = (spans, name) => spans.filter((span) => span.name === name);

test('one request produces a root span with Claude and MCP child spans in the same trace', async () => {
  const { result, mcp, spans } = await tracedRun({
    responses: [toolUseResponse([['t1', 'get_inventory_summary', { sort_by: 'unrealized_pnl', limit: 5 }]]), finalResponse('done')],
  });
  assert.equal(result.stopReason, 'end_turn');

  const [root] = byName(spans, 'agent.request');
  const claude = byName(spans, 'claude.messages.create');
  const [tool] = byName(spans, 'mcp.call_tool get_inventory_summary');
  assert.ok(root && tool);
  assert.equal(claude.length, 2);

  for (const span of [...claude, tool]) {
    assert.equal(span.spanContext().traceId, root.spanContext().traceId);
    assert.equal(span.parentSpanId, root.spanContext().spanId);
  }

  // Claude call 1 carries the question (round 0); its tool runs in round 1, and
  // Claude call 2 carries that round's results.
  assert.deepEqual(claude.map((span) => span.attributes['agent.round']), [0, 1]);
  assert.equal(tool.attributes['agent.round'], 1);
  assert.equal(tool.attributes['mcp.tool.name'], 'get_inventory_summary');
  assert.deepEqual(tool.attributes['mcp.tool.arg_keys'], ['sort_by', 'limit']);
  assert.equal(tool.attributes['agent.tool.status'], 'ok');
  assert.equal(typeof tool.attributes['agent.duration_ms'], 'number');

  assert.equal(claude[1].attributes['gen_ai.usage.input_tokens'], 20);
  assert.equal(claude[1].attributes['gen_ai.usage.output_tokens'], 7);
  assert.equal(claude[1].attributes['gen_ai.usage.cache_read_input_tokens'], 3);
  assert.deepEqual(claude[1].attributes['gen_ai.response.finish_reasons'], ['end_turn']);
  assert.equal(root.attributes['gen_ai.request.model'], 'test-model');
  assert.equal(root.attributes['agent.usage.input_tokens'], 30);
  assert.equal(root.attributes['agent.usage.output_tokens'], 12);
  assert.equal(root.attributes['gen_ai.usage.input_tokens'], undefined); // only on Claude spans
  assert.equal(root.attributes['agent.tool_call_count'], 1);
  assert.equal(root.attributes['agent.tool_round_count'], 1);
  assert.equal(root.attributes['agent.stop_reason'], 'end_turn');
  assert.equal(root.attributes['agent.outcome'], OUTCOMES.UNKNOWN);

  // The server receives the tool span as its parent through _meta.traceparent.
  const traceparent = mcp.calls[0]._meta.traceparent;
  assert.equal(traceparent, `00-${tool.spanContext().traceId}-${tool.spanContext().spanId}-01`);
  assert.equal(mcp.calls[0].name, 'get_inventory_summary');
  assert.deepEqual(mcp.calls[0].arguments, { sort_by: 'unrealized_pnl', limit: 5 });
});

test('no span records the question, argument values, or tool result content', async () => {
  const { spans } = await tracedRun({
    responses: [toolUseResponse([['t1', 'get_inventory_summary', { sort_by: 'SECRET_ARG' }]]), finalResponse('SECRET_ANSWER')],
  });
  const dump = JSON.stringify(spans.map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })));
  for (const secret of ['SECRET_QUESTION', 'SECRET_ARG', 'SECRET_CARD_ROW', 'SECRET_ANSWER']) {
    assert.ok(!dump.includes(secret), `${secret} leaked into span data`);
  }
});

test('tool errors and MCP failures end their spans with ERROR status', async () => {
  const toolError = await tracedRun({
    responses: [toolUseResponse([['t1', 'get_inventory_summary', {}]]), finalResponse('done')],
    mcpResult: { isError: true, content: [{ type: 'text', text: 'Error running tool: SECRET_CARD_ROW' }] },
  });
  const [errorSpan] = byName(toolError.spans, 'mcp.call_tool get_inventory_summary');
  assert.equal(errorSpan.status.code, SpanStatusCode.ERROR);
  assert.equal(errorSpan.attributes['agent.tool.status'], 'tool_error');
  assert.ok(!JSON.stringify(errorSpan.status).includes('SECRET_CARD_ROW'));

  const mcpError = await tracedRun({
    responses: [toolUseResponse([['t1', 'get_inventory_summary', {}]]), finalResponse('done')],
    mcpResult: new Error('Request timed out'),
  });
  const [thrownSpan] = byName(mcpError.spans, 'mcp.call_tool get_inventory_summary');
  assert.equal(thrownSpan.status.code, SpanStatusCode.ERROR);
  assert.equal(thrownSpan.attributes['agent.tool.status'], 'mcp_error');
  // agentCore still answers around the failure, as without tracing.
  assert.equal(mcpError.result.stopReason, 'end_turn');
});

test('rejected tool uses become events on the request span, not MCP calls', async () => {
  const { mcp, spans } = await tracedRun({
    responses: [toolUseResponse([['t1', 'create_tcgplayer_order', {}]]), finalResponse('done')],
  });
  assert.equal(mcp.calls.length, 0);
  const [root] = byName(spans, 'agent.request');
  assert.deepEqual(
    root.events.map((event) => [event.name, event.attributes['mcp.tool.name'], event.attributes['agent.round']]),
    [['tool_use_rejected', 'create_tcgplayer_order', 1]],
  );
});

test('a Claude API error ends both the Claude span and the request span, then propagates', async () => {
  await assert.rejects(tracedRun({ responses: [new Error('overloaded')] }), /overloaded/);
  const spans = exporter.getFinishedSpans();
  assert.deepEqual(spans.map((span) => span.name).sort(), ['agent.request', 'claude.messages.create']);
  for (const span of spans) assert.equal(span.status.code, SpanStatusCode.ERROR);
});

test('endOpenSpans closes spans still running when the process is interrupted', async () => {
  exporter.reset();
  let release;
  const pending = withSpan('agent.request', {}, () => new Promise((resolve) => { release = resolve; }));
  assert.equal(exporter.getFinishedSpans().length, 0);

  endOpenSpans('interrupted by SIGINT');
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.name, 'agent.request');
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.status.message, 'interrupted by SIGINT');

  release();
  await pending;
  assert.equal(exporter.getFinishedSpans().length, 1); // not ended a second time
});

test('agent.outcome stays unknown for end_turn, with or without tool calls', async () => {
  // A no-tool reply is often a clarifying question, but it can also be a direct
  // answer or a refusal, so it is not classified from the missing tool calls.
  const noTools = await tracedRun({ responses: [finalResponse('Which metric do you mean?')] });
  const [root] = byName(noTools.spans, 'agent.request');
  assert.equal(root.attributes['agent.outcome'], OUTCOMES.UNKNOWN);
  assert.equal(root.attributes['agent.tool_call_count'], 0);
  assert.equal(root.attributes['agent.tool_round_count'], 0);
  assert.equal(root.attributes['agent.usage.input_tokens'], 20);
});

test('max_tool_rounds is recorded as an error outcome with the observed counts', async () => {
  const { spans } = await tracedRun({
    responses: [toolUseResponse([['t1', 'get_inventory_summary', {}], ['t2', 'get_inventory_summary', {}]])],
    maxRounds: 2,
  });
  const [root] = byName(spans, 'agent.request');
  assert.equal(root.attributes['agent.outcome'], OUTCOMES.ERROR);
  assert.equal(root.attributes['agent.stop_reason'], 'max_tool_rounds');
  assert.equal(root.attributes['agent.tool_round_count'], 2);
  // Two tool uses per round were handled; the third response's were not.
  assert.equal(root.attributes['agent.tool_call_count'], 4);
  assert.equal(root.attributes['agent.usage.input_tokens'], 30); // three Claude calls x 10
});

test('a run that throws mid-loop records error, partial tokens, and no tool counts', async () => {
  await assert.rejects(
    tracedRun({ responses: [toolUseResponse([['t1', 'get_inventory_summary', {}]]), new Error('overloaded')] }),
    /overloaded/,
  );
  const [root] = byName(exporter.getFinishedSpans(), 'agent.request');
  assert.equal(root.attributes['agent.outcome'], OUTCOMES.ERROR);
  assert.equal(root.attributes['agent.usage.input_tokens'], 10); // the one call that returned
  assert.equal(root.attributes['agent.usage.output_tokens'], 5);
  assert.equal(root.attributes['agent.tool_call_count'], undefined);
  assert.equal(root.attributes['agent.tool_round_count'], undefined);
});

test('an interrupted request keeps the initial unknown outcome', async () => {
  exporter.reset();
  let release;
  const pending = withSpan('agent.request', { attributes: requestStartAttributes('test-model') }, () =>
    new Promise((resolve) => { release = resolve; }),
  );
  endOpenSpans('interrupted by SIGTERM');
  const [root] = exporter.getFinishedSpans();
  assert.equal(root.attributes['agent.outcome'], OUTCOMES.UNKNOWN);
  assert.equal(root.attributes['gen_ai.request.model'], 'test-model');
  release();
  await pending;
});
