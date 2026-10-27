// find_ebay_deals: scans eBay (Browse API) for Sorcery singles listed below their
// TCGplayer market price after resale costs. Matching and profit math live in
// ebayDealsCore.js; this file does the I/O (Supabase + eBay) around it.
import { supabase } from '../supabaseClient.js';
import { withDbSpan } from '../dbSpan.js';
import { getDefaultEbayClient, PAGE_SIZE } from '../ebayClient.js';
import {
  DEFAULTS,
  MAX_ITEMS_LIMIT,
  parseFindEbayDealsArgs,
  buildCardIndex,
  classifyItem,
  evaluateMatch,
  sellerSkipReason,
  auctionSkipReason,
  isAuction,
  readShipping,
  isRepeat,
} from './ebayDealsCore.js';

export { parseFindEbayDealsArgs };

const GAME_SLUG = 'sorcery';
const QUERIES = ['sorcery contested realm', 'sorcery tcg'];
const MAX_OFFSET = 10_000; // Browse API: offset + limit must stay within 10,000
const SAMPLE_LIMIT = 25;
const SEEN_CHUNK = 100;

const round2 = (n) => Math.round(n * 100) / 100;
const bump = (counts, key) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

// Sorcery cards with their latest TCGplayer market price.
async function loadCards(client) {
  const game = await withDbSpan('games', () =>
    client.from('games').select('id').eq('slug', GAME_SLUG).maybeSingle()
  );
  if (game.error) throw new Error(game.error.message);
  if (!game.data) throw new Error(`No games row with slug "${GAME_SLUG}".`);

  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await withDbSpan('v_latest_prices', () =>
      client
        .from('v_latest_prices')
        .select('card_id, name, set_name, foil, tcgplayer_market')
        .eq('game_id', game.data.id)
        .order('card_id')
        .range(from, from + 999)
    );
    if (page.error) throw new Error(page.error.message);
    rows.push(...(page.data ?? []));
    if ((page.data ?? []).length < 1000) break;
  }
  return rows;
}

// Builds the search streams. Fixed-price/all listings are scanned newest first; when
// auctions are on, extra streams sorted by ending time make sure auctions closing within
// `auction_hours` are seen even if they were listed days ago.
function buildStreams(opts, now) {
  const common = `deliveryCountry:US,itemLocationCountry:US,price:[${opts.min_price}..],priceCurrency:USD`;
  const buying = opts.include_auctions ? '{FIXED_PRICE|AUCTION}' : '{FIXED_PRICE}';
  const streams = QUERIES.map((q) => ({
    q,
    sort: 'newlyListed',
    filter: `buyingOptions:${buying},${common}`,
  }));
  if (opts.include_auctions && opts.auction_hours > 0) {
    const endBy = new Date(now.getTime() + opts.auction_hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const q of QUERIES) {
      streams.push({
        q,
        sort: 'endingSoonest',
        filter: `buyingOptions:{AUCTION},${common},itemEndDate:[..${endBy}]`,
      });
    }
  }
  return streams.map((s) => ({ ...s, offset: 0, done: false }));
}

// Pulls pages from each stream in turn until max_items unique items are collected or
// every stream runs dry. A failing stream is reported in `warnings` and dropped; the
// scan only fails outright if nothing at all could be fetched.
async function scanEbay(ebay, opts, now) {
  const streams = buildStreams(opts, now);
  const items = new Map();
  const warnings = [];
  let pages = 0;

  while (items.size < opts.max_items && streams.some((s) => !s.done)) {
    for (const stream of streams) {
      if (stream.done || items.size >= opts.max_items) continue;
      try {
        const page = await ebay.searchPage({
          q: stream.q,
          sort: stream.sort,
          filter: stream.filter,
          offset: stream.offset,
          limit: PAGE_SIZE,
        });
        pages += 1;
        for (const item of page.items) {
          if (items.size >= opts.max_items) break;
          if (item.itemId && !items.has(item.itemId)) items.set(item.itemId, item);
        }
        stream.offset += PAGE_SIZE;
        if (!page.hasNext || page.items.length === 0 || stream.offset + PAGE_SIZE > MAX_OFFSET) stream.done = true;
      } catch (err) {
        // Credential/token problems affect every stream the same way; fail once, clearly.
        if (/Missing eBay credentials|OAuth token/.test(err.message)) throw err;
        stream.done = true;
        warnings.push(`${stream.q} (${stream.sort}) stopped at offset ${stream.offset}: ${err.message}`);
      }
    }
  }
  if (items.size === 0 && warnings.length > 0) throw new Error(warnings.join(' | '));
  return { items: [...items.values()], warnings, pages };
}

