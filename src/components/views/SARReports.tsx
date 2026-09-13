"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  useSARReports,
  useTransactions,
  updateSARStatus,
  createSAR,
  clearSARReports,
  deleteSAR,
} from "@/lib/hooks";
import { formatINR, type Severity, type Transaction } from "@/lib/domain";
import { buildEvidence, sarNarrative, type SARNarrative } from "@/lib/investigation";
import { SeverityBadge } from "../ui/SeverityBadge";
import { Page } from "../ui/Page";
import { useAuth } from "@/components/AuthProvider";

export function SARReports() {
  const { user } = useAuth();
  const { reports, loading } = useSARReports();
  const { transactions } = useTransactions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const selected = reports.find((c) => c.id === selectedId) ?? reports[0] ?? null;

  // A report raised from one account in the graph describes that account's ring,
  // not the whole upload — otherwise a case titled for a single account opens on
  // a narrative about all 43 accounts in the file. If that account is no longer
  // in the data (cleared, or a fresh upload), fall back to the whole file rather
  // than rendering an empty report.
  const ring = useMemo(
    () => (selected?.account ? ringOf(transactions, selected.account) : null),
    [transactions, selected?.account]
  );
  const scoped = useMemo(() => (ring && ring.length ? ring : transactions), [ring, transactions]);

  const highRiskTx = useMemo(() => scoped.filter((t) => t.severity === "high"), [scoped]);

  const scopedAccounts = useMemo(() => {
    const s = new Set<string>();
    scoped.forEach((t) => {
      s.add(t.fromAccount);
      s.add(t.toAccount);
    });
    return s.size;
  }, [scoped]);

  // The report body is derived, never stored. Firestore keeps only the case
  // metadata (title, status, severity), so a report opened tomorrow is written
  // against tomorrow's transactions rather than replaying a stale snapshot —
  // which is what "real-time generation" has to mean for a live case file.
  const narrative = useMemo(() => sarNarrative(buildEvidence(scoped), scoped), [scoped]);

  // "+ New" always files a whole-file report, whichever case happens to be open,
  // so its title and fingerprint come from the unscoped narrative. Clicking it
  // twice without uploading anything new hits the same key, and the second click
  // selects the existing case instead of cloning it.
  const wholeFileNarrative = useMemo(
    () => (scoped === transactions ? narrative : sarNarrative(buildEvidence(transactions), transactions)),
    [scoped, transactions, narrative]
  );
  const sourceKey = `all:${transactions.length}:${wholeFileNarrative.flaggedCount}:${wholeFileNarrative.flaggedValue}`;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  async function handleGenerate() {
    if (!user) return;
    const twin = reports.find((r) => r.sourceKey === sourceKey);
    if (twin) {
      setSelectedId(twin.id);
      setNotice("You already have a report for this data — opened it instead of making a copy.");
      return;
    }
    setCreating(true);
    try {
      const ref = await createSAR(user.uid, {
        // Titled from what was actually found, so the sidebar list distinguishes
        // one case from the next instead of showing six identical rows.
        title: wholeFileNarrative.headline,
        amount: wholeFileNarrative.flaggedValue,
        status: "Draft",
        sourceKey,
        severity: (wholeFileNarrative.grounds.some((g) => g.severity === "high")
          ? "high"
          : wholeFileNarrative.grounds.length
            ? "medium"
            : "safe") as Severity,
      });
      setSelectedId(ref.id);
    } finally {
      setCreating(false);
    }
  }

  async function handleClearHistory() {
    if (!user) return;
    const n = await clearSARReports(user.uid);
    setSelectedId(null);
    setConfirmClear(false);
    setNotice(n ? `Cleared ${n} report${n === 1 ? "" : "s"}.` : "Nothing to clear.");
  }

  async function handleDelete(id: string) {
    if (!user) return;
    await deleteSAR(user.uid, id);
    if (selectedId === id) setSelectedId(null);
  }

  async function handleStatusUpdate(id: string, newStatus: string) {
    if (!user) return;
    await updateSARStatus(user.uid, id, newStatus);
  }

  if (loading) {
    return (
      <Page>
        <div className="py-20 text-center">
          <div className="inline-block w-6 h-6 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin" />
          <div className="mt-2 text-[13px]" style={{ color: "var(--muted)" }}>Loading reports...</div>
        </div>
      </Page>
    );
  }

  const refNo = selected ? `FG/STR/${selected.id.slice(0, 8).toUpperCase()}` : "";

  return (
    <Page width="wide">
      {/* Fixed-width case list, flexible document. The 12-column version stacked
          the list on top of the report below 1280px and gave it a quarter of an
          ultrawide above it — neither is what a case list wants. */}
      <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-4">
          <div className="rounded-2xl border" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
            <div className="p-4 border-b" style={{ borderColor: "var(--border)" }}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Reports</div>
                  <div className="mt-0.5 text-[15px] font-semibold" style={{ color: "var(--text-strong)" }}>{reports.length} total</div>
                </div>
                <button
                  onClick={handleGenerate}
                  disabled={creating || transactions.length === 0}
                  className="text-[11px] rounded-md border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 px-2.5 py-1.5 disabled:opacity-50"
                >
                  {creating ? "Creating..." : "+ New"}
                </button>
              </div>

              {reports.length > 0 && (
                <div className="mt-3">
                  {confirmClear ? (
                    <div className="flex items-center gap-2 text-[11.5px]">
                      <span style={{ color: "var(--muted)" }}>Delete all {reports.length}?</span>
                      <button
                        onClick={handleClearHistory}
                        className="rounded-md border border-red-500/40 bg-red-500/15 hover:bg-red-500/25 text-red-200 px-2 py-1"
                      >
                        Yes, clear
                      </button>
                      <button
                        onClick={() => setConfirmClear(false)}
                        className="rounded-md border px-2 py-1"
                        style={{ borderColor: "var(--border)", color: "var(--text)", background: "var(--chip)" }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmClear(true)}
                      className="text-[11.5px] underline decoration-dotted hover:text-red-200"
                      style={{ color: "var(--muted)" }}
                    >
                      Clear history
                    </button>
                  )}
                </div>
              )}

              {notice && (
                <div
                  className="mt-3 rounded-md border border-sky-500/25 bg-sky-500/10 px-2.5 py-2 text-[11.5px] text-sky-200"
                  role="status"
                >
                  {notice}
                </div>
              )}
            </div>
            <div className="max-h-[560px] overflow-auto divide-y" style={{ borderColor: "var(--border)" }}>
              {reports.map((c) => {
                const active = c.id === (selected?.id ?? "");
                return (
                  <div key={c.id} className="group relative">
                    <button
                      onClick={() => setSelectedId(c.id)}
                      className={`w-full text-left p-3 pr-9 hover:bg-[var(--hover)] transition ${
                        active ? "bg-emerald-500/[0.06] border-l-2 border-emerald-500" : "border-l-2 border-transparent"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <SeverityBadge severity={c.severity} />
                        <span className="text-[10.5px] font-mono" style={{ color: "var(--muted-2)" }}>{c.id.slice(0, 8)}</span>
                        {c.account && (
                          <span className="text-[10px] rounded px-1.5 py-0.5 border border-white/10" style={{ color: "var(--muted)" }}>
                            one account
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[13px] line-clamp-2" style={{ color: "var(--text-strong)" }}>{c.title}</div>
                      <div className="mt-1 flex items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
                        <span className="font-mono">{formatINR(Number(c.amount))}</span>
                        <span>·</span>
                        <span>{c.status}</span>
                      </div>
                    </button>
                    <button
                      onClick={() => handleDelete(c.id)}
                      aria-label="Delete this report"
                      title="Delete this report"
                      className="absolute top-2.5 right-2 rounded px-1.5 py-0.5 text-[13px] leading-none opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-red-500/20 hover:text-red-200 transition"
                      style={{ color: "var(--muted-2)" }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              {reports.length === 0 && (
                <div className="p-6 text-center text-[13px]" style={{ color: "var(--muted)" }}>
                  No reports yet. Upload transactions first.
                </div>
              )}
            </div>
          </div>

          {transactions.length > 0 && (
            <div
              className="rounded-2xl border p-4 text-[12px] leading-relaxed"
              style={{ background: "var(--panel)", borderColor: "var(--border)", color: "var(--muted)" }}
            >
              <div className="text-[11px] uppercase tracking-widest mb-1.5" style={{ color: "var(--muted-2)" }}>
                Live source
              </div>
              Every report on this page is written from your current{" "}
              <span style={{ color: "var(--text)" }}>{transactions.length}</span> transactions. Upload
              more and the wording, accounts and statutes update on their own.
            </div>
          )}
        </aside>

        <section className="min-w-0">
          {!selected && (
            // Fills the column instead of sitting as a 60px sliver at the top of
            // an otherwise empty desktop screen.
            <div
              className="flex h-full min-h-[420px] flex-col items-center justify-center rounded-2xl border p-10 text-center"
              style={{ background: "var(--panel)", borderColor: "var(--border)" }}
            >
              <div className="text-4xl mb-2">📄</div>
              <div className="text-[15px] font-semibold" style={{ color: "var(--text-strong)" }}>No report selected</div>
              <div className="mt-1 text-[13px]" style={{ color: "var(--muted-2)" }}>
                Click &quot;+ New&quot; to generate a report from your transactions
              </div>
            </div>
          )}
          {selected && (
            <div className="rounded-2xl border" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
              <div className="px-5 py-4 border-b flex items-start gap-4" style={{ borderColor: "var(--border)" }}>
                <div className="grid place-items-center w-11 h-11 rounded-lg bg-red-500/15 text-red-300">📄</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                      SAR · {selected.status} · {refNo}
                    </span>
                    <SeverityBadge severity={selected.severity} size="md" />
                  </div>
                  <div className="mt-1 text-[17px] font-semibold" style={{ color: "var(--text-strong)" }}>{selected.title}</div>
                  <div className="text-[12px]" style={{ color: "var(--muted)" }}>
                    {narrative.flaggedCount} flagged transfers · {formatINR(narrative.flaggedValue)} · {narrative.period}
                  </div>
                  {selected.account && ring && ring.length > 0 && (
                    <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
                      Raised from <span className="font-mono">{selected.account}</span> · scoped to that ring
                      ({scopedAccounts} accounts, {scoped.length} transfers)
                    </div>
                  )}
                </div>
                <button
                  onClick={() => window.print()}
                  className="text-[12px] rounded-md border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 px-3 py-1.5 shrink-0"
                >
                  Export PDF ↓
                </button>
              </div>

              <div className="p-5 space-y-5">
                <Section title="1 · Summary of suspicion">
                  {narrative.summary.map((p, i) => (
                    <p key={i} className={i ? "mt-2" : ""}>{p}</p>
                  ))}
                </Section>

                {narrative.subjects.length > 0 && (
                  <Section title="2 · Accounts of interest">
                    <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--border)" }}>
                      <table className="w-full text-[12.5px]">
                        <thead className="text-left" style={{ background: "var(--chip)", color: "var(--muted)" }}>
                          <tr>
                            <th className="px-3 py-2 font-medium">Account</th>
                            <th className="px-3 py-2 font-medium">Role</th>
                            <th className="px-3 py-2 font-medium text-right">Received</th>
                            <th className="px-3 py-2 font-medium text-right">Sent</th>
                          </tr>
                        </thead>
                        <tbody>
                          {narrative.subjects.map((s) => (
                            <tr key={s.account} className="border-t align-top" style={{ borderColor: "var(--border)", color: "var(--text)" }}>
                              <td className="px-3 py-2 font-mono whitespace-nowrap">{s.account}</td>
                              <td className="px-3 py-2">
                                <div style={{ color: "var(--text-strong)" }}>{s.role}</div>
                                <div className="text-[11.5px] mt-0.5" style={{ color: "var(--muted)" }}>{s.why}</div>
                              </td>
                              <td className="px-3 py-2 font-mono text-right whitespace-nowrap">
                                {s.inCount ? `${formatINR(s.inAmount)} (${s.inCount})` : "—"}
                              </td>
                              <td className="px-3 py-2 font-mono text-right whitespace-nowrap">
                                {s.outCount ? `${formatINR(s.outAmount)} (${s.outCount})` : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Section>
                )}

                <Section title={`${narrative.subjects.length ? "3" : "2"} · Grounds for suspicion`}>
                  {narrative.grounds.length === 0 && (
                    <p style={{ color: "var(--muted)" }}>
                      No structural indicator was found in this data. Nothing here is reportable.
                    </p>
                  )}
                  <div className="space-y-3">
                    {narrative.grounds.map((g, i) => (
                      <div
                        key={g.code + i}
                        className="rounded-lg border p-3"
                        style={{ borderColor: "var(--border)", background: "var(--chip)" }}
                      >
                        <div className="flex items-start gap-2 flex-wrap">
                          <SeverityBadge severity={g.severity === "info" ? "safe" : g.severity} />
                          <span className="text-[13px] font-semibold flex-1 min-w-0" style={{ color: "var(--text-strong)" }}>
                            {g.title}
                          </span>
                        </div>
                        <p className="mt-1.5">{g.text}</p>
                      </div>
                    ))}
                  </div>
                </Section>

                <Section title={`${narrative.subjects.length ? "4" : "3"} · Regulatory basis`}>
                  <div className="space-y-2.5">
                    {narrative.regulations.map((r) => (
                      <div key={r.statute}>
                        <div className="font-semibold" style={{ color: "var(--text-strong)" }}>{r.statute}</div>
                        <div>{r.requirement}</div>
                        <div className="text-[12px] mt-0.5" style={{ color: "var(--muted)" }}>
                          Why it applies here: {r.because}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>

                <Section title={`${narrative.subjects.length ? "5" : "4"} · Recommended action`}>
                  <ol className="list-decimal pl-5 space-y-1">
                    {narrative.actions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ol>
                </Section>

                <Section title={`${narrative.subjects.length ? "6" : "5"} · Transactions reported`}>
                  <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--border)" }}>
                    <table className="w-full text-[12.5px]">
                      <thead className="text-left" style={{ background: "var(--chip)", color: "var(--muted)" }}>
                        <tr>
                          <th className="px-3 py-2 font-medium">Date</th>
                          <th className="px-3 py-2 font-medium">From</th>
                          <th className="px-3 py-2 font-medium">To</th>
                          <th className="px-3 py-2 font-medium">Bank</th>
                          <th className="px-3 py-2 font-medium text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {highRiskTx.slice(0, 20).map((t) => (
                          <tr key={t.id} className="border-t" style={{ borderColor: "var(--border)", color: "var(--text)" }}>
                            <td className="px-3 py-2 font-mono">{t.date}</td>
                            <td className="px-3 py-2">{t.fromAccount}</td>
                            <td className="px-3 py-2">{t.toAccount}</td>
                            <td className="px-3 py-2">{t.bank}</td>
                            <td className="px-3 py-2 font-mono text-right">{txAmount(t)}</td>
                          </tr>
                        ))}
                        {highRiskTx.length === 0 && (
                          <tr>
                            <td colSpan={5} className="px-3 py-4 text-center" style={{ color: "var(--muted)" }}>
                              No high-risk transactions in your data
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {highRiskTx.length > 20 && (
                    <div className="mt-1.5 text-[11.5px]" style={{ color: "var(--muted)" }}>
                      Showing the first 20 of {highRiskTx.length} flagged transfers. The full list prints
                      with the PDF.
                    </div>
                  )}
                </Section>

                <Section title={`${narrative.subjects.length ? "7" : "6"} · Conclusion`}>
                  <p>{narrative.conclusion}</p>
                </Section>

                <div className="flex items-center justify-between pt-4 border-t" style={{ borderColor: "var(--border)" }}>
                  <div className="text-[11px]" style={{ color: "var(--muted-2)" }}>
                    Status: <span className="font-semibold" style={{ color: "var(--text)" }}>{selected.status}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleStatusUpdate(selected.id, "Draft")}
                      className="text-[12px] rounded-md border px-3 py-1.5"
                      style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" }}
                    >
                      Draft
                    </button>
                    <button
                      onClick={() => handleStatusUpdate(selected.id, "Under review")}
                      className="text-[12px] rounded-md border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 px-3 py-1.5"
                    >
                      Under review
                    </button>
                    <button
                      onClick={() => handleStatusUpdate(selected.id, "Filed")}
                      className="text-[12px] rounded-md border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 px-3 py-1.5"
                    >
                      Mark as filed
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      {selected && (
        <PrintDocument
          narrative={narrative}
          refNo={refNo}
          status={selected.status}
          flagged={highRiskTx}
        />
      )}
    </Page>
  );
}

function txAmount(t: Transaction) {
  return t.currency === "INR" || !t.currency
    ? formatINR(t.amount)
    : `${t.amount.toLocaleString("en-IN")} ${t.currency}`;
}

// Every transfer in the same connected group as `account` — the ring it belongs
// to, not just the transfers it appears in. A report raised from one node of a
// six-hop layering chain should describe the whole chain, since that is what an
// investigator has to explain to the regulator.
function ringOf(transactions: Transaction[], account: string): Transaction[] {
  const neighbours = new Map<string, string[]>();
  for (const t of transactions) {
    if (!neighbours.has(t.fromAccount)) neighbours.set(t.fromAccount, []);
    if (!neighbours.has(t.toAccount)) neighbours.set(t.toAccount, []);
    neighbours.get(t.fromAccount)!.push(t.toAccount);
    neighbours.get(t.toAccount)!.push(t.fromAccount);
  }
  if (!neighbours.has(account)) return [];

  const seen = new Set<string>([account]);
  const queue = [account];
  while (queue.length) {
    for (const next of neighbours.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return transactions.filter((t) => seen.has(t.fromAccount) || seen.has(t.toAccount));
}

// ── The printed document ──────────────────────────────────────────────────
// Rendered into a portal on <body> and hidden on screen. The print stylesheet
// hides every other top-level node, so the printer receives this and nothing
// else — no sidebar, no buttons, no dark background. It is laid out as a filing
// rather than as a web page: plain type, ruled headings, and the full
// transaction list instead of the first twenty.
function PrintDocument({
  narrative,
  refNo,
  status,
  flagged,
}: {
  narrative: SARNarrative;
  refNo: string;
  status: string;
  flagged: Transaction[];
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = document.createElement("div");
    el.id = "sar-print-portal";
    document.body.appendChild(el);
    setHost(el);
    return () => {
      el.remove();
    };
  }, []);

  if (!host) return null;

  // Numbered so the conclusion can refer back to a section by number and be
  // right whether or not the subjects table is present.
  let n = 0;
  const num = () => ++n;

  return createPortal(
    <article>
      <header style={{ borderBottom: "1.5pt solid #000", paddingBottom: "6pt", marginBottom: "10pt" }}>
        <div style={{ fontSize: "8pt", letterSpacing: "0.14em", textTransform: "uppercase" }}>
          FinGuard Intelligence · Confidential
        </div>
        <h1 style={{ margin: "3pt 0 2pt", fontWeight: 700 }}>Suspicious Activity Report</h1>
        <div style={{ fontSize: "9pt" }}>
          Filed under section 12, Prevention of Money Laundering Act, 2002
        </div>
        <table style={{ marginTop: "7pt", fontSize: "8.5pt", border: "none" }}>
          <tbody>
            <tr>
              <td style={{ border: "none", padding: "1pt 12pt 1pt 0", width: "25%" }}>
                <strong>Reference</strong> {refNo}
              </td>
              <td style={{ border: "none", padding: "1pt 12pt 1pt 0", width: "25%" }}>
                <strong>Status</strong> {status}
              </td>
              <td style={{ border: "none", padding: "1pt 12pt 1pt 0", width: "50%" }}>
                <strong>Period reviewed</strong> {narrative.period}
              </td>
            </tr>
            <tr>
              <td style={{ border: "none", padding: "1pt 12pt 1pt 0" }}>
                <strong>Transfers reported</strong> {narrative.flaggedCount}
              </td>
              <td style={{ border: "none", padding: "1pt 12pt 1pt 0" }} colSpan={2}>
                <strong>Value reported</strong> {formatINR(narrative.flaggedValue)}
              </td>
            </tr>
          </tbody>
        </table>
      </header>

      <section>
        <h2>{num()}. Summary of suspicion</h2>
        {narrative.summary.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </section>

      {narrative.subjects.length > 0 && (
        <section>
          <h2>{num()}. Accounts of interest</h2>
          <table>
            <thead>
              <tr>
                <th style={{ width: "18%" }}>Account</th>
                <th style={{ width: "40%" }}>Role and reason</th>
                <th style={{ width: "13%" }}>Received</th>
                <th style={{ width: "13%" }}>Sent</th>
                <th style={{ width: "16%" }}>Banks</th>
              </tr>
            </thead>
            <tbody>
              {narrative.subjects.map((s) => (
                <tr key={s.account}>
                  <td>{s.account}</td>
                  <td>
                    <strong>{s.role}.</strong> {s.why}
                  </td>
                  <td className="num">{s.inCount ? `${formatINR(s.inAmount)} (${s.inCount})` : "—"}</td>
                  <td className="num">{s.outCount ? `${formatINR(s.outAmount)} (${s.outCount})` : "—"}</td>
                  <td>{s.banks.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>{num()}. Grounds for suspicion</h2>
        {narrative.grounds.length === 0 && (
          <p>No structural indicator of money laundering was identified in the data reviewed.</p>
        )}
        {narrative.grounds.map((g, i) => (
          <div key={g.code + i} style={{ marginBottom: "6pt" }}>
            <p style={{ margin: "0 0 1.5pt", textAlign: "left" }}>
              <strong>
                {i + 1}. {g.title}
              </strong>{" "}
              <span style={{ fontSize: "8pt", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                [{g.severity}]
              </span>
            </p>
            <p style={{ margin: 0 }}>{g.text}</p>
          </div>
        ))}
      </section>

      <section>
        <h2>{num()}. Regulatory basis</h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: "27%" }}>Provision</th>
              <th style={{ width: "36%" }}>What it requires</th>
              <th style={{ width: "37%" }}>Why it applies here</th>
            </tr>
          </thead>
          <tbody>
            {narrative.regulations.map((r) => (
              <tr key={r.statute}>
                <td>{r.statute}</td>
                <td>{r.requirement}</td>
                <td>{r.because}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>{num()}. Recommended action</h2>
        <ol style={{ margin: 0, paddingLeft: "14pt" }}>
          {narrative.actions.map((a, i) => (
            <li key={i} style={{ marginBottom: "2.5pt" }}>
              {a}
            </li>
          ))}
        </ol>
      </section>

      <section className="sar-flow">
        <h2>
          {num()}. Transactions reported ({flagged.length})
        </h2>
        {flagged.length === 0 ? (
          <p>No transaction in the reviewed data was graded high risk.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: "12%" }}>Date</th>
                <th style={{ width: "22%" }}>From</th>
                <th style={{ width: "22%" }}>To</th>
                <th style={{ width: "16%" }}>Bank</th>
                <th style={{ width: "10%" }}>Type</th>
                <th style={{ width: "18%" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map((t) => (
                <tr key={t.id}>
                  <td>{t.date}</td>
                  <td>{t.fromAccount}</td>
                  <td>{t.toAccount}</td>
                  <td>{t.bank}</td>
                  <td>{t.type}</td>
                  <td className="num">{txAmount(t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>{num()}. Conclusion</h2>
        <p>{narrative.conclusion}</p>
      </section>

      <footer style={{ marginTop: "12pt", borderTop: "0.5pt solid #999", paddingTop: "5pt", fontSize: "7.5pt" }}>
        Generated by FinGuard Intelligence from the transaction data held at the time of export.
        This document contains information restricted under section 12 of the PMLA, 2002 and must
        not be disclosed to the subjects named in it.
      </footer>
    </article>,
    host
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[11px] uppercase tracking-widest text-emerald-300 mb-1.5">{title}</div>
      <div className="text-[13px] leading-relaxed" style={{ color: "var(--text)" }}>{children}</div>
    </section>
  );
}
