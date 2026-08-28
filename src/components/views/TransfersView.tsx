"use client";

import { useEffect, useMemo, useState } from "react";
import { useTransfers, useTraceStore } from "@/lib/store";
import {
  shortWallet,
  formatUSD,
  formatToken,
  chainColor,
  detectPattern,
  CHAINS,
  CHAIN_LIST,
  type Severity,
  type Chain,
  type LayerType,
  type WalletTransfer,
} from "@/lib/domain";
import { SeverityBadge } from "@/components/ui/SeverityBadge";
import { Page } from "@/components/ui/Page";

// Readable pipeline-layer labels — mirrors InvestigationView's LAYER_LABEL so the
// transfers table and the hop-trail graph name every layer the same way.
const LAYER_LABEL: Record<LayerType, string> = {
  VICTIM_ENTRY: "Victim entry",
  BURNER_MULE: "Burner mule",
  PEELING_CHAIN: "Peel chain",
  BRIDGE_HOP: "Bridge hop",
  VASP_DEPOSIT: "Exchange deposit",
  VASP_HOT_WALLET: "Exchange hot wallet",
};

/** Marks a transfer the live feed pulled in after the trace was first run. */
function NewChip() {
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap"
      style={{ background: "rgba(34,197,94,.18)", color: "#4ade80" }}
      title="Seen for the first time on the last live refresh"
    >
      New
    </span>
  );
}

