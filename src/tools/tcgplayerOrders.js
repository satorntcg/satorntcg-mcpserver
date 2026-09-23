import { supabase } from '../supabaseClient.js';
import { withDbSpan } from '../dbSpan.js';

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

    const { data, error } = await withDbSpan('tcgplayer_orders', () => query);
    if (error) throw new Error(error.message);
    return { orders: data ?? [] };
  },
};

export const createTcgplayerOrderTool = {
  name: 'create_tcgplayer_order',
  description:
    'Create a TCGplayer order and its line items, matching each line item to a card by exact name (foil printings are matched literally, e.g. "Sinterfee (Foil)" — do not strip "(Foil)" from card_name_raw). Also creates a matching "active" listing in tcgplayer_listings (same shape the dashboard\'s manual "create listing" flow produces: quantity_listed bumped, no sold_price/fee/cost_basis/net_profit/quantity_owned changes yet) — even though the order email means TCGplayer already has a committed buyer, these are booked as placeholders on file and finalized later through the existing chat-based "mark sold" flow once the packing slip is printed and the order actually ships. Safe to re-run: if order_number already exists, its line items are never (re-)created, and its listing/inventory sync is only (re-)attempted if it never completed the first time (e.g. a prior call errored or timed out after the order was recorded but before the listing was synced) — so a retry after a failed call finishes the sync instead of silently no-oping. Also guards against duplicating a sale that was already recorded manually: if any of this order\'s cards has a *manually*-created tcgplayer_listings row (not one this tool made) within 3 days of the order date, listing creation is skipped (the order/items are still recorded) and the response says which existing listing to check. Two auto-created listings for the same card from different orders are never treated as duplicates — each has its own order_number, so they\'re genuinely separate sales.',
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
    const { data: inserted, error: orderError } = await withDbSpan('tcgplayer_orders', () =>
      supabase
        .from('tcgplayer_orders')
        .upsert(
          { order_number, order_total, ship_by, gmail_message_id, manage_order_url, ordered_at },
          { onConflict: 'order_number', ignoreDuplicates: true }
        )
        .select()
        .maybeSingle()
    );
    if (orderError) throw new Error(orderError.message);

    if (!inserted) {
      const { data: existing, error: fetchError } = await withDbSpan('tcgplayer_orders', () =>
        supabase.from('tcgplayer_orders').select('*, tcgplayer_order_items(*)').eq('order_number', order_number).single()
      );
      if (fetchError) throw new Error(fetchError.message);

      const existingItems = existing.tcgplayer_order_items ?? [];

      // The order row can exist without its listing/inventory sync ever having run
      // (e.g. a prior call timed out after inserting the order but before syncing) —
      // in that case a bare no-op here would leave it permanently unsynced. Finish
      // the sync now instead of only checking that the order row exists.
      const { data: existingListing, error: listingCheckError } = await withDbSpan('tcgplayer_listings', () =>
        supabase
          .from('tcgplayer_listings')
          .select('id')
          .eq('notes', `Auto-created from TCGplayer order ${order_number}`)
          .maybeSingle()
      );
      if (listingCheckError) throw new Error(listingCheckError.message);

      if (existingListing) {
        return {
          order: existing,
          items: existingItems,
          skipped: true,
          reason: 'order_number already exists and its listing/inventory sync already completed — no-op',
        };
      }

      const listing = await createListingForOrder({ order: existing, items: existingItems });
      return {
        order: existing,
        items: existingItems,
        skipped: true,
        reason: 'order_number already existed but its listing/inventory sync had not completed — completed it now',
        listing,
      };
    }

    const matchedItems = [];
    for (const item of items) {
      const { data: cardMatches, error: cardError } = await withDbSpan('cards', () =>
        supabase.from('cards').select('id').eq('name', item.card_name_raw).limit(1)
      );
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

    const { data: insertedItems, error: itemsError } = await withDbSpan('tcgplayer_order_items', () =>
      supabase.from('tcgplayer_order_items').insert(matchedItems).select()
    );
    if (itemsError) throw new Error(itemsError.message);

    const unmatched = insertedItems.filter((i) => !i.card_id).map((i) => i.card_name_raw);
    const listing = await createListingForOrder({ order: inserted, items: insertedItems });

    return { order: inserted, items: insertedItems, unmatched, listing };
  },
};

