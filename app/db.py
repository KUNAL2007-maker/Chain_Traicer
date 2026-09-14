"""SQLite persistence — the Python port of src/lib/hooks.ts.

Firestore stored each user's data under users/{uid}/{collection}; here every row
carries a `uid` column instead, and a per-collection table holds them all. The
document-shaped behaviour the views depend on is reproduced exactly:

  * ids are minted before the rows that reference them are written, so a bulk
    import can stamp every transaction with its upload's id before that upload
    record exists (see bulk_insert_transactions);
  * `createdAt` is a millisecond epoch and every list is returned newest-first,
    the Python equivalent of orderBy("createdAt", "desc");
  * within one 400-row import chunk all rows share a single createdAt
    (`now + chunk_index`), byte-for-byte with the original.

Column names match the dataclass field names in domain.py (camelCase, plus the
one snake_case `time_label` on Alert) so a sqlite3.Row maps straight onto a
Transaction / Alert / SARReport with no renaming.
"""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
import threading
import time
from typing import Optional

from .domain import Alert, SARReport, Transaction, classifyRisk, format_en_in


# ── Connection ───────────────────────────────────────────────────────────────
def _db_path() -> str:
    override = os.environ.get("FINGUARD_DB")
    if override:
        return override
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(root, "finguard.db")


DB_PATH = _db_path()

# check_same_thread=False because FastAPI may run a sync path operation in its
# threadpool; every access is serialised by _LOCK so the single connection is
# never touched concurrently. RLock so a function that already holds it can call
# another locked helper without deadlocking.
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_LOCK = threading.RLock()


def _now_ms() -> int:
    """Date.now() — integer milliseconds since the epoch."""
    return int(time.time() * 1000)


# Firestore auto-ids are 20 chars of [A-Za-z0-9]; matching the shape keeps
# things like refNo = `FG/STR/${id.slice(0,8).toUpperCase()}` reading right.
_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"


def _gen_id(n: int = 20) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(n))


def init_db() -> None:
    with _LOCK:
        _conn.executescript(
            """
            PRAGMA journal_mode=WAL;

            CREATE TABLE IF NOT EXISTS users (
                uid          TEXT PRIMARY KEY,
                email        TEXT UNIQUE,
                fullName     TEXT,
                passwordHash TEXT,
                passwordSalt TEXT,
                createdAt    INTEGER
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id          TEXT PRIMARY KEY,
                uid         TEXT NOT NULL,
                date        TEXT,
                fromAccount TEXT,
                toAccount   TEXT,
                bank        TEXT,
                amount      REAL,
                currency    TEXT,
                type        TEXT,
                note        TEXT,
                severity    TEXT,
                uploadId    TEXT,
                createdAt   INTEGER
            );
            CREATE INDEX IF NOT EXISTS ix_tx_uid_created ON transactions(uid, createdAt DESC);
            CREATE INDEX IF NOT EXISTS ix_tx_uid_upload  ON transactions(uid, uploadId);

            CREATE TABLE IF NOT EXISTS alerts (
                id         TEXT PRIMARY KEY,
                uid        TEXT NOT NULL,
                title      TEXT,
                detail     TEXT,
                severity   TEXT,
                amount     REAL,
                time_label TEXT,
                createdAt  INTEGER
            );
            CREATE INDEX IF NOT EXISTS ix_al_uid_created ON alerts(uid, createdAt DESC);

            CREATE TABLE IF NOT EXISTS sar_reports (
                id        TEXT PRIMARY KEY,
                uid       TEXT NOT NULL,
                title     TEXT,
                amount    REAL,
                status    TEXT,
                severity  TEXT,
                account   TEXT,
                sourceKey TEXT,
                updatedAt INTEGER,
                createdAt INTEGER
            );
            CREATE INDEX IF NOT EXISTS ix_sar_uid_created ON sar_reports(uid, createdAt DESC);

            CREATE TABLE IF NOT EXISTS uploads (
                id              TEXT PRIMARY KEY,
                uid             TEXT NOT NULL,
                fileName        TEXT,
                rowCount        INTEGER,
                highRiskCount   INTEGER,
                mediumRiskCount INTEGER,
                totalAmount     REAL,
                flaggedAmount   REAL,
                accountCount    INTEGER,
                banks           TEXT,
                dateFrom        TEXT,
                dateTo          TEXT,
                createdAt       INTEGER
            );
            CREATE INDEX IF NOT EXISTS ix_up_uid_created ON uploads(uid, createdAt DESC);
            """
        )
        _conn.commit()


