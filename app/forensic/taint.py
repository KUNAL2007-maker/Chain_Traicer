"""
taint.py - Dual-Model Taint Accounting Engine (FIFO Court Ledger + Haircut UI Meter)
Strictly compliant with FINAL_ALGORITHM.md §8 (Step 6) & RESEARCH SET 2.

Core components:
1. FIFO Master Court Ledger: Full interval-overlap algorithm with deterministic
   (blockNumber, transactionIndex, logIndex) tie-breaking and clean pre-crime balance seeding.
2. Haircut (Pro-Rata) UI Risk Meter: Used exclusively for visual node color gradient.
3. Poison Model: Explicitly BANNED per §8.3 to protect innocent citizens from false freezes.
"""

from typing import List, Dict, Any, Tuple, Optional
from dataclasses import dataclass
import logging

logger = logging.getLogger("TaintEngine")


@dataclass
class TaintLot:
    """Represents an enqueued inflow value interval on the accounting axis."""
    lot_id: str
    asset: str
    start_axis: float  # Cumulative inflow start [a
    end_axis: float    # Cumulative inflow end     b]
    amount: float      # b - a
    taint_ratio: float # 0.0 (clean) to 1.0 (fully tainted)
    source_tx_hash: str
    block_number: int
    tx_index: int
    log_index: int


@dataclass
class TaintAllocation:
    """Represents the attribution of an outflow against an inflow lot."""
    lot_id: str
    consumed_amount: float
    tainted_amount: float
    lot_source_tx: str


class FIFOLedger:
    """
    Court-Admissible First-In, First-Out (FIFO) Taint Accounting Engine.
    Executes the interval-overlap formula:
      consumed(lot_i, out_j) = max(0, min(b, d) - max(a, c))
    """
    def __init__(self, asset: str, pre_crime_clean_balance: float = 0.0):
        self.asset = asset
        self.lots: List[TaintLot] = []
        self.cumulative_inflow: float = 0.0
        self.cumulative_outflow: float = 0.0
        self.outflow_history: List[Dict[str, Any]] = []

        # Seed pre-existing balance as a clean lot (T = 0.0)
        if pre_crime_clean_balance > 0.0:
            self.enqueue_inflow(
                amount=pre_crime_clean_balance,
                taint_ratio=0.0,
                tx_hash="PRE_CRIME_BALANCE_B0",
                block_number=0,
                tx_index=0,
                log_index=0
            )

    def enqueue_inflow(
        self,
        amount: float,
        taint_ratio: float,
        tx_hash: str,
        block_number: int,
        tx_index: int,
        log_index: int
    ) -> Optional[TaintLot]:
        """Enqueues an incoming transfer as an immutable lot on the cumulative inflow axis."""
        if amount <= 0:
            return None
            
        start_axis = self.cumulative_inflow
        end_axis = self.cumulative_inflow + amount
        self.cumulative_inflow = end_axis
        
        lot = TaintLot(
            lot_id=f"LOT_{len(self.lots) + 1}_{tx_hash[:10]}",
            asset=self.asset,
            start_axis=start_axis,
            end_axis=end_axis,
            amount=amount,
            taint_ratio=max(0.0, min(1.0, taint_ratio)),
            source_tx_hash=tx_hash,
            block_number=block_number,
            tx_index=tx_index,
            log_index=log_index
        )
        self.lots.append(lot)
        return lot

    def process_outflow(
        self,
        amount: float,
        tx_hash: str,
        block_number: int,
        tx_index: int,
        log_index: int
    ) -> Tuple[float, float, List[TaintAllocation]]:
        """
        Consumes the inflow-axis interval [c, d] using the exact interval overlap formula.
        Returns:
          (tainted_amount, effective_taint_ratio, allocations)
        """
        if amount <= 0:
            return 0.0, 0.0, []

        c = self.cumulative_outflow
        d = self.cumulative_outflow + amount
        self.cumulative_outflow = d

        allocations: List[TaintAllocation] = []
        total_tainted_consumed = 0.0

        for lot in self.lots:
            a = lot.start_axis
            b = lot.end_axis

            # SET 2 & FINAL_ALGORITHM.md §8.1: Interval Overlap Formula
            overlap = max(0.0, min(b, d) - max(a, c))
            if overlap > 0.0:
                tainted_portion = overlap * lot.taint_ratio
                total_tainted_consumed += tainted_portion
                allocations.append(TaintAllocation(
                    lot_id=lot.lot_id,
                    consumed_amount=overlap,
                    tainted_amount=tainted_portion,
                    lot_source_tx=lot.source_tx_hash
                ))

        effective_taint_ratio = total_tainted_consumed / amount if amount > 0 else 0.0
        
        # Track unconstrained outflow overrun as an evidence gap
        evidence_gap = max(0.0, d - self.cumulative_inflow)

        record = {
            "tx_hash": tx_hash,
            "block_number": block_number,
            "tx_index": tx_index,
            "log_index": log_index,
            "amount": amount,
            "tainted_amount": total_tainted_consumed,
            "taint_ratio": effective_taint_ratio,
            "unaccounted_evidence_gap": evidence_gap,
            "allocations": [
                {
                    "lot_id": a.lot_id,
                    "consumed": a.consumed_amount,
                    "tainted": a.tainted_amount,
                    "source_tx": a.lot_source_tx
                }
                for a in allocations
            ]
        }
        self.outflow_history.append(record)
        return total_tainted_consumed, effective_taint_ratio, allocations


class HaircutRiskMeter:
    """
    Pro-Rata / Haircut Taint Model.
    Calculates: tau_Tx = sum(T(u) * V(u)) / V_in
    STRICT COMPLIANCE NOTICE: Used ONLY to compute visual risk scores for the Cytoscape graph.
    Never used as statutory court quantum.
    """
    @staticmethod
    def compute_node_taint(inbound_flows: List[Dict[str, Any]]) -> float:
        """
        Calculates pro-rata taint score (0.0 to 1.0) based on weighted inbound flows.
        """
        if not inbound_flows:
            return 0.0
        
        total_volume = 0.0
        tainted_volume = 0.0
        
        for flow in inbound_flows:
            val = float(flow.get("value", 0.0))
            taint = float(flow.get("taint_ratio", 0.0))
            total_volume += val
            tainted_volume += val * taint
            
        if total_volume <= 0.0:
            return 0.0
            
        return min(1.0, max(0.0, tainted_volume / total_volume))

    @staticmethod
    def get_color_gradient(taint_ratio: float) -> str:
        """Returns Cytoscape node hex color based on haircut risk percentage."""
        pct = int(taint_ratio * 100)
        if pct >= 80:
            return "#ff3344"  # Critical red
        elif pct >= 50:
            return "#ff9900"  # High orange
        elif pct >= 20:
            return "#ffcc00"  # Moderate yellow
        elif pct > 0:
            return "#3399ff"  # Low blue
        return "#44bb66"      # Clean green
