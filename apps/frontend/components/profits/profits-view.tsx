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
        title="Profit analysis needs a primary store."
        description="Orders, ads, and cost settings must be tied to one store before profit rows can be calculated."
        actionHref="/settings/stores"
        actionLabel="Open store settings"
      />
    );
  }

  const deliveryFeeReferenceTotal =
    selectedDetail?.orderItems.reduce((total, item) => total + (item.deliveryFeeAmount ?? 0), 0) ?? 0;
  const hasConflict = data.unmappedSummary.conflictOrderItemCount > 0 || data.unmappedSummary.conflictCampaignCount > 0;
  const dateAvailabilityNotice = (() => {
    if (data.latestOrderDate && data.latestAdDate && !data.latestOverlapDate) {
      return {
        title: "Eligible orders and confirmed ads do not overlap yet.",
        description: `Latest eligible order date is ${formatDate(data.latestOrderDate)} and latest confirmed ad date is ${formatDate(data.latestAdDate)}. The profits tab defaults to ${formatDate(data.dateTo)} until a shared date exists, so one side of the totals can still be 0.`,
      };
    }

    if (
      data.latestOrderDate &&
      data.latestAdDate &&
      data.latestOverlapDate &&
      data.latestOrderDate !== data.latestAdDate
    ) {
      return {
        title: "Orders and ads were last updated on different days.",
        description: `Latest eligible order date is ${formatDate(data.latestOrderDate)}, latest confirmed ad date is ${formatDate(data.latestAdDate)}, and the latest shared date is ${formatDate(data.latestOverlapDate)}. The profits tab defaults to the shared date so quantity, revenue, fee, and ad cost line up.`,
      };
    }

    if (!data.latestOrderDate && data.latestAdDate) {
      return {
        title: "Confirmed ad costs exist, but no eligible order rows are available yet.",
        description: `Confirmed ad costs are available on ${formatDate(data.latestAdDate)}. Quantity, revenue, and fee stay 0 until sale rows are synced and mapped to a sales unit.`,
      };
    }

    if (data.latestOrderDate && !data.latestAdDate) {
      return {
        title: "Eligible order rows exist, but confirmed ad costs are not available yet.",
        description: `Eligible order rows are available on ${formatDate(data.latestOrderDate)}. Ad cost stays 0 until the ad upload is confirmed and mapped.`,
      };
    }

    return null;
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Profits"
        title="Sales-unit profit analysis"
        description={`Range ${formatDateRange(data.dateFrom, data.dateTo)}. Conflict and unmapped rows are excluded from the aggregated totals.`}
      />

      <SourceBanner sources={data.sources} />

      {dateAvailabilityNotice ? (
        <div className="rounded-2xl border border-amber-300/40 bg-amber-100/70 px-4 py-4 text-sm leading-6 text-amber-900">
          <p className="font-semibold">{dateAvailabilityNotice.title}</p>
          <p className="mt-1">{dateAvailabilityNotice.description}</p>
        </div>
      ) : null}

      <Panel
        title="Filter date"
        description={`Current date ${formatDate(data.dateTo)}. The table and summary cards are recalculated for the selected day.`}
      >
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            applyDateFilter(selectedDate);
          }}
        >
          <label className="block min-w-56">
            <span className="mb-2 block text-sm font-medium text-ink">date</span>
            <input
              className="input-shell"
              type="date"
              required
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
          </label>
          <button className="button-shell button-primary" type="submit" disabled={isRefreshing}>
            Refresh
          </button>
        </form>
      </Panel>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Revenue" value={formatCurrency(data.summary.totalRevenue)} />
        <StatCard label="Ad cost" value={formatCurrency(data.summary.totalAdCost)} tone="accent" />
        <StatCard
          label="Rough profit"
          value={formatCurrency(data.summary.roughProfit)}
          tone={data.summary.roughProfit >= 0 ? "success" : "danger"}
        />
        <StatCard
          label="Estimated net profit"
          value={formatCurrency(data.summary.estimatedNetProfit)}
          hint={
            data.summary.profitStatus === "INCOMPLETE_COST"
              ? "Some cost rows are incomplete."
              : undefined
          }
          tone={toneForProfitStatus(data.summary.profitStatus)}
        />
      </div>

      {hasConflict ? (
        <div className="rounded-2xl border border-red-300/40 bg-red-100/70 px-4 py-4 text-sm leading-6 text-red-800">
          <p className="font-semibold">Conflict mappings are excluded from profit totals.</p>
          <p className="mt-1">
            Order revenue {formatCurrency(data.unmappedSummary.conflictOrderRevenue)} / Ad cost {formatCurrency(data.unmappedSummary.conflictAdCost)}
          </p>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Panel
          title="Daily profit rows"
          description="Select a row to inspect the underlying cost breakdown and excluded totals."
        >
          <DataTable
            caption="Daily profit rows"
            columns={[
              {
                key: "select",
                title: "Select",
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
                          "Failed to load profit detail.",
                        );
                        setSelectedDetail(detail);
                      } catch (error) {
                        setDetailError(
                          error instanceof Error ? error.message : "Failed to load profit detail.",
                        );
                      } finally {
                        setIsLoadingDetail(false);
                      }
                    }}
                  >
                    {`${row.canonicalSalesUnitId}-${row.date}` === selectedProfitKey ? "Selected" : "Open"}
                  </button>
                ),
              },
              {
                key: "salesUnit",
                title: "Sales unit",
                render: (row) => (
                  <div>
                    <p className="font-semibold text-ink">{row.displayName}</p>
                    <p className="mt-1 text-xs text-ink/55">{row.date}</p>
                  </div>
                ),
              },
              {
                key: "quantity",
                title: "Qty",
                render: (row) => formatNumber(row.totalQuantity),
              },
              {
                key: "revenue",
                title: "Revenue",
                render: (row) => formatCurrency(row.totalRevenue),
              },
              {
                key: "adCost",
                title: "Ad cost",
                render: (row) => formatCurrency(row.totalAdCost),
              },
              {
                key: "feeCost",
                title: "Fee",
                render: (row) => formatCurrency(row.totalFeeCost),
              },
              {
                key: "roughProfit",
                title: "Rough profit",
                render: (row) => formatCurrency(row.roughProfit),
              },
              {
                key: "netProfit",
                title: "Net profit",
                render: (row) => formatCurrency(row.estimatedNetProfit),
              },
            ]}
            rows={data.profits}
            getRowKey={(row) => `${row.canonicalSalesUnitId}-${row.date}`}
          />
        </Panel>

        <div className="space-y-6">
          <Panel title="Excluded totals">
            <div className="grid gap-3">
              <StatCard
                label="Unmapped order revenue"
                value={formatCurrency(data.unmappedSummary.unmappedOrderRevenue)}
                hint={`${formatNumber(data.unmappedSummary.unmappedOrderItemCount)} items`}
                tone="warning"
              />
              <StatCard
                label="Conflict order revenue"
                value={formatCurrency(data.unmappedSummary.conflictOrderRevenue)}
                hint={`${formatNumber(data.unmappedSummary.conflictOrderItemCount)} items`}
                tone="danger"
              />
              <StatCard
                label="Unmapped ad cost"
                value={formatCurrency(data.unmappedSummary.unmappedAdCost)}
                hint={`${formatNumber(data.unmappedSummary.unmappedCampaignCount)} campaigns`}
                tone="warning"
              />
              <StatCard
                label="Conflict ad cost"
                value={formatCurrency(data.unmappedSummary.conflictAdCost)}
                hint={`${formatNumber(data.unmappedSummary.conflictCampaignCount)} campaigns`}
                tone="danger"
              />
              <StatCard
                label="Intentional unmapped ad cost"
                value={formatCurrency(data.unmappedSummary.intentionalUnmappedAdCost)}
                hint={`${formatNumber(data.unmappedSummary.intentionalUnmappedCampaignCount)} campaigns`}
                tone="muted"
              />
            </div>
          </Panel>

          <Panel title="Detail preview">
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
                <p>
                  Orders {formatNumber(selectedDetail.orderItems.length)} / Ads {formatNumber(selectedDetail.adCampaigns.length)}
                </p>
                <p>Total quantity {formatNumber(selectedDetail.summary.totalQuantity)}</p>
                <p>Computed fee cost {formatCurrency(selectedDetail.costBreakdown.computedFeeCost)}</p>
                <p>Fallback fee portion {formatCurrency(selectedDetail.costBreakdown.fallbackFeeCostPortion)}</p>
                <p>Delivery reference {formatCurrency(deliveryFeeReferenceTotal)}</p>
                <p>Excluded order revenue {formatCurrency(selectedDetail.excludedSummary.excludedOrderRevenue)}</p>
                <p>Excluded conflict order revenue {formatCurrency(selectedDetail.excludedSummary.excludedConflictOrderRevenue)}</p>
                <p>Excluded ad cost {formatCurrency(selectedDetail.excludedSummary.excludedAdCost)}</p>
                <p>Excluded conflict ad cost {formatCurrency(selectedDetail.excludedSummary.excludedConflictAdCost)}</p>
                {isLoadingDetail ? <p>Loading detail...</p> : null}
              </div>
            ) : (
              <p className="text-sm text-ink/60">No detail selected.</p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
