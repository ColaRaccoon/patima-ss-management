"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Panel } from "@/components/shared/panel";
import { formatDateTime } from "@/lib/format";
import { isActiveBatch, useOrderSync } from "./order-sync-provider";

const statuses: Record<string, string> = {
  QUEUED: "대기 중",
  RUNNING: "진행 중",
  SUCCEEDED: "동기화 완료",
  PARTIAL_FAILED: "완료 · 일부 실패",
  FAILED: "동기화 실패",
  NO_TARGETS: "동기화 대상 없음",
  SKIPPED: "제외",
};
const stages: Record<string, string> = {
  VALIDATING: "설정 확인 중",
  AUTHENTICATING: "인증 확인 중",
  FETCHING_ORDERS: "주문 조회 중",
  FETCHING_DETAILS: "상세 조회 중",
  SAVING: "저장 중",
  RECALCULATING: "집계 갱신 중",
  FINALIZING: "결과 확인 중",
};
const count = (value: unknown) =>
  typeof value === "number" ? value.toLocaleString("ko-KR") : "0";
const coverageGap = (value: unknown) => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    from: typeof record.from === "string" ? record.from : "미확인",
    to: typeof record.to === "string" ? record.to : "미확인",
    acknowledged: typeof record.acknowledgedAt === "string",
  };
};

