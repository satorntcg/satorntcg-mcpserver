// Live tool-selection eval: sends each question in tool-selection.json to Claude
// with the server's real get_inventory_summary/get_latest_prices definitions and
// checks which tool (and arguments) Claude picks — or, for cases whose
// expected_behavior isn't tool_call, that it picks none. No tool is ever executed.
//
// Usage: ANTHROPIC_MODEL=<model id> node evals/run-claude.js [--repeat N]
// --repeat N sends each case N independent times (default 1), sequentially.
// ANTHROPIC_API_KEY is read from .env (or the shell, which takes precedence).

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const evalsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(evalsDir, '..');
dotenv.config({ path: path.join(repoRoot, '.env') });

const TOOL_NAMES = ['get_inventory_summary', 'get_latest_prices'];
// Cases without expected_behavior default to tool_call. Every other behavior is
// checked only as "no tool was called" — whether the answer, clarification, or
// limitation is actually good is left to manual (or later automated) review.
const BEHAVIORS = ['tool_call', 'direct_answer', 'clarification', 'refusal_or_limitation'];
const MAX_TOKENS = 4096; // room for thinking on models where it's always on

// Sent with every case. "Best" and "top" have no single meaning for a card
// inventory, and guessing a metric would return a confidently wrong ranking.
const SYSTEM_PROMPT = `You help a trading card seller look up their inventory and prices.

Inventory cards can be ranked by three metrics: market price (per-card value), total inventory value (market price times quantity owned), and unrealized profit (market value minus cost basis). When the user asks for their "best" or "top" cards without saying which of these they mean, ask which metric they want instead of calling a tool, since each one produces a different ranking. If the request names or clearly implies a metric (for example "most valuable", "most total value", or "most profitable"), use it without asking.`;

// Same discovery-only setup as test/mcp.test.js: the server needs these to boot,
// but tools/list never touches Supabase or TCGplayer. The SDK forwards only a
// minimal default environment plus this object, so real keys (including
// ANTHROPIC_API_KEY) never reach the child process.
const placeholderEnv = {
  SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_KEY: 'placeholder-not-a-real-key',
  TCGPLAYER_COOKIE: 'placeholder-not-a-real-cookie',
  OTEL_SDK_DISABLED: 'true',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9/v1/traces',
};

// 4xx errors that will fail identically for every remaining case (bad key,
// unknown model, malformed request) — stop instead of repeating the call.
const FATAL_API_ERRORS = [
  Anthropic.AuthenticationError,
  Anthropic.PermissionDeniedError,
  Anthropic.NotFoundError,
  Anthropic.BadRequestError,
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function listMcpTools() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'src', 'index.js')],
    env: placeholderEnv,
    stderr: 'pipe', // keep the server's startup logs out of the report
  });
  const client = new Client({ name: 'satorntcg-eval-runner', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
  }
}

// MCP tools/list uses camelCase `inputSchema`; the Messages API wants `input_schema`.
function toAnthropicTool(mcpTool) {
  return {
    name: mcpTool.name,
    description: mcpTool.description,
    input_schema: mcpTool.inputSchema,
  };
}

function indent(text) {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

function describeApiError(error) {
  const status = error.status ? ` ${error.status}` : '';
  return `${error.constructor.name}${status}: ${error.message}`;
}

const { values: cliArgs } = parseArgs({ options: { repeat: { type: 'string', default: '1' } } });
const repeat = Number(cliArgs.repeat);
if (!Number.isInteger(repeat) || repeat < 1) {
  fail(`--repeat must be a positive integer, got "${cliArgs.repeat}".`);
}

// Appends "(run i/N)" only when repeating, so single-run output is unchanged.
function label(result) {
  return repeat > 1 ? `${result.testCase.question} (run ${result.run}/${repeat})` : result.testCase.question;
}

const model = process.env.ANTHROPIC_MODEL?.trim();
if (!model) {
  fail('ANTHROPIC_MODEL is not set. Set it to an explicit model ID, e.g. ANTHROPIC_MODEL=claude-opus-5-5');
}
if (!process.env.ANTHROPIC_API_KEY) {
  fail('ANTHROPIC_API_KEY is not set (expected in .env).');
}

const cases = JSON.parse(fs.readFileSync(path.join(evalsDir, 'tool-selection.json'), 'utf8'));
for (const testCase of cases) {
  testCase.expected_behavior ??= 'tool_call';
  if (!BEHAVIORS.includes(testCase.expected_behavior)) {
    fail(`Unknown expected_behavior "${testCase.expected_behavior}" for: ${testCase.question}`);
  }
}

const mcpTools = await listMcpTools();
const tools = TOOL_NAMES.map((name) => {
  const tool = mcpTools.find((candidate) => candidate.name === name);
  if (!tool) fail(`MCP server did not list ${name} via tools/list.`);
  return toAnthropicTool(tool);
});

const anthropic = new Anthropic();
const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const results = [];

console.log(`Model: ${model}`);
console.log(`Tools: ${tools.map((tool) => tool.name).join(', ')}`);
console.log(`Cases: ${cases.length}`);
console.log(`Runs per case: ${repeat}\n`);

// Each attempt is an independent single-turn request; nothing carries over between runs.
const attempts = cases.flatMap((testCase) =>
  Array.from({ length: repeat }, (_, i) => ({ testCase, run: i + 1 })),
);

for (const [index, { testCase, run }] of attempts.entries()) {
  let response;
  try {
    response = await anthropic.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: testCase.question }],
    });
  } catch (error) {
    if (!(error instanceof Anthropic.APIError)) throw error;
    const errored = { testCase, run, apiError: describeApiError(error) };
    results.push(errored);
    console.log(`API ERROR: ${label(errored)}\n  ${errored.apiError}`);
    if (FATAL_API_ERRORS.some((ErrorClass) => error instanceof ErrorClass)) {
      for (const skipped of attempts.slice(index + 1)) {
        results.push({ ...skipped, apiError: 'skipped after non-retryable API error' });
      }
      console.log(`  Non-retryable error; skipping ${attempts.length - index - 1} remaining request(s).`);
      break;
    }
    continue;
  }

  for (const key of Object.keys(usage)) {
    usage[key] += response.usage?.[key] ?? 0;
  }

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  const actualTool = toolUse?.name ?? null;
  const actualArgs = toolUse?.input ?? {};
  const responseText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const result = { testCase, run, actualTool, actualArgs, responseText, stopReason: response.stop_reason };

  if (testCase.expected_behavior === 'tool_call') {
    result.toolCorrect = actualTool === testCase.expected_tool;
    result.argMismatches = Object.entries(testCase.expected_args ?? {})
      .filter(([key, expected]) => !isDeepStrictEqual(actualArgs[key], expected))
      .map(([key, expected]) => ({ key, expected, actual: actualArgs[key] }));
    result.passed = result.toolCorrect && result.argMismatches.length === 0;
  } else {
    // The only automated check for non-tool cases: Claude must not call a tool.
    result.passed = actualTool === null;
  }

  results.push(result);
  console.log(`${result.passed ? 'PASS' : 'FAIL'} [${testCase.expected_behavior}]: ${label(result)}`);
}

