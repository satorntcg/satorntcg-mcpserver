// CLI agent: answers one question about the SatornTCG inventory by letting Claude
// call the MCP server's read-only tools (get_inventory_summary, get_latest_prices).
// The loop itself lives in agent/agentCore.js; this file wires up the real
// Anthropic client and MCP server and prints the result.
//
// Usage: ANTHROPIC_MODEL=<model id> node agent/run-agent.js "Show me my 5 most profitable cards"
// ANTHROPIC_API_KEY is read from .env (or the shell, which takes precedence).
//
// Unlike evals/run-claude.js and test/mcp.test.js, this DOES execute tools against
// the real Supabase project (read-only views only).
//
// Tracing: each run is one agent.request trace (exported via src/tracing.js, as
// service satorntcg-agent) with a child span per Claude call and per MCP tool
// call; agent/agentTracing.js has the details. Set OTEL_SDK_DISABLED=true to
// turn it off.
//
// Metrics (agent/agentMetrics.js) are off unless OTEL_METRICS_EXPORTER is set:
// 'otlp' sends them to the local Collector (observability/), 'console' prints
// them to stderr when the process exits.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { initTracing } from '../src/tracing.js';
import { MAX_TOOL_ROUNDS, runAgent, selectAllowedTools } from './agentCore.js';
import { createAgentMetrics, createMetricReader } from './agentMetrics.js';
import {
  createRequestStats,
  endOpenSpans,
  markError,
  recordAgentFailure,
  recordAgentResult,
  requestStartAttributes,
  traceAnthropic,
  traceMcp,
  withSpan,
} from './agentTracing.js';

const agentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(agentDir, '..');
dotenv.config({ path: path.join(repoRoot, '.env') });

// After dotenv, so OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_SDK_DISABLED /
// OTEL_METRICS_EXPORTER from .env apply.
const shutdownTracing = initTracing({
  serviceName: 'satorntcg-agent',
  handleExit: false,
  metricReader: createMetricReader(process.env),
});
// After initTracing(), which registers the MeterProvider (see agentMetrics.js).
const agentMetrics = createAgentMetrics();

// Records agent.requests and agent.request.duration for the request in flight.
// Replaced per request by main(); a no-op until then, so a usage error (no
// request started) records nothing, matching the trace, which has no span then.
let finishRequestMetrics = () => {};

// Server stderr is kept only so a startup failure can show why it happened.
const MAX_STDERR_CHARS = 2000;

function describeApiError(error) {
  const status = error.status ? ` ${error.status}` : '';
  return `${error.constructor.name}${status}: ${error.message}`;
}

function printDiagnostics(result, model) {
  console.log('\n--- Diagnostics ---');
  console.log(`Model: ${model}`);
  console.log(`Stop reason: ${result.stopReason}`);
  console.log(`Tool rounds: ${result.rounds}/${MAX_TOOL_ROUNDS}`);
  console.log(`Tokens: ${result.usage.input_tokens} in, ${result.usage.output_tokens} out`);
  if (result.toolCalls.length === 0) {
    console.log('Tool calls: none');
    return;
  }
  console.log('Tool calls:');
  for (const call of result.toolCalls) {
    // Counts and sizes only; the returned rows themselves are never printed here.
    const parts = [`round ${call.round}`, call.name, JSON.stringify(call.args ?? {}), call.status];
    if (call.rowCount !== undefined && call.rowCount !== null) parts.push(`${call.rowCount} rows`);
    if (call.resultChars !== undefined) parts.push(`${call.resultChars} chars`);
    if (call.durationMs !== undefined) parts.push(`${call.durationMs}ms`);
    console.log(`  - ${parts.join(' | ')}`);
    if (call.detail) console.log(`    ${call.detail}`);
  }
}

