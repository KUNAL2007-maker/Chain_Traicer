"""The chat + investigation orchestrator — ported from src/app/api/chat/route.ts.

Two modes over one pinned model: normal chat for questions and small talk, and
the 4-agent panel for an actual investigation. Both are grounded in a pre-computed
evidence brief so the model quotes this user's real numbers instead of generic AML
theory. Every failure path ends in a real report computed from the same evidence
by app/investigation.py, so the console degrades in wording rather than in
function — no key, no quota, a dropped socket, an unreadable answer all still
produce a grounded report.

The Next.js route read the transactions from the POST body; here they are loaded
from the database by the caller (app/main.py) and passed in as `txs`, so the
browser never has to ship the whole ledger up on every turn.
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import time
from typing import Callable, Optional

from .domain import formatINR
from .investigation import (
    AgentReport,
    buildEvidence,
    casualBrief,
    evidenceBrief,
    localReport,
)
from .gemini import askGemini, geminiKey
from .quota import (
    checkRate,
    ledgerSnapshot,
    noteExhausted,
    refund,
    release,
    reserve,
    seconds,
    syncFromUsage,
    waitFor,
)


def _now_ms() -> float:
    return time.time() * 1000


# ── Prompts ───────────────────────────────────────────────────────────────────
# Reproduced verbatim from the TypeScript route. Two modes share one writing
# rulebook so their tone matches; the reader is a shop owner or a student, not a
# compliance officer, and the prompts spend most of their length forcing that.

PLAIN_LANGUAGE_RULES = """HOW TO WRITE — this matters as much as the analysis:
- Write for someone with no banking or compliance background. A student or a shop owner should follow every sentence.
- Explain jargon the moment you use it: "structuring (splitting one big payment into several small ones so the bank never has to report it)".
- ALWAYS quote the real account names, amounts, dates and bank names from the brief. Never write "Account A" or "a large sum".
- Say WHY something is wrong, not just that it is. Compare it to what normal activity would look like.
- Use short paragraphs and bullet points. Never a wall of text.
- Shortest wording that still carries the fact and the reason. Cut every word that earns nothing: "in order to" → "to", "at this point in time" → "now", "it appears that" → delete.
- Be direct and confident. No "it may potentially be advisable to consider"."""

CASUAL_PROMPT = (
    """You are FinGuard Intelligence's assistant, helping a user understand their own transaction data and financial-crime concepts.

Answer in plain conversational English, 2-5 sentences. If the user asks about their data, answer using ONLY the evidence brief provided — quote real account names and amounts from it. If the brief says no data is uploaded, say so and suggest uploading a CSV. Never invent transactions.

"""
    + PLAIN_LANGUAGE_RULES
)

INVESTIGATE_PROMPT = (
    """You are FinGuard Intelligence, a 4-agent financial-crime analysis system. You are given a pre-computed evidence brief about the user's real transactions.

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

