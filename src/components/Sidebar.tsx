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
    key: "transfers",
    label: "Transfers",
    hint: "Browse & filter",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "graph",
    label: "Wallet Flow Graph",
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
    key: "trace",
    label: "Trace Wallet",
    hint: "Seed a case",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.6" />
        <path d="M16 16l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "chat",
    label: "AI Investigator",
    hint: "I4C multi-agent",
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
    key: "notices",
    label: "Legal Notices",
    hint: "Sec 91 · Sec 94",
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
            CryptoTrace <span className="text-emerald-400">Intelligence</span>
          </div>
          <div className="text-[10px] uppercase tracking-widest truncate" style={{ color: "var(--muted)" }}>
            NCRP · I4C Forensic Console
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
          and the officer chip below stay visible. */}
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
        <OfficerChip />
      </div>
    </aside>
  );
}

/**
 * The signed-in officer, and the way out.
 *
 * In offline mode (no Firebase config) there is no session to end, so the chip
 * says so instead of offering a sign-out button that would do nothing — and the
 * warning is worth showing, because nothing the officer does will be saved.
 */
function OfficerChip() {
  const { user, persistent, signOut } = useAuth();
  if (!user) return null;

  return (
    <div
      className="rounded-xl p-3 border flex items-center gap-2"
      style={{ background: "var(--chip)", borderColor: "var(--border)" }}
    >
      <div
        className="w-8 h-8 shrink-0 rounded-full bg-gradient-to-br from-sky-400 to-indigo-500 grid place-items-center text-[11px] font-semibold text-white"
        aria-hidden
      >
        {initials(user.fullName)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] truncate" style={{ color: "var(--text)" }} title={user.fullName}>
          {user.fullName}
        </div>
        <div
          className="text-[11px] truncate"
          style={{ color: "var(--muted-2)" }}
          title={persistent ? user.email : undefined}
        >
          {persistent ? user.email : "Offline demo · nothing is saved"}
        </div>
      </div>
      {persistent ? (
        <button
          onClick={() => void signOut()}
          title="Sign out"
          aria-label="Sign out"
          className="grid place-items-center w-7 h-7 shrink-0 rounded-md transition hover:bg-[var(--hover)]"
          style={{ color: "var(--muted)" }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path
              d="M15 12H4m0 0l3.5-3.5M4 12l3.5 3.5"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M11 5.5V5a2 2 0 012-2h5a2 2 0 012 2v14a2 2 0 01-2 2h-5a2 2 0 01-2-2v-.5"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : (
        <span
          className="grid place-items-center w-7 h-7 shrink-0 rounded-md text-amber-300"
          title="No database configured — cases clear on refresh"
          style={{ background: "rgba(245,158,11,0.12)" }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 9v4m0 3h.01M10.3 3.9L2.4 17.5A2 2 0 004.1 20.5h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </div>
  );
}

/** "Insp. A. Sharma" → "IA". Falls back to a generic badge for empty names. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "IO";
  const letters = parts
    .slice(0, 2)
    .map((p) => p.replace(/[^\p{L}\p{N}]/gu, "").charAt(0))
    .filter(Boolean)
    .join("");
  return (letters || "IO").toUpperCase();
}
