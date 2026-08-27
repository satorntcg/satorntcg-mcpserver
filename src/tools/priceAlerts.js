import { supabase } from '../supabaseClient.js';

export const getPriceAlertsTool = {
  name: 'get_price_alerts',
  description:
    'Get current, non-dismissed price alerts, plus optional context on eBay listing price alerts and stale listings. Use this to answer questions like "what should I look at today" or "anything moving I should react to".',
  inputSchema: {
    type: 'object',
    properties: {
      include_stale_listings: {
        type: 'boolean',
        description: 'Also include listings that have been active a long time without selling (from v_stale_listings).',
        default: true,
      },
      include_listing_alerts: {
        type: 'boolean',
        description: 'Also include eBay listings whose price has drifted vs. market (from v_listing_price_alerts).',
        default: true,
      },
      limit: {
        type: 'number',
        description: 'Max rows to return per category.',
        default: 25,
      },
    },
  },
  handler: async ({ include_stale_listings = true, include_listing_alerts = true, limit = 25 }) => {
    const [activeAlerts, gainersLosers] = await Promise.all([
      supabase.from('v_active_alerts').select('*').eq('dismissed', false).limit(limit),
      supabase.from('v_price_gainers_losers').select('*').limit(limit),
    ]);

    const result = {
      active_alerts: activeAlerts.data ?? [],
      price_gainers_losers: gainersLosers.data ?? [],
    };

    if (include_listing_alerts) {
      const { data } = await supabase.from('v_listing_price_alerts').select('*').limit(limit);
      result.listing_price_alerts = data ?? [];
    }

    if (include_stale_listings) {
      const { data } = await supabase.from('v_stale_listings').select('*').limit(limit);
      result.stale_listings = data ?? [];
    }

    const errors = [activeAlerts.error, gainersLosers.error].filter(Boolean);
    if (errors.length) {
      throw new Error(errors.map((e) => e.message).join('; '));
    }

    return result;
  },
};
