import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalize,
  buildCardIndex,
  matchCardName,
  detectQuantity,
  classifyItem,
  computeProfit,
  evaluateMatch,
  sellerSkipReason,
  isRepeat,
  parseFindEbayDealsArgs,
  DEFAULTS,
} from '../src/tools/ebayDealsCore.js';
import { createEbayClient, readEbayCredentials } from '../src/ebayClient.js';

const NOW = new Date('2026-10-27T12:00:00Z');
const opts = parseFindEbayDealsArgs({});

const CARD_ROWS = [
  { card_id: 'zap-b', name: 'Zap!', set_name: 'Beta', foil: false, tcgplayer_market: 6 },
  { card_id: 'zapf-b', name: 'Zap! (Foil)', set_name: 'Beta', foil: true, tcgplayer_market: 30 },
  { card_id: 'blaze-b', name: 'Blaze', set_name: 'Beta', foil: false, tcgplayer_market: 1 },
  { card_id: 'bog-b', name: 'Blaze of Glory', set_name: 'Gothic', foil: false, tcgplayer_market: 12 },
  { card_id: 'dt-b', name: 'Death Touch', set_name: 'Beta', foil: false, tcgplayer_market: 40 },
  { card_id: 'dt-a', name: 'Death Touch', set_name: 'Arthurian Legends', foil: false, tcgplayer_market: 25 },
  { card_id: 'lead', name: 'Leadworks (foil)', set_name: 'Gothic', foil: false, tcgplayer_market: 8 },
  { card_id: 'baba', name: "Baba Yaga's Hut", set_name: 'Gothic', foil: false, tcgplayer_market: 20 },
  { card_id: 'dj-promo', name: 'Day of Judgment (Judge Promo)', set_name: 'Gothic', foil: false, tcgplayer_market: 700 },
  { card_id: 'dj', name: 'Day of Judgment', set_name: 'Gothic', foil: false, tcgplayer_market: 80 },
  { card_id: 'pledge', name: 'Sorcery: Contested Realm - Pledge Pack', set_name: 'Alpha', foil: false, tcgplayer_market: 500 },
  { card_id: 'grim', name: 'Grim Reaper', set_name: 'Beta', foil: false, tcgplayer_market: 50 },
  { card_id: 'gold', name: 'Golden Reaper', set_name: 'Beta', foil: false, tcgplayer_market: 50 },
  { card_id: 'nopr', name: 'Unpriced Thing', set_name: 'Beta', foil: false, tcgplayer_market: null },
];
const index = buildCardIndex(CARD_ROWS);

const item = (title, extra = {}) => ({
  itemId: `v1|${title.length}|0`,
  title,
  price: { value: '10.00', currency: 'USD' },
  shippingOptions: [{ shippingCost: { value: '1.00', currency: 'USD' } }],
  buyingOptions: ['FIXED_PRICE'],
  condition: 'Ungraded',
  itemWebUrl: 'https://www.ebay.com/itm/1',
  seller: { username: 'seller1', feedbackPercentage: '99.5', feedbackScore: 1200 },
  ...extra,
});
const classify = (title, extra, o = opts) => classifyItem(item(title, extra), index, o, NOW);

test('normalize strips punctuation, apostrophes and accents', () => {
  assert.equal(normalize("  Zap!  Baba Yaga's   Hut — Seven-League "), 'zap baba yagas hut seven league');
});

test('card index keeps standard printings only and trusts the name foil suffix', () => {
  assert.ok(index.byBase.has('zap'));
  assert.ok(!index.byBase.has('sorcery contested realm pledge pack'), 'sealed catalog rows are excluded');
  assert.equal(index.byBase.get('day of judgment').printings.length, 1, 'judge promo is excluded');
  assert.equal(index.byBase.get('leadworks').printings[0].foil, true);
});

test('names match as whole words only, longest name wins', () => {
  assert.equal(matchCardName(normalize('Sorcery Zapper Beta'), index).status, 'none');
  assert.equal(matchCardName(normalize('Sorcery Zap! Beta'), index).base, 'zap');
  assert.equal(matchCardName(normalize('Sorcery Blaze of Glory Gothic'), index).base, 'blaze of glory');
});

