"use client";

import { useMemo, useState } from "react";
import { MetricCard } from "../ui/MetricCard";
import { SeverityBadge } from "../ui/SeverityBadge";
import { Page, PanelHeader } from "../ui/Page";
import { formatINR, detectPattern } from "@/lib/domain";
import type { Transaction } from "@/lib/domain";
import { useDashboardStats, useAlerts, useTransactions } from "@/lib/hooks";

const spark1 = [12, 14, 13, 18, 17, 22, 24, 21, 27, 30, 28, 34];
const spark2 = [220, 234, 210, 255, 268, 260, 280, 305, 298, 320, 335, 348];
const spark3 = [3, 4, 3, 5, 6, 5, 6, 6, 7, 7, 7, 8];
const spark4 = [90, 88, 85, 82, 84, 81, 80, 78, 79, 78, 77, 78];

function formatAlertDate(ts: number) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
function formatAlertTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

export function CommandDashboard({ liveFeed }: { liveFeed: boolean }) {
  const { total, high, flaggedAmount, openAlerts } = useDashboardStats();
  const { alerts } = useAlerts();
  const { transactions } = useTransactions();
  const [expandedAlert, setExpandedAlert] = useState<string | null>(null);

  const heat = useMemo(() => buildHeatmap(transactions), [transactions]);
  const typology = useMemo(() => buildTypology(transactions), [transactions]);

  const alertsByDate = alerts.reduce<Record<string, typeof alerts>>((acc, a) => {
    const key = a.createdAt ? formatAlertDate(a.createdAt) : "Unknown";
    if (!acc[key]) acc[key] = [];
    acc[key].push(a);
    return acc;
  }, {});

  return (
    <Page>
      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard
          label="Total Transactions"
          value={total.toLocaleString("en-IN")}
          sub="Across all accounts"
          accent="#38bdf8"
          spark={spark1}
          icon={<span className="text-[11px]">◇</span>}
          trend={{ dir: "up", text: "Live from Firestore" }}
        />
        <MetricCard
          label="Flagged Amount"
          value={formatINR(flaggedAmount)}
          sub="High-risk total"
          accent="#22c55e"
          spark={spark2}
          icon={<span className="text-[11px]">₹</span>}
          trend={{ dir: "up", text: `${high} high-risk txns` }}
        />
        <MetricCard
          label="High-Risk Transfers"
          value={String(high)}
          sub="Flagged for review"
          accent="#ef4444"
          spark={spark3}
          icon={<span className="text-[11px]">◉</span>}
          trend={{ dir: high > 0 ? "up" : "flat", text: high > 0 ? `${high} need review` : "All clear" }}
        />
        <MetricCard
          label="Open Alerts"
          value={String(openAlerts)}
          sub="Active alerts"
          accent="#a78bfa"
          spark={spark4}
          icon={<span className="text-[11px]">◈</span>}
          trend={{ dir: openAlerts > 0 ? "up" : "flat", text: openAlerts > 0 ? `${openAlerts} need attention` : "All clear" }}
        />
      </div>

      {/* Middle strip — 2 panels */}
      <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-2xl p-4 border" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
          <PanelHeader
            eyebrow="Risk Heatmap"
            title="Severity × Date"
            right={
              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
                <span className="w-2 h-2 rounded-sm bg-emerald-500/60" /><span>low</span>
                <span className="w-2 h-2 rounded-sm bg-amber-500/70" /><span>med</span>
                <span className="w-2 h-2 rounded-sm bg-red-500/80" /><span>high</span>
              </div>
            }
          />
          {heat.columns.length === 0 ? (
            <div className="mt-8 mb-6 text-center text-[12.5px]" style={{ color: "var(--muted-2)" }}>
              Upload a CSV to populate the heatmap.
            </div>
          ) : (
            <>
              <div className="mt-4 space-y-[3px]">
                {heat.rows.map((r) => (
                  <div key={r.key} className="grid gap-[3px] items-center" style={{ gridTemplateColumns: `18px repeat(${heat.columns.length}, minmax(0,1fr))` }}>
                    <div className="text-[9px] font-mono" style={{ color: r.color }}>{r.short}</div>
                    {heat.columns.map((c, i) => {
                      const count = c[r.key];
                      const intensity = count / r.max;
                      return (
                        <div
                          key={i}
                          title={`${c.label} · ${r.label}: ${count} txn${count !== 1 ? "s" : ""}`}
                          className="h-4 rounded-[3px]"
                          style={{ background: r.color, opacity: count === 0 ? 0.06 : 0.2 + intensity * 0.8 }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="mt-2 ml-[21px] flex justify-between text-[9px] font-mono" style={{ color: "var(--muted)" }}>
                <span>{heat.columns[0].label}</span>
                {heat.columns.length > 2 && <span>{heat.columns[Math.floor(heat.columns.length / 2)].label}</span>}
                <span>{heat.columns[heat.columns.length - 1].label}</span>
              </div>
            </>
          )}
        </div>

        <div className="rounded-2xl p-4 border" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
          <PanelHeader
            eyebrow="Multi-Agent Fleet"
            title="4 agents · online"
            right={
              <span className="text-[11px] rounded px-1.5 py-0.5 bg-sky-500/10 text-sky-300 border border-sky-500/25">LLM · v4.2</span>
            }
          />
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {[
              { n: "Graph Analyst", c: "#38bdf8", load: 62 },
              { n: "Risk Analyst", c: "#f59e0b", load: 74 },
              { n: "Compliance Officer", c: "#a78bfa", load: 41 },
              { n: "Investigation Assistant", c: "#22c55e", load: 55 },
            ].map((a) => (
              <div key={a.n} className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: a.c, boxShadow: `0 0 8px ${a.c}` }} />
                  <div className="text-[12px] truncate" style={{ color: "var(--text)" }}>{a.n}</div>
                </div>
                <div className="mt-1.5 h-1 rounded-full bg-white/5 overflow-hidden">
                  <div className="h-full" style={{ width: `${a.load}%`, background: `linear-gradient(90deg, ${a.c}, ${a.c}55)` }} />
                </div>
                <div className="mt-1 flex justify-between text-[10px]" style={{ color: "var(--muted)" }}>
                  <span>load</span><span className="font-mono">{a.load}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Alert Feed + Typology. A fractional 2/3 + 1/3 split gave the typology
          rail whatever was left over, which at 1024px was 320px of squeezed
          progress bars. Sizing that column in pixels instead keeps it legible
          and hands every extra pixel to the feed, which is what benefits. */}
      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 flex flex-col rounded-2xl border overflow-hidden" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
          <div className="shrink-0 p-4 flex items-start justify-between gap-3 border-b" style={{ borderColor: "var(--border)" }}>
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Real-Time Alert Feed</div>
              <div className="mt-0.5 text-[15px] font-semibold" style={{ color: "var(--text-strong)" }}>Transaction alerts</div>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
              <span className={`w-1.5 h-1.5 rounded-full ${liveFeed ? "bg-emerald-400 animate-blink" : "bg-slate-500"}`} />
              {liveFeed ? "streaming" : "paused"}
              {alerts.length > 0 && <span>· {alerts.length} alert{alerts.length !== 1 ? "s" : ""}</span>}
            </div>
          </div>

          {alerts.length === 0 ? (
            <div className="p-10 text-center">
              <div className="text-[32px] mb-3 opacity-30">◇</div>
              <div className="text-[14px] font-medium" style={{ color: "var(--text-strong)" }}>No alerts yet</div>
              <div className="mt-1 text-[12.5px] mx-auto max-w-sm" style={{ color: "var(--muted-2)" }}>Upload a CSV file to start monitoring transactions. High-risk transactions will trigger alerts here.</div>
            </div>
          ) : (
            // Bounded so a long alert history scrolls inside the card instead of
            // stretching the dashboard to several screens.
            <div className="divide-y max-h-[520px] overflow-y-auto" style={{ borderColor: "var(--border)" }}>
              {Object.entries(alertsByDate).map(([date, dateAlerts]) => (
                <div key={date}>
                  <div className="sticky top-0 z-10 px-4 py-2 text-[11px] uppercase tracking-widest font-semibold backdrop-blur" style={{ color: "var(--muted)", background: "var(--panel-strong)" }}>
                    {date}
                  </div>
                  {dateAlerts.map((a) => (
                    <div key={a.id}>
                      <div
                        className="p-4 flex items-start gap-3 hover:bg-[var(--hover)] transition cursor-pointer group"
                        onClick={() => setExpandedAlert(expandedAlert === a.id ? null : a.id)}
                      >
                        <div className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${a.severity === "high" ? "bg-red-500" : a.severity === "medium" ? "bg-amber-400" : "bg-emerald-400"}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="text-[14px] font-medium" style={{ color: "var(--text-strong)" }}>{a.title}</div>
                            <SeverityBadge severity={a.severity} />
                            <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                              {a.createdAt ? formatAlertTime(a.createdAt) : ""}
                            </span>
                          </div>
                          <div className="mt-1 text-[12.5px]" style={{ color: "var(--muted-2)" }}>{a.detail}</div>
                          <div className="mt-2 flex items-center gap-2 flex-wrap">
                            <span className="text-[11px] font-mono" style={{ color: "var(--muted)" }}>{formatINR(a.amount)}</span>
                          </div>
                        </div>
                        <button
                          className="opacity-0 group-hover:opacity-100 transition text-[11px] rounded-md border px-2 py-1 hover:bg-[var(--hover)] flex-shrink-0"
                          style={{ borderColor: "var(--border)", color: "var(--text)" }}
                          onClick={(e) => { e.stopPropagation(); setExpandedAlert(expandedAlert === a.id ? null : a.id); }}
                        >
                          Investigate →
                        </button>
                      </div>
                      {expandedAlert === a.id && (
                        <div className="px-4 pb-4 ml-9">
                          <div className="rounded-xl border p-4 space-y-3" style={{ background: "var(--bg)", borderColor: "var(--border)" }}>
                            <div className="text-[11px] uppercase tracking-widest text-sky-300">Investigation Details</div>
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                              <div>
                                <div className="text-[10px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Alert Title</div>
                                <div className="mt-0.5 text-[13px]" style={{ color: "var(--text)" }}>{a.title}</div>
                              </div>
                              <div>
                                <div className="text-[10px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Amount</div>
                                <div className="mt-0.5 text-[13px] font-mono" style={{ color: "var(--text)" }}>{formatINR(a.amount)}</div>
                              </div>
                              <div>
                                <div className="text-[10px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Severity</div>
                                <div className="mt-1"><SeverityBadge severity={a.severity} /></div>
                              </div>
                              <div>
                                <div className="text-[10px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Timestamp</div>
                                <div className="mt-0.5 text-[13px] font-mono" style={{ color: "var(--text)" }}>
                                  {a.createdAt ? `${formatAlertDate(a.createdAt)} · ${formatAlertTime(a.createdAt)}` : "—"}
                                </div>
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Details</div>
                              <div className="mt-0.5 text-[13px] leading-relaxed" style={{ color: "var(--text)" }}>{a.detail}</div>
                            </div>
                            <div className="text-[10px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Risk Assessment</div>
                            <div className="grid grid-cols-3 gap-2">
                              <SignalMini label="Severity score" value={a.severity === "high" ? 92 : a.severity === "medium" ? 58 : 15} color={a.severity === "high" ? "#ef4444" : a.severity === "medium" ? "#f59e0b" : "#22c55e"} />
                              <SignalMini label="Confidence" value={a.severity === "high" ? 87 : 65} color="#38bdf8" />
                              <SignalMini label="Priority" value={a.severity === "high" ? 95 : a.severity === "medium" ? 60 : 20} color="#a78bfa" />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col rounded-2xl p-4 border" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
          <PanelHeader eyebrow="Typology Distribution" title="Detected patterns" />
          {typology.total === 0 ? (
            <div className="mt-8 mb-6 text-center text-[12.5px]" style={{ color: "var(--muted-2)" }}>
              No suspicious typologies detected yet.
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {typology.rows.map((r) => (
                <div key={r.name}>
                  <div className="flex items-center justify-between gap-3 text-[12px]">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-1.5 h-1.5 shrink-0 rounded-full" style={{ background: r.c }} />
                      <span className="truncate" style={{ color: "var(--text)" }}>{r.name}</span>
                    </div>
                    <span className="shrink-0 font-mono tabular-nums" style={{ color: "var(--muted)" }}>{r.count} · {r.pct}%</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <div className="h-full" style={{ width: `${r.pct}%`, background: `linear-gradient(90deg, ${r.c}, ${r.c}44)` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Sits on the floor of the card so the rail lines up with the bottom
              of the feed beside it rather than trailing off mid-panel. */}
          <div className="mt-auto pt-4">
            <div className="h-px mb-4" style={{ background: "var(--border)" }} />
            <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.05] p-3">
              <div className="text-[11px] uppercase tracking-widest text-sky-300">Alert Summary</div>
              <div className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--text)" }}>
                {openAlerts > 0 ? `${openAlerts} alert${openAlerts !== 1 ? "s" : ""} require review.` : "No pending alerts. All systems operating normally."}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}

function SignalMini({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2">
      <div className="text-[10px]" style={{ color: "var(--muted)" }}>{label}</div>
      <div className="mt-1 text-[16px] font-bold" style={{ color }}>{value}%</div>
      <div className="mt-1 h-1 rounded-full bg-white/5 overflow-hidden">
        <div className="h-full" style={{ width: `${value}%`, background: `linear-gradient(90deg, ${color}, ${color}55)` }} />
      </div>
    </div>
  );
}

// ── Risk Heatmap — Severity × Date, built from real transactions ──────────
type SevKey = "high" | "medium" | "safe";
type HeatCol = { label: string; high: number; medium: number; safe: number };
type HeatRow = { key: SevKey; label: string; short: string; color: string; max: number };

function fmtDay(d: string) {
  const parts = d.split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : d;
}

function buildHeatmap(transactions: Transaction[]): { columns: HeatCol[]; rows: HeatRow[] } {
  if (!transactions.length) return { columns: [], rows: [] };

  const byDate = new Map<string, { high: number; medium: number; safe: number }>();
  for (const t of transactions) {
    const key = t.date || "—";
    const cur = byDate.get(key) ?? { high: 0, medium: 0, safe: 0 };
    cur[t.severity] += 1;
    byDate.set(key, cur);
  }

  const dates = Array.from(byDate.keys()).sort();
  const MAX = 28;
  let columns: HeatCol[];
  if (dates.length <= MAX) {
    columns = dates.map((d) => ({ label: fmtDay(d), ...byDate.get(d)! }));
  } else {
    columns = [];
    const size = Math.ceil(dates.length / MAX);
    for (let i = 0; i < dates.length; i += size) {
      const slice = dates.slice(i, i + size);
      const agg = { high: 0, medium: 0, safe: 0 };
      slice.forEach((d) => {
        const c = byDate.get(d)!;
        agg.high += c.high;
        agg.medium += c.medium;
        agg.safe += c.safe;
      });
      columns.push({ label: fmtDay(slice[0]), ...agg });
    }
  }

  const rows: HeatRow[] = [
    { key: "high", label: "High", short: "H", color: "#ef4444", max: Math.max(1, ...columns.map((c) => c.high)) },
    { key: "medium", label: "Medium", short: "M", color: "#f59e0b", max: Math.max(1, ...columns.map((c) => c.medium)) },
    { key: "safe", label: "Low", short: "L", color: "#22c55e", max: Math.max(1, ...columns.map((c) => c.safe)) },
  ];
  return { columns, rows };
}

// ── Typology Distribution — matched against transaction notes ──────────────
function buildTypology(transactions: Transaction[]) {
  const tally = new Map<string, { name: string; c: string; count: number }>();
  for (const t of transactions) {
    const pattern = detectPattern(t.note);
    if (!pattern) continue;
    const cur = tally.get(pattern.key) ?? { name: pattern.label, c: pattern.color, count: 0 };
    cur.count += 1;
    tally.set(pattern.key, cur);
  }
  const total = Array.from(tally.values()).reduce((s, c) => s + c.count, 0);
  const rows = Array.from(tally.values())
    .map((c) => ({ ...c, pct: Math.round((c.count / total) * 100) }))
    .sort((a, b) => b.count - a.count);
  return { rows, total };
}
