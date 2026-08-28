"use client";

/**
 * Login gate for the forensic console.
 *
 * A component, not a route: app/page.tsx renders it whenever there is no
 * session, so there is no reachable /login URL that could show a bare form
 * outside the gate. Errors arrive as strings from AuthProvider and render inline
 * — a failed sign-in should never surface a Firebase error code.
 */

import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";

export function LoginScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    // On success the auth listener swaps this screen for the console, so there
    // is no success branch to handle here — only the failure path.
    const err =
      mode === "login"
        ? await signIn(email.trim(), password)
        : await signUp(email.trim(), password, fullName.trim());
    if (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div
      className="min-h-[100dvh] flex items-center justify-center px-4 py-10 radial-glow"
      style={{ backgroundColor: "var(--bg)" }}
    >
      <div className="w-full max-w-md">
        {/* Brand mark — same shield and wordmark as the sidebar, so signing in
            visibly lands you in the same product. */}
        <div className="flex items-center justify-center gap-3 mb-7">
          <div className="w-11 h-11 shrink-0 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-700 grid place-items-center shadow-glow">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"
                stroke="#052e1a"
                strokeWidth="1.6"
                strokeLinejoin="round"
                fill="rgba(255,255,255,0.15)"
              />
              <path
                d="M9 12l2 2 4-4"
                stroke="#052e1a"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="text-xl font-semibold tracking-wide" style={{ color: "var(--text-strong)" }}>
              CryptoTrace <span className="text-emerald-400">Intelligence</span>
            </div>
            <div className="text-[10px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
              NCRP · I4C Forensic Console
            </div>
          </div>
        </div>

        <div
          className="rounded-2xl p-6 border"
          style={{ background: "var(--panel)", borderColor: "var(--border)" }}
        >
          <div className="text-center mb-6">
            <h1 className="text-lg font-semibold" style={{ color: "var(--text-strong)" }}>
              {mode === "login" ? "Officer sign-in" : "Register an officer account"}
            </h1>
            <p className="text-[13px] mt-1" style={{ color: "var(--muted-2)" }}>
              {mode === "login"
                ? "Case files, traces and notices are private to your account."
                : "Your cases are stored against this account and nobody else's."}
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "signup" && (
              <Field
                label="Officer name"
                value={fullName}
                onChange={setFullName}
                placeholder="e.g. Insp. A. Sharma"
                autoComplete="name"
              />
            )}
            <Field
              label="Official email"
              value={email}
              onChange={setEmail}
              type="email"
              placeholder="officer@i4c.gov.in"
              autoComplete="email"
            />
            <Field
              label="Password"
              value={password}
              onChange={setPassword}
              type="password"
              placeholder="At least 6 characters"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 py-2.5 text-[14px] font-medium shadow-glow transition disabled:opacity-50"
            >
              {busy
                ? "Please wait…"
                : mode === "login"
                ? "Sign in to console"
                : "Create account"}
            </button>
          </form>

          <div className="my-5 h-px" style={{ background: "var(--border)" }} />

          <p className="text-center text-[13px]" style={{ color: "var(--muted-2)" }}>
            {mode === "login" ? "First time on this console?" : "Already registered?"}{" "}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "login" ? "signup" : "login");
                setError(null);
              }}
              className="text-emerald-300 hover:underline"
            >
              {mode === "login" ? "Register an account" : "Sign in"}
            </button>
          </p>
        </div>

        <p
          className="mt-6 text-center text-[11px] leading-relaxed"
          style={{ color: "var(--muted-2)" }}
        >
          SIH26183 · Ministry of Home Affairs / Indian Cyber Crime Coordination Centre
          <br />
          Authorised use only. Activity on this console forms part of the case record.
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <div>
      <label className="block text-[12px] uppercase tracking-widest mb-1.5" style={{ color: "var(--muted-2)" }}>
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required
        minLength={type === "password" ? 6 : undefined}
        className="w-full rounded-lg border px-3 py-2.5 text-[14px] outline-none focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/20 transition"
        style={{ background: "var(--chip)", borderColor: "var(--border)", color: "var(--text)" }}
      />
    </div>
  );
}
