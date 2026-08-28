// Domain model for CryptoTrace (SIH26183) — the shapes that travel between the
// blockchain tracer, the investigation engine, the API routes and the views,
// plus the pure functions that turn a wallet trace into something displayable:
// risk scoring, the crypto-typology taxonomy, address/value formatters, VASP
// attribution reference data, cluster grouping and the graph layout engine.
//
// Nothing here fabricates evidence. Every number shown is derived from the
// transfers the tracer ingested (live from a blockchain explorer, or from the
// bundled demo dataset when no API keys are present).
//
// This is a full crypto pivot of the original FinGuard fiat model. The graph
// layout engine below is domain-agnostic and is reused verbatim from that
// project — wallets are nodes, on-chain transfers are edges.

// ── Severity / risk bands ───────────────────────────────────────────────────
// `Severity` (lowercase) is the canonical UI enum, kept so the shared
// SeverityBadge / severityColor primitives work unchanged. `RiskBand`
// (uppercase) is the forensic-report facing band required by SIH26183.
export type Severity = "safe" | "medium" | "high";
export type RiskBand = "HIGH" | "MEDIUM" | "SAFE";

export function bandToSeverity(b: RiskBand): Severity {
  return b === "HIGH" ? "high" : b === "MEDIUM" ? "medium" : "safe";
}
export function severityToBand(s: Severity): RiskBand {
  return s === "high" ? "HIGH" : s === "medium" ? "MEDIUM" : "SAFE";
}

// ── Chains & tokens ─────────────────────────────────────────────────────────
export type Chain = "ETHEREUM" | "TRON" | "BITCOIN" | "POLYGON" | "SOLANA";
export type TokenSymbol = "USDT" | "ETH" | "BTC" | "USDC" | "MATIC" | "TRX" | "SOL";

// Where a wallet sits in the laundering pipeline. Assigned by the tracer as it
// walks outward from the victim-reported address; drives colour and risk.
export type LayerType =
  | "VICTIM_ENTRY" // the first hop the stolen funds reached (reported wallet)
  | "BURNER_MULE" // throwaway wallet used to break the trail
  | "PEELING_CHAIN" // a wallet in a peel chain (small amounts shaved off repeatedly)
  | "BRIDGE_HOP" // a cross-chain bridge / swap contract
  | "VASP_DEPOSIT" // a deposit address at a Virtual Asset Service Provider
  | "VASP_HOT_WALLET"; // an exchange's pooled hot wallet — the freeze target

// What a wallet was attributed to. `is_verified` distinguishes an exchange that
// we can serve legal process on (KYC-bound, responsive) from an unverified or
// offshore endpoint. `confidence_score` is 0-100.
export type VaspAttribution = {
  vasp_name: string;
  is_verified: boolean;
  confidence_score: number;
  compliance_email: string;
  jurisdiction?: string;
  is_mixer?: boolean;
};

// One on-chain transfer — a graph edge. `value` is in token units, `value_usd`
// is the USD-equivalent used for all thresholds and totals. `hop` is the BFS
// distance from the seed. `note` carries a typology hint used purely for
// cluster colouring (see detectPattern / clusterTypology).
export type WalletTransfer = {
  id: string;
  tx_hash: string;
  from_address: string;
  to_address: string;
  chain: Chain;
  token_symbol: TokenSymbol;
  value: number;
  value_usd: number;
  timestamp: number; // ms epoch
  block?: number;
  hop?: number;
  layer_type?: LayerType;
  note?: string;
};

// One wallet — a graph node, carrying its attribution and computed risk.
export type WalletNode = {
  address: string;
  chain: Chain;
  label: string;
  layer_type: LayerType;
  risk_score: number; // 0-100
  risk_band: RiskBand;
  severity: Severity; // derived from risk_band, for UI reuse
  vasp_attribution?: VaspAttribution | null;
  balance_usd?: number;
  inflow_usd?: number;
  outflow_usd?: number;
  first_seen?: number;
  last_seen?: number;
  hop?: number;
  degree?: number;
  x: number;
  y: number;
};

// Optional case metadata threaded through from the NCRP / 1930 complaint so the
// legal-notice generator can address a real case.
export type CaseMeta = {
  ncrp_ack_no?: string;
  victim_name?: string;
  amount_lost_inr?: number;
  reported_on?: string;
  jurisdiction_ps?: string;
  io_name?: string; // investigating officer
};

