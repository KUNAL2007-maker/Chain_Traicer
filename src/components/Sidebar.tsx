"use client";

import { useAuth } from "./AuthProvider";
import type { ViewKey } from "./AppShell";

const NAV: { key: ViewKey; label: string; hint: string; icon: React.ReactNode }[] = [
  {
    key: "dashboard",
    label: "Command Dashboard",
    hint: "Overview & signals",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M3 12h4l3-8 4 16 3-8h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: "transactions",
    label: "Transactions",
    hint: "Browse & filter",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "graph",
    label: "Transaction Graph",
    hint: "Network canvas",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <circle cx="5" cy="6" r="2" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="19" cy="6" r="2" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="12" cy="13" r="2" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="6" cy="19" r="2" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="18" cy="19" r="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.5 7.5L11 12M17.5 7.5L13 12M11 14L7 18M13 14l4 4" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ),
  },
  {
    key: "upload",
    label: "Upload CSV",
    hint: "Import data",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M12 3v12M8 7l4-4 4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: "chat",
    label: "AI Investigator",
    hint: "Multi-agent chat",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M4 6h16v10H8l-4 3V6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="9" cy="11" r="1" fill="currentColor" />
        <circle cx="12" cy="11" r="1" fill="currentColor" />
        <circle cx="15" cy="11" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: "sar",
    label: "Compliance / SAR",
    hint: "Auto reports",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M7 3h8l4 4v14H7V3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M15 3v5h4M9 12h6M9 16h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function Sidebar({
  view,
  onChange,
  open = false,
  onClose,
}: {
  view: ViewKey;
  onChange: (v: ViewKey) => void;
  open?: boolean;
  onClose?: () => void;
}) {
  const { user, signOut } = useAuth();
  const initials = user?.fullName
    ? user.fullName.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2)
    : "FG";

  return (
    // Below lg this is an off-canvas drawer: `fixed` takes it out of the shell's
    // flex row, so the content pane gets the whole screen instead of the ~110px
    // a 256px rail leaves on a 375px phone. From lg up every class is restored
    // by the lg: variants — position, width and transform all match the original
    // static rail, so the desktop layout is byte-identical to before.
    <aside
      id="app-nav"
      aria-label="Main navigation"
      className={`fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-[272px] shrink-0 flex-col border-r transition-transform duration-300 lg:static lg:z-auto lg:h-full lg:w-64 lg:translate-x-0 lg:transition-none 2xl:w-72 ${
        open ? "translate-x-0 shadow-2xl" : "-translate-x-full"
      }`}
      style={{ borderColor: "var(--border)", background: "var(--panel)" }}
    >
      <div className="px-5 pt-5 pb-4 flex items-center gap-3">
        <div className="relative w-9 h-9 shrink-0 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-700 grid place-items-center shadow-glow">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z" stroke="#052e1a" strokeWidth="1.6" strokeLinejoin="round" fill="rgba(255,255,255,0.15)" />
            <path d="M9 12l2 2 4-4" stroke="#052e1a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-wide truncate" style={{ color: "var(--text-strong)" }}>
            FinGuard <span className="text-emerald-400">Intelligence</span>
          </div>
          <div className="text-[10px] uppercase tracking-widest truncate" style={{ color: "var(--muted)" }}>
            Consortium AML Console
          </div>
        </div>
        {/* Only reachable while the drawer is open, so it never shows on desktop. */}
        <button
          onClick={onClose}
          aria-label="Close navigation"
          className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-md border transition hover:bg-[var(--hover)] lg:hidden"
          style={{ borderColor: "var(--border)", color: "var(--muted)" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="h-px shrink-0" style={{ background: "var(--border)" }} />

      {/* The nav is the part that gives if the window is short — the brand above
          and the account chip below stay visible. */}
      <nav className="p-3 flex flex-col gap-1 overflow-y-auto">
        {NAV.map((item) => {
          const active = view === item.key;
          return (
            <button
              key={item.key}
              onClick={() => {
                onChange(item.key);
                onClose?.();     // a tap on mobile should reveal the view it opened
              }}
              aria-current={active ? "page" : undefined}
              className={`group relative w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all ${
                active
                  ? "bg-emerald-500/10 border border-emerald-500/30 shadow-glow"
                  : "border border-transparent hover:bg-[var(--hover)]"
              }`}
              style={{ color: active ? "var(--text-strong)" : "var(--muted)" }}
            >
              <span
                className={`grid place-items-center w-8 h-8 shrink-0 rounded-md ${active ? "bg-emerald-500/15 text-emerald-300" : ""}`}
                style={!active ? { background: "var(--chip)" } : undefined}
              >
                {item.icon}
              </span>
              <span className="flex-1 min-w-0">
                <div className="text-sm font-medium leading-tight truncate">{item.label}</div>
                <div className="text-[11px] truncate" style={{ color: "var(--muted-2)" }}>{item.hint}</div>
              </span>
              {active && <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-emerald-400 shadow-glow" />}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto p-4 shrink-0">
        {/* Auth user chip */}
        <div className="rounded-xl p-3 border flex items-center gap-2" style={{ background: "var(--chip)", borderColor: "var(--border)" }}>
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-sky-400 to-indigo-500 grid place-items-center text-[11px] font-semibold text-white">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] truncate" style={{ color: "var(--text)" }}>{user?.fullName ?? "User"}</div>
            <div className="text-[11px] truncate" style={{ color: "var(--muted-2)" }}>{user?.email ?? ""}</div>
          </div>
          <button
            onClick={signOut}
            title="Sign out"
            className="grid place-items-center w-7 h-7 rounded-md hover:bg-red-500/15 text-slate-400 hover:text-red-300 transition"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}
