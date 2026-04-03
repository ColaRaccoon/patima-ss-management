import Link from "next/link";

interface EmptyStateProps {
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
}

export function EmptyState({
  title,
  description,
  actionHref,
  actionLabel,
}: EmptyStateProps) {
  return (
    <div className="glass-panel rounded-[28px] px-6 py-10 text-center sm:px-10">
      <p className="text-xs uppercase tracking-[0.28em] text-ink/45">Empty State</p>
      <h3 className="mt-3 text-2xl font-semibold text-ink">{title}</h3>
      <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-ink/62">
        {description}
      </p>
      {actionHref && actionLabel ? (
        <div className="mt-6">
          <Link className="button-shell button-primary" href={actionHref}>
            {actionLabel}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
