import { getPriceAlertsTool } from './priceAlerts.js';
import { getInventorySummaryTool, getLatestPricesTool } from './inventory.js';
import { getBoxPnlTool, getGlobalPnlTool } from './pnl.js';
import { getEbayListingsTool } from './listings.js';
import {
  getTcgplayerOrdersTool,
  createTcgplayerOrderTool,
  getOrdersMissingListingsTool,
} from './tcgplayerOrders.js';
import { debugNetworkTool } from './debugNetwork.js';

// Add new tools here — this is the single place that wires a tool definition
// into the running server.
export const tools = [
  getPriceAlertsTool,
  getInventorySummaryTool,
  getLatestPricesTool,
  getBoxPnlTool,
  getGlobalPnlTool,
  getEbayListingsTool,
  getTcgplayerOrdersTool,
  createTcgplayerOrderTool,
  getOrdersMissingListingsTool,
  debugNetworkTool, // TEMPORARY — remove once fetch-failed issue is resolved
];
