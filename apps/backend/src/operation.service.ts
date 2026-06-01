import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { OperationRecord, OperationStatus, OperationType } from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  createId,
  formatApiSuccess,
  nowIso,
} from "./helpers";

type OperationExecutor = (operation: OperationRecord) => Promise<Record<string, unknown>>;
type LegacyOperationExecutor = () => Promise<Record<string, unknown>>;

const DEFAULT_OPERATION_MAX_ATTEMPTS = 3;
const OPERATION_LEASE_DURATION_MS = 2 * 60 * 1000;
const OPERATION_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const OPERATION_LOCK_BUSY_DELAY_MS = 15 * 1000;
const OPERATION_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || "UNKNOWN");

const addMs = (date: Date, ms: number): string => new Date(date.getTime() + ms).toISOString();

@Injectable()
export class OperationService {
  private readonly retryExecutors = new Map<OperationType, OperationExecutor>();
  private readonly leaseOwner = `backend-${process.pid}-${createId()}`;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditLogService: AuditLogService,
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

  hasInFlightOperation(storeId: string, operationType?: OperationType): boolean {
    const nowAt = nowIso();
    const snapshot = this.databaseService.getSnapshot();
    return snapshot.operations.some(
      (operation) =>
        operation.storeId === storeId &&
        (!operationType || operation.operationType === operationType) &&
        (operation.status === "QUEUED" ||
          (operation.status === "RUNNING" && (!operation.leaseExpiresAt || operation.leaseExpiresAt > nowAt))),
    );
  }

  async list(storeId: string, status?: OperationStatus, operationType?: OperationType, page?: number, pageSize?: number) {
    await this.cleanupStaleOperations();
    const result = await this.databaseService.queryOperations({ storeId, status, operationType, page, pageSize });
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

  async retry(operationId: string) {
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
        errors: [{ field: "operationId", reason: "OPERATION_RETRY_NOT_ALLOWED" }],
      });
    }

    if (!this.retryExecutors.has(operation.operationType)) {
      throw new BadRequestException({
        success: false,
        message: "재시도 실행기를 찾을 수 없습니다.",
        errors: [{ field: "operationType", reason: "OPERATION_RETRY_NOT_ALLOWED" }],
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
      this.leaseOwner,
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
      await this.databaseService.deferOperationLease(operation.id, this.leaseOwner, {
        runAfter: addMs(new Date(), OPERATION_LOCK_BUSY_DELAY_MS),
        errorMessage: "STORE_OPERATION_LOCK_BUSY",
        decrementAttempt: true,
      });
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

  async acquireNextOperation(leaseOwner = this.leaseOwner): Promise<OperationRecord | null> {
    await this.cleanupStaleOperations();
    return this.databaseService.acquireNextOperation(leaseOwner, OPERATION_LEASE_DURATION_MS);
  }

  async tryAcquireExecutionLock(operation: Pick<OperationRecord, "storeId" | "operationType">) {
    return this.databaseService.tryAcquireOperationExecutionLock(operation.storeId, operation.operationType);
  }

  private async runOperation(operation: OperationRecord): Promise<void> {
    const executor = this.retryExecutors.get(operation.operationType);
    const heartbeatTimer = setInterval(() => {
      void this.heartbeat(operation.id).catch((error) => {
        console.error(`[OperationService] heartbeat failed for ${operation.id}: ${toErrorMessage(error)}`);
      });
    }, OPERATION_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    try {
      if (!executor) {
        throw new Error(`OPERATION_EXECUTOR_NOT_REGISTERED:${operation.operationType}`);
      }

      const result = await executor(operation);
      await this.databaseService.markOperationSucceeded(operation.id, this.leaseOwner, result);
      await this.appendSuccessAudit(operation, result);
    } catch (error) {
      await this.markFailure(operation, toErrorMessage(error));
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async markFailure(operation: OperationRecord, errorMessage: string): Promise<void> {
    const shouldRetry = operation.attemptCount < operation.maxAttempts;
    const backoffMs = OPERATION_BACKOFF_MS[Math.min(operation.attemptCount - 1, OPERATION_BACKOFF_MS.length - 1)];
    await this.databaseService.markOperationFailedOrQueued(operation.id, this.leaseOwner, {
      errorMessage,
      shouldRetry,
      runAfter: shouldRetry ? addMs(new Date(), backoffMs) : null,
      finishedAt: nowIso(),
    });
  }

  private async appendSuccessAudit(operation: OperationRecord, result: Record<string, unknown>) {
    await this.databaseService.writeCommitted((draft) => {
      this.auditLogService.appendToDraft(draft, {
        storeId: operation.storeId,
        domain: "RECALCULATION",
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
