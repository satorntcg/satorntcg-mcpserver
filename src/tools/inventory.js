import { supabase } from '../supabaseClient.js';
import { withDbSpan } from '../dbSpan.js';
import {
  SORT_FIELDS,
  PRICE_SORTS,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  parseInventorySummaryArgs,
} from './inventoryArgs.js';

export { parseInventorySummaryArgs };

// User text goes into ILIKE patterns, so % and _ must match literally.
const escapeLike = (value) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

function applyFilters(query, { name_contains, set_name, include_unowned }) {
  if (!include_unowned) query = query.gt('quantity_owned', 0);
  // Exact set match, but case-insensitive so "gothic" finds "Gothic".
  if (set_name) query = query.ilike('set_name', escapeLike(set_name));
  if (name_contains) query = query.ilike('name', `%${escapeLike(name_contains)}%`);
  return query;
}

export async function getInventorySummary(args, client = supabase) {
  const opts = parseInventorySummaryArgs(args);
  const column = SORT_FIELDS[opts.sort_by];
  const priceSort = PRICE_SORTS.has(opts.sort_by);

  let query = applyFilters(client.from('v_inventory_dashboard').select('*'), opts);
  // Unpriced cards can't be ranked by value; they're counted separately below instead.
  if (priceSort) query = query.not('tcgplayer_market', 'is', null);
  query = query
    // nullsFirst: false keeps rows missing the sort value (e.g. no cost basis) at the
    // bottom in both directions — Postgres puts NULLs first on DESC by default.
    .order(column, { ascending: opts.sort_order === 'asc', nullsFirst: false })
    .order('name', { ascending: true })
    .limit(opts.limit);

  const unpricedQuery = priceSort
    ? applyFilters(
        client.from('v_inventory_dashboard').select('id', { count: 'exact', head: true }),
        opts
      ).is('tcgplayer_market', null)
    : null;

  const [result, unpricedResult] = await Promise.all([
    withDbSpan('v_inventory_dashboard', () => query),
    unpricedQuery ? withDbSpan('v_inventory_dashboard', () => unpricedQuery) : null,
  ]);
  if (result.error) throw new Error(result.error.message || `HTTP ${result.status}`);
  // The count is supplementary, so a failure there (already recorded on its db.query
  // span) degrades to null instead of failing the whole call.

  const inventory = (result.data ?? []).map((row) => {
    const priceMissing = row.tcgplayer_market === null || row.tcgplayer_market === undefined;
    return {
      ...row,
      // Report unknown value as null rather than the view's COALESCE'd $0.
      market_value: priceMissing ? null : row.market_value,
      price_missing: priceMissing,
    };
  });

  return {
    inventory,
    sort: { sort_by: opts.sort_by, column, sort_order: opts.sort_order },
    ...(priceSort && {
      unpriced_excluded_count: unpricedResult.error ? null : (unpricedResult.count ?? 0),
    }),
  };
}

export const getInventorySummaryTool = {
  name: 'get_inventory_summary',
  description:
    'Get owned inventory from the dashboard: quantities owned/listed, latest TCGplayer prices, and cost basis. ' +
    'Each row has two different value fields: tcgplayer_market is the price of ONE copy of the card, while ' +
    'market_value is the total value of ALL copies owned (tcgplayer_market x quantity_owned). ' +
    'Use sort_by "market_price" for "what are my most valuable cards" and "total_value" for "where is most of my ' +
    'money tied up". Cards with no TCGplayer price have price_missing: true and market_value null; price-based ' +
    'sorts leave them out and report how many in unpriced_excluded_count. Only cards with quantity_owned > 0 are ' +
    'returned unless include_unowned is true.',
  inputSchema: {
    type: 'object',
    properties: {
      name_contains: {
        type: 'string',
        description: 'Optional case-insensitive filter on card name.',
      },
      set_name: {
        type: 'string',
        description: 'Optional exact set name filter (case-insensitive), e.g. "Gothic".',
      },
      sort_by: {
        type: 'string',
        enum: Object.keys(SORT_FIELDS),
        default: 'market_price',
        description:
          'market_price ranks by the price of a single copy; total_value ranks by the combined value of all ' +
          'copies owned; quantity by copies owned; cost_basis by per-card cost; unrealized_pnl by total ' +
          'unrealized gain/loss across copies owned.',
      },
      sort_order: {
        type: 'string',
        enum: ['asc', 'desc'],
        default: 'desc',
        description: 'Sort direction.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        default: DEFAULT_LIMIT,
        description: 'Max rows to return.',
      },
      include_unowned: {
        type: 'boolean',
        default: false,
        description: 'Also return cards with quantity_owned = 0 (catalog entries you no longer hold).',
      },
    },
  },
  handler: (args) => getInventorySummary(args),
};

export const getLatestPricesTool = {
  name: 'get_latest_prices',
  description:
    'Get latest TCGplayer market prices and cost basis for cards, optionally filtered by name. Use for "what is X worth" or "what did I pay vs. what is it worth now" questions.',
  inputSchema: {
    type: 'object',
    properties: {
      name_contains: {
        type: 'string',
        description: 'Optional case-insensitive filter on card name.',
      },
      limit: {
        type: 'number',
        default: 50,
      },
    },
  },
  handler: async ({ name_contains, limit = 50 }) => {
    let query = supabase
      .from('v_latest_prices')
      .select('card_id, name, set_name, rarity, foil, tcg_market_price, cost_basis')
      .order('name')
      .limit(limit);
    if (name_contains) {
      query = query.ilike('name', `%${name_contains}%`);
    }
    const { data, error } = await withDbSpan('v_latest_prices', () => query);
    if (error) throw new Error(error.message);
    return { prices: data ?? [] };
  },
};
