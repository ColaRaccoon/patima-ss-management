"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Panel } from "@/components/shared/panel";
import { SourceBanner } from "@/components/shared/source-banner";
import { StatusBadge } from "@/components/shared/status-badge";
import { readApiResponse } from "@/lib/api/browser";
import type { OperationDetail, OperationsPageData } from "@/lib/api/types";
import { formatDateTime, formatNullableText } from "@/lib/format";
import { toneForOperationStatus } from "@/lib/status-tone";

export function OperationsView({ data }: { data: OperationsPageData }) {
  const router = useRouter();
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(
    data.selectedOperation?.operationId ?? data.operations[0]?.operationId ?? null,
  );
  const [selectedOperation, setSelectedOperation] = useState<OperationDetail | null>(
    data.selectedOperation,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();

  useEffect(() => {
    const fallbackId = data.selectedOperation?.operationId ?? data.operations[0]?.operationId ?? null;
    if (!selectedOperationId || !data.operations.some((item) => item.operationId === selectedOperationId)) {
      setSelectedOperationId(fallbackId);
      setSelectedOperation(data.selectedOperation);
    }
  }, [data.operations, data.selectedOperation, selectedOperationId]);

  if (!data.primaryStore) {
    return (
      <EmptyState
        title="작업 이력은 대표 스토어가 있어야 조회할 수 있습니다."
        description="주문 동기화, 광고 확정, 재계산 작업은 모두 스토어 기준으로 추적됩니다."
        actionHref="/settings/stores"
        actionLabel="스토어 설정"
      />
    );
  }

  const isBusy = isLoadingDetail || isRetrying || isRefreshing;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="백그라운드 작업 이력"
        description="실행된 작업을 선택해 상세 내용을 보고, 실패한 작업은 바로 재시도할 수 있습니다."
      />

      <SourceBanner sources={data.sources} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <Panel
          title="작업 목록"
          description="FAILED 작업은 상세 패널에서 재시도 요청을 보낼 수 있습니다."
        >
          <DataTable
            caption="작업 목록"
            columns={[
              {
                key: "select",
                title: "선택",
                render: (row) => (
                  <button
                    className="button-shell button-ghost"
                    type="button"
                    onClick={async () => {
                      if (row.operationId === selectedOperationId && selectedOperation) {
                        return;
                      }

                      setErrorMessage(null);
                      setSuccessMessage(null);
                      setSelectedOperationId(row.operationId);
                      setIsLoadingDetail(true);
                      try {
                        const detail = await readApiResponse<OperationDetail>(
                          await fetch(`/api/operations/${row.operationId}`, {
                            cache: "no-store",
                          }),
                          "작업 상세 조회에 실패했습니다.",
                        );
                        setSelectedOperation(detail);
                      } catch (error) {
                        setErrorMessage(
                          error instanceof Error
                            ? error.message
                            : "작업 상세 조회 중 오류가 발생했습니다.",
                        );
                      } finally {
                        setIsLoadingDetail(false);
                      }
                    }}
                  >
                    {row.operationId === selectedOperationId ? "선택됨" : "선택"}
                  </button>
                ),
              },
              {
                key: "type",
                title: "작업 유형",
                render: (row) => row.operationType,
              },
              {
                key: "status",
                title: "상태",
                render: (row) => (
                  <StatusBadge tone={toneForOperationStatus(row.status)}>
                    {row.status}
                  </StatusBadge>
                ),
              },
              {
                key: "created",
                title: "생성/종료",
                render: (row) => (
                  <div>
                    <p>{formatDateTime(row.createdAt)}</p>
                    <p className="mt-1 text-xs text-ink/55">{formatDateTime(row.finishedAt)}</p>
                  </div>
                ),
              },
              {
                key: "cutoffAt",
                title: "cutoffAt",
                render: (row) => formatDateTime(row.cutoffAt),
              },
            ]}
            rows={data.operations}
            getRowKey={(row) => row.operationId}
          />
        </Panel>

        <Panel
          title="선택한 작업 상세"
          description="요청 요약과 결과 요약을 확인하고, 실패 작업은 재시도할 수 있습니다."
        >
          {errorMessage ? (
            <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : null}

          {successMessage ? (
            <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {successMessage}
            </div>
          ) : null}

          {selectedOperation ? (
            <div className="space-y-4 text-sm leading-6 text-ink/65">
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold text-ink">{selectedOperation.operationType}</p>
                <StatusBadge tone={toneForOperationStatus(selectedOperation.status)}>
                  {selectedOperation.status}
                </StatusBadge>
              </div>
              <p>createdAt {formatDateTime(selectedOperation.createdAt)}</p>
              <p>startedAt {formatDateTime(selectedOperation.startedAt)}</p>
              <p>finishedAt {formatDateTime(selectedOperation.finishedAt)}</p>
              <p>cutoffAt {formatDateTime(selectedOperation.cutoffAt)}</p>
              <p>requestSummary {formatNullableText(JSON.stringify(selectedOperation.requestSummary))}</p>
              <p>resultSummary {formatNullableText(JSON.stringify(selectedOperation.resultSummary))}</p>
              <p className="text-red-700">{formatNullableText(selectedOperation.errorMessage)}</p>

              <button
                className="button-shell button-primary"
                type="button"
                disabled={isBusy || selectedOperation.status !== "FAILED"}
                onClick={async () => {
                  setErrorMessage(null);
                  setSuccessMessage(null);
                  setIsRetrying(true);
                  try {
                    await readApiResponse(
                      await fetch(`/api/operations/${selectedOperation.operationId}/retry`, {
                        method: "POST",
                      }),
                      "작업 재시도 요청에 실패했습니다.",
                    );
                    setSuccessMessage("재시도 요청을 등록했습니다.");
                    startRefresh(() => {
                      router.refresh();
                    });
                  } catch (error) {
                    setErrorMessage(
                      error instanceof Error ? error.message : "재시도 중 오류가 발생했습니다.",
                    );
                  } finally {
                    setIsRetrying(false);
                  }
                }}
              >
                실패 작업 재시도
              </button>
            </div>
          ) : (
            <p className="text-sm text-ink/60">선택한 작업이 없습니다.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}
