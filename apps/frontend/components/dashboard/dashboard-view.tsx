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
        title="A primary store is required."
        description="Create or activate a store before the dashboard can summarize orders, ads, and profit data."
        actionHref="/settings/stores"
        actionLabel="Open store settings"
      />
    );
  }

  const hasConflict = data.summary.conflictOrderItemCount > 0 || data.summary.conflictCampaignCount > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Dashboard"
        title={`${data.primaryStore.name} summary`}
        description="Daily profit, excluded totals, and recent operations in one place."
        actions={
          <>
            <Link className="button-shell button-secondary" href="/profits">
              Open profits
            </Link>
            <Link className="button-shell button-primary" href="/mappings">
              Review mappings
            </Link>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={`Revenue on ${formatDate(data.selectedDate)}`}
          value={formatCurrency(data.summary.totalRevenue)}
          hint={`Sales units ${formatNumber(data.summary.salesUnitCount)}`}
        />
        <StatCard
          label="Ad cost"
          value={formatCurrency(data.summary.totalAdCost)}
          hint={`Excluded ${formatCurrency(data.summary.excludedAdCost)}`}
          tone="accent"
        />
        <StatCard
          label="Rough profit"
          value={formatCurrency(data.summary.roughProfit)}
          hint="Revenue - ad cost"
          tone={data.summary.roughProfit >= 0 ? "success" : "warning"}
        />
        <StatCard
          label="Estimated net profit"
          value={formatCurrency(data.summary.estimatedNetProfit)}
          hint={
            data.summary.profitStatus === "INCOMPLETE_COST"
              ? "Some cost settings are incomplete."
              : "All tracked cost layers applied."
          }
          tone={toneForProfitStatus(data.summary.profitStatus)}
        />
      </div>

      {hasConflict ? (
        <div className="rounded-2xl border border-red-300/40 bg-red-100/70 px-4 py-4 text-sm leading-6 text-red-800">
          <p className="font-semibold">Conflict mappings are excluded from totals.</p>
          <p className="mt-1">
            Orders {formatNumber(data.summary.conflictOrderItemCount)} / Ads {formatNumber(data.summary.conflictCampaignCount)}
          </p>
          <p>
            Excluded revenue {formatCurrency(data.summary.excludedConflictOrderRevenue)} / Excluded ad cost {formatCurrency(data.summary.excludedConflictAdCost)}
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
              label="Total excluded revenue"
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
        description="Rows shown here already exclude conflict and unmapped data from the aggregated totals."
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
              title: "Revenue",
              render: (row) => formatCurrency(row.totalRevenue),
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
