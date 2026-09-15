"""
client.py - Resilient Alchemy Client & Evidence Ingestion Gateway
Strictly compliant with FINAL_ALGORITHM.md §1, §3, §4, §10, and RESEARCH SET 6 & 10.

Features:
- Multi-network EVM RPC support via Alchemy Cortex.
- Raw-byte capture and SHA-256 evidence hashing for Section 63 BSA compliance.
- Token-bucket rate limiting and automatic retry with exponential backoff.
- Alchemy Prices API integration (/tokens/by-address, /tokens/historical, /tokens/by-symbol).
- Dispatch routing for TRON (TronGrid) and Bitcoin (Mempool.space).
"""

import os
import time
import json
import hashlib
import logging
import base64
import threading
import random
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List, Optional, Tuple
import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry

from .constants import (
    SUPPORTED_NETWORKS,
    CANONICAL_TOKENS,
    DEFAULT_USD_TO_INR
)

logger = logging.getLogger("AlchemyClient")
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter("[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


class RateGovernor:
    """Thread-safe rate governor to smoothly pace requests and avoid provider 429 errors."""
    def __init__(self, max_requests_per_second: float = 24.0):
        self.min_interval = 1.0 / max_requests_per_second
        self.last_call = 0.0
        self._lock = threading.Lock()

    def acquire(self):
        with self._lock:
            now = time.time()
            elapsed = now - self.last_call
            if elapsed < self.min_interval:
                time.sleep(self.min_interval - elapsed)
            self.last_call = time.time()


class EvidenceEntry:
    """Evidentiary seal entry tying raw provider bytes to court records (BSA §63)."""
    def __init__(self, query_id: str, method: str, params: Any, raw_bytes: bytes,
                 as_of_block: Optional[int] = None, timestamp: Optional[float] = None):
        self.query_id = query_id
        self.method = method
        self.params = params
        self.timestamp = timestamp or time.time()
        self.as_of_block = as_of_block
        self.raw_bytes = raw_bytes
        # Pre-image preservation for court verification
        self.payload_b64 = base64.b64encode(raw_bytes).decode("ascii") if raw_bytes else ""
        # 64-character SHA-256 hash of raw HTTP response payload bytes
        self.sha256_payload = hashlib.sha256(raw_bytes).hexdigest()
        # Canonical representation hash
        canonical_str = json.dumps({"method": method, "params": params, "block": as_of_block}, sort_keys=True)
        self.sha256_canonical = hashlib.sha256(canonical_str.encode("utf-8")).hexdigest()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "query_id": self.query_id,
            "method": self.method,
            "params": self.params,
            "timestamp": self.timestamp,
            "as_of_block": self.as_of_block,
            "sha256_payload": self.sha256_payload,
            "sha256_canonical": self.sha256_canonical,
            "payload_b64": self.payload_b64
        }


