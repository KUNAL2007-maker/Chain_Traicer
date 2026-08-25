import { NextResponse } from "next/server";
import {
  buildEvidence,
  casualBrief,
  evidenceBrief,
  localReport,
  CTR_USD,
  type CryptoEvidence,
} from "@/lib/investigation";
import { formatUSD, formatINR, type Severity, type TraceResult } from "@/lib/domain";
import { askGemini, geminiKey, type GeminiTurn } from "@/lib/gemini";
import {
  checkRate,
  ledgerSnapshot,
  noteExhausted,
  refund,
  release,
  reserve,
  seconds,
  syncFromUsage,
  waitFor,
} from "@/lib/quota";

// A four-agent forensic panel legitimately takes longer than Vercel's 10-second
// default — more still if the token budget is short and the request waits for it
// to refill. A killed function looks exactly like a broken AI from the officer's
// side, so raise the ceiling to the plan's maximum and let the fallback logic
// decide when to give up. 60s is a limit, not a target: a real answer is ~4s.
export const maxDuration = 60;

// Two modes: normal chat for questions, and the 4-agent panel for a full
// forensic write-up. Both are grounded in a pre-computed evidence brief built
// from THIS trace, so the model quotes the real wallet addresses, exchange names
// and amounts instead of generic blockchain-forensics theory.

const PLAIN_LANGUAGE_RULES = `HOW TO WRITE — this matters as much as the analysis:
- Write for an investigating officer who is sharp but not a blockchain engineer. A police officer or a magistrate should follow every sentence.
- Explain jargon the moment you use it: "a peel chain (a run of wallets each keeping a slice and forwarding the rest, to bury the source)".
- ALWAYS quote the real wallet addresses (0x…/T…), exchange names, tx hashes and amounts from the brief. Never write "Wallet A" or "an exchange".
- Say WHY something is suspicious, not just that it is. Compare it to what an ordinary transfer would look like.
- Use short paragraphs and bullet points. Never a wall of text.
- Shortest wording that still carries the fact and the reason. Cut every word that earns nothing: "in order to" → "to", "at this point in time" → "now", "it appears that" → delete.
- Be direct and confident. No "it may potentially be advisable to consider".`;

const CASUAL_PROMPT = `You are CryptoTrace, the I4C / NCRP blockchain-forensics assistant, helping an investigating officer understand a traced crypto-fraud case.

Answer in plain conversational English, 2-5 sentences. If the officer asks about the case, answer using ONLY the evidence brief provided — quote real wallet addresses, exchange names and amounts from it. If the brief says no trace is loaded, say so and suggest pasting a victim-reported wallet or loading the demo case. Never invent a wallet, an exchange or a transaction.

${PLAIN_LANGUAGE_RULES}`;

