import { NextResponse } from "next/server";
import { buildEvidence, casualBrief, evidenceBrief, localReport, type Evidence } from "@/lib/investigation";
import { formatINR, type Severity, type Transaction } from "@/lib/domain";
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

// Vercel gives a route handler 10 seconds by default, and a four-agent
// investigation legitimately takes longer than that — more still if the token
// budget is short and the request waits for it to refill. A killed function looks
// exactly like a broken AI from the user's side, so raise the ceiling to the
// plan's maximum and let the fallback logic decide when to give up. 60s is a
// limit, not a target: a real four-agent answer measures about 4 seconds.
export const maxDuration = 60;

// Two modes: normal chat for questions and small talk, and the 4-agent panel
// for an actual investigation. Both are grounded in a pre-computed evidence
// brief so the model quotes this user's real numbers instead of generic AML
// theory — that "cold, always-the-same" answer was the symptom of sending it
// nothing but raw rows.

const PLAIN_LANGUAGE_RULES = `HOW TO WRITE — this matters as much as the analysis:
- Write for someone with no banking or compliance background. A student or a shop owner should follow every sentence.
- Explain jargon the moment you use it: "structuring (splitting one big payment into several small ones so the bank never has to report it)".
- ALWAYS quote the real account names, amounts, dates and bank names from the brief. Never write "Account A" or "a large sum".
- Say WHY something is wrong, not just that it is. Compare it to what normal activity would look like.
- Use short paragraphs and bullet points. Never a wall of text.
- Shortest wording that still carries the fact and the reason. Cut every word that earns nothing: "in order to" → "to", "at this point in time" → "now", "it appears that" → delete.
- Be direct and confident. No "it may potentially be advisable to consider".`;

const CASUAL_PROMPT = `You are FinGuard Intelligence's assistant, helping a user understand their own transaction data and financial-crime concepts.

Answer in plain conversational English, 2-5 sentences. If the user asks about their data, answer using ONLY the evidence brief provided — quote real account names and amounts from it. If the brief says no data is uploaded, say so and suggest uploading a CSV. Never invent transactions.

${PLAIN_LANGUAGE_RULES}`;

