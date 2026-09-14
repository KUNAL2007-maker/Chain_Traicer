"""Presentation glue for the Jinja templates — the Python home for the small
pure functions that used to live inside the React view components.

Nothing here talks to the database or the model. It takes the same Transaction
list the views receive and turns it into the exact shapes the templates iterate
over: the dashboard heatmap and typology bars, the CSV parser that backs the
upload preview and the server-side import, the SAR ring walk, and the graph
edge-curve maths. Kept out of domain.py so the domain model stays free of
anything view-specific.
"""
from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Optional

from .domain import (
    Transaction,
    bankForAccount,
    detectPattern,
    formatINR,
    severityColor,
    _js_round,
)

# ── Layout constants (were src/components/ui/Page.tsx) ────────────────────────
PAGE_GUTTER = "px-4 sm:px-5 2xl:px-8"
WIDTHS = {"default": "max-w-[1440px]", "wide": "max-w-[1760px]"}


# ── Sidebar navigation (was src/components/Sidebar.tsx NAV) ────────────────────
# `icon` is the full <svg> markup, copied verbatim from Sidebar.tsx so the rail
# is pixel-identical (React's strokeWidth/strokeLinecap become the SVG-standard
# hyphenated attributes). base.html renders each with the `safe` filter. `href`
# is the MPA route the SPA's setView(key) became.
NAV = [
    {
        "key": "dashboard",
        "href": "/",
        "label": "Command Dashboard",
        "hint": "Overview & signals",
        "icon": (
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none">'
            '<path d="M3 12h4l3-8 4 16 3-8h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
            "</svg>"
        ),
    },
    {
        "key": "transactions",
        "href": "/transactions",
        "label": "Transactions",
        "hint": "Browse & filter",
        "icon": (
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none">'
            '<path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
            "</svg>"
        ),
    },
    {
        "key": "graph",
        "href": "/graph",
        "label": "Transaction Graph",
        "hint": "Network canvas",
        "icon": (
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none">'
            '<circle cx="5" cy="6" r="2" stroke="currentColor" stroke-width="1.6"/>'
            '<circle cx="19" cy="6" r="2" stroke="currentColor" stroke-width="1.6"/>'
            '<circle cx="12" cy="13" r="2" stroke="currentColor" stroke-width="1.6"/>'
            '<circle cx="6" cy="19" r="2" stroke="currentColor" stroke-width="1.6"/>'
            '<circle cx="18" cy="19" r="2" stroke="currentColor" stroke-width="1.6"/>'
            '<path d="M6.5 7.5L11 12M17.5 7.5L13 12M11 14L7 18M13 14l4 4" stroke="currentColor" stroke-width="1.4"/>'
            "</svg>"
        ),
    },
    {
        "key": "upload",
        "href": "/upload",
        "label": "Upload CSV",
        "hint": "Import data",
        "icon": (
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none">'
            '<path d="M12 3v12M8 7l4-4 4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
            "</svg>"
        ),
    },
    {
        "key": "chat",
        "href": "/chat",
        "label": "AI Investigator",
        "hint": "Multi-agent chat",
        "icon": (
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none">'
            '<path d="M4 6h16v10H8l-4 3V6z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
            '<circle cx="9" cy="11" r="1" fill="currentColor"/>'
            '<circle cx="12" cy="11" r="1" fill="currentColor"/>'
            '<circle cx="15" cy="11" r="1" fill="currentColor"/>'
            "</svg>"
        ),
    },
    {
        "key": "sar",
        "href": "/sar",
        "label": "Compliance / SAR",
        "hint": "Auto reports",
        "icon": (
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none">'
            '<path d="M7 3h8l4 4v14H7V3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
            '<path d="M15 3v5h4M9 12h6M9 16h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
            "</svg>"
        ),
    },
]

