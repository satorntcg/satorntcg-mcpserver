// Argument parsing for get_inventory_summary, kept free of Supabase/tracing imports
// so it can be unit-tested without credentials.

// Public sort keys → v_inventory_dashboard columns.
export const SORT_FIELDS = {
  market_price: 'tcgplayer_market',
  total_value: 'market_value',
  quantity: 'quantity_owned',
  cost_basis: 'cost_basis',
  unrealized_pnl: 'unrealized_pnl',
};

// Sorts that only mean something for cards with a TCGplayer price. The view computes
// market_value as COALESCE(tcgplayer_market, 0) * quantity_owned, so an unpriced card
// would otherwise rank as a genuine $0 holding rather than "unknown".
export const PRICE_SORTS = new Set(['market_price', 'total_value', 'unrealized_pnl']);

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;

// The low-level MCP Server doesn't enforce inputSchema, so every argument is checked
// here. Throws on invalid input; index.js turns that into an isError tool result.
export function parseInventorySummaryArgs(args = {}) {
  // `??` rather than destructuring defaults so an explicit null also means "use the default".
  const { name_contains, set_name } = args ?? {};
  const sort_by = args?.sort_by ?? 'market_price';
  const sort_order = args?.sort_order ?? 'desc';
  const limit = args?.limit ?? DEFAULT_LIMIT;
  const include_unowned = args?.include_unowned ?? false;

  const optionalString = (value, field) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  if (!Object.hasOwn(SORT_FIELDS, sort_by)) {
    throw new Error(`sort_by must be one of: ${Object.keys(SORT_FIELDS).join(', ')}.`);
  }
  if (sort_order !== 'asc' && sort_order !== 'desc') {
    throw new Error('sort_order must be "asc" or "desc".');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  if (typeof include_unowned !== 'boolean') {
    throw new Error('include_unowned must be a boolean.');
  }

  return {
    name_contains: optionalString(name_contains, 'name_contains'),
    set_name: optionalString(set_name, 'set_name'),
    sort_by,
    sort_order,
    limit,
    include_unowned,
  };
}
