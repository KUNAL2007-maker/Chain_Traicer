"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { CommandDashboard } from "./views/CommandDashboard";
import { UploadView } from "./views/UploadView";
import { InvestigatorChat } from "./views/InvestigatorChat";
import { SARReports } from "./views/SARReports";
import { TransactionsView } from "./views/TransactionsView";
import { GraphView } from "./views/GraphView";

export type ViewKey = "dashboard" | "transactions" | "graph" | "upload" | "chat" | "sar";

export function AppShell() {
  const [view, setView] = useState<ViewKey>("dashboard");
  const [liveFeed, setLiveFeed] = useState(false);
  // Mobile only: the sidebar is an off-canvas drawer below lg, so it needs an
  // open/closed state. At lg and up the rail is static and this is inert.
  const [navOpen, setNavOpen] = useState(false);
  // Accounts an agent named in the chat, so "View on graph" lands on the right
  // part of the canvas instead of the whole network.
  const [graphFocus, setGraphFocus] = useState<string[]>([]);

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
    // the full document height, so the sign-out chip it pins to the bottom ended
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
          {view === "dashboard" && <CommandDashboard liveFeed={liveFeed} />}
          {view === "transactions" && <TransactionsView />}
          {view === "graph" && (
            <GraphView
              focusAccounts={graphFocus}
              onClearFocus={() => setGraphFocus([])}
              onOpenSAR={() => setView("sar")}
            />
          )}
          {view === "upload" && <UploadView onDone={() => setView("dashboard")} />}
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
          {view === "sar" && <SARReports />}
        </main>
      </div>
    </div>
  );
}