test('two equally long card names → ambiguous', () => {
  const m = matchCardName(normalize('Sorcery Grim Reaper Golden Reaper'), index);
  assert.equal(m.status, 'ambiguous');
});

test('quantity markers', () => {
  assert.deepEqual(detectQuantity('zap x2 beta'), { quantity: 2, unclear: false });
  assert.deepEqual(detectQuantity('3x zap'), { quantity: 3, unclear: false });
  assert.deepEqual(detectQuantity('zap playset'), { quantity: 4, unclear: false });
  assert.deepEqual(detectQuantity('zap set of 4'), { quantity: 4, unclear: false });
  assert.equal(detectQuantity('zap x2 3x').unclear, true);
  assert.deepEqual(detectQuantity('zap beta nm'), { quantity: 1, unclear: false });
});

test('foil, set and quantity flow into the match', () => {
  const foil = classify('Sorcery Contested Realm Zap! Foil Beta NM');
  assert.equal(foil.kind, 'matched');
  assert.equal(foil.card.card_id, 'zapf-b');
  assert.equal(foil.set_uncertain, false);

  const nonFoil = classify('Sorcery TCG Zap! Non-Foil Beta');
  assert.equal(nonFoil.card.card_id, 'zap-b');

  const two = classify('Sorcery Zap! x2 Beta');
  assert.equal(two.quantity, 2);
});

test('no set named → cheapest set, set_uncertain; named set must match', () => {
  const any = classify('Sorcery Contested Realm Death Touch');
  assert.equal(any.card.card_id, 'dt-a');
  assert.equal(any.set_uncertain, true);

  const beta = classify('Sorcery Death Touch Beta');
  assert.equal(beta.card.card_id, 'dt-b');
  assert.equal(beta.set_uncertain, false);

  const alpha = classify('Sorcery Death Touch Alpha');
  assert.equal(alpha.kind, 'unmatched');
  assert.match(alpha.reason, /alpha/i);

  assert.equal(classify('Sorcery Death Touch Alpha Beta').kind, 'ambiguous');
});

test('skips, lots, graded and variants', () => {
  assert.equal(classify('MTG Sorcery Fireball Alpha').reason, 'other_game');
  assert.equal(classify('Zap! Beta near mint').reason, 'not_sorcery');
  assert.equal(classify('Sorcery Zap! proxy').reason, 'proxy');
  assert.equal(classify('Sorcery Zap! Beta damaged').reason, 'condition');
  assert.equal(classify('Sorcery Contested Realm Beta Booster Box Sealed').reason, 'sealed_product');
  assert.equal(classify('Sorcery Zap! Beta pack fresh').kind, 'matched', '"pack fresh" is not sealed product');
  assert.equal(classify('Sorcery Zap! Beta PSA 10').reason, 'graded');
  assert.equal(classify('Sorcery Zap! Beta PSA 10', {}, { ...opts, include_graded: true }).kind, 'matched');
  assert.equal(classify('Sorcery Contested Realm 50 card lot Beta').kind, 'lot');
  assert.equal(classify('Sorcery Zap! x8').kind, 'lot');
  assert.equal(classify('Sorcery Day of Judgment Judge Promo').kind, 'ambiguous');
  assert.equal(classify('Sorcery Zap! Beta', { itemGroupType: 'SELLER_DEFINED_VARIATIONS' }).kind, 'ambiguous');
  assert.equal(classify('Sorcery Unpriced Thing Beta').reason, 'no_market_price');
});

test('auctions are kept only when ending within auction_hours', () => {
  const soon = { buyingOptions: ['AUCTION'], itemEndDate: '2026-10-27T20:00:00Z', currentBidPrice: { value: '4.00' } };
  assert.equal(classify('Sorcery Zap! Foil Beta', soon).auction, true);
  const late = { ...soon, itemEndDate: '2026-10-30T20:00:00Z' };
  assert.equal(classify('Sorcery Zap! Foil Beta', late).reason, 'auction_ends_too_late');
  assert.equal(classify('Sorcery Zap! Foil Beta', soon, { ...opts, include_auctions: false }).reason, 'auction_excluded');
});

