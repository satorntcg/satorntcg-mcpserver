import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from '../supabaseClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'packing-slips');

// Orders below this order_total print on a single #10 windowed-envelope slip;
// orders at or above it print the standard full-page format, per Chris's shipping process.
const WINDOWED_ENVELOPE_THRESHOLD = 20;

// Calls TCGplayer's Seller Portal export API directly instead of driving a browser click.
// A synthetic (CDP-dispatched) click on the portal's "Packing Slip" button stopped producing
// a real export request partway through processing orders one session — the dropdown opened
// and closed normally, but no POST to this endpoint ever fired, while an identical manual click
// worked immediately. Captured a real manual click's request (DevTools → Copy as cURL) and
// confirmed the endpoint only needs a valid session cookie + this JSON body, no browser/click
// involved at all — see the request shape below.
const EXPORT_URL = 'https://order-management-api.tcgplayer.com/orders/packing-slips/export?api-version=2.0';

export const printPackingSlipTool = {
  name: 'print_packing_slip',
  description:
    `Generate TCGplayer packing-slip PDF(s) for one or more order numbers by calling the Seller Portal's export API directly (bypasses the "Packing Slip" button, which stopped responding to automated clicks). Saves each PDF to a local packing-slips/ folder and returns its path — open or print that file yourself. If format is omitted, it's chosen automatically per order from tcgplayer_orders.order_total: orders below $${WINDOWED_ENVELOPE_THRESHOLD} print as "LeftWindowedEnvelope" (single #10 windowed envelope), orders at or above that print as "Default" (standard full-page). A mixed batch under auto mode is split into one export call per format, producing multiple PDFs. Pass format explicitly to force one format for every requested order instead. Requires TCGPLAYER_COOKIE in .env: a session cookie captured from a logged-in Seller Portal tab (DevTools → Network → any request → Copy as cURL → take the Cookie header value). That cookie expires/rotates periodically — a 401/403 here means it needs refreshing.`,
  inputSchema: {
    type: 'object',
    properties: {
      order_numbers: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'One or more order_number values, e.g. ["F0DFDDC3-36957C-6C74A"].',
      },
      format: {
        type: 'string',
        enum: ['Default', 'LeftWindowedEnvelope'],
        description:
          'Optional explicit override applied to every order in the request. "Default" is the standard full-page packing slip. "LeftWindowedEnvelope" is the Seller Portal\'s "Print #10 Left Window (Single)" option. Omit to auto-select per order by order_total (see tool description).',
      },
    },
    required: ['order_numbers'],
  },
  handler: async ({ order_numbers, format }) => {
    const cookie = process.env.TCGPLAYER_COOKIE;
    if (!cookie) {
      throw new Error(
        'TCGPLAYER_COOKIE is not set in .env. Capture a fresh session cookie from a logged-in Seller Portal tab (DevTools → Network tab → any request → right-click → Copy as cURL → pull out the Cookie header value) and set TCGPLAYER_COOKIE to it.'
      );
    }

    const groups = format
      ? [{ format, order_numbers, unknown_total: [] }]
      : await groupOrdersByAutoFormat(order_numbers);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const results = [];
    for (const group of groups) {
      const buffer = await exportPackingSlips(cookie, group.format, group.order_numbers);
      const label = group.order_numbers.length === 1 ? group.order_numbers[0] : `${group.order_numbers.length}-orders`;
      const filePath = path.join(OUTPUT_DIR, `packing-slip-${group.format}-${label}-${Date.now()}.pdf`);
      await fs.writeFile(filePath, buffer);
      results.push({
        file_path: filePath,
        format: group.format,
        order_numbers: group.order_numbers,
        bytes: buffer.length,
        ...(group.unknown_total.length > 0 && {
          note: `order_total not on file for ${group.unknown_total.join(', ')} — defaulted to "LeftWindowedEnvelope" format`,
        }),
      });
    }

    return order_numbers.length === 1 && !format ? results[0] : { slips: results };
  },
};

async function groupOrdersByAutoFormat(orderNumbers) {
  const { data, error } = await supabase
    .from('tcgplayer_orders')
    .select('order_number, order_total')
    .in('order_number', orderNumbers);
  if (error) throw new Error(error.message);

  const totalByOrder = Object.fromEntries((data ?? []).map((o) => [o.order_number, o.order_total]));

  const windowed = [];
  const standard = [];
  const unknownTotal = [];
  for (const orderNumber of orderNumbers) {
    const total = totalByOrder[orderNumber];
    if (total == null) unknownTotal.push(orderNumber);
    if (total != null && total >= WINDOWED_ENVELOPE_THRESHOLD) standard.push(orderNumber);
    else windowed.push(orderNumber);
  }

  const groups = [];
  if (standard.length > 0) groups.push({ format: 'Default', order_numbers: standard, unknown_total: [] });
  if (windowed.length > 0) {
    groups.push({
      format: 'LeftWindowedEnvelope',
      order_numbers: windowed,
      unknown_total: unknownTotal.filter((o) => windowed.includes(o)),
    });
  }
  return groups;
}

async function exportPackingSlips(cookie, format, orderNumbers) {
  // TCGplayer's own portal sends the browser's local UTC offset in hours (e.g. -4 for EDT),
  // not minutes — Date.getTimezoneOffset() is minutes-behind-UTC with the opposite sign.
  const timezoneOffset = -(new Date().getTimezoneOffset() / 60);

  const res = await fetch(EXPORT_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: 'https://sellerportal.tcgplayer.com',
      referer: 'https://sellerportal.tcgplayer.com/',
      cookie,
    },
    body: JSON.stringify({ sortingType: 'ByRelease', format, timezoneOffset, orderNumbers }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `TCGplayer rejected the request (${res.status}) — TCGPLAYER_COOKIE has likely expired. Capture a fresh one and update .env. Raw response: ${text}`
      );
    }
    throw new Error(`TCGplayer packing-slip export failed (${res.status}): ${text}`);
  }

  return Buffer.from(await res.arrayBuffer());
}
