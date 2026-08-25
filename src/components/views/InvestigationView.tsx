"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Page, PanelHeader } from "@/components/ui/Page";
import { MetricCard } from "@/components/ui/MetricCard";
import { SeverityBadge } from "@/components/ui/SeverityBadge";
import {
  buildGraphFromTransfers,
  nodeRadius,
  severityColor,
  chainColor,
  detectChain,
  CHAINS,
  AGENT_META,
  formatUSD,
  formatINR,
  shortWallet,
  type TraceResult,
  type Severity,
  type Chain,
  type ChatAgent,
  type LayerType,
} from "@/lib/domain";
import {
  buildEvidence,
  section91Notice,
  type LegalNotice,
  type VaspHit,
  type TrackDecision,
} from "@/lib/investigation";

// ── Chat response shapes (mirror /api/chat) ─────────────────────────────────
type AgentPanel = {
  agent: string;
  headline?: string;
  content: string;
  findings?: string[];
  confidence?: number;
};
type Verdict = { level: Severity; headline: string; points: string[]; accounts: string[] };
type InvestigateResponse = {
  mode: "investigate";
  agents: AgentPanel[];
  verdict: Verdict;
  suggestions: string[];
  track: TrackDecision;
  degraded?: string;
  model?: string;
  cached?: boolean;
};
type CasualResponse = {
  mode: "casual";
  reply: string;
  suggestions?: string[];
  degraded?: string;
  model?: string;
};
type ErrorResponse = { error: string; retryAfter?: number };
type ChatResponse = InvestigateResponse | CasualResponse | ErrorResponse;

const GRAPH_W = 1180;

// A demo seed to prefill the box so the address format is obvious even before
// "Load demo case" is clicked. The mock tracer ignores the exact value.
const DEMO_SEED = "0x9F2a7c4b1E5d38A6c0B4e21f7D8a9C3b0E1f2A6d";

// A one-character glyph per pipeline layer, drawn inside the node.
const LAYER_GLYPH: Record<LayerType, string> = {
  VICTIM_ENTRY: "V",
  BURNER_MULE: "M",
  PEELING_CHAIN: "P",
  BRIDGE_HOP: "⇄",
  VASP_DEPOSIT: "⬇",
  VASP_HOT_WALLET: "★",
};
const LAYER_LABEL: Record<LayerType, string> = {
  VICTIM_ENTRY: "Victim entry",
  BURNER_MULE: "Burner mule",
  PEELING_CHAIN: "Peel chain",
  BRIDGE_HOP: "Bridge hop",
  VASP_DEPOSIT: "Exchange deposit",
  VASP_HOT_WALLET: "Exchange hot wallet",
};

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