test('profit math matches the spec formula', () => {
  // market 30, buy 10 + 1 shipping: 30*0.85 - 1.10 - 0.30 - 11 = 13.10
  const p = computeProfit({ market: 30, quantity: 1, buyPrice: 10, shipping: 1 }, opts);
  assert.equal(p.expected_profit, 13.1);
  assert.equal(p.buy_ratio, 0.367);
  // $50+ cards use tracked postage
  assert.equal(computeProfit({ market: 60, quantity: 1, buyPrice: 0, shipping: 0 }, opts).postage, 6.5);
  // per-card costs scale with quantity
  assert.equal(computeProfit({ market: 10, quantity: 2, buyPrice: 0, shipping: 0 }, opts).postage, 2.2);
});

test('deal thresholds', () => {
  const m = classify('Sorcery Zap! Foil Beta');
  const { deal } = evaluateMatch(m, item('Sorcery Zap! Foil Beta'), opts);
  assert.equal(deal.expected_profit, 13.1);
  assert.equal(deal.listing_type, 'fixed_price');

  const pricey = item('Sorcery Zap! Foil Beta', { price: { value: '24.00' } });
  assert.equal(evaluateMatch(m, pricey, opts).rejected, 'buy_ratio_too_high');

  const cheapCard = classify('Sorcery Blaze Beta');
  assert.equal(evaluateMatch(cheapCard, item('x', { price: { value: '0.10' } }), opts).rejected, 'below_min_market');

  const auction = { ...classify('Sorcery Zap! Foil Beta'), auction: true };
  const bid = item('Sorcery Zap! Foil Beta', { currentBidPrice: { value: '5.00' } });
  assert.equal(evaluateMatch(auction, bid, opts).deal.buy_total, 6);
});

test('missing shipping is flagged, not guessed', () => {
  const m = classify('Sorcery Zap! Foil Beta');
  const { deal } = evaluateMatch(m, item('Sorcery Zap! Foil Beta', { shippingOptions: undefined }), opts);
  assert.equal(deal.shipping_unknown, true);
  assert.equal(deal.shipping, 0);
});

test('seller feedback gate', () => {
  assert.equal(sellerSkipReason(item('x'), opts), null);
  assert.equal(sellerSkipReason(item('x', { seller: { username: 'a', feedbackPercentage: '96.9', feedbackScore: 5 } }), opts), 'seller_low_feedback');
  assert.equal(sellerSkipReason(item('x', { seller: { username: 'a' } }), opts), 'seller_no_feedback');
  assert.equal(sellerSkipReason(item('x', { seller: { username: 'a', feedbackPercentage: '0.0', feedbackScore: 0 } }), opts), 'seller_no_feedback');
});

test('repeats are hidden unless the price dropped', () => {
  assert.equal(isRepeat({ buy_total: 10 }, undefined), false);
  assert.equal(isRepeat({ buy_total: 10 }, { last_price: '10' }), true);
  assert.equal(isRepeat({ buy_total: 9.5 }, { last_price: '10' }), false);
});

test('argument validation', () => {
  assert.equal(parseFindEbayDealsArgs(null).max_items, DEFAULTS.max_items);
  assert.throws(() => parseFindEbayDealsArgs({ max_items: 0 }), /max_items/);
  assert.throws(() => parseFindEbayDealsArgs({ max_buy_ratio: 'high' }), /max_buy_ratio/);
  assert.throws(() => parseFindEbayDealsArgs({ only_new: 'yes' }), /only_new/);
});

