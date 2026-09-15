"""Adapter around the vendored on-chain forensic engine (``app/forensic/`` —
Hafiz's COREALGORITHM). It exposes one synchronous entry point, :func:`run_trace`,
that the FastAPI layer calls inside a threadpool (the engine does blocking HTTP
I/O against Alchemy, so it must never run on the event loop).

The engine is built lazily and cached. Constructing ``ForensicTraceEngine``
instantiates an ``AlchemyClient``, which now requires a live ``ALCHEMY_API_KEY``
(the keys that upstream committed to source were stripped on vendoring). Deferring
construction to first use lets the rest of the app import cleanly with no key set,
and lets the route return a tidy "needs configuration" response instead of a 500.

This is glue only: the forensic logic is Hafiz's, unmodified. We normalise the
request the same way his Flask ``/api/trace`` did, run the trace + the three
dossier levels + statutory instruments, and JSON-sanitise the result so
Starlette's ``JSONResponse`` (``allow_nan=False``, no custom encoder) can never
choke on a ``Decimal``, ``set`` or ``NaN`` that leaks out of the engine.
"""
from __future__ import annotations

import math
import threading
from decimal import Decimal
from typing import Any, Dict, Optional, Tuple

from .forensic.constants import SUPPORTED_NETWORKS
from .forensic.dossier import CourtDossierGenerator
from .forensic.engine import ForensicTraceEngine

_engine: Optional[ForensicTraceEngine] = None
_dossier: Optional[CourtDossierGenerator] = None
_lock = threading.Lock()


class TraceNotConfigured(RuntimeError):
    """No ALCHEMY_API_KEY available to build the engine."""


def _ensure_engine() -> Tuple[ForensicTraceEngine, CourtDossierGenerator]:
    """Build (once) and return the engine + dossier singletons.

    Raises :class:`TraceNotConfigured` if the engine cannot be built because no
    Alchemy key is configured — the one failure mode the caller handles specially.
    """
    global _engine, _dossier
    if _engine is not None and _dossier is not None:
        return _engine, _dossier
    with _lock:
        if _engine is None:
            try:
                _engine = ForensicTraceEngine()
            except RuntimeError as exc:  # AlchemyClient() with no key
                raise TraceNotConfigured(str(exc)) from exc
        if _dossier is None:
            _dossier = CourtDossierGenerator()
    return _engine, _dossier


def _json_safe(value: Any) -> Any:
    """Recursively coerce engine output into types Starlette's JSONResponse
    accepts. ``Decimal`` -> float, ``set``/``tuple`` -> list, non-finite floats
    -> None; dict keys are stringified. Everything else passes through."""
    if isinstance(value, Decimal):
        value = float(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(v) for v in value]
    return value


def run_trace(
    address: str,
    network: str = "eth-mainnet",
    max_depth: Any = 4,
    crime_timestamp: Optional[str] = None,
    pre_crime_balance: Any = 0.0,
) -> Dict[str, Any]:
    """Run one forensic trace and assemble the full court dossier.

    Mirrors the request handling of upstream's Flask ``POST /api/trace`` and
    returns the same shape (``success``, ``trace_result``, ``verdict``,
    ``cytoscape_elements``, ``section_63_certificate``, ``statutory_notices``).
    On failure returns ``{"success": False, "error": ...}`` and, when the cause
    is a missing Alchemy key, an additional ``"needs_config": True`` flag.
    """
    address = (address or "").strip()
    if not address:
        return {"success": False, "error": "Target wallet address is required."}

    if network not in SUPPORTED_NETWORKS:
        network = "eth-mainnet"
    try:
        max_depth = max(1, min(8, int(max_depth)))
    except (TypeError, ValueError):
        max_depth = 4
    try:
        pre_crime_balance = float(pre_crime_balance)
    except (TypeError, ValueError):
        pre_crime_balance = 0.0

    try:
        engine, dossier = _ensure_engine()
    except TraceNotConfigured as exc:
        return {"success": False, "needs_config": True, "error": str(exc)}

    try:
        trace_result = engine.execute_forensic_trace(
            suspect_address=address,
            network=network,
            max_depth=max_depth,
            crime_timestamp=crime_timestamp,
            pre_crime_clean_balance=pre_crime_balance,
        )
        level1_verdict = dossier.generate_level1_verdict(trace_result)
        level2_graph = dossier.format_level2_graph(trace_result)
        level3_certificate = dossier.generate_level3_certificate(trace_result)
        statutory_notices = dossier.generate_statutory_instruments(trace_result)
    except Exception as exc:  # upstream/on-chain failure — mirror app.py's guard
        return {"success": False, "error": str(exc)}

    return _json_safe(
        {
            "success": True,
            "trace_result": trace_result,
            "verdict": level1_verdict,
            "cytoscape_elements": level2_graph.get("elements", []),
            "section_63_certificate": level3_certificate,
            "statutory_notices": statutory_notices,
        }
    )
