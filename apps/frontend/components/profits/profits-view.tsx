"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { readApiResponse } from "@/lib/api/browser";
import type { DailySalesUnitDetail, ProfitsPageData } from "@/lib/api/types";
import { formatCurrency, formatDate, formatDateRange, formatNumber } from "@/lib/format";
import { toneForProfitStatus } from "@/lib/status-tone";

export function ProfitsView({ data }: { data: ProfitsPageData }) {
  const router = useRouter();
  const [selectedProfitKey, setSelectedProfitKey] = useState<string | null>(
    data.selectedDetail
      ? `${data.selectedDetail.canonicalSalesUnitId}-${data.selectedDetail.date}`
      : data.profits[0]
        ? `${data.profits[0].canonicalSalesUnitId}-${data.profits[0].date}`
        : null,
  );
  const [selectedDetail, setSelectedDetail] = useState<DailySalesUnitDetail | null>(
    data.selectedDetail,
  );
  const [selectedDate, setSelectedDate] = useState(data.dateTo);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();

  useEffect(() => {
    setSelectedDate(data.dateTo);
  }, [data.dateTo]);

  useEffect(() => {
    if (
      selectedProfitKey &&
      data.profits.some((row) => `${row.canonicalSalesUnitId}-${row.date}` === selectedProfitKey)
    ) {
      return;
    }

    if (data.selectedDetail) {
      setSelectedProfitKey(`${data.selectedDetail.canonicalSalesUnitId}-${data.selectedDetail.date}`);
      setSelectedDetail(data.selectedDetail);
      return;
    }

    if (data.profits[0]) {
      setSelectedProfitKey(`${data.profits[0].canonicalSalesUnitId}-${data.profits[0].date}`);
    }
  }, [data.profits, data.selectedDetail, selectedProfitKey]);

  const applyDateFilter = (nextDate: string) => {
    const searchParams = new URLSearchParams();
    if (nextDate) {
      searchParams.set("date", nextDate);
    }

    startRefresh(() => {
      router.replace(searchParams.size > 0 ? `/profits?${searchParams.toString()}` : "/profits");
    });
  };

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="손익 분석을 위해서는 기본 스토어가 필요합니다."
        description="손익 행을 계산하려면 주문, 광고, 원가 설정이 하나의 스토어에 연결되어 있어야 합니다."
        actionHref="/settings/stores"
        actionLabel="스토어 설정 열기"
      />
    );
  }

  const hasConflict = data.unmappedSummary.conflictOrderItemCount > 0 || data.unmappedSummary.conflictCampaignCount > 0;
  const dateAvailabilityNotice = (() => {
    if (data.latestOrderDate && data.latestAdDate && !data.latestOverlapDate) {
      return {
        title: "아직 유효 주문과 확정된 광고가 겹치는 날짜가 없습니다.",
        description: `최근 유효 주문일은 ${formatDate(data.latestOrderDate)}이고 최근 확정 광고일은 ${formatDate(data.latestAdDate)}입니다. 공통 날짜가 생기기 전까지는 손익 탭이 ${formatDate(data.dateTo)}을 기본값으로 사용하므로 합계 중 한쪽이 0일 수 있습니다.`,
      };
    }

    if (
      data.latestOrderDate &&
      data.latestAdDate &&
      data.latestOverlapDate &&
      data.latestOrderDate !== data.latestAdDate
    ) {
      return {
        title: "주문과 광고가 서로 다른 날짜에 마지막으로 갱신되었습니다.",
        description: `최근 유효 주문일은 ${formatDate(data.latestOrderDate)}, 최근 확정 광고일은 ${formatDate(data.latestAdDate)}, 공통 최신 날짜는 ${formatDate(data.latestOverlapDate)}입니다. 손익 탭은 수량, 상품 매출, 수수료, 광고비가 맞물리도록 공통 날짜를 기본값으로 사용합니다.`,
      };
    }

    if (!data.latestOrderDate && data.latestAdDate) {
      return {
        title: "확정된 광고비는 있으나 유효 주문 행이 아직 없습니다.",
        description: `확정 광고비는 ${formatDate(data.latestAdDate)}에 존재합니다. 판매 행이 동기화되어 판매단위에 매핑되기 전까지 수량, 상품 매출, 수수료는 0으로 유지됩니다.`,
      };
    }

    if (data.latestOrderDate && !data.latestAdDate) {
      return {
        title: "유효 주문 행은 있으나 확정된 광고비가 아직 없습니다.",
        description: `유효 주문 행은 ${formatDate(data.latestOrderDate)}에 존재합니다. 광고 업로드가 확정되어 매핑되기 전까지 광고비는 0으로 유지됩니다.`,
      };
    }

    return null;
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="손익"
        title="판매단위 손익 분석"
        description={`기간 ${formatDateRange(data.dateFrom, data.dateTo)}. 충돌 및 미매핑 행은 제외되며, 배송비 규칙이 확정되기 전까지 배송비는 상품 매출과 분리되어 관리됩니다.`}
      />

      <SourceBanner sources={data.sources} />

      <div className="rounded-2xl border border-sky-300/40 bg-sky-100/70 px-4 py-4 text-sm leading-6 text-sky-900">
        <p className="font-semibold">현재 배송비는 별도로 관리됩니다.</p>
        <p className="mt-1">
          배송 규칙과 배송비/보조금 처리가 확정되기 전까지 상품 매출, 대략 손익, 예상 순이익에서 배송비는 제외됩니다.
        </p>
      </div>

      {dateAvailabilityNotice ? (
        <div className="rounded-2xl border border-amber-300/40 bg-amber-100/70 px-4 py-4 text-sm leading-6 text-amber-900">
          <p className="font-semibold">{dateAvailabilityNotice.title}</p>
          <p className="mt-1">{dateAvailabilityNotice.description}</p>
        </div>
      ) : null}

      <Panel
        title="날짜 필터"
        description={`현재 날짜 ${formatDate(data.dateTo)}. 선택한 날짜를 기준으로 표와 요약 카드가 다시 계산됩니다.`}
      >
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            applyDateFilter(selectedDate);
          }}
        >
          <label className="block min-w-56">
            <span className="mb-2 block text-sm font-medium text-ink">날짜</span>
            <input
              className="input-shell"
              type="date"
              required
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
          </label>
          <button className="button-shell button-primary" type="submit" disabled={isRefreshing}>
            새로고침
          </button>
        </form>
      </Panel>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="상품 매출"
          value={formatCurrency(data.summary.totalProductRevenue)}
          hint="배송비 참고값은 별도로 표시됩니다."
        />
        <StatCard
          label="배송비 참고"
          value={formatCurrency(data.summary.totalDeliveryFeeAmount)}
          hint="현재는 참고용으로만 사용됩니다."
          tone="muted"
        />
        <StatCard label="광고비" value={formatCurrency(data.summary.totalAdCost)} tone="accent" />
        <StatCard
          label="대략 손익"
          value={formatCurrency(data.summary.roughProfit)}
          hint="상품 매출 - 광고비"
          tone={data.summary.roughProfit >= 0 ? "success" : "danger"}
        />
        <StatCard
          label="예상 순이익"
          value={formatCurrency(data.summary.estimatedNetProfit)}
          hint={
            data.summary.profitStatus === "INCOMPLETE_COST"
              ? "일부 원가 정보가 누락되었습니다."
              : undefined
          }
          tone={toneForProfitStatus(data.summary.profitStatus)}
        />
      </div>

      {hasConflict ? (
        <div className="rounded-2xl border border-red-300/40 bg-red-100/70 px-4 py-4 text-sm leading-6 text-red-800">
          <p className="font-semibold">충돌 매핑은 손익 합계에서 제외됩니다.</p>
          <p className="mt-1">
            주문 상품 매출 {formatCurrency(data.unmappedSummary.conflictOrderRevenue)} / 광고비 {formatCurrency(data.unmappedSummary.conflictAdCost)}
          </p>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Panel
          title="일자별 손익 행"
          description="행을 선택하면 해당 원가 구성과 제외된 합계를 확인할 수 있습니다."
        >
          <DataTable
            caption="일자별 손익 행"
            columns={[
              {
                key: "select",
                title: "선택",
                render: (row) => (
                  <button
                    className="button-shell button-ghost"
                    type="button"
                    onClick={async () => {
                      const rowKey = `${row.canonicalSalesUnitId}-${row.date}`;
                      if (rowKey === selectedProfitKey && selectedDetail?.date === row.date) {
                        return;
                      }

                      setSelectedProfitKey(rowKey);
                      setDetailError(null);
                      setIsLoadingDetail(true);
                      try {
                        const detail = await readApiResponse<DailySalesUnitDetail>(
                          await fetch(
                            `/api/profits/daily-sales-units/${row.canonicalSalesUnitId}?storeId=${data.primaryStore!.id}&date=${row.date}`,
                            {
                              cache: "no-store",
                            },
                          ),
                          "손익 상세를 불러오지 못했습니다.",
                        );
                        setSelectedDetail(detail);
                      } catch (error) {
                        setDetailError(
                          error instanceof Error ? error.message : "손익 상세를 불러오지 못했습니다.",
                        );
                      } finally {
                        setIsLoadingDetail(false);
                      }
                    }}
                  >
                    {`${row.canonicalSalesUnitId}-${row.date}` === selectedProfitKey ? "선택됨" : "열기"}
                  </button>
                ),
              },
              {
                key: "salesUnit",
                title: "판매단위",
                render: (row) => (
                  <div className={row.isStoreLevel ? "bg-amber-50 rounded px-2 py-1" : ""}>
                    <p className="font-semibold text-ink">
                      {row.isStoreLevel ? `[스토어 전체] ${row.displayName}` : row.displayName}
                    </p>
                    <p className="mt-1 text-xs text-ink/55">{row.date}</p>
                  </div>
                ),
              },
              {
                key: "quantity",
                title: "수량",
                render: (row) => (row.isStoreLevel ? "-" : formatNumber(row.totalQuantity)),
              },
              {
                key: "revenue",
                title: "상품 매출",
                render: (row) => (row.isStoreLevel ? "-" : formatCurrency(row.totalProductRevenue)),
              },
              {
                key: "adCost",
                title: "광고비",
                render: (row) => formatCurrency(row.totalAdCost),
              },
              {
                key: "feeCost",
                title: "수수료",
                render: (row) => (row.isStoreLevel ? "-" : formatCurrency(row.totalFeeCost)),
              },
              {
                key: "roughProfit",
                title: "대략 손익",
                render: (row) => (row.isStoreLevel ? "-" : formatCurrency(row.roughProfit)),
              },
              {
                key: "netProfit",
                title: "순이익",
                render: (row) => (row.isStoreLevel ? "-" : formatCurrency(row.estimatedNetProfit)),
              },
            ]}
            rows={data.profits}
            getRowKey={(row) => `${row.canonicalSalesUnitId}-${row.date}`}
          />
        </Panel>

        <div className="space-y-6">
          <Panel title="제외된 합계">
            <div className="grid gap-3">
              <StatCard
                label="미매핑 주문 상품 매출"
                value={formatCurrency(data.unmappedSummary.unmappedOrderRevenue)}
                hint={`${formatNumber(data.unmappedSummary.unmappedOrderItemCount)}건`}
                tone="warning"
              />
              <StatCard
                label="충돌 주문 상품 매출"
                value={formatCurrency(data.unmappedSummary.conflictOrderRevenue)}
                hint={`${formatNumber(data.unmappedSummary.conflictOrderItemCount)}건`}
                tone="danger"
              />
              <StatCard
                label="미매핑 광고비"
                value={formatCurrency(data.unmappedSummary.unmappedAdCost)}
                hint={`${formatNumber(data.unmappedSummary.unmappedCampaignCount)}개 캠페인`}
                tone="warning"
              />
              <StatCard
                label="충돌 광고비"
                value={formatCurrency(data.unmappedSummary.conflictAdCost)}
                hint={`${formatNumber(data.unmappedSummary.conflictCampaignCount)}개 캠페인`}
                tone="danger"
              />
              <StatCard
                label="의도적 미매핑 광고비"
                value={formatCurrency(data.unmappedSummary.intentionalUnmappedAdCost)}
                hint={`${formatNumber(data.unmappedSummary.intentionalUnmappedCampaignCount)}개 캠페인`}
                tone="muted"
              />
            </div>
          </Panel>

          <Panel title="상세 미리보기">
            {detailError ? (
              <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {detailError}
              </div>
            ) : null}

            {selectedDetail ? (
              <div className="space-y-3 text-sm leading-6 text-ink/65">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold text-ink">{selectedDetail.displayName}</p>
                  <StatusBadge tone={toneForProfitStatus(selectedDetail.summary.profitStatus)}>
                    {selectedDetail.summary.profitStatus === "COMPLETE"
                      ? "완전"
                      : selectedDetail.summary.profitStatus === "INCOMPLETE_COST"
                        ? "원가 불완전"
                        : selectedDetail.summary.profitStatus}
                  </StatusBadge>
                </div>
                <p>
                  주문 {formatNumber(selectedDetail.orderItems.length)}건 / 광고 {formatNumber(selectedDetail.adCampaigns.length)}건
                </p>
                <p>총 수량 {formatNumber(selectedDetail.summary.totalQuantity)}</p>
                <p>상품 매출 {formatCurrency(selectedDetail.summary.totalProductRevenue)}</p>
                <p>계산된 수수료 {formatCurrency(selectedDetail.costBreakdown.computedFeeCost)}</p>
                <p>폴백 수수료 분담 {formatCurrency(selectedDetail.costBreakdown.fallbackFeeCostPortion)}</p>
                <p>배송비 참고값은 스토어·날짜 요약 단계에서만 표시됩니다.</p>
                <p>제외된 주문 상품 매출 {formatCurrency(selectedDetail.excludedSummary.excludedOrderRevenue)}</p>
                <p>제외된 충돌 주문 상품 매출 {formatCurrency(selectedDetail.excludedSummary.excludedConflictOrderRevenue)}</p>
                <p>제외된 광고비 {formatCurrency(selectedDetail.excludedSummary.excludedAdCost)}</p>
                <p>제외된 충돌 광고비 {formatCurrency(selectedDetail.excludedSummary.excludedConflictAdCost)}</p>
                {isLoadingDetail ? <p>상세를 불러오는 중...</p> : null}
              </div>
            ) : (
              <p className="text-sm text-ink/60">선택된 상세가 없습니다.</p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
