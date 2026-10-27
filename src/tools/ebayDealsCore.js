// Pure logic for find_ebay_deals: argument parsing, title → card matching, and the
// profit math. No Supabase, tracing, dotenv or network imports, so tests can load it
// directly (see "Keep pure logic out of modules that import Supabase" in CLAUDE.md).

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  max_buy_ratio: 0.75,
  min_profit: 3.0,
  min_market: 5.0,
  include_auctions: true,
  auction_hours: 24,
  include_graded: false,
  only_new: true,
  max_items: 1000,
  // Resale cost model
  fee_pct: 0.15, // TCGplayer/eBay selling fees
  postage_under: 1.1, // plain envelope
  postage_over: 6.5, // tracked mailer
  postage_threshold: 50, // market price at which a card needs tracked shipping
  supplies: 0.3,
  // Search + seller filters
  min_price: 3,
  min_seller_feedback: 97,
  record_seen: true,
};

export const MAX_ITEMS_LIMIT = 10000; // Browse API caps offset + limit at 10,000

const NUMBER_RULES = {
  max_buy_ratio: { min: 0, max: 5 },
  min_profit: { min: -1000, max: 100000 },
  min_market: { min: 0, max: 100000 },
  auction_hours: { min: 0, max: 24 * 30 },
  fee_pct: { min: 0, max: 0.99 },
  postage_under: { min: 0, max: 1000 },
  postage_over: { min: 0, max: 1000 },
  postage_threshold: { min: 0, max: 100000 },
  supplies: { min: 0, max: 1000 },
  min_price: { min: 0, max: 100000 },
  min_seller_feedback: { min: 0, max: 100 },
};
const BOOLEAN_ARGS = ['include_auctions', 'include_graded', 'only_new', 'record_seen'];

