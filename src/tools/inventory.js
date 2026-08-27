import { supabase } from '../supabaseClient.js';

export const getInventorySummaryTool = {
  name: 'get_inventory_summary',
  description:
    'Get the current inventory dashboard: cards on hand, quantities owned/listed, and latest market prices. Use for questions like "what do I have in stock" or "what am I sitting on that I should list".',
  inputSchema: {
    type: 'object',
    properties: {
      name_contains: {
        type: 'string',
        description: 'Optional case-insensitive filter on card name.',
      },
      limit: {
        type: 'number',
        description: 'Max rows to return.',
        default: 50,
      },
    },
  },
  handler: async ({ name_contains, limit = 50 }) => {
    let query = supabase.from('v_inventory_dashboard').select('*').limit(limit);
    if (name_contains) {
      query = query.ilike('name', `%${name_contains}%`);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return { inventory: data ?? [] };
  },
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
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return { prices: data ?? [] };
  },
};
