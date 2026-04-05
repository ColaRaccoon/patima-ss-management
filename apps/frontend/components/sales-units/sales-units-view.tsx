"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import type { SalesUnitListItem, SalesUnitsPageData } from "@/lib/api/types";
import { formatDate, formatNumber, formatPercent } from "@/lib/format";
import { toneForActive } from "@/lib/status-tone";

function emptyDraft() {
  return {
    standardProductName: "",
    standardOptionName: "",
    displayName: "",
    memo: "",
  };
}

export function SalesUnitsView({ data }: { data: SalesUnitsPageData }) {
  const router = useRouter();
  const [selectedSalesUnitId, setSelectedSalesUnitId] = useState<string | null>(
    data.salesUnits[0]?.id ?? null,
  );
  const [isCreatingDraft, setIsCreatingDraft] = useState(data.salesUnits.length === 0);
  const [pendingCreatedSalesUnitId, setPendingCreatedSalesUnitId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();

  const selectedSalesUnit = useMemo(
    () => (isCreatingDraft ? null : data.salesUnits.find((item) => item.id === selectedSalesUnitId) ?? null),
    [data.salesUnits, isCreatingDraft, selectedSalesUnitId],
  );

  useEffect(() => {
    if (selectedSalesUnit) {
      setDraft({
        standardProductName: selectedSalesUnit.standardProductName,
        standardOptionName: selectedSalesUnit.standardOptionName ?? "",
        displayName: selectedSalesUnit.displayName,
        memo: selectedSalesUnit.memo ?? "",
      });
      return;
    }

    setDraft(emptyDraft());
  }, [selectedSalesUnit]);

  useEffect(() => {
    if (
      pendingCreatedSalesUnitId &&
      data.salesUnits.some((item) => item.id === pendingCreatedSalesUnitId)
    ) {
      setSelectedSalesUnitId(pendingCreatedSalesUnitId);
      setPendingCreatedSalesUnitId(null);
      setIsCreatingDraft(false);
      return;
    }

    if (isCreatingDraft) {
      return;
    }

    if (selectedSalesUnitId && data.salesUnits.some((item) => item.id === selectedSalesUnitId)) {
      return;
    }

    setSelectedSalesUnitId(data.salesUnits[0]?.id ?? null);
  }, [data.salesUnits, isCreatingDraft, pendingCreatedSalesUnitId, selectedSalesUnitId]);

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="표준 판매단위를 정의하려면 스토어가 먼저 필요합니다."
        description="대표 스토어가 생성되면 주문 원본과 광고 캠페인을 안정적으로 묶을 수 있는 표준 판매단위를 정의할 수 있습니다."
        actionHref="/settings/stores"
        actionLabel="스토어 설정 먼저 하기"
      />
    );
  }

  const activeCount = data.salesUnits.filter((item) => item.isActive).length;
  const incompleteCostCount = data.salesUnits.filter(
    (item) => !data.costSettings.some((cost) => cost.canonicalSalesUnitId === item.id && cost.isActive),
  ).length;
  const primaryStore = data.primaryStore;
  const isBusy = isSubmitting || isToggling || isRefreshing;
  const isEditing = Boolean(selectedSalesUnit);

  async function refreshWithMessage(message: string) {
    setSuccessMessage(message);
    startRefresh(() => {
      router.refresh();
    });
  }

  async function handleToggle(nextAction: "activate" | "deactivate") {
    if (!selectedSalesUnit) {
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);
    setIsToggling(true);
    try {
      const response = await fetch(
        `/api/canonical-sales-units/${selectedSalesUnit.id}/${nextAction}`,
        {
          method: "POST",
        },
      );
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "상태 변경에 실패했습니다.");
      }

      await refreshWithMessage(
        nextAction === "activate"
          ? "표준 판매단위를 다시 활성화했습니다."
          : "표준 판매단위를 비활성화했습니다.",
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "상태 변경 중 오류가 발생했습니다.");
    } finally {
      setIsToggling(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Sales Units"
        title="표준 판매단위 정의"
        description="표준 상품명, 표준 옵션명, 표시명을 분리해 관리하고, 비활성화 전후에도 과거 FK 조회 결과가 유지되도록 설계했습니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href="/mappings">
              매핑 화면으로 이동
            </Link>
            <button
              className="button-shell button-primary"
              type="button"
              disabled={isBusy}
              onClick={() => {
                setIsCreatingDraft(true);
                setPendingCreatedSalesUnitId(null);
                setSelectedSalesUnitId(null);
                setErrorMessage(null);
                setSuccessMessage(null);
                setDraft(emptyDraft());
              }}
            >
              새 판매단위 초안 추가
            </button>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="전체 판매단위"
          value={formatNumber(data.salesUnits.length)}
          hint={`활성 ${formatNumber(activeCount)}건`}
        />
        <StatCard
          label="비용 미설정"
          value={formatNumber(incompleteCostCount)}
          hint="INCOMPLETE 후보"
          tone="warning"
        />
        <StatCard
          label="활성 비용 row"
          value={formatNumber(data.costSettings.filter((item) => item.isActive).length)}
          hint="비용 화면과 연동"
          tone="success"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Panel
          title="표준 판매단위 목록"
          description="같은 스토어 안에서는 정규화된 표시명과 표준 상품/옵션 조합이 중복될 수 없습니다."
        >
          <DataTable
            caption="표준 판매단위 목록"
            columns={[
              {
                key: "select",
                title: "편집",
                render: (row: SalesUnitListItem) => (
                  <button
                    className="button-shell button-ghost"
                    type="button"
                    onClick={() => {
                      setIsCreatingDraft(false);
                      setPendingCreatedSalesUnitId(null);
                      setSelectedSalesUnitId(row.id);
                      setErrorMessage(null);
                      setSuccessMessage(null);
                    }}
                  >
                    {selectedSalesUnitId === row.id ? "선택됨" : "편집"}
                  </button>
                ),
              },
              {
                key: "displayName",
                title: "표시명",
                render: (row) => (
                  <div>
                    <p className="font-semibold text-ink">{row.displayName}</p>
                    <p className="mt-1 text-xs text-ink/55">
                      {row.standardProductName} / {row.standardOptionName ?? "-"}
                    </p>
                  </div>
                ),
              },
              {
                key: "memo",
                title: "메모",
                render: (row) => row.memo ?? "-",
              },
              {
                key: "status",
                title: "상태",
                render: (row) => (
                  <StatusBadge tone={toneForActive(row.isActive)}>
                    {row.isActive ? "ACTIVE" : "INACTIVE"}
                  </StatusBadge>
                ),
              },
              {
                key: "costStatus",
                title: "현재 비용",
                render: (row) => {
                  const cost = data.costSettings.find(
                    (item) => item.canonicalSalesUnitId === row.id && item.isActive,
                  );
                  return cost
                    ? `${formatNumber(cost.unitCost)}원 / ${formatPercent(cost.feeRate)}`
                    : "미설정";
                },
              },
              {
                key: "deactivatedAt",
                title: "비활성화 시각",
                render: (row) => formatDate(row.deactivatedAt),
              },
            ]}
            rows={data.salesUnits}
            getRowKey={(row) => row.id}
          />
        </Panel>

        <Panel
          title={isEditing ? "선택된 판매단위 수정" : "새 판매단위 만들기"}
          description="백엔드 문서 기준 필드 구조와 활성 옵션 분리를 그대로 반영합니다."
        >
          <form
            className="space-y-4"
            onSubmit={async (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setErrorMessage(null);
              setSuccessMessage(null);

              if (!draft.standardProductName.trim()) {
                setErrorMessage("표준 상품명은 필수입니다.");
                return;
              }

              setIsSubmitting(true);
              try {
                const response = await fetch(
                  isEditing
                    ? `/api/canonical-sales-units/${selectedSalesUnit!.id}`
                    : "/api/canonical-sales-units",
                  {
                    method: isEditing ? "PATCH" : "POST",
                    headers: {
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      ...(isEditing ? {} : { storeId: primaryStore.id }),
                      standardProductName: draft.standardProductName.trim(),
                      standardOptionName: draft.standardOptionName.trim() || null,
                      displayName: draft.displayName.trim() || null,
                      memo: draft.memo.trim() || null,
                    }),
                  },
                );

                const payload = (await response.json().catch(() => null)) as {
                  message?: string;
                  data?: { id?: string };
                } | null;
                if (!response.ok) {
                  throw new Error(payload?.message ?? "표준 판매단위 저장에 실패했습니다.");
                }

                if (!isEditing && typeof payload?.data?.id === "string") {
                  setPendingCreatedSalesUnitId(payload.data.id);
                }

                await refreshWithMessage(
                  isEditing
                    ? "표준 판매단위를 수정했습니다."
                    : "표준 판매단위를 생성했습니다.",
                );
              } catch (error) {
                setErrorMessage(error instanceof Error ? error.message : "저장 중 오류가 발생했습니다.");
              } finally {
                setIsSubmitting(false);
              }
            }}
          >
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">표준 상품명</span>
              <input
                className="input-shell"
                placeholder="예: 스포츠 양말"
                value={draft.standardProductName}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, standardProductName: event.target.value }))
                }
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">표준 옵션명</span>
              <input
                className="input-shell"
                placeholder="예: 화이트 / 여성"
                value={draft.standardOptionName}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, standardOptionName: event.target.value }))
                }
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">표시명</span>
              <input
                className="input-shell"
                placeholder="예: 스포츠 양말 / 화이트 / 여성"
                value={draft.displayName}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, displayName: event.target.value }))
                }
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">메모</span>
              <textarea
                className="input-shell min-h-28"
                placeholder="설명 메모"
                value={draft.memo}
                onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))}
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
              비활성화된 판매단위는 과거 FK를 유지하지만, 신규 주문 매핑과 광고 규칙, 비용 row 생성 대상에서는 제외됩니다.
            </div>

            <div className="flex flex-wrap gap-3">
              <button className="button-shell button-primary" type="submit" disabled={isBusy}>
                {isEditing ? "수정 저장" : "신규 저장"}
              </button>
              <button
                className="button-shell button-secondary"
                type="button"
                disabled={isBusy || !selectedSalesUnit || !selectedSalesUnit.isActive}
                onClick={() => handleToggle("deactivate")}
              >
                비활성화
              </button>
              <button
                className="button-shell button-ghost"
                type="button"
                disabled={isBusy || !selectedSalesUnit || selectedSalesUnit.isActive}
                onClick={() => handleToggle("activate")}
              >
                재활성화
              </button>
            </div>
          </form>
        </Panel>
      </div>
    </div>
  );
}
