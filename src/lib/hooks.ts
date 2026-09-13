"use client";

import { useEffect, useState, useCallback } from "react";
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  where,
  doc,
  updateDoc,
  addDoc,
  setDoc,
  writeBatch,
  serverTimestamp,
  deleteDoc,
  getDocs,
} from "firebase/firestore";
import { db } from "./firebase";
import { useAuth } from "@/components/AuthProvider";
import type { Transaction, Alert, SARReport, Severity } from "./domain";
import { classifyRisk } from "./domain";

function userCollection(uid: string, name: string) {
  return collection(db, "users", uid, name);
}

export function useTransactions() {
  const { user } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setTransactions([]);
      setLoading(false);
      return;
    }
    const q = query(userCollection(user.uid, "transactions"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setTransactions(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Transaction)));
        setLoading(false);
      },
      (err) => {
        console.error("[transactions]", err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [user]);

  return { transactions, loading };
}

export function useAlerts() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setAlerts([]);
      setLoading(false);
      return;
    }
    const q = query(userCollection(user.uid, "alerts"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setAlerts(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Alert)));
        setLoading(false);
      },
      (err) => {
        console.error("[alerts]", err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [user]);

  return { alerts, loading };
}

export function useSARReports() {
  const { user } = useAuth();
  const [reports, setReports] = useState<SARReport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setReports([]);
      setLoading(false);
      return;
    }
    const q = query(userCollection(user.uid, "sar_reports"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setReports(snap.docs.map((d) => ({ id: d.id, ...d.data() } as SARReport)));
        setLoading(false);
      },
      (err) => {
        console.error("[sar]", err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [user]);

  return { reports, loading };
}

export async function updateSARStatus(uid: string, id: string, status: string) {
  await updateDoc(doc(db, "users", uid, "sar_reports", id), {
    status,
    updatedAt: Date.now(),
  });
}

export async function createSAR(uid: string, report: Partial<SARReport>) {
  return await addDoc(userCollection(uid, "sar_reports"), {
    // Partial<SARReport> lets a caller pass an optional field through as an
    // explicit undefined, which Firestore rejects — see withoutUndefined below.
    ...withoutUndefined(report),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

// Wipes the report history only. Transactions and alerts are left alone, so the
// investigator can clear a cluttered case list without re-uploading their data.
export async function clearSARReports(uid: string) {
  const snap = await getDocs(userCollection(uid, "sar_reports"));
  if (!snap.docs.length) return 0;
  const batch = writeBatch(db);
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return snap.docs.length;
}

export async function deleteSAR(uid: string, id: string) {
  await deleteDoc(doc(db, "users", uid, "sar_reports", id));
}

export type ParsedRow = {
  date: string;
  fromAccount: string;
  toAccount: string;
  bank: string;
  amount: number;
  currency: string;
  type: string;
  note?: string;
};

/**
 * Drops keys whose value is `undefined` before a document is written.
 *
 * Firestore does not treat `undefined` as "leave this field out" — it rejects
 * the whole batch:
 *
 *     Function WriteBatch.set() called with invalid data.
 *     Unsupported field value: undefined (found in field note in document …)
 *
 * TypeScript pushes you straight into that trap. `note?: string` is idiomatic
 * for an optional column, and the natural way to produce one from a CSV cell
 * that was blank is `|| undefined`. Spread that row into `set()` and the key is
 * present with an undefined value, which is exactly what Firestore refuses. One
 * empty cell in one row fails the entire import.
 *
 * Stripping here rather than at each call site means every optional field added
 * to a row later is covered by default, instead of waiting to be discovered by
 * a user whose upload died on a trailing comma.
 */
function withoutUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export type UploadRecord = {
  id: string;
  fileName: string;
  rowCount: number;
  highRiskCount: number;
  totalAmount: number;
  createdAt: number;
  // Snapshot values written at import time. The history panel prefers live
  // transactions, but keeps these so a row still reads sensibly after its
  // transactions have been deleted.
  mediumRiskCount?: number;
  flaggedAmount?: number;
  accountCount?: number;
  banks?: string[];
  dateFrom?: string;
  dateTo?: string;
};

export function useUploadHistory() {
  const { user } = useAuth();
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setUploads([]);
      setLoading(false);
      return;
    }
    const q = query(userCollection(user.uid, "uploads"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setUploads(snap.docs.map((d) => ({ id: d.id, ...d.data() } as UploadRecord)));
        setLoading(false);
      },
      (err) => {
        console.error("[uploads]", err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [user]);

  return { uploads, loading };
}

export async function bulkInsertTransactions(uid: string, rows: ParsedRow[], fileName?: string) {
  const batches: Promise<void>[] = [];
  const chunkSize = 400;
  const now = Date.now();

  // The id is minted before the rows are written so every transaction can be
  // stamped with it. That stamp is what lets the history tab replay one past
  // import on its own.
  const uploadRef = doc(userCollection(uid, "uploads"));
  const uploadId = uploadRef.id;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = writeBatch(db);
    const slice = rows.slice(i, i + chunkSize);
    for (const r of slice) {
      const severity: Severity = classifyRisk(r.amount, r.note);
      const ref = doc(userCollection(uid, "transactions"));
      batch.set(ref, {
        ...withoutUndefined(r),
        severity,
        uploadId,
        createdAt: now + i,
      });
    }
    batches.push(batch.commit());
  }
  await Promise.all(batches);

  const severities = rows.map((r) => classifyRisk(r.amount, r.note));
  const highRisk = rows.filter((_, i) => severities[i] === "high");
  const mediumRisk = rows.filter((_, i) => severities[i] === "medium");
  const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
  const accounts = new Set<string>();
  const banks = new Set<string>();
  const dates: string[] = [];
  for (const r of rows) {
    accounts.add(r.fromAccount);
    accounts.add(r.toAccount);
    if (r.bank) banks.add(r.bank);
    if (r.date) dates.push(r.date);
  }
  dates.sort();

  // Record the upload so the history tab can show a timeline of imports.
  await setDoc(uploadRef, {
    fileName: fileName ?? "upload.csv",
    rowCount: rows.length,
    highRiskCount: highRisk.length,
    mediumRiskCount: mediumRisk.length,
    totalAmount,
    flaggedAmount: highRisk.reduce((s: number, r) => s + r.amount, 0),
    accountCount: accounts.size,
    banks: Array.from(banks).slice(0, 12),
    dateFrom: dates[0] ?? "",
    dateTo: dates[dates.length - 1] ?? "",
    createdAt: now,
  });

  if (highRisk.length) {
    const alertsBatch = writeBatch(db);
    const highAmount = highRisk.reduce((s, r) => s + r.amount, 0);
    alertsBatch.set(doc(userCollection(uid, "alerts")), {
      title: `${highRisk.length} high-risk transactions detected`,
      detail: `Amount total: ${highAmount.toLocaleString("en-IN")} ${highRisk[0].currency}. Review recommended.`,
      severity: "high",
      amount: highAmount,
      time_label: "just now",
      createdAt: now,
    });
    await alertsBatch.commit();
  }
}

export async function clearAllData(uid: string) {
  const cols = ["transactions", "alerts", "sar_reports", "uploads"];
  for (const name of cols) {
    const snap = await getDocs(userCollection(uid, name));
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    if (snap.docs.length) await batch.commit();
  }
}

// Removes one past import: the history entry and every transaction that came in
// with it. Rows imported before uploads were stamped carry no uploadId, so they
// are never caught by this query and stay put.
export async function deleteUpload(uid: string, uploadId: string) {
  const snap = await getDocs(
    query(userCollection(uid, "transactions"), where("uploadId", "==", uploadId))
  );
  const chunk = 400;
  for (let i = 0; i < snap.docs.length; i += chunk) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + chunk).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await deleteDoc(doc(db, "users", uid, "uploads", uploadId));
  return snap.docs.length;
}

export function useDashboardStats() {
  const { transactions } = useTransactions();
  const { alerts } = useAlerts();

  const total = transactions.length;
  const high = transactions.filter((t) => t.severity === "high").length;
  const flaggedAmount = transactions
    .filter((t) => t.severity === "high")
    .reduce((s, t) => s + (t.amount ?? 0), 0);
  const openAlerts = alerts.length;

  return { total, high, flaggedAmount, openAlerts };
}

export function useDeleteTransaction() {
  const { user } = useAuth();
  return useCallback(
    async (id: string) => {
      if (!user) return;
      await deleteDoc(doc(db, "users", user.uid, "transactions", id));
    },
    [user]
  );
}
