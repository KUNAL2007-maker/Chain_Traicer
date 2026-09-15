"""
tron_tracer.py - Dedicated TRON (TRC-20) Forensic Tracer
Part of COREALGORITHM for SIH 2026.

TRON/USDT is the single largest stablecoin laundering rail, so this tracer
focuses on the TRC-20 transfer graph (USDT-TRC20 first-class) with native TRX
as secondary context. It mirrors the public contract of btc_tracer.BTCTracer so
the ForensicTraceEngine can dispatch to it and hand the result straight to the
CourtDossierGenerator with no chain-specific branching downstream.

Features:
- TronGrid REST integration (https://api.trongrid.io), key-optional. A
  TRON-PRO-API-KEY (env TRONGRID_API_KEY) raises rate limits but is not required.
- Multi-hop BFS over TRC-20 transfers with taint decay per hop.
- Terminal VASP attribution against VERIFIED_VASP_REGISTRY_TRON (+ master registry).
- Supernode / visited-set / dust guards so a hot address cannot explode the trace.
- Section 63 BSA SHA-256 evidence sealing of every raw TronGrid response.
- USDT/USDC valued 1:1 USD; dual USD/INR seizure quantum.
"""

import os
import time
import json
import logging
import threading
from typing import Dict, Any, List, Optional, Set, Tuple

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .constants import (
    VERIFIED_VASP_REGISTRY_TRON,
    VERIFIED_VASP_REGISTRY,
    DEFAULT_USD_TO_INR,
    DEFAULT_MAX_DEPTH_TRON,
)
from .client import RateGovernor, EvidenceEntry, AlchemyClient

