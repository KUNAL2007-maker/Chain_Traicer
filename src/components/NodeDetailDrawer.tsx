"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bankForAccount,
  detectPattern,
  formatINR,
  severityColor,
  type GraphEdge,
  type GraphNode,
  type Typology,
} from "@/lib/domain";
import { createSAR, useSARReports } from "@/lib/hooks";
import { useAuth } from "@/components/AuthProvider";
import { SeverityBadge } from "./ui/SeverityBadge";

type Flow = {
  inCount: number;
  outCount: number;
  inAmount: number;
  outAmount: number;
  highShare: number;
  burst: number;
};

export function NodeDetailDrawer({
  node,
  edges,
  onClose,
  onOpenSAR,
}: {
  node: GraphNode | null;
  edges: GraphEdge[];
  onClose: () => void;
  // Lets the drawer hand the investigator straight to the report it just filed.
  onOpenSAR?: () => void;
}) {
  const open = !!node;
  const { user } = useAuth();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const related = useMemo(() => {
    if (!node) return [];
    return edges.filter((e) => e.source === node.id || e.target === node.id);
  }, [node, edges]);

  // Which laundering typologies this specific account is involved in, read from
  // the narrations of its own transfers. An account can sit in more than one.
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
    let inCount = 0, outCount = 0, inAmount = 0, outAmount = 0, highs = 0;
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
      perDay.set(e.timestamp, (perDay.get(e.timestamp) ?? 0) + 1);
    }
    const burst = related.length ? Math.max(...Array.from(perDay.values())) : 0;
    return {
      inCount,
      outCount,
      inAmount,
      outAmount,
      highShare: related.length ? highs / related.length : 0,
      burst,
    };
  }, [related, node]);

  // The institutions that actually settled this account's transfers, read from
  // the uploaded rows. It used to hash the counterparty id into a fixed list of
  // invented bank names, so the drawer named banks the data had never mentioned.
  const connectedBanks = useMemo(() => {
    if (!node) return [];
    const names = new Set<string>();
    related.forEach((e) => {
      const other = e.source === node.id ? e.target : e.source;
      names.add(e.bank?.trim() || bankForAccount(other).name);
    });
    return Array.from(names).map((name) => ({ name, color: bankTint(name) }));
  }, [node, related]);

  // Risk bars derived from this account's own traffic, so two accounts in the
  // same ring don't read identically.
  const signals = useMemo(() => {
    const sevFloor = node?.severity === "high" ? 26 : node?.severity === "medium" ? 14 : 4;
    return {
      velocity: clamp(sevFloor + flow.burst * 16 + (dominant?.key === "layering" ? 22 : 0)),
      fanOut: clamp(8 + Math.max(flow.inCount, flow.outCount) * 17),
      counterparty: clamp(Math.round(flow.highShare * 88) + connectedBanks.length * 4),
      spread: clamp(connectedBanks.length * 24),
    };
  }, [node, flow, dominant, connectedBanks.length]);

  // One plain sentence plus at most three short facts, all from this account's
  // own traffic. The previous version wrote three dense sentences per typology
  // with FATF codes in them, which nobody could read at a glance.
  const read = useMemo(
    () => (node ? plainRead(node, dominant, flow, connectedBanks.length) : null),
    [node, dominant, flow, connectedBanks.length]
  );

  // ── Escalation ────────────────────────────────────────────────────────────
  const { reports } = useSARReports();
  const [filing, setFiling] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [node?.id]);

  // A report already on file for this account, matched on the `account` field
  // the drawer writes. useSARReports is a live snapshot, so the button flips to
  // its filed state as soon as Firestore acknowledges the write — and is still
  // in that state when the drawer is reopened tomorrow.
  const existing = useMemo(
    () => (node ? (reports.find((r) => r.account === node.id) ?? null) : null),
    [reports, node]
  );

  const escalate = useCallback(async () => {
    if (!node || !user || filing || existing) return;
    setFailed(false);
    setFiling(true);
    try {
      await createSAR(user.uid, {
        account: node.id,
        title: `${dominant ? dominant.label : "Suspicious activity"} — ${node.label}`,
        amount: flow.inAmount + flow.outAmount,
        status: "Draft",
        severity: node.severity,
      });
    } catch (err) {
      console.error("[escalate]", err);
      setFailed(true);
    } finally {
      setFiling(false);
    }
  }, [node, user, filing, existing, dominant, flow.inAmount, flow.outAmount]);

  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 !mt-0 bg-black/50 backdrop-blur-sm transition-opacity ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      />
      {/* !mt-0 is load-bearing, not tidying. The drawer is mounted inside the
          page frame, which spaces its children with `space-y-4` — and that rule
          puts `margin-top: 1rem` on every child after the first, fixed overlays
          included. A fixed element with top-0 and a 16px top margin starts 16px
          down, so its bottom 16px sat under the window edge: that is where the
          Escalate button was disappearing. */}
      <aside
        className={`fixed right-0 top-0 z-50 !mt-0 h-[100dvh] w-[460px] max-w-full transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* 100dvh, not h-full: `height: 100%` on a fixed element resolves against
            the large viewport, which on a laptop with browser chrome or a tablet
            with a collapsing toolbar is taller than what you can actually see —
            that is how the Escalate button ended up under the bottom edge. dvh
            tracks the visible box. min-h-0 on the column and shrink-0 on the two
            chrome blocks then guarantee the scroll region gives up the space
            rather than pushing the footer out. */}
        <div
          className="flex h-full min-h-0 flex-col border-l"
          style={{ background: "var(--panel)", borderColor: "var(--border)" }}
        >
          {node && (
            <>
              <div
                className="shrink-0 border-b p-5 [@media(max-height:820px)]:p-4"
                style={{ borderColor: "var(--border)" }}
              >
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
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                        Anonymized handle
                      </span>
                      <SeverityBadge severity={node.severity} size="md" />
                    </div>
                    <div className="mt-1 font-mono text-[16px] break-all" style={{ color: "var(--text-strong)" }}>
                      {node.hash}
                    </div>
                    <div className="text-[12px]" style={{ color: "var(--muted-2)" }}>{node.label}</div>
                    {dominant && (
                      <span
                        className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]"
                        style={{
                          borderColor: `${dominant.color}55`,
                          background: `${dominant.color}18`,
                          color: dominant.color,
                        }}
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: dominant.color }} />
                        {dominant.label}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={onClose}
                    className="text-lg leading-none px-1"
                    style={{ color: "var(--muted)" }}
                    aria-label="Close"
                  >
                    ×
                  </button>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 [@media(max-height:820px)]:mt-3">
                  <MiniStat label="Role in ring" value={roleOf(flow)} color="#a78bfa" />
                  <MiniStat label={`Received (${flow.inCount})`} value={formatINR(flow.inAmount)} color="#38bdf8" />
                  <MiniStat label={`Sent (${flow.outCount})`} value={formatINR(flow.outAmount)} color="#f59e0b" />
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-5 [@media(max-height:820px)]:p-4">
                {read && (
                  <section>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] uppercase tracking-widest text-emerald-300">
                        AI explanation
                      </span>
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
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ background: p.t.color, boxShadow: `0 0 8px ${p.t.color}` }}
                          />
                          <span className="text-[12.5px]" style={{ color: "var(--text)" }}>{p.t.label}</span>
                          <span className="text-[10px] font-mono" style={{ color: "var(--muted-2)" }}>
                            {typologyCode(p.t.key)}
                          </span>
                          <span className="ml-auto text-[11px] font-mono" style={{ color: "var(--muted)" }}>
                            {p.count} hop{p.count > 1 ? "s" : ""} · {formatINR(p.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section>
                  <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
                    Timeline breakdown ({related.length} events)
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
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-mono" style={{ color: "var(--muted)" }}>{e.timestamp}</span>
                              <span className={`text-[10px] rounded px-1.5 py-0.5 border ${
                                dir === "out" ? "border-red-500/25 bg-red-500/10 text-red-300" : "border-sky-500/25 bg-sky-500/10 text-sky-300"
                              }`}>
                                {dir === "out" ? "→ outbound" : "← inbound"}
                              </span>
                              <SeverityBadge severity={e.severity} />
                            </div>
                            <div className="mt-1 text-[13px]" style={{ color: "var(--text)" }}>
                              {e.currency === "INR" ? formatINR(e.amount) : `${e.currency} ${e.amount.toLocaleString()}`}{" "}
                              <span style={{ color: "var(--muted)" }}>{dir === "out" ? "to" : "from"}</span>{" "}
                              <span className="font-mono">{otherId.length > 12 ? `${otherId.slice(0, 6)}…${otherId.slice(-4)}` : otherId}</span>
                            </div>
                            {e.note && <div className="text-[11.5px] italic" style={{ color: "var(--muted-2)" }}>— {e.note}</div>}
                          </li>
                        );
                      })}
                  </ol>
                  {related.length > 6 && (
                    <div className="mt-2 pl-4 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
                      + {related.length - 6} more transfer{related.length - 6 > 1 ? "s" : ""} on this account
                    </div>
                  )}
                </section>

                {connectedBanks.length > 0 && (
                  <section>
                    <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
                      Banks involved
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {connectedBanks.map((b) => (
                        <span
                          key={b.name}
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
                  <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>Risk signals</div>
                  <div className="grid grid-cols-2 gap-2">
                    <SignalBar label="Velocity anomaly" value={signals.velocity} color="#ef4444" />
                    <SignalBar label="Fan-out ratio" value={signals.fanOut} color="#f59e0b" />
                    <SignalBar label="Counterparty risk" value={signals.counterparty} color="#f59e0b" />
                    <SignalBar label="Cross-bank spread" value={signals.spread} color="#38bdf8" />
                  </div>
                </section>
              </div>

              {/* Pinned action bar. Solid panel fill rather than the drawer's own
                  background so the list visibly runs underneath it, and the
                  bottom inset keeps the button clear of the window edge. */}
              <div
                className="shrink-0 border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
                style={{ borderColor: "var(--border)", background: "var(--panel-strong)" }}
              >
                {existing ? (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12.5px] text-emerald-200">
                      ✓ Report filed · {existing.status}
                    </div>
                    {onOpenSAR && (
                      <button
                        onClick={onOpenSAR}
                        className="shrink-0 rounded-lg border px-3 py-2 text-[13px] hover:bg-[var(--hover)] transition"
                        style={{ borderColor: "var(--border)", color: "var(--text)", background: "var(--chip)" }}
                      >
                        Open →
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <button
                      onClick={escalate}
                      disabled={filing || !user}
                      className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 px-3 py-2 text-[13px] text-emerald-200 shadow-glow disabled:opacity-50"
                    >
                      {filing ? "Filing report…" : "Escalate to SAR →"}
                    </button>
                    {failed && (
                      <div className="mt-2 text-[11.5px] text-red-300">
                        Could not save the report. Check your connection and try again.
                      </div>
                    )}
                    {!user && (
                      <div className="mt-2 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
                        Sign in to file a report.
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg border px-2.5 py-2" style={{ borderColor: `${color}33`, background: `${color}0E` }}>
      <div className="text-[10px] uppercase tracking-widest" style={{ color }}>{label}</div>
      <div className="mt-0.5 text-[13px] font-medium truncate" style={{ color: "var(--text-strong)" }}>{value}</div>
    </div>
  );
}

function SignalBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <div className="flex items-center justify-between text-[11px]">
        <span style={{ color: "var(--text)" }}>{label}</span>
        <span className="font-mono" style={{ color }}>{value}</span>
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

// Hashed rather than indexed, so one bank keeps the same colour in every drawer.
const BANK_TINTS = ["#38bdf8", "#a78bfa", "#f59e0b", "#22c55e", "#ec4899", "#06b6d4", "#f97316", "#14b8a6"];

function bankTint(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 9973;
  return BANK_TINTS[h % BANK_TINTS.length];
}

// Where the account sits in the chain of custody — derived from whether money
// only arrives, only leaves, or passes straight through.
function roleOf(flow: Flow) {
  if (flow.inCount && flow.outCount) return "Pass-through";
  if (flow.outCount) return "Originator";
  if (flow.inCount) return "Beneficiary";
  return "Isolated";
}

// FATF-style reference codes, shown against the matched typologies rather than
// inside the explanation — a code is a filing reference, not an explanation.
const TYPOLOGY_CODES: Record<string, string> = {
  layering: "AML-TYP-04",
  structuring: "AML-TYP-02",
  mule: "AML-TYP-07",
  offshore: "AML-TYP-09",
  shell: "AML-TYP-11",
  roundtrip: "AML-TYP-05",
};

function typologyCode(key: string) {
  return TYPOLOGY_CODES[key] ?? "AML-TYP-00";
}

function confidencePct(flow: Flow, tagged: boolean) {
  const base = tagged ? 0.82 : 0.61;
  const v = Math.min(0.97, base + flow.highShare * 0.12 + Math.min(0.04, flow.inCount * 0.01));
  return Math.round(v * 100);
}

// One sentence per typology, written the way you would say it out loud. No
// account handles, no codes, no traffic counts — those are on screen already.
const PATTERN_LINE: Record<string, string> = {
  layering:
    "Money lands here and is pushed straight on again, a little smaller each hop, so the trail back to its source goes cold.",
  mule:
    "This account collects lots of small deposits from people with no connection to each other, then pays them out as one lump.",
  structuring:
    "One large sum was broken into several payments, each kept just under the ₹10 lakh amount a bank has to report.",
  shell:
    "Companies with no visible trade are paying money in, and the balance leaves again straight away.",
  offshore:
    "Money is gathered here from within the country and then wired out to accounts abroad.",
  roundtrip:
    "Money goes out and comes back through connected accounts, so it ends up looking like it was earned.",
};

const SEVERITY_LINE: Record<string, string> = {
  high: "The size and spread of this activity sit well outside normal use, though the payment notes don't name a known scheme.",
  medium: "Bigger than everyday retail activity, but the counterparties are steady and nothing is being passed along a chain.",
  safe: "Ordinary activity — few counterparties and amounts in line with normal day-to-day use.",
};

// The whole explanation: a plain sentence about what the pattern is, plus at
// most three short facts about this account in particular.
function plainRead(node: GraphNode, dominant: Typology | null, flow: Flow, bankCount: number) {
  const line = (dominant && PATTERN_LINE[dominant.key]) || SEVERITY_LINE[node.severity];
  const facts: string[] = [];

  if (flow.inCount && flow.outCount) {
    facts.push(
      `Took in ${formatINR(flow.inAmount)}, sent on ${formatINR(flow.outAmount)} — it does not hold the money.`
    );
  } else if (flow.outCount) {
    facts.push(`Sent ${formatINR(flow.outAmount)} to ${plural(flow.outCount, "account")}.`);
  } else if (flow.inCount) {
    facts.push(`Received ${formatINR(flow.inAmount)} from ${plural(flow.inCount, "account")}.`);
  }

  if (flow.burst > 1) facts.push(`${flow.burst} of those transfers happened on a single day.`);
  if (bankCount > 1) facts.push(`Spread over ${bankCount} different banks.`);

  return { line, facts: facts.slice(0, 3) };
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
