// Turns a wallet trace into hard, quotable forensic findings for SIH26183.
//
// The blockchain tracer (blockchain.ts) walks the money outward from a
// victim-reported address and tags each wallet with a layer type and any VASP /
// mixer attribution. This module does the arithmetic on top of that: which
// exchange the funds swept into, which hops form a peel chain, where the trail
// crossed a bridge or a mixer, which payments were split under the reporting
// line. It hands the AI panel facts it could only have got from this trace, and
// — because every finding carries its own plain-English sentence — it is also
// the offline engine: a full report, a track decision and a Section 91 notice
// can all be produced with no AI at all.
//
// This is the crypto pivot of FinGuard's investigation.ts. The shapes and the
// "never show an error" philosophy are kept; the domain is wallets and chains.

import {
  TraceResult,
  WalletTransfer,
  WalletNode,
  CaseMeta,
  Chain,
  Severity,
  ChatAgent,
  ChatAgentPanel,
  formatUSD,
  formatINR,
  shortWallet,
  CHAINS,
} from "./domain";

// ── Thresholds ──────────────────────────────────────────────────────────────
// $10,000 is the classic reporting line launderers size crypto cash-outs
// against (the US CTR figure, mirrored by most exchanges' enhanced-diligence
// triggers). Splitting a cash-out into several sub-$10k transfers to stay under
// it is structuring — an offence in its own right, exactly as in fiat.
export const CTR_USD = 10_000;
// Below this a stablecoin transfer is too small to be a genuine cash-out — a
// cluster of them just under the line is the structuring signal.
export const STRUCTURING_FLOOR_USD = 500;
// Native-coin transfers below this are dust: too small to be real value, used
// to seed gas across throwaway mules or to taint a wallet for later tracking.
export const DUST_NATIVE = 0.001;
// A freeze goes on the express track only when the case against the endpoint is
// this strong AND nothing obscured the trail to it.
export const TRACK_A_MIN_CONFIDENCE = 90;

// What an investigator acts on first. The VASP the money swept into is the
// freeze target, so it leads; a mixer or bridge touch is why a case needs
// review; dust and clustering are corroborating, not actionable alone.
const RISK_ORDER: Record<string, number> = {
  "VASP-SWEEP": 1,
  "MIXER-TUMBLER-TOUCH": 2,
  "CROSS-CHAIN-BRIDGE": 3,
  "PEELING-CHAIN": 4,
  "THRESHOLD-SPLIT": 5,
  "MULTI-INPUT-CLUSTER": 6,
  "DUST-TAINT": 7,
};

export type CryptoFinding = {
  code: string;
  title: string;
  plain: string;
  // One-sentence version of `plain` — for the on-screen report and the chat
  // brief, where a bullet you can read in two seconds beats a paragraph.
  short: string;
  severity: "high" | "medium" | "info";
  wallets: string[]; // full addresses, so the AI and the notice can quote them
  amountUsd: number;
};

// An exchange (or mixer) the trail reached. This is the actionable unit: a
// verified VASP with a compliance desk is where a freeze notice goes.
export type VaspHit = {
  vasp_name: string;
  is_verified: boolean;
  is_mixer: boolean;
  compliance_email: string;
  jurisdiction: string;
  confidence: number; // attribution certainty, 0-100
  inflowUsd: number; // laundered value that entered this exchange
  chains: Chain[];
  depositAddresses: string[]; // the addresses to freeze
  hotWalletAddresses: string[];
};

// The dual-track decision for one exchange endpoint. Track A is the express
// auto-freeze; Track B requires an officer to review before anything is frozen.
export type TrackAssessment = {
  target: VaspHit;
  track: "A" | "B";
  confidence: number; // case confidence for THIS endpoint (attribution, penalised for obfuscation)
  autoFreeze: boolean;
  touchedMixer: boolean;
  touchedBridge: boolean;
  reasons: string[];
};

export type TrackDecision = {
  overall: "A" | "B" | "DUAL"; // DUAL = some endpoints express, others need review
  headline: string;
  summary: string;
  assessments: TrackAssessment[];
};

export type CryptoEvidence = {
  seed: string;
  seedChain: Chain;
  source: "live" | "mock";
  hops: number;
  txCount: number;
  walletCount: number;
  totalUsd: number;
  highExposureUsd: number; // value that reached high-risk wallets
  bySeverity: { high: number; medium: number; safe: number };
  chains: Chain[];
  dateRange: { from: string; to: string } | null;
  vasps: VaspHit[];
  mixersTouched: string[];
  bridgesUsed: boolean;
  typologies: { code: string; label: string; count: number; amount: number }[];
  findings: CryptoFinding[];
  topWallets: {
    address: string;
    chain: Chain;
    layer: string;
    degree: number;
    inUsd: number;
    outUsd: number;
    vasp: string | null;
    severity: Severity;
  }[];
  // Per-address obfuscation taint, JSON-safe so it can cross the API boundary.
  taintByAddress: Record<string, { mixer: boolean; bridge: boolean }>;
  // The raw edges, retained so the notice generator can reconstruct the exact
  // deposit trail to a chosen exchange without re-running the tracer.
  transfers: WalletTransfer[];
  track: TrackDecision;
  case?: CaseMeta;
};

const usd = formatUSD;

function isoDate(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toISOString().slice(0, 10);
}

function lc(a: string): string {
  return (a ?? "").toLowerCase();
}

// A short, human label for a layer type, used in prose and the report.
const LAYER_LABEL: Record<string, string> = {
  VICTIM_ENTRY: "victim-entry wallet",
  BURNER_MULE: "burner mule",
  PEELING_CHAIN: "peel-chain wallet",
  BRIDGE_HOP: "cross-chain bridge",
  VASP_DEPOSIT: "exchange deposit address",
  VASP_HOT_WALLET: "exchange hot wallet",
};

