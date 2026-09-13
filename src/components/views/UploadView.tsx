"use client";

import { useState, useRef } from "react";
import { useAuth } from "@/components/AuthProvider";
import { bulkInsertTransactions, clearAllData, useUploadHistory, type ParsedRow } from "@/lib/hooks";
import { classifyRisk, severityColor } from "@/lib/domain";
import { UploadHistory } from "./UploadHistory";
import { Page } from "../ui/Page";

type Row = ParsedRow & { _row: number };

const REQUIRED_HEADERS = ["date", "from", "to", "amount"];

function parseCSV(text: string): { rows: Row[]; errors: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const errors: string[] = [];
  if (lines.length < 2) return { rows: [], errors: ["File is empty or has only headers."] };

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));

  const findIdx = (candidates: string[]) => {
    for (const c of candidates) {
      const i = headers.indexOf(c);
      if (i >= 0) return i;
    }
    return -1;
  };

  const idx = {
    date: findIdx(["date", "timestamp", "time", "transaction_date"]),
    from: findIdx(["from", "from_account", "source", "sender", "payer"]),
    to: findIdx(["to", "to_account", "target", "receiver", "payee", "beneficiary"]),
    amount: findIdx(["amount", "value", "sum"]),
    bank: findIdx(["bank", "institution"]),
    currency: findIdx(["currency", "curr"]),
    type: findIdx(["type", "transaction_type", "category"]),
    note: findIdx(["note", "description", "memo", "remarks"]),
  };

  const missing = REQUIRED_HEADERS.filter((h) => {
    if (h === "from") return idx.from < 0;
    if (h === "to") return idx.to < 0;
    return idx[h as keyof typeof idx] < 0;
  });
  if (missing.length) {
    errors.push(`Missing required column(s): ${missing.join(", ")}. Expected headers include: date, from, to, amount.`);
    return { rows: [], errors };
  }

  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const amountRaw = (cols[idx.amount] ?? "").replace(/[,\s₹$€£]/g, "");
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount)) {
      errors.push(`Row ${i + 1}: amount "${cols[idx.amount]}" is not a number, skipped.`);
      continue;
    }
    rows.push({
      _row: i + 1,
      date: (cols[idx.date] ?? "").trim(),
      fromAccount: (cols[idx.from] ?? "").trim(),
      toAccount: (cols[idx.to] ?? "").trim(),
      amount,
      bank: idx.bank >= 0 ? (cols[idx.bank] ?? "").trim() : "Unknown",
      currency: idx.currency >= 0 ? (cols[idx.currency] ?? "INR").trim() || "INR" : "INR",
      type: idx.type >= 0 ? (cols[idx.type] ?? "transfer").trim() || "transfer" : "transfer",
      note: idx.note >= 0 ? (cols[idx.note] ?? "").trim() || undefined : undefined,
    });
  }

  return { rows, errors };
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function prettyFirebaseError(err: unknown): string {
  const raw = (err as { code?: string; message?: string } | null) ?? {};
  const code = raw.code ?? "";
  const msg = raw.message ?? "";
  if (code.includes("permission-denied") || msg.includes("permission")) {
    return "Firestore denied the write. Open Firebase Console → Firestore Database → Rules and switch to test mode (or match: /users/{uid}/**).";
  }
  if (code.includes("unavailable") || msg.includes("offline") || msg.includes("network")) {
    return "Can't reach Firestore. Check your internet, then verify Firestore Database is created in Firebase Console.";
  }
  if (code.includes("not-found") || msg.includes("NOT_FOUND") || msg.includes("does not exist")) {
    return "Firestore database not found. Open Firebase Console → Firestore Database → Create database → Start in test mode.";
  }
  if (code.includes("unauthenticated")) {
    return "Not signed in. Please refresh and log in again.";
  }
  if (code.includes("failed-precondition")) {
    return "Firestore is not set up. Open Firebase Console → Firestore Database → Create database.";
  }
  return msg || "Unknown error. Open the browser console (F12) for details.";
}

