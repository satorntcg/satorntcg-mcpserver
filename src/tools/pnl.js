import { supabase } from '../supabaseClient.js';

export const getBoxPnlTool = {
  name: 'get_box_pnl',
  description:
    'Get profit & loss per box (purchase price vs. realized/unrealized value of pulled cards). Use for "was Box X worth it" or "how is Gothic performing overall" questions.',
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
    let query = supabase.from('v_box_pnl').select('*').limit(limit);
    if (box_id) query = query.eq('id', box_id);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return { boxes: data ?? [] };
  },
};

export const getGlobalPnlTool = {
  name: 'get_global_pnl',
  description:
    'Get overall business P&L across all boxes/listings (total spend vs. total realized + unrealized value). Use for "how is the business doing overall" questions.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const { data, error } = await supabase.from('v_global_pnl').select('*').single();
    if (error) throw new Error(error.message);
    return { global_pnl: data };
  },
};
