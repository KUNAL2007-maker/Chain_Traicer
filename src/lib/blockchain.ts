// Blockchain ingestion + multi-hop tracing for CryptoTrace (SIH26183).
//
// Two modes, one entry point (`traceWallet`):
//   • LIVE  — when explorer API keys are present in the environment, walk the
//             real chain outward from the victim-reported address via Etherscan
//             (ETH + ERC-20 USDT), TronGrid (TRC-20 USDT) and mempool.space (BTC).
//   • MOCK  — otherwise (the hackathon default, and the fallback whenever a live
//             fetch fails), return a hand-built, deterministic multi-chain
//             laundering scenario so the whole pipeline is demoable offline.
//
// Either way the output is a `TraceResult` the rest of the app consumes without
// caring which path produced it. A live trace never throws to the caller — any
// failure degrades to the mock so a demo is never a red error screen.

import {
  Chain,
  TokenSymbol,
  WalletTransfer,
  WalletNode,
  TraceResult,
  LayerType,
  VaspAttribution,
  CaseMeta,
  detectChain,
  scoreWallet,
  bandToSeverity,
  shortWallet,
  VASPS,
} from "./domain";
import { FALLBACK_PRICES, getPrices, pricesAreLive, type PriceTable } from "./prices";

export const MAX_HOPS = 5;
const BREADTH_PER_NODE = 6; // top-N outgoing transfers followed per wallet (live)

/**
 * Hard ceiling on wallets expanded in one live trace.
 *
 * Without it the walk is 6^5 ≈ 7,800 wallets, or ~15,000 throttled requests — it
 * would blow the route's 60-second budget long before finishing and burn the
 * day's API quota doing it. 40 wallets keeps a trace to roughly 80 requests
 * (~20s at the Etherscan rate limit) while still reaching a VASP deposit, which
 * is the endpoint that matters.
 */
const MAX_WALLETS_EXPANDED = 40;

// USDT contract per chain. These differ, and using the Ethereum address on
// Polygon returns an empty result set rather than an error — a silent blank.
const USDT_CONTRACT: Partial<Record<Chain, string>> = {
  ETHEREUM: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  POLYGON: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
};
const USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// Etherscan V2: one key, one host, `chainid` selects the network. This is what
// fixes Polygon — the V1 code pointed every EVM chain at the Ethereum endpoint,
// so a Polygon trace silently returned Ethereum transactions.
//
// Verified against a real key on 2026-08-26: chainid=1 and chainid=137 both
// return status=1 with distinct block heights. Overridable by env so the host
// can be repointed (a V1 fallback, or a stub in tests) without a code change.
const ETHERSCAN_V2 = process.env.ETHERSCAN_API_BASE || "https://api.etherscan.io/v2/api";
const CHAIN_ID: Partial<Record<Chain, number>> = { ETHEREUM: 1, POLYGON: 137 };
/** Gas token per EVM chain, so a native transfer is priced as what it is. */
const NATIVE_SYMBOL: Partial<Record<Chain, TokenSymbol>> = {
  ETHEREUM: "ETH",
  POLYGON: "MATIC",
};

// ── Environment / key detection ─────────────────────────────────────────────
function etherscanKey() {
  return process.env.ETHERSCAN_API_KEY;
}
function trongridKey() {
  return process.env.TRONGRID_API_KEY;
}
// mempool.space needs no key. A live trace is attempted only when at least one
// keyed provider is configured; otherwise we stay on the mock dataset.
export function hasLiveProviders(): boolean {
  return Boolean(etherscanKey() || trongridKey());
}

