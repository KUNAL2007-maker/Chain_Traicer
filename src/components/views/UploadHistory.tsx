"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { deleteUpload, useTransactions, useUploadHistory, type UploadRecord } from "@/lib/hooks";
import { buildEvidence, type Evidence } from "@/lib/investigation";
import { formatINR, severityColor } from "@/lib/domain";

// A past import can be replayed either on its own or together with everything
// else that landed the same day, so the panel is driven by one of two keys.
type Selection = { kind: "upload"; key: string } | { kind: "day"; key: string };

const DAY_MS = 86_400_000;

function dayKey(ts: number) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function dayLabel(key: string) {
  if (key === dayKey(Date.now())) return "Today";
  if (key === dayKey(Date.now() - DAY_MS)) return "Yesterday";
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function clockLabel(ts: number) {
  return new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

export function UploadHistory() {
  const { user } = useAuth();
  const { uploads, loading } = useUploadHistory();
  const { transactions } = useTransactions();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const days = useMemo(() => {
    const map = new Map<string, UploadRecord[]>();
    for (const u of uploads) {
      const k = dayKey(u.createdAt);
      const list = map.get(k);
      if (list) list.push(u);
      else map.set(k, [u]);
    }
    return Array.from(map.entries()).map(([key, items]) => ({
      key,
      items,
      rowCount: items.reduce((s, u) => s + (u.rowCount ?? 0), 0),
    }));
  }, [uploads]);

  // Open the newest import by default, and never leave a deleted one selected.
  useEffect(() => {
    if (!uploads.length) {
      setSelection(null);
      return;
    }
    const stillThere =
      selection?.kind === "upload"
        ? uploads.some((u) => u.id === selection.key)
        : selection?.kind === "day"
          ? days.some((d) => d.key === selection.key)
          : false;
    if (!stillThere) setSelection({ kind: "upload", key: uploads[0].id });
  }, [uploads, days, selection]);

  const activeIds = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === "upload") return new Set([selection.key]);
    return new Set(uploads.filter((u) => dayKey(u.createdAt) === selection.key).map((u) => u.id));
  }, [selection, uploads]);

  const records = useMemo(
    () => (activeIds ? uploads.filter((u) => activeIds.has(u.id)) : []),
    [uploads, activeIds]
  );

  const scoped = useMemo(
    () => (activeIds ? transactions.filter((t) => t.uploadId && activeIds.has(t.uploadId)) : []),
    [transactions, activeIds]
  );

  const evidence = useMemo(() => (scoped.length ? buildEvidence(scoped) : null), [scoped]);

  async function handleDelete(id: string) {
    if (!user) return;
    setBusy(id);
    try {
      await deleteUpload(user.uid, id);
      setConfirmId(null);
    } catch (err) {
      console.error("[deleteUpload]", err);
    } finally {
      setBusy(null);
    }
  }

  const heading = !selection
    ? ""
    : selection.kind === "upload"
      ? (records[0]?.fileName ?? "Import")
      : dayLabel(selection.key);

  const subheading = !selection
    ? ""
    : selection.kind === "upload" && records[0]
      ? `Imported ${clockLabel(records[0].createdAt)} · ${dayLabel(dayKey(records[0].createdAt))}`
      : `${records.length} import${records.length === 1 ? "" : "s"} on this day`;

  if (loading) {
    return (
      <div className="text-[13px] py-10 text-center" style={{ color: "var(--muted-2)" }}>
        Loading your import history…
      </div>
    );
  }

  if (!uploads.length) {
    return (
      <div
        className="rounded-xl border p-10 text-center"
        style={{ borderColor: "var(--border)", background: "var(--panel-2, var(--chip))" }}
      >
        <div className="text-3xl mb-2">🗂️</div>
        <div className="text-[14px] font-medium" style={{ color: "var(--text-strong)" }}>
          No imports yet
        </div>
        <div className="text-[12.5px] mt-1" style={{ color: "var(--muted-2)" }}>
          Every CSV you upload is kept here so you can revisit its analysis later.
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <div
        className="rounded-xl border overflow-hidden self-start"
        style={{ borderColor: "var(--border)", background: "var(--chip)" }}
      >
        <div
          className="px-3 py-2.5 border-b text-[11px] uppercase tracking-widest"
          style={{ borderColor: "var(--border)", color: "var(--muted)" }}
        >
          {uploads.length} import{uploads.length === 1 ? "" : "s"}
        </div>
        <div className="max-h-[560px] overflow-auto">
          {days.map((d) => {
            const dayActive = selection?.kind === "day" && selection.key === d.key;
            return (
              <div key={d.key}>
                <button
                  onClick={() => setSelection({ kind: "day", key: d.key })}
                  className="w-full text-left px-3 py-2 border-b flex items-baseline justify-between gap-2 transition hover:bg-[var(--hover)]"
                  style={{
                    borderColor: "var(--border)",
                    background: dayActive ? "var(--hover)" : "transparent",
                  }}
                >
                  <span
                    className="text-[11.5px] font-semibold uppercase tracking-wider"
                    style={{ color: dayActive ? "var(--text-strong)" : "var(--muted)" }}
                  >
                    {dayLabel(d.key)}
                  </span>
                  <span className="text-[10.5px] shrink-0" style={{ color: "var(--muted-2)" }}>
                    {d.rowCount} rows
                  </span>
                </button>
                {d.items.map((u) => (
                  <UploadRow
                    key={u.id}
                    upload={u}
                    active={selection?.kind === "upload" && selection.key === u.id}
                    confirming={confirmId === u.id}
                    busy={busy === u.id}
                    onSelect={() => setSelection({ kind: "upload", key: u.id })}
                    onAskDelete={() => setConfirmId(confirmId === u.id ? null : u.id)}
                    onConfirmDelete={() => handleDelete(u.id)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <div
        className="rounded-xl border p-5 min-w-0"
        style={{ borderColor: "var(--border)", background: "var(--chip)" }}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div
              className="text-[15px] font-semibold truncate"
              style={{ color: "var(--text-strong)" }}
            >
              {heading}
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: "var(--muted-2)" }}>
              {subheading}
            </div>
          </div>
          <div
            className="rounded-lg border px-2.5 py-1 text-[11px]"
            style={{ borderColor: "var(--border)", color: "var(--muted)" }}
          >
            {selection?.kind === "day" ? "Whole day" : "Single file"}
          </div>
        </div>

        {evidence ? (
          <UploadAnalytics evidence={evidence} />
        ) : (
          <SnapshotOnly records={records} />
        )}
      </div>
    </div>
  );
}

function UploadRow({
  upload,
  active,
  confirming,
  busy,
  onSelect,
  onAskDelete,
  onConfirmDelete,
}: {
  upload: UploadRecord;
  active: boolean;
  confirming: boolean;
  busy: boolean;
  onSelect: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <div
      className="group relative border-b"
      style={{
        borderColor: "var(--border)",
        background: active ? "var(--hover)" : "transparent",
        boxShadow: active ? "inset 2px 0 0 var(--accent, #34d399)" : "none",
      }}
    >
      <button onClick={onSelect} className="w-full text-left px-3 py-2.5 pr-9">
        <div
          className="text-[12.5px] font-medium truncate"
          style={{ color: active ? "var(--text-strong)" : "var(--text)" }}
        >
          {upload.fileName}
        </div>
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          <span className="text-[10.5px]" style={{ color: "var(--muted-2)" }}>
            {clockLabel(upload.createdAt)}
          </span>
          <span className="text-[10.5px]" style={{ color: "var(--muted-2)" }}>
            · {upload.rowCount} rows
          </span>
          {upload.highRiskCount > 0 && (
            <span className="text-[10px] rounded px-1.5 py-0.5 bg-red-500/15 text-red-300 border border-red-500/25">
              {upload.highRiskCount} high
            </span>
          )}
        </div>
        <div className="mt-1 text-[11px] font-mono" style={{ color: "var(--muted)" }}>
          {formatINR(upload.totalAmount ?? 0)}
        </div>
      </button>
      {confirming ? (
        <div className="px-3 pb-2.5 flex items-center gap-2">
          <button
            onClick={onConfirmDelete}
            disabled={busy}
            className="rounded border border-red-500/40 bg-red-500/15 px-2 py-1 text-[11px] text-red-300 disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete file + rows"}
          </button>
          <button
            onClick={onAskDelete}
            className="text-[11px]"
            style={{ color: "var(--muted-2)" }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={onAskDelete}
          aria-label={`Delete ${upload.fileName}`}
          className="absolute top-2 right-2 h-6 w-6 rounded text-[13px] opacity-0 group-hover:opacity-100 focus:opacity-100 transition hover:bg-red-500/15 hover:text-red-300"
          style={{ color: "var(--muted-2)" }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div
      className="rounded-lg border px-3 py-2.5"
      style={{ borderColor: "var(--border)", background: "var(--panel)" }}
    >
      <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
        {label}
      </div>
      <div
        className="mt-1 text-[16px] font-semibold tabular-nums"
        style={{ color: tone ?? "var(--text-strong)" }}
      >
        {value}
      </div>
    </div>
  );
}

function RiskSplit({ bySeverity, total }: { bySeverity: Evidence["bySeverity"]; total: number }) {
  const parts = [
    { key: "high" as const, label: "High risk", n: bySeverity.high },
    { key: "medium" as const, label: "Medium", n: bySeverity.medium },
    { key: "safe" as const, label: "Normal", n: bySeverity.safe },
  ].filter((p) => p.n > 0);

  return (
    <div>
      <div className="flex h-2 rounded-full overflow-hidden" style={{ background: "var(--panel)" }}>
        {parts.map((p) => (
          <div
            key={p.key}
            title={`${p.label}: ${p.n}`}
            style={{ width: `${(p.n / Math.max(1, total)) * 100}%`, background: severityColor(p.key) }}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        {parts.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
            <i className="h-2 w-2 rounded-full" style={{ background: severityColor(p.key) }} />
            {p.label} <span className="tabular-nums" style={{ color: "var(--text)" }}>{p.n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <div className="text-[10.5px] uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function UploadAnalytics({ evidence: ev }: { evidence: Evidence }) {
  const range = ev.dateRange
    ? ev.dateRange.from === ev.dateRange.to
      ? ev.dateRange.from
      : `${ev.dateRange.from} → ${ev.dateRange.to}`
    : "—";

  return (
    <>
      <div className="mt-4 grid gap-2.5 grid-cols-2 xl:grid-cols-4">
        <Tile label="Transfers" value={String(ev.txCount)} />
        <Tile label="Accounts" value={String(ev.accountCount)} />
        <Tile label="Total value" value={formatINR(ev.totalValue)} />
        <Tile
          label="Flagged value"
          value={formatINR(ev.highValue)}
          tone={ev.highValue > 0 ? severityColor("high") : undefined}
        />
      </div>

      <Section title="Risk split">
        <RiskSplit bySeverity={ev.bySeverity} total={ev.txCount} />
      </Section>

      <Section title="Patterns detected">
        {ev.typologies.length ? (
          <div className="flex flex-wrap gap-2">
            {ev.typologies.map((t) => (
              <span
                key={t.label}
                className="rounded-lg border px-2.5 py-1.5 text-[11.5px]"
                style={{ borderColor: "var(--border)", background: "var(--panel)", color: "var(--text)" }}
              >
                {t.label}
                <span className="ml-1.5" style={{ color: "var(--muted-2)" }}>
                  {t.count} · {formatINR(t.amount)}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <div className="text-[12.5px]" style={{ color: "var(--muted-2)" }}>
            No named laundering pattern in this batch.
          </div>
        )}
      </Section>
      <Section title="Coverage">
        <div className="grid gap-2.5 sm:grid-cols-3">
          <div
            className="rounded-lg border px-3 py-2.5"
            style={{ borderColor: "var(--border)", background: "var(--panel)" }}
          >
            <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
              Date range
            </div>
            <div className="mt-1 text-[12.5px] font-mono" style={{ color: "var(--text)" }}>
              {range}
            </div>
          </div>
          <div
            className="rounded-lg border px-3 py-2.5"
            style={{ borderColor: "var(--border)", background: "var(--panel)" }}
          >
            <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
              Banks
            </div>
            <div className="mt-1 text-[12.5px]" style={{ color: "var(--text)" }}>
              {ev.banks.length ? `${ev.banks.length} · ${ev.banks.slice(0, 2).join(", ")}` : "—"}
              {ev.banks.length > 2 && (
                <span style={{ color: "var(--muted-2)" }}> +{ev.banks.length - 2}</span>
              )}
            </div>
          </div>
          <div
            className="rounded-lg border px-3 py-2.5"
            style={{ borderColor: "var(--border)", background: "var(--panel)" }}
          >
            <div className="text-[10.5px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
              Busiest day
            </div>
            <div className="mt-1 text-[12.5px]" style={{ color: "var(--text)" }}>
              {ev.busiestDay
                ? `${ev.busiestDay.date} · ${ev.busiestDay.count} transfers`
                : "—"}
            </div>
          </div>
        </div>
      </Section>
      {ev.topCounterparties.length > 0 && (
        <Section title="Most active accounts">
          <div className="rounded-lg border overflow-hidden" style={{ borderColor: "var(--border)" }}>
            <div
              className="grid grid-cols-[minmax(0,1fr)_64px_64px_110px] px-3 py-1.5 text-[10.5px] uppercase tracking-widest border-b"
              style={{ background: "var(--panel)", borderColor: "var(--border)", color: "var(--muted)" }}
            >
              <div>Account</div>
              <div className="text-right">In</div>
              <div className="text-right">Out</div>
              <div className="text-right">Volume</div>
            </div>
            {ev.topCounterparties.slice(0, 5).map((a) => (
              <div
                key={a.account}
                className="grid grid-cols-[minmax(0,1fr)_64px_64px_110px] px-3 py-2 text-[12px] border-b last:border-b-0"
                style={{ borderColor: "var(--border)", color: "var(--text)" }}
              >
                <div className="truncate font-mono text-[11.5px]">{a.account}</div>
                <div className="text-right tabular-nums" style={{ color: "var(--muted-2)" }}>{a.inCount}</div>
                <div className="text-right tabular-nums" style={{ color: "var(--muted-2)" }}>{a.outCount}</div>
                <div className="text-right font-mono text-[11.5px]">{formatINR(a.volume)}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {ev.findings.length > 0 && (
        <Section title="What the analysis found">
          <ul className="space-y-1.5">
            {ev.findings.slice(0, 4).map((f) => (
              <li key={f.code} className="flex gap-2 text-[12.5px]" style={{ color: "var(--text)" }}>
                <i
                  className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ background: f.severity === "high" ? severityColor("high") : f.severity === "medium" ? severityColor("medium") : "var(--muted)" }}
                />
                <span>{f.short || f.title}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

// Shown when the import's transactions are no longer in the account — the row
// was cleared, but the summary written at import time is still worth reading.
function SnapshotOnly({ records }: { records: UploadRecord[] }) {
  const rowCount = records.reduce((s, u) => s + (u.rowCount ?? 0), 0);
  const highRisk = records.reduce((s, u) => s + (u.highRiskCount ?? 0), 0);
  const total = records.reduce((s, u) => s + (u.totalAmount ?? 0), 0);
  const flagged = records.reduce((s, u) => s + (u.flaggedAmount ?? 0), 0);
  const accounts = records.reduce((s, u) => Math.max(s, u.accountCount ?? 0), 0);
  const banks = Array.from(new Set(records.flatMap((u) => u.banks ?? [])));
  const dates = records.flatMap((u) => [u.dateFrom, u.dateTo]).filter(Boolean).sort() as string[];

  return (
    <>
      <div className="mt-4 grid gap-2.5 grid-cols-2 xl:grid-cols-4">
        <Tile label="Transfers" value={String(rowCount)} />
        <Tile label="Accounts" value={accounts ? String(accounts) : "—"} />
        <Tile label="Total value" value={formatINR(total)} />
        <Tile
          label="Flagged value"
          value={flagged ? formatINR(flagged) : `${highRisk} high risk`}
          tone={highRisk > 0 ? severityColor("high") : undefined}
        />
      </div>

      {(banks.length > 0 || dates.length > 0) && (
        <Section title="Coverage">
          <div className="text-[12.5px]" style={{ color: "var(--text)" }}>
            {dates.length > 0 && (
              <div>
                Covers{" "}
                <span className="font-mono">
                  {dates[0] === dates[dates.length - 1]
                    ? dates[0]
                    : `${dates[0]} → ${dates[dates.length - 1]}`}
                </span>
              </div>
            )}
            {banks.length > 0 && (
              <div className="mt-1">
                {banks.length} bank{banks.length === 1 ? "" : "s"} · {banks.slice(0, 4).join(", ")}
                {banks.length > 4 && ` +${banks.length - 4}`}
              </div>
            )}
          </div>
        </Section>
      )}

      <div
        className="mt-5 rounded-lg border px-3 py-2.5 text-[12px]"
        style={{ borderColor: "var(--border)", background: "var(--panel)", color: "var(--muted-2)" }}
      >
        These transactions are no longer in your account, so only the summary
        recorded at import time is available. Re-upload the file to restore the
        full breakdown.
      </div>
    </>
  );
}