// The output of one wallet trace — everything the UI and the engine consume.
export type TraceResult = {
  seed: string;
  seed_chain: Chain;
  nodes: WalletNode[];
  transfers: WalletTransfer[];
  hops: number;
  source: "live" | "mock";
  generatedAt?: number;
  case?: CaseMeta;
  /**
   * True when at least one provider call failed, was rate-limited, or was
   * skipped for quota, so the trail below may be incomplete.
   *
   * This exists because the dangerous failure in a forensic tool is not an
   * error — it is a confident blank. An officer shown zero onward transfers
   * concludes the money stopped moving; if the real cause was an exhausted API
   * quota, that conclusion is wrong and nothing on screen says so.
   */
  degraded?: boolean;
  /** Human-readable notes about what was missed or substituted, for the UI. */
  warnings?: string[];
};

// ── Chat / agent panel types (I4C forensic panel) ───────────────────────────
export type ChatAgent =
  | "Chain Analyst"
  | "Attribution Analyst"
  | "Compliance Officer"
  | "Investigating Officer";

export type ChatAgentPanel = {
  agent: ChatAgent;
  headline?: string;
  content: string;
  findings?: string[];
  confidence?: number;
};

export type ChatVerdict = {
  level: Severity;
  headline: string;
  points: string[];
  accounts: string[]; // wallet addresses / VASP names of interest
};

export type ChatMessage = {
  id: string;
  role: "user" | "agent" | "assistant" | "system" | "report";
  agent?: ChatAgent;
  content: string;
  headline?: string;
  findings?: string[];
  time: string;
  confidence?: number;
  citations?: string[];
  verdict?: ChatVerdict;
  panels?: ChatAgentPanel[];
  suggestions?: string[];
};

export const AGENT_META: Record<
  ChatAgent,
  { color: string; bg: string; icon: string; role: string }
> = {
  "Chain Analyst": {
    color: "#38bdf8",
    bg: "rgba(56,189,248,0.12)",
    icon: "◇",
    role: "Traces multi-hop flow across chains",
  },
  "Attribution Analyst": {
    color: "#f59e0b",
    bg: "rgba(245,158,11,0.12)",
    icon: "△",
    role: "Attributes wallets to VASPs & mixers",
  },
  "Compliance Officer": {
    color: "#a78bfa",
    bg: "rgba(167,139,250,0.14)",
    icon: "◈",
    role: "Maps to BNSS/CrPC & drafts notices",
  },
  "Investigating Officer": {
    color: "#22c55e",
    bg: "rgba(34,197,94,0.12)",
    icon: "◉",
    role: "Decides freeze track & next actions",
  },
};

export const SUGGESTED_QUERIES = [
  "Explain this wallet trail in simple words",
  "Which exchange should we send the freeze notice to?",
  "Why is this flagged as high risk?",
  "What laws let us freeze these funds?",
  "Did the money touch a mixer or a bridge?",
];