const evaluated = results.filter((result) => !result.apiError);
const apiErrors = results.filter((result) => result.apiError);
const toolCases = evaluated.filter((result) => result.testCase.expected_behavior === 'tool_call');
const noToolCases = evaluated.filter((result) => result.testCase.expected_behavior !== 'tool_call');
const toolCorrectCount = toolCases.filter((result) => result.toolCorrect).length;
const argsPassedCount = toolCases.filter((result) => result.passed).length;
const noToolPassedCount = noToolCases.filter((result) => result.passed).length;
const passedCount = evaluated.filter((result) => result.passed).length;
const pct = (n, d) => (d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`);

console.log('\n=== Results ===');
console.log(`Evaluated: ${evaluated.length}/${attempts.length} requests (API errors excluded)`);

console.log('\nTool-call cases:');
console.log(`  Tool selection accuracy: ${toolCorrectCount}/${toolCases.length} (${pct(toolCorrectCount, toolCases.length)})`);
console.log(`  Argument accuracy (of correct-tool cases): ${argsPassedCount}/${toolCorrectCount} (${pct(argsPassedCount, toolCorrectCount)})`);

console.log('\nBehavioral checks (non-tool cases):');
console.log(`  No tool called: ${noToolPassedCount}/${noToolCases.length} (${pct(noToolPassedCount, noToolCases.length)})`);
console.log('  Checks only that no tool was called. Whether the explanation, clarification,');
console.log('  or limitation is correct is NOT verified; review the responses below.');

console.log('\nPer-case pass counts:');
for (const testCase of cases) {
  const caseResults = results.filter((result) => result.testCase === testCase);
  const caseEvaluated = caseResults.filter((result) => !result.apiError);
  const casePassed = caseEvaluated.filter((result) => result.passed).length;
  const errorNote = caseResults.length > caseEvaluated.length
    ? ` (${caseResults.length - caseEvaluated.length} API error/skipped)`
    : '';
  console.log(`  ${casePassed}/${caseEvaluated.length} (${pct(casePassed, caseEvaluated.length)}) [${testCase.expected_behavior}] ${testCase.question}${errorNote}`);
}

console.log(`\nOverall automated-check pass rate (all runs): ${passedCount}/${evaluated.length} (${pct(passedCount, evaluated.length)})`);

const failures = evaluated.filter((result) => !result.passed);
if (failures.length > 0) {
  console.log('\n=== Evaluation failures ===');
  for (const result of failures) {
    console.log(`- [${result.testCase.expected_behavior}] ${label(result)}`);
    if (result.testCase.expected_behavior !== 'tool_call') {
      console.log(`  Expected no tool call, got ${result.actualTool} ${JSON.stringify(result.actualArgs)}`);
      continue;
    }
    if (!result.actualTool) {
      console.log(`  No tool selected (stop_reason: ${result.stopReason})`);
      if (result.responseText) console.log(`  Response text: ${result.responseText}`);
      continue;
    }
    if (!result.toolCorrect) {
      console.log(`  Tool: expected ${result.testCase.expected_tool}, got ${result.actualTool}`);
    }
    for (const { key, expected, actual } of result.argMismatches) {
      console.log(`  ${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    console.log(`  Actual args: ${JSON.stringify(result.actualArgs)}`);
  }
}

if (noToolCases.length > 0) {
  console.log('\n=== Non-tool responses (for manual review) ===');
  for (const result of noToolCases) {
    console.log(`- [${result.testCase.expected_behavior}] ${label(result)} (stop_reason: ${result.stopReason})`);
    console.log(result.responseText ? indent(result.responseText) : '  (no text in response)');
  }
}

if (apiErrors.length > 0) {
  console.log('\n=== API errors (not counted as model failures) ===');
  for (const result of apiErrors) {
    console.log(`- ${label(result)}\n  ${result.apiError}`);
  }
}

console.log('\n=== Token usage ===');
for (const [key, value] of Object.entries(usage)) {
  if (value > 0 || key === 'input_tokens' || key === 'output_tokens') console.log(`${key}: ${value}`);
}

process.exitCode = failures.length > 0 || apiErrors.length > 0 ? 1 : 0;
