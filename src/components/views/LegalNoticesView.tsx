"use client";

// Section 91 CrPC / Section 94 BNSS freeze-and-KYC notice manager.
//
// This is the crypto pivot of FinGuard's SARReports view. The two-column
// case-list-plus-document layout, the numbered document sections, the status
// workflow, the per-row delete affordance and the print-portal export are kept
// almost verbatim; the fiat SAR is swapped for a crypto legal notice drafted
// against a live wallet trace. Everything is driven by the in-memory trace
// store: `useNotices()` supplies the drafted notices, `useTraceStore()` the
// evidence and the generate / status / remove actions.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Page } from "@/components/ui/Page";
import {
  useNotices,
  useTraceStore,
  type NoticeStatus,
  type StoredNotice,
} from "@/lib/store";
import { formatUSD, formatINR, shortWallet, CHAINS, chainColor } from "@/lib/domain";

// ── Status pill (mirrors SeverityBadge's shape, coloured by workflow state) ───
const PILL: Record<NoticeStatus, { text: string; bg: string; border: string; dot: string }> = {
  Draft: { text: "text-slate-300", bg: "bg-white/[0.04]", border: "border-white/15", dot: "bg-slate-400" },
  Issued: { text: "text-amber-200", bg: "bg-amber-500/10", border: "border-amber-500/30", dot: "bg-amber-400" },
  Acknowledged: { text: "text-emerald-200", bg: "bg-emerald-500/10", border: "border-emerald-500/30", dot: "bg-emerald-400" },
};

// Workflow button colours — the same palette FinGuard used for Draft / Under
// review / Filed, re-labelled to the notice lifecycle.
const SW: Record<NoticeStatus, string> = {
  Draft: "border-white/15 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300",
  Issued: "border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200",
  Acknowledged: "border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200",
};

function StatusPill({ status, size = "sm" }: { status: NoticeStatus; size?: "sm" | "md" }) {
  const m = PILL[status];
  const pad = size === "md" ? "px-2.5 py-1 text-[12px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border ${m.border} ${m.bg} ${m.text} ${pad}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      {status}
    </span>
  );
}