# ── TopBar copy (was src/components/TopBar.tsx VIEW_TITLES) ─────────────────────
VIEW_TITLES = {
    "dashboard": {"title": "Command Dashboard", "sub": "Overview & signals"},
    "transactions": {"title": "Transactions", "sub": "Browse, search, and filter"},
    "graph": {
        "title": "Interactive Transaction Graph",
        "sub": "Multi-bank flow topology · anonymized handles",
    },
    "upload": {"title": "Upload CSV", "sub": "Import transactions from a CSV file"},
    "chat": {
        "title": "Multi-Agent AI Investigator",
        "sub": "Ask in natural language · 4 specialist agents online",
    },
    "sar": {
        "title": "Compliance Reports · SAR Builder",
        "sub": "Draft & export suspicious activity reports",
    },
}


def initials(full_name: Optional[str], email: Optional[str] = None) -> str:
    """The account-chip monogram from Sidebar.tsx: first letters of the first two
    words of the full name, else the first letter of the email, else 'U'."""
    name = (full_name or "").strip()
    if name:
        parts = [p for p in re.split(r"\s+", name) if p]
        letters = "".join(p[0] for p in parts[:2])
        if letters:
            return letters.upper()
    if email:
        return email[0].upper()
    return "U"


# ── Alert timestamps (were CommandDashboard.tsx formatAlertDate/Time) ───────────
# new Date(ts) is local time; datetime.fromtimestamp is too, so they agree.
def fmt_alert_date(ts: Optional[int]) -> str:
    """toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'})
    → e.g. '13 Sep 2026'. Also the grouping key; falsy ts → 'Unknown'."""
    if not ts:
        return "Unknown"
    return datetime.fromtimestamp(ts / 1000).strftime("%d %b %Y")


def fmt_alert_time(ts: Optional[int]) -> str:
    """toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit', hour12:true})
    → e.g. '10:30 PM'. Falsy ts → ''."""
    if not ts:
        return ""
    return datetime.fromtimestamp(ts / 1000).strftime("%I:%M %p")


def group_alerts_by_date(alerts) -> list[dict]:
    """The alertsByDate reduce in CommandDashboard.tsx, as an ordered list so the
    template keeps the newest-first order the reduce preserved. Each group is
    {date, alerts} and each alert is wrapped with its preformatted time/stamp."""
    groups: dict[str, dict] = {}
    order: list[str] = []
    for a in alerts:
        key = fmt_alert_date(a.createdAt) if a.createdAt else "Unknown"
        g = groups.get(key)
        if g is None:
            g = {"date": key, "alerts": []}
            groups[key] = g
            order.append(key)
        g["alerts"].append(
            {
                "a": a,
                "time": fmt_alert_time(a.createdAt) if a.createdAt else "",
                "stamp": (
                    f"{fmt_alert_date(a.createdAt)} · {fmt_alert_time(a.createdAt)}"
                    if a.createdAt
                    else "—"
                ),
            }
        )
    return [groups[k] for k in order]


# ── Dashboard: sparkline series (was CommandDashboard.tsx) ──────────────────────
SPARK1 = [12, 14, 13, 18, 17, 22, 24, 21, 27, 30, 28, 34]
SPARK2 = [220, 234, 210, 255, 268, 260, 280, 305, 298, 320, 335, 348]
SPARK3 = [3, 4, 3, 5, 6, 5, 6, 6, 7, 7, 7, 8]
SPARK4 = [90, 88, 85, 82, 84, 81, 80, 78, 79, 78, 77, 78]


def sparkline(points: list[float], color: str, width: float = 120, height: float = 36) -> dict:
    """Port of src/components/ui/Sparkline.tsx. Returns the line path, the filled
    area path that closes to the baseline, and the gradient id used to fill it."""
    if not points:
        return {"line": "", "area": "", "gradId": f"spark-{_grad_key(color)}",
                "color": color, "width": width, "height": height}
    lo = min(points)
    hi = max(points)
    rng = (hi - lo) or 1
    n = len(points)
    step = width / (n - 1) if n > 1 else 0.0
    coords = []
    for i, p in enumerate(points):
        x = i * step
        y = height - ((p - lo) / rng) * height
        coords.append((x, y))
    line = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in coords)
    area = (
        f"M{coords[0][0]:.1f} {height:.1f} "
        + "L" + " L".join(f"{x:.1f} {y:.1f}" for x, y in coords)
        + f" L{coords[-1][0]:.1f} {height:.1f} Z"
    )
    return {"line": line, "area": area, "gradId": f"spark-{_grad_key(color)}",
            "color": color, "width": width, "height": height}


