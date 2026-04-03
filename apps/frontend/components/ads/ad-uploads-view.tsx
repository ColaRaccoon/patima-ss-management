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
import { formatCurrency, formatDate, formatDateTime, formatNullableText, formatNumber } from "@/lib/format";
import { toneForWeekdayValidation } from "@/lib/status-tone";

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

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="광고 업로드를 하려면 대표 스토어가 필요합니다."
        description="스토어가 생성된 뒤에만 preview, replace, confirm 흐름이 열립니다."
        actionHref="/settings/stores"
        actionLabel="스토어 설정"
      />
    );
  }

  const primaryStore = data.primaryStore;
  const isBusy = isUploading || isConfirming || isRefreshing;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Ad Uploads"
        title="광고 DA 업로드"
        description="업로드는 미리보기 -> 최종 확인 -> 대체 처리 흐름으로 진행합니다. 요일 검증은 보조 장치이며 실제 날짜를 완전 보장하지는 않습니다."
        actions={
          <>
            <Link className="button-shell button-secondary" href="/mappings">
              매핑 관리
            </Link>
            <button
              className="button-shell button-primary"
              type="submit"
              form="ad-upload-form"
              disabled={isBusy}
            >
              새 preview 만들기
            </button>
          </>
        }
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <Panel
          title="업로드 폼"
          description="MVP에서는 요일 상세 열이 있는 .xlsx만 사용합니다."
        >
          <form
            id="ad-upload-form"
            onSubmit={async (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setErrorMessage(null);
              setSuccessMessage(null);

              if (!reportDate.trim()) {
                setErrorMessage("reportDate를 입력해주세요.");
                return;
              }

              if (!selectedFile) {
                setErrorMessage(".xlsx 파일을 먼저 선택해주세요.");
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
                  throw new Error(payload?.message ?? "광고 엑셀 preview 생성에 실패했습니다.");
                }

                setSuccessMessage("preview를 생성했습니다. 아래 결과를 새로 불러옵니다.");
                setSelectedFile(null);
                setFileInputKey((value) => value + 1);
                startRefresh(() => {
                  router.refresh();
                });
              } catch (error) {
                setErrorMessage(error instanceof Error ? error.message : "광고 업로드 중 오류가 발생했습니다.");
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
                <span className="mb-2 block text-sm font-medium text-ink">엑셀 파일 .xlsx</span>
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
              <p className="mt-3 text-sm text-ink/65">선택된 파일: {selectedFile.name}</p>
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
            replace 대상 또는 활성 규칙 집합이 바뀌면 stale preview가 되어 다시 생성해야 합니다.
          </div>
        </Panel>

        <Panel
          title="현재 preview 상태"
          description="최신 preview만 최종 확정 가능하며, 이전 preview는 이력으로만 남습니다."
        >
          {data.preview ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <StatusBadge tone={toneForWeekdayValidation(data.preview.weekdayValidationStatus)}>
                  {data.preview.weekdayValidationStatus}
                </StatusBadge>
                <p className="text-xs text-ink/55">
                  만료 {formatDateTime(data.preview.previewExpiresAt)}
                </p>
              </div>

              <div className="rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/65">
                <p>검출 요일 {formatNullableText(data.preview.detectedWeekday)}</p>
                <p>replace 대상 {formatNullableText(data.preview.replaceCandidateUploadId)}</p>
                <p>mapped {formatNumber(data.preview.mappingPreviewSummary.mappedCount)}건</p>
                <p>unmapped {formatNumber(data.preview.mappingPreviewSummary.unmappedCount)}건</p>
              </div>

              {data.preview.replaceCandidateUploadId ? (
                <label className="flex items-start gap-3 rounded-2xl bg-white/70 px-4 py-4 text-sm leading-6 text-ink/70">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={confirmReplace}
                    onChange={(event) => setConfirmReplace(event.target.checked)}
                  />
                  <span>
                    기존 활성 업로드를 대체하는 것을 확인합니다.
                    <br />
                    대상: {data.preview.replaceCandidateUploadId}
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
                      throw new Error(payload?.message ?? "광고 업로드 확정에 실패했습니다.");
                    }

                    setSuccessMessage("preview를 확정했습니다. 업로드 이력을 새로 불러옵니다.");
                    startRefresh(() => {
                      router.refresh();
                    });
                  } catch (error) {
                    setErrorMessage(
                      error instanceof Error ? error.message : "광고 업로드 확정 중 오류가 발생했습니다.",
                    );
                  } finally {
                    setIsConfirming(false);
                  }
                }}
              >
                preview 확정
              </button>
            </div>
          ) : (
            <p className="text-sm text-ink/60">아직 preview가 없습니다.</p>
          )}
        </Panel>
      </div>

      <Panel
        title="업로드 이력"
        description="동일 reportDate 재업로드는 기존 활성 업로드를 replace합니다."
      >
        <DataTable
          caption="광고 업로드 이력"
          columns={[
            {
              key: "reportDate",
              title: "reportDate",
              render: (row) => formatDate(row.reportDate),
            },
            {
              key: "weekday",
              title: "검증",
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
              title: "업로드 상태",
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
              title: "replace 정보",
              render: (row) => formatNullableText(row.replacedUploadId),
            },
          ]}
          rows={data.uploads}
          getRowKey={(row) => row.uploadId}
        />
      </Panel>

      <Panel
        title="preview row 결과"
        description="캠페인 row만 대상으로 보며, 요일 상세 row는 직전 캠페인 row 보조 정보로만 사용합니다."
      >
        <DataTable
          caption="preview rows"
          columns={[
            {
              key: "campaignName",
              title: "캠페인",
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
              title: "총비용",
              render: (row) => formatCurrency(row.totalCost),
            },
            {
              key: "mapping",
              title: "예상 매핑",
              render: (row) => (
                <div>
                  <p className="font-medium text-ink">
                    {row.canonicalDisplayName ?? row.displayMappingState}
                  </p>
                  <p className="mt-1 text-xs text-ink/55">
                    {row.mappingReason ?? "RULE_MATCHED"} / 규칙 {formatNumber(row.matchedRuleCount)}개
                  </p>
                </div>
              ),
            },
            {
              key: "reason",
              title: "사유 메모",
              render: (row) =>
                row.reasonNote ? (
                  <div>
                    <p>{row.reasonNote}</p>
                    {row.reasonNoteInherited ? (
                      <p className="mt-1 text-xs text-ink/55">이전 업로드 메모 승계</p>
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
