"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_META,
  SUGGESTED_QUERIES,
  severityColor,
  type ChatAgent,
  type ChatAgentPanel,
  type ChatMessage,
  type ChatVerdict,
} from "@/lib/domain";
import { useTraceStore } from "@/lib/store";
import { useAuth } from "@/components/AuthProvider";
import { Page } from "../ui/Page";

// ── Chat response shapes (mirror /api/chat) ─────────────────────────────────
// The trace summary the route attaches to an investigate reply (see summarize()
// in src/app/api/chat/route.ts). Held in state so the session-context rail can
// report what the last run actually found.
type EvidenceSummary = {
  txCount: number;
  walletCount: number;
  vaspCount: number;
  findingCount: number;
  highCount: number;
  track?: "A" | "B" | "DUAL";
};

type AgentResponse = {
  agent: string;
  headline?: string;
  content: string;
  findings?: string[];
  confidence?: number;
};

type InvestigateResponse = {
  mode: "investigate";
  agents: AgentResponse[];
  verdict: ChatVerdict;
  suggestions?: string[];
  evidence?: EvidenceSummary;
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
  retryAfter?: number;
};

// The route returns 200 for both success shapes; only the true error paths
// (400 / 429-casual / 500) are non-ok, and those are read separately below.
type OkResponse = InvestigateResponse | CasualResponse;

// What the session-context row shows when a report came from the built-in
// forensic engine rather than the AI. Worth naming: the panels look identical
// either way, and a reader comparing two runs deserves to know which is which.
const LOCAL_ENGINE = "built-in engine";

/**
 * A full model id is too long for a ~320px rail, so the row shows the family and
 * variant and the exact id lives in the tooltip. Before the first reply there is
 * nothing to report yet, so it shows a dash.
 */