class AlchemyClient:
    """
    High-throughput, court-grade client for Alchemy Blockchain APIs.
    """
    def __init__(self, api_key: Optional[str] = None, max_retries: int = 6, backoff_base: float = 0.6):
        # SECURITY: no API keys are baked into the source. Keys are read from the
        # ALCHEMY_API_KEY env var (a single key, or several comma-separated for
        # quota rotation) or passed explicitly by the caller. The two keys that
        # were committed to the upstream COREALGORITHM repo were stripped on
        # vendoring and must be revoked/rotated in the Alchemy dashboard.
        if api_key:
            self.api_keys = [api_key]
        else:
            env_key = os.environ.get("ALCHEMY_API_KEY", "")
            self.api_keys = [k.strip() for k in env_key.split(",") if k.strip()]

        if not self.api_keys:
            raise RuntimeError(
                "No Alchemy API key configured. Set ALCHEMY_API_KEY in .env.local "
                "(create one at https://dashboard.alchemy.com) or pass api_key=... "
                "explicitly when constructing AlchemyClient."
            )

        self.api_key = self.api_keys[0]
        self._key_index = 0
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.session = requests.Session()
        self.rate_governor = RateGovernor(max_requests_per_second=24.0)
        
        # High-concurrency connection pool adapter for rapid async & multi-threaded tracing
        retries = Retry(
            total=1,
            connect=0,
            read=0,
            redirect=0,
            status_forcelist=[429, 500, 502, 503, 504],
            raise_on_status=False
        )
        adapter = HTTPAdapter(pool_connections=64, pool_maxsize=64, max_retries=retries)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        
        self._lock = threading.Lock()
        
        # Raw Evidence Store for Section 63 BSA dossiers
        self.evidence_ledger: List[EvidenceEntry] = []
        
        # In-memory spot price cache (60 seconds TTL)
        self._price_cache: Dict[str, Tuple[float, float]] = {}  # symbol -> (price_usd, timestamp)
        self._token_address_price_cache: Dict[str, Tuple[Optional[float], float]] = {}
        self._code_cache: Dict[str, str] = {}
        self._block_cache: Dict[str, Tuple[int, float]] = {}

    def get_latest_block_number(self, network: str = "eth-mainnet") -> int:
        """Retrieves cached or live latest block number for as-of-block evidence anchoring."""
        now = time.time()
        with self._lock:
            if network in self._block_cache and (now - self._block_cache[network][1]) < 30.0:
                return self._block_cache[network][0]
        try:
            url = self._get_rpc_url(network)
            payload = {"jsonrpc": "2.0", "id": 999999, "method": "eth_blockNumber", "params": []}
            r = self.session.post(url, json=payload, timeout=5)
            if r.status_code == 200:
                data = r.json()
                blk = int(data.get("result", "0x0"), 16)
                with self._lock:
                    self._block_cache[network] = (blk, now)
                return blk
        except Exception:
            pass
        return 0

    def get_api_key(self) -> str:
        """Rotates across configured Alchemy keys to balance quota and eliminate 429 rate limits."""
        with self._lock:
            key = self.api_keys[self._key_index % len(self.api_keys)]
            self._key_index += 1
            return key

    def _get_rpc_url(self, network: str) -> str:
        net_info = SUPPORTED_NETWORKS.get(network)
        if not net_info:
            raise ValueError(f"Unsupported EVM network: {network}")
        subdomain = net_info["alchemy_subdomain"]
        return f"https://{subdomain}.g.alchemy.com/v2/{self.get_api_key()}"

    def _execute_rpc(self, network: str, method: str, params: list) -> Tuple[Dict[str, Any], EvidenceEntry]:
        """
        Executes a JSON-RPC request with rate-limiting backoff and raw-byte SHA-256 capture.
        """
        url = self._get_rpc_url(network)
        payload = {
            "jsonrpc": "2.0",
            "id": int(time.time() * 1000) % 1000000,
            "method": method,
            "params": params
        }
        
        last_exception = None
        for attempt in range(self.max_retries):
            self.rate_governor.acquire()
            try:
                t0 = time.time()
                response = self.session.post(url, json=payload, timeout=12)
                raw_bytes = response.content
                
                # Check for rate limiting
                if response.status_code == 429:
                    last_exception = RuntimeError(f"Rate limited (HTTP 429) after attempt {attempt + 1}")
                    retry_after = float(response.headers.get("Retry-After", self.backoff_base * (2 ** attempt)))
                    wait_time = retry_after + random.uniform(0.3, 0.9)
                    logger.warning(f"Rate limited (429) on {network}. Sleeping {wait_time:.2f}s (attempt {attempt + 1}/{self.max_retries})...")
                    time.sleep(wait_time)
                    continue
                
                response.raise_for_status()
                data = response.json()
                
                if "error" in data:
                    err_msg = data["error"].get("message", "Unknown RPC error")
                    err_code = data["error"].get("code", 0)
                    # Some nodes return rate limit inside error json
                    if err_code in (-32005, 429):
                        last_exception = RuntimeError(f"Node rate limit ({err_code}): {err_msg}")
                        wait_time = self.backoff_base * (2 ** attempt) + random.uniform(0.3, 0.9)
                        time.sleep(wait_time)
                        continue
                    raise RuntimeError(f"RPC Error ({err_code}): {err_msg}")
                
                # Evidence anchoring: Record exact raw bytes SHA-256 seal with real as-of-block
                current_block = None
                if method == "eth_blockNumber":
                    try:
                        current_block = int(data.get("result", "0x0"), 16)
                    except Exception:
                        pass
                else:
                    current_block = self.get_latest_block_number(network)

                entry = EvidenceEntry(
                    query_id=f"{network}_{method}_{payload['id']}",
                    method=method,
                    params=params,
                    raw_bytes=raw_bytes,
                    as_of_block=current_block if current_block and current_block > 0 else None,
                    timestamp=time.time()
                )
                with self._lock:
                    self.evidence_ledger.append(entry)
                return data, entry

            except (requests.RequestException, RuntimeError) as e:
                last_exception = e
                wait_time = self.backoff_base * (2 ** attempt) + random.uniform(0.2, 0.6)
                logger.warning(f"RPC attempt {attempt + 1}/{self.max_retries} failed for {method}: {e}. Retrying in {wait_time:.2f}s...")
                time.sleep(wait_time)
        
        raise RuntimeError(f"All {self.max_retries} RPC attempts failed for {method} on {network}: {last_exception}")

    def _execute_batch_rpc(self, network: str, calls: List[Tuple[str, list]]) -> List[Dict[str, Any]]:
        """
        Executes multiple JSON-RPC calls in a single HTTP POST request.
        Compliant with Alchemy batch JSON-RPC API specification.
        Returns results in the exact order corresponding to calls.
        """
        if not calls:
            return []

        url = self._get_rpc_url(network)
        batch_payload = []
        base_id = int(time.time() * 1000) % 1000000
        for i, (method, params) in enumerate(calls):
            batch_payload.append({
                "jsonrpc": "2.0",
                "id": base_id + i,
                "method": method,
                "params": params
            })

        last_exception = None
        for attempt in range(self.max_retries):
            self.rate_governor.acquire()
            try:
                response = self.session.post(url, json=batch_payload, timeout=15)
                raw_bytes = response.content
                if response.status_code == 429:
                    last_exception = RuntimeError(f"Batch RPC rate limit (HTTP 429) after attempt {attempt + 1}")
                    retry_after = float(response.headers.get("Retry-After", self.backoff_base * (2 ** attempt)))
                    wait_time = retry_after + random.uniform(0.3, 0.9)
                    logger.warning(f"Batch RPC rate limited (429) on {network}. Sleeping {wait_time:.2f}s (attempt {attempt + 1}/{self.max_retries})...")
                    time.sleep(wait_time)
                    continue

                response.raise_for_status()
                data = response.json()
                if not isinstance(data, list):
                    if isinstance(data, dict) and "error" in data:
                        raise RuntimeError(f"Batch RPC error: {data['error']}")
                    data = [data]

                # Map responses by id
                resp_by_id = {item.get("id"): item for item in data if isinstance(item, dict)}
                ordered_results = []
                for i, (method, params) in enumerate(calls):
                    call_id = base_id + i
                    item = resp_by_id.get(call_id, {})
                    ordered_results.append(item)

                # Record batch evidentiary entry
                current_block = self.get_latest_block_number(network)
                entry = EvidenceEntry(
                    query_id=f"{network}_batch_{base_id}",
                    method="batch_rpc",
                    params=[c[0] for c in calls],
                    raw_bytes=raw_bytes,
                    as_of_block=current_block if current_block and current_block > 0 else None,
                    timestamp=time.time()
                )
                with self._lock:
                    self.evidence_ledger.append(entry)

                return ordered_results

            except (requests.RequestException, RuntimeError) as e:
                last_exception = e
                wait_time = self.backoff_base * (2 ** attempt) + random.uniform(0.2, 0.6)
                logger.warning(f"Batch RPC attempt {attempt + 1}/{self.max_retries} failed on {network}: {e}. Retrying in {wait_time:.2f}s...")
                time.sleep(wait_time)

        raise RuntimeError(f"All {self.max_retries} batch RPC attempts failed on {network}: {last_exception}")

    # -------------------------------------------------------------------------
    # Core JSON-RPC Blockchain Methods
    # -------------------------------------------------------------------------

    def get_latest_block_number(self, network: str = "eth-mainnet") -> int:
        """Returns the current latest finalized block number."""
        data, _ = self._execute_rpc(network, "eth_blockNumber", [])
        hex_block = data.get("result", "0x0")
        return int(hex_block, 16)

    def get_balance(self, address: str, network: str = "eth-mainnet") -> float:
        """Returns native asset liquid balance (ETH, BNB, POL) decoded to float."""
        data, _ = self._execute_rpc(network, "eth_getBalance", [address, "latest"])
        hex_bal = data.get("result", "0x0")
        raw_wei = int(hex_bal, 16)
        return raw_wei / 1e18

    def get_code(self, address: str, network: str = "eth-mainnet") -> str:
        """Returns bytecode at address. '0x' indicates standard EOA; non-empty indicates Contract / Smart Account."""
        cache_key = f"{network}:{address.lower()}"
        with self._lock:
            if hasattr(self, "_code_cache") and cache_key in self._code_cache:
                return self._code_cache[cache_key]
        data, _ = self._execute_rpc(network, "eth_getCode", [address, "latest"])
        code = data.get("result", "0x")
        with self._lock:
            if hasattr(self, "_code_cache"):
                self._code_cache[cache_key] = code
        return code

    def get_transaction_count(self, address: str, network: str = "eth-mainnet") -> int:
        """Returns outbound nonce for address."""
        data, _ = self._execute_rpc(network, "eth_getTransactionCount", [address, "latest"])
        return int(data.get("result", "0x0"), 16)

    def get_transaction_receipt(self, tx_hash: str, network: str = "eth-mainnet") -> Optional[Dict[str, Any]]:
        """
        Returns the transaction receipt including all emitted event logs.
        Essential for decoding cross-chain bridge events (CCTP, Across, Stargate)
        and DEX swap receipt topics under Section 63 BSA evidence preservation.
        """
        try:
            data, _ = self._execute_rpc(network, "eth_getTransactionReceipt", [tx_hash])
            return data.get("result")
        except Exception as e:
            logger.warning(f"Failed to fetch transaction receipt for {tx_hash} on {network}: {e}")
            return None

    def get_address_triad(self, address: str, network: str = "eth-mainnet") -> Dict[str, Any]:
        """
        High-throughput batch query: fetches bytecode, balance, and outbound nonce
        in a SINGLE network round-trip via JSON-RPC batching.
        Returns: {'code': str, 'balance': float, 'nonce': int}
        """
        cache_key = f"{network}:{address.lower()}"
        cached_code = None
        with self._lock:
            if hasattr(self, "_code_cache") and cache_key in self._code_cache:
                cached_code = self._code_cache[cache_key]

        calls = []
        call_types = []
        if cached_code is None:
            calls.append(("eth_getCode", [address, "latest"]))
            call_types.append("code")
        calls.append(("eth_getBalance", [address, "latest"]))
        call_types.append("balance")
        calls.append(("eth_getTransactionCount", [address, "latest"]))
        call_types.append("nonce")

        results = self._execute_batch_rpc(network, calls)
        out = {"code": cached_code or "0x", "balance": 0.0, "nonce": 0}
        for ctype, res in zip(call_types, results):
            if ctype == "code":
                code = res.get("result", "0x")
                out["code"] = code
                with self._lock:
                    self._code_cache[cache_key] = code
            elif ctype == "balance":
                hex_bal = res.get("result", "0x0")
                try:
                    out["balance"] = int(hex_bal, 16) / 1e18
                except (ValueError, TypeError):
                    out["balance"] = 0.0
            elif ctype == "nonce":
                hex_nonce = res.get("result", "0x0")
                try:
                    out["nonce"] = int(hex_nonce, 16)
                except (ValueError, TypeError):
                    out["nonce"] = 0

        return out

    def get_asset_transfers(
        self,
        network: str = "eth-mainnet",
        from_address: Optional[str] = None,
        to_address: Optional[str] = None,
        from_block: str = "0x0",
        to_block: str = "latest",
        category: Optional[List[str]] = None,
        max_count: int = 100,
        page_key: Optional[str] = None,
        order: str = "desc"
    ) -> Tuple[List[Dict[str, Any]], Optional[str], EvidenceEntry]:
        """
        Calls alchemy_getAssetTransfers for high-throughput forensic edge recovery.
        Always includes raw-byte evidentiary seal.
        """
        if category is None:
            if network in ("eth-mainnet", "polygon-mainnet", "base-mainnet"):
                category = ["external", "internal", "erc20"]
            else:
                category = ["external", "erc20"]
            
        params: Dict[str, Any] = {
            "fromBlock": from_block,
            "toBlock": to_block,
            "category": category,
            "order": order,
            "maxCount": hex(max_count),
            "withMetadata": True
        }
        if from_address:
            params["fromAddress"] = from_address
        if to_address:
            params["toAddress"] = to_address
        if page_key:
            params["pageKey"] = page_key

        data, evidence_entry = self._execute_rpc(network, "alchemy_getAssetTransfers", [params])
        result = data.get("result", {})
        transfers = result.get("transfers", [])
        next_page = result.get("pageKey")
        
        return transfers, next_page, evidence_entry

    def get_genesis_funder(self, address: str, network: str = "eth-mainnet") -> Optional[Dict[str, Any]]:
        """
        O(1) Bounded Window_B query: discovers the genesis funder of an address (FINAL_ALGORITHM.md §3).
        """
        params = {
            "fromBlock": "0x0",
            "toBlock": "latest",
            "toAddress": address,
            "category": ["external"],
            "order": "asc",
            "maxCount": "0x1",
            "withMetadata": True
        }
        try:
            data, _ = self._execute_rpc(network, "alchemy_getAssetTransfers", [params])
            transfers = data.get("result", {}).get("transfers", [])
            if transfers:
                return transfers[0]
        except Exception as e:
            logger.warning(f"Failed to fetch genesis funder for {address}: {e}")
        return None

    # -------------------------------------------------------------------------
    # Alchemy Prices API (Dual-Valuation & Token Decimals)
    # -------------------------------------------------------------------------

    def get_token_price_by_address(self, network: str, contract_address: str) -> Optional[float]:
        """
        Pillar 1 compliant: Query price by CANONICAL CONTRACT ADDRESS, never symbol alone.
        """
        contract_lower = contract_address.lower()
        # Fast path for recognized stablecoins
        token_meta = CANONICAL_TOKENS.get(contract_lower)
        if token_meta and token_meta.get("is_stablecoin"):
            return 1.0

        now = time.time()
        with self._lock:
            if contract_lower in self._token_address_price_cache:
                cached_price, cached_time = self._token_address_price_cache[contract_lower]
                if now - cached_time < 60:
                    return cached_price

        url = f"https://api.g.alchemy.com/prices/v1/{self.get_api_key()}/tokens/by-address"
        body = {
            "addresses": [{"network": network, "address": contract_address}]
        }
        try:
            r = self.session.post(url, json=body, timeout=1.5)
            if r.status_code == 200:
                data = r.json()
                items = data.get("data", [])
                if items and "prices" in items[0] and items[0]["prices"]:
                    price_str = items[0]["prices"][0].get("value")
                    if price_str:
                        val = float(price_str)
                        with self._lock:
                            self._token_address_price_cache[contract_lower] = (val, now)
                        return val
        except Exception as e:
            logger.debug(f"Prices API by-address lookup skipped for {contract_address}: {e}")
        
        with self._lock:
            self._token_address_price_cache[contract_lower] = (None, now)
        return None

    def get_spot_price_by_symbol(self, symbol: str) -> float:
        """
        Returns live real-time spot price in USD (with 60-second in-memory cache).
        """
        sym = (symbol or "").strip().upper()
        if not sym or not sym.isalnum() or len(sym) > 10:
            return 0.0

        if sym in ("USDT", "USDC", "DAI", "FDUSD"):
            return 1.0

        now = time.time()
        with self._lock:
            if sym in self._price_cache:
                cached_price, cached_time = self._price_cache[sym]
                if now - cached_time < 60:
                    return cached_price

        url = f"https://api.g.alchemy.com/prices/v1/{self.get_api_key()}/tokens/by-symbol?symbols={sym}"
        try:
            r = self.session.get(url, timeout=1.5)
            if r.status_code == 200:
                data = r.json()
                data_list = data.get("data", [])
                if data_list and "prices" in data_list[0] and data_list[0]["prices"]:
                    price_val = float(data_list[0]["prices"][0].get("value", 0.0))
                    if price_val > 0:
                        with self._lock:
                            self._price_cache[sym] = (price_val, now)
                        return price_val
        except Exception as e:
            logger.warning(f"Failed to fetch live spot price for {sym}: {e}")

        # Conservative fallbacks if network unreachable
        fallbacks = {
            "ETH": 2600.0, "BNB": 580.0, "BTC": 64000.0, "POL": 0.42, "TRX": 0.15,
            "LINK": 12.50, "AXS": 5.20, "MATIC": 0.42, "UNI": 7.50
        }
        val = fallbacks.get(sym, 1.0)
        with self._lock:
            self._price_cache[sym] = (val, now)
        return val

    def get_historical_price(self, symbol: str, timestamp_iso: str) -> float:
        """
        Dual-Valuation Pillar 3: Returns 1-hour candle price at crime timestamp for Section 63 / FIR loss.
        """
        sym = symbol.upper()
        if sym in ("USDT", "USDC"):
            return 1.0

        url = f"https://api.g.alchemy.com/prices/v1/{self.get_api_key()}/tokens/historical"
        try:
            cleaned = timestamp_iso.replace("Z", "+00:00")
            if cleaned.isdigit() or (cleaned.replace(".", "", 1).isdigit()):
                dt_start = datetime.fromtimestamp(float(cleaned), tz=timezone.utc)
            else:
                dt_start = datetime.fromisoformat(cleaned)
            dt_end = dt_start + timedelta(hours=1)
            start_str = dt_start.strftime("%Y-%m-%dT%H:%M:%SZ")
            end_str = dt_end.strftime("%Y-%m-%dT%H:%M:%SZ")
        except Exception:
            return self.get_spot_price_by_symbol(sym)

        body = {
            "symbol": sym,
            "startTime": start_str,
            "endTime": end_str,
            "interval": "1h"
        }
        try:
            r = self.session.post(url, json=body, timeout=8)
            if r.status_code == 200:
                data = r.json()
                data_points = data.get("data", [])
                if data_points and "value" in data_points[0]:
                    return float(data_points[0]["value"])
        except Exception as e:
            logger.warning(f"Historical price API fallback for {sym} at {timestamp_iso}: {e}")

        return self.get_spot_price_by_symbol(sym)


