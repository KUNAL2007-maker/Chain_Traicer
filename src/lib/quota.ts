/**
 * Two guards that stand between a click and Google AI Studio's free tier.
 *
 * The first is a token ledger. A four-agent investigation is a single expensive
 * call — around 3,000 tokens of prompt plus whatever the answer runs to — and the
 * free tier meters tokens per minute. The route used to find that out the
 * expensive way: send the request, read the refusal, react. That wastes a round
 * trip and, worse, it cannot tell the person waiting how long to wait. So the
 * arithmetic happens ahead of the call instead of behind it.
 *
 * The second is a per-user limiter, because a quota shared by everyone is a
 * quota one person can empty. Three investigations a minute is far more than
 * anyone reviewing a report needs and far less than a stuck mouse button
 * produces.
 *
 * Both keep their state in memory, deliberately, exactly like the report cache
 * in the chat route. See the note above `checkRate` for what that costs on
 * serverless and why it is still the right call here.
 *
 * One thing changed for the worse in the move off Groq, and it is worth being
 * plain about. Groq printed its own meter on every response — a remaining-token
 * count that was account-wide, so any serverless instance could correct itself
 * from one reply. The Gemini Live socket sends no such figure. What it does send
 * is `usageMetadata`, the real token count for the turn that just happened, so
 * this ledger tracks actual spend accurately but only its own instance's spend.
 * `noteExhausted` is what closes that gap: the first genuine refusal empties the
 * bucket, and the governor behaves correctly from then on.
 */

// One pinned model means one bucket. The name is kept in the snapshot because the
// QA harness prints it, and because a second model would need a second bucket
// rather than a shared one.
export type Bucket = "gemini-live";

/**
 * Tokens per minute this instance may spend.
 *
 * 65,000 is the free tier's per-minute allowance for this project's key. It is
 * configuration rather than a figure read off the wire — unlike Groq, the Live
 * API publishes no per-response meter, so nothing here can discover the number
 * on its own. Two things keep that from mattering: `GEMINI_TPM` overrides it
 * without a code change, and `noteExhausted` below empties the ledger the moment
 * Google actually refuses a request, so an allowance that turns out to be lower
 * costs one refusal to learn rather than a broken console.
 *
 * For scale: one four-agent investigation costs about 5,800 tokens, so eleven
 * fit in a minute — comfortably more than the per-user limiter allows anyone to
 * ask for, which is the point. The governor is the backstop, not the gate.
 */
const TPM_LIMIT = (() => {
  const fromEnv = Number(process.env.GEMINI_TPM);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 65_000;
})();

type Ledger = {
  /** Tokens left at the moment `syncedAt` was taken. */
  remaining: number;
  limit: number;
  syncedAt: number;
};

const ledger: Ledger = { remaining: TPM_LIMIT, limit: TPM_LIMIT, syncedAt: Date.now() };

/**
 * The allowance refills continuously rather than at a window boundary, so a
 * request only ever waits for its shortfall. Tokens come back at limit/60000 per
 * millisecond — the same smooth model that was proven against Groq's own reset
 * header (73 tokens spent reported 547ms of refill, and 73 tokens at 8,000/minute
 * is 547.5ms), and the one a per-minute quota implies.
 */
function projected(now: number): number {
  const refilled = ledger.remaining + ((now - ledger.syncedAt) * ledger.limit) / 60_000;
  return Math.min(ledger.limit, Math.max(0, refilled));
}

/**
 * Replace the up-front estimate with what the turn actually cost. The estimate
 * is four characters to a token, which is fine for telling a 3,000-token request
 * from a 600-token one and no better than that; `usageMetadata` is the truth, and
 * applying it keeps a long run of requests from drifting.
 */
export function syncFromUsage(usage: { totalTokens: number } | null, estimated: number): void {
  if (!usage || !Number.isFinite(usage.totalTokens) || usage.totalTokens <= 0) return;
  // The estimate was already debited by `reserve`. Settle the difference rather
  // than debiting the whole real figure a second time.
  const correction = usage.totalTokens - estimated;
  ledger.remaining = Math.min(ledger.limit, Math.max(0, projected(Date.now()) - correction));
  ledger.syncedAt = Date.now();
}

/**
 * Google has refused a request for quota. Whatever this instance believed about
 * its remaining allowance was wrong, so empty the bucket and let the refill rate
 * decide when it is safe to ask again. This is the one signal that corrects a
 * TPM_LIMIT set too high, and it costs exactly one refused request to learn.
 */
export function noteExhausted(): void {
  ledger.remaining = 0;
  ledger.syncedAt = Date.now();
}

/**
 * Milliseconds until the model can afford a `needed`-token request; 0 if it can
 * right now. The caller decides whether that wait is worth absorbing or worth
 * reporting — a two-second hold is invisible, a forty-second one needs saying
 * out loud.
 */