export function OrderSyncPanel() {
  const sync = useOrderSync();
  const params = useSearchParams();
  const selectedId = params.get("batchId");
  const batch = selectedId
    ? sync.batches.find((item) => item.batchId === selectedId)
    : (sync.batches.find(isActiveBatch) ?? sync.batches[0]);
  return (
    <Panel
      title="주문 동기화"
      description="기본 조회 날짜는 한국시간 기준 어제입니다. 선택 날짜 동기화는 해당 날짜에 결제된 주문만 조회하고 갱신합니다."
      aside={
        <Link href="/operations" className="button-shell button-ghost">
          작업 이력
        </Link>
      }
    >
      {sync.submitting && (
        <p role="status" className="mb-3 text-sm">
          요청 접수 중…
        </p>
      )}
      {sync.submissionError && (
        <div
          role="alert"
          className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800"
        >
          {sync.submissionError}
          {sync.pending && (
            <button
              type="button"
              className="ml-3 underline"
              disabled={sync.submitting}
              onClick={() => void sync.retrySubmission()}
            >
              같은 요청으로 접수 확인
            </button>
          )}
        </div>
      )}
      {sync.connectionError && (
        <p
          role="alert"
          className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800"
        >
          {sync.connectionError} 마지막 확인{" "}
          {sync.lastCheckedAt
            ? formatDateTime(sync.lastCheckedAt)
            : "아직 없음"}{" "}
          · 자동으로 다시 연결합니다.
        </p>
      )}
      {batch ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p
              role="status"
              aria-live="polite"
              className={`font-semibold ${batch.counts.failed ? "text-red-700" : "text-ink"}`}
            >
              {statuses[batch.status] ?? batch.status}
            </p>
            <p className="text-sm">
              {batch.counts.succeeded + batch.counts.failed}/
              {batch.counts.target} 처리 완료 · 성공 {batch.counts.succeeded} ·
              실패 {batch.counts.failed} · 제외 {batch.counts.skipped} · 대기{" "}
              {batch.counts.queued}
            </p>
          </div>
          <p className="text-sm text-ink/65">
            기준시각 {formatDateTime(batch.requestedCutoffAt)} KST ·{" "}
            {batch.mode === "CURRENT"
              ? "변경 이력 포함 최신화 (기존 요청)"
              : batch.mode === "YESTERDAY"
                ? "접수 시각 기준 어제 하루"
                : batch.mode === "RECENT_30_DAYS"
                  ? "최근 30일 재수집 (기존 요청)"
                  : "선택 날짜 조회"}
            <br />
            결제 조회 범위 {batch.requestedRange.dateFrom} ~{" "}
            {batch.requestedRange.dateTo}
          </p>
          <ul className="divide-y divide-ink/10">
            {batch.items.map((item) => {
              const retrying =
                item.status === "QUEUED" && item.attemptCount > 0;
              const stage =
                typeof item.progress?.stage === "string"
                  ? item.progress.stage
                  : "";
              const label = retrying
                ? "자동 재시도 대기"
                : item.status === "RUNNING"
                  ? (stages[stage] ?? "진행 중")
                  : (statuses[item.status] ?? item.status);
              const summaryWarning =
                item.result?.summaryStatus === "FAILED" ||
                item.result?.summaryStatus === "WARNING" ||
                item.progress?.summaryStatus === "FAILED";
              return (
                <li key={item.storeId} className="py-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>{item.storeName}</strong>
                    <span aria-live="polite">{label}</span>
                  </div>
                  <p className="mt-1 text-ink/65">
                    수집 {count(item.progress?.fetchedCount)} · 검증{" "}
                    {count(item.progress?.validatedCount)} · 저장{" "}
                    {count(item.progress?.committedCount)}건
                    {item.progress?.totalCount == null
                      ? " · 총량 확인 중"
                      : ` / ${count(item.progress.totalCount)}건`}
                  </p>
                  {item.initialCoverageFrom && (
                    <p className="text-ink/55">
                      최초 수집 시작일 {item.initialCoverageFrom}
                    </p>
                  )}
                  {item.status === "QUEUED" && !retrying && (
                    <p className="text-ink/55">앞선 작업 완료 후 시작</p>
                  )}
                  {retrying && (
                    <p className="text-amber-800">
                      {formatDateTime(item.retryAt)} 재시도 ·{" "}
                      {item.attemptCount}/{item.maxAttempts}회 시도
                    </p>
                  )}
                  {item.skipReason && <p>비활성 스토어 · 제외</p>}
                  {item.error && (
                    <div className="mt-2 text-red-700">
                      <p>{item.error.safeMessage}</p>
                      <p>{item.error.actionHint}</p>
                      {/AUTH|CREDENTIAL|CONFIG/.test(item.error.code) && (
                        <Link
                          className="underline"
                          href={`/settings/stores?storeId=${encodeURIComponent(item.storeId)}`}
                        >
                          스토어 설정 확인
                        </Link>
                      )}
                    </div>
                  )}
                  {summaryWarning && (
                    <p className="mt-2 text-amber-800">
                      주문 저장 완료 · 손익 집계 갱신 필요{" "}
                      <Link
                        className="underline"
                        href={`/operations?operationId=${encodeURIComponent(item.operationId ?? "")}`}
                      >
                        복구 작업 확인
                      </Link>
                    </p>
                  )}
                  {coverageGap(item.result?.coverageGap) && (
                    <p className="mt-2 text-amber-800">
                      이번 작업의 변경 이력 공백:{" "}
                      {coverageGap(item.result?.coverageGap)?.from} ~{" "}
                      {coverageGap(item.result?.coverageGap)?.to}. 과거 미발견
                      주문의 완전 수집은 확인되지 않았습니다.
                      {item.result?.coverageGapAcknowledged
                        ? " 이 공백을 남긴 별도 기준선 재개를 설정했습니다."
                        : " 범위 재수집이 필요합니다."}
                    </p>
                  )}
                  {coverageGap(item.result?.historicalCoverageGap) && (
                    <p className="mt-2 text-amber-800">
                      이전에 남겨 둔 미해결 공백:{" "}
                      {coverageGap(item.result?.historicalCoverageGap)?.from} ~{" "}
                      {coverageGap(item.result?.historicalCoverageGap)?.to}.
                      이후 변경 추적의 성공과 별개로 과거 공백은 남아 있습니다.
                    </p>
                  )}
                  <details className="mt-2 text-xs text-ink/55">
                    <summary className="cursor-pointer">작업 식별 정보</summary>
                    <p>operationId: {item.operationId ?? "없음"}</p>
                    {item.error && (
                      <p>
                        오류 {item.error.code} · traceId{" "}
                        {item.error.traceId ?? "없음"}
                      </p>
                    )}
                    <p>
                      실제 진행 확인{" "}
                      {formatDateTime(
                        typeof item.progress?.lastProgressAt === "string"
                          ? item.progress.lastProgressAt
                          : null,
                      )}
                    </p>
                  </details>
                </li>
              );
            })}
          </ul>
          {batch.counts.failed > 0 && !isActiveBatch(batch) && (
            <button
              type="button"
              className="button-shell button-secondary"
              disabled={sync.submitting || sync.pending}
              onClick={() =>
                void sync.submit(
                  `/api/order-sync-batches/${encodeURIComponent(batch.batchId)}/retry-failed`,
                  {},
                )
              }
            >
              실패한 스토어만 재시도
            </button>
          )}
          {!isActiveBatch(batch) &&
            batch.items.some(
              (item) =>
                item.result?.summaryStatus === "WARNING" ||
                item.result?.summaryStatus === "FAILED",
            ) && (
              <button
                type="button"
                className="button-shell button-secondary"
                disabled={sync.submitting || sync.pending}
                onClick={() =>
                  void sync.submit(
                    `/api/order-sync-batches/${encodeURIComponent(batch.batchId)}/retry-summary`,
                    {},
                  )
                }
              >
                손익 집계만 다시 갱신
              </button>
            )}
          {!isActiveBatch(batch) &&
            batch.items.some(
              (item) =>
                item.result?.coverageGap &&
                !item.result?.coverageGapAcknowledged,
            ) && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <p>
                  30일은 앱의 보수적 검증 범위이며 네이버의 보존기간 보장이
                  아닙니다. 아래 동작은 누락 가능성이 있는 과거 범위를
                  복구하거나 성공 처리하지 않습니다. 공백 경고를 남기고 이
                  배치의 기준시각 이후 변경 추적을 재개합니다.
                </p>
                <button
                  type="button"
                  className="button-shell button-secondary mt-3"
                  disabled={sync.submitting || sync.pending}
                  onClick={() =>
                    void sync.submit(
                      `/api/order-sync-batches/${encodeURIComponent(batch.batchId)}/acknowledge-coverage-gap`,
                      { acknowledge: true },
                    )
                  }
                >
                  과거 공백을 미해결로 남기고 현재 기준부터 재개
                </button>
              </div>
            )}
          {sync.batches.length > 1 && (
            <div className="flex flex-wrap gap-3 text-xs">
              {sync.batches.slice(0, 10).map((item) => (
                <Link
                  className="underline"
                  key={item.batchId}
                  href={`/orders?batchId=${encodeURIComponent(item.batchId)}`}
                >
                  {formatDateTime(item.createdAt)} · {statuses[item.status]}
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink/60">
          동기화 작업을 조회하고 있습니다. 작업이 없으면 위 버튼으로 시작할 수
          있습니다.
        </p>
      )}
    </Panel>
  );
}
