import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_TOOLS,
  MAX_TOOL_ROUNDS,
  executeToolUse,
  runAgent,
  selectAllowedTools,
  validateToolArgs,
} from '../agent/agentCore.js';

// Minimal stand-ins for the schemas the server advertises via tools/list.
const inventoryTool = {
  name: 'get_inventory_summary',
  description: 'inventory',
  inputSchema: {
    type: 'object',
    properties: {
      sort_by: { type: 'string', enum: ['market_price', 'unrealized_pnl'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
};
const pricesTool = {
  name: 'get_latest_prices',
  description: 'prices',
  inputSchema: { type: 'object', properties: { name_contains: { type: 'string' } } },
};
const writeTool = {
  name: 'create_tcgplayer_order',
  description: 'writes',
  inputSchema: { type: 'object', properties: {} },
};

function fakeMcp(result = { content: [{ type: 'text', text: '{"inventory":[{},{}]}' }] }) {
  const calls = [];
  return {
    calls,
    callTool: async (params) => {
      calls.push(params);
      return result;
    },
  };
}

// Returns the queued responses in order and repeats the last one once they run out.
function fakeAnthropic(responses) {
  const requests = [];
  return {
    requests,
    messages: {
      create: async (request) => {
        // Snapshot, since runAgent keeps appending to the same messages array.
        requests.push({ ...request, messages: [...request.messages] });
        return responses[Math.min(requests.length - 1, responses.length - 1)];
      },
    },
  };
}

const toolUseResponse = (blocks) => ({
  stop_reason: 'tool_use',
  content: blocks.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })),
  usage: { input_tokens: 10, output_tokens: 5 },
});
const finalResponse = (text) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

test('selectAllowedTools offers only the read-only allowlist', () => {
  const selected = selectAllowedTools([writeTool, pricesTool, inventoryTool]);
  assert.deepEqual(selected.map((tool) => tool.name), [...ALLOWED_TOOLS]);
});

test('selectAllowedTools fails if an allowlisted tool is missing from tools/list', () => {
  assert.throws(() => selectAllowedTools([inventoryTool, writeTool]), /get_latest_prices/);
});

test('a non-allowlisted tool_use is rejected without calling MCP', async () => {
  const mcp = fakeMcp();
  // Even if a write tool somehow ended up in the lookup map, the allowlist still blocks it.
  const toolsByName = new Map([inventoryTool, writeTool].map((tool) => [tool.name, tool]));
  const { toolResult, diagnostic } = await executeToolUse(
    { type: 'tool_use', id: 'toolu_1', name: 'create_tcgplayer_order', input: {} },
    { mcp, toolsByName },
  );
  assert.equal(mcp.calls.length, 0);
  assert.equal(toolResult.tool_use_id, 'toolu_1');
  assert.equal(toolResult.is_error, true);
  assert.equal(diagnostic.status, 'rejected');
});

test('invalid arguments are rejected before reaching MCP', async () => {
  const mcp = fakeMcp();
  const toolsByName = new Map([[inventoryTool.name, inventoryTool]]);
  for (const input of [{ limit: 500 }, { limit: '5' }, { sort_by: 'best' }, { drop_table: true }, null]) {
    const { toolResult } = await executeToolUse(
      { type: 'tool_use', id: 'toolu_x', name: 'get_inventory_summary', input },
      { mcp, toolsByName },
    );
    assert.equal(toolResult.is_error, true, `expected rejection for ${JSON.stringify(input)}`);
  }
  assert.equal(mcp.calls.length, 0);
});

test('validateToolArgs accepts arguments that match the schema', () => {
  assert.deepEqual(validateToolArgs(inventoryTool.inputSchema, { sort_by: 'unrealized_pnl', limit: 5 }), []);
  assert.deepEqual(validateToolArgs(inventoryTool.inputSchema, {}), []);
});

test('MCP isError results are passed back to Claude as error tool_results', async () => {
  const mcp = fakeMcp({ isError: true, content: [{ type: 'text', text: 'Error running get_latest_prices: boom' }] });
  const toolsByName = new Map([[pricesTool.name, pricesTool]]);
  const { toolResult, diagnostic } = await executeToolUse(
    { type: 'tool_use', id: 'toolu_2', name: 'get_latest_prices', input: { name_contains: 'Apprentice' } },
    { mcp, toolsByName },
  );
  assert.equal(toolResult.tool_use_id, 'toolu_2');
  assert.equal(toolResult.is_error, true);
  assert.equal(diagnostic.status, 'tool_error');
});

test('runAgent returns tool_results in tool_use order with matching IDs', async () => {
  const anthropic = fakeAnthropic([
    toolUseResponse([
      ['toolu_a', 'get_inventory_summary', { sort_by: 'unrealized_pnl', limit: 5 }],
      ['toolu_b', 'get_latest_prices', {}],
    ]),
    finalResponse('Here are your cards.'),
  ]);
  const mcp = fakeMcp();
  const result = await runAgent({
    anthropic, mcp, model: 'test-model', question: 'q', mcpTools: [inventoryTool, pricesTool],
  });

  assert.equal(result.answer, 'Here are your cards.');
  assert.equal(result.rounds, 1);
  assert.equal(mcp.calls.length, 2);
  // Second request carries user question, assistant tool_use turn, and the results.
  const history = anthropic.requests[1].messages;
  assert.equal(history.length, 3);
  assert.deepEqual(history[2].content.map((block) => block.tool_use_id), ['toolu_a', 'toolu_b']);
  assert.deepEqual(anthropic.requests[0].tool_choice, { type: 'auto' });
  assert.equal(anthropic.requests[0].max_tokens, 1024);
});

test('runAgent stops after MAX_TOOL_ROUNDS rounds of tool execution', async () => {
  // Claude asks for a tool on every turn and never gives a final answer.
  const anthropic = fakeAnthropic([toolUseResponse([['toolu_loop', 'get_latest_prices', {}]])]);
  const mcp = fakeMcp();
  const result = await runAgent({
    anthropic, mcp, model: 'test-model', question: 'q', mcpTools: [inventoryTool, pricesTool],
  });

  assert.equal(result.stopReason, 'max_tool_rounds');
  assert.equal(result.rounds, MAX_TOOL_ROUNDS);
  assert.equal(mcp.calls.length, MAX_TOOL_ROUNDS);
  // One request per round, plus the one whose tool request was refused.
  assert.equal(anthropic.requests.length, MAX_TOOL_ROUNDS + 1);
});
