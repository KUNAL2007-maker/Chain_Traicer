/**
 * One page frame for every view.
 *
 * Before this existed each view rolled its own outer div — five of them used
 * `p-5` and ran edge to edge, one used `p-6 max-w-6xl mx-auto`. Switching tabs
 * on a desktop monitor moved the left gutter and changed the content width,
 * which is the kind of thing that reads as "unfinished" even when every
 * individual screen looks fine. Now the gutter and the measure are decided in
 * one place and the TopBar aligns to the same track.
 *
 * `width`:
 *   "default" — reading-and-cards width. Wide enough for a 4-up KPI row, capped
 *               so paragraphs don't run to 2000px on an ultrawide.
 *   "wide"    — data surfaces that genuinely want the pixels: the graph canvas
 *               and the transactions table.
 *
 * `fill` makes the frame exactly as tall as the scroll area so a child can use
 * `h-full` to reach the bottom of the window. Used by the chat, where the
 * message list should grow with the monitor instead of sitting in a fixed 640px
 * box with dead space under it.
 */
export const PAGE_GUTTER = "px-4 sm:px-5 2xl:px-8";

const WIDTHS = {
  default: "max-w-[1440px]",
  wide: "max-w-[1760px]",
} as const;

export function Page({
  children,
  width = "default",
  fill = false,
  className = "",
}: {
  children: React.ReactNode;
  width?: keyof typeof WIDTHS;
  fill?: boolean;
  className?: string;
}) {
  return (
    <div className={fill ? "h-full" : "min-h-full"}>
      <div
        className={`mx-auto w-full ${WIDTHS[width]} ${PAGE_GUTTER} py-4 sm:py-5 ${
          fill ? "h-full flex flex-col" : ""
        } ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Section heading used inside a page: small uppercase eyebrow over a title,
 * with room for a control on the right. The pattern was already repeated in
 * six places by hand with slightly different sizes each time.
 */
export function PanelHeader({
  eyebrow,
  title,
  right,
  className = "",
}: {
  eyebrow: string;
  title: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-widest" style={{ color: "var(--muted)" }}>
          {eyebrow}
        </div>
        <div className="mt-1 text-[15px] font-semibold leading-tight" style={{ color: "var(--text-strong)" }}>
          {title}
        </div>
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}
