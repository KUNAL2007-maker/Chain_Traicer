"""FastAPI application — the Python port of the Next.js app router.

The Next.js SPA became a small multi-page app: one GET route per view, all
sharing base.html, plus a handful of POST routes for the mutations that were
Firestore writes (upload, clear, SAR create/status/delete) and one JSON endpoint
for the chat, the sole client-side fetch left in the app.

Session model, matching the original's requirements:
  * the signed-in uid lives in a Starlette session cookie with max_age=None, so
    it is a browser-session cookie — closing the browser ends the session and a
    fresh load lands on /login (req #4, no silent resume);
  * sign-up never logs the user in; it redirects to /login with a notice (req #3).
"""
from __future__ import annotations

import os

from fastapi import FastAPI, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from . import auth, chat, db, webutil
from .domain import (
    AGENT_META,
    CHAT_AGENTS,
    SUGGESTED_QUERIES,
    TYPOLOGIES,
    bankForAccount,
    detectPattern,
    format_en_in,
    formatINR,
    nodeRadius,
    severityColor,
    shortAccountLabel,
    buildGraphFromTransactions,
)
from .investigation import buildEvidence, sarNarrative

try:  # load .env.local / .env if python-dotenv is present (dev convenience)
    from dotenv import load_dotenv

    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for name in (".env.local", ".env"):
        p = os.path.join(ROOT, name)
        if os.path.exists(p):
            load_dotenv(p, override=False)
except Exception:
    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_APP_DIR = os.path.dirname(os.path.abspath(__file__))
_STATIC_DIR = os.path.join(ROOT, "static")
_TEMPLATES_DIR = os.path.join(ROOT, "templates")
_SAMPLES_DIR = os.path.join(ROOT, "samples")

app = FastAPI(title="FinGuard Intelligence")

# A random secret is fine: the session is not meant to survive a restart, and a
# rotated key simply signs everyone out — the same outcome req #4 already wants.
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ.get("SESSION_SECRET") or os.urandom(32).hex(),
    max_age=None,  # browser-session cookie
    same_site="lax",
    https_only=False,
)

app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")
if os.path.isdir(_SAMPLES_DIR):
    app.mount("/samples", StaticFiles(directory=_SAMPLES_DIR), name="samples")

templates = Jinja2Templates(directory=_TEMPLATES_DIR)

# ── Jinja globals: the helpers the templates call by name ───────────────────────
templates.env.globals.update(
    {
        # domain formatters / helpers
        "formatINR": formatINR,
        "format_en_in": format_en_in,
        "severityColor": severityColor,
        "shortAccountLabel": shortAccountLabel,
        "nodeRadius": nodeRadius,
        "bankForAccount": bankForAccount,
        "detectPattern": detectPattern,
        # webutil presentation helpers
        "tx_amount": webutil.tx_amount,
        "initials": webutil.initials,
        "sparkline": webutil.sparkline,
        "fmt_alert_date": webutil.fmt_alert_date,
        "fmt_alert_time": webutil.fmt_alert_time,
        "curve_path": webutil.curve_path,
        "node_fill": webutil.node_fill,
        "node_stroke": webutil.node_stroke,
        "label_of": webutil.label_of,
        "display_banks": webutil.display_banks,
        # constants
        "NAV": webutil.NAV,
        "VIEW_TITLES": webutil.VIEW_TITLES,
        "PAGE_GUTTER": webutil.PAGE_GUTTER,
        "WIDTHS": webutil.WIDTHS,
        "FLEET": webutil.FLEET,
        "SIGNAL_SCORES": webutil.SIGNAL_SCORES,
        "AGENT_META": AGENT_META,
        "CHAT_AGENTS": list(CHAT_AGENTS),
        "SUGGESTED_QUERIES": SUGGESTED_QUERIES,
        "TYPOLOGIES": TYPOLOGIES,
        # python builtins used in templates
        "len": len,
        "enumerate": enumerate,
        "min": min,
        "max": max,
        "abs": abs,
        "round": round,
        "sorted": sorted,
    }
)


# ── Auth plumbing ──────────────────────────────────────────────────────────────
def _current_uid(request: Request):
    return request.session.get("uid")


def _current_user(request: Request):
    uid = _current_uid(request)
    if not uid:
        return None
    return auth.app_user(uid)


def _require_user(request: Request):
    """Returns (user, None) when signed in, or (None, RedirectResponse) when not."""
    user = _current_user(request)
    if user is None:
        # An orphaned cookie (user deleted) is cleared so the login page is clean.
        request.session.pop("uid", None)
        return None, RedirectResponse("/login", status_code=303)
    return user, None


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    return request.client.host if request.client else "local"


