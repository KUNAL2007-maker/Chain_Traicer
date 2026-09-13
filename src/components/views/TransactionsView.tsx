"use client";

import { useState } from "react";
import { useTransactions, useDeleteTransaction } from "@/lib/hooks";
import { formatINR, detectPattern, type Severity } from "@/lib/domain";
import { SeverityBadge } from "../ui/SeverityBadge";
import { Page } from "../ui/Page";

export function TransactionsView() {
  const { transactions, loading } = useTransactions();
  const deleteTx = useDeleteTransaction();
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState<"all" | Severity>("all");

  const filtered = transactions.filter((t) => {
    if (severity !== "all" && t.severity !== severity) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      t.fromAccount?.toLowerCase().includes(q) ||
      t.toAccount?.toLowerCase().includes(q) ||
      t.bank?.toLowerCase().includes(q) ||
      t.note?.toLowerCase().includes(q) ||
      detectPattern(t.note)?.label.toLowerCase().includes(q) ||
      String(t.amount).includes(q)
    );
  });

  return (
    <Page width="wide">
      <div
        className="rounded-2xl border overflow-hidden"
        style={{ background: "var(--panel)", borderColor: "var(--border)" }}
      >
        <div
          className="p-4 flex flex-wrap items-center gap-3 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by account, bank, note, amount..."
            className="h-9 flex-1 min-w-[240px] rounded-lg border px-3 text-[13px] outline-none focus:border-emerald-500/40"
            style={{ background: "var(--chip)", borderColor: "var(--border)", color: "var(--text)" }}
          />
          {/* Segmented control rather than four loose buttons — same shape as the
              tab bar on the upload screen, so the two toolbars read as a set. */}
          <div
            className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border p-1"
            style={{ borderColor: "var(--border)", background: "var(--chip)" }}
          >
            {(["all", "high", "medium", "safe"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSeverity(s)}
                aria-pressed={severity === s}
                className="rounded-md px-3 py-1 text-[12px] capitalize transition"
                style={
                  severity === s
                    ? { background: "var(--panel)", color: "var(--text-strong)", boxShadow: "0 1px 0 rgba(0,0,0,.25)" }
                    : { color: "var(--muted-2)" }
                }
              >
                {s}
              </button>
            ))}
          </div>
          <div className="ml-auto shrink-0 text-[12px] tabular-nums" style={{ color: "var(--muted-2)" }}>
            {filtered.length} of {transactions.length}
          </div>
        </div>

        {loading && (
          <div className="p-8 text-center text-[13px]" style={{ color: "var(--muted)" }}>
            Loading...
          </div>
        )}

        {!loading && transactions.length === 0 && (
          <div className="p-10 text-center">
            <div className="text-4xl mb-2">📁</div>
            <div className="text-[14px] font-medium" style={{ color: "var(--text-strong)" }}>
              No transactions yet
            </div>
            <div className="text-[12px] mt-1" style={{ color: "var(--muted-2)" }}>
              Import a CSV to get started
            </div>
          </div>
        )}

        {/* Phone and tablet layout. Nine columns cannot fit 375px — the table
            keeps its natural width and puts Amount, Risk and Pattern behind a
            sideways scroll, which hides the three fields that matter most. Each
            row becomes a card instead, and the page scrolls normally rather than
            nesting a second scroll box. Hidden from lg up, where the table below
            takes over unchanged. */}
        {!loading && transactions.length > 0 && (
          <div className="divide-y lg:hidden" style={{ borderColor: "var(--border)" }}>
            {filtered.map((t) => {
              const p = detectPattern(t.note);
              return (
                <div key={t.id} className="p-3.5" style={{ borderColor: "var(--border)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11.5px] tabular-nums" style={{ color: "var(--muted)" }}>
                      {t.date}
                    </span>
                    <SeverityBadge severity={t.severity} />
                  </div>

                  <div className="mt-1.5 font-mono text-[16px] font-semibold tabular-nums" style={{ color: "var(--text-strong)" }}>
                    {t.currency === "INR" ? formatINR(t.amount) : `${t.amount.toLocaleString("en-IN")} ${t.currency}`}
                  </div>

                  {/* break-all, not truncate — an anonymized handle like
                      ACC-MULE-HUB-2 is the whole point of the row, so it wraps
                      rather than getting cut to three characters. */}
                  <div className="mt-1.5 flex items-baseline gap-1.5 text-[12.5px]" style={{ color: "var(--text)" }}>
                    <span className="break-all">{t.fromAccount}</span>
                    <span style={{ color: "var(--muted)" }}>→</span>
                    <span className="break-all">{t.toAccount}</span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <span className="text-[11.5px]" style={{ color: "var(--muted-2)" }}>
                      {t.bank} · {t.type}
                    </span>
                    {p && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                        style={{ background: `${p.color}22`, color: p.color }}
                      >
                        {p.label}
                      </span>
                    )}
                    <button
                      onClick={() => {
                        if (confirm("Delete this transaction?")) deleteTx(t.id);
                      }}
                      className="ml-auto rounded-md border px-2 py-1 text-[11px] text-red-400/80 transition active:bg-red-500/10"
                      style={{ borderColor: "var(--border)" }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="p-6 text-center text-[13px]" style={{ color: "var(--muted)" }}>
                No transactions match your filters
              </div>
            )}
          </div>
        )}

        {!loading && transactions.length > 0 && (
          // Bounded scroll box with a pinned header row: scrolling a 500-row
          // import no longer leaves you guessing which column you are reading.
          <div className="hidden overflow-auto max-h-[calc(100vh-260px)] lg:block">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 z-10">
                <tr
                  className="text-[11px] uppercase tracking-widest text-left backdrop-blur"
                  style={{ background: "var(--panel-strong)", color: "var(--muted)" }}
                >
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">Date</th>
                  <th className="px-4 py-2.5 font-medium">From</th>
                  <th className="px-4 py-2.5 font-medium">To</th>
                  <th className="px-4 py-2.5 font-medium">Bank</th>
                  <th className="px-4 py-2.5 font-medium text-right whitespace-nowrap">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Risk</th>
                  <th className="px-4 py-2.5 font-medium">Pattern</th>
                  <th className="px-4 py-2.5 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.id}
                    className="border-t hover:bg-[var(--hover)] transition"
                    style={{ borderColor: "var(--border)", color: "var(--text)" }}
                  >
                    <td className="px-4 py-2.5 font-mono text-[12px] whitespace-nowrap tabular-nums">{t.date}</td>
                    <td className="px-4 py-2.5">{t.fromAccount}</td>
                    <td className="px-4 py-2.5">{t.toAccount}</td>
                    <td className="px-4 py-2.5">{t.bank}</td>
                    <td className="px-4 py-2.5 text-right font-mono whitespace-nowrap tabular-nums">
                      {t.currency === "INR" ? formatINR(t.amount) : `${t.amount.toLocaleString("en-IN")} ${t.currency}`}
                    </td>
                    <td className="px-4 py-2.5 text-[12px] whitespace-nowrap" style={{ color: "var(--muted)" }}>
                      {t.type}
                    </td>
                    <td className="px-4 py-2.5">
                      <SeverityBadge severity={t.severity} />
                    </td>
                    <td className="px-4 py-2.5">
                      {(() => {
                        const p = detectPattern(t.note);
                        return p ? (
                          <span
                            className="inline-block rounded px-1.5 py-0.5 text-[10.5px] font-medium whitespace-nowrap"
                            style={{ background: `${p.color}22`, color: p.color }}
                          >
                            {p.label}
                          </span>
                        ) : (
                          <span className="text-[12px]" style={{ color: "var(--muted)" }}>—</span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => {
                          if (confirm("Delete this transaction?")) deleteTx(t.id);
                        }}
                        className="rounded-md border border-transparent px-2 py-1 text-[11px] text-red-400/70 transition hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-300"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="p-6 text-center text-[13px]" style={{ color: "var(--muted)" }}>
                No transactions match your filters
              </div>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
