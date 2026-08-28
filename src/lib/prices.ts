// Token pricing for live traces.
//
// Why this exists: the amount stated in a Section 91 / Section 94 notice is
// derived from the USD value of the traced transfers. Until now those values came
// from a hardcoded table (`ETH = $3400`), so a notice served on an exchange could
// state a figure that was months out of date — the one number in this app that
// really must not be invented.
//
// CoinGecko's /simple/price is used because it needs no key for light use, and
// returns USD and INR in one call. Everything degrades: a missing key, a rate
// limit or an outage falls back to the static table below, and a trace is never
// blocked on a price lookup.

import type { TokenSymbol } from "./domain";

export type Price = { usd: number; inr: number };
export type PriceTable = Record<TokenSymbol, Price>;

/**
 * Approximate USD/INR used only to derive the fallback table.
 *
 * Deliberately NOT used when live prices are available. It exists so an offline
 * trace still shows a plausible rupee figure rather than zero; anything an
 * officer serves on an exchange should come from a live trace.
 */
const FALLBACK_USD_INR = 88;

/** Static last-resort prices. Stablecoins are pegged; the rest are round. */
const FALLBACK_USD: Record<TokenSymbol, number> = {
  USDT: 1,
  USDC: 1,
  ETH: 3400,
  BTC: 64000,
  MATIC: 0.7,
  TRX: 0.13,
  SOL: 150,
};

export const FALLBACK_PRICES: PriceTable = Object.fromEntries(
  (Object.keys(FALLBACK_USD) as TokenSymbol[]).map((k) => [
    k,
    { usd: FALLBACK_USD[k], inr: FALLBACK_USD[k] * FALLBACK_USD_INR },
  ])
) as PriceTable;

/** CoinGecko's coin ids for the tokens this app traces. */
const COIN_IDS: Record<TokenSymbol, string> = {
  USDT: "tether",
  USDC: "usd-coin",
  ETH: "ethereum",
  BTC: "bitcoin",
  MATIC: "matic-network",
  TRX: "tron",
  SOL: "solana",
};

/**
 * How long a price quote is reused.
 *
 * This is set by the MONTHLY credit budget, not by how fresh we'd like prices to
 * be. A free CoinGecko Demo plan is ~10,000 credits/month — about 330/day — and
 * /simple/price costs one credit per call. A 60-second TTL would allow 1,440
 * calls/day and exhaust the month in a week, at which point every trace silently
 * reverts to the static table.
 *
 * 15 minutes caps us at 96 calls/day (~2,900/month), leaving 3x headroom. Crypto
 * does not move far enough in 15 minutes to change what an officer writes on a
 * freeze notice, so the accuracy cost is nil and the quota cost is decisive.
 */
const CACHE_TTL_MS = 15 * 60_000;

/**
 * Monthly call ceiling, with ~10% held back.
 *
 * Belt-and-braces only: the TTL above is the real protection. Note this counter
 * lives in memory, so a server restart resets it — on Render's free tier the
 * service sleeps when idle and the count starts over. That is acceptable
 * precisely because the TTL alone already keeps us an order of magnitude clear
 * of the cap; this exists to catch a pathological loop, not to do the budgeting.
 */
const MONTHLY_CALL_BUDGET = 9_000;
let monthKey = "";
let monthCalls = 0;