const INVESTIGATE_PROMPT = `You are FinGuard Intelligence, a 4-agent financial-crime analysis system. You are given a pre-computed evidence brief about the user's real transactions.

Respond with ONLY a valid JSON array of exactly 4 objects. No markdown fence, no preamble.

Each object: {"agent": string, "headline": string, "content": string, "findings": string[], "confidence": number}
- "headline": one punchy sentence summarising that agent's verdict (max 90 chars). Put the single most alarming fact here, with its real number.
- "content": 3-4 BULLET POINTS, one per line, each starting with "• ". NOT paragraphs.
- "findings": 2-3 short supporting facts with real numbers or account names, each inside this agent's own subject. Observations only — never actions, never outcomes. "ACC-X received ₹44.35 L from 5 payers" is a finding; "ACC-X frozen" or "KYC reviewed" is not. These must be facts your bullets did NOT already state — a different angle on the same group, not the same sentence with the words moved. If a bullet says "9 accounts in a chain moving ₹4.00 Cr", then "9 accounts moving ₹4.00 Cr" is the same fact and is banned; the banks it spans, the share of the portfolio it represents, or the dates it ran on are all fair. If you genuinely have nothing new, return fewer findings rather than padding.
- "confidence": 0-1, based on how strong the evidence actually is.

BE SHORT. The reader is skimming on a screen, not studying a filing. Each agent's four bullets together must read in under twenty seconds. If a bullet needs a comma-spliced second clause to survive, cut the clause.

EVERY BULLET HAS TWO HALVES: the fact, then why it matters — joined by " — ". Between 12 and 22 words, and never more than 22. Under 12 words it is a bare statistic and useless; over 22 it is the wall of text the user complained about. No introductions, no "in conclusion", no restating the question.

NEVER SPELL OUT A LIST. The brief names all seven banks because it is a working document; a bullet that repeats them spends 12 of its 22 words on proper nouns and says nothing. Write "7 banks", not the roll-call. Same for accounts: name at most two in a bullet, and say "9 accounts" for the rest. Counting beats listing every time.

Use everyday words. Write "kept a cut" not "retained a margin", "passed it straight on" not "onward-transmitted the funds", "split into smaller payments" not "disaggregated". If a word would stop a shop owner mid-sentence, it is the wrong word.

Good: "• Nine payments of ₹8.65-9.48 L each — every one sized to stop just short of the ₹10 L reporting line."
Bad, too bare (a number with no meaning): "• ₹82.88 L in 9 transfers under ₹10 L"
Bad, too vague (no real figures): "• Our analysis identified concerning patterns suggesting possible attempts to avoid detection through structuring."
Bad, too long (says it twice): "• Nine separate payments ranging between ₹8.65 L and ₹9.48 L, amounting to ₹82.88 L in total, were each deliberately sized to remain below the ₹10 L threshold at which reporting obligations are triggered."

USE THE HARD FINDINGS SECTION. It comes first in the brief and it is the actual case — each entry (F1, F2, …) already carries the exact amounts, dates, account names and reasoning. Every agent must work from it. The ring list further down is only the map; an answer built from ring sizes and totals alone is a failure.

RULES THAT DECIDE WHETHER THIS IS ANY GOOD:
- Never state a number without saying what it means. "₹2.77 Cr across 7 accounts" is a statistic; "money shrank 7.3% over 6 hops because each account kept a cut" is a finding.
- Every comparison you draw must fit the finding you are discussing. Take the percentages, dates and amounts from that specific finding — do not carry a number from one finding onto another.
- A number and the count beside it must come from the SAME source line, and this applies to every agent, in "content" and in "findings" alike. A ring's total goes only with that ring's account count; a finding's amount goes only with that finding's own count of payers or hops. They are different numbers about different things, and crossing them prints a figure that is flatly wrong. If a ring line says "7 accounts … ₹86.35 L" and a finding says "received ₹44.35 L from 5 different accounts", then "₹86.35 L from 5 accounts" and "collects from 7 accounts" are both errors. Write "₹44.35 L from 5 payers", or "the 7-account group moving ₹86.35 L" — never a half of each.
- When a finding gives a date, name the date. "Six hops on 6 August" lands; "a series of transfers" does not. When it gives no date, say nothing about when — do not borrow a date from another finding.
- The four agents must not say the same thing four times. Each answers its own question: what the network looks like / why it is wrong / which law it breaks / what to do on Monday morning.
- ANSWER THE QUESTION THAT WAS ASKED. It arrives above the brief. The four agents and their subjects are fixed, but the emphasis is not: a question about one account leads with that account, a question asking for plain words drops the jargon further, a question about freezing puts the Investigation Assistant's steps first in every agent's mind. A generic recital of the whole portfolio, identical whatever was asked, is a failure.
- NEVER print the internal labels from the brief. No "F1", "F2", "finding F3", "R1", "BANK-HOP", "THRESHOLD-HUG", "FUNNEL-IN". The reader has never seen the brief and these mean nothing to them. Describe the thing itself: "the nine payments that all stopped just short of ₹10 lakh".
- Never assert a fact the brief does not contain. You do not know whether KYC papers are missing or forged, who owns an account, or what anyone intended — you know what the transfers did. Write "re-verify this account's KYC against its turnover", never "its KYC may be incomplete or falsified". Give the reason to check from the transfers themselves: "₹1.04 Cr passed through in a day".

The 4 agents, in this exact order:

1. "Graph Analyst" — the money map only, nothing about legality or next steps. One bullet per suspicious group: its shape (chain / funnel / fan-out) in ordinary words, its total, and what that shape tells you about who controls the money.
   Every number in these bullets comes off ONE R-line in RINGS DETECTED, and the values travel together: that line's account count, that line's total, that line's hub. If an R-line reads "5 accounts … ₹2.04 Cr … Hub(s): ACC-X", the only correct phrasing is "5 accounts around ACC-X moving ₹2.04 Cr". Say "N accounts in the group" — you are describing the whole group, not how many of them pay in, so never reach into a finding for a payer count here.
   When an R-line reads "Hub(s): none" there is NO hub, and naming one is a fabrication. A chain has no centre — it has two ends. Describe it by its run: "a 9-account chain running from ACC-A to ACC-Z, ₹4.00 Cr". Do not write "accounts around ACC-A" for a chain, and never promote the first account of a route into a hub. Say nothing at all about a hub in that case — "around no hub" and "with no central hub" are not sentences a reader wants; simply describe the group without one.
   Never call a total large or small on its own. ₹3 L next to a ₹4 Cr portfolio is a rounding error, and calling it large tells the reader the opposite of the truth. Either compare it to the PORTFOLIO total, or give the figure and say nothing about its size. One final bullet on which groups are boring and can be ignored.

2. "Risk Analyst" — what is actually wrong, nothing about the law. One bullet per hard finding, worst first. Each bullet: what happened with its own amount and date, then why that isn't normal — "ordinary payments don't shrink at every hop", "amounts don't cluster in a narrow band by chance".

3. "Compliance Officer" — one bullet per rule, covering EXACTLY these, in this order, and no others. Do not invent statutes or cite rules about banking secrecy or confidentiality:
   (a) PMLA 2002 / FIU-IND — STR due within 7 working days of forming suspicion; suspicion is the trigger, not the payment size. A CTR covers CASH above ₹10 lakh, so never call a UPI, IMPS, NEFT, RTGS or SWIFT transfer a CTR. Cross-border wires are reportable separately from ₹5 lakh up.
   (b) RBI KYC Master Direction — pass-through accounts must be re-verified.
   (c) FEMA 1999 — include ONLY if the brief says money left India; otherwise omit this bullet entirely.
   (d) FATF Recommendation 20 — cross-border and cross-bank layering.
   Each bullet: what the rule requires, which finding here engages it, and the filing plus deadline. Name real amounts and accounts — "STR required" alone is not a bullet.

4. "Investigation Assistant" — what to do on Monday morning, as numbered points ("1. ", "2. ", …). Name the exact accounts and say WHY each step, not just what: "Freeze ACC-X first — it takes money from 6 unrelated payers and empties within a day." Every point must be something a person can go and do — no "conduct a thorough investigation".

${PLAIN_LANGUAGE_RULES}`;