def _grad_key(color: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]", "", color)


# ── Dashboard: agent fleet + signal-mini constants ─────────────────────────────
FLEET = [
    {"name": "Graph Analyst", "color": "#38bdf8", "load": 62},
    {"name": "Risk Analyst", "color": "#f59e0b", "load": 74},
    {"name": "Compliance Officer", "color": "#a78bfa", "load": 41},
    {"name": "Investigation Assistant", "color": "#22c55e", "load": 55},
]

# The three little bar-signals shown when an alert row is expanded, keyed by the
# alert's own severity (Investigation Details in CommandDashboard.tsx).
SIGNAL_SCORES = {
    "high": {"severity": 92, "confidence": 87, "priority": 95},
    "medium": {"severity": 58, "confidence": 65, "priority": 60},
    "safe": {"severity": 15, "confidence": 65, "priority": 20},
}


# ── Dashboard: heatmap (was CommandDashboard.tsx buildHeatmap) ──────────────────
_HEAT_MAX_COLS = 28


def _fmt_day(label: str) -> str:
    # "YYYY-MM-DD" → "MM/DD"; anything else is shown as-is.
    parts = label.split("-")
    if len(parts) == 3:
        return f"{parts[1]}/{parts[2]}"
    return label


def build_heatmap(transactions: list[Transaction]) -> dict:
    """Severity × Date. Returns the exact shape CommandDashboard.tsx renders:

        columns: [{label, high, medium, safe}]   — one per date/bucket
        rows:    [{key, label, short, color, max}] — per-severity row metadata

    The template reads `col[row.key]` for a cell's count and `row.max` for the
    row's busiest cell, so the opacity ramp stays in the template exactly as the
    JSX had it. Past 28 dates, consecutive dates aggregate into buckets labelled
    by the first date in the bucket (matching the JSX, which drops the range)."""
    if not transactions:
        return {"columns": [], "rows": []}

    by_date: dict[str, dict] = {}
    for t in transactions:
        key = t.date or "—"
        cur = by_date.get(key)
        if cur is None:
            cur = {"high": 0, "medium": 0, "safe": 0}
            by_date[key] = cur
        cur[t.severity] = cur.get(t.severity, 0) + 1

    dates = sorted(by_date.keys())
    if len(dates) <= _HEAT_MAX_COLS:
        columns = [{"label": _fmt_day(d), **by_date[d]} for d in dates]
    else:
        columns = []
        size = math.ceil(len(dates) / _HEAT_MAX_COLS)
        for i in range(0, len(dates), size):
            group = dates[i : i + size]
            agg = {"high": 0, "medium": 0, "safe": 0}
            for gd in group:
                c = by_date[gd]
                agg["high"] += c["high"]
                agg["medium"] += c["medium"]
                agg["safe"] += c["safe"]
            columns.append({"label": _fmt_day(group[0]), **agg})

    rows = [
        {"key": "high", "label": "High", "short": "H", "color": "#ef4444",
         "max": max([1] + [c["high"] for c in columns])},
        {"key": "medium", "label": "Medium", "short": "M", "color": "#f59e0b",
         "max": max([1] + [c["medium"] for c in columns])},
        {"key": "safe", "label": "Low", "short": "L", "color": "#22c55e",
         "max": max([1] + [c["safe"] for c in columns])},
    ]
    return {"columns": columns, "rows": rows}


# ── Dashboard: typology distribution (was CommandDashboard.tsx buildTypology) ───
def build_typology(transactions: list[Transaction]) -> dict:
    tally: dict[str, dict] = {}
    total = 0
    for t in transactions:
        p = detectPattern(t.note)
        if not p:
            continue
        total += 1
        cur = tally.get(p.key)
        if cur:
            cur["count"] += 1
        else:
            tally[p.key] = {"name": p.label, "color": p.color, "count": 1}
    rows = sorted(tally.values(), key=lambda r: r["count"], reverse=True)
    for r in rows:
        r["pct"] = round((r["count"] / total) * 100) if total else 0
    return {"total": total, "rows": rows}