// ── Evidence assembly ─────────────────────────────────────────────────────────
export function buildEvidence(trace: TraceResult): CryptoEvidence {
  const nodes = trace.nodes ?? [];
  const transfers = trace.transfers ?? [];
  const byAddr = new Map<string, WalletNode>();
  nodes.forEach((n) => byAddr.set(lc(n.address), n));

  const bySeverity = { high: 0, medium: 0, safe: 0 };
  nodes.forEach((n) => {
    bySeverity[n.severity] += 1;
  });

  let totalUsd = 0;
  const timestamps: number[] = [];
  const degree = new Map<string, number>();
  const inUsd = new Map<string, number>();
  const outUsd = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, v: number) =>
    m.set(k, (m.get(k) ?? 0) + v);

  for (const t of transfers) {
    totalUsd += t.value_usd;
    if (t.timestamp) timestamps.push(t.timestamp);
    bump(degree, lc(t.from_address), 1);
    bump(degree, lc(t.to_address), 1);
    bump(outUsd, lc(t.from_address), t.value_usd);
    bump(inUsd, lc(t.to_address), t.value_usd);
  }
  timestamps.sort((a, b) => a - b);

  const highExposureUsd = nodes
    .filter((n) => n.severity === "high")
    .reduce((s, n) => s + (n.inflow_usd ?? 0), 0);

  const chains = Array.from(new Set(nodes.map((n) => n.chain)));
  const taint = taintMap(nodes, transfers);
  const taintByAddress: Record<string, { mixer: boolean; bridge: boolean }> = {};
  taint.forEach((v, k) => (taintByAddress[k] = v));

  const vasps = buildVaspHits(nodes, transfers);
  const mixersTouched = vasps.filter((v) => v.is_mixer).map((v) => v.vasp_name);
  const bridgesUsed = Object.values(taintByAddress).some((t) => t.bridge);

  const topWallets = Array.from(degree.entries())
    .map(([addr]) => {
      const n = byAddr.get(addr);
      return {
        address: n?.address ?? addr,
        chain: (n?.chain ?? "ETHEREUM") as Chain,
        layer: n ? LAYER_LABEL[n.layer_type] ?? n.layer_type : "wallet",
        degree: degree.get(addr) ?? 0,
        inUsd: inUsd.get(addr) ?? 0,
        outUsd: outUsd.get(addr) ?? 0,
        vasp: n?.vasp_attribution?.vasp_name ?? null,
        severity: (n?.severity ?? "safe") as Severity,
      };
    })
    .sort((a, b) => b.degree - a.degree || b.inUsd + b.outUsd - (a.inUsd + a.outUsd))
    .slice(0, 6);

  const evidence: CryptoEvidence = {
    seed: trace.seed,
    seedChain: trace.seed_chain,
    source: trace.source,
    hops: trace.hops,
    txCount: transfers.length,
    walletCount: nodes.length,
    totalUsd,
    highExposureUsd,
    bySeverity,
    chains,
    dateRange: timestamps.length
      ? { from: isoDate(timestamps[0]), to: isoDate(timestamps[timestamps.length - 1]) }
      : null,
    vasps,
    mixersTouched,
    bridgesUsed,
    typologies: [],
    findings: [],
    topWallets,
    taintByAddress,
    transfers,
    track: { overall: "B", headline: "", summary: "", assessments: [] },
    case: trace.case,
  };

  evidence.findings = collectFindings(trace, evidence);
  evidence.typologies = tallyTypologies(evidence.findings);
  evidence.track = decideTrack(evidence);
  return evidence;
}

// ── VASP grouping ─────────────────────────────────────────────────────────────
// Collapse all attributed wallets of one exchange into a single actionable hit.
// Inflow counts only funds ENTERING the exchange from outside it — an internal
// deposit→hot-wallet sweep is the same money moving inside, not new exposure.
function buildVaspHits(nodes: WalletNode[], transfers: WalletTransfer[]): VaspHit[] {
  const vaspOf = new Map<string, string>(); // addr -> vasp name
  nodes.forEach((n) => {
    if (n.vasp_attribution) vaspOf.set(lc(n.address), n.vasp_attribution.vasp_name);
  });

  const groups = new Map<string, WalletNode[]>();
  for (const n of nodes) {
    const name = n.vasp_attribution?.vasp_name;
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(n);
  }

  const hits: VaspHit[] = [];
  for (const [name, members] of Array.from(groups.entries())) {
    const memberSet = new Set(members.map((m) => lc(m.address)));
    const att = members.find((m) => m.vasp_attribution)!.vasp_attribution!;
    let inflowUsd = 0;
    for (const t of transfers) {
      if (!memberSet.has(lc(t.to_address))) continue;
      // Skip transfers that originate inside the same exchange (internal sweep).
      if (vaspOf.get(lc(t.from_address)) === name) continue;
      inflowUsd += t.value_usd;
    }
    hits.push({
      vasp_name: name,
      is_verified: att.is_verified,
      is_mixer: !!att.is_mixer,
      compliance_email: att.compliance_email,
      jurisdiction: att.jurisdiction ?? "jurisdiction not recorded",
      confidence: Math.max(...members.map((m) => m.vasp_attribution?.confidence_score ?? 0)),
      inflowUsd,
      chains: Array.from(new Set(members.map((m) => m.chain))),
      depositAddresses: members
        .filter((m) => m.layer_type === "VASP_DEPOSIT")
        .map((m) => m.address),
      hotWalletAddresses: members
        .filter((m) => m.layer_type === "VASP_HOT_WALLET")
        .map((m) => m.address),
    });
  }
  // Verified exchanges with the most exposure first; mixers sink to the bottom
  // (they are evidence of obfuscation, not a place a notice can be served).
  return hits.sort(
    (a, b) => Number(a.is_mixer) - Number(b.is_mixer) || b.inflowUsd - a.inflowUsd
  );
}

// ── Obfuscation taint ─────────────────────────────────────────────────────────
// Forward-propagate two flags along the flow: did the funds arriving at this
// wallet pass through a mixer, or cross a bridge, on their way here? A VASP
// deposit that inherits either flag cannot go on the express track — the trail
// to it was deliberately broken and has to be reconstructed by hand.
function taintMap(
  nodes: WalletNode[],
  transfers: WalletTransfer[]
): Map<string, { mixer: boolean; bridge: boolean }> {
  const pivots = crossChainPivots(transfers);
  const isMixer = (n?: WalletNode) => !!n?.vasp_attribution?.is_mixer;
  const isBridge = (n?: WalletNode) =>
    n?.layer_type === "BRIDGE_HOP" || (n ? pivots.has(lc(n.address)) : false);

  const byAddr = new Map<string, WalletNode>();
  nodes.forEach((n) => byAddr.set(lc(n.address), n));

  const taint = new Map<string, { mixer: boolean; bridge: boolean }>();
  for (const n of nodes) {
    taint.set(lc(n.address), { mixer: isMixer(n), bridge: isBridge(n) });
  }
  // Any address seen only in transfers still needs a slot.
  for (const t of transfers) {
    for (const a of [lc(t.from_address), lc(t.to_address)]) {
      if (!taint.has(a)) taint.set(a, { mixer: false, bridge: false });
    }
  }

  // Relax to a fixpoint. Bounded by node count; the flow is shallow (≤5 hops).
  let changed = true;
  let guard = 0;
  while (changed && guard++ < nodes.length + transfers.length + 4) {
    changed = false;
    for (const t of transfers) {
      const from = taint.get(lc(t.from_address))!;
      const to = taint.get(lc(t.to_address))!;
      if (from.mixer && !to.mixer) {
        to.mixer = true;
        changed = true;
      }
      if (from.bridge && !to.bridge) {
        to.bridge = true;
        changed = true;
      }
    }
  }
  return taint;
}

// A wallet that takes funds in on one chain and sends them out on another is a
// bridge pivot, however it is labelled.
function crossChainPivots(transfers: WalletTransfer[]): Set<string> {
  const inChains = new Map<string, Set<Chain>>();
  const outChains = new Map<string, Set<Chain>>();
  const add = (m: Map<string, Set<Chain>>, k: string, c: Chain) => {
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(c);
  };
  for (const t of transfers) {
    add(inChains, lc(t.to_address), t.chain);
    add(outChains, lc(t.from_address), t.chain);
  }
  const pivots = new Set<string>();
  for (const [addr, outs] of Array.from(outChains.entries())) {
    const ins = inChains.get(addr);
    if (!ins) continue;
    const crosses = Array.from(outs).some((c) => !ins.has(c));
    if (crosses) pivots.add(addr);
  }
  return pivots;
}