def _shell_ctx(request: Request, user: dict, active: str) -> dict:
    """The variables base.html needs for every authenticated page."""
    return {
        "request": request,
        "user": user,
        "active": active,
        "titles": webutil.VIEW_TITLES[active],
    }


# ── Auth routes ────────────────────────────────────────────────────────────────
@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if _current_user(request) is not None:
        return RedirectResponse("/", status_code=303)
    info = request.query_params.get("info")
    return templates.TemplateResponse(
        request,
        "login.html",
        {"request": request, "mode": "login", "error": None, "info": info, "email": "", "fullName": ""},
    )


@app.post("/login", response_class=HTMLResponse)
def login_submit(
    request: Request,
    email: str = Form(""),
    password: str = Form(""),
):
    uid, error = auth.sign_in(email, password)
    if error:
        return templates.TemplateResponse(
            request,
            "login.html",
            {"request": request, "mode": "login", "error": error, "info": None, "email": email, "fullName": ""},
            status_code=400,
        )
    request.session["uid"] = uid
    return RedirectResponse("/", status_code=303)


@app.post("/signup", response_class=HTMLResponse)
def signup_submit(
    request: Request,
    email: str = Form(""),
    password: str = Form(""),
    fullName: str = Form(""),
):
    error = auth.sign_up(email, password, fullName)
    if error:
        return templates.TemplateResponse(
            request,
            "login.html",
            {"request": request, "mode": "signup", "error": error, "info": None, "email": email, "fullName": fullName},
            status_code=400,
        )
    # Success: do NOT log in — send them to sign in explicitly (req #3).
    return RedirectResponse(
        "/login?info=Account+created.+Please+sign+in+to+continue.", status_code=303
    )


@app.post("/logout")
def logout(request: Request):
    request.session.pop("uid", None)
    return RedirectResponse("/login", status_code=303)


# ── View routes ────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    user, redirect = _require_user(request)
    if redirect:
        return redirect
    uid = user["uid"]
    txs = db.list_transactions(uid)
    alerts = db.list_alerts(uid)
    stats = db.dashboard_stats(uid)
    ctx = _shell_ctx(request, user, "dashboard")
    ctx.update(
        {
            "txs": txs,
            "alerts": alerts,
            "alert_groups": webutil.group_alerts_by_date(alerts),
            "stats": stats,
            "heatmap": webutil.build_heatmap(txs),
            "typology": webutil.build_typology(txs),
            "spark1": webutil.sparkline(webutil.SPARK1, "#38bdf8", 110, 40),
            "spark2": webutil.sparkline(webutil.SPARK2, "#22c55e", 110, 40),
            "spark3": webutil.sparkline(webutil.SPARK3, "#ef4444", 110, 40),
            "spark4": webutil.sparkline(webutil.SPARK4, "#a78bfa", 110, 40),
        }
    )
    return templates.TemplateResponse(request, "dashboard.html", ctx)


@app.get("/transactions", response_class=HTMLResponse)
def transactions(request: Request):
    user, redirect = _require_user(request)
    if redirect:
        return redirect
    txs = db.list_transactions(user["uid"])
    ctx = _shell_ctx(request, user, "transactions")
    ctx["txs"] = txs
    return templates.TemplateResponse(request, "transactions.html", ctx)


@app.get("/graph", response_class=HTMLResponse)
def graph(request: Request):
    user, redirect = _require_user(request)
    if redirect:
        return redirect
    txs = db.list_transactions(user["uid"])
    g = buildGraphFromTransactions(txs, webutil.GRAPH_W)
    # A node lookup so edges can resolve their endpoints' positions in the template.
    node_index = {n.id: n for n in g["nodes"]}
    focus = request.query_params.get("focus", "")
    focus_ids = [a for a in focus.split(",") if a] if focus else []
    ctx = _shell_ctx(request, user, "graph")
    ctx.update(
        {
            "graph": g,
            "node_index": node_index,
            "graph_w": webutil.GRAPH_W,
            "focus_ids": focus_ids,
        }
    )
    return templates.TemplateResponse(request, "graph.html", ctx)


@app.get("/graph/node/{node_id}", response_class=HTMLResponse)
def graph_node(request: Request, node_id: str):
    """The NodeDetailDrawer, as a server-rendered partial. app.js fetches this on
    node click and drops it into the drawer aside. Returns 404 markup if the node
    is not on the current graph (e.g. after the data changed under an open graph)."""
    user, redirect = _require_user(request)
    if redirect:
        return redirect
    uid = user["uid"]
    txs = db.list_transactions(uid)
    g = buildGraphFromTransactions(txs, webutil.GRAPH_W)
    node = next((n for n in g["nodes"] if n.id == node_id), None)
    if node is None:
        return HTMLResponse(
            '<div class="p-6 text-[13px]" style="color: var(--muted)">This account is no longer on the graph.</div>',
            status_code=404,
        )
    existing = next(
        (r for r in db.list_sar_reports(uid) if r.account == node_id), None
    )
    dossier = webutil.node_dossier(node, g["edges"], existing)
    return templates.TemplateResponse(
        request, "_node_drawer.html", {"request": request, "d": dossier}
    )


