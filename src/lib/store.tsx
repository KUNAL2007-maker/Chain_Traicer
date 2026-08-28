"use client";

/**
 * Trace store — the single source of truth every tab reads from.
 *
 * Backed by Firestore when Firebase is configured, and by plain React state when
 * it isn't (see AuthProvider: an unconfigured project still boots into a working
 * offline demo). The public shape is identical either way, so no view knows or
 * cares which mode it is in.
 *
 * ── What is realtime and what is not, and why ────────────────────────────────
 *
 * Not everything should stream. Three different strategies, each chosen for a
 * concrete reason:
 *
 *   • The ACTIVE TRACE lives in local state, written through to Firestore and
 *     read back once at sign-in. It deliberately does NOT use onSnapshot: the
 *     whole forensic engine (`buildEvidence`) and the graph layout are memoised
 *     on the trace's *object identity*, and a snapshot hands back a fresh object
 *     every time it fires — so streaming it would re-run the engine and re-lay
 *     out the graph on every unrelated write.
 *
 *   • CASE METADATA is local state with a debounced write-through. The officer
 *     types into six controlled inputs, so a snapshot echo would fight the
 *     cursor and cost one write per keystroke.
 *
 *   • NOTICES and TRACE HISTORY do stream via onSnapshot. Small documents, cheap
 *     to re-render, and genuinely useful live — draft a notice on one machine and
 *     it appears on the other.
 *
 * The derived engine output (`evidence`, and the dual-track freeze decision on
 * it) is memoised on the trace, so findings, VASP attribution, the graph and the
 * track banner all recompute exactly once when a new trace lands.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { deleteDoc, doc, getDoc, limit, onSnapshot, orderBy, query, setDoc, updateDoc } from "firebase/firestore";
import type { TraceResult, CaseMeta, WalletTransfer } from "@/lib/domain";
import {
  buildEvidence,
  section91Notice,
  type CryptoEvidence,
  type CryptoFinding,
  type LegalNotice,
  type TrackDecision,
} from "@/lib/investigation";
import { db, prettyFirestoreError } from "@/lib/firebase";
import { capTraceForStorage, newId, sanitize, userCollection, userDoc } from "@/lib/firestore-safe";
import { useAuth } from "@/components/AuthProvider";

// ── Types ────────────────────────────────────────────────────────────────────

export type TraceStatus = "idle" | "tracing" | "ready" | "error";
export type NoticeStatus = "Draft" | "Issued" | "Acknowledged";

/** A generated Section 91 notice plus the workflow state we track around it. */
export type StoredNotice = {
  id: string;
  status: NoticeStatus;
  createdAt: number;
  notice: LegalNotice;
};

type TraceStore = {
  // Core state
  trace: TraceResult | null;
  status: TraceStatus;
  error: string | null;
  /** The "address shape didn't match a chain" hint the trace API may return. */
  traceNote: string | null;
  caseMeta: CaseMeta;
  history: TraceResult[];
  notices: StoredNotice[];

  // Derived engine outputs (memoised on `trace`)
  evidence: CryptoEvidence | null;
  track: TrackDecision | null;

  /** Reading the saved case back from the database at sign-in. */
  hydrating: boolean;
  /** False when Firebase isn't configured — nothing survives a refresh. */
  persistent: boolean;
  /** A background live-feed poll is in flight (distinct from a fresh trace). */
  refreshing: boolean;
  /** tx_hashes the most recent poll saw for the first time. */
  newTxHashes: string[];

  // Actions
  runTrace: (seed: string) => Promise<void>;
  loadDemo: () => Promise<void>;
  clearTrace: () => void;
  setCaseMeta: (patch: Partial<CaseMeta>) => void;
  generateNotice: (targetVaspName: string) => string | null;
  setNoticeStatus: (id: string, status: NoticeStatus) => void;
  removeNotice: (id: string) => void;
  /** Re-walk the current seed and flag anything new. Used by the live feed. */
  refreshTrace: () => Promise<void>;
};

// ── Context ──────────────────────────────────────────────────────────────────

const Ctx = createContext<TraceStore | null>(null);

/** How long to wait after the last keystroke before saving case metadata. */
const CASE_WRITE_DEBOUNCE_MS = 700;
/** Past traces kept in the history list. */
const HISTORY_LIMIT = 20;

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

