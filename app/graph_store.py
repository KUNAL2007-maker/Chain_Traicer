"""Optional Neo4j graph-store sink for on-chain forensic traces.

The forensic engine (``app/forensic/``) already produces the whole trace graph
in ``trace_result["graph"]`` and the browser renders it with Cytoscape.js — so
the app is fully functional without a database. This module *additionally*
persists every trace into a Neo4j **property graph** when one is configured, so
investigators can run graph queries / path-finding over the traced network and
so the visualization is backed by a real graph database (per the brief:
"make use of a Neo4j graphical database to represent it graphically").

It is entirely optional and *fails soft*: if the ``neo4j`` driver is not
installed, or ``NEO4J_URI`` / ``NEO4J_USER`` / ``NEO4J_PASSWORD`` are not set,
or the server is simply unreachable, every call becomes a no-op that returns a
status dict. The trace API still returns 200 and the graph still renders.

Activate it with, for example, a throwaway local Neo4j::

    docker run -d --name finguard-neo4j -p 7474:7474 -p 7687:7687 \
        -e NEO4J_AUTH=neo4j/finguard123 neo4j:5

then add to ``.env.local`` (gitignored — never commit real credentials)::

    NEO4J_URI=bolt://localhost:7687
    NEO4J_USER=neo4j
    NEO4J_PASSWORD=finguard123

Neo4j Aura (cloud) works too — use its ``neo4j+s://<id>.databases.neo4j.io``
URI and generated password. Nothing about this module assumes a local server.

The graph model is deliberately simple and per-user (multi-tenant, mirroring the
per-uid SQLite database):

    (:Wallet {address, uid, ...})-[:SENT {tx_hash, value, asset, ...}]->(:Wallet)

Every write is idempotent (``MERGE``), so re-tracing the same subject refreshes
the same nodes/edges instead of duplicating them.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Dict, List, Optional

# The neo4j driver is an OPTIONAL dependency. Import it lazily inside functions
# so that importing this module never fails on a box that has not installed it.

_DRIVER = None  # cached neo4j.Driver singleton
_DRIVER_LOCK = threading.Lock()
_DRIVER_FAILED_REASON: Optional[str] = None


def _config() -> Dict[str, str]:
    """Read connection settings from the environment (loaded from .env.local)."""
    return {
        "uri": (os.getenv("NEO4J_URI") or "").strip(),
        "user": (os.getenv("NEO4J_USER") or os.getenv("NEO4J_USERNAME") or "neo4j").strip(),
        "password": (os.getenv("NEO4J_PASSWORD") or "").strip(),
        "database": (os.getenv("NEO4J_DATABASE") or "neo4j").strip(),
    }


def is_configured() -> bool:
    """True when a URI and password are present in the environment."""
    cfg = _config()
    return bool(cfg["uri"] and cfg["password"])


def _driver_available() -> bool:
    try:
        import neo4j  # noqa: F401
        return True
    except Exception:
        return False


def _get_driver():
    """Return a cached, connectivity-verified driver, or None if unavailable.

    Never raises: any failure is recorded in ``_DRIVER_FAILED_REASON`` and None
    is returned so callers degrade to a no-op.
    """
    global _DRIVER, _DRIVER_FAILED_REASON

    if _DRIVER is not None:
        return _DRIVER
    if not is_configured():
        _DRIVER_FAILED_REASON = "NEO4J_URI / NEO4J_PASSWORD not set"
        return None

    with _DRIVER_LOCK:
        if _DRIVER is not None:
            return _DRIVER
        try:
            import neo4j
        except Exception as exc:  # driver not installed
            _DRIVER_FAILED_REASON = f"neo4j driver not installed ({exc})"
            return None
        cfg = _config()
        try:
            drv = neo4j.GraphDatabase.driver(
                cfg["uri"], auth=(cfg["user"], cfg["password"])
            )
            drv.verify_connectivity()
        except Exception as exc:
            _DRIVER_FAILED_REASON = f"connect failed: {exc}"
            return None
        _DRIVER = drv
        _DRIVER_FAILED_REASON = None
        return _DRIVER


def status() -> Dict[str, Any]:
    """A small, UI-friendly snapshot of the graph store's availability.

    Safe to call on every request — it does not open a new connection once the
    driver is cached, and never raises.
    """
    if not _driver_available():
        return {
            "enabled": False,
            "configured": is_configured(),
            "driver_installed": False,
            "reason": "neo4j Python driver not installed (pip install neo4j)",
        }
    if not is_configured():
        return {
            "enabled": False,
            "configured": False,
            "driver_installed": True,
            "reason": "Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to enable",
        }
    drv = _get_driver()
    if drv is None:
        return {
            "enabled": False,
            "configured": True,
            "driver_installed": True,
            "reason": _DRIVER_FAILED_REASON or "unavailable",
        }
    cfg = _config()
    return {
        "enabled": True,
        "configured": True,
        "driver_installed": True,
        "uri": cfg["uri"],
        "database": cfg["database"],
    }


def _node_rows(uid: str, network: str, nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for n in nodes:
        addr = n.get("id")
        if not addr:
            continue
        rows.append(
            {
                "address": addr,
                "uid": uid,
                "network": network,
                "type": n.get("type", "INTERMEDIARY"),
                "label": n.get("label", ""),
                "taint_ratio": float(n.get("taint_ratio", 0.0) or 0.0),
                "valuation_usd": float(n.get("valuation_usd", 0.0) or 0.0),
                "valuation_inr": float(n.get("valuation_inr", 0.0) or 0.0),
                "hop_distance": int(n.get("hop_distance", 0) or 0),
                "status": n.get("status", ""),
            }
        )
    return rows


def _edge_rows(uid: str, edges: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for e in edges:
        src, dst = e.get("source"), e.get("target")
        if not src or not dst:
            continue
        rows.append(
            {
                "uid": uid,
                "source": src,
                "target": dst,
                "id": e.get("id", ""),
                "tx_hash": e.get("tx_hash", ""),
                "value": float(e.get("value", 0.0) or 0.0),
                "value_usd": float(e.get("value_usd", 0.0) or 0.0),
                "value_inr": float(e.get("value_inr", 0.0) or 0.0),
                "asset": e.get("asset", ""),
                "timestamp": float(e.get("timestamp", 0.0) or 0.0),
                "block_number": int(e.get("block_number", 0) or 0),
                "hop": int(e.get("hop", 0) or 0),
                "taint_ratio": float(e.get("taint_ratio", 0.0) or 0.0),
            }
        )
    return rows


# Idempotent UNWIND writes. MERGE keys are (address, uid) for nodes and
# (source, target, tx_hash, uid) for edges, so re-tracing refreshes in place.
_NODE_CYPHER = """
UNWIND $rows AS row
MERGE (w:Wallet {address: row.address, uid: row.uid})
SET w.network = row.network,
    w.type = row.type,
    w.label = row.label,
    w.taint_ratio = row.taint_ratio,
    w.valuation_usd = row.valuation_usd,
    w.valuation_inr = row.valuation_inr,
    w.hop_distance = row.hop_distance,
    w.status = row.status,
    w.updated_at = timestamp()
