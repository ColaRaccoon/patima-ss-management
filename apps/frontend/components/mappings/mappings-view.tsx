"use client";

import type { FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatusBadge } from "@/components/shared/status-badge";
import type { AdMappingListState, MappingListState, MappingListStatus, MappingsPageData, PageMeta } from "@/lib/api/types";
import { buildNaverStoreProductUrl, formatCurrency, formatNumber } from "@/lib/format";
import { buildHrefWithStore, STORE_ID_QUERY_KEY } from "@/lib/store-selection";

type MappingStatus = "MAPPED" | "UNMAPPED" | "CONFLICT";
type MappingListKind = "order" | "ad";

const MAPPING_STATUS_OPTIONS: Array<{ value: MappingListStatus; label: string }> = [
  { value: "UNRESOLVED", label: "미매핑·충돌" },
  { value: "ALL", label: "전체" },
  { value: "MAPPED", label: "매핑 완료" },
  { value: "UNMAPPED", label: "미매핑" },
  { value: "CONFLICT", label: "충돌" },
];
const MAPPING_STATUS_LABELS = { MAPPED: "완료", UNMAPPED: "미매핑", CONFLICT: "충돌" };

const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

const MAPPING_QUERY_PARAM_NAMES = {
  order: {
    page: "orderPage",
    pageSize: "orderPageSize",
    mappingStatus: "orderStatus",
    q: "orderQ",
  },
  ad: {
    page: "adPage",
    pageSize: "adPageSize",
    mappingStatus: "adStatus",
    q: "adQ",
  },
} as const;

interface CampaignDraft {
  canonicalSalesUnitId: string;
  campaignPattern: string;
}

interface PointerSelectionState {
  active: boolean;
  nextChecked: boolean;
  pointerId: number | null;
}

interface SelectableRow {
  id: string;
}

interface SelectionColumn<T extends SelectableRow> {
  key: string;
  title: string;
  className?: string;
  render: (row: T) => ReactNode;
}

function emptyCampaignDraft(defaultSalesUnitId = ""): CampaignDraft {
  return { canonicalSalesUnitId: defaultSalesUnitId, campaignPattern: "" };
}

function MappingState({ status }: { status: MappingStatus }) {
  return (
    <span className={cn("font-semibold", {
      "text-emerald-800": status === "MAPPED",
      "text-red-800": status === "CONFLICT",
      "text-amber-900": status === "UNMAPPED",
    })}>{MAPPING_STATUS_LABELS[status]}</span>
  );
}

function applySelectionChange(currentIds: string[], targetIds: string[], nextChecked: boolean) {
  const nextIds = new Set(currentIds);
  targetIds.forEach((targetId) => {
    if (nextChecked) nextIds.add(targetId);
    else nextIds.delete(targetId);
  });
  return Array.from(nextIds);
}

function isCampaignMappableSalesUnit(salesUnit: MappingsPageData["salesUnits"][number]) {
  return salesUnit.isActive && (salesUnit.isStoreLevel || salesUnit.isGroup || !salesUnit.parentSalesUnitId);
}

function hasGroupShipping(rawOptionInfo: string | null): boolean {
  return rawOptionInfo?.includes("[함께배송") ?? false;
}

function SelectionCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-4 w-4 items-center justify-center rounded border text-xs transition peer-focus-visible:ring-2 peer-focus-visible:ring-ink",
        checked
          ? "border-sand-700 bg-sand-700 text-white"
          : "border-ink/18 bg-white/90 text-transparent",
      )}
    >
      ✓
    </span>
  );
}

