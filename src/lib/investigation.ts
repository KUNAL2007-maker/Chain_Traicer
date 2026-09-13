// Turns the user's live transactions into hard, quotable findings.
//
// The AI agents used to receive nothing but raw CSV rows, so their answers read
// like a textbook. This module does the arithmetic first — who the hubs are,
// which hops form a chain, how much value each hop shaves, which amounts hug
// the reporting threshold — and hands the agents facts they can only have got
// from this data. It is also the offline fallback: every finding here carries
// its own plain-English sentence, so a report can be written with no AI at all.

import { detectPattern, formatINR, type Transaction } from "./domain";

// ₹10 lakh is the cash-reporting line under the PMLA rules. It matters here not
// because these electronic transfers need a CTR — a CTR covers cash — but
// because launderers still size payments against it out of habit, which is what
// makes a cluster of ₹9-point-something-lakh transfers worth flagging.
export const REPORT_THRESHOLD = 1_000_000;

// Cross-border wire transfers are reportable from ₹5 lakh (CBWTR), a lower bar
// than the cash line above.
export const WIRE_REPORT_THRESHOLD = 500_000;

// Settlement systems that never leave India. A transfer on one of these is
// domestic no matter what its note says.
const DOMESTIC_RAILS = /^(neft|rtgs|imps|upi|ach|nach|cheque|cash|cash_deposit|card_payment|bill_payment|salary)$/i;

// Channels that only exist for money leaving the country. "wire_transfer" is
// deliberately absent: banks use it for a domestic high-value RTGS leg just as
// often as for a real overseas wire, so it has to be corroborated by the note.
// Treating every wire as an exit claimed ₹81.50 L "left India" on a Punjab
// National Bank payout that never left the country.
const FOREIGN_RAILS = /(swift|international|cross.?border|remittance|telegraphic|forex|fx_|wire_out|outward)/i;

const FOREIGN_NOTE = /offshore|overseas|foreign|abroad|dubai|singapore|hong ?kong|mauritius|cayman|swiss|nominee account|non.?resident/i;

// A note can name a foreign place because money is arriving from there. Counting
// those legs as exits doubled the reported figure: two inward "offshore routing"
// credits were added to the two SWIFT remittances that actually left.
const INWARD_NOTE = /inward|incoming|inbound|received|credit from|trade advance|repatriat/i;

// What an investigator should act on first, not what carries the largest rupee
// figure. Money already crossing the border can't be clawed back, and splitting
// payments to dodge the reporting line is an offence in its own right. Bank-hop
// sums to the biggest number in most datasets but is the least actionable.
const RISK_ORDER: Record<string, number> = {
  "CROSS-BORDER": 1,
  "THRESHOLD-HUG": 2,
  "CHAIN-DECAY": 3,
  "FUNNEL-IN": 4,
  "FAN-OUT": 5,
  "BANK-HOP": 6,
  BURST: 7,
};

export type Finding = {
  code: string;
  title: string;
  plain: string;
  // One-sentence version of `plain`. The brief sent to the AI wants the full
  // reasoning; the on-screen report wants a bullet you can read in two seconds.
  short: string;
  severity: "high" | "medium" | "info";
  accounts: string[];
  amount: number;
};

export type RingSummary = {
  id: string;
  shape: "chain" | "collector" | "distributor" | "pair" | "web";
  shapeLabel: string;
  typology: string | null;
  accounts: string[];
  hubs: string[];
  // A chain has no centre, only two ends. Without these the brief offers nothing
  // concrete to name for a hubless ring, and the model fills the gap by
  // promoting some arbitrary member into a "hub" that does not exist.
  ends: { from: string; to: string } | null;
  // Accounts that both receive and pass money on. Layering cannot happen
  // without at least one; a group with none is separate payments sharing a
  // payer or a payee, however many accounts and banks it spans.
  passThrough: string[];
  txCount: number;
  total: number;
  banks: string[];
  days: string[];
};

export type Evidence = {
  txCount: number;
  accountCount: number;
  totalValue: number;
  bySeverity: { high: number; medium: number; safe: number };
  highValue: number;
  banks: string[];
  dateRange: { from: string; to: string } | null;
  typologies: { label: string; count: number; amount: number }[];
  channels: { type: string; count: number }[];
  rings: RingSummary[];
  findings: Finding[];
  topCounterparties: {
    account: string;
    degree: number;
    volume: number;
    // Kept apart because "received from 5 payers" and "sent to 5 payees" mean
    // very different things. Collapsing them to one degree count left the model
    // guessing which it was, and it guessed wrong.
    inCount: number;
    outCount: number;
    inAmount: number;
    outAmount: number;
  }[];
  busiestDay: { date: string; count: number; amount: number } | null;
};

const money = formatINR;