// ── Detectors ─────────────────────────────────────────────────────────────────
// Follow the money one hop at a time down a peel chain. A transfer only extends
// the chain if it leaves the wallet the previous hop landed in, happens no
// earlier, and carries no more than arrived — the same discipline the fiat
// engine used, so a "decay" is a path the money actually took, not a sort order.
function longestPeelPath(transfers: WalletTransfer[]): WalletTransfer[] {
  const byTime = [...transfers].sort((a, b) => a.timestamp - b.timestamp);
  let best: WalletTransfer[] = [];
  const walk = (path: WalletTransfer[], visited: Set<string>) => {
    if (path.length > best.length) best = [...path];
    const tail = path[path.length - 1];
    for (const next of byTime) {
      if (lc(next.from_address) !== lc(tail.to_address)) continue;
      if (next.timestamp < tail.timestamp) continue;
      if (next.value_usd > tail.value_usd * 1.02) continue; // allow tiny rounding
      if (visited.has(lc(next.to_address))) continue;
      visited.add(lc(next.to_address));
      walk([...path, next], visited);
      visited.delete(lc(next.to_address));
    }
  };
  for (const start of byTime) {
    walk([start], new Set([lc(start.from_address), lc(start.to_address)]));
  }
  return best;
}

function collectFindings(trace: TraceResult, ev: CryptoEvidence): CryptoFinding[] {
  const out: CryptoFinding[] = [];
  const transfers = trace.transfers ?? [];
  const nodes = trace.nodes ?? [];
  const byAddr = new Map<string, WalletNode>();
  nodes.forEach((n) => byAddr.set(lc(n.address), n));

  // 1. VASP-SWEEP — the funds swept into an exchange. One finding per verified
  //    exchange: this is the freeze target, so it carries the compliance email.
  for (const v of ev.vasps.filter((x) => !x.is_mixer)) {
    const targets = [...v.depositAddresses, ...v.hotWalletAddresses];
    const dep = v.depositAddresses[0];
    out.push({
      code: "VASP-SWEEP",
      title: `${usd(v.inflowUsd)} swept into ${v.vasp_name}${
        v.is_verified ? " (verified exchange)" : ""
      }`,
      plain:
        `${usd(v.inflowUsd)} of the traced funds reached ${v.vasp_name} on ` +
        `${v.chains.map((c) => CHAINS[c]?.short ?? c).join(", ")}` +
        `${dep ? `, landing at deposit address ${shortWallet(dep)}` : ""}. ` +
        (v.is_verified
          ? `${v.vasp_name} is a KYC-bound exchange with a compliance desk (${v.compliance_email}), ` +
            `so the account behind that deposit address can be identified and the balance frozen — ` +
            `this is the single most actionable point in the whole trail.`
          : `${v.vasp_name} is an offshore/unverified endpoint (${v.jurisdiction}); a freeze here depends on ` +
            `mutual legal assistance and is slower, so move on it early.`),
      short:
        `${usd(v.inflowUsd)} reached ${v.vasp_name} — ` +
        (v.is_verified
          ? `serve the freeze/KYC notice on ${v.compliance_email}.`
          : `offshore, needs MLAT; flag it now.`),
      severity: "high",
      wallets: targets,
      amountUsd: v.inflowUsd,
    });
  }

  // 2. MIXER-TUMBLER-TOUCH — the trail passed through a sanctioned mixer.
  for (const v of ev.vasps.filter((x) => x.is_mixer)) {
    const touched = nodes.filter((n) => n.vasp_attribution?.vasp_name === v.vasp_name);
    out.push({
      code: "MIXER-TUMBLER-TOUCH",
      title: `Funds routed through ${v.vasp_name} (mixer/tumbler)`,
      plain:
        `At least ${usd(v.inflowUsd)} entered ${v.vasp_name}, a coin mixer (${v.jurisdiction}). ` +
        `A mixer deliberately severs the on-chain link between the money going in and the money coming out, ` +
        `so exposure downstream of it cannot be proven hop-by-hop and any endpoint fed from it has to be treated ` +
        `as review-only. There is no compliance desk to serve — attribution here is intelligence, not a freeze target.`,
      short:
        `${usd(v.inflowUsd)} went through the ${v.vasp_name} mixer — it breaks the trail, so anything downstream needs officer review.`,
      severity: "high",
      wallets: touched.map((n) => n.address),
      amountUsd: v.inflowUsd,
    });
  }

  // 3. CROSS-CHAIN-BRIDGE — the money hopped chains to shake off tracing.
  const bridgeNodes = nodes.filter(
    (n) =>
      n.layer_type === "BRIDGE_HOP" ||
      (crossChainPivots(transfers).has(lc(n.address)) && n.layer_type !== "VASP_DEPOSIT")
  );
  if (bridgeNodes.length) {
    const bridged = new Set<Chain>();
    for (const t of transfers) {
      const f = byAddr.get(lc(t.from_address));
      const to = byAddr.get(lc(t.to_address));
      if (f && to && f.chain !== to.chain) {
        bridged.add(f.chain);
        bridged.add(to.chain);
      }
    }
    const chainNames = Array.from(bridged).map((c) => CHAINS[c]?.name ?? c);
    const bridgeUsd = bridgeNodes.reduce((s, n) => s + (n.inflow_usd ?? 0), 0);
    out.push({
      code: "CROSS-CHAIN-BRIDGE",
      title: `Funds bridged across ${chainNames.length || 2} chains (${chainNames.join(" → ") || "ETH → TRON"})`,
      plain:
        `The trail crosses a bridge at ${bridgeNodes.map((n) => shortWallet(n.address)).join(", ")}, moving value ` +
        `between ${chainNames.join(" and ") || "two chains"}. Bridging is a favourite obfuscation step because a naive ` +
        `single-chain trace stops dead at the bridge contract; the funds re-appear on another chain under a fresh address ` +
        `with no direct on-chain edge. Following them requires correlating the deposit on one chain with the withdrawal ` +
        `on the other by time and amount, which is why any exchange fed through a bridge is review-only, not express.`,
      short:
        `Money hopped ${chainNames.join(" → ") || "chains"} through a bridge — the trail has to be re-joined across chains, so review before freezing anything downstream.`,
      severity: "high",
      wallets: bridgeNodes.map((n) => n.address),
      amountUsd: bridgeUsd,
    });
  }

  // 4. PEELING-CHAIN — a run of hops each shaving a little off and passing the
  //    rest on, stretching the trail so the source is hard to reach.
  const peel = longestPeelPath(transfers.filter((t) => t.value_usd >= 1));
  if (peel.length >= 3) {
    const first = peel[0];
    const last = peel[peel.length - 1];
    const shrink = first.value_usd - last.value_usd;
    const pct = first.value_usd ? ((shrink / first.value_usd) * 100).toFixed(1) : "0";
    const route = peel.map((h) => shortWallet(h.from_address)).concat(shortWallet(last.to_address));
    out.push({
      code: "PEELING-CHAIN",
      title: `${peel.length} linked hops, ${usd(first.value_usd)} peeled down to ${usd(last.value_usd)} (${pct}% shaved)`,
      plain:
        `${usd(first.value_usd)} left ${shortWallet(first.from_address)} and arrived at ${shortWallet(last.to_address)} ` +
        `as ${usd(last.value_usd)} after ${peel.length} linked hops, each carrying no more than the last. ` +
        `Shaving a slice off at every step and forwarding the remainder — a peel chain — is a deliberate layering ` +
        `technique: it spreads the money across throwaway wallets so no single hop looks large and the original source ` +
        `is several removes away. Route: ${route.join(" → ")}.`,
      short:
        `${usd(first.value_usd)} peeled down to ${usd(last.value_usd)} across ${peel.length} hops — layering to bury the source, not an ordinary payment.`,
      severity: "high",
      wallets: [...peel.map((h) => h.from_address), last.to_address],
      amountUsd: first.value_usd,
    });
  }

  // 5. THRESHOLD-SPLIT — a cash-out broken into sub-$10k stablecoin pieces.
  const splits = transfers.filter(
    (t) =>
      (t.token_symbol === "USDT" || t.token_symbol === "USDC") &&
      t.value_usd >= STRUCTURING_FLOOR_USD &&
      t.value_usd < CTR_USD
  );
  // Only structuring if several sit in a narrow band near the line, not just any
  // small transfers. Group by sender to catch one wallet fanning the split out.
  if (splits.length >= 3) {
    const near = splits.filter((t) => t.value_usd >= CTR_USD * 0.4);
    const pool = near.length >= 3 ? near : splits;
    const sum = pool.reduce((s, t) => s + t.value_usd, 0);
    const lo = Math.min(...pool.map((t) => t.value_usd));
    const hi = Math.max(...pool.map((t) => t.value_usd));
    const senders = Array.from(new Set(pool.map((t) => t.from_address)));
    out.push({
      code: "THRESHOLD-SPLIT",
      title: `${pool.length} stablecoin transfers sized just under the ${usd(CTR_USD)} line`,
      plain:
        `${pool.length} USDT/USDC transfers, ${usd(sum)} in total, each land between ${usd(lo)} and ${usd(hi)} — ` +
        `every one under the ${usd(CTR_USD)} figure exchanges watch for enhanced due diligence. Amounts do not cluster ` +
        `that tightly under a round number by chance; the cash-out was sized to stay below a reporting line. ` +
        `${senders.length === 1 ? `All of them leave the same wallet, which makes coincidence very unlikely.` : `They leave ${senders.length} wallets acting together.`} ` +
        `Deliberately splitting a transfer to stay under a threshold is structuring, an offence separate from the theft itself.`,
      short:
        `${pool.length} stablecoin transfers (${usd(lo)}–${usd(hi)}, ${usd(sum)} total) sized under the ${usd(CTR_USD)} line — that is structuring.`,
      severity: "high",
      wallets: senders,
      amountUsd: sum,
    });
  }

  // 6. MULTI-INPUT-CLUSTER — one wallet quietly funds several mules, betraying
  //    common control however separate the mules look on their own.
  const funderTo = new Map<string, Set<string>>();
  for (const t of transfers) {
    if (!funderTo.has(lc(t.from_address))) funderTo.set(lc(t.from_address), new Set());
    funderTo.get(lc(t.from_address))!.add(lc(t.to_address));
  }
  for (const [funderAddr, recips] of Array.from(funderTo.entries())) {
    if (recips.size < 3) continue;
    const funder = byAddr.get(funderAddr);
    // A victim-entry wallet fanning to mules is the split, already covered above;
    // this finding is about a *separate* wallet that funds the mules' gas.
    if (funder?.layer_type === "VICTIM_ENTRY") continue;
    const fed = Array.from(recips)
      .map((r) => byAddr.get(r))
      .filter(Boolean) as WalletNode[];
    const feedUsd = transfers
      .filter((t) => lc(t.from_address) === funderAddr)
      .reduce((s, t) => s + t.value_usd, 0);
    out.push({
      code: "MULTI-INPUT-CLUSTER",
      title: `${shortWallet(funder?.address ?? funderAddr)} funds ${recips.size} wallets — common-control cluster`,
      plain:
        `${shortWallet(funder?.address ?? funderAddr)} sends to ${recips.size} different wallets ` +
        `(${fed.slice(0, 4).map((n) => shortWallet(n.address)).join(", ")}${fed.length > 4 ? "…" : ""}). ` +
        `A single wallet seeding several others — typically their gas — is a strong sign the receiving wallets are all ` +
        `run by one operator, not independent parties. It lets an investigator treat the whole cluster as one entity ` +
        `and attribute every mule's activity to the same hand.`,
      short:
        `${shortWallet(funder?.address ?? funderAddr)} funds ${recips.size} wallets from one source — they are one operator's cluster, not separate parties.`,
      severity: "medium",
      wallets: [funder?.address ?? funderAddr, ...fed.map((n) => n.address)],
      amountUsd: feedUsd,
    });
  }

  // 7. DUST-TAINT — sub-0.001 native-coin transfers: gas seeding or taint dust.
  const dust = transfers.filter(
    (t) =>
      (t.token_symbol === "ETH" || t.token_symbol === "BTC" || t.token_symbol === "MATIC" || t.token_symbol === "SOL") &&
      t.value > 0 &&
      t.value < DUST_NATIVE
  );
  if (dust.length) {
    const recips = Array.from(new Set(dust.map((t) => t.to_address)));
    const sym = dust[0].token_symbol;
    out.push({
      code: "DUST-TAINT",
      title: `${dust.length} dust transfers (< ${DUST_NATIVE} ${sym}) seeding gas across mules`,
      plain:
        `${dust.length} transfers move less than ${DUST_NATIVE} ${sym} each into ${recips.length} wallets. ` +
        `Amounts that small are not value being moved — they are gas being seeded so a freshly-created mule can pay the ` +
        `fee to forward the real funds, or dust sent to taint and later track a wallet. Either way the dusting ties the ` +
        `recipient wallets to whoever paid for it, which is a handle on the operator.`,
      short:
        `${dust.length} sub-${DUST_NATIVE} ${sym} dust transfers seeded gas to ${recips.length} mules — a handle tying them to one funder.`,
      severity: "medium",
      wallets: recips,
      amountUsd: 0,
    });
  }

  const rank = { high: 0, medium: 1, info: 2 };
  return out.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      (RISK_ORDER[a.code] ?? 99) - (RISK_ORDER[b.code] ?? 99) ||
      b.amountUsd - a.amountUsd
  );
}

