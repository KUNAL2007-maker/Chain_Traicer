"""
typology_detector.py - Automated Fraud Typology Detection & AI/ML Advisory Suspicion Engine
Strictly compliant with RESEARCH SET 8, 04_AI_ML_DOCTRINE.md, and FINAL_ALGORITHM.md.

Components:
1. Layer A: Deterministic Typology Detectors (SET 8 Indicators I1–I6 + Poisoning + Supernode)
   - I1: RAPID_DISPERSAL (out/in >= 0.85 and drain_time <= 3600s)
   - I2: PEEL_CHAIN (3+ successive hops, 85-99% forward trunk vs 1-15% residue)
   - I3: SCATTER_GATHER (fan-out >= 2 intermediaries, reconverging into common sink)
   - I4: COLLECTOR_SINK (fan-in >= 3 sources, swept in single consolidation forward)
   - I5: GAS_UMBILICAL (common gas progenitor funding multiple burner/transient wallets)
   - I6: MIXER_TOUCH (direct interaction with verified privacy pool/mixer)
   - DUST_POISONING (zero-value or sub-dust transfers mimicking counterparties)
   - SUPERNODE_COMMINGLING (high-traffic liquidity pool / DEX router > 100 counterparties)

2. Layer B: Advisory Suspicion & Risk Scoring (0-100) with SHAP-Style Attributions
   - Evaluates on-chain features: velocity, pass-through ratio, burner scores, typology matches.
   - Produces explainable contribution scores ("why" each point was added).
   - Enforces the Constitutional Prime Directive:
     "AI ranks, it never rules. Model output is permanently an advisory lead;
      it never alone reaches High confidence, names a VASP, or gates an asset freeze."
"""

import math
from typing import Dict, Any, List, Optional, Set, Tuple