export function InvestigationView() {
  const [seed, setSeed] = useState(DEMO_SEED);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [tracing, setTracing] = useState(false);
  const [traceErr, setTraceErr] = useState<string | null>(null);

  // The whole forensic engine runs in the browser from the trace — findings,
  // dual-track decision and the graph layout all recompute when the trace does.
  const evidence = useMemo(() => (trace ? buildEvidence(trace) : null), [trace]);
  const graph = useMemo(
    () => (trace ? buildGraphFromTransfers(trace.nodes, trace.transfers, GRAPH_W) : null),
    [trace]
  );

  const [notice, setNotice] = useState<LegalNotice | null>(null);

  // The I4C assistant.
  const [report, setReport] = useState<InvestigateResponse | null>(null);
  const [reporting, setReporting] = useState(false);
  const [chat, setChat] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [chatNote, setChatNote] = useState<string | null>(null);

  const runTrace = useCallback(async (demo: boolean) => {
    setTracing(true);
    setTraceErr(null);
    setNotice(null);
    setReport(null);
    setChat([]);
    setChatNote(null);
    try {
      const body = demo ? { demo: true, seed: seed.trim() || undefined } : { seed: seed.trim() };
      const data = await postJSON<TraceResult>("/api/trace", body);
      setTrace(data);
    } catch {
      setTraceErr("Couldn't reach the tracer. Check the dev server and try again.");
    } finally {
      setTracing(false);
    }
  }, [seed]);

  const runInvestigation = useCallback(async () => {
    if (!trace) return;
    setReporting(true);
    setChatNote(null);
    try {
      const data = await postJSON<ChatResponse>("/api/chat", {
        message: "Run a full forensic investigation of this wallet trace.",
        mode: "investigate",
        context: trace,
      });
      if ("error" in data) {
        setChatNote(data.error);
      } else if (data.mode === "investigate") {
        setReport(data);
        if (data.degraded) setChatNote(data.degraded);
      }
    } catch {
      setChatNote("The assistant is unreachable right now.");
    } finally {
      setReporting(false);
    }
  }, [trace]);

  const ask = useCallback(
    async (q: string) => {
      const query = q.trim();
      if (!query || !trace) return;
      setQuestion("");
      setAsking(true);
      setChatNote(null);
      const history = chat.map((m) => ({ role: m.role, content: m.content }));
      setChat((c) => [...c, { role: "user", content: query }]);
      try {
        const data = await postJSON<ChatResponse>("/api/chat", {
          message: query,
          mode: "casual",
          context: trace,
          history,
        });
        if ("error" in data) {
          setChat((c) => [...c, { role: "assistant", content: data.error }]);
        } else if (data.mode === "casual") {
          setChat((c) => [...c, { role: "assistant", content: data.reply }]);
          if (data.degraded) setChatNote(data.degraded);
        }
      } catch {
        setChat((c) => [...c, { role: "assistant", content: "The assistant is unreachable right now." }]);
      } finally {
        setAsking(false);
      }
    },
    [trace, chat]
  );

  const detected = useMemo(() => detectChain(seed.trim()), [seed]);
  const serviceable = evidence?.vasps.filter((v) => !v.is_mixer) ?? [];

  return (
    <Page width="wide" className="space-y-5">
      {/* Search */}
      <section className="glass rounded-2xl p-4 sm:p-5">
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
              onKeyDown={(e) => e.key === "Enter" && !tracing && runTrace(false)}
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
              onClick={() => runTrace(false)}
              disabled={tracing || !seed.trim()}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-black disabled:opacity-50 transition"
              style={{ background: "linear-gradient(135deg,#22c55e,#10b981)" }}
            >
              {tracing ? "Tracing…" : "Trace wallet"}
            </button>
            <button
              onClick={() => runTrace(true)}
              disabled={tracing}
              className="rounded-xl px-4 py-2.5 text-sm font-medium border disabled:opacity-50 transition hover:opacity-80"
              style={{ borderColor: "var(--border)", color: "var(--text-strong)" }}
            >
              Load demo case
            </button>
          </div>
        </div>
        {traceErr && (
          <p className="mt-3 text-[12px]" style={{ color: "#ef4444" }}>
            {traceErr}
          </p>
        )}
        {evidence?.case?.ncrp_ack_no && (
          <p className="mt-3 text-[12px]" style={{ color: "var(--muted)" }}>
            Linked case — NCRP {evidence.case.ncrp_ack_no}
            {evidence.case.reported_on ? `, reported ${evidence.case.reported_on}` : ""}
            {evidence.case.amount_lost_inr ? `, loss ${formatINR(evidence.case.amount_lost_inr)}` : ""}
            {evidence.case.jurisdiction_ps ? ` · ${evidence.case.jurisdiction_ps}` : ""}.
          </p>
        )}
      </section>

      {!evidence && !tracing && (
        <section className="glass rounded-2xl p-8 text-center">
          <div className="text-3xl mb-2">⛓️‍💥</div>
          <p className="text-sm" style={{ color: "var(--text-strong)" }}>
            Paste a victim-reported wallet address, or load the demo case.
          </p>
          <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
            The tracer walks the money outward hop by hop, attributes the wallets it
            reaches to exchanges and mixers, and decides where a freeze notice can go.
          </p>
        </section>
      )}

      {evidence && (
        <>
          {/* KPI row */}
          <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <MetricCard
              label="Hops traced"
              value={String(evidence.hops)}
              sub={`${evidence.chains.length} chain${evidence.chains.length === 1 ? "" : "s"}`}
              accent="#38bdf8"
              icon="⛓"
            />
            <MetricCard
              label="Wallets"
              value={String(evidence.walletCount)}
              sub={`${evidence.txCount} transfers`}
              accent="#a78bfa"
              icon="◈"
            />
            <MetricCard
              label="Value traced"
              value={formatUSD(evidence.totalUsd)}
              sub={`${formatUSD(evidence.highExposureUsd)} high-risk exposure`}
              accent="#22c55e"
              icon="$"
            />
            <MetricCard
              label="High-risk wallets"
              value={String(evidence.bySeverity.high)}
              sub={`${evidence.bySeverity.medium} medium · ${evidence.bySeverity.safe} low`}
              accent="#ef4444"
              icon="⚠"
            />
            <MetricCard
              label="Exchanges reached"
              value={String(serviceable.length)}
              sub={
                evidence.mixersTouched.length
                  ? `+${evidence.mixersTouched.length} mixer`
                  : evidence.bridgesUsed
                  ? "trail crosses a bridge"
                  : "serviceable endpoints"
              }
              accent="#f59e0b"
              icon="△"
            />
            <MetricCard
              label="Freeze track"
              value={
                evidence.track.overall === "DUAL" ? "Dual" : `Track ${evidence.track.overall}`
              }
              sub={
                evidence.track.overall === "A"
                  ? "express auto-freeze"
                  : evidence.track.overall === "B"
                  ? "officer review"
                  : "express + review"
              }
              accent={
                evidence.track.overall === "A"
                  ? "#22c55e"
                  : evidence.track.overall === "DUAL"
                  ? "#f59e0b"
                  : "#ef4444"
              }
              icon="◉"
            />
          </section>

          {/* Dual-track banner */}
          <TrackBanner track={evidence.track} />

          {/* Hop-trail graph */}
          {graph && (
            <section className="glass rounded-2xl p-4 sm:p-5">
              <PanelHeader
                eyebrow="Money flow"
                title="Multi-hop wallet trail"
                right={<GraphLegend chains={graph.chains} />}
              />
              <div className="mt-3 overflow-x-auto">
                <HopTrail graph={graph} />
              </div>
            </section>
          )}

          {/* Findings */}
          <section className="glass rounded-2xl p-4 sm:p-5">
            <PanelHeader
              eyebrow="Forensic findings"
              title={`${evidence.findings.length} typolog${
                evidence.findings.length === 1 ? "y" : "ies"
              } detected`}
            />
            <div className="mt-4 space-y-2.5">
              {evidence.findings.length === 0 && (
                <p className="text-[13px]" style={{ color: "var(--muted)" }}>
                  No laundering typology fired on this trail — the transfers look routine.
                </p>
              )}
              {evidence.findings.map((f, i) => (
                <FindingRow key={`${f.code}-${i}`} finding={f} />
              ))}
            </div>
          </section>

          {/* Endpoints / VASP attribution */}
          {evidence.vasps.length > 0 && (
            <section className="glass rounded-2xl p-4 sm:p-5">
              <PanelHeader
                eyebrow="Attributed endpoints"
                title="Exchanges & mixers the funds reached"
              />
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {evidence.vasps.map((v) => (
                  <VaspCard
                    key={v.vasp_name}
                    vasp={v}
                    onNotice={
                      v.is_mixer
                        ? undefined
                        : () => setNotice(section91Notice(evidence, evidence.case, v.vasp_name))
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {/* I4C assistant */}
          <section className="glass rounded-2xl p-4 sm:p-5">
            <PanelHeader
              eyebrow="I4C assistant"
              title="Explain, attribute and decide — grounded in this trace"
              right={
                <button
                  onClick={runInvestigation}
                  disabled={reporting}
                  className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-black disabled:opacity-50 transition"
                  style={{ background: "linear-gradient(135deg,#22c55e,#10b981)" }}
                >
                  {reporting ? "Analysing…" : "Run full investigation"}
                </button>
              }
            />

            {chatNote && (
              <p
                className="mt-3 text-[12px] rounded-lg px-3 py-2"
                style={{ background: "rgba(245,158,11,0.10)", color: "#f59e0b" }}
              >
                {chatNote}
              </p>
            )}

            {report && (
              <div className="mt-4 space-y-3">
                <VerdictBanner verdict={report.verdict} model={report.model} cached={report.cached} />
                <div className="grid gap-3 lg:grid-cols-2">
                  {report.agents.map((a, i) => (
                    <AgentCard key={`${a.agent}-${i}`} panel={a} />
                  ))}
                </div>
              </div>
            )}

            {/* Chat thread */}
            {chat.length > 0 && (
              <div className="mt-4 space-y-2.5">
                {chat.map((m, i) => (
                  <div
                    key={i}
                    className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                      m.role === "user" ? "ml-auto" : ""
                    }`}
                    style={{
                      background: m.role === "user" ? "rgba(34,197,94,0.12)" : "var(--panel-2)",
                      color: "var(--text)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    {m.content}
                  </div>
                ))}
                {asking && (
                  <div className="text-[12px]" style={{ color: "var(--muted)" }}>
                    Thinking…
                  </div>
                )}
              </div>
            )}

            {/* Suggestions */}
            {(report?.suggestions?.length || !chat.length) && (
              <div className="mt-4 flex flex-wrap gap-2">
                {(report?.suggestions ?? [
                  serviceable[0] ? `Why should we freeze ${serviceable[0].vasp_name}?` : "Explain this wallet trail in simple words",
                  "What laws let us freeze these funds?",
                  evidence.mixersTouched.length ? "Did the money touch a mixer?" : "Which exchange do we serve first?",
                ]).map((s) => (
                  <button
                    key={s}
                    onClick={() => ask(s)}
                    disabled={asking}
                    className="text-[12px] px-2.5 py-1.5 rounded-full border disabled:opacity-50 transition hover:opacity-80"
                    style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* Ask box */}
            <div className="mt-3 flex gap-2.5">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !asking && ask(question)}
                placeholder="Ask the assistant about this case…"
                className="flex-1 rounded-xl px-3.5 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--panel-2)",
                  border: "1px solid var(--border)",
                  color: "var(--text-strong)",
                }}
              />
              <button
                onClick={() => ask(question)}
                disabled={asking || !question.trim()}
                className="rounded-xl px-4 py-2.5 text-sm font-medium border disabled:opacity-50 transition hover:opacity-80"
                style={{ borderColor: "var(--border)", color: "var(--text-strong)" }}
              >
                Ask
              </button>
            </div>
          </section>
        </>
      )}

      {notice && <NoticeModal notice={notice} onClose={() => setNotice(null)} />}
    </Page>
  );
}

// ── Dual-track banner ────────────────────────────────────────────────────────
function TrackBanner({ track }: { track: TrackDecision }) {
  const accent =
    track.overall === "A" ? "#22c55e" : track.overall === "DUAL" ? "#f59e0b" : "#ef4444";
  return (
    <section
      className="rounded-2xl p-4 sm:p-5"
      style={{ background: `${accent}0f`, border: `1px solid ${accent}44` }}
    >
      <div className="flex items-start gap-3">
        <div
          className="grid place-items-center w-9 h-9 rounded-xl shrink-0 font-bold"
          style={{ background: `${accent}22`, color: accent }}
        >
          {track.overall === "DUAL" ? "⚖" : track.overall}
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold" style={{ color: "var(--text-strong)" }}>
            {track.headline}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
            {track.summary}
          </p>
          {track.assessments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {track.assessments.map((a) => {
                const c = a.track === "A" ? "#22c55e" : "#f59e0b";
                return (
                  <span
                    key={a.target.vasp_name}
                    className="text-[11px] px-2.5 py-1 rounded-full border"
                    style={{ borderColor: `${c}55`, background: `${c}14`, color: c }}
                  >
                    {a.target.vasp_name} · Track {a.track} · {a.confidence}%
                    {a.autoFreeze ? " · auto-freeze" : " · review"}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ── Graph ────────────────────────────────────────────────────────────────────
function GraphLegend({ chains }: { chains: Chain[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 justify-end">
      {chains.map((c) => (
        <span key={c} className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
          <span className="w-2 h-2 rounded-full" style={{ background: chainColor(c) }} />
          {CHAINS[c].name}
        </span>
      ))}
    </div>
  );
}

function HopTrail({ graph }: { graph: ReturnType<typeof buildGraphFromTransfers> }) {
  const nodeById = useMemo(() => {
    const m = new Map<string, (typeof graph.nodes)[number]>();
    graph.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [graph]);

  const markerIds: Record<Severity, string> = { high: "arrow-high", medium: "arrow-medium", safe: "arrow-safe" };

  return (
    <svg
      viewBox={`0 0 ${GRAPH_W} ${graph.height}`}
      width="100%"
      style={{ minWidth: 720, height: "auto", display: "block" }}
      preserveAspectRatio="xMidYMin meet"
    >
      <defs>
        {(["high", "medium", "safe"] as Severity[]).map((s) => (
          <marker
            key={s}
            id={markerIds[s]}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill={severityColor(s)} />
          </marker>
        ))}
      </defs>

      {/* Cluster regions */}
      {graph.clusters.map((cl) => (
        <g key={cl.id}>
          <rect
            x={cl.x}
            y={cl.y}
            width={cl.w}
            height={cl.h}
            rx={14}
            fill={`${cl.color}0a`}
            stroke={`${cl.color}44`}
            strokeDasharray="4 4"
          />
          <text x={cl.x + 14} y={cl.y + 20} fontSize={12} fontWeight={600} fill={cl.color}>
            {cl.label}
          </text>
          <text x={cl.x + 14} y={cl.y + 36} fontSize={10.5} fill="#94a3b8">
            {cl.count} wallets · {formatUSD(cl.total)}
          </text>
        </g>
      ))}

      {/* Edges */}
      {graph.edges.map((e) => {
        const s = nodeById.get(e.source);
        const t = nodeById.get(e.target);
        if (!s || !t || s.id === t.id) return null;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const sr = nodeRadius(s.degree ?? 1) + 2;
        const tr = nodeRadius(t.degree ?? 1) + 8;
        const bx = s.x + ux * sr;
        const by = s.y + uy * sr;
        const ex = t.x - ux * tr;
        const ey = t.y - uy * tr;
        const col = severityColor(e.severity);
        return (
          <g key={e.id}>
            <line
              x1={bx}
              y1={by}
              x2={ex}
              y2={ey}
              stroke={col}
              strokeWidth={e.severity === "high" ? 2 : 1.4}
              strokeOpacity={0.55}
              markerEnd={`url(#${markerIds[e.severity]})`}
            />
            {e.amount > 0 && (
              <text
                x={(bx + ex) / 2}
                y={(by + ey) / 2 - 3}
                fontSize={9}
                textAnchor="middle"
                fill="#cbd5e1"
                stroke="#0b0f16"
                strokeWidth={2.4}
                paintOrder="stroke"
              >
                {formatUSD(e.amount)}
              </text>
            )}
          </g>
        );
      })}

      {/* Nodes */}
      {graph.nodes.map((n) => {
        const r = nodeRadius(n.degree ?? 1);
        const col = severityColor(n.severity);
        const isVasp = !!n.vasp;
        return (
          <g key={n.id}>
            <title>
              {`${LAYER_LABEL[n.layer_type]} · ${n.address}${n.vasp ? ` · ${n.vasp}` : ""}`}
            </title>
            {/* chain ring */}
            <circle cx={n.x} cy={n.y} r={r + 3} fill="none" stroke={chainColor(n.chain)} strokeWidth={1.5} strokeOpacity={0.5} />
            {/* freeze-target halo */}
            {isVasp && (
              <circle cx={n.x} cy={n.y} r={r + 7} fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="2 3" />
            )}
            <circle cx={n.x} cy={n.y} r={r} fill="#0d1117" stroke={col} strokeWidth={2.5} />
            <text x={n.x} y={n.y + 4} fontSize={12} fontWeight={700} textAnchor="middle" fill={col}>
              {LAYER_GLYPH[n.layer_type]}
            </text>
            {isVasp && (
              <text x={n.x} y={n.y - r - 8} fontSize={10} fontWeight={600} textAnchor="middle" fill="#f59e0b">
                {n.vasp}
              </text>
            )}
            <text x={n.x} y={n.y + r + 14} fontSize={10} textAnchor="middle" fill="#94a3b8">
              {shortWallet(n.address)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Findings ──────────────────────────────────────────────────────────────────
function FindingRow({ finding }: { finding: { code: string; title: string; plain: string; severity: "high" | "medium" | "info"; wallets: string[]; amountUsd: number } }) {
  const sev: Severity = finding.severity === "info" ? "safe" : finding.severity;
  return (
    <div
      className="rounded-xl p-3.5"
      style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <SeverityBadge severity={sev} />
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: "var(--panel)", color: "var(--muted)" }}
            >
              {finding.code}
            </span>
          </div>
          <div className="mt-2 text-[13.5px] font-semibold" style={{ color: "var(--text-strong)" }}>
            {finding.title}
          </div>
        </div>
        {finding.amountUsd > 0 && (
          <div className="text-right shrink-0">
            <div className="text-[15px] font-semibold" style={{ color: "var(--text-strong)" }}>
              {formatUSD(finding.amountUsd)}
            </div>
          </div>
        )}
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
        {finding.plain}
      </p>
      {finding.wallets.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {finding.wallets.slice(0, 8).map((w, i) => (
            <span
              key={`${w}-${i}`}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: "var(--panel)", color: "var(--muted)" }}
            >
              {shortWallet(w)}
            </span>
          ))}
          {finding.wallets.length > 8 && (
            <span className="text-[10px]" style={{ color: "var(--muted)" }}>
              +{finding.wallets.length - 8} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── VASP endpoint card ──────────────────────────────────────────────────────
function VaspCard({ vasp, onNotice }: { vasp: VaspHit; onNotice?: () => void }) {
  const tag = vasp.is_mixer
    ? { label: "Mixer — no compliance desk", color: "#ec4899" }
    : vasp.is_verified
    ? { label: "Verified exchange", color: "#22c55e" }
    : { label: "Offshore / unverified", color: "#f59e0b" };
  return (
    <div className="rounded-xl p-4" style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold" style={{ color: "var(--text-strong)" }}>
            {vasp.vasp_name}
          </div>
          <span className="text-[11px] px-2 py-0.5 rounded-full mt-1 inline-block" style={{ background: `${tag.color}18`, color: tag.color }}>
            {tag.label}
          </span>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[16px] font-semibold" style={{ color: "var(--text-strong)" }}>
            {formatUSD(vasp.inflowUsd)}
          </div>
          <div className="text-[11px]" style={{ color: "var(--muted)" }}>
            {vasp.confidence}% confidence
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {vasp.chains.map((c) => (
          <span key={c} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${chainColor(c)}18`, color: chainColor(c) }}>
            {CHAINS[c].short}
          </span>
        ))}
      </div>

      {vasp.depositAddresses.length > 0 && (
        <div className="mt-2 text-[11px] font-mono break-all" style={{ color: "var(--muted)" }}>
          Deposit: {vasp.depositAddresses.map(shortWallet).join(", ")}
        </div>
      )}

      {!vasp.is_mixer ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] truncate" style={{ color: "var(--muted)" }}>
            {vasp.compliance_email} · {vasp.jurisdiction}
          </span>
          {onNotice && (
            <button
              onClick={onNotice}
              className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-medium border transition hover:opacity-80"
              style={{ borderColor: "var(--border)", color: "var(--text-strong)" }}
            >
              Generate Sec 91 notice
            </button>
          )}
        </div>
      ) : (
        <p className="mt-3 text-[11px]" style={{ color: "var(--muted)" }}>
          {vasp.jurisdiction}. No process can be served — refer the exposure to FIU-IND.
        </p>
      )}
    </div>
  );
}

// ── Assistant verdict + agent panels ────────────────────────────────────────
function VerdictBanner({ verdict, model, cached }: { verdict: Verdict; model?: string; cached?: boolean }) {
  return (
    <div className="rounded-xl p-4" style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-2 flex-wrap">
        <SeverityBadge severity={verdict.level} size="md" />
        <span className="text-[14px] font-semibold" style={{ color: "var(--text-strong)" }}>
          {verdict.headline}
        </span>
        <span className="ml-auto text-[10px]" style={{ color: "var(--muted)" }}>
          {cached ? "cached · " : ""}
          {model ? model.replace("models/", "") : "built-in engine"}
        </span>
      </div>
      {verdict.points.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {verdict.points.map((p, i) => (
            <li key={i} className="text-[12.5px] leading-relaxed flex gap-2" style={{ color: "var(--muted)" }}>
              <span style={{ color: "#22c55e" }}>›</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentCard({ panel }: { panel: AgentPanel }) {
  const meta = AGENT_META[panel.agent as ChatAgent] ?? {
    color: "#64748b",
    bg: "rgba(100,116,139,0.12)",
    icon: "◇",
    role: "",
  };
  const lines = panel.content.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <div className="rounded-xl p-4" style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-2.5">
        <span className="grid place-items-center w-7 h-7 rounded-lg shrink-0" style={{ background: meta.bg, color: meta.color }}>
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold" style={{ color: "var(--text-strong)" }}>
            {panel.agent}
          </div>
          {meta.role && (
            <div className="text-[10px]" style={{ color: "var(--muted)" }}>
              {meta.role}
            </div>
          )}
        </div>
        {typeof panel.confidence === "number" && (
          <span className="text-[11px] font-medium shrink-0" style={{ color: meta.color }}>
            {Math.round(panel.confidence * 100)}%
          </span>
        )}
      </div>

      {panel.headline && (
        <div className="mt-2.5 text-[12.5px] font-medium" style={{ color: "var(--text-strong)" }}>
          {panel.headline}
        </div>
      )}

      <div className="mt-2 space-y-1">
        {lines.map((l, i) => {
          const bullet = l.startsWith("•") || /^\d+\./.test(l);
          const text = l.replace(/^•\s?/, "");
          return (
            <div key={i} className="text-[12.5px] leading-relaxed flex gap-2" style={{ color: "var(--muted)" }}>
              {bullet && !/^\d+\./.test(l) && <span style={{ color: meta.color }}>•</span>}
              <span>{text}</span>
            </div>
          );
        })}
      </div>

      {panel.findings && panel.findings.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {panel.findings.map((f, i) => (
            <span key={i} className="text-[10.5px] px-2 py-0.5 rounded-full" style={{ background: meta.bg, color: meta.color }}>
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Section 91 notice modal (+ print portal) ────────────────────────────────
function NoticeModal({ notice, onClose }: { notice: LegalNotice; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setMounted(true), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(notice.rendered);
      if (copyRef.current) {
        const el = copyRef.current;
        const prev = el.textContent;
        el.textContent = "Copied ✓";
        setTimeout(() => (el.textContent = prev), 1400);
      }
    } catch {
      /* clipboard blocked — the text is on screen to copy by hand */
    }
  };

  const download = () => {
    const blob = new Blob([notice.rendered], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${notice.ref.replace(/[^\w.-]/g, "_")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
        <div
          className="w-full max-w-3xl max-h-[88vh] overflow-hidden rounded-2xl flex flex-col"
          style={{ background: "var(--panel)", border: "1px solid var(--border)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 p-4" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                {notice.statute}
              </div>
              <div className="mt-1 text-[15px] font-semibold" style={{ color: "var(--text-strong)" }}>
                {notice.serviceable ? `Freeze & KYC notice — ${notice.to_vasp}` : "No serviceable endpoint"}
              </div>
              {notice.serviceable && (
                <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
                  Ref {notice.ref} · to {notice.to_email} · {formatUSD(notice.amountUsd)}
                  {notice.amountInr ? ` · loss ${formatINR(notice.amountInr)}` : ""}
                </div>
              )}
            </div>
            <button onClick={onClose} className="shrink-0 text-lg leading-none px-2" style={{ color: "var(--muted)" }} aria-label="Close">
              ✕
            </button>
          </div>

          <div className="overflow-y-auto p-4">
            <pre
              className="text-[12px] leading-relaxed whitespace-pre-wrap font-mono"
              style={{ color: "var(--text)" }}
            >
              {notice.rendered}
            </pre>
          </div>

          <div className="flex flex-wrap gap-2 p-4" style={{ borderTop: "1px solid var(--border)" }}>
            <button
              onClick={() => window.print()}
              className="rounded-lg px-3.5 py-2 text-[12px] font-medium text-black transition"
              style={{ background: "linear-gradient(135deg,#22c55e,#10b981)" }}
            >
              Print / Save as PDF
            </button>
            <button ref={copyRef} onClick={copy} className="rounded-lg px-3.5 py-2 text-[12px] font-medium border transition hover:opacity-80" style={{ borderColor: "var(--border)", color: "var(--text-strong)" }}>
              Copy text
            </button>
            <button onClick={download} className="rounded-lg px-3.5 py-2 text-[12px] font-medium border transition hover:opacity-80" style={{ borderColor: "var(--border)", color: "var(--text-strong)" }}>
              Download .txt
            </button>
            {notice.serviceable && notice.to_email && (
              <a
                href={`mailto:${notice.to_email}?subject=${encodeURIComponent(notice.subject)}&body=${encodeURIComponent(notice.rendered)}`}
                className="rounded-lg px-3.5 py-2 text-[12px] font-medium border transition hover:opacity-80"
                style={{ borderColor: "var(--border)", color: "var(--text-strong)" }}
              >
                Draft email
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Print target — globals.css shows only #sar-print-portal when printing. */}
      {mounted &&
        createPortal(
          <div id="sar-print-portal">
            <h1>NOTICE UNDER {notice.statute}</h1>
            {notice.body.map((para, i) => (
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
