import { NextResponse } from "next/server";
import {
  traceWallet,
  loadMockTrace,
  probeSeedActivity,
  quotaSnapshot,
  hasLiveProviders,
} from "@/lib/blockchain";
import { priceQuotaSnapshot } from "@/lib/prices";
import { detectChain, type CaseMeta, type Chain } from "@/lib/domain";

/** Chains a probe can poll. Whitelisted so a client can't send anything else. */
const SUPPORTED_PROBE_CHAINS: Chain[] = ["ETHEREUM", "POLYGON", "TRON", "BITCOIN"];

// A live multi-chain BFS trace fans out across Etherscan / TronGrid / mempool and
// can legitimately run past Vercel's 10-second default, so raise the ceiling. The
// tracer never throws — it falls back to the mock scenario — but the network hops
// it makes are the slow part, and a killed function reads like a broken tracer.
export const maxDuration = 60;

// Trace a victim-reported wallet address outward and return the whole flow:
// nodes (wallets tagged by layer + VASP attribution), transfers (edges), and the
// case metadata. Live when provider keys are set AND the address parses to a
// supported chain; the deterministic mock otherwise, so the demo works with zero
// configuration and the endpoint never answers with an error.
//
// Two modes:
//   • default        — the full walk (up to ~40 wallets, dozens of API calls)
//   • { probe: true } — the seed wallet only, ~2 API calls, returns just its
//                       current outgoing tx hashes.
//
// The probe exists for the live-feed poll. Re-walking the whole tree once a
// minute costs ~80 Etherscan calls/min, which is ~115,000/day against a
// 100,000/day key — the console would quota itself out inside a day of being
// left open on a desk. A poll only needs to answer "has anything moved?".
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const rawSeed = typeof body?.seed === "string" ? body.seed.trim() : "";
    const demo = body?.demo === true;
    const probe = body?.probe === true;
    const caseMeta: CaseMeta | undefined =
      body?.caseMeta && typeof body.caseMeta === "object" ? body.caseMeta : undefined;

    // ── Cheap change-detector for the live feed ──────────────────────────────
    if (probe) {
      // Trust the client's chain when it sends one. It holds `trace.seed_chain`,
      // which is the chain the trace actually landed on — and for a `0x…` address
      // that is the only way to know, since Ethereum and Polygon addresses are
      // the same shape and `detectChain` always guesses Ethereum. Polling the
      // wrong chain would report "no new activity" forever.
      const claimed = typeof body?.chain === "string" ? body.chain : null;
      const chain =
        claimed && SUPPORTED_PROBE_CHAINS.includes(claimed as Chain)
          ? (claimed as Chain)
          : detectChain(rawSeed);

      if (!rawSeed || !chain || !hasLiveProviders()) {
        // Nothing live to check. `hashes: []` (rather than an error) keeps the
        // client's poll loop a no-op on a mock trace instead of making it fall
        // through to a pointless full re-trace every minute.
        return NextResponse.json({
          probe: true,
          hashes: [],
          latestTs: 0,
          degraded: false,
          warnings: [],
        });
      }
      const seen = await probeSeedActivity(rawSeed, chain);
      return NextResponse.json({ probe: true, ...seen, quota: quotaSnapshot() });
    }

    // Explicit demo, or nothing usable to trace → the built-in scenario. It
    // honours a pasted seed as the victim-entry address if one was given.
    if (demo || !rawSeed) {
      const trace = loadMockTrace(rawSeed || undefined, caseMeta);
      return NextResponse.json({ ...trace, generatedAt: Date.now() });
    }

    // A pasted address whose shape matches no chain we trace is worth saying so
    // plainly — but still return a usable trace rather than a bare error, so the
    // console always has something to render.
    const chain = detectChain(rawSeed);
    const trace = await traceWallet(rawSeed, { caseMeta });

    // Quota counters on every live trace. Without this, "why is the trace thin
    // today?" has no answer short of adding logging after the fact — and these
    // are plain counters, never keys.
    if (chain) {
      console.info("[CryptoTrace] quota", {
        chain: quotaSnapshot(),
        prices: priceQuotaSnapshot(),
        degraded: trace.degraded ?? false,
      });
    }

    return NextResponse.json({
      ...trace,
      generatedAt: Date.now(),
      ...(chain
        ? {}
        : {
            note: "Address shape didn't match a supported chain — showing the demo trace instead.",
          }),
    });
  } catch (err) {
    console.error("[CryptoTrace] trace API error:", err);
    // Last-resort fallback: never leave the client without a trace to show.
    const trace = loadMockTrace();
    return NextResponse.json({
      ...trace,
      generatedAt: Date.now(),
      degraded: true,
      warnings: ["The trace service errored — showing the demo scenario instead."],
    });
  }
}
