import { NextResponse } from "next/server";
import { traceWallet, loadMockTrace } from "@/lib/blockchain";
import { detectChain, type CaseMeta } from "@/lib/domain";

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
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const rawSeed = typeof body?.seed === "string" ? body.seed.trim() : "";
    const demo = body?.demo === true;
    const caseMeta: CaseMeta | undefined =
      body?.caseMeta && typeof body.caseMeta === "object" ? body.caseMeta : undefined;

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
    return NextResponse.json({
      ...trace,
      generatedAt: Date.now(),
      ...(chain ? {} : { note: "Address shape didn't match a supported chain — showing the demo trace instead." }),
    });
  } catch (err) {
    console.error("[CryptoTrace] trace API error:", err);
    // Last-resort fallback: never leave the client without a trace to show.
    const trace = loadMockTrace();
    return NextResponse.json({ ...trace, generatedAt: Date.now() });
  }
}