function SelectionTable<T extends SelectableRow>(props: {
  caption: string;
  rows: T[];
  selectedIds: Set<string>;
  columns: SelectionColumn<T>[];
  emptyMessage: string;
  onStartDrag: (event: ReactPointerEvent<HTMLLabelElement>, id: string, selected: boolean) => void;
  onContinueDrag: (event: ReactPointerEvent<HTMLTableRowElement>, id: string) => void;
  onToggle: (id: string, selected: boolean) => void;
  rowLabel: (row: T) => string;
}) {
  return (
      <table className="w-full table-fixed border-collapse text-left">
        <caption className="sr-only">{props.caption}</caption>
        <thead className="sticky top-0 z-[1] bg-[#f7f1e6]">
          <tr className="border-b border-ink/10 text-xs text-ink/75">
            <th scope="col" className="w-8 px-2 py-1.5"><span className="sr-only">선택</span></th>
            {props.columns.map((column) => (
              <th key={column.key} scope="col" className={cn("px-1.5 py-1.5 font-semibold", column.className)}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr>
              <td className="px-3 py-4 text-center text-sm text-ink/65" colSpan={props.columns.length + 1}>
                {props.emptyMessage}
              </td>
            </tr>
          ) : (
            props.rows.map((row) => {
              const isSelected = props.selectedIds.has(row.id);
              return (
                <tr
                  key={row.id}
                  className={cn(
                    "border-b border-ink/10 text-xs text-ink hover:bg-sand/35",
                    isSelected && "bg-sand/65",
                  )}
                  onPointerEnter={(event) => props.onContinueDrag(event, row.id)}
                >
                  <td className="px-2 py-1 align-middle">
                    <label
                      className="flex cursor-pointer items-center"
                      onClick={(event) => event.preventDefault()}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        props.onStartDrag(event, row.id, isSelected);
                      }}
                    >
                      <input aria-label={props.rowLabel(row) + " 선택"} checked={isSelected} className="peer sr-only" readOnly type="checkbox" onKeyDown={(event) => {
                        if (event.key !== " ") return;
                        event.preventDefault();
                        props.onToggle(row.id, !isSelected);
                      }} />
                      <SelectionCheckbox checked={isSelected} />
                    </label>
                  </td>
                  {props.columns.map((column) => (
                    <td key={column.key} className={cn("px-1.5 py-1 align-middle leading-[14px]", column.className)}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
  );
}

function MappingListToolbar({
  title, value, onSearchChange, onSearch, query, page, onChange,
  busy, hiddenCount, hideEmpty, emptyLabel, onHideEmpty, rowCount, selectedCount, hiddenSelected, onSelectPage, onClearSelection,
}: {
  title: string;
  value: string;
  onSearchChange: (value: string) => void;
  onSearch: (event: FormEvent<HTMLFormElement>) => void;
  query: MappingListState;
  page: PageMeta;
  onChange: (patch: Partial<MappingListState>) => void;
  busy: boolean;
  hiddenCount?: number;
  hideEmpty: boolean;
  emptyLabel: string;
  onHideEmpty: (hide: boolean) => void;
  rowCount: number;
  selectedCount: number;
  hiddenSelected: number;
  onSelectPage: () => void;
  onClearSelection: () => void;
}) {
  return (
    <div className="space-y-1.5 border-b border-ink/10 px-2.5 pb-1.5 pt-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-xs tabular-nums text-ink/65">{formatNumber(page.totalCount)}건</span>
      </div>
      <form className="flex flex-wrap items-center gap-1.5" onSubmit={onSearch}>
        <input aria-label={title + " 검색"} className="input-shell min-w-24 flex-1" type="search" placeholder={title === "광고 비용" ? "캠페인·판매단위 검색" : "상품명·옵션 검색"} value={value} onChange={(event) => onSearchChange(event.target.value)} />
        <button type="submit" className="button-shell button-secondary" disabled={busy}>검색</button>
        {query.q && <button type="button" className="button-shell button-ghost" disabled={busy} onClick={() => {
          onSearchChange("");
          onChange({ q: "", page: 1 });
        }}>초기화</button>}
        <select aria-label={title + " 상태"} className="input-shell w-auto" value={query.mappingStatus} disabled={busy} onChange={(event) => onChange({ mappingStatus: event.target.value as MappingListStatus, page: 1 })}>
          {MAPPING_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select aria-label={title + " 페이지 크기"} className="input-shell w-auto" value={query.pageSize} disabled={busy} onChange={(event) => onChange({ pageSize: Number(event.target.value), page: 1 })}>
          {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}개</option>)}
        </select>
      </form>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/70">
        <button type="button" className="button-shell button-ghost" disabled={busy || !rowCount} onClick={onSelectPage}>페이지 선택</button>
        {selectedCount > 0 && <button type="button" className="button-shell button-ghost" disabled={busy} onClick={onClearSelection}>선택 해제</button>}
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={hideEmpty} disabled={busy} onChange={(event) => onHideEmpty(event.target.checked)} />
          {emptyLabel}{Boolean(hiddenCount) && " (" + formatNumber(hiddenCount) + ")"}
        </label>
        {hiddenSelected > 0 && <span className="text-amber-900">숨긴 선택 {hiddenSelected}건</span>}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" aria-label={title + " 이전 페이지"} className="button-shell button-ghost" disabled={busy || page.page <= 1} onClick={() => onChange({ page: page.page - 1 })}><ChevronLeft size={16} aria-hidden="true" /></button>
          <span className="whitespace-nowrap tabular-nums">{page.page} / {page.totalPages}</span>
          <button type="button" aria-label={title + " 다음 페이지"} className="button-shell button-ghost" disabled={busy || !page.hasNext} onClick={() => onChange({ page: page.page + 1 })}><ChevronRight size={16} aria-hidden="true" /></button>
        </div>
      </div>
    </div>
  );
}

export function MappingsView({ data }: { data: MappingsPageData }) {
  const router = useRouter();
  const campaignMappableSalesUnits = data.salesUnits.filter(isCampaignMappableSalesUnit);
  const defaultCampaignSalesUnitId = campaignMappableSalesUnits[0]?.id ?? "";
  const [selectedSignatureIds, setSelectedSignatureIds] = useState<string[]>([]);
  const [selectedMappingId, setSelectedMappingId] = useState<string | null>(data.campaignMappings[0]?.id ?? null);
  const [selectedAdCostIds, setSelectedAdCostIds] = useState<string[]>([]);
  const [signatureSalesUnitId, setSignatureSalesUnitId] = useState(
    data.salesUnits.find((u) => u.isActive && !u.isGroup && !u.isStoreLevel)?.id ?? "",
  );
  const [campaignDraft, setCampaignDraft] = useState(
    emptyCampaignDraft(data.campaignMappings[0]?.canonicalSalesUnitId ?? defaultCampaignSalesUnitId),
  );
  const [adCostSalesUnitId, setAdCostSalesUnitId] = useState(defaultCampaignSalesUnitId);
  const [hideZeroOrderSignatures, setHideZeroOrderSignatures] = useState(false);
  const [intentionalReason, setIntentionalReason] = useState("");
  const [orderSearchInput, setOrderSearchInput] = useState(data.signatureQuery.q);
  const [adSearchInput, setAdSearchInput] = useState(data.adCostQuery.q);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [orderSuccess, setOrderSuccess] = useState<string | null>(null);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [campaignSuccess, setCampaignSuccess] = useState<string | null>(null);
  const [adCostError, setAdCostError] = useState<string | null>(null);
  const [adCostSuccess, setAdCostSuccess] = useState<string | null>(null);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [isRecalculatingOrder, setIsRecalculatingOrder] = useState(false);
  const [isSavingCampaign, setIsSavingCampaign] = useState(false);
  const [isSavingAdCost, setIsSavingAdCost] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();
  const orderDragRef = useRef<PointerSelectionState>({ active: false, nextChecked: false, pointerId: null });
  const adDragRef = useRef<PointerSelectionState>({ active: false, nextChecked: false, pointerId: null });
  const orderScrollRef = useRef<HTMLDivElement>(null);
  const adScrollRef = useRef<HTMLDivElement>(null);
  const rulesRef = useRef<HTMLDetailsElement>(null);
  const ruleInputRef = useRef<HTMLInputElement>(null);
  const scrollPositions = useRef<Map<string, number>>(new Map());

  const selectedMapping = data.campaignMappings.find((mapping) => mapping.id === selectedMappingId) ?? null;
  const isBusy = isSavingOrder || isRecalculatingOrder || isSavingCampaign || isSavingAdCost || isRefreshing;
  const selectedSignatureSet = new Set(selectedSignatureIds);
  const selectedAdCostSet = new Set(selectedAdCostIds);
  const filteredSignatures = data.signatures.filter((item) => !hideZeroOrderSignatures || item.usageCount !== 0);
  const selectedSignatureRows = data.signatures.filter((item) => selectedSignatureSet.has(item.id));
  const selectedAdCostRows = data.adCosts.filter((item) => selectedAdCostSet.has(item.id));
  const visibleSelectedSignatureCount = filteredSignatures.filter((item) => selectedSignatureSet.has(item.id)).length;
  const hiddenSignaturesCount = data.signatures.length - filteredSignatures.length;

  useEffect(() => {
    const stopSelection = () => {
      orderDragRef.current = { active: false, nextChecked: false, pointerId: null };
      adDragRef.current = { active: false, nextChecked: false, pointerId: null };
    };
    window.addEventListener("pointerup", stopSelection);
    window.addEventListener("pointercancel", stopSelection);
    return () => {
      window.removeEventListener("pointerup", stopSelection);
      window.removeEventListener("pointercancel", stopSelection);
    };
  }, []);

  useEffect(() => {
    setOrderSearchInput(data.signatureQuery.q);
  }, [data.signatureQuery.q]);

  useEffect(() => {
    setAdSearchInput(data.adCostQuery.q);
  }, [data.adCostQuery.q]);

  useEffect(() => {
    setSelectedSignatureIds([]);
  }, [
    data.signatureQuery.mappingStatus,
    data.signatureQuery.page,
    data.signatureQuery.pageSize,
    data.signatureQuery.q,
  ]);

  useEffect(() => {
    setSelectedAdCostIds([]);
  }, [
    data.adCostQuery.mappingStatus,
    data.adCostQuery.page,
    data.adCostQuery.pageSize,
    data.adCostQuery.q,
    data.adCostQuery.excludeZeroCost,
  ]);

  useEffect(() => {
    const validIds = new Set(data.signatures.map((item) => item.id));
    setSelectedSignatureIds((current) => current.filter((id) => validIds.has(id)));
  }, [data.signatures]);

  useEffect(() => {
    const validIds = new Set(data.adCosts.map((item) => item.id));
    setSelectedAdCostIds((current) => current.filter((id) => validIds.has(id)));
  }, [data.adCosts]);

  useEffect(() => {
    const selectedIds = new Set(selectedSignatureIds);
    const rows = data.signatures.filter((item) => selectedIds.has(item.id));
    if (!rows.length) {
      setSignatureSalesUnitId(data.salesUnits[0]?.id ?? "");
      return;
    }
    const sharedSalesUnitId =
      rows.every((item) => item.canonicalSalesUnitId === rows[0]?.canonicalSalesUnitId) &&
      rows[0]?.canonicalSalesUnitId
        ? rows[0].canonicalSalesUnitId
        : data.salesUnits[0]?.id ?? "";
    setSignatureSalesUnitId(sharedSalesUnitId);
  }, [data.salesUnits, data.signatures, selectedSignatureIds]);

  useEffect(() => {
    const selectedIds = new Set(selectedAdCostIds);
    const rows = data.adCosts.filter((item) => selectedIds.has(item.id));
    if (!rows.length) {
      setAdCostSalesUnitId(defaultCampaignSalesUnitId);
      setIntentionalReason("");
      return;
    }
    const sharedSalesUnitId =
      rows.every((item) => item.canonicalSalesUnitId === rows[0]?.canonicalSalesUnitId) &&
      rows[0]?.canonicalSalesUnitId
        ? rows[0].canonicalSalesUnitId
        : defaultCampaignSalesUnitId;
    const sharedReason =
      rows.every((item) => item.reasonNote === rows[0]?.reasonNote)
        ? rows[0]?.reasonNote ?? ""
        : "";
    setAdCostSalesUnitId(sharedSalesUnitId);
    setIntentionalReason(sharedReason);
  }, [data.adCosts, defaultCampaignSalesUnitId, selectedAdCostIds]);

  useEffect(() => {
    if (selectedMapping) {
      setCampaignDraft({
        canonicalSalesUnitId: selectedMapping.canonicalSalesUnitId,
        campaignPattern: selectedMapping.campaignPattern,
      });
      return;
    }
    setCampaignDraft(emptyCampaignDraft(defaultCampaignSalesUnitId));
  }, [defaultCampaignSalesUnitId, selectedMapping]);

  useEffect(() => {
    if (selectedMappingId === null) return;
    if (data.campaignMappings.some((item) => item.id === selectedMappingId)) return;
    setSelectedMappingId(data.campaignMappings[0]?.id ?? null);
  }, [data.campaignMappings, selectedMappingId]);

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="스토어를 먼저 설정해 주세요"
        description="주문 시그니처와 광고 캠페인은 기본 스토어를 기준으로 분류됩니다."
        actionHref="/settings/stores"
        actionLabel="스토어 설정으로 이동"
      />
    );
  }

  const primaryStoreId = data.primaryStore.id;
  const salesUnitsHref = buildHrefWithStore("/sales-units", null, primaryStoreId);
  const unmappedSelectedSignatures = selectedSignatureRows.filter((row) => row.mappingStatus !== "MAPPED");
  const registrationQuery = new URLSearchParams(unmappedSelectedSignatures.map((row) => ["signatureId", row.id]));
  registrationQuery.set("register", "1");
  const registrationHref = buildHrefWithStore("/sales-units", registrationQuery, primaryStoreId);
  const orderPage = data.signaturePage;
  const adPage = data.adCostPage;

  const navigateMappingList = (
    kind: MappingListKind,
    patch: Partial<AdMappingListState>,
  ) => {
    const current = kind === "order" ? data.signatureQuery : data.adCostQuery;
    const next = { ...current, ...patch };
    const paramNames = MAPPING_QUERY_PARAM_NAMES[kind];
    const searchParams = new URLSearchParams(window.location.search);

    searchParams.set(STORE_ID_QUERY_KEY, primaryStoreId);
    searchParams.set(paramNames.page, String(next.page));
    searchParams.set(paramNames.pageSize, String(next.pageSize));
    searchParams.set(paramNames.mappingStatus, next.mappingStatus);
    if (next.q.trim()) {
      searchParams.set(paramNames.q, next.q.trim());
    } else {
      searchParams.delete(paramNames.q);
    }

    if (kind === "order") {
      setSelectedSignatureIds([]);
    } else {
      setSelectedAdCostIds([]);
      if (patch.excludeZeroCost === false) searchParams.set("adShowZero", "1");
      if (patch.excludeZeroCost === true) searchParams.delete("adShowZero");
    }

    saveScrollPositions();
    scrollPositions.current.set(kind, 0);
    startRefresh(() => {
      router.replace(`/mappings?${searchParams.toString()}`, { scroll: false });
    });
  };

  const submitOrderSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigateMappingList("order", { q: orderSearchInput, page: 1 });
  };

  const submitAdSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigateMappingList("ad", { q: adSearchInput, page: 1 });
  };

  const saveScrollPositions = () => {
    if (orderScrollRef.current) {
      scrollPositions.current.set("order", orderScrollRef.current.scrollTop);
    }
    if (adScrollRef.current) {
      scrollPositions.current.set("ad", adScrollRef.current.scrollTop);
    }
  };

  const restoreScrollPositions = () => {
    if (orderScrollRef.current) {
      const pos = scrollPositions.current.get("order");
      if (pos !== undefined) {
        orderScrollRef.current.scrollTop = pos;
      }
    }
    if (adScrollRef.current) {
      const pos = scrollPositions.current.get("ad");
      if (pos !== undefined) {
        adScrollRef.current.scrollTop = pos;
      }
    }
  };

  const refreshWithMessage = (target: "order" | "campaign" | "ad-cost", message: string) => {
    saveScrollPositions();
    if (target === "order") setOrderSuccess(message);
    else if (target === "campaign") setCampaignSuccess(message);
    else setAdCostSuccess(message);
    startRefresh(() => router.refresh());
  };

  useEffect(() => {
    if (!isRefreshing) {
      restoreScrollPositions();
    }
  }, [isRefreshing]);

  const updateOrderSelection = (ids: string[], checked: boolean) =>
    setSelectedSignatureIds((current) => applySelectionChange(current, ids, checked));
  const updateAdSelection = (ids: string[], checked: boolean) =>
    setSelectedAdCostIds((current) => applySelectionChange(current, ids, checked));

  const stopOrderDrag = () => {
    orderDragRef.current = { active: false, nextChecked: false, pointerId: null };
  };
  const stopAdDrag = () => {
    adDragRef.current = { active: false, nextChecked: false, pointerId: null };
  };

  const startOrderDrag = (event: ReactPointerEvent<HTMLLabelElement>, id: string, selected: boolean) => {
    if (isBusy) return;
    orderDragRef.current = { active: true, nextChecked: !selected, pointerId: event.pointerId };
    updateOrderSelection([id], !selected);
  };
  const startAdDrag = (event: ReactPointerEvent<HTMLLabelElement>, id: string, selected: boolean) => {
    if (isBusy) return;
    adDragRef.current = { active: true, nextChecked: !selected, pointerId: event.pointerId };
    updateAdSelection([id], !selected);
  };
  const continueOrderDrag = (event: ReactPointerEvent<HTMLTableRowElement>, id: string) => {
    if (!orderDragRef.current.active || isBusy) return;
    if (event.buttons === 0 || orderDragRef.current.pointerId !== event.pointerId) {
      stopOrderDrag();
      return;
    }
    updateOrderSelection([id], orderDragRef.current.nextChecked);
  };
  const continueAdDrag = (event: ReactPointerEvent<HTMLTableRowElement>, id: string) => {
    if (!adDragRef.current.active || isBusy) return;
    if (event.buttons === 0 || adDragRef.current.pointerId !== event.pointerId) {
      stopAdDrag();
      return;
    }
    updateAdSelection([id], adDragRef.current.nextChecked);
  };

  async function postJson(path: string, body: unknown, fallback: string) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    if (!response.ok) throw new Error(payload?.message ?? fallback);
  }

  async function handleSaveOrderMappings() {
    if (!selectedSignatureRows.length) return setOrderError("주문 항목을 하나 이상 선택해 주세요.");
    if (!signatureSalesUnitId) return setOrderError("연결할 판매단위를 선택해 주세요.");
    setOrderError(null);
    setOrderSuccess(null);
    setIsSavingOrder(true);
    try {
      await postJson(
        "/api/order-source-signatures/batch-mapping",
        { signatureIds: selectedSignatureRows.map((item) => item.id), canonicalSalesUnitId: signatureSalesUnitId },
        "주문 일괄 매핑 저장에 실패했습니다.",
      );
      setSelectedSignatureIds([]);
      refreshWithMessage("order", `${formatNumber(selectedSignatureRows.length)}개 주문 매핑을 저장했습니다.`);
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : "주문 일괄 매핑 저장에 실패했습니다.");
    } finally {
      setIsSavingOrder(false);
    }
  }

  async function handleRecalculateOrderMappings() {
    setOrderError(null);
    setOrderSuccess(null);
    setIsRecalculatingOrder(true);
    try {
      await postJson(
        `/api/stores/${primaryStoreId}/order-mapping/recalculate`,
        {},
        "주문 자동 매핑을 다시 계산하지 못했습니다.",
      );
      refreshWithMessage("order", "주문 자동 매핑 재계산 작업을 시작했습니다.");
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : "주문 자동 매핑을 다시 계산하지 못했습니다.");
    } finally {
      setIsRecalculatingOrder(false);
    }
  }

  async function handleSaveCampaign() {
    if (!campaignDraft.canonicalSalesUnitId || !campaignDraft.campaignPattern.trim()) {
      return setCampaignError("판매단위와 캠페인 패턴을 입력해 주세요.");
    }
    setCampaignError(null);
    setCampaignSuccess(null);
    setIsSavingCampaign(true);
    try {
      await fetch(selectedMapping ? `/api/campaign-mappings/${selectedMapping.id}` : "/api/campaign-mappings", {
        method: selectedMapping ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(selectedMapping ? {} : { storeId: primaryStoreId }),
          canonicalSalesUnitId: campaignDraft.canonicalSalesUnitId,
          campaignPattern: campaignDraft.campaignPattern.trim(),
        }),
      }).then(async (response) => {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        if (!response.ok) throw new Error(payload?.message ?? "캠페인 규칙을 저장하지 못했습니다.");
      });
      refreshWithMessage("campaign", selectedMapping ? "캠페인 규칙을 수정했습니다." : "캠페인 규칙을 추가했습니다.");
    } catch (error) {
      setCampaignError(error instanceof Error ? error.message : "캠페인 규칙을 저장하지 못했습니다.");
    } finally {
      setIsSavingCampaign(false);
    }
  }

  async function handleToggleCampaign(nextAction: "activate" | "deactivate") {
    if (!selectedMapping) return;
    setCampaignError(null);
    setCampaignSuccess(null);
    setIsSavingCampaign(true);
    try {
      await postJson(`/api/campaign-mappings/${selectedMapping.id}/${nextAction}`, undefined, "캠페인 규칙 상태를 바꾸지 못했습니다.");
      refreshWithMessage("campaign", nextAction === "activate" ? "캠페인 규칙을 활성화했습니다." : "캠페인 규칙을 비활성화했습니다.");
    } catch (error) {
      setCampaignError(error instanceof Error ? error.message : "캠페인 규칙 상태를 바꾸지 못했습니다.");
    } finally {
      setIsSavingCampaign(false);
    }
  }

  async function handleSaveAdCostMappings() {
    if (!selectedAdCostRows.length) return setAdCostError("광고 항목을 하나 이상 선택해 주세요.");
    if (!adCostSalesUnitId) return setAdCostError("연결할 판매단위를 선택해 주세요.");
    setAdCostError(null);
    setAdCostSuccess(null);
    setIsSavingAdCost(true);
    try {
      await postJson(
        "/api/ad-campaign-costs/batch-mapping",
        { adCostIds: selectedAdCostRows.map((item) => item.id), canonicalSalesUnitId: adCostSalesUnitId },
        "광고 연결을 저장하지 못했습니다.",
      );
      setSelectedAdCostIds([]);
      refreshWithMessage("ad-cost", `${formatNumber(selectedAdCostRows.length)}개 광고 row를 수동 매핑했습니다.`);
    } catch (error) {
      setAdCostError(error instanceof Error ? error.message : "광고 연결을 저장하지 못했습니다.");
    } finally {
      setIsSavingAdCost(false);
    }
  }

  async function handleIntentionalUnmapped() {
    if (!selectedAdCostRows.length) return setAdCostError("광고 항목을 하나 이상 선택해 주세요.");
    if (!intentionalReason.trim()) return setAdCostError("제외 사유를 입력해 주세요.");
    setAdCostError(null);
    setAdCostSuccess(null);
    setIsSavingAdCost(true);
    try {
      await postJson(
        "/api/ad-campaign-costs/batch-intentional-unmapped",
        { adCostIds: selectedAdCostRows.map((item) => item.id), reasonNote: intentionalReason.trim() },
        "광고 제외 사유를 저장하지 못했습니다.",
      );
      setSelectedAdCostIds([]);
      refreshWithMessage("ad-cost", `${formatNumber(selectedAdCostRows.length)}개 광고 row를 의도적 제외로 표시했습니다.`);
    } catch (error) {
      setAdCostError(error instanceof Error ? error.message : "광고 제외 사유를 저장하지 못했습니다.");
    } finally {
      setIsSavingAdCost(false);
    }
  }

  async function handleRecalculateAdCostMappings() {
    if (!selectedAdCostRows.length) return setAdCostError("광고 항목을 하나 이상 선택해 주세요.");
    setAdCostError(null);
    setAdCostSuccess(null);
    setIsSavingAdCost(true);
    try {
      await postJson(
        "/api/ad-campaign-costs/batch-recalculate-mapping",
        { adCostIds: selectedAdCostRows.map((item) => item.id) },
        "광고 자동 매핑을 다시 계산하지 못했습니다.",
      );
      setSelectedAdCostIds([]);
      refreshWithMessage("ad-cost", `${formatNumber(selectedAdCostRows.length)}개 광고 row의 자동 매핑을 다시 계산했습니다.`);
    } catch (error) {
      setAdCostError(error instanceof Error ? error.message : "광고 자동 매핑을 다시 계산하지 못했습니다.");
    } finally {
      setIsSavingAdCost(false);
    }
  }

  const rulesSelect = [...campaignMappableSalesUnits].sort((left, right) => {
    const rank = (unit: typeof left) => unit.isStoreLevel ? 0 : unit.isGroup ? 1 : 2;
    return rank(left) - rank(right) || left.displayName.localeCompare(right.displayName, "ko");
  });
  const orderSalesUnits = data.salesUnits.filter((unit) => unit.isActive && !unit.isGroup && !unit.isStoreLevel)
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "ko"));
  const advertisingReasonLabels = {
    NO_RULE_MATCH: "일치 규칙 없음",
    MULTIPLE_RULE_MATCHES: "여러 규칙 일치",
    MANUAL_MAPPED: "수동 연결",
    INTENTIONALLY_UNMAPPED: "의도적 제외",
  };

  function openNewRule() {
    setSelectedMappingId(null);
    setCampaignDraft(emptyCampaignDraft(defaultCampaignSalesUnitId));
    setCampaignError(null);
    setCampaignSuccess(null);
    if (rulesRef.current) rulesRef.current.open = true;
    requestAnimationFrame(() => ruleInputRef.current?.focus());
  }

  return (
    <div className="mappings-workspace space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h1 className="text-2xl font-semibold tracking-tight">주문 · 광고 매핑</h1>
          <p className="text-sm text-ink/65">{data.primaryStore.name}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button className="button-shell button-secondary" type="button" disabled={isBusy} onClick={() => void handleRecalculateOrderMappings()}>주문 자동 매핑 재계산</button>
          <Link className="button-shell button-ghost" href={salesUnitsHref}>판매단위 관리</Link>
          <button className="button-shell button-secondary" type="button" disabled={isBusy} onClick={openNewRule}>새 캠페인 규칙</button>
        </div>
      </header>

      <SourceBanner sources={data.sources} />

      <nav aria-label="매핑 화면 바로가기" className="flex gap-3 text-xs lg:hidden">
        <a href="#order-mapping" className="underline underline-offset-2">주문 시그니처</a>
        <a href="#advertising-mapping" className="underline underline-offset-2">광고 비용</a>
      </nav>

      <div className="grid items-start gap-3 lg:grid-cols-2">
        <section id="order-mapping" className="min-w-0 scroll-mt-2 rounded-lg border border-ink/15 bg-white/85" aria-label="주문 시그니처">
          <MappingListToolbar
            title="주문 시그니처"
            value={orderSearchInput}
            onSearchChange={setOrderSearchInput}
            onSearch={submitOrderSearch}
            query={data.signatureQuery}
            page={orderPage}
            onChange={(patch) => navigateMappingList("order", patch)}
            busy={isBusy}
            hideEmpty={hideZeroOrderSignatures}
            onHideEmpty={setHideZeroOrderSignatures}
            emptyLabel="주문 0건 숨기기"
            hiddenCount={hiddenSignaturesCount}
            rowCount={filteredSignatures.length}
            selectedCount={selectedSignatureRows.length}
            hiddenSelected={selectedSignatureRows.length - visibleSelectedSignatureCount}
            onSelectPage={() => updateOrderSelection(filteredSignatures.map((item) => item.id), true)}
            onClearSelection={() => setSelectedSignatureIds([])}
          />
          {selectedSignatureRows.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-ink/10 bg-sand/45 px-2.5 py-1.5 text-xs">
              <strong className="shrink-0">{formatNumber(selectedSignatureRows.length)}건 선택</strong>
              <label className="min-w-32 flex-1">
                <span className="sr-only">주문 연결 판매단위</span>
                <select className="input-shell" value={signatureSalesUnitId} disabled={isBusy} onChange={(event) => setSignatureSalesUnitId(event.target.value)}>
                  <option value="">판매단위 선택</option>
                  {orderSalesUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.displayName}</option>)}
                </select>
              </label>
              <button className="button-shell button-primary" type="button" disabled={isBusy || !signatureSalesUnitId} onClick={() => void handleSaveOrderMappings()}>연결 저장</button>
              {unmappedSelectedSignatures.length === selectedSignatureRows.length && selectedSignatureRows.length <= 100 && data.primaryStore.isActive && (
                <Link className="button-shell button-secondary" href={registrationHref}>신상품 등록</Link>
              )}
            </div>
          )}
          {orderError && <p role="alert" className="bg-red-50 px-2.5 py-1.5 text-xs text-red-800">{orderError}</p>}
          {orderSuccess && <p role="status" className="bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-900">{orderSuccess}</p>}
          <div className="max-h-[min(65vh,43rem)] overflow-auto rounded-b-lg" ref={orderScrollRef}>
            <SelectionTable
              caption="주문 시그니처 목록"
              rows={filteredSignatures}
              selectedIds={selectedSignatureSet}
              rowLabel={(row) => row.sourceSignature}
              emptyMessage="조건에 맞는 주문 시그니처가 없습니다."
              onStartDrag={startOrderDrag}
              onContinueDrag={continueOrderDrag}
              onToggle={(id, selected) => { if (!isBusy) updateOrderSelection([id], selected); }}
              columns={[
                {
                  key: "source",
                  title: "상품명 · 옵션",
                  render: (row) => {
                    const productName = row.fallbackProductName || row.rawProductNameSnapshot || row.sourceSignature;
                    const url = !row.fallbackProductName && row.fallbackProductNameSource === null
                      ? buildNaverStoreProductUrl(row.storeSlug, row.externalProductId)
                      : null;
                    return (
                      <>
                        <p title={row.sourceSignature} className="truncate font-semibold">{productName}</p>
                        {(row.rawOptionInfoSnapshot || url) && (
                          <div className="flex items-baseline gap-1 text-ink/70">
                            {row.rawOptionInfoSnapshot && <span title={row.rawOptionInfoSnapshot} className="min-w-0 truncate">{row.rawOptionInfoSnapshot}</span>}
                            {url && <a href={url} target="_blank" rel="noopener noreferrer" className="shrink-0 underline">상품 링크</a>}
                          </div>
                        )}
                      </>
                    );
                  },
                },
                {
                  key: "usage",
                  title: "주문",
                  className: "w-12 text-right tabular-nums",
                  render: (row) => formatNumber(row.usageCount),
                },
                {
                  key: "status",
                  title: "상태 · 판매단위",
                  className: "w-[6.25rem] sm:w-28",
                  render: (row) => (
                    <>
                      <MappingState status={row.mappingStatus} />
                      {row.mappingStatus === "MAPPED" && <span className="ml-1 text-[10px] text-ink/65">{row.externalProductId || row.optionCode ? "ID" : "텍스트"}</span>}
                      {hasGroupShipping(row.rawOptionInfoSnapshot) && <span className="ml-1 text-[10px] text-ink/65">함께배송</span>}
                      {row.canonicalDisplayName && <p title={row.canonicalDisplayName} className="truncate text-ink/65">{row.canonicalDisplayName}</p>}
                    </>
                  ),
                },
              ]}
            />
          </div>
        </section>

        <section id="advertising-mapping" className="min-w-0 scroll-mt-2 rounded-lg border border-ink/15 bg-white/85" aria-label="광고 비용">
          <MappingListToolbar
            title="광고 비용"
            value={adSearchInput}
            onSearchChange={setAdSearchInput}
            onSearch={submitAdSearch}
            query={data.adCostQuery}
            page={adPage}
            onChange={(patch) => navigateMappingList("ad", patch)}
            busy={isBusy}
            hideEmpty={data.adCostQuery.excludeZeroCost}
            onHideEmpty={(excludeZeroCost) => navigateMappingList("ad", { excludeZeroCost, page: 1 })}
            emptyLabel="광고비 0원 숨기기"
            rowCount={data.adCosts.length}
            selectedCount={selectedAdCostRows.length}
            hiddenSelected={0}
            onSelectPage={() => updateAdSelection(data.adCosts.map((item) => item.id), true)}
            onClearSelection={() => setSelectedAdCostIds([])}
          />
          {selectedAdCostRows.length > 0 && (
            <div className="space-y-1.5 border-b border-ink/10 bg-sand/45 px-2.5 py-1.5 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <strong className="shrink-0">{formatNumber(selectedAdCostRows.length)}건 선택</strong>
                <label className="min-w-28 flex-1">
                  <span className="sr-only">광고 연결 판매단위</span>
                  <select className="input-shell" value={adCostSalesUnitId} disabled={isBusy} onChange={(event) => setAdCostSalesUnitId(event.target.value)}>
                    <option value="">판매단위 선택</option>
                    {rulesSelect.map((unit) => <option key={unit.id} value={unit.id}>{unit.displayName}</option>)}
                  </select>
                </label>
                <button className="button-shell button-primary" type="button" disabled={isBusy || !adCostSalesUnitId} onClick={() => void handleSaveAdCostMappings()}>연결 저장</button>
                <button className="button-shell button-secondary" type="button" disabled={isBusy} onClick={() => void handleRecalculateAdCostMappings()}>자동 재계산</button>
                <details className="w-full">
                  <summary className="w-fit cursor-pointer rounded py-1 font-medium">의도적 제외</summary>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input className="input-shell min-w-28 flex-1" aria-label="제외 사유" value={intentionalReason} onChange={(event) => setIntentionalReason(event.target.value)} placeholder="제외 사유" />
                    <button className="button-shell button-secondary" type="button" disabled={isBusy} onClick={() => void handleIntentionalUnmapped()}>선택 항목 제외</button>
                  </div>
                </details>
              </div>
            </div>
          )}
          {adCostError && <p role="alert" className="bg-red-50 px-2.5 py-1.5 text-xs text-red-800">{adCostError}</p>}
          {adCostSuccess && <p role="status" className="bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-900">{adCostSuccess}</p>}
          <div className="max-h-[min(65vh,43rem)] overflow-auto rounded-b-lg" ref={adScrollRef}>
            <SelectionTable
              caption="광고 비용 목록"
              rows={data.adCosts}
              selectedIds={selectedAdCostSet}
              rowLabel={(row) => row.campaignName}
              emptyMessage="조건에 맞는 광고 캠페인이 없습니다."
              onStartDrag={startAdDrag}
              onContinueDrag={continueAdDrag}
              onToggle={(id, selected) => { if (!isBusy) updateAdSelection([id], selected); }}
              columns={[
                {
                  key: "campaign",
                  title: "캠페인 · 최근일",
                  render: (row) => (
                    <>
                      <p title={row.campaignName} className="truncate font-semibold">{row.campaignName}</p>
                      {row.reportDate && <p className="tabular-nums text-ink/65">{row.reportDate}</p>}
                    </>
                  ),
                },
                {
                  key: "cost",
                  title: "비용",
                  className: "w-[4.75rem] whitespace-nowrap text-right tabular-nums sm:w-20",
                  render: (row) => formatCurrency(row.totalCost),
                },
                {
                  key: "status",
                  title: "상태 · 판매단위",
                  className: "w-[6.25rem] sm:w-28",
                  render: (row) => (
                    <>
                      <MappingState status={row.mappingStatus} />
                      {row.canonicalDisplayName
                        ? <p title={row.canonicalDisplayName} className="truncate text-ink/65">{row.canonicalDisplayName}</p>
                        : row.mappingReason && <p title={row.reasonNote || undefined} className="truncate text-ink/65">{advertisingReasonLabels[row.mappingReason]}{row.matchedRuleCount > 1 && " " + row.matchedRuleCount + "개"}</p>}
                    </>
                  ),
                },
              ]}
            />
          </div>
        </section>
      </div>

      <details ref={rulesRef} className="rounded-lg border border-ink/15 bg-white/85">
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
          캠페인 규칙 <span className="ml-1 text-xs font-normal text-ink/65">{formatNumber(data.campaignMappings.length)}개</span>
        </summary>
        <div className="grid gap-3 border-t border-ink/10 p-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="max-h-72 min-w-0 overflow-auto rounded-md border border-ink/10">
            <DataTable
              caption="캠페인 규칙"
              emptyTitle="등록된 캠페인 규칙이 없습니다."
              emptyDescription=""
              rows={data.campaignMappings}
              getRowKey={(row) => row.id}
              selectedRowKey={selectedMappingId}
              onRowClick={(row) => {
                if (isBusy) return;
                setSelectedMappingId(row.id);
                setCampaignError(null);
                setCampaignSuccess(null);
              }}
              columns={[
                { key: "pattern", title: "캠페인 패턴", render: (row) => row.campaignPattern },
                { key: "salesUnit", title: "판매단위", render: (row) => row.canonicalDisplayName },
                { key: "enabled", title: "상태", render: (row) => <StatusBadge tone={row.isEnabled ? "success" : "muted"}>{row.isEnabled ? "활성" : "비활성"}</StatusBadge> },
              ]}
            />
          </div>
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">{selectedMapping ? "캠페인 규칙 편집" : "새 캠페인 규칙"}</h2>
            <label className="block text-xs font-medium">
              <span className="mb-1 block">판매단위</span>
              <select className="input-shell" value={campaignDraft.canonicalSalesUnitId} onChange={(event) => setCampaignDraft((current) => ({ ...current, canonicalSalesUnitId: event.target.value }))}>
                <option value="">판매단위 선택</option>
                {rulesSelect.map((unit) => <option key={unit.id} value={unit.id}>{unit.displayName}</option>)}
              </select>
            </label>
            <label className="block text-xs font-medium">
              <span className="mb-1 block">캠페인 패턴</span>
              <input ref={ruleInputRef} className="input-shell" value={campaignDraft.campaignPattern} onChange={(event) => setCampaignDraft((current) => ({ ...current, campaignPattern: event.target.value }))} placeholder="캠페인명에 포함된 키워드" />
            </label>
            {campaignError && <p role="alert" className="text-xs text-red-800">{campaignError}</p>}
            {campaignSuccess && <p role="status" className="text-xs text-emerald-900">{campaignSuccess}</p>}
            <div className="flex flex-wrap gap-1.5">
              <button className="button-shell button-primary" type="button" disabled={isBusy || !campaignDraft.canonicalSalesUnitId || !campaignDraft.campaignPattern.trim()} onClick={() => void handleSaveCampaign()}>
                {selectedMapping ? "변경사항 저장" : "규칙 생성"}
              </button>
              {selectedMapping && (
                <>
                  <button className="button-shell button-secondary" type="button" disabled={isBusy} onClick={openNewRule}>새 규칙</button>
                  <button className="button-shell button-ghost" type="button" disabled={isBusy} onClick={() => void handleToggleCampaign(selectedMapping.isEnabled ? "deactivate" : "activate")}>
                    {selectedMapping.isEnabled ? "비활성화" : "활성화"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