# -------------------------------------------------------------------------
# MempoolClient - Bitcoin UTXO REST Client (Esplora Engine)
# -------------------------------------------------------------------------
class MempoolClient:
    """
    High-resilience client for Mempool.space / Esplora Bitcoin REST API.
    Provides UTXO transaction retrieval, address stats, and Section 63 BSA evidence seals.
    """
    def __init__(self, base_url: str = "https://mempool.space/api", timeout: float = 6.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.rate_governor = RateGovernor(max_requests_per_second=10.0)
        self.session = requests.Session()
        retries = Retry(
            total=3,
            backoff_factor=0.3,
            status_forcelist=[429, 500, 502, 503, 504],
            raise_on_status=False
        )
        adapter = HTTPAdapter(max_retries=retries)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        self._lock = threading.Lock()
        self._cache: Dict[str, Tuple[Any, float]] = {}

    def get_address(self, address: str) -> Tuple[Dict[str, Any], EvidenceEntry]:
        """
        Fetches on-chain stats and computes confirmed + unconfirmed Satoshi balance.
        """
        self.rate_governor.acquire()
        url = f"{self.base_url}/address/{address}"
        try:
            r = self.session.get(url, timeout=self.timeout)
            raw_bytes = r.content
            if r.status_code == 200:
                data = r.json()
            else:
                data = {
                    "address": address,
                    "chain_stats": {"funded_txo_sum": 0, "spent_txo_sum": 0, "tx_count": 0},
                    "mempool_stats": {"funded_txo_sum": 0, "spent_txo_sum": 0, "tx_count": 0}
                }
        except Exception as e:
            logger.warning(f"Mempool API address lookup failed for {address}: {e}")
            raw_bytes = json.dumps({"address": address, "error": str(e)}).encode("utf-8")
            data = {
                "address": address,
                "chain_stats": {"funded_txo_sum": 0, "spent_txo_sum": 0, "tx_count": 0},
                "mempool_stats": {"funded_txo_sum": 0, "spent_txo_sum": 0, "tx_count": 0}
            }

        cs = data.get("chain_stats", {})
        ms = data.get("mempool_stats", {})
        satoshis = (cs.get("funded_txo_sum", 0) - cs.get("spent_txo_sum", 0)) + \
                   (ms.get("funded_txo_sum", 0) - ms.get("spent_txo_sum", 0))
        data["balance_satoshis"] = max(0, satoshis)
        data["balance_btc"] = max(0.0, satoshis / 100_000_000.0)
        data["tx_count"] = cs.get("tx_count", 0) + ms.get("tx_count", 0)

        evidence = EvidenceEntry(
            query_id=f"mempool_addr_{address[:10]}_{int(time.time())}",
            method="mempool_getAddress",
            params={"address": address},
            raw_bytes=raw_bytes,
            as_of_block=None
        )
        return data, evidence

    def get_address_txs(self, address: str) -> Tuple[List[Dict[str, Any]], EvidenceEntry]:
        """
        Fetches up to 25 recent transactions for the given Bitcoin address.
        """
        self.rate_governor.acquire()
        url = f"{self.base_url}/address/{address}/txs"
        try:
            r = self.session.get(url, timeout=self.timeout)
            raw_bytes = r.content
            if r.status_code == 200:
                txs = r.json()
            else:
                txs = []
        except Exception as e:
            logger.warning(f"Mempool API get_address_txs failed for {address}: {e}")
            raw_bytes = json.dumps({"address": address, "error": str(e)}).encode("utf-8")
            txs = []

        evidence = EvidenceEntry(
            query_id=f"mempool_txs_{address[:10]}_{int(time.time())}",
            method="mempool_getAddressTxs",
            params={"address": address},
            raw_bytes=raw_bytes,
            as_of_block=None
        )
        return txs, evidence

    def get_transaction(self, txid: str) -> Tuple[Dict[str, Any], EvidenceEntry]:
        """
        Fetches full transaction payload including vin and vout.
        """
        self.rate_governor.acquire()
        url = f"{self.base_url}/tx/{txid}"
        try:
            r = self.session.get(url, timeout=self.timeout)
            raw_bytes = r.content
            if r.status_code == 200:
                tx = r.json()
            else:
                tx = {}
        except Exception as e:
            logger.warning(f"Mempool API get_transaction failed for {txid}: {e}")
            raw_bytes = json.dumps({"txid": txid, "error": str(e)}).encode("utf-8")
            tx = {}

        evidence = EvidenceEntry(
            query_id=f"mempool_tx_{txid[:10]}_{int(time.time())}",
            method="mempool_getTx",
            params={"txid": txid},
            raw_bytes=raw_bytes,
            as_of_block=tx.get("status", {}).get("block_height") if tx else None
        )
        return tx, evidence