# ── Row → dataclass mappers ──────────────────────────────────────────────────
# createdAt DESC is the Firestore order; rowid DESC is the tiebreak within one
# import chunk (all such rows share a createdAt), so the newest insert leads.
def _tx(r: sqlite3.Row) -> Transaction:
    return Transaction(
        id=r["id"],
        date=r["date"],
        fromAccount=r["fromAccount"],
        toAccount=r["toAccount"],
        bank=r["bank"],
        amount=r["amount"],
        currency=r["currency"],
        type=r["type"],
        severity=r["severity"],
        note=r["note"],
        createdAt=r["createdAt"],
        uploadId=r["uploadId"],
    )


def _alert(r: sqlite3.Row) -> Alert:
    return Alert(
        id=r["id"],
        title=r["title"],
        detail=r["detail"],
        severity=r["severity"],
        amount=r["amount"],
        time_label=r["time_label"],
        createdAt=r["createdAt"],
    )


def _sar(r: sqlite3.Row) -> SARReport:
    return SARReport(
        id=r["id"],
        title=r["title"],
        amount=r["amount"],
        status=r["status"],
        severity=r["severity"],
        account=r["account"],
        sourceKey=r["sourceKey"],
        updatedAt=r["updatedAt"],
        createdAt=r["createdAt"],
    )


def _upload(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "fileName": r["fileName"],
        "rowCount": r["rowCount"],
        "highRiskCount": r["highRiskCount"],
        "mediumRiskCount": r["mediumRiskCount"],
        "totalAmount": r["totalAmount"],
        "flaggedAmount": r["flaggedAmount"],
        "accountCount": r["accountCount"],
        "banks": json.loads(r["banks"]) if r["banks"] else [],
        "dateFrom": r["dateFrom"],
        "dateTo": r["dateTo"],
        "createdAt": r["createdAt"],
    }


# ── Reads (newest-first) ─────────────────────────────────────────────────────
def list_transactions(uid: str) -> list[Transaction]:
    with _LOCK:
        rows = _conn.execute(
            "SELECT * FROM transactions WHERE uid=? ORDER BY createdAt DESC, rowid DESC",
            (uid,),
        ).fetchall()
    return [_tx(r) for r in rows]


def list_alerts(uid: str) -> list[Alert]:
    with _LOCK:
        rows = _conn.execute(
            "SELECT * FROM alerts WHERE uid=? ORDER BY createdAt DESC, rowid DESC",
            (uid,),
        ).fetchall()
    return [_alert(r) for r in rows]


def list_sar_reports(uid: str) -> list[SARReport]:
    with _LOCK:
        rows = _conn.execute(
            "SELECT * FROM sar_reports WHERE uid=? ORDER BY createdAt DESC, rowid DESC",
            (uid,),
        ).fetchall()
    return [_sar(r) for r in rows]


def list_uploads(uid: str) -> list[dict]:
    with _LOCK:
        rows = _conn.execute(
            "SELECT * FROM uploads WHERE uid=? ORDER BY createdAt DESC, rowid DESC",
            (uid,),
        ).fetchall()
    return [_upload(r) for r in rows]