// One model, pinned, by requirement: models/gemini-3.1-flash-live-preview. There
// is no chain behind it and no catalogue discovery, which is worth stating
// plainly because an earlier version of this route had both and they existed for
// a reason — a route pinned to a single id dies the day that id is retired, and a
// "-preview" id is precisely the kind that gets retired. What stops that from
// looking like "the AI worked for two days and then stopped" is the local
// analysis engine: every failure path below ends in a real report computed from
// the same evidence, so the console degrades in wording rather than in function.
//
// The transport lives in src/lib/gemini.ts, because reaching this model is not a
// normal REST call — it declares only bidiGenerateContent, and it is an
// audio-native Live model that refuses a TEXT response modality outright. See the
// header comment there for what was tried and what the endpoint actually answered.
//
// Cost per turn, measured on the real prompts: a four-agent investigation is
// about 3,000 tokens of prompt and lands in roughly 4 seconds; a casual turn is
// well under a thousand. Both are far cheaper against a per-minute allowance than
// the Groq free tier they replaced, where one investigation very nearly emptied
// the whole minute's budget in a single shot.

// Four characters per token is crude, but it only has to be good enough to tell
// a 3,000-token request from a 600-token one. The real figure arrives with the
// answer in `usageMetadata` and settles the ledger afterwards.
const estimateTokens = (turns: { text: string }[], system: string, maxTokens: number) =>
  Math.ceil((turns.reduce((n, t) => n + t.text.length, 0) + system.length) / 4) + maxTokens;

// The data behind a report does not change between two clicks of the same
// button, so the report does not need to either. Keeping the last few successful
// answers means a repeated question comes back instantly, spends no quota, and
// reads identically to the first time. That last property is the one that
// matters: it makes a demo repeatable rather than a coin toss, and it is the
// difference between a judge seeing the same report twice and seeing the AI's
// wording drift between two runs on the same file.
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 24;
const cache = new Map<string, { at: number; model: string; content: string }>();

// FNV-1a. Short, stable, and good enough to tell one evidence brief from another.
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
// words in front of the user: one is "wait eleven seconds", the other is "the AI
// returned something unreadable". Keeping them apart here is what lets the
// handler give advice instead of a status code.
type Attempt =
  | { ok: true; text: string; model: string }
  | {
      ok: false;
      status: number;
      detail: string;
      rateLimited: boolean;
      daily: boolean;
      retryMs: number;
      // Set when the token governor declined to send the request at all because
      // the per-minute allowance could not cover it. Distinct from `rateLimited`,
      // which means Google refused one we did send: this one costs no round trip
      // and comes with an accurate wait rather than a guess.
      quotaHold?: boolean;
    };

// Failures worth a second attempt. A dropped socket, a timeout and a 5xx are all
// "ask again" — the Live API opens a fresh session per turn, so there is no state
// to be confused by a retry. A 1007 (invalid argument) is not: the request is
// wrong and will be wrong the second time too.
const isTransient = (status: number) =>
  status === 0 || status === 408 || status === 503 || status === 1006 || status === 1011;

