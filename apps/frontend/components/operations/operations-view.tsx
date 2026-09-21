"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  const requestedOperationId = useSearchParams().get("operationId");
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(
    requestedOperationId ??
      data.selectedOperation?.operationId ??
      data.operations[0]?.operationId ??
      null,
  );
  const [selectedOperation, setSelectedOperation] =
    useState<OperationDetail | null>(data.selectedOperation);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();
  const retryKeys = useRef(new Map<string, string>());
  const retryInFlight = useRef(false);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem("order-sync-operation-retry-keys") ?? "{}",
      );
      if (saved && typeof saved === "object") {
        for (const [id, key] of Object.entries(saved))
          if (typeof key === "string") retryKeys.current.set(id, key);
      }
    } catch {
      /* Persistence is optional; the server remains the operation ledger. */
    }
  }, []);
  const persistRetryKeys = () => {
    try {
      sessionStorage.setItem(
        "order-sync-operation-retry-keys",
        JSON.stringify(Object.fromEntries(retryKeys.current)),
      );
    } catch {
      /* optional */
    }
  };

  const selectedStore = useRef(data.primaryStore?.id);
  useEffect(() => {
    if (requestedOperationId) setSelectedOperationId(requestedOperationId);
  }, [requestedOperationId]);
  useEffect(() => {
    if (selectedStore.current !== data.primaryStore?.id) {
      selectedStore.current = data.primaryStore?.id;
      setSelectedOperationId(
        data.selectedOperation?.operationId ??
          data.operations[0]?.operationId ??
          null,
      );
      setSelectedOperation(data.selectedOperation);
    }
  }, [data.primaryStore?.id, data.operations, data.selectedOperation]);

  useEffect(() => {
    if (!selectedOperationId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let failures = 0;
    let terminal = false;
    let observedActive = false;
    let controller: AbortController | undefined;
    setSelectedOperation((current) =>
      current?.operationId === selectedOperationId ? current : null,
    );
    const poll = async () => {
      if (stopped || inFlight || terminal) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 30_000);
      setIsLoadingDetail(true);
      try {
        const detail = await readApiResponse<OperationDetail>(
          await fetch(
            `/api/operations/${encodeURIComponent(selectedOperationId)}`,
            { cache: "no-store", signal: controller.signal },
          ),
          "작업 상세 조회에 실패했습니다.",
        );
        if (
          !detail ||
          detail.operationId !== selectedOperationId ||
          !["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"].includes(detail.status)
        )
          throw new Error("작업 상태 응답이 올바르지 않습니다.");
        if (!stopped) {
          setSelectedOperation(detail);
          setErrorMessage(null);
          failures = 0;
          terminal =
            detail.status === "SUCCEEDED" || detail.status === "FAILED";
          if (terminal && observedActive) router.refresh();
          observedActive ||= !terminal;
        }
      } catch {
        if (!stopped) {
          failures++;
          setErrorMessage(
            "연결이 끊겨 상태를 확인할 수 없습니다. 마지막 상태를 유지하며 다시 연결합니다.",
          );
        }
      } finally {
        clearTimeout(timeout);
        inFlight = false;
        if (!stopped) {
          setIsLoadingDetail(false);
          if (!terminal)
            timer = setTimeout(
              poll,
              document.hidden ? 15_000 : Math.min(30_000, 2500 * 2 ** failures),
            );
        }
      }
    };
    const resume = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", resume);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", resume);
    };
  }, [selectedOperationId, router]);

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
                    onClick={() => {
                      setErrorMessage(null);
                      setSuccessMessage(null);
                      setSelectedOperationId(row.operationId);
                    }}
                  >
                    {row.operationId === selectedOperationId
                      ? "선택됨"
                      : "선택"}
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
                    <p className="mt-1 text-xs text-ink/55">
                      {formatDateTime(row.finishedAt)}
                    </p>
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
                <p className="font-semibold text-ink">
                  {selectedOperation.operationType}
                </p>
                <StatusBadge
                  tone={toneForOperationStatus(selectedOperation.status)}
                >
                  {selectedOperation.status === "QUEUED" &&
                  (selectedOperation.attemptCount ?? 0) > 0
                    ? "자동 재시도 대기"
                    : selectedOperation.status}
                </StatusBadge>
              </div>
              <p>createdAt {formatDateTime(selectedOperation.createdAt)}</p>
              <p>startedAt {formatDateTime(selectedOperation.startedAt)}</p>
              <p>finishedAt {formatDateTime(selectedOperation.finishedAt)}</p>
              <p>cutoffAt {formatDateTime(selectedOperation.cutoffAt)}</p>
              {selectedOperation.status === "QUEUED" &&
                (selectedOperation.attemptCount ?? 0) > 0 && (
                  <p>
                    다음 시도 {formatDateTime(selectedOperation.runAfter)} ·{" "}
                    {selectedOperation.attemptCount}/
                    {selectedOperation.maxAttempts}회 시도
                  </p>
                )}
              <details>
                <summary className="cursor-pointer">
                  요청·결과 상세 정보
                </summary>
                <p>
                  requestSummary{" "}
                  {formatNullableText(
                    JSON.stringify(selectedOperation.requestSummary),
                  )}
                </p>
                <p>
                  resultSummary{" "}
                  {formatNullableText(
                    JSON.stringify(selectedOperation.resultSummary),
                  )}
                </p>
              </details>
              <p className="text-red-700">
                {formatNullableText(selectedOperation.errorMessage)}
              </p>

              <button
                className="button-shell button-primary"
                type="button"
                disabled={isBusy || selectedOperation.status !== "FAILED"}
                onClick={async () => {
                  if (retryInFlight.current) return;
                  retryInFlight.current = true;
                  const operationId = selectedOperation.operationId;
                  const idempotencyKey =
                    retryKeys.current.get(operationId) ?? crypto.randomUUID();
                  retryKeys.current.set(operationId, idempotencyKey);
                  persistRetryKeys();
                  setErrorMessage(null);
                  setSuccessMessage(null);
                  setIsRetrying(true);
                  try {
                    const retry = await readApiResponse<{
                      retryOperationId: string | null;
                      batchId?: string;
                    }>(
                      await fetch(
                        `/api/operations/${selectedOperation.operationId}/retry`,
                        {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ idempotencyKey }),
                        },
                      ),
                      "작업 재시도 요청에 실패했습니다.",
                    );
                    if (
                      !retry?.retryOperationId &&
                      typeof retry?.batchId === "string"
                    ) {
                      retryKeys.current.delete(operationId);
                      persistRetryKeys();
                      router.push(
                        `/orders?batchId=${encodeURIComponent(retry.batchId)}`,
                      );
                      return;
                    }
                    if (!retry?.retryOperationId)
                      throw new Error("재시도 작업 ID를 확인할 수 없습니다.");
                    setSelectedOperationId(retry.retryOperationId);
                    retryKeys.current.delete(operationId);
                    persistRetryKeys();
                    setSuccessMessage("재시도 요청을 등록했습니다.");
                    startRefresh(() => {
                      router.refresh();
                    });
                  } catch (error) {
                    setErrorMessage(
                      error instanceof Error
                        ? error.message
                        : "재시도 중 오류가 발생했습니다.",
                    );
                  } finally {
                    retryInFlight.current = false;
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