# ── Transactions view: amount label + row severity for the no-JS table ─────────
def tx_amount(t: Transaction) -> str:
    """From TransactionsView.tsx / SARReports.tsx: INR is formatted with the
    lakh/crore helper, any other currency is grouped and suffixed with its code."""
    if t.currency == "INR" or not t.currency:
        return formatINR(t.amount)
    from .domain import format_en_in

    return f"{format_en_in(t.amount)} {t.currency}"


# ── Upload: CSV parsing (was UploadView.tsx parseCSV / splitCsvLine) ────────────
REQUIRED_HEADERS = ["date", "from", "to", "amount"]

_HEADER_ALIASES = {
    "date": ["date", "timestamp", "time", "transaction_date"],
    "from": ["from", "from_account", "source", "sender", "payer"],
    "to": ["to", "to_account", "target", "receiver", "payee", "beneficiary"],
    "amount": ["amount", "value", "sum"],
    "bank": ["bank", "institution"],
    "currency": ["currency", "curr"],
    "type": ["type", "transaction_type", "category"],
    "note": ["note", "description", "memo", "remarks"],
}

_AMOUNT_STRIP = re.compile(r"[,\s₹$€£]")


def split_csv_line(line: str) -> list[str]:
    """Quote-aware split on commas. A doubled quote inside a quoted field is a
    literal quote. Mirrors UploadView.tsx splitCsvLine exactly."""
    out: list[str] = []
    cur = ""
    in_quotes = False
    i = 0
    while i < len(line):
        ch = line[i]
        if in_quotes:
            if ch == '"':
                if i + 1 < len(line) and line[i + 1] == '"':
                    cur += '"'
                    i += 1
                else:
                    in_quotes = False
            else:
                cur += ch
        else:
            if ch == '"':
                in_quotes = True
            elif ch == ",":
                out.append(cur)
                cur = ""
            else:
                cur += ch
        i += 1
    out.append(cur)
    return [s.strip() for s in out]


class CSVError(ValueError):
    """A user-facing parse error whose message is shown verbatim, exactly as the
    original threw a string the UI printed."""


def parse_csv(text: str) -> tuple[list[dict], list[str]]:
    """Port of UploadView.tsx parseCSV. Returns (rows, warnings). Raises CSVError
    with the same user-facing message on a structural failure.

    Each row is a ParsedRow dict: {date, fromAccount, toAccount, bank, amount,
    currency, type, note?}. note is omitted (not None) when blank, matching the
    original's `undefined`."""
    lines = [ln for ln in re.split(r"\r?\n", text) if ln.strip()]
    if len(lines) < 2:
        raise CSVError("File is empty or has only headers.")

    raw_headers = split_csv_line(lines[0])
    headers = [re.sub(r"\s+", "_", h.strip().lower()) for h in raw_headers]

    def find_idx(aliases: list[str]) -> int:
        for a in aliases:
            if a in headers:
                return headers.index(a)
        return -1

    idx = {key: find_idx(aliases) for key, aliases in _HEADER_ALIASES.items()}

    missing = [key for key in REQUIRED_HEADERS if idx[key] < 0]
    if missing:
        raise CSVError("Missing required column(s): " + ", ".join(missing))

    rows: list[dict] = []
    warnings: list[str] = []
    for i in range(1, len(lines)):
        cells = split_csv_line(lines[i])

        def cell(key: str) -> str:
            j = idx[key]
            return cells[j].strip() if 0 <= j < len(cells) else ""

        amount_raw = _AMOUNT_STRIP.sub("", cell("amount"))
        try:
            amount = float(amount_raw)
            finite = math.isfinite(amount)
        except (ValueError, TypeError):
            amount = float("nan")
            finite = False
        if not finite:
            warnings.append(f'Row {i + 1}: amount "{cell("amount")}" is not a number, skipped.')
            continue

        note = cell("note")
        row = {
            "date": cell("date"),
            "fromAccount": cell("from"),
            "toAccount": cell("to"),
            "bank": cell("bank") or "Unknown",
            "amount": amount,
            "currency": cell("currency") or "INR",
            "type": cell("type") or "transfer",
        }
        if note:
            row["note"] = note
        rows.append(row)

    return rows, warnings