const INVESTIGATE_PROMPT = `You are CryptoTrace, a 4-agent blockchain-forensics system for India's I4C (Indian Cyber Crime Coordination Centre) working an NCRP/1930 crypto-fraud complaint. You are given a pre-computed evidence brief about a real wallet trace.

Respond with ONLY a valid JSON array of exactly 4 objects. No markdown fence, no preamble.

Each object: {"agent": string, "headline": string, "content": string, "findings": string[], "confidence": number}
- "headline": one punchy sentence summarising that agent's verdict (max 90 chars). Put the single most important fact here, with its real number or wallet.
- "content": 3-4 BULLET POINTS, one per line, each starting with "• ". NOT paragraphs.
- "findings": 2-3 short supporting facts with real numbers, wallet addresses or exchange names, each inside this agent's own subject. Observations only — never actions, never outcomes. "$9,030 reached Binance across 2 deposits" is a finding; "Binance account frozen" is not. These must be facts your bullets did NOT already state — a different angle, not the same sentence reworded. If you genuinely have nothing new, return fewer findings rather than padding.
- "confidence": 0-1, based on how strong the evidence actually is.

BE SHORT. The reader is skimming on a screen. Each agent's four bullets together must read in under twenty seconds. If a bullet needs a comma-spliced second clause to survive, cut the clause.

EVERY BULLET HAS TWO HALVES: the fact, then why it matters — joined by " — ". Between 12 and 22 words, never more than 22. Under 12 words it is a bare statistic and useless; over 22 it is a wall of text.

NEVER SPELL OUT A LIST. Write "3 mules", not the roll-call of addresses. Name at most two wallets in a bullet and say "3 wallets" for the rest. Counting beats listing every time.

Use everyday words. Write "kept a slice and passed the rest on" not "retained a margin and onward-transmitted", "split into smaller transfers" not "disaggregated", "moved to another blockchain" not "effected a cross-chain transposition".

Good: "• $9,030 landed at a Binance deposit address across two hops — a KYC-bound exchange, so the account holder can be identified."
Bad, too bare (a number with no meaning): "• $9,030 to Binance in 2 tx"
Bad, too vague (no real figures): "• Our analysis identified concerning patterns suggesting laundering activity across multiple wallets."

USE THE HARD FINDINGS SECTION. It comes first in the brief and it is the actual case — each entry (F1, F2, …) already carries the exact amounts, wallet addresses and reasoning. Every agent must work from it. The trace stats and wallet list further down are only the map; an answer built from hop counts and totals alone is a failure.

RULES THAT DECIDE WHETHER THIS IS ANY GOOD:
- Never state a number without saying what it means. "$16,000 across 5 wallets" is a statistic; "each transfer sized just under the $10,000 exchange-reporting line" is a finding.
- The mixer/bridge facts in the brief are settled, not "possible". If the brief says MIXER: YES, state plainly that the trail was broken and exposure downstream cannot be proven hop-by-hop. If MIXER: NO, do not speculate about one.
- The FREEZE TRACK line is computed from the trace, not for you to re-decide. Track A means a clean, verified, direct trail eligible for an express freeze; Track B means an officer must review because a mixer, a bridge or an offshore endpoint broke or clouded the trail. Report it; don't overrule it.
- Never assert a fact the brief does not contain. You know what the transfers did and what the wallets resolve to — not who owns an account or what anyone intended. Write "the exchange can identify the account holder from its KYC", never "the account holder is the fraudster".
- NEVER print the internal labels from the brief. No "F1", "F2", "VASP-SWEEP", "PEELING-CHAIN". The reader has never seen the brief. Describe the thing itself: "the run of wallets each shaving off a slice".

The 4 agents, in this exact order:

1. "Chain Analyst" — the money map only, nothing about legality or next steps. Describe the flow: how many hops and wallets, which blockchains, and whether it passed through a mixer or crossed a bridge. One bullet per notable structure (the threshold split, the peel chain, the bridge hop) in ordinary words, with its real amount, and what that shape tells you about who controls the money. Take every number from the brief; never invent a wallet or an amount.

2. "Attribution Analyst" — which wallets resolve to which exchanges or mixers, and how confident. One bullet per endpoint reached: the exchange or mixer name, how much reached it, the attribution confidence, and whether it is a KYC-bound exchange you can serve or a mixer you cannot. This is where the freeze target is named.

3. "Compliance Officer" — one bullet per legal hook, covering EXACTLY these where the brief supports them, in this order, and no others. Do not invent statutes:
   (a) Section 91 CrPC, 1973 / Section 94 BNSS, 2023 — a written requisition compelling the exchange to produce KYC (Aadhaar, PAN, linked bank account) and IP/device logs, and to freeze the balance behind the deposit address.
   (b) PMLA 2002 / FIU-IND — the traced funds are proceeds of crime; the exchange's reporting-entity obligations are engaged, and a mixer touch is an FIU-IND red flag.
   (c) Structuring — include ONLY if the brief shows transfers sized under the ${formatUSD(CTR_USD)} line; splitting to stay under a reporting threshold is a separate offence.
   Each bullet: what the provision requires, which finding here engages it, and what to demand. Name the real exchange and amounts — "serve a notice" alone is not a bullet.

4. "Investigating Officer" — what to do now, as numbered points ("1. ", "2. ", …). Lead with the freeze track and the exchange to serve. Name the exact deposit address and exchange, and say WHY each step: "Serve WazirX at compliance@wazirx.com first — $3,400 landed at a deposit address on a clean, direct trail." Every point must be something a person can go and do — no "conduct a thorough investigation".

${PLAIN_LANGUAGE_RULES}`;