// One turn, with the only two forms of persistence a single pinned model allows:
// the governor decides whether to send at all, and a failure that a short wait or
// a resample could plausibly fix gets exactly one more go.
//
// `validate` lets the caller reject an answer this route cannot use. The
// investigate path needs parseable JSON for four agents, and the model can return
// prose, or truncate at maxOutputTokens, and still call that a completed turn.
// With no second model to fall through to, a resample is the only second chance
// there is — and it is a real one, because that failure is usually sampling
// rather than the prompt.
async function askModel(
  apiKey: string,
  request: { system: string; turns: GeminiTurn[]; temperature: number; maxOutputTokens: number },
  validate: (text: string) => boolean,
  needed: number
): Promise<Attempt> {
  const startedAt = Date.now();

  // Everything this request may spend asleep, across every attempt. Waiting is
  // worth doing once — a real answer three seconds late beats a fallback report —
  // but waiting twice for the same shortfall spends sixteen seconds to deliver
  // what the first wait could have delivered in six. Both holds draw from this pot.
  let waitedMs = 0;
  const hold = async (ms: number) => {
    await sleep(ms);
    waitedMs += ms;
  };
  const budgetLeft = () => WAIT_BUDGET_MS - waitedMs;

  // What the governor knows, phrased as something the user can act on. Recomputed
  // at the moment it is needed rather than reused, because the allowance refills
  // continuously: a request that began thirty seconds short of the budget can
  // reach this line two seconds short of it.
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

  // Pre-flight. Skipping a request the allowance cannot cover costs nothing,
  // where sending it spends a round trip to be told the same thing. A shortfall
  // of a few seconds is absorbed silently instead — the handler has sixty seconds
  // to spend, and an answer that arrives late is a far better outcome than a
  // fallback report. Anything longer is not ours to hide: it goes back to the
  // caller as a number to show the user.
  const upfront = waitFor(needed);
  if (upfront > 0) {
    if (upfront > Math.min(ABSORB_MS, budgetLeft())) return quotaShort();
    console.warn(`[FinGuard] holding ${upfront}ms for the token budget to refill rather than degrading.`);
    await hold(upfront);
  }

  let last = await send();
  if (last.ok) return last;

  // Exactly one more attempt, and only when there is a reason to think it would
  // land differently. Repeating a request the endpoint called invalid changes
  // nothing; resampling one it answered unreadably usually does.
  const retryable = last.rateLimited || last.status === 422 || isTransient(last.status);
  if (!retryable) return last;

  // A quota refusal emptied the ledger, so the wait is now a real figure rather
  // than a guess. A dropped socket needs only long enough not to be a hot loop.
  const again = last.rateLimited ? waitFor(needed) : isTransient(last.status) ? RETRY_HOLD_MS : 0;

  if (again > budgetLeft()) {
    console.warn(
      `[FinGuard] already waited ${waitedMs}ms; not spending another ${again}ms — answering from the local engine instead.`
    );
    return last.rateLimited ? quotaShort() : last;
  }

  // And not on a request that has already been running a long time. The handler's
  // ceiling is sixty seconds, and a readable report at twenty beats a timeout at
  // sixty, which is a blank screen however good the reasoning was.
  if (Date.now() - startedAt + again > REQUEST_SOFT_LIMIT_MS) {
    console.warn(`[FinGuard] ${Date.now() - startedAt}ms spent already; not opening a second attempt.`);
    return last.rateLimited ? quotaShort() : last;
  }

  if (again > 0) await hold(again);
  console.warn(`[FinGuard] retrying once after ${last.status}: ${last.detail.slice(0, 120)}`);

  const second = await send();
  if (second.ok) return second;

  // Report the seconds rather than the status code when the seconds are the
  // actionable part — "free again in 11 seconds" beats "429".
  if (second.rateLimited && !second.daily) return quotaShort();
  return second;
}

// How long the route will silently hold a request waiting for tokens to refill.
// Comfortably inside the 60-second handler ceiling, and short enough that the
// person waiting reads it as a slightly slow answer rather than a hang. Past
// this, telling them the number beats making them stare at a spinner.
const ABSORB_MS = 6_000;

// The total a single request may spend asleep, across every attempt.
const WAIT_BUDGET_MS = 8_000;

