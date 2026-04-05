"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatusBadge } from "@/components/shared/status-badge";
import type { MappingsPageData } from "@/lib/api/types";
import { formatCurrency, formatDate, formatNullableText, formatNumber } from "@/lib/format";

function emptySignatureDraft() {
  return {
    standardProductName: "",
    standardOptionName: "",
    displayName: "",
    memo: "",
  };
}

function emptyCampaignDraft(defaultSalesUnitId = "") {
  return {
    canonicalSalesUnitId: defaultSalesUnitId,
    campaignPattern: "",
  };
}

function pickDefaultAdCostId(adCosts: MappingsPageData["adCosts"]) {
  return adCosts.find((item) => item.mappingStatus === "UNMAPPED")?.id ?? adCosts[0]?.id ?? null;
}

export function MappingsView({ data }: { data: MappingsPageData }) {
  const router = useRouter();
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(
    data.signatures[0]?.id ?? null,
  );
  const [selectedMappingId, setSelectedMappingId] = useState<string | null>(
    data.campaignMappings[0]?.id ?? null,
  );
  const [selectedAdCostId, setSelectedAdCostId] = useState<string | null>(
    pickDefaultAdCostId(data.adCosts.filter((item) => item.totalCost !== 0)),
  );
  const [signatureSalesUnitId, setSignatureSalesUnitId] = useState(
    data.signatures[0]?.canonicalSalesUnitId ?? data.salesUnits[0]?.id ?? "",
  );
  const [signatureDraft, setSignatureDraft] = useState(emptySignatureDraft());
  const [campaignDraft, setCampaignDraft] = useState(
    emptyCampaignDraft(data.campaignMappings[0]?.canonicalSalesUnitId ?? data.salesUnits[0]?.id ?? ""),
  );
  const [adCostSalesUnitId, setAdCostSalesUnitId] = useState(
    data.adCosts[0]?.canonicalSalesUnitId ?? data.salesUnits[0]?.id ?? "",
  );
  const [hideZeroCostAdRows, setHideZeroCostAdRows] = useState(true);
  const [intentionalReason, setIntentionalReason] = useState("");
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

  const selectedSignature =
    data.signatures.find((signature) => signature.id === selectedSignatureId) ?? null;
  const selectedMapping =
    data.campaignMappings.find((mapping) => mapping.id === selectedMappingId) ?? null;
  const visibleAdCosts = hideZeroCostAdRows
    ? data.adCosts.filter((adCost) => adCost.totalCost !== 0)
    : data.adCosts;
  const hiddenZeroCostCount = data.adCosts.length - visibleAdCosts.length;
  const selectedAdCost = visibleAdCosts.find((adCost) => adCost.id === selectedAdCostId) ?? null;
  const isBusy = isSavingOrder || isSavingCampaign || isSavingAdCost || isRefreshing;

  useEffect(() => {
    if (selectedSignature) {
      setSignatureSalesUnitId(
        selectedSignature.canonicalSalesUnitId ?? data.salesUnits[0]?.id ?? "",
      );
      setSignatureDraft({
        standardProductName: selectedSignature.rawProductNameSnapshot,
        standardOptionName: selectedSignature.rawOptionInfoSnapshot ?? "",
        displayName: selectedSignature.canonicalDisplayName ?? "",
        memo: "",
      });
      return;
    }

    setSignatureSalesUnitId(data.salesUnits[0]?.id ?? "");
    setSignatureDraft(emptySignatureDraft());
  }, [data.salesUnits, selectedSignature]);

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
    setIntentionalReason(selectedAdCost?.reasonNote ?? "");
    setAdCostSalesUnitId(selectedAdCost?.canonicalSalesUnitId ?? data.salesUnits[0]?.id ?? "");
  }, [data.salesUnits, selectedAdCost]);

  useEffect(() => {
    if (selectedSignatureId && data.signatures.some((signature) => signature.id === selectedSignatureId)) {
      return;
    }
    setSelectedSignatureId(data.signatures[0]?.id ?? null);
  }, [data.signatures, selectedSignatureId]);

  useEffect(() => {
    if (selectedMappingId === null) {
      return;
    }
    if (selectedMappingId && data.campaignMappings.some((mapping) => mapping.id === selectedMappingId)) {
      return;
    }
    setSelectedMappingId(data.campaignMappings[0]?.id ?? null);
  }, [data.campaignMappings, selectedMappingId]);

  useEffect(() => {
    const nextAdCosts = hideZeroCostAdRows
      ? data.adCosts.filter((adCost) => adCost.totalCost !== 0)
      : data.adCosts;
    if (selectedAdCostId && nextAdCosts.some((adCost) => adCost.id === selectedAdCostId)) {
      return;
    }
    setSelectedAdCostId(pickDefaultAdCostId(nextAdCosts));
  }, [data.adCosts, hideZeroCostAdRows, selectedAdCostId]);

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="매핑 관리를 시작하려면 대표 스토어가 필요합니다."
        description="주문 원본과 광고 캠페인 모두 대표 스토어 기준으로 연결됩니다."
        actionHref="/settings/stores"
        actionLabel="스토어 설정"
      />
    );
  }

  const primaryStore = data.primaryStore;

  function refreshWithMessage(
    target: "order" | "campaign" | "ad-cost",
    message: string,
  ) {
    if (target === "order") {
      setOrderSuccess(message);
    } else if (target === "campaign") {
      setCampaignSuccess(message);
    } else {
      setAdCostSuccess(message);
    }

    startRefresh(() => {
      router.refresh();
    });
  }

  async function handleSaveOrderMapping() {
    if (!selectedSignature || !signatureSalesUnitId) {
      setOrderError("매핑할 판매단위를 선택해주세요.");
      return;
    }

    setOrderError(null);
    setOrderSuccess(null);
    setIsSavingOrder(true);
    try {
      const response = await fetch(`/api/order-source-signatures/${selectedSignature.id}/mapping`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          canonicalSalesUnitId: signatureSalesUnitId,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Failed to save order mapping.");
      }

      refreshWithMessage("order", "주문 매핑을 저장했습니다.");
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : "Failed to save order mapping.");
    } finally {
      setIsSavingOrder(false);
    }
  }

  async function handleCreateAndMap() {
    if (!selectedSignature) {
      setOrderError("주문 시그니처를 먼저 선택해주세요.");
      return;
    }

    if (!signatureDraft.standardProductName.trim()) {
      setOrderError("표준 상품명은 필수입니다.");
      return;
    }

    setOrderError(null);
    setOrderSuccess(null);
    setIsSavingOrder(true);
    try {
      const response = await fetch(`/api/order-source-signatures/${selectedSignature.id}/mapping`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          standardProductName: signatureDraft.standardProductName.trim(),
          standardOptionName: signatureDraft.standardOptionName.trim() || null,
          displayName: signatureDraft.displayName.trim() || null,
          memo: signatureDraft.memo.trim() || null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Failed to create and map sales unit.");
      }

      refreshWithMessage("order", "신규 판매단위를 만들고 바로 매핑했습니다.");
    } catch (error) {
      setOrderError(
        error instanceof Error ? error.message : "Failed to create and map sales unit.",
      );
    } finally {
      setIsSavingOrder(false);
    }
  }

  async function handleSaveCampaign() {
    if (!campaignDraft.canonicalSalesUnitId || !campaignDraft.campaignPattern.trim()) {
      setCampaignError("판매단위와 campaignPattern을 모두 입력해주세요.");
      return;
    }

    setCampaignError(null);
    setCampaignSuccess(null);
    setIsSavingCampaign(true);
    try {
      const response = await fetch(
        selectedMapping ? `/api/campaign-mappings/${selectedMapping.id}` : "/api/campaign-mappings",
        {
          method: selectedMapping ? "PATCH" : "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...(selectedMapping ? {} : { storeId: primaryStore.id }),
            canonicalSalesUnitId: campaignDraft.canonicalSalesUnitId,
            campaignPattern: campaignDraft.campaignPattern.trim(),
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Failed to save campaign mapping.");
      }

      refreshWithMessage(
        "campaign",
        selectedMapping ? "캠페인 규칙을 수정했습니다." : "캠페인 규칙을 추가했습니다.",
      );
    } catch (error) {
      setCampaignError(error instanceof Error ? error.message : "Failed to save campaign mapping.");
    } finally {
      setIsSavingCampaign(false);
    }
  }

  async function handleToggleCampaign(nextAction: "activate" | "deactivate") {
    if (!selectedMapping) {
      return;
    }

    setCampaignError(null);
    setCampaignSuccess(null);
    setIsSavingCampaign(true);
    try {
      const response = await fetch(`/api/campaign-mappings/${selectedMapping.id}/${nextAction}`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Failed to change campaign mapping state.");
      }

      refreshWithMessage(
        "campaign",
        nextAction === "activate" ? "캠페인 규칙을 활성화했습니다." : "캠페인 규칙을 비활성화했습니다.",
      );
    } catch (error) {
      setCampaignError(
        error instanceof Error ? error.message : "Failed to change campaign mapping state.",
      );
    } finally {
      setIsSavingCampaign(false);
    }
  }

  async function handleIntentionalUnmapped() {
    if (!selectedAdCost || !intentionalReason.trim()) {
      setAdCostError("사유 메모를 입력해주세요.");
      return;
    }

    setAdCostError(null);
    setAdCostSuccess(null);
    setIsSavingAdCost(true);
    try {
      const response = await fetch(
        `/api/ad-campaign-costs/${selectedAdCost.id}/intentional-unmapped`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reasonNote: intentionalReason.trim(),
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Failed to save intentional-unmapped note.");
      }

      refreshWithMessage("ad-cost", "광고 row를 의도적 제외로 처리했습니다.");
    } catch (error) {
      setAdCostError(
        error instanceof Error ? error.message : "Failed to save intentional-unmapped note.",
      );
    } finally {
      setIsSavingAdCost(false);
    }
  }

  async function handleSaveAdCostMapping() {
    if (!selectedAdCost || !adCostSalesUnitId) {
      setAdCostError("매핑할 판매단위를 선택해주세요.");
      return;
    }

    setAdCostError(null);
    setAdCostSuccess(null);
    setIsSavingAdCost(true);
    try {
      const response = await fetch(`/api/ad-campaign-costs/${selectedAdCost.id}/mapping`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          canonicalSalesUnitId: adCostSalesUnitId,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Failed to save ad cost mapping.");
      }

      refreshWithMessage("ad-cost", "광고 row를 판매단위에 수동 매핑했습니다.");
    } catch (error) {
      setAdCostError(error instanceof Error ? error.message : "Failed to save ad cost mapping.");
    } finally {
      setIsSavingAdCost(false);
    }
  }

  async function handleRecalculateAdCostMapping() {
    if (!selectedAdCost) {
      return;
    }

    setAdCostError(null);
    setAdCostSuccess(null);
    setIsSavingAdCost(true);
    try {
      const response = await fetch(`/api/ad-campaign-costs/${selectedAdCost.id}/recalculate-mapping`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Failed to recalculate ad cost mapping.");
      }

      refreshWithMessage("ad-cost", "광고 row 매핑을 규칙 기준으로 다시 계산했습니다.");
    } catch (error) {
      setAdCostError(
        error instanceof Error ? error.message : "Failed to recalculate ad cost mapping.",
      );
    } finally {
      setIsSavingAdCost(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Mappings"
        title="주문 원본과 광고 캠페인 연결"
        description="기존에 있던 정적 표를 실제 저장 액션과 연결해 주문/광고 매핑을 바로 수정할 수 있게 구성했습니다."
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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <Panel
          title="주문 원본 매핑"
          description="기존 시그니처를 기존 판매단위에 연결하거나, 새 판매단위를 생성하면서 바로 연결할 수 있습니다."
        >
          <div className="hidden">
            <label className="inline-flex items-center gap-2 text-sm text-ink/70">
              <input
                type="checkbox"
                checked={hideZeroCostAdRows}
                onChange={(event) => setHideZeroCostAdRows(event.target.checked)}
              />
              광고비 0원 숨기기
            </label>
            {hideZeroCostAdRows && hiddenZeroCostCount > 0 ? (
              <p className="text-sm text-ink/55">{formatNumber(hiddenZeroCostCount)}개 숨김</p>
            ) : null}
          </div>

          <DataTable
            caption="주문 원본 매핑"
            columns={[
              {
                key: "select",
                title: "Select",
                render: (row) => (
                  <button
                    className="button-shell button-ghost"
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      setSelectedSignatureId(row.id);
                      setOrderError(null);
                      setOrderSuccess(null);
                    }}
                  >
                    {selectedSignatureId === row.id ? "Selected" : "Open"}
                  </button>
                ),
              },
              {
                key: "signature",
                title: "원본 시그니처",
                render: (row) => (
                  <div>
                    <p className="font-semibold text-ink">{row.sourceSignature}</p>
                    <p className="mt-1 text-xs text-ink/55">
                      {row.rawProductNameSnapshot} / {formatNullableText(row.rawOptionInfoSnapshot)}
                    </p>
                  </div>
                ),
              },
              {
                key: "usageCount",
                title: "사용 건수",
                render: (row) => formatNumber(row.usageCount),
              },
              {
                key: "mapping",
                title: "현재 매핑",
                render: (row) => (
                  <div>
                    <StatusBadge tone={row.mappingStatus === "MAPPED" ? "success" : "warning"}>
                      {row.mappingStatus}
                    </StatusBadge>
                    <p className="mt-2 text-sm text-ink/65">
                      {row.canonicalDisplayName ?? "미매핑"}
                    </p>
                  </div>
                ),
              },
            ]}
            rows={data.signatures}
            getRowKey={(row) => row.id}
          />
        </Panel>

        <Panel
          title="주문 매핑 실행"
          description="선택된 시그니처를 기존 판매단위에 연결하거나 신규 판매단위를 만들 수 있습니다."
        >
          {selectedSignature ? (
            <div className="space-y-4">
              <div className="rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
                <p className="font-semibold text-ink">{selectedSignature.sourceSignature}</p>
                <p>
                  {selectedSignature.rawProductNameSnapshot} /{" "}
                  {formatNullableText(selectedSignature.rawOptionInfoSnapshot)}
                </p>
              </div>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">기존 판매단위 선택</span>
                <select
                  className="input-shell"
                  value={signatureSalesUnitId}
                  onChange={(event) => setSignatureSalesUnitId(event.target.value)}
                >
                  <option value="">선택</option>
                  {data.salesUnits.map((salesUnit) => (
                    <option key={salesUnit.id} value={salesUnit.id}>
                      {salesUnit.displayName}
                    </option>
                  ))}
                </select>
              </label>

              <button
                className="button-shell button-primary"
                type="button"
                disabled={isBusy || !data.salesUnits.length}
                onClick={() => void handleSaveOrderMapping()}
              >
                기존 판매단위로 매핑
              </button>

              <div className="rounded-2xl border border-ink/10 p-4">
                <p className="mb-4 text-sm font-medium text-ink">신규 판매단위 생성 후 바로 매핑</p>
                <div className="space-y-3">
                  <input
                    className="input-shell"
                    placeholder="표준 상품명"
                    value={signatureDraft.standardProductName}
                    onChange={(event) =>
                      setSignatureDraft((current) => ({
                        ...current,
                        standardProductName: event.target.value,
                      }))
                    }
                  />
                  <input
                    className="input-shell"
                    placeholder="표준 옵션명"
                    value={signatureDraft.standardOptionName}
                    onChange={(event) =>
                      setSignatureDraft((current) => ({
                        ...current,
                        standardOptionName: event.target.value,
                      }))
                    }
                  />
                  <input
                    className="input-shell"
                    placeholder="표시 이름"
                    value={signatureDraft.displayName}
                    onChange={(event) =>
                      setSignatureDraft((current) => ({
                        ...current,
                        displayName: event.target.value,
                      }))
                    }
                  />
                  <textarea
                    className="input-shell min-h-24"
                    placeholder="메모"
                    value={signatureDraft.memo}
                    onChange={(event) =>
                      setSignatureDraft((current) => ({
                        ...current,
                        memo: event.target.value,
                      }))
                    }
                  />
                  <button
                    className="button-shell button-secondary"
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleCreateAndMap()}
                  >
                    신규 판매단위 생성 후 매핑
                  </button>
                </div>
              </div>

              {orderError ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {orderError}
                </div>
              ) : null}

              {orderSuccess ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  {orderSuccess}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-ink/60">선택된 주문 시그니처가 없습니다.</p>
          )}
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <Panel
          title="광고 row 매핑 상태"
          description="의도적 제외 메모를 바로 백엔드에 저장할 수 있게 연결했습니다."
        >
          <DataTable
            caption="광고 비용 row"
            columns={[
              {
                key: "select",
                title: "Select",
                render: (row) => (
                  <button
                    className="button-shell button-ghost"
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      setSelectedAdCostId(row.id);
                      setAdCostError(null);
                      setAdCostSuccess(null);
                    }}
                  >
                    {selectedAdCostId === row.id ? "Selected" : "Open"}
                  </button>
                ),
              },
              {
                key: "campaignName",
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
                title: "광고비",
                render: (row) => formatCurrency(row.totalCost),
              },
              {
                key: "mappingReason",
                title: "매핑 상태",
                render: (row) => (
                  <div>
                    <StatusBadge tone={row.mappingStatus === "MAPPED" ? "success" : "warning"}>
                      {row.mappingStatus}
                    </StatusBadge>
                    <p className="mt-2 text-xs text-ink/55">
                      {row.mappingReason ?? "RULE_MATCHED"} / {row.matchedRuleCount} rules
                    </p>
                  </div>
                ),
              },
              {
                key: "displayName",
                title: "판매단위",
                render: (row) => row.canonicalDisplayName ?? "미매핑",
              },
            ]}
            rows={visibleAdCosts}
            getRowKey={(row) => row.id}
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-sm text-ink/70">
              <input
                type="checkbox"
                checked={hideZeroCostAdRows}
                onChange={(event) => setHideZeroCostAdRows(event.target.checked)}
              />
              광고비 0원 숨기기
            </label>
            {hideZeroCostAdRows && hiddenZeroCostCount > 0 ? (
              <p className="text-sm text-ink/55">{formatNumber(hiddenZeroCostCount)}개 숨김</p>
            ) : null}
          </div>
        </Panel>

        <Panel
          title="의도적 제외 메모"
          description="광고 row를 수동으로 제외 처리할 때 reasonNote를 저장합니다."
        >
          {selectedAdCost ? (
            <div className="space-y-4">
              <div className="rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
                <p className="font-semibold text-ink">{selectedAdCost.campaignName}</p>
                <p>광고비 {formatCurrency(selectedAdCost.totalCost)}</p>
                <p>현재 상태 {selectedAdCost.mappingReason ?? selectedAdCost.mappingStatus}</p>
              </div>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">판매단위 선택</span>
                <select
                  className="input-shell"
                  value={adCostSalesUnitId}
                  onChange={(event) => setAdCostSalesUnitId(event.target.value)}
                >
                  <option value="">선택</option>
                  {data.salesUnits.map((salesUnit) => (
                    <option key={salesUnit.id} value={salesUnit.id}>
                      {salesUnit.displayName}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex flex-wrap gap-3">
                <button
                  className="button-shell button-primary"
                  type="button"
                  disabled={isBusy || !data.salesUnits.length}
                  onClick={() => void handleSaveAdCostMapping()}
                >
                  판매단위로 수동 매핑
                </button>
                <button
                  className="button-shell button-ghost"
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleRecalculateAdCostMapping()}
                >
                  자동 규칙으로 다시 계산
                </button>
              </div>

              <textarea
                className="input-shell min-h-28"
                value={intentionalReason}
                onChange={(event) => setIntentionalReason(event.target.value)}
                placeholder="의도적 제외 사유 메모"
              />

              <button
                className="button-shell button-primary"
                type="button"
                disabled={isBusy}
                onClick={() => void handleIntentionalUnmapped()}
              >
                의도적 제외로 저장
              </button>

              {adCostError ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {adCostError}
                </div>
              ) : null}

              {adCostSuccess ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  {adCostSuccess}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-ink/60">선택된 광고 row가 없습니다.</p>
          )}
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <Panel
          title="캠페인 규칙"
          description="생성, 수정, 활성/비활성 전환을 모두 프론트에서 직접 실행할 수 있습니다."
        >
          <DataTable
            caption="캠페인 매핑 규칙"
            columns={[
              {
                key: "select",
                title: "Select",
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
                    {selectedMappingId === row.id ? "Selected" : "Open"}
                  </button>
                ),
              },
              {
                key: "pattern",
                title: "campaignPattern",
                render: (row) => (
                  <div>
                    <p className="font-semibold text-ink">{row.campaignPattern}</p>
                    <p className="mt-1 text-xs text-ink/55">{row.normalizedCampaignPattern}</p>
                  </div>
                ),
              },
              {
                key: "salesUnit",
                title: "판매단위",
                render: (row) => row.canonicalDisplayName,
              },
              {
                key: "enabled",
                title: "상태",
                render: (row) => (
                  <StatusBadge tone={row.isEnabled ? "success" : "muted"}>
                    {row.isEnabled ? "ENABLED" : "DISABLED"}
                  </StatusBadge>
                ),
              },
            ]}
            rows={data.campaignMappings}
            getRowKey={(row) => row.id}
          />
        </Panel>

        <Panel
          title={selectedMapping ? "캠페인 규칙 수정" : "새 캠페인 규칙"}
          description="활성 규칙을 선택하면 수정, 선택을 해제하면 신규 생성 모드로 동작합니다."
        >
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">판매단위</span>
              <select
                className="input-shell"
                value={campaignDraft.canonicalSalesUnitId}
                onChange={(event) =>
                  setCampaignDraft((current) => ({
                    ...current,
                    canonicalSalesUnitId: event.target.value,
                  }))
                }
              >
                <option value="">선택</option>
                {data.salesUnits.map((salesUnit) => (
                  <option key={salesUnit.id} value={salesUnit.id}>
                    {salesUnit.displayName}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">campaignPattern</span>
              <input
                className="input-shell"
                value={campaignDraft.campaignPattern}
                onChange={(event) =>
                  setCampaignDraft((current) => ({
                    ...current,
                    campaignPattern: event.target.value,
                  }))
                }
              />
            </label>

            {campaignError ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {campaignError}
              </div>
            ) : null}

            {campaignSuccess ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {campaignSuccess}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-3">
              <button
                className="button-shell button-primary"
                type="button"
                disabled={isBusy || !data.salesUnits.length}
                onClick={() => void handleSaveCampaign()}
              >
                {selectedMapping ? "규칙 저장" : "규칙 생성"}
              </button>
              <button
                className="button-shell button-secondary"
                type="button"
                disabled={isBusy || !selectedMapping || selectedMapping.isEnabled}
                onClick={() => void handleToggleCampaign("activate")}
              >
                활성화
              </button>
              <button
                className="button-shell button-ghost"
                type="button"
                disabled={isBusy || !selectedMapping || !selectedMapping.isEnabled}
                onClick={() => void handleToggleCampaign("deactivate")}
              >
                비활성화
              </button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
