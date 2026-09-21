"use client";

import Link from "next/link";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatusBadge } from "@/components/shared/status-badge";
import { OrderSyncPanel } from "./order-sync-panel";
import { isActiveBatch, useOrderSync } from "./order-sync-provider";
import type { OrdersPageData, OrdersPageFilters } from "@/lib/api/types";
import {
  buildNaverStoreProductUrl,
  formatCurrency,
  formatDate,
  formatNullableText,
  formatNumber,
} from "@/lib/format";
import { toneForSaleStatus } from "@/lib/status-tone";
import { buildHrefWithStore, STORE_ID_QUERY_KEY } from "@/lib/store-selection";

const SALE_STATUS_OPTIONS = [
  "ALL",
  "SALE",
  "CANCELED",
  "CANCEL_REQUESTED",
  "RETURNED",
  "EXCHANGED",
  "UNKNOWN",
] as const;

export function OrdersView({ data }: { data: OrdersPageData }) {
  const router = useRouter();
  const [filters, setFilters] = useState<OrdersPageFilters>(data.filters);
  const sync = useOrderSync();
  const [isRefreshing, startRefresh] = useTransition();

  useEffect(() => {
    setFilters(data.filters);
  }, [data.filters]);

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="주문 데이터를 보려면 먼저 대표 스토어가 필요합니다."
        description="스토어가 생성되지 않은 상태에서는 주문 동기화와 원본 시그니처 관리를 시작할 수 없습니다."
        actionHref="/settings/stores"
        actionLabel="스토어 먼저 설정"
      />
    );
  }

  const isBusy =
    sync.submitting ||
    sync.pending ||
    sync.batches.some(isActiveBatch) ||
    isRefreshing;
  const operationsHref = buildHrefWithStore(
    "/operations",
    null,
    data.primaryStore.id,
  );

  const applyFilters = (nextFilters: OrdersPageFilters) => {
    const searchParams = new URLSearchParams();
    searchParams.set(STORE_ID_QUERY_KEY, data.primaryStore!.id);
    Object.entries(nextFilters).forEach(([key, value]) => {
      if (!value || value === "ALL") {
        return;
      }
      searchParams.set(key, value);
    });

    startRefresh(() => {
      router.replace(
        searchParams.size > 0
          ? `/orders?${searchParams.toString()}`
          : "/orders",
      );
    });
  };

  const startOrderSync = async (payload: {
    dateFrom?: string;
    dateTo?: string;
  }) => {
    await sync.submit(`/api/stores/${data.primaryStore!.id}/order-sync`, {
      ...payload,
      mode: payload.dateFrom ? "MANUAL" : "YESTERDAY",
    });
  };

  const startAllStoreOrderSync = async () => {
    await sync.submit("/api/stores/order-sync-all", {
      mode: "MANUAL",
      dateFrom: filters.dateFrom,
      dateTo: filters.dateFrom,
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Orders"
        title="주문 원본 데이터 검토"
        description="결제일 기준 범위, 주문 상태, 매핑 상태를 한 화면에서 확인하고 최근 동기화도 바로 시작할 수 있습니다."
        actions={
          <>
            <button
              className="button-shell button-secondary"
              type="button"
              disabled={isBusy}
              onClick={() => void startOrderSync({})}
            >
              어제 주문 동기화
            </button>
            <button
              className="button-shell button-secondary"
              type="button"
              disabled={isBusy}
              onClick={() =>
                void startOrderSync({
                  dateFrom: filters.dateFrom,
                  dateTo: filters.dateFrom,
                })
              }
            >
              {"\uC120\uD0DD \uB0A0\uC9DC \uB3D9\uAE30\uD654"}
            </button>
            <button
              className="button-shell button-secondary"
              type="button"
              disabled={isBusy}
              onClick={() => void startAllStoreOrderSync()}
            >
              전체 스토어 선택 날짜 동기화
            </button>
            <Link className="button-shell button-primary" href={operationsHref}>
              작업 상세 보기
            </Link>
          </>
        }
      />

      <SourceBanner sources={data.sources} />
      <OrderSyncPanel />

      <div className="grid gap-6">
        <Panel
          title="조회 필터"
          description={`현재 선택 날짜 ${formatDate(filters.dateFrom)}`}
        >
          <form
            className="space-y-4"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              applyFilters(filters);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">
                  조회 날짜
                </span>
                <input
                  className="input-shell"
                  type="date"
                  value={filters.dateFrom}
                  onChange={(event) => {
                    setFilters((current) => ({
                      ...current,
                      dateFrom: event.target.value,
                      dateTo: event.target.value,
                    }));
                    const nextFilters = {
                      ...filters,
                      dateFrom: event.target.value,
                      dateTo: event.target.value,
                    };
                    applyFilters(nextFilters);
                  }}
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">
                  상품명
                </span>
                <input
                  className="input-shell"
                  placeholder="원본 상품명 검색"
                  value={filters.productName}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      productName: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">
                  옵션 정보
                </span>
                <input
                  className="input-shell"
                  placeholder="원본 옵션 검색"
                  value={filters.optionInfo}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      optionInfo: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">
                  orderStatus
                </span>
                <input
                  className="input-shell"
                  placeholder="예: DELIVERED"
                  value={filters.orderStatus}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      orderStatus: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">
                  saleStatus
                </span>
                <select
                  className="input-shell"
                  value={filters.saleStatus}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      saleStatus: event.target.value,
                    }))
                  }
                >
                  {SALE_STATUS_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">
                  mappingStatus
                </span>
                <select
                  className="input-shell"
                  value={filters.mappingStatus}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      mappingStatus: event.target
                        .value as OrdersPageFilters["mappingStatus"],
                    }))
                  }
                >
                  <option value="ALL">ALL</option>
                  <option value="MAPPED">MAPPED</option>
                  <option value="UNMAPPED">UNMAPPED</option>
                  <option value="CONFLICT">CONFLICT</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">
                  paymentDateStatus
                </span>
                <select
                  className="input-shell"
                  value={filters.paymentDateStatus}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      paymentDateStatus: event.target
                        .value as OrdersPageFilters["paymentDateStatus"],
                    }))
                  }
                >
                  <option value="ALL">ALL</option>
                  <option value="PRESENT">PRESENT</option>
                  <option value="MISSING">MISSING</option>
                </select>
              </label>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                className="button-shell button-primary"
                type="submit"
                disabled={isBusy}
              >
                필터 적용
              </button>
              <button
                className="button-shell button-ghost"
                type="button"
                disabled={isBusy}
                onClick={() => {
                  const resetFilters: OrdersPageFilters = {
                    dateFrom: data.filters.dateFrom,
                    dateTo: data.filters.dateFrom,
                    productName: "",
                    optionInfo: "",
                    mappingStatus: "ALL",
                    saleStatus: "ALL",
                    orderStatus: "",
                    paymentDateStatus: "ALL",
                  };
                  setFilters(resetFilters);
                  applyFilters(resetFilters);
                }}
              >
                필터 초기화
              </button>
            </div>
          </form>
        </Panel>
      </div>

      <Panel
        title="주문상품 테이블"
        description="원본 주문명, 상태, 매핑 결과를 함께 보면서 실제 판매 데이터 품질을 점검합니다."
      >
        <DataTable
          caption="주문상품 목록"
          columns={[
            {
              key: "product",
              title: "원본 주문",
              render: (row) => (
                <div>
                  <p className="font-semibold text-ink">{row.rawProductName}</p>
                  <p className="mt-1 text-xs text-ink/55">
                    {formatNullableText(row.rawOptionInfo)}
                  </p>
                </div>
              ),
            },
            {
              key: "signature",
              title: "원본 시그니처",
              render: (row) => (
                <div className="max-w-[320px] text-xs leading-6 text-ink/65">
                  {row.sourceSignature}
                </div>
              ),
            },
            {
              key: "amount",
              title: "주문금액",
              render: (row) => (
                <div>
                  <p>{formatCurrency(row.productPaymentAmount)}</p>
                  <p className="mt-1 text-xs text-ink/55">
                    배송비 {formatCurrency(row.deliveryFeeAmount)}
                  </p>
                </div>
              ),
            },
            {
              key: "status",
              title: "상태",
              render: (row) => (
                <div className="space-y-2">
                  <StatusBadge tone={toneForSaleStatus(row.saleStatus)}>
                    {row.saleStatus}
                  </StatusBadge>
                  <p className="text-xs text-ink/55">{row.orderStatus}</p>
                </div>
              ),
            },
            {
              key: "mapping",
              title: "매핑",
              render: (row) => (
                <div>
                  <p className="font-medium text-ink">
                    {row.displayName ?? "미매핑"}
                  </p>
                  <p className="mt-1 text-xs text-ink/55">
                    {row.mappingStatus} / 결제일 {formatDate(row.paymentDate)}
                  </p>
                </div>
              ),
            },
            {
              key: "quantity",
              title: "수량",
              render: (row) => formatNumber(row.quantity),
            },
          ]}
          rows={data.orderItems}
          getRowKey={(row) => row.id}
        />
      </Panel>

      <Panel
        title="원본 주문 조합 목록"
        description="매핑되지 않은 주문 조합을 빠르게 확인하고 매핑 화면으로 넘어갈 수 있도록 요약합니다."
      >
        <DataTable
          caption="원본 주문 조합 목록"
          columns={[
            {
              key: "sourceSignature",
              title: "원본 시그니처",
              render: (row) => (
                <div>
                  <p className="font-semibold text-ink">
                    {row.sourceSignature}
                  </p>
                  <p className="mt-1 text-xs text-ink/55">
                    {row.rawProductNameSnapshot} /{" "}
                    {formatNullableText(row.rawOptionInfoSnapshot)}
                  </p>
                  {row.fallbackProductName && (
                    <p className="mt-2 text-xs text-ink/45">
                      ↳{" "}
                      <span>
                        {row.fallbackProductName}{" "}
                        <span className="text-ink/35">
                          (
                          {row.fallbackProductNameSource === "orderItem"
                            ? "원본 주문 표기"
                            : row.fallbackProductNameSource === "optionInfo"
                              ? "옵션에서 추출"
                              : row.fallbackProductNameSource === "product"
                                ? "상품 DB 매칭"
                                : row.fallbackProductNameSource ===
                                    "commerceApi"
                                  ? "네이버 커머스 API"
                                  : "상품 정보 없음"}
                          )
                        </span>
                      </span>
                    </p>
                  )}
                  {row.externalProductId &&
                    !row.fallbackProductName &&
                    row.fallbackProductNameSource === null && (
                      <p className="mt-2 text-xs text-ink/45">
                        ↳{" "}
                        {buildNaverStoreProductUrl(
                          row.storeSlug,
                          row.externalProductId,
                        ) ? (
                          <a
                            href={
                              buildNaverStoreProductUrl(
                                row.storeSlug,
                                row.externalProductId,
                              ) ?? ""
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-ink/50 underline hover:text-ink/70"
                          >
                            네이버 스토어 열기 ↗
                          </a>
                        ) : (
                          <span className="text-ink/35">(상품 정보 없음)</span>
                        )}
                      </p>
                    )}
                </div>
              ),
            },
            {
              key: "usageCount",
              title: "사용 건수",
              render: (row) => formatNumber(row.usageCount),
            },
            {
              key: "mappingStatus",
              title: "매핑 상태",
              render: (row) => (
                <StatusBadge
                  tone={row.mappingStatus === "MAPPED" ? "success" : "warning"}
                >
                  {row.mappingStatus}
                </StatusBadge>
              ),
            },
            {
              key: "salesUnit",
              title: "현재 판매단위",
              render: (row) => row.canonicalDisplayName ?? "미매핑",
            },
          ]}
          rows={data.signatures}
          getRowKey={(row) => row.id}
        />
      </Panel>
    </div>
  );
}
