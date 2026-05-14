"use client";

import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatusBadge } from "@/components/shared/status-badge";
import type { AdUploadsPageData } from "@/lib/api/types";
import { formatDate, formatDateTime, formatNullableText } from "@/lib/format";
import { toneForWeekdayValidation } from "@/lib/status-tone";
import { buildHrefWithStore } from "@/lib/store-selection";

export function AdUploadsView({ data }: { data: AdUploadsPageData }) {
  const router = useRouter();
  const [reportDate, setReportDate] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [fileInputSeed, setFileInputSeed] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingUploadId, setDeletingUploadId] = useState<string | null>(null);
  const [isRefreshing, startRefresh] = useTransition();

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="Ad uploads need a primary store."
        description="Create or activate a store before uploading ad files."
        actionHref="/settings/stores"
        actionLabel="Open store settings"
      />
    );
  }

  const primaryStore = data.primaryStore;
  const mappingsHref = buildHrefWithStore("/mappings", null, primaryStore.id);
  const isDeleting = deletingUploadId !== null;
  const isBusy = isUploading || isDeleting || isRefreshing;

  const handleDeleteUpload = async (uploadId: string, label: string) => {
    if (!window.confirm(`Delete ${label}?\nThis will remove its confirmed ad costs from calculations.`)) {
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
        title="DA 광고 업로드"
        description="같은 reportDate에 대해 .xlsx 파일을 한 번에 여러 개 선택해서 업로드합니다. 요일 검증을 통과한 파일은 즉시 적용됩니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href={mappingsHref}>
              Open mappings
            </Link>
            <button
              className="button-shell button-primary"
              type="submit"
              form="ad-upload-form"
              disabled={isBusy}
            >
              Upload
            </button>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <Panel
          title="Upload files"
          description="reportDate를 한 번 고른 뒤, .xlsx 파일을 원하는 개수만큼 한 번에 선택하세요."
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

              if (selectedFiles.length === 0) {
                setErrorMessage("Select at least one .xlsx file.");
                return;
              }

              setIsUploading(true);
              try {
                const succeeded: string[] = [];
                const failed: Array<{ fileName: string; reason: string }> = [];

                for (const file of selectedFiles) {
                  const formData = new FormData();
                  formData.append("storeId", primaryStore.id);
                  formData.append("reportDate", reportDate);
                  formData.append("file", file);

                  const response = await fetch("/api/ad-uploads/preview", {
                    method: "POST",
                    body: formData,
                  });

                  const payload = (await response.json().catch(() => null)) as {
                    message?: string;
                    fileName?: string;
                    weekdayValidationStatus?: string;
                  } | null;

                  if (!response.ok) {
                    failed.push({
                      fileName: file.name,
                      reason: payload?.message ?? "업로드 실패",
                    });
                    continue;
                  }

                  succeeded.push(file.name);
                }

                if (succeeded.length > 0) {
                  setSuccessMessage(`${succeeded.length}개 파일이 업로드되었습니다: ${succeeded.join(", ")}`);
                  setSelectedFiles([]);
                  setFileInputSeed((value) => value + 1);
                  startRefresh(() => {
                    router.refresh();
                  });
                }

                if (failed.length > 0) {
                  const failureLines = failed
                    .map((item) => `${item.fileName}: ${item.reason}`)
                    .join("\n");
                  setErrorMessage(`불통과 파일:\n${failureLines}`);
                }
              } catch (error) {
                setErrorMessage(error instanceof Error ? error.message : "Failed to upload files.");
              } finally {
                setIsUploading(false);
              }
            }}
          >
            <div className="grid gap-4 xl:grid-cols-[200px_1fr]">
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
                <span className="mb-2 block text-sm font-medium text-ink">.xlsx 파일 선택 (여러 개 가능)</span>
                <input
                  key={`file-input-${fileInputSeed}`}
                  className="input-shell"
                  type="file"
                  accept=".xlsx"
                  multiple
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    setSelectedFiles(files);
                  }}
                />
                <span className="mt-2 block text-xs text-ink/55">
                  {selectedFiles.length > 0
                    ? `선택된 파일 ${selectedFiles.length}개`
                    : "Ctrl/Shift로 여러 파일을 한 번에 선택할 수 있습니다."}
                </span>
              </label>
            </div>

            {selectedFiles.length > 0 ? (
              <p className="mt-3 text-sm text-ink/65">
                선택된 파일: {selectedFiles.map((file) => file.name).join(", ")}
              </p>
            ) : null}

            {errorMessage ? (
              <div className="mt-4 whitespace-pre-line rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
            같은 reportDate에 여러 파일을 누적할 수 있습니다.
            실수로 같은 파일을 두 번 업로드한 경우 아래 업로드 히스토리에서 직접 삭제해주세요.
          </div>
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
    </div>
  );
}