// Four characters per token is crude, but it only has to tell a 3,000-token
// request from a 600-token one. The real figure arrives with the answer in
// `usageMetadata` and settles the ledger afterwards.
const estimateTokens = (turns: { text: string }[], system: string, maxTokens: number) =>
  Math.ceil((turns.reduce((n, t) => n + t.text.length, 0) + system.length) / 4) + maxTokens;

// The data behind a report does not change between two clicks of the same
// button, so the report does not need to either. Keeping the last few successful
// answers means a repeated question comes back instantly, spends no quota, and
// reads identically to the first time — which is what makes a demo repeatable
// rather than a coin toss.
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 24;
const cache = new Map<string, { at: number; model: string; content: string }>();

// FNV-1a. Short, stable, good enough to tell one evidence brief from another.
function fingerprint(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// A request the governor declined to send, or one Google refused for quota, is a
// different problem from a model that answered badly, and the two need different
// words in front of the user.
type Attempt =
  | { ok: true; text: string; model: string }
  | {
      ok: false;
      status: number;
      detail: string;
      rateLimited: boolean;
      daily: boolean;
      retryMs: number;
      quotaHold?: boolean;
    };

// Failures worth a second attempt. A dropped socket, a timeout and a 5xx are all
// "ask again" — the Live API opens a fresh session per turn, so there is no state
// to be confused by a retry. A 1007 (invalid argument) is not.
const isTransient = (status: number) =>
  status === 0 || status === 408 || status === 503 || status === 1006 || status === 1011;

// One turn, with the only two forms of persistence a single pinned model allows:
// the governor decides whether to send at all, and a failure that a short wait or
// a resample could plausibly fix gets exactly one more go.
async function askModel(
  apiKey: string,
  request: { system: string; turns: GeminiTurn[]; temperature: number; maxOutputTokens: number },
  validate: (text: string) => boolean,
  needed: number
): Promise<Attempt> {
  const startedAt = Date.now();

  // Everything this request may spend asleep, across every attempt. Both holds
  // draw from this pot, so a request never waits twice for the same shortfall.
  let waitedMs = 0;
  const hold = async (ms: number) => {
    await sleep(ms);
    waitedMs += ms;
  };
  const budgetLeft = () => WAIT_BUDGET_MS - waitedMs;

  const quotaShort = (): Attempt => {
    const ms = waitFor(needed);
    return {
      ok: false,
      status: 429,
      detail: `token budget short by ${needed} tokens; free in ${ms}ms`,
      rateLimited: true,
      daily: false,
      retryMs: ms,
      quotaHold: true,
    };
  };

  const send = async (): Promise<Attempt> => {
    // Debited before the call, because two requests arriving together would
    // otherwise both read the same healthy ledger and both spend it.
    reserve(needed);

    const r = await askGemini({ ...request, apiKey, validate });

    // Settle the estimate against what the turn really cost. Usage rides along on
    // a rejected answer too — those tokens were genuinely spent — so the only
    // case that gets its reservation back is a turn that never reached Google.
    if (r.usage) syncFromUsage(r.usage, needed);
    else if (!r.ok) release(needed);

    if (r.ok) return { ok: true, text: r.text, model: r.model };

    if (r.rateLimited) noteExhausted();
    return {
      ok: false,
      status: r.status,
      detail: r.detail,
      rateLimited: r.rateLimited,
      daily: r.daily,
      retryMs: r.retryMs,
    };
  };

  // Pre-flight. Skipping a request the allowance cannot cover costs nothing. A
  // shortfall of a few seconds is absorbed silently; anything longer goes back to
  // the caller as a number to show the user.
  const upfront = waitFor(needed);
  if (upfront > 0) {
    if (upfront > Math.min(ABSORB_MS, budgetLeft())) return quotaShort();
    console.warn(`[CryptoTrace] holding ${upfront}ms for the token budget to refill rather than degrading.`);
    await hold(upfront);
  }

  let last = await send();
  if (last.ok) return last;

  // Exactly one more attempt, and only when there is a reason to think it would
  // land differently. Repeating a request the endpoint called invalid changes
  // nothing; resampling one it answered unreadably usually does.
  const retryable = last.rateLimited || last.status === 422 || isTransient(last.status);
  if (!retryable) return last;

  const again = last.rateLimited ? waitFor(needed) : isTransient(last.status) ? RETRY_HOLD_MS : 0;

  if (again > budgetLeft()) {
    console.warn(
      `[CryptoTrace] already waited ${waitedMs}ms; not spending another ${again}ms — answering from the local engine instead.`
    );
    return last.rateLimited ? quotaShort() : last;
  }

  if (Date.now() - startedAt + again > REQUEST_SOFT_LIMIT_MS) {
    console.warn(`[CryptoTrace] ${Date.now() - startedAt}ms spent already; not opening a second attempt.`);
    return last.rateLimited ? quotaShort() : last;
  }

  if (again > 0) await hold(again);
  console.warn(`[CryptoTrace] retrying once after ${last.status}: ${last.detail.slice(0, 120)}`);

  const second = await send();
  if (second.ok) return second;

  if (second.rateLimited && !second.daily) return quotaShort();
  return second;
}

// How long the route will silently hold a request waiting for tokens to refill.
const ABSORB_MS = 6_000;
// The total a single request may spend asleep, across every attempt.
const WAIT_BUDGET_MS = 8_000;
// Long enough not to be a hot loop, short enough to be invisible.
const RETRY_HOLD_MS = 600;
// Past this much elapsed time, the route stops opening new attempts.
const REQUEST_SOFT_LIMIT_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A model that prints its scratchpad into the answer must never reach the reader,
// and must not break JSON parsing for the agent panel.
const stripThinking = (text: string) =>
  text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<\/?think(?:ing)?>/gi, "")
    .trim();

