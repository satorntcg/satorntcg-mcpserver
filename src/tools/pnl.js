import { supabase } from '../supabaseClient.js';
import { withDbSpan } from '../dbSpan.js';

export const getBoxPnlTool = {
  name: 'get_box_pnl',
  description:
    'Get profit & loss per box entry (purchase price vs. realized/unrealized value of pulled cards). One entry can cover several sealed boxes (box_count); purchase_price and pack_count are totals for the whole entry. Entries marked exclude_from_pnl are skipped. Use for "was Box X worth it" or "how is Gothic performing overall" questions.',
  inputSchema: {
    type: 'object',
    properties: {
      box_id: {
        type: 'string',
        description: 'Optional specific box id to filter to. Omit to get all boxes.',
      },
      limit: {
        type: 'number',
        default: 50,
      },
    },
  },
  handler: async ({ box_id, limit = 50 }) => {
    // box_count / exclude_from_pnl live on `boxes`, not v_box_pnl, so fetch the
    // included box ids first and filter the view by them.
    let boxesQuery = supabase.from('boxes').select('id, box_count').eq('exclude_from_pnl', false);
    if (box_id) boxesQuery = boxesQuery.eq('id', box_id);
    const { data: included, error: boxesError } = await withDbSpan('boxes', () => boxesQuery);
    if (boxesError) throw new Error(boxesError.message);
    if (!included?.length) return { boxes: [] };

    const boxCounts = new Map(included.map((b) => [b.id, b.box_count]));
    const { data, error } = await withDbSpan('v_box_pnl', () =>
      supabase.from('v_box_pnl').select('*').in('id', [...boxCounts.keys()]).limit(limit)
    );
    if (error) throw new Error(error.message);
    return { boxes: (data ?? []).map((b) => ({ ...b, box_count: boxCounts.get(b.id) ?? 1 })) };
  },
};

export const getGlobalPnlTool = {
  name: 'get_global_pnl',
  description:
    'Get overall business P&L across all boxes/listings (total spend vs. total realized + unrealized value). Use for "how is the business doing overall" questions.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const { data, error } = await withDbSpan('v_global_pnl', () => supabase.from('v_global_pnl').select('*').single());
    if (error) throw new Error(error.message);
    return { global_pnl: data };
  },
};