// ── VASP / mixer attribution ────────────────────────────────────────────────
// Match a wallet against the reference directory in domain.ts. Attribution
// confidence reflects how sure we are of the *entity* (a sanctioned mixer or a
// KYC-bound exchange is near-certain); the strength of the *case* against those
// funds is computed separately in the investigation engine.
export function attributeVasp(address: string, _chain: Chain): VaspAttribution | null {
  const addr = (address ?? "").toLowerCase();
  if (!addr) return null;
  for (const v of VASPS) {
    const hit =
      (v.addresses ?? []).some((a) => a.toLowerCase() === addr) ||
      (v.addressHints ?? []).some((re) => re.test(address));
    if (!hit) continue;
    return {
      vasp_name: v.name,
      is_verified: v.is_verified,
      confidence_score: v.is_mixer ? 96 : v.is_verified ? 92 : 70,
      compliance_email: v.compliance_email,
      jurisdiction: v.jurisdiction,
      is_mixer: v.is_mixer,
    };
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Live providers — best-effort, opt-in. Each returns outgoing transfers for one
// address, normalised to WalletTransfer, and swallows its own errors to [].
// ═════════════════════════════════════════════════════════════════════════════
type RawTransfer = Omit<WalletTransfer, "id" | "hop" | "layer_type">;

// ── Rate limiting ───────────────────────────────────────────────────────────
// The BFS fans out over dozens of wallets and previously fired every request at
// once, which on a free tier means most of them come back rate-limited — and
// because each provider swallows its own errors, that failure looked like "this
// wallet has no outgoing transfers". A trace would quietly come back half-empty.
//
// Each provider gets its own lane: requests within a lane are serialised with a
// minimum gap, lanes run independently of each other.

type Lane = "etherscan" | "trongrid" | "mempool";

/**
 * Minimum gap between requests in a lane, derived from the documented free-tier
 * limits with margin — NOT guessed.
 *
 * Etherscan's free tier is **3 calls/second**. An earlier 220 ms gap works out to
 * 4.5/sec and quietly exceeded it, which is how you end up rate-limited on a tier
 * you are nominally within. 400 ms is 2.5/sec: comfortably legal, and a 40-wallet
 * trace (~80 calls) still finishes in ~32s, inside the route's 60s budget.
 *
 * TronGrid and mempool.space publish no hard per-second figure for the free tier,
 * so these are deliberately conservative — mempool.space in particular is an
 * unfunded public good and does not deserve to be hammered.
 */
const MIN_INTERVAL_MS: Record<Lane, number> = {
  etherscan: 400,
  trongrid: 200,
  mempool: 300,
};

/**
 * Daily request ceiling per lane, ~10% held back.
 *
 * In-memory, keyed by UTC day, and therefore reset by a server restart — the same
 * caveat as the price budget. It is a backstop against a runaway loop, not the
 * primary defence. The primary defence is that the live-feed poll no longer
 * re-walks the whole graph (see `probeSeedActivity`), which is what took the
 * projected daily spend from ~115,000 down to ~2,900.
 */
const DAILY_BUDGET: Record<Lane, number> = {
  etherscan: 90_000,
  trongrid: 90_000,
  mempool: 20_000,
};

let dayKey = "";
const dayCalls: Record<Lane, number> = { etherscan: 0, trongrid: 0, mempool: 0 };

function rollDay() {
  const key = new Date().toISOString().slice(0, 10);
  if (key !== dayKey) {
    dayKey = key;
    dayCalls.etherscan = 0;
    dayCalls.trongrid = 0;
    dayCalls.mempool = 0;
  }
}

function budgetLeft(lane: Lane): number {
  rollDay();
  return DAILY_BUDGET[lane] - dayCalls[lane];
}

/** Counters for the trace route's log line. No secrets — just spend. */
export function quotaSnapshot() {
  rollDay();
  return {
    day: dayKey,
    etherscan: `${dayCalls.etherscan}/${DAILY_BUDGET.etherscan}`,
    trongrid: `${dayCalls.trongrid}/${DAILY_BUDGET.trongrid}`,
    mempool: `${dayCalls.mempool}/${DAILY_BUDGET.mempool}`,
  };
}

/** Thrown when a provider says "slow down" — retryable, unlike a 404. */
class RateLimited extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RateLimited";
  }
}
/** Thrown when this lane has spent its day. Not retryable. */
class BudgetExhausted extends Error {
  constructor(lane: Lane) {
    super(`daily request budget for ${lane} exhausted`);
    this.name = "BudgetExhausted";
  }
}