export const getOrdersMissingListingsTool = {
  name: 'get_orders_missing_listings',
  description:
    'Find TCGplayer orders whose listing/inventory sync never completed — a direct comparison of tcgplayer_orders/tcgplayer_order_items against tcgplayer_listings, not an inference from quantity_listed or updated_at (those can shift for unrelated reasons, e.g. a price refresh, and give a false read). An order counts as synced if it has its own auto-created listing (tcgplayer_listings.notes = "Auto-created from TCGplayer order <order_number>"), or if listing creation was correctly skipped because a *manual* listing already covered one of its cards within 3 days of the order date — the same duplicate-sale guard create_tcgplayer_order itself uses. An auto-created listing belonging to a *different* order never counts as coverage, since that guard only ever fires against manual listings. Anything else is flagged as missing, listing every line item on the order since a failed sync never lists any of them. Run with `since` set to the start of an order-capture run to catch a bad sync within the hour; run with no `since` for a full backlog sweep.',
  inputSchema: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description: 'Optional ISO date/datetime — only check orders with created_at >= this. Omit to check every order on file.',
      },
      limit: {
        type: 'number',
        default: 50,
        description: 'Max number of missing orders to return. checked_count/missing_count still reflect the full since-filtered set.',
      },
    },
  },
  handler: async ({ since, limit = 50 }) => {
    let orderQuery = supabase
      .from('tcgplayer_orders')
      .select('order_number, order_total, created_at, ordered_at, tcgplayer_order_items(card_id, card_name_raw, quantity)')
      .order('created_at', { ascending: true });
    if (since) orderQuery = orderQuery.gte('created_at', since);
    const { data: orders, error: ordersError } = await withDbSpan('tcgplayer_orders', () => orderQuery);
    if (ordersError) throw new Error(ordersError.message);

    const { data: autoListings, error: autoError } = await withDbSpan('tcgplayer_listings', () =>
      supabase.from('tcgplayer_listings').select('notes').like('notes', 'Auto-created from TCGplayer order %')
    );
    if (autoError) throw new Error(autoError.message);
    const syncedOrderNumbers = new Set(
      autoListings.map((l) => l.notes.replace('Auto-created from TCGplayer order ', '').trim())
    );

    const candidates = orders.filter((o) => !syncedOrderNumbers.has(o.order_number));

    const missing = [];
    for (const o of candidates) {
      const items = o.tcgplayer_order_items ?? [];
      const cardIds = [...new Set(items.map((i) => i.card_id).filter(Boolean))];

      // Mirrors createListingForOrder: no matched cards means no listing could ever
      // have been created, so there's nothing to check a duplicate guard against.
      const duplicateListingId =
        cardIds.length > 0 ? await findPossibleDuplicateListing(cardIds, o.ordered_at ?? o.created_at) : null;
      if (duplicateListingId) continue;

      missing.push({
        order_number: o.order_number,
        order_total: o.order_total,
        created_at: o.created_at,
        ordered_at: o.ordered_at,
        missing_items: items.map((i) => ({
          card_name_raw: i.card_name_raw,
          quantity: i.quantity,
          unmatched_card: i.card_id == null,
        })),
      });
    }

    return {
      orders_missing_listings: missing.slice(0, limit),
      checked_count: orders.length,
      missing_count: missing.length,
    };
  },
};

// Guards against recreating a sale that's already recorded: a card sold via the dashboard's
// manual flow and the same card's order email arriving through this tool both represent the
// same real-world sale, and nothing else ties them together. If a *manually*-created listing
// (notes IS NULL — i.e. not this tool's own output) touches one of this order's cards within a
// few days of the order date, we treat it as the same sale rather than risk a duplicate — this
// is exactly the pattern that produced ~100 duplicate listings when historical orders were
// backfilled against already-recorded manual sales.
//
// Deliberately excludes other auto-created listings (notes starting with "Auto-created from
// TCGplayer order ..."): each of those already came from its own distinct order_number, which
// tcgplayer_orders' unique constraint guarantees can't be reprocessed, so two auto-created
// listings for the same card are two genuinely separate real sales (a popular card selling
// twice in a few days), not a duplicate. Matching on those too was an over-broad first cut that
// skipped a legitimate order (F0DFDDC3-36E444-16D80) because a *different* order had sold the
// same card ~29 hours earlier — narrowing to manual-only listings fixes that false positive
// without reopening the original manual/auto collision this guard exists for.
const DUPLICATE_WINDOW_MS = 1000 * 60 * 60 * 24 * 3;

async function findPossibleDuplicateListing(cardIds, referenceDate) {
  const refTime = new Date(referenceDate).getTime();

  const { data: direct, error: directError } = await withDbSpan('tcgplayer_listings', () =>
    supabase.from('tcgplayer_listings').select('id, listed_at, sold_at, notes').in('card_id', cardIds)
  );
  if (directError) throw new Error(directError.message);

  const { data: junctionRows, error: junctionError } = await withDbSpan('tcgplayer_listing_cards', () =>
    supabase.from('tcgplayer_listing_cards').select('listing_id').in('card_id', cardIds)
  );
  if (junctionError) throw new Error(junctionError.message);

  const junctionListingIds = [...new Set((junctionRows ?? []).map((j) => j.listing_id))];
  let viaJunction = [];
  if (junctionListingIds.length > 0) {
    const { data, error } = await withDbSpan('tcgplayer_listings', () =>
      supabase.from('tcgplayer_listings').select('id, listed_at, sold_at, notes').in('id', junctionListingIds)
    );
    if (error) throw new Error(error.message);
    viaJunction = data ?? [];
  }

  const candidates = new Map();
  for (const row of [...(direct ?? []), ...viaJunction]) candidates.set(row.id, row);

  for (const row of candidates.values()) {
    if (row.notes != null) continue; // only manual listings count as a possible duplicate
    const dates = [row.sold_at, row.listed_at].filter(Boolean);
    if (dates.some((d) => Math.abs(new Date(d).getTime() - refTime) <= DUPLICATE_WINDOW_MS)) {
      return row.id;
    }
  }
  return null;
}

