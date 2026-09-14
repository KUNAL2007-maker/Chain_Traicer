"""Evidence engine — ported 1:1 from src/lib/investigation.ts.

Turns the user's live transactions into hard, quotable findings. Does the
arithmetic first — who the hubs are, which hops form a chain, how much value
each hop shaves, which amounts hug the reporting threshold — and hands the
agents facts they can only have got from this data. It is also the offline
fallback: every finding carries its own plain-English sentence, so a report can
be written with no AI at all.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Optional

from .domain import Transaction, detectPattern, formatINR

# ₹10 lakh is the cash-reporting line under the PMLA rules.
REPORT_THRESHOLD = 1_000_000
# Cross-border wire transfers are reportable from ₹5 lakh (CBWTR).
WIRE_REPORT_THRESHOLD = 500_000

# Settlement systems that never leave India.
DOMESTIC_RAILS = re.compile(
    r"^(neft|rtgs|imps|upi|ach|nach|cheque|cash|cash_deposit|card_payment|bill_payment|salary)$",
    re.IGNORECASE,
)
# Channels that only exist for money leaving the country.
FOREIGN_RAILS = re.compile(
    r"(swift|international|cross.?border|remittance|telegraphic|forex|fx_|wire_out|outward)",
    re.IGNORECASE,
)
FOREIGN_NOTE = re.compile(
    r"offshore|overseas|foreign|abroad|dubai|singapore|hong ?kong|mauritius|cayman|swiss|nominee account|non.?resident",
    re.IGNORECASE,
)
# A note can name a foreign place because money is arriving from there.
INWARD_NOTE = re.compile(r"inward|incoming|inbound|received|credit from|trade advance|repatriat", re.IGNORECASE)

# What an investigator should act on first, not what carries the largest figure.
RISK_ORDER = {
    "CROSS-BORDER": 1,
    "THRESHOLD-HUG": 2,
    "CHAIN-DECAY": 3,
    "FUNNEL-IN": 4,
    "FAN-OUT": 5,
    "BANK-HOP": 6,
    "BURST": 7,
}

money = formatINR


def _round(x: float) -> int:
    # JS Math.round: half up toward +Infinity.
    return math.floor(x + 0.5)


def _fixed1(x: float) -> str:
    return f"{x:.1f}"


# ── Types ────────────────────────────────────────────────────────────────────
@dataclass
class Finding:
    code: str
    title: str
    plain: str
    short: str
    severity: str  # "high" | "medium" | "info"
    accounts: list[str]
    amount: float


@dataclass
class RingSummary:
    id: str
    shape: str  # "chain" | "collector" | "distributor" | "pair" | "web"
    shapeLabel: str
    typology: Optional[str]
    accounts: list[str]
    hubs: list[str]
    ends: Optional[dict]  # {"from","to"} | None
    passThrough: list[str]
    txCount: int
    total: float
    banks: list[str]
    days: list[str]


@dataclass
class Counterparty:
    account: str
    degree: int
    volume: float
    inCount: int
    outCount: int
    inAmount: float
    outAmount: float


@dataclass
class Evidence:
    txCount: int
    accountCount: int
    totalValue: float
    bySeverity: dict  # {"high","medium","safe"}
    highValue: float
    banks: list[str]
    dateRange: Optional[dict]  # {"from","to"} | None
    typologies: list[dict]  # [{"label","count","amount"}]
    channels: list[dict]  # [{"type","count"}]
    rings: list[RingSummary]
    findings: list[Finding]
    topCounterparties: list[Counterparty]
    busiestDay: Optional[dict]  # {"date","count","amount"} | None


def buildEvidence(txs: list[Transaction]) -> Evidence:
    clean = [t for t in txs if t.fromAccount and t.toAccount]

    bySeverity = {"high": 0, "medium": 0, "safe": 0}
    bankSet: dict[str, None] = {}
    dates: list[str] = []
    perDay: dict[str, dict] = {}
    typTally: dict[str, dict] = {}
    chanTally: dict[str, int] = {}
    accounts: dict[str, dict] = {}

    totalValue = 0.0
    highValue = 0.0

    for t in clean:
        bySeverity[t.severity] += 1
        totalValue += t.amount
        if t.severity == "high":
            highValue += t.amount
        if t.bank:
            bankSet[t.bank] = None
        if t.type:
            chanTally[t.type] = chanTally.get(t.type, 0) + 1
        if t.date:
            dates.append(t.date)
            d = perDay.get(t.date)
            if d is None:
                d = {"count": 0, "amount": 0.0}
            d["count"] += 1
            d["amount"] += t.amount
            perDay[t.date] = d

        p = detectPattern(t.note)
        if p:
            cur = typTally.get(p.key)
            if cur:
                cur["count"] += 1
                cur["amount"] += t.amount
            else:
                typTally[p.key] = {"label": p.label, "count": 1, "amount": t.amount}

        for acc, dir in ((t.fromAccount, "out"), (t.toAccount, "in")):
            a = accounts.get(acc)
            if a is None:
                a = {"degree": 0, "volume": 0.0, "in": 0, "out": 0, "inAmount": 0.0, "outAmount": 0.0, "payers": set(), "payees": set()}
            a["degree"] += 1
            a["volume"] += t.amount
            if dir == "in":
                a["in"] += 1
                a["inAmount"] += t.amount
                a["payers"].add(t.fromAccount)
            else:
                a["out"] += 1
                a["outAmount"] += t.amount
                a["payees"].add(t.toAccount)
            accounts[acc] = a

    dates.sort()
    perDayEntries = sorted(perDay.items(), key=lambda kv: kv[1]["count"], reverse=True)
    busiest = perDayEntries[0] if perDayEntries else None

    rings = buildRings(clean)

    topCounterparties = [
        Counterparty(
            account=account,
            degree=a["degree"],
            volume=a["volume"],
            inCount=a["in"],
            outCount=a["out"],
            inAmount=a["inAmount"],
            outAmount=a["outAmount"],
        )
        for account, a in accounts.items()
    ]
    topCounterparties.sort(key=lambda c: (-c.degree, -c.volume))
    topCounterparties = topCounterparties[:6]

    evidence = Evidence(
        txCount=len(clean),
        accountCount=len(accounts),
        totalValue=totalValue,
        bySeverity=bySeverity,
        highValue=highValue,
        banks=list(bankSet.keys()),
        dateRange={"from": dates[0], "to": dates[-1]} if dates else None,
        typologies=sorted(typTally.values(), key=lambda x: x["count"], reverse=True),
        channels=sorted(
            [{"type": k, "count": v} for k, v in chanTally.items()],
            key=lambda x: x["count"],
            reverse=True,
        ),
        rings=rings,
        findings=[],
        topCounterparties=topCounterparties,
        busiestDay={"date": busiest[0], "count": busiest[1]["count"], "amount": busiest[1]["amount"]} if busiest else None,
    )

    evidence.findings = collectFindings(clean, evidence)
    return evidence


# ── Ring detection ────────────────────────────────────────────────────────────
def buildRings(txs: list[Transaction]) -> list[RingSummary]:
    adj: dict[str, dict[str, None]] = {}

    def touch(a: str, b: str) -> None:
        if a not in adj:
            adj[a] = {}
        adj[a][b] = None

    for t in txs:
        touch(t.fromAccount, t.toAccount)
        touch(t.toAccount, t.fromAccount)

    seen: set[str] = set()
    rings: list[RingSummary] = []

    for start in list(adj.keys()):
        if start in seen:
            continue
        bucket: list[str] = []
        queue = [start]
        seen.add(start)
        qi = 0
        while qi < len(queue):
            cur = queue[qi]
            qi += 1
            bucket.append(cur)
            for nb in list(adj.get(cur, {})):
                if nb not in seen:
                    seen.add(nb)
                    queue.append(nb)

        members = set(bucket)
        ringTxs = [t for t in txs if t.fromAccount in members and t.toAccount in members]
        if not ringTxs:
            continue

        inDeg: dict[str, int] = {}
        outDeg: dict[str, int] = {}
        for t in ringTxs:
            outDeg[t.fromAccount] = outDeg.get(t.fromAccount, 0) + 1
            inDeg[t.toAccount] = inDeg.get(t.toAccount, 0) + 1

        hubs = [a for a in bucket if inDeg.get(a, 0) + outDeg.get(a, 0) >= 3]
        hubs.sort(key=lambda a: inDeg.get(a, 0) + outDeg.get(a, 0), reverse=True)

        typTally: dict[str, int] = {}
        for t in ringTxs:
            p = detectPattern(t.note)
            if p:
                typTally[p.label] = typTally.get(p.label, 0) + 1
        typEntries = sorted(typTally.items(), key=lambda kv: kv[1], reverse=True)
        typology = typEntries[0][0] if typEntries else None

        sources = [a for a in bucket if not inDeg.get(a, 0)]
        sinks = [a for a in bucket if not outDeg.get(a, 0)]
        ends = {"from": sources[0], "to": sinks[0]} if len(sources) == 1 and len(sinks) == 1 else None

        passThrough = [a for a in bucket if inDeg.get(a, 0) and outDeg.get(a, 0)]

        shape, shapeLabel = classifyShape(bucket, ringTxs, inDeg, outDeg, ends)

        rings.append(
            RingSummary(
                id=f"ring_{len(rings) + 1}",
                shape=shape,
                shapeLabel=shapeLabel,
                typology=typology,
                accounts=bucket,
                hubs=hubs[:2],
                ends=ends,
                passThrough=passThrough,
                txCount=len(ringTxs),
                total=sum(t.amount for t in ringTxs),
                banks=list(dict.fromkeys(t.bank for t in ringTxs if t.bank)),
                days=sorted(dict.fromkeys(t.date for t in ringTxs if t.date)),
            )
        )

    rings.sort(key=lambda r: (-len(r.accounts), -r.total))
    return rings


# ── Findings ──────────────────────────────────────────────────────────────────
def longestMoneyPath(ringTxs: list[Transaction]) -> list[Transaction]:
    byDate = sorted(ringTxs, key=lambda t: t.date)
    best: list[Transaction] = []

    def walk(path: list[Transaction], visited: set[str]) -> None:
        nonlocal best
        if len(path) > len(best):
            best = list(path)
        tail = path[-1]
        for nxt in byDate:
            if nxt.fromAccount != tail.toAccount:
                continue
            if nxt.date < tail.date:
                continue
            if nxt.amount > tail.amount:
                continue
            if nxt.toAccount in visited:
                continue
            visited.add(nxt.toAccount)
            walk(path + [nxt], visited)
            visited.discard(nxt.toAccount)

    for start in byDate:
        walk([start], {start.fromAccount, start.toAccount})
    return best


def collectFindings(txs: list[Transaction], ev: Evidence) -> list[Finding]:
    out: list[Finding] = []

    # 1. Chains that lose value at every hop — the classic layering signature.
    for ring in ev.rings:
        if ring.shape != "chain" or len(ring.accounts) < 4:
            continue
        ringTxs = [t for t in txs if t.fromAccount in ring.accounts and t.toAccount in ring.accounts]
        hops = longestMoneyPath(ringTxs)
        if len(hops) < 3:
            continue
        first = hops[0]
        last = hops[-1]
        shrink = first.amount - last.amount
        pct = _fixed1((shrink / first.amount) * 100) if first.amount else "0"
        days = sorted(dict.fromkeys(h.date for h in hops if h.date))
        if len(days) == 1:
            when = f", all on {days[0]}"
        elif len(days) > 1:
            when = f", between {days[0]} and {days[-1]}"
        else:
            when = ""
        route = f"{first.fromAccount} → {last.toAccount}"
        route_full = " → ".join(h.fromAccount for h in hops) + f" → {last.toAccount}"
        out.append(
            Finding(
                code="CHAIN-DECAY",
                title=(
                    f"{len(hops)} linked hops {route}, shrinking {pct}% along the way"
                    if shrink > 0
                    else f"{len(hops)} linked hops {route}, passed on untouched"
                ),
                plain=(
                    f"Money left {first.fromAccount} at {money(first.amount)} and arrived at {last.toAccount} as "
                    f"{money(last.amount)} after {len(hops)} linked hops{when}. "
                    + (
                        f"Each account kept a cut of {money(shrink)} in total and pushed the rest onward. "
                        "Ordinary business payments do not lose a slice at every step — "
                        if shrink > 0
                        else "The full amount was passed straight on at every step, which is not how trade or salary payments behave — "
                    )
                    + "this is what layering looks like: the trail is being stretched out to make the original source hard to trace. "
                    + f"Route: {route_full}."
                ),
                short=(
                    f"{money(first.amount)} became {money(last.amount)} over {len(hops)} linked hops{when} — each account kept a cut, which ordinary payments never do."
                    if shrink > 0
                    else f"{money(first.amount)} passed through {len(hops)} accounts untouched{when} — a trail this long has no ordinary business reason."
                ),
                severity="high",
                accounts=[h.fromAccount for h in hops] + [last.toAccount],
                amount=first.amount,
            )
        )

    # 2. Amounts parked just under the reporting threshold.
    nearMiss = [t for t in txs if t.amount >= REPORT_THRESHOLD * 0.85 and t.amount < REPORT_THRESHOLD]
    if len(nearMiss) >= 3:
        s = sum(t.amount for t in nearMiss)
        senders = list(dict.fromkeys(t.fromAccount for t in nearMiss))
        lowest = min(t.amount for t in nearMiss)
        highest = max(t.amount for t in nearMiss)
        out.append(
            Finding(
                code="THRESHOLD-HUG",
                title=f"{len(nearMiss)} transfers sitting just below the {money(REPORT_THRESHOLD)} reporting line",
                plain=(
                    f"These {len(nearMiss)} transfers total {money(s)}, yet every single one lands between "
                    f"{money(lowest)} and {money(highest)} — just under the {money(REPORT_THRESHOLD)} mark that banks watch as "
                    "a reporting line. Amounts do not cluster in a narrow band like that by chance: someone is sizing each payment "
                    "to stay below a number. "
                    + (
                        "All of them come from the same account, which makes coincidence very unlikely. "
                        if len(senders) == 1
                        else f"They come from {len(senders)} accounts acting together. "
                    )
                    + "Splitting one payment into several to stay under a reporting line is called structuring, or smurfing, and doing "
                    "it deliberately is an offence by itself — separate from whatever the money was for."
                ),
                short=(
                    f"{len(nearMiss)} transfers totalling {money(s)}, every one between {money(lowest)} and {money(highest)} — "
                    f"sized to stay under the {money(REPORT_THRESHOLD)} line, which is structuring."
                ),
                severity="high",
                accounts=senders,
                amount=s,
            )
        )

    # 3. Collector accounts: many payers in, one big payment out.
    for ring in ev.rings:
        if ring.shape != "collector" or not ring.hubs:
            continue
        hub = ring.hubs[0]
        feeders = [t for t in txs if t.toAccount == hub]
        payouts = [t for t in txs if t.fromAccount == hub]
        if len(feeders) < 3:
            continue
        inSum = sum(t.amount for t in feeders)
        outSum = sum(t.amount for t in payouts)
        spread = [f.amount for f in feeders]
        tight = max(spread) - min(spread) < max(spread) * 0.2
        out.append(
            Finding(
                code="FUNNEL-IN",
                title=f"{len(feeders)} accounts all pay into {hub}, which forwards the pile onward",
                plain=(
                    f"{hub} received {money(inSum)} from {len(feeders)} different accounts"
                    + (
                        f" and then sent {money(outSum)} out again in {len(payouts)} payment{'s' if len(payouts) > 1 else ''}"
                        if payouts
                        else ""
                    )
                    + ". "
                    + (
                        "The deposits are all suspiciously similar in size, which is a sign they were coordinated rather than genuine unrelated payments. "
                        if tight
                        else ""
                    )
                    + "Money arriving from many unconnected people and leaving almost immediately as one lump is the standard money-mule shape: "
                    "the middle account is a rented pass-through, not the real owner of the funds."
                ),
                short=(
                    f"{hub} took {money(inSum)} from {len(feeders)} unrelated accounts"
                    + (f" and pushed {money(outSum)} straight out" if payouts else "")
                    + " — the classic mule pass-through."
                ),
                severity="high",
                accounts=[hub] + [f.fromAccount for f in feeders],
                amount=inSum,
            )
        )

    # 4. Distributor accounts: one payer, many receivers.
    for ring in ev.rings:
        if ring.shape != "distributor" or not ring.hubs:
            continue
        hub = ring.hubs[0]
        splits = [t for t in txs if t.fromAccount == hub]
        if len(splits) < 3:
            continue
        s = sum(t.amount for t in splits)
        oneDay = len({sp.date for sp in splits}) == 1
        out.append(
            Finding(
                code="FAN-OUT",
                title=f"{hub} split {money(s)} across {len(splits)} accounts",
                plain=(
                    f"A single account pushed {money(s)} out to {len(splits)} different receivers"
                    + (f" on one day ({splits[0].date})" if oneDay else "")
                    + ". "
                    "Breaking one large sum into several smaller ones spreads it across accounts that are each individually "
                    "unremarkable, so no single bank sees the full picture. The receiving accounts are worth checking for "
                    "whether they have any real reason to be paid."
                ),
                short=(
                    f"{hub} split {money(s)} across {len(splits)} receivers"
                    + (f" on {splits[0].date}" if oneDay else "")
                    + " — small pieces no single bank flags."
                ),
                severity="high",
                accounts=[hub] + [sp.toAccount for sp in splits],
                amount=s,
            )
        )

    # 5. Cross-bank hopping. Reported once for the whole dataset.
    hoppers = [r for r in ev.rings if len(r.banks) >= 3 and len(r.accounts) >= 3 and len(r.passThrough) > 0]
    if hoppers:
        hopTotal = sum(r.total for r in hoppers)
        allBanks = list(dict.fromkeys(b for r in hoppers for b in r.banks))
        lines = [
            f"{r.typology if r.typology else r.shapeLabel.split('—')[0].strip()} ({len(r.accounts)} accounts, "
            f"{money(r.total)}) touched {len(r.banks)} banks"
            for r in hoppers
        ]
        out.append(
            Finding(
                code="BANK-HOP",
                title=(
                    f"One ring spread across {len(hoppers[0].banks)} different banks"
                    if len(hoppers) == 1
                    else f"{len(hoppers)} rings each spread across 3 or more banks"
                ),
                plain=(
                    f"{money(hopTotal)} moved through {len(allBanks)} banks ({', '.join(allBanks)}) — "
                    f"{'; '.join(lines)}. No individual bank can see more than its own slice, so each one sees a "
                    "normal-looking transfer and nothing worth flagging. Spreading a flow across institutions on purpose, "
                    "so that no single one holds enough of the picture to react, is why banks share monitoring data "
                    "between them."
                ),
                short=(
                    f"{money(hopTotal)} routed through {len(allBanks)} banks ({', '.join(allBanks)}) — "
                    "each bank sees only its own slice, so none of them flags anything."
                ),
                severity="high",
                accounts=list(dict.fromkeys(a for r in hoppers for a in r.accounts)),
                amount=hopTotal,
            )
        )

    # 6. Same-day bursts.
    if ev.busiestDay and ev.busiestDay["count"] >= 5:
        out.append(
            Finding(
                code="BURST",
                title=f"{ev.busiestDay['count']} transfers crammed into {ev.busiestDay['date']}",
                plain=(
                    f"{ev.busiestDay['count']} of the {ev.txCount} transfers happened on {ev.busiestDay['date']} alone, "
                    f"moving {money(ev.busiestDay['amount'])} in a single day. Genuine activity usually spreads out; "
                    "a sudden burst normally means someone is moving funds fast, before anyone reviews them."
                ),
                short=(
                    f"{ev.busiestDay['count']} of {ev.txCount} transfers landed on {ev.busiestDay['date']} alone, "
                    f"moving {money(ev.busiestDay['amount'])} — speed beats review."
                ),
                severity="medium",
                accounts=[],
                amount=ev.busiestDay["amount"],
            )
        )

    # 7. Cross-border exits.
    def _is_swift(t: Transaction) -> bool:
        type_ = (t.type or "").strip()
        note = t.note or ""
        if FOREIGN_RAILS.search(type_):
            return True
        if DOMESTIC_RAILS.search(type_):
            return False
        if not FOREIGN_NOTE.search(note):
            return False
        return not INWARD_NOTE.search(note)

    swift = [t for t in txs if _is_swift(t)]
    if swift:
        s = sum(t.amount for t in swift)
        out.append(
            Finding(
                code="CROSS-BORDER",
                title=f"{money(s)} heading out of the country",
                plain=(
                    f"{len(swift)} transfer{'s' if len(swift) > 1 else ''} totalling {money(s)} left via overseas wires. "
                    "Once money is outside Indian jurisdiction it becomes very hard to recover, so cross-border exits at the end of "
                    "a suspicious chain are the last realistic point to freeze anything."
                ),
                short=(
                    f"{money(s)} left India on {len(swift)} overseas wire{'s' if len(swift) > 1 else ''} — "
                    "once it settles abroad it is effectively unrecoverable."
                ),
                severity="high",
                accounts=list(dict.fromkeys(t.toAccount for t in swift)),
                amount=s,
            )
        )

    rank = {"high": 0, "medium": 1, "info": 2}
    out.sort(key=lambda f: (rank[f.severity], RISK_ORDER.get(f.code, 99), -f.amount))
    return out


# ── The brief handed to the AI ────────────────────────────────────────────────
def evidenceBrief(ev: Evidence) -> str:
    if not ev.txCount:
        return "NO TRANSACTION DATA UPLOADED."

    lines: list[str] = []

    if ev.findings:
        lines.append(
            f"HARD FINDINGS ({len(ev.findings)}) — THE ACTUAL CASE. Each one below already contains the exact "
            "amounts, dates and accounts. Explain these in your own words; do not reduce them to a count of accounts."
        )
        for i, f in enumerate(ev.findings):
            lines.append(f"  F{i + 1} [{f.code}] {f.severity.upper()} — {f.title}")
            lines.append(f"      {f.plain}")
            if f.accounts:
                lines.append(
                    f"      Accounts involved: {', '.join(f.accounts[:8])}{'…' if len(f.accounts) > 8 else ''}."
                )
        lines.append("")

    lines.append(f"PORTFOLIO: {ev.txCount} transfers, {ev.accountCount} accounts, {money(ev.totalValue)} total value.")
    lines.append(
        f"RISK SPLIT: {ev.bySeverity['high']} high-risk ({money(ev.highValue)}), {ev.bySeverity['medium']} medium, {ev.bySeverity['safe']} routine."
    )
    if ev.dateRange:
        lines.append(f"PERIOD: {ev.dateRange['from']} to {ev.dateRange['to']}.")

    border = next((f for f in ev.findings if f.code == "CROSS-BORDER"), None)
    lines.append(
        f"CROSS-BORDER: YES — {money(border.amount)} left India by overseas wire. FEMA 1999 applies; say so plainly."
        if border
        else "CROSS-BORDER: NO — every transfer stayed inside India. FEMA 1999 does NOT apply. Do not mention it at all."
    )

    if ev.channels:
        channels_used = ", ".join(f'{c["type"]} ({c["count"]})' for c in ev.channels)
        lines.append(
            f"CHANNELS USED: {channels_used}. "
            "These are all electronic transfers — none of this is cash, so do not describe it as cash."
        )
    if ev.banks:
        lines.append(f"BANKS INVOLVED: {', '.join(ev.banks)}.")
    if ev.busiestDay:
        lines.append(
            f"BUSIEST DAY: {ev.busiestDay['date']} with {ev.busiestDay['count']} transfers worth {money(ev.busiestDay['amount'])}."
        )

    if ev.typologies:
        lines.append(
            "TYPOLOGIES TAGGED: "
            + "; ".join(f"{t['label']} ({t['count']} transfers, {money(t['amount'])})" for t in ev.typologies)
            + "."
        )

    notable = [r for r in ev.rings if len(r.accounts) >= 3]
    if notable:
        lines.append(f"RINGS DETECTED ({len(notable)}):")
        for i, r in enumerate(notable):
            if r.hubs:
                hubPart = f"Hub(s): {', '.join(r.hubs)}. "
            else:
                runs = f"; it runs {r.ends['from']} → {r.ends['to']}" if r.ends else ""
                hubPart = (
                    "Hub(s): none — this group has no centre, so name none and do not "
                    f"mention hubs at all when describing it{runs}. "
                )
            share = _fixed1((r.total / ev.totalValue) * 100) if ev.totalValue else "0.0"
            lines.append(
                f"  R{i + 1}. {len(r.accounts)} accounts, {r.txCount} transfers, {money(r.total)}. "
                f"Shape: {r.shapeLabel}. Typology: {r.typology if r.typology else 'untagged'}. "
                + hubPart
                + f"Share of portfolio: {share}%. Banks: {', '.join(r.banks) or 'n/a'}. "
                + f"Accounts: {', '.join(r.accounts[:8])}{'…' if len(r.accounts) > 8 else ''}."
            )

    pairs = len([r for r in ev.rings if len(r.accounts) < 3])
    if pairs:
        lines.append(f"Plus {pairs} isolated one-to-one transfers with no ring structure.")

    if ev.topCounterparties:
        lines.append(
            "MOST CONNECTED ACCOUNTS — these in/out figures are the ONLY source for how many parties paid "
            "an account or were paid by it. Never state a payer or payee count that is not on this list:"
        )
        for c in ev.topCounterparties:
            parts = [
                (
                    f"received {money(c.inAmount)} in {c.inCount} {'transfer' if c.inCount == 1 else 'transfers'}"
                    if c.inCount
                    else "received nothing"
                ),
                (
                    f"sent {money(c.outAmount)} in {c.outCount} {'transfer' if c.outCount == 1 else 'transfers'}"
                    if c.outCount
                    else "sent nothing"
                ),
            ]
            lines.append(f"  {c.account}: {', '.join(parts)}.")

    return "\n".join(lines)


def casualBrief(ev: Evidence) -> str:
    if not ev.txCount:
        return "NO TRANSACTION DATA UPLOADED."

    lines: list[str] = [
        f"PORTFOLIO: {ev.txCount} transfers, {ev.accountCount} accounts, {money(ev.totalValue)} total.",
        f"RISK SPLIT: {ev.bySeverity['high']} high-risk ({money(ev.highValue)}), {ev.bySeverity['medium']} medium, {ev.bySeverity['safe']} routine.",
    ]
    if ev.dateRange:
        lines.append(f"PERIOD: {ev.dateRange['from']} to {ev.dateRange['to']}.")
    if ev.banks:
        lines.append(f"BANKS ({len(ev.banks)}): {', '.join(ev.banks)}.")

    border = next((f for f in ev.findings if f.code == "CROSS-BORDER"), None)
    lines.append(
        f"CROSS-BORDER: yes — {money(border.amount)} left India by overseas wire."
        if border
        else "CROSS-BORDER: no — every transfer stayed inside India."
    )

    if ev.channels:
        channels_used = ", ".join(f'{c["type"]} ({c["count"]})' for c in ev.channels)
        lines.append(
            f"CHANNELS: {channels_used} — all electronic, no cash."
        )
    if ev.typologies:
        typologies_used = ", ".join(f'{t["label"]} ({t["count"]})' for t in ev.typologies)
        lines.append(f"TYPOLOGIES: {typologies_used}.")

    if ev.findings:
        lines.append(f"FINDINGS ({len(ev.findings)}):")
        for f in ev.findings[:5]:
            lines.append(f"  - {f.short}")

    notable = [r for r in ev.rings if len(r.accounts) >= 3]
    if notable:
        biggest = notable[0]
        for r in notable:
            if r.total > biggest.total:
                biggest = r
        lines.append(
            f"RINGS: {len(notable)} groups of 3+ linked accounts. Largest is {len(biggest.accounts)} accounts "
            f"moving {money(biggest.total)}, shaped as a {biggest.shapeLabel}"
            + (f", centred on {biggest.hubs[0]}" if biggest.hubs else ", with no centre")
            + "."
        )

    if ev.topCounterparties:
        lines.append("BUSIEST ACCOUNTS:")
        for c in ev.topCounterparties[:3]:
            lines.append(
                f"  {c.account}: received {money(c.inAmount)} in {c.inCount}, sent {money(c.outAmount)} in {c.outCount}."
            )

    return "\n".join(lines)


# ── Offline fallback ──────────────────────────────────────────────────────────
@dataclass
class AgentReport:
    agent: str
    content: str
    confidence: float
    headline: Optional[str] = None
    findings: Optional[list[str]] = None


def localReport(ev: Evidence) -> list[AgentReport]:
    if not ev.txCount:
        head = "Waiting on data"
        intro = "There's no transaction data loaded yet, so there's nothing to analyse.\n\n"
        return [
            AgentReport(
                agent="Graph Analyst",
                headline=head,
                content=intro
                + "Once you upload a CSV I'll map who paid whom, group the accounts into separate networks, and point out which account sits at the centre of each one.",
                confidence=0.4,
            ),
            AgentReport(
                agent="Risk Analyst",
                headline=head,
                content=intro
                + "Give me the file and I'll go looking for the usual tells: payments that shrink at every hop, amounts parked just under a reporting line, and one account quietly collecting from many others.",
                confidence=0.4,
            ),
            AgentReport(
                agent="Compliance Officer",
                headline=head,
                content=intro
                + "With data loaded I'll tell you which transfers are reportable, what has to go to FIU-IND and by when, and which accounts need their KYC re-checked.",
                confidence=0.4,
            ),
            AgentReport(
                agent="Investigation Assistant",
                headline="Upload a CSV to start",
                content=intro
                + "Head to the Upload page and give me a file with these columns: **date, from, to, amount** — plus **bank**, **type** and **note** if you have them, which sharpen the analysis a lot.\n\nThen press Run full investigation and all four of us will report back on your real numbers.",
                findings=[
                    "Required columns: date, from, to, amount",
                    "Optional but useful: bank, type, note, currency",
                ],
                confidence=0.4,
            ),
        ]

    rings = [r for r in ev.rings if len(r.accounts) >= 3]
    pairs = len(ev.rings) - len(rings)
    high = [f for f in ev.findings if f.severity == "high"]

    graph_lines = [
        f"• {ev.txCount} transfers, {ev.accountCount} accounts, {len(ev.rings)} separate groups — {len(rings)} worth looking at."
    ]
    for i, r in enumerate(rings[:4]):
        graph_lines.append(
            f"• **Group {i + 1} — {r.typology if r.typology else 'untagged'}**: {len(r.accounts)} accounts, {money(r.total)}, {r.shapeLabel}."
            + (f" Everything passes through {r.hubs[0]}." if r.hubs else "")
        )
    if len(rings) > 4:
        graph_lines.append(f"• Plus {len(rings) - 4} smaller {'group' if len(rings) - 4 == 1 else 'groups'} of the same kinds.")
    if pairs > 0:
        graph_lines.append(f"• The other {pairs} are plain two-account transfers touching nothing else — ignore them.")
    graph = "\n".join(graph_lines)

    ranked = sorted(high, key=lambda f: (RISK_ORDER.get(f.code, 99), -f.amount))
    shown = ranked[:5]
    rest = len(ranked) - len(shown)

    risk_lines = [
        f"• {ev.bySeverity['high']} of {ev.txCount} transfers are high-risk, moving {money(ev.highValue)} — "
        f"{_round((ev.highValue / ev.totalValue) * 100) if ev.totalValue else 0}% of all the money here."
    ]
    if shown:
        risk_lines.extend(f"• {f.short}" for f in shown)
    else:
        risk_lines.append("• Nothing structurally alarming showed up — amounts and counterparties look like ordinary activity.")
    if rest > 0:
        risk_lines.append(f"• Plus {rest} more high-risk {'finding' if rest == 1 else 'findings'} of the same kinds.")
    risk = "\n".join(risk_lines)

    typLine = ", ".join(f"{t['label']} ({t['count']})" for t in ev.typologies) if ev.typologies else "none tagged"
    compliance_lines = [
        f"• Patterns present: {typLine}.",
        "• **PMLA 2002 / FIU-IND**: file an STR within 7 working days of forming suspicion — suspicion is the trigger, not the amount. "
        f"{ev.bySeverity['high']} transfers worth {money(ev.highValue)} qualify.",
    ]
    if any(f.code == "THRESHOLD-HUG" for f in ev.findings):
        compliance_lines.append(
            f"• The {money(REPORT_THRESHOLD)} line these cluster below is for **cash**, and these are electronic — but sizing payments against it is itself an offence."
        )
    if any(f.code == "CROSS-BORDER" for f in ev.findings):
        compliance_lines.append(f"• Overseas wires are separately reportable from {money(WIRE_REPORT_THRESHOLD)} upward.")
    compliance_lines.append(
        "• **RBI KYC Master Direction**: pass-through accounts must be re-verified. "
        + (
            "The collector taking money from many unrelated payers is the textbook case."
            if any(f.code == "FUNNEL-IN" for f in ev.findings)
            else "Any account whose turnover doesn't match its declared profile counts."
        )
    )
    if any(f.code == "CROSS-BORDER" for f in ev.findings):
        compliance_lines.append(
            "• **FEMA 1999**: the overseas legs need their purpose codes and supporting documents checked, and anything not yet settled should be recalled while it is still reachable."
        )
    compliance_lines.append(
        "• **FATF Recommendation 20**: cross-bank layering is what consortium monitoring exists to catch, since each bank sees only a fragment."
    )
    compliance = "\n".join(compliance_lines)

    topAccounts = [c.account for c in ev.topCounterparties[:3]]
    hasBorder = any(f.code == "CROSS-BORDER" for f in ev.findings)
    assistant_lines = [
        f"1. **Freeze {', '.join(topAccounts) if topAccounts else 'the hub accounts'}** — they touch the most transfers, so freezing them stops the most movement.",
        "2. **Pull KYC on the hubs** — check whether declared income matches turnover. A mismatch turns suspicion into evidence.",
        "3. **File the STR** — "
        + (
            f"cite the {len(high)} findings above with their exact amounts and dates."
            if high
            else "document your reasoning even if you conclude no filing is needed."
        ),
    ]
    if hasBorder:
        assistant_lines.append("4. **Flag the overseas leg today** — it is the last point anything can still be stopped.")
    assistant_lines.append(
        f"{'5' if hasBorder else '4'}. **Skip the {pairs} routine transfers** — no structure, no value in chasing them."
    )
    assistant = "\n".join(assistant_lines)

    return [
        AgentReport(
            agent="Graph Analyst",
            headline=f"{len(rings)} suspicious {'group' if len(rings) == 1 else 'groups'} inside {ev.accountCount} accounts",
            content=graph,
            findings=[
                f"{r.typology if r.typology else 'Untagged'}: {len(r.accounts)} accounts, {money(r.total)}, {r.shape} shape"
                for r in rings[:4]
            ],
            confidence=0.93,
        ),
        AgentReport(
            agent="Risk Analyst",
            headline=shown[0].title if shown else "Nothing structurally alarming found",
            content=risk,
            findings=[f.title for f in shown[:4]],
            confidence=0.91,
        ),
        AgentReport(
            agent="Compliance Officer",
            headline="Reportable under PMLA 2002 — STR due within 7 working days",
            content=compliance,
            findings=[
                f"{ev.bySeverity['high']} high-risk transfers worth {money(ev.highValue)} to disclose",
                *(["Threshold-splitting is itself a PMLA offence"] if any(f.code == "THRESHOLD-HUG" for f in ev.findings) else []),
                *(["FEMA 1999 applies — funds already left India"] if hasBorder else []),
            ],
            confidence=0.88,
        ),
        AgentReport(
            agent="Investigation Assistant",
            headline=f"Freeze {topAccounts[0]} first" if topAccounts else "No priority account to freeze",
            content=assistant,
            findings=[f"{c.account}: {c.degree} transfers, {money(c.volume)}" for c in ev.topCounterparties[:3]],
            confidence=0.9,
        ),
    ]


# ── The SAR document ──────────────────────────────────────────────────────────
@dataclass
class SARSubject:
    account: str
    role: str
    why: str
    inCount: int
    outCount: int
    inAmount: float
    outAmount: float
    banks: list[str]


@dataclass
class SARGround:
    code: str
    severity: str
    title: str
    text: str
    accounts: list[str]
    amount: float


@dataclass
class SARRegulation:
    statute: str
    requirement: str
    because: str


@dataclass
class SARNarrative:
    headline: str
    period: str
    summary: list[str]
    subjects: list[SARSubject]
    grounds: list[SARGround]
    regulations: list[SARRegulation]
    actions: list[str]
    conclusion: str
    flaggedCount: int
    flaggedValue: float


def accountStats(txs: list[Transaction]) -> dict[str, dict]:
    m: dict[str, dict] = {}

    def get(a: str) -> dict:
        v = m.get(a)
        if not v:
            v = {"inCount": 0, "outCount": 0, "inAmount": 0.0, "outAmount": 0.0, "banks": set()}
            m[a] = v
        return v

    for t in txs:
        frm = get(t.fromAccount)
        frm["outCount"] += 1
        frm["outAmount"] += t.amount
        if t.bank:
            frm["banks"].add(t.bank)
        to = get(t.toAccount)
        to["inCount"] += 1
        to["inAmount"] += t.amount
        if t.bank:
            to["banks"].add(t.bank)
    return m


def subjectRoles(ev: Evidence) -> dict[str, dict]:
    roles: dict[str, dict] = {}

    def _set(acc: Optional[str], rank: int, role: str, why: str) -> None:
        if acc and acc not in roles:
            roles[acc] = {"role": role, "why": why, "rank": rank}

    for f in ev.findings:
        first = f.accounts[0] if f.accounts else None
        last = f.accounts[-1] if f.accounts else None
        if f.code == "CROSS-BORDER":
            for a in f.accounts:
                _set(
                    a,
                    0,
                    "Beneficiary of an overseas wire",
                    "Received funds on a leg sent as an overseas wire — the last point at which they were still within reach.",
                )
        elif f.code == "THRESHOLD-HUG":
            for a in f.accounts:
                _set(a, 1, "Sender of structured payments", f"Sent payments deliberately sized below the {money(REPORT_THRESHOLD)} reporting line.")
        elif f.code == "CHAIN-DECAY":
            _set(first, 2, "Origin of the layering chain", f"Released {money(f.amount)} into a chain of {len(f.accounts)} accounts.")
            _set(last, 2, "End of the layering chain", "Holds what survived the chain — the point where the money comes to rest.")
            for a in f.accounts[1:-1]:
                _set(a, 4, "Intermediary in the chain", "Held the funds briefly and passed nearly all of them onward.")
        elif f.code == "FUNNEL-IN":
            _set(first, 2, "Collector — suspected money mule", f"Took {money(f.amount)} from {max(len(f.accounts) - 1, 0)} unrelated payers and forwarded it.")
            for a in f.accounts[1:]:
                _set(a, 5, "Feeder into the collector", "One of the accounts paying into the collector.")
        elif f.code == "FAN-OUT":
            _set(first, 3, "Distributor of split payments", f"Broke {money(f.amount)} into {max(len(f.accounts) - 1, 0)} smaller transfers.")
            for a in f.accounts[1:]:
                _set(a, 5, "Recipient of a split payment", "Received one slice of a sum that was deliberately broken up.")
        # BANK-HOP and BURST deliberately skipped.
    return roles


def sarNarrative(ev: Evidence, txs: list[Transaction]) -> SARNarrative:
    period = f"{ev.dateRange['from']} to {ev.dateRange['to']}" if ev.dateRange else "period not stated in the data"
    flagged = [t for t in txs if t.severity == "high"]
    flaggedValue = sum(t.amount for t in flagged)

    if not ev.txCount:
        return SARNarrative(
            headline="No transaction data loaded",
            period=period,
            summary=[
                "There is no transaction data loaded against this account, so no suspicion can be formed and nothing here is reportable. Upload a CSV and this report will rewrite itself from that data.",
            ],
            subjects=[],
            grounds=[],
            regulations=[],
            actions=["Upload transaction data before filing anything."],
            conclusion="This report is incomplete and must not be filed in its current state.",
            flaggedCount=0,
            flaggedValue=0,
        )

    high = [f for f in ev.findings if f.severity == "high"]
    border = next((f for f in ev.findings if f.code == "CROSS-BORDER"), None)
    structuring = next((f for f in ev.findings if f.code == "THRESHOLD-HUG"), None)
    funnel = next((f for f in ev.findings if f.code == "FUNNEL-IN"), None)
    chain = next((f for f in ev.findings if f.code == "CHAIN-DECAY"), None)
    share = _round((flaggedValue / ev.totalValue) * 100) if ev.totalValue else 0

    # ── Summary ──
    summary: list[str] = []
    summary.append(
        f"{ev.txCount} transfers between {ev.accountCount} accounts, worth {money(ev.totalValue)} in total, were reviewed for the period {period}. "
        f"{len(flagged)} of them — {money(flaggedValue)}, {share}% of the money in the file — carry indicators of money laundering and are the subject of this report."
    )

    if ev.findings:
        lead = ev.findings[0]
        others = len(ev.findings) - 1
        otherHigh = len([f for f in high if f is not lead])
        if others > 0:
            base = f"{others} further " + ("indicator is" if others == 1 else "indicators are") + " set out below"
            if otherHigh > 0:
                if otherHigh == others:
                    phrase = "also high severity" if others == 1 else "all of them high severity"
                else:
                    phrase = f"{otherHigh} of them high severity"
                base += f", {phrase}."
            else:
                base += "."
        else:
            base = "It is set out in full below."
        summary.append(
            "The concern is not any single payment but the shape of the activity. " + lead.short + " " + base
        )
    else:
        summary.append(
            "No structural indicator of laundering was found: the amounts, counterparties and timing all look like ordinary activity. "
            "This report records that review rather than a suspicion."
        )

    closing: list[str] = []
    if len(ev.banks) >= 3:
        closing.append(
            f"The money moved through {len(ev.banks)} banks ({', '.join(ev.banks)}), so no single institution saw more than its own share of it."
        )
    closing.append(
        f"{money(border.amount)} has already left India by overseas wire. Once it settles abroad it is effectively beyond recall, which makes this report time-critical."
        if border
        else "Every transfer stayed inside India, so the funds remain within reach of domestic freezing and attachment powers."
    )
    summary.append(" ".join(closing))

    # ── Subjects ──
    stats = accountStats(txs)
    roles = subjectRoles(ev)
    subject_rows = []
    for account, r in roles.items():
        s = stats.get(account)
        subject_rows.append(
            {
                "account": account,
                "role": r["role"],
                "why": r["why"],
                "rank": r["rank"],
                "inCount": s["inCount"] if s else 0,
                "outCount": s["outCount"] if s else 0,
                "inAmount": s["inAmount"] if s else 0,
                "outAmount": s["outAmount"] if s else 0,
                "banks": list(s["banks"]) if s else [],
            }
        )
    subject_rows.sort(key=lambda x: (x["rank"], -(x["inAmount"] + x["outAmount"])))
    subjects = [
        SARSubject(
            account=x["account"],
            role=x["role"],
            why=x["why"],
            inCount=x["inCount"],
            outCount=x["outCount"],
            inAmount=x["inAmount"],
            outAmount=x["outAmount"],
            banks=x["banks"],
        )
        for x in subject_rows[:8]
    ]

    # ── Grounds for suspicion ──
    grounds = [
        SARGround(code=f.code, severity=f.severity, title=f.title, text=f.plain, accounts=f.accounts, amount=f.amount)
        for f in ev.findings
    ]

    # ── Regulatory basis ──
    regulations: list[SARRegulation] = []
    regulations.append(
        SARRegulation(
            statute="PMLA 2002, s.12 read with PML (Maintenance of Records) Rules 2005, r.3",
            requirement="File a Suspicious Transaction Report with FIU-IND within 7 working days of forming the suspicion.",
            because=(
                f"{len(flagged)} transfers worth {money(flaggedValue)} show {len(ev.findings)} structural {'indicator' if len(ev.findings) == 1 else 'indicators'} of laundering. Suspicion — not the amount — is what triggers the obligation."
                if ev.findings
                else "No suspicion has been formed on this data, so no STR is due. The review itself is recorded here."
            ),
        )
    )

    if structuring:
        regulations.append(
            SARRegulation(
                statute=f"PMLA 2002 — structuring (payments sized against the {money(REPORT_THRESHOLD)} line)",
                requirement="Report the pattern, not just the individual payments, and preserve the sequencing evidence.",
                because=(
                    f"{structuring.title}. That line applies to cash and these are electronic transfers, so no Cash Transaction Report is due — "
                    "but deliberately sizing payments to sit under a reporting figure is an offence in its own right."
                ),
            )
        )

    if border:
        regulations.append(
            SARRegulation(
                statute="FEMA 1999 and the Cross-Border Wire Transfer Report (CBWTR)",
                requirement=f"Verify purpose codes and supporting documents on every overseas leg; overseas wires are separately reportable from {money(WIRE_REPORT_THRESHOLD)} upward.",
                because=f"{money(border.amount)} left India by wire, so the cross-border regime is engaged on top of the STR obligation.",
            )
        )

    regulations.append(
        SARRegulation(
            statute="RBI Master Direction on KYC, 2016 (as amended)",
            requirement="Carry out enhanced due diligence and re-verify the customer profile of every account named in the accounts-of-interest section.",
            because=(
                f"{funnel.accounts[0]} takes money from many unrelated payers and passes it straight on — the textbook pass-through account the ongoing-due-diligence obligation exists for."
                if funnel
                else "Turnover on the accounts above does not obviously match a declared profile, which is the trigger for re-verification."
            ),
        )
    )

    if len(ev.banks) >= 3:
        regulations.append(
            SARRegulation(
                statute="FATF Recommendation 20",
                requirement="Report the suspicion promptly and in full, including the legs held at other institutions.",
                because=f"The flow was split across {len(ev.banks)} banks, so this institution's own records show only a fragment of it. The report has to describe the whole picture, not just the part visible here.",
            )
        )

    # ── Recommended actions ──
    actions: list[str] = []
    alreadyNamed: set[str] = set()
    if border:
        exits = border.accounts[:3]
        for a in exits:
            alreadyNamed.add(a)
        actions.append(
            f"Flag the overseas leg today — {money(border.amount)} to {', '.join(exits)}. It is the last point at which anything can still be stopped."
        )
    freezeCandidates = [s for s in subjects if s.account not in alreadyNamed]
    freezeCandidates.sort(key=lambda s: -(s.inAmount + s.outAmount))
    freezeTargets = [s.account for s in freezeCandidates[:3]]
    if freezeTargets:
        actions.append(
            f"Place a hold on {', '.join(freezeTargets)} — the largest movers not already covered above, so a hold there stops the most remaining money."
        )
    actions.append(
        "Pull KYC and declared income for every account named above and compare it against the turnover shown there. A mismatch is what turns suspicion into evidence."
    )
    if chain:
        actions.append(
            f"Obtain statements for the full chain ({' → '.join(chain.accounts[:6])}{' …' if len(chain.accounts) > 6 else ''}) so the route can be evidenced hop by hop rather than inferred."
        )
    actions.append(
        f"File the STR within 7 working days, citing the {len(ev.findings)} {'ground' if len(ev.findings) == 1 else 'grounds'} set out above with the exact amounts and dates given there."
        if ev.findings
        else "Record the reasoning for not filing, so the decision is documented if the accounts resurface later."
    )
    routine = ev.txCount - len(flagged)
    if routine > 0:
        actions.append(f"Leave the remaining {routine} transfers alone — they show no structure and chasing them costs time for nothing.")

    headline = ev.findings[0].title if ev.findings else f"Review of {ev.txCount} transfers — no suspicion formed"

    conclusion = (
        (
            f"On the {len(ev.findings)} {'ground' if len(ev.findings) == 1 else 'grounds'} set out above, there is reasonable ground to suspect that the transfers listed in the reported-transactions section involve the proceeds of crime. "
            "This report is made under section 12 of the Prevention of Money Laundering Act, 2002. The findings are drawn from the transaction data as it stood on the date of generation and should be read together with the account statements for the accounts named above."
        )
        if ev.findings
        else "No reasonable ground for suspicion arises on the data reviewed. This report records the review and its outcome; it is not an STR and should not be filed as one."
    )

    return SARNarrative(
        headline=headline,
        period=period,
        summary=summary,
        subjects=subjects,
        grounds=grounds,
        regulations=regulations,
        actions=actions,
        conclusion=conclusion,
        flaggedCount=len(flagged),
        flaggedValue=flaggedValue,
    )


def classifyShape(
    bucket: list[str],
    ringTxs: list[Transaction],
    inDeg: dict[str, int],
    outDeg: dict[str, int],
    ends: Optional[dict],
) -> tuple[str, str]:
    if len(bucket) <= 2:
        return "pair", "a simple one-to-one transfer"

    def deg(a: str) -> int:
        return inDeg.get(a, 0) + outDeg.get(a, 0)

    top = sorted(bucket, key=deg, reverse=True)[0]

    if deg(top) >= len(bucket) - 1 and deg(top) >= 3:
        incoming = inDeg.get(top, 0)
        outgoing = outDeg.get(top, 0)
        if incoming > outgoing:
            return "collector", "a funnel — many accounts paying into one collector"
        return "distributor", "a fan-out — one account splitting money across many receivers"

    isChain = (
        ends is not None
        and len(ringTxs) == len(bucket) - 1
        and all(inDeg.get(a, 0) <= 1 and outDeg.get(a, 0) <= 1 for a in bucket)
    )
    if isChain:
        return "chain", "a chain — money hopping account to account in sequence"

    if not any(inDeg.get(a, 0) and outDeg.get(a, 0) for a in bucket):
        return "web", "separate payments — no account both receives money and passes it on"

    return "web", "a connected web of accounts"