@app.get("/upload", response_class=HTMLResponse)
def upload(request: Request):
    user, redirect = _require_user(request)
    if redirect:
        return redirect
    uid = user["uid"]
    tab = request.query_params.get("tab", "import")
    ctx = _shell_ctx(request, user, "upload")
    uploads = db.list_uploads(uid)
    txs = db.list_transactions(uid)
    ctx.update(
        {
            "tab": tab,
            "ok": request.query_params.get("ok"),
            "error": request.query_params.get("error"),
            "added": request.query_params.get("added"),
            "high": request.query_params.get("high"),
            "uploads": uploads,
            "txs": txs,
            "history": webutil.upload_history(uploads, txs) if tab == "history" else None,
            # Suspect wallet addresses extracted from imported data — the Upload
            # tab converts these into the input for the on-chain trace engine.
            "wallets": webutil.detect_wallet_addresses(txs),
        }
    )
    return templates.TemplateResponse(request, "upload.html", ctx)


@app.get("/chat", response_class=HTMLResponse)
def chat_page(request: Request):
    user, redirect = _require_user(request)
    if redirect:
        return redirect
    ctx = _shell_ctx(request, user, "chat")
    return templates.TemplateResponse(request, "chat.html", ctx)


@app.get("/sar", response_class=HTMLResponse)
def sar_page(request: Request):
    user, redirect = _require_user(request)
    if redirect:
        return redirect
    uid = user["uid"]
    reports = db.list_sar_reports(uid)
    txs = db.list_transactions(uid)

    sel_id = request.query_params.get("selected")
    selected = None
    if sel_id:
        selected = next((r for r in reports if r.id == sel_id), None)
    if selected is None and reports:
        selected = reports[0]

    ring = None
    scoped = txs
    if selected and selected.account:
        ring = webutil.ring_of(txs, selected.account)
        scoped = ring if ring else txs

    narrative = sarNarrative(buildEvidence(scoped), scoped)
    high_risk = [t for t in scoped if t.severity == "high"]
    scoped_accounts = len({a for t in scoped for a in (t.fromAccount, t.toAccount)})
    ref_no = f"FG/STR/{selected.id[:8].upper()}" if selected else ""

    ctx = _shell_ctx(request, user, "sar")
    ctx.update(
        {
            "reports": reports,
            "txs": txs,
            "selected": selected,
            "narrative": narrative,
            "high_risk": high_risk,
            "ring": ring,
            "scoped_accounts": scoped_accounts,
            "scoped_count": len(scoped),
            "ref_no": ref_no,
            "notice": request.query_params.get("notice"),
        }
    )
    return templates.TemplateResponse(request, "sar.html", ctx)


# ── Chat API ───────────────────────────────────────────────────────────────────
@app.post("/api/chat")
async def api_chat(request: Request):
    uid = _current_uid(request)
    if not uid:
        return JSONResponse({"error": "Not signed in"}, status_code=401)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    message = payload.get("message", "")
    history = payload.get("history")
    forced_mode = payload.get("mode")
    txs = db.list_transactions(uid)

    body, status, headers = await chat.run_chat(
        message=message,
        history=history,
        txs=txs,
        forced_mode=forced_mode,
        uid=uid,
        client_ip=_client_ip(request),
    )
    return JSONResponse(body, status_code=status, headers=headers)


@app.post("/api/crypto-trace")
async def api_crypto_trace(request: Request):
    """On-chain wallet forensic trace (Hafiz's COREALGORITHM, vendored under
    app/forensic/). Returns the engine's verdict + full court dossier as JSON.
    The work is blocking HTTP against Alchemy/Mempool, so it runs in a threadpool
    to keep the event loop free. This endpoint returns data only — no graph is
    rendered here."""
    uid = _current_uid(request)
    if not uid:
        return JSONResponse({"error": "Not signed in"}, status_code=401)
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    from starlette.concurrency import run_in_threadpool

    from .crypto_trace import run_trace

    result = await run_in_threadpool(
        run_trace,
        address=payload.get("address", ""),
        network=payload.get("network", "eth-mainnet"),
        max_depth=payload.get("max_depth", 4),
        crime_timestamp=payload.get("crime_timestamp"),
        pre_crime_balance=payload.get("pre_crime_balance", 0.0),
    )
    if result.get("success"):
        status = 200
    elif result.get("needs_config"):
        status = 503  # engine unconfigured (no ALCHEMY_API_KEY)
    elif result.get("error") == "Target wallet address is required.":
        status = 400
    else:
        status = 502  # upstream / on-chain failure
    return JSONResponse(result, status_code=status)


