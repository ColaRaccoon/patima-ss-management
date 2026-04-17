"use client";

import Link from "next/link";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import type { DashboardPageData } from "@/lib/api/types";
import { formatCurrency, formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { toneForOperationStatus, toneForProfitStatus } from "@/lib/status-tone";

export function DashboardView({ data }: { data: DashboardPageData }) {
  if (!data.primaryStore) {
    return (
      <EmptyState
        title="대표 스토어가 필요합니다."
        description="대시보드에서 주문, 광고, 손익 데이터를 집계하려면 먼저 스토어를 생성하고 활성화해야 합니다."
        actionHref="/settings/stores"
        actionLabel="스토어 설정 열기"
      />
    );
  }

  const hasConflict = data.summary.conflictOrderItemCount > 0 || data.summary.conflictCampaignCount > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="대시보드"
        eyebrowLang="ko"
        title={`${data.primaryStore.name} 요약`}
        description="일자별 손익, 제외 금액, 최근 작업을 한 화면에서 확인합니다. 배송료는 배송료 규칙이 최종화될 때까지 상품 매출과 별도로 표시됩니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href="/profits">
              손익 분석 보기
            </Link>
            <Link className="button-shell button-primary" href="/mappings">
              매핑 검토
            </Link>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="rounded-2xl border border-sky-300/40 bg-sky-100/70 px-4 py-4 text-sm leading-6 text-sky-950">
        <p className="font-semibold">배송료는 순이익 합계와 별도로 표시됩니다.</p>
        <p className="mt-1">
          상품 매출, 조정 손익, 순손익은 현재 배송료 규칙과 배송비/보조금 처리가 확정될 때까지 배송료를 제외합니다.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label={`${formatDate(data.selectedDate)} 상품 매출`}
          value={formatCurrency(data.summary.totalProductRevenue)}
          hint={`판매단위 ${formatNumber(data.summary.salesUnitCount)}개`}
        />
        <StatCard
          label="배송료 참고"
          value={formatCurrency(data.summary.totalDeliveryFeeAmount)}
          hint="현재는 참고용입니다."
          tone="muted"
        />
        <StatCard
          label="광고비"
          value={formatCurrency(data.summary.totalAdCost)}
          hint={`제외됨 ${formatCurrency(data.summary.excludedAdCost)}`}
          tone="accent"
        />
        <StatCard
          label="조정 손익"
          value={formatCurrency(data.summary.roughProfit)}
          hint="상품 매출 - 광고비"
          tone={data.summary.roughProfit >= 0 ? "success" : "warning"}
        />
        <StatCard
          label="순손익(예상)"
          value={formatCurrency(data.summary.estimatedNetProfit)}
          hint={
            data.summary.profitStatus === "INCOMPLETE_COST"
              ? "일부 원가 설정이 완료되지 않았습니다."
              : "모든 추적된 원가 항목이 적용되었습니다."
          }
          tone={toneForProfitStatus(data.summary.profitStatus)}
        />
      </div>

      {hasConflict ? (
        <div className="rounded-2xl border border-red-300/40 bg-red-100/70 px-4 py-4 text-sm leading-6 text-red-800">
          <p className="font-semibold">충돌 매핑은 합계에서 제외됩니다.</p>
          <p className="mt-1">
            주문 {formatNumber(data.summary.conflictOrderItemCount)}건 / 광고 {formatNumber(data.summary.conflictCampaignCount)}건
          </p>
          <p>
            제외된 상품 매출 {formatCurrency(data.summary.excludedConflictOrderRevenue)} / 제외된 광고비 {formatCurrency(data.summary.excludedConflictAdCost)}
          </p>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
        <Panel
          title="Excluded and warning totals"
          description="Excluded amounts are separated so conflict and unmapped data do not distort the headline profit numbers."
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Unmapped orders"
              value={formatNumber(data.summary.unmappedOrderItemCount)}
              hint={formatCurrency(data.summary.excludedUnmappedOrderRevenue)}
              tone="warning"
            />
            <StatCard
              label="Conflict orders"
              value={formatNumber(data.summary.conflictOrderItemCount)}
              hint={formatCurrency(data.summary.excludedConflictOrderRevenue)}
              tone="danger"
            />
            <StatCard
              label="Non-sale orders"
              value={formatCurrency(data.summary.excludedNonSaleOrderRevenue)}
              hint="Excluded from profit totals"
              tone="muted"
            />
            <StatCard
              label="Unmapped ads"
              value={formatNumber(data.summary.unmappedCampaignCount)}
              hint={formatCurrency(data.summary.excludedUnmappedAdCost)}
              tone="warning"
            />
            <StatCard
              label="Conflict ads"
              value={formatNumber(data.summary.conflictCampaignCount)}
              hint={formatCurrency(data.summary.excludedConflictAdCost)}
              tone="danger"
            />
            <StatCard
              label="Intentional unmapped ads"
              value={formatNumber(data.summary.intentionalUnmappedCampaignCount)}
              hint={formatCurrency(data.summary.excludedIntentionalUnmappedAdCost)}
              tone="muted"
            />
            <StatCard
              label="Total excluded product revenue"
              value={formatCurrency(data.summary.excludedOrderRevenue)}
              tone="warning"
            />
            <StatCard
              label="Incomplete cost units"
              value={formatNumber(data.summary.incompleteCostSalesUnitCount)}
              hint="Missing cost settings or fallback fee inputs"
              tone="warning"
            />
          </div>
        </Panel>

        <Panel title="Recent operations" description="Latest background jobs and their current status.">
          <div className="space-y-3">
            {data.recentOperations.map((operation) => (
              <div
                key={operation.operationId}
                className="rounded-2xl border border-ink/10 bg-white/70 px-4 py-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-ink">{operation.operationType}</p>
                    <p className="mt-1 text-xs text-ink/55">
                      Created {formatDateTime(operation.createdAt)}
                    </p>
                  </div>
                  <StatusBadge tone={toneForOperationStatus(operation.status)}>
                    {operation.status}
                  </StatusBadge>
                </div>
                {operation.errorMessage ? (
                  <p className="mt-3 text-sm leading-6 text-red-700">{operation.errorMessage}</p>
                ) : (
                  <p className="mt-3 text-sm leading-6 text-ink/60">
                    cutoffAt {formatDateTime(operation.cutoffAt)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel
        title="Daily sales-unit profit rows"
        description="Rows shown here already exclude conflict and unmapped data, and delivery fee references stay outside the current profit math."
      >
        <DataTable
          caption="Daily sales-unit profit rows"
          columns={[
            {
              key: "displayName",
              title: "Sales unit",
              render: (row) => (
                <div>
                  <p className="font-semibold text-ink">{row.displayName}</p>
                  <p className="mt-1 text-xs text-ink/55">{formatDate(row.date)}</p>
                </div>
              ),
            },
            {
              key: "totalQuantity",
              title: "Qty",
              render: (row) => formatNumber(row.totalQuantity),
            },
            {
              key: "totalRevenue",
              title: "Product revenue",
              render: (row) => formatCurrency(row.totalProductRevenue),
            },
            {
              key: "totalAdCost",
              title: "Ad cost",
              render: (row) => formatCurrency(row.totalAdCost),
            },
            {
              key: "roughProfit",
              title: "Rough profit",
              render: (row) => formatCurrency(row.roughProfit),
            },
            {
              key: "estimatedNetProfit",
              title: "Net profit",
              render: (row) => formatCurrency(row.estimatedNetProfit),
            },
            {
              key: "profitStatus",
              title: "Status",
              render: (row) => (
                <StatusBadge tone={toneForProfitStatus(row.profitStatus)}>
                  {row.profitStatus === "COMPLETE" ? "COMPLETE" : "INCOMPLETE"}
                </StatusBadge>
              ),
            },
          ]}
          rows={data.profits}
          getRowKey={(row) => `${row.canonicalSalesUnitId}-${row.date}`}
        />
      </Panel>
    </div>
  );
}
