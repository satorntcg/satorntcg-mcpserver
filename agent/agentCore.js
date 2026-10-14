// Agent-loop logic for agent/run-agent.js. Kept free of SDK, dotenv, Supabase and
// tracing imports (same split as src/tools/inventoryArgs.js) so tests can drive the
// loop with fake Anthropic and MCP clients and never touch the network.

// Read-only tools Claude may call. Anything else the MCP server lists (order
// creation, packing slips, debug tools) is never offered and never executed.
export const ALLOWED_TOOLS = Object.freeze(['get_inventory_summary', 'get_latest_prices']);
export const MAX_TOOL_ROUNDS = 5;
export const MAX_TOKENS = 1024;

// Keeps diagnostics short and keeps tool output (inventory rows) out of them.
const MAX_DETAIL_CHARS = 200;

// Same guidance as evals/run-claude.js: "best" and "top" have no single meaning
// for a card inventory, and guessing a metric returns a confidently wrong ranking.
export const SYSTEM_PROMPT = `You help a trading card seller look up their inventory and prices.

Inventory cards can be ranked by three metrics: market price (per-card value), total inventory value (market price times quantity owned), and unrealized profit (market value minus cost basis). When the user asks for their "best" or "top" cards without saying which of these they mean, ask which metric they want instead of calling a tool, since each one produces a different ranking. If the request names or clearly implies a metric (for example "most valuable", "most total value", or "most profitable"), use it without asking.`;

// Returns the allowlisted tools from a tools/list response, in ALLOWED_TOOLS order.
export function selectAllowedTools(mcpTools, allowed = ALLOWED_TOOLS) {
  return allowed.map((name) => {
    const tool = mcpTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`MCP server did not list ${name} via tools/list.`);
    return tool;
  });
}

// MCP tools/list uses camelCase `inputSchema`; the Messages API wants `input_schema`.
export function toAnthropicTool(mcpTool) {
  return {
    name: mcpTool.name,
    description: mcpTool.description,
    input_schema: mcpTool.inputSchema,
  };
}

const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
};

const quoteKey = (key) => JSON.stringify(String(key).slice(0, 50));

// Checks model-supplied arguments against the tool's MCP inputSchema before the call
// is forwarded. Covers the flat subset the allowlisted tools use (type, enum,
// minimum, maximum, required) and fails closed on anything else: unknown keys, null
// values and unsupported schema types are all rejected. The server still runs its
// own validation (parseInventorySummaryArgs etc.); this is an extra layer, not a
// replacement. Returns a list of error strings, empty when the arguments are valid.
export function validateToolArgs(schema, args) {
  if (schema?.type !== 'object') return ['tool schema is not an object schema'];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['arguments must be a JSON object'];
  }

  const properties = schema.properties ?? {};
  const errors = [];
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key)) errors.push(`${quoteKey(key)} is required`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) {
      errors.push(`unknown argument ${quoteKey(key)}`);
      continue;
    }
    const prop = properties[key];
    const check = TYPE_CHECKS[prop.type];
    if (!check) {
      errors.push(`${quoteKey(key)} has unsupported schema type ${quoteKey(prop.type)}`);
      continue;
    }
    if (!check(value)) {
      errors.push(`${quoteKey(key)} must be of type ${prop.type}`);
      continue;
    }
    if (prop.enum && !prop.enum.includes(value)) {
      errors.push(`${quoteKey(key)} must be one of: ${prop.enum.join(', ')}`);
    }
    if (prop.minimum !== undefined && value < prop.minimum) {
      errors.push(`${quoteKey(key)} must be >= ${prop.minimum}`);
    }
    if (prop.maximum !== undefined && value > prop.maximum) {
      errors.push(`${quoteKey(key)} must be <= ${prop.maximum}`);
    }
  }
  return errors;
}

const truncate = (text) =>
  text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;

// Row count for diagnostics, taken from the first array in the tool's JSON result.
// It's only a count, so the rows themselves never reach the console.
function countRows(text) {
  try {
    const parsed = JSON.parse(text);
    const rows = Object.values(parsed ?? {}).find(Array.isArray);
    return rows ? rows.length : null;
  } catch {
    return null;
  }
}

