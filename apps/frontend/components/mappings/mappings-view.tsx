"use client";

import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatusBadge } from "@/components/shared/status-badge";
import type { MappingsPageData } from "@/lib/api/types";
import { buildNaverStoreProductUrl, formatCurrency, formatDate, formatNullableText, formatNumber } from "@/lib/format";

type MappingStatus = "MAPPED" | "UNMAPPED" | "CONFLICT";

interface SignatureDraft {
  displayName: string;
  matchAliasesText: string;
  memo: string;
  linkedProductIdsText: string;
  linkedOptionCodesText: string;
}

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

function emptySignatureDraft(): SignatureDraft {
  return { displayName: "", matchAliasesText: "", memo: "", linkedProductIdsText: "", linkedOptionCodesText: "" };
}

function aliasesToText(aliases: string[]) {
  return aliases.join("\n");
}

function parseAliases(value: string) {
  return Array.from(
    new Set(
      value
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function emptyCampaignDraft(defaultSalesUnitId = ""): CampaignDraft {
  return { canonicalSalesUnitId: defaultSalesUnitId, campaignPattern: "" };
}

function toneForMappingStatus(status: MappingStatus) {
  if (status === "MAPPED") return "success" as const;
  if (status === "CONFLICT") return "danger" as const;
  return "warning" as const;
}

function matchesQuery(fields: Array<string | null | undefined>, query: string) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return true;
  return fields.some((field) => field?.toLowerCase().includes(keyword));
}

function applySelectionChange(currentIds: string[], targetIds: string[], nextChecked: boolean) {
  const nextIds = new Set(currentIds);
  targetIds.forEach((targetId) => {
    if (nextChecked) nextIds.add(targetId);
    else nextIds.delete(targetId);
  });
  return Array.from(nextIds);
}

function getMappingTypeIndicator(signature: MappingsPageData["signatures"][number]): "ID_MAPPED" | "TEXT_MAPPED" | "UNMAPPED" {
  if (signature.mappingStatus === "UNMAPPED") return "UNMAPPED";
  if (signature.externalProductId || signature.optionCode) return "ID_MAPPED";
  return "TEXT_MAPPED";
}

function hasGroupShipping(rawOptionInfo: string | null): boolean {
  return rawOptionInfo?.includes("[함께배송") ?? false;
}

function buildSignatureDraft(signatures: MappingsPageData["signatures"]): SignatureDraft {
  if (!signatures.length) return emptySignatureDraft();

  const aliases = new Set<string>();
  signatures.forEach((signature) => {
    const joined = [signature.rawProductNameSnapshot, signature.rawOptionInfoSnapshot]
      .filter(Boolean)
      .join(" ");
    [signature.rawProductNameSnapshot, joined, signature.sourceSignature]
      .filter(Boolean)
      .forEach((value) => aliases.add(value));
  });

  const first = signatures[0];
  return {
    displayName:
      first.canonicalDisplayName ??
      (signatures.length === 1
        ? [first.rawProductNameSnapshot, first.rawOptionInfoSnapshot].filter(Boolean).join(" / ")
        : `${first.rawProductNameSnapshot} 외 ${signatures.length - 1}건`),
    matchAliasesText: aliasesToText(parseAliases(Array.from(aliases).join("\n"))),
    memo: "",
    linkedProductIdsText: "",
    linkedOptionCodesText: "",
  };
}

function SelectionCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded border text-xs transition",
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
}) {
  return (
    <div className="table-scroll">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{props.caption}</caption>
        <thead>
          <tr className="border-b border-ink/10 text-xs uppercase tracking-[0.18em] text-ink/45">
            <th className="px-4 py-3 font-medium">선택</th>
            {props.columns.map((column) => (
              <th key={column.key} className="px-4 py-3 font-medium">
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr>
              <td className="px-4 py-10 text-center text-sm text-ink/60" colSpan={props.columns.length + 1}>
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
                    "select-none border-b border-ink/8 text-sm text-ink transition hover:bg-white/45",
                    isSelected && "bg-white/75",
                  )}
                  onPointerEnter={(event) => props.onContinueDrag(event, row.id)}
                >
                  <td className="px-4 py-4 align-top">
                    <label
                      className="inline-flex cursor-pointer items-center gap-3"
                      onClick={(event) => event.preventDefault()}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        props.onStartDrag(event, row.id, isSelected);
                      }}
                    >
                      <input checked={isSelected} className="sr-only" readOnly type="checkbox" />
                      <SelectionCheckbox checked={isSelected} />
                      <span className="sr-only">{isSelected ? "선택됨" : "선택"}</span>
                    </label>
                  </td>
                  {props.columns.map((column) => (
                    <td key={column.key} className={cn("px-4 py-4 align-top", column.className)}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

export function MappingsView({ data }: { data: MappingsPageData }) {
  const router = useRouter();
  const [selectedSignatureIds, setSelectedSignatureIds] = useState<string[]>([]);
  const [selectedMappingId, setSelectedMappingId] = useState<string | null>(data.campaignMappings[0]?.id ?? null);
  const [selectedAdCostIds, setSelectedAdCostIds] = useState<string[]>([]);
  const [signatureSalesUnitId, setSignatureSalesUnitId] = useState(
    data.salesUnits.find((u) => u.isActive && !u.isGroup && !u.isStoreLevel)?.id ?? "",
  );
  const [signatureDraft, setSignatureDraft] = useState(emptySignatureDraft());
  const [campaignDraft, setCampaignDraft] = useState(
    emptyCampaignDraft(data.campaignMappings[0]?.canonicalSalesUnitId ?? data.salesUnits[0]?.id ?? ""),
  );
  const [adCostSalesUnitId, setAdCostSalesUnitId] = useState(data.salesUnits[0]?.id ?? "");
  const [hideZeroCostAdRows, setHideZeroCostAdRows] = useState(true);
  const [showOnlyUnmapped, setShowOnlyUnmapped] = useState(false);
  const [hideZeroOrderSignatures, setHideZeroOrderSignatures] = useState(true);
  const [intentionalReason, setIntentionalReason] = useState("");
  const [orderSearch, setOrderSearch] = useState("");
  const [adSearch, setAdSearch] = useState("");
  const [orderError, setOrderError] = useState<string | null>(null);
  const [orderSuccess, setOrderSuccess] = useState<string | null>(null);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [campaignSuccess, setCampaignSuccess] = useState<string | null>(null);
  const [adCostError, setAdCostError] = useState<string | null>(null);
  const [adCostSuccess, setAdCostSuccess] = useState<string | null>(null);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [isSavingCampaign, setIsSavingCampaign] = useState(false);
  const [isSavingAdCost, setIsSavingAdCost] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();
  const orderDragRef = useRef<PointerSelectionState>({ active: false, nextChecked: false, pointerId: null });
  const adDragRef = useRef<PointerSelectionState>({ active: false, nextChecked: false, pointerId: null });
  const orderScrollRef = useRef<HTMLDivElement>(null);
  const adScrollRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Map<string, number>>(new Map());

  const selectedMapping = data.campaignMappings.find((mapping) => mapping.id === selectedMappingId) ?? null;
  const visibleAdCostsBase = hideZeroCostAdRows ? data.adCosts.filter((item) => item.totalCost !== 0) : data.adCosts;
  const hiddenZeroCostCount = data.adCosts.length - visibleAdCostsBase.length;
  const isBusy = isSavingOrder || isSavingCampaign || isSavingAdCost || isRefreshing;
  const conflictSignatureCount = data.signatures.filter((item) => item.mappingStatus === "CONFLICT").length;
  const conflictAdCostCount = data.adCosts.filter((item) => item.mappingStatus === "CONFLICT").length;
  const selectedSignatureSet = new Set(selectedSignatureIds);
  const selectedAdCostSet = new Set(selectedAdCostIds);
  const filteredSignatures = data.signatures
    .filter((item) => {
      const matchesSearch = matchesQuery([item.sourceSignature, item.rawProductNameSnapshot, item.rawOptionInfoSnapshot, item.canonicalDisplayName], orderSearch);
      const matchesUnmapped = !showOnlyUnmapped || item.mappingStatus === "UNMAPPED" || item.mappingStatus === "CONFLICT";
      const matchesUsageCount = !hideZeroOrderSignatures || item.usageCount !== 0;
      return matchesSearch && matchesUnmapped && matchesUsageCount;
    });
  const filteredAdCosts = visibleAdCostsBase.filter((item) =>
    matchesQuery([item.campaignName, item.canonicalDisplayName, item.mappingReason, item.reasonNote, item.reportDate], adSearch),
  );
  const selectedSignatureRows = data.signatures.filter((item) => selectedSignatureSet.has(item.id));
  const selectedAdCostRows = data.adCosts.filter((item) => selectedAdCostSet.has(item.id));
  const visibleSelectedSignatureCount = filteredSignatures.filter((item) => selectedSignatureSet.has(item.id)).length;
  const visibleSelectedAdCostCount = filteredAdCosts.filter((item) => selectedAdCostSet.has(item.id)).length;
  const hiddenSignaturesCount = data.signatures.filter((item) => {
    const matchesSearch = matchesQuery([item.sourceSignature, item.rawProductNameSnapshot, item.rawOptionInfoSnapshot, item.canonicalDisplayName], orderSearch);
    const matchesUnmapped = !showOnlyUnmapped || item.mappingStatus === "UNMAPPED" || item.mappingStatus === "CONFLICT";
    const matchesUsageCount = !hideZeroOrderSignatures || item.usageCount !== 0;
    return !(matchesSearch && matchesUnmapped && matchesUsageCount);
  }).length;

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
      setSignatureDraft(emptySignatureDraft());
      return;
    }
    const sharedSalesUnitId =
      rows.every((item) => item.canonicalSalesUnitId === rows[0]?.canonicalSalesUnitId) &&
      rows[0]?.canonicalSalesUnitId
        ? rows[0].canonicalSalesUnitId
        : data.salesUnits[0]?.id ?? "";
    setSignatureSalesUnitId(sharedSalesUnitId);
    setSignatureDraft(buildSignatureDraft(rows));
  }, [data.salesUnits, data.signatures, selectedSignatureIds]);

  useEffect(() => {
    const selectedIds = new Set(selectedAdCostIds);
    const rows = data.adCosts.filter((item) => selectedIds.has(item.id));
    if (!rows.length) {
      setAdCostSalesUnitId(data.salesUnits[0]?.id ?? "");
      setIntentionalReason("");
      return;
    }
    const sharedSalesUnitId =
      rows.every((item) => item.canonicalSalesUnitId === rows[0]?.canonicalSalesUnitId) &&
      rows[0]?.canonicalSalesUnitId
        ? rows[0].canonicalSalesUnitId
        : data.salesUnits[0]?.id ?? "";
    const sharedReason =
      rows.every((item) => item.reasonNote === rows[0]?.reasonNote)
        ? rows[0]?.reasonNote ?? ""
        : "";
    setAdCostSalesUnitId(sharedSalesUnitId);
    setIntentionalReason(sharedReason);
  }, [data.adCosts, data.salesUnits, selectedAdCostIds]);

  useEffect(() => {
    if (selectedMapping) {
      setCampaignDraft({
        canonicalSalesUnitId: selectedMapping.canonicalSalesUnitId,
        campaignPattern: selectedMapping.campaignPattern,
      });
      return;
    }
    setCampaignDraft(emptyCampaignDraft(data.salesUnits[0]?.id ?? ""));
  }, [data.salesUnits, selectedMapping]);

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

  async function handleCreateAndMap() {
    if (!selectedSignatureRows.length) return setOrderError("주문 항목을 하나 이상 선택해 주세요.");
    if (!signatureDraft.displayName.trim()) return setOrderError("displayName is required.");
    const matchAliases = parseAliases(signatureDraft.matchAliasesText);
    if (!matchAliases.length) return setOrderError("Add at least one match alias.");
    const linkedProductIds = signatureDraft.linkedProductIdsText.trim()
      ? parseAliases(signatureDraft.linkedProductIdsText).filter(Boolean)
      : null;
    const linkedOptionCodes = signatureDraft.linkedOptionCodesText.trim()
      ? parseAliases(signatureDraft.linkedOptionCodesText).filter(Boolean)
      : null;
    setOrderError(null);
    setOrderSuccess(null);
    setIsSavingOrder(true);
    try {
      await postJson(
        "/api/order-source-signatures/batch-mapping",
        {
          signatureIds: selectedSignatureRows.map((item) => item.id),
          displayName: signatureDraft.displayName.trim(),
          matchAliases,
          linkedProductIds,
          linkedOptionCodes,
          memo: signatureDraft.memo.trim() || null,
        },
        "Failed to create and map sales unit.",
      );
      setSelectedSignatureIds([]);
      refreshWithMessage("order", `${formatNumber(selectedSignatureRows.length)}개 주문 항목에 새 판매단위를 연결했습니다.`);
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : "Failed to create and map sales unit.");
    } finally {
      setIsSavingOrder(false);
    }
  }

  async function handleSaveCampaign() {
    if (!campaignDraft.canonicalSalesUnitId || !campaignDraft.campaignPattern.trim()) {
      return setCampaignError("Select a sales unit and enter a campaign pattern.");
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
        if (!response.ok) throw new Error(payload?.message ?? "Failed to save campaign mapping.");
      });
      refreshWithMessage("campaign", selectedMapping ? "Campaign mapping updated." : "Campaign mapping created.");
    } catch (error) {
      setCampaignError(error instanceof Error ? error.message : "Failed to save campaign mapping.");
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
      await postJson(`/api/campaign-mappings/${selectedMapping.id}/${nextAction}`, undefined, "Failed to change campaign mapping state.");
      refreshWithMessage("campaign", nextAction === "activate" ? "Campaign mapping activated." : "Campaign mapping deactivated.");
    } catch (error) {
      setCampaignError(error instanceof Error ? error.message : "Failed to change campaign mapping state.");
    } finally {
      setIsSavingCampaign(false);
    }
  }

  async function handleSaveAdCostMappings() {
    if (!selectedAdCostRows.length) return setAdCostError("광고 row를 하나 이상 선택해 주세요.");
    if (!adCostSalesUnitId) return setAdCostError("연결할 판매단위를 선택해 주세요.");
    setAdCostError(null);
    setAdCostSuccess(null);
    setIsSavingAdCost(true);
    try {
      await postJson(
        "/api/ad-campaign-costs/batch-mapping",
        { adCostIds: selectedAdCostRows.map((item) => item.id), canonicalSalesUnitId: adCostSalesUnitId },
        "Failed to save ad cost mapping.",
      );
      setSelectedAdCostIds([]);
      refreshWithMessage("ad-cost", `${formatNumber(selectedAdCostRows.length)}개 광고 row를 수동 매핑했습니다.`);
    } catch (error) {
      setAdCostError(error instanceof Error ? error.message : "Failed to save ad cost mapping.");
    } finally {
      setIsSavingAdCost(false);
    }
  }

  async function handleIntentionalUnmapped() {
    if (!selectedAdCostRows.length) return setAdCostError("광고 row를 하나 이상 선택해 주세요.");
    if (!intentionalReason.trim()) return setAdCostError("제외 사유를 입력해 주세요.");
    setAdCostError(null);
    setAdCostSuccess(null);
    setIsSavingAdCost(true);
    try {
      await postJson(
        "/api/ad-campaign-costs/batch-intentional-unmapped",
        { adCostIds: selectedAdCostRows.map((item) => item.id), reasonNote: intentionalReason.trim() },
        "Failed to save intentional-unmapped note.",
      );
      setSelectedAdCostIds([]);
      refreshWithMessage("ad-cost", `${formatNumber(selectedAdCostRows.length)}개 광고 row를 의도적 제외로 표시했습니다.`);
    } catch (error) {
      setAdCostError(error instanceof Error ? error.message : "Failed to save intentional-unmapped note.");
    } finally {
      setIsSavingAdCost(false);
    }
  }

  async function handleRecalculateAdCostMappings() {
    if (!selectedAdCostRows.length) return setAdCostError("광고 row를 하나 이상 선택해 주세요.");
    setAdCostError(null);
    setAdCostSuccess(null);
    setIsSavingAdCost(true);
    try {
      await postJson(
        "/api/ad-campaign-costs/batch-recalculate-mapping",
        { adCostIds: selectedAdCostRows.map((item) => item.id) },
        "Failed to recalculate ad cost mapping.",
      );
      setSelectedAdCostIds([]);
      refreshWithMessage("ad-cost", `${formatNumber(selectedAdCostRows.length)}개 광고 row의 자동 매핑을 다시 계산했습니다.`);
    } catch (error) {
      setAdCostError(error instanceof Error ? error.message : "Failed to recalculate ad cost mapping.");
    } finally {
      setIsSavingAdCost(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="매핑 관리"
        title="주문 · 광고 매핑"
        description="주문 시그니처와 광고 캠페인을 판매단위에 연결합니다. 항목을 검색하고 드래그로 다중 선택한 뒤 일괄 매핑할 수 있습니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href="/sales-units">
              판매단위 관리
            </Link>
            <button
              className="button-shell button-primary"
              type="button"
              disabled={isBusy}
              onClick={() => {
                setSelectedMappingId(null);
                setCampaignDraft(emptyCampaignDraft(data.salesUnits[0]?.id ?? ""));
                setCampaignError(null);
                setCampaignSuccess(null);
              }}
            >
              새 캠페인 규칙
            </button>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      {conflictSignatureCount > 0 || conflictAdCostCount > 0 ? (
        <div className="rounded-2xl border border-red-300/40 bg-red-100/70 px-4 py-4 text-sm leading-6 text-red-800">
          <p className="font-semibold">충돌 항목이 있습니다. 수동 확인이 필요합니다.</p>
          <p className="mt-1">
            주문 시그니처 {formatNumber(conflictSignatureCount)}건 / 광고 {formatNumber(conflictAdCostCount)}건
          </p>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)]">
        <Panel
          title="주문 시그니처"
          description="목록을 검색하고, 체크박스를 드래그하여 여러 항목을 선택한 뒤 일괄 매핑할 수 있습니다."
          className="flex max-h-[70vh] min-h-[34rem] flex-col"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="space-y-3">
              <input
                className="input-shell"
                value={orderSearch}
                onChange={(event) => setOrderSearch(event.target.value)}
                placeholder="시그니처, 상품명, 옵션, 판매단위 검색"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  className="button-shell button-secondary"
                  type="button"
                  disabled={isBusy || !filteredSignatures.length}
                  onClick={() => updateOrderSelection(filteredSignatures.map((item) => item.id), true)}
                >
                  전체 선택
                </button>
                <button
                  className="button-shell button-ghost"
                  type="button"
                  disabled={isBusy || !selectedSignatureRows.length}
                  onClick={() => setSelectedSignatureIds([])}
                >
                  선택 해제
                </button>
              </div>
              <div className="flex flex-wrap gap-3">
                <label className="inline-flex items-center gap-2 text-xs text-ink/60">
                  <input checked={showOnlyUnmapped} onChange={(event) => setShowOnlyUnmapped(event.target.checked)} type="checkbox" />
                  미매핑/충돌만 보기
                </label>
                <label className="inline-flex items-center gap-2 text-xs text-ink/60">
                  <input checked={hideZeroOrderSignatures} onChange={(event) => setHideZeroOrderSignatures(event.target.checked)} type="checkbox" />
                  주문 0건 숨기기
                </label>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink/50">
              <span>조회 {formatNumber(filteredSignatures.length)}건</span>
              <span>선택 {formatNumber(selectedSignatureRows.length)}건</span>
              {selectedSignatureRows.length > visibleSelectedSignatureCount ? (
                <span>검색으로 숨겨진 선택 {formatNumber(selectedSignatureRows.length - visibleSelectedSignatureCount)}건</span>
              ) : null}
              {hiddenSignaturesCount > 0 ? (
                <span>필터로 숨겨진 {formatNumber(hiddenSignaturesCount)}건</span>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1" ref={orderScrollRef}>
              <SelectionTable
                caption="Order signatures"
                rows={filteredSignatures}
                selectedIds={selectedSignatureSet}
                emptyMessage="검색 결과가 없습니다."
                onStartDrag={startOrderDrag}
                onContinueDrag={continueOrderDrag}
                columns={[
                  {
                    key: "source",
                    title: "출처",
                    render: (row) => (
                      <div>
                        <p className="font-semibold text-ink">{row.sourceSignature}</p>
                        <p className="mt-1 text-xs text-ink/55">
                          {row.rawProductNameSnapshot} / {formatNullableText(row.rawOptionInfoSnapshot)}
                        </p>
                        {row.fallbackProductName && (
                          <p className="mt-2 text-xs text-ink/45">
                            ↳{" "}
                            <span>
                              {row.fallbackProductName}{" "}
                              <span className="text-ink/35">
                                (
                                {row.fallbackProductNameSource === "orderItem"
                                  ? "원본 주문 표기"
                                  : row.fallbackProductNameSource === "optionInfo"
                                  ? "옵션에서 추출"
                                  : row.fallbackProductNameSource === "product"
                                  ? "상품 DB 매칭"
                                  : row.fallbackProductNameSource === "commerceApi"
                                  ? "네이버 커머스 API"
                                  : "상품 정보 없음"}
                                )
                              </span>
                            </span>
                          </p>
                        )}
                        {row.externalProductId && !row.fallbackProductName && row.fallbackProductNameSource === null && (
                          <p className="mt-2 text-xs text-ink/45">
                            ↳{" "}
                            {buildNaverStoreProductUrl(row.storeSlug, row.externalProductId) ? (
                              <a
                                href={buildNaverStoreProductUrl(row.storeSlug, row.externalProductId) ?? ""}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-ink/50 underline hover:text-ink/70"
                              >
                                네이버 스토어 열기 ↗
                              </a>
                            ) : (
                              <span className="text-ink/35">(상품 정보 없음)</span>
                            )}
                          </p>
                        )}
                      </div>
                    ),
                  },
                  {
                    key: "usage",
                    title: "사용",
                    render: (row) => formatNumber(row.usageCount),
                  },
                  {
                    key: "status",
                    title: "상태",
                    render: (row) => (
                      <div>
                        <StatusBadge tone={toneForMappingStatus(row.mappingStatus)}>{row.mappingStatus}</StatusBadge>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {(getMappingTypeIndicator(row) === "ID_MAPPED") && (
                            <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">ID매핑</span>
                          )}
                          {(getMappingTypeIndicator(row) === "TEXT_MAPPED") && (
                            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">텍스트매핑</span>
                          )}
                          {hasGroupShipping(row.rawOptionInfoSnapshot) && (
                            <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">함께배송</span>
                          )}
                        </div>
                        <p className="mt-2 text-sm text-ink/65">{row.canonicalDisplayName ?? "미매핑"}</p>
                      </div>
                    ),
                  },
                ]}
              />
            </div>
          </div>
        </Panel>

        <Panel
          title="주문 매핑"
          description="선택한 시그니처를 기존 판매단위에 연결하거나, 새 판매단위를 만들어 한 번에 연결합니다."
        >
          {selectedSignatureRows.length ? (
            <div className="space-y-4">
              <div className="rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
                <p className="font-semibold text-ink">
                  {formatNumber(selectedSignatureRows.length)}개 시그니처 선택됨
                </p>
                <div className="mt-3 space-y-2">
                  {selectedSignatureRows.slice(0, 3).map((row) => (
                    <div key={row.id} className="rounded-2xl border border-ink/10 bg-white/70 px-3 py-2">
                      <p className="font-medium text-ink">{row.sourceSignature}</p>
                      <p className="text-xs text-ink/55">
                        {row.rawProductNameSnapshot} / {formatNullableText(row.rawOptionInfoSnapshot)}
                      </p>
                      {row.fallbackProductName && (
                        <p className="mt-1 text-xs text-ink/45">
                          ↳ {row.fallbackProductName}{" "}
                          <span className="text-ink/35">
                            (
                            {row.fallbackProductNameSource === "orderItem"
                              ? "원본 주문 표기"
                              : row.fallbackProductNameSource === "optionInfo"
                              ? "옵션에서 추출"
                              : row.fallbackProductNameSource === "product"
                              ? "상품 DB 매칭"
                              : row.fallbackProductNameSource === "commerceApi"
                              ? "네이버 커머스 API"
                              : "상품 정보 없음"}
                            )
                          </span>
                        </p>
                      )}
                      {row.externalProductId && !row.fallbackProductName && row.fallbackProductNameSource === null && (
                        <p className="mt-1 text-xs text-ink/45">
                          ↳{" "}
                          {buildNaverStoreProductUrl(row.storeSlug, row.externalProductId) ? (
                            <a
                              href={buildNaverStoreProductUrl(row.storeSlug, row.externalProductId) ?? ""}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-ink/50 underline hover:text-ink/70"
                            >
                              네이버 스토어 열기 ↗
                            </a>
                          ) : (
                            <span className="text-ink/35">(상품 정보 없음)</span>
                          )}
                        </p>
                      )}
                    </div>
                  ))}
                  {selectedSignatureRows.length > 3 ? (
                    <p className="text-xs text-ink/55">외 {formatNumber(selectedSignatureRows.length - 3)}개 항목</p>
                  ) : null}
                </div>
              </div>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">기존 판매단위에 연결</span>
                <select
                  className="input-shell"
                  value={signatureSalesUnitId}
                  onChange={(event) => setSignatureSalesUnitId(event.target.value)}
                >
                  <option value="">판매단위 선택</option>
                  {[...data.salesUnits]
                    .filter((u) => !u.isGroup && !u.isStoreLevel && u.isActive)
                    .sort((a, b) => a.displayName.localeCompare(b.displayName, "ko"))
                    .map((salesUnit) => (
                      <option key={salesUnit.id} value={salesUnit.id}>
                        {salesUnit.displayName}
                      </option>
                    ))}
                </select>
              </label>

              <button
                className="button-shell button-primary w-full"
                type="button"
                disabled={isBusy || !selectedSignatureRows.length || !data.salesUnits.length}
                onClick={() => void handleSaveOrderMappings()}
              >
                선택 항목 매핑 저장
              </button>

              <div className="rounded-2xl border border-ink/10 p-4">
                <p className="mb-4 text-sm font-medium text-ink">새 판매단위를 만들어 연결</p>
                <div className="space-y-3">
                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-ink">표시 이름</span>
                    <input
                      className="input-shell"
                      value={signatureDraft.displayName}
                      onChange={(event) => setSignatureDraft((current) => ({ ...current, displayName: event.target.value }))}
                      placeholder="화면에 표시될 판매단위 이름"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-ink">매칭 별칭</span>
                    <textarea
                      className="input-shell min-h-32"
                      value={signatureDraft.matchAliasesText}
                      onChange={(event) => setSignatureDraft((current) => ({ ...current, matchAliasesText: event.target.value }))}
                      placeholder={"줄바꿈 또는 쉼표로 구분\n예: 상품명A\n상품명B, 상품명C"}
                    />
                  </label>

                  <p className="text-xs leading-5 text-ink/55">
                    자동 매핑 시 별칭을 기준으로 매칭됩니다. 표시 이름은 화면 표시용입니다.
                  </p>

                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-ink">메모</span>
                    <textarea
                      className="input-shell min-h-24"
                      value={signatureDraft.memo}
                      onChange={(event) => setSignatureDraft((current) => ({ ...current, memo: event.target.value }))}
                      placeholder="참고사항 (선택)"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-ink">연동 상품 ID</span>
                    <div className="space-y-2">
                      <textarea
                        className="input-shell min-h-20"
                        value={signatureDraft.linkedProductIdsText}
                        onChange={(event) => setSignatureDraft((current) => ({ ...current, linkedProductIdsText: event.target.value }))}
                        placeholder="상품ID를 줄바꿈 또는 쉼표로 구분&#10;예: 12345&#10;67890, 11111"
                      />
                      <p className="text-xs text-ink/50">네이버 상품번호 (externalProductId) 또는 수동 입력</p>
                    </div>
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-ink">연동 옵션 코드</span>
                    <div className="space-y-2">
                      <textarea
                        className="input-shell min-h-20"
                        value={signatureDraft.linkedOptionCodesText}
                        onChange={(event) => setSignatureDraft((current) => ({ ...current, linkedOptionCodesText: event.target.value }))}
                        placeholder="옵션코드를 줄바꿈 또는 쉼표로 구분&#10;예: OPT001&#10;OPT002, OPT003"
                      />
                      <p className="text-xs text-ink/50">네이버 옵션코드 (optionCode) 또는 수동 입력</p>
                    </div>
                  </label>

                  <button
                    className="button-shell button-secondary w-full"
                    type="button"
                    disabled={isBusy || !selectedSignatureRows.length}
                    onClick={() => void handleCreateAndMap()}
                  >
                    새 판매단위 생성 및 연결
                  </button>
                </div>
              </div>

              {orderError ? <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{orderError}</div> : null}
              {orderSuccess ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{orderSuccess}</div> : null}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="text-sm font-medium text-ink/50">주문 시그니처를 선택해 주세요</p>
              <p className="mt-2 text-xs text-ink/40">왼쪽 목록에서 항목을 선택하면 여기서 매핑을 수정할 수 있습니다</p>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)]">
        <Panel
          title="광고 비용"
          description="캠페인별 광고 비용을 조회하고, 드래그로 선택하여 판매단위에 매핑합니다."
          className="flex max-h-[70vh] min-h-[34rem] flex-col"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="space-y-3">
              <input
                className="input-shell"
                value={adSearch}
                onChange={(event) => setAdSearch(event.target.value)}
                placeholder="캠페인명, 판매단위, 사유, 날짜 검색"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  className="button-shell button-secondary"
                  type="button"
                  disabled={isBusy || !filteredAdCosts.length}
                  onClick={() => updateAdSelection(filteredAdCosts.map((item) => item.id), true)}
                >
                  전체 선택
                </button>
                <button
                  className="button-shell button-ghost"
                  type="button"
                  disabled={isBusy || !selectedAdCostRows.length}
                  onClick={() => setSelectedAdCostIds([])}
                >
                  선택 해제
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink/50">
                <span>조회 {formatNumber(filteredAdCosts.length)}건</span>
                <span>선택 {formatNumber(selectedAdCostRows.length)}건</span>
                {selectedAdCostRows.length > visibleSelectedAdCostCount ? (
                  <span>필터로 숨겨진 선택 {formatNumber(selectedAdCostRows.length - visibleSelectedAdCostCount)}건</span>
                ) : null}
              </div>
              <label className="inline-flex items-center gap-2 text-xs text-ink/60">
                <input checked={hideZeroCostAdRows} onChange={(event) => setHideZeroCostAdRows(event.target.checked)} type="checkbox" />
                0원 항목 숨기기{hiddenZeroCostCount > 0 ? ` (${formatNumber(hiddenZeroCostCount)}건)` : ""}
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1" ref={adScrollRef}>
              <SelectionTable
                caption="Ad cost rows"
                rows={filteredAdCosts}
                selectedIds={selectedAdCostSet}
                emptyMessage={
                  hideZeroCostAdRows && hiddenZeroCostCount > 0
                    ? `검색 결과가 없습니다. (0원 row ${formatNumber(hiddenZeroCostCount)}개 숨김)`
                    : "검색 결과가 없습니다."
                }
                onStartDrag={startAdDrag}
                onContinueDrag={continueAdDrag}
                columns={[
                  {
                    key: "campaign",
                    title: "캠페인",
                    render: (row) => (
                      <div>
                        <p className="font-semibold text-ink">{row.campaignName}</p>
                        <p className="mt-1 text-xs text-ink/55">{formatDate(row.reportDate)}</p>
                      </div>
                    ),
                  },
                  {
                    key: "cost",
                    title: "비용",
                    render: (row) => formatCurrency(row.totalCost),
                  },
                  {
                    key: "status",
                    title: "상태",
                    render: (row) => (
                      <div>
                        <StatusBadge tone={toneForMappingStatus(row.mappingStatus)}>{row.mappingStatus}</StatusBadge>
                        <p className="mt-2 text-xs text-ink/55">
                          {row.mappingReason ?? "규칙 매칭"} / {row.matchedRuleCount}개 규칙
                        </p>
                      </div>
                    ),
                  },
                  {
                    key: "salesUnit",
                    title: "판매단위",
                    render: (row) => row.canonicalDisplayName ?? "미매핑",
                  },
                ]}
              />
            </div>
          </div>
        </Panel>

        <Panel
          title="광고 매핑"
          description="선택한 항목을 판매단위에 수동 매핑하거나, 자동 매핑을 재계산하거나, 의도적 제외로 표시합니다."
        >
          {selectedAdCostRows.length ? (
            <div className="space-y-4">
              <div className="rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
                <p className="font-semibold text-ink">{formatNumber(selectedAdCostRows.length)}개 광고 항목 선택됨</p>
                <div className="mt-3 space-y-2">
                  {selectedAdCostRows.slice(0, 3).map((row) => (
                    <div key={row.id} className="rounded-2xl border border-ink/10 bg-white/70 px-3 py-2">
                      <p className="font-medium text-ink">{row.campaignName}</p>
                      <p className="text-xs text-ink/55">
                        {formatDate(row.reportDate)} / {formatCurrency(row.totalCost)}
                      </p>
                    </div>
                  ))}
                  {selectedAdCostRows.length > 3 ? (
                    <p className="text-xs text-ink/55">외 {formatNumber(selectedAdCostRows.length - 3)}개 항목</p>
                  ) : null}
                </div>
              </div>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">판매단위</span>
                <select
                  className="input-shell"
                  value={adCostSalesUnitId}
                  onChange={(event) => setAdCostSalesUnitId(event.target.value)}
                >
                  <option value="">판매단위 선택</option>
                  {[...data.salesUnits]
                    .filter((u) => !u.isGroup && u.isActive)
                    .sort((a, b) => {
                      if (a.isStoreLevel === b.isStoreLevel) return 0;
                      return a.isStoreLevel ? -1 : 1;
                    })
                    .map((salesUnit) => (
                      <option key={salesUnit.id} value={salesUnit.id}>
                        {salesUnit.isStoreLevel ? `[스토어 전체] ${salesUnit.displayName}` : salesUnit.displayName}
                      </option>
                    ))}
                </select>
              </label>

              <div className="flex flex-wrap gap-3">
                <button className="button-shell button-primary flex-1" type="button" disabled={isBusy || !selectedAdCostRows.length || !data.salesUnits.length} onClick={() => void handleSaveAdCostMappings()}>
                  수동 매핑 저장
                </button>
                <button className="button-shell button-ghost" type="button" disabled={isBusy || !selectedAdCostRows.length} onClick={() => void handleRecalculateAdCostMappings()}>
                  자동 재계산
                </button>
              </div>

              <div className="rounded-2xl border border-ink/10 p-4">
                <p className="mb-3 text-sm font-medium text-ink">의도적 제외 처리</p>
                <textarea className="input-shell min-h-20" value={intentionalReason} onChange={(event) => setIntentionalReason(event.target.value)} placeholder="제외 사유를 입력해 주세요" />
                <button className="button-shell button-ghost mt-3 w-full" type="button" disabled={isBusy || !selectedAdCostRows.length} onClick={() => void handleIntentionalUnmapped()}>
                  의도적 제외로 표시
                </button>
              </div>

              {adCostError ? <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{adCostError}</div> : null}
              {adCostSuccess ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{adCostSuccess}</div> : null}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="text-sm font-medium text-ink/50">광고 항목을 선택해 주세요</p>
              <p className="mt-2 text-xs text-ink/40">왼쪽 목록에서 항목을 선택하면 여기서 매핑을 수정할 수 있습니다</p>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)]">
        <Panel title="캠페인 규칙" description="활성 규칙은 별칭 기반 매칭보다 우선 적용됩니다.">
          <DataTable
            caption="캠페인 규칙"
            columns={[
              {
                key: "select",
                title: "선택",
                render: (row) => (
                  <button
                    className="button-shell button-ghost"
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      setSelectedMappingId(row.id);
                      setCampaignError(null);
                      setCampaignSuccess(null);
                    }}
                  >
                    {selectedMappingId === row.id ? "선택됨" : "열기"}
                  </button>
                ),
              },
              {
                key: "pattern",
                title: "패턴",
                render: (row) => (
                  <div>
                    <p className="font-semibold text-ink">{row.campaignPattern}</p>
                    <p className="mt-1 text-xs text-ink/55">{row.normalizedCampaignPattern}</p>
                  </div>
                ),
              },
              { key: "salesUnit", title: "판매단위", render: (row) => row.canonicalDisplayName },
              {
                key: "enabled",
                title: "상태",
                render: (row) => <StatusBadge tone={row.isEnabled ? "success" : "muted"}>{row.isEnabled ? "활성" : "비활성"}</StatusBadge>,
              },
            ]}
            rows={data.campaignMappings}
            getRowKey={(row) => row.id}
          />
        </Panel>

        <Panel title={selectedMapping ? "캠페인 규칙 편집" : "새 캠페인 규칙"} description="캠페인명에 포함된 키워드로 매칭하는 규칙을 만들거나 수정합니다.">
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">판매단위</span>
              <select className="input-shell" value={campaignDraft.canonicalSalesUnitId} onChange={(event) => setCampaignDraft((current) => ({ ...current, canonicalSalesUnitId: event.target.value }))}>
                <option value="">판매단위 선택</option>
                {[...data.salesUnits]
                  .filter((u) => u.isStoreLevel || u.isGroup)
                  .sort((a, b) => {
                    if (a.isStoreLevel === b.isStoreLevel) return 0;
                    return a.isStoreLevel ? -1 : 1;
                  })
                  .map((salesUnit) => (
                    <option key={salesUnit.id} value={salesUnit.id}>
                      {salesUnit.isStoreLevel ? `[스토어 전체] ${salesUnit.displayName}` : salesUnit.displayName}
                    </option>
                  ))}
              </select>
              {data.salesUnits.some((u) => u.parentSalesUnitId) && (
                <p className="mt-1 text-xs text-ink/55">
                  그룹 자식 판매단위는 광고 매핑 대상이 아닙니다. 자식이 속한 그룹을 선택해주세요.
                </p>
              )}
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">캠페인 패턴</span>
              <input className="input-shell" value={campaignDraft.campaignPattern} onChange={(event) => setCampaignDraft((current) => ({ ...current, campaignPattern: event.target.value }))} placeholder="캠페인명에 포함된 키워드" />
            </label>

            {campaignError ? <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{campaignError}</div> : null}
            {campaignSuccess ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{campaignSuccess}</div> : null}

            <div className="flex flex-wrap gap-3">
              <button className="button-shell button-primary flex-1" type="button" disabled={isBusy || !data.salesUnits.length} onClick={() => void handleSaveCampaign()}>
                {selectedMapping ? "변경사항 저장" : "규칙 생성"}
              </button>
              {selectedMapping ? (
                selectedMapping.isEnabled ? (
                  <button className="button-shell button-ghost" type="button" disabled={isBusy} onClick={() => void handleToggleCampaign("deactivate")}>
                    비활성화
                  </button>
                ) : (
                  <button className="button-shell button-secondary" type="button" disabled={isBusy} onClick={() => void handleToggleCampaign("activate")}>
                    활성화
                  </button>
                )
              ) : null}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