"""
    + PLAIN_LANGUAGE_RULES
)


# ── Token estimation ──────────────────────────────────────────────────────────
# Four characters per token is crude, but it only has to tell a 3,000-token
# request from a 600-token one. The real figure arrives with the answer in
# usageMetadata and settles the ledger afterwards.
def estimateTokens(turns: list[dict], system: str, maxTokens: int) -> int:
    total = sum(len(t["text"]) for t in turns)
    return math.ceil((total + len(system)) / 4) + maxTokens


# ── Report cache ──────────────────────────────────────────────────────────────
# The data behind a report does not change between two clicks of the same button,
# so the report does not need to either. Keeping the last few successful answers
# means a repeated question comes back instantly, spends no quota, and reads
# identically — which is what makes a demo repeatable rather than a coin toss.
CACHE_TTL_MS = 15 * 60 * 1000
CACHE_MAX = 24
cache: dict[str, dict] = {}

_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(n: int) -> str:
    if n == 0:
        return "0"
    out = []
    while n:
        n, r = divmod(n, 36)
        out.append(_B36[r])
    return "".join(reversed(out))


def fingerprint(s: str) -> str:
    """FNV-1a. Short, stable, and good enough to tell one evidence brief from another."""
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return _base36(h & 0xFFFFFFFF)


# ── Retry policy ──────────────────────────────────────────────────────────────
# A dropped socket, a timeout and a 5xx are all "ask again" — the Live API opens a
# fresh session per turn, so there is no state a retry can confuse. A 1007 (invalid
# argument) is not: the request is wrong and will be wrong the second time too.
def isTransient(status: int) -> bool:
    return status in (0, 408, 503, 1006, 1011)


# How long the route will silently hold a request waiting for tokens to refill.
ABSORB_MS = 6_000
# The total a single request may spend asleep, across every attempt.
WAIT_BUDGET_MS = 8_000
# Long enough not to be a hot loop, short enough to be invisible.
RETRY_HOLD_MS = 600
# Past this much elapsed time, the route stops opening new attempts.
REQUEST_SOFT_LIMIT_MS = 30_000


# A model that prints its scratchpad into the answer must never reach the reader,
# and must not break JSON parsing for the agent panel. Stripping the tags costs
# nothing and removes a whole class of surprise.
_THINK_BLOCK = re.compile(r"<think(?:ing)?>[\s\S]*?</think(?:ing)?>", re.I)
_THINK_TAG = re.compile(r"</?think(?:ing)?>", re.I)


def stripThinking(text: str) -> str:
    return _THINK_TAG.sub("", _THINK_BLOCK.sub("", text)).strip()


# Which path a typed question takes. The bar is an explicit request for the whole
# report — not a mention of its subject matter. A question about the data belongs
# on the casual path, which reads the same evidence and actually answers it.
INVESTIGATION_REQUESTS = [
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
]


def wantsInvestigation(msg: str) -> bool:
    m = msg.lower()
    return any(k in m for k in INVESTIGATION_REQUESTS)


# Gemini accepts two turn roles, "user" and "model". The client keeps richer roles
# for its own bubbles ("report", "agent"), and one of those reaching the API
# rejects the whole request. Anything that isn't a user turn is folded into
# "model", and entries without usable text are dropped rather than sent.
def sanitizeHistory(history) -> list[dict]:
    if not isinstance(history, list):
        return []
    out: list[dict] = []
    for m in history[-6:]:
        role = m.get("role") if isinstance(m, dict) else None
        content = m.get("content") if isinstance(m, dict) else None
        if not isinstance(content, str) or not content.strip():
            continue
        out.append({"role": "user" if role == "user" else "model", "text": content})
    return out


# Who to count this request against. The signed-in account is the right unit — a
# college computer lab shares one public IP. It is trivially forgeable, which is
# fine: this limiter divides a shared allowance fairly, it is not a security
# boundary. The token governor is what actually protects the quota.
def callerId(uid, client_ip: str) -> str:
    if isinstance(uid, str) and uid.strip():
        return f"u:{uid.strip()[:128]}"
    return f"ip:{client_ip or 'local'}"


# ── The one turn, with retry ──────────────────────────────────────────────────
async def askModel(
    apiKey: str,
    request: dict,
    validate: Callable[[str], bool],
    needed: int,
) -> dict:
    """One turn, with the only two forms of persistence a single pinned model
    allows: the governor decides whether to send at all, and a failure a short
    wait or a resample could plausibly fix gets exactly one more go."""
    startedAt = _now_ms()

    waited = {"ms": 0}

    async def hold(ms: float) -> None:
        await asyncio.sleep(ms / 1000)
        waited["ms"] += ms

    def budgetLeft() -> float:
        return WAIT_BUDGET_MS - waited["ms"]

    def quotaShort() -> dict:
        ms = waitFor(needed)
        return {
            "ok": False,
            "status": 429,
            "detail": f"token budget short by {needed} tokens; free in {ms}ms",
            "rateLimited": True,
            "daily": False,
            "retryMs": ms,
            "quotaHold": True,
        }

    async def send() -> dict:
        # Debited before the call, because two requests arriving together would
        # otherwise both read the same healthy ledger and both spend it.
        reserve(needed)

        r = await askGemini(
            apiKey=apiKey,
            system=request["system"],
            turns=request["turns"],
            temperature=request["temperature"],
            maxOutputTokens=request["maxOutputTokens"],
            validate=validate,
        )

        # Settle the estimate against what the turn really cost. Usage rides along
        # on a rejected answer too — those tokens were genuinely spent — so the
        # only case that gets its reservation back is one that never reached Google.
        if r.get("usage"):
            syncFromUsage(r["usage"], needed)
        elif not r["ok"]:
            release(needed)

        if r["ok"]:
            return {"ok": True, "text": r["text"], "model": r["model"]}

        if r["rateLimited"]:
            noteExhausted()
        return {
            "ok": False,
            "status": r["status"],
            "detail": r["detail"],
            "rateLimited": r["rateLimited"],
            "daily": r["daily"],
            "retryMs": r["retryMs"],
        }

    # Pre-flight. A shortfall of a few seconds is absorbed silently; anything
    # longer goes back to the caller as a number to show the user.
    upfront = waitFor(needed)
    if upfront > 0:
        if upfront > min(ABSORB_MS, budgetLeft()):
            return quotaShort()
        print(f"[FinGuard] holding {upfront}ms for the token budget to refill rather than degrading.")
        await hold(upfront)

    last = await send()
    if last["ok"]:
        return last

    retryable = last["rateLimited"] or last["status"] == 422 or isTransient(last["status"])
    if not retryable:
        return last

    if last["rateLimited"]:
        again = waitFor(needed)
    elif isTransient(last["status"]):
        again = RETRY_HOLD_MS
    else:
        again = 0

    if again > budgetLeft():
        print(
            f"[FinGuard] already waited {waited['ms']}ms; not spending another {again}ms — answering from the local engine instead."
        )
        return quotaShort() if last["rateLimited"] else last

    if _now_ms() - startedAt + again > REQUEST_SOFT_LIMIT_MS:
        print(f"[FinGuard] {_now_ms() - startedAt}ms spent already; not opening a second attempt.")
        return quotaShort() if last["rateLimited"] else last

    if again > 0:
        await hold(again)
    print(f"[FinGuard] retrying once after {last['status']}: {last['detail'][:120]}")

    second = await send()
    if second["ok"]:
        return second

    if second["rateLimited"] and not second["daily"]:
        return quotaShort()
    return second


# ── Answer parsing ────────────────────────────────────────────────────────────
def parseAgents(raw: str):
    """The model may return a bare array, or an object wrapping one under any key.
    Accept every shape rather than falling back to a generic message."""

    def attempt(text: str):
        try:
            return json.loads(text)
        except (ValueError, TypeError):
            return None

    parsed = attempt(raw.strip())
    if parsed is None:
        m = re.search(r"\[[\s\S]*\]", raw)
        if m:
            parsed = attempt(m.group(0))
    if parsed is None:
        m = re.search(r"\{[\s\S]*\}", raw)
        if m:
            parsed = attempt(m.group(0))
    if parsed is None:
        return None

    if isinstance(parsed, list):
        return normalize(parsed)
    if isinstance(parsed, dict):
        for value in parsed.values():
            if isinstance(value, list) and value:
                return normalize(value)
    return None


# The brief labels its findings F1, F2 and its rings R1, R2 so the model can hold
# them apart. The reader has never seen the brief, so swapping in the plain noun
# the label stood for leaves the sentence grammatical either way. The lookarounds
# keep it off account names — ACC-R1 is a name, not a ring.
_F_LABEL = re.compile(r"(?<![-\w])F(\d{1,2})(?![-\w])")
_R_LABEL = re.compile(r"(?<![-\w])R(\d{1,2})(?![-\w])")


def stripInternalLabels(text: str) -> str:
    text = _F_LABEL.sub("this finding", text)
    text = _R_LABEL.sub("this group", text)
    text = re.sub(r"\bfinding this finding\b", "this finding", text, flags=re.I)
    text = re.sub(r"\bring this group\b", "this group", text, flags=re.I)
    return text


# The model mirrors the indentation of the prompt's own nested lists, so bullets
# arrive with leading spaces. Strip it here rather than asking it not to.
def tidyBullets(text: str) -> str:
    lines = [l.strip() for l in stripInternalLabels(text).split("\n")]
    kept = [l for i, l in enumerate(lines) if len(l) > 0 or (i > 0 and len(lines[i - 1]) > 0)]
    return "\n".join(kept).strip()


def confidenceOf(raw) -> float:
    """The panels render confidence as a percentage of 1, and the prompt asks for
    0-1. Gemini answers 95 about as often as 0.95, so a value above 1 is taken as
    a percentage, and anything outside the scale is clamped rather than trusted."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
        return 0.85
    scaled = raw / 100 if raw > 1 else raw
    return min(1.0, max(0.0, scaled))


