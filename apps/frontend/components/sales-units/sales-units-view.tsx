"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Plus, Search } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { SourceBanner } from "@/components/shared/source-banner";
import type { ProductRegistrationResult } from "@/lib/api/product-registrations";
import type { SalesUnitListItem, SalesUnitsPageData } from "@/lib/api/types";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import { buildHrefWithStore } from "@/lib/store-selection";
import { ProductEditView } from "./product-edit-view";
import { ProductRegistrationView } from "./product-registration-view";

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

export function SalesUnitsView({ data, today, openRegistration, signatureIds, orderContextError }: {
  data: SalesUnitsPageData;
  today: string;
  openRegistration: boolean;
  signatureIds: string[];
  orderContextError?: string;
}) {
  const router = useRouter();
  const [selectedSalesUnitId, setSelectedSalesUnitId] = useState<string | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(openRegistration);
  const [registrationVersion, setRegistrationVersion] = useState(0);
  const [savedProduct, setSavedProduct] = useState<{ id: string; date: string; signatureKey: string; recalculationPending?: boolean }>();
  const registrationToggle = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [isSavingProductEdit, setIsSavingProductEdit] = useState(false);
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
    () => data.salesUnits.find((item) => item.id === selectedSalesUnitId) ?? null,
    [data.salesUnits, selectedSalesUnitId],
  );

  const signatureKey = JSON.stringify(signatureIds);
  const activeSignatureKey = savedProduct?.signatureKey === signatureKey ? "[]" : signatureKey;
  const registrationSignatures = useMemo(() => JSON.parse(activeSignatureKey) as string[], [activeSignatureKey]);
  useEffect(() => {
    if (openRegistration) setRegistrationOpen(true);
  }, [openRegistration, signatureKey]);
  useEffect(() => {
    if (!openRegistration || !savedProduct || !data.salesUnits.some((unit) => unit.id === savedProduct.id)) return;
    const query = new URLSearchParams(window.location.search);
    if (!query.has("register") && !query.has("signatureId")) return;
    window.history.replaceState(null, "", buildHrefWithStore("/sales-units", null, data.primaryStore?.id));
  }, [data.primaryStore?.id, data.salesUnits, openRegistration, savedProduct]);

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
  const groupIds = new Set(data.salesUnits.filter((item) => item.isGroup).map((item) => item.id));
  const costsById = new Map(data.costCoverage?.items.map((item) => [item.id, item.unitCost]));
  const incompleteCostCount = data.costCoverage?.items.filter((item) => item.unitCost === null).length;
  const primaryStore = data.primaryStore;
  const canRegister = primaryStore.isActive && data.sources.every((source) => source.source === "live");
  const mappingsHref = buildHrefWithStore("/mappings", null, primaryStore.id);
  const isBusy = isSubmitting || isToggling || isRefreshing || isSavingProductEdit;
  const query = search.trim().toLocaleLowerCase("ko");
  const filtering = Boolean(query) || filter !== "all";
  const matchesSearch = (unit: SalesUnitListItem) =>
    [unit.displayName, ...unit.matchAliases].some((value) => value.toLocaleLowerCase("ko").includes(query));
  const matchesFilter = (unit: SalesUnitListItem) => (
    filter === "active" ? unit.isActive : filter === "inactive" ? !unit.isActive : filter === "missing" ? costsById.get(unit.id) === null : true
  );
  const childrenByGroup = new Map<string, SalesUnitListItem[]>();
  for (const unit of data.salesUnits) {
    if (!unit.parentSalesUnitId || !groupIds.has(unit.parentSalesUnitId)) continue;
    const children = childrenByGroup.get(unit.parentSalesUnitId) ?? [];
    children.push(unit);
    childrenByGroup.set(unit.parentSalesUnitId, children);
  }
  const roots = data.salesUnits
    .filter((unit) => !unit.parentSalesUnitId || !groupIds.has(unit.parentSalesUnitId))
    .sort((a, b) => Number(b.isStoreLevel) - Number(a.isStoreLevel) || Number(b.isGroup) - Number(a.isGroup));
  const rows = roots.flatMap((unit) => {
    const matchesName = matchesSearch(unit);
    const children = (childrenByGroup.get(unit.id) ?? []).filter((child) => (matchesName || matchesSearch(child)) && matchesFilter(child));
    if ((!matchesName || !matchesFilter(unit)) && children.length === 0) return [];
    const expansionKey = (filtering ? "filtered:" : "") + unit.id;
    const isExpanded = expandedGroups[expansionKey] ?? filtering;
    return [
      { unit, isChild: false, expansionKey, isExpanded, childCount: children.length },
      ...(isExpanded ? children.map((child) => ({ unit: child, isChild: true, expansionKey, isExpanded: false, childCount: 0 })) : []),
    ];
  });

  function productHref(id: string, date?: string, pending?: boolean) {
    const params = new URLSearchParams({ salesUnitId: id });
    if (date) params.set("date", date);
    if (pending) params.set("recalculation", "pending");
    return buildHrefWithStore("/sales-units/product", params, data.primaryStore?.id);
  }

  function handleRegistered(result: Pick<ProductRegistrationResult, "salesUnitId" | "recalculationPending">, date: string) {
    setRegistrationOpen(false);
    setRegistrationVersion((version) => version + 1);
    setSearch("");
    setFilter("all");
    setSavedProduct({ id: result.salesUnitId, date, signatureKey, recalculationPending: result.recalculationPending });
    router.refresh();
    registrationToggle.current?.focus();
  }

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

  const editor = selectedSalesUnit && !selectedSalesUnit.isStoreLevel && (
    <div className="space-y-2.5">
      <ProductEditView
        key={selectedSalesUnit.id}
        store={primaryStore}
        salesUnitId={selectedSalesUnit.id}
        today={today}
        disabled={!canRegister || isBusy}
        onSavingChange={setIsSavingProductEdit}
        onSaved={(pending) => {
          setSelectedSalesUnitId(null);
          void refreshWithMessage(pending ? "판매단위를 수정했습니다. 손익 갱신 상태는 상품 화면에서 확인해 주세요." : "판매단위를 수정했습니다.");
        }}
      />
        {errorMessage ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMessage}
          </div>
        ) : null}

        {selectedSalesUnit?.isGroup && (
          <details className="rounded-md border border-ink/10 px-2.5 py-1.5">
            <summary className="cursor-pointer text-xs font-semibold">하위 구성 관리</summary>
            <div className="pt-2">
              <div className="space-y-2">
                {data.salesUnits
                  .filter((u) => u.parentSalesUnitId === selectedSalesUnit.id)
                  .map((child) => (
                    <div key={child.id} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2">
                      <span className="text-sm text-ink">{child.displayName}</span>
                      <button
                        className="button-shell button-ghost text-xs"
                        type="button"
                        disabled={!canRegister || isBusy}
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
                disabled={!canRegister || isBusy}
                onClick={() => {
                  setManageChildrenModal({
                    isOpen: true,
                    selectedChildIdToAdd: null,
                    errorMessage: null,
                    isSubmitting: false,
                  });
                }}
              >
                구성 추가
              </button>
            </div>
          </details>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            className="button-shell button-ghost"
            type="button"
            disabled={!canRegister || isBusy}
            onClick={() => void handleToggle(selectedSalesUnit.isActive ? "deactivate" : "activate")}
          >
            {selectedSalesUnit.isActive ? "비활성화" : "활성화"}
          </button>
          {selectedSalesUnit?.isGroup && (
            <button
              className="button-shell button-ghost text-red-600"
              type="button"
              disabled={!canRegister || isBusy}
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
    </div>
  );


  return (
    <div className="sales-units-workspace space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h1 className="text-2xl font-semibold tracking-tight">판매단위</h1>
          <p className="text-sm text-ink/65">{primaryStore.name}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="button-shell button-ghost" href={mappingsHref}>주문·광고 매핑</Link>
          <button
            className="button-shell button-secondary"
            type="button"
            disabled={!canRegister || isBusy}
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
            기존 상품 그룹 만들기
          </button>
        </div>
      </header>

      <SourceBanner sources={data.sources} />

      {canRegister && (
        <section className="rounded-lg border border-ink/15 bg-white/85" aria-labelledby="product-registration-title">
          <h2 id="product-registration-title">
            <button
              ref={registrationToggle}
              type="button"
              aria-expanded={registrationOpen}
              aria-controls="product-registration"
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold hover:bg-sand/35 sm:px-4"
              onClick={() => {
                setRegistrationOpen(!registrationOpen);
                if (!registrationOpen && !orderContextError) requestAnimationFrame(() => document.getElementById("new-product-name")?.focus());
              }}
            >
              <Plus size={16} className="text-coral" aria-hidden="true" />
              신상품 등록
              <ChevronDown size={16} className={registrationOpen ? "ml-auto rotate-180" : "ml-auto"} aria-hidden="true" />
            </button>
          </h2>
          <div id="product-registration" hidden={!registrationOpen}>
            {orderContextError ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-ink/10 px-3 py-2 text-sm">
                <p role="alert" className="text-red-700">{orderContextError}</p>
                <Link href={mappingsHref} className="button-shell button-secondary">주문 매핑으로 돌아가기</Link>
              </div>
            ) : (
              <ProductRegistrationView
                key={activeSignatureKey + ":" + registrationVersion}
                store={primaryStore}
                today={today}
                signatureIds={registrationSignatures}
                onSaved={handleRegistered}
              />
            )}
          </div>
        </section>
      )}
      {savedProduct && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-900">
          <span>상품을 등록했습니다.</span>
          <Link className="font-semibold underline underline-offset-2" href={productHref(savedProduct.id, savedProduct.date, savedProduct.recalculationPending)}>등록한 상품 상태 확인</Link>
        </div>
      )}
      {successMessage && <p role="status" className="rounded-md bg-emerald-50 px-3 py-1.5 text-sm text-emerald-900">{successMessage}</p>}

      <section className="rounded-lg border border-ink/15 bg-white/85" aria-labelledby="sales-unit-list-title">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-4">
          <div>
            <h2 id="sales-unit-list-title" className="text-base font-semibold">등록된 판매단위</h2>
            <p className="text-xs text-ink/65">
              전체 {formatNumber(data.salesUnits.length)}개 · 활성 {formatNumber(activeCount)}개
              {data.costCoverage && <> · 원가 미설정 {formatNumber(incompleteCostCount)}개</>}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <label className="flex min-w-40 flex-1 items-center gap-1.5 sm:w-52">
              <Search aria-hidden="true" size={16} className="shrink-0 text-ink/65" />
              <span className="sr-only">판매단위 검색</span>
              <input className="input-shell" type="search" placeholder="상품명 또는 연결 키워드" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <select className="input-shell max-w-32" aria-label="상태로 판매단위 필터링" value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">전체 상태</option>
              <option value="active">활성</option>
              <option value="inactive">비활성</option>
              {data.costCoverage && <option value="missing">원가 미설정</option>}
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-sm">
            <caption className="sr-only">판매단위, 자동 연결 키워드, 상태와 적용 원가</caption>
            <colgroup>
              <col />
              <col className="hidden w-[27%] lg:table-column" />
              <col className="w-[3rem] sm:w-16" />
              <col className="w-[5rem] sm:w-28" />
              <col className="w-[6.25rem] sm:w-32" />
            </colgroup>
            <thead className="border-y border-ink/10 bg-sand/45 text-xs text-ink/70">
              <tr>
                <th scope="col" className="px-2.5 py-2 text-left sm:px-4">상품 · 판매 구성</th>
                <th scope="col" className="hidden px-2 py-2 text-left lg:table-cell">자동 연결 키워드</th>
                <th scope="col" className="py-2 text-center">상태</th>
                <th scope="col" className="px-2 py-2 text-right">
                  <span title={data.costCoverage ? formatDate(data.costCoverage.date) + " 기준" : "원가 조회 불가"}>적용 원가</span>
                </th>
                <th scope="col" className="px-2 py-2 text-right sm:pr-4">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/10">
              {rows.length === 0 && (
                <tr><td className="px-4 py-6 text-center text-sm text-ink/65" colSpan={5}>{filtering ? "검색 조건에 맞는 판매단위가 없습니다." : "등록된 판매단위가 없습니다."}</td></tr>
              )}
              {rows.map(({ unit, isChild, expansionKey, isExpanded, childCount }) => {
                const isEditing = selectedSalesUnitId === unit.id && !unit.isStoreLevel;
                const cost = costsById.get(unit.id);
                const productId = unit.parentSalesUnitId && groupIds.has(unit.parentSalesUnitId) ? unit.parentSalesUnitId : unit.id;
                const editorId = "edit-unit-" + unit.id;
                return (
                  <Fragment key={unit.id}>
                    <tr className={isEditing ? "bg-sand/55" : isChild ? "bg-sand/20 hover:bg-sand/45" : "hover:bg-sand/30"}>
                      <th scope="row" className="px-2.5 py-1.5 text-left font-medium sm:px-4">
                        <div className={"flex min-w-0 items-center gap-1.5" + (isChild ? " pl-5" : "")}>
                          {unit.isGroup && childCount > 0 && (
                            <button type="button" className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-ink/10" aria-expanded={isExpanded} aria-label={unit.displayName + " 판매 구성"} onClick={() => setExpandedGroups((current) => ({ ...current, [expansionKey]: !isExpanded }))}>
                              {isExpanded ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
                            </button>
                          )}
                          <span className="min-w-0 break-words leading-4 sm:truncate" title={unit.displayName}>{unit.displayName}</span>
                          {unit.isGroup && <span className="hidden shrink-0 text-xs font-normal text-ink/65 sm:inline">그룹{childCount > 0 ? " · " + childCount : ""}</span>}
                          {unit.isStoreLevel && <span className="hidden shrink-0 text-xs font-normal text-ink/65 sm:inline">공통</span>}
                        </div>
                      </th>
                      <td className="hidden truncate px-2 py-1.5 text-xs text-ink/70 lg:table-cell" title={unit.matchAliases.join(", ")}>{unit.matchAliases.join(", ") || "—"}</td>
                      <td className="py-1.5 text-center text-xs">
                        <span className={unit.isActive ? "font-medium text-emerald-800" : "text-ink/65"}>{unit.isActive ? "활성" : "비활성"}</span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right text-xs tabular-nums sm:text-sm">
                        {cost === null ? <span className="text-amber-800">미설정</span> : cost === undefined ? <span className="text-ink/55">—</span> : formatCurrency(cost)}
                      </td>
                      <td className="py-0.5 pr-2 text-right sm:pr-4">
                        {!unit.isStoreLevel && (
                          <div className="flex items-center justify-end gap-0.5 whitespace-nowrap text-xs">
                            <Link prefetch={false} className="rounded px-1.5 py-1.5 text-ink/70 hover:bg-ink/10 hover:text-ink" href={productHref(productId)} aria-label={unit.displayName + " 상품 상태"}>상태</Link>
                            <button
                              type="button"
                              className="rounded px-1.5 py-1.5 font-semibold hover:bg-ink/10"
                              aria-expanded={isEditing}
                              aria-controls={isEditing ? editorId : undefined}
                              aria-label={unit.displayName + (isEditing ? " 편집 닫기" : " 편집")}
                              disabled={isBusy}
                              onClick={() => {
                                setSelectedSalesUnitId(isEditing ? null : unit.id);
                                setErrorMessage(null);
                                setSuccessMessage(null);
                              }}
                            >{isEditing ? "닫기" : "편집"}</button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {isEditing && (
                      <tr id={editorId} className="bg-sand/30">
                        <td colSpan={5} className="px-3 py-2.5 sm:px-4">{editor}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

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