function whenLabel(ts: number): string {
  return new Date(ts).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function LegalNoticesView({ onGoToTrace }: { onGoToTrace: () => void }) {
  const { notices } = useNotices();
  const { evidence, generateNotice, setNoticeStatus, removeNotice } = useTraceStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Fall back to the most recent notice so the document panel is never empty
  // while the list has rows — the same discipline FinGuard used for its cases.
  const selected = notices.find((n) => n.id === selectedId) ?? notices[0] ?? null;

  // Serviceable freeze targets: every attributed exchange that is not a mixer.
  const serviceable = evidence?.vasps.filter((v) => !v.is_mixer) ?? [];

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function handleGenerate(vaspName: string) {
    const id = generateNotice(vaspName);
    if (id) {
      setSelectedId(id);
      setPicking(false);
      setToast(`Drafted a Section 91 / 94 notice to ${vaspName}.`);
    }
  }

  function handleDelete(id: string) {
    removeNotice(id);
    if (selectedId === id) setSelectedId(null);
  }

  return (
    <Page width="wide">
      {/* Fixed-width notice list, flexible document — the SARReports track. */}
      <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-4">
          <div className="rounded-2xl border" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
            <div className="p-4 border-b" style={{ borderColor: "var(--border)" }}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                    Legal notices
                  </div>
                  <div className="mt-0.5 text-[15px] font-semibold" style={{ color: "var(--text-strong)" }}>
                    {notices.length} total
                  </div>
                </div>
                <button
                  onClick={() => setPicking((p) => !p)}
                  disabled={!evidence}
                  className="text-[11px] rounded-md border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 px-2.5 py-1.5 disabled:opacity-50"
                >
                  {picking ? "Cancel" : "+ Generate"}
                </button>
              </div>

              {!evidence && (
                <div className="mt-2 text-[11px]" style={{ color: "var(--muted-2)" }}>
                  Trace a wallet first to draft a notice.
                </div>
              )}

              {picking && evidence && (
                <div
                  className="mt-3 rounded-lg border p-2"
                  style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
                >
                  <div className="px-1 pb-1.5 text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted-2)" }}>
                    Serve on a serviceable exchange
                  </div>
                  {serviceable.length === 0 ? (
                    <div className="px-1 pb-1 text-[12px]" style={{ color: "var(--muted)" }}>
                      No serviceable exchange endpoint in this trace
                      {evidence.mixersTouched.length
                        ? ` — funds ended in ${evidence.mixersTouched.join(", ")}, which has no compliance desk to serve`
                        : ""}
                      .
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {serviceable.map((v) => (
                        <button
                          key={v.vasp_name}
                          onClick={() => handleGenerate(v.vasp_name)}
                          className="w-full text-left rounded-md px-2.5 py-2 hover:bg-[var(--hover)] transition flex items-center justify-between gap-2"
                        >
                          <span className="min-w-0">
                            <span className="block text-[12.5px] font-medium truncate" style={{ color: "var(--text-strong)" }}>
                              {v.vasp_name}
                            </span>
                            <span className="block text-[11px]" style={{ color: "var(--muted)" }}>
                              {v.is_verified ? "Verified exchange" : "Offshore / unverified"} · {v.confidence}%
                            </span>
                          </span>
                          <span className="text-[12px] font-mono shrink-0" style={{ color: "var(--muted)" }}>
                            {formatUSD(v.inflowUsd)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {toast && (
                <div
                  className="mt-3 rounded-md border border-sky-500/25 bg-sky-500/10 px-2.5 py-2 text-[11.5px] text-sky-200"
                  role="status"
                >
                  {toast}
                </div>
              )}
            </div>

            <div className="max-h-[560px] overflow-auto divide-y" style={{ borderColor: "var(--border)" }}>
              {notices.map((item) => {
                const active = item.id === (selected?.id ?? "");
                return (
                  <div key={item.id} className="group relative">
                    <button
                      onClick={() => setSelectedId(item.id)}
                      className={`w-full text-left p-3 pr-9 hover:bg-[var(--hover)] transition ${
                        active ? "bg-emerald-500/[0.06] border-l-2 border-emerald-500" : "border-l-2 border-transparent"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <StatusPill status={item.status} />
                        <span className="text-[10.5px] font-mono truncate" style={{ color: "var(--muted-2)" }}>
                          {item.notice.ref}
                        </span>
                      </div>
                      <div className="mt-1 text-[13px] line-clamp-2" style={{ color: "var(--text-strong)" }}>
                        {item.notice.serviceable
                          ? `Freeze & KYC — ${item.notice.to_vasp}`
                          : `No serviceable endpoint — ${item.notice.to_vasp}`}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
                        <span className="font-mono">{formatUSD(item.notice.amountUsd)}</span>
                        <span>·</span>
                        <span>{whenLabel(item.createdAt)}</span>
                      </div>
                    </button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      aria-label="Delete this notice"
                      title="Delete this notice"
                      className="absolute top-2.5 right-2 rounded px-1.5 py-0.5 text-[13px] leading-none opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-red-500/20 hover:text-red-200 transition"
                      style={{ color: "var(--muted-2)" }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              {notices.length === 0 && (
                <div className="p-6 text-center text-[13px]" style={{ color: "var(--muted)" }}>
                  {evidence
                    ? "No notices yet. Use “+ Generate” to draft one against this trace."
                    : "No notices yet. Trace a wallet first."}
                </div>
              )}
            </div>
          </div>

          {evidence && (
            <div
              className="rounded-2xl border p-4 text-[12px] leading-relaxed"
              style={{ background: "var(--panel)", borderColor: "var(--border)", color: "var(--muted)" }}
            >
              <div className="text-[11px] uppercase tracking-widest mb-1.5" style={{ color: "var(--muted-2)" }}>
                Live source
              </div>
              Every notice here is drafted from your current trace of{" "}
              <span className="font-mono" style={{ color: "var(--text)" }}>
                {shortWallet(evidence.seed)}
              </span>{" "}
              — <span style={{ color: "var(--text)" }}>{evidence.txCount}</span> transfers,{" "}
              <span style={{ color: "var(--text)" }}>{formatUSD(evidence.totalUsd)}</span> moved. Re-trace and the
              wording, addresses and amounts update on their own.
            </div>
          )}
        </aside>

        <section className="min-w-0">
          {!selected && (
            <div
              className="flex h-full min-h-[420px] flex-col items-center justify-center rounded-2xl border p-10 text-center"
              style={{ background: "var(--panel)", borderColor: "var(--border)" }}
            >
              <div className="text-4xl mb-2">⚖️</div>
              {evidence ? (
                <>
                  <div className="text-[15px] font-semibold" style={{ color: "var(--text-strong)" }}>
                    No notice drafted yet
                  </div>
                  <div className="mt-1 text-[13px] max-w-md" style={{ color: "var(--muted-2)" }}>
                    {serviceable.length
                      ? `Use the “+ Generate” picker to draft a Section 91 CrPC / Section 94 BNSS freeze-and-KYC notice to one of the ${serviceable.length} serviceable exchange${
                          serviceable.length === 1 ? "" : "s"
                        } in this trace.`
                      : "This trace reached no serviceable exchange endpoint — extend the trace or await further hops before a notice can be drafted."}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[15px] font-semibold" style={{ color: "var(--text-strong)" }}>
                    No trace loaded
                  </div>
                  <div className="mt-1 text-[13px] max-w-md" style={{ color: "var(--muted-2)" }}>
                    Trace a victim-reported wallet first; then you can draft a freeze-and-KYC notice to the exchange
                    the funds reached.
                  </div>
                  <button
                    onClick={onGoToTrace}
                    className="mt-4 rounded-xl px-4 py-2.5 text-sm font-medium text-black transition"
                    style={{ background: "linear-gradient(135deg,#22c55e,#10b981)" }}
                  >
                    Go to Trace Wallet
                  </button>
                </>
              )}
            </div>
          )}

          {selected && (
            <NoticeDocument
              stored={selected}
              onSetStatus={(s) => setNoticeStatus(selected.id, s)}
              onDelete={() => handleDelete(selected.id)}
            />
          )}
        </section>
      </div>
    </Page>
  );
}

// ── The document panel + its print portal ───────────────────────────────────
function NoticeDocument({
  stored,
  onSetStatus,
  onDelete,
}: {
  stored: StoredNotice;
  onSetStatus: (s: NoticeStatus) => void;
  onDelete: () => void;
}) {
  const n = stored.notice;
  const copyRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(n.rendered);
      if (copyRef.current) {
        const el = copyRef.current;
        const prev = el.textContent;
        el.textContent = "Copied ✓";
        setTimeout(() => {
          el.textContent = prev;
        }, 1400);
      }
    } catch {
      /* clipboard blocked — the text is on screen to copy by hand */
    }
  };

  const download = () => {
    const blob = new Blob([n.rendered], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${n.ref.replace(/[^\w.-]/g, "_")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="rounded-2xl border" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
        <div className="px-5 py-4 border-b flex items-start gap-4" style={{ borderColor: "var(--border)" }}>
          <div className="grid place-items-center w-11 h-11 rounded-lg bg-red-500/15 text-red-300 text-[20px] font-semibold">
            §
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                {n.statute}
              </span>
              <StatusPill status={stored.status} size="md" />
            </div>
            <div className="mt-1 text-[17px] font-semibold" style={{ color: "var(--text-strong)" }}>
              {n.serviceable ? `Freeze & KYC notice — ${n.to_vasp}` : "No serviceable endpoint"}
            </div>
            <div className="text-[12px]" style={{ color: "var(--muted)" }}>
              Ref {n.ref}
              {n.serviceable && n.to_email ? ` · to ${n.to_email}` : ""}
              {n.serviceable ? ` · ${formatUSD(n.amountUsd)}` : ""}
              {n.amountInr ? ` · loss ${formatINR(n.amountInr)}` : ""}
            </div>
            {n.date && (
              <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
                Dated {n.date}
                {n.jurisdiction && n.jurisdiction !== "n/a" ? ` · ${n.jurisdiction}` : ""}
              </div>
            )}
          </div>
          <button
            onClick={() => window.print()}
            className="text-[12px] rounded-md border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 px-3 py-1.5 shrink-0"
          >
            Print / Save as PDF ↓
          </button>
        </div>

        <div className="p-5 space-y-5">
          {!n.serviceable && (
            <div
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[12.5px] leading-relaxed"
              style={{ color: "var(--text)" }}
            >
              The traced funds terminate in an endpoint with no compliance desk on which process can be served. No
              Section 91 / 94 notice can issue until an attributable exchange is identified — refer the exposure to
              FIU-IND and reconstruct the flow first.
            </div>
          )}

          <Section title="1 · Notice served">
            {n.body.map((p, i) => (
              <p key={i} className={i ? "mt-2" : ""} style={{ whiteSpace: "pre-wrap" }}>
                {p}
              </p>
            ))}
          </Section>

          {n.walletTrail.length > 0 && (
            <Section title="2 · Traced deposit trail">
              <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--border)" }}>
                <table className="w-full text-[12.5px]">
                  <thead className="text-left" style={{ background: "var(--chip)", color: "var(--muted)" }}>
                    <tr>
                      <th className="px-3 py-2 font-medium">Hop</th>
                      <th className="px-3 py-2 font-medium">From → To</th>
                      <th className="px-3 py-2 font-medium">Chain</th>
                      <th className="px-3 py-2 font-medium">Token</th>
                      <th className="px-3 py-2 font-medium text-right">Value</th>
                      <th className="px-3 py-2 font-medium">Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {n.walletTrail.map((h) => (
                      <tr
                        key={`${h.hop}-${h.tx_hash}`}
                        className="border-t"
                        style={{ borderColor: "var(--border)", color: "var(--text)" }}
                      >
                        <td className="px-3 py-2 font-mono">{h.hop}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">
                          {shortWallet(h.from)} → {shortWallet(h.to)}
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <span className="w-2 h-2 rounded-full" style={{ background: chainColor(h.chain) }} />
                            {CHAINS[h.chain]?.short ?? h.chain}
                          </span>
                        </td>
                        <td className="px-3 py-2">{h.token}</td>
                        <td className="px-3 py-2 font-mono text-right">{formatUSD(h.valueUsd)}</td>
                        <td className="px-3 py-2 font-mono">{shortWallet(h.tx_hash)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {n.kycDemands.length > 0 && (
            <Section title="3 · KYC production demanded">
              <ol className="list-decimal pl-5 space-y-1.5">
                {n.kycDemands.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ol>
            </Section>
          )}

          {n.freezeRequest && (
            <Section title="4 · Freeze request">
              <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--chip)" }}>
                {n.freezeRequest}
              </div>
            </Section>
          )}

          {n.targetAddresses.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {n.targetAddresses.map((a, i) => (
                <span
                  key={`${a}-${i}`}
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: "var(--chip)", color: "var(--muted)" }}
                >
                  {shortWallet(a)}
                </span>
              ))}
            </div>
          )}

          {/* Status workflow */}
          <div className="flex items-center justify-between pt-4 border-t flex-wrap gap-3" style={{ borderColor: "var(--border)" }}>
            <div className="text-[11px]" style={{ color: "var(--muted-2)" }}>
              Status: <span className="font-semibold" style={{ color: "var(--text)" }}>{stored.status}</span>
            </div>
            <div className="flex items-center gap-2">
              {(["Draft", "Issued", "Acknowledged"] as NoticeStatus[]).map((s) => {
                const active = stored.status === s;
                return (
                  <button
                    key={s}
                    onClick={() => onSetStatus(s)}
                    aria-pressed={active}
                    className={`text-[12px] rounded-md border px-3 py-1.5 transition ${SW[s]} ${
                      active ? "" : "opacity-60 hover:opacity-100"
                    }`}
                  >
                    {active ? "✓ " : ""}
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Export / actions */}
          <div className="flex items-center justify-between pt-4 border-t flex-wrap gap-3" style={{ borderColor: "var(--border)" }}>
            <div className="flex flex-wrap gap-2">
              <button
                ref={copyRef}
                onClick={copy}
                className="text-[12px] rounded-md border px-3 py-1.5 transition hover:opacity-80"
                style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" }}
              >
                Copy text
              </button>
              <button
                onClick={download}
                className="text-[12px] rounded-md border px-3 py-1.5 transition hover:opacity-80"
                style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" }}
              >
                Download .txt
              </button>
              {n.serviceable && n.to_email && (
                <a
                  href={`mailto:${n.to_email}?subject=${encodeURIComponent(n.subject)}&body=${encodeURIComponent(n.rendered)}`}
                  className="text-[12px] rounded-md border px-3 py-1.5 transition hover:opacity-80"
                  style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" }}
                >
                  Draft email
                </a>
              )}
            </div>
            <button
              onClick={onDelete}
              className="text-[12px] rounded-md border border-red-500/40 bg-red-500/15 hover:bg-red-500/25 text-red-200 px-3 py-1.5"
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Print target — globals.css shows only #sar-print-portal when printing. */}
      {mounted &&
        createPortal(
          <div id="sar-print-portal">
            <h1>NOTICE UNDER {n.statute}</h1>
            {n.body.map((para, i) => (
              <p key={i} style={{ whiteSpace: "pre-wrap" }}>
                {para}
              </p>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

// Small numbered section heading used down the document — the emerald eyebrow
// over indented body content, lifted from FinGuard's SARReports.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[11px] uppercase tracking-widest text-emerald-300 mb-1.5">{title}</div>
      <div className="text-[13px] leading-relaxed" style={{ color: "var(--text)" }}>
        {children}
      </div>
    </section>
  );
}