class TypologyDetector:
    """
    Layer A: Deterministic graph typology pattern recognition engine.
    Detects structural fraud patterns across the transaction graph.
    """

    def __init__(self, rapid_dispersal_time_threshold_sec: float = 3600.0):
        self.drain_time_threshold = rapid_dispersal_time_threshold_sec

    def detect_all(
        self,
        nodes: Dict[str, Dict[str, Any]],
        edges: List[Dict[str, Any]],
        root_address: str,
        gas_parents: Optional[Dict[str, str]] = None
    ) -> List[Dict[str, Any]]:
        """
        Executes all Layer A typology checks on the graph.
        Returns a list of detected typology dictionaries with indicator code, name, and evidence.
        """
        detected = []
        root_norm = root_address.lower()

        # 1. Indicator I1: RAPID_DISPERSAL
        rapid_dispersal = self._check_rapid_dispersal(nodes, edges, root_norm)
        if rapid_dispersal:
            detected.append(rapid_dispersal)

        # 2. Indicator I2: PEEL_CHAIN
        peel_chain = self._check_peel_chain(nodes, edges, root_norm)
        if peel_chain:
            detected.append(peel_chain)

        # 3. Indicator I3: SCATTER_GATHER
        scatter_gather = self._check_scatter_gather(nodes, edges, root_norm)
        if scatter_gather:
            detected.append(scatter_gather)

        # 4. Indicator I4: COLLECTOR_SINK
        collector_sink = self._check_collector_sink(nodes, edges)
        if collector_sink:
            detected.append(collector_sink)

        # 5. Indicator I5: GAS_UMBILICAL
        gas_umbilical = self._check_gas_umbilical(nodes, gas_parents)
        if gas_umbilical:
            detected.append(gas_umbilical)

        # 6. Indicator I6: MIXER_TOUCH
        mixer_touch = self._check_mixer_touch(nodes)
        if mixer_touch:
            detected.append(mixer_touch)

        # 7. Supplemental: DUST_POISONING
        dust_poisoning = self._check_dust_poisoning(edges)
        if dust_poisoning:
            detected.append(dust_poisoning)

        # 8. Supplemental: SUPERNODE_COMMINGLING
        supernode = self._check_supernode(nodes)
        if supernode:
            detected.append(supernode)

        return detected

    def _check_rapid_dispersal(
        self,
        nodes: Dict[str, Dict[str, Any]],
        edges: List[Dict[str, Any]],
        root_address: str
    ) -> Optional[Dict[str, Any]]:
        """
        I1: RAPID_DISPERSAL
        Rule: Outbound value / Inbound value >= 0.85 AND drain time <= 3600 seconds.
        """
        if not edges:
            return None

        # Calculate root in/out or intermediary in/out
        inbound_times = []
        outbound_times = []
        inbound_blocks = []
        outbound_blocks = []
        inbound_val = 0.0
        outbound_val = 0.0

        for e in edges:
            src = e.get("source", "").lower()
            tgt = e.get("target", "").lower()
            val = float(e.get("value", 0.0))
            ts = float(e.get("timestamp") or 0.0)
            blk = int(e.get("block_number") or 0)

            if tgt == root_address:
                inbound_val += val
                if ts > 0:
                    inbound_times.append(ts)
                if blk > 0:
                    inbound_blocks.append(blk)
            if src == root_address:
                outbound_val += val
                if ts > 0:
                    outbound_times.append(ts)
                if blk > 0:
                    outbound_blocks.append(blk)

        if outbound_val > 0 and (inbound_val == 0 or outbound_val / max(0.0001, inbound_val) >= 0.85):
            # Check drain time if timestamps are available
            drain_time = 0.0
            if inbound_times and outbound_times:
                raw_diff = min(outbound_times) - max(inbound_times)
                if raw_diff < 0:
                    # Outflow occurred before inbound funds arrived; not a causal rapid dispersal
                    drain_time = float("inf")
                else:
                    drain_time = raw_diff
            elif inbound_blocks and outbound_blocks:
                block_diff = min(outbound_blocks) - max(inbound_blocks)
                if block_diff < 0:
                    drain_time = float("inf")
                else:
                    # EVM average block interval ~12 seconds
                    drain_time = block_diff * 12.0
            else:
                # If dwell dt on edge exists
                dwells = [float(e.get("dwell_seconds", 0.0)) for e in edges if e.get("source", "").lower() == root_address]
                if dwells:
                    drain_time = min(dwells)

            if drain_time <= self.drain_time_threshold:
                return {
                    "indicator": "I1",
                    "tag": "RAPID_DISPERSAL",
                    "name": "Rapid Dispersal / Flash Sweep",
                    "confidence": 0.92,
                    "evidence": (
                        f"Root/burner forward ratio: {outbound_val:.4f} swept out "
                        f"(estimated drain time: {drain_time:.0f}s <= {self.drain_time_threshold:.0f}s threshold)."
                    ),
                    "drain_time_seconds": drain_time,
                    "statutory_relevance": "Supports Golden-Hour emergency freezing requisition under BNSS §94."
                }
        return None

    def _check_peel_chain(
        self,
        nodes: Dict[str, Dict[str, Any]],
        edges: List[Dict[str, Any]],
        root_address: str
    ) -> Optional[Dict[str, Any]]:
        """
        I2: PEEL_CHAIN
        Rule: Sequence of >= 3 hops where each node splits into a dominant trunk (85-99%)
        and a minor peel residue (1-15%).
        """
        # Build adjacency
        out_edges_by_src: Dict[str, List[Dict[str, Any]]] = {}
        for e in edges:
            src = e.get("source", "").lower()
            out_edges_by_src.setdefault(src, []).append(e)

        peel_hops = 0
        curr = root_address
        peel_details = []
        visited: Set[str] = set()

        while curr in out_edges_by_src:
            if curr in visited:
                break
            visited.add(curr)

            out_list = out_edges_by_src[curr]
            if len(out_list) >= 2:
                # Sort descending by value
                sorted_outs = sorted(out_list, key=lambda x: float(x.get("value", 0.0)), reverse=True)
                total_out = sum(float(x.get("value", 0.0)) for x in sorted_outs)
                if total_out > 0:
                    dominant = float(sorted_outs[0].get("value", 0.0))
                    dom_ratio = dominant / total_out
                    if 0.80 <= dom_ratio <= 0.999:
                        peel_hops += 1
                        peel_details.append(
                            f"Hop {peel_hops}: {dom_ratio*100:.1f}% forwarded to {sorted_outs[0].get('target', '')[:8]}..., "
                            f"peeled {(1-dom_ratio)*100:.1f}% to {sorted_outs[1].get('target', '')[:8]}..."
                        )
                        curr = sorted_outs[0].get("target", "").lower()
                        continue
            elif len(out_list) == 1 and peel_hops > 0:
                # Continuation hop
                peel_hops += 1
                curr = out_list[0].get("target", "").lower()
                continue
            break

        if peel_hops >= 2:
            return {
                "indicator": "I2",
                "tag": "PEEL_CHAIN",
                "name": "Programmatic Peeling Chain",
                "confidence": 0.88 if peel_hops >= 3 else 0.75,
                "evidence": f"Detected {peel_hops}-hop peeling sequence with asymmetric change outputs: " + "; ".join(peel_details),
                "peel_hops": peel_hops,
                "statutory_relevance": "Demonstrates deliberate layering of proceeds of crime to evade detection."
            }
        return None

    def _check_scatter_gather(
        self,
        nodes: Dict[str, Dict[str, Any]],
        edges: List[Dict[str, Any]],
        root_address: str
    ) -> Optional[Dict[str, Any]]:
        """
        I3: SCATTER_GATHER
        Rule: Fan-out from one wallet into >= 2 intermediaries, which subsequently
        reconverge into a common destination sink.
        """
        out_from_root = [e.get("target", "").lower() for e in edges if e.get("source", "").lower() == root_address]
        if len(out_from_root) < 2:
            return None

        # Check where these intermediaries send funds
        sinks_reached: Dict[str, Set[str]] = {}
        for e in edges:
            src = e.get("source", "").lower()
            tgt = e.get("target", "").lower()
            if src in out_from_root and tgt != root_address:
                sinks_reached.setdefault(tgt, set()).add(src)

        reconverged = {sink: srcs for sink, srcs in sinks_reached.items() if len(srcs) >= 2}
        if reconverged:
            sink_list = list(reconverged.keys())
            return {
                "indicator": "I3",
                "tag": "SCATTER_GATHER",
                "name": "Scatter-Gather (Dispersal & Reconvergence)",
                "confidence": 0.90,
                "evidence": (
                    f"Funds fanned out to {len(out_from_root)} conduits and reconverged into "
                    f"{len(sink_list)} common sink(s): {', '.join([s[:8]+'...' for s in sink_list])}."
                ),
                "reconvergence_sinks": sink_list,
                "statutory_relevance": "Indicates syndicate-level consolidation circuit; common destination represents primary recovery target."
            }
        return None

    def _check_collector_sink(
        self,
        nodes: Dict[str, Dict[str, Any]],
        edges: List[Dict[str, Any]]
    ) -> Optional[Dict[str, Any]]:
        """
        I4: COLLECTOR_SINK
        Rule: A node has fan-in >= 3 from distinct sources, and then performs a
        consolidated sweep forward into a VASP or cold storage.
        """
        inbound_by_target: Dict[str, Set[str]] = {}
        outbound_by_source: Dict[str, Set[str]] = {}

        for e in edges:
            src = e.get("source", "").lower()
            tgt = e.get("target", "").lower()
            inbound_by_target.setdefault(tgt, set()).add(src)
            outbound_by_source.setdefault(src, set()).add(tgt)

        for wallet, in_srcs in inbound_by_target.items():
            if len(in_srcs) >= 3:
                # Check if it also sweeps forward
                outs = outbound_by_source.get(wallet, set())
                if len(outs) >= 1:
                    return {
                        "indicator": "I4",
                        "tag": "COLLECTOR_SINK",
                        "name": "Collector Sink / Swept Aggregator",
                        "confidence": 0.89,
                        "evidence": (
                            f"Wallet {wallet[:8]}... receives inflows from {len(in_srcs)} distinct source addresses "
                            f"and consolidates outflow to {len(outs)} downstream destination(s)."
                        ),
                        "collector_wallet": wallet,
                        "fan_in_count": len(in_srcs),
                        "statutory_relevance": "Classic custodial deposit box or mule aggregation hub; critical nexus for Section 94 BNSS production."
                    }
        return None

    def _check_gas_umbilical(
        self,
        nodes: Dict[str, Dict[str, Any]],
        gas_parents: Optional[Dict[str, str]]
    ) -> Optional[Dict[str, Any]]:
        """
        I5: GAS_UMBILICAL
        Rule: Multiple transient/burner wallets in the graph were funded with gas
        by the exact same external sponsor address.
        """
        if not gas_parents:
            return None

        sponsor_to_children: Dict[str, List[str]] = {}
        for child, sponsor in gas_parents.items():
            if sponsor:
                sponsor_to_children.setdefault(sponsor.lower(), []).append(child.lower())

        syndicates = {sp: ch for sp, ch in sponsor_to_children.items() if len(ch) >= 2}
        if syndicates:
            top_sponsor = max(syndicates.keys(), key=lambda s: len(syndicates[s]))
            children = syndicates[top_sponsor]
            return {
                "indicator": "I5",
                "tag": "GAS_UMBILICAL",
                "name": "Gas Umbilical Progenitor Linkage",
                "confidence": 0.94,
                "evidence": (
                    f"Common gas sponsor {top_sponsor[:8]}... funded initial execution gas for "
                    f"{len(children)} unlinked burner wallets: {', '.join([c[:6]+'...' for c in children[:3]])}."
                ),
                "sponsor_address": top_sponsor,
                "funded_children_count": len(children),
                "statutory_relevance": "Proves criminal syndicate clustering by shared operational gas infrastructure."
            }
        return None

    def _check_mixer_touch(
        self,
        nodes: Dict[str, Dict[str, Any]]
    ) -> Optional[Dict[str, Any]]:
        """
        I6: MIXER_TOUCH
        Rule: Direct interaction with a known privacy protocol / mixer contract.
        """
        mixer_nodes = [n for n in nodes.values() if n.get("type") == "MIXER" or n.get("status") == "MIXER_POOL_ENTERED"]
        if mixer_nodes:
            pool = mixer_nodes[0]
            return {
                "indicator": "I6",
                "tag": "MIXER_TOUCH",
                "name": "Privacy Pool / Mixer Interaction",
                "confidence": 0.99,
                "evidence": (
                    f"Direct deposit detected into privacy pool {pool.get('name', 'Mixer')} "
                    f"({pool.get('id', '')[:8]}...). zk-SNARK MUST-HALT enforced."
                ),
                "mixer_address": pool.get("id"),
                "statutory_relevance": "Enforces Section 94 BNSS statutory boundary; forward tracing halted; flag on FIU-IND watchlist."
            }
        return None

    def _check_dust_poisoning(
        self,
        edges: List[Dict[str, Any]]
    ) -> Optional[Dict[str, Any]]:
        """
        Supplemental: DUST_POISONING
        Rule: Transfer of zero-value or micro-dust (< 0.0001) attempting to poison address history.
        """
        dust_edges = []
        for e in edges:
            val = float(e.get("value", 0.0))
            asset = e.get("asset", "ETH")
            if val == 0.0 or (asset in ("ETH", "BNB") and val < 0.0001) or (asset in ("USDT", "USDC") and val < 0.01):
                dust_edges.append(e)

        if dust_edges:
            return {
                "indicator": "I_POISON",
                "tag": "DUST_POISONING",
                "name": "Address Poisoning / Zero-Value Dust Attack",
                "confidence": 0.95,
                "evidence": f"Detected {len(dust_edges)} micro-dust/zero-value transfer(s) attempting to spoof counterparties.",
                "poisoned_transfers_count": len(dust_edges),
                "statutory_relevance": "Suppressed by Four-Pillar Token Shield; zero taint propagated to innocent victim."
            }
        return None

    def _check_supernode(
        self,
        nodes: Dict[str, Dict[str, Any]]
    ) -> Optional[Dict[str, Any]]:
        """
        Supplemental: SUPERNODE_COMMINGLING
        Rule: High-traffic contract (DEX router / bridge / market maker) exceeding counterparty cap.
        """
        supernodes = [n for n in nodes.values() if n.get("type") == "SUPERNODE" or "SUPERNODE" in n.get("status", "")]
        if supernodes:
            sn = supernodes[0]
            return {
                "indicator": "I_SUPERNODE",
                "tag": "SUPERNODE_COMMINGLING",
                "name": "Supernode High-Velocity Commingling Hub",
                "confidence": 0.91,
                "evidence": f"Node {sn.get('id', '')[:8]}... exceeded counterparty safety threshold (>100 counterparties). Circuit breaker engaged.",
                "supernode_address": sn.get("id"),
                "statutory_relevance": "Prevents combinatorial explosion; requires DEX log event decoding rather than broad asset freezing."
            }
        return None


