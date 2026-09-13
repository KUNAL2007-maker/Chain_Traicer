"use client";

import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";

export default function LoginPage() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);

    if (mode === "login") {
      const err = await signIn(email.trim(), password);
      if (err) setError(err);
    } else {
      // Requirement #3: after signup, land back on the login form with
      // credentials prefilled so the user must sign in explicitly.
      const err = await signUp(email.trim(), password, fullName.trim());
      if (err) {
        setError(err);
      } else {
        setMode("login");
        setInfo("Account created. Please sign in to continue.");
      }
    }
    setBusy(false);
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "var(--bg)" }}
    >
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-700 grid place-items-center shadow-glow">
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
          <div>
            <div className="text-xl font-semibold" style={{ color: "var(--text-strong)" }}>
              FinGuard <span className="text-emerald-400">Intelligence</span>
            </div>
            <div className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted-2)" }}>
              Transaction analysis console
            </div>
          </div>
        </div>

        <div
          className="rounded-2xl p-6 border"
          style={{ background: "var(--panel)", borderColor: "var(--border)" }}
        >
          <div className="text-center mb-6">
            <h1 className="text-lg font-semibold" style={{ color: "var(--text-strong)" }}>
              {mode === "login" ? "Welcome back" : "Create your account"}
            </h1>
            <p className="text-[13px] mt-1" style={{ color: "var(--muted-2)" }}>
              {mode === "login"
                ? "Sign in with your email and password"
                : "Sign up to start analyzing transactions"}
            </p>
          </div>

          {info && (
            <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[13px] text-emerald-300">
              {info}
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "signup" && (
              <Field label="Full name" value={fullName} onChange={setFullName} placeholder="Your name" />
            )}
            <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="you@example.com" />
            <Field
              label="Password"
              value={password}
              onChange={setPassword}
              type="password"
              placeholder="At least 6 characters"
            />

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 py-2.5 text-[14px] font-medium shadow-glow transition disabled:opacity-50"
            >
              {busy ? "Please wait..." : mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>

          <div className="my-5 h-px" style={{ background: "var(--border)" }} />

          <p className="text-center text-[13px]" style={{ color: "var(--muted-2)" }}>
            {mode === "login" ? "New to FinGuard?" : "Already have an account?"}{" "}
            <button
              onClick={() => {
                setMode(mode === "login" ? "signup" : "login");
                setError(null);
                setInfo(null);
              }}
              className="text-emerald-300 hover:underline"
            >
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </p>
        </div>
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label
        className="block text-[12px] uppercase tracking-widest mb-1.5"
        style={{ color: "var(--muted-2)" }}
      >
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required
        minLength={type === "password" ? 6 : undefined}
        className="w-full rounded-lg border px-3 py-2.5 text-[14px] outline-none focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/20 transition"
        style={{
          background: "var(--chip)",
          borderColor: "var(--border)",
          color: "var(--text)",
        }}
      />
    </div>
  );
}
