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

export const MAX_HOPS = 5;
const BREADTH_PER_NODE = 6; // top-N outgoing transfers followed per wallet (live)

// Static USD price table. The live path uses this for value_usd; a real price
// oracle is a Pass-2 concern. Stablecoins are pegged; the rest are round demo
// figures, deliberately not presented as market-accurate.
const USD_PRICE: Record<TokenSymbol, number> = {
  USDT: 1,
  USDC: 1,
  ETH: 3400,
  BTC: 64000,
  MATIC: 0.7,
  TRX: 0.13,
  SOL: 150,
};

const USDT_ERC20 = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

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

async function fetchJson(url: string, headers?: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function etherscanOutgoing(address: string): Promise<RawTransfer[]> {
  const key = etherscanKey();
  if (!key) return [];
  const base = "https://api.etherscan.io/api";
  const out: RawTransfer[] = [];
  try {
    // Native ETH transfers.
    const native = await fetchJson(
      `${base}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=asc&apikey=${key}`
    );
    for (const t of (native.result ?? []).slice(0, 200)) {
      if ((t.from ?? "").toLowerCase() !== address.toLowerCase()) continue;
      if (t.value === "0") continue;
      const value = Number(t.value) / 1e18;
      out.push({
        tx_hash: t.hash,
        from_address: t.from,
        to_address: t.to,
        chain: "ETHEREUM",
        token_symbol: "ETH",
        value,
        value_usd: value * USD_PRICE.ETH,
        timestamp: Number(t.timeStamp) * 1000,
        block: Number(t.blockNumber),
      });
    }
    // ERC-20 USDT transfers.
    const erc20 = await fetchJson(
      `${base}?module=account&action=tokentx&contractaddress=${USDT_ERC20}&address=${address}&sort=asc&apikey=${key}`
    );
    for (const t of (erc20.result ?? []).slice(0, 200)) {
      if ((t.from ?? "").toLowerCase() !== address.toLowerCase()) continue;
      const dp = Number(t.tokenDecimal ?? 6);
      const value = Number(t.value) / 10 ** dp;
      out.push({
        tx_hash: t.hash,
        from_address: t.from,
        to_address: t.to,
        chain: "ETHEREUM",
        token_symbol: "USDT",
        value,
        value_usd: value * USD_PRICE.USDT,
        timestamp: Number(t.timeStamp) * 1000,
        block: Number(t.blockNumber),
      });
    }
  } catch {
    /* degrade to whatever we gathered */
  }
  return out;
}

async function trongridOutgoing(address: string): Promise<RawTransfer[]> {
  const key = trongridKey();
  const out: RawTransfer[] = [];
  try {
    const data = await fetchJson(
      `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=50&contract_address=${USDT_TRC20}`,
      key ? { "TRON-PRO-API-KEY": key } : undefined
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
        value_usd: value * USD_PRICE.USDT,
        timestamp: Number(t.block_timestamp),
      });
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function mempoolOutgoing(address: string): Promise<RawTransfer[]> {
  const out: RawTransfer[] = [];
  try {
    const txs = await fetchJson(`https://mempool.space/api/address/${address}/txs`);
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
          value_usd: value * USD_PRICE.BTC,
          timestamp: (tx.status?.block_time ?? 0) * 1000,
          block: tx.status?.block_height,
        });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function outgoingFor(address: string, chain: Chain): Promise<RawTransfer[]> {
  switch (chain) {
    case "ETHEREUM":
    case "POLYGON":
      return etherscanOutgoing(address);
    case "TRON":
      return trongridOutgoing(address);
    case "BITCOIN":
      return mempoolOutgoing(address);
    default:
      return Promise.resolve([]);
  }
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

  const seedNode = makeNode(seed, chain, "VICTIM_ENTRY", 0);
  nodeMap.set(seed.toLowerCase(), seedNode);

  let frontier: { address: string; chain: Chain; hop: number }[] = [
    { address: seed, chain, hop: 0 },
  ];

  while (frontier.length) {
    const next: typeof frontier = [];
    // Fetch this frontier's wallets in parallel.
    const results = await Promise.all(
      frontier.map(async (f) => ({ f, raw: await outgoingFor(f.address, f.chain) }))
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
  };
}

// ── Public entry point ──────────────────────────────────────────────────────
export async function traceWallet(
  seed: string,
  opts?: { caseMeta?: CaseMeta; maxHops?: number; forceMock?: boolean }
): Promise<TraceResult> {
  const chain = detectChain(seed);
  const goLive = !opts?.forceMock && hasLiveProviders() && !!chain;
  if (!goLive) return loadMockTrace(seed, opts?.caseMeta);
  try {
    const res = await liveTrace(seed, chain!, opts?.maxHops ?? MAX_HOPS, opts?.caseMeta);
    // A live address with no traceable outflow is useless for a demo — fall back.
    if (res.transfers.length === 0) return loadMockTrace(seed, opts?.caseMeta);
    return res;
  } catch {
    return loadMockTrace(seed, opts?.caseMeta);
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
    value_usd: value * USD_PRICE[token],
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
