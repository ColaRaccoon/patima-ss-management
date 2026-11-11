"use client";

import type { PageMeta } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";

export function Pagination({
  page,
  label,
  pending,
  onPageChange,
}: {
  page: PageMeta;
  label: string;
  pending?: boolean;
  onPageChange: (page: number) => void;
}) {
  const first = page.totalCount === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const last = Math.min(page.page * page.pageSize, page.totalCount);
  return (
    <nav
      aria-label={`${label} 페이지`}
      className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ink/10 pt-4"
    >
      <p className="text-sm text-ink/70" role="status">
        {pending
          ? "불러오는 중…"
          : `총 ${formatNumber(page.totalCount)}건 · ${formatNumber(Math.min(first, last))}–${formatNumber(last)}건 표시`}
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="button-shell button-secondary"
          disabled={pending || page.page <= 1}
          onClick={() => onPageChange(page.page - 1)}
        >
          이전
        </button>
        <span className="text-sm tabular-nums">
          {formatNumber(page.page)} / {formatNumber(page.totalPages)}
        </span>
        <button
          type="button"
          className="button-shell button-secondary"
          disabled={pending || !page.hasNext}
          onClick={() => onPageChange(page.page + 1)}
        >
          다음
        </button>
      </div>
    </nav>
  );
}
