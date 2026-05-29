import type { DatabaseShape, OrderItem, OrderRecord } from "@patima/shared";
import type { SyncedOrderItemInput } from "./naver-commerce.service";

export const DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS = 90;

const KST_TIME_ZONE = "Asia/Seoul";
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_PREFIX_PATTERN = /^(\d{4}-\d{2}-\d{2})/;

const formatKstDate = (date: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const addDaysToDateString = (dateString: string, days: number): string => {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
};

export function getOrderRawPayloadRetentionDays(
  value = process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS,
): number {
  if (value === undefined || value === null || value.trim() === "") {
    return DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS;
  }

  if (!/^\d+$/.test(value.trim())) {
    return DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS;
}

export function getKstRetentionCutoffDate(days: number, now = new Date()): string {
  const retentionDays =
    Number.isSafeInteger(days) && days >= 0 ? days : DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS;
  return addDaysToDateString(formatKstDate(now), -retentionDays);
}

export function toKstDateString(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (DATE_ONLY_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) {
    return formatKstDate(new Date(timestamp));
  }

  return DATE_PREFIX_PATTERN.exec(trimmed)?.[1] ?? null;
}

export function getSyncedOrderItemRetentionDate(
  entry: SyncedOrderItemInput,
  now = new Date(),
): string {
  return (
    entry.paymentDate ??
    entry.orderDate ??
    toKstDateString(entry.orderDateTime) ??
    formatKstDate(now)
  );
}

export function shouldRetainOrderRawPayload(
  referenceDate: string | null | undefined,
  cutoffDate: string,
  retentionDays: number,
): boolean {
  if (retentionDays === 0) {
    return false;
  }
  return !referenceDate || referenceDate >= cutoffDate;
}

const getOrderRetentionDate = (order: OrderRecord): string | null =>
  toKstDateString(order.paymentDatetime) ??
  toKstDateString(order.orderDatetime) ??
  toKstDateString(order.syncedAt);

const getOrderItemRetentionDate = (item: OrderItem): string | null =>
  item.paymentDate ?? item.orderDate ?? toKstDateString(item.createdAt);

export function pruneExpiredOrderRawPayloads(
  draft: DatabaseShape,
  storeId: string,
  cutoffDate: string,
  retentionDays: number,
): {
  prunedOrderCount: number;
  prunedOrderItemCount: number;
} {
  let prunedOrderCount = 0;
  let prunedOrderItemCount = 0;

  draft.orders.forEach((order) => {
    if (order.storeId !== storeId || order.rawPayload === null) {
      return;
    }

    const referenceDate = getOrderRetentionDate(order);
    if (retentionDays === 0 || (referenceDate && referenceDate < cutoffDate)) {
      order.rawPayload = null;
      prunedOrderCount += 1;
    }
  });

  draft.orderItems.forEach((item) => {
    if (item.storeId !== storeId || item.rawPayload === null) {
      return;
    }

    const referenceDate = getOrderItemRetentionDate(item);
    if (retentionDays === 0 || (referenceDate && referenceDate < cutoffDate)) {
      item.rawPayload = null;
      prunedOrderItemCount += 1;
    }
  });

  return { prunedOrderCount, prunedOrderItemCount };
}
