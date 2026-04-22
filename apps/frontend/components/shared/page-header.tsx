import { cn } from "@/lib/cn";

interface PageHeaderProps {
  eyebrow?: string;
  eyebrowLang?: "ko" | "en"; // NEW: 한글/영문 구분
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  eyebrow = "Workspace",
  eyebrowLang = "en",
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "mb-6 flex flex-col gap-4 rounded-[32px] border border-ink/10 bg-white/55 px-5 py-6 sm:px-6",
        className,
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className={cn(
            "text-xs tracking-tight text-ink/65",
            eyebrowLang === "en" && "uppercase tracking-wider"
          )}>
            {eyebrow}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">
            {title}
          </h1>
          {description ? (<p className="mt-3 max-w-3xl text-sm leading-6 text-ink/70">{description}</p>) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
      </div>
    </div>
  );
}