# ── SAR reports ──────────────────────────────────────────────────────────────
def update_sar_status(uid: str, id: str, status: str) -> None:
    with _LOCK:
        _conn.execute(
            "UPDATE sar_reports SET status=?, updatedAt=? WHERE uid=? AND id=?",
            (status, _now_ms(), uid, id),
        )
        _conn.commit()


def create_sar(uid: str, report: dict) -> str:
    """Insert one report, returning its id. Mirrors createSAR: keys whose value
    is None are dropped (the withoutUndefined guard), createdAt == updatedAt."""
    now = _now_ms()
    sid = _gen_id()
    r = {k: v for k, v in report.items() if v is not None}
    with _LOCK:
        _conn.execute(
            "INSERT INTO sar_reports"
            " (id, uid, title, amount, status, severity, account, sourceKey, updatedAt, createdAt)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                sid,
                uid,
                r.get("title"),
                r.get("amount"),
                r.get("status"),
                r.get("severity"),
                r.get("account"),
                r.get("sourceKey"),
                now,
                now,
            ),
        )
        _conn.commit()
    return sid


def clear_sar_reports(uid: str) -> int:
    with _LOCK:
        n = _conn.execute(
            "SELECT COUNT(*) AS c FROM sar_reports WHERE uid=?", (uid,)
        ).fetchone()["c"]
        if not n:
            return 0
        _conn.execute("DELETE FROM sar_reports WHERE uid=?", (uid,))
        _conn.commit()
        return n


def delete_sar(uid: str, id: str) -> None:
    with _LOCK:
        _conn.execute("DELETE FROM sar_reports WHERE uid=? AND id=?", (uid, id))
        _conn.commit()


# ── Bulk import ──────────────────────────────────────────────────────────────
def bulk_insert_transactions(uid: str, rows: list[dict], file_name: Optional[str] = None) -> None:
    """Port of bulkInsertTransactions. `rows` are ParsedRow dicts:
    {date, fromAccount, toAccount, bank, amount, currency, type, note?}."""
    now = _now_ms()
    chunk_size = 400

    # Mint the upload id up front so every row can be stamped with it before the
    # upload record itself is written.
    upload_id = _gen_id()

    severities = [classifyRisk(r["amount"], r.get("note")) for r in rows]

    with _LOCK:
        for i in range(0, len(rows), chunk_size):
            sl = rows[i : i + chunk_size]
            for j, r in enumerate(sl):
                _conn.execute(
                    "INSERT INTO transactions"
                    " (id, uid, date, fromAccount, toAccount, bank, amount, currency, type, note, severity, uploadId, createdAt)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        _gen_id(),
                        uid,
                        r.get("date"),
                        r.get("fromAccount"),
                        r.get("toAccount"),
                        r.get("bank"),
                        r.get("amount"),
                        r.get("currency"),
                        r.get("type"),
                        r.get("note"),  # None → NULL, the withoutUndefined case
                        severities[i + j],
                        upload_id,
                        now + i,  # chunk-start index: a whole chunk shares one stamp
                    ),
                )

        high_risk = [r for r, s in zip(rows, severities) if s == "high"]
        medium_risk = [r for r, s in zip(rows, severities) if s == "medium"]
        total_amount = sum(r["amount"] for r in rows)

        accounts: set[str] = set()
        banks_od: dict[str, None] = {}  # ordered set → preserves first-seen order
        dates: list[str] = []
        for r in rows:
            accounts.add(r.get("fromAccount"))
            accounts.add(r.get("toAccount"))
            b = r.get("bank")
            if b:
                banks_od[b] = None
            d = r.get("date")
            if d:
                dates.append(d)
        dates.sort()

        _conn.execute(
            "INSERT INTO uploads"
            " (id, uid, fileName, rowCount, highRiskCount, mediumRiskCount, totalAmount, flaggedAmount, accountCount, banks, dateFrom, dateTo, createdAt)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                upload_id,
                uid,
                file_name if file_name is not None else "upload.csv",
                len(rows),
                len(high_risk),
                len(medium_risk),
                total_amount,
                sum(r["amount"] for r in high_risk),
                len(accounts),
                json.dumps(list(banks_od.keys())[:12]),
                dates[0] if dates else "",
                dates[-1] if dates else "",
                now,
            ),
        )

        if high_risk:
            high_amount = sum(r["amount"] for r in high_risk)
            _conn.execute(
                "INSERT INTO alerts (id, uid, title, detail, severity, amount, time_label, createdAt)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (
                    _gen_id(),
                    uid,
                    f"{len(high_risk)} high-risk transactions detected",
                    f"Amount total: {format_en_in(high_amount)} {high_risk[0]['currency']}. Review recommended.",
                    "high",
                    high_amount,
                    "just now",
                    now,
                ),
            )

        _conn.commit()