// The low-level MCP Server doesn't enforce inputSchema, so every argument is checked here.
export function parseFindEbayDealsArgs(args = {}) {
  const input = args ?? {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    // `??` so an explicit null also means "use the default".
    out[key] = input[key] ?? fallback;
  }
  for (const [key, { min, max }] of Object.entries(NUMBER_RULES)) {
    const v = out[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new Error(`${key} must be a number between ${min} and ${max}.`);
    }
  }
  for (const key of BOOLEAN_ARGS) {
    if (typeof out[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
  }
  if (!Number.isInteger(out.max_items) || out.max_items < 1 || out.max_items > MAX_ITEMS_LIMIT) {
    throw new Error(`max_items must be an integer between 1 and ${MAX_ITEMS_LIMIT}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

// Lowercase, drop apostrophes (so "Yaga's" → "yagas"), turn every other non-alphanumeric
// character into a space, collapse whitespace. Card names and titles go through the same
// function, so "Zap!" → "zap" and "Seven-League Boots" → "seven league boots" on both sides.
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/['‘’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Whole-word search inside an already-normalised string. Returns every start index.
function findWhole(haystack, needle) {
  const hits = [];
  if (!needle) return hits;
  const padded = ` ${haystack} `;
  const target = ` ${needle} `;
  let from = 0;
  for (;;) {
    const i = padded.indexOf(target, from);
    if (i === -1) break;
    hits.push(i); // index in `haystack` (padding offset cancels the leading space of target)
    from = i + 1;
  }
  return hits;
}

const hasWord = (normTitle, phrase) => findWhole(normTitle, phrase).length > 0;
const hasAny = (normTitle, phrases) => phrases.find((p) => hasWord(normTitle, p));

// ---------------------------------------------------------------------------
// Card index
// ---------------------------------------------------------------------------

// Card names in the DB carry printing info as parenthesised suffixes: "Blink (Foil)",
// "Druid (Box Topper) (Foil)", "Day of Judgment (Judge Promo)". Only standard printings
// ("Name" / "Name (Foil)") are matchable — a promo/misprint/box-topper often trades at a
// very different price from the regular card, and titles rarely say which one they are.
const FOIL_SUFFIX = /\s*\(foil\)\s*$/i;

export function buildCardIndex(rows) {
  const byBase = new Map(); // normalised base name → { display, printings: [...] }
  let skippedVariants = 0;
  for (const row of rows ?? []) {
    const name = String(row.name ?? '');
    const nameSaysFoil = FOIL_SUFFIX.test(name);
    const base = name.replace(FOIL_SUFFIX, '').trim();
    if (base.includes('(')) {
      skippedVariants += 1;
      continue;
    }
    const key = normalize(base);
    // Catalog rows for sealed product ("Sorcery: Contested Realm - Pledge Pack") would
    // otherwise match the game name in almost every title.
    if (!key || hasWord(key, 'sorcery') || hasWord(key, 'contested realm')) {
      skippedVariants += 1;
      continue;
    }
    if (!byBase.has(key)) byBase.set(key, { display: base, printings: [] });
    byBase.get(key).printings.push({
      card_id: row.card_id ?? row.id,
      name,
      set_name: row.set_name,
      // A handful of rows have the foil flag and the name suffix out of sync
      // (e.g. "Leadworks (foil)" with foil=false); the name is the more reliable signal.
      foil: nameSaysFoil || row.foil === true,
      market: row.tcgplayer_market == null ? null : Number(row.tcgplayer_market),
    });
  }
  // Longest first, so the first hit for a given position is the most specific name.
  const names = [...byBase.keys()].sort((a, b) => b.length - a.length);
  const sets = new Set(rows?.map((r) => r.set_name).filter(Boolean));
  return { byBase, names, sets, skippedVariants };
}

// ---------------------------------------------------------------------------
// Title classification
// ---------------------------------------------------------------------------

// Set names as they appear in titles → cards.set_name. Sets eBay sellers use that the DB
// doesn't track (e.g. Dragonlord) still count as "a set was named", so the title can't
// silently fall back to another set's price.
export const SET_ALIASES = [
  ['arthurian legends', 'Arthurian Legends'],
  ['arthurian', 'Arthurian Legends'],
  ['gothic', 'Gothic'],
  ['alpha', 'Alpha'],
  ['beta', 'Beta'],
  ['dragonlord', 'Dragonlord'],
];

const OTHER_GAMES = [
  'mtg', 'magic the gathering', 'magic gathering', 'pokemon', 'yugioh', 'yu gi oh', 'lorcana',
  'flesh and blood', 'one piece', 'digimon', 'riftbound', 'star wars unlimited',
];

const SKIP_RULES = [
  ['proxy', ['proxy', 'proxies']],
  ['custom', ['custom', 'orica', 'orika', 'fan made', 'fanmade', 'fan art', 'altered', 'alter', 'hand painted']],
  ['digital', ['digital', 'code card', 'code cards', 'online code', 'redemption code']],
  ['art_card', ['art card', 'art cards', 'artist proof', 'art print', 'poster']],
  ['condition', ['damaged', 'dmg', 'heavily played', 'heavy play', 'hp', 'poor', 'creased', 'water damage']],
  ['packaging', ['empty box', 'empty', 'packaging', 'wrapper', 'wrappers']],
  ['accessory', ['playmat', 'play mat', 'sleeves', 'deck box', 'binder', 'dice', 'token set', 'card storage']],
];

// Words that mark a non-standard printing. Those titles are reported as ambiguous rather
// than valued against the regular card's price.
const VARIANT_WORDS = [
  'promo', 'box topper', 'topper', 'pledge pack', 'pledge', 'judge', 'misprint', 'error',
  'corrected', 'draft kit', 'prerelease', 'pre release', 'buy a box', 'grand contest',
  'serialized', 'signed', 'autographed', 'sketch',
];

// "Pack fresh" etc. describe a single's condition, not sealed product.
const PACK_FRESH = /\b(pack fresh|fresh (from|out of) (the )?pack|fresh pack|pulled from (a )?pack|pack pulled|straight from pack)\b/g;
const SEALED_WORDS = [
  'booster box', 'booster pack', 'booster packs', 'booster', 'boosters', 'sealed', 'display',
  'case', 'pack', 'packs', 'box', 'boxes', 'precon', 'preconstructed', 'starter deck',
  'starter kit', 'deck', 'blister', 'collector box', 'gift box', 'pledge kit',
];
const GRADED_WORDS = ['psa', 'bgs', 'cgc', 'sgc', 'tag', 'beckett', 'graded', 'slab', 'slabbed', 'gem mint 10'];
const LOT_WORDS = ['lot', 'lots', 'bundle', 'collection', 'bulk', 'complete set', 'full set', 'mixed', 'assorted', 'random'];

const NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10 };

// Returns { quantity, unclear } — explicit markers only ("x2", "2x", "x 2", "playset",
// "set of 4", "4 copies", "pair"). Conflicting markers → unclear.
export function detectQuantity(normTitle) {
  const found = new Set();
  const add = (n) => {
    const v = Number(n);
    if (Number.isInteger(v) && v >= 1 && v <= 1000) found.add(v);
  };
  for (const m of normTitle.matchAll(/(?:^| )x ?(\d{1,3})(?= |$)/g)) add(m[1]);
  for (const m of normTitle.matchAll(/(?:^| )(\d{1,3}) ?x(?= |$)/g)) add(m[1]);
  for (const m of normTitle.matchAll(/(?:^| )(?:set|lot|pack) of (\d{1,3}|two|three|four|five|six|eight|ten)(?= |$)/g)) {
    add(NUMBER_WORDS[m[1]] ?? m[1]);
  }
  for (const m of normTitle.matchAll(/(?:^| )(\d{1,3}|two|three|four) (?:copies|copy|cards)(?= |$)/g)) {
    add(NUMBER_WORDS[m[1]] ?? m[1]);
  }
  if (hasWord(normTitle, 'playset') || hasWord(normTitle, 'play set')) found.add(4);
  if (hasWord(normTitle, 'pair')) found.add(2);
  if (found.size === 0) return { quantity: 1, unclear: false };
  if (found.size > 1) return { quantity: null, unclear: true, candidates: [...found] };
  return { quantity: [...found][0], unclear: false };
}

// Finds the card the title is about. Returns one of:
//   { status: 'matched', base, start, end }
//   { status: 'none' }
//   { status: 'ambiguous', reason, names }
export function matchCardName(normTitle, index) {
  const hits = [];
  for (const name of index.names) {
    for (const start of findWhole(normTitle, name)) {
      hits.push({ name, start, end: start + name.length });
    }
  }
  if (hits.length === 0) return { status: 'none' };

  // Keep only hits that aren't inside a longer hit ("blaze" inside "blaze of glory").
  const maximal = hits.filter(
    (h) => !hits.some((o) => o !== h && o.start <= h.start && o.end >= h.end && o.name.length > h.name.length)
  );
  const distinct = [...new Set(maximal.map((h) => h.name))];
  if (distinct.length === 1) {
    const h = maximal[0];
    return { status: 'matched', base: h.name, start: h.start, end: h.end };
  }

  // More than one card name. Two equally long names → can't pick. A longer name plus
  // unrelated shorter ones usually means a multi-card listing, which we also don't value.
  distinct.sort((a, b) => b.length - a.length);
  const reason = distinct[0].length === distinct[1].length ? 'two_cards_match_equally' : 'multiple_card_names';
  return { status: 'ambiguous', reason, names: distinct.map((n) => index.byBase.get(n).display) };
}

// An auction with a Buy It Now option is bought at the fixed price, so it counts as fixed.
export const isAuction = (item) =>
  (item.buyingOptions ?? []).includes('AUCTION') && !(item.buyingOptions ?? []).includes('FIXED_PRICE');

// Auctions are only worth showing when they end soon; returns a skip reason or null.
export function auctionSkipReason(item, opts, now = new Date()) {
  if (!isAuction(item)) return null;
  if (!opts.include_auctions) return 'auction_excluded';
  const end = item.itemEndDate ? new Date(item.itemEndDate) : null;
  if (!end || Number.isNaN(end.getTime())) return 'auction_no_end_date';
  const hoursLeft = (end.getTime() - now.getTime()) / 3_600_000;
  if (hoursLeft < 0) return 'auction_ended';
  if (hoursLeft > opts.auction_hours) return 'auction_ends_too_late';
  return null;
}

// Classifies one eBay item summary. Pure: everything it needs comes in through arguments.
// Result `kind` is one of: 'skip', 'lot', 'ambiguous', 'unmatched', 'matched'.
export function classifyItem(item, index, opts, now = new Date()) {
  const title = item.title ?? '';
  const t = normalize(title);
  const skip = (reason) => ({ kind: 'skip', reason, title });

  // Must be about Sorcery at all — "sorcery" alone also hits MTG listings (it's a card type there).
  if (!hasWord(t, 'sorcery') && !hasWord(t, 'contested realm')) return skip('not_sorcery');
  if (hasAny(t, OTHER_GAMES)) return skip('other_game');

  // Find the card first, then run every keyword check on the title with the card name
  // cut out, so a card whose name contains "box", "promo", "lot", a set name, etc. is
  // never mistaken for that keyword.
  const match = matchCardName(t, index);
  const rest =
    match.status === 'matched'
      ? `${t.slice(0, match.start)} ${t.slice(match.end)}`.replace(/\s+/g, ' ').trim()
      : t;

  for (const [reason, words] of SKIP_RULES) {
    if (hasAny(rest, words)) return skip(reason);
  }

  // eBay's trading-card conditions are "Graded" (2750) and "Ungraded" (4000).
  const graded =
    Boolean(hasAny(rest, GRADED_WORDS)) || /^graded\b/i.test(item.condition ?? '') || String(item.conditionId) === '2750';
  if (graded && !opts.include_graded) return skip('graded');

  // Variation listings ("choose your card") show one price for many different cards.
  if (item.itemGroupHref || item.itemGroupType) {
    return { kind: 'ambiguous', reason: 'multi_variation_listing', title };
  }

  const variant = hasAny(rest, VARIANT_WORDS);
  if (variant) return { kind: 'ambiguous', reason: `variant_printing:${variant}`, title };

  if (hasAny(rest.replace(PACK_FRESH, ' '), SEALED_WORDS)) return skip('sealed_product');

  const qty = detectQuantity(rest);
  const isLotWord = hasAny(rest, LOT_WORDS);
  if (isLotWord || (qty.quantity ?? 0) >= 5 || (qty.candidates ?? []).some((n) => n >= 5)) {
    return { kind: 'lot', title, card_count: qty.quantity ?? null };
  }

  if (match.status === 'none') return { kind: 'unmatched', reason: 'no_card_name', title };
  if (match.status === 'ambiguous') {
    return { kind: 'ambiguous', reason: match.reason, title, candidates: match.names };
  }
  if (qty.unclear) return { kind: 'ambiguous', reason: 'quantity_unclear', title };

  const entry = index.byBase.get(match.base);
  const foil = !(hasWord(rest, 'non foil') || hasWord(rest, 'nonfoil')) && (hasWord(rest, 'foil') || hasWord(rest, 'rainbow'));

  const namedSets = new Set();
  let remaining = rest;
  for (const [alias, setName] of SET_ALIASES) {
    if (hasWord(remaining, alias)) {
      namedSets.add(setName);
      remaining = remaining.replace(new RegExp(`(^| )${alias}(?= |$)`, 'g'), ' ');
    }
  }
  if (namedSets.size > 1) {
    return { kind: 'ambiguous', reason: 'multiple_sets_named', title, candidates: [...namedSets] };
  }
  const namedSet = [...namedSets][0] ?? null;

  let printings = entry.printings.filter((p) => p.foil === foil);
  if (namedSet) printings = printings.filter((p) => p.set_name === namedSet);
  if (printings.length === 0) {
    return {
      kind: 'unmatched',
      reason: namedSet ? `no_${foil ? 'foil' : 'nonfoil'}_printing_in_${namedSet}` : `no_${foil ? 'foil' : 'nonfoil'}_printing`,
      title,
      card_name: entry.display,
    };
  }
  const priced = printings.filter((p) => p.market != null && p.market > 0);
  if (priced.length === 0) return { kind: 'unmatched', reason: 'no_market_price', title, card_name: entry.display };

  // No set named and several sets → value at the cheapest set, flagged.
  priced.sort((a, b) => a.market - b.market);
  const chosen = priced[0];
  const setUncertain = !namedSet && new Set(priced.map((p) => p.market)).size > 1;

  const auction = isAuction(item);
  const auctionSkip = auctionSkipReason(item, opts, now);
  if (auctionSkip) return skip(auctionSkip);

  return {
    kind: 'matched',
    title,
    card: chosen,
    card_name: entry.display,
    foil,
    quantity: qty.quantity,
    set_uncertain: setUncertain,
    graded,
    auction,
  };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const money = (v) => {
  const n = Number(v?.value ?? v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => Math.round(n * 100) / 100;

export function readShipping(item) {
  const opt = item.shippingOptions?.[0];
  const cost = money(opt?.shippingCost);
  if (cost == null) return { shipping: 0, shipping_unknown: true };
  return { shipping: cost, shipping_unknown: false };
}

// Per-card resale costs apply to every copy, since copies are resold one at a time.
export function computeProfit({ market, quantity, buyPrice, shipping }, opts) {
  const marketTotal = market * quantity;
  const buyTotal = buyPrice + shipping;
  const resaleNet = marketTotal * (1 - opts.fee_pct);
  const postageEach = market < opts.postage_threshold ? opts.postage_under : opts.postage_over;
  const postage = postageEach * quantity;
  const supplies = opts.supplies * quantity;
  const expectedProfit = resaleNet - postage - supplies - buyTotal;
  return {
    market_total: round2(marketTotal),
    buy_total: round2(buyTotal),
    resale_net: round2(resaleNet),
    postage: round2(postage),
    supplies: round2(supplies),
    expected_profit: round2(expectedProfit),
    buy_ratio: marketTotal > 0 ? Math.round((buyTotal / marketTotal) * 1000) / 1000 : null,
  };
}

// Seller gate: returns a skip reason or null.
export function sellerSkipReason(item, opts) {
  const pct = item.seller?.feedbackPercentage;
  const score = item.seller?.feedbackScore;
  if (pct == null || pct === '' || score === 0) return 'seller_no_feedback';
  if (Number(pct) < opts.min_seller_feedback) return 'seller_low_feedback';
  return null;
}

// Takes a 'matched' classification plus the raw item and decides whether it's a deal.
// Returns { deal } or { rejected: reason }.
export function evaluateMatch(match, item, opts) {
  const { shipping, shipping_unknown } = readShipping(item);
  const buyPrice = match.auction ? money(item.currentBidPrice) ?? money(item.price) : money(item.price);
  if (buyPrice == null) return { rejected: 'no_price' };

  const market = match.card.market;
  if (market < opts.min_market) return { rejected: 'below_min_market' };

  const p = computeProfit({ market, quantity: match.quantity, buyPrice, shipping }, opts);
  if (p.buy_ratio > opts.max_buy_ratio) return { rejected: 'buy_ratio_too_high', ...p };
  if (p.expected_profit < opts.min_profit) return { rejected: 'profit_too_low', ...p };

  return {
    deal: {
      card_name: match.card_name,
      card_id: match.card.card_id,
      set_name: match.card.set_name,
      foil: match.foil,
      quantity: match.quantity,
      ebay_title: item.title,
      buy_total: p.buy_total,
      price: round2(buyPrice),
      shipping: round2(shipping),
      market: round2(market),
      market_total: p.market_total,
      buy_ratio: p.buy_ratio,
      expected_profit: p.expected_profit,
      resale_net: p.resale_net,
      listing_type: match.auction ? 'auction' : 'fixed_price',
      ends_at: match.auction ? item.itemEndDate ?? null : null,
      seller: item.seller?.username ?? null,
      feedback: item.seller?.feedbackPercentage == null ? null : Number(item.seller.feedbackPercentage),
      url: item.itemWebUrl,
      item_id: item.itemId,
      condition: item.condition ?? null,
      set_uncertain: match.set_uncertain,
      shipping_unknown,
      graded: match.graded,
    },
  };
}

// A previously seen item comes back only if its total price dropped.
export function isRepeat(deal, seenRow) {
  if (!seenRow) return false;
  const last = Number(seenRow.last_price);
  if (!Number.isFinite(last)) return false;
  return !(deal.buy_total < last - 0.005);
}