async function loadSeen(client, itemIds) {
  const seen = new Map();
  for (let i = 0; i < itemIds.length; i += SEEN_CHUNK) {
    const chunk = itemIds.slice(i, i + SEEN_CHUNK);
    const res = await withDbSpan('ebay_deal_seen', () =>
      client.from('ebay_deal_seen').select('item_id, last_price').in('item_id', chunk)
    );
    if (res.error) throw new Error(`ebay_deal_seen lookup failed: ${res.error.message}`);
    for (const row of res.data ?? []) seen.set(row.item_id, row);
  }
  return seen;
}

async function recordSeen(client, deals) {
  if (deals.length === 0) return null;
  const rows = deals.map((d) => ({ item_id: d.item_id, last_price: d.buy_total, card_id: d.card_id }));
  const res = await withDbSpan('ebay_deal_seen', () =>
    client.from('ebay_deal_seen').upsert(rows, { onConflict: 'item_id' })
  );
  return res.error ? res.error.message : null;
}

function lotRow(item, classification) {
  const auction = isAuction(item);
  const price = Number((auction ? item.currentBidPrice?.value : null) ?? item.price?.value);
  const { shipping, shipping_unknown } = readShipping(item);
  return {
    ebay_title: item.title,
    price: Number.isFinite(price) ? round2(price) : null,
    shipping: round2(shipping),
    buy_total: Number.isFinite(price) ? round2(price + shipping) : null,
    card_count: classification.card_count,
    listing_type: auction ? 'auction' : 'fixed_price',
    ends_at: auction ? item.itemEndDate ?? null : null,
    seller: item.seller?.username ?? null,
    feedback: item.seller?.feedbackPercentage == null ? null : Number(item.seller.feedbackPercentage),
    url: item.itemWebUrl,
    shipping_unknown,
  };
}

// deps lets scripts/tests swap in other clients: { db, ebay, now }.
export async function findEbayDeals(args, deps = {}) {
  const opts = parseFindEbayDealsArgs(args);
  const db = deps.db ?? supabase;
  const ebay = deps.ebay ?? getDefaultEbayClient();
  const now = deps.now ?? new Date();

  const [cardRows, scan] = await Promise.all([loadCards(db), scanEbay(ebay, opts, now)]);
  const index = buildCardIndex(cardRows);

  const skipped = {};
  const rejected = {};
  const ambiguousSamples = [];
  const unmatchedSamples = [];
  let ambiguousCount = 0;
  let unmatchedCount = 0;
  let matched = 0;
  const candidates = [];
  const lots = [];

  for (const item of scan.items) {
    const c = classifyItem(item, index, opts, now);
    if (c.kind === 'skip') {
      bump(skipped, c.reason);
      continue;
    }
    if (c.kind === 'ambiguous') {
      ambiguousCount += 1;
      if (ambiguousSamples.length < SAMPLE_LIMIT) {
        ambiguousSamples.push({ title: c.title, reason: c.reason, candidates: c.candidates, url: item.itemWebUrl });
      }
      continue;
    }
    if (c.kind === 'unmatched') {
      unmatchedCount += 1;
      if (unmatchedSamples.length < SAMPLE_LIMIT) {
        unmatchedSamples.push({ title: c.title, reason: c.reason, card_name: c.card_name, url: item.itemWebUrl });
      }
      continue;
    }

    const sellerSkip = sellerSkipReason(item, opts);
    if (c.kind === 'lot') {
      const why = sellerSkip ?? auctionSkipReason(item, opts, now);
      if (why) bump(skipped, `lot_${why}`);
      else lots.push(lotRow(item, c));
      continue;
    }

    matched += 1;
    if (sellerSkip) {
      bump(skipped, sellerSkip);
      continue;
    }
    const result = evaluateMatch(c, item, opts);
    if (result.deal) candidates.push(result.deal);
    else bump(rejected, result.rejected);
  }

  // Repeat suppression: items already returned before come back only if cheaper now.
  let deals = candidates;
  let repeatsHidden = 0;
  if (opts.only_new && candidates.length > 0) {
    const seen = await loadSeen(db, candidates.map((d) => d.item_id));
    deals = candidates.filter((d) => {
      const seenRow = seen.get(d.item_id);
      if (isRepeat(d, seenRow)) {
        repeatsHidden += 1;
        return false;
      }
      if (seenRow) d.price_dropped_from = Number(seenRow.last_price);
      return true;
    });
  }
  deals.sort((a, b) => b.expected_profit - a.expected_profit);
  lots.sort((a, b) => (a.buy_total ?? Infinity) - (b.buy_total ?? Infinity));

  const warnings = [...scan.warnings];
  if (opts.record_seen) {
    const err = await recordSeen(db, deals);
    if (err) warnings.push(`Could not record seen deals in ebay_deal_seen: ${err}`);
  }

  return {
    scanned: scan.items.length,
    matched,
    deal_count: deals.length,
    deals,
    lots,
    ambiguous_count: ambiguousCount,
    unmatched_count: unmatchedCount,
    repeats_hidden: repeatsHidden,
    skipped,
    rejected,
    ambiguous_samples: ambiguousSamples,
    unmatched_samples: unmatchedSamples,
    catalog: { cards_loaded: cardRows.length, matchable_names: index.names.length, variant_printings_ignored: index.skippedVariants },
    search: { pages_fetched: scan.pages, queries: QUERIES },
    settings: opts,
    warnings,
  };
}