export function TransfersView({ onGoToTrace }: { onGoToTrace: () => void }) {
  const { transfers, loading, newTxHashes } = useTransfers();
  const { trace } = useTraceStore();

  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState<"all" | Severity>("all");
  const [chain, setChain] = useState<"all" | Chain>("all");
  const [newOnly, setNewOnly] = useState(false);

  // A "New" chip buried on row 700 of a long trace is invisible, so the count is
  // also a filter — the officer can jump straight to what just moved.
  const newSet = useMemo(() => new Set(newTxHashes), [newTxHashes]);
  const isNew = (t: WalletTransfer) => newSet.has(t.tx_hash);

  // A later poll that finds nothing new empties the set; leaving the filter on
  // would strand the officer on an empty table with no obvious way back.
  useEffect(() => {
    if (newTxHashes.length === 0) setNewOnly(false);
  }, [newTxHashes]);

  // FinGuard read severity/typology straight off the transaction row. Here a
  // transfer's risk and attribution live on the destination *wallet node* the
  // engine produced, so we index the trace's nodes by address and look up the
  // node the money lands in.
  const nodeByAddr = useMemo(
    () => new Map((trace?.nodes ?? []).map((n) => [n.address, n] as const)),
    [trace]
  );
  const rowSeverity = (t: WalletTransfer): Severity =>
    nodeByAddr.get(t.to_address)?.severity ?? "safe";

  // The chains this trace actually touched, in canonical order — the chain
  // filter only ever offers segments that match real data.
  const chainsPresent = useMemo(() => {
    const seen = new Set<Chain>();
    transfers.forEach((t) => seen.add(t.chain));
    return CHAIN_LIST.filter((c) => seen.has(c));
  }, [transfers]);

  const filtered = transfers.filter((t) => {
    if (newOnly && !isNew(t)) return false;
    if (severity !== "all" && rowSeverity(t) !== severity) return false;
    if (chain !== "all" && t.chain !== chain) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      t.from_address.toLowerCase().includes(q) ||
      t.to_address.toLowerCase().includes(q) ||
      t.tx_hash.toLowerCase().includes(q) ||
      t.token_symbol.toLowerCase().includes(q) ||
      CHAINS[t.chain].name.toLowerCase().includes(q)
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
            placeholder="Search by wallet, tx hash, token, chain..."
            className="h-9 flex-1 min-w-[240px] rounded-lg border px-3 text-[13px] outline-none focus:border-emerald-500/40"
            style={{ background: "var(--chip)", borderColor: "var(--border)", color: "var(--text)" }}
          />
          {/* Segmented control rather than four loose buttons — same shape as the
              tab bar elsewhere in the console, so the toolbars read as a set. */}
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
          {/* Chain filter — only rendered once the trace spans more than one chain,
              otherwise a single-chain toggle is pointless. */}
          {chainsPresent.length > 1 && (
            <div
              className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border p-1"
              style={{ borderColor: "var(--border)", background: "var(--chip)" }}
            >
              {(["all", ...chainsPresent] as ("all" | Chain)[]).map((c) => (
                <button
                  key={c}
                  onClick={() => setChain(c)}
                  aria-pressed={chain === c}
                  className="rounded-md px-3 py-1 text-[12px] transition"
                  style={
                    chain === c
                      ? { background: "var(--panel)", color: "var(--text-strong)", boxShadow: "0 1px 0 rgba(0,0,0,.25)" }
                      : { color: "var(--muted-2)" }
                  }
                >
                  {c === "all" ? "All" : CHAINS[c].short}
                </button>
              ))}
            </div>
          )}
          {/* Only appears after a live refresh actually turned something up. */}
          {newTxHashes.length > 0 && (
            <button
              onClick={() => setNewOnly((v) => !v)}
              aria-pressed={newOnly}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition"
              style={
                newOnly
                  ? { borderColor: "rgba(34,197,94,.5)", background: "rgba(34,197,94,.14)", color: "#4ade80" }
                  : { borderColor: "var(--border)", background: "var(--chip)", color: "#4ade80" }
              }
            >
              <span className="h-1.5 w-1.5 rounded-full animate-blink" style={{ background: "#22c55e" }} />
              {newTxHashes.length} new
            </button>
          )}
          <div className="ml-auto shrink-0 text-[12px] tabular-nums" style={{ color: "var(--muted-2)" }}>
            {filtered.length} of {transfers.length}
          </div>
        </div>

        {loading && (
          <div className="p-8 text-center text-[13px]" style={{ color: "var(--muted)" }}>
            Tracing…
          </div>
        )}

        {!loading && transfers.length === 0 && (
          <div className="p-10 text-center">
            <div className="text-4xl mb-2">⛓️‍💥</div>
            <div className="text-[14px] font-medium" style={{ color: "var(--text-strong)" }}>
              No transfers yet
            </div>
            <div className="text-[12px] mt-1" style={{ color: "var(--muted-2)" }}>
              Trace a suspect wallet first — its on-chain transfers land here.
            </div>
            <button
              onClick={onGoToTrace}
              className="mt-4 rounded-xl px-4 py-2.5 text-sm font-medium text-black transition hover:opacity-90"
              style={{ background: "linear-gradient(135deg,#22c55e,#10b981)" }}
            >
              Go to Trace Wallet
            </button>
          </div>
        )}

        {/* Phone and tablet layout. Nine columns cannot fit a narrow screen — the
            table would push Value, Risk and Typology behind a sideways scroll,
            hiding the three fields that matter most. Each transfer becomes a card
            instead and the page scrolls normally. Hidden from lg up, where the
            table below takes over unchanged. */}
        {!loading && transfers.length > 0 && (
          <div className="divide-y lg:hidden" style={{ borderColor: "var(--border)" }}>
            {filtered.map((t) => {
              const p = detectPattern(t.note);
              const vasp = nodeByAddr.get(t.to_address)?.vasp_attribution;
              return (
                <div key={t.id} className="p-3.5" style={{ borderColor: "var(--border)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[11.5px] tabular-nums" style={{ color: "var(--muted)" }}>
                        {new Date(t.timestamp).toLocaleString()}
                      </span>
                      {isNew(t) && <NewChip />}
                    </span>
                    <SeverityBadge severity={rowSeverity(t)} />
                  </div>

                  <div className="mt-1.5 font-mono text-[16px] font-semibold tabular-nums" style={{ color: "var(--text-strong)" }}>
                    {formatToken(t.value, t.token_symbol)}
                    <span className="ml-2 text-[12px] font-normal" style={{ color: "var(--muted)" }}>
                      {formatUSD(t.value_usd)}
                    </span>
                  </div>

                  {/* break-all, not truncate — a full wallet handle is the point of
                      the row, so it wraps rather than getting cut. */}
                  <div className="mt-1.5 flex items-baseline gap-1.5 text-[12.5px]" style={{ color: "var(--text)" }}>
                    <span className="font-mono break-all" title={t.from_address}>{shortWallet(t.from_address)}</span>
                    <span style={{ color: "var(--muted)" }}>→</span>
                    <span className="font-mono break-all" title={t.to_address}>{shortWallet(t.to_address)}</span>
                  </div>
                  {vasp && (
                    <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
                      → {vasp.vasp_name}
                    </div>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <span
                      className="rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                      style={{ background: `${chainColor(t.chain)}22`, color: chainColor(t.chain) }}
                    >
                      {CHAINS[t.chain].short}
                    </span>
                    <span className="text-[11.5px]" style={{ color: "var(--muted-2)" }}>
                      {t.layer_type ? LAYER_LABEL[t.layer_type] : "—"} · hop {t.hop ?? "—"}
                    </span>
                    {p && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                        style={{ background: `${p.color}22`, color: p.color }}
                      >
                        {p.label}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="p-6 text-center text-[13px]" style={{ color: "var(--muted)" }}>
                No transfers match your filters
              </div>
            )}
          </div>
        )}

        {!loading && transfers.length > 0 && (
          // Bounded scroll box with a pinned header row: scrolling a long trace no
          // longer leaves you guessing which column you are reading.
          <div className="hidden overflow-auto max-h-[calc(100vh-260px)] lg:block">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 z-10">
                <tr
                  className="text-[11px] uppercase tracking-widest text-left backdrop-blur"
                  style={{ background: "var(--panel-strong)", color: "var(--muted)" }}
                >
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">Time</th>
                  <th className="px-4 py-2.5 font-medium">From</th>
                  <th className="px-4 py-2.5 font-medium">To</th>
                  <th className="px-4 py-2.5 font-medium">Chain</th>
                  <th className="px-4 py-2.5 font-medium text-right whitespace-nowrap">Value</th>
                  <th className="px-4 py-2.5 font-medium text-right">Hop</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">Layer</th>
                  <th className="px-4 py-2.5 font-medium">Risk</th>
                  <th className="px-4 py-2.5 font-medium">Typology</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
                  const vasp = nodeByAddr.get(t.to_address)?.vasp_attribution;
                  return (
                    <tr
                      key={t.id}
                      className="border-t hover:bg-[var(--hover)] transition"
                      style={{ borderColor: "var(--border)", color: "var(--text)" }}
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {/* The chip rides in the Time column rather than getting a
                            tenth column of its own — nine already fill the width,
                            and "when did this land" is exactly what it qualifies. */}
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[12px] tabular-nums">
                            {new Date(t.timestamp).toLocaleString()}
                          </span>
                          {isNew(t) && <NewChip />}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[12px] whitespace-nowrap" title={t.from_address}>
                        {shortWallet(t.from_address)}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="font-mono text-[12px] whitespace-nowrap" title={t.to_address}>
                          {shortWallet(t.to_address)}
                        </div>
                        {vasp && (
                          <div className="text-[10.5px]" style={{ color: "var(--muted)" }}>
                            {vasp.vasp_name}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className="inline-block rounded px-1.5 py-0.5 text-[10.5px] font-medium whitespace-nowrap"
                          style={{ background: `${chainColor(t.chain)}22`, color: chainColor(t.chain) }}
                        >
                          {CHAINS[t.chain].short}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono whitespace-nowrap tabular-nums">
                        <div style={{ color: "var(--text-strong)" }}>{formatToken(t.value, t.token_symbol)}</div>
                        <div className="text-[11px]" style={{ color: "var(--muted)" }}>{formatUSD(t.value_usd)}</div>
                      </td>
                      <td className="px-4 py-2.5 text-right text-[12px] tabular-nums" style={{ color: "var(--muted)" }}>
                        {t.hop ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] whitespace-nowrap" style={{ color: "var(--muted)" }}>
                        {t.layer_type ? LAYER_LABEL[t.layer_type] : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <SeverityBadge severity={rowSeverity(t)} />
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="p-6 text-center text-[13px]" style={{ color: "var(--muted)" }}>
                No transfers match your filters
              </div>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