async function main() {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('Usage: node agent/run-agent.js "<question>"');
    return 1;
  }
  const model = process.env.ANTHROPIC_MODEL?.trim();
  if (!model) {
    console.error('ANTHROPIC_MODEL is not set. Set it to an explicit model ID, e.g. ANTHROPIC_MODEL=claude-opus-5-5');
    return 1;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (expected in .env).');
    return 1;
  }

  const stats = createRequestStats();
  const request = agentMetrics.startRequest(model);
  // Reads stats.outcome when called, so it gets whatever the request ended with.
  finishRequestMetrics = () => request.end(stats.outcome);
  try {
    return await withSpan('agent.request', { attributes: requestStartAttributes(model) }, (span) =>
      runRequest({ question, model, span, stats }),
    );
  } finally {
    // Every exit path, including a throw, after the outcome is final.
    finishRequestMetrics();
  }
}

async function runRequest({ question, model, span, stats }) {
  // For runs that fail before runAgent() returns: sets the request span's error
  // status and outcome, and gives the exit code to return.
  const fail = (reason) => {
    markError(span, reason);
    recordAgentFailure(span, stats);
    return 1;
  };

  // No `env` is passed, so the SDK forwards only its minimal default environment
  // (PATH etc.) and nothing from this shell. The server loads its own Supabase
  // credentials from .env through src/env.js.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'src', 'index.js')],
    stderr: 'pipe',
  });
  let serverStderr = '';
  transport.stderr?.on('data', (chunk) => {
    serverStderr = (serverStderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
  });
  const mcp = new Client({ name: 'satorntcg-agent', version: '0.1.0' });

  try {
    // Server startup + tools/list, so the time before the first Claude call is
    // accounted for in the trace.
    const mcpTools = await withSpan('mcp.setup', {}, async (setupSpan) => {
      try {
        await mcp.connect(transport);
      } catch (error) {
        console.error(`MCP error: could not start or connect to the server: ${error.message}`);
        if (serverStderr.trim()) console.error(`Server stderr (tail):\n${serverStderr.trim()}`);
        markError(setupSpan, error);
        return null;
      }
      try {
        const { tools } = await mcp.listTools();
        return selectAllowedTools(tools);
      } catch (error) {
        console.error(`MCP error during tools/list: ${error.message}`);
        markError(setupSpan, error);
        return null;
      }
    });
    if (!mcpTools) return fail('MCP setup failed');

    const result = await runAgent({
      anthropic: traceAnthropic(new Anthropic(), stats, agentMetrics),
      mcp: traceMcp(mcp, stats, agentMetrics),
      model,
      question,
      mcpTools,
    });
    stats.outcome = recordAgentResult(span, result);

    console.log(result.answer || '(Claude returned no text.)');
    if (result.stopReason === 'max_tool_rounds') {
      console.log(`\n[Stopped: Claude still wanted tools after ${MAX_TOOL_ROUNDS} rounds; the answer above may be incomplete.]`);
    } else if (result.stopReason === 'max_tokens') {
      console.log('\n[Stopped: the answer hit max_tokens and may be cut off.]');
    }
    printDiagnostics(result, model);
    if (result.stopReason === 'max_tool_rounds') {
      // recordAgentResult() already set agent.outcome and the counts.
      markError(span, 'max_tool_rounds');
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(`Anthropic API error: ${describeApiError(error)}`);
      return fail(error);
    }
    // withSpan() records the exception and status; only the outcome is added here.
    recordAgentFailure(span, stats);
    throw error;
  } finally {
    // Closes the transport and stops the server child process (SIGTERM, then SIGKILL).
    await mcp.close().catch((error) => console.error(`Error closing MCP connection: ${error.message}`));
  }
}

// Ctrl+C / kill mid-request: record the request's metrics (outcome 'unknown',
// as on the span), close the open spans as interrupted, and flush both before
// exiting, with the conventional 128 + signal number exit code. The MCP
// server child gets the same signal from the terminal, or exits once our end of
// its stdin pipe closes.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, async () => {
    finishRequestMetrics();
    endOpenSpans(`interrupted by ${signal}`);
    await shutdownTracing();
    process.exit(code);
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`Unexpected error: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  })
  // Spans and metrics are exported on timers that don't keep the process
  // alive, so flush explicitly or the whole trace and all metrics are lost.
  .finally(shutdownTracing);