function engineLabel(model: string | null): string {
  if (!model) return "—";
  if (model === LOCAL_ENGINE) return LOCAL_ENGINE;
  return model
    .replace(/^models\//, "")
    .replace(/^gemini-/, "gemini · ")
    .replace(/-preview$/, "");
}

export function InvestigatorChat({ onOpenGraph }: { onOpenGraph: (accounts: string[]) => void }) {
  // The single source of truth every tab reads from. The whole TraceResult is
  // sent to /api/chat as `context` on every turn — the route calls asTrace() on
  // it and reads context.transfers / context.nodes, so a slimmed projection
  // would be discarded.
  const { trace } = useTraceStore();

  // Scoped to the signed-in officer, so two officers sharing a machine never
  // read each other's transcript. It survives a page reload or a full remount,
  // not just a tab switch.
  const { user } = useAuth();
  const storageKey = `cryptotrace-chat:${user?.uid ?? "anon"}`;
  const [messages, setMessages] = useState<ChatMessage[]>(freshSession);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState<ChatAgent | "assistant" | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Seconds left on a rate limit. Held separately from `aiError` so it can count
  // down on its own without the message text being rewritten each tick.
  const [cooldown, setCooldown] = useState(0);
  const [evidence, setEvidence] = useState<EvidenceSummary | null>(null);
  // Which brain answered last. The API names the model on every AI-served reply
  // and omits it when the built-in engine stood in, so this is the one honest
  // place to say which of the two produced what is on screen.
  const [engine, setEngine] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Flipped true once the saved transcript has been read back (or found absent).
  // The save effect waits for it, so the empty default never overwrites a stored
  // conversation during that first render.
  const [hydrated, setHydrated] = useState(false);
  // Which storageKey the state currently in `messages` was loaded from.
  const hydratedKey = useRef<string | null>(null);

  // A static "wait 24 seconds" goes stale the moment it is read. Ticking it down
  // turns the same number into something the officer can act on — and it stops
  // on its own, so nothing needs clearing elsewhere.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Read the saved transcript back on mount, and only replace the default when a
  // non-empty conversation was actually stored.
  useEffect(() => {
    let restored = false;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as {
          messages?: ChatMessage[];
          evidence?: EvidenceSummary | null;
          engine?: string | null;
        };
        if (Array.isArray(saved.messages) && saved.messages.length) {
          setMessages(saved.messages);
          if (saved.evidence) setEvidence(saved.evidence);
          if (typeof saved.engine === "string") setEngine(saved.engine);
          restored = true;
        }
      }
    } catch {
      // A corrupt or unreadable cache should never take the console down with
      // it — fall back to the fresh session already in state.
    }
    if (!restored) {
      // Nothing stored for this officer. Clear rather than leave whatever the
      // previous session had on screen, which is what a sign-out/sign-in would
      // otherwise show.
      setMessages(freshSession());
      setEvidence(null);
      setEngine(null);
    }
    // A ref, not the `hydrated` flag alone: the save effect below runs in the
    // same commit as this one, and a state update wouldn't be visible to it yet.
    // Without this, switching officers writes the previous transcript straight
    // into the new officer's key before the load result lands.
    hydratedKey.current = storageKey;
    setHydrated(true);
  }, [storageKey]);

  // Write it back on every change, once hydration has run so we don't clobber a
  // stored conversation with the empty default on first paint.
  useEffect(() => {
    if (!hydrated || hydratedKey.current !== storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ messages, evidence, engine }));
    } catch {
      // Storage full or disabled (private mode) — persistence is best-effort.
    }
  }, [hydrated, messages, evidence, engine, storageKey]);

  // The wallet addresses this trace actually contains — from the transfers and
  // the resolved nodes. A "View on graph" button opens focused on whichever of
  // these an agent named. Longest first, so a full address wins over a prefix.
  const walletAddresses = useMemo(() => {
    const s = new Set<string>();
    for (const t of trace?.transfers ?? []) {
      if (t.from_address) s.add(t.from_address);
      if (t.to_address) s.add(t.to_address);
    }
    for (const n of trace?.nodes ?? []) {
      if (n.address) s.add(n.address);
    }
    return Array.from(s).sort((a, b) => b.length - a.length);
  }, [trace]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  async function send(text: string, forcedMode?: "casual" | "investigate") {
    if (!text.trim()) return;
    setAiError(null);
    setNotice(null);
    setCooldown(0);
    const time = nowLabel();
    setMessages((m) => [...m, { id: `u${Date.now()}`, role: "user", content: text, time }]);
    setInput("");
    setThinking("assistant");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          mode: forcedMode,
          // Send the whole TraceResult — the route analyses these transfers into
          // an evidence brief before the AI sees them, and it checks
          // context.transfers / context.nodes are arrays. A null trace is fine:
          // the route degrades to a "no trace loaded" verdict.
          context: trace,
          // Gemini accepts two roles, "user" and "model". A finished report is
          // stored locally as role "report"; passing that through verbatim gets
          // the turn rejected, so every follow-up is normalised to user/assistant
          // here. The route sanitises again on arrival.
          history: messages
            .filter((m) => m.role !== "system")
            .slice(-8)
            .map((m) => ({
              role: m.role === "user" ? "user" : "assistant",
              content: historyText(m),
            })),
        }),
      });

      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as {
          error?: string;
          retryAfter?: number;
        };
        // 429 is the rate limiter, and it sends the exact number of seconds left.
        // Starting the countdown here is what makes the message stay true while
        // it is on screen.
        if (res.status === 429 && typeof errData.retryAfter === "number") {
          setCooldown(errData.retryAfter);
        }
        throw new Error(errData.error || `API returned ${res.status}`);
      }

      const data = (await res.json()) as OkResponse;
      if (data.degraded) setNotice(data.degraded);
      setEngine(data.model ?? LOCAL_ENGINE);

      if (data.mode === "casual") {
        setThinking(null);
        setMessages((m) => [
          ...m,
          {
            id: `a${Date.now()}`,
            role: "assistant",
            content: data.reply ?? "…",
            suggestions: data.suggestions ?? [],
            time: nowLabel(),
          },
        ]);
        return;
      }

      // Investigate reply. Fold the trace summary into the rail and assemble the
      // four specialist panels in a fixed order so the breakdown always reads the
      // same way, whichever order the model returned them.
      if (data.evidence) setEvidence(data.evidence);

      const agentOrder: ChatAgent[] = [
        "Chain Analyst",
        "Attribution Analyst",
        "Compliance Officer",
        "Investigating Officer",
      ];
      const agents = data.agents ?? [];
      const panels: ChatAgentPanel[] = [];
      for (let i = 0; i < agentOrder.length; i++) {
        const agent = agentOrder[i];
        const resp =
          agents.find((a) => a.agent?.toLowerCase() === agent.toLowerCase()) ?? agents[i];
        if (!resp?.content) continue;
        panels.push({
          agent,
          headline: resp.headline,
          content: resp.content,
          findings: resp.findings ?? [],
          confidence: resp.confidence ?? 0.85,
        });
      }

      // Cycle the specialist names briefly so it still reads as a panel of four
      // working, then land the single summary.
      for (const p of panels) {
        setThinking(p.agent);
        await new Promise((r) => setTimeout(r, 240));
      }
      setThinking(null);

      setMessages((m) => [
        ...m,
        {
          id: `r${Date.now()}`,
          role: "report",
          content: data.verdict?.headline ?? "Investigation complete.",
          verdict: data.verdict,
          panels,
          suggestions: data.suggestions ?? [],
          time: nowLabel(),
        },
      ]);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "Failed to reach the investigator");
    } finally {
      setThinking(null);
    }
  }

  return (
    <Page fill>
      {/* Explicit column tracks: a fixed rail and a fluid transcript. Below lg
          the grid takes its content height and the page scrolls; at lg and up the
          transcript scrolls inside a window-height column. */}
      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[320px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)]">
        {/* Left rail */}
        <aside className="space-y-4 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          {/* Agent Fleet */}
          <div className="rounded-2xl p-4 border" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
            <div className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Agent Fleet</div>
            <div className="mt-1 text-[15px] font-semibold" style={{ color: "var(--text-strong)" }}>4 specialists · collaborating</div>
            <div className="mt-3 space-y-2">
              {(Object.keys(AGENT_META) as ChatAgent[]).map((a) => {
                const m = AGENT_META[a];
                return (
                  <div key={a} className="flex items-start gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                    <span className="grid place-items-center w-8 h-8 rounded-md text-[14px]" style={{ background: m.bg, color: m.color }}>
                      {m.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-[13px] truncate" style={{ color: "var(--text-strong)" }}>{a}</div>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.color, boxShadow: `0 0 8px ${m.color}` }} />
                      </div>
                      <div className="text-[11.5px]" style={{ color: "var(--muted-2)" }}>{m.role}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => send("Run a full forensic investigation of this wallet trace.", "investigate")}
              disabled={!!thinking}
              className="mt-3 w-full rounded-lg border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 px-3 py-2 text-[12.5px] font-medium shadow-glow transition disabled:opacity-50"
            >
              ⚡ Run full investigation
            </button>
          </div>

          {/* Suggested queries */}
          <div className="rounded-2xl p-4 border" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
            <div className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Try asking</div>
            <div className="mt-3 flex flex-col gap-2">
              {SUGGESTED_QUERIES.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  disabled={!!thinking}
                  className="text-left text-[12.5px] rounded-lg border px-3 py-2 hover:bg-[var(--hover)] disabled:opacity-50"
                  style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          {/* Session context */}
          <div className="rounded-2xl p-4 border" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
            <div className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>Session context</div>
            <div className="mt-2 space-y-1.5 text-[12px]">
              <ContextRow k="Transfers" v={String(trace?.transfers.length ?? 0)} />
              {evidence ? (
                <>
                  <ContextRow k="Wallets traced" v={String(evidence.walletCount)} />
                  <ContextRow k="Exchanges reached" v={String(evidence.vaspCount)} />
                  <ContextRow k="Hard findings" v={String(evidence.findingCount)} />
                  <ContextRow k="High-risk wallets" v={String(evidence.highCount)} />
                </>
              ) : (
                <ContextRow k="Analysis" v="not run yet" />
              )}
              <ContextRow k="Model" v={engineLabel(engine)} title={engine ?? undefined} mono />
            </div>
          </div>
        </aside>

        {/* Chat surface */}
        {/* order-first below lg: in a single column the rail's cards are tall, so
            the conversation would start below a screen of scrolling. lg:order-none
            restores source order. */}
        <section className="order-first flex min-w-0 flex-col lg:order-none lg:min-h-0">
          <div className="flex min-h-[520px] flex-1 flex-col overflow-hidden rounded-2xl border" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
            <div className="shrink-0 px-4 py-3 border-b flex flex-wrap items-center justify-between gap-3" style={{ borderColor: "var(--border)" }}>
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid place-items-center w-8 h-8 shrink-0 rounded-md bg-emerald-500/15 text-emerald-300 shadow-glow">◉</div>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium" style={{ color: "var(--text-strong)" }}>Investigator Console</div>
                  <div className="text-[11px] truncate" style={{ color: "var(--muted-2)" }}>Answers synthesized across 4 agents · confidence-weighted</div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => {
                    const txt = messages.map((m) => `[${m.time}] ${m.role === "agent" ? m.agent : m.role}: ${m.content}`).join("\n");
                    const blob = new Blob([txt], { type: "text/plain" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url; a.download = "cryptotrace-transcript.txt"; a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="text-[11px] rounded-md border px-2 py-1 hover:bg-[var(--hover)]"
                  style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" }}
                >
                  Export transcript
                </button>
                <button
                  onClick={() => {
                    setMessages([{ id: "m0", role: "system", content: "Session reset", time: nowLabel() }]);
                    setEvidence(null);
                    setEngine(null);
                  }}
                  className="text-[11px] rounded-md border px-2 py-1 hover:bg-[var(--hover)]"
                  style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" }}
                >
                  Reset session
                </button>
              </div>
            </div>

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-5 space-y-4">
              {messages.map((m) => (
                <Message
                  key={m.id}
                  m={m}
                  wallets={walletAddresses}
                  onOpenGraph={onOpenGraph}
                  onAsk={(q) => send(q)}
                  busy={!!thinking}
                />
              ))}
              {thinking && (
                <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--muted)" }}>
                  <span
                    className="w-2 h-2 rounded-full animate-blink"
                    style={{ background: thinking === "assistant" ? "#22c55e" : AGENT_META[thinking as ChatAgent].color }}
                  />
                  <span style={{ color: thinking === "assistant" ? "#22c55e" : AGENT_META[thinking as ChatAgent].color }}>
                    {thinking === "assistant" ? "Assistant" : thinking}
                  </span>
                  <span>is analyzing</span>
                  <span className="inline-flex gap-0.5">
                    <span className="w-1 h-1 rounded-full bg-slate-400 animate-blink" />
                    <span className="w-1 h-1 rounded-full bg-slate-400 animate-blink" style={{ animationDelay: "200ms" }} />
                    <span className="w-1 h-1 rounded-full bg-slate-400 animate-blink" style={{ animationDelay: "400ms" }} />
                  </span>
                </div>
              )}
              {notice && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-200">
                  {notice}
                </div>
              )}
              {aiError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
                  {/* While a cooldown is running the ticking figure is the more
                      useful of the two, so it replaces the seconds baked into the
                      server's sentence. */}
                  {cooldown > 0
                    ? aiError.replace(/\d+ seconds?/, `${cooldown} second${cooldown === 1 ? "" : "s"}`)
                    : aiError}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t p-3" style={{ borderColor: "var(--border)" }}>
              <div className="rounded-xl px-3 py-2 flex items-center gap-2 border" style={{ background: "var(--chip)", borderColor: "var(--border)" }}>
                <span className="text-[13px] font-mono" style={{ color: "var(--muted-2)" }}>›</span>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  placeholder='Ask "Why is this wallet high risk?" or "Which exchange do we freeze first?"'
                  className="min-w-0 flex-1 bg-transparent outline-none text-[13.5px]"
                  style={{ color: "var(--text)" }}
                  disabled={!!thinking}
                />
                <span className="hidden md:inline text-[10.5px] rounded px-1.5 py-0.5 font-mono border" style={{ background: "var(--chip)", borderColor: "var(--border)", color: "var(--muted)" }}>
                  ⏎ send
                </span>
                <button
                  onClick={() => send(input)}
                  disabled={!!thinking}
                  className="rounded-md border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 text-[12.5px] px-3 py-1.5 shadow-glow disabled:opacity-50"
                >
                  Ask fleet
                </button>
              </div>
              {trace ? (
                <div className="mt-2 flex items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
                  <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-emerald-400 animate-blink" />
                  Answers are grounded in the {trace.transfers.length} on-chain transfers in this trace — no generic advice.
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
                  <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-amber-400 animate-blink" />
                  No case loaded yet — trace a victim-reported wallet in{" "}
                  <span style={{ color: "var(--text)" }}>Trace Wallet</span> to ground answers, or ask anyway for general guidance.
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </Page>
  );
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// The opening state of a brand-new console — one system line, no history. Used
// for the initial render and by "Reset session".
function freshSession(): ChatMessage[] {
  return [
    {
      id: "m0",
      role: "system",
      content: "Session opened — ask a question, or run a full investigation.",
      time: nowLabel(),
    },
  ];
}

// What an earlier bubble contributes to the next turn. A report's own `content`
// is only its headline, so the verdict points and named wallets travel with it —
// otherwise a follow-up like "which exchange should we serve first?" is answered
// by a model that cannot see what the investigation just found.
function historyText(m: ChatMessage): string {
  const base = m.content ?? "";
  if (m.role !== "report" || !m.verdict) return base;
  const points = (m.verdict.points ?? []).slice(0, 4).map((p) => `• ${p}`).join("\n");
  const accounts = (m.verdict.accounts ?? []).slice(0, 10).join(", ");
  return [base, points, accounts && `Wallets implicated: ${accounts}`]
    .filter(Boolean)
    .join("\n");
}

function ContextRow({ k, v, mono, title }: { k: string; v: string; mono?: boolean; title?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span style={{ color: "var(--muted-2)" }}>{k}</span>
      <span
        className={`min-w-0 truncate ${mono ? "font-mono" : ""}`}
        title={title}
        style={{ color: "var(--text)" }}
      >
        {v}
      </span>
    </div>
  );
}

function Message({
  m,
  wallets,
  onOpenGraph,
  onAsk,
  busy,
}: {
  m: ChatMessage;
  wallets: string[];
  onOpenGraph: (accounts: string[]) => void;
  onAsk: (q: string) => void;
  busy: boolean;
}) {
  if (m.role === "system") {
    return (
      <div className="text-center">
        <span
          className="inline-block text-[11px] rounded-full border px-2.5 py-1 font-mono"
          style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--muted)" }}
        >
          {m.content}
        </span>
      </div>
    );
  }
  if (m.role === "user") {
    return (
      <div className="flex items-start gap-3 justify-end">
        <div
          className="max-w-[80%] xl:max-w-[72ch] rounded-2xl rounded-tr-sm border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-[13.5px] leading-relaxed"
          style={{ color: "var(--text)" }}
        >
          {m.content}
          <div className="mt-1 text-[10px] font-mono" style={{ color: "var(--muted)" }}>{m.time}</div>
        </div>
        <div className="w-8 h-8 shrink-0 rounded-full bg-gradient-to-br from-sky-400 to-indigo-500 grid place-items-center text-[11px] font-bold text-white">U</div>
      </div>
    );
  }
  if (m.role === "report") {
    return <ReportMessage m={m} onOpenGraph={onOpenGraph} onAsk={onAsk} busy={busy} />;
  }
  if (m.role === "assistant") {
    // Wallets this reply actually named — the graph opens focused on those.
    const named = wallets.filter((a) => m.content.includes(a)).slice(0, 12);
    return (
      <div className="flex items-start gap-3">
        <div
          className="w-8 h-8 shrink-0 rounded-md grid place-items-center text-[14px] bg-emerald-500/15 text-emerald-300"
          style={{ boxShadow: "0 0 12px rgba(34,197,94,0.45)" }}
        >
          ◉
        </div>
        <div className="max-w-[82%] xl:max-w-[88ch] min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Assistant
            </span>
            <span className="text-[10.5px] font-mono" style={{ color: "var(--muted-2)" }}>{m.time}</span>
          </div>
          <div
            className="mt-1 rounded-2xl rounded-tl-sm border px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap"
            style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" }}
          >
            {m.content}
          </div>
          {(named.length > 0 || !!m.suggestions?.length) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {named.length > 0 && (
                <button
                  onClick={() => onOpenGraph(named)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11.5px] text-emerald-300 transition hover:bg-emerald-500/20"
                >
                  ◈ View on graph
                  <span style={{ color: "var(--muted-2)" }}>· {named.length}</span>
                </button>
              )}
              {m.suggestions?.map((q) => (
                <button
                  key={q}
                  onClick={() => onAsk(q)}
                  disabled={busy}
                  className="rounded-md border px-2.5 py-1 text-[11.5px] transition hover:bg-[var(--hover)] disabled:opacity-40"
                  style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--muted)" }}
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  // role === "agent" — a single specialist bubble (kept for any transcript that
  // stored one; reports fold their panels inside ReportMessage instead).
  const meta = AGENT_META[m.agent!];
  const mentioned = wallets
    .filter((a) => `${m.headline ?? ""} ${m.content} ${(m.findings ?? []).join(" ")}`.includes(a))
    .slice(0, 12);
  return (
    <div className="flex items-start gap-3">
      <div
        className="w-8 h-8 rounded-md grid place-items-center text-[14px] shrink-0"
        style={{ background: meta.bg, color: meta.color, boxShadow: `0 0 12px ${meta.color}55` }}
      >
        {meta.icon}
      </div>
      <div className="max-w-[88%] xl:max-w-[104ch] min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]"
            style={{ borderColor: `${meta.color}55`, background: meta.bg, color: meta.color }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: meta.color }} />
            {m.agent}
          </span>
          <span className="text-[10.5px] font-mono" style={{ color: "var(--muted-2)" }}>{m.time}</span>
          {typeof m.confidence === "number" && (
            <span
              className="text-[10.5px] rounded px-1.5 py-0.5 font-mono border"
              style={{ background: "var(--chip)", borderColor: "var(--border)", color: "var(--text)" }}
            >
              conf {m.confidence.toFixed(2)}
            </span>
          )}
        </div>
        <div
          className="mt-1 rounded-2xl rounded-tl-sm border px-4 py-3"
          style={{ borderColor: "var(--border)", background: "var(--chip)" }}
        >
          {m.headline && (
            <div
              className="text-[14px] font-semibold leading-snug pb-2 mb-2 border-b"
              style={{ color: meta.color, borderColor: "var(--border)" }}
            >
              {m.headline}
            </div>
          )}
          <div className="space-y-2 text-[13.5px] leading-relaxed" style={{ color: "var(--text)" }}>
            {m.content.split(/\n{2,}/).map((para, i) => (
              <Paragraph key={i} text={para} />
            ))}
          </div>
          {!!m.findings?.length && (
            <div className="mt-3 pt-2.5 border-t space-y-1.5" style={{ borderColor: "var(--border)" }}>
              <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
                Key evidence
              </div>
              {m.findings.map((f, i) => (
                <div key={i} className="flex gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
                  <span style={{ color: meta.color }}>▸</span>
                  <span className="flex-1">{renderBold(f)}</span>
                </div>
              ))}
            </div>
          )}
          {mentioned.length > 0 && (
            <div className="mt-3 pt-2.5 border-t" style={{ borderColor: "var(--border)" }}>
              <button
                onClick={() => onOpenGraph(mentioned)}
                className="inline-flex items-center gap-1.5 text-[11.5px] rounded-md border px-2.5 py-1 hover:bg-[var(--hover)] transition"
                style={{ borderColor: `${meta.color}55`, background: meta.bg, color: meta.color }}
              >
                ◈ View on graph
                <span style={{ color: "var(--muted-2)" }}>
                  · {mentioned.length} {mentioned.length === 1 ? "wallet" : "wallets"}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// The investigation reply. Deliberately one short card: a verdict, the few facts
// behind it, and a toggle. The four specialists' full write-ups are still here —
// they are just not the first thing you have to read.
const LEVEL_TEXT = { high: "High risk", medium: "Needs a look", safe: "Clear" } as const;

function ReportMessage({
  m,
  onOpenGraph,
  onAsk,
  busy,
}: {
  m: ChatMessage;
  onOpenGraph: (accounts: string[]) => void;
  onAsk: (q: string) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const v: ChatVerdict | undefined = m.verdict;
  const level = v?.level ?? "high";
  const tone = severityColor(level);
  const panels = m.panels ?? [];
  const accounts = v?.accounts ?? [];

  return (
    <div className="flex items-start gap-3">
      <div
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[14px]"
        style={{ background: `${tone}1F`, color: tone, boxShadow: `0 0 12px ${tone}55` }}
      >
        ⚡
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]"
            style={{ borderColor: `${tone}55`, background: `${tone}14`, color: tone }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
            {LEVEL_TEXT[level]}
          </span>
          <span className="text-[10.5px] font-mono" style={{ color: "var(--muted-2)" }}>
            {m.time} · {panels.length} specialists agreed
          </span>
        </div>

        <div
          className="mt-1 rounded-2xl rounded-tl-sm border px-4 py-3"
          style={{ borderColor: `${tone}3D`, background: "var(--chip)" }}
        >
          <div className="text-[14.5px] font-semibold leading-snug" style={{ color: "var(--text-strong)" }}>
            {v?.headline ?? m.content}
          </div>
          {!!v?.points.length && (
            <ul className="mt-2.5 space-y-1.5">
              {v.points.map((p, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-relaxed" style={{ color: "var(--text)" }}>
                  <span style={{ color: tone }}>▸</span>
                  <span className="flex-1">{renderBold(p)}</span>
                </li>
              ))}
            </ul>
          )}
          {(accounts.length > 0 || panels.length > 0) && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-2.5" style={{ borderColor: "var(--border)" }}>
              {accounts.length > 0 && (
                <button
                  onClick={() => onOpenGraph(accounts)}
                  className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] transition hover:opacity-80"
                  style={{ borderColor: `${tone}55`, background: `${tone}14`, color: tone }}
                >
                  ◈ View these wallets on the graph
                  <span style={{ color: "var(--muted-2)" }}>· {accounts.length}</span>
                </button>
              )}
              {panels.length > 0 && (
                <button
                  onClick={() => setOpen((o) => !o)}
                  className="rounded-md border px-2.5 py-1 text-[11.5px] transition hover:bg-[var(--hover)]"
                  style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" }}
                >
                  {open ? "▴ Hide the full breakdown" : `▾ Full breakdown (${panels.length} agents)`}
                </button>
              )}
            </div>
          )}
        </div>

        {open && (
          <div className="mt-2 space-y-2">
            {panels.map((p) => (
              <AgentPanel key={p.agent} p={p} />
            ))}
          </div>
        )}

        {!!m.suggestions?.length && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.suggestions.map((q) => (
              <button
                key={q}
                onClick={() => onAsk(q)}
                disabled={busy}
                className="rounded-md border px-2.5 py-1 text-[11.5px] transition hover:bg-[var(--hover)] disabled:opacity-40"
                style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--muted)" }}
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentPanel({ p }: { p: ChatAgentPanel }) {
  const meta = AGENT_META[p.agent];
  return (
    <details
      className="rounded-xl border px-3 py-2.5"
      style={{ borderColor: "var(--border)", background: "var(--bg)" }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <span
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-[11px]"
          style={{ background: meta.bg, color: meta.color }}
        >
          {meta.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium" style={{ color: meta.color }}>
            {p.agent}
          </span>
          {p.headline && (
            <span className="block truncate text-[11.5px]" style={{ color: "var(--muted)" }}>
              {p.headline}
            </span>
          )}
        </span>
        {typeof p.confidence === "number" && (
          <span className="shrink-0 font-mono text-[10.5px]" style={{ color: "var(--muted-2)" }}>
            {p.confidence.toFixed(2)}
          </span>
        )}
      </summary>
      <div className="mt-2.5 space-y-2 border-t pt-2.5 text-[13px] leading-relaxed" style={{ borderColor: "var(--border)", color: "var(--text)" }}>
        {p.content.split(/\n{2,}/).map((para, i) => (
          <Paragraph key={i} text={para} />
        ))}
        {!!p.findings?.length && (
          <div className="space-y-1.5 border-t pt-2" style={{ borderColor: "var(--border)" }}>
            <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
              Key evidence
            </div>
            {p.findings.map((f, i) => (
              <div key={i} className="flex gap-2 text-[12.5px]">
                <span style={{ color: meta.color }}>▸</span>
                <span className="flex-1">{renderBold(f)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

// Agents write short markdown — bullet lines, numbered steps and **bold**.
// Render just those three, so the copy stays readable without a md library.
const BULLET = /^\s*([•\-*]|\d+\.)\s/;

function Paragraph({ text }: { text: string }) {
  // A bullet may carry its explanation on the next, indented line. Fold those
  // back into their bullet so one long finding still renders as one list item.
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    if (BULLET.test(raw) || !lines.length) lines.push(raw.trim());
    else lines[lines.length - 1] += ` ${raw.trim()}`;
  }
  const isList = lines.length > 1 && lines.every((l) => BULLET.test(l));

  if (isList) {
    return (
      <ul className="space-y-2">
        {lines.map((l, i) => {
          const numbered = l.match(/^\s*(\d+)\.\s*(.*)$/);
          const body = numbered ? numbered[2] : l.replace(/^\s*[•\-*]\s*/, "");
          return (
            <li key={i} className="flex gap-2">
              <span className="font-mono text-[12px] shrink-0" style={{ color: "var(--muted)" }}>
                {numbered ? `${numbered[1]}.` : "•"}
              </span>
              <span className="flex-1">{renderBold(body)}</span>
            </li>
          );
        })}
      </ul>
    );
  }

  return <p>{renderBold(text.replace(/\n/g, " "))}</p>;
}

function renderBold(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} style={{ color: "var(--text-strong)" }}>
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}