// ── Formatters ──────────────────────────────────────────────────────────────
export function formatUSD(n: number): string {
  const v = Math.abs(n);
  if (v >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function formatINR(n: number): string {
  if (n >= 10_000_000) return `₹${(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000) return `₹${(n / 100_000).toFixed(2)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
}

export function formatToken(n: number, sym: TokenSymbol): string {
  // BTC/ETH need more decimals than stablecoins to stay meaningful.
  const dp = sym === "BTC" ? 6 : sym === "ETH" || sym === "SOL" ? 4 : 2;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: dp })} ${sym}`;
}

// 0x1234…5678 for EVM/Tron, kept short enough for on-canvas labels. Replaces the
// fiat shortAccountLabel — the layout engine's measure() calls this.
export function shortWallet(addr: string): string {
  if (!addr) return "";
  if (addr.length <= 13) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function severityColor(s: Severity) {
  return s === "high" ? "#ef4444" : s === "medium" ? "#f59e0b" : "#22c55e";
}

export function bandColor(b: RiskBand) {
  return severityColor(bandToSeverity(b));
}

// ── Chain reference table ───────────────────────────────────────────────────
export type ChainMeta = {
  id: Chain;
  name: string;
  short: string;
  color: string;
  native: TokenSymbol;
  explorerTx: (hash: string) => string;
  explorerAddr: (addr: string) => string;
};

export const CHAINS: Record<Chain, ChainMeta> = {
  ETHEREUM: {
    id: "ETHEREUM",
    name: "Ethereum",
    short: "ETH",
    color: "#38bdf8",
    native: "ETH",
    explorerTx: (h) => `https://etherscan.io/tx/${h}`,
    explorerAddr: (a) => `https://etherscan.io/address/${a}`,
  },
  TRON: {
    id: "TRON",
    name: "TRON",
    short: "TRX",
    color: "#ef4444",
    native: "TRX",
    explorerTx: (h) => `https://tronscan.org/#/transaction/${h}`,
    explorerAddr: (a) => `https://tronscan.org/#/address/${a}`,
  },
  BITCOIN: {
    id: "BITCOIN",
    name: "Bitcoin",
    short: "BTC",
    color: "#f59e0b",
    native: "BTC",
    explorerTx: (h) => `https://mempool.space/tx/${h}`,
    explorerAddr: (a) => `https://mempool.space/address/${a}`,
  },
  POLYGON: {
    id: "POLYGON",
    name: "Polygon",
    short: "POL",
    color: "#a78bfa",
    native: "MATIC",
    explorerTx: (h) => `https://polygonscan.com/tx/${h}`,
    explorerAddr: (a) => `https://polygonscan.com/address/${a}`,
  },
  SOLANA: {
    id: "SOLANA",
    name: "Solana",
    short: "SOL",
    color: "#10b981",
    native: "SOL",
    explorerTx: (h) => `https://solscan.io/tx/${h}`,
    explorerAddr: (a) => `https://solscan.io/account/${a}`,
  },
};

export const CHAIN_LIST: Chain[] = ["ETHEREUM", "TRON", "BITCOIN", "POLYGON", "SOLANA"];

export function chainColor(c: Chain): string {
  return CHAINS[c]?.color ?? "#64748b";
}

