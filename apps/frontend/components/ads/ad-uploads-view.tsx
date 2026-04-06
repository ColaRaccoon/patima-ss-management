"use client";

import Link from "next/link";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import type { AdPreviewDetail, AdUploadsPageData } from "@/lib/api/types";
import { formatCurrency, formatDate, formatDateTime, formatNullableText, formatNumber } from "@/lib/format";
import { toneForWeekdayValidation } from "@/lib/status-tone";

const FILE_SLOT_COUNT = 3;

function toneForMappingStatus(status: "MAPPED" | "UNMAPPED" | "CONFLICT") {
  if (status === "MAPPED") {
    return "success" as const;
  }
  if (status === "CONFLICT") {
    return "danger" as const;
  }
  return "warning" as const;
}

function createEmptyFileSlots() {
  return Array.from({ length: FILE_SLOT_COUNT }, () => null as File | null);
}

function summarizePreviewRows(rows: AdPreviewDetail["rows"]) {
  const mappedRows = rows.filter((row) => row.mappingStatus === "MAPPED");
  const conflictRows = rows.filter((row) => row.mappingStatus === "CONFLICT");
  const intentionalRows = rows.filter((row) => row.mappingReason === "INTENTIONALLY_UNMAPPED");
  const unmappedRows = rows.filter(
    (row) => row.mappingStatus === "UNMAPPED" && row.mappingReason !== "INTENTIONALLY_UNMAPPED",
  );

  return {
    mappedCost: mappedRows.reduce((total, row) => total + row.totalCost, 0),
    unmappedCost: unmappedRows.reduce((total, row) => total + row.totalCost, 0),
    conflictCost: conflictRows.reduce((total, row) => total + row.totalCost, 0),
    intentionalCost: intentionalRows.reduce((total, row) => total + row.totalCost, 0),
  };
}