def clear_all_data(uid: str) -> None:
    with _LOCK:
        for name in ("transactions", "alerts", "sar_reports", "uploads"):
            _conn.execute(f"DELETE FROM {name} WHERE uid=?", (uid,))
        _conn.commit()


def delete_upload(uid: str, upload_id: str) -> int:
    """Remove one past import: the history row and every transaction stamped with
    it. Rows imported before uploads were stamped carry no uploadId and stay."""
    with _LOCK:
        n = _conn.execute(
            "SELECT COUNT(*) AS c FROM transactions WHERE uid=? AND uploadId=?",
            (uid, upload_id),
        ).fetchone()["c"]
        _conn.execute(
            "DELETE FROM transactions WHERE uid=? AND uploadId=?", (uid, upload_id)
        )
        _conn.execute("DELETE FROM uploads WHERE uid=? AND id=?", (uid, upload_id))
        _conn.commit()
        return n


def delete_transaction(uid: str, id: str) -> None:
    with _LOCK:
        _conn.execute("DELETE FROM transactions WHERE uid=? AND id=?", (uid, id))
        _conn.commit()


# ── Dashboard stats ──────────────────────────────────────────────────────────
def dashboard_stats(uid: str) -> dict:
    with _LOCK:
        total = _conn.execute(
            "SELECT COUNT(*) AS c FROM transactions WHERE uid=?", (uid,)
        ).fetchone()["c"]
        high = _conn.execute(
            "SELECT COUNT(*) AS c FROM transactions WHERE uid=? AND severity='high'",
            (uid,),
        ).fetchone()["c"]
        flagged = _conn.execute(
            "SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE uid=? AND severity='high'",
            (uid,),
        ).fetchone()["s"]
        open_alerts = _conn.execute(
            "SELECT COUNT(*) AS c FROM alerts WHERE uid=?", (uid,)
        ).fetchone()["c"]
    return {
        "total": total,
        "high": high,
        "flaggedAmount": flagged,
        "openAlerts": open_alerts,
    }


# ── Users (auth support) ─────────────────────────────────────────────────────
def get_user_by_email(email: str) -> Optional[sqlite3.Row]:
    with _LOCK:
        return _conn.execute(
            "SELECT * FROM users WHERE email=?", (email,)
        ).fetchone()


def get_user_by_uid(uid: str) -> Optional[sqlite3.Row]:
    with _LOCK:
        return _conn.execute("SELECT * FROM users WHERE uid=?", (uid,)).fetchone()


def insert_user(uid: str, email: str, full_name: str, password_hash: str, password_salt: str) -> None:
    with _LOCK:
        _conn.execute(
            "INSERT INTO users (uid, email, fullName, passwordHash, passwordSalt, createdAt)"
            " VALUES (?,?,?,?,?,?)",
            (uid, email, full_name, password_hash, password_salt, _now_ms()),
        )
        _conn.commit()


def new_uid() -> str:
    return _gen_id(28)


# Create tables on import so any entry point (uvicorn, a script, a test) has a
# ready database without a separate migration step.
init_db()