# ── SAR: ring walk (was SARReports.tsx ringOf) ─────────────────────────────────
def ring_of(transactions: list[Transaction], account: str) -> list[Transaction]:
    """Every transfer in the same connected component as `account`. BFS over the
    undirected neighbour graph, then keep transfers touching any seen node."""
    neighbours: dict[str, list[str]] = {}
    for t in transactions:
        neighbours.setdefault(t.fromAccount, []).append(t.toAccount)
        neighbours.setdefault(t.toAccount, []).append(t.fromAccount)
    if account not in neighbours:
        return []

    seen = {account}
    queue = [account]
    qi = 0
    while qi < len(queue):
        cur = queue[qi]
        qi += 1
        for nxt in neighbours.get(cur, []):
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    return [t for t in transactions if t.fromAccount in seen or t.toAccount in seen]


# ── Graph: edge curve + node colours (was GraphView.tsx) ───────────────────────
GRAPH_W = 1240


def curve_path(x1: float, y1: float, x2: float, y2: float) -> str:
    """A gently bowed cubic between two node centres. The control points are
    pushed perpendicular to the line so parallel edges between the same lanes
    don't overlap into a single stroke."""
    mx = (x1 + x2) / 2
    my = (y1 + y2) / 2
    dx = x2 - x1
    dy = y2 - y1
    dist = math.hypot(dx, dy) or 1
    # Perpendicular unit vector, bow scaled to a fraction of the span (capped).
    # Matches GraphView.tsx curvePath exactly: off = min(26, len * 0.12).
    nx = -dy / dist
    ny = dx / dist
    off = min(26.0, dist * 0.12)
    cx = mx + nx * off
    cy = my + ny * off
    return f"M {x1:.1f} {y1:.1f} Q {cx:.1f} {cy:.1f} {x2:.1f} {y2:.1f}"


def node_fill(node) -> str:
    """Disc fill — the panel colour in both themes (globals.css remaps it under
    html.light via the circle[fill="#0d1117"] selector)."""
    return "#0d1117"


def node_stroke(node) -> str:
    return severityColor(node.severity)


def label_of(node) -> str:
    from .domain import shortAccountLabel

    return shortAccountLabel(node.label)


# Lane / typology hues read on the dark canvas; as lettering on a white panel
# each sinks below legible contrast, so light mode swaps the *text* colour for a
# darker sibling of the same family (fills, strokes, dots and glows keep the
# original hue). Port of GraphView.tsx `laneText`. app.js applies this map to
# [data-lane-hue] elements when html.light; server render is dark, so unchanged.
LANE_TEXT_DARKER = {
    "#38bdf8": "#0369a1", "#a78bfa": "#6d28d9", "#f59e0b": "#b45309",
    "#22c55e": "#15803d", "#ec4899": "#be185d", "#06b6d4": "#0e7490",
    "#f97316": "#c2410c", "#8b5cf6": "#6d28d9", "#14b8a6": "#0f766e",
    "#e11d48": "#be123c", "#ef4444": "#dc2626",
}

# The ten lane hues assigned to institutions in draw order (GraphView LANE_COLORS).
LANE_COLORS = [
    "#38bdf8", "#a78bfa", "#f59e0b", "#22c55e", "#ec4899",
    "#06b6d4", "#f97316", "#8b5cf6", "#14b8a6", "#e11d48",
]


def display_banks(bank_names: list[str]) -> list[dict]:
    """The lane legend GraphView derives from the graph's bankNames: a stable
    id, the name, a 3-letter code (initials of the words) and a lane colour."""
    out = []
    for i, name in enumerate(bank_names):
        code = "".join(w[0] for w in name.split(" ") if w)[:3].upper()
        out.append(
            {
                "id": f"dyn-{i}",
                "name": name,
                "code": code or "?",
                "color": LANE_COLORS[i % len(LANE_COLORS)],
            }
        )
    return out


# ── Node dossier (was NodeDetailDrawer.tsx) ─────────────────────────────────────
# The whole per-account analysis the drawer showed, kept in Python so the maths
# (flow split, typologies, risk bars, the plain-English read) stays next to the
# formatters it already depends on, rather than being re-implemented in JS. The
# /graph/node/{id} route renders _node_drawer.html from this; app.js only fetches
# and shows it.
_BANK_TINTS = ["#38bdf8", "#a78bfa", "#f59e0b", "#22c55e", "#ec4899", "#06b6d4", "#f97316", "#14b8a6"]

