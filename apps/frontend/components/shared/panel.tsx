import { cn } from "@/lib/cn";

interface PanelProps {
  title: string;
  description?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function Panel({
  title,
  description,
  aside,
  children,
  className,
}: PanelProps) {
  return (
    <section className={cn("glass-panel rounded-[30px] p-5 sm:p-6", className)}>
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-ink">{title}</h2>
          {description ? (
            <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/62">
              {description}
            </p>
          ) : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}
