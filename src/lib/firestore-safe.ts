// Firestore write helpers: path builders, an `undefined`-stripping sanitiser, and
// a document-size cap for traces.
//
// Why the sanitiser exists. Firestore rejects a write containing `undefined`
// anywhere in the payload. Several fields in this app are legitimately optional
// and left undefined — `CaseMeta.amount_lost_inr`, `LegalNotice.amountInr`,
// `LegalNotice.case`, `TraceResult.case`, `WalletTransfer.block`. Today they are
// invisible because every trace crosses `NextResponse.json`, and JSON silently
// drops undefined object properties. Writing straight to Firestore loses that
// protection, so the same job has to be done deliberately.
//
// `ignoreUndefinedProperties` is also enabled on the Firestore instance (see
// firebase.ts) — belt and braces. This module is the explicit half, so the data
// that lands in the database is the data we meant to send.

import {
  collection,
  doc,
  type CollectionReference,
  type DocumentReference,
  type Firestore,
} from "firebase/firestore";
import type { TraceResult } from "./domain";

// ── Paths ───────────────────────────────────────────────────────────────────
// Everything a signed-in officer owns hangs off users/{uid}, which is exactly
// what the security rule matches. Callers pass `db` explicitly because it is
// null when Firebase isn't configured — that keeps the null check at the call
// site where TypeScript can narrow it, rather than hiding a non-null assertion
// in here.

/** `users/{uid}/{name}` — a per-officer collection (traces, notices). */
export function userCollection(
  dbi: Firestore,
  uid: string,
  name: string
): CollectionReference {
  return collection(dbi, "users", uid, name);
}

/** `users/{uid}/{...segments}` — a per-officer document. */
export function userDoc(
  dbi: Firestore,
  uid: string,
  ...segments: string[]
): DocumentReference {
  return doc(dbi, "users", uid, ...segments);
}

/**
 * Mint a document ID locally, with no network round trip.
 *
 * `doc(collectionRef)` generates the ID client-side, which is what lets
 * `generateNotice()` stay synchronous: it can return the new notice's ID to its
 * caller immediately and let the write land afterwards.
 */
export function newId(col: CollectionReference): string {
  return doc(col).id;
}

// ── Sanitiser ───────────────────────────────────────────────────────────────

/**
 * Deep-copy `value`, dropping every `undefined` object property and array entry.
 *
 * `null` is preserved — it is a real Firestore value and meaningful here
 * (`activeTraceId: null` means "no active trace", which is different from the
 * field being absent). Non-plain objects (class instances such as Firestore's
 * `FieldValue` sentinels, `Date`) pass through untouched so we never mangle one
 * by rebuilding it as a plain object.
 */
export function sanitize<T>(value: T): T {
  return walk(value) as T;
}

function walk(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) {
    // Firestore has no notion of a hole or an undefined element, so drop them
    // rather than writing nulls that would change the array's meaning.
    return v.filter((x) => x !== undefined).map(walk);
  }
  if (!isPlainObject(v)) return v;

  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined) continue;
    out[k] = walk(val);
  }
  return out;
}

/**
 * Plain data object, not a class instance.
 *
 * Checking the prototype (rather than `typeof v === "object"`) is what keeps
 * `serverTimestamp()` sentinels, `Timestamp`s and `Date`s intact — rebuilding
 * one of those as a plain object would produce `{}` and silently lose the value.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ── Document size cap ───────────────────────────────────────────────────────

/** A live 5-hop trace can outgrow Firestore's 1 MiB document limit. */
export const MAX_STORED_TRANSFERS = 1200;
export const MAX_STORED_NODES = 600;

/**
 * Trim a trace so it fits comfortably inside one Firestore document.
 *
 * A transfer serialises to roughly 300 bytes, so 1200 of them plus 600 nodes is
 * ~500 KB — half the 1 MiB ceiling, with room for the case metadata. Transfers
 * are kept by USD value so the trim drops dust rather than the movements an
 * officer actually cares about, and nodes are kept by hop so the trail stays
 * connected from the victim entry outward.
 *
 * Returns the trace unchanged (same object identity) when nothing needs
 * trimming, which is the common case and matters because `buildEvidence` is
 * memoised on trace identity.
 */
export function capTraceForStorage(trace: TraceResult): TraceResult & { truncated?: boolean } {
  const overTransfers = trace.transfers.length > MAX_STORED_TRANSFERS;
  const overNodes = trace.nodes.length > MAX_STORED_NODES;
  if (!overTransfers && !overNodes) return trace;

  const transfers = overTransfers
    ? [...trace.transfers]
        .sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0))
        .slice(0, MAX_STORED_TRANSFERS)
    : trace.transfers;

  // Keep every wallet the surviving transfers still reference, so the stored
  // graph has no dangling edges, then fill the remaining budget by hop order.
  const referenced = new Set<string>();
  for (const t of transfers) {
    referenced.add(t.from_address.toLowerCase());
    referenced.add(t.to_address.toLowerCase());
  }
  const nodes = overNodes
    ? [...trace.nodes]
        .sort((a, b) => {
          const aRef = referenced.has(a.address.toLowerCase()) ? 0 : 1;
          const bRef = referenced.has(b.address.toLowerCase()) ? 0 : 1;
          return aRef - bRef || (a.hop ?? 0) - (b.hop ?? 0);
        })
        .slice(0, MAX_STORED_NODES)
    : trace.nodes;

  return { ...trace, transfers, nodes, truncated: true };
}