const numberProp = (description, extra = {}) => ({ type: 'number', description, ...extra });

export const findEbayDealsTool = {
  name: 'find_ebay_deals',
  description:
    'Scan live eBay listings (US, Browse API) for Sorcery: Contested Realm singles priced below their TCGplayer ' +
    'market price after resale costs. Each listing title is matched to a card (name, set, foil, quantity); the ' +
    'buy total (price + shipping, or current bid + shipping for auctions) is compared against market x quantity, ' +
    'net of selling fees, postage and supplies. Returns `deals` sorted by expected_profit, multi-card `lots` for ' +
    'manual review (never valued), and counts/samples of titles that were ambiguous or unmatched. ' +
    'set_uncertain means the title named no set and the cheapest set\'s price was used; shipping_unknown means ' +
    'eBay gave no shipping cost (treated as $0). By default deals already returned by an earlier run are hidden ' +
    'unless their price dropped (only_new). Use for "find me cheap Sorcery cards on eBay" or "any eBay deals?". ' +
    'Calls eBay live, so it takes several seconds.',
  inputSchema: {
    type: 'object',
    properties: {
      max_buy_ratio: numberProp('Max buy_total / market value to count as a deal.', { default: DEFAULTS.max_buy_ratio }),
      min_profit: numberProp('Minimum expected profit in USD.', { default: DEFAULTS.min_profit }),
      min_market: numberProp('Minimum TCGplayer market price per card in USD.', { default: DEFAULTS.min_market }),
      include_auctions: { type: 'boolean', default: DEFAULTS.include_auctions, description: 'Include auctions (valued at current bid).' },
      auction_hours: numberProp('Only include auctions ending within this many hours.', { default: DEFAULTS.auction_hours }),
      include_graded: { type: 'boolean', default: DEFAULTS.include_graded, description: 'Include PSA/BGS/CGC graded cards (valued at raw market).' },
      only_new: { type: 'boolean', default: DEFAULTS.only_new, description: 'Hide deals returned by earlier runs unless the price dropped.' },
      max_items: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_ITEMS_LIMIT,
        default: DEFAULTS.max_items,
        description: 'Max unique eBay listings to scan per run.',
      },
      fee_pct: numberProp('Selling fee fraction when reselling.', { default: DEFAULTS.fee_pct }),
      postage_under: numberProp('Postage per card when market < postage_threshold.', { default: DEFAULTS.postage_under }),
      postage_over: numberProp('Postage per card when market >= postage_threshold.', { default: DEFAULTS.postage_over }),
      postage_threshold: numberProp('Market price at which tracked postage applies.', { default: DEFAULTS.postage_threshold }),
      supplies: numberProp('Packing supplies cost per card.', { default: DEFAULTS.supplies }),
      min_price: numberProp('Minimum eBay listing price searched.', { default: DEFAULTS.min_price }),
      min_seller_feedback: numberProp('Skip sellers below this feedback percentage (sellers with no feedback are always skipped).', {
        default: DEFAULTS.min_seller_feedback,
      }),
      exclude_sets: {
        type: 'array',
        items: { type: 'string' },
        default: DEFAULTS.exclude_sets,
        description: 'Set names never valued (titles naming them are skipped). Every other set, including newly added ones, is included.',
      },
      record_seen: {
        type: 'boolean',
        default: DEFAULTS.record_seen,
        description: 'Save returned deals to ebay_deal_seen so later only_new runs skip them.',
      },
    },
  },
  handler: (args) => findEbayDeals(args),
};
