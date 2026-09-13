<div align="center">

# 🛡️ FinGuard Intelligence

### Cross-bank financial-crime detection, from a CSV to a filed SAR in one sitting.

[![Next.js](https://img.shields.io/badge/Next.js-14.2-000000?style=flat-square&logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-3.4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Firebase](https://img.shields.io/badge/Firebase-Auth%20%2B%20Firestore-FFCA28?style=flat-square&logo=firebase&logoColor=black)](https://firebase.google.com)
[![Gemini](https://img.shields.io/badge/Gemini-3.1%20Flash%20Live-4285F4?style=flat-square&logo=googlegemini&logoColor=white)](https://ai.google.dev)

**Upload a transaction ledger. Get back a case file.**

Risk-scored transactions · a network graph of the real money flow · a four-agent AI
investigation grounded in *your* numbers · and a filing-ready Suspicious Activity Report.

</div>

---

## Why this exists

Financial crime is rarely visible from a single transaction or a single institution. Modern money laundering schemes are designed to exploit the gaps between banks, payment providers, and financial systems, making each transfer appear legitimate when viewed in isolation.

FinGuard bridges that visibility gap.

By analyzing a consolidated transaction ledger, FinGuard reconstructs the complete flow of funds across accounts, institutions, and time. Instead of evaluating transactions individually, it identifies hidden relationships, suspicious movement patterns, circular fund flows, rapid layering, and networks of connected accounts that traditional rule-based systems often miss.

The platform transforms raw financial data into an explainable investigation by combining AI-driven risk scoring, transaction graph analysis, behavioral pattern detection, and automated case generation. Investigators can quickly understand **who moved the money, how it moved, why it appears suspicious, and which entities require immediate attention.**

Whether used for fraud detection, AML research, compliance demonstrations, or cybersecurity projects, FinGuard provides a clear, visual, and evidence-backed view of complex financial activity—helping analysts detect risks that are difficult to uncover through isolated transaction monitoring alone.

## The 60-second tour

| | | |
|---|---|---|
| **1** | **Import** | Drag a .csv file in or choose a file from the sample.csv for reference. Pre-flight preview validates headers and shows you the first rows before anything is written. |
| **2** | **Triage** | Every row is severity-scored and tagged with a laundering typology on arrival. |
| **3** | **See the shape** | The graph groups accounts into rings and labels each one — chain, funnel, fan-out — with its own total. |
| **4** | **Interrogate** | Ask the four-agent panel anything. Answers quote your real account IDs and amounts. |
| **5** | **File** | One click turns the evidence into a SAR narrative and prints a clean A4 document. |

---

## ✨ The six views

### 1. 📊 Command Dashboard

The morning-briefing screen. Six KPI tiles — total transactions, open alerts, flagged
rings, flagged amount, severity score, confidence — all computed live from your own
imports, never from a fixture.

- **Severity × Date heatmap** — every transaction placed on a grid of day against risk
  band, so a single afternoon of frantic activity shows up as a hot column you can't miss.
- **Detected patterns** — the typology mix across the whole ledger, ranked by exposure.
- **Alert feed** — grouped by day, newest first, each entry carrying its amount, its
  severity and the accounts involved.
- **Agent fleet** — the four specialists and their live status.

### 2. 📒 Transactions

The full ledger, searchable across accounts, banks and notes, filterable by severity.
Every row carries its own pattern tag, so you can pull "show me only the mule deposits"
out of ten thousand rows without writing a query.

### 3. 🕸️ Transaction Graph

The centrepiece. Accounts become nodes, transfers become directed edges, and connected
components are laid out as **one tidy card per ring** — so ten separate laundering
structures read as ten separate structures instead of one hairball.

- Each card is titled with the ring's detected typology, its account count and its
  rupee total.
- Ring shapes are classified automatically: **chain** (A→B→C→D, layering),
  **collector** (many→one, a mule hub), **distributor** (one→many, structuring),
  **web**, **pair**.
- Zoom, pan and a scrolling canvas that renders the graph at natural size.
- **Edge log** below the canvas — every hop as a sortable row with a sticky header.
- Click any node for a **slide-over dossier**: role in the ring, money in, money out,
  the amount retained, counterparties, and a one-click **Escalate to SAR**.
- The AI Investigator can drive this view — "View on graph" from any reply focuses
  exactly the accounts that reply was about.

### 4. 📥 Upload CSV

- Drag-and-drop or pick a file from the sample.csv and import with a **pre-flight preview** — headers are
  validated and the first rows displayed *before* a single document is written.
- A downloadable template so the expected shape is never a guess.
- **Upload history** tab: every past import is kept as its own record. Select one and
  the entire dashboard replays that file's analytics in isolation — useful for
  "what did last Tuesday's batch actually look like?"

### 5. 🤖 AI Investigator

A four-agent panel over your data, not over the internet's general knowledge of AML.

| Agent | Answers the question |
|---|---|
| 🕸️ **Graph Analyst** | What does the money map look like? |
| ⚠️ **Risk Analyst** | Why is that wrong, compared to normal activity? |
| ⚖️ **Compliance Officer** | Which obligation does it trigger? |
| 🔍 **Investigation Assistant** | What do I do about it on Monday morning? |

**The part that matters:** before the model is called, the server computes an
**evidence brief** locally — rings, hop paths, per-account in/out totals, threshold
proximity, bank spread. The model receives that brief, so every answer quotes real
account IDs, real amounts and real dates. Ask it a vague question and you still get
`ACC-STR-HUB`, `₹47.80 L` and `2026-08-11` back, because the numbers were never the
model's to invent.

- **Two modes, auto-detected** — a short conversational reply for a question, the full
  four-agent report for an investigation.
- **Follow-ups keep context.** Run an investigation, then ask "which accounts should I
  freeze first?" and the panel answers from what it just found.
- One-tap **suggested follow-ups** after every reply.
- **Works with no API key.** If `GEMINI_API_KEY` is absent, rate-limited or the response
  is malformed, the same evidence brief is rendered by a deterministic offline engine.
  The app never shows an empty screen; it degrades to a slightly plainer report.

### 6. ⚖️ Compliance / SAR

Generates a Suspicious Activity Report narrative from the same evidence engine that
powers the chat — subject accounts, the typology, the pattern of activity, the amounts,
the dates, and a conclusion. Reports are stored per user with a status, deduplicated so
escalating the same account twice doesn't create a second filing, and exported through a
**print-only portal** that lays out a clean A4 document with none of the app chrome.

---

## 🔬 The detection engine

Everything above is driven by `src/lib/investigation.ts` — a pure TypeScript pass over
your rows. No model is consulted to decide what is suspicious; the model only explains
what the engine already found. That is deliberate: findings must be reproducible, and a
number in a SAR has to be defensible.

### Seven detectors

| Code | Fires when | Why it matters |
|---|---|---|
| `CHAIN-DECAY` | The longest money path runs 3+ linked hops, with each hop's amount ≤ the one before | Classic **layering** — a trail stretched over accounts and banks to break the link to the source. A shrinking balance means every hop kept a cut |
| `THRESHOLD-HUG` | 3+ transfers land between **₹8.50 L and ₹9,99,999** | Nobody accidentally stops just short of the ₹10 L reporting line, repeatedly |
| `FUNNEL-IN` | A collector hub takes payments from 3+ unrelated accounts, then forwards the pile | The shape of a **mule network**. Tightly-clustered deposit sizes mean coordination, not coincidence |
| `FAN-OUT` | One account splits a sum across 3+ receivers | **Structuring** — one reportable payment broken into several that aren't |
| `BANK-HOP` | A ring spans 3+ institutions and contains a pass-through account | The cross-bank blind spot itself: no single bank holds enough of the trail to flag it |
| `BURST` | 5+ transfers on the single busiest day | Genuine activity spreads out. A burst means someone is moving funds before review |
| `CROSS-BORDER` | Value leaves on a foreign rail (SWIFT, remittance, outward wire) | Once money is outside Indian jurisdiction, recovery is close to impossible |

Findings are ranked by severity and exposure, and each one carries a plain-language
explanation, the accounts involved, the amount and the dates — that same text feeds the
chat, the alert feed and the SAR.

### Six typologies

Tagged per transaction from the note text, and rolled up per ring:

🔴 **Rapid Layering** · 🟠 **Shell-Account Funnel** · 🟣 **Mule Network** ·
🔵 **Structuring / Smurfing** · 🟢 **Round-Trip / U-Turn** · 🩷 **Offshore Transfer**

### How risk is scored

| Severity | Rule |
|---|---|
| 🔴 **High** | The note names a laundering pattern (layering, structuring, mule, shell, offshore, split, pass-through) **or** the amount is ≥ **₹10,00,000** |
| 🟡 **Medium** | Amount ≥ **₹1,00,000** |
| 🟢 **Safe** | Everything else |

Reporting thresholds are configurable in one place — `REPORT_THRESHOLD` (₹10 L) and
`WIRE_REPORT_THRESHOLD` (₹5 L) at the top of `src/lib/investigation.ts`.

---

## 🚀 Quick start

```bash
git clone https://github.com/KUNAL2007-maker/FinGuard.git
cd FinGuard
npm install
cp .env.example .env.local    # fill in your own values
npm run dev
```

Open <http://localhost:3000>, create an account, and upload
[`samples/guided-demo.csv`](samples/guided-demo.csv) — or press
**↓ Download demo CSV** on the Import CSV screen, which hands you the same file.

### CSV format

```csv
date,from,to,bank,amount,currency,type,note
2026-08-10,ACC-LAY-01,ACC-LAY-02,HDFC Bank,24000000,INR,RTGS,rapid layering hop 1
```

`date`, `from`, `to` and `amount` are required. `bank`, `currency`, `type` and `note` are
optional but make the analysis much sharper — `note` is what drives typology tagging and
`type` is what distinguishes a domestic rail from an outward wire.

### 📁 Sample datasets

| File | Rows | What it demonstrates |
|---|---|---|
| [`samples/guided-demo.csv`](samples/guided-demo.csv) | 30 | **Start here.** Exactly 4 high-risk rings (layering chain, structuring fan-out, mule funnel, offshore SWIFT exit), 2 medium and 4 clean groups — every severity band and every panel populated |
| [`samples/typology-sweep.csv`](samples/typology-sweep.csv) | 36 | All six typologies including a shell-company funnel, spread over 7 banks |
| [`samples/high-volume.csv`](samples/high-volume.csv) | 96 | A denser ledger for testing the graph, filters and pagination at size |

`guided-demo.csv` also exists at [`public/samples/guided-demo.csv`](public/samples/guided-demo.csv),
byte-identical, because that is the only directory Next.js serves statically and the
in-app download button needs a URL. Edit both or neither.

---

## 🏗️ Architecture

```
src/
├── app/
│   ├── layout.tsx            Root layout, theme + auth providers
│   ├── page.tsx              Single-page shell, view routing
│   ├── login/page.tsx        Sign-in / registration
│   ├── globals.css           Design tokens + the print-only SAR stylesheet
│   └── api/chat/route.ts     Investigation endpoint — grounding, Gemini call, fallback
├── components/
│   ├── AppShell.tsx          Sidebar + top bar + scroll model
│   ├── AuthProvider.tsx      Firebase auth context
│   ├── NodeDetailDrawer.tsx  Per-account dossier, Escalate to SAR
│   ├── views/                The six screens
│   └── ui/                   MetricCard, Page, SeverityBadge, Sparkline
└── lib/
    ├── firebase.ts           Client init from env
    ├── domain.ts             Types, risk scoring, typology taxonomy, clustering, layout
    ├── investigation.ts      Evidence engine — 7 detectors, ring analysis, SAR text
    └── hooks.ts              Firestore reads/writes, CSV bulk insert, upload history
```

**Data model.** Everything is namespaced per user:

```
users/{uid}/transactions   users/{uid}/alerts
users/{uid}/sar_reports    users/{uid}/uploads
```

No account can read another's imports. Suggested Firestore rules:

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

**Where the intelligence lives.** The analysis layer is deliberately server-side and
model-free. `investigation.ts` (~1,250 lines) does the detection; `route.ts` decides
whether a message is a question or an investigation, builds the brief, calls Gemini
through a token governor that recognises daily rate caps, and falls back to the local
report generator on any failure. `gemini.ts` holds the transport — a Live API WebSocket
session, because the pinned model speaks no other protocol. The UI never talks to Gemini
directly and the API key never reaches the browser.

---

## ☁️ Deploy

The app is a stock Next.js App Router project and deploys to Vercel with no
configuration:

1. **Import** the repository at [vercel.com/new](https://vercel.com/new).
2. Add the environment variables from [`.env.example`](.env.example) under
   **Settings → Environment Variables** (all seven `NEXT_PUBLIC_FIREBASE_*`, plus
   `GEMINI_API_KEY` if you have one). `NEXT_PUBLIC_*` values must be present at build time.
3. In the Firebase console, add your Vercel domain under
   **Authentication → Settings → Authorized domains**, or sign-in will be rejected in
   production.
4. Deploy. Every push to `main` ships automatically.

```bash
npm run build    # verify the production build locally first
```

---

## 🧰 Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 14** (App Router) | Server routes keep the API key and the analysis off the client |
| Language | **TypeScript** (strict) | The evidence engine is the product; it needs types |
| Styling | **Tailwind CSS** + CSS custom properties | One token set drives dark, light and print |
| Auth & data | **Firebase** Auth + Firestore | Per-user isolation with no backend to run |
| Inference | **Google Gemini** · 3.1 Flash Live | A four-agent panel answers in about four seconds |
| Visualisation | **Hand-rolled SVG** | No chart library — the graph layout is bespoke, so the cluster cards can be too |

**Zero runtime dependencies beyond the framework.** `package.json` lists four production
packages: `next`, `react`, `react-dom`, `firebase`. No chart library, no UI kit, no state
manager. Every widget in the console — the heatmap, the sparklines, the network canvas,
the print layout — is written for this app.

---

## ⚠️ Scope

FinGuard is a decision-support console built as a final-year engineering project. It
surfaces patterns and drafts narratives; it does not file reports with any regulator, and
its output is a starting point for a human investigator, not a legal determination.

<div align="center">

**Built with Next.js, Firebase and Google Gemini.**

</div>