function wantsInvestigation(msg: string): boolean {
  const m = msg.toLowerCase();
  const keywords = [
    "investigate", "investigation", "analyze", "analyse", "audit", "review",
    "suspicious", "risk", "trace", "launder", "mixer", "bridge", "peel",
    "typology", "compliance", "agents", "full report", "deep dive",
    "why is", "what patterns", "freeze", "notice", "attribute", "exchange",
    "vasp", "whats wrong", "what's wrong", "find", "detect", "section 91",
  ];
  return keywords.some((k) => m.includes(k));
}

// Gemini accepts two turn roles, "user" and "model". The client keeps richer
// roles for its own bubbles; anything that isn't a user turn is folded into
// "model", and entries without usable text are dropped rather than sent.
function sanitizeHistory(history: unknown): GeminiTurn[] {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-6)
    .map((m) => {
      const role = (m as { role?: unknown })?.role;
      const content = (m as { content?: unknown })?.content;
      if (typeof content !== "string" || !content.trim()) return null;
      return { role: role === "user" ? "user" : "model", text: content } as GeminiTurn;
    })
    .filter((m): m is GeminiTurn => m !== null);
}

// Who to count this request against. A signed-in id if the client sends one,
// otherwise the forwarded IP. Forgeable, and that is fine: this limiter divides a
// shared allowance fairly, it is not a security boundary. The token governor is
// what actually protects the quota.
function callerId(req: Request, uid: unknown): string {
  if (typeof uid === "string" && uid.trim()) return `u:${uid.trim().slice(0, 128)}`;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${forwarded || req.headers.get("x-real-ip") || "local"}`;
}

// A minimal, safe trace when the client sends nothing usable — buildEvidence then
// reports an empty case and every path below degrades gracefully.
const EMPTY_TRACE: TraceResult = {
  seed: "",
  seed_chain: "ETHEREUM",
  nodes: [],
  transfers: [],
  hops: 0,
  source: "mock",
};

function asTrace(context: unknown): TraceResult {
  if (
    context &&
    typeof context === "object" &&
    Array.isArray((context as TraceResult).transfers) &&
    Array.isArray((context as TraceResult).nodes)
  ) {
    return context as TraceResult;
  }
  return EMPTY_TRACE;
}

export async function POST(req: Request) {
  try {
    const { message, history, context, mode: forcedMode, uid } = await req.json();

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    const investigate =
      forcedMode === "investigate" ||
      (forcedMode !== "casual" && wantsInvestigation(message));

    // Analyse the trace server-side first. This is what makes answers specific.
    // Two sizes of the same evidence: the report needs the full working document,
    // a chat turn needs the facts and nothing telling it how to write.
    const trace = asTrace(context);
    const evidence = buildEvidence(trace);
    const brief = investigate ? evidenceBrief(evidence) : casualBrief(evidence);

    // Nothing to investigate — answer from the local engine rather than asking
    // the model to improvise four near-identical "no trace loaded" bubbles.
    if (investigate && !evidence.txCount) {
      return NextResponse.json(investigatePayload(evidence, localReport(evidence)));
    }

    const apiKey = geminiKey();

    // No key — still give a real report rather than an error.
    if (!apiKey) {
      if (investigate) {
        return NextResponse.json(
          investigatePayload(
            evidence,
            localReport(evidence),
            "Running on the built-in forensic engine (no AI key configured)."
          )
        );
      }
      return NextResponse.json({
        mode: "casual",
        reply:
          "The AI service isn't configured, so I can't chat freely — but Run full investigation still works, it uses the built-in forensic engine.",
        suggestions: followUps(evidence),
      });
    }

    const system = investigate ? INVESTIGATE_PROMPT : CASUAL_PROMPT;
    const turns: GeminiTurn[] = [
      ...sanitizeHistory(history),
      { role: "user", text: `${message}\n\n=== EVIDENCE BRIEF (computed from the real wallet trace) ===\n${brief}` },
    ];

    // Bullets, not essays. The investigate figure is measured; the casual figure
    // is deliberately generous because this model emits AUDIO and spends the cap
    // on audio tokens when it speaks — see the note in src/lib/gemini.ts.
    const maxTokens = investigate ? 2_000 : 1_500;

    // Only investigations are cached — a report is a function of the trace and the
    // question, whereas a casual turn depends on the conversation so far.
    const key = investigate ? `${fingerprint(message.trim().toLowerCase())}:${fingerprint(brief)}` : null;
    if (key) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        const cachedAgents = parseAgents(hit.content);
        if (cachedAgents) {
          return NextResponse.json({
            ...investigatePayload(evidence, cachedAgents),
            model: hit.model,
            cached: true,
          });
        }
        cache.delete(key);
      }
    }

    // Counted only now, after the cache has had its chance — a repeated question
    // answered from memory costs nothing and should not spend anyone's allowance.
    const who = callerId(req, uid);
    const kind = investigate ? "investigate" : "casual";
    const verdict = checkRate(who, kind);

    if (!verdict.ok) {
      if (verdict.retryAfterMs <= ABSORB_MS) {
        await sleep(verdict.retryAfterMs);
      } else {
        const wait = seconds(verdict.retryAfterMs);
        const busy =
          verdict.scope === "global"
            ? "The console is handling a lot of requests right now"
            : "That's a lot of requests in one minute";
        console.warn(`[CryptoTrace] rate limit (${verdict.scope}) for ${who} on ${kind}; ${wait}s to wait.`);

        if (investigate) {
          return NextResponse.json(
            investigatePayload(
              evidence,
              localReport(evidence),
              `${busy} — this report came from the built-in forensic engine. The AI's wording is free again in ${wait} seconds.`
            )
          );
        }
        return NextResponse.json(
          {
            error: `${busy}. Please wait ${wait} seconds and try again.`,
            retryAfter: wait,
          },
          { status: 429, headers: { "Retry-After": String(wait) } }
        );
      }
    }

    const needed = estimateTokens(turns, system, maxTokens);
    const outcome = await askModel(
      apiKey,
      { system, turns, temperature: investigate ? 0.4 : 0.7, maxOutputTokens: maxTokens },
      investigate
        ? (text) => parseAgents(stripThinking(text)) !== null
        : (text) => stripThinking(text).length > 0,
      needed
    );

    if (!outcome.ok) {
      console.error("[CryptoTrace] Gemini unavailable:", outcome.status, outcome.detail);
      const { rateLimited, daily, quotaHold } = outcome;
      if (!rateLimited) refund(who, kind);

      const held = quotaHold ? seconds(outcome.retryMs) : 0;
      const waitAdvice = daily
        ? "You've used up today's free AI quota — it resets on a rolling 24-hour window."
        : quotaHold
          ? `The free AI tier's per-minute token budget is spent — it refills in ${held} seconds.`
          : "The free AI tier only allows so many requests a minute.";

      if (investigate) {
        return NextResponse.json(
          investigatePayload(
            evidence,
            localReport(evidence),
            rateLimited
              ? `${waitAdvice} This report came from the built-in forensic engine instead — same trace, just without the AI's wording.`
              : "The AI service was unreachable, so this report came from the built-in forensic engine."
          )
        );
      }
      return NextResponse.json({
        mode: "casual",
        reply: rateLimited
          ? `${waitAdvice} That's a limit on the free plan, not a problem with your trace or your key. ${daily ? "Run full investigation still works — it uses the built-in engine and needs no AI." : "Give it a moment and ask again, or use Run full investigation, which works either way."}`
          : "The AI service didn't respond just now. Try again in a moment — Run full investigation works either way, since it can fall back to the built-in engine.",
        suggestions: followUps(evidence),
        degraded: rateLimited ? waitAdvice : "AI service unavailable.",
        ...(quotaHold ? { retryAfter: held } : {}),
      });
    }

    const raw = stripThinking(outcome.text);
    const budget = ledgerSnapshot();

    if (!investigate) {
      const clean = raw.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
      return NextResponse.json({
        mode: "casual",
        reply: clean,
        suggestions: followUps(evidence),
        model: outcome.model,
        budget,
      });
    }

    const agents = parseAgents(raw);
    if (!agents) {
      refund(who, kind);
      return NextResponse.json(
        investigatePayload(
          evidence,
          localReport(evidence),
          "The AI returned an unreadable response, so this report came from the built-in forensic engine."
        )
      );
    }

    if (key) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: Date.now(), model: outcome.model, content: raw });
    }

    return NextResponse.json({ ...investigatePayload(evidence, agents), model: outcome.model, budget });
  } catch (err) {
    console.error("[CryptoTrace] Chat API error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// The model may return a bare array, or an object wrapping one under any key.
// Accept every shape rather than falling back to a generic message.
function parseAgents(raw: string) {
  const attempt = (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  let parsed = attempt(raw.trim());
  if (!parsed) {
    const arr = raw.match(/\[[\s\S]*\]/);
    if (arr) parsed = attempt(arr[0]);
  }
  if (!parsed) {
    const obj = raw.match(/\{[\s\S]*\}/);
    if (obj) parsed = attempt(obj[0]);
  }
  if (!parsed) return null;

  if (Array.isArray(parsed)) return normalize(parsed);
  if (typeof parsed === "object") {
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value) && value.length) return normalize(value);
    }
  }
  return null;
}

