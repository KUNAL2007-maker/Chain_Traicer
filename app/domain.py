"""Domain model — ported 1:1 from src/lib/domain.ts.

The shapes that travel between the database, the views and the evidence engine,
plus the pure functions that turn a list of transactions into something
displayable — risk classification, the typology taxonomy, currency/label
formatters, cluster grouping and graph layout. Nothing here fabricates data;
every number is derived from the rows the user imported.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Optional

# ── Types ────────────────────────────────────────────────────────────────────
# Severity is one of "safe" | "medium" | "high" (kept as a plain str).
Severity = str


@dataclass
class Transaction:
    id: str
    date: str
    fromAccount: str
    toAccount: str
    bank: str
    amount: float
    currency: str
    type: str
    severity: Severity
    note: Optional[str] = None
    createdAt: Optional[int] = None
    # Which CSV import this row arrived in. Lets the upload history replay the
    # analytics for one past file instead of the whole account.
    uploadId: Optional[str] = None


@dataclass
class Alert:
    id: str
    title: str
    detail: str
    severity: Severity
    amount: float
    time_label: str
    createdAt: Optional[int] = None


@dataclass
class SARReport:
    id: str
    title: str
    amount: float
    status: str
    severity: Severity
    account: Optional[str] = None
    sourceKey: Optional[str] = None
    updatedAt: Optional[int] = None
    createdAt: Optional[int] = None


# The four specialist agents, by name.
CHAT_AGENTS = (
    "Graph Analyst",
    "Risk Analyst",
    "Compliance Officer",
    "Investigation Assistant",
)

AGENT_META = {
    "Graph Analyst": {
        "color": "#38bdf8",
        "bg": "rgba(56,189,248,0.12)",
        "icon": "◇",
        "role": "Traces topology & flow paths",
    },
    "Risk Analyst": {
        "color": "#f59e0b",
        "bg": "rgba(245,158,11,0.12)",
        "icon": "△",
        "role": "Scores anomalies & typologies",
    },
    "Compliance Officer": {
        "color": "#a78bfa",
        "bg": "rgba(167,139,250,0.14)",
        "icon": "◈",
        "role": "Maps to regulation & filings",
    },
    "Investigation Assistant": {
        "color": "#22c55e",
        "bg": "rgba(34,197,94,0.12)",
        "icon": "◉",
        "role": "Suggests next actions",
    },
}

SUGGESTED_QUERIES = [
    "Explain what's wrong with my data in simple words",
    "Which accounts should I freeze first?",
    "Why are these transfers suspicious?",
    "What laws does this break?",
    "Show me the biggest money flows",
]


# ── Currency formatting ──────────────────────────────────────────────────────
# JS uses Number.prototype.toLocaleString("en-IN"); Python has no direct
# equivalent, so the Indian digit grouping (last three digits, then pairs) is
# implemented here to keep every rendered figure byte-identical to the original.
def _group_en_in(digits: str) -> str:
    if len(digits) <= 3:
        return digits
    last3 = digits[-3:]
    rest = digits[:-3]
    parts: list[str] = []
    while len(rest) > 2:
        parts.insert(0, rest[-2:])
        rest = rest[:-2]
    if rest:
        parts.insert(0, rest)
    return ",".join(parts) + "," + last3


def format_en_in(n: float) -> str:
    neg = n < 0
    v = abs(n)
    r = round(v, 3)  # JS default maximumFractionDigits is 3
    int_part = int(r)
    int_str = _group_en_in(str(int_part))
    frac = round(r - int_part, 3)
    if frac > 0:
        frac_str = f"{r:.3f}".split(".")[1].rstrip("0")
        out = f"{int_str}.{frac_str}" if frac_str else int_str
    else:
        out = int_str
    return ("-" + out) if neg else out


def formatINR(n: float) -> str:
    if n >= 10_000_000:
        return f"₹{n / 10_000_000:.2f} Cr"
    if n >= 100_000:
        return f"₹{n / 100_000:.2f} L"
    return f"₹{format_en_in(n)}"


def severityColor(s: Severity) -> str:
    return "#ef4444" if s == "high" else "#f59e0b" if s == "medium" else "#22c55e"


# ── Risk & typology recognition ──────────────────────────────────────────────
_RISK_RE = re.compile(r"shell|layer|structur|mule|offshore|rapid|pass-through|split")


def classifyRisk(amount: float, note: Optional[str] = None) -> Severity:
    n = (note or "").lower()
    if _RISK_RE.search(n):
        return "high"
    if amount >= 1_000_000:
        return "high"
    if amount >= 100_000:
        return "medium"
    return "safe"


@dataclass
class Typology:
    key: str
    label: str
    re: "re.Pattern[str]"
    color: str


# A transaction's narration (note) is scanned for laundering-pattern signals.
# The first matching typology wins, so each transaction is tagged with a single
# dominant pattern. Shared by the raw-data table and the dashboard's typology
# distribution so both always agree.
TYPOLOGIES: list[Typology] = [
    Typology("layering", "Rapid Layering", re.compile(r"layer|rapid"), "#ef4444"),
    Typology("shell", "Shell-Account Funnel", re.compile(r"shell"), "#f59e0b"),
    Typology("mule", "Mule Network", re.compile(r"mule"), "#a78bfa"),
    Typology("structuring", "Structuring / Smurfing", re.compile(r"structur|split|smurf"), "#38bdf8"),
    Typology("roundtrip", "Round-Trip / U-Turn", re.compile(r"round-?trip|u-?turn|pass-?through"), "#22c55e"),
    Typology("offshore", "Offshore Transfer", re.compile(r"offshore"), "#ec4899"),
]


def detectPattern(note: Optional[str] = None) -> Optional[Typology]:
    n = (note or "").lower()
    if not n:
        return None
    for t in TYPOLOGIES:
        if t.re.search(n):
            return t
    return None


# ── Graph shapes ─────────────────────────────────────────────────────────────
@dataclass
class Bank:
    id: str
    name: str
    code: str
    color: str


@dataclass
class GraphNode:
    id: str
    hash: str
    bankId: str
    bankName: str
    label: str
    severity: Severity
    riskLevel: str  # "normal" | "suspicious" | "high"
    balance: float
    country: str
    createdAt: str
    x: float = 0.0
    y: float = 0.0
    vx: float = 0.0
    vy: float = 0.0
    degree: int = 0


@dataclass
class GraphEdge:
    id: str
    source: str
    target: str
    amount: float
    currency: str
    severity: Severity
    timestamp: str
    note: Optional[str] = None
    bank: Optional[str] = None


@dataclass
class GraphCluster:
    id: str
    kind: str  # "web" | "pairs"
    label: str
    color: str
    count: int
    total: float
    severity: Severity
    nodeIds: list[str]
    x: float
    y: float
    w: float
    h: float


# Node size scales with how many counterparties an account touches, so hubs
# visibly dominate. Shared with the renderer so layout spacing and drawn size
# never disagree.
def nodeRadius(degree: int = 1) -> float:
    return min(26, 13 + max(0, degree - 1) * 2.6)


# Account handles all share an "ACC-" prefix; dropping it keeps the on-canvas
# label short.
_ACC_PREFIX = re.compile(r"^ACC[-_]?", re.IGNORECASE)


def shortAccountLabel(label: str) -> str:
    s = _ACC_PREFIX.sub("", label)
    return f"{s[:12]}…" if len(s) > 13 else s


# ── Layout constants ─────────────────────────────────────────────────────────
PAD = 44
GAP_X = 56
GAP_Y = 64
REGION_GAP = 76
CAPTION_H = 46
MAX_COLS = 2
PAIR_GAP = 34


def _js_round(x: float) -> int:
    # JS Math.round rounds a half up (toward +Infinity), unlike Python's round().
    return math.floor(x + 0.5)


# The only static table left in this file. Every figure the UI shows is derived
# from the user's own imported rows; this exists purely to give an account a
# stable colour when its CSV carries no bank column.
BANKS: list[Bank] = [
    Bank("b1", "Meridian Trust Bank", "MTB", "#38bdf8"),
    Bank("b2", "Northwind Capital", "NWC", "#a78bfa"),
    Bank("b3", "Sterling Union Bank", "SUB", "#f59e0b"),
    Bank("b4", "Pacific Reserve", "PRV", "#22c55e"),
    Bank("b5", "Continental Wealth", "CWL", "#ec4899"),
]


def bankForAccount(account: str) -> Bank:
    h = 0
    for ch in account:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return BANKS[h % len(BANKS)]


# ── Build graph from transactions ────────────────────────────────────────────
def buildGraphFromTransactions(txs: list[Transaction], canvasWidth: int = 1240) -> dict:
    accountMap: dict[str, dict] = {}

    for t in txs:
        for acc in (t.fromAccount, t.toAccount):
            if not acc:
                continue
            cur = accountMap.get(acc)
            if cur is None:
                cur = {"in": 0.0, "out": 0.0, "sev": "safe", "bank": t.bank or "Unknown", "example": t}
            if acc == t.fromAccount:
                cur["out"] += t.amount
            else:
                cur["in"] += t.amount
            if t.bank and t.bank != "Unknown":
                cur["bank"] = t.bank
            if t.severity == "high":
                cur["sev"] = "high"
            elif t.severity == "medium" and cur["sev"] != "high":
                cur["sev"] = "medium"
            accountMap[acc] = cur

    # Array.from(new Set(...)) preserves first-seen order → dict.fromkeys.
    bankNames = list(
        dict.fromkeys(v["bank"] for v in accountMap.values() if v["bank"] and v["bank"] != "Unknown")
    )

    accounts = list(accountMap.keys())

    nodes: list[GraphNode] = []
    for acc in accounts:
        info = accountMap[acc]
        bankName = info["bank"] or "Unknown"
        bankIdx = bankNames.index(bankName) if bankName in bankNames else -1
        matchedBank = BANKS[bankIdx] if 0 <= bankIdx < len(BANKS) else bankForAccount(acc)
        sev = info["sev"]
        nodes.append(
            GraphNode(
                id=acc,
                hash=f"{acc[:6]}…{acc[-4:]}" if len(acc) > 12 else acc,
                bankId=matchedBank.id,
                bankName=bankName,
                label=acc,
                severity=sev,
                riskLevel="high" if sev == "high" else "suspicious" if sev == "medium" else "normal",
                balance=info["in"] - info["out"],
                country="IN" if info["example"].currency == "INR" else "—",
                createdAt=info["example"].date,
                x=0.0,
                y=0.0,
                degree=0,
            )
        )

    edges: list[GraphEdge] = []
    for i, t in enumerate(txs):
        edges.append(
            GraphEdge(
                id=t.id or f"e{i}",
                source=t.fromAccount,
                target=t.toAccount,
                amount=t.amount,
                currency=t.currency,
                severity=t.severity,
                timestamp=t.date,
                note=t.note,
                bank=t.bank,
            )
        )

    clusters, height = _layoutGraph(nodes, edges, canvasWidth)

    return {
        "nodes": nodes,
        "edges": edges,
        "bankNames": bankNames,
        "clusters": clusters,
        "height": height,
    }


# ── Graph layout ─────────────────────────────────────────────────────────────
# Dependency-free, fully deterministic (no random seed) so re-renders are stable.
# Ordered sets are modelled with dict (insertion-ordered keys) to match the JS
# Set iteration semantics the BFS and chain-walk depend on.
def _layoutGraph(nodes: list[GraphNode], edges: list[GraphEdge], W: int) -> tuple[list[GraphCluster], int]:
    if not nodes:
        return [], 420

    index: dict[str, GraphNode] = {n.id: n for n in nodes}

    adj: dict[str, dict[str, None]] = {}
    outN: dict[str, dict[str, None]] = {}
    for n in nodes:
        adj[n.id] = {}
        outN[n.id] = {}
    for e in edges:
        if e.source == e.target:
            continue
        if e.source not in index or e.target not in index:
            continue
        adj[e.source][e.target] = None
        adj[e.target][e.source] = None
        outN[e.source][e.target] = None
    for n in nodes:
        n.degree = len(adj[n.id])

    # Connected components via BFS.
    seen: set[str] = set()
    comps: list[list[GraphNode]] = []
    for start in nodes:
        if start.id in seen:
            continue
        bucket: list[GraphNode] = []
        queue = [start.id]
        seen.add(start.id)
        qi = 0
        while qi < len(queue):
            cur = queue[qi]
            qi += 1
            bucket.append(index[cur])
            for nb in adj[cur]:
                if nb not in seen:
                    seen.add(nb)
                    queue.append(nb)
        comps.append(bucket)

    items: list[dict] = []
    for i, bucket in enumerate(comps):
        pos = _layoutComponent(bucket, adj, outN, index)
        m = _measure(bucket, pos)
        items.append({"i": i, "bucket": bucket, "pos": pos, **m})

    usable = max(320, W - PAD * 2)
    clusters: list[GraphCluster] = []
    y = PAD

    webs = [it for it in items if len(it["bucket"]) >= 3]
    for it in webs:
        it["typ"] = _clusterTypology(it["bucket"], edges)
    # Stable sort by (rank asc, size desc).
    webs.sort(key=lambda it: (it["typ"]["rank"], -len(it["bucket"])))
    pairs = [it for it in items if len(it["bucket"]) < 3]

    if webs:
        rows: list[list[dict]] = []
        row: list[dict] = []
        for it in webs:
            cand = row + [it]
            widest = max(c["w"] for c in cand)
            fits = widest * len(cand) + GAP_X * (len(cand) - 1) <= usable
            if row and (not fits or len(row) >= MAX_COLS):
                rows.append(row)
                row = [it]
            else:
                row = cand
        if row:
            rows.append(row)

        for r in rows:
            cardW = (usable - GAP_X * (len(r) - 1)) / len(r)
            bodyH = max(it["h"] for it in r)
            for k, it in enumerate(r):
                ownH = min(bodyH, _js_round(it["h"] * 1.35))
                cardX = PAD + k * (cardW + GAP_X)
                dx = cardX + (cardW - it["w"]) / 2 + it["ox"]
                dy = y + CAPTION_H + (ownH - it["h"]) / 2 + it["oy"]
                for nd in it["bucket"]:
                    p = it["pos"][nd.id]
                    nd.x = dx + p["x"]
                    nd.y = dy + p["y"]
                clusters.append(
                    GraphCluster(
                        id=f"cl-{it['i']}",
                        kind="web",
                        label=it["typ"]["label"],
                        color=it["typ"]["color"],
                        count=len(it["bucket"]),
                        total=it["typ"]["total"],
                        severity=it["typ"]["severity"],
                        nodeIds=[b.id for b in it["bucket"]],
                        x=cardX,
                        y=y,
                        w=cardW,
                        h=ownH + CAPTION_H,
                    )
                )
            y += bodyH + CAPTION_H + GAP_Y
        y -= GAP_Y

    if pairs:
        if webs:
            y += REGION_GAP
        inner = usable - 32
        cellW = max(p["w"] for p in pairs)
        cellH = max(p["h"] for p in pairs)
        maxCols = max(1, math.floor((inner + PAIR_GAP) / (cellW + PAIR_GAP)))
        rowCount = math.ceil(len(pairs) / maxCols)
        cols = max(1, math.ceil(len(pairs) / rowCount))
        gridW = cols * cellW + (cols - 1) * PAIR_GAP
        gridH = rowCount * cellH + (rowCount - 1) * PAIR_GAP
        startX = PAD + max(0, (usable - gridW) / 2)
        for k, it in enumerate(pairs):
            cx = startX + (k % cols) * (cellW + PAIR_GAP) + (cellW - it["w"]) / 2
            cy = y + CAPTION_H + math.floor(k / cols) * (cellH + PAIR_GAP) + (cellH - it["h"]) / 2
            for nd in it["bucket"]:
                p = it["pos"][nd.id]
                nd.x = cx + it["ox"] + p["x"]
                nd.y = cy + it["oy"] + p["y"]
        pairIds: dict[str, None] = {}
        for p in pairs:
            for b in p["bucket"]:
                pairIds[b.id] = None
        pairTotal = 0.0
        pairHigh = False
        pairMedium = False
        for e in edges:
            if e.source not in pairIds or e.target not in pairIds:
                continue
            pairTotal += e.amount
            if e.severity == "high":
                pairHigh = True
            elif e.severity == "medium":
                pairMedium = True
        clusters.append(
            GraphCluster(
                id="cl-pairs",
                kind="pairs",
                label="Direct 1-to-1 transfers",
                color="#64748b",
                count=len(pairs),
                total=pairTotal,
                severity="high" if pairHigh else "medium" if pairMedium else "safe",
                nodeIds=list(pairIds.keys()),
                x=PAD,
                y=y,
                w=usable,
                h=gridH + CAPTION_H + 20,
            )
        )
        y += gridH + CAPTION_H + 20

    return clusters, max(380, _js_round(y + PAD))


def _measure(bucket: list[GraphNode], pos: dict[str, dict]) -> dict:
    minX = math.inf
    maxX = -math.inf
    minY = math.inf
    maxY = -math.inf
    for n in bucket:
        p = pos[n.id]
        r = nodeRadius(n.degree or 1)
        halfLabel = len(shortAccountLabel(n.label)) * 2.9 + 6
        halfW = max(r + 16, halfLabel)
        minX = min(minX, p["x"] - halfW)
        maxX = max(maxX, p["x"] + halfW)
        minY = min(minY, p["y"] - r - 16)
        maxY = max(maxY, p["y"] + r + 22)
    return {"w": maxX - minX, "h": maxY - minY, "ox": -minX, "oy": -minY}


def _clusterTypology(bucket: list[GraphNode], edges: list[GraphEdge]) -> dict:
    ids = {b.id for b in bucket}
    tally: dict[str, dict] = {}
    total = 0.0
    high = False
    medium = False
    for e in edges:
        if e.source not in ids or e.target not in ids:
            continue
        total += e.amount
        if e.severity == "high":
            high = True
        elif e.severity == "medium":
            medium = True
        p = detectPattern(e.note)
        if not p:
            continue
        cur = tally.get(p.key)
        if cur:
            cur["n"] += 1
        else:
            tally[p.key] = {"t": p, "n": 1}
    severity = "high" if high else "medium" if medium else "safe"
    best = None
    for entry in tally.values():
        if best is None or entry["n"] > best["n"]:
            best = entry
    if best:
        rank = next((i for i, t in enumerate(TYPOLOGIES) if t.key == best["t"].key), -1)
        return {"label": best["t"].label, "color": best["t"].color, "total": total, "severity": severity, "rank": rank}
    if high:
        return {"label": "Suspicious flow", "color": "#ef4444", "total": total, "severity": severity, "rank": 90}
    if medium:
        return {"label": "Elevated-value transfer", "color": "#f59e0b", "total": total, "severity": severity, "rank": 91}
    return {"label": "Verified transfer", "color": "#22c55e", "total": total, "severity": severity, "rank": 92}


def _layoutComponent(
    bucket: list[GraphNode],
    adj: dict[str, dict[str, None]],
    outN: dict[str, dict[str, None]],
    index: dict[str, GraphNode],
) -> dict[str, dict]:
    pos: dict[str, dict] = {}
    n = len(bucket)

    def deg(_id: str) -> int:
        return len(adj[_id])

    if n == 1:
        pos[bucket[0].id] = {"x": 0.0, "y": 0.0}
        return pos

    if n == 2:
        a, b = bucket[0], bucket[1]
        aSends = b.id in outN[a.id]
        pos[a.id if aSends else b.id] = {"x": -46.0, "y": 0.0}
        pos[b.id if aSends else a.id] = {"x": 46.0, "y": 0.0}
        return pos

    edgeCount = sum(deg(b.id) for b in bucket) / 2
    ends = [b for b in bucket if deg(b.id) == 1]

    # Chain (layering): a path graph — draw the hops as a gentle left-to-right arc.
    if edgeCount == n - 1 and len(ends) == 2 and all(deg(b.id) <= 2 for b in bucket):
        start = next((e for e in ends if len(outN[e.id]) > 0), ends[0])
        order = [start]
        walked = {start.id}
        while len(order) < n:
            cur = order[-1]
            nxt = next((x for x in adj[cur.id] if x not in walked), None)
            if not nxt:
                break
            walked.add(nxt)
            order.append(index[nxt])
        span = max(1, len(order) - 1)
        for i, b in enumerate(order):
            pos[b.id] = {"x": i * 104, "y": -math.sin((i / span) * math.pi) * 26}
        return pos

    # Hub-and-spoke: one account touches every other. Senders left, hub centre,
    # beneficiaries right.
    hub = sorted(bucket, key=lambda b: deg(b.id), reverse=True)[0]
    if deg(hub.id) == n - 1 and deg(hub.id) >= 3:
        sendsTo = outN[hub.id]
        outs = [b for b in bucket if b.id != hub.id and b.id in sendsTo]
        ins = [b for b in bucket if b.id != hub.id and b.id not in sendsTo]
        pos[hub.id] = {"x": 0.0, "y": 0.0}
        _placeFan(ins, -1, pos)
        _placeFan(outs, 1, pos)
        return pos

    return _relaxLayout(bucket, adj)


def _placeFan(lst: list[GraphNode], side: int, pos: dict[str, dict]) -> None:
    if not lst:
        return
    cols = math.ceil(len(lst) / 3)
    remaining = len(lst)
    idx = 0
    for c in range(cols):
        take = math.ceil(remaining / (cols - c))
        remaining -= take
        x = side * (128 + c * 68)
        for i in range(take):
            pos[lst[idx].id] = {"x": float(x), "y": (i - (take - 1) / 2) * 64}
            idx += 1


def _relaxLayout(bucket: list[GraphNode], adj: dict[str, dict[str, None]]) -> dict[str, dict]:
    positions: dict[str, dict] = {}
    n = len(bucket)
    R = 40 + n * 13
    for i, b in enumerate(bucket):
        ang = (i / n) * math.pi * 2
        positions[b.id] = {"x": math.cos(ang) * R, "y": math.sin(ang) * R}

    ids = [b.id for b in bucket]
    ideal = 84
    for _iter in range(240):
        disp: dict[str, dict] = {_id: {"x": 0.0, "y": 0.0} for _id in ids}

        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a = positions[ids[i]]
                b = positions[ids[j]]
                dx = a["x"] - b["x"]
                dy = a["y"] - b["y"]
                d2 = dx * dx + dy * dy
                if d2 < 0.01:
                    dx = ((i * 13 + 7) % 11) - 5
                    dy = ((j * 17 + 3) % 11) - 5
                    d2 = dx * dx + dy * dy + 0.01
                d = math.sqrt(d2)
                rep = 6200 / d2
                ux = dx / d
                uy = dy / d
                da = disp[ids[i]]
                db = disp[ids[j]]
                da["x"] += ux * rep
                da["y"] += uy * rep
                db["x"] -= ux * rep
                db["y"] -= uy * rep

        for _id in ids:
            for nb in adj[_id]:
                if _id < nb and nb in positions:
                    a = positions[_id]
                    b = positions[nb]
                    dx = b["x"] - a["x"]
                    dy = b["y"] - a["y"]
                    d = math.sqrt(dx * dx + dy * dy) or 1
                    f = (d - ideal) * 0.09
                    ux = dx / d
                    uy = dy / d
                    da = disp[_id]
                    db = disp[nb]
                    da["x"] += ux * f
                    da["y"] += uy * f
                    db["x"] -= ux * f
                    db["y"] -= uy * f

        cap = 26
        for _id in ids:
            dsp = disp[_id]
            m = math.sqrt(dsp["x"] * dsp["x"] + dsp["y"] * dsp["y"])
            sx = (dsp["x"] / m) * cap if m > cap else dsp["x"]
            sy = (dsp["y"] / m) * cap if m > cap else dsp["y"]
            p = positions[_id]
            p["x"] += sx * 0.85
            p["y"] += sy * 0.85

    cx = 0.0
    cy = 0.0
    for p in positions.values():
        cx += p["x"]
        cy += p["y"]
    cx /= n
    cy /= n
    for p in positions.values():
        p["x"] -= cx
        p["y"] -= cy
    return positions
