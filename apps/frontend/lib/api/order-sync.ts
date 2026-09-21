import type { OrderSyncBatchView } from "@patima/shared";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableString = (value: unknown) =>
  value === null || typeof value === "string";
const nullableTimestamp = (value: unknown) =>
  value === null || timestamp(value);
const nonnegative = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export function validateOrderSyncBatch(value: unknown): OrderSyncBatchView {
  if (
    !object(value) ||
    typeof value.batchId !== "string" ||
    !value.batchId ||
    !["YESTERDAY", "CURRENT", "MANUAL", "RECENT_30_DAYS"].includes(
      String(value.mode),
    ) ||
    ![
      "QUEUED",
      "RUNNING",
      "SUCCEEDED",
      "PARTIAL_FAILED",
      "FAILED",
      "NO_TARGETS",
    ].includes(String(value.status)) ||
    !timestamp(value.requestedCutoffAt) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !object(value.requestedRange) ||
    typeof value.requestedRange.dateFrom !== "string" ||
    typeof value.requestedRange.dateTo !== "string" ||
    !object(value.counts) ||
    ![
      "total",
      "target",
      "queued",
      "running",
      "succeeded",
      "failed",
      "skipped",
    ].every((key) =>
      nonnegative((value.counts as Record<string, unknown>)[key]),
    ) ||
    !Array.isArray(value.items) ||
    !value.items.every(
      (item) =>
        object(item) &&
        typeof item.storeId === "string" &&
        typeof item.storeName === "string" &&
        ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"].includes(
          String(item.status),
        ) &&
        nullableString(item.operationId) &&
        nullableString(item.skipReason) &&
        nullableTimestamp(item.retryAt) &&
        nullableString(item.initialCoverageFrom) &&
        nonnegative(item.attemptCount) &&
        nonnegative(item.maxAttempts) &&
        (item.progress === null ||
          (object(item.progress) &&
            (item.progress.lastProgressAt == null ||
              timestamp(item.progress.lastProgressAt)))) &&
        (item.result === null || object(item.result)) &&
        (item.error === null ||
          (object(item.error) &&
            typeof item.error.code === "string" &&
            typeof item.error.safeMessage === "string" &&
            typeof item.error.actionHint === "string" &&
            (item.error.traceId == null ||
              typeof item.error.traceId === "string"))),
    )
  ) {
    throw new Error("동기화 상태 응답 형식이 올바르지 않습니다.");
  }
  return value as unknown as OrderSyncBatchView;
}

export async function readOrderSyncResponse(
  response: Response,
): Promise<unknown> {
  const payload: unknown = await response.json().catch(() => null);
  if (
    !response.ok ||
    !object(payload) ||
    payload.success !== true ||
    !("data" in payload)
  ) {
    throw new Error(
      object(payload) && typeof payload.message === "string"
        ? payload.message
        : "동기화 요청을 확인할 수 없습니다.",
    );
  }
  return payload.data;
}