// MCP results can contain non-text content, which the tools here never return.
// Pass a marker instead of silently dropping it.
function toToolResultContent(mcpContent = []) {
  const blocks = mcpContent.map((item) =>
    item.type === 'text'
      ? { type: 'text', text: item.text }
      : { type: 'text', text: `[unsupported MCP content type: ${item.type}]` },
  );
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '(tool returned no content)' }];
}

function errorResult(toolUseId, message) {
  return { type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: message };
}

// Runs one tool_use block. Always returns a tool_result for the same tool_use_id
// (the API requires one per tool_use), plus a diagnostic without row data.
export async function executeToolUse(block, { mcp, toolsByName, allowed = ALLOWED_TOOLS }) {
  const diagnostic = { id: block.id, name: block.name, args: block.input };

  if (!allowed.includes(block.name) || !toolsByName.has(block.name)) {
    diagnostic.status = 'rejected';
    diagnostic.detail = 'tool is not allowlisted';
    return {
      toolResult: errorResult(block.id, `Tool "${block.name}" is not available. Use only: ${allowed.join(', ')}.`),
      diagnostic,
    };
  }

  const argErrors = validateToolArgs(toolsByName.get(block.name).inputSchema, block.input);
  if (argErrors.length > 0) {
    diagnostic.status = 'rejected';
    diagnostic.detail = truncate(`invalid arguments: ${argErrors.join('; ')}`);
    return {
      toolResult: errorResult(block.id, `Invalid arguments for ${block.name}: ${argErrors.join('; ')}`),
      diagnostic,
    };
  }

  const startedAt = performance.now();
  try {
    const result = await mcp.callTool({ name: block.name, arguments: block.input });
    const content = toToolResultContent(result.content);
    const text = content.map((item) => item.text).join('\n');
    diagnostic.status = result.isError ? 'tool_error' : 'ok';
    diagnostic.resultChars = text.length;
    if (result.isError) diagnostic.detail = truncate(text);
    else diagnostic.rowCount = countRows(text);
    return {
      toolResult: {
        type: 'tool_result',
        tool_use_id: block.id,
        ...(result.isError && { is_error: true }),
        content,
      },
      diagnostic,
    };
  } catch (error) {
    // Protocol-level failures (timeout, server crashed, unknown tool). Claude gets an
    // error result and can answer around it; the loop itself keeps going.
    diagnostic.status = 'mcp_error';
    diagnostic.detail = truncate(error.message ?? String(error));
    return { toolResult: errorResult(block.id, `MCP error calling ${block.name}: ${error.message}`), diagnostic };
  } finally {
    diagnostic.durationMs = Math.round(performance.now() - startedAt);
  }
}

const textOf = (content) =>
  content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

// Sends the question to Claude and runs tool calls until Claude answers without
// requesting a tool, or until maxRounds rounds of tool execution have happened.
// `anthropic` needs messages.create() and `mcp` needs callTool(), so tests can pass
// fakes. API errors are not caught here; they propagate to the caller.
export async function runAgent({ anthropic, mcp, model, question, mcpTools, maxRounds = MAX_TOOL_ROUNDS }) {
  const toolsByName = new Map(mcpTools.map((tool) => [tool.name, tool]));
  const tools = mcpTools.map(toAnthropicTool);
  const messages = [{ role: 'user', content: question }];
  const toolCalls = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let rounds = 0;

  for (;;) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools,
      tool_choice: { type: 'auto' },
      messages,
    });
    usage.input_tokens += response.usage?.input_tokens ?? 0;
    usage.output_tokens += response.usage?.output_tokens ?? 0;

    // The full content goes back unchanged (including any thinking blocks), so the
    // next request carries the complete history.
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((block) => block.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { answer: textOf(response.content), stopReason: response.stop_reason, rounds, toolCalls, usage, messages };
    }
    if (rounds >= maxRounds) {
      return { answer: textOf(response.content), stopReason: 'max_tool_rounds', rounds, toolCalls, usage, messages };
    }

    rounds += 1;
    // One tool_result per tool_use, in the same order, all in a single user message.
    const toolResults = [];
    for (const block of toolUses) {
      const { toolResult, diagnostic } = await executeToolUse(block, { mcp, toolsByName });
      toolResults.push(toolResult);
      toolCalls.push({ round: rounds, ...diagnostic });
    }
    messages.push({ role: 'user', content: toolResults });
  }
}
