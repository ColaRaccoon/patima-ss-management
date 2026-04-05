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
    displayName: "",
    matchAliasesText: "",
    memo: "",
  };
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

function emptyCampaignDraft(defaultSalesUnitId = "") {
  return {
    canonicalSalesUnitId: defaultSalesUnitId,
    campaignPattern: "",
  };
}

function toneForMappingStatus(status: "MAPPED" | "UNMAPPED" | "CONFLICT") {
  if (status === "MAPPED") {
    return "success" as const;
  }
  if (status === "CONFLICT") {
    return "danger" as const;
  }
  return "warning" as const;
}

function pickDefaultAdCostId(adCosts: MappingsPageData["adCosts"]) {
  return (
    adCosts.find((item) => item.mappingStatus === "CONFLICT")?.id ??
    adCosts.find((item) => item.mappingStatus === "UNMAPPED")?.id ??
    adCosts[0]?.id ??
    null
  );
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
  const conflictSignatureCount = data.signatures.filter((signature) => signature.mappingStatus === "CONFLICT").length;
  const conflictAdCostCount = data.adCosts.filter((adCost) => adCost.mappingStatus === "CONFLICT").length;

  useEffect(() => {
    if (selectedSignature) {
      const suggestedAliases = [
        selectedSignature.rawProductNameSnapshot,
        [selectedSignature.rawProductNameSnapshot, selectedSignature.rawOptionInfoSnapshot]
          .filter(Boolean)
          .join(" "),
        selectedSignature.sourceSignature,
      ].filter(Boolean);

      setSignatureSalesUnitId(
        selectedSignature.canonicalSalesUnitId ?? data.salesUnits[0]?.id ?? "",
      );
      setSignatureDraft({
        displayName:
          selectedSignature.canonicalDisplayName ??
          [selectedSignature.rawProductNameSnapshot, selectedSignature.rawOptionInfoSnapshot]
            .filter(Boolean)
            .join(" / "),
        matchAliasesText: aliasesToText(parseAliases(suggestedAliases.join("\n"))),
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
        title="Mappings need a store first."
        description="Order signatures and ad campaigns are grouped by the primary store."
        actionHref="/settings/stores"
        actionLabel="Open store settings"
      />
    );
  }

  const primaryStore = data.primaryStore;

  function refreshWithMessage(target: "order" | "campaign" | "ad-cost", message: string) {
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
      setOrderError("Select a sales unit first.");
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

      refreshWithMessage("order", "Order mapping saved.");
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : "Failed to save order mapping.");
    } finally {
      setIsSavingOrder(false);
    }
  }

  async function handleCreateAndMap() {
    if (!selectedSignature) {
      setOrderError("Select an order signature first.");
      return;
    }

    if (!signatureDraft.displayName.trim()) {
      setOrderError("displayName is required.");
      return;
    }

    const matchAliases = parseAliases(signatureDraft.matchAliasesText);
    if (!matchAliases.length) {
      setOrderError("Add at least one match alias.");
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
          displayName: signatureDraft.displayName.trim(),
          matchAliases,
          memo: signatureDraft.memo.trim() || null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Failed to create and map sales unit.");
      }

      refreshWithMessage("order", "Created a sales unit and mapped the signature.");
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : "Failed to create and map sales unit.");
    } finally {
      setIsSavingOrder(false);
    }
  }

  async function handleSaveCampaign() {
    if (!campaignDraft.canonicalSalesUnitId || !campaignDraft.campaignPattern.trim()) {
      setCampaignError("Select a sales unit and enter a campaign pattern.");
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
        selectedMapping ? "Campaign mapping updated." : "Campaign mapping created.",
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
        nextAction === "activate" ? "Campaign mapping activated." : "Campaign mapping deactivated.",
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
      setAdCostError("Enter a reason note first.");
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

      refreshWithMessage("ad-cost", "Marked the ad row as intentionally unmapped.");
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
      setAdCostError("Select a sales unit first.");
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

      refreshWithMessage("ad-cost", "Saved the ad cost mapping.");
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

      refreshWithMessage("ad-cost", "Recalculated the ad cost mapping.");
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
        title="Order and ad mappings"
        description="Review source signatures, create sales units quickly, and resolve ad mapping conflicts in one place."
        actions={
          <>
            <Link className="button-shell button-secondary" href="/sales-units">
              Open sales units
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
              New campaign rule
            </button>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      {conflictSignatureCount > 0 || conflictAdCostCount > 0 ? (
        <div className="rounded-2xl border border-red-300/40 bg-red-100/70 px-4 py-4 text-sm leading-6 text-red-800">
          <p className="font-semibold">CONFLICT items require manual review.</p>
          <p className="mt-1">
            Order signatures {formatNumber(conflictSignatureCount)} / Ad rows {formatNumber(conflictAdCostCount)}
          </p>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <Panel
          title="Order signatures"
          description="Pick an existing sales unit or create a new one with aliases that will be used by auto-mapping."
        >
          <DataTable
            caption="Order signatures"
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
                title: "Source",
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
                title: "Usage",
                render: (row) => formatNumber(row.usageCount),
              },
              {
                key: "mapping",
                title: "Status",
                render: (row) => (
                  <div>
                    <StatusBadge tone={toneForMappingStatus(row.mappingStatus)}>
                      {row.mappingStatus}
                    </StatusBadge>
                    <p className="mt-2 text-sm text-ink/65">
                      {row.canonicalDisplayName ?? "Unmapped"}
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
          title="Quick create"
          description="Create a sales unit using displayName, matchAliases, and memo, then map the selected signature immediately."
        >
          {selectedSignature ? (
            <div className="space-y-4">
              <div className="rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
                <p className="font-semibold text-ink">{selectedSignature.sourceSignature}</p>
                <p>
                  {selectedSignature.rawProductNameSnapshot} /{" "}
                  {formatNullableText(selectedSignature.rawOptionInfoSnapshot)}
                </p>
                <div className="mt-3">
                  <StatusBadge tone={toneForMappingStatus(selectedSignature.mappingStatus)}>
                    {selectedSignature.mappingStatus}
                  </StatusBadge>
                </div>
              </div>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">Map to existing sales unit</span>
                <select
                  className="input-shell"
                  value={signatureSalesUnitId}
                  onChange={(event) => setSignatureSalesUnitId(event.target.value)}
                >
                  <option value="">Select</option>
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
                Save existing mapping
              </button>

              <div className="rounded-2xl border border-ink/10 p-4">
                <p className="mb-4 text-sm font-medium text-ink">Create a new sales unit and map it now</p>
                <div className="space-y-3">
                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-ink">displayName</span>
                    <input
                      className="input-shell"
                      value={signatureDraft.displayName}
                      onChange={(event) =>
                        setSignatureDraft((current) => ({
                          ...current,
                          displayName: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-ink">matchAliases</span>
                    <textarea
                      className="input-shell min-h-32"
                      value={signatureDraft.matchAliasesText}
                      onChange={(event) =>
                        setSignatureDraft((current) => ({
                          ...current,
                          matchAliasesText: event.target.value,
                        }))
                      }
                      placeholder={"one alias per line\ncomma also works"}
                    />
                  </label>

                  <p className="text-xs leading-5 text-ink/55">
                    displayName is for UI only. Auto-mapping uses matchAliases only.
                  </p>

                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-ink">memo</span>
                    <textarea
                      className="input-shell min-h-24"
                      value={signatureDraft.memo}
                      onChange={(event) =>
                        setSignatureDraft((current) => ({
                          ...current,
                          memo: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <button
                    className="button-shell button-secondary"
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleCreateAndMap()}
                  >
                    Create and map
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
            <p className="text-sm text-ink/60">No order signature selected.</p>
          )}
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <Panel
          title="Ad cost rows"
          description="Conflict rows are surfaced first so they can be reviewed before profit totals are trusted."
        >
          <DataTable
            caption="Ad cost rows"
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
                title: "Campaign",
                render: (row) => (
                  <div>
                    <p className="font-semibold text-ink">{row.campaignName}</p>
                    <p className="mt-1 text-xs text-ink/55">{formatDate(row.reportDate)}</p>
                  </div>
                ),
              },
              {
                key: "cost",
                title: "Cost",
                render: (row) => formatCurrency(row.totalCost),
              },
              {
                key: "mappingReason",
                title: "Status",
                render: (row) => (
                  <div>
                    <StatusBadge tone={toneForMappingStatus(row.mappingStatus)}>
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
                title: "Sales unit",
                render: (row) => row.canonicalDisplayName ?? "Unmapped",
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
              Hide zero-cost rows
            </label>
            {hideZeroCostAdRows && hiddenZeroCostCount > 0 ? (
              <p className="text-sm text-ink/55">{formatNumber(hiddenZeroCostCount)} hidden</p>
            ) : null}
          </div>
        </Panel>

        <Panel
          title="Ad mapping actions"
          description="Resolve conflicts with a manual mapping, recalculate from rules, or mark the row as intentionally unmapped."
        >
          {selectedAdCost ? (
            <div className="space-y-4">
              <div className="rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
                <p className="font-semibold text-ink">{selectedAdCost.campaignName}</p>
                <p>Cost {formatCurrency(selectedAdCost.totalCost)}</p>
                <div className="mt-3">
                  <StatusBadge tone={toneForMappingStatus(selectedAdCost.mappingStatus)}>
                    {selectedAdCost.mappingStatus}
                  </StatusBadge>
                </div>
                <p className="mt-2">{selectedAdCost.mappingReason ?? "RULE_MATCHED"}</p>
              </div>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">Sales unit</span>
                <select
                  className="input-shell"
                  value={adCostSalesUnitId}
                  onChange={(event) => setAdCostSalesUnitId(event.target.value)}
                >
                  <option value="">Select</option>
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
                  Save manual mapping
                </button>
                <button
                  className="button-shell button-ghost"
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleRecalculateAdCostMapping()}
                >
                  Recalculate
                </button>
              </div>

              <textarea
                className="input-shell min-h-28"
                value={intentionalReason}
                onChange={(event) => setIntentionalReason(event.target.value)}
                placeholder="Reason note"
              />

              <button
                className="button-shell button-primary"
                type="button"
                disabled={isBusy}
                onClick={() => void handleIntentionalUnmapped()}
              >
                Mark intentionally unmapped
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
            <p className="text-sm text-ink/60">No ad row selected.</p>
          )}
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        <Panel
          title="Campaign rules"
          description="Active rules are applied before alias fallback logic."
        >
          <DataTable
            caption="Campaign rules"
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
                title: "Pattern",
                render: (row) => (
                  <div>
                    <p className="font-semibold text-ink">{row.campaignPattern}</p>
                    <p className="mt-1 text-xs text-ink/55">{row.normalizedCampaignPattern}</p>
                  </div>
                ),
              },
              {
                key: "salesUnit",
                title: "Sales unit",
                render: (row) => row.canonicalDisplayName,
              },
              {
                key: "enabled",
                title: "State",
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
          title={selectedMapping ? "Edit campaign rule" : "New campaign rule"}
          description="Create a new contains rule or update the currently selected one."
        >
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-ink">Sales unit</span>
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
                <option value="">Select</option>
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
                {selectedMapping ? "Save changes" : "Create rule"}
              </button>
              <button
                className="button-shell button-secondary"
                type="button"
                disabled={isBusy || !selectedMapping || selectedMapping.isEnabled}
                onClick={() => void handleToggleCampaign("activate")}
              >
                Activate
              </button>
              <button
                className="button-shell button-ghost"
                type="button"
                disabled={isBusy || !selectedMapping || !selectedMapping.isEnabled}
                onClick={() => void handleToggleCampaign("deactivate")}
              >
                Deactivate
              </button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