// Infer the chain from an address's shape. EVM chains (Ethereum/Polygon) share
// the 0x… format, so a 0x address is reported as ETHEREUM by default — the
// tracer can override once it sees which explorer actually answers.
export function detectChain(address: string): Chain | null {
  const a = (address ?? "").trim();
  if (!a) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return "ETHEREUM";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return "TRON";
  if (/^(bc1[0-9a-z]{6,}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(a)) return "BITCOIN";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return "SOLANA";
  return null;
}

// ── VASP / mixer attribution directory ──────────────────────────────────────
// The reference set the tracer matches intermediate wallets against. Known
// public hot-wallet addresses are included so live attribution has something to
// hit; the demo dataset sets attribution directly on its nodes. Tornado Cash is
// carried here as a flagged mixer (is_mixer), not a serviceable VASP.
export type VaspEntry = {
  name: string;
  is_verified: boolean;
  compliance_email: string;
  jurisdiction: string;
  chains: Chain[];
  is_mixer?: boolean;
  addresses?: string[];
  addressHints?: RegExp[];
};

export const VASPS: VaspEntry[] = [
  {
    name: "Binance",
    is_verified: true,
    compliance_email: "le@binance.com",
    jurisdiction: "Cayman Islands / global",
    chains: ["ETHEREUM", "TRON", "BITCOIN", "POLYGON", "SOLANA"],
    addresses: [
      "0x28C6c06298d514Db089934071355E5743bf21d60",
      "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549",
      "0xDFd5293D8e347dFe59E90eFd55b2956a1343963d",
      "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb",
    ],
  },
  {
    name: "WazirX",
    is_verified: true,
    compliance_email: "compliance@wazirx.com",
    jurisdiction: "India (FIU-IND registered)",
    chains: ["ETHEREUM", "TRON", "BITCOIN", "POLYGON"],
  },
  {
    name: "CoinDCX",
    is_verified: true,
    compliance_email: "compliance@coindcx.com",
    jurisdiction: "India (FIU-IND registered)",
    chains: ["ETHEREUM", "TRON", "BITCOIN", "POLYGON"],
  },
  {
    name: "Kraken",
    is_verified: true,
    compliance_email: "lawenforcement@kraken.com",
    jurisdiction: "United States",
    chains: ["ETHEREUM", "BITCOIN", "SOLANA"],
    addresses: [
      "0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2",
      "0x0A869d79a7052C7f1b55a8EbAbbEa3420F0D1E13",
    ],
  },
  {
    name: "KuCoin",
    is_verified: false, // offshore, historically slower to respond to Indian LEA
    compliance_email: "compliance@kucoin.com",
    jurisdiction: "Seychelles",
    chains: ["ETHEREUM", "TRON", "BITCOIN", "POLYGON", "SOLANA"],
  },
  {
    name: "Tornado Cash",
    is_verified: false,
    is_mixer: true,
    compliance_email: "", // sanctioned mixer — no compliance desk to serve
    jurisdiction: "Decentralised (OFAC-sanctioned)",
    chains: ["ETHEREUM", "POLYGON"],
    addresses: [
      "0x8589427373D6D84E98730D7795D8f6f8731FDA16",
      "0x722122dF12D4e14e13Ac3b6895a86e84145b6967",
    ],
  },
];

export function vaspByName(name: string): VaspEntry | undefined {
  return VASPS.find((v) => v.name.toLowerCase() === name.toLowerCase());
}

// ── Risk scoring ────────────────────────────────────────────────────────────
// Pure, deterministic wallet scoring from its position in the pipeline and its
// attribution. Bridges and mixers push a wallet up because they signal
// deliberate obfuscation; a verified VASP endpoint is high because it is the
// actionable freeze target.
export function scoreWallet(input: {
  layer_type: LayerType;
  vasp?: VaspAttribution | null;
  touchedMixer?: boolean;
  touchedBridge?: boolean;
}): { score: number; band: RiskBand } {
  let score = 20;
  switch (input.layer_type) {
    case "VICTIM_ENTRY":
      score = 82; // reported crime proceeds enter here
      break;
    case "BURNER_MULE":
      score = 68;
      break;
    case "PEELING_CHAIN":
      score = 72;
      break;
    case "BRIDGE_HOP":
      score = 80;
      break;
    case "VASP_DEPOSIT":
      score = 88;
      break;
    case "VASP_HOT_WALLET":
      score = 92;
      break;
  }
  if (input.vasp?.is_mixer) score = Math.max(score, 90);
  else if (input.vasp?.is_verified) score = Math.min(100, score + 6);
  if (input.touchedMixer) score = Math.min(100, score + 8);
  if (input.touchedBridge) score = Math.min(100, score + 4);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const band: RiskBand = score >= 75 ? "HIGH" : score >= 45 ? "MEDIUM" : "SAFE";
  return { score, band };
}

// ── Crypto typology recognition ─────────────────────────────────────────────
// A transfer's `note` (a pattern hint set by the tracer/engine) is scanned for
// laundering-pattern signals. The first match wins. Shared by cluster
// colouring so the canvas and the findings list always agree.
export type Typology = {
  key: string;
  label: string;
  re: RegExp;
  color: string;
};

export const TYPOLOGIES: Typology[] = [
  { key: "mixer", label: "Mixer / Tumbler Touch", re: /mixer|tumbl|tornado/, color: "#ec4899" },
  { key: "vasp-sweep", label: "VASP Sweep", re: /vasp|sweep|deposit|hot-?wallet/, color: "#ef4444" },
  { key: "bridge", label: "Cross-Chain Bridge", re: /bridge|cross-?chain|swap/, color: "#38bdf8" },
  { key: "peeling", label: "Peeling Chain", re: /peel/, color: "#f59e0b" },
  { key: "mule", label: "Burner-Mule Cluster", re: /mule|burner|multi-?input|cluster/, color: "#a78bfa" },
  { key: "structuring", label: "Threshold Split", re: /threshold|split|structur|smurf/, color: "#22c55e" },
];

export function detectPattern(note?: string): Typology | null {
  const n = (note ?? "").toLowerCase();
  if (!n) return null;
  for (const t of TYPOLOGIES) {
    if (t.re.test(n)) return t;
  }
  return null;
}

// ── Graph types ─────────────────────────────────────────────────────────────
// Kept structurally compatible with the reused layout engine: the engine only
// reads {id, degree, label, severity, x, y} on nodes and {source, target,
// amount, severity, note} on edges. `amount` carries value_usd so the engine's
// per-cluster totals are USD totals; `currency` carries the token symbol.
export type GraphNode = {
  id: string; // wallet address
  address: string;
  chain: Chain;
  label: string;
  severity: Severity;
  layer_type: LayerType;
  risk_score: number;
  risk_band: RiskBand;
  vasp?: string | null;
  hop?: number;
  degree?: number;
  x: number;
  y: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  amount: number; // value_usd
  currency: TokenSymbol;
  severity: Severity;
  timestamp: string;
  note?: string;
  chain: Chain;
  tx_hash: string;
};

export type GraphCluster = {
  id: string;
  kind: "web" | "pairs";
  label: string;
  color: string;
  count: number;
  total: number; // USD moved inside the cluster
  severity: Severity;
  nodeIds: string[];
  x: number;
  y: number;
  w: number;
  h: number;
};

// Node size scales with counterparty count so hubs (mule collectors, exchange
// hot wallets) visibly dominate. Shared with the renderer.
export function nodeRadius(degree = 1): number {
  return Math.min(26, 13 + Math.max(0, degree - 1) * 2.6);
}

// Build a graph layout from a trace. Maps WalletNode → GraphNode and
// WalletTransfer → GraphEdge, tags each edge with a typology hint (so clusters
// colour by pattern), then runs the connected-component layout engine.
export function buildGraphFromTransfers(
  nodesIn: WalletNode[],
  transfers: WalletTransfer[],
  canvasWidth = 1240
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  chains: Chain[];
  clusters: GraphCluster[];
  height: number;
} {
  const byAddr = new Map<string, WalletNode>();
  nodesIn.forEach((n) => byAddr.set(n.address, n));

  const nodes: GraphNode[] = nodesIn.map((n) => ({
    id: n.address,
    address: n.address,
    chain: n.chain,
    label: n.address,
    severity: n.severity,
    layer_type: n.layer_type,
    risk_score: n.risk_score,
    risk_band: n.risk_band,
    vasp: n.vasp_attribution?.vasp_name ?? null,
    hop: n.hop,
    degree: 0,
    x: 0,
    y: 0,
  }));

  const edges: GraphEdge[] = transfers.map((t, i) => {
    const target = byAddr.get(t.to_address);
    return {
      id: t.id ?? t.tx_hash ?? `e${i}`,
      source: t.from_address,
      target: t.to_address,
      amount: t.value_usd,
      currency: t.token_symbol,
      severity: target ? target.severity : "safe",
      timestamp: new Date(t.timestamp).toISOString(),
      note: edgeTypologyHint(t, target),
      chain: t.chain,
      tx_hash: t.tx_hash,
    };
  });

  const chains = Array.from(new Set(nodesIn.map((n) => n.chain)));
  const { clusters, height } = layoutGraph(nodes, edges, canvasWidth);
  return { nodes, edges, chains, clusters, height };
}

// Derive the typology keyword an edge is tagged with, from the transfer's own
// note or the layer type of the wallet it lands in. Consumed by detectPattern.
function edgeTypologyHint(t: WalletTransfer, target?: WalletNode): string {
  if (t.note) return t.note;
  if (target?.vasp_attribution?.is_mixer) return "mixer";
  switch (target?.layer_type) {
    case "VASP_DEPOSIT":
    case "VASP_HOT_WALLET":
      return "vasp deposit sweep";
    case "BRIDGE_HOP":
      return "cross-chain bridge";
    case "PEELING_CHAIN":
      return "peeling";
    case "BURNER_MULE":
      return "burner mule";
    default:
      return "";
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Graph layout engine — reused verbatim from FinGuard. Dependency-free, fully
// deterministic (no random seed) so re-renders are stable. Three stages:
//   1. split the graph into connected components,
//   2. lay each component out with a shape that matches its topology,
//   3. pack the dense components into rows and the 1-to-1 pairs into a grid.
// Nothing is scaled down to fit — the canvas height grows and the renderer
// scales the whole SVG uniformly so labels never collide.
// ═════════════════════════════════════════════════════════════════════════════
const PAD = 44;
const GAP_X = 56;
const GAP_Y = 64;
const REGION_GAP = 76;
const CAPTION_H = 46;
const MAX_COLS = 2;
const PAIR_GAP = 34;

function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  W: number
): { clusters: GraphCluster[]; height: number } {
  if (!nodes.length) return { clusters: [], height: 420 };

  const index = new Map<string, GraphNode>();
  nodes.forEach((n) => index.set(n.id, n));

  // Undirected adjacency (for clustering) + directed successors (for flow).
  const adj = new Map<string, Set<string>>();
  const outN = new Map<string, Set<string>>();
  nodes.forEach((n) => {
    adj.set(n.id, new Set());
    outN.set(n.id, new Set());
  });
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!index.has(e.source) || !index.has(e.target)) continue;
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
    outN.get(e.source)!.add(e.target);
  }
  nodes.forEach((n) => {
    n.degree = adj.get(n.id)!.size;
  });

  // Connected components via BFS.
  const seen = new Set<string>();
  const comps: GraphNode[][] = [];
  for (const start of nodes) {
    if (seen.has(start.id)) continue;
    const bucket: GraphNode[] = [];
    const queue = [start.id];
    seen.add(start.id);
    while (queue.length) {
      const cur = queue.shift()!;
      bucket.push(index.get(cur)!);
      for (const nb of adj.get(cur)!) {
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    comps.push(bucket);
  }

  const items = comps.map((bucket, i) => {
    const pos = layoutComponent(bucket, adj, outN, index);
    return { i, bucket, pos, ...measure(bucket, pos) };
  });

  const usable = Math.max(320, W - PAD * 2);
  const clusters: GraphCluster[] = [];
  let y = PAD;

  const webs = items
    .filter((it) => it.bucket.length >= 3)
    .map((it) => ({ ...it, typ: clusterTypology(it.bucket, edges) }))
    .sort((a, b) => a.typ.rank - b.typ.rank || b.bucket.length - a.bucket.length);
  const pairs = items.filter((it) => it.bucket.length < 3);

  if (webs.length) {
    const rows: (typeof webs)[] = [];
    let row: typeof webs = [];
    for (const it of webs) {
      const cand = row.concat(it);
      const widest = Math.max(...cand.map((c) => c.w));
      const fits = widest * cand.length + GAP_X * (cand.length - 1) <= usable;
      if (row.length && (!fits || row.length >= MAX_COLS)) {
        rows.push(row);
        row = [it];
      } else {
        row = cand;
      }
    }
    if (row.length) rows.push(row);

    for (const r of rows) {
      const cardW = (usable - GAP_X * (r.length - 1)) / r.length;
      const bodyH = Math.max(...r.map((it) => it.h));
      r.forEach((it, k) => {
        const ownH = Math.min(bodyH, Math.round(it.h * 1.35));
        const cardX = PAD + k * (cardW + GAP_X);
        const dx = cardX + (cardW - it.w) / 2 + it.ox;
        const dy = y + CAPTION_H + (ownH - it.h) / 2 + it.oy;
        for (const nd of it.bucket) {
          const p = it.pos.get(nd.id)!;
          nd.x = dx + p.x;
          nd.y = dy + p.y;
        }
        clusters.push({
          id: `cl-${it.i}`,
          kind: "web",
          label: it.typ.label,
          color: it.typ.color,
          count: it.bucket.length,
          total: it.typ.total,
          severity: it.typ.severity,
          nodeIds: it.bucket.map((b) => b.id),
          x: cardX,
          y,
          w: cardW,
          h: ownH + CAPTION_H,
        });
      });
      y += bodyH + CAPTION_H + GAP_Y;
    }
    y -= GAP_Y;
  }

  if (pairs.length) {
    if (webs.length) y += REGION_GAP;
    const inner = usable - 32;
    const cellW = Math.max(...pairs.map((p) => p.w));
    const cellH = Math.max(...pairs.map((p) => p.h));
    const maxCols = Math.max(1, Math.floor((inner + PAIR_GAP) / (cellW + PAIR_GAP)));
    const rowCount = Math.ceil(pairs.length / maxCols);
    const cols = Math.max(1, Math.ceil(pairs.length / rowCount));
    const gridW = cols * cellW + (cols - 1) * PAIR_GAP;
    const gridH = rowCount * cellH + (rowCount - 1) * PAIR_GAP;
    const startX = PAD + Math.max(0, (usable - gridW) / 2);
    pairs.forEach((it, k) => {
      const cx = startX + (k % cols) * (cellW + PAIR_GAP) + (cellW - it.w) / 2;
      const cy = y + CAPTION_H + Math.floor(k / cols) * (cellH + PAIR_GAP) + (cellH - it.h) / 2;
      for (const nd of it.bucket) {
        const p = it.pos.get(nd.id)!;
        nd.x = cx + it.ox + p.x;
        nd.y = cy + it.oy + p.y;
      }
    });
    const pairIds = new Set(pairs.flatMap((p) => p.bucket.map((b) => b.id)));
    let pairTotal = 0;
    let pairHigh = false;
    let pairMedium = false;
    for (const e of edges) {
      if (!pairIds.has(e.source) || !pairIds.has(e.target)) continue;
      pairTotal += e.amount;
      if (e.severity === "high") pairHigh = true;
      else if (e.severity === "medium") pairMedium = true;
    }
    clusters.push({
      id: "cl-pairs",
      kind: "pairs",
      label: "Direct 1-to-1 transfers",
      color: "#64748b",
      count: pairs.length,
      total: pairTotal,
      severity: pairHigh ? "high" : pairMedium ? "medium" : "safe",
      nodeIds: Array.from(pairIds),
      x: PAD,
      y,
      w: usable,
      h: gridH + CAPTION_H + 20,
    });
    y += gridH + CAPTION_H + 20;
  }

  return { clusters, height: Math.max(380, Math.round(y + PAD)) };
}

function measure(
  bucket: GraphNode[],
  pos: Map<string, { x: number; y: number }>
): { w: number; h: number; ox: number; oy: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of bucket) {
    const p = pos.get(n.id)!;
    const r = nodeRadius(n.degree ?? 1);
    const halfLabel = shortWallet(n.label).length * 2.9 + 6;
    const halfW = Math.max(r + 16, halfLabel);
    minX = Math.min(minX, p.x - halfW);
    maxX = Math.max(maxX, p.x + halfW);
    minY = Math.min(minY, p.y - r - 16);
    maxY = Math.max(maxY, p.y + r + 22);
  }
  return { w: maxX - minX, h: maxY - minY, ox: -minX, oy: -minY };
}

// Dominant crypto typology inside a cluster, from the pattern hints on the
// transfers it contains. Falls back to severity when nothing is tagged. `rank`
// orders the canvas: named patterns in declaration order first.
function clusterTypology(
  bucket: GraphNode[],
  edges: GraphEdge[]
): { label: string; color: string; total: number; severity: Severity; rank: number } {
  const ids = new Set(bucket.map((b) => b.id));
  const tally = new Map<string, { t: Typology; n: number }>();
  let total = 0;
  let high = false;
  let medium = false;
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    total += e.amount;
    if (e.severity === "high") high = true;
    else if (e.severity === "medium") medium = true;
    const p = detectPattern(e.note);
    if (!p) continue;
    const cur = tally.get(p.key);
    if (cur) cur.n += 1;
    else tally.set(p.key, { t: p, n: 1 });
  }
  const severity: Severity = high ? "high" : medium ? "medium" : "safe";
  let best: { t: Typology; n: number } | undefined;
  for (const entry of Array.from(tally.values())) {
    if (!best || entry.n > best.n) best = entry;
  }
  if (best) {
    const rank = TYPOLOGIES.findIndex((t) => t.key === best!.t.key);
    return { label: best.t.label, color: best.t.color, total, severity, rank };
  }
  if (high) return { label: "Suspicious flow", color: "#ef4444", total, severity, rank: 90 };
  if (medium)
    return { label: "Elevated-value transfer", color: "#f59e0b", total, severity, rank: 91 };
  return { label: "Traced transfer", color: "#22c55e", total, severity, rank: 92 };
}