test('eBay client caches the token and falls back to EBAY_APP_ID/EBAY_CERT_ID', async () => {
  assert.throws(() => readEbayCredentials({}), /EBAY_CLIENT_ID/);
  assert.deepEqual(readEbayCredentials({ EBAY_APP_ID: 'a', EBAY_CERT_ID: 'b' }), { clientId: 'a', clientSecret: 'b' });

  let tokenCalls = 0;
  let clock = 0;
  const fetchImpl = async (url) => {
    if (url.includes('oauth2/token')) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: `t${tokenCalls}`, expires_in: 7200 }));
    }
    return new Response(JSON.stringify({ itemSummaries: [{ itemId: '1' }], total: 1 }));
  };
  const ebay = createEbayClient({ fetchImpl, env: { EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 's' }, now: () => clock });
  await ebay.searchPage({ q: 'sorcery', filter: '' });
  await ebay.searchPage({ q: 'sorcery', filter: '' });
  assert.equal(tokenCalls, 1);
  clock = 7200 * 1000; // past expiry
  await ebay.searchPage({ q: 'sorcery', filter: '' });
  assert.equal(tokenCalls, 2);
});

// --- end to end with fake clients ---------------------------------------------------

function fakeDb({ seen = [] } = {}) {
  const upserts = [];
  const from = (table) => {
    const q = {
      _table: table,
      select: () => q,
      eq: () => q,
      order: () => q,
      in: (_col, ids) => {
        q._ids = ids;
        return q;
      },
      range: () => q,
      maybeSingle: () => Promise.resolve({ data: { id: 'game-sorcery' }, error: null }),
      upsert: (rows) => {
        upserts.push(...rows);
        return Promise.resolve({ error: null });
      },
      then: (resolve, reject) => {
        let data = [];
        if (table === 'v_latest_prices') data = CARD_ROWS;
        if (table === 'ebay_deal_seen') data = seen.filter((s) => q._ids.includes(s.item_id));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return { from, upserts };
}

const fakeEbay = (items) => ({
  searchPage: async ({ offset }) => ({ items: offset === 0 ? items : [], hasNext: false, total: items.length }),
});

test('findEbayDeals end to end: deals sorted, lots separated, seen recorded', async () => {
  // ebayDeals.js imports the shared Supabase client, which needs these to exist at import time.
  process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
  process.env.SUPABASE_SERVICE_KEY ??= 'placeholder';
  const { findEbayDeals } = await import('../src/tools/ebayDeals.js');

  const items = [
    item('Sorcery Zap! Foil Beta', { itemId: 'A' }), // profit 13.10
    item('Sorcery Contested Realm Death Touch', { itemId: 'B', price: { value: '5.00' } }), // set uncertain, market 25
    item('Sorcery Contested Realm 100 card bulk lot', { itemId: 'C' }),
    item('Sorcery Grim Reaper Golden Reaper', { itemId: 'D' }),
    item('Sorcery Something Unknown', { itemId: 'E' }),
  ];
  const db = fakeDb();
  const r = await findEbayDeals({}, { db, ebay: fakeEbay(items), now: NOW });

  assert.equal(r.scanned, 5);
  assert.equal(r.matched, 2);
  assert.deepEqual(r.deals.map((d) => d.item_id), ['B', 'A']);
  assert.equal(r.deals[0].set_uncertain, true);
  assert.equal(r.lots.length, 1);
  assert.equal(r.ambiguous_count, 1);
  assert.equal(r.unmatched_count, 1);
  assert.deepEqual(db.upserts.map((u) => u.item_id).sort(), ['A', 'B']);

  // Second run: A already seen at the same price → hidden; B seen at a higher price → shown.
  const db2 = fakeDb({ seen: [{ item_id: 'A', last_price: 11 }, { item_id: 'B', last_price: 9 }] });
  const r2 = await findEbayDeals({}, { db: db2, ebay: fakeEbay(items), now: NOW });
  assert.deepEqual(r2.deals.map((d) => d.item_id), ['B']);
  assert.equal(r2.deals[0].price_dropped_from, 9);
  assert.equal(r2.repeats_hidden, 1);

  const r3 = await findEbayDeals({ only_new: false, record_seen: false }, { db: db2, ebay: fakeEbay(items), now: NOW });
  assert.equal(r3.deals.length, 2);
});
