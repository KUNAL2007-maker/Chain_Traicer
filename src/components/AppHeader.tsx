"use client";

import { useTheme } from "@/components/ThemeProvider";

// The top bar. Kept deliberately thin in this pass — a wordmark, the problem-
// statement tag so anyone opening the console knows what it is, and the theme
// toggle. The rich sidebar / multi-view chrome is Pass 2.
export function AppHeader() {
  const { theme, toggle } = useTheme();
  return (
    <header
      className="sticky top-0 z-30 glass"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="mx-auto w-full max-w-[1760px] px-4 sm:px-5 2xl:px-8 h-14 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="grid place-items-center w-8 h-8 rounded-lg shrink-0 text-black font-bold"
            style={{ background: "linear-gradient(135deg,#22c55e,#10b981)" }}
          >
            ⛓
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight" style={{ color: "var(--text-strong)" }}>
              CryptoTrace
            </div>
            <div className="text-[10px] uppercase tracking-widest truncate" style={{ color: "var(--muted)" }}>
              SIH26183 · MHA / I4C · Blockchain Forensics
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden md:inline text-[11px]" style={{ color: "var(--muted)" }}>
            Fraud-linked exchange identification from victim-reported wallets
          </span>
          <button
            onClick={toggle}
            className="text-xs px-2.5 py-1.5 rounded-lg border hover:opacity-80 transition"
            style={{ borderColor: "var(--border)", color: "var(--muted)" }}
            aria-label="Toggle colour theme"
          >
            {theme === "dark" ? "☀ Light" : "🌙 Dark"}
          </button>
        </div>
      </div>
    </header>
  );
}