function tallyTypologies(
  findings: CryptoFinding[]
): { code: string; label: string; count: number; amount: number }[] {
  const LABEL: Record<string, string> = {
    "VASP-SWEEP": "VASP Sweep",
    "MIXER-TUMBLER-TOUCH": "Mixer / Tumbler Touch",
    "CROSS-CHAIN-BRIDGE": "Cross-Chain Bridge",
    "PEELING-CHAIN": "Peeling Chain",
    "THRESHOLD-SPLIT": "Threshold Split",
    "MULTI-INPUT-CLUSTER": "Multi-Input Cluster",
    "DUST-TAINT": "Dust Taint",
  };
  const m = new Map<string, { code: string; label: string; count: number; amount: number }>();
  for (const f of findings) {
    const cur = m.get(f.code);
    if (cur) {
      cur.count += 1;
      cur.amount += f.amountUsd;
    } else {
      m.set(f.code, { code: f.code, label: LABEL[f.code] ?? f.code, count: 1, amount: f.amountUsd });
    }
  }
  return Array.from(m.values()).sort(
    (a, b) => (RISK_ORDER[a.code] ?? 99) - (RISK_ORDER[b.code] ?? 99)
  );
}

// ── Dual-track decision ─────────────────────────────────────────────────────────
// Track A (express auto-freeze) is reserved for the clean case: a verified
// exchange, funds landing at a real deposit address, a trail that was never run
// through a mixer or a bridge, and high attribution confidence. Anything less —
// an offshore endpoint, an obscured trail, thin confidence — is Track B, where
// an officer reviews before a freeze goes out. The demo produces both at once.
export function decideTrack(ev: CryptoEvidence): TrackDecision {
  const serviceable = ev.vasps.filter((v) => !v.is_mixer);

  if (!serviceable.length) {
    return {
      overall: "B",
      headline: "Track B — no serviceable exchange endpoint",
      summary:
        ev.mixersTouched.length
          ? `The trail ends in ${ev.mixersTouched.join(", ")} with no attributed exchange to serve a notice on. Reconstruct the post-mixer flow before any freeze.`
          : `No wallet in this trace resolves to a known exchange yet. Extend the trace or await further hops before a freeze can be targeted.`,
      assessments: [],
    };
  }

  const assessments: TrackAssessment[] = serviceable.map((target) => {
    const addrs = [...target.depositAddresses, ...target.hotWalletAddresses].map(lc);
    const touchedMixer = addrs.some((a) => ev.taintByAddress[a]?.mixer);
    const touchedBridge = addrs.some((a) => ev.taintByAddress[a]?.bridge);
    const hasDeposit = target.depositAddresses.length > 0;

    // Case confidence starts at the attribution certainty and is penalised for
    // anything that broke the trail — an honest number, not the raw attribution.
    let confidence = target.confidence;
    if (touchedMixer) confidence = Math.min(confidence, 60);
    else if (touchedBridge) confidence = Math.min(confidence, 74);
    if (!target.is_verified) confidence = Math.min(confidence, 70);

    const trackA =
      target.is_verified &&
      hasDeposit &&
      !touchedMixer &&
      !touchedBridge &&
      confidence >= TRACK_A_MIN_CONFIDENCE;

    const reasons: string[] = [];
    if (target.is_verified)
      reasons.push(`${target.vasp_name} is a verified, KYC-bound exchange with a compliance desk.`);
    else reasons.push(`${target.vasp_name} is offshore/unverified (${target.jurisdiction}).`);
    if (hasDeposit) reasons.push(`Funds landed at an identified deposit address.`);
    else reasons.push(`No distinct deposit address was resolved — only a pooled hot wallet.`);
    if (touchedMixer) reasons.push(`The trail to it passed through a mixer — exposure is not provable hop-by-hop.`);
    if (touchedBridge) reasons.push(`The trail to it crossed a bridge and must be re-joined across chains.`);
    if (trackA)
      reasons.push(`Clean, direct, high-confidence trail — eligible for an express freeze.`);

    return {
      target,
      track: trackA ? "A" : "B",
      confidence,
      autoFreeze: trackA,
      touchedMixer,
      touchedBridge,
      reasons,
    };
  });

  const anyA = assessments.some((a) => a.track === "A");
  const anyB = assessments.some((a) => a.track === "B");
  const overall: TrackDecision["overall"] = anyA && anyB ? "DUAL" : anyA ? "A" : "B";

  const aTargets = assessments.filter((a) => a.track === "A").map((a) => a.target.vasp_name);
  const bTargets = assessments.filter((a) => a.track === "B").map((a) => a.target.vasp_name);

  let headline: string;
  let summary: string;
  if (overall === "A") {
    headline = `Track A — express freeze on ${aTargets.join(", ")}`;
    summary = `Clean, verified, direct trail. An auto-freeze / KYC notice can be issued to ${aTargets.join(", ")} immediately.`;
  } else if (overall === "DUAL") {
    headline = `Dual-track — express on ${aTargets.join(", ")}, review on ${bTargets.join(", ")}`;
    summary =
      `${aTargets.join(", ")} sits on a clean direct trail and can be frozen on the express track. ` +
      `${bTargets.join(", ")} was reached through ${
        assessments.find((a) => a.track === "B")?.touchedMixer ? "a mixer" : "a bridge"
      }, so it needs an officer to review the reconstructed trail before a freeze.`;
  } else {
    headline = `Track B — officer review before freeze`;
    summary =
      `Every exchange endpoint here was reached through an obscured trail (${
        ev.mixersTouched.length ? "mixer" : "bridge"
      }) or is offshore. Reconstruct and confirm the flow before serving a freeze.`;
  }

  return { overall, headline, summary, assessments };
}