_TYPOLOGY_CODES = {
    "layering": "AML-TYP-04",
    "structuring": "AML-TYP-02",
    "mule": "AML-TYP-07",
    "offshore": "AML-TYP-09",
    "shell": "AML-TYP-11",
    "roundtrip": "AML-TYP-05",
}

_PATTERN_LINE = {
    "layering": "Money lands here and is pushed straight on again, a little smaller each hop, so the trail back to its source goes cold.",
    "mule": "This account collects lots of small deposits from people with no connection to each other, then pays them out as one lump.",
    "structuring": "One large sum was broken into several payments, each kept just under the ₹10 lakh amount a bank has to report.",
    "shell": "Companies with no visible trade are paying money in, and the balance leaves again straight away.",
    "offshore": "Money is gathered here from within the country and then wired out to accounts abroad.",
    "roundtrip": "Money goes out and comes back through connected accounts, so it ends up looking like it was earned.",
}

_SEVERITY_LINE = {
    "high": "The size and spread of this activity sit well outside normal use, though the payment notes don't name a known scheme.",
    "medium": "Bigger than everyday retail activity, but the counterparties are steady and nothing is being passed along a chain.",
    "safe": "Ordinary activity — few counterparties and amounts in line with normal day-to-day use.",
}


def _bank_tint(name: str) -> str:
    h = 0
    for ch in name:
        h = (h * 31 + ord(ch)) % 9973
    return _BANK_TINTS[h % len(_BANK_TINTS)]


def _clamp(v: float, lo: int = 0, hi: int = 98) -> int:
    return max(lo, min(hi, _js_round(v)))


def _role_of(in_count: int, out_count: int) -> str:
    if in_count and out_count:
        return "Pass-through"
    if out_count:
        return "Originator"
    if in_count:
        return "Beneficiary"
    return "Isolated"


def _typology_code(key: str) -> str:
    return _TYPOLOGY_CODES.get(key, "AML-TYP-00")


def _confidence_pct(high_share: float, in_count: int, tagged: bool) -> int:
    base = 0.82 if tagged else 0.61
    v = min(0.97, base + high_share * 0.12 + min(0.04, in_count * 0.01))
    return _js_round(v * 100)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _short_id(other_id: str) -> str:
    if len(other_id) > 12:
        return f"{other_id[:6]}…{other_id[-4:]}"
    return other_id


def _edge_amount_label(currency: str, amount: float) -> str:
    if currency == "INR":
        return formatINR(amount)
    from .domain import format_en_in

    return f"{format_en_in(amount)} {currency}"