export function UploadView({ onDone }: { onDone: () => void }) {
  const { user } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"import" | "history">("import");
  const { uploads } = useUploadHistory();
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [uploadedCount, setUploadedCount] = useState(0);
  const [errorDetail, setErrorDetail] = useState<string>("");

  function resetState() {
    setRows([]);
    setErrors([]);
    setFileName("");
    setStatus("idle");
    setErrorDetail("");
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleFile(file: File) {
    // clear old file state before loading new one
    setStatus("idle");
    setErrorDetail("");
    setRows([]);
    setErrors([]);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const parsed = parseCSV(text);
      setRows(parsed.rows);
      setErrors(parsed.errors);
    };
    reader.readAsText(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  async function handleUpload() {
    if (!user || !rows.length) return;
    setStatus("uploading");
    setErrorDetail("");
    try {
      await bulkInsertTransactions(user.uid, rows, fileName || "upload.csv");
      setUploadedCount(rows.length);
      setStatus("success");
      setRows([]);
      setErrors([]);
      setFileName("");
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      console.error("[Upload] failed:", err);
      setStatus("error");
      setErrorDetail(prettyFirebaseError(err));
    }
  }

  async function handleClearAll() {
    if (!user) return;
    if (!confirm("Delete all your transactions, alerts, and reports? This cannot be undone.")) return;
    try {
      await clearAllData(user.uid);
      alert("All data cleared.");
    } catch (err) {
      console.error("[ClearAll] failed:", err);
      alert("Failed to clear data: " + prettyFirebaseError(err));
    }
  }

  const preview = rows.slice(0, 8);
  const highRisk = rows.filter((r) => classifyRisk(r.amount, r.note) === "high").length;

  return (
    <Page width="wide">
      <div
        className="mb-4 inline-flex h-9 items-center rounded-lg border p-1 gap-1"
        style={{ borderColor: "var(--border)", background: "var(--chip)" }}
      >
        {(
          [
            ["import", "Import CSV"],
            ["history", uploads.length ? `History · ${uploads.length}` : "History"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className="rounded-md px-3.5 py-1 text-[12.5px] font-medium whitespace-nowrap transition"
            style={
              tab === key
                ? { background: "var(--panel)", color: "var(--text-strong)", boxShadow: "0 1px 0 rgba(0,0,0,.25)" }
                : { color: "var(--muted-2)" }
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "history" ? (
        <UploadHistory />
      ) : (
      // The import flow is a single-column form: capped at a readable measure so
      // the drop zone and the six-column preview do not stretch across an
      // ultrawide monitor. The history tab keeps the full page width.
      <div
        className="max-w-5xl rounded-2xl p-4 sm:p-6 border"
        style={{ background: "var(--panel)", borderColor: "var(--border)" }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-lg font-semibold" style={{ color: "var(--text-strong)" }}>
              Import transactions from CSV
            </div>
            <div className="mt-1 text-[13px]" style={{ color: "var(--muted-2)" }}>
              Drag & drop a file or click to browse. We&apos;ll analyze risk automatically.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(fileName || rows.length > 0) && status !== "uploading" && (
              <button
                onClick={resetState}
                className="rounded-lg border px-3 py-2 text-[12px] hover:bg-[var(--hover)] transition"
                style={{ borderColor: "var(--border)", color: "var(--text)", background: "var(--chip)" }}
              >
                ✕ Clear file
              </button>
            )}
            {/* The demo ledger rather than a bare header row. A four-line
                template told you the column names and nothing else — you still
                had to invent thirty plausible transactions before the dashboard
                had anything to show. This is the same file the README walks
                through: 30 rows containing four high-risk rings, so importing it
                straight back populates every panel and every severity band.
                Served from public/samples/, kept byte-identical to
                samples/guided-demo.csv, which is the copy the docs cite. */}
            <a
              href="/samples/guided-demo.csv"
              download="finguard-demo.csv"
              title="30 real-looking transactions with four high-risk rings — import it as-is to see the console populated"
              className="inline-flex items-center rounded-lg border px-3 py-2 text-[12px] hover:bg-[var(--hover)] transition"
              style={{ borderColor: "var(--border)", color: "var(--text)", background: "var(--chip)" }}
            >
              ↓ Download demo CSV
            </a>
          </div>
        </div>

        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          className="rounded-xl border-2 border-dashed p-6 sm:p-10 cursor-pointer hover:border-emerald-500/50 transition text-center"
          style={{ borderColor: "var(--border)" }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <div className="text-4xl mb-2">📄</div>
          <div className="text-[14px] font-medium" style={{ color: "var(--text-strong)" }}>
            {fileName || "Drop your CSV here or click to browse"}
          </div>
          <div className="text-[12px] mt-1" style={{ color: "var(--muted-2)" }}>
            Required columns: date, from, to, amount · Optional: bank, currency, type, note
          </div>
        </div>

        {errors.length > 0 && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <div className="text-[13px] font-medium text-red-300 mb-1">Warnings</div>
            <ul className="text-[12px] text-red-300 space-y-0.5 list-disc pl-4">
              {errors.slice(0, 5).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {errors.length > 5 && <li>...and {errors.length - 5} more</li>}
            </ul>
          </div>
        )}

        {rows.length > 0 && status !== "success" && (
          <>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[13px]" style={{ color: "var(--text)" }}>
                <span className="font-semibold">{rows.length}</span> rows ready to upload
                {highRisk > 0 && (
                  <span className="ml-2 text-[12px] rounded px-1.5 py-0.5 bg-red-500/15 text-red-300 border border-red-500/25">
                    {highRisk} high-risk
                  </span>
                )}
              </div>
              <button
                onClick={handleUpload}
                disabled={status === "uploading"}
                className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 px-4 py-2 text-[13px] font-medium transition disabled:opacity-50"
              >
                {status === "uploading" ? "Uploading..." : `Upload ${rows.length} rows →`}
              </button>
            </div>

            <div className="mt-3 rounded-lg border overflow-hidden" style={{ borderColor: "var(--border)" }}>
              {/* Six equal columns can't fit a phone — every cell would truncate to
                  three characters. Below lg the table keeps its natural width and
                  scrolls sideways instead; at lg and up min-w-0 releases it and the
                  grid fills the card exactly as before. */}
              <div className="overflow-x-auto lg:overflow-x-visible">
                <div className="min-w-[680px] lg:min-w-0">
                  <div className="grid grid-cols-6 text-[11px] uppercase tracking-widest px-3 py-2 border-b" style={{ background: "var(--chip)", borderColor: "var(--border)", color: "var(--muted)" }}>
                    <div>Date</div>
                    <div>From</div>
                    <div>To</div>
                    <div>Bank</div>
                    <div className="text-right">Amount</div>
                    <div className="text-right">Risk</div>
                  </div>
                  {preview.map((r) => {
                    const sev = classifyRisk(r.amount, r.note);
                    return (
                      <div key={r._row} className="grid grid-cols-6 text-[12.5px] px-3 py-2 border-b" style={{ borderColor: "var(--border)", color: "var(--text)" }}>
                        <div className="truncate">{r.date}</div>
                        <div className="truncate">{r.fromAccount}</div>
                        <div className="truncate">{r.toAccount}</div>
                        <div className="truncate">{r.bank}</div>
                        <div className="text-right font-mono tabular-nums">{r.amount.toLocaleString("en-IN")} {r.currency}</div>
                        <div className="text-right">
                          <span
                            className="inline-block rounded px-1.5 py-0.5 text-[10.5px] font-medium capitalize"
                            style={{ background: `${severityColor(sev)}22`, color: severityColor(sev) }}
                          >
                            {sev}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  {rows.length > preview.length && (
                    <div className="px-3 py-2 text-[11px] text-center" style={{ color: "var(--muted)" }}>
                      ...and {rows.length - preview.length} more rows
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {status === "success" && (
          <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5 text-center">
            <div className="text-3xl mb-2">✓</div>
            <div className="text-[15px] font-semibold text-emerald-200">
              Uploaded {uploadedCount} transactions
            </div>
            <div className="text-[12px] mt-1 text-emerald-300/80">
              Your dashboard is now updated with live data
            </div>
            <div className="mt-3 flex items-center justify-center gap-2">
              <button
                onClick={resetState}
                className="rounded-lg border px-4 py-2 text-[13px] font-medium transition hover:bg-[var(--hover)]"
                style={{ borderColor: "var(--border)", color: "var(--text)", background: "var(--chip)" }}
              >
                Upload another file
              </button>
              <button
                onClick={() => setTab("history")}
                className="rounded-lg border px-4 py-2 text-[13px] font-medium transition hover:bg-[var(--hover)]"
                style={{ borderColor: "var(--border)", color: "var(--text)", background: "var(--chip)" }}
              >
                View history
              </button>
              <button
                onClick={onDone}
                className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 px-4 py-2 text-[13px] font-medium transition"
              >
                Go to dashboard →
              </button>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-[13px] text-red-300">
            <div className="font-semibold mb-1">Upload failed</div>
            <div className="text-[12.5px]">{errorDetail || "Check your internet connection and Firebase configuration."}</div>
          </div>
        )}

        <div className="mt-6 pt-5 border-t flex flex-wrap items-center justify-between gap-2" style={{ borderColor: "var(--border)" }}>
          <div className="text-[12px]" style={{ color: "var(--muted-2)" }}>
            Data is stored securely in your Firebase account
          </div>
          <button
            onClick={handleClearAll}
            className="text-[12px] text-red-400 hover:text-red-300 transition"
          >
            Clear all my data
          </button>
        </div>
      </div>
      )}
    </Page>
  );
}