def _coalesce(*vals):
    for v in vals:
        if v is not None:
            return v
    return None


def normalize(lst):
    cleaned = []
    for a in lst:
        if not a or not isinstance(a, dict):
            continue
        agent = str(_coalesce(a.get("agent"), a.get("name"), "Investigation Assistant"))
        headline_raw = a.get("headline")
        headline = stripInternalLabels(headline_raw.strip()) if isinstance(headline_raw, str) else None
        content = tidyBullets(str(_coalesce(a.get("content"), a.get("text"), a.get("analysis"), "")))
        findings_raw = a.get("findings")
        if isinstance(findings_raw, list):
            findings = [x for x in (stripInternalLabels(str(f).strip()) for f in findings_raw) if x][:4]
        else:
            findings = []
        confidence = confidenceOf(a.get("confidence"))
        item = {"agent": agent, "content": content, "findings": findings, "confidence": confidence}
        if headline is not None:
            item["headline"] = headline
        if content.strip():
            cleaned.append(item)
    return cleaned if cleaned else None


# ── Payload builders ──────────────────────────────────────────────────────────
def _report_dicts(reports: list[AgentReport]) -> list[dict]:
    """localReport hands back dataclasses; the AI path hands back dicts. Flatten
    the dataclasses to the same dict shape so `agents` is uniform in the JSON."""
    out = []
    for r in reports:
        d = {"agent": r.agent, "content": r.content, "confidence": r.confidence}
        if r.headline is not None:
            d["headline"] = r.headline
        if r.findings is not None:
            d["findings"] = r.findings
        out.append(d)
    return out