def node_dossier(node, edges: list, existing=None) -> dict:
    """Everything NodeDetailDrawer.tsx computed for one node, as a plain dict the
    _node_drawer.html partial iterates. `existing` is the SARReport already on
    file for this account (or None)."""
    related = [e for e in edges if e.source == node.id or e.target == node.id]

    # Flow split (in = money arriving at this node, out = leaving it).
    in_count = out_count = 0
    in_amount = out_amount = 0.0
    highs = 0
    per_day: dict[str, int] = {}
    for e in related:
        if e.target == node.id:
            in_count += 1
            in_amount += e.amount
        else:
            out_count += 1
            out_amount += e.amount
        if e.severity == "high":
            highs += 1
        per_day[e.timestamp] = per_day.get(e.timestamp, 0) + 1
    burst = max(per_day.values()) if related else 0
    high_share = (highs / len(related)) if related else 0.0

    # Typologies this account is involved in, from its own transfers' notes.
    tally: dict[str, dict] = {}
    for e in related:
        p = detectPattern(e.note)
        if not p:
            continue
        cur = tally.get(p.key)
        if cur:
            cur["count"] += 1
            cur["amount"] += e.amount
        else:
            tally[p.key] = {"key": p.key, "label": p.label, "color": p.color, "count": 1, "amount": e.amount}
    patterns = sorted(tally.values(), key=lambda p: (-p["count"], -p["amount"]))
    for p in patterns:
        p["code"] = _typology_code(p["key"])
    dominant = patterns[0] if patterns else None

    # Institutions that actually settled this account's transfers.
    seen: set[str] = set()
    connected_banks: list[dict] = []
    for e in related:
        other = e.target if e.source == node.id else e.source
        name = (e.bank or "").strip() or bankForAccount(other).name
        if name not in seen:
            seen.add(name)
            connected_banks.append({"name": name, "color": _bank_tint(name)})

    # Risk bars, derived from this account's own traffic.
    sev_floor = 26 if node.severity == "high" else 14 if node.severity == "medium" else 4
    dom_key = dominant["key"] if dominant else None
    signals = {
        "velocity": _clamp(sev_floor + burst * 16 + (22 if dom_key == "layering" else 0)),
        "fanOut": _clamp(8 + max(in_count, out_count) * 17),
        "counterparty": _clamp(_js_round(high_share * 88) + len(connected_banks) * 4),
        "spread": _clamp(len(connected_banks) * 24),
    }

    # Plain-English read: one sentence + up to three short facts.
    line = (_PATTERN_LINE.get(dom_key) if dom_key else None) or _SEVERITY_LINE[node.severity]
    facts: list[str] = []
    if in_count and out_count:
        facts.append(f"Took in {formatINR(in_amount)}, sent on {formatINR(out_amount)} — it does not hold the money.")
    elif out_count:
        facts.append(f"Sent {formatINR(out_amount)} to {_plural(out_count, 'account')}.")
    elif in_count:
        facts.append(f"Received {formatINR(in_amount)} from {_plural(in_count, 'account')}.")
    if burst > 1:
        facts.append(f"{burst} of those transfers happened on a single day.")
    if len(connected_banks) > 1:
        facts.append(f"Spread over {len(connected_banks)} different banks.")
    read = {"line": line, "facts": facts[:3]}

    # Timeline: first six events by timestamp.
    ordered = sorted(related, key=lambda e: e.timestamp)
    timeline = []
    for e in ordered[:6]:
        other = e.target if e.source == node.id else e.source
        timeline.append(
            {
                "id": e.id,
                "timestamp": e.timestamp,
                "dir": "out" if e.source == node.id else "in",
                "severity": e.severity,
                "amount_label": _edge_amount_label(e.currency, e.amount),
                "other_label": _short_id(other),
                "note": e.note,
            }
        )
    timeline_more = max(0, len(related) - 6)

    return {
        "node": node,
        "related_count": len(related),
        "patterns": patterns,
        "dominant": dominant,
        "flow": {
            "inCount": in_count,
            "outCount": out_count,
            "inAmount": in_amount,
            "outAmount": out_amount,
            "role": _role_of(in_count, out_count),
        },
        "connected_banks": connected_banks,
        "signals": signals,
        "read": read,
        "confidence": _confidence_pct(high_share, in_count, bool(dominant)),
        "timeline": timeline,
        "timeline_more": timeline_more,
        "escalate_amount": in_amount + out_amount,
        "escalate_title": f"{dominant['label'] if dominant else 'Suspicious activity'} — {node.label}",
        "existing": existing,
    }


# ── Upload history (was UploadHistory.tsx) ─────────────────────────────────────
# The SPA grouped past imports by day, let you replay one file or a whole day,
# and computed live buildEvidence analytics over that selection's still-present
# rows (falling back to the snapshot written at import time when the rows were
# cleared). Here every selectable panel is pre-computed server-side; app.js only
# toggles which one is visible when a rail entry is clicked (no reload).
def _upload_day_key(ts_ms: int) -> str:
    d = datetime.fromtimestamp((ts_ms or 0) / 1000)
    return f"{d.year:04d}-{d.month:02d}-{d.day:02d}"


