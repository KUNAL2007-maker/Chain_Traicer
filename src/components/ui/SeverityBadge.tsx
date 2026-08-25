import type { Severity } from "@/lib/domain";

export function SeverityBadge({
  severity,
  size = "sm",
}: {
  severity: Severity;
  size?: "sm" | "md";
}) {
  const map: Record<Severity, { label: string; dot: string; text: string; bg: string; border: string; icon: string }> = {
    safe: {
      label: "Safe",
      dot: "bg-emerald-400",
      text: "text-emerald-300",
      bg: "bg-emerald-500/10",
      border: "border-emerald-500/25",
      icon: "🟢",
    },
    medium: {
      label: "Medium",
      dot: "bg-amber-400",
      text: "text-amber-300",
      bg: "bg-amber-500/10",
      border: "border-amber-500/25",
      icon: "🟠",
    },
    high: {
      label: "High",
      dot: "bg-red-500",
      text: "text-red-300",
      bg: "bg-red-500/10",
      border: "border-red-500/30",
      icon: "🔴",
    },
  };
  const m = map[severity];
  const pad = size === "md" ? "px-2.5 py-1 text-[12px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border ${m.border} ${m.bg} ${m.text} ${pad}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}
