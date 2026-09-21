import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  OrderSyncBatch,
  OrderSyncBatchView,
  OrderSyncMode,
  OrderSyncCoverageGap,
  OperationRecord,
} from "@patima/shared";
import { DatabaseService } from "./database.service";
import { createId, ensureKstDateRange, nowIso } from "./helpers";

export interface OrderSyncRequest {
  mode?: OrderSyncMode;
  dateFrom?: string;
  dateTo?: string;
  idempotencyKey?: string;
}

@Injectable()
export class OrderSyncBatchService {
  constructor(private readonly database: DatabaseService) {}

  async enqueue(
    input: OrderSyncRequest,
    storeId?: string,
    retryOfBatchId?: string,
    legacyRetryOperationId?: string,
  ) {
    const mode =
      input.mode ?? (input.dateFrom || input.dateTo ? "MANUAL" : "YESTERDAY");
    if (!["YESTERDAY", "CURRENT", "MANUAL", "RECENT_30_DAYS"].includes(mode))
      throw new BadRequestException("INVALID_SYNC_MODE");
    if (mode !== "MANUAL" && (input.dateFrom || input.dateTo))
      throw new BadRequestException("DATE_RANGE_REQUIRES_MANUAL_MODE");
    if (mode === "MANUAL" && (!input.dateFrom || !input.dateTo))
      throw new BadRequestException("MANUAL_RANGE_REQUIRED");
    const key = input.idempotencyKey ?? createId();
    if (typeof key !== "string" || key.length < 8 || key.length > 128)
      throw new BadRequestException("INVALID_IDEMPOTENCY_KEY");
    const fingerprintInput = {
      mode,
      dateFrom: input.dateFrom ?? null,
      dateTo: input.dateTo ?? null,
      storeId: storeId ?? null,
      retryOfBatchId: retryOfBatchId ?? null,
      ...(legacyRetryOperationId ? { legacyRetryOperationId } : {}),
    };
    const fingerprint = JSON.stringify(fingerprintInput);
    // Replay requests admitted before the default changed, including failed-batch retries.
    const previousDefaultFingerprint =
      !input.mode && !input.dateFrom && !input.dateTo
        ? JSON.stringify({ ...fingerprintInput, mode: "CURRENT" })
        : null;
    const id = await this.database.commitOrderSync((draft) => {
      const existing = draft.orderSyncBatches.find(
        (batch) => batch.idempotencyKey === key,
      );
      if (existing) {
        if (
          existing.fingerprint !== fingerprint &&
          existing.fingerprint !== previousDefaultFingerprint
        )
          throw new ConflictException("IDEMPOTENCY_KEY_CONFLICT");
        return existing.id;
      }
      const source = retryOfBatchId
        ? draft.orderSyncBatches.find((batch) => batch.id === retryOfBatchId)
        : null;
      if (retryOfBatchId && !source)
        throw new NotFoundException("BATCH_NOT_FOUND");
      const legacy = legacyRetryOperationId
        ? draft.operations.find(
            (operation) => operation.id === legacyRetryOperationId,
          )
        : null;
      if (
        legacyRetryOperationId &&
        (!legacy ||
          legacy.operationType !== "ORDER_SYNC" ||
          legacy.status !== "FAILED" ||
          legacy.storeId !== storeId)
      )
        throw new BadRequestException("INVALID_LEGACY_RETRY");
      const legacyRequest = legacy?.requestJson;
      const legacyCutoff = legacy
        ? typeof legacyRequest?.requestedCutoffAt === "string"
          ? legacyRequest.requestedCutoffAt
          : legacy.cutoffAt
        : null;
      const now = nowIso();
      const kstDay = (millis: number) =>
        new Date(millis + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const range =
        source?.requestedRange ??
        (legacy &&
        typeof legacyRequest?.dateFrom === "string" &&
        typeof legacyRequest?.dateTo === "string"
          ? { dateFrom: legacyRequest.dateFrom, dateTo: legacyRequest.dateTo }
          : null) ??
        (mode === "MANUAL"
          ? ensureKstDateRange(input.dateFrom, input.dateTo)
          : mode === "YESTERDAY" && !legacy
            ? {
                dateFrom: kstDay(Date.parse(now) - 86400000),
                dateTo: kstDay(Date.parse(now) - 86400000),
              }
            : {
              dateFrom: kstDay(Date.parse(legacyCutoff ?? now) - 29 * 86400000),
              dateTo: kstDay(Date.parse(legacyCutoff ?? now)),
            });
      const batch: OrderSyncBatch = {
        id: createId(),
        idempotencyKey: key,
        fingerprint,
        mode:
          source?.mode ??
          (legacy
            ? legacyRequest?.mode === "CURRENT"
              ? "CURRENT"
              : legacyRequest?.rangeMode === "MANUAL"
                ? "MANUAL"
                : "RECENT_30_DAYS"
            : mode),
        requestedCutoffAt: source?.requestedCutoffAt ?? legacyCutoff ?? now,
        requestedRange: { dateFrom: range.dateFrom, dateTo: range.dateTo },
        createdAt: now,
        finishedAt: null,
        retryOfBatchId: source?.id ?? null,
        schemaVersion: 1,
      };
      let stores = draft.stores.filter(
        (store) => !storeId || store.id === storeId,
      );
      if (storeId && !stores.length)
        throw new NotFoundException("STORE_NOT_FOUND");
      if (source) {
        const failedIds = new Set(
          draft.orderSyncBatchItems
            .filter(
              (item) =>
                item.batchId === source.id &&
                draft.operations.some(
                  (operation) =>
                    operation.id === item.operationId &&
                    operation.status === "FAILED",
                ),
            )
            .map((item) => item.storeId),
        );
        stores = stores.filter((store) => failedIds.has(store.id));
        if (!stores.length) throw new BadRequestException("NO_FAILED_ITEMS");
      }
      draft.orderSyncBatches.push(batch);
      for (const store of stores) {
        const operationId = store.isActive ? createId() : null;
        draft.orderSyncBatchItems.push({
          id: createId(),
          batchId: batch.id,
          storeId: store.id,
          storeNameAtRequest: store.name,
          operationId,
          eligibility: store.isActive ? "ELIGIBLE" : "SKIPPED",
          skipReason: store.isActive ? null : "STORE_INACTIVE",
        });
        if (!operationId) continue;
        const operation: OperationRecord = {
          id: operationId,
          storeId: store.id,
          operationType: "ORDER_SYNC",
          status: "QUEUED",
          retryOfOperationId: source
            ? (draft.orderSyncBatchItems.find(
                (item) =>
                  item.batchId === source.id && item.storeId === store.id,
              )?.operationId ?? null)
            : (legacy?.id ?? null),
          requestedBy: "LOCALHOST_ADMIN",
          requestJson: {
            schemaVersion: 1,
            batchId: batch.id,
            mode: batch.mode,
            requestedCutoffAt: batch.requestedCutoffAt,
            dateFrom: range.dateFrom,
            dateTo: range.dateTo,
            rangeMode:
              batch.mode === "MANUAL"
                ? "MANUAL"
                : batch.mode === "YESTERDAY"
                  ? "AUTO_YESTERDAY"
                  : "AUTO_LAST_30_DAYS",
            requireLiveCredential: true,
          },
          resultJson: null,
          errorMessage: null,
          cutoffAt: batch.requestedCutoffAt,
          createdAt: now,
          startedAt: null,
          finishedAt: null,
          attemptCount: 0,
          maxAttempts: 3,
          runAfter: now,
          heartbeatAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lockedAt: null,
          progressJson: null,
        };
        draft.operations.push(operation);
      }
      if (!stores.some((store) => store.isActive)) batch.finishedAt = now;
      return batch.id;
    });
    return this.get(id);
  }

  async acknowledgeCoverageGap(id: string): Promise<OrderSyncBatchView> {
    await this.database.commitOrderSync((draft) => {
      const batch = draft.orderSyncBatches.find((item) => item.id === id);
      if (!batch) throw new NotFoundException("BATCH_NOT_FOUND");
      const itemIds = new Set(
        draft.orderSyncBatchItems
          .filter((item) => item.batchId === id)
          .map((item) => item.operationId),
      );
      const operations = draft.operations.filter((item) =>
        itemIds.has(item.id),
      );
      if (
        operations.some(
          (item) => item.status === "QUEUED" || item.status === "RUNNING",
        )
      )
        throw new BadRequestException("BATCH_STILL_ACTIVE");
      let found = false;
      for (const operation of operations) {
        const gap = operation.resultJson?.coverageGap as
          | OrderSyncCoverageGap
          | undefined;
        if (!gap || operation.status !== "FAILED") continue;
        found = true;
        let state = draft.orderSyncStates.find(
          (item) => item.storeId === operation.storeId,
        );
        if (!state) {
          state = {
            id: operation.storeId,
            storeId: operation.storeId,
            initialCoverageFrom: batch.requestedRange.dateFrom,
            lastSuccessfulChangedTo: null,
            lastSuccessfulSyncAt: null,
            updatedAt: batch.createdAt,
          };
          draft.orderSyncStates.push(state);
        }
        if (
          state.acknowledgedCoverageGaps?.some((entry) => entry.batchId === id)
        )
          continue;
        // Acknowledgement narrows future coverage; it never rewrites this failed batch or claims recovery.
        const baseline = [
          state.lastSuccessfulChangedTo,
          state.changedCoverageBaselineAt,
          batch.requestedCutoffAt,
        ]
          .filter((value): value is string => !!value)
          .sort()
          .at(-1)!;
        state.changedCoverageBaselineAt = baseline;
        const acknowledgedAt = nowIso();
        state.acknowledgedCoverageGaps = [
          ...(state.acknowledgedCoverageGaps ?? []),
          { batchId: id, gap: { ...gap }, acknowledgedAt },
        ];
        const previous = state.historicalCoverageGap;
        state.historicalCoverageGap = {
          ...gap,
          from: previous && previous.from < gap.from ? previous.from : gap.from,
          to: previous && previous.to > gap.to ? previous.to : gap.to,
          reason:
            "미해결 과거 공백들을 포함한 전체 경고 범위입니다. 개별 공백은 원래 실패 작업 이력에 보존됩니다.",
          acknowledgedAt,
        };
        state.updatedAt = nowIso();
      }
      if (!found) throw new BadRequestException("NO_COVERAGE_GAP");
    });
    return this.get(id);
  }

  get(id: string): OrderSyncBatchView {
    const snapshot = this.database.getSnapshot();
    const batch = snapshot.orderSyncBatches.find((item) => item.id === id);
    if (!batch) throw new NotFoundException("BATCH_NOT_FOUND");
    const items: OrderSyncBatchView["items"] = snapshot.orderSyncBatchItems
      .filter((item) => item.batchId === id)
      .map((item) => {
        const operation = snapshot.operations.find(
          (candidate) => candidate.id === item.operationId,
        );
        return {
          storeId: item.storeId,
          storeName: item.storeNameAtRequest,
          operationId: item.operationId,
          status:
            item.eligibility === "SKIPPED"
              ? "SKIPPED"
              : (operation?.status ?? "FAILED"),
          skipReason: item.skipReason,
          error:
            (operation?.progressJson
              ?.error as OrderSyncBatchView["items"][number]["error"]) ??
            (operation?.errorMessage
              ? {
                  code: operation.errorMessage,
                  category: "SYNC",
                  safeMessage: operation.errorMessage,
                  actionHint: "작업 이력과 스토어 설정을 확인하세요.",
                  retryable: operation.status === "QUEUED",
                }
              : !operation && item.operationId
                ? {
                    code: "OPERATION_MISSING",
                    category: "STORAGE",
                    safeMessage: "작업 기록을 찾을 수 없습니다.",
                    actionHint: "백업 및 작업 이력을 확인하세요.",
                    retryable: false,
                  }
                : null),
          progress: operation?.progressJson ?? null,
          attemptCount: operation?.attemptCount ?? 0,
          maxAttempts: operation?.maxAttempts ?? 3,
          retryAt:
            operation?.status === "QUEUED" && operation.attemptCount > 0
              ? operation.runAfter
              : null,
          result: operation?.resultJson
            ? {
                ...operation.resultJson,
                coverageGapAcknowledged:
                  snapshot.orderSyncStates
                    .find((state) => state.storeId === item.storeId)
                    ?.acknowledgedCoverageGaps?.some(
                      (entry) => entry.batchId === id,
                    ) ?? false,
                historicalCoverageGap:
                  snapshot.orderSyncStates.find(
                    (state) => state.storeId === item.storeId,
                  )?.historicalCoverageGap ??
                  operation.resultJson.historicalCoverageGap ??
                  null,
              }
            : null,
          initialCoverageFrom:
            snapshot.orderSyncStates.find(
              (state) => state.storeId === item.storeId,
            )?.initialCoverageFrom ?? batch.requestedRange.dateFrom,
        };
      });
    const count = (status: string) =>
      items.filter((item) => item.status === status).length;
    const counts = {
      total: items.length,
      target: items.length - count("SKIPPED"),
      queued: count("QUEUED"),
      running: count("RUNNING"),
      succeeded: count("SUCCEEDED"),
      failed: count("FAILED"),
      skipped: count("SKIPPED"),
    };
    const status = !counts.target
      ? "NO_TARGETS"
      : counts.running ||
          (counts.queued &&
            (counts.succeeded > 0 ||
              counts.failed > 0 ||
              items.some((item) => item.attemptCount > 0)))
        ? "RUNNING"
        : counts.queued
          ? "QUEUED"
          : counts.failed
            ? counts.succeeded
              ? "PARTIAL_FAILED"
              : "FAILED"
            : "SUCCEEDED";
    const times = snapshot.operations
      .filter((operation) =>
        items.some((item) => item.operationId === operation.id),
      )
      .flatMap((operation) => [
        operation.finishedAt,
        operation.heartbeatAt,
        operation.createdAt,
        typeof operation.progressJson?.lastProgressAt === "string"
          ? operation.progressJson.lastProgressAt
          : null,
        typeof operation.resultJson?.summaryUpdatedAt === "string"
          ? operation.resultJson.summaryUpdatedAt
          : null,
      ])
      .filter((value): value is string => !!value);
    times.push(
      ...snapshot.orderSyncStates
        .filter((state) => items.some((item) => item.storeId === state.storeId))
        .map((state) => state.updatedAt),
    );
    const updatedAt = times.sort().at(-1) ?? batch.createdAt;
    return {
      batchId: id,
      statusUrl: `/api/v1/order-sync-batches/${id}`,
      mode: batch.mode,
      requestedCutoffAt: batch.requestedCutoffAt,
      requestedRange: batch.requestedRange,
      createdAt: batch.createdAt,
      finishedAt:
        counts.queued || counts.running
          ? null
          : (batch.finishedAt ??
            snapshot.operations
              .filter((operation) =>
                items.some((item) => item.operationId === operation.id),
              )
              .map((operation) => operation.finishedAt)
              .filter((value): value is string => !!value)
              .sort()
              .at(-1) ??
            batch.createdAt),
      updatedAt,
      retryOfBatchId: batch.retryOfBatchId,
      status,
      counts,
      items,
    };
  }

  list(active: boolean, page = 1, pageSize = 20) {
    page = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    pageSize = Number.isFinite(pageSize)
      ? Math.min(50, Math.max(1, Math.floor(pageSize)))
      : 20;
    const batches = this.database
      .getSnapshot()
      .orderSyncBatches.slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((batch) => this.get(batch.id))
      .filter(
        (batch) =>
          !active || batch.status === "QUEUED" || batch.status === "RUNNING",
      );
    return {
      items: batches.slice((page - 1) * pageSize, page * pageSize),
      total: batches.length,
      page,
      pageSize,
    };
  }
}