# ── Mutations (Firestore writes → SQLite, all PRG) ─────────────────────────────
@app.post("/upload")
async def do_upload(request: Request, file: UploadFile = None):
    uid = _current_uid(request)
    if not uid:
        return RedirectResponse("/login", status_code=303)
    if file is None:
        return RedirectResponse("/upload?error=No+file+selected.", status_code=303)
    raw = await file.read()
    text = raw.decode("utf-8-sig", "replace")
    try:
        rows, _warnings = webutil.parse_csv(text)
    except webutil.CSVError as e:
        from urllib.parse import quote_plus

        return RedirectResponse(f"/upload?error={quote_plus(str(e))}", status_code=303)
    if not rows:
        return RedirectResponse("/upload?error=No+valid+rows+found+in+the+file.", status_code=303)

    from .domain import classifyRisk

    high = sum(1 for r in rows if classifyRisk(r["amount"], r.get("note")) == "high")
    db.bulk_insert_transactions(uid, rows, file_name=file.filename or "upload.csv")
    return RedirectResponse(f"/upload?ok=1&added={len(rows)}&high={high}", status_code=303)


@app.post("/clear-all")
def do_clear_all(request: Request):
    uid = _current_uid(request)
    if not uid:
        return RedirectResponse("/login", status_code=303)
    db.clear_all_data(uid)
    return RedirectResponse("/upload", status_code=303)


@app.post("/upload/delete")
def do_delete_upload(request: Request, upload_id: str = Form(...)):
    uid = _current_uid(request)
    if not uid:
        return RedirectResponse("/login", status_code=303)
    db.delete_upload(uid, upload_id)
    return RedirectResponse("/upload?tab=history", status_code=303)


@app.post("/transactions/delete")
def do_delete_tx(request: Request, id: str = Form(...)):
    uid = _current_uid(request)
    if not uid:
        return RedirectResponse("/login", status_code=303)
    db.delete_transaction(uid, id)
    return RedirectResponse("/transactions", status_code=303)


@app.post("/sar/create")
def do_create_sar(request: Request, account: str = Form("")):
    uid = _current_uid(request)
    if not uid:
        return RedirectResponse("/login", status_code=303)
    txs = db.list_transactions(uid)
    if not txs:
        return RedirectResponse("/sar", status_code=303)

    account = (account or "").strip()
    if account:
        scoped = webutil.ring_of(txs, account) or txs
        narrative = sarNarrative(buildEvidence(scoped), scoped)
        source_key = f"acct:{account}:{len(scoped)}:{narrative.flaggedCount}:{narrative.flaggedValue}"
    else:
        scoped = txs
        narrative = sarNarrative(buildEvidence(scoped), scoped)
        source_key = f"all:{len(txs)}:{narrative.flaggedCount}:{narrative.flaggedValue}"

    reports = db.list_sar_reports(uid)
    twin = next((r for r in reports if r.sourceKey == source_key), None)
    if twin:
        return RedirectResponse(
            f"/sar?selected={twin.id}&notice=You+already+have+a+report+for+this+data.",
            status_code=303,
        )

    severity = (
        "high"
        if any(g.severity == "high" for g in narrative.grounds)
        else "medium"
        if narrative.grounds
        else "safe"
    )
    report = {
        "title": narrative.headline,
        "amount": narrative.flaggedValue,
        "status": "Draft",
        "sourceKey": source_key,
        "severity": severity,
    }
    if account:
        report["account"] = account
    sid = db.create_sar(uid, report)
    return RedirectResponse(f"/sar?selected={sid}", status_code=303)


@app.post("/sar/status")
def do_sar_status(request: Request, id: str = Form(...), status: str = Form(...)):
    uid = _current_uid(request)
    if not uid:
        return RedirectResponse("/login", status_code=303)
    db.update_sar_status(uid, id, status)
    return RedirectResponse(f"/sar?selected={id}", status_code=303)


@app.post("/sar/delete")
def do_sar_delete(request: Request, id: str = Form(...)):
    uid = _current_uid(request)
    if not uid:
        return RedirectResponse("/login", status_code=303)
    db.delete_sar(uid, id)
    return RedirectResponse("/sar", status_code=303)


@app.post("/sar/clear")
def do_sar_clear(request: Request):
    uid = _current_uid(request)
    if not uid:
        return RedirectResponse("/login", status_code=303)
    db.clear_sar_reports(uid)
    return RedirectResponse("/sar", status_code=303)


@app.get("/healthz")
def healthz():
    return Response("ok", media_type="text/plain")