def summarize(ev) -> dict:
    return {
        "txCount": ev.txCount,
        "accountCount": ev.accountCount,
        "ringCount": len([r for r in ev.rings if len(r.accounts) >= 3]),
        "findingCount": len(ev.findings),
        "highCount": ev.bySeverity["high"],
    }


def verdictOf(ev) -> dict:
    """The short answer: how bad it is, in one sentence, with at most four facts.
    Computed from the evidence engine rather than the model, so it is always
    present, its numbers always match the data, and it costs no tokens."""
    if not ev.txCount:
        return {
            "level": "safe",
            "headline": "No transactions loaded yet.",
            "points": ["Import a CSV from the Upload tab and run this again."],
            "accounts": [],
        }

    hard = [f for f in ev.findings if f.severity == "high"]
    if hard or ev.bySeverity["high"]:
        level = "high"
    elif ev.bySeverity["medium"]:
        level = "medium"
    else:
        level = "safe"
    rings = [r for r in ev.rings if len(r.accounts) >= 3]
    named = list(dict.fromkeys(r.typology for r in rings if r.typology))

    if level == "high":
        n = len(hard) or ev.bySeverity["high"]
        headline = (
            f"{n} serious problem{'' if n == 1 else 's'} found — "
            f"{formatINR(ev.highValue)} of {formatINR(ev.totalValue)} is high-risk."
        )
    elif level == "medium":
        m = ev.bySeverity["medium"]
        headline = (
            f"Nothing criminal stands out, but {m} transfer{'' if m == 1 else 's'} "
            "are large enough to keep an eye on."
        )
    else:
        headline = f"All {ev.txCount} transfers look routine. Nothing to escalate."

    points: list[str] = []
    if named:
        points.append(f"Patterns matched: {', '.join(named[:4])}.")
    for f in ev.findings[:3]:
        points.append(f.short or f.title)
    if len(points) < 2:
        points.append(
            f"{ev.txCount} transfers, {ev.accountCount} accounts, {formatINR(ev.totalValue)} "
            f"across {len(ev.banks)} bank{'' if len(ev.banks) == 1 else 's'}."
        )

    # The accounts the graph should open focused on: whatever the hard findings
    # actually name, worst finding first.
    accounts: list[str] = []
    for f in (hard if hard else ev.findings):
        for a in f.accounts:
            if a not in accounts:
                accounts.append(a)

    return {"level": level, "headline": headline, "points": points[:4], "accounts": accounts[:14]}


def followUps(ev) -> list[str]:
    """Generated from the data, not the model, so they always name something that
    exists and never cost a request."""
    if not ev.txCount:
        return ["How do I upload my transactions?", "What file format do you need?"]

    out: list[str] = []
    ring = next((r for r in ev.rings if r.typology and len(r.accounts) >= 3), None)
    if ring and ring.typology:
        out.append(f"Explain the {ring.typology.lower()} in simple words")
    hub = ev.topCounterparties[0].account if ev.topCounterparties else None
    if hub:
        out.append(f"Why is {hub} suspicious?")
    if ev.findings:
        out.append("Which accounts should I freeze first?")
    out.append("What laws does this break?")
    out.append("Show me the biggest money flows")
    return out[:3]