function budgetAvailable(): boolean {
  const now = new Date();
  const key = `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
  if (key !== monthKey) {
    monthKey = key;
    monthCalls = 0;
  }
  return monthCalls < MONTHLY_CALL_BUDGET;
}

type Cached = { at: number; table: PriceTable; live: boolean };
let cache: Cached | null = null;
// Shared so a breadth-first trace fanning out over dozens of wallets triggers
// one price request, not one per wallet.
let inFlight: Promise<PriceTable> | null = null;

function coingeckoUrl(): { url: string; headers: Record<string, string> } {
  const key = process.env.COINGECKO_API_KEY;
  const ids = Array.from(new Set(Object.values(COIN_IDS))).join(",");
  const qs = `ids=${ids}&vs_currencies=usd,inr`;

  // Host selection must be explicit, NOT sniffed from the key.
  //
  // An earlier version treated a "CG-" prefix as "this is a paid Pro key" and
  // sent it to pro-api.coingecko.com. That is wrong: free Demo keys are ALSO
  // "CG-"-prefixed, so a Demo key got posted to the Pro host, came back 401, and
  // every trace fell back to the static table while looking perfectly healthy.
  // Demo is the overwhelmingly common case, so it is the default; Pro is opt-in.
  if (key && process.env.COINGECKO_PRO === "true") {
    return {
      url: `https://pro-api.coingecko.com/api/v3/simple/price?${qs}`,
      headers: { "x-cg-pro-api-key": key },
    };
  }
  return {
    url: `https://api.coingecko.com/api/v3/simple/price?${qs}`,
    headers: key ? { "x-cg-demo-api-key": key } : {},
  };
}

async function fetchPrices(): Promise<PriceTable> {
  const { url, headers } = coingeckoUrl();
  const res = await fetch(url, {
    headers,
    cache: "no-store",
    // Never let a slow price API hold up a trace; the route has its own budget.
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, { usd?: number; inr?: number }>;

  const table = { ...FALLBACK_PRICES };
  let hits = 0;
  for (const sym of Object.keys(COIN_IDS) as TokenSymbol[]) {
    const row = body[COIN_IDS[sym]];
    // Only override a fallback when the response actually carried a usable
    // number — a partial response shouldn't zero out the rest of the table.
    if (row && typeof row.usd === "number" && row.usd > 0) {
      table[sym] = {
        usd: row.usd,
        inr: typeof row.inr === "number" && row.inr > 0 ? row.inr : row.usd * FALLBACK_USD_INR,
      };
      hits++;
    }
  }
  if (hits === 0) throw new Error("CoinGecko returned no usable prices");
  return table;
}

/**
 * Current prices. Always resolves — never rejects.
 *
 * Degradation order, best first:
 *   1. fresh live quote
 *   2. cached live quote, even an expired one
 *   3. the static table
 *
 * Step 2 matters: a stale-but-real ETH price from an hour ago is far closer to
 * the truth than the hardcoded $3400, so an outage or an exhausted budget must
 * never throw away a good quote we already hold.
 */
export async function getPrices(): Promise<PriceTable> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.table;
  if (inFlight) return inFlight;

  // Out of monthly budget: serve what we have rather than spend a credit we may
  // need for an actual notice later in the month.
  if (!budgetAvailable()) {
    if (cache) return cache.table;
    return FALLBACK_PRICES;
  }

  monthCalls++;
  inFlight = fetchPrices()
    .then((table) => {
      cache = { at: Date.now(), table, live: true };
      return table;
    })
    .catch((err) => {
      console.warn("[prices] live lookup failed:", (err as Error).message);
      if (cache?.live) {
        // Keep the last good live table and push its timestamp forward a little,
        // so a hard outage doesn't mean one failed request per wallet for the
        // rest of the trace, but we still retry well before the full TTL.
        cache = { ...cache, at: Date.now() - CACHE_TTL_MS + 60_000 };
        return cache.table;
      }
      cache = { at: Date.now(), table: FALLBACK_PRICES, live: false };
      return FALLBACK_PRICES;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Diagnostics for the trace route's log line — no secrets, just counters. */
export function priceQuotaSnapshot() {
  return {
    monthCalls,
    monthlyBudget: MONTHLY_CALL_BUDGET,
    cachedAgeMs: cache ? Date.now() - cache.at : null,
    live: cache?.live ?? false,
  };
}

/** True when the prices in use came from the live feed rather than the table. */
export function pricesAreLive(table: PriceTable): boolean {
  // ETH is the reliable tell: its fallback is a round 3400, and a live quote
  // matching that to the cent is not a case worth distinguishing.
  return table.ETH.usd !== FALLBACK_PRICES.ETH.usd;
}