// The brief labels its findings F1, F2 so the model can hold them apart. The
// reader has never seen the brief, so "F2 engages PMLA" is a reference to
// nothing. The prompt forbids printing them; this is the backstop. The lookaround
// keeps it off anything with a word character either side.
function stripInternalLabels(text: string) {
  return text
    .replace(/(?<![-\w])F(\d{1,2})(?![-\w])/g, "this finding")
    .replace(/\bfinding this finding\b/gi, "this finding");
}

// The model mirrors the indentation of the prompt's own nested lists, so bullets
// can arrive with leading spaces. Strip it here rather than asking it not to.
function tidyBullets(text: string) {
  return stripInternalLabels(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .trim();
}

// The panels render confidence as a percentage of 1, and the prompt asks for
// 0-1. Gemini answers 95 about as often as 0.95, so a value above 1 is taken as a
// percentage and anything outside the scale is clamped rather than trusted.
function confidenceOf(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0.85;
  const scaled = raw > 1 ? raw / 100 : raw;
  return Math.min(1, Math.max(0, scaled));
}

function normalize(list: unknown[]) {
  const cleaned = list
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      agent: String(a.agent ?? a.name ?? "Investigating Officer"),
      headline:
        typeof a.headline === "string" ? stripInternalLabels(a.headline.trim()) : undefined,
      content: tidyBullets(String(a.content ?? a.text ?? a.analysis ?? "")),
      findings: Array.isArray(a.findings)
        ? a.findings.map((f) => stripInternalLabels(String(f).trim())).filter(Boolean).slice(0, 4)
        : [],
      confidence: confidenceOf(a.confidence),
    }))
    .filter((a) => a.content.trim().length > 0);
  return cleaned.length ? cleaned : null;
}