function layoutComponent(
  bucket: GraphNode[],
  adj: Map<string, Set<string>>,
  outN: Map<string, Set<string>>,
  index: Map<string, GraphNode>
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const n = bucket.length;
  const deg = (id: string) => adj.get(id)!.size;

  if (n === 1) {
    pos.set(bucket[0].id, { x: 0, y: 0 });
    return pos;
  }

  if (n === 2) {
    const [a, b] = bucket;
    const aSends = outN.get(a.id)!.has(b.id);
    pos.set(aSends ? a.id : b.id, { x: -46, y: 0 });
    pos.set(aSends ? b.id : a.id, { x: 46, y: 0 });
    return pos;
  }

  const edgeCount = bucket.reduce((s, b) => s + deg(b.id), 0) / 2;
  const ends = bucket.filter((b) => deg(b.id) === 1);

  // Chain (peeling / hop line): a path graph — draw hops left-to-right on an arc.
  if (edgeCount === n - 1 && ends.length === 2 && bucket.every((b) => deg(b.id) <= 2)) {
    const start = ends.find((e) => outN.get(e.id)!.size > 0) ?? ends[0];
    const order: GraphNode[] = [start];
    const walked = new Set<string>([start.id]);
    while (order.length < n) {
      const cur = order[order.length - 1];
      const next = Array.from(adj.get(cur.id)!).find((x) => !walked.has(x));
      if (!next) break;
      walked.add(next);
      order.push(index.get(next)!);
    }
    const span = Math.max(1, order.length - 1);
    order.forEach((b, i) => {
      pos.set(b.id, { x: i * 104, y: -Math.sin((i / span) * Math.PI) * 26 });
    });
    return pos;
  }

  // Hub-and-spoke (mule fan-in, VASP funnel, multi-input cluster): one wallet
  // touches every other. Senders left, hub centre, beneficiaries right.
  const hub = bucket.slice().sort((a, b) => deg(b.id) - deg(a.id))[0];
  if (deg(hub.id) === n - 1 && deg(hub.id) >= 3) {
    const sendsTo = outN.get(hub.id)!;
    const outs = bucket.filter((b) => b.id !== hub.id && sendsTo.has(b.id));
    const ins = bucket.filter((b) => b.id !== hub.id && !sendsTo.has(b.id));
    pos.set(hub.id, { x: 0, y: 0 });
    placeFan(ins, -1, pos);
    placeFan(outs, 1, pos);
    return pos;
  }

  return relaxLayout(bucket, adj);
}

