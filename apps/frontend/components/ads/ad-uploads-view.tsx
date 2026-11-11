"use client";

import Link from "next/link";
import { parseAdUploadFileName } from "@patima/shared";
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
  const [uploadMode, setUploadMode] = useState<"auto" | "manual">("auto");
  const [summaryWarning, setSummaryWarning] = useState<string | null>(null);
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
    setSummaryWarning(null);
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
        description="파일명에서 스토어와 날짜를 자동으로 분류합니다. 여러 스토어·날짜의 파일을 함께 선택하거나 직접 지정할 수 있습니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href={mappingsHref}>
              매핑 관리
            </Link>
            <button
              className="button-shell button-primary"
              type="submit"
              form="ad-upload-form"
              disabled={isBusy || (uploadMode === "manual" && !reportDate) || selectedFiles.length === 0}
            >
              {isUploading ? `업로드 중 ${uploadProgress.completed}/${uploadProgress.total}` : isRetry ? "선택한 파일 다시 업로드" : "업로드"}
            </button>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-6">
        <Panel
          title="광고 파일 업로드"
          description={uploadMode === "auto" ? "YYMMDD_인피니티[메인/서브].xlsx 또는 YYMMDD_파티마[메인/서브].xlsx 형식으로 최대 100개, 파일당 10MB까지 선택하세요." : "현재 선택한 스토어와 보고일에 업로드합니다. 파일명 형식과 관계없이 파일별로 검증하고 반영합니다."}
        >
          <form
            id="ad-upload-form"
            onSubmit={async (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (mutationInFlight.current || isRefreshing) return;
              setErrorMessage(null);
              setSuccessMessage(null);

              setSummaryWarning(null);
              if (uploadMode === "manual" && !reportDate.trim()) {
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
                const { succeeded, failed, details } = await uploadAdFiles({
                  files: selectedFiles,
                  mode: uploadMode,
                  ...(uploadMode === "manual" ? { storeId: primaryStore.id, reportDate } : {}),
                  onProgress: (completed, total) => setUploadProgress({ completed, total }),
                });
                setSelectedFiles(failed.map(({ file }) => file));
                setIsRetry(failed.length > 0);
                setFileInputSeed((value) => value + 1);

                if (succeeded.length > 0) {
                  const lines = details
                    ? details.map((item) => `${item.originalFileName} → ${item.storeName} / ${item.reportDate} / ${item.confirmedRowCount}건`)
                    : succeeded.map((file) => `${file.name} → ${primaryStore.name} / ${reportDate}`);
                  setSuccessMessage(`${succeeded.length}개 파일을 업로드했습니다.\n${lines.join("\n")}`);
                  if (details?.some((item) => item.summaryStatus !== "SUCCEEDED")) {
                    setSummaryWarning("광고 파일은 저장됐지만 일부 손익 집계를 갱신하지 못했습니다. 손익 집계를 다시 실행해 주세요.");
                  }
                }
                // A lost response may still have committed; refresh history for every completed batch.
                startRefresh(() => router.refresh());

                if (failed.length > 0) {
                  const failureLines = failed
                    .map((item) => `${item.file.name}: ${item.reason}`)
                    .join("\n");
                  setErrorMessage(uploadMode === "auto"
                    ? failed[0].reason
                    : `업로드를 확인하지 못한 파일 ${failed.length}개:\n${failureLines}`);
                }
              } catch (error) {
                setErrorMessage(error instanceof Error ? error.message : "광고 파일 업로드에 실패했습니다.");
              } finally {
                mutationInFlight.current = false;
                setIsUploading(false);
              }
            }}
          >
            <fieldset disabled={isBusy} className="mb-5">
              <legend className="mb-2 text-sm font-medium text-ink">업로드 방식</legend>
              <div className="flex flex-wrap gap-4">
                {([{ value: "auto", label: "파일명으로 자동 분류" }, { value: "manual", label: "스토어·보고일 직접 지정" }] as const).map(({ value, label }) => (
                  <label key={value} className="flex cursor-pointer items-center gap-2 rounded-xl border border-ink/15 bg-white/70 px-4 py-3 text-sm">
                    <input type="radio" name="ad-upload-mode" value={value} checked={uploadMode === value} onChange={() => {
                      setUploadMode(value);
                      setIsRetry(false);
                      setErrorMessage(null);
                      setSuccessMessage(null);
                      setSummaryWarning(null);
                    }} />
                    {label}
                  </label>
                ))}
              </div>
              <p className="mt-2 text-sm leading-6 text-ink/65">
                {uploadMode === "auto"
                  ? "모든 파일이 검증을 통과하면 함께 반영합니다. 오류가 있으면 선택한 파일 전체를 유지합니다."
                  : `대상 스토어: ${primaryStore.name}. 검증을 통과한 파일은 먼저 반영하고, 실패한 파일만 다시 시도합니다.`}
              </p>
            </fieldset>
            <div className={uploadMode === "manual" ? "grid gap-4 xl:grid-cols-[200px_1fr]" : "grid gap-4"}>
              {uploadMode === "manual" ? <label className="block">
                <span className="mb-2 block text-sm font-medium text-ink">보고일</span>
                <input
                  className="input-shell"
                  type="date"
                  required
                  disabled={isBusy}
                  value={reportDate}
                  onChange={(event) => setReportDate(event.target.value)}
                />
              </label> : null}
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
                    setSummaryWarning(null);
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
              <ul className="mt-3 max-h-64 space-y-1 overflow-auto text-sm text-ink/65" aria-label="선택한 파일과 업로드 대상">
                {selectedFiles.map((file, index) => {
                  const target = uploadMode === "auto" ? parseAdUploadFileName(file.name) : { storeName: primaryStore.name, reportDate };
                  const invalidSize = file.size > 10 * 1024 * 1024 || file.size === 0;
                  return <li key={`${file.name}-${index}`} className={!target || invalidSize ? "text-red-700" : undefined}>
                    {file.name} → {invalidSize ? "파일 크기를 확인하세요 (1바이트~10MB)" : target ? `${target.storeName} / ${target.reportDate || "보고일을 선택하세요"}` : "파일명 또는 날짜를 확인하세요"}
                  </li>;
                })}
              </ul>
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
              <div role="status" className="mt-4 whitespace-pre-line rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {successMessage}
              </div>
            ) : null}
            {summaryWarning ? <p role="alert" className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{summaryWarning}</p> : null}
          </form>

          <div className="mt-4 rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
            같은 스토어·날짜에 이미 반영된 캠페인은 중복 반영하지 않습니다. 파일을 교체하려면 아래 이력에서 기존 파일을 삭제한 후 다시 업로드하세요.
            업로드 이력은 현재 선택한 스토어 기준입니다.
          </div>
        </Panel>
      </div>

      <Panel
        title="업로드 이력"
        description={`현재 선택한 스토어(${primaryStore.name})의 업로드 이력입니다. 삭제하면 해당 파일의 광고비가 손익에서 제외됩니다.`}
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
