// Live smoke test for find_ebay_deals: calls the real tool (real eBay + Supabase) and
// prints a readable report. Not part of `npm test`, which must stay offline.
//
//   npm run test:deals                      # tool defaults, but doesn't record seen deals
//   npm run test:deals -- --record          # also upsert deals into ebay_deal_seen
//   npm run test:deals -- --max-items=300   # smaller scan
//   npm run test:deals -- --json            # dump the full result as JSON at the end
//
// Seen-deal recording is off by default here so repeated runs show the same deals while
// you tune matching. Pass --record to behave exactly like the MCP tool's defaults.
import '../src/env.js'; // must be first: loads .env before supabaseClient.js reads it

const { findEbayDeals } = await import('../src/tools/ebayDeals.js');
const { getDefaultEbayClient, CCG_INDIVIDUAL_CARDS_CATEGORY } = await import('../src/ebayClient.js');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const args = { record_seen: flag('record') };
if (value('max-items')) args.max_items = Number(value('max-items'));

const money = (n) => (n == null ? '   ?' : `$${n.toFixed(2)}`);
const clip = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
const pad = (s, n) => clip(s, n).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const heading = (s) => console.log(`\n=== ${s} ${'='.repeat(Math.max(0, 70 - s.length))}`);
const counts = (obj) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${pad(k, 34)} ${lpad(v, 5)}`)
    .join('\n') || '  (none)';

const started = Date.now();

heading('eBay category check');
try {
  const name = await getDefaultEbayClient().getCategoryName(CCG_INDIVIDUAL_CARDS_CATEGORY);
  console.log(`  category ${CCG_INDIVIDUAL_CARDS_CATEGORY} = "${name}"${name === 'CCG Individual Cards' ? '  ✓' : '  ✗ expected "CCG Individual Cards"'}`);
} catch (err) {
  console.log(`  could not verify category: ${err.message}`);
}

let r;
try {
  r = await findEbayDeals(args);
} catch (err) {
  console.error(`\nfind_ebay_deals failed: ${err.message}`);
  process.exit(1);
}
const secs = ((Date.now() - started) / 1000).toFixed(1);

heading('Totals');
console.log(`  scanned            ${r.scanned}   (${r.search.pages_fetched} API pages, ${secs}s)`);
console.log(`  matched to a card  ${r.matched}`);
console.log(`  deals              ${r.deal_count}`);
console.log(`  lots               ${r.lots.length}`);
console.log(`  ambiguous          ${r.ambiguous_count}`);
console.log(`  unmatched          ${r.unmatched_count}`);
console.log(`  repeats hidden     ${r.repeats_hidden}`);
console.log(`  catalog            ${r.catalog.cards_loaded} cards, ${r.catalog.matchable_names} matchable names, ${r.catalog.variant_printings_ignored} variant printings ignored`);
console.log(`  record_seen        ${r.settings.record_seen}`);
if (r.warnings.length) console.log(`  WARNINGS:\n    ${r.warnings.join('\n    ')}`);

heading('Skipped before matching / seller checks');
console.log(counts(r.skipped));
heading('Matched but not a deal');
console.log(counts(r.rejected));

heading(`Top ${Math.min(10, r.deals.length)} deals (of ${r.deal_count})`);
if (r.deals.length === 0) console.log('  (none)');
else {
  console.log(
    `  ${pad('card', 26)} ${pad('set', 10)} ${pad('foil', 4)} ${lpad('qty', 3)} ${lpad('buy', 8)} ${lpad('market', 8)} ${lpad('ratio', 5)} ${lpad('profit', 8)}  type  flags`
  );
  for (const d of r.deals.slice(0, 10)) {
    const flags = [d.set_uncertain && 'set?', d.shipping_unknown && 'ship?', d.price_dropped_from && `was ${money(d.price_dropped_from)}`]
      .filter(Boolean)
      .join(' ');
    console.log(
      `  ${pad(d.card_name, 26)} ${pad(d.set_name, 10)} ${pad(d.foil ? 'yes' : '', 4)} ${lpad(d.quantity, 3)} ${lpad(money(d.buy_total), 8)} ${lpad(money(d.market_total), 8)} ${lpad(d.buy_ratio.toFixed(2), 5)} ${lpad(money(d.expected_profit), 8)}  ${d.listing_type === 'auction' ? 'AUC ' : 'BIN '}  ${flags}`
    );
    console.log(`      "${clip(d.ebay_title, 90)}"`);
    console.log(`      ${d.seller} (${d.feedback}%)${d.ends_at ? `  ends ${d.ends_at}` : ''}  ${d.url}`);
  }
}

heading(`Lots for manual review (${r.lots.length})`);
if (r.lots.length === 0) console.log('  (none)');
for (const l of r.lots.slice(0, 25)) {
  console.log(`  ${lpad(money(l.buy_total), 9)}  ${l.listing_type === 'auction' ? 'AUC' : 'BIN'}  ${clip(l.ebay_title, 80)}`);
  console.log(`             ${l.url}`);
}
if (r.lots.length > 25) console.log(`  … ${r.lots.length - 25} more (use --json)`);

heading('10 sample ambiguous titles');
for (const a of r.ambiguous_samples.slice(0, 10)) {
  console.log(`  [${a.reason}] ${clip(a.title, 85)}${a.candidates ? `\n      candidates: ${a.candidates.join(', ')}` : ''}`);
}
if (r.ambiguous_samples.length === 0) console.log('  (none)');

heading('10 sample unmatched titles');
for (const u of r.unmatched_samples.slice(0, 10)) {
  console.log(`  [${u.reason}${u.card_name ? ` → ${u.card_name}` : ''}] ${clip(u.title, 85)}`);
}
if (r.unmatched_samples.length === 0) console.log('  (none)');

if (flag('json')) {
  heading('Full JSON');
  console.log(JSON.stringify(r, null, 2));
}

process.exit(0);
