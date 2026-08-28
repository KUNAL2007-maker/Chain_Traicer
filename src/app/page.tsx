"use client";

import { useAuth } from "@/components/AuthProvider";
import { LoginScreen } from "@/components/LoginScreen";
import { AppShell } from "@/components/AppShell";

/**
 * The auth gate.
 *
 * Three states, in the order they occur:
 *   1. loading — resolving whether there is a saved session. Brief, but showing
 *      the login form here would make a signed-in officer's refresh flash a
 *      form they don't need.
 *   2. no user — the login screen.
 *   3. signed in — the console.
 *
 * With Firebase unconfigured, AuthProvider supplies a local demo officer and
 * `loading` starts false, so this falls straight through to the console and the
 * zero-config demo behaves exactly as it did before auth existed.
 */
export default function Home() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div
        className="min-h-[100dvh] grid place-items-center radial-glow"
        style={{ backgroundColor: "var(--bg)" }}
      >
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500/30 border-t-emerald-400" />
          <div className="text-[12px] uppercase tracking-widest" style={{ color: "var(--muted-2)" }}>
            Restoring session
          </div>
        </div>
      </div>
    );
  }

  if (!user) return <LoginScreen />;

  return <AppShell />;
}