// ── The brief handed to the AI panel ───────────────────────────────────────────
// Compact enough for a prompt, specific enough that a generic answer is
// obviously wrong. The model is told to quote these addresses, hashes and names.
export function evidenceBrief(ev: CryptoEvidence): string {
  if (!ev.txCount) return "NO WALLET TRACE LOADED.";
  const lines: string[] = [];

  if (ev.findings.length) {
    lines.push(
      `HARD FINDINGS (${ev.findings.length}) — THE ACTUAL CASE. Each already contains the exact ` +
        `amounts, wallet addresses and exchange names. Explain these in your own words; quote the real ` +
        `0x…/T… addresses and VASP names — never invent one.`
    );
    ev.findings.forEach((f, i) => {
      lines.push(`  F${i + 1} [${f.code}] ${f.severity.toUpperCase()} — ${f.title}`);
      lines.push(`      ${f.plain}`);
      if (f.wallets.length) {
        lines.push(
          `      Wallets: ${f.wallets.slice(0, 6).join(", ")}${f.wallets.length > 6 ? "…" : ""}.`
        );
      }
    });
    lines.push(``);
  }

  lines.push(
    `TRACE: seed ${ev.seed} on ${CHAINS[ev.seedChain]?.name ?? ev.seedChain}, ${ev.hops} hops, ` +
      `${ev.txCount} transfers, ${ev.walletCount} wallets, ${usd(ev.totalUsd)} moved. Source: ${ev.source}.`
  );
  lines.push(
    `RISK SPLIT: ${ev.bySeverity.high} high-risk wallets (${usd(ev.highExposureUsd)} exposure), ` +
      `${ev.bySeverity.medium} medium, ${ev.bySeverity.safe} low.`
  );
  if (ev.dateRange) lines.push(`PERIOD: ${ev.dateRange.from} to ${ev.dateRange.to}.`);
  lines.push(`CHAINS: ${ev.chains.map((c) => CHAINS[c]?.name ?? c).join(", ")}.`);

  // Obfuscation stated as fact — the model kept hedging on whether a mixer was
  // "possibly" involved when the taint map already answered it.
  lines.push(
    ev.mixersTouched.length
      ? `MIXER: YES — funds passed through ${ev.mixersTouched.join(", ")}. Downstream exposure is NOT provable hop-by-hop; say so plainly.`
      : `MIXER: NO — no mixer/tumbler in this trail.`
  );
  lines.push(
    ev.bridgesUsed
      ? `BRIDGE: YES — the trail crosses chains via a bridge; exposure must be re-joined across chains.`
      : `BRIDGE: NO — single-chain or no bridge hop.`
  );

  if (ev.vasps.length) {
    lines.push(`EXCHANGES / MIXERS REACHED (${ev.vasps.length}) — the actionable endpoints:`);
    ev.vasps.forEach((v) => {
      lines.push(
        `  ${v.vasp_name} — ${v.is_mixer ? "MIXER (no compliance desk)" : v.is_verified ? "VERIFIED exchange" : "unverified/offshore"}, ` +
          `${usd(v.inflowUsd)} in, on ${v.chains.map((c) => CHAINS[c]?.short ?? c).join("/")}, ` +
          `confidence ${v.confidence}%. ` +
          (v.is_mixer
            ? `No notice can be served.`
            : `Serve process on ${v.compliance_email} (${v.jurisdiction}). ` +
              `${v.depositAddresses.length ? `Deposit: ${v.depositAddresses.map(shortWallet).join(", ")}.` : ""}`)
      );
    });
  }

  // The track decision is computed here, not by the model — it hedged both ways.
  lines.push(`FREEZE TRACK: ${ev.track.headline}. ${ev.track.summary}`);
  ev.track.assessments.forEach((a) => {
    lines.push(
      `  ${a.target.vasp_name}: Track ${a.track}${a.autoFreeze ? " (auto-freeze)" : " (officer review)"}, ` +
        `case confidence ${a.confidence}%. ${a.reasons.join(" ")}`
    );
  });

  if (ev.topWallets.length) {
    lines.push(`MOST-CONNECTED WALLETS — the only source for in/out figures; never invent one:`);
    ev.topWallets.forEach((w) => {
      lines.push(
        `  ${w.address} [${w.layer}${w.vasp ? `, ${w.vasp}` : ""}]: in ${usd(w.inUsd)}, out ${usd(w.outUsd)}, ${w.degree} transfers.`
      );
    });
  }

  if (ev.case) {
    lines.push(
      `CASE: NCRP ${ev.case.ncrp_ack_no ?? "n/a"}, reported ${ev.case.reported_on ?? "n/a"}, ` +
        `loss ${ev.case.amount_lost_inr ? formatINR(ev.case.amount_lost_inr) : "n/a"}, ` +
        `PS ${ev.case.jurisdiction_ps ?? "n/a"}.`
    );
  }

  lines.push(
    `LEGAL BASIS: freezes and KYC production run on Section 91 CrPC / Section 94 BNSS (documents & data), ` +
      `PMLA 2002 for proceeds of crime, and the exchange's FIU-IND obligations. Cite these, not FEMA unless funds left India.`
  );

  return lines.join("\n");
}