/** CaseMeta the officer has actually filled in — empty strings/undefined dropped. */
function definedCase(meta: CaseMeta): CaseMeta {
  const out: CaseMeta = {};
  (Object.keys(meta) as (keyof CaseMeta)[]).forEach((k) => {
    const v = meta[k];
    if (v !== undefined && v !== null && v !== "") {
      // The two number fields and the string fields share this guard; the cast
      // keeps TypeScript happy across the union without widening the value.
      (out as Record<string, unknown>)[k] = v;
    }
  });
  return out;
}

export function TraceStoreProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  // Offline covers both "no Firebase config" and "not signed in yet": in either
  // case there is nowhere to write, so the store behaves as pure local state.
  const offline = !db || !uid || (user?.offline ?? true);

  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [status, setStatus] = useState<TraceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [traceNote, setTraceNote] = useState<string | null>(null);
  const [caseMeta, setCaseMetaState] = useState<CaseMeta>({});
  const [history, setHistory] = useState<TraceResult[]>([]);
  const [notices, setNotices] = useState<StoredNotice[]>([]);
  const [hydrating, setHydrating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newTxHashes, setNewTxHashes] = useState<string[]>([]);

  // Firestore id of the trace document the officer is currently working in, so a
  // live-feed refresh updates that case rather than filing a new one every poll.
  const activeTraceId = useRef<string | null>(null);
  // Only write case metadata the officer actually edited. Without this, the
  // values we just hydrated would be written straight back on mount.
  const caseDirty = useRef(false);
  // Guards against overlapping polls if one refresh outlives its interval.
  const refreshInFlight = useRef(false);
  // Offline-only notice ids. Unused when Firestore mints them.
  const noticeSeq = useRef(0);

  // The whole forensic engine runs here, once per trace: findings, VASP
  // attribution and the dual-track freeze decision. `evidence.track` is already
  // populated by buildEvidence, so `track` is just a convenient alias.
  const evidence = useMemo(() => (trace ? buildEvidence(trace) : null), [trace]);
  const track = evidence?.track ?? null;

  // ── Subscriptions: notices + trace history ────────────────────────────────
  useEffect(() => {
    const database = db;
    if (!database || !uid || offline) return;

    const noticesQuery = query(
      userCollection(database, uid, "notices"),
      orderBy("createdAt", "desc")
    );
    const unsubNotices = onSnapshot(
      noticesQuery,
      (snap) => {
        setNotices(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              status: (data.status as NoticeStatus) ?? "Draft",
              createdAt: (data.createdAt as number) ?? 0,
              notice: data.notice as LegalNotice,
            };
          })
        );
      },
      // Surfacing this matters: without it a permission-denied rule set looks
      // exactly like an empty collection, which is a miserable thing to debug.
      (err) => setError(prettyFirestoreError(err))
    );

    const historyQuery = query(
      userCollection(database, uid, "traces"),
      orderBy("createdAt", "desc"),
      limit(HISTORY_LIMIT)
    );
    const unsubHistory = onSnapshot(
      historyQuery,
      (snap) => setHistory(snap.docs.map((d) => d.data() as TraceResult)),
      (err) => setError(prettyFirestoreError(err))
    );

    return () => {
      unsubNotices();
      unsubHistory();
    };
  }, [uid, offline]);

  // ── One-shot hydration of the case the officer left open ──────────────────
  useEffect(() => {
    // Whoever just signed in, start from a clean slate — otherwise the previous
    // officer's case would still be on screen while theirs loads.
    setTrace(null);
    setStatus("idle");
    setError(null);
    setTraceNote(null);
    setCaseMetaState({});
    setNewTxHashes([]);
    activeTraceId.current = null;
    caseDirty.current = false;

    const database = db;
    if (!database || !uid || offline) {
      setHydrating(false);
      return;
    }

    let cancelled = false;
    setHydrating(true);

    (async () => {
      try {
        const [caseSnap, stateSnap] = await Promise.all([
          getDoc(userDoc(database, uid, "meta", "case")),
          getDoc(userDoc(database, uid, "meta", "state")),
        ]);
        if (cancelled) return;

        if (caseSnap.exists()) setCaseMetaState(caseSnap.data() as CaseMeta);

        const openId = stateSnap.exists()
          ? ((stateSnap.data().activeTraceId as string | null) ?? null)
          : null;
        if (!openId) return;

        const traceSnap = await getDoc(userDoc(database, uid, "traces", openId));
        if (cancelled || !traceSnap.exists()) return;

        activeTraceId.current = openId;
        setTrace(traceSnap.data() as TraceResult);
        setStatus("ready");
      } catch (err) {
        if (!cancelled) setError(prettyFirestoreError(err));
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uid, offline]);

  // ── Debounced write-through of case metadata ──────────────────────────────
  useEffect(() => {
    const database = db;
    if (!database || !uid || offline || !caseDirty.current) return;

    const handle = setTimeout(() => {
      // setDoc without merge, deliberately: definedCase() has already dropped
      // the fields the officer cleared, and a full overwrite is what makes
      // clearing one actually remove it (merge would leave the old value).
      setDoc(userDoc(database, uid, "meta", "case"), sanitize(definedCase(caseMeta))).catch(
        (err) => setError(prettyFirestoreError(err))
      );
    }, CASE_WRITE_DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [caseMeta, uid, offline]);

  // ── Trace persistence ─────────────────────────────────────────────────────

  /**
   * Write a trace and point `meta/state` at it.
   *
   * Not awaited by callers: the trace is already on screen from local state, so
   * the write is a background durability step, not something the UI waits on.
   */
  const persistTrace = useCallback(
    (data: TraceResult, mode: "new" | "update") => {
      const database = db;
      if (!database || !uid || offline) return;

      const traces = userCollection(database, uid, "traces");
      const id =
        mode === "update" && activeTraceId.current ? activeTraceId.current : newId(traces);
      activeTraceId.current = id;

      // capTraceForStorage keeps the document under Firestore's 1 MiB limit; it
      // returns the trace untouched (same identity) when no trim is needed.
      const payload = sanitize({
        ...capTraceForStorage(data),
        createdAt: Date.now(),
      });

      setDoc(doc(traces, id), payload).catch((err) => setError(prettyFirestoreError(err)));
      setDoc(userDoc(database, uid, "meta", "state"), { activeTraceId: id }).catch((err) =>
        setError(prettyFirestoreError(err))
      );
    },
    [uid, offline]
  );

  const ingest = useCallback(
    (data: TraceResult & { note?: string }, mode: "new" | "update" = "new") => {
      setTrace(data);
      // `warnings` carries provider failures and rate limits up from the tracer.
      // Folding them into the same amber note as `note` is deliberate: an
      // incomplete trail has to be visible on the screen the officer is already
      // looking at, not buried in a server log they will never open.
      const notes = [
        ...(typeof data.note === "string" ? [data.note] : []),
        ...(Array.isArray(data.warnings) ? data.warnings : []),
      ];
      // Newline-joined, and rendered with `whitespace-pre-line`: joining with a
      // space ran two separate warnings into one nonsense sentence ("…aborted due
      // to timeout Walk stopped at the 40-wallet limit").
      setTraceNote(notes.length ? notes.join("\n") : null);
      setStatus("ready");
      // History comes from Firestore when online; keep the local list for the
      // offline demo so the "recent traces" panel still fills in.
      if (offline) setHistory((h) => [data, ...h].slice(0, HISTORY_LIMIT));
      persistTrace(data, mode);
    },
    [offline, persistTrace]
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  const runTrace = useCallback(
    async (seed: string) => {
      const s = seed.trim();
      if (!s) return;
      setStatus("tracing");
      setError(null);
      setTraceNote(null);
      setNewTxHashes([]);
      try {
        const dc = definedCase(caseMeta);
        const body: Record<string, unknown> = { seed: s };
        if (Object.keys(dc).length) body.caseMeta = dc;
        const data = await postJSON<TraceResult & { note?: string }>("/api/trace", body);
        ingest(data, "new");
      } catch {
        setStatus("error");
        setError("Couldn't reach the tracer. Check the server and try again.");
      }
    },
    [caseMeta, ingest]
  );

  const loadDemo = useCallback(async () => {
    setStatus("tracing");
    setError(null);
    setTraceNote(null);
    setNewTxHashes([]);
    try {
      const dc = definedCase(caseMeta);
      const body: Record<string, unknown> = { demo: true };
      if (Object.keys(dc).length) body.caseMeta = dc;
      const data = await postJSON<TraceResult & { note?: string }>("/api/trace", body);
      ingest(data, "new");
    } catch {
      setStatus("error");
      setError("Couldn't reach the tracer. Check the server and try again.");
    }
  }, [caseMeta, ingest]);

  /**
   * Live-feed poll: check whether the seed wallet has moved anything, and only
   * pay for a full re-walk if it has.
   *
   * The two-step shape is a quota decision, not a style one. A full trace costs
   * up to ~80 provider calls; at one poll a minute that is ~115,000 calls a day
   * against a 100,000/day Etherscan key, so a console left open on a desk would
   * exhaust the quota and then start returning nothing. The probe costs 2 calls
   * (~2,900/day), and the expensive walk runs only when the probe finds a hash
   * we have never seen.
   *
   * If nothing changed this returns without touching state, which keeps `trace`
   * identity stable — otherwise a 60-second poll would re-run the forensic
   * engine and re-lay out the graph every minute for no reason.
   */
  const refreshTrace = useCallback(async () => {
    const current = trace;
    if (!current || refreshInFlight.current) return;

    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      const seen = new Set(current.transfers.map((t) => t.tx_hash));
      const seedLc = current.seed.toLowerCase();
      // Newest transfer we already hold that the SEED itself sent. This is the
      // watermark the probe is compared against.
      const lastSeedTs = current.transfers.reduce(
        (m, t) => (t.from_address?.toLowerCase() === seedLc ? Math.max(m, t.timestamp ?? 0) : m),
        0
      );

      // Step 1 — the cheap question: anything new at the seed?
      const probe = await postJSON<{
        probe: true;
        hashes: string[];
        latestTs: number;
        degraded?: boolean;
      }>("/api/trace", { seed: current.seed, chain: current.seed_chain, probe: true });

      // An empty hash list means either a mock trace, no live providers, or a
      // degraded probe. In none of those cases would a full re-walk help, and in
      // the degraded case it would spend the very quota we are trying to protect.
      if (!probe.hashes?.length) return;

      // Compare TIMESTAMPS, not hash sets. The stored trace keeps only the top
      // few outgoing transfers per wallet, so the probe legitimately sees hashes
      // we never stored — treating those as new would re-walk the whole graph on
      // every single poll, which is the cost this two-step exists to avoid.
      const movedAgain = lastSeedTs > 0 ? probe.latestTs > lastSeedTs : probe.hashes.some((h) => !seen.has(h));
      if (!movedAgain) return;

      // Step 2 — something moved, so the full walk is now worth its cost.
      const dc = definedCase(caseMeta);
      const body: Record<string, unknown> = { seed: current.seed };
      if (Object.keys(dc).length) body.caseMeta = dc;
      const data = await postJSON<TraceResult & { note?: string }>("/api/trace", body);

      const fresh = data.transfers.filter((t) => !seen.has(t.tx_hash)).map((t) => t.tx_hash);
      if (fresh.length === 0) return;

      setNewTxHashes(fresh);
      ingest(data, "update");
    } catch {
      // A failed poll is not a case error. Keep showing the last good trace
      // rather than replacing the officer's screen with a network message.
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [trace, caseMeta, ingest]);

  const clearTrace = useCallback(() => {
    setTrace(null);
    setStatus("idle");
    setError(null);
    setTraceNote(null);
    setNewTxHashes([]);

    // Drop the pointer, but keep the trace document — it stays in history.
    const database = db;
    if (database && uid && !offline) {
      setDoc(userDoc(database, uid, "meta", "state"), { activeTraceId: null }).catch(() => {
        /* losing the pointer is cosmetic; don't nag the officer about it */
      });
    }
    activeTraceId.current = null;
  }, [uid, offline]);

  const setCaseMeta = useCallback((patch: Partial<CaseMeta>) => {
    caseDirty.current = true;
    setCaseMetaState((m) => ({ ...m, ...patch }));
  }, []);

  /**
   * Draft a Section 91 notice. Stays SYNCHRONOUS and returns the new id.
   *
   * Firestore mints document ids client-side with no round trip, so we can hand
   * the id straight back to the caller (LegalNoticesView selects it, the graph
   * drawer switches tabs to it) and let the write land on its own. There is no
   * optimistic insert here: onSnapshot fires from the local cache before the
   * server acknowledges, so the notice appears immediately and exactly once.
   */
  const generateNotice = useCallback(
    (targetVaspName: string): string | null => {
      if (!evidence) return null;
      // Prefer the officer's edited case fields, falling back to whatever the
      // trace itself carried, so a notice always names the freshest NCRP details.
      const effectiveCase: CaseMeta = { ...(evidence.case ?? {}), ...definedCase(caseMeta) };
      const notice = section91Notice(evidence, effectiveCase, targetVaspName);
      const createdAt = Date.now();

      const database = db;
      if (!database || !uid || offline) {
        const id = `NTC-${++noticeSeq.current}`;
        setNotices((list) => [{ id, status: "Draft", createdAt, notice }, ...list]);
        return id;
      }

      const col = userCollection(database, uid, "notices");
      const id = newId(col);
      setDoc(doc(col, id), sanitize({ status: "Draft", createdAt, notice })).catch((err) =>
        setError(prettyFirestoreError(err))
      );
      return id;
    },
    [evidence, caseMeta, uid, offline]
  );

  const setNoticeStatus = useCallback(
    (id: string, s: NoticeStatus) => {
      const database = db;
      if (!database || !uid || offline) {
        setNotices((list) => list.map((n) => (n.id === id ? { ...n, status: s } : n)));
        return;
      }
      updateDoc(doc(userCollection(database, uid, "notices"), id), { status: s }).catch((err) =>
        setError(prettyFirestoreError(err))
      );
    },
    [uid, offline]
  );

  const removeNotice = useCallback(
    (id: string) => {
      const database = db;
      if (!database || !uid || offline) {
        setNotices((list) => list.filter((n) => n.id !== id));
        return;
      }
      deleteDoc(doc(userCollection(database, uid, "notices"), id)).catch((err) =>
        setError(prettyFirestoreError(err))
      );
    },
    [uid, offline]
  );

  const value = useMemo<TraceStore>(
    () => ({
      trace,
      status,
      error,
      traceNote,
      caseMeta,
      history,
      notices,
      evidence,
      track,
      hydrating,
      persistent: !offline,
      refreshing,
      newTxHashes,
      runTrace,
      loadDemo,
      clearTrace,
      setCaseMeta,
      generateNotice,
      setNoticeStatus,
      removeNotice,
      refreshTrace,
    }),
    [
      trace,
      status,
      error,
      traceNote,
      caseMeta,
      history,
      notices,
      evidence,
      track,
      hydrating,
      offline,
      refreshing,
      newTxHashes,
      runTrace,
      loadDemo,
      clearTrace,
      setCaseMeta,
      generateNotice,
      setNoticeStatus,
      removeNotice,
      refreshTrace,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ── Root hook ────────────────────────────────────────────────────────────────

export function useTraceStore(): TraceStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTraceStore must be used within <TraceStoreProvider>");
  return ctx;
}

// ── Hook-shaped selectors (mirror FinGuard's Firestore hooks) ────────────────
// These keep the ported views mechanical: a view that read useTransactions() in
// FinGuard reads useTransfers() here and changes almost nothing else.

/** FinGuard `useTransactions()` → transfers of the current trace. */
export function useTransfers(): {
  transfers: WalletTransfer[];
  loading: boolean;
  newTxHashes: string[];
} {
  const { trace, status, hydrating, newTxHashes } = useTraceStore();
  return {
    transfers: trace?.transfers ?? [],
    // Reading the saved case back counts as loading too, otherwise the table
    // flashes its empty state between sign-in and hydration.
    loading: status === "tracing" || hydrating,
    newTxHashes,
  };
}

/** FinGuard `useAlerts()` → the forensic findings the engine fired. */
export function useFindings(): { findings: CryptoFinding[] } {
  const { evidence } = useTraceStore();
  return { findings: evidence?.findings ?? [] };
}

/** FinGuard `useDashboardStats()` → the four headline KPIs. */
export function useTraceStats(): {
  wallets: number;
  highRisk: number;
  tracedUsd: number;
  openFindings: number;
} {
  const { evidence } = useTraceStore();
  return {
    wallets: evidence?.walletCount ?? 0,
    highRisk: evidence?.bySeverity.high ?? 0,
    tracedUsd: evidence?.totalUsd ?? 0,
    openFindings: evidence?.findings.length ?? 0,
  };
}

/** FinGuard `useSARReports()` → the drafted Section 91 notices. */
export function useNotices(): { notices: StoredNotice[] } {
  const { notices } = useTraceStore();
  return { notices };
}

/** FinGuard `useUploadHistory()` → traces filed by this officer. */
export function useTraceHistory(): { traces: TraceResult[] } {
  const { history } = useTraceStore();
  return { traces: history };
}
