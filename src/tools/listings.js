import { supabase } from '../supabaseClient.js';

export const getEbayListingsTool = {
  name: 'get_ebay_listings',
  description:
    'Get eBay listings, either currently active or sold, for questions like "what do I have listed right now" or "what has sold recently".',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'sold'],
        description: 'Which set of listings to return.',
        default: 'active',
      },
      limit: {
        type: 'number',
        default: 50,
      },
    },
    required: ['status'],
  },
  handler: async ({ status = 'active', limit = 50 }) => {
    const view = status === 'sold' ? 'v_ebay_sold' : 'v_ebay_active';
    const { data, error } = await supabase.from(view).select('*').limit(limit);
    if (error) throw new Error(error.message);
    return { status, listings: data ?? [] };
  },
};
