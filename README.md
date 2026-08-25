# CryptoTrace — SIH26183

**Real-Time Identification of Fraud-Linked Cryptocurrency Exchanges from Victim-Reported Suspect Wallet Addresses through Automated Blockchain Analytics.**

> Smart India Hackathon 2026 · Problem Statement **SIH26183**
> Ministry of Home Affairs (MHA) / Indian Cyber Crime Coordination Centre (**I4C**)

A cyber-crime investigator pastes a wallet address a victim reported to the 1930
helpline / NCRP. CryptoTrace walks the stolen funds outward across chains, works
out which **exchanges (VASPs)** and **mixers** the money reached, classifies the
laundering typologies it sees, decides — on two tracks — where a freeze can go
today versus where an officer must review first, and drafts the **Section 91 CrPC
/ Section 94 BNSS** freeze-and-KYC notice addressed to that exchange's compliance
desk.

It runs **zero-config**: with no API keys it serves a realistic multi-chain demo
case and answers from a built-in forensic engine. Add keys to trace live chains
and to get an AI-written narrative.

---

## Why it stands up in the field

- **Readable without AI.** Every finding, the dual-track decision and the legal
  notice are produced by a deterministic engine in the browser. The Gemini
  assistant *narrates* that evidence; it never invents it, and if the key is
  missing the console degrades to a local four-agent report rather than showing
  an error. An investigator is never blocked by a network.
- **Actionable, not just pretty.** The output of a trace is a servable document:
  the correct exchange, the correct compliance email and jurisdiction, the exact
  deposit addresses to freeze, the full hop-by-hop wallet trail with transaction
  hashes, the amount (USD and INR), and the mandatory KYC demand (Aadhaar, PAN,
  linked bank account, IP/login logs).
- **Honest about limits.** When the trail terminates in a mixer with no
  compliance desk, the tool says so and recommends an FIU-IND referral instead of
  addressing a notice to a machine.

---

## What it does (end to end)

1. **Ingest** a victim-reported wallet address. The chain is detected from the
   address shape — `0x…` (Ethereum / Polygon), `T…` (TRON), `bc1…/1…/3…`
   (Bitcoin).
2. **Trace** the money with a hop-limited breadth-first walk (`MAX_HOPS`,
   cycle-safe), tagging each wallet's role: victim entry → burner mules → peel
   chain → cross-chain bridge → exchange deposit → exchange hot wallet.
3. **Attribute** the wallets it reaches to a directory of VASPs (Binance, WazirX,
   CoinDCX, Kraken, KuCoin) and mixers (Tornado Cash), with a confidence score.
4. **Classify** laundering typologies — VASP sweep, peeling chain, dust taint,
   cross-chain bridge, multi-input (burner-mule) cluster, threshold split, and
   mixer/tumbler touch. Each carries its own plain-English sentence.
5. **Decide** on two tracks:
   - **Track A (express auto-freeze):** high attribution confidence, a verified
     direct exchange deposit, no mixer or bridge in the path.
   - **Track B (officer review):** lower confidence, or a mixer/bridge in the
     path. Nothing freezes without a human.
   When some endpoints qualify for A and others for B, the case is **DUAL**.
6. **Generate** the Section 91 CrPC / Section 94 BNSS notice for a chosen
   exchange — print to PDF, copy, download, or open a pre-filled email.
7. **Explain** anything through the I4C assistant, grounded in the live trace.

---

## Quick start

```bash
npm install
npm run dev
```

Open the app, click **Load demo case**, and the whole pipeline runs with no keys.

To go live, copy `.env.example` to `.env.local` and add what you have — every key
is optional and each unlocks one capability:

| Key | Unlocks | Without it |
| --- | --- | --- |
| `GEMINI_API_KEY` | AI-written assistant narrative | Local four-agent report |
| `ETHERSCAN_API_KEY` | Live Ethereum / Polygon tracing | Demo dataset for that chain |
| `TRONGRID_API_KEY` | Live TRON (TRC-20) tracing | Demo dataset for that chain |
| _(none for Bitcoin)_ | Live BTC via mempool.space | — |

```bash
npm run build   # production build (strict TypeScript)
npm start
```

Requires **Node ≥ 22**.

---

## Architecture

```
src/
  lib/
    domain.ts         Crypto schema (chains, tokens, VASPs) + the graph
                      layout engine (connected-component → per-topology
                      layout → packing). Pure, browser-safe.
    blockchain.ts     Chain providers (Etherscan / TronGrid / mempool),
                      VASP attribution, hop-limited BFS tracer, and the
                      seeded mock scenario used offline.
    investigation.ts  buildEvidence (7 detectors), decideTrack (dual-track),
                      section91Notice (the legal document), and the local
                      offline report. Pure, browser-safe.
    gemini.ts         Gemini Live-API transport (WebSocket).
    quota.ts          Per-minute token governor.
  app/
    api/trace/route.ts  POST a seed → a full multi-chain trace (live or mock).
    api/chat/route.ts   The I4C assistant: token governor, 15-min cache,
                        one-retry/wait budget, and the local fallback.
    page.tsx            Single-view shell (no auth gate in this pass).
  components/
    views/InvestigationView.tsx   The console: search, KPIs, hop-trail graph,
                                  findings, dual-track panel, Sec 91 notice,
                                  and the assistant.
    ui/…                          Shared primitives (cards, badges, layout).
```

The engine is deliberately domain-agnostic where it can be — the graph layout and
the AI transport/governor are reused wholesale; only the *domain* (wallets,
chains, VASPs, crypto typologies, the crypto legal instrument) is specific to this
problem statement.

---

## Roadmap — Pass 2

- Full graph canvas with animated flow pulses and a per-wallet dossier drawer.
- A command dashboard and a dedicated legal-notices workspace.
- Firebase auth + a fresh database for case / evidence persistence.
- Live-API hardening: rate/backoff, and a price oracle for accurate `value_usd`.

---

## Attribution

Built for **SIH2026 · Problem Statement SIH26183** (MHA / I4C). The blockchain
schema, tracing, attribution, typology detection, dual-track logic and the
Section 91 / 94 generator are original to this project; the AI transport, token
governor and graph layout engine are adapted from a prior fiat-AML console.
