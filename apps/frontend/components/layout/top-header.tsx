"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarRange, Clock3, RefreshCw, UploadCloud } from "lucide-react";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatDate, formatDateTime } from "@/lib/format";
import type { ShellData } from "@/lib/api/types";
import {
  buildHrefWithStore,
  resolveSelectedStore,
  STORE_ID_QUERY_KEY,
} from "@/lib/store-selection";

const routeMeta: Record<string, { title: string; description: string }> = {
  "/": {
    title: "대시보드",
    description: "일자 요약, 제외 금액, 핵심 손익 흐름을 한 화면에서 확인합니다.",
  },
  "/settings/stores": {
    title: "스토어 설정",
    description: "대표 스토어, 인증 연결 상태, 보안 정책을 관리합니다.",
  },
  "/orders": {
    title: "주문 데이터",
    description: "원본 주문과 동기화 품질을 점검하고 매핑 준비 상태를 확인합니다.",
  },
  "/sales-units": {
    title: "표준 판매단위",
    description: "집계 기준이 되는 판매단위를 정의하고 재사용합니다.",
  },
  "/mappings": {
    title: "매핑 관리",
    description: "주문 원본과 광고 캠페인을 판매단위에 연결합니다.",
  },
  "/ads/uploads": {
    title: "광고 업로드",
    description: "성과형 DA 엑셀 미리보기와 대체 확정 흐름을 관리합니다.",
  },
  "/costs": {
    title: "비용 설정",
    description: "원가, fallback 수수료율, 기타 비용 이력을 안전하게 관리합니다.",
  },
  "/profits": {
    title: "손익 분석",
    description: "판매단위 기준 손익과 제외 컨텍스트를 상세하게 분석합니다.",
  },
  "/operations": {
    title: "작업 이력",
    description: "장시간 작업의 상태와 실패 원인을 추적합니다.",
  },
};

function resolveMeta(pathname: string) {
  const exact = routeMeta[pathname];
  if (exact) {
    return exact;
  }

  const pair = Object.entries(routeMeta).find(([key]) =>
    key !== "/" ? pathname.startsWith(key) : false,
  );

  return pair?.[1] ?? routeMeta["/"];
}

export function TopHeader({ shellData }: { shellData: ShellData }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const meta = resolveMeta(pathname);
  const store = resolveSelectedStore(
    shellData.stores,
    searchParams.get(STORE_ID_QUERY_KEY),
  );
  const selectedStoreId = store?.id ?? null;
  const ordersHref = buildHrefWithStore("/orders", searchParams, selectedStoreId);
  const uploadsHref = buildHrefWithStore("/ads/uploads", searchParams, selectedStoreId);

  const handleStoreChange = (nextStoreId: string) => {
    const nextHref = buildHrefWithStore(pathname, searchParams, nextStoreId || null);
    router.replace(nextHref);
    router.refresh();
  };

  return (
    <header className="sticky top-0 z-20 border-b border-ink/10 bg-[rgba(247,241,230,0.84)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-ink/65">
              스마트스토어 손익 관리
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-semibold tracking-tight text-ink">
                {meta.title}
              </h2>
              <StatusBadge
                tone={shellData.storeSource === "live" ? "success" : "warning"}
              >
                {shellData.storeSource === "live" ? "라이브 스토어" : "테스트 스토어"}
              </StatusBadge>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/70">
              {meta.description}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Link className="button-shell button-secondary" href={ordersHref}>
              <RefreshCw className="h-4 w-4" />
              주문 동기화
            </Link>
            <Link className="button-shell button-ghost" href={uploadsHref}>
              <UploadCloud className="h-4 w-4" />
              엑셀 업로드
            </Link>
          </div>
        </div>

        <div className="grid gap-3 rounded-[28px] border border-ink/10 bg-white/55 px-4 py-4 sm:grid-cols-3">
          <div className="rounded-2xl bg-white/70 px-4 py-3">
            <div className="flex items-center gap-2 text-xs tracking-tight text-ink/65">
              <CalendarRange className="h-3.5 w-3.5" />
              현재 기준일
            </div>
            <p className="mt-2 text-sm font-medium text-ink">
              {formatDate(shellData.today)}
            </p>
          </div>

          <div className="rounded-2xl bg-white/70 px-4 py-3">
            <div className="flex items-center gap-2 text-xs tracking-tight text-ink/65">
              <Clock3 className="h-3.5 w-3.5" />
              선택 스토어
            </div>
            <select
              className="input-shell mt-2 h-9 text-sm"
              value={store?.id ?? ""}
              onChange={(event) => handleStoreChange(event.target.value)}
              disabled={shellData.stores.length === 0}
            >
              {shellData.stores.length === 0 ? (
                <option value="">스토어 없음</option>
              ) : null}
              {shellData.stores.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.isPrimary ? " (대표)" : ""}
                  {item.isActive ? "" : " (비활성)"}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink/55">
              {store
                ? `${store.sellerAccountId} / ${store.channelNo}`
                : "초기 설정 이후 전체 화면이 활성화됩니다."}
            </p>
          </div>

          <div className="rounded-2xl bg-white/70 px-4 py-3">
            <div className="flex items-center gap-2 text-xs tracking-tight text-ink/65">
              <RefreshCw className="h-3.5 w-3.5" />
              최근 주문 동기화
            </div>
            <p className="mt-2 text-sm font-medium text-ink">
              {store?.lastOrderSyncAt
                ? formatDateTime(store.lastOrderSyncAt)
                : "아직 실행 기록 없음"}
            </p>
            <p className="mt-1 text-xs text-ink/55">
              상태: {store?.lastOrderSyncStatus ?? "NEVER"}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}