// Long enough not to be a hot loop, short enough to be invisible. Only used
// after a dropped socket or a 5xx, where the wait is not about quota at all —
// there is nothing to refill, the connection just needs a fresh start.
const RETRY_HOLD_MS = 600;

// Past this much elapsed time, the route stops opening new attempts and answers
// with what it has. Well inside the 60-second handler ceiling, with room for one
// slow turn to finish rather than being cut off mid-answer.
const REQUEST_SOFT_LIMIT_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A model that prints its scratchpad into the answer rather than a separate field
// must never reach the reader, and must not break JSON parsing for the agent
// panel. The pinned model does not do this, but the transcript is a transcript —
// stripping the tags costs nothing and removes a whole class of surprise.
const stripThinking = (text: string) =>
  text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<\/?think(?:ing)?>/gi, "")
    .trim();

// Which path a typed question takes. The bar is an explicit request for the
// whole report — not a mention of its subject matter.
//
// This used to match any of twenty-six topic words, "suspicious", "risk",
// "find", "detect" and "what's wrong" among them. Those catch ordinary
// questions, and the four-agent panel answers with a fixed script over the
// entire portfolio rather than the thing that was asked, so two different
// questions came back as the same report: "Explain what's wrong with my data in
// simple words" tripped it on "what's wrong" and "Why are these transfers
// suspicious?" tripped it on "suspicious", and both produced identical output.
// Three of the five suggested queries never matched at all, which is why only
// those two collided.
//
// A question about the data belongs on the casual path, which reads the same
// evidence and actually answers what was asked. The full report keeps its own
// button, and that button passes `forcedMode`, so it never depends on this
// function. "str" is gone for a second reason: as a bare substring it also
// matched "administrator", "distribute" and "strange".
const INVESTIGATION_REQUESTS = [
  "investigate",
  "investigation",
  "audit",
  "full report",
  "full analysis",
  "complete analysis",
  "detailed report",
  "deep dive",
  "run the agents",
  "agent panel",
  "analyze everything",
  "analyse everything",
  "explain everything",
];

function wantsInvestigation(msg: string): boolean {
  const m = msg.toLowerCase();
  return INVESTIGATION_REQUESTS.some((k) => m.includes(k));
}

// Gemini accepts two turn roles, "user" and "model". The client keeps richer
// roles for its own bubbles ("report", "agent"), and one of those reaching the
// API rejects the whole request, which the user sees as "AI service
// unavailable". Anything that isn't a user turn is folded into "model", and
// entries without usable text are dropped rather than sent.
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

