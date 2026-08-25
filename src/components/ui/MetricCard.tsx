import { Sparkline } from "./Sparkline";

export function MetricCard({
  label,
  value,
  sub,
  accent = "#22c55e",
  spark,
  icon,
  trend,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  spark?: number[];
  icon?: React.ReactNode;
  trend?: { dir: "up" | "down" | "flat"; text: string };
}) {
  const trendColor =
    trend?.dir === "up"
      ? "text-emerald-300"
      : trend?.dir === "down"
      ? "text-red-300"
      : "text-slate-400";
  const trendGlyph = trend?.dir === "up" ? "▲" : trend?.dir === "down" ? "▼" : "◆";

  return (
    <div className="relative glass rounded-2xl p-4 overflow-hidden group hover:border-white/20 transition">
      <div
        className="absolute inset-x-0 -top-px h-[2px] opacity-70"
        style={{
          background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
        }}
      />
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-slate-400 flex items-center gap-2">
            {icon && (
              <span
                className="grid place-items-center w-5 h-5 rounded-md"
                style={{ background: `${accent}22`, color: accent }}
              >
                {icon}
              </span>
            )}
            {label}
          </div>
          <div className="mt-2 text-2xl font-semibold text-white leading-none tracking-tight">
            {value}
          </div>
          {sub && <div className="mt-1.5 text-[12px] text-slate-400">{sub}</div>}
        </div>
        {spark && (
          <div className="opacity-90">
            <Sparkline points={spark} color={accent} width={110} height={40} />
          </div>
        )}
      </div>
      {trend && (
        <div className={`mt-3 text-[12px] flex items-center gap-1.5 ${trendColor}`}>
          <span>{trendGlyph}</span>
          <span>{trend.text}</span>
        </div>
      )}
    </div>
  );
}
