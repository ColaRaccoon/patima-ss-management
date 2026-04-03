import { cn } from "@/lib/cn";

export type StatusTone =
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "muted"
  | "accent";

const toneClassMap: Record<StatusTone, string> = {
  default: "border-ink/12 bg-white/80 text-ink",
  success: "border-sage/25 bg-sage/15 text-sage",
  warning: "border-amber-300/35 bg-amber-100/80 text-amber-800",
  danger: "border-red-300/35 bg-red-100/80 text-red-700",
  muted: "border-ink/8 bg-ink/6 text-ink/68",
  accent: "border-coral/20 bg-coral/10 text-coral",
};

export function StatusBadge({
  children,
  tone = "default",
  className,
}: {
  children: React.ReactNode;
  tone?: StatusTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold tracking-[0.14em] uppercase",
        toneClassMap[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
