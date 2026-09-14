"""Two guards between a click and Google AI Studio's free tier — ported 1:1 from
src/lib/quota.ts.

The first is a token ledger that does the per-minute arithmetic ahead of the call
instead of behind it, so a request that cannot fit is held (or reported) rather
than sent and refused. The second is a per-user sliding-window limiter so one
person cannot empty a shared allowance. Both keep their state in memory,
deliberately — a warm process serves a whole session, and the token ledger is
what genuinely protects the quota; the limiter is fairness between users and is
allowed to be approximate.
"""
from __future__ import annotations

import math
import os
import time


def _now_ms() -> float:
    return time.time() * 1000


# One pinned model means one bucket.
Bucket = str  # "gemini-live"


def _tpm_limit() -> float:
    try:
        from_env = float(os.environ.get("GEMINI_TPM", ""))
    except (TypeError, ValueError):
        from_env = float("nan")
    return from_env if math.isfinite(from_env) and from_env > 0 else 65_000


TPM_LIMIT = _tpm_limit()

ledger = {"remaining": TPM_LIMIT, "limit": TPM_LIMIT, "syncedAt": _now_ms()}


def projected(now: float) -> float:
    refilled = ledger["remaining"] + ((now - ledger["syncedAt"]) * ledger["limit"]) / 60_000
    return min(ledger["limit"], max(0.0, refilled))


def syncFromUsage(usage: dict | None, estimated: float) -> None:
    """Replace the up-front estimate with what the turn actually cost."""
    if not usage:
        return
    total = usage.get("totalTokens")
    if total is None or not math.isfinite(total) or total <= 0:
        return
    correction = total - estimated
    ledger["remaining"] = min(ledger["limit"], max(0.0, projected(_now_ms()) - correction))
    ledger["syncedAt"] = _now_ms()


def noteExhausted() -> None:
    """Google refused for quota — empty the bucket and let the refill rate decide."""
    ledger["remaining"] = 0
    ledger["syncedAt"] = _now_ms()


def waitFor(needed: float) -> int:
    """Milliseconds until the model can afford a `needed`-token request; 0 if now."""
    if needed > ledger["limit"]:
        return 60_000
    short = needed - projected(_now_ms())
    if short <= 0:
        return 0
    return math.ceil((short * 60_000) / ledger["limit"])


def reserve(needed: float) -> None:
    """Debit before the call rather than after it, to prevent a double-spend."""
    ledger["remaining"] = max(0.0, projected(_now_ms()) - needed)
    ledger["syncedAt"] = _now_ms()


def release(needed: float) -> None:
    """Hand back a reservation for a call that never reached Google at all."""
    ledger["remaining"] = min(ledger["limit"], projected(_now_ms()) + needed)
    ledger["syncedAt"] = _now_ms()


def ledgerSnapshot() -> dict:
    return {
        "bucket": "gemini-live",
        "limit": ledger["limit"],
        "projected": math.floor(projected(_now_ms()) + 0.5),
    }


# ---------------------------------------------------------------------------
# Per-user rate limiting
# ---------------------------------------------------------------------------
LIMITS = {
    "investigatePerMin": 3,
    "casualPerMin": 12,
    "globalPerMin": 25,
}

WINDOW_MS = 60_000

# One entry per identity, least-recently-used first. Insertion order is the LRU
# order — a hit deletes and re-inserts, so the oldest key is always first.
perUser: dict[str, dict] = {}
globalHits: list[float] = []

MAX_TRACKED_USERS = 500


def _prune(hits: list[float], now: float) -> list[float]:
    while hits and now - hits[0] >= WINDOW_MS:
        hits.pop(0)
    return hits


def checkRate(id: str, kind: str) -> dict:
    """A sliding window. Returns {"ok": True} or
    {"ok": False, "retryAfterMs": int, "scope": "user"|"global"}."""
    now = _now_ms()

    _prune(globalHits, now)
    if len(globalHits) >= LIMITS["globalPerMin"]:
        return {"ok": False, "retryAfterMs": WINDOW_MS - (now - globalHits[0]), "scope": "global"}

    w = perUser.get(id)
    if w is None:
        if len(perUser) >= MAX_TRACKED_USERS:
            oldest = next(iter(perUser), None)
            if oldest is not None:
                del perUser[oldest]
        w = {"investigate": [], "casual": []}
    else:
        # Re-inserted below, so insertion order stays least-recently-used first.
        del perUser[id]
    perUser[id] = w

    hits = _prune(w["investigate"] if kind == "investigate" else w["casual"], now)
    cap = LIMITS["investigatePerMin"] if kind == "investigate" else LIMITS["casualPerMin"]
    if len(hits) >= cap:
        return {"ok": False, "retryAfterMs": WINDOW_MS - (now - hits[0]), "scope": "user"}

    hits.append(now)
    globalHits.append(now)
    return {"ok": True}


def refund(id: str, kind: str) -> None:
    """Give a slot back when the call it was taken for never happened."""
    w = perUser.get(id)
    if w:
        arr = w["investigate"] if kind == "investigate" else w["casual"]
        if arr:
            arr.pop()
    if globalHits:
        globalHits.pop()


def seconds(ms: float) -> int:
    """Whole seconds, rounded up, never zero — 'wait 0 seconds' is not advice."""
    return max(1, math.ceil(ms / 1000))