// The same evidence sized for a conversation — every fact a chat answer might
// quote, none of the stage directions. About a fifth of the brief above.
export function casualBrief(ev: CryptoEvidence): string {
  if (!ev.txCount) return "NO WALLET TRACE LOADED.";
  const lines: string[] = [
    `TRACE: ${ev.hops} hops, ${ev.txCount} transfers, ${ev.walletCount} wallets, ${usd(ev.totalUsd)} moved across ${ev.chains
      .map((c) => CHAINS[c]?.short ?? c)
      .join("/")}. Seed ${shortWallet(ev.seed)}.`,
    `RISK: ${ev.bySeverity.high} high-risk wallets, ${usd(ev.highExposureUsd)} exposure.`,
  ];
  if (ev.dateRange) lines.push(`PERIOD: ${ev.dateRange.from} to ${ev.dateRange.to}.`);

  lines.push(ev.mixersTouched.length ? `MIXER: yes — ${ev.mixersTouched.join(", ")}.` : `MIXER: no.`);
  lines.push(ev.bridgesUsed ? `BRIDGE: yes — crosses chains.` : `BRIDGE: no.`);

  if (ev.vasps.length) {
    lines.push(
      `EXCHANGES: ${ev.vasps
        .map(
          (v) =>
            `${v.vasp_name} (${v.is_mixer ? "mixer" : v.is_verified ? "verified" : "offshore"}, ${usd(v.inflowUsd)})`
        )
        .join(", ")}.`
    );
  }
  lines.push(`TRACK: ${ev.track.headline}.`);

  if (ev.findings.length) {
    lines.push(`FINDINGS (${ev.findings.length}):`);
    ev.findings.slice(0, 5).forEach((f) => lines.push(`  - ${f.short}`));
  }
  return lines.join("\n");
}

