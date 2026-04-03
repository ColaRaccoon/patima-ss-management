"use client";

import { useEffect, useMemo, useState } from "react";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { readApiResponse } from "@/lib/api/browser";
import type { DailySalesUnitDetail, ProfitsPageData } from "@/lib/api/types";
import { formatCurrency, formatDateRange, formatNumber } from "@/lib/format";
import { toneForProfitStatus } from "@/lib/status-tone";

export function ProfitsView({ data }: { data: ProfitsPageData }) {
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
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  const selectedProfit = useMemo(
    () =>
      data.profits.find(
        (row) => `${row.canonicalSalesUnitId}-${row.date}` === selectedProfitKey,
      ) ?? null,
    [data.profits, selectedProfitKey],
  );

  useEffect(() => {
    if (selectedProfitKey && data.profits.some((row) => `${row.canonicalSalesUnitId}-${row.date}` === selectedProfitKey)) {
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

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="손익 분석은 대표 스토어가 있어야 열립니다."
        description="주문, 광고, 비용 데이터가 모여야 판매단위 기준 손익을 계산할 수 있습니다."
        actionHref="/settings/stores"
        actionLabel="스토어 설정"
      />
    );
  }

  const deliveryFeeReferenceTotal =
    selectedDetail?.orderItems.reduce((total, item) => total + (item.deliveryFeeAmount ?? 0), 0) ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Profits"
        title="판매단위 손익 분석"
        description={`조회 범위 ${formatDateRange(data.dateFrom, data.dateTo)}. roughProfit은 매출-광고비 기준이며, 비용이 비어 있으면 estimatedNetProfit이 null로 유지됩니다.`}
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="총 주문금액" value={formatCurrency(data.summary.totalRevenue)} />
        <StatCard label="총 광고비" value={formatCurrency(data.summary.totalAdCost)} tone="accent" />
        <StatCard
          label="러프 손익"
          value={formatCurrency(data.summary.roughProfit)}
          tone={data.summary.roughProfit >= 0 ? "success" : "danger"}
        />
        <StatCard
          label="추정 순이익"
          value={formatCurrency(data.summary.estimatedNetProfit)}
          hint={
            data.summary.profitStatus === "INCOMPLETE_COST"
              ? "INCOMPLETE 판매단위가 있어 총합을 비웠습니다."
              : undefined
          }
          tone={toneForProfitStatus(data.summary.profitStatus)}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Panel
          title="손익 테이블"
          description="행을 선택하면 우측에서 실제 손익 상세와 원가/수수료 breakdown을 확인할 수 있습니다."
        >
          <DataTable
            caption="손익 목록"
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
                          "손익 상세 조회에 실패했습니다.",
                        );
                        setSelectedDetail(detail);
                      } catch (error) {
                        setDetailError(
                          error instanceof Error
                            ? error.message
                            : "손익 상세 조회 중 오류가 발생했습니다.",
                        );
                      } finally {
                        setIsLoadingDetail(false);
                      }
                    }}
                  >
                    {`${row.canonicalSalesUnitId}-${row.date}` === selectedProfitKey ? "선택됨" : "선택"}
                  </button>
                ),
              },
              {
                key: "salesUnit",
                title: "판매단위",
                render: (row) => (
                  <div>
                    <p className="font-semibold text-ink">{row.displayName}</p>
                    <p className="mt-1 text-xs text-ink/55">{row.date}</p>
                  </div>
                ),
              },
              {
                key: "quantity",
                title: "판매수량",
                render: (row) => formatNumber(row.totalQuantity),
              },
              {
                key: "revenue",
                title: "주문금액",
                render: (row) => formatCurrency(row.totalRevenue),
              },
              {
                key: "adCost",
                title: "광고비",
                render: (row) => formatCurrency(row.totalAdCost),
              },
              {
                key: "feeCost",
                title: "수수료",
                render: (row) => formatCurrency(row.totalFeeCost),
              },
              {
                key: "roughProfit",
                title: "러프 손익",
                render: (row) => formatCurrency(row.roughProfit),
              },
              {
                key: "netProfit",
                title: "추정 순이익",
                render: (row) => formatCurrency(row.estimatedNetProfit),
              },
            ]}
            rows={data.profits}
            getRowKey={(row) => `${row.canonicalSalesUnitId}-${row.date}`}
          />
        </Panel>

        <div className="space-y-6">
          <Panel title="미매핑/제외 요약">
            <div className="grid gap-3">
              <StatCard label="미매핑 주문" value={formatCurrency(data.unmappedSummary.unmappedOrderRevenue)} />
              <StatCard label="미매핑 광고" value={formatCurrency(data.unmappedSummary.unmappedAdCost)} />
              <StatCard
                label="의도적 제외 광고"
                value={formatCurrency(data.unmappedSummary.intentionalUnmappedAdCost)}
                tone="warning"
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
                    {selectedDetail.summary.profitStatus}
                  </StatusBadge>
                </div>
                <p>주문 {formatNumber(selectedDetail.orderItems.length)}건 / 광고 {formatNumber(selectedDetail.adCampaigns.length)}건</p>
                <p>총 판매수량 {formatNumber(selectedDetail.summary.totalQuantity)}개</p>
                <p>계산된 수수료 {formatCurrency(selectedDetail.costBreakdown.computedFeeCost)}</p>
                <p>fallback 수수료 사용분 {formatCurrency(selectedDetail.costBreakdown.fallbackFeeCostPortion)}</p>
                <p>배송비 참고값 {formatCurrency(deliveryFeeReferenceTotal)}</p>
                <p>제외 주문 매출 {formatCurrency(selectedDetail.excludedSummary.excludedOrderRevenue)}</p>
                <p>제외 광고비 {formatCurrency(selectedDetail.excludedSummary.excludedAdCost)}</p>
                {isLoadingDetail ? <p>상세를 불러오는 중입니다.</p> : null}
              </div>
            ) : (
              <p className="text-sm text-ink/60">표시할 상세 미리보기가 없습니다.</p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
