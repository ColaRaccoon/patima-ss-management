import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { OperationRecord, OperationStatus, OperationType } from "@patima/shared";
import { DatabaseService } from "./database.service";
import {
  createId,
  formatApiSuccess,
  nowIso,
  paginate,
  sortByUpdatedAtDesc,
} from "./helpers";
import { AuditLogService } from "./audit-log.service";

type OperationExecutor = () => Promise<Record<string, unknown>>;

@Injectable()
export class OperationService implements OnModuleInit {
  private readonly storeQueues = new Map<string, Promise<void>>();
  private readonly retryExecutors = new Map<OperationType, (operation: OperationRecord) => Promise<Record<string, unknown>>>();
  private static readonly STALE_RUNNING_OPERATION_MS = 15 * 60 * 1000;
  private static readonly STALE_QUEUED_OPERATION_MS = 5 * 60 * 1000;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditLogService: AuditLogService,
  ) {}

  onModuleInit(): void {
    this.reconcileInFlightOperations();
  }

  registerRetryExecutor(
    operationType: OperationType,
    executor: (operation: OperationRecord) => Promise<Record<string, unknown>>,
  ) {
    this.retryExecutors.set(operationType, executor);
  }

  hasRunningOperation(storeId: string): boolean {
    this.cleanupStaleOperations();
    const snapshot = this.databaseService.getSnapshot();
    return snapshot.operations.some((operation) => operation.storeId === storeId && operation.status === "RUNNING");
  }

  list(storeId: string, status?: OperationStatus, operationType?: OperationType, page?: number, pageSize?: number) {
    this.cleanupStaleOperations();
    const snapshot = this.databaseService.getSnapshot();
    const items = snapshot.operations
      .filter((item) => item.storeId === storeId)
      .filter((item) => (status ? item.status === status : true))
      .filter((item) => (operationType ? item.operationType === operationType : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return formatApiSuccess(paginate(items, page, pageSize));
  }

  get(operationId: string) {
    this.cleanupStaleOperations();
    const snapshot = this.databaseService.getSnapshot();
    const operation = snapshot.operations.find((item) => item.id === operationId);

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
    });
  }

  async retry(operationId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const operation = snapshot.operations.find((item) => item.id === operationId);
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

    const executor = this.retryExecutors.get(operation.operationType);
    if (!executor) {
      throw new BadRequestException({
        success: false,
        message: "재시도 실행기를 찾을 수 없습니다.",
        errors: [{ field: "operationType", reason: "OPERATION_RETRY_NOT_ALLOWED" }],
      });
    }

    const retryOperation = this.enqueue(
      operation.storeId,
      operation.operationType,
      operation.requestJson ?? {},
      () => executor(operation),
      operation.id,
    );

    return formatApiSuccess({
      operationId: operation.id,
      retryOperationId: retryOperation.id,
      status: retryOperation.status,
    });
  }

  enqueue(
    storeId: string,
    operationType: OperationType,
    requestJson: Record<string, unknown>,
    executor: OperationExecutor,
    retryOfOperationId: string | null = null,
  ): OperationRecord {
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
      cutoffAt: nowIso(),
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
    };

    this.databaseService.write((draft) => {
      draft.operations.push(operation);
    });

    const previous = this.storeQueues.get(storeId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        this.databaseService.write((draft) => {
          const current = draft.operations.find((item) => item.id === operation.id);
          if (!current) {
            return;
          }
          current.status = "RUNNING";
          current.startedAt = nowIso();
        });

        try {
          const result = await executor();
          this.databaseService.write((draft) => {
            const current = draft.operations.find((item) => item.id === operation.id);
            if (!current) {
              return;
            }
            current.status = "SUCCEEDED";
            current.resultJson = result;
            current.finishedAt = nowIso();
          });
          this.auditLogService.record({
            storeId,
            domain: "RECALCULATION",
            action: "RUN",
            targetId: operation.id,
            actorIdentifier: "LOCALHOST_ADMIN",
            beforeJson: null,
            afterJson: result,
          });
        } catch (error) {
          this.databaseService.write((draft) => {
            const current = draft.operations.find((item) => item.id === operation.id);
            if (!current) {
              return;
            }
            current.status = "FAILED";
            current.errorMessage = error instanceof Error ? error.message : "UNKNOWN";
            current.finishedAt = nowIso();
          });
        }
      });

    this.storeQueues.set(storeId, next);

    return operation;
  }

  private reconcileInFlightOperations() {
    this.markOperationsAsFailed((operation) => operation.status === "QUEUED" || operation.status === "RUNNING");
  }

  private cleanupStaleOperations() {
    const now = Date.now();
    this.markOperationsAsFailed((operation) => {
      if (operation.status === "RUNNING" && operation.startedAt) {
        return now - Date.parse(operation.startedAt) > OperationService.STALE_RUNNING_OPERATION_MS;
      }

      if (operation.status === "QUEUED") {
        return now - Date.parse(operation.createdAt) > OperationService.STALE_QUEUED_OPERATION_MS;
      }

      return false;
    });
  }

  private markOperationsAsFailed(predicate: (operation: OperationRecord) => boolean) {
    const snapshot = this.databaseService.getSnapshot();
    const targets = snapshot.operations.filter(predicate);

    if (!targets.length) {
      return;
    }

    const targetIds = new Set(targets.map((operation) => operation.id));
    this.databaseService.write((draft) => {
      draft.operations.forEach((operation) => {
        if (!targetIds.has(operation.id)) {
          return;
        }

        const previousStatus = operation.status;
        operation.status = "FAILED";
        operation.errorMessage =
          previousStatus === "RUNNING"
            ? "SERVER_RESTARTED_DURING_OPERATION"
            : "SERVER_RESTARTED_BEFORE_OPERATION_STARTED";
        operation.finishedAt = nowIso();
      });
    });
  }
}
