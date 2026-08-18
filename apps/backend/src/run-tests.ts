import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSourceSignature, normalizeText, DEFAULT_DELIVERY_UNIT_COST } from "@patima/shared";
import type {
  AdCampaignDailyCost,
  AdCampaignSignature,
  OperationRecord,
  OperationType,
  OrderItem,
  OrderSourceSignature,
  StoredDailySalesUnitProfit,
  StoredDailyStoreSummary,
} from "@patima/shared";
import * as XLSX from "xlsx";
import {
  applyAdCampaignSignatureToRows,
  evaluateAdMapping,
  getAdMappingOverride,
  ensureAdCampaignSignaturesForStore,
  recalculateAdCampaignSignaturesForStore,
} from "./ad-mapping-engine";
import { AD_UPLOAD_REQUIRED_HEADERS, AdsService } from "./ads.service";
import { DatabaseService, POSTGRES_UPSERT_BATCH_SIZE, hashPayload, stableStringify } from "./database.service";
import { FakePurchaseService } from "./fake-purchase.service";
import {
  calculateDashboardSummary,
  calculateDailyProfitRows,
  calculateFee,
  calculateStoreDeliverySummary,
  calculateVatAmount,
  calculateVatAdjustedRevenue,
  coalesceNonBlankText,
  createEmptyDatabase,
  getActiveConfirmedUploadIds,
  getAdMappingStatus,
  getOrderItemMappingStatus,
  getSignatureIndex,
  getWeekdayNameKo,
  mapOrderItemResponse,
  paginate,
  repairMojibakeText,
  resolvePackageKey,
  saleStatusFromNaverOrderState,
  saleStatusFromRawStatus,
} from "./helpers";
import { NaverCommerceConfigService } from "./naver-commerce-config.service";
import { NaverCommerceService, createNaverClientSecretSign } from "./naver-commerce.service";
import type { SyncedOrderItemInput } from "./naver-commerce.service";
import { MappingSeedService } from "./mapping-seed.service";
import { OrderMappingService } from "./order-mapping.service";
import { OrderSyncService } from "./order-sync.service";
import { OperationService } from "./operation.service";
import { OperationWorkerService } from "./operation-worker.service";
import { ProfitService } from "./profit.service";
import { ProfitSummaryService } from "./profit-summary.service";
import {
  DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS,
  getKstRetentionCutoffDate,
  getOrderRawPayloadRetentionDays,
} from "./raw-payload-retention";
import {
  recalculateOrderMappingsForStore,
  recalculateOrderMappingsForTouchedItems,
  resolveOrderSignatureAutoMapping,
} from "./sales-unit-auto-mapper";
import { SalesUnitService } from "./sales-unit.service";
import { isMeaningfulName, extractNameFromOptionInfo, enrichSignatureDisplayName } from "./signature-enrichment";
import { buildPaginationResult, createSqlBuilder, normalizePagination } from "./query-builders";

const run = (name: string, fn: () => void) => {
  fn();
  console.log(`PASS ${name}`);
};

const pendingAsyncTests: Promise<void>[] = [];
let asyncTestChain = Promise.resolve();
const runAsync = (name: string, fn: () => Promise<void>) => {
  const testPromise = asyncTestChain.then(fn).then(() => {
    console.log(`PASS ${name}`);
  });
  asyncTestChain = testPromise;
  pendingAsyncTests.push(testPromise);
};