export function buildEvidence(txs: Transaction[]): Evidence {
  const clean = txs.filter((t) => t.fromAccount && t.toAccount);

  const bySeverity = { high: 0, medium: 0, safe: 0 };
  const bankSet = new Set<string>();
  const dates: string[] = [];
  const perDay = new Map<string, { count: number; amount: number }>();
  const typTally = new Map<string, { label: string; count: number; amount: number }>();
  const chanTally = new Map<string, number>();
  const accounts = new Map<
    string,
    {
      degree: number;
      volume: number;
      in: number;
      out: number;
      inAmount: number;
      outAmount: number;
      payers: Set<string>;
      payees: Set<string>;
    }
  >();

  let totalValue = 0;
  let highValue = 0;

  for (const t of clean) {
    bySeverity[t.severity] += 1;
    totalValue += t.amount;
    if (t.severity === "high") highValue += t.amount;
    if (t.bank) bankSet.add(t.bank);
    if (t.type) chanTally.set(t.type, (chanTally.get(t.type) ?? 0) + 1);
    if (t.date) {
      dates.push(t.date);
      const d = perDay.get(t.date) ?? { count: 0, amount: 0 };
      d.count += 1;
      d.amount += t.amount;
      perDay.set(t.date, d);
    }

    const p = detectPattern(t.note);
    if (p) {
      const cur = typTally.get(p.key);
      if (cur) {
        cur.count += 1;
        cur.amount += t.amount;
      } else {
        typTally.set(p.key, { label: p.label, count: 1, amount: t.amount });
      }
    }

    for (const [acc, dir] of [[t.fromAccount, "out"], [t.toAccount, "in"]] as const) {
      const a =
        accounts.get(acc) ??
        { degree: 0, volume: 0, in: 0, out: 0, inAmount: 0, outAmount: 0, payers: new Set<string>(), payees: new Set<string>() };
      a.degree += 1;
      a.volume += t.amount;
      if (dir === "in") {
        a.in += 1;
        a.inAmount += t.amount;
        a.payers.add(t.fromAccount);
      } else {
        a.out += 1;
        a.outAmount += t.amount;
        a.payees.add(t.toAccount);
      }
      accounts.set(acc, a);
    }
  }

  dates.sort();
  const busiest = Array.from(perDay.entries()).sort((a, b) => b[1].count - a[1].count)[0];

  const rings = buildRings(clean);
  const evidence: Evidence = {
    txCount: clean.length,
    accountCount: accounts.size,
    totalValue,
    bySeverity,
    highValue,
    banks: Array.from(bankSet),
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    typologies: Array.from(typTally.values()).sort((a, b) => b.count - a.count),
    channels: Array.from(chanTally.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    rings,
    findings: [],
    topCounterparties: Array.from(accounts.entries())
      .map(([account, a]) => ({
        account,
        degree: a.degree,
        volume: a.volume,
        inCount: a.in,
        outCount: a.out,
        inAmount: a.inAmount,
        outAmount: a.outAmount,
      }))
      .sort((a, b) => b.degree - a.degree || b.volume - a.volume)
      .slice(0, 6),
    busiestDay: busiest ? { date: busiest[0], count: busiest[1].count, amount: busiest[1].amount } : null,
  };

  evidence.findings = collectFindings(clean, evidence);
  return evidence;
}
// ── Ring detection ────────────────────────────────────────────────────────
// Accounts that only ever transact with each other form one ring. The shape of
// that ring is what tells an investigator which typology they are looking at,
// so we classify it structurally rather than trusting the narration alone.
function buildRings(txs: Transaction[]): RingSummary[] {
  const adj = new Map<string, Set<string>>();
  const touch = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const t of txs) {
    touch(t.fromAccount, t.toAccount);
    touch(t.toAccount, t.fromAccount);
  }

  const seen = new Set<string>();
  const rings: RingSummary[] = [];

  for (const start of Array.from(adj.keys())) {
    if (seen.has(start)) continue;
    const bucket: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const cur = queue.shift()!;
      bucket.push(cur);
      for (const nb of Array.from(adj.get(cur) ?? [])) {
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }

    const members = new Set(bucket);
    const ringTxs = txs.filter((t) => members.has(t.fromAccount) && members.has(t.toAccount));
    if (!ringTxs.length) continue;

    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    for (const t of ringTxs) {
      outDeg.set(t.fromAccount, (outDeg.get(t.fromAccount) ?? 0) + 1);
      inDeg.set(t.toAccount, (inDeg.get(t.toAccount) ?? 0) + 1);
    }

    const hubs = bucket
      .filter((a) => (inDeg.get(a) ?? 0) + (outDeg.get(a) ?? 0) >= 3)
      .sort(
        (a, b) =>
          (inDeg.get(b)! ?? 0) + (outDeg.get(b) ?? 0) - ((inDeg.get(a) ?? 0) + (outDeg.get(a) ?? 0))
      );

    const typTally = new Map<string, number>();
    for (const t of ringTxs) {
      const p = detectPattern(t.note);
      if (p) typTally.set(p.label, (typTally.get(p.label) ?? 0) + 1);
    }
    const typology =
      Array.from(typTally.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    // The entry point takes nothing in and the exit sends nothing on. Only
    // meaningful when there is exactly one of each — a web has several of both,
    // and picking one at random would be the same invention we are avoiding.
    const sources = bucket.filter((a) => !(inDeg.get(a) ?? 0));
    const sinks = bucket.filter((a) => !(outDeg.get(a) ?? 0));
    const ends =
      sources.length === 1 && sinks.length === 1
        ? { from: sources[0], to: sinks[0] }
        : null;

    const passThrough = bucket.filter((a) => (inDeg.get(a) ?? 0) && (outDeg.get(a) ?? 0));

    const { shape, shapeLabel } = classifyShape(bucket, ringTxs, inDeg, outDeg, ends);

    rings.push({
      id: `ring_${rings.length + 1}`,
      shape,
      shapeLabel,
      typology,
      accounts: bucket,
      hubs: hubs.slice(0, 2),
      ends,
      passThrough,
      txCount: ringTxs.length,
      total: ringTxs.reduce((s, t) => s + t.amount, 0),
      banks: Array.from(new Set(ringTxs.map((t) => t.bank).filter(Boolean))),
      days: Array.from(new Set(ringTxs.map((t) => t.date).filter(Boolean))).sort(),
    });
  }

  return rings.sort((a, b) => b.accounts.length - a.accounts.length || b.total - a.total);
}

// ── Findings ──────────────────────────────────────────────────────────────
// Follow the money one hop at a time. A transfer only continues the chain if it
// leaves the account the previous hop landed in, happens no earlier, and carries
// no more than arrived. Sorting a ring's transfers by amount instead — which is
// what this used to do — makes the largest "money in" and the smallest "money
// out" for ANY ring, so every chain reported a decay that was an artifact of the
// sort rather than a path the money actually took.
function longestMoneyPath(ringTxs: Transaction[]): Transaction[] {
  const byDate = [...ringTxs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let best: Transaction[] = [];

  const walk = (path: Transaction[], visited: Set<string>) => {
    if (path.length > best.length) best = [...path];
    const tail = path[path.length - 1];
    for (const next of byDate) {
      if (next.fromAccount !== tail.toAccount) continue;
      if (next.date < tail.date) continue;
      if (next.amount > tail.amount) continue;
      // Revisiting an account is a loop, not a longer trail.
      if (visited.has(next.toAccount)) continue;
      visited.add(next.toAccount);
      walk([...path, next], visited);
      visited.delete(next.toAccount);
    }
  };

  for (const start of byDate) {
    walk([start], new Set([start.fromAccount, start.toAccount]));
  }
  return best;
}

// Each finding is a fact plus the sentence a non-expert needs to understand why
// it matters. These sentences are what make the report readable without AI.
function collectFindings(txs: Transaction[], ev: Evidence): Finding[] {
  const out: Finding[] = [];

  // 1. Chains that lose value at every hop — the classic layering signature.
  for (const ring of ev.rings) {
    if (ring.shape !== "chain" || ring.accounts.length < 4) continue;
    const ringTxs = txs.filter(
      (t) => ring.accounts.includes(t.fromAccount) && ring.accounts.includes(t.toAccount)
    );
    const hops = longestMoneyPath(ringTxs);
    // Under three linked hops there is no trail to speak of — two transfers that
    // happen to share an account are just a payment being passed on.
    if (hops.length < 3) continue;
    const first = hops[0];
    const last = hops[hops.length - 1];
    const shrink = first.amount - last.amount;
    const pct = first.amount ? ((shrink / first.amount) * 100).toFixed(1) : "0";
    const days = Array.from(new Set(hops.map((h) => h.date).filter(Boolean))).sort();
    const when =
      days.length === 1
        ? `, all on ${days[0]}`
        : days.length > 1
          ? `, between ${days[0]} and ${days[days.length - 1]}`
          : "";
    // Money passing through untouched is still layering, but "kept a cut" would
    // be a claim the numbers do not support.
    const route = `${first.fromAccount} → ${last.toAccount}`;
    out.push({
      code: "CHAIN-DECAY",
      title: shrink > 0
        ? `${hops.length} linked hops ${route}, shrinking ${pct}% along the way`
        : `${hops.length} linked hops ${route}, passed on untouched`,
      plain:
        `Money left ${first.fromAccount} at ${money(first.amount)} and arrived at ${last.toAccount} as ` +
        `${money(last.amount)} after ${hops.length} linked hops${when}. ` +
        (shrink > 0
          ? `Each account kept a cut of ${money(shrink)} in total and pushed the rest onward. ` +
            `Ordinary business payments do not lose a slice at every step — `
          : `The full amount was passed straight on at every step, which is not how trade or salary payments behave — `) +
        `this is what layering looks like: the trail is being stretched out to make the original source hard to trace. ` +
        `Route: ${hops.map((h) => h.fromAccount).join(" → ")} → ${last.toAccount}.`,
      short: shrink > 0
        ? `${money(first.amount)} became ${money(last.amount)} over ${hops.length} linked hops${when} — each account kept a cut, which ordinary payments never do.`
        : `${money(first.amount)} passed through ${hops.length} accounts untouched${when} — a trail this long has no ordinary business reason.`,
      severity: "high",
      accounts: [...hops.map((h) => h.fromAccount), last.toAccount],
      amount: first.amount,
    });
  }

  // 2. Amounts parked just under the reporting threshold.
  const nearMiss = txs.filter(
    (t) => t.amount >= REPORT_THRESHOLD * 0.85 && t.amount < REPORT_THRESHOLD
  );
  if (nearMiss.length >= 3) {
    const sum = nearMiss.reduce((s, t) => s + t.amount, 0);
    const senders = Array.from(new Set(nearMiss.map((t) => t.fromAccount)));
    const lowest = Math.min(...nearMiss.map((t) => t.amount));
    const highest = Math.max(...nearMiss.map((t) => t.amount));
    out.push({
      code: "THRESHOLD-HUG",
      title: `${nearMiss.length} transfers sitting just below the ${money(REPORT_THRESHOLD)} reporting line`,
      plain:
        `These ${nearMiss.length} transfers total ${money(sum)}, yet every single one lands between ` +
        `${money(lowest)} and ${money(highest)} — just under the ${money(REPORT_THRESHOLD)} mark that banks watch as ` +
        `a reporting line. Amounts do not cluster in a narrow band like that by chance: someone is sizing each payment ` +
        `to stay below a number. ` +
        `${senders.length === 1 ? "All of them come from the same account, which makes coincidence very unlikely." : `They come from ${senders.length} accounts acting together.`} ` +
        `Splitting one payment into several to stay under a reporting line is called structuring, or smurfing, and doing ` +
        `it deliberately is an offence by itself — separate from whatever the money was for.`,
      short:
        `${nearMiss.length} transfers totalling ${money(sum)}, every one between ${money(lowest)} and ${money(highest)} — ` +
        `sized to stay under the ${money(REPORT_THRESHOLD)} line, which is structuring.`,
      severity: "high",
      accounts: senders,
      amount: sum,
    });
  }

  // 3. Collector accounts: many payers in, one big payment out.
  for (const ring of ev.rings) {
    if (ring.shape !== "collector" || !ring.hubs.length) continue;
    const hub = ring.hubs[0];
    const feeders = txs.filter((t) => t.toAccount === hub);
    const payouts = txs.filter((t) => t.fromAccount === hub);
    if (feeders.length < 3) continue;
    const inSum = feeders.reduce((s, t) => s + t.amount, 0);
    const outSum = payouts.reduce((s, t) => s + t.amount, 0);
    const spread = feeders.map((f) => f.amount);
    const tight = Math.max(...spread) - Math.min(...spread) < Math.max(...spread) * 0.2;
    out.push({
      code: "FUNNEL-IN",
      title: `${feeders.length} accounts all pay into ${hub}, which forwards the pile onward`,
      plain:
        `${hub} received ${money(inSum)} from ${feeders.length} different accounts` +
        `${payouts.length ? ` and then sent ${money(outSum)} out again in ${payouts.length} payment${payouts.length > 1 ? "s" : ""}` : ""}. ` +
        `${tight ? "The deposits are all suspiciously similar in size, which is a sign they were coordinated rather than genuine unrelated payments. " : ""}` +
        `Money arriving from many unconnected people and leaving almost immediately as one lump is the standard money-mule shape: ` +
        `the middle account is a rented pass-through, not the real owner of the funds.`,
      short:
        `${hub} took ${money(inSum)} from ${feeders.length} unrelated accounts` +
        `${payouts.length ? ` and pushed ${money(outSum)} straight out` : ""} — the classic mule pass-through.`,
      severity: "high",
      accounts: [hub, ...feeders.map((f) => f.fromAccount)],
      amount: inSum,
    });
  }

  // 4. Distributor accounts: one payer, many receivers.
  for (const ring of ev.rings) {
    if (ring.shape !== "distributor" || !ring.hubs.length) continue;
    const hub = ring.hubs[0];
    const splits = txs.filter((t) => t.fromAccount === hub);
    if (splits.length < 3) continue;
    const sum = splits.reduce((s, t) => s + t.amount, 0);
    out.push({
      code: "FAN-OUT",
      title: `${hub} split ${money(sum)} across ${splits.length} accounts`,
      plain:
        `A single account pushed ${money(sum)} out to ${splits.length} different receivers` +
        `${new Set(splits.map((s) => s.date)).size === 1 ? ` on one day (${splits[0].date})` : ""}. ` +
        `Breaking one large sum into several smaller ones spreads it across accounts that are each individually ` +
        `unremarkable, so no single bank sees the full picture. The receiving accounts are worth checking for ` +
        `whether they have any real reason to be paid.`,
      short:
        `${hub} split ${money(sum)} across ${splits.length} receivers` +
        `${new Set(splits.map((s) => s.date)).size === 1 ? ` on ${splits[0].date}` : ""} — small pieces no single bank flags.`,
      severity: "high",
      accounts: [hub, ...splits.map((s) => s.toAccount)],
      amount: sum,
    });
  }

  // 5. Cross-bank hopping. Reported once for the whole dataset — repeating the
  // same explanation per ring buried the other findings and read like padding.
  // A ring only counts if money actually travels through an account in it. A
  // company paying six vendors who bank in six places touches six banks without
  // anything hopping anywhere, and counting those inflated this finding to
  // ₹4.10 Cr when the one real chain accounted for ₹4.00 Cr of it — a figure
  // that overstates the case is worse than no figure.
  const hoppers = ev.rings.filter(
    (r) => r.banks.length >= 3 && r.accounts.length >= 3 && r.passThrough.length > 0
  );
  if (hoppers.length) {
    const hopTotal = hoppers.reduce((s, r) => s + r.total, 0);
    const allBanks = [...new Set(hoppers.flatMap((r) => r.banks))];
    const lines = hoppers.map(
      (r) =>
        `${r.typology ?? r.shapeLabel.split("—")[0].trim()} (${r.accounts.length} accounts, ` +
        `${money(r.total)}) touched ${r.banks.length} banks`
    );
    out.push({
      code: "BANK-HOP",
      title:
        hoppers.length === 1
          ? `One ring spread across ${hoppers[0].banks.length} different banks`
          : `${hoppers.length} rings each spread across 3 or more banks`,
      plain:
        `${money(hopTotal)} moved through ${allBanks.length} banks (${allBanks.join(", ")}) — ` +
        `${lines.join("; ")}. No individual bank can see more than its own slice, so each one sees a ` +
        `normal-looking transfer and nothing worth flagging. Spreading a flow across institutions on purpose, ` +
        `so that no single one holds enough of the picture to react, is why banks share monitoring data ` +
        `between them.`,
      short:
        `${money(hopTotal)} routed through ${allBanks.length} banks (${allBanks.join(", ")}) — ` +
        `each bank sees only its own slice, so none of them flags anything.`,
      severity: "high",
      accounts: [...new Set(hoppers.flatMap((r) => r.accounts))],
      amount: hopTotal,
    });
  }

  // 6. Same-day bursts.
  if (ev.busiestDay && ev.busiestDay.count >= 5) {
    out.push({
      code: "BURST",
      title: `${ev.busiestDay.count} transfers crammed into ${ev.busiestDay.date}`,
      plain:
        `${ev.busiestDay.count} of the ${ev.txCount} transfers happened on ${ev.busiestDay.date} alone, ` +
        `moving ${money(ev.busiestDay.amount)} in a single day. Genuine activity usually spreads out; ` +
        `a sudden burst normally means someone is moving funds fast, before anyone reviews them.`,
      short:
        `${ev.busiestDay.count} of ${ev.txCount} transfers landed on ${ev.busiestDay.date} alone, ` +
        `moving ${money(ev.busiestDay.amount)} — speed beats review.`,
      severity: "medium",
      accounts: [],
      amount: ev.busiestDay.amount,
    });
  }

  // 7. Cross-border exits.
  // The channel decides this wherever it can. NEFT, RTGS, IMPS and UPI are
  // domestic-only settlement systems — money cannot leave the country on them
  // however the note is worded, and a note reading "to offshore mule" describes
  // who the payee is thought to be, not where the payment went. Trusting the
  // note alone counted a domestic RTGS leg as an overseas exit and inflated the
  // reported figure, which is exactly the kind of error a reviewer catches.
  // "wire_transfer" sits in between and needs the note to corroborate it.
  const swift = txs.filter((t) => {
    const type = (t.type ?? "").trim();
    const note = t.note ?? "";
    if (FOREIGN_RAILS.test(type)) return true;
    if (DOMESTIC_RAILS.test(type)) return false;
    if (!FOREIGN_NOTE.test(note)) return false;
    return !INWARD_NOTE.test(note);
  });
  if (swift.length) {
    const sum = swift.reduce((s, t) => s + t.amount, 0);
    out.push({
      code: "CROSS-BORDER",
      title: `${money(sum)} heading out of the country`,
      plain:
        `${swift.length} transfer${swift.length > 1 ? "s" : ""} totalling ${money(sum)} left via overseas wires. ` +
        `Once money is outside Indian jurisdiction it becomes very hard to recover, so cross-border exits at the end of ` +
        `a suspicious chain are the last realistic point to freeze anything.`,
      short:
        `${money(sum)} left India on ${swift.length} overseas wire${swift.length > 1 ? "s" : ""} — ` +
        `once it settles abroad it is effectively unrecoverable.`,
      severity: "high",
      accounts: Array.from(new Set(swift.map((t) => t.toAccount))),
      amount: sum,
    });
  }

  // Severity first, then what an investigator should act on first — NOT the
  // largest rupee figure. Bank-hopping sums to the biggest number here but is
  // the least actionable, and sorting by amount pushed it to the top of the
  // brief, where it crowded out the findings that carry dates and percentages.
  const rank = { high: 0, medium: 1, info: 2 };
  return out.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      (RISK_ORDER[a.code] ?? 99) - (RISK_ORDER[b.code] ?? 99) ||
      b.amount - a.amount
  );
}

// ── The brief handed to the AI ────────────────────────────────────────────
// Compact enough to fit in a prompt, specific enough that a generic answer is
// obviously wrong. The model is told to quote these numbers.
export function evidenceBrief(ev: Evidence): string {
  if (!ev.txCount) return "NO TRANSACTION DATA UPLOADED.";

  const lines: string[] = [];

  // Findings lead. When the compact ring table came first the model answered
  // from that alone and reduced every agent to the same recital of ring stats.
  if (ev.findings.length) {
    lines.push(
      `HARD FINDINGS (${ev.findings.length}) — THE ACTUAL CASE. Each one below already contains the exact ` +
        `amounts, dates and accounts. Explain these in your own words; do not reduce them to a count of accounts.`
    );
    ev.findings.forEach((f, i) => {
      lines.push(`  F${i + 1} [${f.code}] ${f.severity.toUpperCase()} — ${f.title}`);
      lines.push(`      ${f.plain}`);
      if (f.accounts.length) {
        lines.push(`      Accounts involved: ${f.accounts.slice(0, 8).join(", ")}${f.accounts.length > 8 ? "…" : ""}.`);
      }
    });
    lines.push(``);
  }

  lines.push(
    `PORTFOLIO: ${ev.txCount} transfers, ${ev.accountCount} accounts, ${money(ev.totalValue)} total value.`
  );
  lines.push(
    `RISK SPLIT: ${ev.bySeverity.high} high-risk (${money(ev.highValue)}), ${ev.bySeverity.medium} medium, ${ev.bySeverity.safe} routine.`
  );
  if (ev.dateRange) lines.push(`PERIOD: ${ev.dateRange.from} to ${ev.dateRange.to}.`);

  // Decided here, not by the model — it kept hedging both ways in one breath.
  const border = ev.findings.find((f) => f.code === "CROSS-BORDER");
  lines.push(
    border
      ? `CROSS-BORDER: YES — ${money(border.amount)} left India by overseas wire. FEMA 1999 applies; say so plainly.`
      : `CROSS-BORDER: NO — every transfer stayed inside India. FEMA 1999 does NOT apply. Do not mention it at all.`
  );

  if (ev.channels.length) {
    lines.push(
      `CHANNELS USED: ${ev.channels.map((c) => `${c.type} (${c.count})`).join(", ")}. ` +
        `These are all electronic transfers — none of this is cash, so do not describe it as cash.`
    );
  }
  if (ev.banks.length) lines.push(`BANKS INVOLVED: ${ev.banks.join(", ")}.`);
  if (ev.busiestDay)
    lines.push(
      `BUSIEST DAY: ${ev.busiestDay.date} with ${ev.busiestDay.count} transfers worth ${money(ev.busiestDay.amount)}.`
    );

  if (ev.typologies.length) {
    lines.push(
      `TYPOLOGIES TAGGED: ${ev.typologies
        .map((t) => `${t.label} (${t.count} transfers, ${money(t.amount)})`)
        .join("; ")}.`
    );
  }

  const notable = ev.rings.filter((r) => r.accounts.length >= 3);
  if (notable.length) {
    lines.push(`RINGS DETECTED (${notable.length}):`);
    notable.forEach((r, i) => {
      lines.push(
        `  R${i + 1}. ${r.accounts.length} accounts, ${r.txCount} transfers, ${money(r.total)}. ` +
          `Shape: ${r.shapeLabel}. Typology: ${r.typology ?? "untagged"}. ` +
          (r.hubs.length
            ? `Hub(s): ${r.hubs.join(", ")}. `
            : `Hub(s): none — this group has no centre, so name none and do not ` +
              `mention hubs at all when describing it${
                r.ends ? `; it runs ${r.ends.from} → ${r.ends.to}` : ""
              }. `) +
          `Share of portfolio: ${
            ev.totalValue ? ((r.total / ev.totalValue) * 100).toFixed(1) : "0.0"
          }%. Banks: ${r.banks.join(", ") || "n/a"}. ` +
          `Accounts: ${r.accounts.slice(0, 8).join(", ")}${r.accounts.length > 8 ? "…" : ""}.`
      );
    });
  }

  const pairs = ev.rings.filter((r) => r.accounts.length < 3).length;
  if (pairs) lines.push(`Plus ${pairs} isolated one-to-one transfers with no ring structure.`);

  if (ev.topCounterparties.length) {
    lines.push(
      `MOST CONNECTED ACCOUNTS — these in/out figures are the ONLY source for how many parties paid ` +
        `an account or were paid by it. Never state a payer or payee count that is not on this list:`
    );
    ev.topCounterparties.forEach((c) => {
      const parts = [
        c.inCount
          ? `received ${money(c.inAmount)} in ${c.inCount} ${c.inCount === 1 ? "transfer" : "transfers"}`
          : "received nothing",
        c.outCount
          ? `sent ${money(c.outAmount)} in ${c.outCount} ${c.outCount === 1 ? "transfer" : "transfers"}`
          : "sent nothing",
      ];
      lines.push(`  ${c.account}: ${parts.join(", ")}.`);
    });
  }

  return lines.join("\n");
}

/**
 * The same evidence, sized for a conversation instead of a report.
 *
 * `evidenceBrief` above is a working document: on a 30-row upload it runs to
 * 8,100 characters, most of it stage directions written for the four-agent panel
 * — "do not reduce them to a count of accounts", "never state a payer count that
 * is not on this list", "say so plainly". Handing all of that to a two-sentence
 * question measured 16 to 19 seconds a turn, against 4.8 for the full
 * investigation the same brief was written for. The model spends the difference
 * reconciling a small question with a large set of instructions aimed at a
 * different job. The identical question against a 1,100-character brief came back
 * in under two seconds.
 *
 * So this keeps every fact a chat answer might quote and drops all the
 * directives: what is in the data, how bad it is, and one line per finding. About
 * a fifth of the size, which is also a fifth of the per-minute token budget.
 */
export function casualBrief(ev: Evidence): string {
  if (!ev.txCount) return "NO TRANSACTION DATA UPLOADED.";

  const lines: string[] = [
    `PORTFOLIO: ${ev.txCount} transfers, ${ev.accountCount} accounts, ${money(ev.totalValue)} total.`,
    `RISK SPLIT: ${ev.bySeverity.high} high-risk (${money(ev.highValue)}), ${ev.bySeverity.medium} medium, ${ev.bySeverity.safe} routine.`,
  ];
  if (ev.dateRange) lines.push(`PERIOD: ${ev.dateRange.from} to ${ev.dateRange.to}.`);
  if (ev.banks.length) lines.push(`BANKS (${ev.banks.length}): ${ev.banks.join(", ")}.`);

  // Stated as a fact either way. Left to the model it hedged both directions in
  // one breath, and whether money left the country is not a matter of opinion.
  const border = ev.findings.find((f) => f.code === "CROSS-BORDER");
  lines.push(
    border
      ? `CROSS-BORDER: yes — ${money(border.amount)} left India by overseas wire.`
      : `CROSS-BORDER: no — every transfer stayed inside India.`
  );

  if (ev.channels.length) {
    lines.push(
      `CHANNELS: ${ev.channels.map((c) => `${c.type} (${c.count})`).join(", ")} — all electronic, no cash.`
    );
  }
  if (ev.typologies.length) {
    lines.push(`TYPOLOGIES: ${ev.typologies.map((t) => `${t.label} (${t.count})`).join(", ")}.`);
  }

  // `short` exists for the on-screen report — one sentence carrying the numbers —
  // which is exactly what a conversational answer quotes. Five is enough: an
  // answer that reaches for a sixth finding is no longer 2-5 sentences.
  if (ev.findings.length) {
    lines.push(`FINDINGS (${ev.findings.length}):`);
    ev.findings.slice(0, 5).forEach((f) => lines.push(`  - ${f.short}`));
  }

  const notable = ev.rings.filter((r) => r.accounts.length >= 3);
  if (notable.length) {
    const biggest = notable.reduce((a, b) => (b.total > a.total ? b : a));
    lines.push(
      `RINGS: ${notable.length} groups of 3+ linked accounts. Largest is ${biggest.accounts.length} accounts ` +
        `moving ${money(biggest.total)}, shaped as a ${biggest.shapeLabel}` +
        `${biggest.hubs.length ? `, centred on ${biggest.hubs[0]}` : ", with no centre"}.`
    );
  }

  if (ev.topCounterparties.length) {
    lines.push(`BUSIEST ACCOUNTS:`);
    ev.topCounterparties.slice(0, 3).forEach((c) => {
      lines.push(
        `  ${c.account}: received ${money(c.inAmount)} in ${c.inCount}, sent ${money(c.outAmount)} in ${c.outCount}.`
      );
    });
  }

  return lines.join("\n");
}

// ── Offline fallback ──────────────────────────────────────────────────────
// Written straight from the evidence when the AI is unreachable, so the user
// still gets a specific, readable report instead of an error bubble.

export type AgentReport = {
  agent: string;
  headline?: string;
  content: string;
  findings?: string[];
  confidence: number;
};

export function localReport(ev: Evidence): AgentReport[] {
  // One distinct line each. Four copies of the same sentence was the "cold
  // message" complaint in miniature.
  if (!ev.txCount) {
    const head = "Waiting on data";
    const intro = "There's no transaction data loaded yet, so there's nothing to analyse.\n\n";
    return [
      {
        agent: "Graph Analyst",
        headline: head,
        content:
          intro +
          "Once you upload a CSV I'll map who paid whom, group the accounts into separate networks, and point out which account sits at the centre of each one.",
        confidence: 0.4,
      },
      {
        agent: "Risk Analyst",
        headline: head,
        content:
          intro +
          "Give me the file and I'll go looking for the usual tells: payments that shrink at every hop, amounts parked just under a reporting line, and one account quietly collecting from many others.",
        confidence: 0.4,
      },
      {
        agent: "Compliance Officer",
        headline: head,
        content:
          intro +
          "With data loaded I'll tell you which transfers are reportable, what has to go to FIU-IND and by when, and which accounts need their KYC re-checked.",
        confidence: 0.4,
      },
      {
        agent: "Investigation Assistant",
        headline: "Upload a CSV to start",
        content:
          intro +
          "Head to the Upload page and give me a file with these columns: **date, from, to, amount** — plus **bank**, **type** and **note** if you have them, which sharpen the analysis a lot.\n\nThen press Run full investigation and all four of us will report back on your real numbers.",
        findings: [
          "Required columns: date, from, to, amount",
          "Optional but useful: bank, type, note, currency",
        ],
        confidence: 0.4,
      },
    ];
  }

  const rings = ev.rings.filter((r) => r.accounts.length >= 3);
  const pairs = ev.rings.length - rings.length;
  const high = ev.findings.filter((f) => f.severity === "high");

  // Short bullets, not essays. The full reasoning still goes to the AI in the
  // evidence brief; what lands on screen has to be readable at a glance.
  const graph = [
    `• ${ev.txCount} transfers, ${ev.accountCount} accounts, ${ev.rings.length} separate groups — ${rings.length} worth looking at.`,
    ...rings
      .slice(0, 4)
      .map(
        (r, i) =>
          `• **Group ${i + 1} — ${r.typology ?? "untagged"}**: ${r.accounts.length} accounts, ${money(r.total)}, ${r.shapeLabel}.` +
          `${r.hubs.length ? ` Everything passes through ${r.hubs[0]}.` : ""}`
      ),
    ...(rings.length > 4
      ? [`• Plus ${rings.length - 4} smaller ${rings.length - 4 === 1 ? "group" : "groups"} of the same kinds.`]
      : []),
    ...(pairs > 0
      ? [`• The other ${pairs} are plain two-account transfers touching nothing else — ignore them.`]
      : []),
  ].join("\n");

  // Worst-first, and capped — listing all eleven findings at equal weight told
  // the user nothing about what to deal with before lunch.
  const ranked = [...high].sort(
    (a, b) => (RISK_ORDER[a.code] ?? 99) - (RISK_ORDER[b.code] ?? 99) || b.amount - a.amount
  );
  const shown = ranked.slice(0, 5);
  const rest = ranked.length - shown.length;

  const risk = [
    `• ${ev.bySeverity.high} of ${ev.txCount} transfers are high-risk, moving ${money(ev.highValue)} — ` +
      `${ev.totalValue ? Math.round((ev.highValue / ev.totalValue) * 100) : 0}% of all the money here.`,
    // `short` already reads "fact — why", so a bolded title in front of it just
    // says the same thing twice.
    ...(shown.length
      ? shown.map((f) => `• ${f.short}`)
      : [`• Nothing structurally alarming showed up — amounts and counterparties look like ordinary activity.`]),
    ...(rest > 0
      ? [`• Plus ${rest} more high-risk ${rest === 1 ? "finding" : "findings"} of the same kinds.`]
      : []),
  ].join("\n");

  const typLine = ev.typologies.length
    ? ev.typologies.map((t) => `${t.label} (${t.count})`).join(", ")
    : "none tagged";
  const compliance = [
    `• Patterns present: ${typLine}.`,
    `• **PMLA 2002 / FIU-IND**: file an STR within 7 working days of forming suspicion — suspicion is the trigger, not the amount. ` +
      `${ev.bySeverity.high} transfers worth ${money(ev.highValue)} qualify.`,
    ...(ev.findings.some((f) => f.code === "THRESHOLD-HUG")
      ? [`• The ${money(REPORT_THRESHOLD)} line these cluster below is for **cash**, and these are electronic — but sizing payments against it is itself an offence.`]
      : []),
    ...(ev.findings.some((f) => f.code === "CROSS-BORDER")
      ? [`• Overseas wires are separately reportable from ${money(WIRE_REPORT_THRESHOLD)} upward.`]
      : []),
    `• **RBI KYC Master Direction**: pass-through accounts must be re-verified. ` +
      `${ev.findings.some((f) => f.code === "FUNNEL-IN") ? "The collector taking money from many unrelated payers is the textbook case." : "Any account whose turnover doesn't match its declared profile counts."}`,
    ...(ev.findings.some((f) => f.code === "CROSS-BORDER")
      ? [`• **FEMA 1999**: the overseas legs need their purpose codes and supporting documents checked, and anything not yet settled should be recalled while it is still reachable.`]
      : []),
    `• **FATF Recommendation 20**: cross-bank layering is what consortium monitoring exists to catch, since each bank sees only a fragment.`,
  ].join("\n");

  const topAccounts = ev.topCounterparties.slice(0, 3).map((c) => c.account);
  const assistant = [
    `1. **Freeze ${topAccounts.length ? topAccounts.join(", ") : "the hub accounts"}** — they touch the most transfers, so freezing them stops the most movement.`,
    `2. **Pull KYC on the hubs** — check whether declared income matches turnover. A mismatch turns suspicion into evidence.`,
    `3. **File the STR** — ${high.length ? `cite the ${high.length} findings above with their exact amounts and dates.` : "document your reasoning even if you conclude no filing is needed."}`,
    ...(ev.findings.some((f) => f.code === "CROSS-BORDER")
      ? [`4. **Flag the overseas leg today** — it is the last point anything can still be stopped.`]
      : []),
    `${ev.findings.some((f) => f.code === "CROSS-BORDER") ? "5" : "4"}. **Skip the ${pairs} routine transfers** — no structure, no value in chasing them.`,
  ].join("\n");

  return [
    {
      agent: "Graph Analyst",
      headline: `${rings.length} suspicious ${rings.length === 1 ? "group" : "groups"} inside ${ev.accountCount} accounts`,
      content: graph,
      findings: rings
        .slice(0, 4)
        .map((r) => `${r.typology ?? "Untagged"}: ${r.accounts.length} accounts, ${money(r.total)}, ${r.shape} shape`),
      confidence: 0.93,
    },
    {
      agent: "Risk Analyst",
      headline: shown.length ? shown[0].title : "Nothing structurally alarming found",
      content: risk,
      findings: shown.slice(0, 4).map((f) => f.title),
      confidence: 0.91,
    },
    {
      agent: "Compliance Officer",
      headline: `Reportable under PMLA 2002 — STR due within 7 working days`,
      content: compliance,
      findings: [
        `${ev.bySeverity.high} high-risk transfers worth ${money(ev.highValue)} to disclose`,
        ...(ev.findings.some((f) => f.code === "THRESHOLD-HUG") ? ["Threshold-splitting is itself a PMLA offence"] : []),
        ...(ev.findings.some((f) => f.code === "CROSS-BORDER") ? ["FEMA 1999 applies — funds already left India"] : []),
      ],
      confidence: 0.88,
    },
    {
      agent: "Investigation Assistant",
      headline: topAccounts.length ? `Freeze ${topAccounts[0]} first` : "No priority account to freeze",
      content: assistant,
      findings: ev.topCounterparties
        .slice(0, 3)
        .map((c) => `${c.account}: ${c.degree} transfers, ${money(c.volume)}`),
      confidence: 0.9,
    },
  ];
}

// ── The SAR document ──────────────────────────────────────────────────────
// A filed report has to say what was found, in which accounts, and under which
// obligation — all of it from the data in front of the user. This is built from
// the same evidence the agents get, so it changes the moment the transaction
// set does, and it never asserts a statute that the data does not trigger.

export type SARSubject = {
  account: string;
  role: string;
  why: string;
  inCount: number;
  outCount: number;
  inAmount: number;
  outAmount: number;
  banks: string[];
};

export type SARGround = {
  code: string;
  severity: Finding["severity"];
  title: string;
  text: string;
  accounts: string[];
  amount: number;
};

export type SARRegulation = { statute: string; requirement: string; because: string };

export type SARNarrative = {
  headline: string;
  period: string;
  summary: string[];
  subjects: SARSubject[];
  grounds: SARGround[];
  regulations: SARRegulation[];
  actions: string[];
  conclusion: string;
  flaggedCount: number;
  flaggedValue: number;
};

function accountStats(txs: Transaction[]) {
  const m = new Map<
    string,
    { inCount: number; outCount: number; inAmount: number; outAmount: number; banks: Set<string> }
  >();
  const get = (a: string) => {
    let v = m.get(a);
    if (!v) {
      v = { inCount: 0, outCount: 0, inAmount: 0, outAmount: 0, banks: new Set<string>() };
      m.set(a, v);
    }
    return v;
  };
  for (const t of txs) {
    const from = get(t.fromAccount);
    from.outCount += 1;
    from.outAmount += t.amount;
    if (t.bank) from.banks.add(t.bank);
    const to = get(t.toAccount);
    to.inCount += 1;
    to.inAmount += t.amount;
    if (t.bank) to.banks.add(t.bank);
  }
  return m;
}

// Which part an account played, taken from the findings that named it. Findings
// arrive worst-first, and the first label an account earns is kept — so an
// account that is both a link in a chain and the beneficiary of an outbound wire
// is described by the wire, which is the fact that decides what happens next.
// The rank rides along so the report can list subjects by how much they matter
// rather than by how much money passed through them: a chain's origin moves less
// than its middle, and burying it under the intermediaries would be wrong.
function subjectRoles(ev: Evidence): Map<string, { role: string; why: string; rank: number }> {
  const roles = new Map<string, { role: string; why: string; rank: number }>();
  const set = (acc: string, rank: number, role: string, why: string) => {
    if (acc && !roles.has(acc)) roles.set(acc, { role, why, rank });
  };

  for (const f of ev.findings) {
    const first = f.accounts[0];
    const last = f.accounts[f.accounts.length - 1];
    switch (f.code) {
      case "CROSS-BORDER":
        // Careful with the wording: the data shows these legs were sent as
        // overseas wires, not that the receiving account is itself foreign.
        // Calling a domestic intermediary an "offshore account" is a claim the
        // transaction file does not support and a reviewer would catch.
        f.accounts.forEach((a) =>
          set(a, 0, "Beneficiary of an overseas wire", "Received funds on a leg sent as an overseas wire — the last point at which they were still within reach.")
        );
        break;
      case "THRESHOLD-HUG":
        f.accounts.forEach((a) =>
          set(a, 1, "Sender of structured payments", `Sent payments deliberately sized below the ${money(REPORT_THRESHOLD)} reporting line.`)
        );
        break;
      case "CHAIN-DECAY":
        set(first, 2, "Origin of the layering chain", `Released ${money(f.amount)} into a chain of ${f.accounts.length} accounts.`);
        set(last, 2, "End of the layering chain", "Holds what survived the chain — the point where the money comes to rest.");
        f.accounts
          .slice(1, -1)
          .forEach((a) => set(a, 4, "Intermediary in the chain", "Held the funds briefly and passed nearly all of them onward."));
        break;
      case "FUNNEL-IN":
        set(first, 2, "Collector — suspected money mule", `Took ${money(f.amount)} from ${Math.max(f.accounts.length - 1, 0)} unrelated payers and forwarded it.`);
        f.accounts.slice(1).forEach((a) => set(a, 5, "Feeder into the collector", "One of the accounts paying into the collector."));
        break;
      case "FAN-OUT":
        set(first, 3, "Distributor of split payments", `Broke ${money(f.amount)} into ${Math.max(f.accounts.length - 1, 0)} smaller transfers.`);
        f.accounts.slice(1).forEach((a) => set(a, 5, "Recipient of a split payment", "Received one slice of a sum that was deliberately broken up."));
        break;
      // BANK-HOP and BURST name every account in the dataset, which would make
      // a subject list of everyone and single out no one. Deliberately skipped.
      default:
        break;
    }
  }
  return roles;
}

export function sarNarrative(ev: Evidence, txs: Transaction[]): SARNarrative {
  const period = ev.dateRange ? `${ev.dateRange.from} to ${ev.dateRange.to}` : "period not stated in the data";
  const flagged = txs.filter((t) => t.severity === "high");
  const flaggedValue = flagged.reduce((s, t) => s + t.amount, 0);

  if (!ev.txCount) {
    return {
      headline: "No transaction data loaded",
      period,
      summary: [
        "There is no transaction data loaded against this account, so no suspicion can be formed and nothing here is reportable. Upload a CSV and this report will rewrite itself from that data.",
      ],
      subjects: [],
      grounds: [],
      regulations: [],
      actions: ["Upload transaction data before filing anything."],
      conclusion: "This report is incomplete and must not be filed in its current state.",
      flaggedCount: 0,
      flaggedValue: 0,
    };
  }

  const high = ev.findings.filter((f) => f.severity === "high");
  const border = ev.findings.find((f) => f.code === "CROSS-BORDER");
  const structuring = ev.findings.find((f) => f.code === "THRESHOLD-HUG");
  const funnel = ev.findings.find((f) => f.code === "FUNNEL-IN");
  const chain = ev.findings.find((f) => f.code === "CHAIN-DECAY");
  const share = ev.totalValue ? Math.round((flaggedValue / ev.totalValue) * 100) : 0;

  // ── Summary ──
  const summary: string[] = [];
  summary.push(
    `${ev.txCount} transfers between ${ev.accountCount} accounts, worth ${money(ev.totalValue)} in total, were reviewed for the period ${period}. ` +
      `${flagged.length} of them — ${money(flaggedValue)}, ${share}% of the money in the file — carry indicators of money laundering and are the subject of this report.`
  );

  if (ev.findings.length) {
    const lead = ev.findings[0];
    const others = ev.findings.length - 1;
    // The counts have to agree with each other. "2 further indicators, 3 of
    // which are high severity" was arithmetic nonsense — the high count covered
    // the whole set including the one just described.
    const otherHigh = high.filter((f) => f !== lead).length;
    summary.push(
      `The concern is not any single payment but the shape of the activity. ${lead.short} ` +
        (others > 0
          ? `${others} further ${others === 1 ? "indicator is" : "indicators are"} set out below` +
            (otherHigh > 0
              ? `, ${otherHigh === others ? (others === 1 ? "also high severity" : "all of them high severity") : `${otherHigh} of ${others === 1 ? "them" : "them"} high severity`}.`
              : `.`)
          : `It is set out in full below.`)
    );
  } else {
    summary.push(
      `No structural indicator of laundering was found: the amounts, counterparties and timing all look like ordinary activity. ` +
        `This report records that review rather than a suspicion.`
    );
  }

  const closing: string[] = [];
  if (ev.banks.length >= 3) {
    closing.push(
      `The money moved through ${ev.banks.length} banks (${ev.banks.join(", ")}), so no single institution saw more than its own share of it.`
    );
  }
  closing.push(
    border
      ? `${money(border.amount)} has already left India by overseas wire. Once it settles abroad it is effectively beyond recall, which makes this report time-critical.`
      : `Every transfer stayed inside India, so the funds remain within reach of domestic freezing and attachment powers.`
  );
  summary.push(closing.join(" "));

  // ── Subjects ──
  const stats = accountStats(txs);
  const roles = subjectRoles(ev);
  const subjects: SARSubject[] = Array.from(roles.entries())
    .map(([account, r]) => {
      const s = stats.get(account);
      return {
        account,
        role: r.role,
        why: r.why,
        rank: r.rank,
        inCount: s?.inCount ?? 0,
        outCount: s?.outCount ?? 0,
        inAmount: s?.inAmount ?? 0,
        outAmount: s?.outAmount ?? 0,
        banks: s ? Array.from(s.banks) : [],
      };
    })
    // By role first, volume only to break ties. Sorting on volume alone put the
    // chain's intermediaries above its origin, which reads as though the
    // pass-through accounts mattered more than the account that started it.
    .sort((a, b) => a.rank - b.rank || b.inAmount + b.outAmount - (a.inAmount + a.outAmount))
    .slice(0, 8)
    .map(({ rank: _rank, ...s }) => s);

  // ── Grounds for suspicion ──
  const grounds: SARGround[] = ev.findings.map((f) => ({
    code: f.code,
    severity: f.severity,
    title: f.title,
    text: f.plain,
    accounts: f.accounts,
    amount: f.amount,
  }));

  // ── Regulatory basis ──
  // Conditional on purpose. A report that cites FEMA when no money left the
  // country, or a cash threshold against electronic transfers, is wrong in a way
  // a reviewer will notice immediately.
  const regulations: SARRegulation[] = [];
  regulations.push({
    statute: "PMLA 2002, s.12 read with PML (Maintenance of Records) Rules 2005, r.3",
    requirement: "File a Suspicious Transaction Report with FIU-IND within 7 working days of forming the suspicion.",
    because: ev.findings.length
      ? `${flagged.length} transfers worth ${money(flaggedValue)} show ${ev.findings.length} structural ${ev.findings.length === 1 ? "indicator" : "indicators"} of laundering. Suspicion — not the amount — is what triggers the obligation.`
      : `No suspicion has been formed on this data, so no STR is due. The review itself is recorded here.`,
  });

  if (structuring) {
    regulations.push({
      statute: `PMLA 2002 — structuring (payments sized against the ${money(REPORT_THRESHOLD)} line)`,
      requirement: "Report the pattern, not just the individual payments, and preserve the sequencing evidence.",
      because:
        `${structuring.title}. That line applies to cash and these are electronic transfers, so no Cash Transaction Report is due — ` +
        `but deliberately sizing payments to sit under a reporting figure is an offence in its own right.`,
    });
  }

  if (border) {
    regulations.push({
      statute: "FEMA 1999 and the Cross-Border Wire Transfer Report (CBWTR)",
      requirement: `Verify purpose codes and supporting documents on every overseas leg; overseas wires are separately reportable from ${money(WIRE_REPORT_THRESHOLD)} upward.`,
      because: `${money(border.amount)} left India by wire, so the cross-border regime is engaged on top of the STR obligation.`,
    });
  }

  regulations.push({
    statute: "RBI Master Direction on KYC, 2016 (as amended)",
    requirement: "Carry out enhanced due diligence and re-verify the customer profile of every account named in the accounts-of-interest section.",
    because: funnel
      ? `${funnel.accounts[0]} takes money from many unrelated payers and passes it straight on — the textbook pass-through account the ongoing-due-diligence obligation exists for.`
      : `Turnover on the accounts above does not obviously match a declared profile, which is the trigger for re-verification.`,
  });

  if (ev.banks.length >= 3) {
    regulations.push({
      statute: "FATF Recommendation 20",
      requirement: "Report the suspicion promptly and in full, including the legs held at other institutions.",
      because: `The flow was split across ${ev.banks.length} banks, so this institution's own records show only a fragment of it. The report has to describe the whole picture, not just the part visible here.`,
    });
  }

  // ── Recommended actions ──
  const actions: string[] = [];
  const alreadyNamed = new Set<string>();
  if (border) {
    const exits = border.accounts.slice(0, 3);
    exits.forEach((a) => alreadyNamed.add(a));
    actions.push(
      `Flag the overseas leg today — ${money(border.amount)} to ${exits.join(", ")}. It is the last point at which anything can still be stopped.`
    );
  }
  // Freezing is a volume decision, and it should not repeat accounts the line
  // above already covers — an action list that names the same three accounts
  // twice reads as padding and tells the reader nothing new.
  const freezeTargets = subjects
    .filter((s) => !alreadyNamed.has(s.account))
    .sort((a, b) => b.inAmount + b.outAmount - (a.inAmount + a.outAmount))
    .slice(0, 3)
    .map((s) => s.account);
  if (freezeTargets.length) {
    actions.push(
      `Place a hold on ${freezeTargets.join(", ")} — the largest movers not already covered above, so a hold there stops the most remaining money.`
    );
  }
  actions.push(
    `Pull KYC and declared income for every account named above and compare it against the turnover shown there. A mismatch is what turns suspicion into evidence.`
  );
  if (chain) {
    actions.push(
      `Obtain statements for the full chain (${chain.accounts.slice(0, 6).join(" → ")}${chain.accounts.length > 6 ? " …" : ""}) so the route can be evidenced hop by hop rather than inferred.`
    );
  }
  actions.push(
    ev.findings.length
      ? `File the STR within 7 working days, citing the ${ev.findings.length} ${ev.findings.length === 1 ? "ground" : "grounds"} set out above with the exact amounts and dates given there.`
      : `Record the reasoning for not filing, so the decision is documented if the accounts resurface later.`
  );
  const routine = ev.txCount - flagged.length;
  if (routine > 0) {
    actions.push(`Leave the remaining ${routine} transfers alone — they show no structure and chasing them costs time for nothing.`);
  }

  const headline = ev.findings.length
    ? ev.findings[0].title
    : `Review of ${ev.txCount} transfers — no suspicion formed`;

  const conclusion = ev.findings.length
    ? `On the ${ev.findings.length} ${ev.findings.length === 1 ? "ground" : "grounds"} set out above, there is reasonable ground to suspect that the transfers listed in the reported-transactions section involve the proceeds of crime. ` +
      `This report is made under section 12 of the Prevention of Money Laundering Act, 2002. The findings are drawn from the transaction data as it stood on the date of generation and should be read together with the account statements for the accounts named above.`
    : `No reasonable ground for suspicion arises on the data reviewed. This report records the review and its outcome; it is not an STR and should not be filed as one.`;

  return {
    headline,
    period,
    summary,
    subjects,
    grounds,
    regulations,
    actions,
    conclusion,
    flaggedCount: flagged.length,
    flaggedValue,
  };
}

function classifyShape(
  bucket: string[],
  ringTxs: Transaction[],
  inDeg: Map<string, number>,
  outDeg: Map<string, number>,
  ends: { from: string; to: string } | null
): { shape: RingSummary["shape"]; shapeLabel: string } {
  if (bucket.length <= 2) {
    return { shape: "pair", shapeLabel: "a simple one-to-one transfer" };
  }

  const deg = (a: string) => (inDeg.get(a) ?? 0) + (outDeg.get(a) ?? 0);
  const top = bucket.slice().sort((a, b) => deg(b) - deg(a))[0];

  // One account touching everyone else = a star. Direction says which kind.
  if (deg(top) >= bucket.length - 1 && deg(top) >= 3) {
    const incoming = inDeg.get(top) ?? 0;
    const outgoing = outDeg.get(top) ?? 0;
    if (incoming > outgoing) {
      return {
        shape: "collector",
        shapeLabel: "a funnel — many accounts paying into one collector",
      };
    }
    return {
      shape: "distributor",
      shapeLabel: "a fan-out — one account splitting money across many receivers",
    };
  }

  // A chain is a single path: one entry, one exit, and every account in between
  // taking exactly one payment in and passing one on. Counting edges and total
  // degree alone is not enough — three payers sending to four payees satisfies
  // both and is a set of ordinary business payments, not a chain. Requiring one
  // source and one sink is what separates a path from a tree, and calling
  // someone's rent and consulting fees "a chain" is a false accusation.
  const isChain =
    !!ends &&
    ringTxs.length === bucket.length - 1 &&
    bucket.every((a) => (inDeg.get(a) ?? 0) <= 1 && (outDeg.get(a) ?? 0) <= 1);
  if (isChain) {
    return { shape: "chain", shapeLabel: "a chain — money hopping account to account in sequence" };
  }

  // No account both receives and passes money on, so nothing is travelling
  // through anyone — these are separate payments that merely share a payer or a
  // payee. That absence is the point: layering needs pass-through, so a group
  // without it is the boring kind, and saying so is more useful than "a web".
  if (!bucket.some((a) => (inDeg.get(a) ?? 0) && (outDeg.get(a) ?? 0))) {
    return {
      shape: "web",
      shapeLabel: "separate payments — no account both receives money and passes it on",
    };
  }

  return { shape: "web", shapeLabel: "a connected web of accounts" };
}