// ── Offline fallback report ─────────────────────────────────────────────────────
// Written straight from the evidence when the AI is unreachable, so the officer
// always gets a specific, readable four-agent report instead of an error.
export function localReport(ev: CryptoEvidence): ChatAgentPanel[] {
  if (!ev.txCount) {
    const intro = "No wallet trace is loaded yet, so there is nothing to analyse.\n\n";
    const mk = (agent: ChatAgent, tail: string): ChatAgentPanel => ({
      agent,
      headline: "Waiting on a trace",
      content: intro + tail,
      confidence: 0.4,
    });
    return [
      mk("Chain Analyst", "Paste a victim-reported wallet address (or load the demo case) and I'll walk the money outward hop by hop and map every wallet it touched."),
      mk("Attribution Analyst", "Once a trace is loaded I'll match the intermediate wallets against known exchange and mixer addresses and tell you which are serviceable."),
      mk("Compliance Officer", "With a trace I'll tell you which exchange to serve, under Section 91 CrPC / Section 94 BNSS, and draft the freeze-and-KYC notice."),
      mk("Investigating Officer", "Load the demo case to see the whole pipeline: trace → attribution → dual-track freeze decision → legal notice."),
    ];
  }

  const high = ev.findings.filter((f) => f.severity === "high");
  const shown = high.slice(0, 5);
  const rest = high.length - shown.length;
  const serviceable = ev.vasps.filter((v) => !v.is_mixer);

  // Chain Analyst — the shape of the flow.
  const chain = [
    `• ${ev.txCount} transfers across ${ev.walletCount} wallets, ${ev.hops} hops, ${usd(ev.totalUsd)} moved on ${ev.chains
      .map((c) => CHAINS[c]?.name ?? c)
      .join(", ")}.`,
    ev.mixersTouched.length
      ? `• The trail passes through ${ev.mixersTouched.join(", ")} — a mixer — so part of it can't be proven hop-by-hop.`
      : `• No mixer in the trail — every hop is directly traceable.`,
    ev.bridgesUsed
      ? `• It crosses chains via a bridge, so the flow re-appears on another chain and had to be re-joined by time and amount.`
      : `• Single-chain flow, no bridge to re-join.`,
    ...ev.topWallets
      .slice(0, 3)
      .map(
        (w) =>
          `• ${shortWallet(w.address)} (${w.layer}) — ${w.degree} transfers, ${usd(w.inUsd)} in / ${usd(w.outUsd)} out.`
      ),
  ].join("\n");

  // Attribution Analyst — who the endpoints are.
  const attribution = ev.vasps.length
    ? ev.vasps
        .map(
          (v) =>
            `• **${v.vasp_name}** — ${v.is_mixer ? "coin mixer, no compliance desk" : v.is_verified ? "verified exchange" : "offshore/unverified"}, ` +
            `${usd(v.inflowUsd)} received, confidence ${v.confidence}%.` +
            (v.is_mixer ? "" : ` Serve on ${v.compliance_email}.`)
        )
        .join("\n")
    : "• No wallet resolved to a known exchange or mixer in this trace.";

  // Compliance Officer — the legal hooks.
  const compliance = [
    `• **Section 91 CrPC / Section 94 BNSS**: compels ${serviceable.length ? serviceable.map((v) => v.vasp_name).join(", ") : "the exchange"} to produce KYC (Aadhaar, PAN, bank account, IP & device logs) and freeze the balance behind the deposit address.`,
    `• **PMLA 2002**: the traced funds are proceeds of crime; the exchange's FIU-IND obligations are engaged the moment it is served.`,
    ...(ev.findings.some((f) => f.code === "THRESHOLD-SPLIT")
      ? [`• The cash-out was structured under the ${usd(CTR_USD)} line — a separate offence worth citing in the notice.`]
      : []),
    ...(ev.mixersTouched.length
      ? [`• ${ev.mixersTouched.join(", ")} is a sanctioned mixer — flag the exposure to FIU-IND; there is no desk to serve.`]
      : []),
  ].join("\n");

  // Investigating Officer — the track decision and next actions.
  const io = [
    `• **${ev.track.headline}.** ${ev.track.summary}`,
    ...ev.track.assessments.map(
      (a) =>
        `• ${a.target.vasp_name}: **Track ${a.track}** (${a.autoFreeze ? "auto-freeze" : "officer review"}), confidence ${a.confidence}%.`
    ),
    ...(shown.length ? shown.map((f) => `• ${f.short}`) : [`• No high-severity finding — the trail looks routine.`]),
    ...(rest > 0 ? [`• Plus ${rest} more high-severity ${rest === 1 ? "finding" : "findings"}.`] : []),
  ].join("\n");

  return [
    {
      agent: "Chain Analyst",
      headline: `${ev.hops}-hop trail, ${usd(ev.totalUsd)} across ${ev.chains.length} ${ev.chains.length === 1 ? "chain" : "chains"}`,
      content: chain,
      findings: ev.topWallets.slice(0, 3).map((w) => `${shortWallet(w.address)}: ${w.layer}, ${usd(w.inUsd + w.outUsd)}`),
      confidence: 0.93,
    },
    {
      agent: "Attribution Analyst",
      headline: serviceable.length
        ? `${serviceable[0].vasp_name} is the freeze target (${usd(serviceable[0].inflowUsd)})`
        : ev.mixersTouched.length
        ? `Trail ends in ${ev.mixersTouched[0]} — no serviceable endpoint`
        : "No exchange attributed yet",
      content: attribution,
      findings: ev.vasps.map((v) => `${v.vasp_name}: ${usd(v.inflowUsd)}, ${v.confidence}%`),
      confidence: 0.9,
    },
    {
      agent: "Compliance Officer",
      headline: `Serve under Section 91 CrPC / Section 94 BNSS`,
      content: compliance,
      findings: [
        ...(serviceable.length ? [`Notice to ${serviceable.map((v) => v.compliance_email).join(", ")}`] : []),
        ...(ev.findings.some((f) => f.code === "THRESHOLD-SPLIT") ? ["Structuring under $10k — separate offence"] : []),
        ...(ev.mixersTouched.length ? [`${ev.mixersTouched.join(", ")} — sanctioned mixer`] : []),
      ],
      confidence: 0.88,
    },
    {
      agent: "Investigating Officer",
      headline: ev.track.headline,
      content: io,
      findings: ev.track.assessments.map(
        (a) => `${a.target.vasp_name}: Track ${a.track}, ${a.confidence}%`
      ),
      confidence: 0.91,
    },
  ];
}

// ── Section 91 CrPC / Section 94 BNSS notice ────────────────────────────────────
// The freeze-and-produce notice served on an exchange. Built from the same
// evidence the panel gets, so it changes the moment the trace does, and it never
// asserts a fact the trace does not support. Replaces FinGuard's sarNarrative.
export type LegalNotice = {
  ref: string;
  statute: string;
  to_vasp: string;
  to_email: string;
  jurisdiction: string;
  subject: string;
  date: string;
  amountUsd: number;
  amountInr?: number;
  targetAddresses: string[];
  walletTrail: {
    hop: number;
    from: string;
    to: string;
    chain: Chain;
    token: string;
    valueUsd: number;
    tx_hash: string;
  }[];
  kycDemands: string[];
  freezeRequest: string;
  body: string[];
  rendered: string;
  serviceable: boolean;
  case?: CaseMeta;
};