export function waitFor(needed: number): number {
  // A request larger than the whole per-minute allowance can never fit, no
  // matter how long anyone waits. Report the full-refill time and let the caller
  // treat it as the long wait it is, rather than returning Infinity and forcing
  // every call site to special-case it.
  if (needed > ledger.limit) return 60_000;

  const short = needed - projected(Date.now());
  if (short <= 0) return 0;
  return Math.ceil((short * 60_000) / ledger.limit);
}

/**
 * Debit before the call rather than after it. Two requests arriving together in
 * one instance would otherwise both read the same healthy ledger, both decide
 * they have room, and both spend it — the exact double-spend the governor exists
 * to prevent. `syncFromUsage` settles the difference once the real cost is known.
 */
export function reserve(needed: number): void {
  ledger.remaining = Math.max(0, projected(Date.now()) - needed);
  ledger.syncedAt = Date.now();
}

/** Hand back a reservation for a call that never reached Google at all. */
export function release(needed: number): void {
  ledger.remaining = Math.min(ledger.limit, projected(Date.now()) + needed);
  ledger.syncedAt = Date.now();
}

/** Read-only view of the ledger, for logging and for the QA harness. */
export function ledgerSnapshot() {
  return {
    bucket: "gemini-live" satisfies Bucket,
    limit: ledger.limit,
    projected: Math.round(projected(Date.now())),
  };
}

// ---------------------------------------------------------------------------
// Per-user rate limiting
// ---------------------------------------------------------------------------

// An investigation is the expensive call and the one worth clicking twice by
// accident, so it gets the tight number. Chat is cheap enough that the limit is
// really only there to stop a script. The global ceiling is the backstop: it
// bounds what every user together can draw out of one shared free tier, which
// is the number that actually decides whether the app still works while someone
// is watching it.
export const LIMITS = {
  investigatePerMin: 3,
  casualPerMin: 12,
  globalPerMin: 25,
} as const;

const WINDOW_MS = 60_000;

// Left in memory on purpose. Firestore-backed counters would survive across
// serverless instances, but they would also add a read and a write to every
// single turn — spending Firebase quota to protect Gemini quota, and adding
// latency to the request the user is waiting on. At this scale a warm instance
// serves a whole session, so per-instance counters are accurate in practice and
// free. The token ledger above is what genuinely protects the allowance; this is
// fairness between users, and it is allowed to be approximate.
type Window = { investigate: number[]; casual: number[] };
const perUser = new Map<string, Window>();
const globalHits: number[] = [];

// One entry per identity, so an open endpoint plus a script equals unbounded
// growth. Oldest-first eviction keeps it to a few hundred, which is far more
// than a demo needs and small enough to never matter.
const MAX_TRACKED_USERS = 500;

const prune = (hits: number[], now: number) => {
  while (hits.length && now - hits[0] >= WINDOW_MS) hits.shift();
  return hits;
};

export type RateVerdict =
  | { ok: true }
  | { ok: false; retryAfterMs: number; scope: "user" | "global" };

/**
 * A sliding window rather than a fixed one, because a fixed window lets someone
 * spend a whole minute's allowance in the last second of one window and again in
 * the first second of the next. `retryAfterMs` is when the oldest hit in the
 * window falls out of it — the real moment a slot opens, not a round number.
 *
 * Only counts calls that will actually reach Gemini. A cached report costs
 * nothing, so the caller checks its cache first and never gets here on a hit.
 */
export function checkRate(id: string, kind: "investigate" | "casual"): RateVerdict {
  const now = Date.now();

  prune(globalHits, now);
  if (globalHits.length >= LIMITS.globalPerMin) {
    return { ok: false, retryAfterMs: WINDOW_MS - (now - globalHits[0]), scope: "global" };
  }

  let w = perUser.get(id);
  if (!w) {
    if (perUser.size >= MAX_TRACKED_USERS) {
      const oldest = perUser.keys().next().value;
      if (oldest !== undefined) perUser.delete(oldest);
    }
    w = { investigate: [], casual: [] };
  } else {
    // Re-inserted below, so the Map's insertion order stays least-recently-used
    // first and the eviction above removes the right entry.
    perUser.delete(id);
  }
  perUser.set(id, w);

  const hits = prune(kind === "investigate" ? w.investigate : w.casual, now);
  const cap = kind === "investigate" ? LIMITS.investigatePerMin : LIMITS.casualPerMin;
  if (hits.length >= cap) {
    return { ok: false, retryAfterMs: WINDOW_MS - (now - hits[0]), scope: "user" };
  }

  hits.push(now);
  globalHits.push(now);
  return { ok: true };
}

/**
 * Give a slot back when the call it was taken for never happened — a governor
 * hold that turned into a local report, say. Without this, a refusal would cost
 * the user the same allowance as an answer.
 */
export function refund(id: string, kind: "investigate" | "casual"): void {
  const w = perUser.get(id);
  if (w) (kind === "investigate" ? w.investigate : w.casual).pop();
  globalHits.pop();
}

/** Whole seconds, rounded up, and never zero — "wait 0 seconds" is not advice. */
export const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