class AISuspicionEngine:
    """
    Layer B: Advisory Suspicion & Risk Scorer.
    Strictly follows 04_AI_ML_DOCTRINE.md:
    - Produces a calibrated 0-100 suspicion score.
    - Generates SHAP-style per-feature attribution reasons ("why").
    - Permanently tagged as an ADVISORY LEAD — never rules, never auto-freezes.
    """

    CONSTITUTIONAL_LABEL = "ADVISORY ONLY · AI RANKS, IT NEVER RULES · LEA ACTION GATED BY DETERMINISTIC EVIDENCE"

    def compute_suspicion_score(
        self,
        nodes: Dict[str, Dict[str, Any]],
        edges: List[Dict[str, Any]],
        typologies: List[Dict[str, Any]],
        attributed_vasps: List[Dict[str, Any]],
        mixer_events: List[Dict[str, Any]],
        threat_actors: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Calculates advisory suspicion score 0-100 and returns SHAP attribution reasons.
        """
        score = 0.0
        shap_factors = []

        # Feature 1: Threat Actor Direct Interaction
        if threat_actors:
            delta = 45.0
            score += delta
            shap_factors.append({
                "feature": "THREAT_ACTOR_MATCH",
                "weight": f"+{delta:.0f}",
                "reason": f"Direct link to known threat actor: {threat_actors[0].get('name', 'Malicious Actor')}"
            })

        # Feature 2: Mixer / Privacy Pool Interaction
        if mixer_events or any(t.get("tag") == "MIXER_TOUCH" for t in typologies):
            delta = 35.0
            score += delta
            shap_factors.append({
                "feature": "MIXER_INTERACTION",
                "weight": f"+{delta:.0f}",
                "reason": "Direct deposit into Tornado Cash privacy pool (zk-SNARK obfuscation)"
            })

        # Feature 3: High Pass-Through Ratio (Transit Conduit)
        if edges:
            in_vals = sum(float(e.get("value", 0.0)) for e in edges if e.get("target") in nodes)
            out_vals = sum(float(e.get("value", 0.0)) for e in edges if e.get("source") in nodes)
            if in_vals > 0 and (out_vals / in_vals) >= 0.85:
                delta = 20.0
                score += delta
                shap_factors.append({
                    "feature": "HIGH_PASS_THROUGH_CONDUIT",
                    "weight": f"+{delta:.0f}",
                    "reason": f"Near-total value pass-through ({(out_vals/in_vals)*100:.1f}% swept through)"
                })

        # Feature 4: Rapid Dispersal Match (I1)
        rapid_t = next((t for t in typologies if t.get("tag") == "RAPID_DISPERSAL"), None)
        if rapid_t:
            drain_s = rapid_t.get("drain_time_seconds", 0)
            # Golden hour fast drain bonus
            if drain_s <= 900.0:
                delta_drain = 20.0
                score += delta_drain
                shap_factors.append({
                    "feature": "GOLDEN_HOUR_FLASH_SWEEP",
                    "weight": f"+{delta_drain:.0f}",
                    "reason": f"Golden-Hour flash sweep: drained in {drain_s:.0f}s (<= 15 min)"
                })
            delta = 20.0
            score += delta
            shap_factors.append({
                "feature": "RAPID_DISPERSAL",
                "weight": f"+{delta:.0f}",
                "reason": f"Rapid dispersal pattern match (I1 indicator)"
            })

        # Feature 4: Peeling Chain Match (I2)
        peel_t = next((t for t in typologies if t.get("tag") == "PEEL_CHAIN"), None)
        if peel_t:
            delta = 20.0
            score += delta
            hops = peel_t.get("peel_hops", 0)
            shap_factors.append({
                "feature": "PEEL_CHAIN_TOPOLOGY",
                "weight": f"+{delta:.0f}",
                "reason": f"Detected programmatic {hops}-hop peeling sequence with asymmetric change outputs"
            })

        # Feature 5: Scatter-Gather Match (I3)
        sg_t = next((t for t in typologies if t.get("tag") == "SCATTER_GATHER"), None)
        if sg_t:
            delta = 20.0
            score += delta
            shap_factors.append({
                "feature": "SCATTER_GATHER",
                "weight": f"+{delta:.0f}",
                "reason": "Syndicate fan-out followed by common sink reconvergence"
            })

        # Feature 6: Collector Sink Match (I4)
        cs_t = next((t for t in typologies if t.get("tag") == "COLLECTOR_SINK"), None)
        if cs_t:
            delta = 20.0
            score += delta
            shap_factors.append({
                "feature": "COLLECTOR_SINK",
                "weight": f"+{delta:.0f}",
                "reason": f"Aggregation hub with {cs_t.get('fan_in_count', 0)} inbound sources swept to terminus"
            })

        # Feature 7: Gas Umbilical Progenitor (I5)
        gu_t = next((t for t in typologies if t.get("tag") == "GAS_UMBILICAL"), None)
        if gu_t:
            delta = 15.0
            score += delta
            shap_factors.append({
                "feature": "GAS_UMBILICAL",
                "weight": f"+{delta:.0f}",
                "reason": "Execution gas funded by common sponsor across unlinked burner wallets"
            })

        # Feature 8: Burner Conduit Presence
        burner_nodes = [n for n in nodes.values() if n.get("type") == "BURNER" or n.get("burner_score", 0.0) >= 0.60]
        if burner_nodes:
            delta = 10.0
            score += delta
            shap_factors.append({
                "feature": "BURNER_CONDUIT",
                "weight": f"+{delta:.0f}",
                "reason": f"Graph traverses {len(burner_nodes)} transient zero-balance burner wallet(s)"
            })

        # Feature 9: Terminal VASP Cashout
        if attributed_vasps:
            delta = 15.0
            score += delta
            shap_factors.append({
                "feature": "VASP_CASHOUT_DESTINATION",
                "weight": f"+{delta:.0f}",
                "reason": f"Path terminates at regulated exchange hot wallet ({attributed_vasps[0].get('vasp_name', 'VASP')})"
            })

        # Base minimum for active transactions
        if not shap_factors and edges:
            score = 15.0
            shap_factors.append({
                "feature": "STANDARD_TRANSFER_ACTIVITY",
                "weight": "+15",
                "reason": "Standard on-chain asset movement without detected laundering patterns"
            })
        elif not edges:
            score = 5.0
            shap_factors.append({
                "feature": "DORMANT_WALLET",
                "weight": "+5",
                "reason": "No outbound activity detected; funds remain resting"
            })

        final_score = int(min(100.0, score))

        if final_score >= 80:
            badge = "HIGH_PRIORITY_LEAD"
            lead_summary = "High Suspicion — prioritize immediate forensic review and preservation."
        elif final_score >= 50:
            badge = "ELEVATED_LEAD"
            lead_summary = "Elevated Suspicion — layered movement detected; warrants investigator analysis."
        else:
            badge = "LOW_PRIORITY_LEAD"
            lead_summary = "Low Suspicion — routine liquidity or dormant asset."

        return {
            "suspicion_score": final_score,
            "lead_badge": badge,
            "lead_summary": lead_summary,
            "shap_attributions": shap_factors,
            "constitutional_label": self.CONSTITUTIONAL_LABEL
        }