// Mirrors the dashboard's manual "create listing" flow (Tcgplayerlistings.jsx CreateModal):
// creates an 'active' placeholder listing for the order, with no financials populated yet.
// Chris finalizes each one (marks it sold, with the real sold_price/fee/cost_basis/net_profit
// and the quantity_owned decrement) through the existing chat-based flow once he's actually
// packed and shipped it — this tool only books the placeholder, on his explicit instruction,
// even though every order it processes represents an already-committed TCGplayer sale.
async function createListingForOrder({ order, items }) {
  const linkable = items.filter((i) => i.card_id);
  if (linkable.length === 0) return null;

  const totalQty = linkable.reduce((sum, i) => sum + i.quantity, 0);
  const uniqueCardIds = [...new Set(linkable.map((i) => i.card_id))];
  const isSingleCard = uniqueCardIds.length === 1 && totalQty === 1;

  const referenceDate = order.ordered_at ?? new Date().toISOString();
  const duplicateListingId = await findPossibleDuplicateListing(uniqueCardIds, referenceDate);
  if (duplicateListingId) {
    return {
      skipped: true,
      reason: `An existing tcgplayer_listings row (id ${duplicateListingId}) already covers one of this order's cards within 3 days of ${referenceDate} — likely the same sale already recorded manually. No listing created; check listing ${duplicateListingId} against order ${order.order_number} and add one by hand if it's genuinely a separate sale.`,
    };
  }

  const { data: cardDetails, error: cardDetailsError } = await withDbSpan('cards', () =>
    supabase.from('cards').select('id, name, set_name').in('id', uniqueCardIds)
  );
  if (cardDetailsError) throw new Error(cardDetailsError.message);
  const cardById = Object.fromEntries((cardDetails ?? []).map((c) => [c.id, c]));

  const condition = linkable[0].condition ?? 'Near Mint';
  const title = isSingleCard
    ? `${cardById[uniqueCardIds[0]].name} — Sorcery TCG${
        cardById[uniqueCardIds[0]].set_name ? ` ${cardById[uniqueCardIds[0]].set_name}` : ''
      } — ${condition}`
    : `Sorcery TCG Lot — ${totalQty} Cards`;

  const listedPrice = order.order_total ?? 0;
  // Cheap orders ship first-class stamp rate; $20+ bumps to padded-envelope/priority.
  const shipping = listedPrice < 20 ? 0.82 : 5.5;

  const { data: newListing, error: listingError } = await withDbSpan('tcgplayer_listings', () =>
    supabase
      .from('tcgplayer_listings')
      .insert({
        card_id: isSingleCard ? uniqueCardIds[0] : null,
        title,
        listed_price: listedPrice,
        shipping_cost: shipping,
        condition,
        quantity: 1,
        notes: `Auto-created from TCGplayer order ${order.order_number}`,
        tcgplayer_url: order.manage_order_url ?? null,
        status: 'active',
        ...(order.ordered_at ? { listed_at: order.ordered_at } : {}),
      })
      .select()
      .single()
  );
  if (listingError) throw new Error(listingError.message);

  const perCardPrice =
    order.order_total != null && totalQty > 0 ? parseFloat((order.order_total / totalQty).toFixed(2)) : 0;
  const { error: listingCardsError } = await withDbSpan('tcgplayer_listing_cards', () =>
    supabase.from('tcgplayer_listing_cards').insert(
      linkable.map((i) => ({
        listing_id: newListing.id,
        card_id: i.card_id,
        price: perCardPrice,
        quantity: i.quantity,
      }))
    )
  );
  if (listingCardsError) throw new Error(listingCardsError.message);

  // Mirrors CreateModal's quantity_listed bump, keeping "what's reserved for sale" accurate.
  // quantity_owned is untouched until Chris marks the listing sold through the existing flow.
  for (const i of linkable) {
    const { data: cardRow, error: cardRowError } = await withDbSpan('cards', () =>
      supabase.from('cards').select('quantity_listed').eq('id', i.card_id).single()
    );
    if (cardRowError) throw new Error(cardRowError.message);
    const { error: updateError } = await withDbSpan('cards', () =>
      supabase.from('cards').update({ quantity_listed: (cardRow.quantity_listed ?? 0) + i.quantity }).eq('id', i.card_id)
    );
    if (updateError) throw new Error(updateError.message);
  }

  return newListing;
}
