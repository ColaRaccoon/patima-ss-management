import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  OperationRecord,
  OperationStatus,
  OperationType,
} from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import { OrderSyncBatchService } from "./order-sync-batch.service";
import { DatabaseService } from "./database.service";
import { createId, formatApiSuccess, nowIso } from "./helpers";

export interface OperationExecutionContext {
  signal: AbortSignal;
  fence: { id: string; owner: string; attempt: number };
  progress: (value: Record<string, unknown>) => Promise<void>;
}
type OperationExecutor = (
  operation: OperationRecord,
  context: OperationExecutionContext,
) => Promise<Record<string, unknown>>;
type LegacyOperationExecutor = () => Promise<Record<string, unknown>>;

const DEFAULT_OPERATION_MAX_ATTEMPTS = 3;
const OPERATION_LEASE_DURATION_MS = 2 * 60 * 1000;
const OPERATION_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const OPERATION_LOCK_BUSY_DELAY_MS = 15 * 1000;
const OPERATION_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || "UNKNOWN");

const addMs = (date: Date, ms: number): string =>
  new Date(date.getTime() + ms).toISOString();

@Injectable()
export class OperationService {
  private readonly retryExecutors = new Map<OperationType, OperationExecutor>();
  private readonly leaseOwner = `backend-${process.pid}-${createId()}`;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditLogService: AuditLogService,
    private readonly batchService: OrderSyncBatchService = new OrderSyncBatchService(
      databaseService,
    ),
  ) {}

  registerRetryExecutor(
    operationType: OperationType,
    executor: OperationExecutor,
  ) {
    this.retryExecutors.set(operationType, executor);
  }

  hasRunningOperation(storeId: string): boolean {
    const nowAt = nowIso();
    const snapshot = this.databaseService.getSnapshot();
    return snapshot.operations.some(
      (operation) =>
        operation.storeId === storeId &&
        operation.status === "RUNNING" &&
        (!operation.leaseExpiresAt || operation.leaseExpiresAt > nowAt),
    );
  }

  hasInFlightOperation(
    storeId: string,
    operationType?: OperationType,
  ): boolean {
    const nowAt = nowIso();
    const snapshot = this.databaseService.getSnapshot();
    return snapshot.operations.some(
      (operation) =>
        operation.storeId === storeId &&
        (!operationType || operation.operationType === operationType) &&
        (operation.status === "QUEUED" ||
          (operation.status === "RUNNING" &&
            (!operation.leaseExpiresAt || operation.leaseExpiresAt > nowAt))),
    );
  }

  async list(
    storeId: string,
    status?: OperationStatus,
    operationType?: OperationType,
    page?: number,
    pageSize?: number,
  ) {
    await this.cleanupStaleOperations();
    const result = await this.databaseService.queryOperations({
      storeId,
      status,
      operationType,
      page,
      pageSize,
    });
    return formatApiSuccess(result);
  }

  async get(operationId: string) {
    await this.cleanupStaleOperations();
    const operation = await this.databaseService.getOperationById(operationId);

    if (!operation) {
      throw new NotFoundException({
        success: false,
        message: "작업을 찾을 수 없습니다.",
        errors: [{ field: "operationId", reason: "OPERATION_NOT_FOUND" }],
      });
    }

    return formatApiSuccess({
      operationId: operation.id,
      storeId: operation.storeId,
      operationType: operation.operationType,
      status: operation.status,
      cutoffAt: operation.cutoffAt,
      createdAt: operation.createdAt,
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt,
      errorMessage: operation.errorMessage,
      requestSummary: operation.requestJson,
      resultSummary: operation.resultJson,
      attemptCount: operation.attemptCount,
      maxAttempts: operation.maxAttempts,
      runAfter: operation.runAfter,
      heartbeatAt: operation.heartbeatAt,
      leaseOwner: operation.leaseOwner,
      leaseExpiresAt: operation.leaseExpiresAt,
      lockedAt: operation.lockedAt,
      progressJson: operation.progressJson,
    });
  }

  async retry(operationId: string, idempotencyKey?: string) {
    const operation = await this.databaseService.getOperationById(operationId);
    if (!operation) {
      throw new NotFoundException({
        success: false,
        message: "작업을 찾을 수 없습니다.",
        errors: [{ field: "operationId", reason: "OPERATION_NOT_FOUND" }],
      });
    }
    if (operation.status !== "FAILED") {
      throw new BadRequestException({
        success: false,
        message: "실패한 작업만 재시도할 수 있습니다.",
        errors: [
          { field: "operationId", reason: "OPERATION_RETRY_NOT_ALLOWED" },
        ],
      });
    }

    if (!this.retryExecutors.has(operation.operationType)) {
      throw new BadRequestException({
        success: false,
        message: "재시도 실행기를 찾을 수 없습니다.",
        errors: [
          { field: "operationType", reason: "OPERATION_RETRY_NOT_ALLOWED" },
        ],
      });
    }

    if (operation.operationType === "ORDER_SYNC") {
      const batch = await this.batchService.enqueue(
        { idempotencyKey: idempotencyKey ?? createId() },
        operation.storeId,
        typeof operation.requestJson?.batchId === "string"
          ? operation.requestJson.batchId
          : undefined,
        typeof operation.requestJson?.batchId === "string"
          ? undefined
          : operation.id,
      );
      return formatApiSuccess({
        operationId: operation.id,
        retryOperationId: batch.items[0]?.operationId,
        batchId: batch.batchId,
        status: batch.items[0]?.status ?? batch.status,
      });
    }
    const retryOperation = await this.enqueue(
      operation.storeId,
      operation.operationType,
      operation.requestJson ?? {},
      undefined,
      operation.id,
    );

    return formatApiSuccess({
      operationId: operation.id,
      retryOperationId: retryOperation.id,
      status: retryOperation.status,
    });
  }

  async enqueue(
    storeId: string,
    operationType: OperationType,
    requestJson: Record<string, unknown>,
    _executor?: LegacyOperationExecutor,
    retryOfOperationId: string | null = null,
  ): Promise<OperationRecord> {
    const now = nowIso();
    const operation: OperationRecord = {
      id: createId(),
      storeId,
      operationType,
      status: "QUEUED",
      retryOfOperationId,
      requestedBy: "LOCALHOST_ADMIN",
      requestJson,
      resultJson: null,
      errorMessage: null,
      cutoffAt: now,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      attemptCount: 0,
      maxAttempts: DEFAULT_OPERATION_MAX_ATTEMPTS,
      runAfter: now,
      heartbeatAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lockedAt: null,
      progressJson: null,
    };

    return this.databaseService.insertOperation(operation);
  }

  async pollOnce(): Promise<boolean> {
    await this.cleanupStaleOperations();
    const operation = await this.databaseService.acquireNextOperation(
      `${this.leaseOwner}-${createId()}`,
      OPERATION_LEASE_DURATION_MS,
    );
    if (!operation) {
      return false;
    }

    const lock = await this.databaseService.tryAcquireOperationExecutionLock(
      operation.storeId,
      operation.operationType,
    );
    if (!lock) {
      await this.databaseService.deferOperationLease(
        operation.id,
        operation.leaseOwner!,
        {
          runAfter: addMs(new Date(), OPERATION_LOCK_BUSY_DELAY_MS),
          errorMessage: "STORE_OPERATION_LOCK_BUSY",
          decrementAttempt: true,
        },
      );
      return true;
    }

    try {
      await this.runOperation(operation);
    } finally {
      await lock.release();
    }
    return true;
  }

  async heartbeat(
    operationId: string,
    progressJson?: Record<string, unknown> | null,
    leaseOwner = this.leaseOwner,
  ) {
    return this.databaseService.heartbeatOperation(
      operationId,
      leaseOwner,
      OPERATION_LEASE_DURATION_MS,
      progressJson,
    );
  }

  async acquireNextOperation(
    leaseOwner = this.leaseOwner,
  ): Promise<OperationRecord | null> {
    await this.cleanupStaleOperations();
    return this.databaseService.acquireNextOperation(
      leaseOwner,
      OPERATION_LEASE_DURATION_MS,
    );
  }

  async tryAcquireExecutionLock(
    operation: Pick<OperationRecord, "storeId" | "operationType">,
  ) {
    return this.databaseService.tryAcquireOperationExecutionLock(
      operation.storeId,
      operation.operationType,
    );
  }

  private async runOperation(operation: OperationRecord): Promise<void> {
    const executor = this.retryExecutors.get(operation.operationType);
    const controller = new AbortController();
    const owner = operation.leaseOwner!;
    const fence = { id: operation.id, owner, attempt: operation.attemptCount };
    let progress: Record<string, unknown> = {
      ...operation.progressJson,
      error: null,
    };
    const executionStartedAt = Date.now();
    this.logOrderSync(operation, "STARTED", executionStartedAt, progress);
    let lastProgress = executionStartedAt;
    let heartbeatPending = false;
    const heartbeatTimer = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      if (Date.now() - lastProgress > 120_000)
        controller.abort(new Error("OPERATION_PROGRESS_TIMEOUT"));
      void this.heartbeat(operation.id, undefined, owner)
        .then((updated) => {
          if (!updated || updated.attemptCount !== operation.attemptCount)
            controller.abort(new Error("OPERATION_LEASE_LOST"));
        })
        .catch(() => controller.abort(new Error("OPERATION_HEARTBEAT_FAILED")))
        .finally(() => {
          heartbeatPending = false;
        });
    }, OPERATION_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    try {
      if (!executor) throw new Error("OPERATION_EXECUTOR_NOT_REGISTERED");
      const result = await executor(operation, {
        signal: controller.signal,
        fence,
        progress: async (value) => {
          controller.signal.throwIfAborted();
          const stageChanged =
            typeof value.stage === "string" && value.stage !== progress.stage;
          lastProgress = Date.now();
          progress = {
            ...progress,
            ...(value.stage && value.stage !== progress.stage
              ? { stageStartedAt: nowIso() }
              : {}),
            ...value,
            attempt: operation.attemptCount,
            lastProgressAt: nowIso(),
          };
          const updated = await this.heartbeat(operation.id, progress, owner);
          if (!updated || updated.attemptCount !== operation.attemptCount) {
            controller.abort();
            throw new Error("OPERATION_LEASE_LOST");
          }
          if (stageChanged)
            this.logOrderSync(
              operation,
              String(value.stage),
              executionStartedAt,
              progress,
            );
        },
      });
      controller.signal.throwIfAborted();
      if (operation.operationType === "ORDER_SYNC") {
        await this.databaseService.commitOrderSync(
          (draft) => {
            const target = draft.operations.find(
              (item) => item.id === operation.id,
            )!;
            const finishedAt = nowIso();
            target.progressJson = { ...target.progressJson, error: null };
            Object.assign(target, {
              status: result.coverageGap ? "FAILED" : "SUCCEEDED",
              resultJson: result,
              errorMessage: result.coverageGap
                ? "COVERAGE_GAP: 변경 이력 공백 범위 재수집이 필요합니다."
                : null,
              finishedAt,
              runAfter: null,
              leaseOwner: null,
              leaseExpiresAt: null,
            });
            const store = draft.stores.find(
              (item) => item.id === operation.storeId,
            );
            if (store)
              Object.assign(store, {
                lastOrderSyncAt: finishedAt,
                lastOrderSyncStatus: result.coverageGap
                  ? "FAILED"
                  : "SUCCEEDED",
                updatedAt: finishedAt,
              });
            this.finishBatchIfTerminal(draft, operation);
            if (
              operation.requestJson?.mode === "CURRENT" &&
              !result.coverageGap
            ) {
              let state = draft.orderSyncStates.find(
                (item) => item.storeId === operation.storeId,
              );
              if (!state) {
                state = {
                  id: operation.storeId,
                  storeId: operation.storeId,
                  initialCoverageFrom: String(operation.requestJson.dateFrom),
                  lastSuccessfulChangedTo: null,
                  lastSuccessfulSyncAt: null,
                  updatedAt: finishedAt,
                };
                draft.orderSyncStates.push(state);
              }
              const cutoff = String(operation.requestJson.requestedCutoffAt);
              state.lastSuccessfulChangedTo =
                !state.lastSuccessfulChangedTo ||
                state.lastSuccessfulChangedTo < cutoff
                  ? cutoff
                  : state.lastSuccessfulChangedTo;
              state.lastSuccessfulSyncAt = finishedAt;
              state.updatedAt = finishedAt;
            }
          },
          fence,
          operation.storeId,
          { orderIds: new Set(), itemIds: new Set() },
        );
      } else if (
        !(await this.databaseService.markOperationSucceeded(
          operation.id,
          owner,
          result,
        ))
      )
        throw new Error("OPERATION_LEASE_LOST");
      this.logOrderSync(
        operation,
        result.coverageGap ? "FAILED" : "SUCCEEDED",
        executionStartedAt,
        progress,
        result.coverageGap ? "COVERAGE_GAP" : null,
      );
      // A failed auxiliary audit must never rerun already committed business work.
      await this.appendSuccessAudit(operation, result).catch(() =>
        console.error("OPERATION_AUDIT_FAILED", operation.id),
      );
    } catch (error) {
      const value = (error && typeof error === "object" ? error : {}) as {
        retryable?: boolean;
        code?: string;
        safeMessage?: string;
        category?: string;
        actionHint?: string;
        upstreamStatus?: number;
        upstreamCode?: string;
        traceId?: string;
        retryAfterMs?: number;
      };
      const message =
        value.safeMessage ??
        (operation.operationType === "ORDER_SYNC"
          ? "주문 동기화에 실패했습니다. 스토어 설정과 작업 이력을 확인하세요."
          : toErrorMessage(error));
      const code =
        value.code ??
        (error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "ORDER_SYNC_FAILED");
      const retryable =
        value.retryable ??
        !/CREDENTIAL|AUTH|INACTIVE|INVALID|SCHEMA|COVERAGE|DETAIL|PAGINATION/.test(
          code,
        );
      try {
        await this.heartbeat(
          operation.id,
          {
            ...progress,
            error: {
              code,
              upstreamStatus: value.upstreamStatus,
              upstreamCode: value.upstreamCode,
              traceId: value.traceId,
              category: value.category ?? "SYNC",
              retryable,
              safeMessage: message,
              actionHint:
                value.actionHint ?? "스토어 설정 및 네이버 연결을 확인하세요.",
            },
          },
          owner,
        );
        const shouldRetry =
          retryable && operation.attemptCount < operation.maxAttempts;
        const runAfter = shouldRetry
          ? addMs(
              new Date(),
              Math.max(
                OPERATION_BACKOFF_MS[Math.max(0, operation.attemptCount - 1)] ??
                  900000,
                value.retryAfterMs ?? 0,
              ),
            )
          : null;
        if (operation.operationType === "ORDER_SYNC") {
          await this.databaseService.commitOrderSync(
            (draft) => {
              const target = draft.operations.find(
                (item) => item.id === operation.id,
              )!;
              Object.assign(target, {
                status: shouldRetry ? "QUEUED" : "FAILED",
                errorMessage: message,
                runAfter,
                finishedAt: shouldRetry ? null : nowIso(),
                leaseOwner: null,
                leaseExpiresAt: null,
              });
              this.finishBatchIfTerminal(draft, operation);
              if (!shouldRetry) {
                const store = draft.stores.find(
                  (item) => item.id === operation.storeId,
                );
                if (store)
                  Object.assign(store, {
                    lastOrderSyncStatus: "FAILED",
                    updatedAt: nowIso(),
                  });
              }
            },
            fence,
            operation.storeId,
            { orderIds: new Set(), itemIds: new Set() },
          );
        } else
          await this.databaseService.markOperationFailedOrQueued(
            operation.id,
            owner,
            {
              errorMessage: message,
              shouldRetry,
              runAfter,
              finishedAt: nowIso(),
            },
          );
        this.logOrderSync(
          operation,
          shouldRetry ? "RETRY_QUEUED" : "FAILED",
          executionStartedAt,
          progress,
          code,
        );
      } catch {
        this.logOrderSync(
          operation,
          "FAILURE_PERSIST_UNAVAILABLE",
          executionStartedAt,
          progress,
          code,
        );
        console.error("OPERATION_FAILURE_PERSIST_FAILED", {
          operationId: operation.id,
          code,
        });
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private logOrderSync(
    operation: OperationRecord,
    stage: string,
    executionStartedAt: number,
    progress: Record<string, unknown>,
    errorCode: string | null = null,
  ): void {
    if (operation.operationType !== "ORDER_SYNC") return;
    const stages = new Set([
      "STARTED",
      "VALIDATING",
      "AUTHENTICATING",
      "FETCHING_ORDERS",
      "FETCHING_DETAILS",
      "SAVING",
      "RECALCULATING",
      "FINALIZING",
      "SUCCEEDED",
      "FAILED",
      "RETRY_QUEUED",
      "FAILURE_PERSIST_UNAVAILABLE",
    ]);
    if (!stages.has(stage)) return;
    const count = (key: string) =>
      typeof progress[key] === "number" && Number.isFinite(progress[key])
        ? Math.max(0, Number(progress[key]))
        : 0;
    // Whitelist fields: never serialize requests, raw payloads, or exception text.
    try {
      console.info(
        JSON.stringify({
          batchId:
            typeof operation.requestJson?.batchId === "string"
              ? operation.requestJson.batchId
              : null,
          operationId: operation.id,
          storeId: operation.storeId,
          attempt: operation.attemptCount,
          stage,
          elapsedMs: Math.max(0, Date.now() - executionStartedAt),
          counts: {
            fetched: count("fetchedCount"),
            validated: count("validatedCount"),
            committed: count("committedCount"),
          },
          errorCode:
            errorCode && /^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode)
              ? errorCode
              : errorCode
                ? "ORDER_SYNC_FAILED"
                : null,
        }),
      );
    } catch {
      // An unavailable log sink must not change the persisted operation outcome.
    }
  }

  private finishBatchIfTerminal(
    draft: ReturnType<DatabaseService["getSnapshot"]>,
    operation: OperationRecord,
  ) {
    const batchId = operation.requestJson?.batchId;
    const batch = draft.orderSyncBatches.find((item) => item.id === batchId);
    if (!batch) return;
    const ids = new Set(
      draft.orderSyncBatchItems
        .filter((item) => item.batchId === batchId)
        .map((item) => item.operationId),
    );
    if (
      !draft.operations.some(
        (item) =>
          ids.has(item.id) &&
          (item.status === "QUEUED" || item.status === "RUNNING"),
      )
    )
      batch.finishedAt = nowIso();
  }

  private async appendSuccessAudit(
    operation: OperationRecord,
    result: Record<string, unknown>,
  ) {
    await this.databaseService.writeCommitted((draft) => {
      this.auditLogService.appendToDraft(draft, {
        storeId: operation.storeId,
        domain:
          operation.operationType === "ORDER_SYNC"
            ? "ORDER_SYNC"
            : "RECALCULATION",
        action: "RUN",
        targetId: operation.id,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: null,
        afterJson: result,
      });
    });
  }

  private async cleanupStaleOperations() {
    await this.databaseService.releaseExpiredOperationLeases();
  }
}
