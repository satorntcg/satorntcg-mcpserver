// Minimal eBay Browse API client: application-token OAuth (client credentials) plus
// item_summary/search. No Supabase imports, so it can be tested with a fake fetch.
//
// Credentials: EBAY_CLIENT_ID / EBAY_CLIENT_SECRET, falling back to EBAY_APP_ID /
// EBAY_CERT_ID — the names the Supabase daily_price_check Edge Function already uses
// for the same eBay app (that function's secrets live in Supabase, so they still have
// to be copied into this server's .env).

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const TAXONOMY_URL = 'https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_subtree';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';
const REQUEST_TIMEOUT_MS = 20_000;
// Refresh a little early so a token never expires mid-scan.
const TOKEN_SAFETY_MS = 5 * 60_000;

export const CCG_INDIVIDUAL_CARDS_CATEGORY = '183454';
export const PAGE_SIZE = 200; // Browse API max per page

export function readEbayCredentials(env = process.env) {
  const clientId = env.EBAY_CLIENT_ID || env.EBAY_APP_ID;
  const clientSecret = env.EBAY_CLIENT_SECRET || env.EBAY_CERT_ID;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing eBay credentials. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env ' +
        '(the production App ID / Cert ID from developer.ebay.com — the same pair the ' +
        'daily_price_check Edge Function uses as EBAY_APP_ID / EBAY_CERT_ID).'
    );
  }
  return { clientId, clientSecret };
}

async function ebayError(res, what) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body.errors?.map((e) => e.longMessage || e.message).join('; ') || body.error_description || '';
  } catch {
    /* body wasn't JSON */
  }
  const hint = res.status === 429 ? ' (rate limited — Browse API allows ~5,000 calls/day)' : '';
  return new Error(`eBay ${what} failed: HTTP ${res.status}${hint}${detail ? ` — ${detail}` : ''}`);
}

export function createEbayClient({ fetchImpl = fetch, env = process.env, now = () => Date.now() } = {}) {
  let cached = null; // { token, expiresAt }

  async function getToken() {
    if (cached && cached.expiresAt > now()) return cached.token;
    const { clientId, clientSecret } = readEbayCredentials(env);
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw await ebayError(res, 'OAuth token request');
    const body = await res.json();
    const ttlMs = (Number(body.expires_in) || 7200) * 1000;
    cached = { token: body.access_token, expiresAt: now() + ttlMs - TOKEN_SAFETY_MS };
    return cached.token;
  }

  async function authedGet(url, what) {
    const token = await getToken();
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401) cached = null; // token revoked/expired early; next call refreshes
    if (!res.ok) throw await ebayError(res, what);
    return res.json();
  }

  // One page of search results. `filter` is the raw Browse filter string.
  async function searchPage({ q, filter, sort, offset = 0, limit = PAGE_SIZE, categoryId = CCG_INDIVIDUAL_CARDS_CATEGORY }) {
    const params = new URLSearchParams({ q, category_ids: categoryId, filter, limit: String(limit), offset: String(offset) });
    if (sort) params.set('sort', sort);
    const body = await authedGet(`${SEARCH_URL}?${params}`, `search "${q}"`);
    return {
      items: body.itemSummaries ?? [],
      total: body.total ?? 0,
      hasNext: Boolean(body.next),
    };
  }

  // Looks up a category's name so callers can confirm the ID means what they think.
  async function getCategoryName(categoryId = CCG_INDIVIDUAL_CARDS_CATEGORY) {
    const body = await authedGet(`${TAXONOMY_URL}?category_id=${encodeURIComponent(categoryId)}`, 'category lookup');
    const node = body.categorySubtreeNode;
    return node?.category?.categoryName ?? null;
  }

  return { getToken, searchPage, getCategoryName };
}

// Shared default client, so the token cache survives across tool calls in one server process.
let defaultClient = null;
export function getDefaultEbayClient() {
  defaultClient ??= createEbayClient();
  return defaultClient;
}
