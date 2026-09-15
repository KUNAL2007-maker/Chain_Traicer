"""
token_shield.py - Four-Pillar Token Shield & Dual Valuation
Strictly compliant with FINAL_ALGORITHM.md §4 (Step 2) & RESEARCH SET 2 & 8.

Pillars:
1. Identity by canonical contract address, never bare symbol string.
2. Anti-poisoning by priority tiering (zero-evidence-loss: zero/dust transfers are tiered, never deleted).
3. Dual valuation: Historical FIR Loss (crime timestamp) vs Live Seizure Quantum (spot price).
4. Exact per-contract decimals decoding (eliminates the 10^12 under-reporting bug).
"""

from typing import Dict, Any, Optional, Tuple
from decimal import Decimal
import logging
from .constants import CANONICAL_TOKENS, DEFAULT_USD_TO_INR
from .client import AlchemyClient

logger = logging.getLogger("TokenShield")


class TokenShield:
    """
    Enforces the Four-Pillar Token Shield on all on-chain transfers.
    """
    def __init__(self, client: AlchemyClient, usd_to_inr: float = DEFAULT_USD_TO_INR):
        self.client = client
        self.usd_to_inr = usd_to_inr

    def parse_transfer_value(self, tx: Dict[str, Any], network: str) -> Tuple[float, int, str]:
        """
        Pillar 4: Decodes exact human-readable value, integer base units, and asset identifier.
        Safely extracts per-contract decimals rather than assuming 18 decimals.
        """
        raw_contract = tx.get("rawContract") or {}
        contract_addr = (raw_contract.get("address") or "").lower()
        asset_symbol = (tx.get("asset") or "ETH").upper()
        
        # 1. Determine exact decimals
        decimals = 18  # default for native ETH / BNB / POL
        
        # Check rawContract decimal or decimals from Alchemy response
        raw_dec = raw_contract.get("decimal") or raw_contract.get("decimals")
        if raw_dec is not None:
            try:
                if isinstance(raw_dec, str) and raw_dec.startswith("0x"):
                    decimals = int(raw_dec, 16)
                else:
                    decimals = int(raw_dec)
            except Exception:
                pass
        elif contract_addr in CANONICAL_TOKENS:
            decimals = CANONICAL_TOKENS[contract_addr]["decimals"]
        elif asset_symbol in ("USDT", "USDC"):
            # If contract unlisted, fallback to standard 6 decimals for EVM USDT/USDC (except BSC)
            decimals = 18 if network == "bnb-mainnet" else 6

        # 2. Integer base units (wei / sun / token base unit)
        raw_val_hex = raw_contract.get("value")
        base_units = 0
        if raw_val_hex:
            try:
                base_units = int(raw_val_hex, 16) if isinstance(raw_val_hex, str) else int(raw_val_hex)
            except Exception:
                base_units = 0
        
        # 3. Calculate human value
        if base_units > 0:
            value = base_units / (10 ** decimals)
        else:
            value = float(tx.get("value") or 0.0)
            base_units = int(Decimal(str(value)) * Decimal(10 ** decimals))

        # Asset identity string (contract address preferred over loose symbol)
        asset_id = contract_addr if contract_addr else asset_symbol
        return value, base_units, asset_id

    def assess_transfer_tier(self, value: float, asset_id: str) -> str:
        """
        Pillar 2: Anti-Poisoning by Tiering.
        Returns:
          - 'ANALYSIS_GRADE': High-priority financial flow (non-zero, above dust).
          - 'DUST': Micro-value transfer (< $0.05), retained in evidence but de-prioritized.
          - 'ZERO_VALUE_POISON': Address poisoning / phishing attempt, persisted with zero weight.
        """
        if value <= 0.0:
            return "ZERO_VALUE_POISON"
        
        # Check if dust value: nominal token dust or fiat-equivalent dust (< $0.05 for USD stablecoins)
        aid_lower = (asset_id or "").lower()
        if any(s in aid_lower for s in ("usdt", "usdc", "dac17f", "a0b869", "55d398", "c2132d", "8ac76a")) and value < 0.05:
            return "DUST"

        if value < 0.0001:
            return "DUST"
            
        return "ANALYSIS_GRADE"

    def verify_token_legitimacy(self, contract_address: str, reported_symbol: str) -> Tuple[bool, str]:
        """
        Pillar 1: Identity by contract address.
        Prevents honeypot / fake token spoofing (e.g. counterfeit 'USDT' tokens).
        """
        if not contract_address:
            # Native gas token (ETH/BNB/POL)
            return True, reported_symbol

        contract_lower = contract_address.lower()
        if contract_lower in CANONICAL_TOKENS:
            canonical_meta = CANONICAL_TOKENS[contract_lower]
            return True, canonical_meta["symbol"]
        
        # If it claims to be USDT/USDC but has wrong contract address -> FAKE / SPOOF
        if reported_symbol.upper() in ("USDT", "USDC", "WBTC", "DAI"):
            return False, f"UNVERIFIED_CLONE_{reported_symbol.upper()}"

        return False, reported_symbol

    def compute_dual_valuation(
        self,
        symbol: str,
        contract_addr: str,
        amount: float,
        network: str,
        crime_timestamp_iso: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Pillar 3: Dual Valuation.
        Computes:
          - Historical FIR Crime Loss (value at time of offence)
          - Live Spot Seizure Quantum (value today under Section 107 BNSS)
          - Equivalent values in INR (₹)
        """
        contract_lower = contract_addr.lower() if contract_addr else ""
        is_canonical, verified_symbol = self.verify_token_legitimacy(contract_lower, symbol)
        
        # 1. Spot Price Calculation
        if not is_canonical and verified_symbol.startswith("UNVERIFIED_CLONE_"):
            spot_unit_usd = 0.0
            historical_unit_usd = 0.0
        elif verified_symbol in ("USDT", "USDC") and is_canonical:
            spot_unit_usd = 1.0
        elif contract_lower:
            price = self.client.get_token_price_by_address(network, contract_lower)
            spot_unit_usd = price if price is not None else (self.client.get_spot_price_by_symbol(verified_symbol) if is_canonical else 0.0)
        else:
            spot_unit_usd = self.client.get_spot_price_by_symbol(verified_symbol)

        spot_total_usd = amount * spot_unit_usd
        spot_total_inr = spot_total_usd * self.usd_to_inr

        # 2. Historical Price Calculation
        if not is_canonical and verified_symbol.startswith("UNVERIFIED_CLONE_"):
            historical_unit_usd = 0.0
        elif crime_timestamp_iso and verified_symbol not in ("USDT", "USDC"):
            historical_unit_usd = self.client.get_historical_price(verified_symbol, crime_timestamp_iso)
        else:
            historical_unit_usd = 1.0 if (verified_symbol in ("USDT", "USDC") and is_canonical) else spot_unit_usd

        historical_total_usd = amount * historical_unit_usd
        historical_total_inr = historical_total_usd * self.usd_to_inr

        return {
            "asset": verified_symbol,
            "is_canonical": is_canonical,
            "contract_address": contract_lower or "NATIVE",
            "amount": amount,
            "spot_unit_usd": spot_unit_usd,
            "spot_total_usd": spot_total_usd,
            "spot_total_inr": spot_total_inr,
            "historical_unit_usd": historical_unit_usd,
            "historical_total_usd": historical_total_usd,
            "historical_total_inr": historical_total_inr,
            "inr_rate_applied": self.usd_to_inr
        }
