"use client";

import { useTheme } from "./ThemeProvider";
import { PAGE_GUTTER } from "./ui/Page";
import type { ViewKey } from "./AppShell";

const VIEW_TITLES: Record<ViewKey, { title: string; sub: string }> = {
  dashboard: { title: "Command Dashboard", sub: "Overview & signals" },
  transactions: { title: "Transactions", sub: "Browse, search, and filter" },
  graph: { title: "Interactive Transaction Graph", sub: "Multi-bank flow topology · anonymized handles" },
  upload: { title: "Upload CSV", sub: "Import transactions from a CSV file" },
  chat: { title: "Multi-Agent AI Investigator", sub: "Ask in natural language · 4 specialist agents online" },
  sar: { title: "Compliance Reports · SAR Builder", sub: "Draft & export suspicious activity reports" },
};

export function TopBar({
  view,
  liveFeed,
  onToggleFeed,
  onOpenNav,
}: {
  view: ViewKey;
  liveFeed: boolean;
  onToggleFeed: () => void;
  onOpenNav?: () => void;
}) {
  const { theme, toggle } = useTheme();
  const { title, sub } = VIEW_TITLES[view];

  return (
    <header
      className="shrink-0 z-20 border-b backdrop-blur"
      style={{ borderColor: "var(--border)", background: "var(--panel-strong)" }}
    >
      {/* Same max-width and gutters as <Page>, so the view title sits exactly
          above the left edge of the cards it belongs to instead of floating
          20-odd pixels off on a wide monitor. */}
      <div className={`mx-auto w-full max-w-[1760px] ${PAGE_GUTTER} flex items-center gap-2 sm:gap-4 py-3`}>
        {/* Opens the off-canvas nav. lg:hidden, and the sidebar is a static rail
            from lg up, so this never renders on a laptop or desktop. */}
        <button
          onClick={onOpenNav}
          aria-label="Open navigation"
          aria-controls="app-nav"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border transition hover:bg-[var(--hover)] lg:hidden"
          style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>

        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-[11px] uppercase tracking-widest truncate" style={{ color: "var(--muted)" }}>
              FinGuard Intelligence
            </div>
            {/* sm:, not a custom xs: — this config defines no xs breakpoint, so
                an xs: variant would never match and the badge would vanish on
                desktop too. */}
            <span className="hidden sm:inline text-[10px] rounded px-1.5 py-0.5 bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
              SECURE
            </span>
          </div>
          {/* sm:text-[18px], not sm:text-lg — text-lg also carries
              line-height:1.75rem, and inside the sm: media query that would beat
              the base leading-tight and make the whole header 5px taller than it
              is today. An arbitrary size sets font-size only. */}
          <div className="mt-0.5 text-[15px] sm:text-[18px] font-semibold leading-tight truncate" style={{ color: "var(--text-strong)" }}>
            {title}
          </div>
          <div className="hidden sm:block text-[12px] truncate" style={{ color: "var(--muted-2)" }}>{sub}</div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2.5">
          {/* Live feed toggle. Below sm the label drops and the status dot alone
              carries the state, so the two chips still fit a 360px screen. */}
          <button
            onClick={onToggleFeed}
            aria-pressed={liveFeed}
            title={liveFeed ? "Live feed · ON" : "Live feed · paused"}
            className={`flex h-9 items-center gap-2 whitespace-nowrap rounded-lg border px-2.5 sm:px-3 transition ${
              liveFeed
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200 shadow-glow"
                : "hover:bg-[var(--hover)]"
            }`}
            style={!liveFeed ? { borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" } : undefined}
          >
            <span className={`h-2 w-2 rounded-full ${liveFeed ? "bg-emerald-400 animate-blink" : "bg-slate-500"}`} />
            <span className="hidden sm:inline text-[12px]">{liveFeed ? "Live feed · ON" : "Live feed · paused"}</span>
          </button>

          {/* Theme toggle */}
          <button
            onClick={toggle}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 sm:px-3 transition hover:bg-[var(--hover)]"
            style={{ borderColor: "var(--border)", background: "var(--chip)", color: "var(--text)" }}
          >
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1.6" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            )}
            <span className="hidden sm:inline text-[12px]">{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
