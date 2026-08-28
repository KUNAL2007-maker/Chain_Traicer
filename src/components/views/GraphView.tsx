"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  buildGraphFromTransfers,
  chainColor,
  detectPattern,
  formatUSD,
  nodeRadius,
  severityColor,
  shortWallet,
  CHAINS,
  type Chain,
  type GraphCluster,
  type GraphEdge,
  type GraphNode,
  type LayerType,
} from "@/lib/domain";
import { useTraceStore } from "@/lib/store";
import { useTheme } from "@/components/ThemeProvider";
import { SeverityBadge } from "../ui/SeverityBadge";
import { NodeDetailDrawer } from "../NodeDetailDrawer";
import { Page } from "../ui/Page";

type FilterKey = "all" | "safe" | "medium" | "high";

const W = 1240;

// Short layer tags for the crowded canvas — the drawer spells them out in full.
const LAYER_SHORT: Record<LayerType, string> = {
  VICTIM_ENTRY: "Victim",
  BURNER_MULE: "Mule",
  PEELING_CHAIN: "Peel",
  BRIDGE_HOP: "Bridge",
  VASP_DEPOSIT: "Deposit",
  VASP_HOT_WALLET: "Exchange",
};

export function GraphView({
  focusAccounts,
  onClearFocus,
  onOpenNotices,
  onGoToTrace,
}: {
  // Wallets an investigator agent named, handed over when the user clicks
  // "View on graph" in the chat. Everything else on the canvas fades back.
  focusAccounts?: string[];
  onClearFocus?: () => void;
  // Jump to the Legal Notices tab after the drawer drafts a Section 91 notice.
  onOpenNotices?: () => void;
  // Empty-state CTA — the graph only fills once a trace has seeded the store.
  onGoToTrace?: () => void;
} = {}) {
  const { trace, status } = useTraceStore();
  const loading = status === "tracing";

  // Lane and typology hues were chosen to read on the dark canvas; as lettering
  // on a white panel each one sinks below legible contrast. Light mode swaps the
  // text colour for a darker sibling of the same family — fills, strokes, dots
  // and glows keep the original hue, so the graph's palette is unchanged and
  // only the words get darker. In dark mode this returns the colour untouched.
  const { theme } = useTheme();
  const laneText = useMemo(() => {
    const darker: Record<string, string> = {
      "#38bdf8": "#0369a1", "#a78bfa": "#6d28d9", "#f59e0b": "#b45309",
      "#22c55e": "#15803d", "#ec4899": "#be185d", "#06b6d4": "#0e7490",
      "#f97316": "#c2410c", "#8b5cf6": "#6d28d9", "#14b8a6": "#0f766e",
      "#e11d48": "#be123c", "#ef4444": "#dc2626", "#10b981": "#047857",
    };
    return (c: string) => (theme === "light" ? darker[c] ?? c : c);
  }, [theme]);

  const [filter, setFilter] = useState<FilterKey>("all");
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const {
    nodes: NODES,
    edges: EDGES,
    chains: CHAINS_USED,
    clusters: CLUSTERS,
    height: H,
  } = useMemo(() => {
    const nodesIn = trace?.nodes ?? [];
    const transfers = trace?.transfers ?? [];
    if (!nodesIn.length)
      return {
        nodes: [] as GraphNode[],
        edges: [] as GraphEdge[],
        chains: [] as Chain[],
        clusters: [] as GraphCluster[],
        height: 560,
      };
    return buildGraphFromTransfers(nodesIn, transfers, W);
  }, [trace]);

  // The chains this trace touched — the crypto analogue of FinGuard's bank lanes.
  const displayChains = useMemo(
    () =>
      CHAINS_USED.map((c) => ({
        id: c,
        name: CHAINS[c].name,
        code: CHAINS[c].short,
        color: chainColor(c),
      })),
    [CHAINS_USED]
  );

  const nodeIndex = useMemo(() => {
    const m = new Map<string, GraphNode>();
    NODES.forEach((n) => m.set(n.id, n));
    return m;
  }, [NODES]);

  const visibleNodes = useMemo(
    () => NODES.filter((n) => (filter === "all" ? true : n.severity === filter)),
    [filter, NODES]
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => EDGES.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [visibleIds, EDGES]
  );

  // Wallets arriving from the chat, kept only if they exist on this canvas.
  const pinned = useMemo(
    () => (focusAccounts ?? []).filter((a) => nodeIndex.has(a)),
    [focusAccounts, nodeIndex]
  );

  // Two different jobs, kept apart on purpose. Wallets arriving from the chat get
  // a standing highlight — a marked ring plus a permanent label — and every other
  // node stays fully visible, because arriving on a canvas showing one lit ring
  // and nothing else hides the context that makes the ring mean something. Hover
  // is the transient one, and it only softens the rest rather than blanking it.
  const spread = useCallback(
    (roots: string[]) => {
      const s = new Set<string>(roots);
      EDGES.forEach((e) => {
        if (s.has(e.source)) s.add(e.target);
        if (s.has(e.target)) s.add(e.source);
      });
      return s;
    },
    [EDGES]
  );

  const highlightIds = useMemo(() => (pinned.length ? spread(pinned) : null), [pinned, spread]);
  const hoverIds = useMemo(() => (hover ? spread([hover]) : null), [hover, spread]);

  const highCount = NODES.filter((n) => n.severity === "high").length;
  const medCount = NODES.filter((n) => n.severity === "medium").length;

  // The multi-wallet rings — the typology panel's list, the "Rings" stat and its
  // empty state all read this, and computing it three times from CLUSTERS was how
  // the stat and the list could disagree.
  const webClusters = useMemo(() => CLUSTERS.filter((c) => c.kind === "web"), [CLUSTERS]);

  // Below lg the pane is about 340px against a 1240px canvas, so at 100% a phone
  // showed a quarter of the first ring. Fitting the canvas to the pane on first
  // paint is the fix — the whole network arrives complete, and the zoom controls
  // are right there to read a ring properly. Desktop never enters this branch.
  const touchedZoom = useRef(false);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const apply = () => {
      const isNarrow = window.matchMedia("(max-width: 1023px)").matches;
      setNarrow(isNarrow);
      if (!isNarrow || touchedZoom.current) return;
      const el = scrollRef.current;
      if (!el || !el.clientWidth) return;
      setZoom(Math.max(0.16, Math.min(1, (el.clientWidth - 12) / W)));
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [H, NODES.length]);

  const zoomBy = (fn: (z: number) => number) => {
    touchedZoom.current = true;
    setZoom(fn);
  };

  if (loading) {
    return (
      <Page width="wide" fill>
        <div className="flex h-full min-h-[420px] items-center justify-center" style={{ color: "var(--muted)" }}>
          Tracing the money…
        </div>
      </Page>
    );
  }

  if (NODES.length === 0) {
    return (
      <Page width="wide" fill>
        <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-3">
          <div className="text-[32px] opacity-30">◇</div>
          <div className="text-[14px] font-medium" style={{ color: "var(--text-strong)" }}>
            No wallet traced yet
          </div>
          <div className="text-[12.5px]" style={{ color: "var(--muted-2)" }}>
            Seed a case in Trace Wallet to build the multi-chain flow graph.
          </div>
          {onGoToTrace && (
            <button
              onClick={onGoToTrace}
              className="mt-1 rounded-lg px-4 py-2 text-[13px] font-medium text-black transition"
              style={{ background: "linear-gradient(135deg,#22c55e,#10b981)" }}
            >
              Go to Trace Wallet →
            </button>
          )}
        </div>
      </Page>
    );
  }

  const fittedH = Math.round(H * zoom) + 8;
  const viewportH = narrow ? fittedH : Math.min(760, Math.max(520, fittedH));

  const fitToView = () => {
    const el = scrollRef.current;
    if (!el) return;
    touchedZoom.current = true;
    setZoom(Math.max(0.3, Math.min(1, (el.clientWidth - 12) / W)));
  };

  return (
    <Page width="wide" className="space-y-4">
      {/* ── Network canvas (full width) ─────────────────────────────────── */}
      <div
        className="rounded-2xl overflow-hidden border"
        style={{ background: "var(--panel)", borderColor: "var(--border)" }}
      >
        <div
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
              Network Canvas
            </div>
            <span
              className="text-[11px] rounded px-1.5 py-0.5 border"
              style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--muted)" }}
            >
              {CLUSTERS.length} clusters · {NODES.length} wallets
            </span>
            {highCount > 0 && (
              <span className="text-[11px] rounded px-1.5 py-0.5 bg-red-500/10 border border-red-500/25 text-red-300">
                {highCount} high-risk
              </span>
            )}
            {medCount > 0 && (
              <span className="text-[11px] rounded px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/25 text-amber-300">
                {medCount} medium
              </span>
            )}
            {pinned.length > 0 && (
              <span className="inline-flex items-center gap-1.5 text-[11px] rounded px-1.5 py-0.5 bg-sky-500/10 border border-sky-500/30 text-sky-200">
                Focused on {pinned.length} {pinned.length === 1 ? "wallet" : "wallets"} from the investigation
                {onClearFocus && (
                  <button onClick={onClearFocus} className="underline decoration-dotted hover:text-sky-100">
                    clear
                  </button>
                )}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex gap-1">
              {(["all", "high", "medium", "safe"] as FilterKey[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  className={`text-[11.5px] rounded-md border px-2.5 py-1.5 capitalize transition lg:py-1 ${
                    filter === k
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                      : "hover:bg-[var(--hover)]"
                  }`}
                  style={filter !== k ? { borderColor: "var(--border)", color: "var(--text)" } : undefined}
                >
                  {k}
                </button>
              ))}
            </div>
            <div className="hidden w-px h-5 lg:block" style={{ background: "var(--border)" }} />
            <div className="flex items-center gap-2">
              <button
                onClick={() => zoomBy((z) => Math.max(0.35, Math.round((z - 0.1) * 100) / 100))}
                className="h-8 w-8 rounded-md border hover:bg-[var(--hover)] lg:h-7 lg:w-7"
                style={{ borderColor: "var(--border)", color: "var(--text)" }}
                aria-label="Zoom out"
              >
                −
              </button>
              <div className="text-[11px] font-mono w-10 text-center" style={{ color: "var(--muted)" }}>
                {Math.round(zoom * 100)}%
              </div>
              <button
                onClick={() => zoomBy((z) => Math.min(2, Math.round((z + 0.1) * 100) / 100))}
                className="h-8 w-8 rounded-md border hover:bg-[var(--hover)] lg:h-7 lg:w-7"
                style={{ borderColor: "var(--border)", color: "var(--text)" }}
                aria-label="Zoom in"
              >
                +
              </button>
              <button
                onClick={() => zoomBy(() => 1)}
                className="text-[11px] rounded-md border px-2 py-1.5 hover:bg-[var(--hover)] lg:py-1"
                style={{ borderColor: "var(--border)", color: "var(--text)" }}
                title="Back to actual size — labels at full readability"
              >
                100%
              </button>
              <button
                onClick={fitToView}
                className="text-[11px] rounded-md border px-2 py-1.5 hover:bg-[var(--hover)] lg:py-1"
                style={{ borderColor: "var(--border)", color: "var(--text)" }}
                title="Zoom out until the whole width fits"
              >
                Fit
              </button>
            </div>
          </div>
        </div>

        <div className="relative max-h-[60vh] lg:max-h-none" style={{ height: viewportH, background: "var(--bg)" }}>
          <div ref={scrollRef} className="absolute inset-0 overflow-auto">
            <svg
              width={Math.round(W * zoom)}
              height={Math.round(H * zoom)}
              viewBox={`0 0 ${W} ${H}`}
              style={{ display: "block" }}
            >
              <defs>
                <marker id="arrowRed" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#ef4444" />
                </marker>
                <marker id="arrowAmber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
                </marker>
                <marker id="arrowGreen" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#22c55e" />
                </marker>
                <radialGradient id="redGlow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="rgba(239,68,68,0.5)" />
                  <stop offset="100%" stopColor="rgba(239,68,68,0)" />
                </radialGradient>
              </defs>

              {/* Cluster cards. Each ring is a titled panel — dot, typology, wallet
                  count and money moved — so the canvas reads as a list of findings
                  you can scan, instead of a field of loose circles. */}
              {CLUSTERS.map((c) => {
                if (!c.nodeIds.some((id) => visibleIds.has(id))) return null;
                const r = 14;
                const hb = 34;
                const head =
                  `M ${c.x} ${c.y + r} A ${r} ${r} 0 0 1 ${c.x + r} ${c.y}` +
                  ` L ${c.x + c.w - r} ${c.y} A ${r} ${r} 0 0 1 ${c.x + c.w} ${c.y + r}` +
                  ` L ${c.x + c.w} ${c.y + hb} L ${c.x} ${c.y + hb} Z`;
                return (
                  <g key={c.id} opacity={hoverIds ? 0.55 : 1}>
                    <rect
                      x={c.x}
                      y={c.y}
                      width={c.w}
                      height={c.h}
                      rx={r}
                      fill={`${c.color}08`}
                      stroke={`${c.color}2E`}
                      strokeWidth={1}
                      strokeDasharray={c.kind === "pairs" ? "7 6" : undefined}
                    />
                    <path d={head} fill={`${c.color}1C`} />
                    <line x1={c.x} y1={c.y + hb} x2={c.x + c.w} y2={c.y + hb} stroke={`${c.color}2E`} strokeWidth={1} />
                    <circle cx={c.x + 17} cy={c.y + 18} r={3.5} fill={c.color} />
                    <text x={c.x + 29} y={c.y + 22} fontSize={11.5} fill={laneText(c.color)} letterSpacing="0.09em" fontWeight={700}>
                      {c.label.toUpperCase()}
                    </text>
                    <text x={c.x + c.w - 16} y={c.y + 22} fontSize={10.5} textAnchor="end" fill="#94a3b8" className="font-mono">
                      {c.count} {c.kind === "pairs" ? "pairs" : "wallets"} · {formatUSD(c.total)}
                    </text>
                  </g>
                );
              })}

              {/* Edges */}
              {visibleEdges.map((e) => {
                const s = nodeIndex.get(e.source);
                const t = nodeIndex.get(e.target);
                if (!s || !t) return null;
                const color = severityColor(e.severity);
                const isHigh = e.severity === "high";
                const lit = !!highlightIds && highlightIds.has(e.source) && highlightIds.has(e.target);
                const hovered = !!hoverIds && hoverIds.has(e.source) && hoverIds.has(e.target);
                const touched = lit || hovered;
                const faded = !!hoverIds && !hovered;
                const marker =
                  e.severity === "high" ? "url(#arrowRed)" : e.severity === "medium" ? "url(#arrowAmber)" : "url(#arrowGreen)";
                return (
                  <g key={e.id} opacity={faded ? 0.5 : 1} style={{ transition: "opacity 0.15s ease" }}>
                    <path
                      d={curvePath(s.x, s.y, t.x, t.y)}
                      fill="none"
                      stroke={color}
                      strokeOpacity={touched ? 1 : isHigh ? 0.8 : 0.5}
                      strokeWidth={touched ? 2.4 : isHigh ? 1.8 : 1.3}
                      strokeDasharray={isHigh ? "6 6" : undefined}
                      markerEnd={marker}
                      className={isHigh ? "animate-dashmove" : ""}
                    />
                    {touched && (
                      <text
                        x={(s.x + t.x) / 2}
                        y={(s.y + t.y) / 2 - 6}
                        textAnchor="middle"
                        fontSize={10}
                        fill={laneText(color)}
                        className="font-mono"
                        style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}
                      >
                        {formatUSD(e.amount)}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Nodes */}
              {visibleNodes.map((n) => {
                const isHover = hover === n.id;
                const isHigh = n.severity === "high";
                const color = severityColor(n.severity);
                const deg = n.degree ?? 1;
                const base = nodeRadius(deg);
                const r = isHover ? base + 3 : base;
                const isHub = deg >= 4;
                const isNamed = pinned.includes(n.id);
                const lit = !!highlightIds && highlightIds.has(n.id);
                const faded = !!hoverIds && !hoverIds.has(n.id);
                const cColor = chainColor(n.chain);
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x}, ${n.y})`}
                    className="cursor-pointer"
                    opacity={faded ? 0.55 : 1}
                    style={{ transition: "opacity 0.15s ease" }}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => setSelected(n)}
                  >
                    {isHigh && <circle r={r + 14} fill="url(#redGlow)" />}
                    {lit && (
                      <circle
                        r={r + 7}
                        fill="none"
                        stroke="#38bdf8"
                        strokeOpacity={isNamed ? 0.95 : 0.5}
                        strokeWidth={isNamed ? 2.4 : 1.4}
                        strokeDasharray={isNamed ? undefined : "3 3"}
                      />
                    )}
                    {isHigh && (isHub || isHover) && (
                      <circle r={r + 4} fill="none" stroke="#ef4444" strokeOpacity={0.5} strokeWidth={1.5}>
                        <animate attributeName="r" from={String(r + 4)} to={String(r + 18)} dur="1.6s" repeatCount="indefinite" />
                        <animate attributeName="opacity" from="0.7" to="0" dur="1.6s" repeatCount="indefinite" />
                      </circle>
                    )}
                    <circle
                      r={r}
                      fill="#0d1117"
                      stroke={color}
                      strokeWidth={isHub ? 2.6 : isHover ? 2.2 : 1.6}
                      style={{ filter: `drop-shadow(0 0 6px ${color}80)`, transition: "r 0.15s ease" }}
                    />
                    {/* Inner core carries the chain identity; the ring carries risk. */}
                    <circle r={Math.max(5, r * 0.38)} fill={cColor} opacity={0.92} />
                    {isHub && (
                      <text y={4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#0d1117">
                        {deg}
                      </text>
                    )}
                    <text
                      y={r + 14}
                      textAnchor="middle"
                      fontSize={9.5}
                      fontWeight={isHover || isHub || isNamed ? 700 : 400}
                      fill={isHover ? "#ffffff" : isNamed ? "#7dd3fc" : isHub ? "#e2e8f0" : "#94a3b8"}
                      className="font-mono"
                      style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}
                    >
                      {shortWallet(n.label)}
                    </text>
                    {/* Named wallets keep their chain and role on screen permanently;
                        everything else reveals it on hover. */}
                    {(isHover || isNamed) && (
                      <text
                        y={r + 25}
                        textAnchor="middle"
                        fontSize={8.5}
                        fill={laneText(cColor)}
                        className="font-mono"
                        style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}
                      >
                        {CHAINS[n.chain].short} · {n.vasp ?? LAYER_SHORT[n.layer_type]}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          {highCount > 0 && (
            <div
              className="graph-hud pointer-events-none absolute left-3 bottom-3 hidden rounded-md border border-red-500/25 px-2.5 py-1.5 text-[11px] font-mono text-red-300 lg:block"
              style={{ background: "rgba(0,0,0,0.45)" }}
            >
              {highCount} HIGH RISK WALLETS DETECTED
            </div>
          )}
          <div
            className="graph-hud pointer-events-none absolute right-3 top-3 hidden rounded-md border px-2.5 py-1.5 text-[11px] font-mono lg:block"
            style={{ borderColor: "var(--border)", background: "rgba(0,0,0,0.45)", color: "var(--text)" }}
          >
            Hover to isolate a ring · click for the full dossier
          </div>
        </div>
      </div>

      {/* ── Legend strip ─────────────────────────────────────────────────── */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-2.5 text-[12px] lg:gap-x-6"
        style={{ background: "var(--panel)", borderColor: "var(--border)", color: "var(--text)" }}
      >
        <LegendRow color="#ef4444" label="High risk" />
        <LegendRow color="#f59e0b" label="Medium risk" />
        <LegendRow color="#22c55e" label="Safe" />
        <span className="flex items-center gap-2">
          <span
            className="grid place-items-center w-4 h-4 rounded-full border text-[8px] font-bold"
            style={{ borderColor: "var(--muted)", color: "var(--text)" }}
          >
            n
          </span>
          Number in a node = counterparties
        </span>
        <span className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full ring-2 ring-white/20" style={{ background: "#38bdf8" }} />
          Core colour = chain
        </span>
        <span className="w-full text-[11.5px] lg:ml-auto lg:w-auto" style={{ color: "var(--muted)" }}>
          <span className="lg:hidden">Tap any node for its full dossier · pinch or use + to zoom in</span>
          <span className="hidden lg:inline">Hover a ring to isolate it · click any node for the full dossier</span>
        </span>
      </div>

      {/* ── Reference panels ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-3">
        <Panel title="Cluster inspector">
          <div className="grid shrink-0 grid-cols-4 gap-2 text-center">
            <Stat label="Nodes" value={String(NODES.length)} color={laneText("#38bdf8")} />
            <Stat label="Edges" value={String(EDGES.length)} color={laneText("#a78bfa")} />
            <Stat label="Rings" value={String(webClusters.length)} color={laneText("#f59e0b")} />
            <Stat label="High" value={String(highCount)} color={laneText("#ef4444")} />
          </div>
          <div className="h-px my-4 shrink-0" style={{ background: "var(--border)" }} />
          <div className="shrink-0 text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
            Chains ({displayChains.length})
          </div>
          <div className="mt-2.5 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {displayChains.map((b) => (
              <div key={b.id} className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 shrink-0 rounded-sm" style={{ background: b.color, boxShadow: `0 0 8px ${b.color}` }} />
                <span className="text-[12.5px] truncate" style={{ color: "var(--text)" }}>
                  {b.name}
                </span>
                <span className="ml-auto text-[11px] font-mono" style={{ color: "var(--muted)" }}>
                  {b.code}
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Detected typologies" count={webClusters.length}>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {webClusters.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2.5 rounded-lg border px-2.5 py-2"
                style={{ borderColor: `${c.color}33`, background: `${c.color}0D` }}
              >
                <span className="w-2 h-2 shrink-0 rounded-full" style={{ background: c.color, boxShadow: `0 0 8px ${c.color}` }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] truncate" style={{ color: "var(--text-strong)" }}>
                    {c.label}
                  </span>
                  <span className="block text-[10.5px]" style={{ color: "var(--muted)" }}>
                    {c.count} wallets
                  </span>
                </span>
                <span className="shrink-0 text-right text-[12px] font-mono" style={{ color: laneText(c.color) }}>
                  {formatUSD(c.total)}
                </span>
              </div>
            ))}
            {webClusters.length === 0 && (
              <div className="text-[12px]" style={{ color: "var(--muted)" }}>
                No multi-wallet rings in this trace.
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Largest hops" count={Math.min(EDGES.length, 8)}>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {EDGES.slice()
              .sort((a, b) => b.amount - a.amount)
              .slice(0, 8)
              .map((e, i) => {
                const s = nodeIndex.get(e.source);
                const t = nodeIndex.get(e.target);
                return (
                  <div
                    key={e.id}
                    className="flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-[12px]"
                    style={{ background: "var(--bg)", borderColor: "var(--border)" }}
                  >
                    <span
                      className="grid h-4 w-4 shrink-0 place-items-center rounded text-[9.5px] font-semibold"
                      style={{ background: `${severityColor(e.severity)}1F`, color: severityColor(e.severity) }}
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono" style={{ color: "var(--muted)" }}>
                      {shortWallet(s?.label ?? e.source)} → {shortWallet(t?.label ?? e.target)}
                    </span>
                    <span className="shrink-0 font-mono" style={{ color: "var(--text-strong)" }}>
                      {formatUSD(e.amount)}
                    </span>
                  </div>
                );
              })}
          </div>
        </Panel>
      </div>

      {/* ── Edge log ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border overflow-hidden" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
          <div className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
            Edge Log
          </div>
          <div className="text-[11px] font-mono tabular-nums" style={{ color: "var(--muted)" }}>
            {visibleEdges.length} transfers
          </div>
        </div>
        <div className="max-h-[340px] overflow-auto">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 z-10">
              <tr
                className="text-left text-[10.5px] uppercase tracking-widest backdrop-blur"
                style={{ color: "var(--muted)", background: "var(--panel-strong)" }}
              >
                <th className="px-4 py-2 font-medium whitespace-nowrap">Time</th>
                <th className="px-4 py-2 font-medium">From</th>
                <th className="px-4 py-2 font-medium">To</th>
                <th className="px-4 py-2 font-medium">Chain</th>
                <th className="px-4 py-2 font-medium text-right whitespace-nowrap">Value</th>
                <th className="px-4 py-2 font-medium">Severity</th>
                <th className="px-4 py-2 font-medium">Typology</th>
              </tr>
            </thead>
            <tbody>
              {visibleEdges.map((e) => {
                const s = nodeIndex.get(e.source);
                const t = nodeIndex.get(e.target);
                const pat = detectPattern(e.note);
                return (
                  <tr key={e.id} className="border-t hover:bg-[var(--hover)]" style={{ borderColor: "var(--border)" }}>
                    <td className="px-4 py-2 font-mono whitespace-nowrap tabular-nums" style={{ color: "var(--muted)" }}>
                      {e.timestamp.slice(0, 10)}
                    </td>
                    <td className="px-4 py-2 font-mono" style={{ color: "var(--text)" }}>
                      {shortWallet(s?.label ?? e.source)}
                    </td>
                    <td className="px-4 py-2 font-mono" style={{ color: "var(--text)" }}>
                      {shortWallet(t?.label ?? e.target)}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className="text-[10.5px] rounded px-1.5 py-0.5"
                        style={{ background: `${chainColor(e.chain)}1F`, color: laneText(chainColor(e.chain)) }}
                      >
                        {CHAINS[e.chain].short}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono whitespace-nowrap tabular-nums" style={{ color: "var(--text-strong)" }}>
                      {formatUSD(e.amount)}
                    </td>
                    <td className="px-4 py-2">
                      <SeverityBadge severity={e.severity} />
                    </td>
                    <td className="px-4 py-2" style={{ color: "var(--muted)" }}>
                      {pat?.label ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <NodeDetailDrawer
        node={selected}
        edges={EDGES}
        onClose={() => setSelected(null)}
        onOpenNotices={
          onOpenNotices &&
          (() => {
            setSelected(null);
            onOpenNotices();
          })
        }
      />
    </Page>
  );
}

// A gentle quadratic bow so parallel hops between the same two wallets don't
// overlap into a single line.
function curvePath(x1: number, y1: number, x2: number, y2: number) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const nx = -dy;
  const ny = dx;
  const len = Math.sqrt(nx * nx + ny * ny) || 1;
  const off = Math.min(26, len * 0.12);
  const cx = mx + (nx / len) * off;
  const cy = my + (ny / len) * off;
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}

function Panel({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section
      className="flex h-full min-h-0 flex-col rounded-2xl border p-4 lg:max-h-[392px]"
      style={{ background: "var(--panel)", borderColor: "var(--border)" }}
    >
      <div className="flex shrink-0 items-baseline justify-between gap-2">
        <h3 className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
          {title}
        </h3>
        {count !== undefined && (
          <span className="font-mono text-[11px] tabular-nums" style={{ color: "var(--muted-2)" }}>
            {count}
          </span>
        )}
      </div>
      <div className="mt-3 flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg border p-2" style={{ borderColor: `${color}33`, background: `${color}0F` }}>
      <div className="text-[17px] font-semibold leading-none" style={{ color: "var(--text-strong)" }}>
        {value}
      </div>
      <div className="mt-1 text-[9.5px] uppercase tracking-widest" style={{ color }}>
        {label}
      </div>
    </div>
  );
}

function LegendRow({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-2 h-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      <span>{label}</span>
    </div>
  );
}
