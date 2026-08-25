import { AppHeader } from "@/components/AppHeader";
import { InvestigationView } from "@/components/views/InvestigationView";

// Single-view shell for the core-engine pass: trace a victim-reported wallet,
// see the flow, the findings, the dual-track freeze decision and the Section 91
// notice, and ask the I4C assistant. No auth gate — the demo runs zero-config.
export default function Home() {
  return (
    <div className="min-h-screen grid-bg radial-glow">
      <AppHeader />
      <main>
        <InvestigationView />
      </main>
    </div>
  );
}