export function AdUploadsView({ data }: { data: AdUploadsPageData }) {
  const router = useRouter();
  const [reportDate, setReportDate] = useState(data.previews[0]?.reportDate ?? "");
  const [selectedFiles, setSelectedFiles] = useState<Array<File | null>>(() => createEmptyFileSlots());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [fileInputSeed, setFileInputSeed] = useState(0);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(data.previews[0]?.uploadId ?? null);
  const [isUploading, setIsUploading] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [deletingUploadId, setDeletingUploadId] = useState<string | null>(null);
  const [isRefreshing, startRefresh] = useTransition();

  useEffect(() => {
    if (data.previews.length === 0) {
      setSelectedPreviewId(null);
      return;
    }

    setSelectedPreviewId((current) =>
      current && data.previews.some((preview) => preview.uploadId === current)
        ? current
        : data.previews[0].uploadId,
    );
  }, [data.previews]);

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="Ad uploads need a primary store."
        description="Create or activate a store before preview and confirm workflows can run."
        actionHref="/settings/stores"
        actionLabel="Open store settings"
      />
    );
  }

  const primaryStore = data.primaryStore;
  const selectedUploadFiles = selectedFiles.filter((file): file is File => file !== null);
  const isDeleting = deletingUploadId !== null;
  const isBusy = isUploading || isConfirming || isDeleting || isRefreshing;
  const activePreview =
    data.previews.find((preview) => preview.uploadId === selectedPreviewId) ??
    data.previews[0] ??
    null;

  const handleDeleteUpload = async (uploadId: string, label: string) => {
    if (!window.confirm(`Delete ${label}?\nThis will remove its preview rows and confirmed ad costs from calculations.`)) {
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);
    setDeletingUploadId(uploadId);
    try {
      const response = await fetch(`/api/ad-uploads/${uploadId}`, {
        method: "DELETE",
      });

      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.message ?? "Failed to delete ad upload.");
      }

      setSuccessMessage(`${label} deleted. Reloading upload history.`);
      startRefresh(() => {
        router.refresh();
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete upload.");
    } finally {
      setDeletingUploadId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Ad Uploads"
        title="DA upload previews"
        description="Upload up to three files for the same reportDate, review each preview, and confirm them one by one."
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
              Create previews
            </button>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <Panel
          title="Upload files"
          description="Pick the same reportDate once, then attach up to three `.xlsx` files. Leave unused slots empty."
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

              if (selectedUploadFiles.length === 0) {
                setErrorMessage("Select at least one .xlsx file.");
                return;
              }

              setIsUploading(true);
              try {
                const successes: string[] = [];
                const failures: string[] = [];

                for (const file of selectedUploadFiles) {
                  const formData = new FormData();
                  formData.append("storeId", primaryStore.id);
                  formData.append("reportDate", reportDate);
                  formData.append("file", file);

                  const response = await fetch("/api/ad-uploads/preview", {
                    method: "POST",
                    body: formData,
                  });

                  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
                  if (!response.ok) {
                    failures.push(`${file.name}: ${payload?.message ?? "Failed to create preview."}`);
                    continue;
                  }

                  successes.push(file.name);
                }

                if (successes.length > 0) {
                  setSuccessMessage(`${successes.length} preview(s) created. Reloading pending previews.`);
                  setSelectedFiles(createEmptyFileSlots());
                  setFileInputSeed((value) => value + 1);
                  startRefresh(() => {
                    router.refresh();
                  });
                }

                if (failures.length > 0) {
                  setErrorMessage(failures.join(" / "));
                }
              } catch (error) {
                setErrorMessage(error instanceof Error ? error.message : "Failed to upload preview files.");
              } finally {
                setIsUploading(false);
              }
            }}
          >
            <div className="grid gap-4 xl:grid-cols-4">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">reportDate</span>
                <input
                  className="input-shell"
                  type="date"
                  value={reportDate}
                  onChange={(event) => setReportDate(event.target.value)}
                />
              </label>
              {selectedFiles.map((selectedFile, index) => (
                <label className="block" key={`file-slot-${index}`}>
                  <span className="mb-2 block text-sm font-medium text-ink">xlsx file {index + 1}</span>
                  <input
                    key={`file-input-${index}-${fileInputSeed}`}
                    className="input-shell"
                    type="file"
                    accept=".xlsx"
                    onChange={(event) => {
                      const nextFile = event.target.files?.[0] ?? null;
                      setSelectedFiles((current) =>
                        current.map((file, fileIndex) => (fileIndex === index ? nextFile : file)),
                      );
                    }}
                  />
                  <span className="mt-2 block text-xs text-ink/55">
                    {selectedFile ? selectedFile.name : "Leave blank if you need fewer files."}
                  </span>
                </label>
              ))}
            </div>

            {selectedUploadFiles.length > 0 ? (
              <p className="mt-3 text-sm text-ink/65">
                Selected files: {selectedUploadFiles.map((file) => file.name).join(", ")}
              </p>
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
            One date can keep multiple active confirmed uploads now.
            Duplicate campaignIds are still blocked against active confirmed uploads and within each file.
          </div>
        </Panel>

        <Panel
          title="Pending previews"
          description="Each uploaded file becomes its own preview card. Review, confirm, or delete mistaken duplicates one by one."
        >
          {data.previews.length > 0 ? (
            <div className="space-y-4">
              {data.previews.map((preview) => {
                const previewStats = summarizePreviewRows(preview.rows);
                const isSelected = activePreview?.uploadId === preview.uploadId;
                const hasPreviewConflict = preview.mappingPreviewSummary.conflictCount > 0;
                const previewLabel = preview.originalFileName ?? preview.uploadId;

                return (
                  <div
                    key={preview.uploadId}
                    className={`rounded-2xl border px-4 py-4 ${
                      isSelected ? "border-emerald-400 bg-emerald-50/70" : "border-black/10 bg-white/70"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-ink">{previewLabel}</p>
                        <p className="mt-1 text-xs text-ink/55">
                          {formatDate(preview.reportDate)} / {preview.uploadId}
                        </p>
                      </div>
                      <div className="space-y-1 text-right">
                        <StatusBadge tone={toneForWeekdayValidation(preview.weekdayValidationStatus)}>
                          {preview.weekdayValidationStatus}
                        </StatusBadge>
                        <p className="text-xs text-ink/55">
                          Uploaded {formatNullableText(preview.createdAt ? formatDateTime(preview.createdAt) : null)}
                        </p>
                        <p className="text-xs text-ink/55">
                          Expires {formatDateTime(preview.previewExpiresAt)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <StatCard
                        label="Mapped"
                        value={formatNumber(preview.mappingPreviewSummary.mappedCount)}
                        hint={formatCurrency(previewStats.mappedCost)}
                        tone="success"
                      />
                      <StatCard
                        label="Unmapped"
                        value={formatNumber(preview.mappingPreviewSummary.unmappedCount)}
                        hint={formatCurrency(previewStats.unmappedCost)}
                        tone="warning"
                      />
                      <StatCard
                        label="Conflict"
                        value={formatNumber(preview.mappingPreviewSummary.conflictCount)}
                        hint={formatCurrency(previewStats.conflictCost)}
                        tone="danger"
                      />
                      <StatCard
                        label="Rows"
                        value={formatNumber(preview.rowCount)}
                        hint={`${formatNumber(preview.activeConfirmedUploadCount)} active confirmed on this date`}
                        tone="muted"
                      />
                    </div>

                    {hasPreviewConflict ? (
                      <div className="mt-4 rounded-2xl border border-red-300/40 bg-red-100/70 px-4 py-4 text-sm leading-6 text-red-800">
                        <p className="font-semibold">Conflict rows will be excluded if you confirm this preview.</p>
                        <p className="mt-1">
                          {formatNumber(preview.mappingPreviewSummary.conflictCount)} rows / {formatCurrency(previewStats.conflictCost)}
                        </p>
                      </div>
                    ) : null}

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="text-sm leading-6 text-ink/65">
                        <p>Detected weekday {formatNullableText(preview.detectedWeekday)}</p>
                        <p>Same-date active confirmed uploads {formatNumber(preview.activeConfirmedUploadCount)}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="button-shell button-secondary"
                          type="button"
                          onClick={() => setSelectedPreviewId(preview.uploadId)}
                        >
                          View rows
                        </button>
                        <button
                          className="button-shell button-primary"
                          type="button"
                          disabled={isBusy || preview.weekdayValidationStatus !== "PASSED"}
                          onClick={async () => {
                            setErrorMessage(null);
                            setSuccessMessage(null);
                            setIsConfirming(true);
                            try {
                              const response = await fetch(`/api/ad-uploads/${preview.uploadId}/confirm`, {
                                method: "POST",
                              });

                              const payload = (await response.json().catch(() => null)) as { message?: string } | null;
                              if (!response.ok) {
                                throw new Error(payload?.message ?? "Failed to confirm ad upload preview.");
                              }

                              setSuccessMessage(`${previewLabel} confirmed. Reloading upload history.`);
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
                        <button
                          className="button-shell button-ghost text-red-700 hover:bg-red-50"
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleDeleteUpload(preview.uploadId, previewLabel)}
                        >
                          {deletingUploadId === preview.uploadId ? "Deleting..." : "Delete upload"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-ink/60">No pending previews yet. Upload one to three files for the same date to start.</p>
          )}
        </Panel>
      </div>

      <Panel
        title="Upload history"
        description="Multiple confirmed uploads can stay active for the same report date, and you can manually delete mistaken duplicates."
      >
        <DataTable
          caption="Upload history"
          columns={[
            {
              key: "file",
              title: "File",
              render: (row) => (
                <div>
                  <p className="font-semibold text-ink">{row.originalFileName ?? row.uploadId}</p>
                  <p className="mt-1 text-xs text-ink/55">
                    {row.createdAt ? formatDateTime(row.createdAt) : "Created time unavailable"}
                  </p>
                </div>
              ),
            },
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
                  <p className="mt-1 text-xs text-ink/55">{row.isActive ? "ACTIVE" : "INACTIVE"}</p>
                </div>
              ),
            },
            {
              key: "actions",
              title: "Actions",
              render: (row) =>
                row.uploadStatus === "DELETED" ? (
                  <span className="text-xs text-ink/45">Already deleted</span>
                ) : (
                  <button
                    className="button-shell button-ghost text-red-700 hover:bg-red-50"
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleDeleteUpload(row.uploadId, row.originalFileName ?? row.uploadId)}
                  >
                    {deletingUploadId === row.uploadId ? "Deleting..." : "Delete"}
                  </button>
                ),
            },
          ]}
          rows={data.uploads}
          getRowKey={(row) => row.uploadId}
        />
      </Panel>

      <Panel
        title="Selected Preview Rows"
        description="Choose a pending preview above to inspect row-level mapping results before confirming it."
      >
        {activePreview ? (
          <DataTable
            caption={`Preview rows for ${activePreview.originalFileName ?? activePreview.uploadId}`}
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
                    <p className="mt-2 text-xs text-ink/55">
                      {row.canonicalDisplayName ?? row.reasonNote ?? "No mapped sales unit"}
                    </p>
                  </div>
                ),
              },
            ]}
            rows={activePreview.rows}
            getRowKey={(row) => `${activePreview.uploadId}-${row.rowNo}-${row.campaignId}`}
          />
        ) : (
          <p className="text-sm text-ink/60">Select a pending preview above to inspect its rows.</p>
        )}
      </Panel>
    </div>
  );
}
