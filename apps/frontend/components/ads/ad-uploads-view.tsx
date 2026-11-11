"use client";

import Link from "next/link";
import { useRef, useState, useTransition, type FormEvent } from "react";
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
import { readApiResponse } from "@/lib/api/browser";
import { uploadAdFiles } from "@/lib/api/ad-upload-batch";

const validationLabels = {
  PENDING: "검증 대기", PASSED: "통과", MISSING: "요일 누락", MULTIPLE: "요일 혼재", MISMATCH: "요일 불일치",
};
const uploadLabels = {
  PREVIEW_PARSED: "검토 대기", CONFIRMED: "확정", FAILED: "실패", REPLACED: "대체됨", EXPIRED: "만료", DELETED: "삭제됨",
};

export function AdUploadsView({ data }: { data: AdUploadsPageData }) {
  return <StoreAdUploadsView key={data.primaryStore?.id ?? "no-store"} data={data} />;
}

function StoreAdUploadsView({ data }: { data: AdUploadsPageData }) {
  const router = useRouter();
  const [reportDate, setReportDate] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [fileInputSeed, setFileInputSeed] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingUploadId, setDeletingUploadId] = useState<string | null>(null);
  const [isRefreshing, startRefresh] = useTransition();
  const mutationInFlight = useRef(false);
  const [uploadProgress, setUploadProgress] = useState({ completed: 0, total: 0 });
  const [isRetry, setIsRetry] = useState(false);

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="광고 업로드를 시작하려면 스토어가 필요합니다."
        description="스토어를 생성하거나 활성화한 후 광고 파일을 업로드하세요."
        actionHref="/settings/stores"
        actionLabel="스토어 설정 열기"
      />
    );
  }

  const primaryStore = data.primaryStore;
  const mappingsHref = buildHrefWithStore("/mappings", null, primaryStore.id);
  const isDeleting = deletingUploadId !== null;
  const isBusy = isUploading || isDeleting || isRefreshing;

  const handleDeleteUpload = async (uploadId: string, label: string) => {
    if (mutationInFlight.current || isRefreshing) return;
    if (!window.confirm(`${label} 파일을 삭제할까요?\n이 파일의 확정 광고비가 손익 계산에서 제외됩니다.`)) {
      return;
    }

    mutationInFlight.current = true;
    setErrorMessage(null);
    setSuccessMessage(null);
    setDeletingUploadId(uploadId);
    try {
      await readApiResponse(
        await fetch(`/api/ad-uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" }),
        "광고 파일 삭제에 실패했습니다.",
      );

      setSuccessMessage(`${label} 파일을 삭제했습니다.`);
      startRefresh(() => {
        router.refresh();
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "광고 파일 삭제에 실패했습니다.");
    } finally {
      mutationInFlight.current = false;
      setDeletingUploadId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Ad Uploads"
        title="DA 광고 업로드"
        description="같은 보고일의 .xlsx 파일을 여러 개 선택할 수 있습니다. 요일 검증을 통과한 파일은 즉시 적용됩니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href={mappingsHref}>
              매핑 관리
            </Link>
            <button
              className="button-shell button-primary"
              type="submit"
              form="ad-upload-form"
              disabled={isBusy || !reportDate || selectedFiles.length === 0}
            >
              {isUploading ? `업로드 중 ${uploadProgress.completed}/${uploadProgress.total}` : isRetry ? "실패한 파일 다시 업로드" : "업로드"}
            </button>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-6">
        <Panel
          title="광고 파일 업로드"
          description="보고일을 고르고 .xlsx 파일을 선택하세요. 실패한 파일은 선택을 유지하므로 바로 다시 시도할 수 있습니다."
        >
          <form
            id="ad-upload-form"
            onSubmit={async (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (mutationInFlight.current || isRefreshing) return;
              setErrorMessage(null);
              setSuccessMessage(null);

              if (!reportDate.trim()) {
                setErrorMessage("보고일을 선택해 주세요.");
                return;
              }

              if (selectedFiles.length === 0) {
                setErrorMessage(".xlsx 파일을 하나 이상 선택해 주세요.");
                return;
              }

              mutationInFlight.current = true;
              setIsUploading(true);
              try {
                const { succeeded, failed } = await uploadAdFiles({
                  files: selectedFiles,
                  storeId: primaryStore.id,
                  reportDate,
                  onProgress: (completed, total) => setUploadProgress({ completed, total }),
                });
                setSelectedFiles(failed.map(({ file }) => file));
                setIsRetry(failed.length > 0);
                setFileInputSeed((value) => value + 1);

                if (succeeded.length > 0) {
                  setSuccessMessage(`${succeeded.length}개 파일이 업로드되었습니다: ${succeeded.map((file) => file.name).join(", ")}`);
                }
                // A lost response may still have committed; refresh history for every completed batch.
                startRefresh(() => router.refresh());

                if (failed.length > 0) {
                  const failureLines = failed
                    .map((item) => `${item.file.name}: ${item.reason}`)
                    .join("\n");
                  setErrorMessage(`업로드를 확인하지 못한 파일 ${failed.length}개:\n${failureLines}`);
                }
              } catch (error) {
                setErrorMessage(error instanceof Error ? error.message : "광고 파일 업로드에 실패했습니다.");
              } finally {
                mutationInFlight.current = false;
                setIsUploading(false);
              }
            }}
          >
            <div className="grid gap-4 xl:grid-cols-[200px_1fr]">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">보고일</span>
                <input
                  className="input-shell"
                  type="date"
                  required
                  disabled={isBusy}
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
                  disabled={isBusy}
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    setSelectedFiles(files);
                    setIsRetry(false);
                    setErrorMessage(null);
                    setSuccessMessage(null);
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

            {isUploading ? (
              <div className="mt-4 space-y-2" role="status" aria-live="polite">
                <p className="text-sm text-ink/70">{uploadProgress.total}개 중 {uploadProgress.completed}개 처리 완료 · 파일 검증과 손익 반영 중입니다.</p>
                <progress className="h-2 w-full accent-[var(--accent)]" value={uploadProgress.completed} max={uploadProgress.total || 1} aria-label="광고 파일 업로드 진행률" />
              </div>
            ) : null}

            {errorMessage ? (
              <div role="alert" className="mt-4 whitespace-pre-line rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {errorMessage}
              </div>
            ) : null}

            {successMessage ? (
              <div role="status" className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {successMessage}
              </div>
            ) : null}
          </form>

          <div className="mt-4 rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
            같은 보고일에 여러 파일을 누적할 수 있습니다.
            이미 반영된 캠페인이 포함된 파일은 중복으로 반영되지 않습니다. 파일을 교체하려면 아래 이력에서 기존 파일을 삭제한 후 다시 업로드하세요.
          </div>
        </Panel>
      </div>

      <Panel
        title="업로드 이력"
        description="같은 보고일의 확정 파일은 함께 합산됩니다. 삭제하면 해당 파일의 광고비가 손익에서 제외됩니다."
      >
        <DataTable
          caption="광고 업로드 이력"
          columns={[
            {
              key: "file",
              title: "파일",
              render: (row) => (
                <div>
                  <p className="font-semibold text-ink">{row.originalFileName ?? row.uploadId}</p>
                  <p className="mt-1 text-xs text-ink/55">
                    {row.createdAt ? formatDateTime(row.createdAt) : "업로드 시각 없음"}
                  </p>
                </div>
              ),
            },
            {
              key: "reportDate",
              title: "보고일",
              render: (row) => formatDate(row.reportDate),
            },
            {
              key: "weekday",
              title: "요일 검증",
              render: (row) => (
                <div>
                  <StatusBadge tone={toneForWeekdayValidation(row.weekdayValidationStatus)}>
                    {validationLabels[row.weekdayValidationStatus] ?? row.weekdayValidationStatus}
                  </StatusBadge>
                  <p className="mt-2 text-xs text-ink/55">{formatNullableText(row.detectedWeekday)}</p>
                </div>
              ),
            },
            {
              key: "status",
              title: "업로드 상태",
              render: (row) => (
                <div>
                  <p className="font-semibold text-ink">{uploadLabels[row.uploadStatus] ?? row.uploadStatus}</p>
                  <p className="mt-1 text-xs text-ink/55">{row.isActive ? "손익에 반영 중" : "손익에서 제외"}</p>
                </div>
              ),
            },
            {
              key: "actions",
              title: "관리",
              render: (row) =>
                row.uploadStatus === "DELETED" ? (
                  <span className="text-xs text-ink/45">삭제됨</span>
                ) : (
                  <button
                    className="button-shell button-ghost text-red-700 hover:bg-red-50"
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleDeleteUpload(row.uploadId, row.originalFileName ?? row.uploadId)}
                  >
                    {deletingUploadId === row.uploadId ? "삭제 중..." : "삭제"}
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
