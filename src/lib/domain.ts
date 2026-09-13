// Domain model for the console: the shapes that travel between Firestore, the
// views and the evidence engine, plus the pure functions that turn a list of
// transactions into something displayable — risk classification, the typology
// taxonomy, currency/label formatters, cluster grouping and graph layout.
// Nothing here fabricates data; every number is derived from the rows the user
// imported.

export type Severity = "safe" | "medium" | "high";

export type Transaction = {
  id: string;
  date: string;
  fromAccount: string;
  toAccount: string;
  bank: string;
  amount: number;
  currency: string;
  type: string;
  note?: string;
  severity: Severity;
  createdAt?: number;
  // Which CSV import this row arrived in. Lets the upload history replay the
  // analytics for one past file instead of the whole account.
  uploadId?: string;
};

export type Alert = {
  id: string;
  title: string;
  detail: string;
  severity: Severity;
  amount: number;
  time_label: string;
  createdAt?: number;
};

export type SARReport = {
  id: string;
  title: string;
  amount: number;
  status: string;
  severity: Severity;
  // Set when the report was raised from a single account in the graph drawer.
  // Used to keep one account from being escalated into several duplicate cases.
  account?: string;
  // Fingerprint of the data the report was generated from. Two "+ New" clicks on
  // an unchanged dataset produce the same key, which is how the duplicate is
  // caught before it reaches Firestore.
  sourceKey?: string;
  updatedAt?: number;
  createdAt?: number;
};

export type ChatAgent =
  | "Graph Analyst"
  | "Risk Analyst"
  | "Compliance Officer"
  | "Investigation Assistant";

// One specialist's slice of an investigation. Four of these used to arrive as
// four separate chat bubbles, which is how a "short answer" turned into a page
// of scrolling. They now travel inside a single report message and stay folded
// away until the reader asks for them.
export type ChatAgentPanel = {
  agent: ChatAgent;
  headline?: string;
  content: string;
  findings?: string[];
  confidence?: number;
};

// The one-glance answer: how bad it is, in a sentence, plus the few facts that
// justify it. Computed from the evidence engine, never from the model, so it is
// always present and always this user's real numbers.
export type ChatVerdict = {
  level: Severity;
  headline: string;
  points: string[];
  accounts: string[];
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
  // Follow-up questions offered as one-tap chips beneath a reply.
  suggestions?: string[];
};

export const AGENT_META: Record<
  ChatAgent,
  { color: string; bg: string; icon: string; role: string }
> = {
  "Graph Analyst": {
    color: "#38bdf8",
    bg: "rgba(56,189,248,0.12)",
    icon: "◇",
    role: "Traces topology & flow paths",
  },
  "Risk Analyst": {
    color: "#f59e0b",
    bg: "rgba(245,158,11,0.12)",
    icon: "△",
    role: "Scores anomalies & typologies",
  },
  "Compliance Officer": {
    color: "#a78bfa",
    bg: "rgba(167,139,250,0.14)",
    icon: "◈",
    role: "Maps to regulation & filings",
  },
  "Investigation Assistant": {
    color: "#22c55e",
    bg: "rgba(34,197,94,0.12)",
    icon: "◉",
    role: "Suggests next actions",
  },
};

export const SUGGESTED_QUERIES = [
  "Explain what's wrong with my data in simple words",
  "Which accounts should I freeze first?",
  "Why are these transfers suspicious?",
  "What laws does this break?",
  "Show me the biggest money flows",
];

