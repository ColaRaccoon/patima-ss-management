"use client";

import Link from "next/link";
import { parseAdUploadFileName } from "@patima/shared";
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
        description="파일명에서 스토어와 날짜를 자동으로 분류합니다. 두 스토어의 광고 파일을 함께 선택하세요."
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
          description="YYMMDD_인피니티[메인/서브].xlsx 또는 YYMMDD_파티마[메인/서브].xlsx 형식을 사용하세요."
        >
          <form
            id="ad-upload-form"
            onSubmit={async (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setErrorMessage(null);
              setSuccessMessage(null);

              if (selectedFiles.length === 0) {
                setErrorMessage("Select at least one .xlsx file.");
                return;
              }

              setIsUploading(true);
              try {
                const invalidFiles = selectedFiles.filter((file) => !parseAdUploadFileName(file.name));
                if (invalidFiles.length) throw new Error(`파일명 또는 날짜를 확인하세요: ${invalidFiles.map((file) => file.name).join(", ")}`);
                const formData = new FormData();
                for (const file of selectedFiles) formData.append("files", file);
                const response = await fetch("/api/ad-uploads/batch", { method: "POST", body: formData });
                const payload = (await response.json().catch(() => null)) as {
                  message?: string; fileName?: string;
                  data?: { items: Array<{ originalFileName: string; storeName: string; reportDate: string; confirmedRowCount: number; summaryStatus: string }> };
                } | null;
                if (!response.ok || !payload?.data?.items) {
                  throw new Error(`${payload?.fileName ? `${payload.fileName}: ` : ""}${payload?.message ?? "일괄 업로드에 실패했습니다."}${response.status === 400 ? "\n선택한 파일은 모두 반영되지 않았습니다." : "\n업로드 이력을 확인한 후 다시 시도하세요."}`);
                }
                const items = payload.data.items;
                const details = items.map((item) => `${item.originalFileName} → ${item.storeName} / ${item.reportDate} / ${item.confirmedRowCount}건`).join("\n");
                const warning = items.some((item) => item.summaryStatus !== "SUCCEEDED") ? "\n광고는 저장됐지만 일부 손익 집계를 갱신하지 못했습니다. 손익 집계를 다시 실행하세요." : "";
                setSuccessMessage(`${items.length}개 파일을 업로드했습니다.\n${details}${warning}`);
                setSelectedFiles([]);
                setFileInputSeed((value) => value + 1);
                startRefresh(() => router.refresh());
              } catch (error) {
                setErrorMessage(error instanceof Error ? error.message : "Failed to upload files.");
              } finally {
                setIsUploading(false);
              }
            }}
          >
            <div className="grid gap-4">
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
              <ul className="mt-3 space-y-1 text-sm text-ink/65">
                {selectedFiles.map((file, index) => {
                  const target = parseAdUploadFileName(file.name);
                  return <li key={`${file.name}-${index}`}>{file.name} → {target ? `${target.storeName} / ${target.reportDate}` : "파일명 또는 날짜를 확인하세요"}</li>;
                })}
              </ul>
            ) : null}

            {errorMessage ? (
              <div className="mt-4 whitespace-pre-line rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {errorMessage}
              </div>
            ) : null}

            {successMessage ? (
              <div className="mt-4 whitespace-pre-line rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {successMessage}
              </div>
            ) : null}
          </form>

          <div className="mt-4 rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
            모든 파일의 형식·요일·중복 검증을 통과한 경우에만 함께 반영합니다.
            같은 스토어·날짜의 캠페인 중복은 허용하지 않습니다. 업로드 히스토리는 현재 선택한 스토어 기준으로 표시됩니다.
          </div>
        </Panel>
      </div>

      <Panel
        title="Upload history"
        description="현재 선택한 스토어의 업로드 이력입니다. 같은 날짜에도 캠페인이 겹치지 않는 파일을 추가할 수 있습니다."
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
