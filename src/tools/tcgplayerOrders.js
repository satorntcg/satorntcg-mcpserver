import { supabase } from '../supabaseClient.js';

export const getTcgplayerOrdersTool = {
  name: 'get_tcgplayer_orders',
  description:
    'Get TCGplayer orders and their line items, optionally filtered by status (new/shipped) or order number. Use for questions like "what TCGplayer orders do I need to ship" or "what did order X contain".',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['new', 'shipped'],
        description: "Filter by status: 'new' or 'shipped'. Omit for all.",
      },
      order_number: {
        type: 'string',
        description: 'Optional exact order number to look up.',
      },
      limit: {
        type: 'number',
        default: 25,
      },
    },
  },
  handler: async ({ status, order_number, limit = 25 }) => {
    let query = supabase
      .from('tcgplayer_orders')
      .select('*, tcgplayer_order_items(*, cards(name, set_name))')
      .order('ordered_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);
    if (order_number) query = query.eq('order_number', order_number);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return { orders: data ?? [] };
  },
};

export const createTcgplayerOrderTool = {
  name: 'create_tcgplayer_order',
  description:
    'Create a TCGplayer order and its line items, matching each line item to a card by exact name (foil printings are matched literally, e.g. "Sinterfee (Foil)" — do not strip "(Foil)" from card_name_raw). Safe to re-run: if order_number already exists, the call is a no-op and no items are inserted, so the same parsed email can be submitted more than once without creating duplicates.',
  inputSchema: {
    type: 'object',
    properties: {
      order_number: { type: 'string', description: 'e.g. F0DFDDC3-1965A5-DEF21' },
      order_total: { type: 'number', description: 'Aggregate order total from the email.' },
      ship_by: { type: 'string', description: 'Ship-by date, YYYY-MM-DD.' },
      gmail_message_id: { type: 'string' },
      manage_order_url: { type: 'string' },
      ordered_at: { type: 'string', description: 'ISO timestamp of when the order was placed.' },
      items: {
        type: 'array',
        description: 'Line items parsed from the order email.',
        items: {
          type: 'object',
          properties: {
            card_name_raw: {
              type: 'string',
              description: 'Exact card name text as it appears in the email, including "(Foil)" suffix if present.',
            },
            condition: { type: 'string', description: 'e.g. "Near Mint", "Lightly Played".' },
            foil: { type: 'boolean', default: false },
            quantity: { type: 'number', default: 1 },
          },
          required: ['card_name_raw'],
        },
      },
    },
    required: ['order_number', 'items'],
  },
  handler: async ({ order_number, order_total, ship_by, gmail_message_id, manage_order_url, ordered_at, items }) => {
    const { data: inserted, error: orderError } = await supabase
      .from('tcgplayer_orders')
      .upsert(
        { order_number, order_total, ship_by, gmail_message_id, manage_order_url, ordered_at },
        { onConflict: 'order_number', ignoreDuplicates: true }
      )
      .select()
      .maybeSingle();
    if (orderError) throw new Error(orderError.message);

    if (!inserted) {
      const { data: existing, error: fetchError } = await supabase
        .from('tcgplayer_orders')
        .select()
        .eq('order_number', order_number)
        .single();
      if (fetchError) throw new Error(fetchError.message);
      return { order: existing, items: [], skipped: true, reason: 'order_number already exists — no items inserted' };
    }

    const matchedItems = [];
    for (const item of items) {
      const { data: cardMatches, error: cardError } = await supabase
        .from('cards')
        .select('id')
        .eq('name', item.card_name_raw)
        .limit(1);
      if (cardError) throw new Error(cardError.message);
      matchedItems.push({
        order_id: inserted.id,
        card_id: cardMatches?.[0]?.id ?? null,
        card_name_raw: item.card_name_raw,
        condition: item.condition ?? null,
        foil: item.foil ?? false,
        quantity: item.quantity ?? 1,
      });
    }

    const { data: insertedItems, error: itemsError } = await supabase
      .from('tcgplayer_order_items')
      .insert(matchedItems)
      .select();
    if (itemsError) throw new Error(itemsError.message);

    return {
      order: inserted,
      items: insertedItems,
      unmatched: insertedItems.filter((i) => !i.card_id).map((i) => i.card_name_raw),
    };
  },
};
