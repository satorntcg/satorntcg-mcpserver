import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!url || !serviceKey) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Copy .env.example to .env and fill in your project credentials.'
  );
}

// Service-role client: this process runs locally/server-side only (stdio transport),
// never in a browser bundle, so it's safe to use the elevated key here.
export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});
