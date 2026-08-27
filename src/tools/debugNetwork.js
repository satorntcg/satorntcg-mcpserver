import util from 'util';

// TEMPORARY diagnostic tool — safe to remove once the fetch-failed issue is resolved.
// Tests outbound HTTPS from this exact process in two ways:
//   1. A generic, unrelated HTTPS endpoint (isolates "is networking broken at all")
//   2. The actual configured Supabase URL (isolates "is it Supabase-specific")
// Logs full error detail (not just .message) since some failures don't populate err.cause.
export const debugNetworkTool = {
  name: 'debug_network',
  description:
    'DIAGNOSTIC ONLY: tests outbound HTTPS connectivity from this server process to a generic endpoint and to the configured Supabase URL, returning full error detail for troubleshooting.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const results = {};

    // Test 1: generic external HTTPS endpoint
    try {
      const res = await fetch('https://api.github.com', { method: 'GET' });
      results.generic_https = { ok: true, status: res.status };
    } catch (err) {
      results.generic_https = {
        ok: false,
        message: err.message,
        full: util.inspect(err, { depth: 10, showHidden: false }),
      };
    }

    // Test 2: the actual configured Supabase URL
    const supabaseUrl = process.env.SUPABASE_URL;
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/`, {
        method: 'GET',
        headers: { apikey: process.env.SUPABASE_SERVICE_KEY ?? '' },
      });
      results.supabase_rest = { ok: true, status: res.status, url_used: supabaseUrl };
    } catch (err) {
      results.supabase_rest = {
        ok: false,
        url_used: supabaseUrl,
        message: err.message,
        full: util.inspect(err, { depth: 10, showHidden: false }),
      };
    }

    return results;
  },
};