// Who to count this request against. The signed-in account is the right unit —
// a household or a college computer lab shares one public IP, and limiting by
// address there means classmates throttle each other for no reason. It arrives
// from the client and is therefore trivially forgeable, which is fine: this
// limiter divides a shared allowance fairly, it is not a security boundary. The
// token governor is what actually protects the quota, and claiming somebody
// else's id does not buy a single extra token from it.
function callerId(req: Request, uid: unknown): string {
  if (typeof uid === "string" && uid.trim()) return `u:${uid.trim().slice(0, 128)}`;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${forwarded || req.headers.get("x-real-ip") || "local"}`;
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

    // Analyse the data server-side first. This is what makes answers specific.
    //
    // Two sizes of the same evidence, because the two paths are not the same job.
    // The report needs the full working document; a chat turn needs the facts and
    // nothing telling it how to write. Sending the long one to a casual question
    // cost 16 seconds a turn where the short one costs under two — see the note
    // above `casualBrief`.
    const txs: Transaction[] = Array.isArray(context) ? context : [];
    const evidence = buildEvidence(txs);
    const brief = investigate ? evidenceBrief(evidence) : casualBrief(evidence);

    // Nothing to investigate — answer from the local engine rather than asking
    // the model to improvise. Sent to the AI it produced four near-identical
    // "there is no data" bubbles, which read exactly like the cold, generic
    // reply this whole path exists to avoid.
    if (investigate && !evidence.txCount) {
      return NextResponse.json(investigatePayload(evidence, localReport(evidence)));
    }

    const apiKey = geminiKey();

    // No key, or no data — still give a real report rather than an error.
    if (!apiKey) {
      if (investigate) {
        return NextResponse.json(
          investigatePayload(
            evidence,
            localReport(evidence),
            "Running on the local analysis engine (no AI key configured)."
          )
        );
      }
      return NextResponse.json({
        mode: "casual",
        reply: "The AI service isn't configured, so I can't chat freely — but the Run full investigation button still works, it uses the built-in analysis engine.",
        suggestions: followUps(evidence),
      });
    }

    // Gemini keeps the system instruction out of the turn list and calls the
    // assistant "model" rather than "assistant", so the conversation is assembled
    // in that shape rather than OpenAI's.
    //
    // The question is labelled and repeated after the brief on the investigate
    // path. Unlabelled and sitting on top of eight thousand characters of
    // evidence it read as a preamble to the data rather than the thing to answer,
    // and the report came back the same whatever had been asked.
    const system = investigate ? INVESTIGATE_PROMPT : CASUAL_PROMPT;
    const briefBlock = `=== EVIDENCE BRIEF (computed from the user's real data) ===\n${brief}`;
    const turns: GeminiTurn[] = [
      ...sanitizeHistory(history),
      {
        role: "user",
        text: investigate
          ? `THE QUESTION: ${message}\n\n${briefBlock}\n\n=== END OF BRIEF ===\nNow answer THE QUESTION above — "${message}" — as the four agents.`
          : `${message}\n\n${briefBlock}`,
      },
    ];

    // Bullets, not essays — a report lands well inside this, and the per-minute
    // token budget is spent far slower with a realistic cap. The investigate
    // figure is measured rather than guessed: a full four-agent answer runs to
    // about 2,500 characters of JSON, and 2,000 tokens leaves room for a wordier
    // sampling without ever truncating mid-object, which would cost the whole turn.
    //
    // The casual figure is measured too, and it is larger than it looks like it
    // needs to be. This model only emits AUDIO — it refuses a TEXT modality
    // outright — so on any turn where it decides to speak, the cap is spent on
    // audio tokens rather than on words. `responseTokensDetails` puts a spoken
    // two-sentence answer at 438-502 AUDIO tokens, which means a 500 cap lands
    // exactly on the edge: sometimes it suppresses the speech and the answer is
    // fine, sometimes generation stops mid-sentence and the user reads "9
    // transfers totalling ₹82.88 L, every one between" and nothing after it.
    // 1,500 clears the measured cost with room for a long answer on top. It costs
    // nothing in practice — the ledger is settled against real usage below, and a
    // spoken turn really spends about 930 tokens.
    const maxTokens = investigate ? 2_000 : 1_500;

    // Only investigations are cached. A report is a function of the data and the
    // question, so repeating either should give the same answer — whereas a
    // casual turn depends on the conversation so far, which is not in this key.
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

    // Counted only now, after the cache has had its chance. A repeated question
    // is answered from memory without touching Gemini, so charging it against
    // anyone's allowance would punish the one usage pattern that costs nothing —
    // and it is exactly the pattern a demo relies on.
    const who = callerId(req, uid);
    const kind = investigate ? "investigate" : "casual";
    const verdict = checkRate(who, kind);

    if (!verdict.ok) {
      // A slot about to open is worth waiting for. Absorbing it here turns a
      // refusal into a slightly slow answer, which is almost always what the
      // person clicking actually wanted.
      if (verdict.retryAfterMs <= ABSORB_MS) {
        await sleep(verdict.retryAfterMs);
      } else {
        const wait = seconds(verdict.retryAfterMs);
        const busy =
          verdict.scope === "global"
            ? "The console is handling a lot of requests right now"
            : "That's a lot of requests in one minute";
        console.warn(`[FinGuard] rate limit (${verdict.scope}) for ${who} on ${kind}; ${wait}s to wait.`);

        // An investigation still produces its report. The built-in engine reads
        // the same evidence and needs no quota, so there is no reason to show
        // someone a refusal when a real answer is available.
        if (investigate) {
          return NextResponse.json(
            investigatePayload(
              evidence,
              localReport(evidence),
              `${busy} — this report came from the built-in analysis engine. The AI's wording is free again in ${wait} seconds.`
            )
          );
        }
        // A chat turn has no local equivalent, so this is the one place a plain
        // refusal is the honest answer. `retryAfter` drives the countdown in the UI.
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
      // Only the investigate path has a shape it must hit. A casual reply is
      // whatever the model said, so any non-empty answer is usable.
      investigate
        ? (text) => parseAgents(stripThinking(text)) !== null
        : (text) => stripThinking(text).length > 0,
      needed
    );

    if (!outcome.ok) {
      console.error("[FinGuard] Gemini unavailable:", outcome.status, outcome.detail);
      const { rateLimited, daily, quotaHold } = outcome;
      // The slot was charged for a call that never produced an answer, so hand it
      // back — a user whose request broke on a 400 or a 5xx should not pay the
      // same allowance as one who was served.
      //
      // But not when the failure was the pace itself. A quota hold or a 429 means
      // this request arrived faster than the free tier can absorb, which is the
      // precise thing the limiter is counting; refunding it would let someone
      // hammer the button forever, each refusal handing its slot straight back,
      // and the per-user counter would never reach its cap.
      if (!rateLimited) refund(who, kind);

      const held = quotaHold ? seconds(outcome.retryMs) : 0;
      // A daily cap needs hours, a per-minute cap needs seconds, and a governor
      // hold knows the exact figure. Saying "wait a minute" when the answer is
      // "wait until tomorrow" just wastes the user's time on retries that cannot
      // succeed — and saying "a minute" when we know it is nine is worse advice
      // than the number we already have.
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
              ? `${waitAdvice} This report came from the built-in analysis engine instead — it reads the same data, just without the AI's wording.`
              : "The AI service was unreachable, so this report came from the local analysis engine."
          )
        );
      }
      // Casual questions have no local equivalent, so say what happened in
      // plain words instead of surfacing a bare status code.
      return NextResponse.json({
        mode: "casual",
        reply: rateLimited
          ? `${waitAdvice} That's a limit on the free plan, not a problem with your data or your key. ${daily ? "Run full investigation still works in the meantime — it uses the built-in engine and needs no AI." : "Give it a moment and ask again, or use Run full investigation, which works either way."}`
          : "The AI service didn't respond just now. Try again in a moment — Run full investigation works either way, since it can fall back to the built-in engine.",
        suggestions: followUps(evidence),
        degraded: rateLimited ? waitAdvice : "AI service unavailable.",
        ...(quotaHold ? { retryAfter: held } : {}),
      });
    }

    const raw = stripThinking(outcome.text);

    // What the governor believes is left in the per-minute allowance. Rides along
    // for the same reason the model id does: it costs nothing, it is not a secret,
    // and it turns "why was that one slower" into one glance at the network tab.
    // The QA harness reads it to check the ledger settles against the real token
    // counts Gemini reports rather than drifting on its own estimate.
    const budget = ledgerSnapshot();

    if (!investigate) {
      const clean = raw.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
      // Which model answered rides along on every reply. It costs nothing, it is
      // not a secret, and it turns "the AI is being weird again" into one glance
      // at the network tab.
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
          "The AI returned an unreadable response, so this report came from the local analysis engine."
        )
      );
    }

    if (key) {
      // Oldest first out. Map keeps insertion order, so the first key is the
      // stalest — a plain bound, not a real LRU, because 24 entries of a
      // single-user demo never need one.
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: Date.now(), model: outcome.model, content: raw });
    }

    return NextResponse.json({ ...investigatePayload(evidence, agents), model: outcome.model, budget });
  } catch (err) {
    console.error("[FinGuard] Chat API error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// The model may return a bare array, or an object wrapping one under any key
// (json_object mode forces an object). Accept every shape rather than falling
// back to a generic message.
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

// The brief labels its findings F1, F2 and its rings R1, R2 so the model can
// hold them apart. The reader has never seen the brief, so "F2 engages RBI KYC"
// is a reference to nothing. The prompt forbids printing them and mostly that
// holds, but it is one sampling away from failing, and a citation to an invisible
// document is the kind of thing a judge notices. Swapping in the plain noun the
// label stood for leaves the sentence grammatical either way.
// The lookarounds keep it off account names — ACC-R1 is a name, not a ring.
function stripInternalLabels(text: string) {
  return text
    .replace(/(?<![-\w])F(\d{1,2})(?![-\w])/g, "this finding")
    .replace(/(?<![-\w])R(\d{1,2})(?![-\w])/g, "this group")
    .replace(/\bfinding this finding\b/gi, "this finding")
    .replace(/\bring this group\b/gi, "this group");
}

// The model mirrors the indentation of the prompt's own nested lists, so bullets
// arrive with six leading spaces. Strip it here rather than asking it not to.
function tidyBullets(text: string) {
  return stripInternalLabels(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .trim();
}

/**
 * The panels render confidence as a percentage of 1, and the prompt asks for
 * 0-1. Gemini answers 95 about as often as 0.95 — reading either literally puts
 * "9500%" on the screen — so a value above 1 is taken as a percentage. A model
 * that means "certain" and writes 1 still lands on 1, and anything outside the
 * scale is clamped rather than trusted.
 */
function confidenceOf(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0.85;
  const scaled = raw > 1 ? raw / 100 : raw;
  return Math.min(1, Math.max(0, scaled));
}

function normalize(list: unknown[]) {
  const cleaned = list
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      agent: String(a.agent ?? a.name ?? "Investigation Assistant"),
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

function summarize(ev: ReturnType<typeof buildEvidence>) {
  return {
    txCount: ev.txCount,
    accountCount: ev.accountCount,
    ringCount: ev.rings.filter((r) => r.accounts.length >= 3).length,
    findingCount: ev.findings.length,
    highCount: ev.bySeverity.high,
  };
}

// ── The short answer ───────────────────────────────────────────────────────
// "Run full investigation" used to reply with four agent bubbles totalling a
// page of text. The verdict below is what the user actually asked for: how bad
// it is, in one sentence, with at most four facts behind it. It is computed
// from the evidence engine rather than the model, so it is always present, its
// numbers always match the data, and it costs no tokens.
function verdictOf(ev: Evidence): {
  level: Severity;
  headline: string;
  points: string[];
  accounts: string[];
} {
  if (!ev.txCount) {
    return {
      level: "safe",
      headline: "No transactions loaded yet.",
      points: ["Import a CSV from the Upload tab and run this again."],
      accounts: [],
    };
  }

  const hard = ev.findings.filter((f) => f.severity === "high");
  const level: Severity = hard.length || ev.bySeverity.high ? "high" : ev.bySeverity.medium ? "medium" : "safe";
  const rings = ev.rings.filter((r) => r.accounts.length >= 3);
  const named = Array.from(new Set(rings.map((r) => r.typology).filter(Boolean))) as string[];

  const headline =
    level === "high"
      ? `${hard.length || ev.bySeverity.high} serious problem${(hard.length || ev.bySeverity.high) === 1 ? "" : "s"} found — ` +
        `${formatINR(ev.highValue)} of ${formatINR(ev.totalValue)} is high-risk.`
      : level === "medium"
        ? `Nothing criminal stands out, but ${ev.bySeverity.medium} transfer${ev.bySeverity.medium === 1 ? "" : "s"} ` +
          `are large enough to keep an eye on.`
        : `All ${ev.txCount} transfers look routine. Nothing to escalate.`;

  const points: string[] = [];
  if (named.length) {
    points.push(`Patterns matched: ${named.slice(0, 4).join(", ")}.`);
  }
  for (const f of ev.findings.slice(0, 3)) points.push(f.short || f.title);
  if (points.length < 2) {
    points.push(
      `${ev.txCount} transfers, ${ev.accountCount} accounts, ${formatINR(ev.totalValue)} across ${ev.banks.length} bank${ev.banks.length === 1 ? "" : "s"}.`
    );
  }

  // The accounts the graph should open focused on: whatever the hard findings
  // actually name, worst finding first.
  const accounts: string[] = [];
  for (const f of hard.length ? hard : ev.findings) {
    for (const a of f.accounts) if (!accounts.includes(a)) accounts.push(a);
  }

  return { level, headline, points: points.slice(0, 4), accounts: accounts.slice(0, 14) };
}

// Follow-ups are generated from the data, not the model, so they always name
// something that exists and never cost a request.
function followUps(ev: Evidence): string[] {
  if (!ev.txCount) return ["How do I upload my transactions?", "What file format do you need?"];

  const out: string[] = [];
  const ring = ev.rings.find((r) => r.typology && r.accounts.length >= 3);
  if (ring?.typology) out.push(`Explain the ${ring.typology.toLowerCase()} in simple words`);
  const hub = ev.topCounterparties[0]?.account;
  if (hub) out.push(`Why is ${hub} suspicious?`);
  if (ev.findings.length) out.push("Which accounts should I freeze first?");
  out.push("What laws does this break?");
  out.push("Show me the biggest money flows");
  return out.slice(0, 3);
}

// Every investigate reply has the same shape; building it in one place stops the
// five exit paths from drifting apart.
function investigatePayload(ev: Evidence, agents: unknown, degraded?: string) {
  return {
    mode: "investigate" as const,
    agents,
    verdict: verdictOf(ev),
    suggestions: followUps(ev),
    evidence: summarize(ev),
    ...(degraded ? { degraded } : {}),
  };
}