logger = logging.getLogger("TronTracer")
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter("[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

# Canonical USDT-TRC20 contract (base58). The trace never treats a token
# contract address as a counterparty node.
USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
STABLECOIN_SYMBOLS = {"USDT", "USDC", "TUSD", "USDD"}

# Trace bounds — keep the BFS responsive against TronGrid rate limits.
PER_ADDRESS_TX_LIMIT = 50      # most-recent TRC-20 transfers pulled per address
MAX_VISITED_ADDRESSES = 40     # hard ceiling on addresses expanded in one trace
# A non-root address that returns a full page is high-throughput (likely a
# service/exchange); mark it terminal and stop expanding through it.
SUPERNODE_FULL_PAGE = PER_ADDRESS_TX_LIMIT
DUST_USD_THRESHOLD = 1.0       # ignore transfers worth < $1
TRX_PRICE_FALLBACK_USD = 0.30  # used only if the live TRX spot price is unavailable


class TronGridClient:
    """
    Resilient client for the TronGrid REST API (TRC-20 transfers + account state)
    with Section 63 BSA evidence sealing. The API key is read from TRONGRID_API_KEY
    (or passed explicitly); it is optional but strongly recommended for rate limits.
    """

    def __init__(self, api_key: Optional[str] = None,
                 base_url: str = "https://api.trongrid.io", timeout: float = 8.0):
        self.api_key = api_key if api_key is not None else os.environ.get("TRONGRID_API_KEY", "").strip()
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.rate_governor = RateGovernor(max_requests_per_second=12.0)
        self.session = requests.Session()
        retries = Retry(
            total=3,
            backoff_factor=0.3,
            status_forcelist=[429, 500, 502, 503, 504],
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retries)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        self._lock = threading.Lock()

    def _headers(self) -> Dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["TRON-PRO-API-KEY"] = self.api_key
        return headers

    def get_account(self, address: str) -> Tuple[Dict[str, Any], EvidenceEntry]:
        """Fetch account state; derives native TRX balance (sun -> TRX)."""
        self.rate_governor.acquire()
        url = f"{self.base_url}/v1/accounts/{address}"
        try:
            r = self.session.get(url, headers=self._headers(), timeout=self.timeout)
            raw_bytes = r.content
            payload = r.json() if r.status_code == 200 else {}
        except Exception as e:
            logger.warning(f"TronGrid account lookup failed for {address}: {e}")
            raw_bytes = json.dumps({"address": address, "error": str(e)}).encode("utf-8")
            payload = {}

        rows = payload.get("data") or []
        row = rows[0] if rows else {}
        balance_trx = float(row.get("balance", 0) or 0) / 1_000_000.0
        data = {
            "address": address,
            "balance_trx": max(0.0, balance_trx),
            "raw": row,
        }
        evidence = EvidenceEntry(
            query_id=f"trongrid_acct_{address[:10]}_{int(time.time())}",
            method="trongrid_getAccount",
            params={"address": address},
            raw_bytes=raw_bytes,
            as_of_block=None,
        )
        return data, evidence

    def get_trc20_transfers(self, address: str,
                            limit: int = PER_ADDRESS_TX_LIMIT) -> Tuple[List[Dict[str, Any]], EvidenceEntry]:
        """Fetch the most-recent TRC-20 transfers touching this address."""
        self.rate_governor.acquire()
        limit = max(1, min(200, int(limit)))
        url = f"{self.base_url}/v1/accounts/{address}/transactions/trc20"
        params = {"limit": limit, "only_confirmed": "true"}
        try:
            r = self.session.get(url, headers=self._headers(), params=params, timeout=self.timeout)
            raw_bytes = r.content
            payload = r.json() if r.status_code == 200 else {}
            transfers = payload.get("data") or []
        except Exception as e:
            logger.warning(f"TronGrid TRC-20 lookup failed for {address}: {e}")
            raw_bytes = json.dumps({"address": address, "error": str(e)}).encode("utf-8")
            transfers = []

        evidence = EvidenceEntry(
            query_id=f"trongrid_trc20_{address[:10]}_{int(time.time())}",
            method="trongrid_getTrc20Transfers",
            params={"address": address, "limit": limit},
            raw_bytes=raw_bytes,
            as_of_block=None,
        )
        return transfers, evidence


class TronTracer:
    """Forensic engine specialized for TRON TRC-20 (USDT) transfer graphs."""

    def __init__(self, tron_client: Optional[TronGridClient] = None,
                 alchemy_client: Optional[AlchemyClient] = None,
                 usd_to_inr: float = DEFAULT_USD_TO_INR):
        self.client = tron_client or TronGridClient()
        # Alchemy is optional here — used only to price native TRX. USDT (the
        # dominant asset) is valued 1:1, so the tracer is fully functional even
        # if Alchemy is unavailable.
        self.alchemy = alchemy_client
        self.usd_to_inr = usd_to_inr

    def get_trx_price(self) -> float:
        """Live TRX/USD spot price with a conservative fallback."""
        if self.alchemy is not None:
            try:
                p = self.alchemy.get_spot_price_by_symbol("TRX")
                if p and p > 0.0:
                    return p
            except Exception:
                pass
        return TRX_PRICE_FALLBACK_USD

    @staticmethod
    def _lookup_vasp(address: str) -> Optional[Dict[str, Any]]:
        return VERIFIED_VASP_REGISTRY_TRON.get(address) or VERIFIED_VASP_REGISTRY.get(address)

    @staticmethod
    def _value_usd(symbol: str, amount: float, trx_usd: float) -> float:
        if symbol in STABLECOIN_SYMBOLS:
            return amount  # 1:1 USD peg
        if symbol == "TRX":
            return amount * trx_usd
        return 0.0  # unpriced token — recorded, but not counted toward quantum

    def trace(self, suspect_address: str, max_depth: int = DEFAULT_MAX_DEPTH_TRON,
              crime_timestamp: Optional[str] = None) -> Dict[str, Any]:
        """Execute a multi-hop TRC-20 forensic trace on a target TRON address."""
        t_start = time.time()
        root_address = suspect_address.strip()
        max_depth = max(1, int(max_depth))
        logger.info(f"Initiating TRON TRC-20 trace on {root_address} | Max Depth: {max_depth}")

        trx_usd = self.get_trx_price()
        trx_inr = trx_usd * self.usd_to_inr

        nodes: Dict[str, Dict[str, Any]] = {}
        edges: List[Dict[str, Any]] = []
        raw_evidence_records: List[Dict[str, Any]] = []
        attributed_vasps: List[Dict[str, Any]] = []
        syndicate_clusters: List[Dict[str, Any]] = []
        visited_addresses: Set[str] = set()

        # Step 1: Ingest root account state
        root_data, root_evidence = self.client.get_account(root_address)
        raw_evidence_records.append(root_evidence.to_dict())
        root_bal_trx = root_data.get("balance_trx", 0.0)

        vasp_hit = self._lookup_vasp(root_address)
        if vasp_hit:
            root_type = vasp_hit.get("type", "VASP_HOT_WALLET")
            root_label = f"VASP: {vasp_hit['name']}\n{root_address[:6]}...{root_address[-4:]}"
            attributed_vasps.append({
                "vasp_address": root_address,
                "vasp_name": vasp_hit["name"],
                "name": vasp_hit["name"],
                "entity": vasp_hit["entity"],
                "type": root_type,
                "email": vasp_hit.get("email", "compliance@exchange.com"),
                "fiu_registered": vasp_hit.get("fiu_registered", True),
                "hop_distance": 0,
                "tx_hash": "DIRECT_VASP_ROOT",
                "seizure_quantum_asset": "USDT",
                "seizure_quantum_val": 0.0,
                "seizure_quantum_usd": 0.0,
                "seizure_quantum_inr": 0.0,
                "fifo_tainted_val": 0.0,
                "status": "ATTRIBUTED_FOR_FREEZE",
                "statutory_action": "ISSUE_BNSS_SECTION_94_PRODUCTION_ORDER",
            })
        else:
            root_type = "SUSPECT_ROOT"
            root_label = f"Root Suspect (TRON)\n{root_address[:6]}...{root_address[-4:]}"

        nodes[root_address] = {
            "id": root_address,
            "label": root_label,
            "type": root_type,
            "balance": root_bal_trx,
            "valuation_usd": root_bal_trx * trx_usd,
            "valuation_inr": root_bal_trx * trx_inr,
            "taint_ratio": 1.0,
            "hop_distance": 0,
            "status": "CONFIRMED_VASP" if vasp_hit else "ACTIVE_INVESTIGATION",
        }

        # Step 2: BFS over TRC-20 transfer graph. Queue item: (address, hop)
        queue: List[Tuple[str, int]] = [(root_address, 0)]
        visited_addresses.add(root_address)

        while queue:
            curr_addr, hop = queue.pop(0)
            if hop >= max_depth:
                continue
            if len(visited_addresses) > MAX_VISITED_ADDRESSES:
                logger.info("TRON trace hit visited-address ceiling; halting expansion.")
                break

            transfers, ev = self.client.get_trc20_transfers(curr_addr)
            raw_evidence_records.append(ev.to_dict())

            # Supernode guard: a non-root address returning a full page implies a
            # high-throughput service. Record it, but do not expand through it.
            if hop > 0 and len(transfers) >= SUPERNODE_FULL_PAGE:
                if curr_addr in nodes:
                    nodes[curr_addr]["status"] = "TERMINAL_SUPERNODE_SERVICE"
                continue

            for tr in transfers:
                token = tr.get("token_info") or {}
                symbol = (token.get("symbol") or "TRC20").upper()
                decimals = int(token.get("decimals", 6) or 6)
                token_contract = token.get("address") or ""
                frm = tr.get("from") or ""
                to = tr.get("to") or ""
                txid = tr.get("transaction_id") or ""
                block_ms = float(tr.get("block_timestamp", 0) or 0)
                block_time = block_ms / 1000.0

                try:
                    amount = float(int(tr.get("value", "0") or "0")) / (10 ** decimals)
                except (TypeError, ValueError):
                    amount = 0.0

                val_usd = self._value_usd(symbol, amount, trx_usd)
                val_inr = val_usd * self.usd_to_inr

                # Only follow OUTFLOWS from the current address (forward laundering flow).
                if frm != curr_addr:
                    continue
                # Skip token-contract self-references and dust.
                if not to or to == curr_addr or to == token_contract:
                    continue
                if val_usd < DUST_USD_THRESHOLD and symbol in STABLECOIN_SYMBOLS:
                    continue

                dest_vasp = self._lookup_vasp(to)
                if dest_vasp:
                    node_type = dest_vasp.get("type", "VASP_HOT_WALLET")
                    node_label = f"VASP: {dest_vasp['name']}\n{to[:6]}...{to[-4:]}"
                    node_status = "CASHOUT_TERMINAL"
                    attributed_vasps.append({
                        "vasp_address": to,
                        "vasp_name": dest_vasp["name"],
                        "name": dest_vasp["name"],
                        "entity": dest_vasp["entity"],
                        "type": node_type,
                        "email": dest_vasp.get("email", "compliance@exchange.com"),
                        "fiu_registered": dest_vasp.get("fiu_registered", True),
                        "hop_distance": hop + 1,
                        "tx_hash": txid,
                        "seizure_quantum_asset": symbol,
                        "seizure_quantum_val": amount,
                        "seizure_quantum_usd": val_usd,
                        "seizure_quantum_inr": val_inr,
                        "fifo_tainted_val": amount,
                        "status": "ATTRIBUTED_FOR_FREEZE",
                        "statutory_action": "ISSUE_BNSS_SECTION_94_PRODUCTION_ORDER",
                    })
                else:
                    node_type = "INTERMEDIARY_BURNER"
                    node_label = f"Hop {hop + 1}\n{to[:6]}...{to[-4:]}"
                    node_status = "ACTIVE_LAYERING"

                if to not in nodes:
                    nodes[to] = {
                        "id": to,
                        "label": node_label,
                        "type": node_type,
                        "balance": amount,
                        "valuation_usd": val_usd,
                        "valuation_inr": val_inr,
                        "taint_ratio": max(0.2, 1.0 - ((hop + 1) * 0.15)),
                        "hop_distance": hop + 1,
                        "status": node_status,
                    }

                edges.append({
                    "id": f"tron_{txid[:10]}_{frm[:6]}_{to[:6]}",
                    "source": curr_addr,
                    "target": to,
                    "value": amount,
                    "value_usd": val_usd,
                    "value_inr": val_inr,
                    "asset": symbol,
                    "timestamp": block_time,
                    "tx_hash": txid,
                    "hop": hop + 1,
                    "edge_type": "OUTFLOW_TRANSFER",
                    "label": f"{amount:,.2f} {symbol} (₹{val_inr:,.0f})",
                })

                if to not in visited_addresses and not dest_vasp:
                    visited_addresses.add(to)
                    queue.append((to, hop + 1))

        exec_ms = int((time.time() - t_start) * 1000)

        # De-duplicate attributed VASPs (keep first / shallowest hit per address).
        unique_vasps: List[Dict[str, Any]] = []
        seen_vasp_addrs: Set[str] = set()
        for v in attributed_vasps:
            va = v["vasp_address"]
            if va not in seen_vasp_addrs:
                seen_vasp_addrs.add(va)
                unique_vasps.append(v)

        total_seized_val = sum(v["seizure_quantum_val"] for v in unique_vasps)
        total_seized_usd = sum(v["seizure_quantum_usd"] for v in unique_vasps)
        total_seized_inr = sum(v["seizure_quantum_inr"] for v in unique_vasps)
        primary_vasp = unique_vasps[0] if unique_vasps else None

        if primary_vasp:
            verdict_badge = "CONFIRMED_VASP_CASHOUT"
            confidence_score = 94.0
            confidence_tier = "HIGH"
            police_story = (
                f"Illicit TRC-20 funds originating from suspect TRON wallet {root_address[:8]}... "
                f"were traced across {primary_vasp['hop_distance']} hops and deposited into "
                f"verified exchange infrastructure ({primary_vasp['name']}). An asset freeze of "
                f"{total_seized_usd:,.2f} USDT (₹{total_seized_inr:,.0f} INR) under Section 94 BNSS "
                f"is eligible against {primary_vasp['entity']}."
            )
        else:
            verdict_badge = "INTERMEDIARY_PEEL_CHAIN"
            confidence_score = 78.0
            confidence_tier = "MEDIUM"
            police_story = (
                f"Funds from TRON suspect {root_address[:8]}... have been dispersed across "
                f"{max(0, len(nodes) - 1)} downstream intermediary TRC-20 addresses. No direct "
                f"exchange deposit has been identified yet. Recommend continuous monitoring."
            )

        return {
            "status": "SUCCESS",
            "network": "tron-mainnet",
            "family": "TRON",
            "root_address": root_address,
            "root_balance": root_bal_trx,
            "valuation_usd": root_bal_trx * trx_usd,
            "valuation_inr": root_bal_trx * trx_inr,
            "execution_time_ms": exec_ms,
            "nodes": nodes,
            "edges": edges,
            "attributed_vasps": unique_vasps,
            "syndicate_clusters": syndicate_clusters,
            "raw_evidence_records": raw_evidence_records,
            "seizure_quantum": {
                "asset": "USDT",
                "total_val": total_seized_val,
                "total_usd": total_seized_usd,
                "total_inr": total_seized_inr,
            },
            "assessment": {
                "verdict_badge": verdict_badge,
                "confidence_score": confidence_score,
                "confidence_tier": confidence_tier,
                "police_story": police_story,
                "primary_vasp": primary_vasp["name"] if primary_vasp else "None",
                "compliance_email": primary_vasp["email"] if primary_vasp else "N/A",
            },
        }