function summarize(ev: CryptoEvidence) {
  return {
    txCount: ev.txCount,
    walletCount: ev.walletCount,
    vaspCount: ev.vasps.filter((v) => !v.is_mixer).length,
    findingCount: ev.findings.length,
    highCount: ev.bySeverity.high,
    track: ev.track.overall,
  };
}

// ── The short answer ───────────────────────────────────────────────────────
// A one-sentence verdict computed from the evidence engine rather than the
// model, so it is always present, its numbers always match the trace, and it
// costs no tokens. The graph opens focused on the wallets it names.
function verdictOf(ev: CryptoEvidence): {
  level: Severity;
  headline: string;
  points: string[];
  accounts: string[];
} {
  if (!ev.txCount) {
    return {
      level: "safe",
      headline: "No wallet trace loaded yet.",
      points: ["Paste a victim-reported wallet address, or load the demo case, and run this again."],
      accounts: [],
    };
  }

  const hard = ev.findings.filter((f) => f.severity === "high");
  const level: Severity = hard.length || ev.bySeverity.high ? "high" : ev.bySeverity.medium ? "medium" : "safe";
  const serviceable = ev.vasps.filter((v) => !v.is_mixer);

  const headline =
    level === "high"
      ? `${ev.track.headline} — ${formatUSD(ev.highExposureUsd)} of ${formatUSD(ev.totalUsd)} traced is high-risk.`
      : level === "medium"
        ? `Nothing conclusive, but ${ev.bySeverity.medium} wallet${ev.bySeverity.medium === 1 ? "" : "s"} are worth watching across ${ev.hops} hops.`
        : `All ${ev.txCount} transfers look routine across ${ev.hops} hops. Nothing to escalate.`;

  const points: string[] = [];
  points.push(ev.track.summary);
  for (const f of ev.findings.slice(0, 3)) points.push(f.short || f.title);
  if (points.length < 2) {
    points.push(
      `${ev.txCount} transfers, ${ev.walletCount} wallets, ${formatUSD(ev.totalUsd)} across ${ev.chains.length} chain${ev.chains.length === 1 ? "" : "s"}.`
    );
  }

  // The wallets the graph should open focused on: the serviceable deposit
  // addresses first, then whatever the hard findings name, worst finding first.
  const accounts: string[] = [];
  for (const v of serviceable) for (const a of v.depositAddresses) if (!accounts.includes(a)) accounts.push(a);
  for (const f of hard.length ? hard : ev.findings) {
    for (const a of f.wallets) if (!accounts.includes(a)) accounts.push(a);
  }

  return { level, headline, points: points.slice(0, 4), accounts: accounts.slice(0, 14) };
}