const laneTail: Record<Lane, Promise<unknown>> = {
  etherscan: Promise.resolve(),
  trongrid: Promise.resolve(),
  mempool: Promise.resolve(),
};
const laneLastAt: Record<Lane, number> = { etherscan: 0, trongrid: 0, mempool: 0 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Queue `fn` behind everything else in its lane, respecting the minimum gap. */
function throttled<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
  const run = laneTail[lane].then(async () => {
    if (budgetLeft(lane) <= 0) throw new BudgetExhausted(lane);
    const wait = MIN_INTERVAL_MS[lane] - (Date.now() - laneLastAt[lane]);
    if (wait > 0) await sleep(wait);
    laneLastAt[lane] = Date.now();
    dayCalls[lane]++;
    return fn();
  });
  // Absorb rejections into the chain so one failed request doesn't poison the
  // lane for every request queued behind it.
  laneTail[lane] = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * One throttled request, retried on rate-limit with exponential backoff.
 *
 * Retries go back through `throttled`, so each attempt re-enters the lane queue
 * and re-checks the budget rather than jumping the line.
 */
const MAX_ATTEMPTS = 3;
async function withRetry<T>(lane: Lane, label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await throttled(lane, fn);
    } catch (err) {
      lastErr = err;
      // A spent budget will not un-spend itself, and a genuine 404 will not
      // become a 200 — only back off for the errors that backing off can fix.
      if (!(err instanceof RateLimited)) throw err;
      if (attempt === MAX_ATTEMPTS) break;
      const backoff = MIN_INTERVAL_MS[lane] * 2 ** attempt; // 800ms, 1600ms
      console.warn(`[trace] ${label} rate-limited, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ── Per-address cache ───────────────────────────────────────────────────────
// A wallet often shows up on more than one branch of the walk, so this pays for
// itself within a single trace.
//
// The TTL used to be pinned below the live-feed poll interval so a refresh could
// see new activity. That is no longer needed: the poll now probes only the seed,
// bypassing this cache entirely (`probeSeedActivity`), which frees the TTL to be
// chosen for quota rather than for freshness.
const ADDRESS_CACHE_TTL_MS = 10 * 60_000;
const addressCache = new Map<string, { at: number; data: RawTransfer[] }>();

function cacheKey(address: string, chain: Chain) {
  return `${chain}:${address.toLowerCase()}`;
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  // 429 is the honest signal; some gateways use 503 when shedding load. Both are
  // worth another attempt, unlike a 4xx that means the request itself is wrong.
  if (res.status === 429 || res.status === 503) {
    throw new RateLimited(`HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Etherscan signals a rate limit with **HTTP 200** and a body of
 * `{"status":"0","message":"NOTOK","result":"Max rate limit reached"}`.
 *
 * This is the single nastiest failure mode in the whole tracer. `result` is a
 * *string* there, not an array — so code that does `(result ?? []).slice(0,200)`
 * gets a substring, iterates it character by character, finds no `.from` on a
 * character, and yields zero transfers. The wallet then looks like it never sent
 * anything. No error, no warning, a confidently blank trace.
 *
 * So the string case is detected explicitly and turned into a real retryable
 * error. `NOTOK` with an empty-array result is different and legitimate: it is
 * what Etherscan returns for an address with no transactions.
 */
function assertEtherscanOk(body: any, label: string): any[] {
  const result = body?.result;
  if (Array.isArray(result)) return result;
  if (typeof result === "string") {
    const msg = result.toLowerCase();
    if (msg.includes("rate limit") || msg.includes("too many")) {
      throw new RateLimited(`etherscan: ${result}`);
    }
    if (msg.includes("invalid api key") || msg.includes("api key")) {
      // Not retryable, and worth shouting about — this is a setup problem.
      throw new Error(`etherscan rejected the API key: ${result}`);
    }
    throw new Error(`etherscan ${label}: ${result}`);
  }
  return [];
}

/**
 * Per-trace context.
 *
 * `degraded` is the point of this: a provider that fails must not be
 * indistinguishable from a wallet with no outgoing funds. Every swallowed error
 * marks the trace, so the officer is told "this trail may be incomplete" instead
 * of being shown a confident blank.
 */
type TraceCtx = {
  prices: PriceTable;
  warnings: string[];
  degraded: boolean;
};

function note(ctx: TraceCtx, msg: string) {
  ctx.degraded = true;
  if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
  console.warn(`[trace] ${msg}`);
}

/**
 * Etherscan V2 — Ethereum and Polygon from one key.
 *
 * The V2 API multiplexes chains through `chainid`, so a single ETHERSCAN_API_KEY
 * covers both. V1's per-chain hosts (api.etherscan.io, api.polygonscan.com) each
 * needed their own key, and the code only ever used the Ethereum one.
 */
async function etherscanOutgoing(
  address: string,
  chain: Chain,
  ctx: TraceCtx
): Promise<RawTransfer[]> {
  const key = etherscanKey();
  const chainId = CHAIN_ID[chain];
  const nativeSymbol = NATIVE_SYMBOL[chain];
  if (!key || !chainId || !nativeSymbol) return [];

  const base = `${ETHERSCAN_V2}?chainid=${chainId}`;
  const out: RawTransfer[] = [];
  const { prices } = ctx;

  try {
    // Native transfers (ETH on mainnet, MATIC on Polygon).
    //
    // `assertEtherscanOk` runs INSIDE the retry callback on purpose. Etherscan's
    // rate limit arrives as an HTTP 200, so it is only detectable once the body
    // is parsed — validating out here would surface it as a hard failure that
    // withRetry never gets the chance to back off from.
    const rows = await withRetry("etherscan", `${chain} txlist ${shortWallet(address)}`, async () =>
      assertEtherscanOk(
        await fetchJson(
          `${base}&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&page=1&offset=200&apikey=${key}`
        ),
        "txlist"
      )
    );
    for (const t of rows.slice(0, 200)) {
      if ((t.from ?? "").toLowerCase() !== address.toLowerCase()) continue;
      if (t.value === "0") continue;
      const value = Number(t.value) / 1e18;
      out.push({
        tx_hash: t.hash,
        from_address: t.from,
        to_address: t.to,
        chain,
        token_symbol: nativeSymbol,
        value,
        value_usd: value * prices[nativeSymbol].usd,
        timestamp: Number(t.timeStamp) * 1000,
        block: Number(t.blockNumber),
      });
    }
  } catch (err) {
    note(ctx, `etherscan ${chain} native ${shortWallet(address)}: ${(err as Error).message}`);
  }

  // USDT is fetched in its own try block so a rate limit on the native call does
  // not also discard the token call — losing the USDT leg would drop the very
  // transfers most fraud proceeds actually move in.
  const contract = USDT_CONTRACT[chain];
  if (contract) {
    try {
      const rows = await withRetry(
        "etherscan",
        `${chain} tokentx ${shortWallet(address)}`,
        async () =>
          assertEtherscanOk(
            await fetchJson(
              `${base}&module=account&action=tokentx&contractaddress=${contract}&address=${address}&sort=desc&page=1&offset=200&apikey=${key}`
            ),
            "tokentx"
          )
      );
      for (const t of rows.slice(0, 200)) {
        if ((t.from ?? "").toLowerCase() !== address.toLowerCase()) continue;
        const dp = Number(t.tokenDecimal ?? 6);
        const value = Number(t.value) / 10 ** dp;
        out.push({
          tx_hash: t.hash,
          from_address: t.from,
          to_address: t.to,
          chain,
          token_symbol: "USDT",
          value,
          value_usd: value * prices.USDT.usd,
          timestamp: Number(t.timeStamp) * 1000,
          block: Number(t.blockNumber),
        });
      }
    } catch (err) {
      note(ctx, `etherscan ${chain} USDT ${shortWallet(address)}: ${(err as Error).message}`);
    }
  }

  return out;
}

async function trongridOutgoing(address: string, ctx: TraceCtx): Promise<RawTransfer[]> {
  const key = trongridKey();
  const out: RawTransfer[] = [];
  try {
    const data = await withRetry("trongrid", `tron ${shortWallet(address)}`, () =>
      fetchJson(
        `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=50&contract_address=${USDT_TRC20}`,
        key ? { "TRON-PRO-API-KEY": key } : undefined
      )
    );
    for (const t of data.data ?? []) {
      if ((t.from ?? "").toLowerCase() !== address.toLowerCase()) continue;
      const dp = Number(t.token_info?.decimals ?? 6);
      const value = Number(t.value) / 10 ** dp;
      out.push({
        tx_hash: t.transaction_id,
        from_address: t.from,
        to_address: t.to,
        chain: "TRON",
        token_symbol: "USDT",
        value,
        value_usd: value * ctx.prices.USDT.usd,
        timestamp: Number(t.block_timestamp),
      });
    }
  } catch (err) {
    note(ctx, `trongrid ${shortWallet(address)}: ${(err as Error).message}`);
  }
  return out;
}

async function mempoolOutgoing(address: string, ctx: TraceCtx): Promise<RawTransfer[]> {
  const out: RawTransfer[] = [];
  try {
    const txs = await withRetry("mempool", `btc ${shortWallet(address)}`, () =>
      fetchJson(`https://mempool.space/api/address/${address}/txs`)
    );
    for (const tx of (txs ?? []).slice(0, 25)) {
      const spendsFromUs = (tx.vin ?? []).some(
        (i: any) => i.prevout?.scriptpubkey_address === address
      );
      if (!spendsFromUs) continue;
      for (const o of tx.vout ?? []) {
        const to = o.scriptpubkey_address;
        if (!to || to === address) continue; // skip change back to self
        const value = Number(o.value) / 1e8;
        out.push({
          tx_hash: tx.txid,
          from_address: address,
          to_address: to,
          chain: "BITCOIN",
          token_symbol: "BTC",
          value,
          value_usd: value * ctx.prices.BTC.usd,
          timestamp: (tx.status?.block_time ?? 0) * 1000,
          block: tx.status?.block_height,
        });
      }
    }
  } catch (err) {
    note(ctx, `mempool ${shortWallet(address)}: ${(err as Error).message}`);
  }
  return out;
}

/** Fetch one wallet's outgoing transfers, no cache. */
async function fetchOutgoing(address: string, chain: Chain, ctx: TraceCtx): Promise<RawTransfer[]> {
  switch (chain) {
    case "ETHEREUM":
    case "POLYGON":
      // Both go through Etherscan V2, but each with its OWN chainid — routing
      // Polygon to the Ethereum endpoint was the bug this replaces.
      return etherscanOutgoing(address, chain, ctx);
    case "TRON":
      return trongridOutgoing(address, ctx);
    case "BITCOIN":
      return mempoolOutgoing(address, ctx);
    default:
      // Solana has no provider configured (no Helius key), so a Solana seed
      // falls through to the mock rather than returning a misleading blank.
      return [];
  }
}

/** Route one wallet to its chain's provider, through the cache. */
async function outgoingFor(address: string, chain: Chain, ctx: TraceCtx): Promise<RawTransfer[]> {
  const key = cacheKey(address, chain);
  const hit = addressCache.get(key);
  if (hit && Date.now() - hit.at < ADDRESS_CACHE_TTL_MS) return hit.data;

  const data = await fetchOutgoing(address, chain, ctx);

  // Only cache a clean read. Caching a degraded (rate-limited, empty) result
  // would pin the blank in place for the next ten minutes and make the failure
  // look permanent.
  if (!ctx.degraded || data.length > 0) {
    addressCache.set(key, { at: Date.now(), data });
  }
  return data;
}

/**
 * Cheap change-detector for the live feed: how recently the seed wallet last
 * sent anything, and the hashes behind it.
 *
 * This is the fix for the quota problem that mattered most. The live-feed poll
 * used to re-run the full BFS every 60 seconds — about 80 Etherscan calls a
 * minute, or 115,000 a day against a 100,000/day key, so the console would take
 * itself offline within a day of being left open. A poll only ever needs to
 * answer "has anything moved?", which is 2 calls. The expensive walk then runs
 * only when the answer is yes.
 *
 * `latestTs` is the field that actually decides it, and the reason is subtle: the
 * stored trace keeps only the top BREADTH_PER_NODE (6) outgoing transfers per
 * wallet, while this probe sees all of them. Comparing hash SETS therefore finds
 * a dozen "unseen" hashes on the very first poll — ones the breadth cap pruned,
 * not new activity — and escalates to the full walk every single minute, which
 * is exactly the cost this function exists to avoid. A timestamp comparison is
 * immune to the pruning: only a transfer newer than the newest one we hold means
 * the money actually moved again.
 *
 * Deliberately bypasses `addressCache`: seeing new activity is the entire job.
 */
export async function probeSeedActivity(
  seed: string,
  chain: Chain
): Promise<{ hashes: string[]; latestTs: number; degraded: boolean; warnings: string[] }> {
  const ctx: TraceCtx = { prices: FALLBACK_PRICES, warnings: [], degraded: false };
  // Prices are irrelevant here — we compare hashes and timestamps, never values —
  // so the probe spends no CoinGecko credit at all.
  const raw = await fetchOutgoing(seed, chain, ctx);
  return {
    hashes: raw.map((r) => r.tx_hash),
    latestTs: raw.reduce((m, r) => Math.max(m, r.timestamp ?? 0), 0),
    degraded: ctx.degraded,
    warnings: ctx.warnings,
  };
}

// ── Live BFS trace ──────────────────────────────────────────────────────────
// Breadth-first from the seed, following the largest outgoing transfers at each
// wallet, tagging layer types heuristically and stopping a branch the moment it
// lands at an attributed VASP (its deposit address is the actionable endpoint).
async function liveTrace(
  seed: string,
  chain: Chain,
  maxHops: number,
  caseMeta?: CaseMeta
): Promise<TraceResult> {
  const nodeMap = new Map<string, WalletNode>();
  const transfers: WalletTransfer[] = [];
  const visited = new Set<string>();
  let edgeSeq = 0;

  // One price lookup for the whole walk (getPrices caches and de-duplicates, and
  // never rejects — a price outage falls back to the static table).
  const prices = await getPrices();
  const ctx: TraceCtx = { prices, warnings: [], degraded: false };
  if (!pricesAreLive(prices)) {
    ctx.warnings.push("USD/INR values are from the static fallback table, not live prices.");
    // Not a `note()` — stale prices don't make the *trail* incomplete, so this
    // warns without marking the whole trace degraded.
  }

  const seedNode = makeNode(seed, chain, "VICTIM_ENTRY", 0);
  nodeMap.set(seed.toLowerCase(), seedNode);

  let frontier: { address: string; chain: Chain; hop: number }[] = [
    { address: seed, chain, hop: 0 },
  ];

  while (frontier.length) {
    // Stay inside the request budget. Trimming here rather than when queueing
    // keeps the walk breadth-first, so what survives is the shallowest — and
    // therefore most probative — part of the trail.
    const room = MAX_WALLETS_EXPANDED - visited.size;
    if (room <= 0) break;
    if (frontier.length > room) frontier = frontier.slice(0, room);

    const next: typeof frontier = [];
    // Fetch this frontier's wallets in parallel. The per-provider throttle
    // serialises the actual requests, so this is concurrency the APIs allow.
    const results = await Promise.all(
      frontier.map(async (f) => ({ f, raw: await outgoingFor(f.address, f.chain, ctx) }))
    );
    for (const { f, raw } of results) {
      if (visited.has(f.address.toLowerCase())) continue;
      visited.add(f.address.toLowerCase());
      const top = raw
        .sort((a, b) => b.value_usd - a.value_usd)
        .slice(0, BREADTH_PER_NODE);
      for (const r of top) {
        transfers.push({ ...r, id: `tx${edgeSeq++}`, hop: f.hop + 1 });
        const key = r.to_address.toLowerCase();
        if (!nodeMap.has(key)) {
          const vasp = attributeVasp(r.to_address, r.chain);
          const bridged = r.chain !== f.chain;
          const layer: LayerType = vasp
            ? "VASP_DEPOSIT"
            : bridged
            ? "BRIDGE_HOP"
            : f.hop + 1 >= maxHops
            ? "PEELING_CHAIN"
            : "BURNER_MULE";
          nodeMap.set(
            key,
            makeNode(r.to_address, r.chain, layer, f.hop + 1, { vasp, touchedBridge: bridged })
          );
          // Expand only non-VASP wallets, only within the hop budget.
          if (!vasp && f.hop + 1 < maxHops) {
            next.push({ address: r.to_address, chain: r.chain, hop: f.hop + 1 });
          }
        }
      }
    }
    frontier = next;
  }

  // The walk stopped at the wallet cap rather than running out of trail — say so,
  // otherwise a truncated tree reads as a complete one.
  if (visited.size >= MAX_WALLETS_EXPANDED && frontier.length > 0) {
    ctx.warnings.push(
      `Walk stopped at the ${MAX_WALLETS_EXPANDED}-wallet limit; deeper hops were not expanded.`
    );
  }

  finalizeNodeStats(nodeMap, transfers);
  return {
    seed,
    seed_chain: chain,
    nodes: Array.from(nodeMap.values()),
    transfers,
    hops: transfers.reduce((m, t) => Math.max(m, t.hop ?? 0), 0),
    source: "live",
    generatedAt: Date.now(),
    case: caseMeta,
    degraded: ctx.degraded,
    warnings: ctx.warnings,
  };
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Ethereum and Polygon addresses are the SAME 20-byte shape, so `detectChain`
 * cannot tell them apart and answers "ETHEREUM" for every `0x…`. Left there, a
 * victim who reports a Polygon wallet gets traced on Ethereum, finds nothing, and
 * is shown the demo scenario — the Polygon support in this file would never run.
 *
 * So an EVM seed that comes back empty is retried on the other EVM chain. The
 * order matters for quota: Ethereum first (much the commoner case), and the
 * second chain is only paid for when the first genuinely has nothing. A wallet
 * active on Ethereum is traced on Ethereum and costs no extra calls at all.
 */
const EVM_FALLBACK: Partial<Record<Chain, Chain>> = { ETHEREUM: "POLYGON" };

export async function traceWallet(
  seed: string,
  opts?: { caseMeta?: CaseMeta; maxHops?: number; forceMock?: boolean }
): Promise<TraceResult> {
  const chain = detectChain(seed);
  const goLive = !opts?.forceMock && hasLiveProviders() && !!chain;
  if (!goLive) return loadMockTrace(seed, opts?.caseMeta);

  const maxHops = opts?.maxHops ?? MAX_HOPS;
  try {
    let res = await liveTrace(seed, chain!, maxHops, opts?.caseMeta);

    // Nothing on the assumed chain, and the providers were healthy — so "empty"
    // is a real answer about THIS chain, which makes it worth asking the other.
    const alt = EVM_FALLBACK[chain!];
    if (res.transfers.length === 0 && !res.degraded && alt) {
      const altRes = await liveTrace(seed, alt, maxHops, opts?.caseMeta);
      if (altRes.transfers.length > 0) {
        altRes.warnings = [
          `No activity on ${chain} for this address — traced on ${alt} instead.`,
          ...(altRes.warnings ?? []),
        ];
        return altRes;
      }
      // Neither chain had anything; keep the alt's warnings so a provider failure
      // on the second attempt is still reported.
      res = { ...res, degraded: res.degraded || altRes.degraded, warnings: [...(res.warnings ?? []), ...(altRes.warnings ?? [])] };
    }

    if (res.transfers.length > 0) return res;

    // Zero transfers. Falling back to the mock keeps the console demoable, but
    // the REASON has to travel with it — the two causes are not equivalent:
    //
    //   • degraded → the providers failed or rate-limited us. We do not know
    //     whether this wallet moved funds. Claiming a clean trail here is the
    //     exact "empty response" failure this hardening exists to prevent.
    //   • not degraded → the providers answered, and this wallet genuinely has
    //     no outgoing transfers we can follow.
    const why = res.degraded
      ? "Live lookup was incomplete (see below) — showing the demo scenario instead. Re-run in a few minutes for real data."
      : "This address has no outgoing transfers on the chains we cover — showing the demo scenario instead.";
    const mock = loadMockTrace(seed, opts?.caseMeta);
    return { ...mock, degraded: res.degraded, warnings: [why, ...(res.warnings ?? [])] };
  } catch (err) {
    const msg = (err as Error)?.message ?? "unknown error";
    console.warn(`[trace] live trace of ${shortWallet(seed)} failed:`, msg);
    return {
      ...loadMockTrace(seed, opts?.caseMeta),
      degraded: true,
      warnings: [`Live trace failed (${msg}) — showing the demo scenario instead.`],
    };
  }
}

// ── Node helpers ────────────────────────────────────────────────────────────
function makeNode(
  address: string,
  chain: Chain,
  layer_type: LayerType,
  hop: number,
  opts?: { vasp?: VaspAttribution | null; touchedMixer?: boolean; touchedBridge?: boolean }
): WalletNode {
  const vasp = opts?.vasp ?? null;
  const { score, band } = scoreWallet({
    layer_type,
    vasp,
    touchedMixer: opts?.touchedMixer || vasp?.is_mixer,
    touchedBridge: opts?.touchedBridge,
  });
  return {
    address,
    chain,
    label: shortWallet(address),
    layer_type,
    risk_score: score,
    risk_band: band,
    severity: bandToSeverity(band),
    vasp_attribution: vasp,
    hop,
    inflow_usd: 0,
    outflow_usd: 0,
    degree: 0,
    x: 0,
    y: 0,
  };
}

// Sum inflow/outflow and first/last seen onto each node from the transfer set.
function finalizeNodeStats(nodeMap: Map<string, WalletNode>, transfers: WalletTransfer[]) {
  for (const t of transfers) {
    const from = nodeMap.get(t.from_address.toLowerCase());
    const to = nodeMap.get(t.to_address.toLowerCase());
    if (from) {
      from.outflow_usd = (from.outflow_usd ?? 0) + t.value_usd;
      from.first_seen = Math.min(from.first_seen ?? t.timestamp, t.timestamp);
      from.last_seen = Math.max(from.last_seen ?? t.timestamp, t.timestamp);
    }
    if (to) {
      to.inflow_usd = (to.inflow_usd ?? 0) + t.value_usd;
      to.balance_usd = (to.balance_usd ?? 0) + t.value_usd;
      to.first_seen = Math.min(to.first_seen ?? t.timestamp, t.timestamp);
      to.last_seen = Math.max(to.last_seen ?? t.timestamp, t.timestamp);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Deterministic mock dataset — the demo default and the offline fallback.
//
// A realistic ₹12 lakh investment-scam laundering flow reported via NCRP/1930:
//   VICTIM_ENTRY → three sub-₹ threshold-split burner mules (funded from one
//   common gas wallet, with dust taint) → a clean peel chain into a WazirX
//   deposit (Track A: verified, direct, no obfuscation) AND a branch that
//   crosses an ETH→TRON bridge and another that passes through Tornado Cash,
//   both converging on a Binance deposit (Track B: needs officer review).
// ═════════════════════════════════════════════════════════════════════════════

// Deterministic address/hash fabricators — valid-shaped, stable across renders,
// derived from a label so the demo never depends on Math.random.
function fnv(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function hexFrom(seed: string, len: number): string {
  let out = "";
  let s = seed;
  while (out.length < len) {
    out += fnv(s).toString(16).padStart(8, "0");
    s = out + seed;
  }
  return out.slice(0, len);
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58From(seed: string, len: number): string {
  let out = "";
  let h = fnv(seed);
  while (out.length < len) {
    h = Math.imul(h ^ (out.length + 0x9e3779b9), 0x01000193) >>> 0;
    out += B58[h % 58];
  }
  return out.slice(0, len);
}
function ethAddr(label: string): string {
  return "0x" + hexFrom("eth:" + label, 40);
}
function tronAddr(label: string): string {
  return "T" + b58From("tron:" + label, 33);
}
function ethHash(label: string): string {
  return "0x" + hexFrom("hash:" + label, 64);
}
function tronHash(label: string): string {
  return hexFrom("trxhash:" + label, 64);
}

const MOCK_BASE_TS = Date.parse("2026-08-17T09:00:00Z");

export function loadMockTrace(seedInput?: string, caseMeta?: CaseMeta): TraceResult {
  // Honour a pasted address as the victim-entry wallet so the trace feels
  // responsive to the officer's input; otherwise use a fabricated one.
  const seedChain = seedInput ? detectChain(seedInput) ?? "ETHEREUM" : "ETHEREUM";
  const V = seedInput && detectChain(seedInput) ? seedInput : ethAddr("victim-entry");

  // Attribution objects for the two exchange endpoints and the mixer.
  const wazirx = attributeVaspByName("WazirX", 94);
  const binance = attributeVaspByName("Binance", 91);
  const tornado = attributeVaspByName("Tornado Cash", 96);

  // Wallet roster.
  const gas = ethAddr("gas-funder");
  const m1 = ethAddr("mule-1");
  const m2 = ethAddr("mule-2");
  const m3 = ethAddr("mule-3");
  const p1 = ethAddr("peel-1");
  const p2 = ethAddr("peel-2");
  const dwz = ethAddr("wazirx-deposit");
  const hwz = ethAddr("wazirx-hot");
  const br = ethAddr("bridge-router");
  const t1 = tronAddr("tron-mule-1");
  const dbn = tronAddr("binance-deposit");
  const hbn = tronAddr("binance-hot");
  const mix = ethAddr("tornado-router");
  const mx1 = ethAddr("post-mix-mule");

  const nodes: WalletNode[] = [
    makeNode(V, seedChain, "VICTIM_ENTRY", 0),
    makeNode(gas, "ETHEREUM", "BURNER_MULE", 1),
    makeNode(m1, "ETHEREUM", "BURNER_MULE", 1),
    makeNode(m2, "ETHEREUM", "BURNER_MULE", 1),
    makeNode(m3, "ETHEREUM", "BURNER_MULE", 1),
    makeNode(p1, "ETHEREUM", "PEELING_CHAIN", 2),
    makeNode(p2, "ETHEREUM", "PEELING_CHAIN", 3),
    makeNode(dwz, "ETHEREUM", "VASP_DEPOSIT", 4, { vasp: wazirx }),
    makeNode(hwz, "ETHEREUM", "VASP_HOT_WALLET", 5, { vasp: wazirx }),
    makeNode(br, "ETHEREUM", "BRIDGE_HOP", 2, { touchedBridge: true }),
    makeNode(t1, "TRON", "BURNER_MULE", 3, { touchedBridge: true }),
    makeNode(dbn, "TRON", "VASP_DEPOSIT", 4, { vasp: binance, touchedBridge: true }),
    makeNode(hbn, "TRON", "VASP_HOT_WALLET", 5, { vasp: binance, touchedBridge: true }),
    makeNode(mix, "ETHEREUM", "BURNER_MULE", 2, { vasp: tornado, touchedMixer: true }),
    makeNode(mx1, "ETHEREUM", "BURNER_MULE", 3, { touchedMixer: true }),
  ];

  // Transfers. USDT figures are their own USD value; the gas-dust transfers are
  // sub-0.001 ETH (both a shared-funding signal and a dust-taint signal).
  let seq = 0;
  const mk = (
    from: string,
    to: string,
    chain: Chain,
    token: TokenSymbol,
    value: number,
    hop: number,
    note: string,
    tsOffsetMin: number
  ): WalletTransfer => ({
    id: `mtx${seq++}`,
    tx_hash: chain === "TRON" ? tronHash(`${from}-${to}-${seq}`) : ethHash(`${from}-${to}-${seq}`),
    from_address: from,
    to_address: to,
    chain,
    token_symbol: token,
    value,
    // The mock stays on the static table rather than live prices, so the demo
    // scenario's figures are byte-identical on every run — a walkthrough whose
    // numbers drift with the market is impossible to script against.
    value_usd: value * FALLBACK_PRICES[token].usd,
    timestamp: MOCK_BASE_TS + tsOffsetMin * 60_000,
    hop,
    note,
  });

  const transfers: WalletTransfer[] = [
    // Threshold split: three sub-$5k mule payments (structuring under $10k).
    mk(V, m1, "ETHEREUM", "USDT", 4800, 1, "threshold split", 0),
    mk(V, m2, "ETHEREUM", "USDT", 4900, 1, "threshold split", 3),
    mk(V, m3, "ETHEREUM", "USDT", 4700, 1, "threshold split", 6),
    // Common gas funder dusts all three mules (multi-input cluster + dust taint).
    mk(gas, m1, "ETHEREUM", "ETH", 0.0006, 1, "gas dust multi-input", -20),
    mk(gas, m2, "ETHEREUM", "ETH", 0.0006, 1, "gas dust multi-input", -19),
    mk(gas, m3, "ETHEREUM", "ETH", 0.0005, 1, "gas dust multi-input", -18),
    // Clean peel chain into WazirX (Track A path).
    mk(m1, p1, "ETHEREUM", "USDT", 4600, 2, "peeling", 40),
    mk(p1, p2, "ETHEREUM", "USDT", 3900, 3, "peeling", 95),
    mk(p2, dwz, "ETHEREUM", "USDT", 3400, 4, "vasp deposit", 150),
    mk(dwz, hwz, "ETHEREUM", "USDT", 3350, 5, "vasp sweep hot-wallet", 220),
    // Cross-chain bridge branch into Binance (Track B path).
    mk(m2, br, "ETHEREUM", "USDT", 4800, 2, "cross-chain bridge", 55),
    mk(br, t1, "TRON", "USDT", 4720, 3, "cross-chain bridge", 70),
    mk(t1, dbn, "TRON", "USDT", 4650, 4, "vasp deposit", 130),
    // Mixer branch, also converging on Binance (Track B path).
    mk(m3, mix, "ETHEREUM", "USDT", 4600, 2, "mixer tornado", 48),
    mk(mix, mx1, "ETHEREUM", "USDT", 4450, 3, "mixer tornado", 300),
    mk(mx1, dbn, "TRON", "USDT", 4380, 4, "vasp deposit", 360),
    mk(dbn, hbn, "TRON", "USDT", 8900, 5, "vasp sweep hot-wallet", 420),
  ];

  finalizeNodeStats(new Map(nodes.map((n) => [n.address.toLowerCase(), n])), transfers);
  // finalizeNodeStats mutates via the map's node objects (same refs as `nodes`).

  return {
    seed: V,
    seed_chain: seedChain,
    nodes,
    transfers,
    hops: 5,
    source: "mock",
    generatedAt: MOCK_BASE_TS,
    case:
      caseMeta ?? {
        ncrp_ack_no: "NCRP-DL-2026-0031847",
        victim_name: "Complainant (identity withheld)",
        amount_lost_inr: 1_200_000,
        reported_on: "2026-08-18",
        jurisdiction_ps: "Cyber Crime Police Station, New Delhi",
        io_name: "Investigating Officer, I4C Cell",
      },
  };
}

// Build an attribution object from the directory by name, overriding the
// case-confidence figure used in the demo scenario.
function attributeVaspByName(name: string, confidence: number): VaspAttribution | null {
  const v = VASPS.find((x) => x.name === name);
  if (!v) return null;
  return {
    vasp_name: v.name,
    is_verified: v.is_verified,
    confidence_score: confidence,
    compliance_email: v.compliance_email,
    jurisdiction: v.jurisdiction,
    is_mixer: v.is_mixer,
  };
}
