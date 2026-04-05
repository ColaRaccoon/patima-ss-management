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
import { readApiResponse } from "@/lib/api/browser";
import type { OrdersPageData, OrdersPageFilters } from "@/lib/api/types";
import {
  formatCurrency,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatNullableText,
  formatNumber,
} from "@/lib/format";
import { toneForOperationStatus, toneForSaleStatus } from "@/lib/status-tone";

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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
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

  const isBusy = isSyncing || isRefreshing;

  const applyFilters = (nextFilters: OrdersPageFilters) => {
    const searchParams = new URLSearchParams();
    Object.entries(nextFilters).forEach(([key, value]) => {
      if (!value || value === "ALL") {
        return;
      }
      searchParams.set(key, value);
    });

    startRefresh(() => {
      router.replace(searchParams.size > 0 ? `/orders?${searchParams.toString()}` : "/orders");
    });
  };

  const startOrderSync = async (
    payload: { dateFrom?: string; dateTo?: string },
    fallbackMessage: string,
    nextSuccessMessage: string,
  ) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSyncing(true);
    try {
      await readApiResponse(
        await fetch(`/api/stores/${data.primaryStore!.id}/order-sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
        fallbackMessage,
      );

      setSuccessMessage(nextSuccessMessage);
      startRefresh(() => {
        router.refresh();
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "\uC8FC\uBB38 \uB3D9\uAE30\uD654 \uC694\uCCAD \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.",
      );
    } finally {
      setIsSyncing(false);
    }
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
              onClick={async () => {
                setErrorMessage(null);
                setSuccessMessage(null);
                setIsSyncing(true);
                try {
                  await readApiResponse(
                    await fetch(`/api/stores/${data.primaryStore!.id}/order-sync`, {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({}),
                    }),
                    "최근 30일 주문 동기화 시작에 실패했습니다.",
                  );

                  setSuccessMessage("최근 30일 주문 동기화를 큐에 등록했습니다.");
                  startRefresh(() => {
                    router.refresh();
                  });
                } catch (error) {
                  setErrorMessage(
                    error instanceof Error
                      ? error.message
                      : "주문 동기화 요청 중 오류가 발생했습니다.",
                  );
                } finally {
                  setIsSyncing(false);
                }
              }}
            >
              최근 30일 동기화
            </button>
            <button
              className="button-shell button-secondary"
              type="button"
              disabled={isBusy}
              onClick={() =>
                void startOrderSync(
                  {
                    dateFrom: filters.dateFrom,
                    dateTo: filters.dateTo,
                  },
                  "\uC120\uD0DD \uAE30\uAC04 \uC8FC\uBB38 \uB3D9\uAE30\uD654 \uC2DC\uC791\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.",
                  `\uC120\uD0DD \uAE30\uAC04(${filters.dateFrom} ~ ${filters.dateTo}) \uC8FC\uBB38 \uB3D9\uAE30\uD654\uB97C \uC791\uC5C5 \uD050\uC5D0 \uB4F1\uB85D\uD588\uC2B5\uB2C8\uB2E4.`,
                )
              }
            >
              {"\uC120\uD0DD \uAE30\uAC04 \uB3D9\uAE30\uD654"}
            </button>
            <Link className="button-shell button-primary" href="/operations">
              작업 상세 보기
            </Link>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <Panel
          title="조회 필터"
          description={`현재 조회 범위 ${formatDateRange(
            data.filters.dateFrom,
            data.filters.dateTo,
          )}`}
        >
          <form
            className="space-y-4"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setErrorMessage(null);
              setSuccessMessage(null);
              applyFilters(filters);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">dateFrom</span>
                <input
                  className="input-shell"
                  type="date"
                  value={filters.dateFrom}
                  onChange={(event) =>
                    setFilters((current) => ({ ...current, dateFrom: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">dateTo</span>
                <input
                  className="input-shell"
                  type="date"
                  value={filters.dateTo}
                  onChange={(event) =>
                    setFilters((current) => ({ ...current, dateTo: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">상품명</span>
                <input
                  className="input-shell"
                  placeholder="원본 상품명 검색"
                  value={filters.productName}
                  onChange={(event) =>
                    setFilters((current) => ({ ...current, productName: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">옵션 정보</span>
                <input
                  className="input-shell"
                  placeholder="원본 옵션 검색"
                  value={filters.optionInfo}
                  onChange={(event) =>
                    setFilters((current) => ({ ...current, optionInfo: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">orderStatus</span>
                <input
                  className="input-shell"
                  placeholder="예: DELIVERED"
                  value={filters.orderStatus}
                  onChange={(event) =>
                    setFilters((current) => ({ ...current, orderStatus: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">saleStatus</span>
                <select
                  className="input-shell"
                  value={filters.saleStatus}
                  onChange={(event) =>
                    setFilters((current) => ({ ...current, saleStatus: event.target.value }))
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
                <span className="mb-2 block text-sm font-medium text-ink">mappingStatus</span>
                <select
                  className="input-shell"
                  value={filters.mappingStatus}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      mappingStatus: event.target.value as OrdersPageFilters["mappingStatus"],
                    }))
                  }
                >
                  <option value="ALL">ALL</option>
                  <option value="MAPPED">MAPPED</option>
                  <option value="UNMAPPED">UNMAPPED</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">paymentDateStatus</span>
                <select
                  className="input-shell"
                  value={filters.paymentDateStatus}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      paymentDateStatus:
                        event.target.value as OrdersPageFilters["paymentDateStatus"],
                    }))
                  }
                >
                  <option value="ALL">ALL</option>
                  <option value="PRESENT">PRESENT</option>
                  <option value="MISSING">MISSING</option>
                </select>
              </label>
            </div>

            {errorMessage ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {errorMessage}
              </div>
            ) : null}

            {successMessage ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {successMessage}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-3">
              <button className="button-shell button-primary" type="submit" disabled={isBusy}>
                필터 적용
              </button>
              <button
                className="button-shell button-ghost"
                type="button"
                disabled={isBusy}
                onClick={() => {
                  const resetFilters: OrdersPageFilters = {
                    dateFrom: data.filters.dateFrom,
                    dateTo: data.filters.dateTo,
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

        <Panel title="최근 주문 동기화 작업">
          {data.latestOperation ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-ink">
                    {data.latestOperation.operationType}
                  </p>
                  <p className="mt-1 text-xs text-ink/55">
                    {formatDateTime(data.latestOperation.createdAt)}
                  </p>
                </div>
                <StatusBadge tone={toneForOperationStatus(data.latestOperation.status)}>
                  {data.latestOperation.status}
                </StatusBadge>
              </div>
              <div className="rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
                <p>cutoffAt {formatDateTime(data.latestOperation.cutoffAt)}</p>
                <p className="mt-2">
                  요청 요약: {formatNullableText(JSON.stringify(data.latestOperation.requestSummary))}
                </p>
                <p className="mt-2">
                  결과 요약: {formatNullableText(JSON.stringify(data.latestOperation.resultSummary))}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink/60">아직 동기화 작업 이력이 없습니다.</p>
          )}
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
                  <p className="font-medium text-ink">{row.displayName ?? "미매핑"}</p>
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
                  <p className="font-semibold text-ink">{row.sourceSignature}</p>
                  <p className="mt-1 text-xs text-ink/55">
                    {row.rawProductNameSnapshot} / {formatNullableText(row.rawOptionInfoSnapshot)}
                  </p>
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
                <StatusBadge tone={row.mappingStatus === "MAPPED" ? "success" : "warning"}>
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