// Follow-ups generated from the trace, not the model, so they always name
// something that exists and never cost a request.
function followUps(ev: CryptoEvidence): string[] {
  if (!ev.txCount) return ["How do I trace a wallet address?", "Load the demo case"];

  const out: string[] = [];
  const serviceable = ev.vasps.filter((v) => !v.is_mixer);
  if (serviceable[0]) out.push(`Why should we freeze ${serviceable[0].vasp_name}?`);
  if (ev.mixersTouched.length) out.push(`What does the ${ev.mixersTouched[0]} mixer mean for this case?`);
  else if (ev.bridgesUsed) out.push("How do we follow the money across the bridge?");
  if (ev.findings.some((f) => f.code === "PEELING-CHAIN")) out.push("Explain the peeling chain in plain words");
  out.push("Which exchange do we serve first?");
  return out.slice(0, 3);
}

// Every investigate reply has the same shape; building it in one place stops the
// exit paths from drifting apart.
function investigatePayload(ev: CryptoEvidence, agents: unknown, degraded?: string) {
  return {
    mode: "investigate" as const,
    agents,
    verdict: verdictOf(ev),
    suggestions: followUps(ev),
    evidence: summarize(ev),
    track: ev.track,
    ...(degraded ? { degraded } : {}),
  };
}
