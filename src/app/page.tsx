"use client";

import { useAuth } from "@/components/AuthProvider";
import LoginPage from "@/app/login/page";
import { AppShell } from "@/components/AppShell";

export default function Page() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center radial-glow" style={{ backgroundColor: "var(--bg)" }}>
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-700 grid place-items-center shadow-glow animate-pulse">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z" stroke="#052e1a" strokeWidth="1.6" strokeLinejoin="round" fill="rgba(255,255,255,0.15)" />
            </svg>
          </div>
          <div className="text-[13px] text-slate-400">Loading FinGuard Console...</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <AppShell />;
}