def investigatePayload(ev, agents, degraded: Optional[str] = None) -> dict:
    """Every investigate reply has the same shape; building it in one place stops
    the exit paths from drifting apart."""
    payload = {
        "mode": "investigate",
        "agents": agents,
        "verdict": verdictOf(ev),
        "suggestions": followUps(ev),
        "evidence": summarize(ev),
    }
    if degraded:
        payload["degraded"] = degraded
    return payload


# ── The handler ───────────────────────────────────────────────────────────────
async def run_chat(
    *,
    message,
    history=None,
    txs=None,
    forced_mode=None,
    uid=None,
    client_ip: str = "local",
) -> tuple[dict, int, dict]:
    """Returns (body, status, headers). app/main.py wraps this in a JSONResponse."""
    try:
        if not message or not isinstance(message, str):
            return {"error": "Message is required"}, 400, {}

        investigate = forced_mode == "investigate" or (
            forced_mode != "casual" and wantsInvestigation(message)
        )

        # Analyse the data server-side first. This is what makes answers specific.
        # Two sizes of the same evidence: the report needs the full working
        # document; a chat turn needs the facts and nothing telling it how to write.
        tx_list = txs if isinstance(txs, list) else []
        evidence = buildEvidence(tx_list)
        brief = evidenceBrief(evidence) if investigate else casualBrief(evidence)

        # Nothing to investigate — answer from the local engine rather than asking
        # the model to improvise four near-identical "there is no data" bubbles.
        if investigate and not evidence.txCount:
            return investigatePayload(evidence, _report_dicts(localReport(evidence))), 200, {}

        apiKey = geminiKey()

        # No key — still give a real report rather than an error.
        if not apiKey:
            if investigate:
                return (
                    investigatePayload(
                        evidence,
                        _report_dicts(localReport(evidence)),
                        "Running on the local analysis engine (no AI key configured).",
                    ),
                    200,
                    {},
                )
            return (
                {
                    "mode": "casual",
                    "reply": "The AI service isn't configured, so I can't chat freely — but the Run full investigation button still works, it uses the built-in analysis engine.",
                    "suggestions": followUps(evidence),
                },
                200,
                {},
            )

        # Gemini keeps the system instruction out of the turn list and calls the
        # assistant "model". The question is labelled and repeated after the brief
        # on the investigate path so it reads as the thing to answer, not a preamble.
        system = INVESTIGATE_PROMPT if investigate else CASUAL_PROMPT
        briefBlock = f"=== EVIDENCE BRIEF (computed from the user's real data) ===\n{brief}"
        turns = sanitizeHistory(history)
        if investigate:
            turns.append(
                {
                    "role": "user",
                    "text": f'THE QUESTION: {message}\n\n{briefBlock}\n\n=== END OF BRIEF ===\nNow answer THE QUESTION above — "{message}" — as the four agents.',
                }
            )
        else:
            turns.append({"role": "user", "text": f"{message}\n\n{briefBlock}"})

        maxTokens = 2_000 if investigate else 1_500

        # Only investigations are cached. A report is a function of the data and
        # the question; a casual turn depends on the conversation, which isn't here.
        key = (
            f"{fingerprint(message.strip().lower())}:{fingerprint(brief)}" if investigate else None
        )
        if key:
            hit = cache.get(key)
            if hit and _now_ms() - hit["at"] < CACHE_TTL_MS:
                cachedAgents = parseAgents(hit["content"])
                if cachedAgents:
                    payload = investigatePayload(evidence, cachedAgents)
                    payload["model"] = hit["model"]
                    payload["cached"] = True
                    return payload, 200, {}
                cache.pop(key, None)

        # Counted only now, after the cache has had its chance — a repeated
        # question costs nothing, and it is exactly the pattern a demo relies on.
        who = callerId(uid, client_ip)
        kind = "investigate" if investigate else "casual"
        verdict = checkRate(who, kind)

        if not verdict["ok"]:
            if verdict["retryAfterMs"] <= ABSORB_MS:
                await asyncio.sleep(verdict["retryAfterMs"] / 1000)
            else:
                wait = seconds(verdict["retryAfterMs"])
                busy = (
                    "The console is handling a lot of requests right now"
                    if verdict["scope"] == "global"
                    else "That's a lot of requests in one minute"
                )
                print(f"[FinGuard] rate limit ({verdict['scope']}) for {who} on {kind}; {wait}s to wait.")

                # An investigation still produces its report from the built-in engine.
                if investigate:
                    return (
                        investigatePayload(
                            evidence,
                            _report_dicts(localReport(evidence)),
                            f"{busy} — this report came from the built-in analysis engine. The AI's wording is free again in {wait} seconds.",
                        ),
                        200,
                        {},
                    )
                # A chat turn has no local equivalent, so a plain refusal is honest.
                return (
                    {
                        "error": f"{busy}. Please wait {wait} seconds and try again.",
                        "retryAfter": wait,
                    },
                    429,
                    {"Retry-After": str(wait)},
                )

        needed = estimateTokens(turns, system, maxTokens)
        if investigate:
            validate = lambda text: parseAgents(stripThinking(text)) is not None
        else:
            validate = lambda text: len(stripThinking(text)) > 0
        outcome = await askModel(
            apiKey,
            {
                "system": system,
                "turns": turns,
                "temperature": 0.4 if investigate else 0.7,
                "maxOutputTokens": maxTokens,
            },
            validate,
            needed,
        )

        if not outcome["ok"]:
            print(f"[FinGuard] Gemini unavailable: {outcome['status']} {outcome['detail']}")
            rateLimited = outcome["rateLimited"]
            daily = outcome["daily"]
            quotaHold = outcome.get("quotaHold", False)
            # Hand the slot back for a call that never produced an answer — but not
            # when the failure was the pace itself, or the counter never caps.
            if not rateLimited:
                refund(who, kind)

            held = seconds(outcome["retryMs"]) if quotaHold else 0
            if daily:
                waitAdvice = "You've used up today's free AI quota — it resets on a rolling 24-hour window."
            elif quotaHold:
                waitAdvice = f"The free AI tier's per-minute token budget is spent — it refills in {held} seconds."
            else:
                waitAdvice = "The free AI tier only allows so many requests a minute."

            if investigate:
                degraded = (
                    f"{waitAdvice} This report came from the built-in analysis engine instead — it reads the same data, just without the AI's wording."
                    if rateLimited
                    else "The AI service was unreachable, so this report came from the local analysis engine."
                )
                return (
                    investigatePayload(evidence, _report_dicts(localReport(evidence)), degraded),
                    200,
                    {},
                )
            # Casual questions have no local equivalent, so say what happened.
            reply = (
                (
                    f"{waitAdvice} That's a limit on the free plan, not a problem with your data or your key. "
                    + (
                        "Run full investigation still works in the meantime — it uses the built-in engine and needs no AI."
                        if daily
                        else "Give it a moment and ask again, or use Run full investigation, which works either way."
                    )
                )
                if rateLimited
                else "The AI service didn't respond just now. Try again in a moment — Run full investigation works either way, since it can fall back to the built-in engine."
            )
            body = {
                "mode": "casual",
                "reply": reply,
                "suggestions": followUps(evidence),
                "degraded": waitAdvice if rateLimited else "AI service unavailable.",
            }
            if quotaHold:
                body["retryAfter"] = held
            return body, 200, {}

        raw = stripThinking(outcome["text"])

        # What the governor believes is left in the per-minute allowance. Rides
        # along because it costs nothing and it is not a secret.
        budget = ledgerSnapshot()

        if not investigate:
            clean = re.sub(r"```", "", re.sub(r"```[a-z]*\n?", "", raw, flags=re.I)).strip()
            return (
                {
                    "mode": "casual",
                    "reply": clean,
                    "suggestions": followUps(evidence),
                    "model": outcome["model"],
                    "budget": budget,
                },
                200,
                {},
            )

        agents = parseAgents(raw)
        if not agents:
            refund(who, kind)
            return (
                investigatePayload(
                    evidence,
                    _report_dicts(localReport(evidence)),
                    "The AI returned an unreadable response, so this report came from the local analysis engine.",
                ),
                200,
                {},
            )

        if key:
            # Oldest first out. dict keeps insertion order, so the first key is the
            # stalest — a plain bound, not a real LRU.
            if len(cache) >= CACHE_MAX:
                cache.pop(next(iter(cache)), None)
            cache[key] = {"at": _now_ms(), "model": outcome["model"], "content": raw}

        payload = investigatePayload(evidence, agents)
        payload["model"] = outcome["model"]
        payload["budget"] = budget
        return payload, 200, {}
    except Exception as err:  # noqa: BLE001 — mirror the route's catch-all 500.
        print(f"[FinGuard] Chat API error: {err}")
        return {"error": "Internal server error"}, 500, {}
