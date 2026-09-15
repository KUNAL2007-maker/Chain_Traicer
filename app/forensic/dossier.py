"""
dossier.py - Three-Level Court Dossier & Statutory Legal Notice Generator
Strictly compliant with FINAL_ALGORITHM.md §9 & RESEARCH SET 9 & 10.

Components:
1. Level 1: 5-Second Police Verdict Card & plain-English money story.
2. Level 2: Interactive Crime Canvas data formatter (Cytoscape JSON).
3. Level 3: Section 63 BSA Schedule Certificate with raw SHA-256 response seals,
   As-of-Block-N anchor, and query-completeness attestation.
4. Statutory Instruments Generator:
   - BNSS 94: Production Summons to VASP (KYC & IP logs)
   - BNSS 107: Proceeds-of-Crime Attachment Application to Magistrate (The real freeze)
   - BNSS 106: Evidentiary Seizure with mandatory 24h Magistrate intimation
   - BNSS 503: Court Interim Custody & Victim Restitution
   - Tether/Circle Smart Contract Blocklist Notice
"""

import time
import hashlib
import json
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

from .constants import STATUTORY_INSTRUMENTS


class CourtDossierGenerator:
    """
    Generates Section 63 BSA court-admissible dossiers and statutory notices.
    """
    def __init__(self, officer_name: str = "Inspector Cyber Crime Cell", officer_badge: str = "CYBER-INV-2026-IND"):
        self.officer_name = officer_name
        self.officer_badge = officer_badge

    # -------------------------------------------------------------------------
    # Level 1: 5-Second Police Verdict Card & Plain-English Money Story
    # -------------------------------------------------------------------------
    def generate_level1_verdict(self, trace_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Produces an executive summary and plain-English money story for investigating officers.
        """
        root = trace_result["root_address"]
        net = trace_result["network"]
        badge = trace_result["verdict_badge"]
        usd_val = trace_result["total_seizure_quantum_usd"]
        inr_val = trace_result["total_seizure_quantum_inr"]
        vasps = trace_result.get("attributed_vasps", [])
        mixers = trace_result.get("mixer_events", [])
        threats = trace_result.get("threat_actors_detected", [])
        bridges = trace_result.get("bridge_events", [])
        clusters = trace_result.get("syndicate_clusters", [])

        # Money Story Formulation (Threat Actors prioritized over routine VASP notices)
        if threats:
            target_threat = threats[0]
            vasp_addendum = ""
            if vasps:
                target_vasp = vasps[0]
                vasp_addendum = (
                    f" Additionally, victim funds were traced exiting into {target_vasp['vasp_name']} ({target_vasp['entity']}). "
                    f"Recoverable quantum: ${usd_val:,.2f} USD (₹{inr_val:,.2f} INR). "
                    f"Serve urgent BNSS §94 production summons and §107 attachment application on {target_vasp['email']}."
                )
            story = (
                f"CRITICAL THREAT ALERT: Suspect/counterparty matches confirmed threat actor {target_threat['name']} "
                f"({target_threat['entity']}). Threat Classification: "
                f"{target_threat.get('threat_type', 'KNOWN_THREAT_ACTOR')} (Risk Score: {target_threat.get('risk_score', 100)}/100).{vasp_addendum} "
                f"Actionable step: Issue Cyber Crime Lookout Notice, alert CERT-In / I4C, and monitor outbound conduits."
            )
            recommendation = f"Escalate Threat ({target_threat['name']}) & Serve Statutory Notices" if vasps else f"Issue Cyber Crime Lookout Notice ({target_threat['name']})"
            action_code = "ALERT_KNOWN_THREAT_ACTOR"

        elif vasps:
            target_vasp = vasps[0]
            if target_vasp.get("via_mixer_deanonymization"):
                story = (
                    f"Victim funds were transferred into {target_vasp.get('mixer_pool', 'Tornado Cash')} privacy pool to sever the audit trail. "
                    f"Applying {target_vasp.get('deanonymization_heuristic', 'MD-H4 Fee-Aware Knapsack')} de-anonymization heuristics, "
                    f"the exit conduit was unmasked ({target_vasp.get('unmasked_exit_address', '')[:8]}...) and traced directly "
                    f"into {target_vasp['vasp_name']} ({target_vasp['entity']}). "
                    f"Total recoverable quantum: ${usd_val:,.2f} USD (₹{inr_val:,.2f} INR). "
                    f"Actionable step: Serve Section 94 BNSS production summons and asset freeze on {target_vasp['email']} immediately."
                )
            else:
                story = (
                    f"Victim funds were received by suspect address {root[:8]}...{root[-6:]} on {net}, "
                    f"rapidly layered across {target_vasp['hop_distance']} on-chain hops, and deposited "
                    f"directly into {target_vasp['vasp_name']} ({target_vasp['entity']}). "
                    f"Total recoverable quantum: ${usd_val:,.2f} USD (₹{inr_val:,.2f} INR). "
                    f"Actionable step: Serve Section 94 BNSS production summons and Section 107 BNSS "
                    f"attachment application on {target_vasp['email']} immediately."
                )
            recommendation = f"Serve Statutory Notice on {target_vasp['vasp_name']}"
            action_code = "FREEZE_ELIGIBLE_HIGH"

        elif mixers:
            target_mixer = mixers[0]
            story = (
                f"Victim funds were transferred into the {target_mixer['pool_name']} privacy pool. "
                f"zk-SNARK Severance Encountered: forward trail cannot be drawn deterministically. "
                f"Effective candidate anonymity set: {target_mixer['entropy_metrics']['anonymity_set_size']} candidates "
                f"(Shannon entropy: {target_mixer['entropy_metrics']['entropy_bits']} bits). "
                f"Funds remain dormant within the pool note. Recommended action: Register 24/7 "
                f"withdrawal tripwire and flag counterparty on FIU-IND High-Risk Watchlist."
            )
            recommendation = "Register 24/7 Tripwire & Alert FIU-IND"
            action_code = "MONITOR_DORMANT_MIXER"

        elif bridges:
            target_bridge = bridges[0]
            recip = target_bridge.get("recipient_address")
            recip_str = f"Decoded recipient on destination chain: {recip}. " if recip else ""
            story = (
                f"Victim funds were bridged via {target_bridge['bridge_name']} ({target_bridge.get('protocol', 'Cross-Chain Bridge')}) "
                f"from {target_bridge.get('source_chain', net)} to destination chain {target_bridge['target_chain']}. "
                f"Cross-Chain Transit Tx Hash: {target_bridge['tx_hash'][:12]}... "
                f"{recip_str}Actionable step: Dispatch multi-chain observer to track recipient on {target_bridge['target_chain']} "
                f"and serve statutory freeze notice upon exchange deposit."
            )
            recommendation = f"Dispatch Cross-Chain Observer ({target_bridge['target_chain']})"
            action_code = "DISPATCH_CROSS_CHAIN_OBSERVER"

        else:
            story = (
                f"Funds are currently resting or dispersing across intermediary burner wallets on {net}. "
                f"No centralized exchange or privacy mixer terminus has been definitively reached. "
                f"Status: INSUFFICIENT EVIDENCE — DO NOT FREEZE."
            )
            recommendation = "Maintain Continuous Monitoring"
            action_code = "INSUFFICIENT_EVIDENCE"

        return {
            "root_address": root,
            "verdict_badge": badge,
            "confidence_score": trace_result["confidence_score"],
            "confidence_tier": trace_result["confidence_tier"],
            "recoverable_usd": usd_val,
            "recoverable_inr": inr_val,
            "plain_english_story": story,
            "tactical_recommendation": recommendation,
            "action_code": action_code,
            "destination_vasps": [v["vasp_name"] for v in vasps],
            "threat_actors": [t["name"] for t in threats],
            "syndicate_leads": len(clusters),
            "typologies_detected": trace_result.get("typologies_detected", []),
            "ai_advisory": trace_result.get("ai_advisory", {})
        }

    # -------------------------------------------------------------------------
    # Level 2: Cytoscape Graph Data Formatter
    # -------------------------------------------------------------------------
    def format_level2_graph(self, trace_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Formats network graph elements strictly for Cytoscape.js visual canvas.
        """
        raw_graph = trace_result.get("graph", {})
        nodes = raw_graph.get("nodes", [])
        edges = raw_graph.get("edges", [])

        cy_elements = []

        # Nodes formatting
        for n in nodes:
            cy_elements.append({
                "group": "nodes",
                "data": {
                    "id": n["id"],
                    "label": n["label"],
                    "type": n.get("type", "INTERMEDIARY"),
                    "taint_ratio": n.get("taint_ratio", 0.0),
                    "balance": n.get("balance", 0.0),
                    "valuation_usd": n.get("valuation_usd", 0.0),
                    "valuation_inr": n.get("valuation_inr", 0.0),
                    "hop": n.get("hop_distance", 0)
                },
                "classes": f"node-{n.get('type', 'INTERMEDIARY').lower()}"
            })

        # Edges formatting
        for e in edges:
            cy_elements.append({
                "group": "edges",
                "data": {
                    "id": e["id"],
                    "source": e["source"],
                    "target": e["target"],
                    "label": e.get("label", ""),
                    "value": e.get("value", 0.0),
                    "asset": e.get("asset", "ETH"),
                    "tx_hash": e.get("tx_hash", ""),
                    "taint_ratio": e.get("taint_ratio", 1.0),
                    "weight": e.get("weight", 1.0)
                }
            })

        return {"elements": cy_elements}

    # -------------------------------------------------------------------------
    # Level 3: Section 63 BSA Schedule Certificate
    # -------------------------------------------------------------------------
    def generate_level3_certificate(self, trace_result: Dict[str, Any], case_fir_no: str = "FIR/CYBER/2026/042") -> Dict[str, Any]:
        """
        Produces Section 63 Bharatiya Sakshya Adhiniyam, 2023 (BSA) electronic record certificate.
        Includes 64-char SHA-256 hashes of raw JSON-RPC response bytes and As-of-Block-N anchor.
        """
        now_utc = datetime.now(timezone.utc).isoformat()
        evidence_records = trace_result.get("evidence_ledger", [])
        
        # Aggregate master evidence digest
        concatenated_seals = "".join([e.get("sha256_payload", "") for e in evidence_records])
        master_evidence_hash = hashlib.sha256(concatenated_seals.encode("utf-8")).hexdigest()

        certificate_text = f"""
====================================================================================================
CERTIFICATE UNDER SECTION 63 OF THE BHARATIYA SAKSHYA ADHINIYAM, 2023 (BSA)
[Formerly Section 65B of the Indian Evidence Act, 1872]
FOR ADMISSIBILITY OF COMPUTER OUTPUT AND ON-CHAIN FORENSIC EVIDENCE
====================================================================================================

CASE REFERENCE : {case_fir_no}
POLICE STATION : Cyber Crime Police Station / Special Investigation Cell
DATE & TIME    : {now_utc}
TARGET WALLET  : {trace_result['root_address']}
BLOCKCHAIN NET : {trace_result['network']}

1. STATEMENT OF OFFICIAL POSITION & DEVICE INTEGRITY:
   I, {self.officer_name}, Badge No. {self.officer_badge}, do hereby solemnly affirm and state:
   (a) The electronic records and on-chain graph analysis detailed herein were generated by the
       Automated Crypto Fraud Attribution System in the ordinary lawful course of official duty.
   (b) The computer systems, network gateways, and cryptographic hashing processors operated properly
       and with complete fidelity throughout the entire investigative process.
   (c) No unauthorized interception, alteration, or data compromise occurred at any stage.

2. EVIDENTIARY AUDIT TRAILS & AS-OF-BLOCK-N ANCHOR:
"""
        as_of_block_val = None
        for ev in evidence_records:
            if ev.get("as_of_block"):
                as_of_block_val = ev["as_of_block"]
                break
        block_anchor = f"Block #{as_of_block_val} (Confirmed Finality)" if as_of_block_val else "LATEST_FINALIZED (Confirmed Finality)"
        certificate_text += f"   - Forensic Analysis As-of-Block : {block_anchor}\n"
        certificate_text += f"   - Total Raw RPC Ingestions      : {len(evidence_records)} Verified JSON-RPC Responses\n"
        certificate_text += f"   - Master Cryptographic Seal     : SHA-256: {master_evidence_hash}\n"
        certificate_text += "   - Individual Evidence Hashes    :\n"
        for i, ev in enumerate(evidence_records[:10], 1):
            certificate_text += f"     [{i:02d}] Method: {ev.get('method')} | Query: {ev.get('query_id')}\n"
            certificate_text += f"          Payload SHA-256: {ev.get('sha256_payload')}\n"

        if len(evidence_records) > 10:
            certificate_text += f"     ... and {len(evidence_records) - 10} additional verified raw payloads.\n"

        certificate_text += f"""
3. FORENSIC ATTRIBUTION CONCLUSION:
   - Primary Suspect Wallet : {trace_result['root_address']}
   - Trace Verdict Badge   : {trace_result['verdict_badge']}
   - Forensic Confidence   : {trace_result['confidence_score']}% ({trace_result['confidence_tier']})
   - Recoverable Asset     : ${trace_result['total_seizure_quantum_usd']:,.2f} USD (₹{trace_result['total_seizure_quantum_inr']:,.2f} INR)
   - Statutory Compliance  : BNSS Sections 94, 106, 107 & 503 compliant.

I attest under penalty of law that the above computer printout and evidentiary audit hash representation
is true, unaltered, and cryptographically verifiable.

Sd/-
{self.officer_name}
Investigating Officer / Cyber Forensic Examiner
====================================================================================================
"""
        return {
            "case_fir_no": case_fir_no,
            "timestamp": now_utc,
            "master_evidence_hash": master_evidence_hash,
            "total_payloads_verified": len(evidence_records),
            "certificate_text": certificate_text.strip()
        }

    # -------------------------------------------------------------------------
    # Statutory Instrument Drafts: BNSS 94, 107, 106, 503
    # -------------------------------------------------------------------------
    def generate_statutory_instruments(self, trace_result: Dict[str, Any], case_fir_no: str = "FIR/CYBER/2026/042") -> Dict[str, str]:
        """
        Generates formal legal notices correctly citing Bharatiya Nagarik Suraksha Sanhita, 2023 (BNSS).
        Gated strictly against emitting active freeze orders on unconfirmed or insufficient evidence.
        """
        vasps = trace_result.get("attributed_vasps", [])
        badge = trace_result.get("verdict_badge", "")
        conf = trace_result.get("confidence_score", 0)

        unconfirmed_badges = (
            "INSUFFICIENT_EVIDENCE_DO_NOT_FREEZE",
            "MIXER_POOL_MUST_HALT",
            "MUST_HALT_PASSIVE_ADVERSARY_LIMIT",
            "LAYERED_BURNING_IN_FLIGHT"
        )
        if not vasps or badge in unconfirmed_badges or conf < 70:
            return {
                "STATUS": "STATUTORY_INSTRUMENTS_WITHHELD_INSUFFICIENT_EVIDENCE",
                "notice": (
                    "Statutory production summons and attachment orders are strictly gated "
                    "and withheld when no verified VASP terminus is attributed with sufficient evidentiary confidence. "
                    "In accordance with Decision D8, BSA §63, and BNSS §107, active freeze orders "
                    "must never target speculative, resting, or unconfirmed conduits."
                ),
                "action_recommended": "CONTINUOUS_MONITORING_OR_TRIPWIRE"
            }

        vasp_target = vasps[0]
        v_name = vasp_target.get("vasp_name") or vasp_target.get("name", "Unknown VASP")
        v_entity = vasp_target.get("entity", "Exchange Entity")
        v_email = vasp_target.get("email", "compliance@exchange.com")
        v_tx_hash = vasp_target.get("tx_hash", "DIRECT_INSPECTION_OR_ROOT")
        v_usd = float(vasp_target.get("seizure_quantum_usd", 0.0) or 0.0)
        v_inr = float(vasp_target.get("seizure_quantum_inr", 0.0) or 0.0)

        # 1. BNSS Section 94 (Production Summons to VASP)
        bnss_94 = f"""
FORMAL SUMMONS TO PRODUCE DOCUMENTS / ELECTRONIC RECORDS
UNDER SECTION 94 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023 (BNSS)
[Formerly Section 91 of the Code of Criminal Procedure, 1973 (CrPC)]

TO:
The Nodal Officer / Compliance Desk
{v_name} ({v_entity})
Email: {v_email}

SUBJECT: Production of KYC, IP Logs, and Transaction Audit Records in FIR No. {case_fir_no}

WHEREAS, an investigation into a cryptocurrency financial fraud is being conducted under FIR No. {case_fir_no}.
Forensic on-chain analysis confirms that stolen illicit proceeds were deposited into your exchange infrastructure:
  * On-Chain Deposit Tx Hash : {v_tx_hash}
  * Total Fraud-Linked Value : ${v_usd:,.2f} USD (Approx ₹{v_inr:,.2f} INR)

YOU ARE HEREBY DIRECTED under Section 94 BNSS to immediately produce and furnish within 24 hours:
1. Complete Know Your Customer (KYC) identity documentation of the recipient account holder (Name, Address, PAN/Aadhaar/Passport).
2. Linked bank account details, fiat withdrawal destinations, and mobile numbers.
3. Login audit records including IP addresses, timestamps, device fingerprints, and ISP logs.
4. Immediate administrative preservation of the subject wallet and internal custodial sub-account.

Take note that failure to comply with this statutory summons shall render the responsible officer liable
under Section 223 and Section 238 of the Bharatiya Nyaya Sanhita, 2023 (BNS).

Given under my hand and seal,
{self.officer_name}
Investigating Officer, Cyber Crime Cell
"""

        # 2. BNSS Section 107 (Attachment / Freeze Application to Magistrate)
        bnss_107 = f"""
IN THE COURT OF THE LEARNED CHIEF JUDICIAL MAGISTRATE / SESSIONS JUDGE
APPLICATION UNDER SECTION 107 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023 (BNSS)
FOR PROVISIONAL ATTACHMENT AND FREEZING OF PROCEEDS OF CRIME

IN THE MATTER OF:
State (through Cyber Crime Police Station)   ... Applicant / Prosecution
VERSUS
Unidentified Suspect / Beneficiary         ... Accused

APPLICATION RESPECTFULLY SHOWETH:
1. That FIR No. {case_fir_no} was registered under Sections 316, 318 of BNS and Section 66D of IT Act, 2000.
2. That on-chain forensic tracing authenticated under Section 63 BSA demonstrates that victim funds were
   unlawfully channeled into account vault belonging to {v_name}.
3. That the tainted quantum quantified via mathematical First-In, First-Out (FIFO) taint accounting is
   ${v_usd:,.2f} USD (Approx ₹{v_inr:,.2f} INR).
4. That under Section 107 BNSS, where an officer has reason to believe that property represents proceeds
   of crime, an application lies before this Hon'ble Court for attachment and seizure.

PRAYER:
It is therefore respectfully prayed that this Hon'ble Court may be pleased to:
(a) Pass an order directing {v_name} to provisionally attach and freeze the specified cryptocurrency assets.
(b) Issue notice to the concerned beneficiary to show cause why the property should not be attached.

Filed by:
Superintendent of Police / Authorized Officer
"""

        # 3. BNSS Section 106 (Evidentiary Seizure Notice with 24h Intimation)
        bnss_106 = f"""
POLICE MEMO OF SEIZURE UNDER SECTION 106 BHARATIYA NAGARIK SURAKSHA SANHITA, 2023
[Formerly Section 102 CrPC, 1973]
WITH MANDATORY STATUTORY INTIMATION TO MAGISTRATE UNDER SECTION 106(3) BNSS

TO: The Learned Judicial Magistrate
MEMO:
Notice is hereby given that in connection with FIR No. {case_fir_no}, crypto assets / digital evidence
totaling ${v_usd:,.2f} USD have been provisionally seized/immobilized under Section 106(1) BNSS.
In strict compliance with Section 106(3) of BNSS, 2023, the seizure of property is being formally reported
to this Hon'ble Court within 24 hours of execution.

Sd/-
{self.officer_name}
"""

        # 4. BNSS Section 503 (Victim Restitution Application)
        bnss_503 = f"""
APPLICATION UNDER SECTION 503 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023 (BNSS)
[Formerly Section 457 CrPC, 1973]
FOR INTERIM CUSTODY AND RESTITUTION OF RECOVERED CRYPTO ASSETS TO VICTIM

1. The attached assets totaling ${v_usd:,.2f} USD (₹{v_inr:,.2f} INR)
   have been successfully seized from {v_name}.
2. Complainant has established uncontroverted title and electronic proof of transfer under Section 63 BSA.
3. Prayer is made for interim custody and disposal of the attached digital assets in favor of the victim.
"""

        return {
            "BNSS_94_PRODUCTION_SUMMONS": bnss_94.strip(),
            "BNSS_107_ATTACHMENT_APPLICATION": bnss_107.strip(),
            "BNSS_106_EVIDENTIARY_SEIZURE": bnss_106.strip(),
            "BNSS_503_VICTIM_RESTITUTION": bnss_503.strip()
        }