function placeFan(
  list: GraphNode[],
  side: 1 | -1,
  pos: Map<string, { x: number; y: number }>
) {
  if (!list.length) return;
  const cols = Math.ceil(list.length / 3);
  let remaining = list.length;
  let idx = 0;
  for (let c = 0; c < cols; c++) {
    const take = Math.ceil(remaining / (cols - c));
    remaining -= take;
    const x = side * (128 + c * 68);
    for (let i = 0; i < take; i++) {
      pos.set(list[idx++].id, { x, y: (i - (take - 1) / 2) * 64 });
    }
  }
}

function relaxLayout(
  bucket: GraphNode[],
  adj: Map<string, Set<string>>
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const n = bucket.length;
  const R = 40 + n * 13;
  bucket.forEach((b, i) => {
    const ang = (i / n) * Math.PI * 2;
    positions.set(b.id, { x: Math.cos(ang) * R, y: Math.sin(ang) * R });
  });

  const ids = bucket.map((b) => b.id);
  const ideal = 84;
  for (let iter = 0; iter < 240; iter++) {
    const disp = new Map<string, { x: number; y: number }>();
    ids.forEach((id) => disp.set(id, { x: 0, y: 0 }));

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i])!;
        const b = positions.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = ((i * 13 + 7) % 11) - 5;
          dy = ((j * 17 + 3) % 11) - 5;
          d2 = dx * dx + dy * dy + 0.01;
        }
        const d = Math.sqrt(d2);
        const rep = 6200 / d2;
        const ux = dx / d;
        const uy = dy / d;
        const da = disp.get(ids[i])!;
        const db = disp.get(ids[j])!;
        da.x += ux * rep;
        da.y += uy * rep;
        db.x -= ux * rep;
        db.y -= uy * rep;
      }
    }

    for (const id of ids) {
      for (const nb of adj.get(id)!) {
        if (id < nb && positions.has(nb)) {
          const a = positions.get(id)!;
          const b = positions.get(nb)!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = (d - ideal) * 0.09;
          const ux = dx / d;
          const uy = dy / d;
          const da = disp.get(id)!;
          const db = disp.get(nb)!;
          da.x += ux * f;
          da.y += uy * f;
          db.x -= ux * f;
          db.y -= uy * f;
        }
      }
    }

    const cap = 26;
    for (const id of ids) {
      const dsp = disp.get(id)!;
      const m = Math.sqrt(dsp.x * dsp.x + dsp.y * dsp.y);
      const sx = m > cap ? (dsp.x / m) * cap : dsp.x;
      const sy = m > cap ? (dsp.y / m) * cap : dsp.y;
      const p = positions.get(id)!;
      p.x += sx * 0.85;
      p.y += sy * 0.85;
    }
  }

  let cx = 0, cy = 0;
  positions.forEach((p) => {
    cx += p.x;
    cy += p.y;
  });
  cx /= n;
  cy /= n;
  positions.forEach((p) => {
    p.x -= cx;
    p.y -= cy;
  });
  return positions;
}
