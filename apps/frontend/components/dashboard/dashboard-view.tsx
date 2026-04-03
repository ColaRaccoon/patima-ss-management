import Link from "next/link";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import type { DashboardPageData } from "@/lib/api/types";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
} from "@/lib/format";
import { toneForOperationStatus, toneForProfitStatus } from "@/lib/status-tone";

export function DashboardView({ data }: { data: DashboardPageData }) {
  if (!data.primaryStore) {
    return (
      <EmptyState
        title="대표 스토어 초기 설정이 필요합니다."
        description="스토어가 아직 생성되지 않았습니다. 먼저 대표 스토어와 커머스 인증 정보를 설정한 뒤 대시보드 집계를 시작해 주세요."
        actionHref="/settings/stores"
        actionLabel="스토어 설정으로 이동"
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Dashboard"
        title={`${data.primaryStore.name} 손익 브리핑`}
        description="대표가 가장 먼저 보는 화면입니다. 일자 손익, 제외 금액, 최근 작업 상태를 한 화면에서 빠르게 검토할 수 있도록 구성했습니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href="/profits">
              손익 상세 보기
            </Link>
            <Link className="button-shell button-primary" href="/mappings">
              미매핑 정리
            </Link>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={`총 주문금액 · ${formatDate(data.selectedDate)}`}
          value={formatCurrency(data.summary.totalRevenue)}
          hint={`집계 대상 판매단위 ${formatNumber(data.summary.salesUnitCount)}건`}
        />
        <StatCard
          label="총 광고비"
          value={formatCurrency(data.summary.totalAdCost)}
          hint={`미매핑 제외 광고비 ${formatCurrency(
            data.summary.excludedAdCost,
          )}`}
          tone="accent"
        />
        <StatCard
          label="러프 손익"
          value={formatCurrency(data.summary.roughProfit)}
          hint="주문금액 - 광고비 기준"
          tone={data.summary.roughProfit >= 0 ? "success" : "warning"}
        />
        <StatCard
          label="추정 순이익"
          value={formatCurrency(data.summary.estimatedNetProfit)}
          hint={
            data.summary.profitStatus === "INCOMPLETE_COST"
              ? "비용 미설정 판매단위가 있어 총합이 비워졌습니다."
              : "원가, 수수료, 기타비용까지 반영되었습니다."
          }
          tone={toneForProfitStatus(data.summary.profitStatus)}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
        <Panel
          title="미매핑 및 제외 요약"
          description="집계에서 빠진 항목을 별도 금액으로 드러내어, 누락과 비매출 상태를 같은 문제로 섞어 보지 않도록 분리했습니다."
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard
              label="미매핑 주문"
              value={formatNumber(data.summary.unmappedOrderItemCount)}
              hint={formatCurrency(data.summary.excludedUnmappedOrderRevenue)}
            />
            <StatCard
              label="비매출 상태 주문"
              value={formatCurrency(data.summary.excludedNonSaleOrderRevenue)}
              hint="SALE 외 상태는 손익 집계에서 제외"
              tone="warning"
            />
            <StatCard
              label="미매핑 광고"
              value={formatNumber(data.summary.unmappedCampaignCount)}
              hint={formatCurrency(data.summary.excludedUnmappedAdCost)}
            />
            <StatCard
              label="의도적 제외 광고"
              value={formatNumber(data.summary.intentionalUnmappedCampaignCount)}
              hint={formatCurrency(data.summary.excludedIntentionalUnmappedAdCost)}
            />
            <StatCard
              label="제외 주문 총액"
              value={formatCurrency(data.summary.excludedOrderRevenue)}
            />
            <StatCard
              label="INCOMPLETE 판매단위"
              value={formatNumber(data.summary.incompleteCostSalesUnitCount)}
              hint="비용 row 또는 feeRate fallback 누락"
              tone="warning"
            />
          </div>
        </Panel>

        <Panel
          title="최근 작업"
          description="백그라운드 작업은 마지막 성공 커밋 기준으로만 화면에 반영됩니다."
        >
          <div className="space-y-3">
            {data.recentOperations.map((operation) => (
              <div
                key={operation.operationId}
                className="rounded-2xl border border-ink/10 bg-white/70 px-4 py-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-ink">
                      {operation.operationType}
                    </p>
                    <p className="mt-1 text-xs text-ink/55">
                      생성 {formatDateTime(operation.createdAt)}
                    </p>
                  </div>
                  <StatusBadge tone={toneForOperationStatus(operation.status)}>
                    {operation.status}
                  </StatusBadge>
                </div>
                {operation.errorMessage ? (
                  <p className="mt-3 text-sm leading-6 text-red-700">
                    {operation.errorMessage}
                  </p>
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
        title="표준 판매단위 손익 요약"
        description="추정 순이익이 비어 있는 판매단위는 비용 미설정 또는 fallback 수수료율 누락 상태입니다."
      >
        <DataTable
          caption="일자별 표준 판매단위 손익 요약"
          columns={[
            {
              key: "displayName",
              title: "표준 판매단위",
              render: (row) => (
                <div>
                  <p className="font-semibold text-ink">{row.displayName}</p>
                  <p className="mt-1 text-xs text-ink/55">{formatDate(row.date)}</p>
                </div>
              ),
            },
            {
              key: "totalQuantity",
              title: "판매수량",
              render: (row) => formatNumber(row.totalQuantity),
            },
            {
              key: "totalRevenue",
              title: "주문금액",
              render: (row) => formatCurrency(row.totalRevenue),
            },
            {
              key: "totalAdCost",
              title: "광고비",
              render: (row) => formatCurrency(row.totalAdCost),
            },
            {
              key: "roughProfit",
              title: "러프 손익",
              render: (row) => formatCurrency(row.roughProfit),
            },
            {
              key: "estimatedNetProfit",
              title: "추정 순이익",
              render: (row) => formatCurrency(row.estimatedNetProfit),
            },
            {
              key: "profitStatus",
              title: "상태",
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