const createSalesUnit = (id: string, displayName: string, matchAliases: string[]) =>
  ({
    id,
    storeId: "store-1",
    displayName,
    matchAliases,
    normalizedMatchAliases: matchAliases.map((alias) => alias.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase()),
    linkedProductIds: [],
    linkedOptionCodes: [],
    linkedManageCodes: [],
    memo: null,
    isActive: true,
    deactivatedAt: null,
    isStoreLevel: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

const createOperationRecord = (
  overrides: Partial<OperationRecord> &
    Pick<OperationRecord, "id" | "storeId" | "operationType" | "status">,
): OperationRecord => {
  const timestamp = new Date().toISOString();
  return {
    retryOfOperationId: null,
    requestedBy: "LOCALHOST_ADMIN",
    requestJson: {},
    resultJson: null,
    errorMessage: null,
    cutoffAt: timestamp,
    createdAt: timestamp,
    startedAt: null,
    finishedAt: null,
    attemptCount: 0,
    maxAttempts: 3,
    runAfter: null,
    heartbeatAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lockedAt: null,
    progressJson: null,
    ...overrides,
  };
};

const normalizeOperationForTest = (operation: OperationRecord): OperationRecord =>
  createOperationRecord(operation);

const createMemoryDatabaseService = (database = createEmptyDatabase()) => ({
  database,
  storageMode: "file" as "file" | "postgres",
  operationLocks: new Set<string>(),
  writeCommittedCalls: 0,
  createCanonicalSalesUnitCommittedCalls: 0,
  saveOrderManualMappingsCommittedCalls: 0,
  saveAdCampaignMappingsCommittedCalls: 0,
  replaceDailyProfitSummariesCommittedCalls: 0,
  removeDailyProfitSummariesCommittedCalls: 0,
  getStorageMode() {
    return this.storageMode;
  },
  getSnapshot() {
    return JSON.parse(JSON.stringify(this.database));
  },
  write(mutator: (draft: typeof database) => unknown) {
    const draft = this.getSnapshot();
    const result = mutator(draft);
    this.database = draft;
    return result;
  },
  async writeCommitted(mutator: (draft: typeof database) => unknown) {
    this.writeCommittedCalls += 1;
    return this.write(mutator);
  },
  async createCanonicalSalesUnitCommitted(params: {
    salesUnit: (typeof database.canonicalSalesUnits)[number];
    auditLog?: (typeof database.auditLogs)[number] | null;
  }) {
    this.createCanonicalSalesUnitCommittedCalls += 1;
    const apply = (draft: typeof database) => {
      if (!draft.stores.some((store) => store.id === params.salesUnit.storeId)) {
        throw new Error("STORE_NOT_FOUND");
      }
      const existingIndex = draft.canonicalSalesUnits.findIndex((salesUnit) => salesUnit.id === params.salesUnit.id);
      if (existingIndex === -1) {
        draft.canonicalSalesUnits.push(params.salesUnit);
      } else {
        draft.canonicalSalesUnits[existingIndex] = params.salesUnit;
      }
      if (params.auditLog) {
        const auditIndex = draft.auditLogs.findIndex((auditLog) => auditLog.id === params.auditLog!.id);
        if (auditIndex === -1) {
          draft.auditLogs.push(params.auditLog);
        } else {
          draft.auditLogs[auditIndex] = params.auditLog;
        }
      }
      return { salesUnit: JSON.parse(JSON.stringify(params.salesUnit)) };
    };

    if (this.storageMode !== "postgres") {
      return this.writeCommitted(apply);
    }

    return apply(this.database);
  },
  async saveOrderManualMappingsCommitted(params: {
    storeId: string;
    signatureIds: string[];
    canonicalSalesUnitId: string;
    timestamp: string;
  }) {
    this.saveOrderManualMappingsCommittedCalls += 1;
    const signatureIds = Array.from(new Set(params.signatureIds.filter(Boolean)));
    const apply = (draft: typeof database) => {
      const targetIds = new Set(signatureIds);
      const signatures = signatureIds.map((signatureId) =>
        draft.orderSourceSignatures.find((item) => item.id === signatureId),
      );
      if (signatures.some((signature) => !signature || signature.storeId !== params.storeId)) {
        throw new Error("ORDER_MANUAL_MAPPING_TARGET_NOT_FOUND");
      }
      signatures.forEach((signature) => {
        const target = signature as OrderSourceSignature;
        target.canonicalSalesUnitId = params.canonicalSalesUnitId;
        target.mappingStatus = "MAPPED";
        target.confirmedAt = params.timestamp;
        target.updatedAt = params.timestamp;
      });

      const updatedOrderItems: OrderItem[] = [];
      draft.orderItems.forEach((item) => {
        if (
          item.storeId !== params.storeId ||
          !item.orderSourceSignatureId ||
          !targetIds.has(item.orderSourceSignatureId)
        ) {
          return;
        }
        item.canonicalSalesUnitId = params.canonicalSalesUnitId;
        item.updatedAt = params.timestamp;
        updatedOrderItems.push(item as OrderItem);
      });

      return {
        signatureIds,
        updatedOrderItemCount: updatedOrderItems.length,
        affectedDates: Array.from(
          new Set(updatedOrderItems.map((item) => item.paymentDate).filter((date): date is string => Boolean(date))),
        ).sort((left, right) => left.localeCompare(right)),
      };
    };

    if (this.storageMode !== "postgres") {
      return this.writeCommitted(apply);
    }

    return apply(this.database);
  },
  async saveAdCampaignMappingsCommitted(params: {
    storeId: string;
    targetIds: string[];
    action:
      | { type: "MANUAL_MAPPED"; canonicalSalesUnitId: string; timestamp: string }
      | { type: "INTENTIONALLY_UNMAPPED"; reasonNote: string; timestamp: string }
      | { type: "RECALCULATE" };
  }) {
    this.saveAdCampaignMappingsCommittedCalls += 1;
    const targetIds = Array.from(new Set(params.targetIds.filter(Boolean)));
    const apply = (draft: typeof database) => {
      const directSignatureIds = new Set(
        targetIds.filter((id) =>
          draft.adCampaignSignatures.some((signature) => signature.id === id && signature.storeId === params.storeId),
        ),
      );
      const rowIds = targetIds.filter((id) =>
        draft.adCampaignDailyCosts.some((row) => row.id === id && row.storeId === params.storeId),
      );
      if (directSignatureIds.size + rowIds.length !== targetIds.length) {
        throw new Error("AD_CAMPAIGN_MAPPING_TARGET_NOT_FOUND");
      }
      const rowSignatureIds = ensureAdCampaignSignaturesForStore(draft, params.storeId, rowIds);
      const signatureIds = new Set([...directSignatureIds, ...rowSignatureIds]);
      draft.adCampaignDailyCosts.forEach((row) => {
        if (row.storeId === params.storeId && rowIds.includes(row.id) && row.adCampaignSignatureId) {
          signatureIds.add(row.adCampaignSignatureId);
        }
      });

      const action = params.action;
      if (action.type === "RECALCULATE") {
        recalculateAdCampaignSignaturesForStore(draft, params.storeId, {
          signatureIds,
          applyToRows: true,
        });
      } else {
        draft.adCampaignSignatures.forEach((signature) => {
          if (!signatureIds.has(signature.id)) {
            return;
          }
          if (action.type === "MANUAL_MAPPED") {
            signature.canonicalSalesUnitId = action.canonicalSalesUnitId;
            signature.mappingReason = "MANUAL_MAPPED";
            signature.reasonNote = null;
          } else {
            signature.canonicalSalesUnitId = null;
            signature.mappingReason = "INTENTIONALLY_UNMAPPED";
            signature.reasonNote = action.reasonNote;
          }
          signature.matchedRuleCount = 0;
          signature.reasonNoteInherited = false;
          signature.confirmedAt = action.timestamp;
          signature.updatedAt = action.timestamp;
        });
        applyAdCampaignSignatureToRows(draft, {
          storeId: params.storeId,
          signatureIds,
        });
      }

      const updatedRows = draft.adCampaignDailyCosts.filter(
        (row) => row.storeId === params.storeId && row.adCampaignSignatureId && signatureIds.has(row.adCampaignSignatureId),
      );
      return {
        signatureIds: Array.from(signatureIds),
        updatedAdCampaignDailyCostCount: updatedRows.length,
        affectedDates: Array.from(new Set(updatedRows.map((row) => row.reportDate))).sort((left, right) =>
          left.localeCompare(right),
        ),
      };
    };

    if (this.storageMode !== "postgres") {
      return this.writeCommitted(apply);
    }

    return apply(this.database);
  },
  async replaceDailyProfitSummariesCommitted(params: {
    storeId: string;
    dates: string[];
    buildReplacement: (database: ReturnType<typeof createEmptyDatabase>) => {
      dailySalesUnitProfits: StoredDailySalesUnitProfit[];
      dailyStoreSummaries: StoredDailyStoreSummary[];
      result: unknown;
    };
  }) {
    this.replaceDailyProfitSummariesCommittedCalls += 1;
    return this.write((draft) => {
      const replacement = params.buildReplacement(draft);
      const dateSet = new Set(params.dates);
      draft.dailySalesUnitProfits = draft.dailySalesUnitProfits.filter(
        (row) => row.storeId !== params.storeId || !dateSet.has(row.date),
      );
      draft.dailyStoreSummaries = draft.dailyStoreSummaries.filter(
        (row) => row.storeId !== params.storeId || !dateSet.has(row.date),
      );
      draft.dailySalesUnitProfits.push(...replacement.dailySalesUnitProfits);
      draft.dailyStoreSummaries.push(...replacement.dailyStoreSummaries);
      return replacement.result;
    });
  },
  async removeDailyProfitSummariesCommitted(params: { storeId: string; dates: string[] }) {
    this.removeDailyProfitSummariesCommittedCalls += 1;
    return this.write((draft) => {
      const dateSet = new Set(params.dates);
      draft.dailySalesUnitProfits = draft.dailySalesUnitProfits.filter(
        (row) => row.storeId !== params.storeId || !dateSet.has(row.date),
      );
      draft.dailyStoreSummaries = draft.dailyStoreSummaries.filter(
        (row) => row.storeId !== params.storeId || !dateSet.has(row.date),
      );
    });
  },
  async queryOperations(query: {
    storeId: string;
    status?: string;
    operationType?: string;
    page?: number;
    pageSize?: number;
  }) {
    const items = this.database.operations
      .map((item) => normalizeOperationForTest(item))
      .filter((item) => item.storeId === query.storeId)
      .filter((item) => (query.status ? item.status === query.status : true))
      .filter((item) => (query.operationType ? item.operationType === query.operationType : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return paginate(items, query.page, query.pageSize);
  },
  async getOperationById(operationId: string) {
    const operation = this.database.operations.find((item) => item.id === operationId);
    return operation ? JSON.parse(JSON.stringify(normalizeOperationForTest(operation))) : null;
  },
  async insertOperation(operation: OperationRecord) {
    const normalized = normalizeOperationForTest(operation);
    return this.write((draft) => {
      draft.operations.push(normalized);
      return JSON.parse(JSON.stringify(normalized));
    });
  },
  async releaseExpiredOperationLeases(now = new Date()) {
    const nowAt = now.toISOString();
    return this.write((draft) => {
      let recoveredCount = 0;
      draft.operations = draft.operations.map((operation) => {
        const normalized = normalizeOperationForTest(operation);
        if (normalized.status !== "RUNNING" || (normalized.leaseExpiresAt && normalized.leaseExpiresAt > nowAt)) {
          return operation;
        }
        recoveredCount += 1;
        if (normalized.attemptCount >= normalized.maxAttempts) {
          return {
            ...normalized,
            status: "FAILED",
            errorMessage: normalized.errorMessage ?? "OPERATION_LEASE_EXPIRED",
            runAfter: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            finishedAt: nowAt,
          };
        }
        return {
          ...normalized,
          status: "QUEUED",
          errorMessage: "OPERATION_LEASE_EXPIRED",
          runAfter: nowAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          finishedAt: null,
        };
      });
      return recoveredCount;
    });
  },
  async acquireNextOperation(leaseOwner: string, leaseDurationMs: number, now = new Date()) {
    return this.write((draft) => {
      const nowAt = now.toISOString();
      const normalized = draft.operations.map((operation, index) => ({
        index,
        operation: normalizeOperationForTest(operation),
      }));
      const candidate = normalized
        .filter(({ operation }) => {
          if (operation.attemptCount >= operation.maxAttempts) {
            return false;
          }
          if (operation.status === "QUEUED") {
            return !operation.runAfter || operation.runAfter <= nowAt;
          }
          return operation.status === "RUNNING" && (!operation.leaseExpiresAt || operation.leaseExpiresAt <= nowAt);
        })
        .filter(
          ({ operation }) =>
            !normalized.some(
              ({ operation: active }) =>
                active.id !== operation.id &&
                active.storeId === operation.storeId &&
                active.operationType === operation.operationType &&
                active.status === "RUNNING" &&
                !!active.leaseExpiresAt &&
                active.leaseExpiresAt > nowAt,
            ),
        )
        .sort((left, right) => {
          const leftRank = left.operation.status === "RUNNING" ? 0 : 1;
          const rightRank = right.operation.status === "RUNNING" ? 0 : 1;
          return (
            leftRank - rightRank ||
            (left.operation.runAfter ?? left.operation.createdAt).localeCompare(
              right.operation.runAfter ?? right.operation.createdAt,
            ) ||
            left.operation.createdAt.localeCompare(right.operation.createdAt)
          );
        })[0];

      if (!candidate) {
        return null;
      }

      const leased = createOperationRecord({
        ...candidate.operation,
        status: "RUNNING",
        attemptCount: candidate.operation.attemptCount + 1,
        runAfter: null,
        errorMessage: null,
        startedAt: candidate.operation.startedAt ?? nowAt,
        finishedAt: null,
        heartbeatAt: nowAt,
        lockedAt: nowAt,
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
      });
      draft.operations[candidate.index] = leased;
      return JSON.parse(JSON.stringify(leased));
    });
  },
  async heartbeatOperation(
    operationId: string,
    leaseOwner: string,
    leaseDurationMs: number,
    progressJson?: Record<string, unknown> | null,
    now = new Date(),
  ) {
    return this.write((draft) => {
      const operation = draft.operations.find((item) => item.id === operationId);
      if (!operation || operation.leaseOwner !== leaseOwner) {
        return null;
      }
      operation.heartbeatAt = now.toISOString();
      operation.leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
      if (progressJson !== undefined) {
        operation.progressJson = progressJson;
      }
      return JSON.parse(JSON.stringify(operation));
    });
  },
  async markOperationSucceeded(operationId: string, leaseOwner: string, resultJson: Record<string, unknown>) {
    return this.write((draft) => {
      const operation = draft.operations.find((item) => item.id === operationId);
      if (!operation || operation.leaseOwner !== leaseOwner) {
        return null;
      }
      operation.status = "SUCCEEDED";
      operation.resultJson = resultJson;
      operation.errorMessage = null;
      operation.finishedAt = new Date().toISOString();
      operation.runAfter = null;
      operation.leaseOwner = null;
      operation.leaseExpiresAt = null;
      return JSON.parse(JSON.stringify(operation));
    });
  },
  async markOperationFailedOrQueued(
    operationId: string,
    leaseOwner: string,
    params: { errorMessage: string; shouldRetry: boolean; runAfter: string | null; finishedAt?: string },
  ) {
    return this.write((draft) => {
      const operation = draft.operations.find((item) => item.id === operationId);
      if (!operation || operation.leaseOwner !== leaseOwner) {
        return null;
      }
      operation.status = params.shouldRetry ? "QUEUED" : "FAILED";
      operation.errorMessage = params.errorMessage;
      operation.runAfter = params.shouldRetry ? params.runAfter : null;
      operation.leaseOwner = null;
      operation.leaseExpiresAt = null;
      operation.finishedAt = params.shouldRetry ? null : (params.finishedAt ?? new Date().toISOString());
      return JSON.parse(JSON.stringify(operation));
    });
  },
  async deferOperationLease(
    operationId: string,
    leaseOwner: string,
    params: { runAfter: string; errorMessage: string; decrementAttempt?: boolean },
  ) {
    return this.write((draft) => {
      const operation = draft.operations.find((item) => item.id === operationId);
      if (!operation || operation.leaseOwner !== leaseOwner) {
        return null;
      }
      operation.status = "QUEUED";
      operation.attemptCount = Math.max(0, operation.attemptCount - (params.decrementAttempt ? 1 : 0));
      operation.errorMessage = params.errorMessage;
      operation.runAfter = params.runAfter;
      operation.leaseOwner = null;
      operation.leaseExpiresAt = null;
      operation.finishedAt = null;
      return JSON.parse(JSON.stringify(operation));
    });
  },
  async tryAcquireOperationExecutionLock(storeId: string, operationType: OperationType) {
    const lockName = `operation:${storeId}:${operationType}`;
    if (this.operationLocks.has(lockName)) {
      return null;
    }
    this.operationLocks.add(lockName);
    let released = false;
    return {
      lockName,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        this.operationLocks.delete(lockName);
      },
    };
  },
  async queryOrderItems(query: {
    storeId: string;
    dateFrom?: string;
    dateTo?: string;
    productName?: string;
    optionInfo?: string;
    mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED" | "CONFLICT";
    orderStatus?: string;
    saleStatus?: string;
    paymentDateStatus?: "ALL" | "PRESENT" | "MISSING";
    page?: number;
    pageSize?: number;
  }) {
    const keywordProduct = query.productName ? normalizeText(query.productName) : null;
    const keywordOption = query.optionInfo ? normalizeText(query.optionInfo) : null;
    const signaturesById = getSignatureIndex(this.database);
    const getSearchText = (item: OrderItem) => {
      const signature = item.orderSourceSignatureId ? signaturesById.get(item.orderSourceSignatureId) : null;
      return {
        normalizedProductName: coalesceNonBlankText(signature?.normalizedProductName, item.normalizedProductName) ?? "",
        normalizedOptionInfo: coalesceNonBlankText(signature?.normalizedOptionInfo, item.normalizedOptionInfo) ?? "",
      };
    };
    const items = this.database.orderItems
      .filter((item) => item.storeId === query.storeId)
      .filter((item) =>
        query.dateFrom && query.dateTo
          ? !!item.paymentDate && item.paymentDate >= query.dateFrom && item.paymentDate <= query.dateTo
          : true,
      )
      .filter((item) => (keywordProduct ? getSearchText(item).normalizedProductName.includes(keywordProduct) : true))
      .filter((item) => (keywordOption ? getSearchText(item).normalizedOptionInfo.includes(keywordOption) : true))
      .filter((item) =>
        query.mappingStatus && query.mappingStatus !== "ALL"
          ? getOrderItemMappingStatus(this.database, item) === query.mappingStatus
          : true,
      )
      .filter((item) => (query.orderStatus ? item.orderStatus === query.orderStatus : true))
      .filter((item) => (query.saleStatus ? item.saleStatus === query.saleStatus : true))
      .filter((item) =>
        query.paymentDateStatus && query.paymentDateStatus !== "ALL"
          ? query.paymentDateStatus === "PRESENT"
            ? !!item.paymentDate
            : !item.paymentDate
          : true,
      )
      .sort((left, right) => (right.paymentDate ?? "").localeCompare(left.paymentDate ?? ""));

    return paginate(items, query.page, query.pageSize);
  },
  async queryAdCampaignSignatures(query: {
    storeId: string;
    dateFrom?: string;
    dateTo?: string;
    mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED" | "CONFLICT";
    q?: string;
    page?: number;
    pageSize?: number;
  }) {
    const activeUploadIds = getActiveConfirmedUploadIds(this.database, query.storeId);
    const keyword = query.q ? normalizeText(query.q) : null;
    const rowsBySignatureId = new Map<string, Array<(typeof database.adCampaignDailyCosts)[number]>>();
    const salesUnitsById = new Map(this.database.canonicalSalesUnits.map((item) => [item.id, item]));

    this.database.adCampaignDailyCosts
      .filter((row) => row.storeId === query.storeId && activeUploadIds.has(row.sourceUploadId))
      .filter((row) => (query.dateFrom ? row.reportDate >= query.dateFrom : true))
      .filter((row) => (query.dateTo ? row.reportDate <= query.dateTo : true))
      .forEach((row) => {
        if (!row.adCampaignSignatureId) {
          return;
        }
        const rows = rowsBySignatureId.get(row.adCampaignSignatureId) ?? [];
        rows.push(row);
        rowsBySignatureId.set(row.adCampaignSignatureId, rows);
      });

    const signatures = this.database.adCampaignSignatures
      .filter((signature) => signature.storeId === query.storeId)
      .filter((signature) => rowsBySignatureId.has(signature.id))
      .filter((signature) =>
        query.mappingStatus && query.mappingStatus !== "ALL"
          ? getAdMappingStatus(signature) === query.mappingStatus
          : true,
      )
      .filter((signature) => {
        if (!keyword) {
          return true;
        }

        const rows = rowsBySignatureId.get(signature.id) ?? [];
        const salesUnitDisplayName = signature.canonicalSalesUnitId
          ? salesUnitsById.get(signature.canonicalSalesUnitId)?.displayName
          : null;
        const mappingReasonAlias =
          signature.mappingReason === "NO_RULE"
            ? "NO_RULE_MATCH"
            : signature.mappingReason === "MULTIPLE_RULES"
              ? "MULTIPLE_RULE_MATCHES"
              : signature.mappingReason;

        return (
          normalizeText(signature.campaignNameSnapshot).includes(keyword) ||
          normalizeText(repairMojibakeText(signature.campaignNameSnapshot)).includes(keyword) ||
          normalizeText(signature.normalizedCampaignName).includes(keyword) ||
          normalizeText(signature.campaignId ?? "").includes(keyword) ||
          normalizeText(salesUnitDisplayName).includes(keyword) ||
          normalizeText(signature.mappingReason).includes(keyword) ||
          normalizeText(mappingReasonAlias).includes(keyword) ||
          normalizeText(repairMojibakeText(signature.reasonNote)).includes(keyword) ||
          normalizeText(signature.firstSeenDate).includes(keyword) ||
          normalizeText(signature.lastSeenDate).includes(keyword) ||
          rows.some((row) => normalizeText(row.reportDate).includes(keyword))
        );
      })
      .sort((left, right) =>
        (right.lastSeenDate ?? right.updatedAt).localeCompare(left.lastSeenDate ?? left.updatedAt),
      );

    return paginate(
      signatures.map((signature) => {
        const rows = rowsBySignatureId.get(signature.id) ?? [];
        const latestRow = rows
          .slice()
          .sort((left, right) =>
            `${right.reportDate}:${right.updatedAt}`.localeCompare(`${left.reportDate}:${left.updatedAt}`),
          )[0];

        return {
          signature,
          latestRow: latestRow ?? null,
          totalCost: rows.reduce((sum, row) => sum + row.totalCost, 0),
          rowCount: rows.length,
        };
      }),
      query.page,
      query.pageSize,
    );
  },
});

const createAuditLogServiceDouble = (auditCalls: Array<Record<string, unknown>> = []) => ({
  createAuditLog(params: Record<string, unknown>) {
    auditCalls.push(params);
    return {
      id: `audit-test-${auditCalls.length}`,
      actorType: "LOCALHOST_ADMIN",
      createdAt: new Date().toISOString(),
      ...params,
    };
  },
  record(params: Record<string, unknown>) {
    auditCalls.push(params);
    return params;
  },
  async recordCommitted(params: Record<string, unknown>) {
    auditCalls.push(params);
    return params;
  },
  appendToDraft(draft: { auditLogs?: unknown[] }, params: Record<string, unknown>) {
    auditCalls.push(params);
    draft.auditLogs?.push({
      id: `audit-test-${auditCalls.length}`,
      actorType: "LOCALHOST_ADMIN",
      createdAt: new Date().toISOString(),
      ...params,
    });
    return params;
  },
});

const createAdsServiceHarness = (params?: { withProfitSummaryService?: boolean }) => {
  const databaseService = createMemoryDatabaseService();
  const profitSummaryService = params?.withProfitSummaryService
    ? new ProfitSummaryService(databaseService as never)
    : undefined;
  const adsService = new AdsService(
    databaseService as never,
    {
      ensureWritable: () => undefined,
    } as never,
    {
      registerRetryExecutor: () => undefined,
      enqueue: () => {
        throw new Error("enqueue not used in tests");
      },
    } as never,
    createAuditLogServiceDouble() as never,
    profitSummaryService,
  );

  return { databaseService, adsService, profitSummaryService };
};

const createOrderMappingServiceHarness = (params?: { withProfitSummaryService?: boolean }) => {
  const databaseService = createMemoryDatabaseService();
  const enqueueCalls: Array<{ storeId: string; requestJson: Record<string, unknown> }> = [];
  const profitSummaryService = params?.withProfitSummaryService
    ? new ProfitSummaryService(databaseService as never)
    : undefined;
  const orderMappingService = new OrderMappingService(
    databaseService as never,
    {
      registerRetryExecutor: () => undefined,
      enqueue: (storeId: string, _operationType: string, requestJson: Record<string, unknown>) => {
        enqueueCalls.push({ storeId, requestJson });
        return { id: `operation-${enqueueCalls.length}` };
      },
    } as never,
    {
      ensureWritable: () => undefined,
    } as never,
    {
      create: () => {
        throw new Error("create not used in this test");
      },
    } as never,
    profitSummaryService,
  );

  return { databaseService, orderMappingService, enqueueCalls, profitSummaryService };
};

const createFakePurchaseServiceHarness = () => {
  const databaseService = createMemoryDatabaseService();
  const auditCalls: Array<Record<string, unknown>> = [];
  const fakePurchaseService = new FakePurchaseService(
    databaseService as never,
    {
      ensureWritable: (storeId: string) => {
        const exists = databaseService
          .getSnapshot()
          .stores.some((store: { id: string }) => store.id === storeId);
        if (!exists) {
          throw new Error("STORE_NOT_FOUND");
        }
      },
    } as never,
    createAuditLogServiceDouble(auditCalls) as never,
  );

  databaseService.write((draft) => {
    draft.stores.push({
      id: "store-1",
      name: "Main Store",
      platformType: "NAVER_SMARTSTORE",
      sellerAccountId: "seller-1",
      channelNo: "channel-1",
      isPrimary: true,
      isActive: true,
      deactivatedAt: null,
      memo: null,
      lastOrderSyncAt: null,
      lastOrderSyncStatus: "NEVER",
      credentialConnectionStatus: "NOT_TESTED",
      lastCredentialTestAt: null,
      deliveryUnitCost: DEFAULT_DELIVERY_UNIT_COST,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  return { databaseService, fakePurchaseService, auditCalls };
};

const createStoreRecord = (id: string, name: string, isActive = true) =>
  ({
    id,
    name,
    platformType: "NAVER_SMARTSTORE",
    sellerAccountId: `seller-${id}`,
    channelNo: `channel-${id}`,
    isPrimary: id === "store-live",
    isActive,
    deactivatedAt: isActive ? null : new Date().toISOString(),
    memo: null,
    lastOrderSyncAt: null,
    lastOrderSyncStatus: "NEVER",
    credentialConnectionStatus: "NOT_TESTED",
    lastCredentialTestAt: null,
    deliveryUnitCost: DEFAULT_DELIVERY_UNIT_COST,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

const createOrderSyncServiceHarness = (params?: {
  stores?: ReturnType<typeof createStoreRecord>[];
  configuredStoreIds?: string[];
  inFlightStoreIds?: string[];
  liveOrderItems?: SyncedOrderItemInput[];
  withProfitSummaryService?: boolean;
}) => {
  const databaseService = createMemoryDatabaseService();
  const profitSummaryService = params?.withProfitSummaryService
    ? new ProfitSummaryService(databaseService as never)
    : undefined;
  const enqueueCalls: Array<{
    storeId: string;
    operationType: string;
    requestJson: Record<string, unknown>;
  }> = [];
  const fetchOrderItemsCalls: Array<{
    storeId: string;
    dateFrom: string;
    dateTo: string;
    options?: { includeRawPayload?: boolean };
  }> = [];
  const retryExecutors = new Map<string, (operation: Record<string, unknown>) => unknown>();
  const configuredStoreIds = new Set(params?.configuredStoreIds ?? ["store-live"]);
  const inFlightStoreIds = new Set(params?.inFlightStoreIds ?? []);

  databaseService.write((draft) => {
    draft.stores.push(
      ...(params?.stores ?? [
        createStoreRecord("store-live", "Live Store"),
        createStoreRecord("store-missing", "Missing Credential Store"),
        createStoreRecord("store-inactive", "Inactive Store", false),
      ]),
    );
  });

  const operationService = {
    registerRetryExecutor: (
      operationType: string,
      executor: (operation: Record<string, unknown>) => unknown,
    ) => {
      retryExecutors.set(operationType, executor);
    },
    hasInFlightOperation: (storeId: string) => inFlightStoreIds.has(storeId),
    enqueue: (
      storeId: string,
      operationType: string,
      requestJson: Record<string, unknown>,
    ) => {
      enqueueCalls.push({ storeId, operationType, requestJson });
      return {
        id: `operation-${enqueueCalls.length}`,
        operationType,
        status: "QUEUED",
      };
    },
  };

  const orderSyncService = new OrderSyncService(
    databaseService as never,
    operationService as never,
    createAuditLogServiceDouble() as never,
    {
      getResolvedConfiguration: (storeId: string) =>
        configuredStoreIds.has(storeId) ? { store: { id: storeId }, credential: {} } : null,
      fetchOrderItems: (
        storeId: string,
        dateFrom: string,
        dateTo: string,
        options?: { includeRawPayload?: boolean },
      ) => {
        fetchOrderItemsCalls.push({ storeId, dateFrom, dateTo, options });
        if (params?.liveOrderItems) {
          return params.liveOrderItems;
        }
        throw new Error("fetchOrderItems not configured for this test");
      },
    } as never,
    profitSummaryService,
  );

  return {
    databaseService,
    orderSyncService,
    enqueueCalls,
    fetchOrderItemsCalls,
    retryExecutors,
    profitSummaryService,
  };
};

const createSyncedOrderItemInput = (params: {
  externalOrderId: string;
  externalProductOrderId: string;
  date: string;
  paymentDate?: string | null;
  rawPayload?: Record<string, unknown> | null;
  rawProductName?: string;
  optionCode?: string | null;
  optionManageCode?: string;
  paymentCommission?: number | null;
  deliveryFeeAmount?: number | null;
  productPaymentAmount?: number;
  totalProductAmount?: number | null;
}): SyncedOrderItemInput => {
  const productPaymentAmount = params.productPaymentAmount ?? 10000;
  const paymentDate = params.paymentDate === undefined ? params.date : params.paymentDate;
  return {
    externalOrderId: params.externalOrderId,
    externalProductOrderId: params.externalProductOrderId,
    externalProductId: `product-${params.externalProductOrderId}`,
    rawProductName: params.rawProductName ?? "Retention Test Product",
    rawOptionInfo: "Color: Black",
    optionCode: params.optionCode ?? "OPT-RETENTION",
    optionManageCode: params.optionManageCode,
    quantity: 1,
    productPaymentAmount,
    totalProductAmount: params.totalProductAmount ?? productPaymentAmount,
    deliveryFeeAmount: params.deliveryFeeAmount ?? 3000,
    paymentCommission: params.paymentCommission ?? 150,
    knowledgeShoppingSellingInterlockCommission: 80,
    saleCommission: 0,
    channelCommission: 0,
    orderDate: params.date,
    paymentDate,
    orderDateTime: `${params.date}T09:00:00+09:00`,
    paymentDateTime: paymentDate ? `${paymentDate}T09:30:00+09:00` : null,
    productOrderStatus: "DELIVERED",
    claimStatus: null,
    rawStatus: "DELIVERED",
    saleStatus: "SALE",
    packageNumber: `PKG-${params.externalOrderId}`,
    rawPayload: params.rawPayload === undefined ? { source: params.externalProductOrderId } : params.rawPayload,
  };
};

const createOrderSourceSignature = (id: string, productName: string, storeId = "store-1") =>
  ({
    id,
    storeId,
    rawProductNameSnapshot: productName,
    rawOptionInfoSnapshot: null,
    normalizedProductName: normalizeText(productName),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature(productName, null),
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED",
    confirmedAt: null,
    usageCount: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    sampleExternalProductId: null,
    sampleOptionCode: null,
    sampleOptionManageCode: null,
    lastAutoMappedAt: null,
    mappingRuleHash: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

const createStoredDailySalesUnitProfitForTest = (
  overrides: Partial<StoredDailySalesUnitProfit> = {},
): StoredDailySalesUnitProfit => {
  const date = overrides.date ?? "2026-04-01";
  const storeId = overrides.storeId ?? "store-1";
  const canonicalSalesUnitId = overrides.canonicalSalesUnitId ?? "sales-1";
  return {
    id: overrides.id ?? `daily-sales-unit-profit:${storeId}:${date}:${canonicalSalesUnitId}`,
    storeId,
    date,
    canonicalSalesUnitId,
    displayName: overrides.displayName ?? "Test Unit",
    totalQuantity: overrides.totalQuantity ?? 1,
    totalRevenue: overrides.totalRevenue ?? 100,
    totalProductRevenue: overrides.totalProductRevenue ?? 100,
    totalDeliveryFeeAmount: overrides.totalDeliveryFeeAmount ?? 0,
    totalAdCost: overrides.totalAdCost ?? 0,
    totalUnitCost: overrides.totalUnitCost ?? 0,
    totalFeeCost: overrides.totalFeeCost ?? 0,
    totalOtherCost: overrides.totalOtherCost ?? 0,
    roughProfit: overrides.roughProfit ?? 100,
    estimatedNetProfit: overrides.estimatedNetProfit ?? 100,
    profitStatus: overrides.profitStatus ?? "COMPLETE",
    vatAmount: overrides.vatAmount ?? 0,
    vatAdjustedRevenue: overrides.vatAdjustedRevenue ?? 100,
    isStoreLevel: overrides.isStoreLevel,
    isGroup: overrides.isGroup,
    parentSalesUnitId: overrides.parentSalesUnitId,
    childRows: overrides.childRows,
    costSnapshotId: overrides.costSnapshotId ?? null,
    mappingBasisHash: overrides.mappingBasisHash ?? null,
    calculationVersion: overrides.calculationVersion ?? "profit-v1",
    calculatedAt: overrides.calculatedAt ?? "2026-04-01T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
  };
};

const createStoredDailyStoreSummaryForTest = (
  overrides: Partial<StoredDailyStoreSummary> = {},
): StoredDailyStoreSummary => {
  const date = overrides.date ?? "2026-04-01";
  const storeId = overrides.storeId ?? "store-1";
  return {
    id: overrides.id ?? `daily-store-summary:${storeId}:${date}`,
    storeId,
    date,
    totalRevenue: overrides.totalRevenue ?? 100,
    totalProductRevenue: overrides.totalProductRevenue ?? 100,
    totalDeliveryFeeAmount: overrides.totalDeliveryFeeAmount ?? 0,
    totalAdCost: overrides.totalAdCost ?? 0,
    roughProfit: overrides.roughProfit ?? 100,
    estimatedNetProfit: overrides.estimatedNetProfit ?? 100,
    profitStatus: overrides.profitStatus ?? "COMPLETE",
    salesUnitCount: overrides.salesUnitCount ?? 1,
    incompleteCostSalesUnitCount: overrides.incompleteCostSalesUnitCount ?? 0,
    unmappedOrderItemCount: overrides.unmappedOrderItemCount ?? 0,
    conflictOrderItemCount: overrides.conflictOrderItemCount ?? 0,
    unmappedCampaignCount: overrides.unmappedCampaignCount ?? 0,
    conflictCampaignCount: overrides.conflictCampaignCount ?? 0,
    intentionalUnmappedCampaignCount: overrides.intentionalUnmappedCampaignCount ?? 0,
    excludedOrderRevenue: overrides.excludedOrderRevenue ?? 0,
    excludedUnmappedOrderRevenue: overrides.excludedUnmappedOrderRevenue ?? 0,
    excludedConflictOrderRevenue: overrides.excludedConflictOrderRevenue ?? 0,
    excludedNonSaleOrderRevenue: overrides.excludedNonSaleOrderRevenue ?? 0,
    excludedAdCost: overrides.excludedAdCost ?? 0,
    excludedUnmappedAdCost: overrides.excludedUnmappedAdCost ?? 0,
    excludedConflictAdCost: overrides.excludedConflictAdCost ?? 0,
    excludedIntentionalUnmappedAdCost: overrides.excludedIntentionalUnmappedAdCost ?? 0,
    totalVatAmount: overrides.totalVatAmount ?? 0,
    totalVatAdjustedRevenue: overrides.totalVatAdjustedRevenue ?? 100,
    uniquePackageCount: overrides.uniquePackageCount ?? 1,
    deliveryUnitCost: overrides.deliveryUnitCost ?? DEFAULT_DELIVERY_UNIT_COST,
    estimatedDeliveryBaseCost: overrides.estimatedDeliveryBaseCost ?? DEFAULT_DELIVERY_UNIT_COST,
    customerPaidDeliveryFee: overrides.customerPaidDeliveryFee ?? 0,
    deliveryMargin: overrides.deliveryMargin ?? -DEFAULT_DELIVERY_UNIT_COST,
    calculationVersion: overrides.calculationVersion ?? "profit-v1",
    calculatedAt: overrides.calculatedAt ?? "2026-04-01T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
  };
};

const createAdUploadFile = (
  reportDate: string,
  campaigns: Array<{ campaignId: string; campaignName: string; totalCost: number }>,
) => {
  const sheetRows: string[][] = [AD_UPLOAD_REQUIRED_HEADERS.map((value) => String(value))];

  campaigns.forEach((campaign) => {
    sheetRows.push([
      campaign.campaignId,
      campaign.campaignName,
      String(campaign.totalCost),
      "0",
      "0",
      "0",
      "0",
    ]);
    sheetRows.push([
      "",
      getWeekdayNameKo(reportDate),
      "",
      "",
      "",
      "",
      "",
    ]);
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheetRows), "Sheet1");

  return {
    originalname: `ads-${reportDate}.xlsx`,
    buffer: XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }),
  } as never;
};

const createConfirmedUploadRow = (params: {
  uploadId: string;
  reportDate: string;
  campaignId: string;
  campaignName: string;
  canonicalSalesUnitId: string | null;
  totalCost: number;
  mappingReason?: "RULE_MATCHED" | "MANUAL_MAPPED" | "NO_RULE" | "MULTIPLE_RULES" | "INTENTIONALLY_UNMAPPED";
}) =>
  ({
    id: `ad-${params.uploadId}-${params.campaignId}`,
    uploadId: params.uploadId,
    sourceUploadId: params.uploadId,
    storeId: "store-1",
    reportDate: params.reportDate,
    campaignId: params.campaignId,
    campaignName: params.campaignName,
    normalizedCampaignName: normalizeText(params.campaignName),
    weekday: getWeekdayNameKo(params.reportDate),
    adType: null,
    status: "ACTIVE",
    totalCost: params.totalCost,
    impressions: 0,
    clicks: 0,
    totalConversions: 0,
    totalConversionSales: 0,
    matchedRuleCount: params.canonicalSalesUnitId ? 1 : 0,
    canonicalSalesUnitId: params.canonicalSalesUnitId,
    mappingReason: params.mappingReason ?? (params.canonicalSalesUnitId ? "RULE_MATCHED" : "NO_RULE"),
    reasonNote: null,
    reasonNoteInherited: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

const createConfirmedUpload = (params: { uploadId: string; reportDate: string; isActive?: boolean }) =>
  ({
    id: params.uploadId,
    storeId: "store-1",
    sourceType: "NAVER_DA_XLSX",
    originalFileName: `${params.uploadId}.xlsx`,
    fileHash: `hash-${params.uploadId}`,
    reportDate: params.reportDate,
    detectedWeekday: getWeekdayNameKo(params.reportDate),
    weekdayValidationStatus: "PASSED",
    replacedUploadId: null,
    previewRuleSnapshotHash: null,
    previewOverrideSnapshotHash: null,
    previewCreatedAt: null,
    previewExpiresAt: null,
    state: "CONFIRMED",
    isActive: params.isActive ?? true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

const createAdCampaignSignature = (params: {
  id: string;
  campaignId: string;
  campaignName: string;
  canonicalSalesUnitId?: string | null;
  mappingReason?: "RULE_MATCHED" | "MANUAL_MAPPED" | "NO_RULE" | "MULTIPLE_RULES" | "INTENTIONALLY_UNMAPPED";
  reasonNote?: string | null;
  firstSeenDate?: string | null;
  lastSeenDate?: string | null;
}) =>
  ({
    id: params.id,
    storeId: "store-1",
    channel: "NAVER_DA",
    campaignId: params.campaignId,
    campaignNameSnapshot: params.campaignName,
    normalizedCampaignName: normalizeText(params.campaignName),
    canonicalSalesUnitId: params.canonicalSalesUnitId ?? null,
    mappingReason: params.mappingReason ?? (params.canonicalSalesUnitId ? "RULE_MATCHED" : "NO_RULE"),
    matchedRuleCount: params.canonicalSalesUnitId ? 1 : 0,
    reasonNote: params.reasonNote ?? null,
    reasonNoteInherited: false,
    confirmedAt: params.canonicalSalesUnitId || params.reasonNote ? new Date().toISOString() : null,
    usageCount: 1,
    firstSeenDate: params.firstSeenDate ?? null,
    lastSeenDate: params.lastSeenDate ?? null,
    lastAutoMappedAt: null,
    mappingRuleHash: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

const createPostgresQueryHarness = (responses: Array<{ rows: Array<Record<string, unknown>> }>) => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const service = Object.create(DatabaseService.prototype) as {
    storageMode: string;
    pool: {
      query: (text: string, params?: readonly unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    };
    queryOperations: DatabaseService["queryOperations"];
    queryOrderItems: DatabaseService["queryOrderItems"];
    queryAdCampaignSignatures: DatabaseService["queryAdCampaignSignatures"];
  };

  service.storageMode = "postgres";
  service.pool = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params: [...params] });
      const response = responses.shift();
      if (!response) {
        throw new Error(`Unexpected query: ${text}`);
      }
      return response;
    },
  };

  return { service: service as unknown as DatabaseService, queries };
};

run("query builders normalize pagination and keep user values in params", () => {
  const builder = createSqlBuilder();
  builder.addCondition("payload->>'storeId' = {param}", "store-1' OR true");
  builder.addCondition((placeholder) => `payload->>'status' = ${placeholder}`, "RUNNING");

  const pagination = normalizePagination(-2, 999);
  const query = builder.buildPaginated(
    `SELECT payload FROM operations ${builder.whereClause()} ORDER BY payload->>'createdAt' DESC`,
    pagination,
  );
  const result = buildPaginationResult(["a", "b"], 401, pagination);

  assert.equal(query.text.includes("store-1' OR true"), false);
  assert.deepEqual(query.params, ["store-1' OR true", "RUNNING", 200, 0]);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 200);
  assert.equal(result.totalPages, 3);
});

runAsync("DatabaseService queryOperations uses PostgreSQL count, page, and bound params", async () => {
  const operation = createOperationRecord({
    id: "op-2",
    storeId: "store-1' OR true",
    operationType: "ORDER_SYNC",
    status: "RUNNING",
    createdAt: "2026-04-03T00:00:00.000Z",
  });
  const { service, queries } = createPostgresQueryHarness([
    { rows: [{ total_count: 3 }] },
    { rows: [{ payload: operation }] },
  ]);

  const result = await service.queryOperations({
    storeId: "store-1' OR true",
    status: "RUNNING",
    operationType: "ORDER_SYNC",
    page: 2,
    pageSize: 1,
  });

  assert.equal(result.totalCount, 3);
  assert.equal(result.items[0].id, "op-2");
  assert.match(queries[0].text, /COUNT\(\*\)::int AS total_count FROM operations/);
  assert.equal(queries[0].text.includes("store-1' OR true"), false);
  assert.deepEqual(queries[0].params, ["store-1' OR true", "RUNNING", "ORDER_SYNC"]);
  assert.match(queries[1].text, /LIMIT \$4 OFFSET \$5/);
  assert.deepEqual(queries[1].params, ["store-1' OR true", "RUNNING", "ORDER_SYNC", 1, 1]);
});

runAsync("DatabaseService queryOrderItems pushes filters into PostgreSQL", async () => {
  const orderItem = {
    id: "item-1",
    orderId: "order-1",
    storeId: "store-1",
    productId: null,
    orderSourceSignatureId: "sig-1",
    canonicalSalesUnitId: null,
    externalProductOrderId: "external-item-1",
    externalProductId: null,
    optionCode: null,
    packageNumber: null,
    rawProductName: "Needle Product",
    rawOptionInfo: "Black",
    normalizedProductName: "needle product",
    normalizedOptionInfo: "black",
    sourceSignature: "needle product || black",
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: 10000,
    deliveryFeeAmount: 0,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: "2026-04-03",
    paymentDate: "2026-04-03",
    saleStatus: "SALE",
    orderStatus: "PAYED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  };
  const { service, queries } = createPostgresQueryHarness([
    { rows: [{ total_count: "2" }] },
    { rows: [{ payload: orderItem }] },
  ]);

  const result = await service.queryOrderItems({
    storeId: "store-1",
    dateFrom: "2026-04-01",
    dateTo: "2026-04-30",
    productName: "Needle_%",
    optionInfo: "Black",
    mappingStatus: "UNMAPPED",
    orderStatus: "PAYED",
    saleStatus: "SALE",
    paymentDateStatus: "PRESENT",
    page: 1,
    pageSize: 50,
  });

  assert.equal(result.totalCount, 2);
  assert.equal(result.items[0].id, "item-1");
  assert.match(queries[0].text, /LEFT JOIN order_source_signatures signatures/);
  assert.match(queries[0].text, /items\.payload->>'paymentDate' >= \$2/);
  assert.match(queries[0].text, /signatures\.payload->>'normalizedProductName'/);
  assert.match(queries[0].text, /signatures\.payload->>'normalizedOptionInfo'/);
  assert.match(queries[0].text, /items\.payload->>'normalizedProductName'/);
  assert.match(queries[0].text, /items\.payload->>'normalizedOptionInfo'/);
  assert.equal(queries[0].text.includes("Needle_%"), false);
  assert.match(queries[0].text, /LIKE \$4 ESCAPE/);
  assert.deepEqual(queries[0].params, [
    "store-1",
    "2026-04-01",
    "2026-04-30",
    "%needle\\_\\%%",
    "%black%",
    "UNMAPPED",
    "PAYED",
    "SALE",
  ]);
});

runAsync("DatabaseService queryOrderItems searches signature fields when item text fields are absent", async () => {
  const database = createEmptyDatabase();
  const signature = createOrderSourceSignature("sig-1", "Signature Product") as OrderSourceSignature;
  signature.rawOptionInfoSnapshot = "Signature Option";
  signature.normalizedOptionInfo = normalizeText("Signature Option");
  signature.sourceSignature = createSourceSignature("Signature Product", "Signature Option");
  database.orderSourceSignatures.push(signature);
  database.orderItems.push({
    id: "item-no-repeat",
    orderId: "order-1",
    storeId: "store-1",
    productId: null,
    orderSourceSignatureId: "sig-1",
    canonicalSalesUnitId: null,
    externalProductOrderId: "external-item-no-repeat",
    externalProductId: null,
    optionCode: null,
    packageNumber: null,
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: 10000,
    deliveryFeeAmount: 0,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: "2026-04-03",
    paymentDate: "2026-04-03",
    saleStatus: "SALE",
    orderStatus: "PAYED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  } as OrderItem);
  const service = Object.create(DatabaseService.prototype) as {
    database: typeof database;
    storageMode: "file";
    queryOrderItems: DatabaseService["queryOrderItems"];
  };
  service.database = database;
  service.storageMode = "file";

  const result = await service.queryOrderItems({
    storeId: "store-1",
    productName: "Signature Product",
    optionInfo: "Signature Option",
  });

  assert.equal(result.totalCount, 1);
  assert.equal(result.items[0].id, "item-no-repeat");
});

runAsync("DatabaseService queryOrderItems falls back to legacy item text for sparse signatures", async () => {
  const database = createEmptyDatabase();
  database.orderSourceSignatures.push({
    id: "sig-sparse",
    storeId: "store-1",
    sourceSignature: "",
    rawProductNameSnapshot: "",
    rawOptionInfoSnapshot: "",
    normalizedProductName: "",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED",
    confirmedAt: null,
    usageCount: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    sampleExternalProductId: null,
    sampleOptionCode: null,
    sampleOptionManageCode: null,
    lastAutoMappedAt: null,
    mappingRuleHash: null,
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  database.orderItems.push({
    id: "item-legacy-text",
    orderId: "order-1",
    storeId: "store-1",
    productId: null,
    orderSourceSignatureId: "sig-sparse",
    canonicalSalesUnitId: null,
    externalProductOrderId: "external-item-legacy-text",
    externalProductId: null,
    optionCode: null,
    packageNumber: null,
    rawProductName: "Legacy Product",
    rawOptionInfo: "Legacy Option",
    normalizedProductName: normalizeText("Legacy Product"),
    normalizedOptionInfo: normalizeText("Legacy Option"),
    sourceSignature: createSourceSignature("Legacy Product", "Legacy Option"),
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: 10000,
    deliveryFeeAmount: 0,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: "2026-04-03",
    paymentDate: "2026-04-03",
    saleStatus: "SALE",
    orderStatus: "PAYED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  const service = Object.create(DatabaseService.prototype) as {
    database: typeof database;
    storageMode: "file";
    queryOrderItems: DatabaseService["queryOrderItems"];
  };
  service.database = database;
  service.storageMode = "file";

  const result = await service.queryOrderItems({
    storeId: "store-1",
    productName: "Legacy Product",
    optionInfo: "Legacy Option",
  });

  assert.equal(result.totalCount, 1);
  assert.equal(result.items[0].id, "item-legacy-text");
});

run("mapOrderItemResponse resolves display text from order source signature", () => {
  const database = createEmptyDatabase();
  database.orders.push({
    id: "order-1",
    storeId: "store-1",
    externalOrderId: "external-order-1",
    orderDatetime: null,
    paymentDatetime: null,
    orderStatus: "PAYED",
    rawPayload: null,
    syncedAt: "2026-04-03T00:00:00.000Z",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  const signature = createOrderSourceSignature("sig-1", "Signature Product") as OrderSourceSignature;
  signature.rawOptionInfoSnapshot = "Signature Option";
  signature.normalizedOptionInfo = normalizeText("Signature Option");
  signature.sourceSignature = createSourceSignature("Signature Product", "Signature Option");
  database.orderSourceSignatures.push(signature);
  const item = {
    id: "item-no-repeat",
    orderId: "order-1",
    storeId: "store-1",
    productId: null,
    orderSourceSignatureId: "sig-1",
    canonicalSalesUnitId: null,
    externalProductOrderId: "external-item-no-repeat",
    externalProductId: null,
    optionCode: null,
    packageNumber: null,
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: 10000,
    deliveryFeeAmount: 0,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: "2026-04-03",
    paymentDate: "2026-04-03",
    saleStatus: "SALE",
    orderStatus: "PAYED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  } as OrderItem;

  const response = mapOrderItemResponse(database, item);

  assert.equal(response.rawProductName, "Signature Product");
  assert.equal(response.rawOptionInfo, "Signature Option");
  assert.equal(response.sourceSignature, createSourceSignature("Signature Product", "Signature Option"));
});

run("mapOrderItemResponse falls back to legacy item text for sparse signatures", () => {
  const database = createEmptyDatabase();
  database.orders.push({
    id: "order-1",
    storeId: "store-1",
    externalOrderId: "external-order-1",
    orderDatetime: null,
    paymentDatetime: null,
    orderStatus: "PAYED",
    rawPayload: null,
    syncedAt: "2026-04-03T00:00:00.000Z",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  database.orderSourceSignatures.push({
    id: "sig-sparse",
    storeId: "store-1",
    sourceSignature: "",
    rawProductNameSnapshot: "",
    rawOptionInfoSnapshot: "",
    normalizedProductName: "",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED",
    confirmedAt: null,
    usageCount: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    sampleExternalProductId: null,
    sampleOptionCode: null,
    sampleOptionManageCode: null,
    lastAutoMappedAt: null,
    mappingRuleHash: null,
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
  const item = {
    id: "item-legacy-text",
    orderId: "order-1",
    storeId: "store-1",
    productId: null,
    orderSourceSignatureId: "sig-sparse",
    canonicalSalesUnitId: null,
    externalProductOrderId: "external-item-legacy-text",
    externalProductId: null,
    optionCode: null,
    packageNumber: null,
    rawProductName: "Legacy Product",
    rawOptionInfo: "Legacy Option",
    normalizedProductName: normalizeText("Legacy Product"),
    normalizedOptionInfo: normalizeText("Legacy Option"),
    sourceSignature: createSourceSignature("Legacy Product", "Legacy Option"),
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: 10000,
    deliveryFeeAmount: 0,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: "2026-04-03",
    paymentDate: "2026-04-03",
    saleStatus: "SALE",
    orderStatus: "PAYED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
  } as OrderItem;

  const response = mapOrderItemResponse(database, item);

  assert.equal(response.rawProductName, "Legacy Product");
  assert.equal(response.rawOptionInfo, "Legacy Option");
  assert.equal(response.sourceSignature, createSourceSignature("Legacy Product", "Legacy Option"));
});

runAsync("DatabaseService queryAdCampaignSignatures uses active upload SQL and returns page summaries", async () => {
  const signature = createAdCampaignSignature({
    id: "ad-signature-1",
    campaignId: "cmp-1",
    campaignName: "Needle Launch",
    firstSeenDate: "2026-04-01",
    lastSeenDate: "2026-04-03",
  });
  const latestRow = Object.assign(
    createConfirmedUploadRow({
      uploadId: "upload-1",
      reportDate: "2026-04-03",
      campaignId: "cmp-1",
      campaignName: "Needle Launch",
      canonicalSalesUnitId: null,
      totalCost: 120,
    }) as Record<string, unknown>,
    { adCampaignSignatureId: "ad-signature-1" },
  );
  const { service, queries } = createPostgresQueryHarness([
    { rows: [{ total_count: 1 }] },
    {
      rows: [
        {
          signature_payload: signature,
          latest_row_payload: latestRow,
          total_cost: "120",
          row_count: 1,
        },
      ],
    },
  ]);

  const result = await service.queryAdCampaignSignatures({
    storeId: "store-1",
    dateFrom: "2026-04-01",
    dateTo: "2026-04-30",
    q: "Needle_%' OR true",
    page: 1,
    pageSize: 20,
  });

  assert.equal(result.totalCount, 1);
  assert.equal(result.items[0].signature.id, "ad-signature-1");
  assert.equal(result.items[0].latestRow?.sourceUploadId, "upload-1");
  assert.equal(result.items[0].totalCost, 120);
  assert.match(queries[0].text, /EXISTS \(/);
  assert.match(queries[1].text, /LEFT JOIN LATERAL/);
  assert.equal(queries[0].text.includes("Needle_%' OR true"), false);
  assert.equal(queries[0].params.some((param) => param === "%needle\\_\\%' or true%"), true);
  assert.equal(queries[1].params.at(-2), 20);
  assert.equal(queries[1].params.at(-1), 0);
});

runAsync("DatabaseService queryAdCampaignSignatures keeps repaired Hangul search compatible", async () => {
  const database = createEmptyDatabase();
  database.adExcelUploads.push(createConfirmedUpload({ uploadId: "upload-mojibake", reportDate: "2026-04-03" }));
  database.adCampaignSignatures.push(
    createAdCampaignSignature({
      id: "ad-signature-mojibake",
      campaignId: "cmp-mojibake",
      campaignName: "ì¸í¼ëí° ìº íì¸",
      firstSeenDate: "2026-04-03",
      lastSeenDate: "2026-04-03",
    }),
  );
  database.adCampaignDailyCosts.push(
    Object.assign(
      createConfirmedUploadRow({
        uploadId: "upload-mojibake",
        reportDate: "2026-04-03",
        campaignId: "cmp-mojibake",
        campaignName: "ì¸í¼ëí° ìº íì¸",
        canonicalSalesUnitId: null,
        totalCost: 50,
      }) as Record<string, unknown>,
      { adCampaignSignatureId: "ad-signature-mojibake" },
    ) as never,
  );
  const service = Object.create(DatabaseService.prototype) as {
    storageMode: string;
    database: typeof database;
    pool: { query: () => never };
    queryAdCampaignSignatures: DatabaseService["queryAdCampaignSignatures"];
  };
  service.storageMode = "postgres";
  service.database = database;
  service.pool = {
    query: () => {
      throw new Error("Hangul repaired search should use snapshot fallback");
    },
  };

  const result = await service.queryAdCampaignSignatures({ storeId: "store-1", q: "인피니티" });

  assert.equal(result.totalCount, 1);
  assert.equal(result.items[0].signature.id, "ad-signature-mojibake");
});

run("normalizeText keeps prefixes and symbols while normalizing whitespace and case", () => {
  assert.equal(normalizeText("  [Fast Delivery]\nRunning Hat: BLACK  "), "[fast delivery] running hat: black");
});

run("getWeekdayNameKo resolves KST weekday correctly", () => {
  assert.equal(getWeekdayNameKo("2026-03-25"), "수요일");
});

run("repairMojibakeText repairs UTF-8 Korean file names decoded as latin1", () => {
  assert.equal(repairMojibakeText("ì¸í¼ëí°ìë¸.xlsx"), "인피니티서브.xlsx");
  assert.equal(repairMojibakeText("already-fine.xlsx"), "already-fine.xlsx");
});

run("saleStatusFromRawStatus maps cancel request correctly", () => {
  assert.equal(saleStatusFromRawStatus("CANCEL_REQUEST"), "CANCEL_REQUESTED");
});

run("saleStatusFromNaverOrderState prioritizes claim status over product order status", () => {
  assert.equal(saleStatusFromNaverOrderState("PAYED", "RETURN_REQUEST"), "RETURNED");
});

run("createNaverClientSecretSign produces a base64 bcrypt signature", () => {
  const signature = createNaverClientSecretSign(
    "aaaabbbbcccc",
    "$2a$04$abcdefghijklmnopqrstuv",
    "1643961623299",
  );
  assert.equal(
    signature,
    "JDJhJDA0JGFiY2RlZmdoaWprbG1ub3BxcnN0dXV6NDlObEtMdDYyUWhPdnNjSTNNWnR4ZUlDQjNoYUpD",
  );
});

run("NaverCommerceService prefers productOption over optionCode for readable option info", () => {
  const service = Object.create(NaverCommerceService.prototype) as NaverCommerceService;

  assert.equal(
    (service as any).buildOptionInfo(
      {
        productOption: "컬러: 옵션3.핑크베이지+핑크베이지 / 사이즈: M(32~35cm)",
        optionCode: "49765107855",
      },
      null,
      {},
    ),
    "컬러: 옵션3.핑크베이지+핑크베이지 / 사이즈: M(32~35cm)",
  );
});

runAsync("OrderSyncService enqueueSyncAll targets active configured stores and skips missing credentials", async () => {
  const { orderSyncService, enqueueCalls } = createOrderSyncServiceHarness();
  const result = await orderSyncService.enqueueSyncAll("2026-05-10", "2026-05-10");

  assert.equal(result.data.dateFrom, "2026-05-10");
  assert.equal(result.data.dateTo, "2026-05-10");
  assert.equal(result.data.rangeMode, "MANUAL");
  assert.equal(result.data.targetStoreCount, 1);
  assert.equal(result.data.skippedStoreCount, 1);
  assert.equal(result.data.operations[0].storeId, "store-live");
  assert.equal(result.data.operations.some((item) => item.storeId === "store-inactive"), false);
  assert.equal(result.data.skippedStores[0].storeId, "store-missing");
  assert.equal(result.data.skippedStores[0].reason, "NAVER_CREDENTIALS_NOT_CONFIGURED");
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].requestJson.requireLiveCredential, true);
  assert.equal(enqueueCalls[0].requestJson.requestedByBatch, true);
});

runAsync("OrderSyncService enqueueSyncAll skips stores with in-flight ORDER_SYNC", async () => {
  const { orderSyncService, enqueueCalls } = createOrderSyncServiceHarness({
    stores: [
      createStoreRecord("store-live", "Live Store"),
      createStoreRecord("store-live-2", "Live Store 2"),
    ],
    configuredStoreIds: ["store-live", "store-live-2"],
    inFlightStoreIds: ["store-live"],
  });
  const result = await orderSyncService.enqueueSyncAll("2026-05-10", "2026-05-10");

  assert.equal(result.data.targetStoreCount, 1);
  assert.equal(result.data.skippedStoreCount, 1);
  assert.equal(result.data.operations[0].storeId, "store-live-2");
  assert.equal(result.data.skippedStores[0].storeId, "store-live");
  assert.equal(result.data.skippedStores[0].reason, "ORDER_SYNC_ALREADY_IN_FLIGHT");
  assert.equal(enqueueCalls.length, 1);
});

runAsync("OrderSyncService retry executor preserves requireLiveCredential", async () => {
  const { orderSyncService, retryExecutors } = createOrderSyncServiceHarness();
  let capturedOptions: { requireLiveCredential?: boolean } | undefined;
  orderSyncService.performSync = ((
    _storeId: string,
    _dateFrom: string,
    _dateTo: string,
    _rangeMode: "MANUAL" | "AUTO_LAST_30_DAYS",
    options?: { requireLiveCredential?: boolean },
  ) => {
    capturedOptions = options;
    return Promise.resolve({});
  }) as never;

  orderSyncService.onModuleInit();
  const retryExecutor = retryExecutors.get("ORDER_SYNC");
  assert.ok(retryExecutor);
  await retryExecutor({
    storeId: "store-live",
    requestJson: {
      dateFrom: "2026-05-10",
      dateTo: "2026-05-10",
      rangeMode: "MANUAL",
      requireLiveCredential: true,
    },
  });

  assert.equal(capturedOptions?.requireLiveCredential, true);
});

runAsync("OrderSyncService enqueueSyncAll rejects manual ranges over 30 days", async () => {
  const { orderSyncService } = createOrderSyncServiceHarness();

  await assert.rejects(() => orderSyncService.enqueueSyncAll("2026-01-01", "2026-02-01"));
});

run("ORDER_RAW_PAYLOAD_RETENTION_DAYS defaults to zero", () => {
  const original = process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
  try {
    delete process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
    assert.equal(getOrderRawPayloadRetentionDays(), 0);
  } finally {
    if (original === undefined) {
      delete process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
    } else {
      process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = original;
    }
  }
});

run("ORDER_RAW_PAYLOAD_RETENTION_DAYS accepts only non-negative integers", () => {
  const original = process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
  try {
    process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = "0";
    assert.equal(getOrderRawPayloadRetentionDays(), 0);
    process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = "30";
    assert.equal(getOrderRawPayloadRetentionDays(), 30);
    process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = "1.5";
    assert.equal(getOrderRawPayloadRetentionDays(), DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS);
    process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = "-1";
    assert.equal(getOrderRawPayloadRetentionDays(), DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS);
    process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = "invalid";
    assert.equal(getOrderRawPayloadRetentionDays(), DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS);
  } finally {
    if (original === undefined) {
      delete process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
    } else {
      process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = original;
    }
  }
});

runAsync("OrderSyncService retains recent rawPayloads and prunes only expired store-scoped payloads", async () => {
  const original = process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
  process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = "1";
  const recentDate = getKstRetentionCutoffDate(0);
  const oldDate = getKstRetentionCutoffDate(2);
  const cutoffDate = getKstRetentionCutoffDate(1);
  const { databaseService, orderSyncService, fetchOrderItemsCalls } = createOrderSyncServiceHarness({
    stores: [createStoreRecord("store-1", "Main Store"), createStoreRecord("store-2", "Other Store")],
    configuredStoreIds: ["store-1"],
    liveOrderItems: [
      createSyncedOrderItemInput({
        externalOrderId: "order-sync-old",
        externalProductOrderId: "item-sync-old",
        date: oldDate,
        rawPayload: { retain: "old-sync" },
        optionCode: "OPT-OLD",
        optionManageCode: "MNG-OLD",
        paymentCommission: 456,
        deliveryFeeAmount: 3210,
        productPaymentAmount: 12345,
      }),
      createSyncedOrderItemInput({
        externalOrderId: "order-sync-recent",
        externalProductOrderId: "item-sync-recent",
        date: recentDate,
        rawPayload: { retain: "recent-sync" },
      }),
    ],
  });

  try {
    databaseService.write((draft) => {
      draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Retention Unit", []));
      draft.salesUnitCostSnapshots.push({
        id: "cost-snapshot-1",
        storeId: "store-1",
        effectiveFrom: oldDate,
        sourceFileName: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      draft.salesUnitCostSnapshotEntries.push({
        id: "cost-entry-1",
        snapshotId: "cost-snapshot-1",
        storeId: "store-1",
        canonicalSalesUnitId: "sales-1",
        unitCost: 1000,
        feeRate: 0.1,
        otherCost: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      draft.orders.push(
        {
          id: "prune-order-old",
          storeId: "store-1",
          externalOrderId: "external-prune-order-old",
          orderDatetime: `${oldDate}T08:00:00+09:00`,
          paymentDatetime: `${oldDate}T08:30:00+09:00`,
          orderStatus: "DELIVERED",
          rawPayload: { old: true },
          syncedAt: `${oldDate}T09:00:00+09:00`,
          createdAt: `${oldDate}T09:00:00+09:00`,
          updatedAt: `${oldDate}T09:00:00+09:00`,
        },
        {
          id: "keep-order-recent",
          storeId: "store-1",
          externalOrderId: "external-keep-order-recent",
          orderDatetime: `${recentDate}T08:00:00+09:00`,
          paymentDatetime: `${recentDate}T08:30:00+09:00`,
          orderStatus: "DELIVERED",
          rawPayload: { recent: true },
          syncedAt: `${recentDate}T09:00:00+09:00`,
          createdAt: `${recentDate}T09:00:00+09:00`,
          updatedAt: `${recentDate}T09:00:00+09:00`,
        },
        {
          id: "other-store-order-old",
          storeId: "store-2",
          externalOrderId: "external-other-store-order-old",
          orderDatetime: `${oldDate}T08:00:00+09:00`,
          paymentDatetime: `${oldDate}T08:30:00+09:00`,
          orderStatus: "DELIVERED",
          rawPayload: { otherStore: true },
          syncedAt: `${oldDate}T09:00:00+09:00`,
          createdAt: `${oldDate}T09:00:00+09:00`,
          updatedAt: `${oldDate}T09:00:00+09:00`,
        },
      );
      draft.orderItems.push(
        {
          id: "prune-item-old",
          orderId: "prune-order-old",
          storeId: "store-1",
          productId: null,
          orderSourceSignatureId: null,
          canonicalSalesUnitId: "sales-1",
          externalProductOrderId: "external-prune-item-old",
          externalProductId: "product-prune",
          optionCode: "OPT-KEEP",
          optionManageCode: "MNG-KEEP",
          packageNumber: "PKG-KEEP",
          rawProductName: "Retention Unit",
          rawOptionInfo: "Color: Black",
          normalizedProductName: normalizeText("Retention Unit"),
          normalizedOptionInfo: normalizeText("Color: Black"),
          sourceSignature: createSourceSignature("Retention Unit", "Color: Black"),
          quantity: 2,
          productPaymentAmount: 20000,
          totalProductAmount: 20000,
          deliveryFeeAmount: 3000,
          paymentCommission: 500,
          knowledgeShoppingSellingInterlockCommission: 200,
          saleCommission: 0,
          channelCommission: 0,
          orderDate: oldDate,
          paymentDate: oldDate,
          saleStatus: "SALE",
          orderStatus: "DELIVERED",
          isCanceled: false,
          isReturned: false,
          rawPayload: { oldItem: true },
          createdAt: `${oldDate}T09:00:00+09:00`,
          updatedAt: `${oldDate}T09:00:00+09:00`,
        },
        {
          id: "already-null-item-old",
          orderId: "prune-order-old",
          storeId: "store-1",
          productId: null,
          orderSourceSignatureId: null,
          canonicalSalesUnitId: null,
          externalProductOrderId: "external-already-null-item-old",
          externalProductId: null,
          optionCode: "OPT-NULL",
          packageNumber: null,
          rawProductName: "Already Null",
          rawOptionInfo: null,
          normalizedProductName: normalizeText("Already Null"),
          normalizedOptionInfo: "",
          sourceSignature: createSourceSignature("Already Null", null),
          quantity: 1,
          productPaymentAmount: 100,
          totalProductAmount: 100,
          deliveryFeeAmount: 0,
          paymentCommission: 0,
          knowledgeShoppingSellingInterlockCommission: 0,
          saleCommission: 0,
          channelCommission: 0,
          orderDate: oldDate,
          paymentDate: oldDate,
          saleStatus: "SALE",
          orderStatus: "DELIVERED",
          isCanceled: false,
          isReturned: false,
          rawPayload: null,
          createdAt: `${oldDate}T09:00:00+09:00`,
          updatedAt: `${oldDate}T09:00:00+09:00`,
        },
        {
          id: "other-store-item-old",
          orderId: "other-store-order-old",
          storeId: "store-2",
          productId: null,
          orderSourceSignatureId: null,
          canonicalSalesUnitId: null,
          externalProductOrderId: "external-other-store-item-old",
          externalProductId: null,
          optionCode: "OPT-OTHER",
          packageNumber: null,
          rawProductName: "Other Store",
          rawOptionInfo: null,
          normalizedProductName: normalizeText("Other Store"),
          normalizedOptionInfo: "",
          sourceSignature: createSourceSignature("Other Store", null),
          quantity: 1,
          productPaymentAmount: 100,
          totalProductAmount: 100,
          deliveryFeeAmount: 0,
          paymentCommission: 0,
          knowledgeShoppingSellingInterlockCommission: 0,
          saleCommission: 0,
          channelCommission: 0,
          orderDate: oldDate,
          paymentDate: oldDate,
          saleStatus: "SALE",
          orderStatus: "DELIVERED",
          isCanceled: false,
          isReturned: false,
          rawPayload: { otherStore: true },
          createdAt: `${oldDate}T09:00:00+09:00`,
          updatedAt: `${oldDate}T09:00:00+09:00`,
        },
      );
    });

    const result = await orderSyncService.performSync("store-1", oldDate, recentDate, "MANUAL");
    const snapshot = databaseService.getSnapshot();
    const syncedOldItem = snapshot.orderItems.find((item: { externalProductOrderId: string }) =>
      item.externalProductOrderId === "item-sync-old"
    )!;
    const syncedRecentItem = snapshot.orderItems.find((item: { externalProductOrderId: string }) =>
      item.externalProductOrderId === "item-sync-recent"
    )!;

    assert.equal(result.rawPayloadRetentionDays, 1);
    assert.equal(result.rawPayloadRetentionCutoffDate, cutoffDate);
    assert.equal(fetchOrderItemsCalls[0]?.options?.includeRawPayload, true);
    assert.equal(result.rawPayloadPrunedOrderCount, 1);
    assert.equal(result.rawPayloadPrunedOrderItemCount, 1);
    assert.equal(snapshot.orders.find((item: { id: string }) => item.id === "prune-order-old")?.rawPayload, null);
    assert.deepEqual(snapshot.orders.find((item: { id: string }) => item.id === "keep-order-recent")?.rawPayload, {
      recent: true,
    });
    assert.deepEqual(snapshot.orders.find((item: { id: string }) => item.id === "other-store-order-old")?.rawPayload, {
      otherStore: true,
    });
    assert.equal(snapshot.orderItems.find((item: { id: string }) => item.id === "prune-item-old")?.rawPayload, null);
    assert.deepEqual(snapshot.orderItems.find((item: { id: string }) => item.id === "other-store-item-old")?.rawPayload, {
      otherStore: true,
    });
    assert.equal(syncedOldItem.rawPayload, null);
    assert.deepEqual(syncedRecentItem.rawPayload, { retain: "recent-sync" });
    assert.equal(syncedOldItem.optionCode, "OPT-OLD");
    assert.equal(syncedOldItem.optionManageCode, "MNG-OLD");
    assert.equal(syncedOldItem.productPaymentAmount, 12345);
    assert.equal(syncedOldItem.deliveryFeeAmount, 3210);
    assert.equal(syncedOldItem.paymentCommission, 456);

    const listResult = await orderSyncService.listOrderItems({ storeId: "store-1", dateFrom: oldDate, dateTo: oldDate });
    assert.equal(
      listResult.data.items.some((item: { id: string }) => item.id === "prune-item-old"),
      true,
    );
    const profitRows = calculateDailyProfitRows(snapshot, "store-1", oldDate, oldDate);
    assert.equal(profitRows[0].totalProductRevenue, 20000);
    assert.equal(profitRows[0].totalDeliveryFeeAmount, 3000);
  } finally {
    if (original === undefined) {
      delete process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
    } else {
      process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = original;
    }
  }
});

runAsync("OrderSyncService does not save new rawPayloads when retention days defaults to zero", async () => {
  const original = process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
  delete process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
  const today = getKstRetentionCutoffDate(0);
  const { databaseService, orderSyncService, fetchOrderItemsCalls } = createOrderSyncServiceHarness({
    stores: [createStoreRecord("store-1", "Main Store")],
    configuredStoreIds: ["store-1"],
    liveOrderItems: [
      createSyncedOrderItemInput({
        externalOrderId: "order-zero-retention",
        externalProductOrderId: "item-zero-retention",
        date: today,
        rawPayload: { shouldBeRemoved: true },
      }),
    ],
  });

  try {
    const result = await orderSyncService.performSync("store-1", today, today, "MANUAL");
    const snapshot = databaseService.getSnapshot();
    assert.equal(result.rawPayloadRetentionDays, 0);
    assert.equal(fetchOrderItemsCalls[0]?.options?.includeRawPayload, false);
    assert.equal(
      snapshot.orders.find((item: { externalOrderId: string }) => item.externalOrderId === "order-zero-retention")
        ?.rawPayload,
      null,
    );
    assert.equal(
      snapshot.orderItems.find((item: { externalProductOrderId: string }) =>
        item.externalProductOrderId === "item-zero-retention"
      )?.rawPayload,
      null,
    );
    const syncedItem = snapshot.orderItems.find((item: { externalProductOrderId: string }) =>
      item.externalProductOrderId === "item-zero-retention"
    ) as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(syncedItem, "rawProductName"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(syncedItem, "rawOptionInfo"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(syncedItem, "normalizedProductName"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(syncedItem, "normalizedOptionInfo"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(syncedItem, "sourceSignature"), false);
    const listed = await orderSyncService.listOrderItems({ storeId: "store-1" });
    assert.equal(listed.data.items[0].rawProductName, "Retention Test Product");
    assert.equal(listed.data.items[0].rawOptionInfo, "Color: Black");
    assert.equal(listed.data.items[0].sourceSignature, createSourceSignature("Retention Test Product", "Color: Black"));
  } finally {
    if (original === undefined) {
      delete process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
    } else {
      process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = original;
    }
  }
});

runAsync("OrderSyncService mock fallback omits rawPayloads when retention days is zero", async () => {
  const original = process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
  process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = "0";
  const today = getKstRetentionCutoffDate(0);
  const { databaseService, orderSyncService } = createOrderSyncServiceHarness({
    stores: [createStoreRecord("store-1", "Main Store")],
    configuredStoreIds: [],
  });

  try {
    const result = await orderSyncService.performSync("store-1", today, today, "MANUAL");
    const snapshot = databaseService.getSnapshot();

    assert.equal(result.syncSource, "MOCK_FALLBACK");
    assert.equal(result.rawPayloadRetentionDays, 0);
    assert.equal(snapshot.orders.length > 0, true);
    assert.equal(snapshot.orderItems.length > 0, true);
    assert.equal(snapshot.orders.every((item: { rawPayload: unknown }) => item.rawPayload === null), true);
    assert.equal(snapshot.orderItems.every((item: { rawPayload: unknown }) => item.rawPayload === null), true);
  } finally {
    if (original === undefined) {
      delete process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS;
    } else {
      process.env.ORDER_RAW_PAYLOAD_RETENTION_DAYS = original;
    }
  }
});

run("OperationService hasInFlightOperation checks queued and running operations by type", () => {
  const databaseService = createMemoryDatabaseService();
  const operationService = new OperationService(
    databaseService as never,
    createAuditLogServiceDouble() as never,
  );

  databaseService.write((draft) => {
    draft.operations.push(
      createOperationRecord({
        id: "op-queued",
        storeId: "store-1",
        operationType: "ORDER_SYNC",
        status: "QUEUED",
      }),
      createOperationRecord({
        id: "op-done",
        storeId: "store-1",
        operationType: "RECALCULATE_AD_MAPPING",
        status: "SUCCEEDED",
        finishedAt: new Date().toISOString(),
      }),
    );
  });

  assert.equal(operationService.hasInFlightOperation("store-1", "ORDER_SYNC"), true);
  assert.equal(operationService.hasInFlightOperation("store-1", "RECALCULATE_AD_MAPPING"), false);
  assert.equal(operationService.hasInFlightOperation("store-2", "ORDER_SYNC"), false);
});

runAsync("OperationService enqueue records queued DB operation without executing inline", async () => {
  const databaseService = createMemoryDatabaseService();
  const operationService = new OperationService(
    databaseService as never,
    createAuditLogServiceDouble() as never,
  );
  let executed = false;

  const operation = await operationService.enqueue(
    "store-1",
    "ORDER_SYNC",
    { dateFrom: "2026-05-01" },
    async () => {
      executed = true;
      return {};
    },
  );

  const stored = databaseService.getSnapshot().operations.find((item: OperationRecord) => item.id === operation.id)!;
  assert.equal(executed, false);
  assert.equal(stored.status, "QUEUED");
  assert.equal(stored.attemptCount, 0);
  assert.equal(stored.maxAttempts, 3);
  assert.equal(stored.runAfter, stored.createdAt);
  assert.equal(stored.leaseOwner, null);
});

runAsync("OperationWorkerService pollOnce leases and completes one queued operation", async () => {
  const databaseService = createMemoryDatabaseService();
  const operationService = new OperationService(
    databaseService as never,
    createAuditLogServiceDouble() as never,
  );
  operationService.registerRetryExecutor("ORDER_SYNC", async (operation) => ({
    ok: true,
    attemptCount: operation.attemptCount,
  }));
  const operation = await operationService.enqueue("store-1", "ORDER_SYNC", {}, async () => ({}));
  const worker = new OperationWorkerService(operationService);

  assert.equal(await worker.pollOnce(), true);

  const stored = databaseService.getSnapshot().operations.find((item: OperationRecord) => item.id === operation.id)!;
  assert.equal(stored.status, "SUCCEEDED");
  assert.equal(stored.attemptCount, 1);
  assert.deepEqual(stored.resultJson, { ok: true, attemptCount: 1 });
  assert.equal(stored.leaseOwner, null);
  assert.equal(stored.leaseExpiresAt, null);
  assert.ok(stored.startedAt);
  assert.ok(stored.finishedAt);
  assert.ok(stored.heartbeatAt);
});

runAsync("OperationWorkerService retries failed operations with backoff before max attempts", async () => {
  const databaseService = createMemoryDatabaseService();
  const operationService = new OperationService(
    databaseService as never,
    createAuditLogServiceDouble() as never,
  );
  operationService.registerRetryExecutor("ORDER_SYNC", async () => {
    throw new Error("SYNC_FAILED");
  });
  const operation = await operationService.enqueue("store-1", "ORDER_SYNC", {}, async () => ({}));
  const worker = new OperationWorkerService(operationService);

  assert.equal(await worker.pollOnce(), true);

  const stored = databaseService.getSnapshot().operations.find((item: OperationRecord) => item.id === operation.id)!;
  assert.equal(stored.status, "QUEUED");
  assert.equal(stored.attemptCount, 1);
  assert.equal(stored.errorMessage, "SYNC_FAILED");
  assert.ok(stored.runAfter && stored.runAfter > stored.createdAt);
  assert.equal(stored.finishedAt, null);
});

runAsync("OperationWorkerService marks operation failed at max attempts", async () => {
  const databaseService = createMemoryDatabaseService();
  const operationService = new OperationService(
    databaseService as never,
    createAuditLogServiceDouble() as never,
  );
  operationService.registerRetryExecutor("ORDER_SYNC", async () => {
    throw new Error("FINAL_FAILURE");
  });
  const operation = await operationService.enqueue("store-1", "ORDER_SYNC", {}, async () => ({}));
  databaseService.write((draft) => {
    const stored = draft.operations.find((item) => item.id === operation.id)!;
    stored.maxAttempts = 1;
  });
  const worker = new OperationWorkerService(operationService);

  assert.equal(await worker.pollOnce(), true);

  const stored = databaseService.getSnapshot().operations.find((item: OperationRecord) => item.id === operation.id)!;
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.attemptCount, 1);
  assert.equal(stored.errorMessage, "FINAL_FAILURE");
  assert.equal(stored.runAfter, null);
  assert.ok(stored.finishedAt);
});

runAsync("OperationService heartbeat extends lease and stores progress", async () => {
  const databaseService = createMemoryDatabaseService();
  const operationService = new OperationService(
    databaseService as never,
    createAuditLogServiceDouble() as never,
  );
  const operation = await operationService.enqueue("store-1", "ORDER_SYNC", {}, async () => ({}));
  const acquired = await databaseService.acquireNextOperation("worker-a", 120_000) as OperationRecord | null;
  assert.equal(acquired?.id, operation.id);

  const heartbeat = await databaseService.heartbeatOperation(operation.id, "worker-a", 120_000, {
    phase: "fetching",
  }) as OperationRecord | null;

  assert.equal(heartbeat?.progressJson?.phase, "fetching");
  assert.ok(heartbeat?.heartbeatAt);
  assert.ok(heartbeat?.leaseExpiresAt);
});

runAsync("Database operation lease prevents another same store/type acquisition until expired", async () => {
  const databaseService = createMemoryDatabaseService();
  const operationService = new OperationService(
    databaseService as never,
    createAuditLogServiceDouble() as never,
  );
  const first = await operationService.enqueue("store-1", "ORDER_SYNC", { n: 1 }, async () => ({}));
  await operationService.enqueue("store-1", "ORDER_SYNC", { n: 2 }, async () => ({}));

  const acquired = await databaseService.acquireNextOperation("worker-a", 120_000) as OperationRecord | null;
  assert.equal(acquired?.id, first.id);
  assert.equal(await databaseService.acquireNextOperation("worker-b", 120_000), null);

  databaseService.write((draft) => {
    const stored = draft.operations.find((item) => item.id === first.id)!;
    stored.leaseExpiresAt = "2000-01-01T00:00:00.000Z";
  });

  const reacquired = await databaseService.acquireNextOperation("worker-b", 120_000) as OperationRecord | null;
  assert.equal(reacquired?.id, first.id);
  assert.equal(reacquired?.attemptCount, 2);
});

runAsync("OperationWorkerService defers same store/type execution when execution lock is busy", async () => {
  const databaseService = createMemoryDatabaseService();
  const operationService = new OperationService(
    databaseService as never,
    createAuditLogServiceDouble() as never,
  );
  operationService.registerRetryExecutor("ORDER_SYNC", async () => ({ ok: true }));
  const operation = await operationService.enqueue("store-1", "ORDER_SYNC", {}, async () => ({}));
  const existingLock = await databaseService.tryAcquireOperationExecutionLock("store-1", "ORDER_SYNC");
  const worker = new OperationWorkerService(operationService);

  try {
    assert.ok(existingLock);
    assert.equal(await worker.pollOnce(), true);
  } finally {
    await existingLock?.release();
  }

  const stored = databaseService.getSnapshot().operations.find((item: OperationRecord) => item.id === operation.id)!;
  assert.equal(stored.status, "QUEUED");
  assert.equal(stored.attemptCount, 0);
  assert.equal(stored.errorMessage, "STORE_OPERATION_LOCK_BUSY");
  assert.ok(stored.runAfter && stored.runAfter > stored.createdAt);
});

run("NaverCommerceService omits optionCode when readable option fields are present", () => {
  const service = Object.create(NaverCommerceService.prototype) as NaverCommerceService;

  assert.equal(
    (service as any).buildOptionInfo(
      {
        optionName: "컬러",
        optionValue: "화이트",
        optionCode: "49765107855",
      },
      null,
      {},
    ),
    "컬러 / 화이트",
  );
});

run("NaverCommerceService falls back to optionCode when it is the only option field", () => {
  const service = Object.create(NaverCommerceService.prototype) as NaverCommerceService;

  assert.equal(
    (service as any).buildOptionInfo(
      {
        optionCode: "49765107855",
      },
      null,
      {},
    ),
    "49765107855",
  );
});

run("NaverCommerceConfigService resolves matching env credentials", () => {
  const original = {
    NAVER_CLIENT_ID: process.env.NAVER_CLIENT_ID,
    NAVER_CLIENT_SECRET: process.env.NAVER_CLIENT_SECRET,
    NAVER_ACCOUNT_UID: process.env.NAVER_ACCOUNT_UID,
    NAVER_CHANNEL_NO: process.env.NAVER_CHANNEL_NO,
    NAVER_SOLUTION_ID: process.env.NAVER_SOLUTION_ID,
    NAVER_CALLBACK_URL: process.env.NAVER_CALLBACK_URL,
  };

  process.env.NAVER_CLIENT_ID = "env-client-id";
  process.env.NAVER_CLIENT_SECRET = "env-client-secret";
  process.env.NAVER_ACCOUNT_UID = "env-account";
  process.env.NAVER_CHANNEL_NO = "1001";
  process.env.NAVER_SOLUTION_ID = "sol-1";
  process.env.NAVER_CALLBACK_URL = "https://example.com/naver/callback";

  const service = new NaverCommerceConfigService();
  const resolved = service.getEnvCredentialForStore({
    sellerAccountId: "env-account",
    channelNo: "1001",
  } as never);

  assert.equal(resolved?.clientId, "env-client-id");
  assert.equal(resolved?.accountUid, "env-account");
  assert.equal(resolved?.channelNo, "1001");
  assert.equal(resolved?.solutionId, "sol-1");

  Object.entries(original).forEach(([key, value]) => {
    if (value == null) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  });
});

run("calculateFee falls back to feeRate only when both API fees are null", () => {
  const result = calculateFee(
    {
      paymentCommission: null,
      knowledgeShoppingSellingInterlockCommission: null,
      productPaymentAmount: 10000,
    } as never,
    {
      feeRate: 0.035,
    } as never,
  );
  assert.equal(result.totalFeeCost, 350);
  assert.equal(result.usedFallback, true);
  assert.equal(result.incomplete, false);
});

run("calculateVatAmount rounds to nearest won", () => {
  assert.equal(calculateVatAmount(10000), 1000);
  assert.equal(calculateVatAmount(9994), 999);
  assert.equal(calculateVatAmount(9995), 1000);
});

run("calculateVatAdjustedRevenue subtracts VAT amount from revenue", () => {
  assert.equal(calculateVatAdjustedRevenue(10000), 9000);
  assert.equal(calculateVatAdjustedRevenue(9994), 8995);
});

run("resolvePackageKey falls back to orderId when packageNumber is empty or null", () => {
  assert.equal(resolvePackageKey({ packageNumber: "PKG-001", orderId: "ORD-001" } as never), "PKG-001");
  assert.equal(resolvePackageKey({ packageNumber: "  ", orderId: "ORD-001" } as never), "ORD-001");
  assert.equal(resolvePackageKey({ packageNumber: null, orderId: "ORD-001" } as never), "ORD-001");
});

run("calculateStoreDeliverySummary counts unique packages and computes delivery margin", () => {
  const database = createEmptyDatabase();
  database.stores.push({
    id: "store-1",
    deliveryUnitCost: DEFAULT_DELIVERY_UNIT_COST,
  } as never);
  database.orderItems.push(
    {
      id: "item-1",
      storeId: "store-1",
      packageNumber: "PKG-001",
      orderId: "ORD-001",
      paymentDate: "2026-04-02",
      saleStatus: "SALE",
      canonicalSalesUnitId: "sales-1",
      deliveryFeeAmount: 3000,
    } as never,
    {
      id: "item-2",
      storeId: "store-1",
      packageNumber: "PKG-001",
      orderId: "ORD-001",
      paymentDate: "2026-04-02",
      saleStatus: "SALE",
      canonicalSalesUnitId: "sales-1",
      deliveryFeeAmount: 0,
    } as never,
    {
      id: "item-3",
      storeId: "store-1",
      packageNumber: "PKG-002",
      orderId: "ORD-002",
      paymentDate: "2026-04-02",
      saleStatus: "SALE",
      canonicalSalesUnitId: "sales-1",
      deliveryFeeAmount: 2000,
    } as never,
    {
      id: "item-4",
      storeId: "store-1",
      packageNumber: null,
      orderId: "ORD-003",
      paymentDate: "2026-04-02",
      saleStatus: "CANCELED",
      canonicalSalesUnitId: "sales-1",
      deliveryFeeAmount: 5000,
    } as never,
    {
      id: "item-5",
      storeId: "store-1",
      packageNumber: null,
      orderId: "ORD-004",
      paymentDate: "2026-04-02",
      saleStatus: "SALE",
      canonicalSalesUnitId: null,
      deliveryFeeAmount: 2000,
    } as never,
  );

  const summary = calculateStoreDeliverySummary(database, "store-1", "2026-04-02", "2026-04-02");
  assert.equal(summary.uniquePackageCount, 2);
  assert.equal(summary.deliveryUnitCost, 3500);
  assert.equal(summary.estimatedDeliveryBaseCost, 7000);
  assert.equal(summary.customerPaidDeliveryFee, 5000);
  assert.equal(summary.deliveryMargin, -2000);
});

run("calculateStoreDeliverySummary keeps positive delivery margin without clamping", () => {
  const database = createEmptyDatabase();
  database.stores.push({
    id: "store-1",
    deliveryUnitCost: DEFAULT_DELIVERY_UNIT_COST,
  } as never);
  database.orderItems.push({
    id: "item-1",
    storeId: "store-1",
    packageNumber: "PKG-001",
    orderId: "ORD-001",
    paymentDate: "2026-04-02",
    saleStatus: "SALE",
    canonicalSalesUnitId: "sales-1",
    deliveryFeeAmount: 10000,
  } as never);

  const summary = calculateStoreDeliverySummary(database, "store-1", "2026-04-02", "2026-04-02");
  assert.equal(summary.estimatedDeliveryBaseCost, 3500);
  assert.equal(summary.customerPaidDeliveryFee, 10000);
  assert.equal(summary.deliveryMargin, 6500);
});

runAsync("FakePurchaseService stores daily amounts by store and date with audit history", async () => {
  const { databaseService, fakePurchaseService, auditCalls } = createFakePurchaseServiceHarness();

  assert.deepEqual(fakePurchaseService.get("store-1", "2026-04-02"), {
    amount: 0,
    exists: false,
    updatedAt: null,
  });

  const created = await fakePurchaseService.upsert({
    storeId: "store-1",
    date: "2026-04-02",
    amount: 12000,
  });

  assert.equal(created.amount, 12000);
  assert.deepEqual(fakePurchaseService.get("store-1", "2026-04-02"), {
    amount: 12000,
    exists: true,
    updatedAt: created.updatedAt,
  });

  const updated = await fakePurchaseService.upsert({
    storeId: "store-1",
    date: "2026-04-02",
    amount: 0,
  });
  const snapshot = databaseService.getSnapshot();

  assert.equal(updated.id, created.id);
  assert.equal(updated.amount, 0);
  assert.equal(snapshot.dailyFakePurchases.length, 1);
  assert.equal(snapshot.dailyFakePurchases[0].amount, 0);
  assert.equal(auditCalls.length, 2);
  assert.deepEqual(auditCalls[0], {
    storeId: "store-1",
    domain: "FAKE_PURCHASE",
    action: "UPSERT",
    targetId: "store-1-2026-04-02",
    actorIdentifier: "LOCALHOST_ADMIN",
    beforeJson: null,
    afterJson: 12000,
  });
  assert.deepEqual(auditCalls[1], {
    storeId: "store-1",
    domain: "FAKE_PURCHASE",
    action: "UPSERT",
    targetId: "store-1-2026-04-02",
    actorIdentifier: "LOCALHOST_ADMIN",
    beforeJson: 12000,
    afterJson: 0,
  });
});

run("getAdMappingOverride returns manual mapped rows as overrides", () => {
  assert.deepEqual(
    getAdMappingOverride({
      canonicalSalesUnitId: "sales-1",
      mappingReason: "MANUAL_MAPPED",
      reasonNote: null,
    } as never),
    {
      type: "MANUAL_MAPPED",
      canonicalSalesUnitId: "sales-1",
    },
  );
});

run("evaluateAdMapping preserves manual overrides ahead of rule matching", () => {
  const database = createEmptyDatabase();
  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Hat", ["runninghat"]));
  database.campaignMappings.push({
    id: "mapping-1",
    storeId: "store-1",
    canonicalSalesUnitId: "sales-2",
    normalizedCampaignPattern: "alpha",
    isActive: true,
  } as never);

  const result = evaluateAdMapping(database, "store-1", "alpha campaign", {
    type: "MANUAL_MAPPED",
    canonicalSalesUnitId: "sales-1",
  });

  assert.equal(result.canonicalSalesUnitId, "sales-1");
  assert.equal(result.mappingReason, "MANUAL_MAPPED");
  assert.equal(result.matchedRuleCount, 0);
});

run("resolveOrderSignatureAutoMapping matches an order by alias", () => {
  const salesUnits = [createSalesUnit("sales-1", "Pretty Display Name", ["dietsocks", "diet socks"])];

  const result = resolveOrderSignatureAutoMapping(salesUnits, {
    normalizedProductName: normalizeText("diet socks"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("diet socks", null),
  } as never);

  assert.equal(result.canonicalSalesUnitId, "sales-1");
  assert.equal(result.ambiguous, false);
});

run("resolveOrderSignatureAutoMapping ignores displayName when aliases are empty", () => {
  const salesUnits = [createSalesUnit("sales-1", "diet socks", [])];

  const result = resolveOrderSignatureAutoMapping(salesUnits, {
    normalizedProductName: normalizeText("diet socks"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("diet socks", null),
  } as never);

  assert.equal(result.canonicalSalesUnitId, null);
  assert.equal(result.ambiguous, false);
});

run("recalculateOrderMappingsForStore marks ambiguous alias matches as conflict", () => {
  const database = createEmptyDatabase();
  database.canonicalSalesUnits.push(
    createSalesUnit("sales-1", "Diet Socks A", ["diet"]),
    createSalesUnit("sales-2", "Diet Socks B", ["diet"]),
  );
  database.orderSourceSignatures.push({
    id: "signature-1",
    storeId: "store-1",
    rawProductNameSnapshot: "diet special socks",
    rawOptionInfoSnapshot: null,
    normalizedProductName: normalizeText("diet special socks"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("diet special socks", null),
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED",
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.orderItems.push({
    id: "order-item-1",
    storeId: "store-1",
    orderId: "order-1",
    orderSourceSignatureId: "signature-1",
    canonicalSalesUnitId: null,
    externalProductOrderId: "external-1",
    externalProductId: null,
    packageNumber: null,
    rawProductName: "diet special socks",
    rawOptionInfo: null,
    normalizedProductName: normalizeText("diet special socks"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("diet special socks", null),
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: null,
    deliveryFeeAmount: null,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: "2026-04-01",
    paymentDate: "2026-04-01",
    saleStatus: "SALE",
    orderStatus: "DELIVERED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);

  recalculateOrderMappingsForStore(database, "store-1");

  assert.equal(database.orderSourceSignatures[0].mappingStatus, "CONFLICT");
  assert.equal(database.orderSourceSignatures[0].canonicalSalesUnitId, null);
  assert.equal(database.orderItems[0].canonicalSalesUnitId, null);
});

run("recalculateOrderMappingsForTouchedItems updates only touched order items", () => {
  const database = createEmptyDatabase();
  const touchedUnit = createSalesUnit("sales-1", "Touched Unit", []) as Record<string, unknown>;
  const untouchedUnit = createSalesUnit("sales-2", "Untouched Unit", []) as Record<string, unknown>;
  database.canonicalSalesUnits.push(
    {
      ...touchedUnit,
      linkedProductIds: ["prod-1"],
    } as never,
    {
      ...untouchedUnit,
      linkedProductIds: ["prod-2"],
    } as never,
  );
  database.orderSourceSignatures.push(
    createOrderSourceSignature("sig-1", "touched product"),
    createOrderSourceSignature("sig-2", "untouched product"),
  );
  const createOrderItem = (id: string, signatureId: string, productId: string) =>
    ({
      id,
      storeId: "store-1",
      orderId: `order-${id}`,
      orderSourceSignatureId: signatureId,
      canonicalSalesUnitId: null,
      externalProductOrderId: `external-${id}`,
      externalProductId: productId,
      optionCode: null,
      packageNumber: null,
      rawProductName: id,
      rawOptionInfo: null,
      normalizedProductName: normalizeText(id),
      normalizedOptionInfo: "",
      sourceSignature: createSourceSignature(id, null),
      quantity: 1,
      productPaymentAmount: 10000,
      totalProductAmount: null,
      deliveryFeeAmount: null,
      paymentCommission: null,
      knowledgeShoppingSellingInterlockCommission: null,
      saleCommission: null,
      channelCommission: null,
      orderDate: "2026-04-01",
      paymentDate: "2026-04-01",
      saleStatus: "SALE",
      orderStatus: "DELIVERED",
      isCanceled: false,
      isReturned: false,
      rawPayload: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }) as never;
  const conflictingSameSignatureItem = createOrderItem("item-3", "sig-1", "prod-2") as Record<string, unknown>;
  conflictingSameSignatureItem.canonicalSalesUnitId = "sales-2";
  database.orderItems.push(
    createOrderItem("item-1", "sig-1", "prod-1"),
    createOrderItem("item-2", "sig-2", "prod-2"),
    conflictingSameSignatureItem as never,
  );

  recalculateOrderMappingsForTouchedItems(database, {
    storeId: "store-1",
    signatureIds: new Set(["sig-1"]),
    orderItemIds: new Set(["item-1"]),
  });

  assert.equal(database.orderItems.find((item) => item.id === "item-1")?.canonicalSalesUnitId, "sales-1");
  assert.equal(database.orderItems.find((item) => item.id === "item-2")?.canonicalSalesUnitId, null);
  assert.equal(database.orderItems.find((item) => item.id === "item-3")?.canonicalSalesUnitId, "sales-2");
  assert.equal(database.orderSourceSignatures.find((item) => item.id === "sig-1")?.mappingStatus, "CONFLICT");
  assert.equal(database.orderSourceSignatures.find((item) => item.id === "sig-1")?.canonicalSalesUnitId, null);
  assert.equal(database.orderSourceSignatures.find((item) => item.id === "sig-2")?.canonicalSalesUnitId, null);
});

run("recalculateOrderMappingsForStore detects bundled items from signature raw option snapshot", () => {
  const database = createEmptyDatabase();
  const mainUnit = createSalesUnit("sales-main", "Main Product", []) as Record<string, unknown>;
  mainUnit.linkedProductIds = ["product-shared"];
  const bundledUnit = createSalesUnit("sales-bundled", "Bundled Option", []) as Record<string, unknown>;
  bundledUnit.linkedManageCodes = ["manage-bundled"];
  database.canonicalSalesUnits.push(mainUnit as never, bundledUnit as never);
  const bundledSignature = createOrderSourceSignature("sig-bundled", "Main Product") as OrderSourceSignature;
  bundledSignature.rawOptionInfoSnapshot = "[함께배송] Bundled Option: Black";
  bundledSignature.normalizedOptionInfo = normalizeText("[함께배송] Bundled Option: Black");
  bundledSignature.sourceSignature = createSourceSignature("Main Product", "[함께배송] Bundled Option: Black");
  database.orderSourceSignatures.push(bundledSignature);
  database.orderItems.push({
    id: "item-bundled",
    storeId: "store-1",
    orderId: "order-bundled",
    orderSourceSignatureId: "sig-bundled",
    canonicalSalesUnitId: null,
    externalProductOrderId: "external-bundled",
    externalProductId: "product-shared",
    optionCode: null,
    optionManageCode: "manage-bundled",
    packageNumber: null,
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: null,
    deliveryFeeAmount: null,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: "2026-04-01",
    paymentDate: "2026-04-01",
    saleStatus: "SALE",
    orderStatus: "DELIVERED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as OrderItem);

  recalculateOrderMappingsForStore(database, "store-1");

  assert.equal(database.orderItems[0].canonicalSalesUnitId, "sales-bundled");
  assert.equal(database.orderSourceSignatures[0].canonicalSalesUnitId, "sales-bundled");
});

runAsync("MappingSeedService uses signature snapshots when order item raw text fields are absent", async () => {
  const databaseService = createMemoryDatabaseService();
  const service = new MappingSeedService(
    databaseService as never,
    { ensureWritable: () => undefined } as never,
    createAuditLogServiceDouble() as never,
  );

  databaseService.write((draft) => {
    draft.stores.push(createStoreRecord("store-1", "Main Store"));
    const seedSignature = createOrderSourceSignature("sig-seed", "Main Product") as OrderSourceSignature;
    seedSignature.rawOptionInfoSnapshot = "[함께배송] Care Band: Black";
    seedSignature.normalizedOptionInfo = normalizeText("[함께배송] Care Band: Black");
    seedSignature.sourceSignature = createSourceSignature("Main Product", "[함께배송] Care Band: Black");
    draft.orderSourceSignatures.push(seedSignature);
    draft.orderItems.push({
      id: "item-seed",
      storeId: "store-1",
      orderId: "order-seed",
      productId: null,
      orderSourceSignatureId: "sig-seed",
      canonicalSalesUnitId: null,
      externalProductOrderId: "external-seed",
      externalProductId: "product-seed",
      optionCode: "option-seed",
      optionManageCode: "manage-seed",
      packageNumber: null,
      quantity: 1,
      productPaymentAmount: 10000,
      totalProductAmount: null,
      deliveryFeeAmount: null,
      paymentCommission: null,
      knowledgeShoppingSellingInterlockCommission: null,
      saleCommission: null,
      channelCommission: null,
      orderDate: "2026-04-01",
      paymentDate: "2026-04-01",
      saleStatus: "SALE",
      orderStatus: "DELIVERED",
      isCanceled: false,
      isReturned: false,
      rawPayload: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as OrderItem);
  });

  const result = await service.generateInitialMappings("store-1");
  const snapshot = databaseService.getSnapshot();
  const created = snapshot.canonicalSalesUnits.find((unit: { displayName: string }) =>
    unit.displayName === "Care Band"
  );

  assert.equal(result.createdCount, 1);
  assert.equal(created?.linkedOptionCodes.includes("option-seed"), true);
  assert.equal(created?.linkedManageCodes.includes("manage-seed"), true);
  assert.equal(snapshot.orderItems[0].canonicalSalesUnitId, created?.id);
});

runAsync("OrderMappingService saveMappings deduplicates signatures without recalculation", async () => {
  const { databaseService, orderMappingService, enqueueCalls } = createOrderMappingServiceHarness();

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Diet Socks", ["diet socks"]));
    draft.orderSourceSignatures.push(
      createOrderSourceSignature("sig-1", "diet socks"),
      createOrderSourceSignature("sig-2", "diet socks black"),
    );
    draft.orderItems.push(
      {
        id: "order-item-1",
        storeId: "store-1",
        orderSourceSignatureId: "sig-1",
        canonicalSalesUnitId: null,
        updatedAt: new Date().toISOString(),
      } as never,
      {
        id: "order-item-2",
        storeId: "store-1",
        orderSourceSignatureId: "sig-2",
        canonicalSalesUnitId: null,
        updatedAt: new Date().toISOString(),
      } as never,
    );
  });

  const result = await orderMappingService.saveMappings(["sig-1", "sig-1", "sig-2"], {
    canonicalSalesUnitId: "sales-1",
  });
  const snapshot = databaseService.getSnapshot();
  const first = snapshot.orderSourceSignatures.find((item: { id: string }) => item.id === "sig-1");
  const second = snapshot.orderSourceSignatures.find((item: { id: string }) => item.id === "sig-2");
  const firstOrderItem = snapshot.orderItems.find((item: { id: string }) => item.id === "order-item-1");
  const secondOrderItem = snapshot.orderItems.find((item: { id: string }) => item.id === "order-item-2");

  assert.equal(result.data.updatedCount, 2);
  assert.equal(result.data.operationId, null);
  assert.equal(enqueueCalls.length, 0);
  assert.equal(first?.canonicalSalesUnitId, "sales-1");
  assert.equal(second?.canonicalSalesUnitId, "sales-1");
  assert.equal(firstOrderItem?.canonicalSalesUnitId, "sales-1");
  assert.equal(secondOrderItem?.canonicalSalesUnitId, "sales-1");
  assert.equal(first?.mappingStatus, "MAPPED");
  assert.equal(second?.mappingStatus, "MAPPED");
});

runAsync("OrderMappingService saveMappings updates only related rows and refreshes affected dates directly", async () => {
  const { databaseService, orderMappingService, profitSummaryService } = createOrderMappingServiceHarness({
    withProfitSummaryService: true,
  });
  const summaryService = profitSummaryService!;
  const refreshCalls: Array<{ storeId: string; dates: string[]; reason: string }> = [];
  const originalRefresh = summaryService.refreshStoreDateListBestEffort.bind(summaryService);
  summaryService.refreshStoreDateListBestEffort = ((params) => {
    refreshCalls.push({ ...params });
    return originalRefresh(params);
  }) as ProfitSummaryService["refreshStoreDateListBestEffort"];
  const createMappedTestItem = (overrides: Partial<OrderItem> & Pick<OrderItem, "id" | "storeId">) =>
    ({
      id: overrides.id,
      storeId: overrides.storeId,
      orderId: `order-${overrides.id}`,
      productId: null,
      orderSourceSignatureId: overrides.orderSourceSignatureId ?? "sig-1",
      canonicalSalesUnitId: overrides.canonicalSalesUnitId ?? null,
      externalProductOrderId: `external-${overrides.id}`,
      externalProductId: null,
      optionCode: null,
      packageNumber: null,
      rawProductName: "daily unit",
      rawOptionInfo: null,
      normalizedProductName: normalizeText("daily unit"),
      normalizedOptionInfo: "",
      sourceSignature: createSourceSignature("daily unit", null),
      quantity: 1,
      productPaymentAmount: 100,
      totalProductAmount: 100,
      deliveryFeeAmount: 0,
      paymentCommission: 0,
      knowledgeShoppingSellingInterlockCommission: null,
      saleCommission: null,
      channelCommission: null,
      orderDate: overrides.orderDate ?? overrides.paymentDate ?? "2026-04-01",
      paymentDate: Object.prototype.hasOwnProperty.call(overrides, "paymentDate")
        ? (overrides.paymentDate ?? null)
        : "2026-04-01",
      saleStatus: "SALE",
      orderStatus: "DELIVERED",
      isCanceled: false,
      isReturned: false,
      rawPayload: null,
      createdAt: new Date().toISOString(),
      updatedAt: "before",
    }) as OrderItem;

  databaseService.write((draft) => {
    draft.stores.push(createStoreRecord("store-1", "Main Store"), createStoreRecord("store-2", "Other Store"));
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Daily Unit", ["daily"]));
    draft.orderSourceSignatures.push(
      createOrderSourceSignature("sig-1", "daily unit"),
      createOrderSourceSignature("sig-2", "untouched unit"),
    );
    draft.orderItems.push(
      createMappedTestItem({ id: "item-target-1", storeId: "store-1", paymentDate: "2026-04-02" }) as never,
      createMappedTestItem({ id: "item-target-2", storeId: "store-1", paymentDate: "2026-04-01" }) as never,
      createMappedTestItem({ id: "item-target-no-date", storeId: "store-1", paymentDate: null }) as never,
      createMappedTestItem({
        id: "item-other-signature",
        storeId: "store-1",
        orderSourceSignatureId: "sig-2",
        paymentDate: "2026-04-03",
      }) as never,
      createMappedTestItem({ id: "item-other-store", storeId: "store-2", paymentDate: "2026-04-04" }) as never,
    );
  });

  databaseService.storageMode = "postgres";
  databaseService.writeCommitted = async () => {
    throw new Error("writeCommitted should not be used for PostgreSQL order manual mapping");
  };

  const result = await orderMappingService.saveMappings(["sig-1", "sig-1"], {
    canonicalSalesUnitId: "sales-1",
  });
  const snapshot = databaseService.getSnapshot();

  assert.equal(result.data.updatedCount, 1);
  assert.equal(databaseService.saveOrderManualMappingsCommittedCalls, 1);
  assert.equal(databaseService.writeCommittedCalls, 0);
  assert.equal(databaseService.replaceDailyProfitSummariesCommittedCalls, 1);
  assert.deepEqual(refreshCalls[0]?.dates, ["2026-04-01", "2026-04-02"]);
  assert.equal(snapshot.orderSourceSignatures.find((item: OrderSourceSignature) => item.id === "sig-1")?.canonicalSalesUnitId, "sales-1");
  assert.equal(snapshot.orderSourceSignatures.find((item: OrderSourceSignature) => item.id === "sig-2")?.canonicalSalesUnitId, null);
  assert.equal(snapshot.orderItems.find((item: OrderItem) => item.id === "item-target-1")?.canonicalSalesUnitId, "sales-1");
  assert.equal(snapshot.orderItems.find((item: OrderItem) => item.id === "item-target-2")?.canonicalSalesUnitId, "sales-1");
  assert.equal(snapshot.orderItems.find((item: OrderItem) => item.id === "item-target-no-date")?.canonicalSalesUnitId, "sales-1");
  assert.equal(snapshot.orderItems.find((item: OrderItem) => item.id === "item-other-signature")?.canonicalSalesUnitId, null);
  assert.equal(snapshot.orderItems.find((item: OrderItem) => item.id === "item-other-store")?.canonicalSalesUnitId, null);
  assert.deepEqual(
    snapshot.dailyStoreSummaries.map((row: StoredDailyStoreSummary) => row.date).sort(),
    ["2026-04-01", "2026-04-02"],
  );
});

runAsync("OrderMappingService saveMappings rejects cross-store signature batches", async () => {
  const { databaseService, orderMappingService } = createOrderMappingServiceHarness();

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Unit", ["unit"]));
    draft.orderSourceSignatures.push(
      createOrderSourceSignature("sig-store-1", "unit", "store-1"),
      createOrderSourceSignature("sig-store-2", "unit", "store-2"),
    );
  });

  await assert.rejects(
    () =>
      orderMappingService.saveMappings(["sig-store-1", "sig-store-2"], {
        canonicalSalesUnitId: "sales-1",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "getResponse" in error &&
      JSON.stringify((error as { getResponse: () => unknown }).getResponse()).includes("CROSS_STORE_REFERENCE"),
  );
  assert.equal(databaseService.saveOrderManualMappingsCommittedCalls, 0);
});

runAsync("OrderMappingService saveMappings rejects inactive and group sales units before commit", async () => {
  const cases: Array<{ salesUnit: Record<string, unknown> & { id: string }; reason: string }> = [
    {
      salesUnit: {
        ...(createSalesUnit("sales-inactive", "Inactive Unit", ["inactive"]) as Record<string, unknown>),
        id: "sales-inactive",
        isActive: false,
        deactivatedAt: new Date().toISOString(),
      },
      reason: "INVALID_VALUE",
    },
    {
      salesUnit: {
        ...(createSalesUnit("sales-group", "Group Unit", ["group"]) as Record<string, unknown>),
        id: "sales-group",
        isGroup: true,
      },
      reason: "CANNOT_MAP_TO_GROUP",
    },
  ];

  for (const testCase of cases) {
    const { databaseService, orderMappingService } = createOrderMappingServiceHarness();
    databaseService.write((draft) => {
      draft.canonicalSalesUnits.push(testCase.salesUnit as never);
      draft.orderSourceSignatures.push(createOrderSourceSignature("sig-1", "unit"));
    });

    await assert.rejects(
      () =>
        orderMappingService.saveMappings(["sig-1"], {
          canonicalSalesUnitId: testCase.salesUnit.id as string,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "getResponse" in error &&
        JSON.stringify((error as { getResponse: () => unknown }).getResponse()).includes(testCase.reason),
    );
    assert.equal(databaseService.saveOrderManualMappingsCommittedCalls, 0);
  }
});

runAsync("OrderMappingService saveMappings skips profit summary refresh when affected dates are empty", async () => {
  const { databaseService, orderMappingService, profitSummaryService } = createOrderMappingServiceHarness({
    withProfitSummaryService: true,
  });
  const summaryService = profitSummaryService!;
  let refreshCalls = 0;
  const originalRefresh = summaryService.refreshStoreDateListBestEffort.bind(summaryService);
  summaryService.refreshStoreDateListBestEffort = ((params) => {
    refreshCalls += 1;
    return originalRefresh(params);
  }) as ProfitSummaryService["refreshStoreDateListBestEffort"];

  databaseService.write((draft) => {
    draft.stores.push(createStoreRecord("store-1", "Main Store"));
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "No Date Unit", ["no date"]));
    draft.orderSourceSignatures.push(createOrderSourceSignature("sig-no-date", "no date product"));
    draft.orderItems.push({
      id: "order-item-no-date",
      storeId: "store-1",
      orderSourceSignatureId: "sig-no-date",
      canonicalSalesUnitId: null,
      paymentDate: null,
      updatedAt: new Date().toISOString(),
    } as never);
  });

  const writeCountBefore = databaseService.writeCommittedCalls;
  const result = await orderMappingService.saveMappings(["sig-no-date"], {
    canonicalSalesUnitId: "sales-1",
  });
  const snapshot = databaseService.getSnapshot();

  assert.equal(result.data.updatedCount, 1);
  assert.equal(
    snapshot.orderItems.find((item: { id: string }) => item.id === "order-item-no-date")?.canonicalSalesUnitId,
    "sales-1",
  );
  assert.equal(refreshCalls, 0);
  assert.equal(databaseService.saveOrderManualMappingsCommittedCalls, 1);
  assert.equal(databaseService.writeCommittedCalls, writeCountBefore + 1);
  assert.equal(snapshot.dailyStoreSummaries.length, 0);
  assert.equal(snapshot.dailySalesUnitProfits.length, 0);
});

runAsync("OrderMappingService enqueueRecalculate starts one order mapping recalculation", async () => {
  const { orderMappingService, enqueueCalls } = createOrderMappingServiceHarness();

  const result = await orderMappingService.enqueueRecalculate("store-1");

  assert.equal(result.data.operationId, "operation-1");
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0]?.storeId, "store-1");
  assert.equal(enqueueCalls[0]?.requestJson.reason, "MANUAL_RECALCULATE_ORDER_MAPPING");
});

runAsync("OrderMappingService createAndMapMany skips automatic recalculation during sales-unit creation", async () => {
  const databaseService = createMemoryDatabaseService();
  const createCalls: Array<{
    options?: {
      skipOrderRecalculation?: boolean;
      skipAdRecalculation?: boolean;
      skipProfitSummaryRecalculation?: boolean;
    };
  }> = [];
  const orderMappingService = new OrderMappingService(
    databaseService as never,
    {
      registerRetryExecutor: () => undefined,
      enqueue: () => ({ id: "operation-1" }),
    } as never,
    {
      ensureWritable: () => undefined,
    } as never,
    {
      create: (
        payload: { displayName: string; matchAliases?: string[] | null },
        options?: {
          skipOrderRecalculation?: boolean;
          skipAdRecalculation?: boolean;
          skipProfitSummaryRecalculation?: boolean;
        },
      ) => {
        createCalls.push({ options });
        databaseService.write((draft) => {
          draft.canonicalSalesUnits.push(
            createSalesUnit("sales-created", payload.displayName, payload.matchAliases ?? []),
          );
        });
        return {
          data: {
            id: "sales-created",
          },
        };
      },
    } as never,
  );

  databaseService.write((draft) => {
    draft.orderSourceSignatures.push(createOrderSourceSignature("sig-create", "alpha pack"));
  });

  await orderMappingService.createAndMapMany(["sig-create"], {
    displayName: "Alpha Pack",
    matchAliases: ["alpha pack"],
    memo: null,
  });

  assert.equal(createCalls[0]?.options?.skipOrderRecalculation, true);
  assert.equal(createCalls[0]?.options?.skipAdRecalculation, true);
  assert.equal(createCalls[0]?.options?.skipProfitSummaryRecalculation, true);
});

runAsync("OrderMappingService createAndMapMany creates sales unit directly and maps selected signatures in PostgreSQL mode", async () => {
  const databaseService = createMemoryDatabaseService();
  const salesUnitService = new SalesUnitService(
    databaseService as never,
    { ensureWritable: () => undefined } as never,
    createAuditLogServiceDouble() as never,
  );
  const orderMappingService = new OrderMappingService(
    databaseService as never,
    {
      registerRetryExecutor: () => undefined,
      enqueue: () => ({ id: "operation-1" }),
    } as never,
    {
      ensureWritable: () => undefined,
    } as never,
    salesUnitService,
  );

  databaseService.write((draft) => {
    draft.stores.push(createStoreRecord("store-1", "Main Store"));
    draft.orderSourceSignatures.push(
      createOrderSourceSignature("sig-create-selected", "Alpha Pack"),
      createOrderSourceSignature("sig-create-unselected", "Alpha Pack"),
    );
    draft.orderItems.push(
      {
        id: "order-item-create-selected",
        storeId: "store-1",
        orderSourceSignatureId: "sig-create-selected",
        canonicalSalesUnitId: null,
        paymentDate: "2026-04-01",
        updatedAt: "before",
      } as never,
      {
        id: "order-item-create-unselected",
        storeId: "store-1",
        orderSourceSignatureId: "sig-create-unselected",
        canonicalSalesUnitId: null,
        paymentDate: "2026-04-01",
        updatedAt: "before",
      } as never,
    );
  });
  databaseService.storageMode = "postgres";
  databaseService.writeCommitted = async () => {
    throw new Error("writeCommitted should not be used for PostgreSQL create-and-map");
  };

  const result = await orderMappingService.createAndMapMany(["sig-create-selected"], {
    displayName: "Alpha Pack",
    matchAliases: [" Alpha Pack "],
    linkedProductIds: ["product-alpha"],
    linkedOptionCodes: ["option-alpha"],
    memo: "created from mapping",
  });
  const snapshot = databaseService.getSnapshot();
  const createdSalesUnitId = result.data.createdSalesUnitId;
  const createdInSnapshot = snapshot.canonicalSalesUnits.find(
    (salesUnit: { id: string }) => salesUnit.id === createdSalesUnitId,
  );
  const createdInDatabase = databaseService.database.canonicalSalesUnits.find(
    (salesUnit: { id: string }) => salesUnit.id === createdSalesUnitId,
  );

  assert.equal(databaseService.writeCommittedCalls, 0);
  assert.equal(databaseService.createCanonicalSalesUnitCommittedCalls, 1);
  assert.equal(databaseService.saveOrderManualMappingsCommittedCalls, 1);
  assert.ok(createdInSnapshot);
  assert.ok(createdInDatabase);
  assert.equal(createdInSnapshot?.displayName, "Alpha Pack");
  assert.deepEqual(createdInSnapshot?.matchAliases, ["Alpha Pack"]);
  assert.deepEqual(createdInSnapshot?.normalizedMatchAliases, ["alphapack"]);
  assert.deepEqual(createdInSnapshot?.linkedProductIds, ["product-alpha"]);
  assert.deepEqual(createdInSnapshot?.linkedOptionCodes, ["option-alpha"]);
  assert.equal(
    snapshot.orderSourceSignatures.find((signature: { id: string }) => signature.id === "sig-create-selected")
      ?.canonicalSalesUnitId,
    createdSalesUnitId,
  );
  assert.equal(
    snapshot.orderItems.find((item: { id: string }) => item.id === "order-item-create-selected")
      ?.canonicalSalesUnitId,
    createdSalesUnitId,
  );
  assert.equal(
    snapshot.orderSourceSignatures.find((signature: { id: string }) => signature.id === "sig-create-unselected")
      ?.canonicalSalesUnitId,
    null,
  );
  assert.equal(
    snapshot.orderItems.find((item: { id: string }) => item.id === "order-item-create-unselected")
      ?.canonicalSalesUnitId,
    null,
  );
});

runAsync("OrderSyncService listOrderSourceSignatures searches canonical sales unit display name", async () => {
  const { databaseService, orderSyncService } = createOrderSyncServiceHarness({
    stores: [createStoreRecord("store-1", "Main Store")],
    configuredStoreIds: ["store-1"],
  });

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-needle", "Needle Unit", []));
    draft.orderSourceSignatures.push(
      Object.assign(createOrderSourceSignature("sig-needle", "Hidden Product") as Record<string, unknown>, {
        canonicalSalesUnitId: "sales-needle",
        mappingStatus: "MAPPED",
      }) as never,
      createOrderSourceSignature("sig-other", "Other Product"),
    );
  });

  const result = await orderSyncService.listOrderSourceSignatures({
    storeId: "store-1",
    q: "Needle Unit",
  });

  assert.equal(result.data.totalCount, 1);
  assert.equal(result.data.items[0].id, "sig-needle");
  assert.equal(result.data.items[0].canonicalDisplayName, "Needle Unit");
});

run("evaluateAdMapping falls back to alias matching without a campaign rule", () => {
  const database = createEmptyDatabase();
  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Display Only", ["kneebrace"]));

  const result = evaluateAdMapping(database, "store-1", normalizeText("best knee-brace campaign"));

  assert.equal(result.canonicalSalesUnitId, "sales-1");
  assert.equal(result.mappingReason, "RULE_MATCHED");
});

run("evaluateAdMapping returns conflict when multiple aliases match", () => {
  const database = createEmptyDatabase();
  database.canonicalSalesUnits.push(
    createSalesUnit("sales-1", "Campaign A", ["diet"]),
    createSalesUnit("sales-2", "Campaign B", ["diet"]),
  );

  const result = evaluateAdMapping(database, "store-1", normalizeText("diet launch campaign"));

  assert.equal(result.canonicalSalesUnitId, null);
  assert.equal(result.mappingReason, "MULTIPLE_RULES");
});

run("recalculateAdCampaignSignaturesForStore without row apply leaves ad cost rows unchanged", () => {
  const database = createEmptyDatabase();
  const originalUpdatedAt = "2026-04-01T00:00:00.000Z";
  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Launch Unit", ["launch"]));
  database.campaignMappings.push({
    id: "campaign-rule-1",
    storeId: "store-1",
    channel: "NAVER_DA",
    canonicalSalesUnitId: "sales-1",
    campaignPattern: "launch",
    normalizedCampaignPattern: normalizeText("launch"),
    isActive: true,
    deactivatedAt: null,
    createdAt: originalUpdatedAt,
    updatedAt: originalUpdatedAt,
  });
  database.adCampaignSignatures.push({
    id: "ad-signature-1",
    storeId: "store-1",
    channel: "NAVER_DA",
    campaignId: "cmp-1",
    campaignNameSnapshot: "launch campaign",
    normalizedCampaignName: normalizeText("launch campaign"),
    canonicalSalesUnitId: null,
    mappingReason: "NO_RULE",
    matchedRuleCount: 0,
    reasonNote: "일치하는 규칙이 없습니다.",
    reasonNoteInherited: false,
    confirmedAt: null,
    usageCount: 1,
    firstSeenDate: "2026-04-01",
    lastSeenDate: "2026-04-01",
    lastAutoMappedAt: null,
    mappingRuleHash: null,
    createdAt: originalUpdatedAt,
    updatedAt: originalUpdatedAt,
  });
  const row = createConfirmedUploadRow({
    uploadId: "upload-1",
    reportDate: "2026-04-01",
    campaignId: "cmp-1",
    campaignName: "launch campaign",
    canonicalSalesUnitId: null,
    totalCost: 100,
  }) as Record<string, unknown>;
  row.adCampaignSignatureId = "ad-signature-1";
  row.updatedAt = originalUpdatedAt;
  database.adCampaignDailyCosts.push(row as never);

  recalculateAdCampaignSignaturesForStore(database, "store-1", { onlyUnconfirmed: true });

  assert.equal(database.adCampaignSignatures[0].canonicalSalesUnitId, "sales-1");
  assert.equal(database.adCampaignSignatures[0].mappingReason, "RULE_MATCHED");
  assert.equal(database.adCampaignDailyCosts[0].canonicalSalesUnitId, null);
  assert.equal(database.adCampaignDailyCosts[0].mappingReason, "NO_RULE");
  assert.equal(database.adCampaignDailyCosts[0].updatedAt, originalUpdatedAt);
});

run("recalculateAdCampaignSignaturesForStore with row apply syncs ad cost rows", () => {
  const database = createEmptyDatabase();
  const originalUpdatedAt = "2026-04-01T00:00:00.000Z";
  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Launch Unit", ["launch"]));
  database.campaignMappings.push({
    id: "campaign-rule-1",
    storeId: "store-1",
    channel: "NAVER_DA",
    canonicalSalesUnitId: "sales-1",
    campaignPattern: "launch",
    normalizedCampaignPattern: normalizeText("launch"),
    isActive: true,
    deactivatedAt: null,
    createdAt: originalUpdatedAt,
    updatedAt: originalUpdatedAt,
  });
  database.adCampaignSignatures.push({
    id: "ad-signature-1",
    storeId: "store-1",
    channel: "NAVER_DA",
    campaignId: "cmp-1",
    campaignNameSnapshot: "launch campaign",
    normalizedCampaignName: normalizeText("launch campaign"),
    canonicalSalesUnitId: null,
    mappingReason: "NO_RULE",
    matchedRuleCount: 0,
    reasonNote: "?쇱튂?섎뒗 洹쒖튃???놁뒿?덈떎.",
    reasonNoteInherited: false,
    confirmedAt: null,
    usageCount: 1,
    firstSeenDate: "2026-04-01",
    lastSeenDate: "2026-04-01",
    lastAutoMappedAt: null,
    mappingRuleHash: null,
    createdAt: originalUpdatedAt,
    updatedAt: originalUpdatedAt,
  });
  const row = createConfirmedUploadRow({
    uploadId: "upload-1",
    reportDate: "2026-04-01",
    campaignId: "cmp-1",
    campaignName: "launch campaign",
    canonicalSalesUnitId: null,
    totalCost: 100,
  }) as Record<string, unknown>;
  row.adCampaignSignatureId = "ad-signature-1";
  row.updatedAt = originalUpdatedAt;
  database.adCampaignDailyCosts.push(row as never);

  recalculateAdCampaignSignaturesForStore(database, "store-1", {
    onlyUnconfirmed: true,
    applyToRows: true,
  });

  assert.equal(database.adCampaignSignatures[0].canonicalSalesUnitId, "sales-1");
  assert.equal(database.adCampaignSignatures[0].mappingReason, "RULE_MATCHED");
  assert.equal(database.adCampaignDailyCosts[0].canonicalSalesUnitId, "sales-1");
  assert.equal(database.adCampaignDailyCosts[0].mappingReason, "RULE_MATCHED");
  assert.notEqual(database.adCampaignDailyCosts[0].updatedAt, originalUpdatedAt);
});

run("DatabaseService normalizeSnapshot keeps conflicting manual ad rows as signature conflict", () => {
  const database = createEmptyDatabase();
  database.adCampaignDailyCosts.push(
    createConfirmedUploadRow({
      uploadId: "upload-1",
      reportDate: "2026-04-01",
      campaignId: "cmp-conflict",
      campaignName: "manual conflict",
      canonicalSalesUnitId: "sales-1",
      totalCost: 100,
      mappingReason: "MANUAL_MAPPED",
    }),
    createConfirmedUploadRow({
      uploadId: "upload-2",
      reportDate: "2026-04-02",
      campaignId: "cmp-conflict",
      campaignName: "manual conflict",
      canonicalSalesUnitId: "sales-2",
      totalCost: 100,
      mappingReason: "MANUAL_MAPPED",
    }),
  );

  const normalized = (
    new DatabaseService() as unknown as {
      normalizeSnapshot(snapshot: typeof database): typeof database;
    }
  ).normalizeSnapshot(database);
  const signature = normalized.adCampaignSignatures.find(
    (item: { campaignId: string | null }) => item.campaignId === "cmp-conflict",
  )!;

  assert.equal(signature.mappingReason, "MULTIPLE_RULES");
  assert.equal(signature.canonicalSalesUnitId, null);
  assert.equal(signature.confirmedAt, null);
  assert.equal(new Set(normalized.adCampaignDailyCosts.map((item) => item.adCampaignSignatureId)).size, 1);
});

runAsync("DatabaseService writeCommitted propagates PostgreSQL failures without swapping memory snapshot", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  service.database = createEmptyDatabase();
  service.database.stores.push({ id: "store-original" } as never);
  service.storageMode = "postgres";
  service.persistenceQueue = Promise.resolve();
  service.pendingWriteCount = 0;
  service.lastPersistenceError = null;
  service.persistSnapshotToPostgres = async () => {
    throw new Error("POSTGRES_COMMIT_FAILED");
  };

  await assert.rejects(
    () =>
      service.writeCommitted((draft: ReturnType<typeof createEmptyDatabase>) => {
        draft.stores.push({ id: "store-new" } as never);
      }),
    /POSTGRES_COMMIT_FAILED/,
  );

  assert.deepEqual(
    service.getSnapshot().stores.map((store: { id: string }) => store.id),
    ["store-original"],
  );
  assert.equal(service.getPersistenceStatus().lastPersistenceError?.message, "POSTGRES_COMMIT_FAILED");
});

runAsync("DatabaseService file mode writes committed snapshots atomically under DATA_DIR", async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDataDir = process.env.DATA_DIR;
  const tempDir = mkdtempSync(join(tmpdir(), "patima-db-"));

  try {
    delete process.env.DATABASE_URL;
    process.env.DATA_DIR = tempDir;
    const service = new DatabaseService();
    await service.onModuleInit();

    await service.writeCommitted((draft) => {
      draft.stores.push({ id: "store-atomic" } as never);
      draft.orderItems.push({
        id: "item-atomic",
        orderId: "order-atomic",
        storeId: "store-atomic",
        productId: null,
        orderSourceSignatureId: null,
        canonicalSalesUnitId: null,
        externalProductOrderId: "external-atomic",
        externalProductId: null,
        optionCode: null,
        packageNumber: null,
        rawProductName: "Atomic Product",
        rawOptionInfo: "Atomic Option",
        normalizedProductName: "atomic product",
        normalizedOptionInfo: "atomic option",
        sourceSignature: "atomic product || atomic option",
        quantity: 1,
        productPaymentAmount: 100,
        totalProductAmount: 100,
        deliveryFeeAmount: 0,
        paymentCommission: null,
        knowledgeShoppingSellingInterlockCommission: null,
        saleCommission: null,
        channelCommission: null,
        orderDate: "2026-04-01",
        paymentDate: "2026-04-01",
        saleStatus: "SALE",
        orderStatus: "PAYED",
        isCanceled: false,
        isReturned: false,
        rawPayload: null,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      } as never);
    });

    const filePath = join(tempDir, "database.json");
    const saved = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(existsSync(filePath), true);
    assert.equal(readdirSync(tempDir).some((fileName) => fileName.includes(".tmp-")), false);
    assert.equal(saved.stores[0].id, "store-atomic");
    assert.equal(saved.orderItems[0].id, "item-atomic");
  } finally {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

run("DatabaseService stableStringify and hashPayload ignore object key order", () => {
  const left = { b: 2, a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: 2 };

  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(hashPayload(left), hashPayload(right));
});

runAsync("DatabaseService PostgreSQL saves order manual mappings with row-level direct updates", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const makeOrderItem = (overrides: Partial<OrderItem> & Pick<OrderItem, "id" | "storeId">): OrderItem =>
    ({
      id: overrides.id,
      storeId: overrides.storeId,
      orderId: `order-${overrides.id}`,
      productId: null,
      orderSourceSignatureId: overrides.orderSourceSignatureId ?? "sig-1",
      canonicalSalesUnitId: overrides.canonicalSalesUnitId ?? null,
      externalProductOrderId: `external-${overrides.id}`,
      externalProductId: null,
      optionCode: null,
      packageNumber: null,
      rawProductName: "direct unit",
      rawOptionInfo: null,
      normalizedProductName: normalizeText("direct unit"),
      normalizedOptionInfo: "",
      sourceSignature: createSourceSignature("direct unit", null),
      quantity: 1,
      productPaymentAmount: 100,
      totalProductAmount: 100,
      deliveryFeeAmount: 0,
      paymentCommission: 0,
      knowledgeShoppingSellingInterlockCommission: null,
      saleCommission: null,
      channelCommission: null,
      orderDate: overrides.orderDate ?? overrides.paymentDate ?? "2026-04-01",
      paymentDate: Object.prototype.hasOwnProperty.call(overrides, "paymentDate")
        ? (overrides.paymentDate ?? null)
        : "2026-04-01",
      saleStatus: "SALE",
      orderStatus: "DELIVERED",
      isCanceled: false,
      isReturned: false,
      rawPayload: null,
      createdAt: "before",
      updatedAt: "before",
    }) as OrderItem;

  service.database = createEmptyDatabase();
  service.database.orderSourceSignatures.push(
    createOrderSourceSignature("sig-1", "direct unit"),
    createOrderSourceSignature("sig-2", "direct unit two"),
    createOrderSourceSignature("sig-other", "other unit"),
    createOrderSourceSignature("sig-store-2", "direct unit", "store-2"),
  );
  service.database.orderItems.push(
    makeOrderItem({ id: "item-1", storeId: "store-1", orderSourceSignatureId: "sig-1", paymentDate: "2026-04-02" }) as never,
    makeOrderItem({ id: "item-2", storeId: "store-1", orderSourceSignatureId: "sig-2", paymentDate: "2026-04-01" }) as never,
    makeOrderItem({ id: "item-3", storeId: "store-1", orderSourceSignatureId: "sig-2", paymentDate: null }) as never,
    makeOrderItem({ id: "item-other", storeId: "store-1", orderSourceSignatureId: "sig-other", paymentDate: "2026-04-03" }) as never,
    makeOrderItem({ id: "item-store-2", storeId: "store-2", orderSourceSignatureId: "sig-1", paymentDate: "2026-04-04" }) as never,
  );

  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (/FROM order_source_signatures/.test(text)) {
        const ids = new Set(values?.[0] as string[]);
        const storeId = values?.[1] as string;
        return {
          rows: service.database.orderSourceSignatures
            .filter((signature: OrderSourceSignature) => ids.has(signature.id) && signature.storeId === storeId)
            .map((signature: OrderSourceSignature) => ({ id: signature.id, payload: JSON.parse(JSON.stringify(signature)) })),
          rowCount: 0,
        };
      }
      if (/FROM order_items/.test(text)) {
        const storeId = values?.[0] as string;
        const ids = new Set(values?.[1] as string[]);
        return {
          rows: service.database.orderItems
            .filter(
              (item: OrderItem) =>
                item.storeId === storeId &&
                item.orderSourceSignatureId &&
                ids.has(item.orderSourceSignatureId),
            )
            .map((item: OrderItem) => ({ id: item.id, payload: JSON.parse(JSON.stringify(item)) })),
          rowCount: 0,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  service.storageMode = "postgres";
  service.persistenceQueue = Promise.resolve();
  service.pendingWriteCount = 0;
  service.lastPersistenceError = null;
  service.pool = { connect: async () => client };
  service.persistSnapshotToPostgres = async () => {
    throw new Error("persistSnapshotToPostgres should not be called");
  };

  const result = await service.saveOrderManualMappingsCommitted({
    storeId: "store-1",
    signatureIds: ["sig-1", "sig-1", "sig-2"],
    canonicalSalesUnitId: "sales-1",
    timestamp: "2026-06-04T00:00:00.000Z",
  });

  const sqlText = queries.map((query) => query.text).join("\n");
  assert.match(sqlText, /BEGIN/);
  assert.match(sqlText, /COMMIT/);
  assert.match(sqlText, /FROM order_source_signatures/);
  assert.match(sqlText, /payload->>'storeId' = \$2/);
  assert.match(sqlText, /FROM order_items/);
  assert.match(sqlText, /payload->>'storeId' = \$1/);
  assert.match(sqlText, /payload->>'orderSourceSignatureId' = ANY\(\$2::text\[\]\)/);
  assert.match(sqlText, /UPDATE order_source_signatures AS target/);
  assert.match(sqlText, /UPDATE order_items AS target/);
  assert.match(sqlText, /payload_hash = source\.payload_hash/);
  assert.equal(/storage_metadata|INSERT INTO orders|DELETE FROM orders|loadSnapshotFromPostgres/.test(sqlText), false);
  assert.deepEqual(
    queries.find((query) => /FROM order_items/.test(query.text))?.values,
    ["store-1", ["sig-1", "sig-2"]],
  );

  const signatureUpdate = queries.find((query) => /UPDATE order_source_signatures AS target/.test(query.text));
  const updatedSignaturePayload = JSON.parse((signatureUpdate?.values as unknown[])[1] as string) as OrderSourceSignature;
  assert.equal(updatedSignaturePayload.canonicalSalesUnitId, "sales-1");
  assert.equal(updatedSignaturePayload.mappingStatus, "MAPPED");
  assert.equal((signatureUpdate?.values as unknown[])[2], hashPayload(updatedSignaturePayload));

  const itemUpdate = queries.find((query) => /UPDATE order_items AS target/.test(query.text));
  const updatedItemPayload = JSON.parse((itemUpdate?.values as unknown[])[1] as string) as OrderItem;
  assert.equal(updatedItemPayload.canonicalSalesUnitId, "sales-1");
  assert.equal(Object.prototype.hasOwnProperty.call(updatedItemPayload, "rawProductName"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updatedItemPayload, "rawOptionInfo"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updatedItemPayload, "normalizedProductName"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updatedItemPayload, "normalizedOptionInfo"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updatedItemPayload, "sourceSignature"), false);
  assert.equal((itemUpdate?.values as unknown[])[2], hashPayload(updatedItemPayload));

  assert.deepEqual(result.signatureIds, ["sig-1", "sig-2"]);
  assert.equal(result.updatedOrderItemCount, 3);
  assert.deepEqual(result.affectedDates, ["2026-04-01", "2026-04-02"]);
  assert.equal(service.database.orderSourceSignatures.find((item: OrderSourceSignature) => item.id === "sig-1")?.confirmedAt, "2026-06-04T00:00:00.000Z");
  assert.equal(service.database.orderSourceSignatures.find((item: OrderSourceSignature) => item.id === "sig-other")?.canonicalSalesUnitId, null);
  assert.equal(service.database.orderSourceSignatures.find((item: OrderSourceSignature) => item.id === "sig-store-2")?.canonicalSalesUnitId, null);
  assert.equal(service.database.orderItems.find((item: OrderItem) => item.id === "item-1")?.canonicalSalesUnitId, "sales-1");
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      service.database.orderItems.find((item: OrderItem) => item.id === "item-1"),
      "rawProductName",
    ),
    false,
  );
  assert.equal(service.database.orderItems.find((item: OrderItem) => item.id === "item-2")?.canonicalSalesUnitId, "sales-1");
  assert.equal(service.database.orderItems.find((item: OrderItem) => item.id === "item-3")?.canonicalSalesUnitId, "sales-1");
  assert.equal(service.database.orderItems.find((item: OrderItem) => item.id === "item-other")?.canonicalSalesUnitId, null);
  assert.equal(service.database.orderItems.find((item: OrderItem) => item.id === "item-store-2")?.canonicalSalesUnitId, null);
});

runAsync("DatabaseService PostgreSQL saves ad campaign mappings with row-level direct updates", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const rowWithoutSignature = createConfirmedUploadRow({
    uploadId: "upload-direct",
    reportDate: "2026-04-01",
    campaignId: "cmp-direct",
    campaignName: "direct launch",
    canonicalSalesUnitId: null,
    totalCost: 100,
  }) as AdCampaignDailyCost;
  const rowWithSignature = Object.assign(
    createConfirmedUploadRow({
      uploadId: "upload-direct-2",
      reportDate: "2026-04-02",
      campaignId: "cmp-direct",
      campaignName: "direct launch",
      canonicalSalesUnitId: null,
      totalCost: 200,
    }),
    { adCampaignSignatureId: "ad-signature-direct" },
  ) as AdCampaignDailyCost;
  const untouchedRow = Object.assign(
    createConfirmedUploadRow({
      uploadId: "upload-other",
      reportDate: "2026-04-03",
      campaignId: "cmp-other",
      campaignName: "other launch",
      canonicalSalesUnitId: null,
      totalCost: 300,
    }),
    { adCampaignSignatureId: "ad-signature-other" },
  ) as AdCampaignDailyCost;

  service.database = createEmptyDatabase();
  service.database.canonicalSalesUnits.push(createSalesUnit("sales-direct", "Direct Unit", ["direct"]));
  service.database.adCampaignSignatures.push(
    createAdCampaignSignature({
      id: "ad-signature-direct",
      campaignId: "cmp-direct",
      campaignName: "direct launch",
    }),
    createAdCampaignSignature({
      id: "ad-signature-other",
      campaignId: "cmp-other",
      campaignName: "other launch",
    }),
  );
  service.database.adCampaignDailyCosts.push(rowWithoutSignature, rowWithSignature, untouchedRow);

  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (/FROM ad_campaign_signatures/.test(text)) {
        const ids = new Set(values?.[0] as string[]);
        const storeId = values?.[1] as string;
        return {
          rows: service.database.adCampaignSignatures
            .filter((signature: AdCampaignSignature) => ids.has(signature.id) && signature.storeId === storeId)
            .map((signature: AdCampaignSignature) => ({
              id: signature.id,
              payload: JSON.parse(JSON.stringify(signature)),
            })),
          rowCount: 0,
        };
      }
      if (/FROM ad_campaign_daily_costs/.test(text) && /id = ANY\(\$1::text\[\]\)/.test(text)) {
        const ids = new Set(values?.[0] as string[]);
        const storeId = values?.[1] as string;
        return {
          rows: service.database.adCampaignDailyCosts
            .filter((row: AdCampaignDailyCost) => ids.has(row.id) && row.storeId === storeId)
            .map((row: AdCampaignDailyCost) => ({ id: row.id, payload: JSON.parse(JSON.stringify(row)) })),
          rowCount: 0,
        };
      }
      if (/FROM ad_campaign_daily_costs/.test(text) && /adCampaignSignatureId/.test(text)) {
        const storeId = values?.[0] as string;
        const signatureIds = new Set(values?.[1] as string[]);
        const targetIds = new Set(values?.[2] as string[]);
        return {
          rows: service.database.adCampaignDailyCosts
            .filter(
              (row: AdCampaignDailyCost) =>
                row.storeId === storeId &&
                ((row.adCampaignSignatureId ? signatureIds.has(row.adCampaignSignatureId) : false) ||
                  targetIds.has(row.id)),
            )
            .map((row: AdCampaignDailyCost) => ({ id: row.id, payload: JSON.parse(JSON.stringify(row)) })),
          rowCount: 0,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  service.storageMode = "postgres";
  service.persistenceQueue = Promise.resolve();
  service.pendingWriteCount = 0;
  service.lastPersistenceError = null;
  service.pool = { connect: async () => client };
  service.persistSnapshotToPostgres = async () => {
    throw new Error("persistSnapshotToPostgres should not be called");
  };

  const result = await service.saveAdCampaignMappingsCommitted({
    storeId: "store-1",
    targetIds: [rowWithoutSignature.id],
    action: {
      type: "MANUAL_MAPPED",
      canonicalSalesUnitId: "sales-direct",
      timestamp: "2026-06-04T00:00:00.000Z",
    },
  });

  const sqlText = queries.map((query) => query.text).join("\n");
  assert.match(sqlText, /BEGIN/);
  assert.match(sqlText, /COMMIT/);
  assert.match(sqlText, /FROM ad_campaign_signatures/);
  assert.match(sqlText, /FROM ad_campaign_daily_costs/);
  assert.match(sqlText, /INSERT INTO ad_campaign_signatures/);
  assert.match(sqlText, /UPDATE ad_campaign_daily_costs AS target/);
  assert.match(sqlText, /payload_hash = EXCLUDED\.payload_hash/);
  assert.match(sqlText, /payload_hash = source\.payload_hash/);
  assert.equal(/storage_metadata|INSERT INTO orders|DELETE FROM orders|loadSnapshotFromPostgres/.test(sqlText), false);

  const signatureUpsert = queries.find((query) => /INSERT INTO ad_campaign_signatures/.test(query.text));
  const updatedSignaturePayload = JSON.parse((signatureUpsert?.values as unknown[])[1] as string) as AdCampaignSignature;
  assert.equal(updatedSignaturePayload.canonicalSalesUnitId, "sales-direct");
  assert.equal(updatedSignaturePayload.mappingReason, "MANUAL_MAPPED");
  assert.equal((signatureUpsert?.values as unknown[])[2], hashPayload(updatedSignaturePayload));

  const rowUpdate = queries.find((query) => /UPDATE ad_campaign_daily_costs AS target/.test(query.text));
  const updatedRowPayload = JSON.parse((rowUpdate?.values as unknown[])[1] as string) as AdCampaignDailyCost;
  assert.equal(updatedRowPayload.adCampaignSignatureId, "ad-signature-direct");
  assert.equal(updatedRowPayload.canonicalSalesUnitId, "sales-direct");
  assert.equal((rowUpdate?.values as unknown[])[2], hashPayload(updatedRowPayload));

  assert.deepEqual(result.signatureIds, ["ad-signature-direct"]);
  assert.equal(result.updatedAdCampaignDailyCostCount, 2);
  assert.deepEqual(result.affectedDates, ["2026-04-01", "2026-04-02"]);
  assert.equal(
    service.database.adCampaignSignatures.find((item: AdCampaignSignature) => item.id === "ad-signature-direct")
      ?.canonicalSalesUnitId,
    "sales-direct",
  );
  assert.equal(
    service.database.adCampaignDailyCosts.find((item: AdCampaignDailyCost) => item.id === rowWithoutSignature.id)
      ?.adCampaignSignatureId,
    "ad-signature-direct",
  );
  assert.equal(
    service.database.adCampaignDailyCosts.find((item: AdCampaignDailyCost) => item.id === rowWithSignature.id)
      ?.canonicalSalesUnitId,
    "sales-direct",
  );
  assert.equal(
    service.database.adCampaignDailyCosts.find((item: AdCampaignDailyCost) => item.id === untouchedRow.id)
      ?.canonicalSalesUnitId,
    null,
  );
});

runAsync("DatabaseService PostgreSQL locks materialized ad signature for row-id mapping targets", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const targetRow = createConfirmedUploadRow({
    uploadId: "upload-stale",
    reportDate: "2026-04-05",
    campaignId: "cmp-stale",
    campaignName: "stale launch",
    canonicalSalesUnitId: null,
    totalCost: 100,
  }) as AdCampaignDailyCost;
  const staleMemorySignature = createAdCampaignSignature({
    id: "ad-signature-stale",
    campaignId: "cmp-stale",
    campaignName: "stale launch",
  }) as AdCampaignSignature;
  staleMemorySignature.usageCount = 1;
  staleMemorySignature.firstSeenDate = "2026-01-01";

  const dbSignature = JSON.parse(JSON.stringify(staleMemorySignature)) as AdCampaignSignature;
  dbSignature.usageCount = 9;
  dbSignature.firstSeenDate = "2026-03-01";
  dbSignature.lastSeenDate = "2026-03-10";
  dbSignature.reasonNote = "fresh database payload";

  service.database = createEmptyDatabase();
  service.database.canonicalSalesUnits.push(createSalesUnit("sales-stale", "Fresh Unit", ["stale"]));
  service.database.adCampaignSignatures.push(staleMemorySignature);
  service.database.adCampaignDailyCosts.push(targetRow);

  const dbSignatures = [dbSignature];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (/FROM ad_campaign_signatures/.test(text)) {
        const ids = new Set(values?.[0] as string[]);
        const storeId = values?.[1] as string;
        return {
          rows: dbSignatures
            .filter((signature) => ids.has(signature.id) && signature.storeId === storeId)
            .map((signature) => ({ id: signature.id, payload: JSON.parse(JSON.stringify(signature)) })),
          rowCount: 0,
        };
      }
      if (/FROM ad_campaign_daily_costs/.test(text) && /id = ANY\(\$1::text\[\]\)/.test(text)) {
        const ids = new Set(values?.[0] as string[]);
        const storeId = values?.[1] as string;
        return {
          rows: service.database.adCampaignDailyCosts
            .filter((row: AdCampaignDailyCost) => ids.has(row.id) && row.storeId === storeId)
            .map((row: AdCampaignDailyCost) => ({ id: row.id, payload: JSON.parse(JSON.stringify(row)) })),
          rowCount: 0,
        };
      }
      if (/FROM ad_campaign_daily_costs/.test(text) && /adCampaignSignatureId/.test(text)) {
        const storeId = values?.[0] as string;
        const targetIds = new Set(values?.[2] as string[]);
        return {
          rows: service.database.adCampaignDailyCosts
            .filter((row: AdCampaignDailyCost) => row.storeId === storeId && targetIds.has(row.id))
            .map((row: AdCampaignDailyCost) => ({ id: row.id, payload: JSON.parse(JSON.stringify(row)) })),
          rowCount: 0,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  service.storageMode = "postgres";
  service.persistenceQueue = Promise.resolve();
  service.pendingWriteCount = 0;
  service.lastPersistenceError = null;
  service.pool = { connect: async () => client };
  service.persistSnapshotToPostgres = async () => {
    throw new Error("persistSnapshotToPostgres should not be called");
  };

  await service.saveAdCampaignMappingsCommitted({
    storeId: "store-1",
    targetIds: [targetRow.id],
    action: {
      type: "MANUAL_MAPPED",
      canonicalSalesUnitId: "sales-stale",
      timestamp: "2026-06-04T00:00:00.000Z",
    },
  });

  const signatureSelects = queries.filter((query) => /FROM ad_campaign_signatures/.test(query.text));
  assert.equal(signatureSelects.length, 2);
  assert.deepEqual(signatureSelects[0].values, [[targetRow.id], "store-1"]);
  assert.deepEqual(signatureSelects[1].values, [["ad-signature-stale"], "store-1"]);

  const signatureUpsert = queries.find((query) => /INSERT INTO ad_campaign_signatures/.test(query.text));
  const updatedSignaturePayload = JSON.parse((signatureUpsert?.values as unknown[])[1] as string) as AdCampaignSignature;
  assert.equal(updatedSignaturePayload.canonicalSalesUnitId, "sales-stale");
  assert.equal(updatedSignaturePayload.usageCount, 10);
  assert.equal(updatedSignaturePayload.firstSeenDate, "2026-03-01");
  assert.equal(updatedSignaturePayload.lastSeenDate, "2026-04-05");
  assert.equal(
    service.database.adCampaignSignatures.find((signature: AdCampaignSignature) => signature.id === "ad-signature-stale")
      ?.usageCount,
    10,
  );
  assert.equal(
    service.database.adCampaignSignatures.find((signature: AdCampaignSignature) => signature.id === "ad-signature-stale")
      ?.lastSeenDate,
    "2026-04-05",
  );
});

runAsync("DatabaseService file mode falls back to committed order manual mapping snapshot write", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const persistedSnapshots: ReturnType<typeof createEmptyDatabase>[] = [];
  service.database = createEmptyDatabase();
  service.database.orderSourceSignatures.push(createOrderSourceSignature("sig-1", "file unit"));
  service.database.orderItems.push({
    id: "item-1",
    storeId: "store-1",
    orderSourceSignatureId: "sig-1",
    canonicalSalesUnitId: null,
    paymentDate: "2026-04-01",
    updatedAt: "before",
  } as never);
  service.storageMode = "file";
  service.persistenceQueue = Promise.resolve();
  service.pendingWriteCount = 0;
  service.lastPersistenceError = null;
  service.persistSnapshotWithStatus = async (snapshot: ReturnType<typeof createEmptyDatabase>) => {
    persistedSnapshots.push(JSON.parse(JSON.stringify(snapshot)));
  };

  const result = await service.saveOrderManualMappingsCommitted({
    storeId: "store-1",
    signatureIds: ["sig-1"],
    canonicalSalesUnitId: "sales-1",
    timestamp: "2026-06-04T00:00:00.000Z",
  });

  assert.equal(result.updatedOrderItemCount, 1);
  assert.deepEqual(result.affectedDates, ["2026-04-01"]);
  assert.equal(persistedSnapshots.length, 1);
  assert.equal(service.database.orderSourceSignatures[0].canonicalSalesUnitId, "sales-1");
  assert.equal(service.database.orderItems[0].canonicalSalesUnitId, "sales-1");
  assert.equal(persistedSnapshots[0]?.orderItems[0]?.canonicalSalesUnitId, "sales-1");
});

runAsync("DatabaseService PostgreSQL replaces only scoped daily profit summary rows", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const oldTarget = createStoredDailySalesUnitProfitForTest({
    id: "old-target",
    date: "2026-04-01",
    totalRevenue: 10,
  });
  const otherDate = createStoredDailySalesUnitProfitForTest({
    id: "other-date",
    date: "2026-04-02",
    totalRevenue: 20,
  });
  const otherStore = createStoredDailySalesUnitProfitForTest({
    id: "other-store",
    storeId: "store-2",
    date: "2026-04-01",
    totalRevenue: 30,
  });
  const newRows = [
    createStoredDailySalesUnitProfitForTest({ id: "new-1", date: "2026-04-01", totalRevenue: 100 }),
    createStoredDailySalesUnitProfitForTest({ id: "new-3", date: "2026-04-03", totalRevenue: 300 }),
  ];
  const newSummaries = [
    createStoredDailyStoreSummaryForTest({ id: "summary-new-1", date: "2026-04-01", totalRevenue: 100 }),
    createStoredDailyStoreSummaryForTest({ id: "summary-new-3", date: "2026-04-03", totalRevenue: 300 }),
  ];
  service.database = createEmptyDatabase();
  service.database.dailySalesUnitProfits.push(oldTarget, otherDate, otherStore);
  service.database.dailyStoreSummaries.push(
    createStoredDailyStoreSummaryForTest({ id: "summary-old-target", date: "2026-04-01", totalRevenue: 10 }),
    createStoredDailyStoreSummaryForTest({ id: "summary-other-date", date: "2026-04-02", totalRevenue: 20 }),
    createStoredDailyStoreSummaryForTest({
      id: "summary-other-store",
      storeId: "store-2",
      date: "2026-04-01",
      totalRevenue: 30,
    }),
  );
  service.storageMode = "postgres";
  service.persistenceQueue = Promise.resolve();
  service.pendingWriteCount = 0;
  service.lastPersistenceError = null;
  service.pool = { connect: async () => client };
  service.persistSnapshotToPostgres = async () => {
    throw new Error("persistSnapshotToPostgres should not be called");
  };

  await service.replaceDailyProfitSummariesCommitted({
    storeId: "store-1",
    dates: ["2026-04-03", "2026-04-01", "2026-04-01"],
    buildReplacement: () => ({
      dailySalesUnitProfits: newRows,
      dailyStoreSummaries: newSummaries,
      result: undefined,
    }),
  });

  const sqlText = queries.map((query) => query.text).join("\n");
  assert.match(sqlText, /BEGIN/);
  assert.match(sqlText, /DELETE FROM daily_sales_unit_profits/);
  assert.match(sqlText, /DELETE FROM daily_store_summaries/);
  assert.match(sqlText, /INSERT INTO daily_sales_unit_profits/);
  assert.match(sqlText, /INSERT INTO daily_store_summaries/);
  assert.match(sqlText, /payload_hash = EXCLUDED\.payload_hash/);
  assert.equal(/storage_metadata|INSERT INTO orders|DELETE FROM orders/.test(sqlText), false);
  assert.deepEqual(
    queries.find((query) => /DELETE FROM daily_sales_unit_profits/.test(query.text))?.values,
    ["store-1", ["2026-04-01", "2026-04-03"]],
  );

  const salesInsert = queries.find((query) => /INSERT INTO daily_sales_unit_profits/.test(query.text));
  assert.equal((salesInsert?.values as unknown[])[0], "new-1");
  assert.equal((salesInsert?.values as unknown[])[2], hashPayload(newRows[0]));

  assert.deepEqual(
    service.database.dailySalesUnitProfits.map((row: StoredDailySalesUnitProfit) => row.id).sort(),
    ["new-1", "new-3", "other-date", "other-store"],
  );
  assert.deepEqual(
    service.database.dailyStoreSummaries.map((row: StoredDailyStoreSummary) => row.id).sort(),
    ["summary-new-1", "summary-new-3", "summary-other-date", "summary-other-store"],
  );
});

runAsync("ProfitSummaryService PostgreSQL daily summary calculation waits for queued committed writes", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const date = "2026-04-09";
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  let releaseQueuedWrite!: () => void;

  service.database = createEmptyDatabase();
  service.database.stores.push(createStoreRecord("store-1", "Main Store"));
  service.database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Queued Unit", ["queued"]));
  service.storageMode = "postgres";
  service.pendingWriteCount = 0;
  service.lastPersistenceError = null;
  service.pool = { connect: async () => client };
  service.persistenceQueue = new Promise<void>((resolve) => {
    releaseQueuedWrite = () => {
      service.database.orderItems.push({
        id: "queued-order-item",
        storeId: "store-1",
        orderId: "queued-order",
        orderSourceSignatureId: null,
        canonicalSalesUnitId: "sales-1",
        externalProductOrderId: "external-queued",
        externalProductId: null,
        packageNumber: null,
        rawProductName: "queued unit",
        rawOptionInfo: null,
        normalizedProductName: normalizeText("queued unit"),
        normalizedOptionInfo: "",
        sourceSignature: createSourceSignature("queued unit", null),
        quantity: 1,
        productPaymentAmount: 100,
        totalProductAmount: 100,
        deliveryFeeAmount: 0,
        paymentCommission: 0,
        knowledgeShoppingSellingInterlockCommission: null,
        saleCommission: null,
        channelCommission: null,
        orderDate: date,
        paymentDate: date,
        saleStatus: "SALE",
        orderStatus: "DELIVERED",
        isCanceled: false,
        isReturned: false,
        rawPayload: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never);
      resolve();
    };
  });

  const summaryService = new ProfitSummaryService(service as DatabaseService);
  const refreshPromise = summaryService.recalculateStoreDates({
    storeId: "store-1",
    dateFrom: date,
    dateTo: date,
    reason: "MAPPING_CHANGE",
  });

  await Promise.resolve();
  assert.equal(queries.some((query) => /INSERT INTO daily_sales_unit_profits/.test(query.text)), false);

  releaseQueuedWrite();
  const result = await refreshPromise;
  const salesInsert = queries.find((query) => /INSERT INTO daily_sales_unit_profits/.test(query.text));
  const insertedSalesUnitRow = JSON.parse((salesInsert?.values as unknown[])[1] as string) as StoredDailySalesUnitProfit;

  assert.equal(result.data.salesUnitRowCount, 1);
  assert.equal(insertedSalesUnitRow.totalProductRevenue, 100);
  assert.equal(service.database.dailySalesUnitProfits[0].totalProductRevenue, 100);
  assert.equal(service.database.dailyStoreSummaries[0].totalProductRevenue, 100);
});

runAsync("DatabaseService file mode falls back to committed daily profit summary snapshot write", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const persistedSnapshots: ReturnType<typeof createEmptyDatabase>[] = [];
  service.database = createEmptyDatabase();
  service.database.dailySalesUnitProfits.push(
    createStoredDailySalesUnitProfitForTest({ id: "old-target", date: "2026-04-01" }),
    createStoredDailySalesUnitProfitForTest({ id: "other-date", date: "2026-04-02" }),
  );
  service.database.dailyStoreSummaries.push(
    createStoredDailyStoreSummaryForTest({ id: "summary-old-target", date: "2026-04-01" }),
    createStoredDailyStoreSummaryForTest({ id: "summary-other-date", date: "2026-04-02" }),
  );
  service.storageMode = "file";
  service.persistenceQueue = Promise.resolve();
  service.pendingWriteCount = 0;
  service.lastPersistenceError = null;
  service.persistSnapshotWithStatus = async (snapshot: ReturnType<typeof createEmptyDatabase>) => {
    persistedSnapshots.push(JSON.parse(JSON.stringify(snapshot)));
  };

  await service.replaceDailyProfitSummariesCommitted({
    storeId: "store-1",
    dates: ["2026-04-01"],
    buildReplacement: () => ({
      dailySalesUnitProfits: [createStoredDailySalesUnitProfitForTest({ id: "new-target", date: "2026-04-01" })],
      dailyStoreSummaries: [createStoredDailyStoreSummaryForTest({ id: "summary-new-target", date: "2026-04-01" })],
      result: undefined,
    }),
  });

  assert.deepEqual(
    service.database.dailySalesUnitProfits.map((row: StoredDailySalesUnitProfit) => row.id).sort(),
    ["new-target", "other-date"],
  );
  assert.equal(persistedSnapshots.length, 1);
  const persisted = persistedSnapshots[0]!;
  assert.deepEqual(
    persisted.dailyStoreSummaries.map((row: StoredDailyStoreSummary) => row.id).sort(),
    ["summary-new-target", "summary-other-date"],
  );
});

runAsync("DatabaseService PostgreSQL removes only scoped daily profit summary rows", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  service.database = createEmptyDatabase();
  service.database.dailySalesUnitProfits.push(
    createStoredDailySalesUnitProfitForTest({ id: "target", date: "2026-04-01" }),
    createStoredDailySalesUnitProfitForTest({ id: "other-date", date: "2026-04-02" }),
    createStoredDailySalesUnitProfitForTest({ id: "other-store", storeId: "store-2", date: "2026-04-01" }),
  );
  service.database.dailyStoreSummaries.push(
    createStoredDailyStoreSummaryForTest({ id: "summary-target", date: "2026-04-01" }),
    createStoredDailyStoreSummaryForTest({ id: "summary-other-date", date: "2026-04-02" }),
    createStoredDailyStoreSummaryForTest({ id: "summary-other-store", storeId: "store-2", date: "2026-04-01" }),
  );
  service.storageMode = "postgres";
  service.persistenceQueue = Promise.resolve();
  service.pendingWriteCount = 0;
  service.lastPersistenceError = null;
  service.pool = { connect: async () => client };
  service.persistSnapshotToPostgres = async () => {
    throw new Error("persistSnapshotToPostgres should not be called");
  };

  await service.removeDailyProfitSummariesCommitted({ storeId: "store-1", dates: ["2026-04-01"] });

  const sqlText = queries.map((query) => query.text).join("\n");
  assert.match(sqlText, /DELETE FROM daily_sales_unit_profits/);
  assert.match(sqlText, /DELETE FROM daily_store_summaries/);
  assert.equal(/INSERT INTO daily_sales_unit_profits|storage_metadata/.test(sqlText), false);
  assert.deepEqual(
    service.database.dailySalesUnitProfits.map((row: StoredDailySalesUnitProfit) => row.id).sort(),
    ["other-date", "other-store"],
  );
  assert.deepEqual(
    service.database.dailyStoreSummaries.map((row: StoredDailyStoreSummary) => row.id).sort(),
    ["summary-other-date", "summary-other-store"],
  );
});

runAsync("DatabaseService PostgreSQL persistence upserts rows and deletes missing ids without TRUNCATE", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  };

  await service.persistTableRowsIncrementally(
    client,
    { key: "orders", tableName: "orders" },
    [
      { id: "order-1", storeId: "store-1", externalOrderId: "ext-1", amount: 100 },
      { id: "order-2", storeId: "store-1", externalOrderId: "ext-2", amount: 200 },
    ],
  );

  const sqlText = queries.map((query) => query.text).join("\n");
  assert.equal(/TRUNCATE/i.test(sqlText), false);
  assert.match(sqlText, /INSERT INTO orders \(id, payload, payload_hash, updated_at\)/);
  assert.match(sqlText, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(sqlText, /payload_hash IS DISTINCT FROM EXCLUDED\.payload_hash/);
  assert.match(sqlText, /DELETE FROM orders/);
  assert.deepEqual(queries.at(-1)?.values, [["order-1", "order-2"]]);

  const insertValues = queries[0].values as unknown[];
  assert.equal(insertValues[0], "order-1");
  assert.equal(insertValues[2], hashPayload({ id: "order-1", storeId: "store-1", externalOrderId: "ext-1", amount: 100 }));
});

runAsync("DatabaseService PostgreSQL persistence deletes all rows for an empty table snapshot", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  };

  await service.persistTableRowsIncrementally(client, { key: "orders", tableName: "orders" }, []);

  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /DELETE FROM orders/);
  assert.equal(queries[0].values, undefined);
  assert.equal(/TRUNCATE/i.test(queries[0].text), false);
});

runAsync("DatabaseService runtime PostgreSQL persistence skips queue-owned operations table", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  service.pool = {
    connect: async () => client,
  };
  const snapshot = createEmptyDatabase();
  snapshot.stores.push({ id: "store-runtime" } as never);
  snapshot.operations.push(
    createOperationRecord({
      id: "operation-from-other-worker",
      storeId: "store-runtime",
      operationType: "ORDER_SYNC",
      status: "QUEUED",
    }),
  );

  await service.persistSnapshotToPostgres(snapshot, { includeQueueOwnedTables: false });

  const sqlText = queries.map((query) => query.text).join("\n");
  assert.match(sqlText, /INSERT INTO stores/);
  assert.equal(/INSERT INTO operations/i.test(sqlText), false);
  assert.equal(/DELETE FROM operations/i.test(sqlText), false);
});

runAsync("DatabaseService PostgreSQL persistence splits large upserts into batches", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  };
  const rows = Array.from({ length: POSTGRES_UPSERT_BATCH_SIZE + 1 }, (_, index) => ({
    id: `order-${index}`,
    storeId: "store-1",
    externalOrderId: `ext-${index}`,
  }));

  await service.persistTableRowsIncrementally(client, { key: "orders", tableName: "orders" }, rows);

  const insertQueries = queries.filter((query) => /INSERT INTO orders/.test(query.text));
  assert.equal(insertQueries.length, 2);
  assert.equal((insertQueries[0].values as unknown[]).length, POSTGRES_UPSERT_BATCH_SIZE * 3);
  assert.equal((insertQueries[1].values as unknown[]).length, 3);
});

runAsync("DatabaseService duplicate business key warnings skip unique index and create lookup fallback", async () => {
  const service = Object.create(DatabaseService.prototype) as any;
  const queries: string[] = [];
  const warningCalls: unknown[][] = [];
  const originalWarn = console.warn;
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("externalProductOrderId") && text.includes("HAVING COUNT(*) > 1")) {
        return {
          rows: [
            {
              store_id: "store-1",
              external_product_order_id: "product-order-1",
              duplicate_count: 2,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  try {
    console.warn = (...args: unknown[]) => {
      warningCalls.push(args);
    };
    const warnings = await service.warnAboutDuplicateBusinessKeys(client);
    await service.ensurePostgresIndexes(client, warnings);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].checkId, "order-items-store-external-product-order");
    assert.equal(queries.some((query) => /CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_store_external_product_order/.test(query)), false);
    assert.equal(queries.some((query) => /idx_order_items_store_external_product_order_lookup/.test(query)), true);
    assert.equal(warningCalls.length >= 2, true);
  } finally {
    console.warn = originalWarn;
  }
});

run("calculateDashboardSummary excludes conflict order revenue and conflict ad cost from totals", () => {
  const database = createEmptyDatabase();
  const date = "2026-04-01";

  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Diet Socks", ["dietsocks"]));
  database.salesUnitCostSnapshots.push({
    id: "snapshot-1",
    storeId: "store-1",
    effectiveFrom: date,
    sourceFileName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.salesUnitCostSnapshotEntries.push({
    id: "cost-1",
    snapshotId: "snapshot-1",
    storeId: "store-1",
    canonicalSalesUnitId: "sales-1",
    unitCost: 10,
    feeRate: 0.1,
    otherCost: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.orderSourceSignatures.push(
    {
      id: "sig-mapped",
      storeId: "store-1",
      sourceSignature: createSourceSignature("diet socks", null),
      rawProductNameSnapshot: "diet socks",
      rawOptionInfoSnapshot: null,
      normalizedProductName: normalizeText("diet socks"),
      normalizedOptionInfo: "",
      canonicalSalesUnitId: "sales-1",
      mappingStatus: "MAPPED",
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    {
      id: "sig-conflict",
      storeId: "store-1",
      sourceSignature: createSourceSignature("diet", null),
      rawProductNameSnapshot: "diet",
      rawOptionInfoSnapshot: null,
      normalizedProductName: normalizeText("diet"),
      normalizedOptionInfo: "",
      canonicalSalesUnitId: null,
      mappingStatus: "CONFLICT",
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  );
  database.orderItems.push(
    {
      id: "order-1",
      storeId: "store-1",
      orderId: "record-1",
      orderSourceSignatureId: "sig-mapped",
      canonicalSalesUnitId: "sales-1",
      externalProductOrderId: "external-1",
      externalProductId: null,
      packageNumber: null,
      rawProductName: "diet socks",
      rawOptionInfo: null,
      normalizedProductName: normalizeText("diet socks"),
      normalizedOptionInfo: "",
      sourceSignature: createSourceSignature("diet socks", null),
      quantity: 1,
      productPaymentAmount: 100,
      totalProductAmount: null,
      deliveryFeeAmount: 12,
      paymentCommission: null,
      knowledgeShoppingSellingInterlockCommission: null,
      saleCommission: null,
      channelCommission: null,
      orderDate: date,
      paymentDate: date,
      saleStatus: "SALE",
      orderStatus: "DELIVERED",
      isCanceled: false,
      isReturned: false,
      rawPayload: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    {
      id: "order-2",
      storeId: "store-1",
      orderId: "record-2",
      orderSourceSignatureId: "sig-conflict",
      canonicalSalesUnitId: null,
      externalProductOrderId: "external-2",
      externalProductId: null,
      packageNumber: null,
      rawProductName: "diet",
      rawOptionInfo: null,
      normalizedProductName: normalizeText("diet"),
      normalizedOptionInfo: "",
      sourceSignature: createSourceSignature("diet", null),
      quantity: 1,
      productPaymentAmount: 50,
      totalProductAmount: null,
      deliveryFeeAmount: 30,
      paymentCommission: null,
      knowledgeShoppingSellingInterlockCommission: null,
      saleCommission: null,
      channelCommission: null,
      orderDate: date,
      paymentDate: date,
      saleStatus: "SALE",
      orderStatus: "DELIVERED",
      isCanceled: false,
      isReturned: false,
      rawPayload: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  );
  database.adExcelUploads.push({
    id: "upload-1",
    storeId: "store-1",
    isActive: true,
    weekdayValidationStatus: "PASSED",
    state: "CONFIRMED",
  } as never);
  database.adCampaignDailyCosts.push(
    {
      id: "ad-1",
      storeId: "store-1",
      sourceUploadId: "upload-1",
      reportDate: date,
      campaignName: "diet socks launch",
      normalizedCampaignName: normalizeText("diet socks launch"),
      totalCost: 20,
      canonicalSalesUnitId: "sales-1",
      mappingReason: "RULE_MATCHED",
      matchedRuleCount: 1,
      reasonNote: null,
      reasonNoteInherited: false,
    } as never,
    {
      id: "ad-2",
      storeId: "store-1",
      sourceUploadId: "upload-1",
      reportDate: date,
      campaignName: "diet launch",
      normalizedCampaignName: normalizeText("diet launch"),
      totalCost: 30,
      canonicalSalesUnitId: null,
      mappingReason: "MULTIPLE_RULES",
      matchedRuleCount: 2,
      reasonNote: null,
      reasonNoteInherited: false,
    } as never,
  );

  const summary = calculateDashboardSummary(database, "store-1", date);

  assert.equal(summary.totalRevenue, 100);
  assert.equal(summary.totalProductRevenue, 100);
  assert.equal(summary.totalDeliveryFeeAmount, 12);
  assert.equal(summary.totalAdCost, 20);
  assert.equal(summary.conflictOrderItemCount, 1);
  assert.equal(summary.excludedConflictOrderRevenue, 50);
  assert.equal(summary.conflictCampaignCount, 1);
  assert.equal(summary.excludedConflictAdCost, 30);
});

run("profit rows keep delivery fee separate from product revenue and net profit", () => {
  const database = createEmptyDatabase();
  const date = "2026-04-02";

  database.stores.push(createStoreRecord("store-1", "Main Store"));
  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Diet Socks", ["dietsocks"]));
  database.salesUnitCostSnapshots.push({
    id: "snapshot-delivery-profit",
    storeId: "store-1",
    effectiveFrom: date,
    sourceFileName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.salesUnitCostSnapshotEntries.push({
    id: "cost-1",
    snapshotId: "snapshot-delivery-profit",
    storeId: "store-1",
    canonicalSalesUnitId: "sales-1",
    unitCost: 10,
    feeRate: 0.1,
    otherCost: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.orderSourceSignatures.push({
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: createSourceSignature("diet socks", null),
    rawProductNameSnapshot: "diet socks",
    rawOptionInfoSnapshot: null,
    normalizedProductName: normalizeText("diet socks"),
    normalizedOptionInfo: "",
    canonicalSalesUnitId: "sales-1",
    mappingStatus: "MAPPED",
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.orderItems.push({
    id: "order-1",
    storeId: "store-1",
    orderId: "record-1",
    orderSourceSignatureId: "sig-1",
    canonicalSalesUnitId: "sales-1",
    externalProductOrderId: "external-1",
    externalProductId: null,
    packageNumber: null,
    rawProductName: "diet socks",
    rawOptionInfo: null,
    normalizedProductName: normalizeText("diet socks"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("diet socks", null),
    quantity: 1,
    productPaymentAmount: 100,
    totalProductAmount: 100,
    deliveryFeeAmount: 20,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: date,
    paymentDate: date,
    saleStatus: "SALE",
    orderStatus: "DELIVERED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);

  const rows = calculateDailyProfitRows(database, "store-1", date, date);
  const summary = calculateDashboardSummary(database, "store-1", date);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalRevenue, 100);
  assert.equal(rows[0].totalProductRevenue, 100);
  assert.equal(rows[0].totalDeliveryFeeAmount, 20);
  assert.equal(rows[0].roughProfit, 100);
  assert.equal(rows[0].vatAmount, 10);
  assert.equal(rows[0].vatAdjustedRevenue, 90);
  assert.equal(rows[0].estimatedNetProfit, 65);
  assert.equal(summary.totalRevenue, 100);
  assert.equal(summary.totalProductRevenue, 100);
  assert.equal(summary.totalDeliveryFeeAmount, 20);
  assert.equal(summary.roughProfit, 100);
  assert.equal(summary.totalVatAmount, 10);
  assert.equal(summary.totalVatAdjustedRevenue, 90);
  assert.equal(summary.estimatedNetProfit, -3415);
  assert.equal(summary.uniquePackageCount, 1);
  assert.equal(summary.deliveryUnitCost, 3500);
  assert.equal(summary.deliveryMargin, -3480);
});

run("createEmptyDatabase includes daily profit summary collections", () => {
  const database = createEmptyDatabase();

  assert.deepEqual(database.dailySalesUnitProfits, []);
  assert.deepEqual(database.dailyStoreSummaries, []);
});

run("ProfitService Excel export shows total ad cost and sales quantity above the detail table", () => {
  const database = createEmptyDatabase();
  const date = "2026-04-02";
  database.dailySalesUnitProfits.push(
    createStoredDailySalesUnitProfitForTest({
      id: "group-profit",
      date,
      canonicalSalesUnitId: "group-1",
      displayName: "Group Unit",
      totalQuantity: 5,
      totalAdCost: 100,
      isGroup: true,
      childRows: [
        createStoredDailySalesUnitProfitForTest({
          id: "child-profit-1",
          date,
          canonicalSalesUnitId: "child-1",
          totalQuantity: 2,
          totalAdCost: 40,
          parentSalesUnitId: "group-1",
        }),
        createStoredDailySalesUnitProfitForTest({
          id: "child-profit-2",
          date,
          canonicalSalesUnitId: "child-2",
          totalQuantity: 3,
          totalAdCost: 60,
          parentSalesUnitId: "group-1",
        }),
      ],
    }),
    createStoredDailySalesUnitProfitForTest({
      id: "standalone-profit",
      date,
      canonicalSalesUnitId: "standalone-1",
      totalQuantity: 4,
      totalAdCost: 20,
    }),
    createStoredDailySalesUnitProfitForTest({
      id: "store-level-profit",
      date,
      canonicalSalesUnitId: "store-level",
      totalQuantity: 99,
      totalAdCost: 30,
      isStoreLevel: true,
    }),
  );
  database.dailyStoreSummaries.push(
    createStoredDailyStoreSummaryForTest({ date, totalAdCost: 150 }),
  );
  const databaseService = createMemoryDatabaseService(database);
  const profitService = new ProfitService(
    databaseService as never,
    new ProfitSummaryService(databaseService as never),
  );

  const buffer = profitService.exportDailySalesUnitsExcel({
    storeId: "store-1",
    dateFrom: date,
    dateTo: date,
  });
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets.DailyProfitRows;

  assert.equal(sheet.A1?.v, "전체 광고비");
  assert.equal(sheet.B1?.v, 150);
  assert.equal(sheet.C1?.v, "전체 판매수");
  assert.equal(sheet.D1?.v, 9);
  assert.equal(sheet.A2, undefined);
  assert.equal(sheet.A3?.v, "일자");
});

runAsync("ProfitSummaryService skips committed writes for empty date refresh", async () => {
  const database = createEmptyDatabase();
  database.stores.push(createStoreRecord("store-1", "Main Store"));
  const databaseService = createMemoryDatabaseService(database);
  const summaryService = new ProfitSummaryService(databaseService as never);

  const result = await summaryService.refreshStoreDateListBestEffort({
    storeId: "store-1",
    dates: [],
    reason: "MAPPING_CHANGE",
  });

  assert.deepEqual(result, {
    recalculatedDateCount: 0,
    salesUnitRowCount: 0,
    storeSummaryRowCount: 0,
    reason: "MAPPING_CHANGE",
  });
  assert.equal(databaseService.writeCommittedCalls, 0);
});

runAsync("ProfitSummaryService uses PostgreSQL daily summary direct replace path", async () => {
  const database = createEmptyDatabase();
  const date = "2026-04-08";
  database.stores.push(createStoreRecord("store-1", "Main Store"));
  const databaseService = createMemoryDatabaseService(database);
  databaseService.storageMode = "postgres";
  databaseService.writeCommitted = async () => {
    throw new Error("writeCommitted should not be used in PostgreSQL daily summary recalculation");
  };
  const summaryService = new ProfitSummaryService(databaseService as never);

  const result = await summaryService.recalculateStoreDates({
    storeId: "store-1",
    dateFrom: date,
    dateTo: date,
    reason: "MAPPING_CHANGE",
  });

  assert.equal(result.data.recalculatedDateCount, 1);
  assert.equal(result.data.salesUnitRowCount, 0);
  assert.equal(result.data.storeSummaryRowCount, 1);
  assert.equal(databaseService.replaceDailyProfitSummariesCommittedCalls, 1);
  assert.equal(databaseService.writeCommittedCalls, 0);
  assert.equal(databaseService.getSnapshot().dailyStoreSummaries[0].date, date);
});

runAsync("ProfitSummaryService invalidates PostgreSQL daily summaries with scoped direct remove path", async () => {
  const database = createEmptyDatabase();
  database.stores.push(createStoreRecord("store-1", "Main Store"));
  database.dailySalesUnitProfits.push(
    createStoredDailySalesUnitProfitForTest({ id: "target", date: "2026-04-01" }),
    createStoredDailySalesUnitProfitForTest({ id: "other-date", date: "2026-04-02" }),
  );
  database.dailyStoreSummaries.push(
    createStoredDailyStoreSummaryForTest({ id: "summary-target", date: "2026-04-01" }),
    createStoredDailyStoreSummaryForTest({ id: "summary-other-date", date: "2026-04-02" }),
  );
  const databaseService = createMemoryDatabaseService(database);
  databaseService.storageMode = "postgres";
  databaseService.replaceDailyProfitSummariesCommitted = async () => {
    throw new Error("forced recalculation failure");
  };
  const summaryService = new ProfitSummaryService(databaseService as never);

  const result = await summaryService.refreshStoreDateListBestEffort({
    storeId: "store-1",
    dates: ["2026-04-01"],
    reason: "MAPPING_CHANGE",
  });
  const snapshot = databaseService.getSnapshot();

  assert.equal(result, null);
  assert.equal(databaseService.removeDailyProfitSummariesCommittedCalls, 1);
  assert.deepEqual(
    snapshot.dailySalesUnitProfits.map((row: StoredDailySalesUnitProfit) => row.id),
    ["other-date"],
  );
  assert.deepEqual(
    snapshot.dailyStoreSummaries.map((row: StoredDailyStoreSummary) => row.id),
    ["summary-other-date"],
  );
});

runAsync("ProfitSummaryService stores calculation rows and ProfitService prefers them", async () => {
  const database = createEmptyDatabase();
  const date = "2026-04-02";

  database.stores.push(createStoreRecord("store-1", "Main Store"));
  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Diet Socks", ["dietsocks"]));
  database.salesUnitCostSnapshots.push({
    id: "snapshot-summary-profit",
    storeId: "store-1",
    effectiveFrom: date,
    sourceFileName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.salesUnitCostSnapshotEntries.push({
    id: "cost-summary-profit",
    snapshotId: "snapshot-summary-profit",
    storeId: "store-1",
    canonicalSalesUnitId: "sales-1",
    unitCost: 10,
    feeRate: 0.1,
    otherCost: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.orderItems.push({
    id: "order-summary-profit",
    storeId: "store-1",
    orderId: "record-summary-profit",
    orderSourceSignatureId: null,
    canonicalSalesUnitId: "sales-1",
    externalProductOrderId: "external-summary-profit",
    externalProductId: null,
    packageNumber: null,
    rawProductName: "diet socks",
    rawOptionInfo: null,
    normalizedProductName: normalizeText("diet socks"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("diet socks", null),
    quantity: 1,
    productPaymentAmount: 100,
    totalProductAmount: 100,
    deliveryFeeAmount: 20,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: date,
    paymentDate: date,
    saleStatus: "SALE",
    orderStatus: "DELIVERED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);

  const databaseService = createMemoryDatabaseService(database);
  const summaryService = new ProfitSummaryService(databaseService as never);
  const profitService = new ProfitService(databaseService as never, summaryService);

  await summaryService.recalculateStoreDates({
    storeId: "store-1",
    dateFrom: date,
    dateTo: date,
    reason: "MANUAL",
  });

  databaseService.write((draft) => {
    draft.orderItems = [];
  });

  const rows = profitService.listDailySalesUnits({
    storeId: "store-1",
    dateFrom: date,
    dateTo: date,
  }).data.items;
  const summary = profitService.getDashboardSummary("store-1", date).data;

  assert.equal(databaseService.getSnapshot().dailySalesUnitProfits.length, 1);
  assert.equal(databaseService.getSnapshot().dailyStoreSummaries.length, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalProductRevenue, 100);
  assert.equal(summary.totalProductRevenue, 100);
});

runAsync("ProfitService uses stored child rows for group child detail", async () => {
  const database = createEmptyDatabase();
  const date = "2026-04-06";

  database.stores.push(createStoreRecord("store-1", "Main Store"));
  database.canonicalSalesUnits.push(
    Object.assign(createSalesUnit("group-1", "Group Unit", []) as Record<string, unknown>, {
      isGroup: true,
      parentSalesUnitId: null,
    }) as never,
    Object.assign(createSalesUnit("sales-child", "Child Unit", ["child unit"]) as Record<string, unknown>, {
      parentSalesUnitId: "group-1",
      isGroup: false,
    }) as never,
  );
  database.salesUnitCostSnapshots.push({
    id: "snapshot-child-summary",
    storeId: "store-1",
    effectiveFrom: date,
    sourceFileName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.salesUnitCostSnapshotEntries.push({
    id: "cost-child-summary",
    snapshotId: "snapshot-child-summary",
    storeId: "store-1",
    canonicalSalesUnitId: "sales-child",
    unitCost: 10,
    feeRate: 0,
    otherCost: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.orderItems.push({
    id: "order-child-summary",
    storeId: "store-1",
    orderId: "record-child-summary",
    orderSourceSignatureId: null,
    canonicalSalesUnitId: "sales-child",
    externalProductOrderId: "external-child-summary",
    externalProductId: null,
    packageNumber: null,
    rawProductName: "child unit",
    rawOptionInfo: null,
    normalizedProductName: normalizeText("child unit"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("child unit", null),
    quantity: 2,
    productPaymentAmount: 200,
    totalProductAmount: 200,
    deliveryFeeAmount: 0,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: date,
    paymentDate: date,
    saleStatus: "SALE",
    orderStatus: "DELIVERED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);

  const databaseService = createMemoryDatabaseService(database);
  const summaryService = new ProfitSummaryService(databaseService as never);
  const profitService = new ProfitService(databaseService as never, summaryService);

  await summaryService.recalculateStoreDates({
    storeId: "store-1",
    dateFrom: date,
    dateTo: date,
    reason: "MANUAL",
  });

  const detail = profitService.getDailySalesUnitDetail("store-1", "sales-child", date).data;

  assert.equal(detail.summary.canonicalSalesUnitId, "sales-child");
  assert.equal(detail.summary.displayName, "Child Unit");
  assert.equal(detail.summary.totalProductRevenue, 200);
});

runAsync("SalesUnitService refreshes stored summaries after grouping changes", async () => {
  const database = createEmptyDatabase();
  const date = "2026-04-07";

  database.stores.push(createStoreRecord("store-1", "Main Store"));
  database.canonicalSalesUnits.push(createSalesUnit("sales-child", "Child Unit", ["child unit"]));
  database.salesUnitCostSnapshots.push({
    id: "snapshot-sales-unit-refresh",
    storeId: "store-1",
    effectiveFrom: date,
    sourceFileName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.salesUnitCostSnapshotEntries.push({
    id: "cost-sales-unit-refresh",
    snapshotId: "snapshot-sales-unit-refresh",
    storeId: "store-1",
    canonicalSalesUnitId: "sales-child",
    unitCost: 10,
    feeRate: 0,
    otherCost: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.orderItems.push({
    id: "order-sales-unit-refresh",
    storeId: "store-1",
    orderId: "record-sales-unit-refresh",
    orderSourceSignatureId: null,
    canonicalSalesUnitId: "sales-child",
    externalProductOrderId: "external-sales-unit-refresh",
    externalProductId: null,
    packageNumber: null,
    rawProductName: "child unit",
    rawOptionInfo: null,
    normalizedProductName: normalizeText("child unit"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("child unit", null),
    quantity: 1,
    productPaymentAmount: 100,
    totalProductAmount: 100,
    deliveryFeeAmount: 0,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: date,
    paymentDate: date,
    saleStatus: "SALE",
    orderStatus: "DELIVERED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);

  const databaseService = createMemoryDatabaseService(database);
  const summaryService = new ProfitSummaryService(databaseService as never);
  const salesUnitService = new SalesUnitService(
    databaseService as never,
    { ensureWritable: () => undefined } as never,
    createAuditLogServiceDouble() as never,
    summaryService,
  );

  await summaryService.recalculateStoreDates({
    storeId: "store-1",
    dateFrom: date,
    dateTo: date,
    reason: "MANUAL",
  });
  assert.equal(databaseService.getSnapshot().dailySalesUnitProfits[0].canonicalSalesUnitId, "sales-child");

  await salesUnitService.createSalesUnitGroup("store-1", "Group Unit", ["sales-child"]);

  const storedRow = databaseService.getSnapshot().dailySalesUnitProfits[0];
  assert.equal(storedRow.canonicalSalesUnitId === "sales-child", false);
  assert.equal(storedRow.childRows?.[0]?.canonicalSalesUnitId, "sales-child");
});

runAsync("OrderSyncService recalculates daily profit summaries after successful sync", async () => {
  const date = "2026-04-05";
  const { databaseService, orderSyncService } = createOrderSyncServiceHarness({
    stores: [createStoreRecord("store-1", "Main Store")],
    configuredStoreIds: ["store-1"],
    withProfitSummaryService: true,
    liveOrderItems: [
      createSyncedOrderItemInput({
        externalOrderId: "summary-sync-order",
        externalProductOrderId: "summary-sync-item",
        date,
        rawProductName: "Summary Product",
        productPaymentAmount: 100,
        deliveryFeeAmount: 0,
        paymentCommission: 0,
      }),
    ],
  });

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Summary Product", ["Summary Product"]));
    draft.salesUnitCostSnapshots.push({
      id: "snapshot-order-summary",
      storeId: "store-1",
      effectiveFrom: date,
      sourceFileName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    draft.salesUnitCostSnapshotEntries.push({
      id: "cost-order-summary",
      snapshotId: "snapshot-order-summary",
      storeId: "store-1",
      canonicalSalesUnitId: "sales-1",
      unitCost: 0,
      feeRate: 0,
      otherCost: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
  });

  const result = await orderSyncService.performSync("store-1", date, date, "MANUAL");
  const snapshot = databaseService.getSnapshot();

  assert.equal(snapshot.dailyStoreSummaries.length, 1);
  assert.equal(snapshot.dailySalesUnitProfits.length, 1);
  assert.equal(snapshot.dailySalesUnitProfits[0].totalProductRevenue, 100);
  assert.equal(result.summaryRecalculation?.recalculatedDateCount, 1);
});

runAsync("AdsService recalculates daily profit summaries after confirmed upload changes", async () => {
  const { databaseService, adsService } = createAdsServiceHarness({ withProfitSummaryService: true });
  const date = "2026-04-03";

  databaseService.write((draft) => {
    draft.stores.push(createStoreRecord("store-1", "Main Store"));
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
  });

  await adsService.previewUpload(
    "store-1",
    date,
    createAdUploadFile(date, [{ campaignId: "cmp-summary", campaignName: "alpha launch", totalCost: 120 }]),
  );

  let snapshot = databaseService.getSnapshot();
  assert.equal(snapshot.dailyStoreSummaries.length, 1);
  assert.equal(snapshot.dailyStoreSummaries[0].totalAdCost, 120);
  assert.equal(snapshot.dailySalesUnitProfits.length, 1);
  assert.equal(snapshot.dailySalesUnitProfits[0].totalAdCost, 120);

  await adsService.deleteUpload(snapshot.adExcelUploads[0].id);

  snapshot = databaseService.getSnapshot();
  assert.equal(snapshot.dailyStoreSummaries.length, 1);
  assert.equal(snapshot.dailyStoreSummaries[0].totalAdCost, 0);
  assert.equal(snapshot.dailySalesUnitProfits.length, 0);
});

runAsync("AdsService confirms two same-date uploads and sums ad cost across active confirmed uploads", async () => {
  const { databaseService, adsService } = createAdsServiceHarness();
  const date = "2026-04-03";

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha", "beta"]));
  });

  await adsService.previewUpload(
    "store-1",
    date,
    createAdUploadFile(date, [{ campaignId: "cmp-1001", campaignName: "alpha launch", totalCost: 120 }]),
  );

  await adsService.previewUpload(
    "store-1",
    date,
    createAdUploadFile(date, [{ campaignId: "cmp-1002", campaignName: "beta launch", totalCost: 80 }]),
  );

  const snapshot = databaseService.getSnapshot();
  const activeConfirmedUploads = snapshot.adExcelUploads.filter(
    (item: { reportDate: string; isActive: boolean; state: string }) =>
      item.reportDate === date && item.isActive && item.state === "CONFIRMED",
  );
  const summary = calculateDashboardSummary(snapshot, "store-1", date);

  assert.equal(activeConfirmedUploads.length, 2);
  assert.equal(summary.totalAdCost, 200);
});

runAsync("AdsService rejects preview when campaignId overlaps an active confirmed upload on the same date", async () => {
  const { databaseService, adsService } = createAdsServiceHarness();
  const date = "2026-04-03";

  databaseService.write((draft) => {
    draft.adExcelUploads.push(createConfirmedUpload({ uploadId: "upload-existing", reportDate: date }));
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-existing",
        reportDate: date,
        campaignId: "cmp-dup",
        campaignName: "alpha launch",
        canonicalSalesUnitId: "sales-1",
        totalCost: 55,
      }),
    );
  });

  await assert.rejects(
    () =>
      adsService.previewUpload(
        "store-1",
        date,
        createAdUploadFile(date, [{ campaignId: "cmp-dup", campaignName: "beta launch", totalCost: 30 }]),
      ),
    (error: unknown) =>
      error instanceof Error &&
      "getResponse" in error &&
      JSON.stringify((error as { getResponse: () => unknown }).getResponse()).includes(
        "AD_UPLOAD_DUPLICATE_WITH_ACTIVE_UPLOAD",
      ),
  );
});

runAsync("AdsService rejects preview when the new file contains duplicate campaignIds", async () => {
  const { adsService } = createAdsServiceHarness();
  const date = "2026-04-03";

  await assert.rejects(
    () =>
      adsService.previewUpload(
        "store-1",
        date,
        createAdUploadFile(date, [
          { campaignId: "cmp-dup", campaignName: "alpha launch", totalCost: 30 },
          { campaignId: "cmp-dup", campaignName: "beta launch", totalCost: 40 },
        ]),
      ),
    (error: unknown) =>
      error instanceof Error &&
      "getResponse" in error &&
      JSON.stringify((error as { getResponse: () => unknown }).getResponse()).includes("AD_UPLOAD_DUPLICATE_IN_FILE"),
  );
});

run("ProfitService detail and summary include only active confirmed uploads", () => {
  const databaseService = createMemoryDatabaseService();
  const profitService = new ProfitService(databaseService as never);
  const date = "2026-04-03";

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.adExcelUploads.push(
      createConfirmedUpload({ uploadId: "upload-active", reportDate: date, isActive: true }),
      createConfirmedUpload({ uploadId: "upload-inactive", reportDate: date, isActive: false }),
    );
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-active",
        reportDate: date,
        campaignId: "cmp-1001",
        campaignName: "alpha launch",
        canonicalSalesUnitId: "sales-1",
        totalCost: 20,
      }),
      createConfirmedUploadRow({
        uploadId: "upload-inactive",
        reportDate: date,
        campaignId: "cmp-1002",
        campaignName: "alpha old",
        canonicalSalesUnitId: "sales-1",
        totalCost: 999,
      }),
    );
  });

  const summary = calculateDashboardSummary(databaseService.getSnapshot(), "store-1", date);
  const detail = profitService.getDailySalesUnitDetail("store-1", "sales-1", date);

  assert.equal(summary.totalAdCost, 20);
  assert.equal(detail.data.summary.totalAdCost, 20);
  assert.equal(detail.data.deliveryContext.uniquePackageCount, 0);
  assert.equal(detail.data.deliveryContext.customerPaidDeliveryFee, 0);
  assert.equal(detail.data.deliveryContext.includedInThisSalesUnitNetProfit, false);
  assert.equal(detail.data.adCampaigns.length, 1);
  assert.equal(detail.data.adCampaigns[0].adCostId, "ad-upload-active-cmp-1001");
});

run("ProfitService keeps delivery fee references separate from product revenue and net profit", () => {
  const databaseService = createMemoryDatabaseService();
  const profitService = new ProfitService(databaseService as never);
  const date = "2026-04-02";

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.salesUnitCostSnapshots.push({
      id: "snapshot-profit-service",
      storeId: "store-1",
      effectiveFrom: date,
      sourceFileName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    draft.salesUnitCostSnapshotEntries.push({
      id: "cost-1",
      snapshotId: "snapshot-profit-service",
      storeId: "store-1",
      canonicalSalesUnitId: "sales-1",
      unitCost: 0,
      feeRate: 0,
      otherCost: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    draft.orderItems.push({
      id: "order-item-1",
      storeId: "store-1",
      orderId: "record-1",
      orderSourceSignatureId: null,
      canonicalSalesUnitId: "sales-1",
      externalProductOrderId: "external-1",
      externalProductId: null,
      packageNumber: null,
      rawProductName: "alpha",
      rawOptionInfo: null,
      normalizedProductName: normalizeText("alpha"),
      normalizedOptionInfo: "",
      sourceSignature: createSourceSignature("alpha", null),
      quantity: 1,
      productPaymentAmount: 100,
      totalProductAmount: 100,
      deliveryFeeAmount: 30,
      paymentCommission: 0,
      knowledgeShoppingSellingInterlockCommission: 0,
      saleCommission: 0,
      channelCommission: 0,
      orderDate: date,
      paymentDate: date,
      saleStatus: "SALE",
      orderStatus: "DELIVERED",
      isCanceled: false,
      isReturned: false,
      rawPayload: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
  });

  const summary = calculateDashboardSummary(databaseService.getSnapshot(), "store-1", date);
  const detail = profitService.getDailySalesUnitDetail("store-1", "sales-1", date);

  assert.equal(summary.totalRevenue, 100);
  assert.equal(summary.totalProductRevenue, 100);
  assert.equal(summary.totalDeliveryFeeAmount, 30);
  assert.equal(summary.roughProfit, 100);
  assert.equal(summary.totalVatAmount, 10);
  assert.equal(summary.totalVatAdjustedRevenue, 90);
  assert.equal(summary.estimatedNetProfit, -3380);
  assert.equal(detail.data.summary.totalRevenue, 100);
  assert.equal(detail.data.summary.totalProductRevenue, 100);
  assert.equal(detail.data.summary.totalDeliveryFeeAmount, 30);
  assert.equal(detail.data.revenueBreakdown.productRevenueOriginal, 100);
  assert.equal(detail.data.revenueBreakdown.vatAmount, 10);
  assert.equal(detail.data.revenueBreakdown.vatAdjustedRevenue, 90);
  assert.equal(detail.data.deliveryContext.uniquePackageCount, 1);
  assert.equal(detail.data.deliveryContext.deliveryMargin, -3470);
  assert.equal(detail.data.deliveryContext.includedInThisSalesUnitNetProfit, false);
});

run("ProfitService latest activity date prefers latest overlap even over later eligible orders and ads", () => {
  const databaseService = createMemoryDatabaseService();
  const profitService = new ProfitService(databaseService as never);

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.orderItems.push({
      id: "order-overlap",
      storeId: "store-1",
      paymentDate: "2026-04-04",
      saleStatus: "SALE",
      canonicalSalesUnitId: "sales-1",
    } as never);
    draft.orderItems.push({
      id: "order-latest-eligible",
      storeId: "store-1",
      paymentDate: "2026-04-05",
      saleStatus: "SALE",
      canonicalSalesUnitId: "sales-1",
    } as never);
    draft.adExcelUploads.push(
      createConfirmedUpload({ uploadId: "upload-overlap", reportDate: "2026-04-04" }),
      createConfirmedUpload({ uploadId: "upload-latest-ad", reportDate: "2026-04-06" }),
    );
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-overlap",
        reportDate: "2026-04-04",
        campaignId: "cmp-overlap",
        campaignName: "overlap campaign",
        canonicalSalesUnitId: "sales-1",
        totalCost: 10,
      }),
      createConfirmedUploadRow({
        uploadId: "upload-latest-ad",
        reportDate: "2026-04-06",
        campaignId: "cmp-latest-ad",
        campaignName: "latest ad campaign",
        canonicalSalesUnitId: "sales-1",
        totalCost: 10,
      }),
    );
  });

  const latestDate = profitService.getLatestActivityDate("store-1");
  assert.equal(latestDate.data.latestOrderDate, "2026-04-05");
  assert.equal(latestDate.data.latestAdDate, "2026-04-06");
  assert.equal(latestDate.data.latestOverlapDate, "2026-04-04");
  assert.equal(latestDate.data.date, "2026-04-04");
});

run("ProfitService latest activity date ignores ineligible latest orders and falls back to the latest eligible order", () => {
  const databaseService = createMemoryDatabaseService();
  const profitService = new ProfitService(databaseService as never);

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.orderItems.push(
      {
        id: "order-eligible",
        storeId: "store-1",
        paymentDate: "2026-04-03",
        saleStatus: "SALE",
        canonicalSalesUnitId: "sales-1",
      } as never,
      {
        id: "order-canceled",
        storeId: "store-1",
        paymentDate: "2026-04-06",
        saleStatus: "CANCELED",
        canonicalSalesUnitId: "sales-1",
      } as never,
      {
        id: "order-unmapped",
        storeId: "store-1",
        paymentDate: "2026-04-05",
        saleStatus: "SALE",
        canonicalSalesUnitId: null,
      } as never,
    );
    draft.adExcelUploads.push(createConfirmedUpload({ uploadId: "upload-no-overlap", reportDate: "2026-04-04" }));
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-no-overlap",
        reportDate: "2026-04-04",
        campaignId: "cmp-no-overlap",
        campaignName: "no overlap campaign",
        canonicalSalesUnitId: "sales-1",
        totalCost: 25,
      }),
    );
  });

  const latestDate = profitService.getLatestActivityDate("store-1");
  assert.equal(latestDate.data.latestOrderDate, "2026-04-03");
  assert.equal(latestDate.data.latestAdDate, "2026-04-04");
  assert.equal(latestDate.data.latestOverlapDate, null);
  assert.equal(latestDate.data.date, "2026-04-03");
});

run("ProfitService latest activity date falls back to the latest ad date when no eligible orders exist", () => {
  const databaseService = createMemoryDatabaseService();
  const profitService = new ProfitService(databaseService as never);

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.orderItems.push(
      {
        id: "order-canceled-only",
        storeId: "store-1",
        paymentDate: "2026-04-05",
        saleStatus: "CANCELED",
        canonicalSalesUnitId: "sales-1",
      } as never,
      {
        id: "order-without-sales-unit-only",
        storeId: "store-1",
        paymentDate: "2026-04-04",
        saleStatus: "SALE",
        canonicalSalesUnitId: null,
      } as never,
    );
    draft.adExcelUploads.push(createConfirmedUpload({ uploadId: "upload-ad-only", reportDate: "2026-04-06" }));
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-ad-only",
        reportDate: "2026-04-06",
        campaignId: "cmp-ad-only",
        campaignName: "ad only campaign",
        canonicalSalesUnitId: "sales-1",
        totalCost: 30,
      }),
    );
  });

  const latestDate = profitService.getLatestActivityDate("store-1");
  assert.equal(latestDate.data.latestOrderDate, null);
  assert.equal(latestDate.data.latestAdDate, "2026-04-06");
  assert.equal(latestDate.data.latestOverlapDate, null);
  assert.equal(latestDate.data.date, "2026-04-06");
});

runAsync("AdsService deleteUpload deactivates the upload and removes related ad rows", async () => {
  const { databaseService, adsService } = createAdsServiceHarness();
  const date = "2026-04-03";

  databaseService.write((draft) => {
    draft.adExcelUploads.push(createConfirmedUpload({ uploadId: "upload-delete", reportDate: date, isActive: true }));
    draft.adCampaignSignatures.push({
      id: "ad-signature-delete",
      storeId: "store-1",
      channel: "NAVER_DA",
      campaignId: "cmp-delete",
      campaignNameSnapshot: "duplicate launch",
      normalizedCampaignName: normalizeText("duplicate launch"),
      canonicalSalesUnitId: "sales-1",
      mappingReason: "RULE_MATCHED",
      matchedRuleCount: 1,
      reasonNote: null,
      reasonNoteInherited: false,
      confirmedAt: null,
      usageCount: 1,
      firstSeenDate: date,
      lastSeenDate: date,
      lastAutoMappedAt: null,
      mappingRuleHash: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const row = createConfirmedUploadRow({
      uploadId: "upload-delete",
      reportDate: date,
      campaignId: "cmp-delete",
      campaignName: "duplicate launch",
      canonicalSalesUnitId: "sales-1",
      totalCost: 45,
    }) as Record<string, unknown>;
    row.adCampaignSignatureId = "ad-signature-delete";
    draft.adCampaignDailyCosts.push(row as never);
  });

  const result = await adsService.deleteUpload("upload-delete");
  const snapshot = databaseService.getSnapshot();
  const upload = snapshot.adExcelUploads.find((item: { id: string }) => item.id === "upload-delete");

  assert.equal(result.data.uploadId, "upload-delete");
  assert.equal(result.data.previousState, "CONFIRMED");
  assert.equal(result.data.adCostCount, 1);
  assert.equal(upload?.state, "DELETED");
  assert.equal(upload?.isActive, false);
  assert.equal(snapshot.adCampaignDailyCosts.some((item: { sourceUploadId: string }) => item.sourceUploadId === "upload-delete"), false);
  assert.equal(snapshot.adCampaignSignatures.find((item: { id: string }) => item.id === "ad-signature-delete")?.usageCount, 0);
  assert.equal(snapshot.adCampaignSignatures.find((item: { id: string }) => item.id === "ad-signature-delete")?.firstSeenDate, null);
  assert.equal(snapshot.adCampaignSignatures.find((item: { id: string }) => item.id === "ad-signature-delete")?.lastSeenDate, null);
  assert.equal(calculateDashboardSummary(snapshot, "store-1", date).totalAdCost, 0);
});

runAsync("AdsService listAdCampaignSignatures excludes stale signatures and searches extended fields", async () => {
  const { databaseService, adsService } = createAdsServiceHarness();

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-needle", "Needle Unit", []));
    draft.adExcelUploads.push(
      createConfirmedUpload({ uploadId: "upload-active", reportDate: "2026-04-03" }),
      createConfirmedUpload({ uploadId: "upload-inactive", reportDate: "2026-04-02", isActive: false }),
    );
    draft.adCampaignSignatures.push(
      createAdCampaignSignature({
        id: "ad-signature-active",
        campaignId: "cmp-active",
        campaignName: "active launch",
        canonicalSalesUnitId: "sales-needle",
        mappingReason: "INTENTIONALLY_UNMAPPED",
        reasonNote: "budget hold",
        firstSeenDate: "2026-04-01",
        lastSeenDate: "2026-04-03",
      }),
      createAdCampaignSignature({
        id: "ad-signature-stale",
        campaignId: "cmp-stale",
        campaignName: "stale launch",
        firstSeenDate: "2026-04-02",
        lastSeenDate: "2026-04-02",
      }),
      createAdCampaignSignature({
        id: "ad-signature-no-rule",
        campaignId: "cmp-no-rule",
        campaignName: "no rule launch",
        mappingReason: "NO_RULE",
        firstSeenDate: "2026-04-03",
        lastSeenDate: "2026-04-03",
      }),
    );
    draft.adCampaignDailyCosts.push(
      Object.assign(
        createConfirmedUploadRow({
          uploadId: "upload-active",
          reportDate: "2026-04-03",
          campaignId: "cmp-active",
          campaignName: "active launch",
          canonicalSalesUnitId: null,
          totalCost: 120,
        }),
        { adCampaignSignatureId: "ad-signature-active" },
      ) as never,
      Object.assign(
        createConfirmedUploadRow({
          uploadId: "upload-inactive",
          reportDate: "2026-04-02",
          campaignId: "cmp-stale",
          campaignName: "stale launch",
          canonicalSalesUnitId: null,
          totalCost: 80,
        }),
        { adCampaignSignatureId: "ad-signature-stale" },
      ) as never,
      Object.assign(
        createConfirmedUploadRow({
          uploadId: "upload-active",
          reportDate: "2026-04-03",
          campaignId: "cmp-no-rule",
          campaignName: "no rule launch",
          canonicalSalesUnitId: null,
          totalCost: 40,
          mappingReason: "NO_RULE",
        }),
        { adCampaignSignatureId: "ad-signature-no-rule" },
      ) as never,
    );
  });

  const defaultResult = await adsService.listAdCampaignSignatures({ storeId: "store-1" });
  assert.equal(defaultResult.data.totalCount, 2);
  assert.deepEqual(
    new Set(defaultResult.data.items.map((item: { id: string }) => item.id)),
    new Set(["ad-signature-active", "ad-signature-no-rule"]),
  );

  for (const q of ["Needle Unit", "budget hold", "intentional", "2026-04-03"]) {
    const result = await adsService.listAdCampaignSignatures({ storeId: "store-1", q });
    assert.equal(
      result.data.items.some((item: { id: string }) => item.id === "ad-signature-active"),
      true,
    );
  }

  const reasonAliasResult = await adsService.listAdCampaignSignatures({ storeId: "store-1", q: "NO_RULE_MATCH" });
  assert.equal(reasonAliasResult.data.totalCount, 1);
  assert.equal(reasonAliasResult.data.items[0].id, "ad-signature-no-rule");
});

runAsync("AdsService saveManualMappings applies one sales unit to multiple rows", async () => {
  const { databaseService, adsService } = createAdsServiceHarness();

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-1",
        reportDate: "2026-04-03",
        campaignId: "cmp-1",
        campaignName: "alpha launch",
        canonicalSalesUnitId: null,
        totalCost: 120,
      }),
      createConfirmedUploadRow({
        uploadId: "upload-2",
        reportDate: "2026-04-03",
        campaignId: "cmp-2",
        campaignName: "alpha retarget",
        canonicalSalesUnitId: null,
        totalCost: 80,
      }),
    );
  });

  const result = await adsService.saveManualMappings(
    ["ad-upload-1-cmp-1", "ad-upload-2-cmp-2"],
    { canonicalSalesUnitId: "sales-1" },
  );
  const snapshot = databaseService.getSnapshot();

  assert.equal(result.data.updatedCount, 2);
  snapshot.adCampaignDailyCosts.forEach((item: any) => {
    assert.equal(item.canonicalSalesUnitId, "sales-1");
    assert.equal(item.mappingReason, "MANUAL_MAPPED");
    assert.equal(item.matchedRuleCount, 0);
    assert.equal(item.reasonNote, null);
    assert.equal(item.reasonNoteInherited, false);
  });
});

runAsync("AdsService saveManualMappings skips profit summary refresh when affected dates are empty", async () => {
  const { databaseService, adsService, profitSummaryService } = createAdsServiceHarness({
    withProfitSummaryService: true,
  });
  const summaryService = profitSummaryService!;
  let refreshCalls = 0;
  const originalRefresh = summaryService.refreshStoreDateListBestEffort.bind(summaryService);
  summaryService.refreshStoreDateListBestEffort = ((params) => {
    refreshCalls += 1;
    return originalRefresh(params);
  }) as ProfitSummaryService["refreshStoreDateListBestEffort"];

  databaseService.write((draft) => {
    draft.stores.push(createStoreRecord("store-1", "Main Store"));
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Signature Unit", ["signature"]));
    draft.adCampaignSignatures.push(
      createAdCampaignSignature({
        id: "ad-signature-no-date",
        campaignId: "cmp-no-date",
        campaignName: "signature campaign",
      }),
    );
  });

  const writeCountBefore = databaseService.writeCommittedCalls;
  const result = await adsService.saveManualMappings(["ad-signature-no-date"], {
    canonicalSalesUnitId: "sales-1",
  });
  const snapshot = databaseService.getSnapshot();

  assert.equal(result.data.updatedCount, 1);
  assert.equal(
    snapshot.adCampaignSignatures.find((item: { id: string }) => item.id === "ad-signature-no-date")
      ?.canonicalSalesUnitId,
    "sales-1",
  );
  assert.equal(refreshCalls, 0);
  assert.equal(databaseService.writeCommittedCalls, writeCountBefore + 1);
  assert.equal(snapshot.dailyStoreSummaries.length, 0);
  assert.equal(snapshot.dailySalesUnitProfits.length, 0);
});

runAsync("AdsService PostgreSQL mapping APIs bypass writeCommitted snapshot persistence", async () => {
  const { databaseService, adsService, profitSummaryService } = createAdsServiceHarness({
    withProfitSummaryService: true,
  });
  const refreshCalls: Array<{ storeId: string; dates: string[]; reason: string }> = [];
  profitSummaryService!.refreshStoreDateListBestEffort = ((params) => {
    refreshCalls.push({ ...params });
    return Promise.resolve(null);
  }) as ProfitSummaryService["refreshStoreDateListBestEffort"];

  databaseService.write((draft) => {
    draft.stores.push(createStoreRecord("store-1", "Main Store"));
    draft.adExcelUploads.push(createConfirmedUpload({ uploadId: "upload-direct", reportDate: "2026-04-01" }));
    draft.adExcelUploads.push(createConfirmedUpload({ uploadId: "upload-direct-2", reportDate: "2026-04-02" }));
    draft.canonicalSalesUnits.push(
      createSalesUnit("sales-manual", "Manual Unit", ["manual"]),
      createSalesUnit("sales-rule", "Rule Unit", ["direct"]),
    );
    draft.campaignMappings.push({
      id: "campaign-rule-direct",
      storeId: "store-1",
      channel: "NAVER_DA",
      canonicalSalesUnitId: "sales-rule",
      campaignPattern: "direct",
      normalizedCampaignPattern: normalizeText("direct"),
      isActive: true,
      deactivatedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    draft.adCampaignSignatures.push(
      createAdCampaignSignature({
        id: "ad-signature-direct",
        campaignId: "cmp-direct",
        campaignName: "direct launch",
      }),
    );
    draft.adCampaignDailyCosts.push(
      Object.assign(
        createConfirmedUploadRow({
          uploadId: "upload-direct",
          reportDate: "2026-04-01",
          campaignId: "cmp-direct",
          campaignName: "direct launch",
          canonicalSalesUnitId: null,
          totalCost: 100,
        }),
        { adCampaignSignatureId: "ad-signature-direct" },
      ) as never,
      Object.assign(
        createConfirmedUploadRow({
          uploadId: "upload-direct-2",
          reportDate: "2026-04-02",
          campaignId: "cmp-direct",
          campaignName: "direct launch",
          canonicalSalesUnitId: null,
          totalCost: 200,
        }),
        { adCampaignSignatureId: "ad-signature-direct" },
      ) as never,
    );
  });

  databaseService.storageMode = "postgres";
  databaseService.writeCommitted = async () => {
    throw new Error("writeCommitted should not be used for PostgreSQL ad campaign mapping");
  };

  await adsService.saveManualMappings(["ad-signature-direct"], { canonicalSalesUnitId: "sales-manual" });
  await adsService.setIntentionalUnmappedMany(["ad-upload-direct-cmp-direct"], {
    reasonNote: "brand spend hold",
  });
  const recalculateResult = await adsService.recalculateMappings(["ad-signature-direct"]);
  const snapshot = databaseService.getSnapshot();
  const signature = snapshot.adCampaignSignatures.find((item: { id: string }) => item.id === "ad-signature-direct")!;
  const relatedRows = snapshot.adCampaignDailyCosts.filter(
    (item: { adCampaignSignatureId: string | null }) => item.adCampaignSignatureId === "ad-signature-direct",
  );

  assert.equal(databaseService.writeCommittedCalls, 0);
  assert.equal(databaseService.saveAdCampaignMappingsCommittedCalls, 3);
  assert.equal(signature.mappingReason, "INTENTIONALLY_UNMAPPED");
  assert.equal(signature.reasonNote, "brand spend hold");
  assert.equal(recalculateResult.data.mappings[0].mappingReason, "INTENTIONALLY_UNMAPPED");
  assert.deepEqual(
    relatedRows.map((item: { mappingReason: string; reasonNote: string | null }) => [item.mappingReason, item.reasonNote]),
    [
      ["INTENTIONALLY_UNMAPPED", "brand spend hold"],
      ["INTENTIONALLY_UNMAPPED", "brand spend hold"],
    ],
  );
  assert.equal(refreshCalls.length, 3);
  refreshCalls.forEach((call) => {
    assert.deepEqual(call.dates, ["2026-04-01", "2026-04-02"]);
  });
});

runAsync("AdsService stores manual mappings on campaign signatures and later uploads inherit them", async () => {
  const { databaseService, adsService } = createAdsServiceHarness();

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(
      createSalesUnit("sales-1", "Manual Unit", ["manual"]),
      createSalesUnit("sales-2", "Rule Unit", ["rule"]),
    );
  });

  await adsService.previewUpload(
    "store-1",
    "2026-04-03",
    createAdUploadFile("2026-04-03", [
      { campaignId: "cmp-signature", campaignName: "brand launch", totalCost: 120 },
    ]),
  );

  const firstSnapshot = databaseService.getSnapshot();
  const firstRow = firstSnapshot.adCampaignDailyCosts.find(
    (item: { campaignId: string }) => item.campaignId === "cmp-signature",
  )!;

  await adsService.saveManualMappings([firstRow.id], { canonicalSalesUnitId: "sales-1" });
  const manualSnapshot = databaseService.getSnapshot();
  const signature = manualSnapshot.adCampaignSignatures.find(
    (item: { campaignId: string | null }) => item.campaignId === "cmp-signature",
  )!;

  assert.equal(signature.canonicalSalesUnitId, "sales-1");
  assert.equal(signature.mappingReason, "MANUAL_MAPPED");
  assert.ok(signature.confirmedAt);
  assert.equal(
    manualSnapshot.adCampaignDailyCosts.find((item: { id: string }) => item.id === firstRow.id)?.adCampaignSignatureId,
    signature.id,
  );

  databaseService.write((draft) => {
    draft.campaignMappings.push({
      id: "campaign-rule-1",
      storeId: "store-1",
      channel: "NAVER_DA",
      canonicalSalesUnitId: "sales-2",
      campaignPattern: "brand",
      normalizedCampaignPattern: normalizeText("brand"),
      isActive: true,
      deactivatedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  await adsService.recalculateMappings([signature.id]);
  assert.equal(
    databaseService.getSnapshot().adCampaignSignatures.find((item: { id: string }) => item.id === signature.id)
      ?.canonicalSalesUnitId,
    "sales-1",
  );

  await adsService.previewUpload(
    "store-1",
    "2026-04-04",
    createAdUploadFile("2026-04-04", [
      { campaignId: "cmp-signature", campaignName: "brand launch", totalCost: 80 },
    ]),
  );

  const finalSnapshot = databaseService.getSnapshot();
  const rows = finalSnapshot.adCampaignDailyCosts.filter(
    (item: { campaignId: string }) => item.campaignId === "cmp-signature",
  );
  const finalSignature = finalSnapshot.adCampaignSignatures.find(
    (item: { id: string }) => item.id === signature.id,
  )!;

  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((item: { adCampaignSignatureId: string | null }) => item.adCampaignSignatureId)).size, 1);
  assert.equal(finalSignature.usageCount, 2);
  rows.forEach((item: { canonicalSalesUnitId: string | null; mappingReason: string }) => {
    assert.equal(item.canonicalSalesUnitId, "sales-1");
    assert.equal(item.mappingReason, "MANUAL_MAPPED");
  });
});

runAsync("AdsService saveManualMappings rejects inactive sales units", async () => {
  const { databaseService, adsService } = createAdsServiceHarness();
  const inactiveSalesUnit = createSalesUnit("sales-1", "Alpha Unit", ["alpha"]) as Record<string, unknown>;

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(
      {
        ...inactiveSalesUnit,
        isActive: false,
        deactivatedAt: new Date().toISOString(),
      } as never,
    );
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-5",
        reportDate: "2026-04-03",
        campaignId: "cmp-5",
        campaignName: "alpha launch",
        canonicalSalesUnitId: null,
        totalCost: 20,
      }),
    );
  });

  await assert.rejects(
    () =>
      adsService.saveManualMappings(["ad-upload-5-cmp-5"], {
        canonicalSalesUnitId: "sales-1",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "getResponse" in error &&
      JSON.stringify((error as { getResponse: () => unknown }).getResponse()).includes("비활성화된 판매단위"),
  );
});

runAsync("AdsService setIntentionalUnmappedMany applies one note to multiple rows", async () => {
  const { databaseService, adsService } = createAdsServiceHarness();

  databaseService.write((draft) => {
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-3",
        reportDate: "2026-04-03",
        campaignId: "cmp-3",
        campaignName: "beta launch",
        canonicalSalesUnitId: "sales-1",
        totalCost: 50,
      }),
      createConfirmedUploadRow({
        uploadId: "upload-4",
        reportDate: "2026-04-03",
        campaignId: "cmp-4",
        campaignName: "beta retention",
        canonicalSalesUnitId: "sales-1",
        totalCost: 40,
      }),
    );
  });

  const result = await adsService.setIntentionalUnmappedMany(
    ["ad-upload-3-cmp-3", "ad-upload-4-cmp-4"],
    { reasonNote: "merged into brand spend" },
  );
  const snapshot = databaseService.getSnapshot();

  assert.equal(result.data.updatedCount, 2);
  snapshot.adCampaignDailyCosts.forEach((item: any) => {
    assert.equal(item.canonicalSalesUnitId, null);
    assert.equal(item.mappingReason, "INTENTIONALLY_UNMAPPED");
    assert.equal(item.reasonNote, "merged into brand spend");
    assert.equal(item.reasonNoteInherited, false);
  });
});

// ========== Signature Enrichment Tests ==========

run("isMeaningfulName rejects empty/null/whitespace strings", () => {
  assert.equal(isMeaningfulName(null), false);
  assert.equal(isMeaningfulName(undefined), false);
  assert.equal(isMeaningfulName(""), false);
  assert.equal(isMeaningfulName("   "), false);
});

run("isMeaningfulName rejects strings with length <= 2", () => {
  assert.equal(isMeaningfulName("L"), false);
  assert.equal(isMeaningfulName("XL"), false);
  assert.equal(isMeaningfulName("M"), false);
  assert.equal(isMeaningfulName("s"), false);
  assert.equal(isMeaningfulName("XS"), false);
});

run("isMeaningfulName rejects size/option patterns (case-insensitive)", () => {
  assert.equal(isMeaningfulName("xs"), false);
  assert.equal(isMeaningfulName("XS"), false);
  assert.equal(isMeaningfulName("s"), false);
  assert.equal(isMeaningfulName("m"), false);
  assert.equal(isMeaningfulName("l"), false);
  assert.equal(isMeaningfulName("xl"), false);
  assert.equal(isMeaningfulName("xxl"), false);
  assert.equal(isMeaningfulName("free"), false);
  assert.equal(isMeaningfulName("one"), false);
  assert.equal(isMeaningfulName("원사이즈"), false);
  assert.equal(isMeaningfulName("32"), false);
  assert.equal(isMeaningfulName("36"), false);
});

run("isMeaningfulName rejects values contained in context option info", () => {
  const contextOption = "[함께배송⭐추가할인]러닝깔창: L";
  assert.equal(isMeaningfulName("L", contextOption), false);
  assert.equal(isMeaningfulName("l", contextOption), false); // case-insensitive check
});

run("isMeaningfulName accepts meaningful product names", () => {
  assert.equal(isMeaningfulName("러닝깔창"), true);
  assert.equal(isMeaningfulName("베놈 무릎보호대"), true);
  assert.equal(isMeaningfulName("Running Hat"), true);
  assert.equal(isMeaningfulName("ABC"), true); // length >= 3
});

run("extractNameFromOptionInfo parses pattern correctly", () => {
  assert.equal(
    extractNameFromOptionInfo("[함께배송⭐추가할인]러닝깔창: L"),
    "러닝깔창"
  );
  assert.equal(
    extractNameFromOptionInfo("[TAG]상품명: 사이즈"),
    "상품명"
  );
  assert.equal(
    extractNameFromOptionInfo("무릎보호대: XL"),
    "무릎보호대"
  );
});

run("extractNameFromOptionInfo returns null for non-matching patterns", () => {
  assert.equal(extractNameFromOptionInfo("no colon here"), null);
  assert.equal(extractNameFromOptionInfo(""), null);
  assert.equal(extractNameFromOptionInfo(null as never), null);
});

run("enrichSignatureDisplayName returns snapshot when meaningful", async () => {
  const database = createEmptyDatabase();
  const signature = {
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: "sig",
    rawProductNameSnapshot: "러닝깔창",
    rawOptionInfoSnapshot: null,
    normalizedProductName: "러닝깔창",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED" as const,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;

  const result = await enrichSignatureDisplayName(database, signature);
  assert.equal(result.fallbackProductName, "러닝깔창");
  assert.equal(result.fallbackProductNameSource, "snapshot");
});

run("enrichSignatureDisplayName falls back to orderItem rawProductName", async () => {
  const database = createEmptyDatabase();
  const signature = {
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: "sig",
    rawProductNameSnapshot: "",
    rawOptionInfoSnapshot: null,
    normalizedProductName: "",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED" as const,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;
  database.orderItems.push({
    id: "item-1",
    orderId: "order-1",
    storeId: "store-1",
    productId: null,
    orderSourceSignatureId: "sig-1",
    canonicalSalesUnitId: null,
    externalProductOrderId: "ext-1",
    externalProductId: null,
    optionCode: null,
    packageNumber: null,
    rawProductName: "베놈 무릎보호대",
    rawOptionInfo: null,
    normalizedProductName: "베놈 무릎보호대",
    normalizedOptionInfo: "",
    sourceSignature: "sig",
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: null,
    deliveryFeeAmount: null,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: null,
    paymentDate: null,
    saleStatus: "SALE",
    orderStatus: "PAYED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);

  const result = await enrichSignatureDisplayName(database, signature);
  assert.equal(result.fallbackProductName, "베놈 무릎보호대");
  assert.equal(result.fallbackProductNameSource, "orderItem");
});

run("enrichSignatureDisplayName extracts from option info pattern", async () => {
  const database = createEmptyDatabase();
  const signature = {
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: "sig",
    rawProductNameSnapshot: "",
    rawOptionInfoSnapshot: "[함께배송⭐추가할인]러닝깔창: L",
    normalizedProductName: "",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED" as const,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;

  const result = await enrichSignatureDisplayName(database, signature);
  assert.equal(result.fallbackProductName, "러닝깔창");
  assert.equal(result.fallbackProductNameSource, "optionInfo");
});

run("enrichSignatureDisplayName matches product by externalProductId", async () => {
  const database = createEmptyDatabase();
  const signature = {
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: "sig",
    rawProductNameSnapshot: "",
    rawOptionInfoSnapshot: null,
    normalizedProductName: "",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED" as const,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;
  database.orderItems.push({
    id: "item-1",
    orderId: "order-1",
    storeId: "store-1",
    productId: null,
    orderSourceSignatureId: "sig-1",
    canonicalSalesUnitId: null,
    externalProductOrderId: "ext-1",
    externalProductId: "prod-123",
    optionCode: null,
    packageNumber: null,
    rawProductName: "L",
    rawOptionInfo: null,
    normalizedProductName: "l",
    normalizedOptionInfo: "",
    sourceSignature: "sig",
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: null,
    deliveryFeeAmount: null,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: null,
    paymentDate: null,
    saleStatus: "SALE",
    orderStatus: "PAYED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.products.push({
    id: "p-1",
    storeId: "store-1",
    externalProductId: "prod-123",
    productName: "고급 러닝화",
    normalizedProductName: "고급 러닝화",
    status: null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const result = await enrichSignatureDisplayName(database, signature);
  assert.equal(result.fallbackProductName, "고급 러닝화");
  assert.equal(result.fallbackProductNameSource, "product");
});

runAsync("enrichSignatureDisplayName prefers product fallback before legacy order item raw fields", async () => {
  const database = createEmptyDatabase();
  const signature = {
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: "sig",
    rawProductNameSnapshot: "",
    rawOptionInfoSnapshot: null,
    normalizedProductName: "",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED" as const,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;
  database.orderItems.push({
    id: "item-1",
    orderId: "order-1",
    storeId: "store-1",
    productId: null,
    orderSourceSignatureId: "sig-1",
    canonicalSalesUnitId: null,
    externalProductOrderId: "ext-1",
    externalProductId: "prod-123",
    optionCode: null,
    packageNumber: null,
    rawProductName: "Legacy Raw Product",
    rawOptionInfo: null,
    normalizedProductName: "legacy raw product",
    normalizedOptionInfo: "",
    sourceSignature: "sig",
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: null,
    deliveryFeeAmount: null,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: null,
    paymentDate: null,
    saleStatus: "SALE",
    orderStatus: "PAYED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.products.push({
    id: "p-1",
    storeId: "store-1",
    externalProductId: "prod-123",
    productName: "Catalog Product",
    normalizedProductName: "catalog product",
    status: null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const result = await enrichSignatureDisplayName(database, signature);

  assert.equal(result.fallbackProductName, "Catalog Product");
  assert.equal(result.fallbackProductNameSource, "product");
});

run("enrichSignatureDisplayName returns null when all fallbacks fail", async () => {
  const database = createEmptyDatabase();
  const signature = {
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: "sig",
    rawProductNameSnapshot: "",
    rawOptionInfoSnapshot: null,
    normalizedProductName: "",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED" as const,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;

  const result = await enrichSignatureDisplayName(database, signature);
  assert.equal(result.fallbackProductName, null);
  assert.equal(result.fallbackProductNameSource, null);
});

run("getSignatureIndex caches index by database reference", () => {
  const database = createEmptyDatabase();
  database.orderSourceSignatures = [
    {
      id: "sig-1",
      storeId: "store-1",
      sourceSignature: "sig1",
      rawProductNameSnapshot: "Product 1",
      rawOptionInfoSnapshot: "Option 1",
      normalizedProductName: "product 1",
      normalizedOptionInfo: "option 1",
      canonicalSalesUnitId: "unit-1",
      mappingStatus: "MAPPED" as const,
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    {
      id: "sig-2",
      storeId: "store-1",
      sourceSignature: "sig2",
      rawProductNameSnapshot: "Product 2",
      rawOptionInfoSnapshot: null,
      normalizedProductName: "product 2",
      normalizedOptionInfo: "",
      canonicalSalesUnitId: null,
      mappingStatus: "UNMAPPED",
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  ];

  // First call builds the index
  const index1 = getSignatureIndex(database);
  assert.equal(index1.size, 2);
  assert.equal(index1.get("sig-1")?.sourceSignature, "sig1");
  assert.equal(index1.get("sig-2")?.sourceSignature, "sig2");

  // Second call with same reference should return cached index (same object)
  const index2 = getSignatureIndex(database);
  assert.strictEqual(index1, index2, "Cache should return same Map instance");

  // Third call still returns cached
  const index3 = getSignatureIndex(database);
  assert.strictEqual(index1, index3);
});

run("getSignatureIndex cache invalidates on database reference change", () => {
  const database1 = createEmptyDatabase();
  database1.orderSourceSignatures = [
    {
      id: "sig-1",
      storeId: "store-1",
      sourceSignature: "sig1",
      rawProductNameSnapshot: "Product 1",
      rawOptionInfoSnapshot: "Option 1",
      normalizedProductName: "product 1",
      normalizedOptionInfo: "option 1",
      canonicalSalesUnitId: "unit-1",
      mappingStatus: "MAPPED" as const,
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  ];

  const index1 = getSignatureIndex(database1);
  assert.equal(index1.size, 1);

  // Create a new database reference with different signatures
  const database2 = createEmptyDatabase();
  database2.orderSourceSignatures = [
    {
      id: "sig-a",
      storeId: "store-1",
      sourceSignature: "siga",
      rawProductNameSnapshot: "Product A",
      rawOptionInfoSnapshot: null,
      normalizedProductName: "product a",
      normalizedOptionInfo: "",
      canonicalSalesUnitId: null,
      mappingStatus: "UNMAPPED",
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    {
      id: "sig-b",
      storeId: "store-1",
      sourceSignature: "sigb",
      rawProductNameSnapshot: "Product B",
      rawOptionInfoSnapshot: null,
      normalizedProductName: "product b",
      normalizedOptionInfo: "",
      canonicalSalesUnitId: null,
      mappingStatus: "UNMAPPED",
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  ];

  // New database reference should build new index
  const index2 = getSignatureIndex(database2);
  assert.equal(index2.size, 2);
  assert.notStrictEqual(index1, index2, "Different database references should have different caches");
  assert.equal(index2.get("sig-a")?.sourceSignature, "siga");
  assert.equal(index2.get("sig-b")?.sourceSignature, "sigb");

  // Original database should still have cached original index
  const index1Again = getSignatureIndex(database1);
  assert.strictEqual(index1, index1Again);
  assert.equal(index1Again.size, 1);
});

void Promise.all(pendingAsyncTests).then(() => {
  console.log("All backend checks passed.");
});
