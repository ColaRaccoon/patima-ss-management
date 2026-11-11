"use client";

import Link from "next/link";
import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RefreshCw, UploadCloud } from "lucide-react";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatDateTime } from "@/lib/format";
import type { ShellData } from "@/lib/api/types";
import {
  buildHrefWithStore,
  buildStoreSwitchHref,
  resolveSelectedStore,
  STORE_ID_QUERY_KEY,
} from "@/lib/store-selection";

const routeTitles: Record<string, string> = {
  "/": "대시보드",
  "/settings/stores": "스토어 설정",
  "/orders": "주문 데이터",
  "/sales-units": "표준 판매단위",
  "/mappings": "매핑 관리",
  "/ads/uploads": "광고 업로드",
  "/costs": "비용 설정",
  "/profits": "손익 분석",
  "/operations": "작업 이력",
};

const syncStatusLabels: Record<string, string> = {
  NEVER: "동기화 기록 없음",
  QUEUED: "동기화 대기",
  RUNNING: "동기화 진행 중",
  SUCCEEDED: "동기화 완료",
  FAILED: "동기화 실패",
};

export function TopHeader({ shellData }: { shellData: ShellData }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isSwitchingStore, startStoreSwitch] = useTransition();
  const title = routeTitles[pathname] ?? Object.entries(routeTitles).find(
    ([route]) => route !== "/" && pathname.startsWith(`${route}/`),
  )?.[1] ?? "스마트스토어 손익 관리";
  const store = resolveSelectedStore(shellData.stores, searchParams.get(STORE_ID_QUERY_KEY));
  const selectedStoreId = store?.id ?? null;
  const ordersHref = buildHrefWithStore("/orders", null, selectedStoreId);
  const uploadsHref = buildHrefWithStore("/ads/uploads", null, selectedStoreId);
  const syncStatus = store?.lastOrderSyncStatus ?? "NEVER";

  const handleStoreChange = (nextStoreId: string) => {
    if (nextStoreId === selectedStoreId) return;
    startStoreSwitch(() => {
      router.replace(buildStoreSwitchHref(pathname, searchParams, nextStoreId || null));
    });
  };

  return (
    <header className="sticky top-0 z-20 border-b border-ink/10 bg-[rgba(247,241,230,0.96)] backdrop-blur-xl">
      <div className="mx-auto max-w-7xl space-y-2 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <p className="font-semibold text-ink">{title}</p>
            {shellData.storeSource !== "live" ? <StatusBadge tone="warning">테스트 데이터</StatusBadge> : null}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Link className="button-shell button-secondary" href={ordersHref}>
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
              주문 동기화
            </Link>
            <Link className="button-shell button-ghost" href={uploadsHref}>
              <UploadCloud aria-hidden="true" className="h-4 w-4" />
              광고 업로드
            </Link>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <label className="flex min-w-0 items-center gap-3 sm:max-w-md sm:flex-1">
            <span className="shrink-0 text-sm text-ink/70">스토어</span>
            <select
              className="input-shell min-w-0 !rounded-xl !py-2 text-sm"
              value={store?.id ?? ""}
              onChange={(event) => handleStoreChange(event.target.value)}
              disabled={shellData.stores.length === 0 || isSwitchingStore}
              aria-busy={isSwitchingStore}
            >
              {shellData.stores.length === 0 ? <option value="">스토어 없음</option> : null}
              {shellData.stores.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}{item.isPrimary ? " (대표)" : ""}{item.isActive ? "" : " (비활성)"}
                </option>
              ))}
            </select>
          </label>
          <p role="status" className="min-h-4 text-xs leading-5 text-ink/65">
            {isSwitchingStore ? "스토어를 변경하고 있습니다…" : store ? (
              <>
                <span className={syncStatus === "FAILED" ? "font-medium text-red-700" : undefined}>
                  {syncStatusLabels[syncStatus] ?? syncStatus}
                </span>
                {store.lastOrderSyncAt ? ` · ${formatDateTime(store.lastOrderSyncAt)}` : ""}
              </>
            ) : "스토어 설정에서 스토어를 등록해 주세요."}
          </p>
        </div>
      </div>
    </header>
  );
}