"""

_EDGE_CYPHER = """
UNWIND $rows AS row
MATCH (a:Wallet {address: row.source, uid: row.uid})
MATCH (b:Wallet {address: row.target, uid: row.uid})
MERGE (a)-[r:SENT {tx_hash: row.tx_hash, uid: row.uid}]->(b)
SET r.edge_id = row.id,
    r.value = row.value,
    r.value_usd = row.value_usd,
    r.value_inr = row.value_inr,
    r.asset = row.asset,
    r.timestamp = row.timestamp,
    r.block_number = row.block_number,
    r.hop = row.hop,
    r.taint_ratio = row.taint_ratio,
    r.updated_at = timestamp()
"""


def persist_trace(uid: str, trace_result: Dict[str, Any]) -> Dict[str, Any]:
    """Write a completed trace's graph into Neo4j. Never raises.

    Returns a status dict: ``{"ok": bool, "nodes": int, "edges": int, ...}``.
    When the store is disabled/unavailable this is a cheap no-op with
    ``ok=False`` and a human-readable ``reason``.
    """
    if not trace_result:
        return {"ok": False, "reason": "empty trace"}

    drv = _get_driver()
    if drv is None:
        st = status()
        return {"ok": False, "reason": st.get("reason", "graph store disabled"),
                "enabled": False}

    graph = trace_result.get("graph", {}) or {}
    network = trace_result.get("network", "")
    node_rows = _node_rows(uid, network, graph.get("nodes", []) or [])
    edge_rows = _edge_rows(uid, graph.get("edges", []) or [])
    if not node_rows:
        return {"ok": False, "reason": "no nodes to persist", "enabled": True}

    cfg = _config()
    t0 = time.time()
    try:
        with drv.session(database=cfg["database"]) as sess:
            sess.run(_NODE_CYPHER, rows=node_rows).consume()
            if edge_rows:
                sess.run(_EDGE_CYPHER, rows=edge_rows).consume()
    except Exception as exc:
        return {"ok": False, "reason": f"write failed: {exc}", "enabled": True}

    return {
        "ok": True,
        "enabled": True,
        "nodes": len(node_rows),
        "edges": len(edge_rows),
        "root_address": trace_result.get("root_address", ""),
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


def close() -> None:
    """Close the cached driver (for clean shutdown). Never raises."""
    global _DRIVER
    with _DRIVER_LOCK:
        if _DRIVER is not None:
            try:
                _DRIVER.close()
            except Exception:
                pass
            _DRIVER = None