export function section91Notice(
  ev: CryptoEvidence,
  caseMeta?: CaseMeta,
  targetVaspName?: string
): LegalNotice {
  const c = caseMeta ?? ev.case;
  const date = c?.reported_on ?? ev.dateRange?.to ?? isoDate(Date.now());
  const serviceableHits = ev.vasps.filter((v) => !v.is_mixer);
  const target =
    (targetVaspName && ev.vasps.find((v) => v.vasp_name === targetVaspName)) ||
    serviceableHits[0];

  const ref = `I4C/91/${c?.ncrp_ack_no ?? "PENDING"}/${(target?.vasp_name ?? "NA")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")}`;
  const statute = "Section 91 CrPC, 1973 read with Section 94 BNSS, 2023";

  // No serviceable exchange — say so honestly rather than address a mixer.
  if (!target || target.is_mixer) {
    const mixer = ev.mixersTouched[0] ?? "a mixer";
    const rendered =
      `NOTICE UNDER ${statute}\n\n` +
      `Ref: ${ref}\nDate: ${date}\n\n` +
      `The traced funds terminate in ${mixer}, a coin mixer with no compliance desk on which ` +
      `process can be served. No Section 91/94 notice can issue until the post-mixer flow is ` +
      `reconstructed and an attributable exchange endpoint is identified.\n\n` +
      `Recommended: refer the mixer exposure to FIU-IND and pursue the withdrawal side by ` +
      `time-and-amount correlation before serving any exchange.`;
    return {
      ref,
      statute,
      to_vasp: mixer,
      to_email: "",
      jurisdiction: "n/a",
      subject: `No serviceable endpoint — funds routed through ${mixer}`,
      date,
      amountUsd: 0,
      amountInr: c?.amount_lost_inr,
      targetAddresses: [],
      walletTrail: [],
      kycDemands: [],
      freezeRequest: "",
      body: [rendered],
      rendered,
      serviceable: false,
      case: c,
    };
  }

  const trail = walletTrailTo(ev, target);
  const targetAddresses = [...target.depositAddresses, ...target.hotWalletAddresses];
  const amountUsd = target.inflowUsd;

  const kycDemands = [
    "Full KYC of the account holder(s) operating the deposit address(es) below — name, address, Aadhaar and PAN as furnished at onboarding.",
    "Registered mobile number, email, and all linked bank account / UPI details used for fiat deposits and withdrawals.",
    "Complete IP-address, device-fingerprint and login/session logs for the said account(s) for the period of the transactions listed.",
    "All internal transaction records mapping the deposit address(es) to the account, including internal ledger entries and withdrawal history.",
  ];

  const freezeRequest =
    `Immediately freeze / place a lien on the balance and all onward withdrawals from the account(s) ` +
    `behind ${targetAddresses.map(shortWallet).join(", ")} pending further orders, and confirm the frozen ` +
    `quantum to this office within 48 hours.`;

  const trailLines = trail.map(
    (h) =>
      `   Hop ${h.hop}: ${shortWallet(h.from)} → ${shortWallet(h.to)} — ${usd(h.valueUsd)} in ${h.token} on ` +
      `${CHAINS[h.chain]?.name ?? h.chain} (tx ${shortWallet(h.tx_hash)}).`
  );

  const track = ev.track.assessments.find((a) => a.target.vasp_name === target.vasp_name);

  const body: string[] = [
    `To: The Nodal / Compliance Officer, ${target.vasp_name} (${target.compliance_email}).`,
    `Ref: ${ref}   Date: ${date}`,
    `Subject: Production of information and freezing of crypto-assets under ${statute} in NCRP complaint ${
      c?.ncrp_ack_no ?? "(ref. to follow)"
    }.`,
    `1. A complaint registered on the National Cyber Crime Reporting Portal (1930)${
      c?.ncrp_ack_no ? ` vide acknowledgement ${c.ncrp_ack_no}` : ""
    }${c?.reported_on ? `, reported ${c.reported_on}` : ""} discloses a cyber-financial fraud with a reported loss of ${
      c?.amount_lost_inr ? formatINR(c.amount_lost_inr) : "(amount under verification)"
    }. The matter is under investigation by ${c?.jurisdiction_ps ?? "the Cyber Crime Police Station"}.`,
    `2. Blockchain analysis of the victim-reported wallet ${ev.seed} traced the proceeds across ${ev.hops} hops on ${ev.chains
      .map((cc) => CHAINS[cc]?.name ?? cc)
      .join(", ")}. ${usd(amountUsd)} of the traced proceeds were deposited into wallet address(es) attributed to ${
      target.vasp_name
    } (attribution confidence ${target.confidence}%).`,
    ...(track?.touchedMixer
      ? [
          `   Note: the trail to ${target.vasp_name} passed through ${ev.mixersTouched.join(
            ", "
          )} (mixer). A mixer severs the on-chain link, so the exposure stated is the value observed entering ${target.vasp_name} and must be read together with the reconstructed trail below.`,
        ]
      : track?.touchedBridge
      ? [
          `   Note: the trail to ${target.vasp_name} crossed a cross-chain bridge. The funds were re-joined across chains by time-and-amount correlation; the exposure stated is the value observed entering ${target.vasp_name} and is corroborated by the trail below.`,
        ]
      : []),
    `3. The traced deposit trail is as follows:`,
    ...trailLines,
    `4. Target address(es) for freezing at ${target.vasp_name}: ${targetAddresses.join(", ") || "(deposit address as identified above)"}.`,
    `5. You are hereby required under ${statute} to PRODUCE, within 3 (three) working days:`,
    ...kycDemands.map((d, i) => `   (${String.fromCharCode(97 + i)}) ${d}`),
    `6. You are further required to ${freezeRequest}`,
    `7. This is a lawful requisition issued in the course of investigation. Non-compliance attracts consequences under Section 91 CrPC / Section 94 BNSS and the exchange's FIU-IND obligations under the PMLA, 2002. The proceeds herein are proceeds of crime; kindly preserve all records and refrain from tipping off the account holder(s).`,
    `${c?.io_name ?? "Investigating Officer"}\n${c?.jurisdiction_ps ?? "Cyber Crime Police Station"} / I4C`,
    ...(track && track.track === "B"
      ? [
          `[Internal: Track B — this endpoint was reached through ${
            track.touchedMixer ? "a mixer" : "a bridge"
          }; verify the reconstructed trail before service.]`,
        ]
      : track && track.track === "A"
      ? [`[Internal: Track A — clean, direct, high-confidence trail; eligible for express service.]`]
      : []),
  ];

  const rendered = `NOTICE UNDER ${statute}\n\n${body.join("\n\n")}`;

  return {
    ref,
    statute,
    to_vasp: target.vasp_name,
    to_email: target.compliance_email,
    jurisdiction: target.jurisdiction,
    subject: `Freeze & KYC production — ${usd(amountUsd)} traced to ${target.vasp_name}`,
    date,
    amountUsd,
    amountInr: c?.amount_lost_inr,
    targetAddresses,
    walletTrail: trail,
    kycDemands,
    freezeRequest,
    body,
    rendered,
    serviceable: true,
    case: c,
  };
}

// Reconstruct the deposit trail leading to a VASP target: walk backwards from
// its addresses over the transfer graph, collect every ancestor wallet, then
// return the transfers among them in flow order. This is the evidenced route
// the notice quotes hop by hop, rather than an inferred one.
function walletTrailTo(ev: CryptoEvidence, target: VaspHit): LegalNotice["walletTrail"] {
  const transfers = ev.transfers ?? [];
  const targetSet = new Set([...target.depositAddresses, ...target.hotWalletAddresses].map(lc));
  if (!targetSet.size || !transfers.length) return [];

  // Backward reachability: every wallet that feeds the exchange, directly or
  // through intermediaries. The "not already seen" guard makes it cycle-safe.
  const ancestors = new Set(targetSet);
  let frontier = Array.from(targetSet);
  let guard = 0;
  while (frontier.length && guard++ < transfers.length + 4) {
    const next: string[] = [];
    for (const t of transfers) {
      if (ancestors.has(lc(t.to_address)) && !ancestors.has(lc(t.from_address))) {
        ancestors.add(lc(t.from_address));
        next.push(lc(t.from_address));
      }
    }
    frontier = next;
  }

  // Keep the edges wholly inside the feeding subgraph — the path the money
  // actually took to reach this exchange — and order them as a flow.
  const onTrail = transfers.filter(
    (t) => ancestors.has(lc(t.from_address)) && ancestors.has(lc(t.to_address))
  );
  onTrail.sort((a, b) => (a.hop ?? 0) - (b.hop ?? 0) || a.timestamp - b.timestamp);

  return onTrail.map((t, i) => ({
    hop: i + 1,
    from: t.from_address,
    to: t.to_address,
    chain: t.chain,
    token: t.token_symbol,
    valueUsd: t.value_usd,
    tx_hash: t.tx_hash,
  }));
}
