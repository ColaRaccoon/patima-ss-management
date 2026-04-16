"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatusBadge } from "@/components/shared/status-badge";
import { readApiResponse } from "@/lib/api/browser";
import type { CostSettingListItem, CostsPageData } from "@/lib/api/types";
import { formatCurrency, formatDate, formatNumber, formatPercent } from "@/lib/format";

function emptyDraft() {
  return {
    salesUnitId: "",
    unitCost: "",
    feeRate: "",
    otherCost: "",
    effectiveFrom: "",
  };
}

export function CostsView({ data }: { data: CostsPageData }) {
  const router = useRouter();
  const [selectedCostSettingId, setSelectedCostSettingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();

  const selectedCostSetting = useMemo(
    () => data.costSettings.find((item) => item.id === selectedCostSettingId) ?? null,
    [data.costSettings, selectedCostSettingId],
  );

  useEffect(() => {
    if (!selectedCostSetting) {
      setDraft((current) => ({
        ...emptyDraft(),
        salesUnitId: current.salesUnitId || data.salesUnits[0]?.id || "",
      }));
      return;
    }

    setDraft({
      salesUnitId: selectedCostSetting.canonicalSalesUnitId,
      unitCost: String(selectedCostSetting.unitCost),
      feeRate: selectedCostSetting.feeRate == null ? "" : String(selectedCostSetting.feeRate),
      otherCost: String(selectedCostSetting.otherCost),
      effectiveFrom: selectedCostSetting.effectiveFrom,
    });
  }, [data.salesUnits, selectedCostSetting]);

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="비용 설정은 스토어가 있어야 시작할 수 있습니다."
        description="대표 스토어가 정해져야 판매단위별 비용 이력 row를 안전하게 관리할 수 있습니다."
        actionHref="/settings/stores"
        actionLabel="스토어 설정"
      />
    );
  }

  const isBusy = isSubmitting || isDeactivating || isRefreshing;
  const isEditing = Boolean(selectedCostSetting);

  const refreshWithMessage = (message: string) => {
    setSuccessMessage(message);
    startRefresh(() => {
      router.refresh();
    });
  };

  const parseNumberValue = (value: string, label: string) => {
    const normalized = Number(value);
    if (Number.isNaN(normalized)) {
      throw new Error(`${label} 값을 숫자로 입력해 주세요.`);
    }
    return normalized;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Costs"
        title="원가와 fallback 수수료율 관리"
        description="비용 row를 생성하고, 적용 전 row는 수정/비활성화할 수 있습니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href="/sales-units">
              판매단위 보기
            </Link>
            <button
              className="button-shell button-primary"
              type="button"
              disabled={isBusy}
              onClick={() => {
                setSelectedCostSettingId(null);
                setErrorMessage(null);
                setSuccessMessage(null);
                setDraft({
                  ...emptyDraft(),
                  salesUnitId: data.salesUnits[0]?.id ?? "",
                });
              }}
            >
              신규 비용 row
            </button>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Panel
          title={isEditing ? "선택한 비용 row 관리" : "비용 입력"}
          description="feeRate는 0.035 = 3.5% 형식입니다. 수정은 아직 적용되지 않은 row에서만 가능합니다. 종료일 설정은 지원하지 않습니다."
        >
          <form
            className="space-y-4"
            onSubmit={async (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setErrorMessage(null);
              setSuccessMessage(null);

              if (!draft.salesUnitId) {
                setErrorMessage("비용을 적용할 판매단위를 먼저 선택해 주세요.");
                return;
              }
              if (!draft.unitCost.trim() || !draft.otherCost.trim() || !draft.effectiveFrom.trim()) {
                setErrorMessage("원가, 기타비용, 시작일은 모두 필수입니다.");
                return;
              }

              try {
                const unitCost = parseNumberValue(draft.unitCost, "원가");
                const otherCost = parseNumberValue(draft.otherCost, "기타비용");
                const feeRate = draft.feeRate.trim()
                  ? parseNumberValue(draft.feeRate, "수수료율")
                  : null;

                setIsSubmitting(true);
                await readApiResponse(
                  await fetch(
                    isEditing
                      ? `/api/sales-unit-cost-settings/${selectedCostSetting!.id}`
                      : "/api/sales-unit-cost-settings",
                    {
                      method: isEditing ? "PATCH" : "POST",
                      headers: {
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify(
                        isEditing
                          ? {
                              unitCost,
                              feeRate,
                              otherCost,
                              effectiveFrom: draft.effectiveFrom,
                            }
                          : {
                              storeId: data.primaryStore!.id,
                              canonicalSalesUnitId: draft.salesUnitId,
                              unitCost,
                              feeRate,
                              otherCost,
                              effectiveFrom: draft.effectiveFrom,
                            },
                      ),
                    },
                  ),
                  isEditing ? "비용 row 수정에 실패했습니다." : "비용 row 생성에 실패했습니다.",
                );

                if (!isEditing) {
                  setDraft({
                    ...emptyDraft(),
                    salesUnitId: draft.salesUnitId,
                  });
                }
                refreshWithMessage(
                  isEditing ? "비용 row를 수정했습니다." : "비용 row를 추가했습니다.",
                );
              } catch (error) {
                setErrorMessage(
                  error instanceof Error ? error.message : "비용 저장 중 오류가 발생했습니다.",
                );
              } finally {
                setIsSubmitting(false);
              }
            }}
          >
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">판매단위</span>
              <select
                className="input-shell"
                disabled={isEditing}
                value={draft.salesUnitId}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, salesUnitId: event.target.value }))
                }
              >
                {data.salesUnits
                  .filter((item) => !item.isGroup && !item.isStoreLevel)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">원가 unitCost</span>
              <input
                className="input-shell"
                type="number"
                min="0"
                step="1"
                value={draft.unitCost}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, unitCost: event.target.value }))
                }
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">수수료율 feeRate fallback</span>
              <input
                className="input-shell"
                type="number"
                min="0"
                max="1"
                step="0.0001"
                value={draft.feeRate}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, feeRate: event.target.value }))
                }
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">기타비용 otherCost</span>
              <input
                className="input-shell"
                type="number"
                min="0"
                step="1"
                value={draft.otherCost}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, otherCost: event.target.value }))
                }
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">시작일 effectiveFrom</span>
              <input
                className="input-shell"
                type="date"
                value={draft.effectiveFrom}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, effectiveFrom: event.target.value }))
                }
              />
            </label>

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

            <div className="rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
              현재 row의 action flag를 확인해 수정 가능 여부를 판단합니다. 미적용 row만 수정/비활성화할 수 있습니다.
            </div>

            <div className="flex flex-wrap gap-3">
              <button className="button-shell button-primary" type="submit" disabled={isBusy}>
                {isEditing ? "수정 저장" : "비용 row 추가"}
              </button>
              <button
                className="button-shell button-ghost"
                type="button"
                disabled={isBusy || !selectedCostSetting || !selectedCostSetting.canDeactivate}
                onClick={async () => {
                  if (!selectedCostSetting) {
                    return;
                  }
                  setErrorMessage(null);
                  setSuccessMessage(null);
                  setIsDeactivating(true);
                  try {
                    await readApiResponse(
                      await fetch(
                        `/api/sales-unit-cost-settings/${selectedCostSetting.id}/deactivate`,
                        {
                          method: "POST",
                        },
                      ),
                      "비용 row 비활성화에 실패했습니다.",
                    );

                    refreshWithMessage("비용 row를 비활성화했습니다.");
                  } catch (error) {
                    setErrorMessage(
                      error instanceof Error
                        ? error.message
                        : "비용 row 비활성화 중 오류가 발생했습니다.",
                    );
                  } finally {
                    setIsDeactivating(false);
                  }
                }}
              >
                비활성화
              </button>
            </div>
          </form>
        </Panel>

        <Panel
          title="비용 이력"
          description="행을 선택하면 수정/종료/비활성화 액션이 가능한지 함께 확인할 수 있습니다."
        >
          <DataTable
            caption="비용 이력 목록"
            columns={[
              {
                key: "select",
                title: "선택",
                render: (row: CostSettingListItem) => (
                  <button
                    className="button-shell button-ghost"
                    type="button"
                    onClick={() => {
                      setSelectedCostSettingId(row.id);
                      setErrorMessage(null);
                      setSuccessMessage(null);
                    }}
                  >
                    {selectedCostSettingId === row.id ? "선택됨" : "선택"}
                  </button>
                ),
              },
              {
                key: "salesUnit",
                title: "판매단위",
                render: (row) => row.canonicalDisplayName,
              },
              {
                key: "period",
                title: "시작일",
                render: (row) => <p>{formatDate(row.effectiveFrom)}</p>,
              },
              {
                key: "costs",
                title: "비용",
                render: (row) => (
                  <div>
                    <p>원가 {formatCurrency(row.unitCost)}</p>
                    <p className="mt-1 text-xs text-ink/55">
                      fee {formatPercent(row.feeRate)} / 기타 {formatCurrency(row.otherCost)}
                    </p>
                  </div>
                ),
              },
              {
                key: "flags",
                title: "action flag",
                render: (row) => (
                  <div className="space-y-1 text-xs text-ink/65">
                    <p>applied {formatNumber(row.appliedOrderItemCount)}</p>
                    <p>edit {String(row.canEdit)} / deactivate {String(row.canDeactivate)}</p>
                    <p>{row.blockingReason ?? "-"}</p>
                  </div>
                ),
              },
              {
                key: "active",
                title: "상태",
                render: (row) => (
                  <StatusBadge tone={row.isActive ? "success" : "muted"}>
                    {row.isActive ? "ACTIVE" : "INACTIVE"}
                  </StatusBadge>
                ),
              },
            ]}
            rows={data.costSettings}
            getRowKey={(row) => row.id}
          />
        </Panel>
      </div>
    </div>
  );
}
