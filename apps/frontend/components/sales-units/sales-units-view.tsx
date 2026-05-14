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
import { buildHrefWithStore } from "@/lib/store-selection";

interface ExpandedGroupState {
  [groupId: string]: boolean;
}

interface CreateGroupModalState {
  isOpen: boolean;
  selectedChildIds: Set<string>;
  displayName: string;
  errorMessage: string | null;
  isSubmitting: boolean;
}

interface ManageChildrenModalState {
  isOpen: boolean;
  selectedChildIdToAdd: string | null;
  errorMessage: string | null;
  isSubmitting: boolean;
}

function emptyDraft() {
  return {
    displayName: "",
    matchAliasesText: "",
    memo: "",
  };
}

function aliasesToText(matchAliases: string[]) {
  return matchAliases.join("\n");
}

function parseAliases(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function SalesUnitsView({ data }: { data: SalesUnitsPageData }) {
  const router = useRouter();
  const [selectedSalesUnitId, setSelectedSalesUnitId] = useState<string | null>(data.salesUnits[0]?.id ?? null);
  const [isCreatingDraft, setIsCreatingDraft] = useState(data.salesUnits.length === 0);
  const [pendingCreatedSalesUnitId, setPendingCreatedSalesUnitId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();
  const [expandedGroups, setExpandedGroups] = useState<ExpandedGroupState>({});
  const [createGroupModal, setCreateGroupModal] = useState<CreateGroupModalState>({
    isOpen: false,
    selectedChildIds: new Set(),
    displayName: "",
    errorMessage: null,
    isSubmitting: false,
  });
  const [manageChildrenModal, setManageChildrenModal] = useState<ManageChildrenModalState>({
    isOpen: false,
    selectedChildIdToAdd: null,
    errorMessage: null,
    isSubmitting: false,
  });

  const selectedSalesUnit = useMemo(
    () => (isCreatingDraft ? null : data.salesUnits.find((item) => item.id === selectedSalesUnitId) ?? null),
    [data.salesUnits, isCreatingDraft, selectedSalesUnitId],
  );

  useEffect(() => {
    if (selectedSalesUnit) {
      setDraft({
        displayName: selectedSalesUnit.displayName,
        matchAliasesText: aliasesToText(selectedSalesUnit.matchAliases),
        memo: selectedSalesUnit.memo ?? "",
      });
      return;
    }

    setDraft(emptyDraft());
  }, [selectedSalesUnit]);

  useEffect(() => {
    if (pendingCreatedSalesUnitId && data.salesUnits.some((item) => item.id === pendingCreatedSalesUnitId)) {
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
        title="판매단위를 정의하려면 먼저 스토어가 필요합니다."
        description="스토어가 생성되면 주문 원본과 광고 캠페인을 안정적으로 연결할 판매단위를 관리할 수 있습니다."
        actionHref="/settings/stores"
        actionLabel="스토어 설정"
      />
    );
  }

  const activeCount = data.salesUnits.filter((item) => item.isActive).length;
  const incompleteCostCount = data.salesUnits.filter(
    (item) => !data.costSettings.some((cost) => cost.canonicalSalesUnitId === item.id && cost.isActive),
  ).length;
  const primaryStore = data.primaryStore;
  const mappingsHref = buildHrefWithStore("/mappings", null, primaryStore.id);
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
      const response = await fetch(`/api/canonical-sales-units/${selectedSalesUnit.id}/${nextAction}`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "상태 변경에 실패했습니다.");
      }

      await refreshWithMessage(nextAction === "activate" ? "판매단위를 다시 활성화했습니다." : "판매단위를 비활성화했습니다.");
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
        title="판매단위 정의"
        description="표시명은 UI에만 쓰이고 자동 매핑은 matchAliases 기준으로만 동작합니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href={mappingsHref}>
              매핑 화면으로 이동
            </Link>
            <button
              className="button-shell button-secondary"
              type="button"
              disabled={isBusy}
              onClick={() => {
                setCreateGroupModal({
                  isOpen: true,
                  selectedChildIds: new Set(),
                  displayName: "",
                  errorMessage: null,
                  isSubmitting: false,
                });
              }}
            >
              판매단위 그룹 만들기
            </button>
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
              새 판매단위 추가
            </button>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="전체 판매단위" value={formatNumber(data.salesUnits.length)} hint={`활성 ${formatNumber(activeCount)}개`} />
        <StatCard label="비용 미설정" value={formatNumber(incompleteCostCount)} hint="INCOMPLETE 후보" tone="warning" />
        <StatCard
          label="활성 비용 row"
          value={formatNumber(data.costSettings.filter((item) => item.isActive).length)}
          hint="비용 화면과 연동"
          tone="success"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Panel
          title="판매단위 목록"
          description="같은 스토어 안에서는 표시명과 normalize된 alias가 중복되지 않도록 관리합니다."
        >
          <div className="space-y-2">
            {[...data.salesUnits]
              .sort((a, b) => {
                // 스토어 전체 최상단
                if (a.isStoreLevel === b.isStoreLevel) {
                  // 그룹은 자식보다 먼저
                  if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
                  return 0;
                }
                return a.isStoreLevel ? -1 : 1;
              })
              .flatMap((unit) => {
                const result: (SalesUnitListItem & { _level: number; _parentId?: string })[] = [
                  { ...unit, _level: 0 },
                ];
                // 그룹인 경우 자식을 추가
                if (unit.isGroup && expandedGroups[unit.id]) {
                  const children = data.salesUnits.filter((u) => u.parentSalesUnitId === unit.id);
                  result.push(...children.map((child) => ({ ...child, _level: 1, _parentId: unit.id })));
                }
                return result;
              })
              .map((row, idx) => (
                <div
                  key={idx}
                  className={`rounded-lg border p-4 ${
                    row._level === 1
                      ? "ml-6 border-slate-200 bg-slate-50"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        {row.isGroup && (
                          <button
                            className="button-shell button-ghost p-1"
                            type="button"
                            onClick={() =>
                              setExpandedGroups((current) => ({
                                ...current,
                                [row.id]: !current[row.id],
                              }))
                            }
                          >
                            {expandedGroups[row.id] ? "▼" : "▸"}
                          </button>
                        )}
                        {!row.isGroup && row._level === 0 && <div className="w-6" />}
                        <p className="font-semibold text-ink">{row.displayName}</p>
                        {row.isStoreLevel && (
                          <span className="inline-block rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">
                            스토어 전체
                          </span>
                        )}
                        {row.isGroup && (
                          <span className="inline-block rounded-full bg-purple-100 px-2 py-1 text-xs font-semibold text-purple-700">
                            그룹
                          </span>
                        )}
                        {row._level === 1 && (
                          <span className="inline-block rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-700">
                            그룹 자식
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-ink/55">
                        {row.matchAliases.length > 0 ? row.matchAliases.join(", ") : "alias 없음"}
                      </p>
                      {row.memo && <p className="mt-1 text-xs text-ink/65">{row.memo}</p>}
                    </div>
                    <div className="flex flex-col items-end gap-2 text-right text-xs text-ink/55">
                      <StatusBadge tone={toneForActive(row.isActive)}>
                        {row.isActive ? "ACTIVE" : "INACTIVE"}
                      </StatusBadge>
                      {data.costSettings.find(
                        (cost) => cost.canonicalSalesUnitId === row.id && cost.isActive,
                      ) && (
                        <span className="text-emerald-600">
                          {formatNumber(
                            data.costSettings.find(
                              (cost) => cost.canonicalSalesUnitId === row.id && cost.isActive,
                            )?.unitCost ?? 0,
                          )}
                          원
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className="button-shell button-ghost text-xs"
                      type="button"
                      onClick={() => {
                        setIsCreatingDraft(false);
                        setPendingCreatedSalesUnitId(null);
                        setSelectedSalesUnitId(row.id);
                        setErrorMessage(null);
                        setSuccessMessage(null);
                      }}
                    >
                      {selectedSalesUnitId === row.id ? "선택됨" : "열기"}
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </Panel>

        <Panel
          title={isEditing ? "선택한 판매단위 수정" : "새 판매단위 만들기"}
          description={
            selectedSalesUnit?.isStoreLevel
              ? "스토어 전체 광고비 버킷 (편집 불가)"
              : selectedSalesUnit?.isGroup
                ? "그룹 판매단위: 자식의 매출을 합산하고 광고비를 귀속받습니다"
                : "matchAliases는 한 줄에 하나씩 입력하면 자동 매핑 기준으로 사용됩니다"
          }
        >
          {selectedSalesUnit?.isStoreLevel ? (
            <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-4 text-sm leading-6 text-blue-700">
              이 판매단위는 스토어 전체 광고비 버킷입니다. 카탈로그, 키워드타겟, 인피니티가드(단독) 등 스토어 전체를 대상으로 하는 광고가 자동으로 매핑됩니다. 편집할 수 없습니다.
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={async (event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                setErrorMessage(null);
                setSuccessMessage(null);

                if (!draft.displayName.trim()) {
                  setErrorMessage("표시 이름은 필수입니다.");
                  return;
                }

                setIsSubmitting(true);
                try {
                  const response = await fetch(
                    isEditing ? `/api/canonical-sales-units/${selectedSalesUnit!.id}` : "/api/canonical-sales-units",
                    {
                      method: isEditing ? "PATCH" : "POST",
                      headers: {
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        ...(isEditing ? {} : { storeId: primaryStore.id }),
                        displayName: draft.displayName.trim(),
                        matchAliases: parseAliases(draft.matchAliasesText),
                        memo: draft.memo.trim() || null,
                      }),
                    },
                  );

                  const payload = (await response.json().catch(() => null)) as {
                    message?: string;
                    data?: { id?: string };
                  } | null;
                  if (!response.ok) {
                    throw new Error(payload?.message ?? "판매단위 저장에 실패했습니다.");
                  }

                  if (!isEditing && typeof payload?.data?.id === "string") {
                    setPendingCreatedSalesUnitId(payload.data.id);
                  }

                  await refreshWithMessage(isEditing ? "판매단위를 수정했습니다." : "판매단위를 생성했습니다.");
                } catch (error) {
                  setErrorMessage(error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.");
                } finally {
                  setIsSubmitting(false);
                }
              }}
            >
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">표시 이름</span>
                <input
                  className="input-shell"
                  placeholder="예: 코벨 다이어트 양말"
                  value={draft.displayName}
                  onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">matchAliases</span>
                <textarea
                  className="input-shell min-h-28"
                  placeholder={"한 줄에 하나씩 alias를 입력하세요.\n코벨 다이어트 양말\n다이어트 양말\n코벨 다이어트"}
                  value={draft.matchAliasesText}
                  onChange={(event) => setDraft((current) => ({ ...current, matchAliasesText: event.target.value }))}
                  disabled={selectedSalesUnit?.isStoreLevel}
                />
              </label>

              {selectedSalesUnit?.isGroup && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  그룹 판매단위는 주문을 직접 매핑할 수 없으며, 매출/원가는 자식 판매단위에서 집계됩니다.
                </div>
              )}

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
                비활성화된 판매단위는 과거 FK를 유지하지만 신규 자동 매핑과 비용 설정 대상에서는 제외됩니다.
              </div>

              {selectedSalesUnit?.isGroup && (
                <div className="space-y-4 rounded-2xl border border-purple-200 bg-purple-50 px-4 py-4">
                  <div>
                    <h4 className="mb-3 text-sm font-semibold text-purple-900">자식 관리</h4>
                    <div className="space-y-2">
                      {data.salesUnits
                        .filter((u) => u.parentSalesUnitId === selectedSalesUnit.id)
                        .map((child) => (
                          <div key={child.id} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2">
                            <span className="text-sm text-ink">{child.displayName}</span>
                            <button
                              className="button-shell button-ghost text-xs"
                              type="button"
                              disabled={isBusy}
                              onClick={async () => {
                                setIsSubmitting(true);
                                try {
                                  const response = await fetch(
                                    `/api/canonical-sales-units/group/${child.id}/detach-child`,
                                    {
                                      method: "POST",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ storeId: primaryStore.id }),
                                    },
                                  );
                                  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
                                  if (!response.ok) {
                                    throw new Error(payload?.message ?? "자식 제거에 실패했습니다.");
                                  }
                                  await refreshWithMessage("자식을 제거했습니다.");
                                } catch (error) {
                                  setErrorMessage(error instanceof Error ? error.message : "자식 제거 중 오류가 발생했습니다.");
                                } finally {
                                  setIsSubmitting(false);
                                }
                              }}
                            >
                              제거
                            </button>
                          </div>
                        ))}
                    </div>
                    <button
                      className="button-shell button-ghost mt-3 text-xs"
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        setManageChildrenModal({
                          isOpen: true,
                          selectedChildIdToAdd: null,
                          errorMessage: null,
                          isSubmitting: false,
                        });
                      }}
                    >
                      자식 추가
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <button className="button-shell button-primary" type="submit" disabled={isBusy || selectedSalesUnit?.isStoreLevel}>
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
                  활성화
                </button>
                {selectedSalesUnit?.isGroup && (
                  <button
                    className="button-shell button-ghost text-red-600"
                    type="button"
                    disabled={isBusy}
                    onClick={async () => {
                      setIsSubmitting(true);
                      try {
                        const response = await fetch(
                          `/api/canonical-sales-units/group/${selectedSalesUnit.id}/dissolve`,
                          {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ storeId: primaryStore.id }),
                          },
                        );
                        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
                        if (!response.ok) {
                          throw new Error(payload?.message ?? "그룹 해체에 실패했습니다.");
                        }
                        await refreshWithMessage("그룹을 해체했습니다.");
                      } catch (error) {
                        setErrorMessage(error instanceof Error ? error.message : "그룹 해체 중 오류가 발생했습니다.");
                      } finally {
                        setIsSubmitting(false);
                      }
                    }}
                  >
                    그룹 해체
                  </button>
                )}
              </div>
            </form>
          )}
        </Panel>
      </div>

      {createGroupModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
            <h3 className="mb-4 text-lg font-semibold text-ink">판매단위 그룹 만들기</h3>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">자식 판매단위 선택</span>
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-slate-300 bg-white p-3">
                  {data.salesUnits
                    .filter((u) => u.storeId === primaryStore.id && !u.isStoreLevel && !u.isGroup && !u.parentSalesUnitId)
                    .map((unit) => (
                      <label key={unit.id} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={createGroupModal.selectedChildIds.has(unit.id)}
                          onChange={(event) => {
                            setCreateGroupModal((current) => {
                              const newIds = new Set(current.selectedChildIds);
                              if (event.target.checked) {
                                newIds.add(unit.id);
                              } else {
                                newIds.delete(unit.id);
                              }
                              return { ...current, selectedChildIds: newIds };
                            });
                          }}
                        />
                        <span className="text-sm text-ink">{unit.displayName}</span>
                      </label>
                    ))}
                </div>
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">그룹 표시 이름</span>
                <input
                  className="input-shell"
                  placeholder="예: 할인 상품군"
                  value={createGroupModal.displayName}
                  onChange={(event) => setCreateGroupModal((current) => ({ ...current, displayName: event.target.value }))}
                />
              </label>

              {createGroupModal.errorMessage && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {createGroupModal.errorMessage}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  className="button-shell button-primary flex-1"
                  type="button"
                  disabled={createGroupModal.isSubmitting || createGroupModal.selectedChildIds.size === 0 || !createGroupModal.displayName.trim()}
                  onClick={async () => {
                    setCreateGroupModal((current) => ({ ...current, isSubmitting: true, errorMessage: null }));
                    try {
                      const response = await fetch("/api/canonical-sales-units/group/create", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          storeId: primaryStore.id,
                          displayName: createGroupModal.displayName.trim(),
                          childSalesUnitIds: Array.from(createGroupModal.selectedChildIds),
                        }),
                      });
                      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
                      if (!response.ok) {
                        throw new Error(payload?.message ?? "그룹 생성에 실패했습니다.");
                      }
                      setCreateGroupModal({
                        isOpen: false,
                        selectedChildIds: new Set(),
                        displayName: "",
                        errorMessage: null,
                        isSubmitting: false,
                      });
                      await refreshWithMessage("그룹을 생성했습니다.");
                    } catch (error) {
                      setCreateGroupModal((current) => ({
                        ...current,
                        errorMessage: error instanceof Error ? error.message : "그룹 생성 중 오류가 발생했습니다.",
                        isSubmitting: false,
                      }));
                    }
                  }}
                >
                  생성
                </button>
                <button
                  className="button-shell button-ghost flex-1"
                  type="button"
                  disabled={createGroupModal.isSubmitting}
                  onClick={() => {
                    setCreateGroupModal({
                      isOpen: false,
                      selectedChildIds: new Set(),
                      displayName: "",
                      errorMessage: null,
                      isSubmitting: false,
                    });
                  }}
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {manageChildrenModal.isOpen && selectedSalesUnit?.isGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
            <h3 className="mb-4 text-lg font-semibold text-ink">자식 추가</h3>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">추가할 판매단위 선택</span>
                <select
                  className="input-shell"
                  value={manageChildrenModal.selectedChildIdToAdd || ""}
                  onChange={(event) => setManageChildrenModal((current) => ({ ...current, selectedChildIdToAdd: event.target.value || null }))}
                >
                  <option value="">선택하세요</option>
                  {data.salesUnits
                    .filter(
                      (u) =>
                        u.storeId === primaryStore.id &&
                        !u.isStoreLevel &&
                        !u.isGroup &&
                        !u.parentSalesUnitId &&
                        !data.salesUnits.some((child) => child.parentSalesUnitId === selectedSalesUnit.id && child.id === u.id),
                    )
                    .map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.displayName}
                      </option>
                    ))}
                </select>
              </label>

              {manageChildrenModal.errorMessage && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {manageChildrenModal.errorMessage}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  className="button-shell button-primary flex-1"
                  type="button"
                  disabled={manageChildrenModal.isSubmitting || !manageChildrenModal.selectedChildIdToAdd}
                  onClick={async () => {
                    setManageChildrenModal((current) => ({ ...current, isSubmitting: true, errorMessage: null }));
                    try {
                      const response = await fetch(`/api/canonical-sales-units/group/${selectedSalesUnit.id}/attach-child`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          storeId: primaryStore.id,
                          childId: manageChildrenModal.selectedChildIdToAdd,
                        }),
                      });
                      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
                      if (!response.ok) {
                        throw new Error(payload?.message ?? "자식 추가에 실패했습니다.");
                      }
                      setManageChildrenModal({
                        isOpen: false,
                        selectedChildIdToAdd: null,
                        errorMessage: null,
                        isSubmitting: false,
                      });
                      await refreshWithMessage("자식을 추가했습니다.");
                    } catch (error) {
                      setManageChildrenModal((current) => ({
                        ...current,
                        errorMessage: error instanceof Error ? error.message : "자식 추가 중 오류가 발생했습니다.",
                        isSubmitting: false,
                      }));
                    }
                  }}
                >
                  추가
                </button>
                <button
                  className="button-shell button-ghost flex-1"
                  type="button"
                  disabled={manageChildrenModal.isSubmitting}
                  onClick={() => {
                    setManageChildrenModal({
                      isOpen: false,
                      selectedChildIdToAdd: null,
                      errorMessage: null,
                      isSubmitting: false,
                    });
                  }}
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