def _upload_day_label(key: str) -> str:
    from datetime import date, timedelta

    today = date.today()
    if key == f"{today.year:04d}-{today.month:02d}-{today.day:02d}":
        return "Today"
    y = today - timedelta(days=1)
    if key == f"{y.year:04d}-{y.month:02d}-{y.day:02d}":
        return "Yesterday"
    parts = key.split("-")
    try:
        dt = date(int(parts[0]), int(parts[1]), int(parts[2]))
    except (ValueError, IndexError):
        return key
    # en-IN {weekday:'short', day:'numeric', month:'short', year:'numeric'}.
    return dt.strftime("%a, ") + str(dt.day) + dt.strftime(" %b %Y")


def _upload_clock_label(ts_ms: int) -> str:
    # en-IN {hour:'numeric', minute:'2-digit'} → e.g. "3:05 PM" (hour not padded).
    d = datetime.fromtimestamp((ts_ms or 0) / 1000)
    h = d.strftime("%I").lstrip("0") or "12"
    return f"{h}:{d.strftime('%M %p')}"


def upload_history(uploads: list[dict], transactions: list[Transaction]) -> dict:
    """The whole History tab, pre-computed. Returns day groups for the left rail
    and one detail panel per selectable key (`up:<id>` for a file, `day:<key>`
    for a whole day), each carrying either live evidence or the import snapshot."""
    from .investigation import buildEvidence

    # Day groups, newest-first (uploads already arrive newest-first).
    day_order: list[str] = []
    day_map: dict[str, list[dict]] = {}
    for u in uploads:
        k = _upload_day_key(u["createdAt"])
        if k not in day_map:
            day_map[k] = []
            day_order.append(k)
        day_map[k].append(u)

    days = [
        {
            "key": k,
            "label": _upload_day_label(k),
            "rowCount": sum((u.get("rowCount") or 0) for u in day_map[k]),
            "uploads": [
                {
                    "u": u,
                    "clock": _upload_clock_label(u["createdAt"]),
                    "sel": f"up:{u['id']}",
                }
                for u in day_map[k]
            ],
        }
        for k in day_order
    ]

    def _panel(sel: str, kind: str, ids: list[str], records: list[dict]) -> dict:
        scoped = [t for t in transactions if t.uploadId and t.uploadId in ids]
        ev = buildEvidence(scoped) if scoped else None
        if kind == "upload":
            rec = records[0]
            heading = rec["fileName"]
            sub = f"Imported {_upload_clock_label(rec['createdAt'])} · {_upload_day_label(_upload_day_key(rec['createdAt']))}"
            badge = "Single file"
        else:
            heading = _upload_day_label(sel.split(":", 1)[1])
            n = len(records)
            sub = f"{n} import{'' if n == 1 else 's'} on this day"
            badge = "Whole day"
        return {
            "sel": sel,
            "kind": kind,
            "heading": heading,
            "subheading": sub,
            "badge": badge,
            "records": records,
            "evidence": ev,
            "snapshot": _upload_snapshot(records) if ev is None else None,
        }

    panels: list[dict] = []
    for u in uploads:
        panels.append(_panel(f"up:{u['id']}", "upload", [u["id"]], [u]))
    for k in day_order:
        recs = day_map[k]
        panels.append(_panel(f"day:{k}", "day", [u["id"] for u in recs], recs))

    return {
        "total": len(uploads),
        "days": days,
        "panels": panels,
        "default_sel": f"up:{uploads[0]['id']}" if uploads else "",
    }


def _upload_snapshot(records: list[dict]) -> dict:
    """The SnapshotOnly fallback figures — summed from the records written at
    import time, shown when the underlying rows are no longer in the account."""
    row_count = sum((u.get("rowCount") or 0) for u in records)
    high_risk = sum((u.get("highRiskCount") or 0) for u in records)
    total = sum((u.get("totalAmount") or 0) for u in records)
    flagged = sum((u.get("flaggedAmount") or 0) for u in records)
    accounts = max([0] + [(u.get("accountCount") or 0) for u in records])
    seen: dict[str, None] = {}
    for u in records:
        for b in (u.get("banks") or []):
            seen[b] = None
    banks = list(seen.keys())
    dates = sorted([d for u in records for d in (u.get("dateFrom"), u.get("dateTo")) if d])
    return {
        "rowCount": row_count,
        "highRisk": high_risk,
        "total": total,
        "flagged": flagged,
        "accounts": accounts,
        "banks": banks,
        "dates": dates,
    }
