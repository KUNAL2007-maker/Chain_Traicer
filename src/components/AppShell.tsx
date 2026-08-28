"use client";

import { useEffect, useRef, useState } from "react";
import { useTraceStore } from "@/lib/store";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { CommandDashboard } from "./views/CommandDashboard";
import { TransfersView } from "./views/TransfersView";
import { GraphView } from "./views/GraphView";
import { TraceWalletView } from "./views/TraceWalletView";
import { InvestigatorChat } from "./views/InvestigatorChat";
import { LegalNoticesView } from "./views/LegalNoticesView";

export type ViewKey = "dashboard" | "transfers" | "graph" | "trace" | "chat" | "notices";

/**
 * How often the live feed re-walks the current seed.
 *
 * Chain data does not move fast enough to justify anything tighter, and every
 * poll costs explorer-API quota against a free tier shared with actual tracing.
 */
const LIVE_POLL_MS = 60_000;

export function AppShell() {
  const [view, setView] = useState<ViewKey>("dashboard");
  const [liveFeed, setLiveFeed] = useState(false);
  // Mobile only: the sidebar is an off-canvas drawer below lg, so it needs an
  // open/closed state. At lg and up the rail is static and this is inert.
  const [navOpen, setNavOpen] = useState(false);
  // Wallets an agent named in the chat, so "View on graph" lands on the right
  // part of the canvas instead of the whole network.
  const [graphFocus, setGraphFocus] = useState<string[]>([]);

  // ── Live feed ─────────────────────────────────────────────────────────────
  // The toggle used to be decorative: it only animated a couple of status dots.
  // It now drives a real poll, off by default so an unattended tab never burns
  // API quota on its own.
  const { trace, status, refreshTrace } = useTraceStore();
  const hasTrace = !!trace;

  // Held in a ref so the interval below doesn't depend on refreshTrace's
  // identity — it changes whenever the trace or case metadata does, which would
  // otherwise tear down and restart the timer on every keystroke in a case field.
  const refresh = useRef(refreshTrace);
  useEffect(() => {
    refresh.current = refreshTrace;
  }, [refreshTrace]);

  useEffect(() => {
    if (!liveFeed || !hasTrace || status !== "ready") return;
    // Poll once on switch-on so the toggle visibly does something, then settle
    // into the interval. The tracer's per-address cache absorbs this if the
    // trace was only just run.
    void refresh.current();
    const id = setInterval(() => void refresh.current(), LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [liveFeed, hasTrace, status]);

  // The transcript lives in the chat component's own state, so unmounting it on
  // every tab switch threw the conversation away. Once opened it stays mounted
  // and is only hidden — an answer that arrives while you are on another tab is
  // still waiting when you come back.
  const [chatMounted, setChatMounted] = useState(false);
  useEffect(() => {
    if (view === "chat") setChatMounted(true);
  }, [view]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    // A fixed-height shell, not `min-h-screen`. With min-height the aside grew to
    // the full document height, so the officer chip it pins to the bottom ended
    // up thousands of pixels down a long dashboard, and `overflow-auto` on <main>
    // was inert because main had no height to overflow. Now the frame is exactly
    // one viewport, the rails stay put, and main is the only thing that scrolls.
    // 100dvh rather than h-screen: on a phone `vh` resolves against the *large*
    // viewport, so the bottom of the app sat under the browser's address bar.
    // dvh tracks the visible box and is identical to vh on desktop.
    // backgroundColor, not the `background` shorthand — the shorthand would reset
    // background-image and wipe out `radial-glow`.
    <div className="flex h-[100dvh] overflow-hidden radial-glow" style={{ backgroundColor: "var(--bg)" }}>
      <Sidebar view={view} onChange={setView} open={navOpen} onClose={() => setNavOpen(false)} />
      {/* Backdrop for the mobile drawer. lg:hidden so it can never appear on
          desktop, where navOpen is never set in the first place. */}
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          view={view}
          liveFeed={liveFeed}
          onToggleFeed={() => setLiveFeed((v) => !v)}
          onOpenNav={() => setNavOpen(true)}
        />
        <main className="flex-1 min-h-0 min-w-0 overflow-y-auto scroll-stable">
          {view === "dashboard" && (
            <CommandDashboard liveFeed={liveFeed} onGoToTrace={() => setView("trace")} />
          )}
          {view === "transfers" && <TransfersView onGoToTrace={() => setView("trace")} />}
          {view === "graph" && (
            <GraphView
              focusAccounts={graphFocus}
              onClearFocus={() => setGraphFocus([])}
              onOpenNotices={() => setView("notices")}
              onGoToTrace={() => setView("trace")}
            />
          )}
          {view === "trace" && <TraceWalletView onDone={() => setView("dashboard")} />}
          {chatMounted && (
            <div hidden={view !== "chat"} className="h-full">
              <InvestigatorChat
                onOpenGraph={(accounts) => {
                  setGraphFocus(accounts);
                  setView("graph");
                }}
              />
            </div>
          )}
          {view === "notices" && <LegalNoticesView onGoToTrace={() => setView("trace")} />}
        </main>
      </div>
    </div>
  );
}
