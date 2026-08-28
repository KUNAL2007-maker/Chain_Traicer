"use client";

import { useEffect, useMemo } from "react";
import {
  chainColor,
  detectPattern,
  formatUSD,
  severityColor,
  CHAINS,
  type Chain,
  type GraphEdge,
  type GraphNode,
  type LayerType,
  type Typology,
  type WalletNode,
} from "@/lib/domain";
import { useTraceStore } from "@/lib/store";
import { SeverityBadge } from "./ui/SeverityBadge";

type Flow = {
  inCount: number;
  outCount: number;
  inAmount: number;
  outAmount: number;
  highShare: number;
  burst: number;
};

const LAYER_LABEL: Record<LayerType, string> = {
  VICTIM_ENTRY: "Victim entry point",
  BURNER_MULE: "Burner / mule wallet",
  PEELING_CHAIN: "Peeling-chain hop",
  BRIDGE_HOP: "Cross-chain bridge",
  VASP_DEPOSIT: "Exchange deposit address",
  VASP_HOT_WALLET: "Exchange hot wallet",
};

export function NodeDetailDrawer({
  node,
  edges,
  onClose,
  onOpenNotices,
}: {
  node: GraphNode | null;
  edges: GraphEdge[];
  onClose: () => void;
  // Hands the investigator straight to the notice the drawer just drafted.
  onOpenNotices?: () => void;
}) {
  const open = !!node;
  const { trace, notices, generateNotice } = useTraceStore();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The full wallet record behind this graph node — carries the attribution,
  // balance and first/last-seen the layout node doesn't.
  const wallet = useMemo<WalletNode | null>(
    () => (node && trace ? trace.nodes.find((n) => n.address === node.address) ?? null : null),
    [node, trace]
  );

  const related = useMemo(() => {
    if (!node) return [];
    return edges.filter((e) => e.source === node.id || e.target === node.id);
  }, [node, edges]);

  // Which laundering typologies this specific wallet is involved in, read from
  // the tags on its own transfers. A wallet can sit in more than one.
  const patterns = useMemo(() => {
    const tally = new Map<string, { t: Typology; count: number; amount: number }>();
    for (const e of related) {
      const p = detectPattern(e.note);
      if (!p) continue;
      const cur = tally.get(p.key);
      if (cur) {
        cur.count += 1;
        cur.amount += e.amount;
      } else {
        tally.set(p.key, { t: p, count: 1, amount: e.amount });
      }
    }
    return Array.from(tally.values()).sort((a, b) => b.count - a.count || b.amount - a.amount);
  }, [related]);

  const dominant = patterns.length ? patterns[0].t : null;

  const flow = useMemo<Flow>(() => {
    let inCount = 0,
      outCount = 0,
      inAmount = 0,
      outAmount = 0,
      highs = 0;
    const perDay = new Map<string, number>();
    for (const e of related) {
      if (node && e.target === node.id) {
        inCount += 1;
        inAmount += e.amount;
      } else {
        outCount += 1;
        outAmount += e.amount;
      }
      if (e.severity === "high") highs += 1;
      const day = e.timestamp.slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    const burst = related.length ? Math.max(...Array.from(perDay.values())) : 0;
    return { inCount, outCount, inAmount, outAmount, highShare: related.length ? highs / related.length : 0, burst };
  }, [related, node]);

  // The chains this wallet actually transacted on, read from its own transfers.
  const connectedChains = useMemo(() => {
    const set = new Set<Chain>();
    related.forEach((e) => set.add(e.chain));
    if (node) set.add(node.chain);
    return Array.from(set).map((c) => ({ chain: c, name: CHAINS[c].name, color: chainColor(c) }));
  }, [related, node]);

  // Risk bars derived from this wallet's own traffic, so two wallets in the same
  // ring don't read identically.
  const signals = useMemo(() => {
    const sevFloor = node?.severity === "high" ? 26 : node?.severity === "medium" ? 14 : 4;
    return {
      velocity: clamp(sevFloor + flow.burst * 16 + (dominant?.key === "peeling" ? 22 : 0)),
      fanOut: clamp(8 + Math.max(flow.inCount, flow.outCount) * 17),
      counterparty: clamp(Math.round(flow.highShare * 88) + connectedChains.length * 4),
      spread: clamp(connectedChains.length * 24),
    };
  }, [node, flow, dominant, connectedChains.length]);

  const read = useMemo(
    () => (node ? plainRead(node, dominant, flow, connectedChains.length) : null),
    [node, dominant, flow, connectedChains.length]
  );

  // ── Escalation: draft a Section 91 notice against this wallet's exchange ────
  const attribution = wallet?.vasp_attribution ?? null;
  const isMixer = !!attribution?.is_mixer;
  const targetVasp = node?.vasp ?? null;
  const serviceable = !!targetVasp && !isMixer;

  // A notice already drafted for this exchange desk, matched on the VASP name the
  // store writes into the notice. The footer flips to its filed state at once.
  const existing = useMemo(
    () => (targetVasp ? notices.find((n) => n.notice.to_vasp === targetVasp) ?? null : null),
    [notices, targetVasp]
  );

  const draftNotice = () => {
    if (!serviceable || !targetVasp) return;
    const id = generateNotice(targetVasp);
    if (id) onOpenNotices?.();
  };

  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 !mt-0 bg-black/50 backdrop-blur-sm transition-opacity ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      />
      {/* !mt-0 is load-bearing: the drawer is mounted inside a `space-y-4` page
          frame, which puts margin-top:1rem on every child after the first —
          fixed overlays included — pushing the footer under the window edge. */}
      <aside
        className={`fixed right-0 top-0 z-50 !mt-0 h-[100dvh] w-[460px] max-w-full transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex h-full min-h-0 flex-col border-l" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
          {node && (
            <>
              <div className="shrink-0 border-b p-5 [@media(max-height:820px)]:p-4" style={{ borderColor: "var(--border)" }}>
                <div className="flex items-start gap-3">
                  <div
                    className="w-10 h-10 rounded-lg grid place-items-center"
                    style={{
                      background: `${severityColor(node.severity)}22`,
                      color: severityColor(node.severity),
                      boxShadow: node.severity === "high" ? "0 0 16px rgba(239,68,68,0.45)" : undefined,
                    }}
                  >
                    ◉
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                        {LAYER_LABEL[node.layer_type]}
                      </span>
                      <SeverityBadge severity={node.severity} size="md" />
                    </div>
                    <div className="mt-1 font-mono text-[14px] break-all" style={{ color: "var(--text-strong)" }}>
                      {node.address}
                    </div>
                    <div className="text-[12px] flex items-center gap-1.5" style={{ color: "var(--muted-2)" }}>
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: chainColor(node.chain) }} />
                      {CHAINS[node.chain].name}
                      {typeof node.hop === "number" && <span> · hop {node.hop}</span>}
                      <span> · risk {node.risk_score}</span>
                    </div>
                    {dominant && (
                      <span
                        className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]"
                        style={{ borderColor: `${dominant.color}55`, background: `${dominant.color}18`, color: dominant.color }}
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: dominant.color }} />
                        {dominant.label}
                      </span>
                    )}
                  </div>
                  <button onClick={onClose} className="text-lg leading-none px-1" style={{ color: "var(--muted)" }} aria-label="Close">
                    ×
                  </button>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 [@media(max-height:820px)]:mt-3">
                  <MiniStat label="Role in ring" value={roleOf(flow)} color="#a78bfa" />
                  <MiniStat label={`Received (${flow.inCount})`} value={formatUSD(flow.inAmount)} color="#38bdf8" />
                  <MiniStat label={`Sent (${flow.outCount})`} value={formatUSD(flow.outAmount)} color="#f59e0b" />
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-5 [@media(max-height:820px)]:p-4">
                {read && (
                  <section>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] uppercase tracking-widest text-emerald-300">AI explanation</span>
                      <span className="shrink-0 text-[10px] rounded px-1.5 py-0.5 bg-emerald-500/15 border border-emerald-500/25 text-emerald-300">
                        {confidencePct(flow, !!dominant)}% confident
                      </span>
                    </div>
                    <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] p-3">
                      <p className="text-[13.5px] leading-snug" style={{ color: "var(--text-strong)" }}>
                        {read.line}
                      </p>
                      {read.facts.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {read.facts.map((f) => (
                            <li key={f} className="flex gap-1.5 text-[12px]" style={{ color: "var(--muted)" }}>
                              <span className="text-emerald-400/70">·</span>
                              <span>{f}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </section>
                )}

                {/* Attribution — the crypto-specific heart of the dossier. */}
                {attribution && (
                  <section>
                    <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
                      Attribution
                    </div>
                    <div
                      className="rounded-lg border p-3"
                      style={{
                        borderColor: isMixer ? "#ec489955" : attribution.is_verified ? "#22c55e44" : "#f59e0b44",
                        background: isMixer ? "#ec48990D" : attribution.is_verified ? "#22c55e0D" : "#f59e0b0D",
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[14px] font-semibold" style={{ color: "var(--text-strong)" }}>
                          {attribution.vasp_name}
                        </span>
                        <span
                          className="shrink-0 text-[10px] rounded-full border px-2 py-0.5"
                          style={
                            isMixer
                              ? { borderColor: "#ec489955", color: "#ec4899" }
                              : attribution.is_verified
                              ? { borderColor: "#22c55e55", color: "#22c55e" }
                              : { borderColor: "#f59e0b55", color: "#f59e0b" }
                          }
                        >
                          {isMixer ? "Mixer" : attribution.is_verified ? "Verified VASP" : "Unverified"}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-1.5 text-[12px]" style={{ color: "var(--muted)" }}>
                        {attribution.compliance_email && (
                          <Row k="Compliance desk" v={attribution.compliance_email} mono />
                        )}
                        {attribution.jurisdiction && <Row k="Jurisdiction" v={attribution.jurisdiction} />}
                        <Row k="Attribution confidence" v={`${attribution.confidence_score}%`} />
                      </div>
                    </div>
                  </section>
                )}

                {/* Wallet facts */}
                <section>
                  <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
                    Wallet
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {wallet?.balance_usd != null && <MiniStat label="Balance" value={formatUSD(wallet.balance_usd)} color="#22c55e" />}
                    {wallet?.inflow_usd != null && <MiniStat label="Total in" value={formatUSD(wallet.inflow_usd)} color="#38bdf8" />}
                    {wallet?.outflow_usd != null && <MiniStat label="Total out" value={formatUSD(wallet.outflow_usd)} color="#f59e0b" />}
                    {wallet?.first_seen != null && <MiniStat label="First seen" value={fmtDate(wallet.first_seen)} color="#a78bfa" />}
                    {wallet?.last_seen != null && <MiniStat label="Last seen" value={fmtDate(wallet.last_seen)} color="#a78bfa" />}
                    <MiniStat label="Risk band" value={node.risk_band} color={severityColor(node.severity)} />
                  </div>
                </section>

                {patterns.length > 0 && (
                  <section>
                    <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
                      Typologies matched ({patterns.length})
                    </div>
                    <div className="space-y-1.5">
                      {patterns.map((p) => (
                        <div
                          key={p.t.key}
                          className="flex items-center gap-2 rounded-lg border px-2.5 py-2"
                          style={{ borderColor: `${p.t.color}33`, background: `${p.t.color}0D` }}
                        >
                          <span className="w-2 h-2 rounded-full" style={{ background: p.t.color, boxShadow: `0 0 8px ${p.t.color}` }} />
                          <span className="text-[12.5px]" style={{ color: "var(--text)" }}>
                            {p.t.label}
                          </span>
                          <span className="ml-auto text-[11px] font-mono" style={{ color: "var(--muted)" }}>
                            {p.count} hop{p.count > 1 ? "s" : ""} · {formatUSD(p.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section>
                  <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
                    Timeline breakdown ({related.length} transfers)
                  </div>
                  <ol className="relative border-l border-white/10 pl-4 space-y-3">
                    {related
                      .slice()
                      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
                      .slice(0, 6)
                      .map((e) => {
                        const otherId = e.source === node.id ? e.target : e.source;
                        const dir = e.source === node.id ? "out" : "in";
                        return (
                          <li key={e.id} className="relative">
                            <span
                              className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full"
                              style={{ background: severityColor(e.severity), boxShadow: `0 0 8px ${severityColor(e.severity)}` }}
                            />
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[11px] font-mono" style={{ color: "var(--muted)" }}>
                                {e.timestamp.slice(0, 10)}
                              </span>
                              <span
                                className={`text-[10px] rounded px-1.5 py-0.5 border ${
                                  dir === "out"
                                    ? "border-red-500/25 bg-red-500/10 text-red-300"
                                    : "border-sky-500/25 bg-sky-500/10 text-sky-300"
                                }`}
                              >
                                {dir === "out" ? "→ outbound" : "← inbound"}
                              </span>
                              <span
                                className="text-[10px] rounded px-1.5 py-0.5"
                                style={{ background: `${chainColor(e.chain)}1F`, color: chainColor(e.chain) }}
                              >
                                {CHAINS[e.chain].short}
                              </span>
                            </div>
                            <div className="mt-1 text-[13px]" style={{ color: "var(--text)" }}>
                              {formatUSD(e.amount)} <span style={{ color: "var(--muted)" }}>{dir === "out" ? "to" : "from"}</span>{" "}
                              <span className="font-mono">
                                {otherId.length > 12 ? `${otherId.slice(0, 6)}…${otherId.slice(-4)}` : otherId}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                  </ol>
                  {related.length > 6 && (
                    <div className="mt-2 pl-4 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
                      + {related.length - 6} more transfer{related.length - 6 > 1 ? "s" : ""} on this wallet
                    </div>
                  )}
                </section>

                {connectedChains.length > 0 && (
                  <section>
                    <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
                      Chains involved
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {connectedChains.map((b) => (
                        <span
                          key={b.chain}
                          className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[12px]"
                          style={{ borderColor: `${b.color}44`, background: `${b.color}12`, color: b.color }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: b.color }} />
                          {b.name}
                        </span>
                      ))}
                    </div>
                  </section>
                )}

                <section>
                  <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
                    Risk signals
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <SignalBar label="Velocity anomaly" value={signals.velocity} color="#ef4444" />
                    <SignalBar label="Fan-out ratio" value={signals.fanOut} color="#f59e0b" />
                    <SignalBar label="Counterparty risk" value={signals.counterparty} color="#f59e0b" />
                    <SignalBar label="Cross-chain spread" value={signals.spread} color="#38bdf8" />
                  </div>
                </section>
              </div>

              {/* Pinned action bar — draft a freeze notice against this wallet's
                  attributed exchange, or explain why one can't be served. */}
              <div
                className="shrink-0 border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
                style={{ borderColor: "var(--border)", background: "var(--panel-strong)" }}
              >
                {existing ? (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12.5px] text-emerald-200">
                      ✓ Sec 91 notice drafted · {existing.status}
                    </div>
                    {onOpenNotices && (
                      <button
                        onClick={onOpenNotices}
                        className="shrink-0 rounded-lg border px-3 py-2 text-[13px] hover:bg-[var(--hover)] transition"
                        style={{ borderColor: "var(--border)", color: "var(--text)", background: "var(--chip)" }}
                      >
                        Open →
                      </button>
                    )}
                  </div>
                ) : serviceable ? (
                  <button
                    onClick={draftNotice}
                    className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 px-3 py-2 text-[13px] text-emerald-200 shadow-glow transition"
                  >
                    Generate Sec 91 Notice → {targetVasp}
                  </button>
                ) : (
                  <div className="text-[12px] leading-snug" style={{ color: "var(--muted-2)" }}>
                    {isMixer
                      ? "This is a mixer / tumbler — there is no compliance desk to serve. Trace the exit hops to a real exchange to seek a freeze."
                      : "This wallet isn't attributed to an exchange yet. Follow the trail to a VASP deposit or hot wallet to serve a freeze notice."}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0" style={{ color: "var(--muted-2)" }}>
        {k}
      </span>
      <span className={`text-right break-all ${mono ? "font-mono text-[11.5px]" : ""}`} style={{ color: "var(--text)" }}>
        {v}
      </span>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg border px-2.5 py-2" style={{ borderColor: `${color}33`, background: `${color}0E` }}>
      <div className="text-[10px] uppercase tracking-widest" style={{ color }}>
        {label}
      </div>
      <div className="mt-0.5 text-[13px] font-medium truncate" style={{ color: "var(--text-strong)" }}>
        {value}
      </div>
    </div>
  );
}

function SignalBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <div className="flex items-center justify-between text-[11px]">
        <span style={{ color: "var(--text)" }}>{label}</span>
        <span className="font-mono" style={{ color }}>
          {value}
        </span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-white/5 overflow-hidden">
        <div className="h-full" style={{ width: `${value}%`, background: `linear-gradient(90deg, ${color}, ${color}55)` }} />
      </div>
    </div>
  );
}

function clamp(v: number, min = 0, max = 98) {
  return Math.max(min, Math.min(max, Math.round(v)));
}

function fmtDate(ms: number) {
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return "—";
  }
}

// Where the wallet sits in the chain of custody — derived from whether funds
// only arrive, only leave, or pass straight through.
function roleOf(flow: Flow) {
  if (flow.inCount && flow.outCount) return "Pass-through";
  if (flow.outCount) return "Originator";
  if (flow.inCount) return "Beneficiary";
  return "Isolated";
}

function confidencePct(flow: Flow, tagged: boolean) {
  const base = tagged ? 0.82 : 0.61;
  const v = Math.min(0.97, base + flow.highShare * 0.12 + Math.min(0.04, flow.inCount * 0.01));
  return Math.round(v * 100);
}

// One sentence per typology, written the way you'd say it out loud. No addresses,
// no codes, no traffic counts — those are on screen already.
const PATTERN_LINE: Record<string, string> = {
  mixer:
    "Funds were pushed through a mixer or tumbler, pooling them with unrelated deposits so the trail back to the theft goes cold.",
  "vasp-sweep":
    "Funds were swept into an exchange deposit address — the point where a real, KYC-bound account sits behind the wallet and can be frozen.",
  bridge:
    "Funds were moved across chains through a bridge or swap, changing the asset so a single-chain trace loses them.",
  peeling:
    "Small amounts are shaved off across many hops — a peel chain that quietly cashes out while looking like ordinary spends.",
  mule:
    "This wallet gathers many unrelated deposits and forwards them on as one — a burner / mule collector.",
  structuring:
    "Transfers are split to sit under reporting thresholds, spreading one sum across many smaller moves.",
};

const SEVERITY_LINE: Record<string, string> = {
  high: "The size and routing of this activity sit well outside ordinary use, though no single named laundering scheme dominates.",
  medium: "Larger than everyday on-chain activity, but the counterparties are steady and nothing is being peeled along a chain.",
  safe: "Ordinary activity — few counterparties and amounts in line with normal use.",
};

function plainRead(node: GraphNode, dominant: Typology | null, flow: Flow, chainCount: number) {
  const line = (dominant && PATTERN_LINE[dominant.key]) || SEVERITY_LINE[node.severity];
  const facts: string[] = [];

  if (flow.inCount && flow.outCount) {
    facts.push(`Took in ${formatUSD(flow.inAmount)}, sent on ${formatUSD(flow.outAmount)} — it does not hold the funds.`);
  } else if (flow.outCount) {
    facts.push(`Sent ${formatUSD(flow.outAmount)} to ${plural(flow.outCount, "wallet")}.`);
  } else if (flow.inCount) {
    facts.push(`Received ${formatUSD(flow.inAmount)} from ${plural(flow.inCount, "wallet")}.`);
  }

  if (flow.burst > 1) facts.push(`${flow.burst} of those transfers happened on a single day.`);
  if (chainCount > 1) facts.push(`Moved across ${chainCount} different chains.`);

  return { line, facts: facts.slice(0, 3) };
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