export function formatINR(n: number) {
  if (n >= 10_000_000) return `₹${(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000) return `₹${(n / 100_000).toFixed(2)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
}

export function severityColor(s: Severity) {
  return s === "high" ? "#ef4444" : s === "medium" ? "#f59e0b" : "#22c55e";
}

export type Bank = {
  id: string;
  name: string;
  code: string;
  color: string;
};

export type GraphNode = {
  id: string;
  hash: string;
  bankId: string;
  bankName?: string;
  label: string;
  severity: Severity;
  riskLevel: "normal" | "suspicious" | "high";
  balance: number;
  country: string;
  createdAt: string;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  degree?: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  amount: number;
  currency: string;
  severity: Severity;
  timestamp: string;
  note?: string;
  // The institution that actually settled this transfer, carried from the CSV so
  // the drawer can name real banks instead of guessing from the account id.
  bank?: string;
};

export function classifyRisk(amount: number, note?: string): Severity {
  const n = (note ?? "").toLowerCase();
  if (n.match(/shell|layer|structur|mule|offshore|rapid|pass-through|split/)) return "high";
  if (amount >= 1_000_000) return "high";
  if (amount >= 100_000) return "medium";
  return "safe";
}

// ── Typology recognition ──────────────────────────────────────────────────
// A transaction's narration (note) is scanned for laundering-pattern signals.
// The first matching typology wins, so each transaction is tagged with a
// single dominant pattern. Shared by the raw-data table and the dashboard's
// typology distribution so both always agree.
export type Typology = {
  key: string;
  label: string;
  re: RegExp;
  color: string;
};

export const TYPOLOGIES: Typology[] = [
  { key: "layering", label: "Rapid Layering", re: /layer|rapid/, color: "#ef4444" },
  { key: "shell", label: "Shell-Account Funnel", re: /shell/, color: "#f59e0b" },
  { key: "mule", label: "Mule Network", re: /mule/, color: "#a78bfa" },
  { key: "structuring", label: "Structuring / Smurfing", re: /structur|split|smurf/, color: "#38bdf8" },
  { key: "roundtrip", label: "Round-Trip / U-Turn", re: /round-?trip|u-?turn|pass-?through/, color: "#22c55e" },
  { key: "offshore", label: "Offshore Transfer", re: /offshore/, color: "#ec4899" },
];

export function detectPattern(note?: string): Typology | null {
  const n = (note ?? "").toLowerCase();
  if (!n) return null;
  for (const t of TYPOLOGIES) {
    if (t.re.test(n)) return t;
  }
  return null;
}

// A visual grouping of accounts that transact only with each other. Each
// cluster is captioned with its dominant laundering typology so the canvas
// reads as "here is the mule ring, here is the smurfing fan-out" at a glance.
export type GraphCluster = {
  id: string;
  kind: "web" | "pairs";
  label: string;
  color: string;
  count: number;
  // Money moved inside the cluster, and the worst severity on any of its
  // transfers. Both go in the card header so a ring can be sized up without
  // clicking into it — the whole point of "understand it in one look".
  total: number;
  severity: Severity;
  nodeIds: string[];
  x: number;
  y: number;
  w: number;
  h: number;
};

// Node size scales with how many counterparties an account touches, so hubs
// (mule collectors, smurf sources, shell beneficiaries) visibly dominate.
// Shared with the renderer so layout spacing and drawn size never disagree.
export function nodeRadius(degree = 1): number {
  return Math.min(26, 13 + Math.max(0, degree - 1) * 2.6);
}

// Build a graph layout from live Firestore transactions. Nodes are unique
// account handles; edges are the raw transfers between them. The canvas
// height is computed from the content, so the renderer scales everything
// uniformly instead of squashing nodes into a fixed box.
export function buildGraphFromTransactions(
  txs: Transaction[],
  canvasWidth = 1240
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  bankNames: string[];
  clusters: GraphCluster[];
  height: number;
} {
  const accountMap = new Map<string, { in: number; out: number; sev: Severity; bank: string; example: Transaction }>();

  for (const t of txs) {
    for (const acc of [t.fromAccount, t.toAccount]) {
      if (!acc) continue;
      const cur = accountMap.get(acc) ?? { in: 0, out: 0, sev: "safe" as Severity, bank: t.bank || "Unknown", example: t };
      if (acc === t.fromAccount) cur.out += t.amount;
      else cur.in += t.amount;
      if (t.bank && t.bank !== "Unknown") cur.bank = t.bank;
      if (t.severity === "high") cur.sev = "high";
      else if (t.severity === "medium" && cur.sev !== "high") cur.sev = "medium";
      accountMap.set(acc, cur);
    }
  }

  const bankNames = Array.from(new Set(
    Array.from(accountMap.values()).map((v) => v.bank).filter((b) => b && b !== "Unknown")
  ));

  const accounts = Array.from(accountMap.keys());

  const nodes: GraphNode[] = accounts.map((acc) => {
    const info = accountMap.get(acc)!;
    const bankName = info.bank || "Unknown";
    const bankIdx = bankNames.indexOf(bankName);
    const matchedBank = bankIdx >= 0 && bankIdx < BANKS.length ? BANKS[bankIdx] : bankForAccount(acc);
    return {
      id: acc,
      hash: acc.length > 12 ? `${acc.slice(0, 6)}…${acc.slice(-4)}` : acc,
      bankId: matchedBank.id,
      bankName,
      label: acc,
      severity: info.sev,
      riskLevel: info.sev === "high" ? "high" : info.sev === "medium" ? "suspicious" : "normal",
      balance: info.in - info.out,
      country: info.example.currency === "INR" ? "IN" : "—",
      createdAt: info.example.date,
      x: 0,
      y: 0,
      degree: 0,
    };
  });

  const edges: GraphEdge[] = txs.map((t, i) => ({
    id: t.id ?? `e${i}`,
    source: t.fromAccount,
    target: t.toAccount,
    amount: t.amount,
    currency: t.currency,
    severity: t.severity,
    timestamp: t.date,
    note: t.note,
    bank: t.bank,
  }));

  // Position nodes by connected-component clustering, then give each cluster a
  // shape that matches its topology (chain, fan-in, fan-out) so tightly-linked
  // laundering rings read as structured webs while one-off (safe) transfers sit
  // apart in a tidy grid of two-node pairs.
  const { clusters, height } = layoutGraph(nodes, edges, canvasWidth);

  return { nodes, edges, bankNames, clusters, height };
}

// ── Graph layout ───────────────────────────────────────────────────────────
// Dependency-free, fully deterministic (no random seed) so re-renders are
// stable. Three stages:
//   1. split the graph into connected components,
//   2. lay each component out with a shape that matches its topology,
//   3. pack the dense components into rows and the 1-to-1 pairs into a grid.
// Nothing is ever scaled down to fit — the canvas height grows instead, and the
// renderer scales the whole SVG uniformly so labels never collide.
// Generous, deliberately. The earlier values packed rings shoulder to shoulder
// and the canvas read as one dense mass — you could not tell where the mule
// ring ended and the smurfing fan-out began. Whitespace between cards is what
// makes the groups legible as separate findings.
const PAD = 44;
const GAP_X = 56;
const GAP_Y = 64;
const REGION_GAP = 76;
const CAPTION_H = 46;
// At most two rings side by side. Three columns on a 1240 canvas leaves each
// card too narrow for a six-hop chain, and the chain is the thing worth seeing.
const MAX_COLS = 2;
// Pairs are two nodes and an arrow; they do not need ring-sized breathing room.
const PAIR_GAP = 34;

// Account handles all share an "ACC-" prefix; dropping it keeps the on-canvas
// label short. Exported so the renderer draws exactly what the layout measured.
export function shortAccountLabel(label: string): string {
  const s = label.replace(/^ACC[-_]?/i, "");
  return s.length > 13 ? `${s.slice(0, 12)}…` : s;
}

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

  // Typology is resolved before packing, so the canvas can be ordered by what
  // matters — named attack patterns first, in a fixed order so the colour
  // sequence never shuffles between renders — instead of by box size.
  const webs = items
    .filter((it) => it.bucket.length >= 3)
    .map((it) => ({ ...it, typ: clusterTypology(it.bucket, edges) }))
    .sort((a, b) => a.typ.rank - b.typ.rank || b.bucket.length - a.bucket.length);
  const pairs = items.filter((it) => it.bucket.length < 3);

  if (webs.length) {
    // A row is valid only if every card in it still fits once the width is
    // shared equally — checking the sum instead would let a six-hop chain sit
    // next to a small fan and then spill past its own card, which is the
    // overlap this layout exists to prevent.
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
      // Cards in a row share the width equally, so each one is a clean
      // rectangle on a common grid rather than a box shrink-wrapped to its
      // contents, and the ring is centred inside it.
      const cardW = (usable - GAP_X * (r.length - 1)) / r.length;
      const bodyH = Math.max(...r.map((it) => it.h));
      r.forEach((it, k) => {
        // Height is shared too, so a row reads as one band — but a small ring
        // beside a large one is never stretched past 1.35× its own content. A
        // card that is mostly empty space looks like a rendering fault rather
        // than a deliberate panel, which is worse than a ragged bottom edge.
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

  // Then the simple 1-to-1 transfers. These are the low-interest region, so
  // they pack tighter than the rings above, and the card spans the full width
  // so its edges line up with the typology cards — that alignment is most of
  // what makes the canvas look composed rather than merely assembled.
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

// Bounding box of a laid-out cluster, padded for the glow ring and for the
// label that sits under every node — measured per node so short handles don't
// reserve space they never use. `ox`/`oy` shift the box to start at 0,0.
function measure(
  bucket: GraphNode[],
  pos: Map<string, { x: number; y: number }>
): { w: number; h: number; ox: number; oy: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of bucket) {
    const p = pos.get(n.id)!;
    const r = nodeRadius(n.degree ?? 1);
    // ~5.8px per character at the 9.5px monospace label size.
    const halfLabel = shortAccountLabel(n.label).length * 2.9 + 6;
    const halfW = Math.max(r + 16, halfLabel);
    minX = Math.min(minX, p.x - halfW);
    maxX = Math.max(maxX, p.x + halfW);
    minY = Math.min(minY, p.y - r - 16);
    maxY = Math.max(maxY, p.y + r + 22);
  }
  return { w: maxX - minX, h: maxY - minY, ox: -minX, oy: -minY };
}

// Dominant laundering typology inside a cluster, taken from the narrations of
// the transfers it contains. Falls back to severity when nothing is tagged.
// `rank` orders the canvas: named patterns in declaration order first, so the
// worst findings sit at the top and the colour sequence is stable across
// renders, then the merely suspicious, then the routine.
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
  return { label: "Verified transfer", color: "#22c55e", total, severity, rank: 92 };
}

// Lay out one connected cluster around the origin, choosing the arrangement
// that makes its topology obvious: chains become left-to-right hop lines,
// hub-and-spoke rings put senders on the left and beneficiaries on the right.
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

  // Chain (layering): a path graph — draw the hops as a gentle left-to-right arc.
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

  // Hub-and-spoke (mule fan-in, smurfing fan-out, shell funnel, offshore split):
  // one account touches every other. Senders left, hub centre, beneficiaries right.
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

// Spokes on one side of a hub. Columns cap at 3 so a wide fan grows sideways
// instead of into one very tall stack.
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

// Fallback for irregular clusters: force relaxation (node repulsion + edge
// springs) seeded on a ring, so mixed shapes still spread out evenly.
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

  // Relax: node-node repulsion + edge springs.
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

  // Recentre on the origin.
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

// --- Bank palette -----------------------------------------------------------
// The only static table left in this file. Every figure the UI shows is derived
// from the user's own imported rows; this exists purely to give an account a
// stable colour when its CSV carries no bank column.

export const BANKS: Bank[] = [
  { id: "b1", name: "Meridian Trust Bank", code: "MTB", color: "#38bdf8" },
  { id: "b2", name: "Northwind Capital", code: "NWC", color: "#a78bfa" },
  { id: "b3", name: "Sterling Union Bank", code: "SUB", color: "#f59e0b" },
  { id: "b4", name: "Pacific Reserve", code: "PRV", color: "#22c55e" },
  { id: "b5", name: "Continental Wealth", code: "CWL", color: "#ec4899" },
];

// Assigns a stable bank per account handle by hashing its string. Used to
// colour graph nodes into "swimlanes" when the data has no explicit bank field.
export function bankForAccount(account: string): Bank {
  let h = 0;
  for (let i = 0; i < account.length; i++) h = (h * 31 + account.charCodeAt(i)) >>> 0;
  return BANKS[h % BANKS.length];
}
