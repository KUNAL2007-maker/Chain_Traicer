"use client";

import { useMemo, useState } from "react";
import { Page, PanelHeader } from "../ui/Page";
import {
  detectChain,
  CHAINS,
  chainColor,
  shortWallet,
  formatUSD,
  formatINR,
  severityColor,
  type Chain,
  type TraceResult,
} from "@/lib/domain";
import { buildEvidence, type CryptoEvidence } from "@/lib/investigation";
import { useTraceStore, useTraceHistory } from "@/lib/store";

// A demo seed to prefill the box so the address format is obvious even before
// "Load demo case" is clicked. The mock tracer ignores the exact value.
const DEMO_SEED = "0x9F2a7c4b1E5d38A6c0B4e21f7D8a9C3b0E1f2A6d";

const LAYER_LABEL: Record<string, string> = {
  VICTIM_ENTRY: "Victim entry",
  BURNER_MULE: "Burner mule",
  PEELING_CHAIN: "Peel chain",
  BRIDGE_HOP: "Bridge hop",
  VASP_DEPOSIT: "Exchange deposit",
  VASP_HOT_WALLET: "Exchange hot wallet",
};

export function TraceWalletView({ onDone }: { onDone: () => void }) {
  const {
    status,
    error,
    traceNote,
    trace,
    evidence,
    caseMeta,
    runTrace,
    loadDemo,
    clearTrace,
    setCaseMeta,
  } = useTraceStore();
  const { traces } = useTraceHistory();

  const [tab, setTab] = useState<"trace" | "history">("trace");
  const [seed, setSeed] = useState(DEMO_SEED);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batch, setBatch] = useState("");

  const tracing = status === "tracing";
  const detected = useMemo(() => detectChain(seed.trim()), [seed]);

  // Parse the batch box into candidate addresses with their detected chain, so a
  // case with several victim-reported wallets can be worked one at a time.
  const batchRows = useMemo(() => {
    return batch
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 40)
      .map((address) => ({ address, chain: detectChain(address) }));
  }, [batch]);

  const doTrace = (addr: string) => {
    const s = addr.trim();
    if (!s) return;
    setSeed(s);
    void runTrace(s);
  };

  return (
    <Page width="wide">
      {/* Tab switch — same segmented control as the rest of the console. */}
      <div
        className="mb-4 inline-flex h-9 items-center rounded-lg border p-1 gap-1"
        style={{ borderColor: "var(--border)", background: "var(--chip)" }}
      >
        {(
          [
            ["trace", "New trace"],
            ["history", traces.length ? `History · ${traces.length}` : "History"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className="rounded-md px-3.5 py-1 text-[12.5px] font-medium whitespace-nowrap transition"
            style={
              tab === key
                ? { background: "var(--panel)", color: "var(--text-strong)", boxShadow: "0 1px 0 rgba(0,0,0,.25)" }
                : { color: "var(--muted-2)" }
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "history" ? (
        <TraceHistory traces={traces} />
      ) : (
        <div
          className="max-w-5xl rounded-2xl p-4 sm:p-6 border space-y-5"
          style={{ background: "var(--panel)", borderColor: "var(--border)" }}
        >
          {/* Seed a trace */}
          <div>
            <PanelHeader
              eyebrow="Victim-reported wallet"
              title="Trace a suspect crypto address across chains"
              right={
                evidence ? (
                  <span
                    className="text-[11px] px-2 py-1 rounded-full border"
                    style={{
                      borderColor: "var(--border)",
                      color: evidence.source === "live" ? "#22c55e" : "var(--muted)",
                    }}
                  >
                    {evidence.source === "live" ? "● live trace" : "● demo dataset"}
                  </span>
                ) : undefined
              }
            />
            <div className="mt-4 flex flex-col lg:flex-row gap-2.5">
              <div className="flex-1 relative">
                <input
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !tracing && doTrace(seed)}
                  spellCheck={false}
                  placeholder="Paste a wallet address — 0x… (ETH/Polygon), T… (TRON), bc1…/1…/3… (BTC)"
                  className="w-full rounded-xl px-3.5 py-2.5 text-sm outline-none font-mono"
                  style={{
                    background: "var(--panel-2)",
                    border: "1px solid var(--border)",
                    color: "var(--text-strong)",
                  }}
                />
                {seed.trim() && (
                  <span
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] px-1.5 py-0.5 rounded-md"
                    style={{
                      background: detected ? `${chainColor(detected)}22` : "transparent",
                      color: detected ? chainColor(detected) : "var(--muted)",
                    }}
                  >
                    {detected ? CHAINS[detected].name : "unrecognised shape"}
                  </span>
                )}
              </div>
              <div className="flex gap-2.5">
                <button
                  onClick={() => doTrace(seed)}
                  disabled={tracing || !seed.trim()}
                  className="rounded-xl px-4 py-2.5 text-sm font-medium text-black disabled:opacity-50 transition"
                  style={{ background: "linear-gradient(135deg,#22c55e,#10b981)" }}
                >
                  {tracing ? "Tracing…" : "Run trace"}
                </button>
                <button
                  onClick={() => loadDemo()}
                  disabled={tracing}
                  className="rounded-xl px-4 py-2.5 text-sm font-medium border disabled:opacity-50 transition hover:opacity-80"
                  style={{ borderColor: "var(--border)", color: "var(--text-strong)" }}
                >
                  Load demo case
                </button>
              </div>
            </div>

            {error && (
              <p className="mt-3 text-[12px]" style={{ color: "#ef4444" }}>
                {error}
              </p>
            )}
            {traceNote && (
              <p
                className="mt-3 text-[12px] rounded-lg px-3 py-2 whitespace-pre-line leading-relaxed"
                style={{ background: "rgba(245,158,11,0.10)", color: "#f59e0b" }}
              >
                {traceNote}
              </p>
            )}

            {/* Batch paste — multiple victim-reported wallets for one case. */}
            <button
              onClick={() => setBatchOpen((v) => !v)}
              className="mt-3 text-[12px] transition hover:opacity-80"
              style={{ color: "var(--muted)" }}
            >
              {batchOpen ? "− Hide batch import" : "+ Paste a batch of reported wallets"}
            </button>
            {batchOpen && (
              <div className="mt-2.5 rounded-xl border p-3" style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}>
                <textarea
                  value={batch}
                  onChange={(e) => setBatch(e.target.value)}
                  spellCheck={false}
                  rows={3}
                  placeholder="One wallet per line (or comma-separated). Each is traced individually."
                  className="w-full rounded-lg px-3 py-2 text-[12.5px] outline-none font-mono resize-y"
                  style={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text-strong)" }}
                />
                {batchRows.length > 0 && (
                  <div className="mt-2.5 space-y-1.5">
                    {batchRows.map((r, i) => (
                      <div
                        key={`${r.address}-${i}`}
                        className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
                        style={{ background: "var(--panel)", border: "1px solid var(--border)" }}
                      >
                        <span className="min-w-0 flex items-center gap-2">
                          <span className="font-mono text-[11.5px] truncate" style={{ color: "var(--text)" }}>
                            {r.address}
                          </span>
                          <span
                            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded"
                            style={{
                              background: r.chain ? `${chainColor(r.chain)}22` : "transparent",
                              color: r.chain ? chainColor(r.chain) : "var(--muted)",
                            }}
                          >
                            {r.chain ? CHAINS[r.chain].short : "?"}
                          </span>
                        </span>
                        <button
                          onClick={() => doTrace(r.address)}
                          disabled={tracing}
                          className="shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium border disabled:opacity-50 transition hover:opacity-80"
                          style={{ borderColor: "var(--border)", color: "var(--text-strong)" }}
                        >
                          Trace
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="h-px" style={{ background: "var(--border)" }} />

          {/* Case metadata — feeds the Section 91 notice. */}
          <div>
            <PanelHeader
              eyebrow="NCRP / 1930 complaint"
              title="Link this trace to a case (optional)"
            />
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Field
                label="NCRP acknowledgement no."
                value={caseMeta.ncrp_ack_no ?? ""}
                onChange={(v) => setCaseMeta({ ncrp_ack_no: v })}
                placeholder="e.g. 21902450000123"
              />
              <Field
                label="Victim name"
                value={caseMeta.victim_name ?? ""}
                onChange={(v) => setCaseMeta({ victim_name: v })}
                placeholder="As on the complaint"
              />
              <Field
                label="Amount lost (INR)"
                value={caseMeta.amount_lost_inr != null ? String(caseMeta.amount_lost_inr) : ""}
                onChange={(v) => {
                  const n = Number(v.replace(/[,\s₹]/g, ""));
                  setCaseMeta({ amount_lost_inr: v.trim() && Number.isFinite(n) ? n : undefined });
                }}
                placeholder="e.g. 4200000"
                mono
              />
              <Field
                label="Reported on"
                value={caseMeta.reported_on ?? ""}
                onChange={(v) => setCaseMeta({ reported_on: v })}
                placeholder="YYYY-MM-DD"
                mono
              />
              <Field
                label="Jurisdiction / police station"
                value={caseMeta.jurisdiction_ps ?? ""}
                onChange={(v) => setCaseMeta({ jurisdiction_ps: v })}
                placeholder="e.g. Cyber PS, Pune City"
              />
              <Field
                label="Investigating officer"
                value={caseMeta.io_name ?? ""}
                onChange={(v) => setCaseMeta({ io_name: v })}
                placeholder="Name & rank"
              />
            </div>
            <p className="mt-2.5 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
              These details are quoted verbatim on any Section 91 CrPC / Section 94 BNSS notice you generate.
            </p>
          </div>

          {/* Success summary */}
          {status === "ready" && trace && evidence && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
              <div className="flex items-center gap-2">
                <span className="text-2xl">✓</span>
                <div className="text-[15px] font-semibold text-emerald-200">
                  Traced {shortWallet(trace.seed)} · {evidence.hops} hop{evidence.hops === 1 ? "" : "s"} across{" "}
                  {evidence.chains.length} chain{evidence.chains.length === 1 ? "" : "s"}
                </div>
              </div>
              <div className="mt-1.5 text-[12.5px] text-emerald-300/80">
                {evidence.walletCount} wallets · {evidence.txCount} transfers · {formatUSD(evidence.totalUsd)} traced ·{" "}
                {evidence.track.overall === "DUAL" ? "Dual-track" : `Track ${evidence.track.overall}`} freeze decision
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={onDone}
                  className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 px-4 py-2 text-[13px] font-medium transition"
                >
                  Go to dashboard →
                </button>
                <button
                  onClick={() => {
                    clearTrace();
                    setSeed("");
                  }}
                  className="rounded-lg border px-4 py-2 text-[13px] font-medium transition hover:bg-[var(--hover)]"
                  style={{ borderColor: "var(--border)", color: "var(--text)", background: "var(--chip)" }}
                >
                  Trace another
                </button>
                <button
                  onClick={() => setTab("history")}
                  className="rounded-lg border px-4 py-2 text-[13px] font-medium transition hover:bg-[var(--hover)]"
                  style={{ borderColor: "var(--border)", color: "var(--text)", background: "var(--chip)" }}
                >
                  View history
                </button>
              </div>
            </div>
          )}

          <div className="pt-1 text-[12px]" style={{ color: "var(--muted-2)" }}>
            The tracer walks the money outward hop by hop, attributes the wallets it reaches to
            exchanges and mixers, and decides where a freeze notice can be served. No configuration
            needed — the demo case runs offline.
          </div>
        </div>
      )}
    </Page>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-[10.5px] uppercase tracking-widest mb-1.5" style={{ color: "var(--muted)" }}>
        {label}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={`w-full rounded-lg px-3 py-2 text-[13px] outline-none ${mono ? "font-mono" : ""}`}
        style={{ background: "var(--panel-2)", border: "1px solid var(--border)", color: "var(--text-strong)" }}
      />
    </label>
  );
}

// ── History tab: session traces + per-trace analytics ────────────────────────

type TraceMeta = { trace: TraceResult; key: string; time: string };

function TraceHistory({ traces }: { traces: TraceResult[] }) {
  const items: TraceMeta[] = useMemo(
    () =>
      traces.map((t, i) => ({
        trace: t,
        key: `${t.seed}-${t.generatedAt ?? i}`,
        time: t.generatedAt ? new Date(t.generatedAt).toLocaleString() : "this session",
      })),
    [traces]
  );

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active = items.find((i) => i.key === activeKey) ?? items[0] ?? null;

  if (!traces.length) {
    return (
      <div
        className="rounded-xl border p-10 text-center"
        style={{ borderColor: "var(--border)", background: "var(--chip)" }}
      >
        <div className="text-3xl mb-2">🗂️</div>
        <div className="text-[14px] font-medium" style={{ color: "var(--text-strong)" }}>
          No traces yet
        </div>
        <div className="text-[12.5px] mt-1" style={{ color: "var(--muted-2)" }}>
          Every wallet you trace this session is kept here so you can revisit its analysis.
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <div
        className="rounded-xl border overflow-hidden self-start"
        style={{ borderColor: "var(--border)", background: "var(--chip)" }}
      >
        <div
          className="px-3 py-2.5 border-b text-[11px] uppercase tracking-widest"
          style={{ borderColor: "var(--border)", color: "var(--muted)" }}
        >
          {traces.length} trace{traces.length === 1 ? "" : "s"}
        </div>
        <div className="max-h-[560px] overflow-auto">
          {items.map((it) => {
            const isActive = active?.key === it.key;
            return (
              <button
                key={it.key}
                onClick={() => setActiveKey(it.key)}
                className="w-full text-left px-3 py-2.5 border-b transition hover:bg-[var(--hover)]"
                style={{
                  borderColor: "var(--border)",
                  background: isActive ? "var(--hover)" : "transparent",
                  boxShadow: isActive ? "inset 2px 0 0 var(--accent, #34d399)" : "none",
                }}
              >
                <div
                  className="text-[12.5px] font-mono font-medium truncate"
                  style={{ color: isActive ? "var(--text-strong)" : "var(--text)" }}
                >
                  {shortWallet(it.trace.seed)}
                </div>
                <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10.5px]" style={{ color: "var(--muted-2)" }}>
                    {it.time}
                  </span>
                  <span className="text-[10.5px]" style={{ color: "var(--muted-2)" }}>
                    · {it.trace.hops} hops
                  </span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: `${chainColor(it.trace.seed_chain)}18`, color: chainColor(it.trace.seed_chain) }}
                  >
                    {CHAINS[it.trace.seed_chain].short}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border p-5 min-w-0" style={{ borderColor: "var(--border)", background: "var(--chip)" }}>
        {active && <TraceAnalytics trace={active.trace} time={active.time} />}
      </div>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--border)", background: "var(--panel)" }}>
      <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
        {label}
      </div>
      <div className="mt-1 text-[16px] font-semibold tabular-nums" style={{ color: tone ?? "var(--text-strong)" }}>
        {value}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <div className="text-[10.5px] uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function RiskSplit({ bySeverity, total }: { bySeverity: CryptoEvidence["bySeverity"]; total: number }) {
  const parts = [
    { key: "high" as const, label: "High risk", n: bySeverity.high },
    { key: "medium" as const, label: "Medium", n: bySeverity.medium },
    { key: "safe" as const, label: "Normal", n: bySeverity.safe },
  ].filter((p) => p.n > 0);

  return (
    <div>
      <div className="flex h-2 rounded-full overflow-hidden" style={{ background: "var(--panel)" }}>
        {parts.map((p) => (
          <div
            key={p.key}
            title={`${p.label}: ${p.n}`}
            style={{ width: `${(p.n / Math.max(1, total)) * 100}%`, background: severityColor(p.key) }}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        {parts.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
            <i className="h-2 w-2 rounded-full" style={{ background: severityColor(p.key) }} />
            {p.label} <span className="tabular-nums" style={{ color: "var(--text)" }}>{p.n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function TraceAnalytics({ trace, time }: { trace: TraceResult; time: string }) {
  const ev = useMemo(() => buildEvidence(trace), [trace]);
  const range = ev.dateRange
    ? ev.dateRange.from === ev.dateRange.to
      ? ev.dateRange.from
      : `${ev.dateRange.from} → ${ev.dateRange.to}`
    : "—";

  return (
    <>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold font-mono truncate" style={{ color: "var(--text-strong)" }}>
            {shortWallet(ev.seed)}
          </div>
          <div className="text-[12px] mt-0.5" style={{ color: "var(--muted-2)" }}>
            {time} · {ev.source === "live" ? "live trace" : "demo dataset"}
          </div>
        </div>
        <div
          className="rounded-lg border px-2.5 py-1 text-[11px]"
          style={{
            borderColor:
              ev.track.overall === "A" ? "#22c55e55" : ev.track.overall === "DUAL" ? "#f59e0b55" : "#ef444455",
            color: ev.track.overall === "A" ? "#22c55e" : ev.track.overall === "DUAL" ? "#f59e0b" : "#ef4444",
          }}
        >
          {ev.track.overall === "DUAL" ? "Dual-track" : `Track ${ev.track.overall}`}
        </div>
      </div>

      <div className="mt-4 grid gap-2.5 grid-cols-2 xl:grid-cols-4">
        <Tile label="Transfers" value={String(ev.txCount)} />
        <Tile label="Wallets" value={String(ev.walletCount)} />
        <Tile label="Value traced" value={formatUSD(ev.totalUsd)} />
        <Tile
          label="High-risk exposure"
          value={formatUSD(ev.highExposureUsd)}
          tone={ev.highExposureUsd > 0 ? severityColor("high") : undefined}
        />
      </div>

      <Section title="Risk split (wallets)">
        <RiskSplit bySeverity={ev.bySeverity} total={ev.walletCount} />
      </Section>

      <Section title="Typologies detected">
        {ev.typologies.length ? (
          <div className="flex flex-wrap gap-2">
            {ev.typologies.map((t) => (
              <span
                key={t.code}
                className="rounded-lg border px-2.5 py-1.5 text-[11.5px]"
                style={{ borderColor: "var(--border)", background: "var(--panel)", color: "var(--text)" }}
              >
                {t.label}
                <span className="ml-1.5" style={{ color: "var(--muted-2)" }}>
                  {t.count} · {formatUSD(t.amount)}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <div className="text-[12.5px]" style={{ color: "var(--muted-2)" }}>
            No named laundering pattern on this trail.
          </div>
        )}
      </Section>

      <Section title="Coverage">
        <div className="grid gap-2.5 sm:grid-cols-3">
          <div className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--border)", background: "var(--panel)" }}>
            <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Date range</div>
            <div className="mt-1 text-[12.5px] font-mono" style={{ color: "var(--text)" }}>{range}</div>
          </div>
          <div className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--border)", background: "var(--panel)" }}>
            <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Chains</div>
            <div className="mt-1 text-[12.5px]" style={{ color: "var(--text)" }}>
              {ev.chains.length ? ev.chains.map((c: Chain) => CHAINS[c].short).join(", ") : "—"}
            </div>
          </div>
          <div className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--border)", background: "var(--panel)" }}>
            <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Endpoints</div>
            <div className="mt-1 text-[12.5px]" style={{ color: "var(--text)" }}>
              {ev.vasps.length
                ? `${ev.vasps.filter((v) => !v.is_mixer).length} exchange${ev.vasps.filter((v) => !v.is_mixer).length === 1 ? "" : "s"}${ev.mixersTouched.length ? ` · ${ev.mixersTouched.length} mixer` : ""}`
                : "—"}
            </div>
          </div>
        </div>
      </Section>

      {ev.topWallets.length > 0 && (
        <Section title="Most active wallets">
          <div className="rounded-lg border overflow-hidden" style={{ borderColor: "var(--border)" }}>
            <div
              className="grid grid-cols-[minmax(0,1fr)_88px_88px] px-3 py-1.5 text-[10.5px] uppercase tracking-widest border-b"
              style={{ background: "var(--panel)", borderColor: "var(--border)", color: "var(--muted)" }}
            >
              <div>Wallet</div>
              <div className="text-right">In</div>
              <div className="text-right">Out</div>
            </div>
            {ev.topWallets.slice(0, 5).map((a) => (
              <div
                key={a.address}
                className="grid grid-cols-[minmax(0,1fr)_88px_88px] px-3 py-2 text-[12px] border-b last:border-b-0"
                style={{ borderColor: "var(--border)", color: "var(--text)" }}
              >
                <div className="truncate font-mono text-[11.5px]">
                  {shortWallet(a.address)}
                  {a.vasp ? <span style={{ color: "var(--muted-2)" }}> · {a.vasp}</span> : ""}
                </div>
                <div className="text-right font-mono text-[11.5px]">{formatUSD(a.inUsd)}</div>
                <div className="text-right font-mono text-[11.5px]">{formatUSD(a.outUsd)}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {ev.findings.length > 0 && (
        <Section title="What the analysis found">
          <ul className="space-y-1.5">
            {ev.findings.slice(0, 4).map((f) => (
              <li key={f.code} className="flex gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
                <i
                  className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ background: f.severity === "high" ? severityColor("high") : f.severity === "medium" ? severityColor("medium") : "var(--muted)" }}
                />
                <span>{f.short || f.title}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {ev.case?.ncrp_ack_no && (
        <div className="mt-5 rounded-lg border px-3 py-2.5 text-[12px]" style={{ borderColor: "var(--border)", background: "var(--panel)", color: "var(--muted-2)" }}>
          Linked case — NCRP {ev.case.ncrp_ack_no}
          {ev.case.reported_on ? `, reported ${ev.case.reported_on}` : ""}
          {ev.case.amount_lost_inr ? `, loss ${formatINR(ev.case.amount_lost_inr)}` : ""}
          {ev.case.jurisdiction_ps ? ` · ${ev.case.jurisdiction_ps}` : ""}.
        </div>
      )}
    </>
  );
}
