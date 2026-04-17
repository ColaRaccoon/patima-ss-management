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
import type { DailySalesUnitDetail, DailySalesUnitProfit, ProfitsPageData } from "@/lib/api/types";
import { formatCurrency, formatDate, formatDateRange, formatNumber } from "@/lib/format";
import { toneForProfitStatus } from "@/lib/status-tone";

interface ExpandedGroups {
  [groupId: string]: boolean;
}

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
  const [expandedGroups, setExpandedGroups] = useState<ExpandedGroups>({});
  const [excludedSummaryExpanded, setExcludedSummaryExpanded] = useState(false);

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

  // Prepare date filter form for PageHeader actions
  const dateFilterForm = (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        applyDateFilter(selectedDate);
      }}
    >
      <label className="block w-40">
        <span className="mb-2 block text-sm font-medium text-ink">날짜</span>
        <input
          className="input-shell"
          type="date"
          required
          value={selectedDate}
          onChange={(event) => setSelectedDate(event.target.value)}
        />
      </label>
      <button
        className="button-shell button-primary"
        type="submit"
        disabled={isRefreshing}
      >
        {isRefreshing ? "새로고침 중..." : "새로고침"}
      </button>
    </form>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="손익"
        title="판매단위 손익 분석"
        description={`기간 ${formatDateRange(data.dateFrom, data.dateTo)}. 충돌 및 미매핑 행은 제외되며, 배송비 규칙이 확정되기 전까지 배송비는 상품 매출과 분리되어 관리됩니다.`}
        actions={
          <div className="space-y-3">
            {dateFilterForm}
            {dateAvailabilityNotice ? (
              <div className="rounded-2xl border border-amber-300/40 bg-amber-100/70 px-4 py-3 text-sm leading-6 text-amber-900">
                <p className="font-semibold">{dateAvailabilityNotice.title}</p>
                <p className="mt-1">{dateAvailabilityNotice.description}</p>
              </div>
            ) : null}
          </div>
        }
      />

      <SourceBanner sources={data.sources} />

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
        {hasConflict ? (
          <StatCard
            label="충돌 매핑"
            value={`주문 ${formatCurrency(data.unmappedSummary.conflictOrderRevenue)} / 광고비 ${formatCurrency(data.unmappedSummary.conflictAdCost)}`}
            hint="손익 합계에서 제외됨"
            tone="danger"
          />
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,0.7fr)]">
        <div className="relative space-y-4">
          {isRefreshing && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-[30px] bg-white/40">
              <p className="text-sm font-medium text-ink">데이터를 새로고침 중입니다...</p>
            </div>
          )}
          {(() => {
            const storeLevelRows = data.profits.filter((row) => row.isStoreLevel);
            const groupAndRegularRows = data.profits.filter((row) => !row.isStoreLevel && !row.parentSalesUnitId);

            const handleRowClick = async (row: DailySalesUnitProfit & { _isChild?: boolean; _parentId?: string }) => {
              // 자식 행은 선택하지 않음
              if (row._isChild) return;

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
            };

            const renderExpandableTable = (rows: typeof data.profits, title: string) => {
              // 확장 가능한 구조로 변환: 그룹 행 + 그룹에 속한 자식들
              const expandableRows: (DailySalesUnitProfit & { _isChild?: boolean; _parentId?: string })[] = [];

              rows.forEach((row) => {
                expandableRows.push(row);
                // 그룹이고 확장된 경우 자식을 추가
                if (row.isGroup && expandedGroups[`${row.canonicalSalesUnitId}-${row.date}`] && row.childRows) {
                  row.childRows.forEach((childRow: DailySalesUnitProfit) => {
                    expandableRows.push({ ...childRow, _isChild: true, _parentId: row.canonicalSalesUnitId });
                  });
                }
              });

              return (
                <Panel title={title} description="행을 선택하면 해당 원가 구성과 제외된 합계를 확인할 수 있습니다.">
                  <DataTable
                    caption={title}
                    columns={[
                      {
                        key: "salesUnit",
                        title: "판매단위",
                        render: (row) => {
                          const hasSingleItem = row.displayName.includes("단품");
                          const hasBundle = row.displayName.includes("1+1");
                          const isExpandable = row.isGroup && row.childRows?.length;
                          const rowKey = `${row.canonicalSalesUnitId}-${row.date}`;
                          const isGroupExpanded = expandedGroups[rowKey];

                          return (
                            <div className={row._isChild ? "ml-6 text-xs" : ""}>
                              <div className="flex items-center gap-2">
                                {isExpandable && (
                                  <button
                                    className="button-shell button-ghost p-1 text-xs shrink-0"
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedGroups((current) => ({
                                        ...current,
                                        [rowKey]: !current[rowKey],
                                      }));
                                    }}
                                  >
                                    {isGroupExpanded ? "▼" : "▸"}
                                  </button>
                                )}
                                {!isExpandable && <span className="w-8" />}
                                {row._isChild && <span className="text-amber-600">└</span>}
                                <p className={row._isChild ? "text-xs font-normal" : "font-semibold text-ink"}>{row.displayName}</p>
                                {row.isGroup && <span className="inline-block rounded-full bg-purple-100 px-1.5 py-0.5 text-xs font-semibold text-purple-700">그룹</span>}
                                {hasSingleItem && <span className="inline-block rounded-full bg-blue-100 px-1.5 py-0.5 text-xs font-semibold text-blue-700">[단품]</span>}
                                {hasBundle && <span className="inline-block rounded-full bg-pink-100 px-1.5 py-0.5 text-xs font-semibold text-pink-700">[1+1]</span>}
                              </div>
                              <p className="mt-1 text-xs text-ink/55">{row.date}</p>
                            </div>
                          );
                        },
                      },
                      {
                        key: "quantity",
                        title: "수량",
                        className: "text-right",
                        render: (row) => (row.isStoreLevel || row.isGroup || row._isChild ? formatNumber(row.totalQuantity) : formatNumber(row.totalQuantity)),
                      },
                      {
                        key: "revenue",
                        title: "상품 매출",
                        className: "text-right",
                        render: (row) => (row.isStoreLevel ? "-" : formatCurrency(row.totalProductRevenue)),
                      },
                      {
                        key: "adCost",
                        title: "광고비",
                        className: "text-right",
                        render: (row) => (row._isChild ? "-" : formatCurrency(row.totalAdCost)),
                      },
                      {
                        key: "feeCost",
                        title: "수수료",
                        className: "text-right",
                        render: (row) => (row.isStoreLevel ? "-" : formatCurrency(row.totalFeeCost)),
                      },
                      {
                        key: "unitCost",
                        title: "원가",
                        className: "text-right",
                        render: (row) => (row.isStoreLevel ? "-" : formatCurrency(row.totalUnitCost)),
                      },
                      {
                        key: "otherCost",
                        title: "기타비용",
                        className: "text-right",
                        render: (row) => (row.isStoreLevel ? "-" : formatCurrency(row.totalOtherCost)),
                      },
                      {
                        key: "roughProfit",
                        title: "대략 손익",
                        className: "text-right",
                        render: (row) => (row.isStoreLevel ? "-" : formatCurrency(row.roughProfit)),
                      },
                      {
                        key: "netProfit",
                        title: "순이익",
                        className: "text-right",
                        render: (row) => (row.isStoreLevel ? "-" : formatCurrency(row.estimatedNetProfit)),
                      },
                    ]}
                    rows={expandableRows}
                    getRowKey={(row) => `${row.canonicalSalesUnitId}-${row.date}${row._isChild ? '-child-' + row._parentId : ''}`}
                    selectedRowKey={selectedProfitKey}
                    onRowClick={handleRowClick}
                  />
                </Panel>
              );
            };

            return (
              <>
                {storeLevelRows.length > 0 && renderExpandableTable(storeLevelRows, "스토어 전체 광고비")}
                {groupAndRegularRows.length > 0 && renderExpandableTable(groupAndRegularRows, "일자별 손익 행")}
              </>
            );
          })()}
        </div>

        <div className="xl:sticky xl:top-6 space-y-6">
          <Panel
            title="제외된 합계"
            aside={
              <button
                className="button-shell button-ghost text-xs"
                type="button"
                onClick={() => setExcludedSummaryExpanded(!excludedSummaryExpanded)}
              >
                {excludedSummaryExpanded ? "축소" : "펼치기"}
              </button>
            }
          >
            {excludedSummaryExpanded ? (
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
            ) : (
              <div className="flex items-center justify-center rounded-lg bg-ink/3 py-8">
                <p className="text-xs text-ink/50">펼쳐서 상세 항목을 확인하세요</p>
              </div>
            )}
          </Panel>

          <Panel title="상세 미리보기">
            {detailError ? (
              <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {detailError}
              </div>
            ) : null}

            {isLoadingDetail ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-ink/60">상세를 불러오는 중...</p>
              </div>
            ) : selectedDetail ? (
              <div className="space-y-6">
                <div className="flex items-center justify-between gap-3 pb-4 border-b border-ink/8">
                  <p className="font-semibold text-ink">{selectedDetail.displayName}</p>
                  <StatusBadge tone={toneForProfitStatus(selectedDetail.summary.profitStatus)}>
                    {selectedDetail.summary.profitStatus === "COMPLETE"
                      ? "완전"
                      : selectedDetail.summary.profitStatus === "INCOMPLETE_COST"
                        ? "원가 불완전"
                        : selectedDetail.summary.profitStatus}
                  </StatusBadge>
                </div>

                {/* Group 1: 거래 요약 */}
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-ink/45 font-semibold mb-3">거래 요약</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-ink/55">주문 건수</p>
                      <p className="mt-1 text-sm font-semibold text-ink">{formatNumber(selectedDetail.orderItems?.length ?? 0)}건</p>
                    </div>
                    <div>
                      <p className="text-xs text-ink/55">광고 캠페인</p>
                      <p className="mt-1 text-sm font-semibold text-ink">{formatNumber(selectedDetail.adCampaigns?.length ?? 0)}개</p>
                    </div>
                  </div>
                </div>

                <div className="border-b border-ink/8" />

                {/* Group 2: 주요 수치 */}
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-ink/45 font-semibold mb-3">주요 수치</h3>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-ink/55">총 수량</p>
                      <p className="text-sm font-semibold text-ink">{formatNumber(selectedDetail.summary.totalQuantity)}</p>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-ink/55">상품 매출</p>
                      <p className="text-sm font-semibold text-ink">{formatCurrency(selectedDetail.summary.totalProductRevenue)}</p>
                    </div>
                  </div>
                </div>

                <div className="border-b border-ink/8" />

                {/* Group 3: 수수료 내역 */}
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-ink/45 font-semibold mb-3">수수료 내역</h3>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-ink/55">계산된 수수료</p>
                      <p className="text-sm font-semibold text-ink">{formatCurrency(selectedDetail.costBreakdown.computedFeeCost)}</p>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-ink/55">폴백 수수료 분담</p>
                      <p className="text-sm font-semibold text-ink">{formatCurrency(selectedDetail.costBreakdown.fallbackFeeCostPortion)}</p>
                    </div>
                    <p className="text-xs text-ink/50 mt-2">배송비 참고값은 스토어·날짜 요약 단계에서만 표시됩니다.</p>
                  </div>
                </div>

                <div className="border-b border-ink/8" />

                {/* Group 4: 제외된 항목 */}
                <div className="rounded-lg bg-amber-100/40 p-3">
                  <h3 className="text-xs uppercase tracking-wider text-amber-900/60 font-semibold mb-3">제외된 항목</h3>
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between">
                      <p className="text-amber-900/70">제외된 주문 상품 매출</p>
                      <p className="font-semibold text-amber-900">{formatCurrency(selectedDetail.excludedSummary.excludedOrderRevenue)}</p>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-amber-900/70">제외된 충돌 주문 상품 매출</p>
                      <p className="font-semibold text-amber-900">{formatCurrency(selectedDetail.excludedSummary.excludedConflictOrderRevenue)}</p>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-amber-900/70">제외된 광고비</p>
                      <p className="font-semibold text-amber-900">{formatCurrency(selectedDetail.excludedSummary.excludedAdCost)}</p>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-amber-900/70">제외된 충돌 광고비</p>
                      <p className="font-semibold text-amber-900">{formatCurrency(selectedDetail.excludedSummary.excludedConflictAdCost)}</p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-sm font-medium text-ink">선택된 행이 없습니다</p>
                <p className="mt-2 text-xs text-ink/55">왼쪽 표에서 행을 클릭하여 상세 정보를 확인하세요.</p>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
