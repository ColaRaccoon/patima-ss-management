import { cn } from "@/lib/cn";

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "accent" | "success" | "warning" | "danger" | "muted";
}

const toneClassMap: Record<NonNullable<StatCardProps["tone"]>, string> = {
  default: "bg-white/72",
  accent: "bg-coral/10",
  success: "bg-sage/15",
  warning: "bg-amber-100/75",
  danger: "bg-red-100/75",
  muted: "bg-ink/5",
};

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: StatCardProps) {
  return (
    <div
      className={cn(
        "rounded-[26px] border border-ink/10 px-5 py-5 shadow-sm",
        toneClassMap[tone],
      )}
    >
      <p className={cn(
        "text-xs tracking-tight text-ink/70",
        /^[A-Z\s]+$/.test(label ?? "") && "uppercase tracking-wider"
      )}>
        {label}
      </p>
      <p className="mt-3 font-mono text-2xl font-semibold tracking-tight text-ink" style={{ fontVariantNumeric: "tabular-nums" }}>
        {value}
      </p>
      {hint ? <p className="mt-2 text-sm leading-6 text-ink/65">{hint}</p> : null}
    </div>
  );
}
