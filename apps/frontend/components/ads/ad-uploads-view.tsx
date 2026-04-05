"use client";

import Link from "next/link";
import { useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import type { AdUploadsPageData } from "@/lib/api/types";
import { formatCurrency, formatDate, formatDateTime, formatNullableText, formatNumber } from "@/lib/format";
import { toneForWeekdayValidation } from "@/lib/status-tone";

function toneForMappingStatus(status: "MAPPED" | "UNMAPPED" | "CONFLICT") {
  if (status === "MAPPED") {
    return "success" as const;
  }
  if (status === "CONFLICT") {
    return "danger" as const;
  }
  return "warning" as const;
}

export function AdUploadsView({ data }: { data: AdUploadsPageData }) {
  const router = useRouter();
  const [reportDate, setReportDate] = useState(data.preview?.reportDate ?? "");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(Boolean(data.preview?.replaceCandidateUploadId));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();

  const previewStats = useMemo(() => {
    const mappedRows = data.previewRows.filter((row) => row.mappingStatus === "MAPPED");
    const conflictRows = data.previewRows.filter((row) => row.mappingStatus === "CONFLICT");
    const intentionalRows = data.previewRows.filter(
      (row) => row.mappingReason === "INTENTIONALLY_UNMAPPED",
    );
    const unmappedRows = data.previewRows.filter(
      (row) => row.mappingStatus === "UNMAPPED" && row.mappingReason !== "INTENTIONALLY_UNMAPPED",
    );

    return {
      mappedCost: mappedRows.reduce((total, row) => total + row.totalCost, 0),
      unmappedCost: unmappedRows.reduce((total, row) => total + row.totalCost, 0),
      conflictCost: conflictRows.reduce((total, row) => total + row.totalCost, 0),
      intentionalCost: intentionalRows.reduce((total, row) => total + row.totalCost, 0),
    };
  }, [data.previewRows]);

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="Ad uploads need a primary store."
        description="Create or activate a store before preview, replace, and confirm workflows can run."
        actionHref="/settings/stores"
        actionLabel="Open store settings"
      />
    );
  }

  const primaryStore = data.primaryStore;
  const isBusy = isUploading || isConfirming || isRefreshing;
  const hasPreviewConflict = (data.preview?.mappingPreviewSummary.conflictCount ?? 0) > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Ad Uploads"
        title="DA upload preview"
        description="Preview first, confirm only after the mapping summary looks safe, and replace older uploads deliberately."
        actions={
          <>
            <Link className="button-shell button-secondary" href="/mappings">
              Open mappings
            </Link>
            <button
              className="button-shell button-primary"
              type="submit"
              form="ad-upload-form"
              disabled={isBusy}
            >
              Create preview
            </button>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <Panel
          title="Upload file"
          description="Use the `.xlsx` export first, then review preview counts and excluded cost before confirming."
        >
          <form
            id="ad-upload-form"
            onSubmit={async (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setErrorMessage(null);
              setSuccessMessage(null);

              if (!reportDate.trim()) {
                setErrorMessage("reportDate is required.");
                return;
              }

              if (!selectedFile) {
                setErrorMessage("Select an .xlsx file first.");
                return;
              }

              const formData = new FormData();
              formData.append("storeId", primaryStore.id);
              formData.append("reportDate", reportDate);
              formData.append("file", selectedFile);

              setIsUploading(true);
              try {
                const response = await fetch("/api/ad-uploads/preview", {
                  method: "POST",
                  body: formData,
                });

                const payload = (await response.json().catch(() => null)) as { message?: string } | null;
                if (!response.ok) {
                  throw new Error(payload?.message ?? "Failed to create ad upload preview.");
                }

                setSuccessMessage("Preview created. Reloading the latest preview rows.");
                setSelectedFile(null);
                setFileInputKey((value) => value + 1);
                startRefresh(() => {
                  router.refresh();
                });
              } catch (error) {
                setErrorMessage(error instanceof Error ? error.message : "Failed to upload preview file.");
              } finally {
                setIsUploading(false);
              }
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">reportDate</span>
                <input
                  className="input-shell"
                  type="date"
                  value={reportDate}
                  onChange={(event) => setReportDate(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">xlsx file</span>
                <input
                  key={fileInputKey}
                  className="input-shell"
                  type="file"
                  accept=".xlsx"
                  onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                />
              </label>
            </div>

            {selectedFile ? (
              <p className="mt-3 text-sm text-ink/65">Selected file: {selectedFile.name}</p>
            ) : null}

            {errorMessage ? (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {errorMessage}
              </div>
            ) : null}

            {successMessage ? (
              <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {successMessage}
              </div>
            ) : null}
          </form>

          <div className="mt-4 rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
            If rules or overrides change after preview creation, recreate the preview before confirming.
          </div>
        </Panel>

        <Panel
          title="Current preview"
          description="Only the newest preview for a date should be confirmed."
        >
          {data.preview ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <StatusBadge tone={toneForWeekdayValidation(data.preview.weekdayValidationStatus)}>
                  {data.preview.weekdayValidationStatus}
                </StatusBadge>
                <p className="text-xs text-ink/55">
                  Expires {formatDateTime(data.preview.previewExpiresAt)}
                </p>
              </div>

              <div className="rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
                <p>Detected weekday {formatNullableText(data.preview.detectedWeekday)}</p>
                <p>Replace target {formatNullableText(data.preview.replaceCandidateUploadId)}</p>
                <p>Rows {formatNumber(data.preview.rowCount)}</p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <StatCard
                  label="Mapped"
                  value={formatNumber(data.preview.mappingPreviewSummary.mappedCount)}
                  hint={formatCurrency(previewStats.mappedCost)}
                  tone="success"
                />
                <StatCard
                  label="Unmapped"
                  value={formatNumber(data.preview.mappingPreviewSummary.unmappedCount)}
                  hint={formatCurrency(previewStats.unmappedCost)}
                  tone="warning"
                />
                <StatCard
                  label="Conflict"
                  value={formatNumber(data.preview.mappingPreviewSummary.conflictCount)}
                  hint={formatCurrency(previewStats.conflictCost)}
                  tone="danger"
                />
                <StatCard
                  label="Intentional"
                  value={formatNumber(data.preview.mappingPreviewSummary.intentionallyUnmappedCount)}
                  hint={formatCurrency(previewStats.intentionalCost)}
                  tone="muted"
                />
              </div>

              {hasPreviewConflict ? (
                <div className="rounded-2xl border border-red-300/40 bg-red-100/70 px-4 py-4 text-sm leading-6 text-red-800">
                  <p className="font-semibold">Conflict rows will be excluded if you confirm this upload.</p>
                  <p className="mt-1">
                    {formatNumber(data.preview.mappingPreviewSummary.conflictCount)} rows / {formatCurrency(previewStats.conflictCost)}
                  </p>
                </div>
              ) : null}

              {data.preview.replaceCandidateUploadId ? (
                <label className="flex items-start gap-3 rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/70">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={confirmReplace}
                    onChange={(event) => setConfirmReplace(event.target.checked)}
                  />
                  <span>
                    Replace the currently active upload for this date.
                    <br />
                    Target {data.preview.replaceCandidateUploadId}
                  </span>
                </label>
              ) : null}

              <button
                className="button-shell button-primary"
                type="button"
                disabled={
                  isBusy ||
                  data.preview.weekdayValidationStatus !== "PASSED" ||
                  (Boolean(data.preview.replaceCandidateUploadId) && !confirmReplace)
                }
                onClick={async () => {
                  setErrorMessage(null);
                  setSuccessMessage(null);
                  setIsConfirming(true);
                  try {
                    const response = await fetch(`/api/ad-uploads/${data.preview!.uploadId}/confirm`, {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({ confirmReplace }),
                    });

                    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
                    if (!response.ok) {
                      throw new Error(payload?.message ?? "Failed to confirm ad upload preview.");
                    }

                    setSuccessMessage("Preview confirmed. Reloading upload history.");
                    startRefresh(() => {
                      router.refresh();
                    });
                  } catch (error) {
                    setErrorMessage(error instanceof Error ? error.message : "Failed to confirm preview.");
                  } finally {
                    setIsConfirming(false);
                  }
                }}
              >
                Confirm preview
              </button>
            </div>
          ) : (
            <p className="text-sm text-ink/60">No preview available yet.</p>
          )}
        </Panel>
      </div>

      <Panel
        title="Upload history"
        description="Uploads for the same report date can replace earlier confirmed rows."
      >
        <DataTable
          caption="Upload history"
          columns={[
            {
              key: "reportDate",
              title: "reportDate",
              render: (row) => formatDate(row.reportDate),
            },
            {
              key: "weekday",
              title: "Validation",
              render: (row) => (
                <div>
                  <StatusBadge tone={toneForWeekdayValidation(row.weekdayValidationStatus)}>
                    {row.weekdayValidationStatus}
                  </StatusBadge>
                  <p className="mt-2 text-xs text-ink/55">{formatNullableText(row.detectedWeekday)}</p>
                </div>
              ),
            },
            {
              key: "status",
              title: "Upload state",
              render: (row) => (
                <div>
                  <p className="font-semibold text-ink">{row.uploadStatus}</p>
                  <p className="mt-1 text-xs text-ink/55">
                    {row.isActive ? "ACTIVE" : "INACTIVE"}
                  </p>
                </div>
              ),
            },
            {
              key: "replace",
              title: "Replace target",
              render: (row) => formatNullableText(row.replacedUploadId),
            },
          ]}
          rows={data.uploads}
          getRowKey={(row) => row.uploadId}
        />
      </Panel>

      <Panel
        title="Preview rows"
        description="Preview rows surface conflict status and estimated excluded cost before confirmation."
      >
        <DataTable
          caption="Preview rows"
          columns={[
            {
              key: "campaignName",
              title: "Campaign",
              render: (row) => (
                <div>
                  <p className="font-semibold text-ink">{row.campaignName}</p>
                  <p className="mt-1 text-xs text-ink/55">
                    {row.campaignId} / {formatNullableText(row.weekdayLabel)}
                  </p>
                </div>
              ),
            },
            {
              key: "cost",
              title: "Cost",
              render: (row) => formatCurrency(row.totalCost),
            },
            {
              key: "mapping",
              title: "Mapping",
              render: (row) => (
                <div>
                  <StatusBadge tone={toneForMappingStatus(row.mappingStatus)}>
                    {row.displayMappingState}
                  </StatusBadge>
                  <p className="mt-2 font-medium text-ink">
                    {row.canonicalDisplayName ?? "No sales unit"}
                  </p>
                  <p className="mt-1 text-xs text-ink/55">
                    {row.mappingReason ?? "RULE_MATCHED"} / rules {formatNumber(row.matchedRuleCount)}
                  </p>
                </div>
              ),
            },
            {
              key: "reason",
              title: "Reason note",
              render: (row) =>
                row.reasonNote ? (
                  <div>
                    <p>{row.reasonNote}</p>
                    {row.reasonNoteInherited ? (
                      <p className="mt-1 text-xs text-ink/55">Inherited from previous upload</p>
                    ) : null}
                  </div>
                ) : (
                  "-"
                ),
            },
          ]}
          rows={data.previewRows}
          getRowKey={(row) => `${row.campaignId}-${row.rowNo}`}
        />
      </Panel>
    </div>
  );
}
