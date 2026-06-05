import { Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import {
  AdCampaignDailyCost,
  AdCampaignSignature,
  CanonicalSalesUnit,
  DatabaseShape,
  DEFAULT_DELIVERY_UNIT_COST,
  MappingStatus,
  OperationRecord,
  OperationStatus,
  OperationType,
  OrderItem,
  OrderSourceSignature,
  PaginationResult,
  StoredDailySalesUnitProfit,
  StoredDailyStoreSummary,
  normalizeText,
} from "@patima/shared";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { Pool, PoolClient } from "pg";
import {
  applyAdCampaignSignatureToRows,
  ensureAdCampaignSignaturesForStore,
  recalculateAdCampaignSignaturesForStore,
} from "./ad-mapping-engine";
import {
  createEmptyDatabase,
  getActiveConfirmedUploadIds,
  getAdMappingStatus,
  getOrderItemMappingStatus,
  getSignatureMappingStatus,
  migrateCanonicalSalesUnit,
  paginate,
  repairMojibakeText,
} from "./helpers";
import { buildPaginationResult, createSqlBuilder, normalizePagination } from "./query-builders";

type DatabaseCollectionKey = keyof DatabaseShape;
type StorageMode = "postgres" | "file";

interface PersistenceErrorState {
  message: string;
  occurredAt: string;
}

interface StorageTable {
  key: DatabaseCollectionKey;
  tableName: string;
  queueOwned?: boolean;
}

interface PostgresJsonbIndex {
  name: string;
  sql: string;
  requiresDuplicateCheckId?: string;
  duplicateFallbackSql?: string;
}

interface DuplicateKeyCheck {
  id: string;
  label: string;
  sql: string;
}

interface DuplicateKeyWarning {
  checkId: string;
  label: string;
  rows: Array<Record<string, unknown>>;
}

type ListMappingStatus = "ALL" | MappingStatus;

interface DailyProfitSummaryRows {
  dailySalesUnitProfits: StoredDailySalesUnitProfit[];
  dailyStoreSummaries: StoredDailyStoreSummary[];
}

interface DailyProfitSummaryReplacementResult<T> extends DailyProfitSummaryRows {
  result: T;
}

export interface OrderManualMappingCommitResult {
  signatureIds: string[];
  updatedOrderItemCount: number;
  affectedDates: string[];
}

export type AdCampaignMappingCommitAction =
  | { type: "MANUAL_MAPPED"; canonicalSalesUnitId: string; timestamp: string }
  | { type: "INTENTIONALLY_UNMAPPED"; reasonNote: string; timestamp: string }
  | { type: "RECALCULATE" };

export interface AdCampaignMappingCommitResult {
  signatureIds: string[];
  updatedAdCampaignDailyCostCount: number;
  affectedDates: string[];
}

export interface CanonicalSalesUnitCreateCommitResult {
  salesUnit: CanonicalSalesUnit;
}

export interface OperationListQuery {
  storeId: string;
  status?: OperationStatus;
  operationType?: OperationType;
  page?: number;
  pageSize?: number;
}

export interface OperationExecutionLock {
  lockName: string;
  release: () => Promise<void>;
}

export interface OrderItemListQuery {
  storeId: string;
  dateFrom?: string;
  dateTo?: string;
  productName?: string;
  optionInfo?: string;
  mappingStatus?: ListMappingStatus;
  orderStatus?: string;
  saleStatus?: string;
  paymentDateStatus?: "ALL" | "PRESENT" | "MISSING";
  page?: number;
  pageSize?: number;
}

export interface AdCampaignSignatureListQuery {
  storeId: string;
  dateFrom?: string;
  dateTo?: string;
  mappingStatus?: ListMappingStatus;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface AdCampaignSignatureQueryItem {
  signature: AdCampaignSignature;
  latestRow: AdCampaignDailyCost | null;
  totalCost: number;
  rowCount: number;
}

const parsePgCount = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }

  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const DEFAULT_OPERATION_MAX_ATTEMPTS = 3;
const OPERATION_LOCK_BUSY_ATTEMPT_DECREMENT = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const HANGUL_REGEX = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (match) => `\\${match}`);

const likePattern = (value: string): string => `%${escapeLikePattern(value)}%`;

const toDisplayMappingReasonAlias = (value: string | null | undefined) => {
  switch (value) {
    case "NO_RULE":
      return "NO_RULE_MATCH";
    case "MULTIPLE_RULES":
      return "MULTIPLE_RULE_MATCHES";
    default:
      return value ?? "";
  }
};

const orderItemMappingStatusSql = (itemAlias: string, signatureAlias: string) => `
  CASE
    WHEN ${signatureAlias}.payload IS NOT NULL THEN COALESCE(
      ${signatureAlias}.payload->>'mappingStatus',
      CASE
        WHEN NULLIF(${signatureAlias}.payload->>'canonicalSalesUnitId', '') IS NOT NULL THEN 'MAPPED'
        ELSE 'UNMAPPED'
      END
    )
    WHEN NULLIF(${itemAlias}.payload->>'canonicalSalesUnitId', '') IS NOT NULL THEN 'MAPPED'
    ELSE 'UNMAPPED'
  END
`;

const adCampaignMappingStatusSql = (signatureAlias: string) => `
  CASE
    WHEN ${signatureAlias}.payload->>'mappingReason' = 'MULTIPLE_RULES' THEN 'CONFLICT'
    WHEN NULLIF(${signatureAlias}.payload->>'canonicalSalesUnitId', '') IS NOT NULL THEN 'MAPPED'
    ELSE 'UNMAPPED'
  END
`;

const adCampaignMappingReasonAliasSql = (signatureAlias: string) => `
  CASE ${signatureAlias}.payload->>'mappingReason'
    WHEN 'NO_RULE' THEN 'NO_RULE_MATCH'
    WHEN 'MULTIPLE_RULES' THEN 'MULTIPLE_RULE_MATCHES'
    ELSE COALESCE(${signatureAlias}.payload->>'mappingReason', '')
  END
`;

const STORAGE_TABLES: StorageTable[] = [
  { key: "stores", tableName: "stores" },
  { key: "commerceCredentials", tableName: "commerce_api_credentials" },
  { key: "products", tableName: "products" },
  { key: "canonicalSalesUnits", tableName: "canonical_sales_units" },
  { key: "orderSourceSignatures", tableName: "order_source_signatures" },
  { key: "orders", tableName: "orders" },
  { key: "orderItems", tableName: "order_items" },
  { key: "campaignMappings", tableName: "campaign_sales_unit_mappings" },
  { key: "adCampaignSignatures", tableName: "ad_campaign_signatures" },
  { key: "adExcelUploads", tableName: "ad_excel_uploads" },
  { key: "adUploadPreviewRows", tableName: "ad_upload_preview_rows" },
  { key: "adCampaignDailyCosts", tableName: "ad_campaign_daily_costs" },
  { key: "salesUnitCostSettings", tableName: "sales_unit_cost_settings" },
  { key: "salesUnitCostSnapshots", tableName: "sales_unit_cost_snapshots" },
  { key: "salesUnitCostSnapshotEntries", tableName: "sales_unit_cost_snapshot_entries" },
  { key: "dailyFakePurchases", tableName: "daily_fake_purchases" },
  { key: "dailySalesUnitProfits", tableName: "daily_sales_unit_profits" },
  { key: "dailyStoreSummaries", tableName: "daily_store_summaries" },
  { key: "operations", tableName: "operations", queueOwned: true },
  { key: "auditLogs", tableName: "audit_logs" },
];

export const POSTGRES_SCHEMA_VERSION = 3;
export const POSTGRES_UPSERT_BATCH_SIZE = 500;

const POSTGRES_JSONB_INDEXES: PostgresJsonbIndex[] = [
  {
    name: "idx_orders_store_external",
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_store_external
          ON orders ((payload->>'storeId'), (payload->>'externalOrderId'))`,
  },
  {
    name: "idx_orders_store_payment_datetime",
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_store_payment_datetime
          ON orders ((payload->>'storeId'), (payload->>'paymentDatetime'))`,
  },
  {
    name: "idx_order_items_store_external_product_order",
    requiresDuplicateCheckId: "order-items-store-external-product-order",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_store_external_product_order
          ON order_items ((payload->>'storeId'), (payload->>'externalProductOrderId'))`,
    duplicateFallbackSql: `CREATE INDEX IF NOT EXISTS idx_order_items_store_external_product_order_lookup
                           ON order_items ((payload->>'storeId'), (payload->>'externalProductOrderId'))`,
  },
  {
    name: "idx_order_items_store_payment_date",
    sql: `CREATE INDEX IF NOT EXISTS idx_order_items_store_payment_date
          ON order_items ((payload->>'storeId'), (payload->>'paymentDate'))`,
  },
  {
    name: "idx_order_items_store_sale_status",
    sql: `CREATE INDEX IF NOT EXISTS idx_order_items_store_sale_status
          ON order_items ((payload->>'storeId'), (payload->>'saleStatus'))`,
  },
  {
    name: "idx_order_items_store_order_status",
    sql: `CREATE INDEX IF NOT EXISTS idx_order_items_store_order_status
          ON order_items ((payload->>'storeId'), (payload->>'orderStatus'))`,
  },
  {
    name: "idx_order_items_store_signature",
    sql: `CREATE INDEX IF NOT EXISTS idx_order_items_store_signature
          ON order_items ((payload->>'storeId'), (payload->>'orderSourceSignatureId'))`,
  },
  {
    name: "idx_ad_signatures_store_last_seen",
    sql: `CREATE INDEX IF NOT EXISTS idx_ad_signatures_store_last_seen
          ON ad_campaign_signatures ((payload->>'storeId'), (payload->>'lastSeenDate'), (payload->>'updatedAt'))`,
  },
  {
    name: "idx_ad_costs_store_report_campaign",
    sql: `CREATE INDEX IF NOT EXISTS idx_ad_costs_store_report_campaign
          ON ad_campaign_daily_costs ((payload->>'storeId'), (payload->>'reportDate'), (payload->>'campaignId'))`,
  },
  {
    name: "idx_ad_costs_store_signature_upload_report",
    sql: `CREATE INDEX IF NOT EXISTS idx_ad_costs_store_signature_upload_report
          ON ad_campaign_daily_costs ((payload->>'storeId'), (payload->>'adCampaignSignatureId'), (payload->>'sourceUploadId'), (payload->>'reportDate'))`,
  },
  {
    name: "idx_operations_store_status_created",
    sql: `CREATE INDEX IF NOT EXISTS idx_operations_store_status_created
          ON operations ((payload->>'storeId'), (payload->>'status'), (payload->>'createdAt'))`,
  },
  {
    name: "idx_operations_store_type_created",
    sql: `CREATE INDEX IF NOT EXISTS idx_operations_store_type_created
          ON operations ((payload->>'storeId'), (payload->>'operationType'), (payload->>'createdAt'))`,
  },
  {
    name: "idx_operations_status_run_after_created",
    sql: `CREATE INDEX IF NOT EXISTS idx_operations_status_run_after_created
          ON operations ((payload->>'status'), (payload->>'runAfter'), (payload->>'createdAt'))`,
  },
  {
    name: "idx_operations_store_type_status_lease",
    sql: `CREATE INDEX IF NOT EXISTS idx_operations_store_type_status_lease
          ON operations ((payload->>'storeId'), (payload->>'operationType'), (payload->>'status'), (payload->>'leaseExpiresAt'))`,
  },
  {
    name: "idx_daily_sales_unit_profit_unique",
    requiresDuplicateCheckId: "daily-sales-unit-profits-store-date-unit",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_sales_unit_profit_unique
          ON daily_sales_unit_profits ((payload->>'storeId'), (payload->>'date'), (payload->>'canonicalSalesUnitId'))`,
    duplicateFallbackSql: `CREATE INDEX IF NOT EXISTS idx_daily_sales_unit_profit_lookup
                           ON daily_sales_unit_profits ((payload->>'storeId'), (payload->>'date'), (payload->>'canonicalSalesUnitId'))`,
  },
  {
    name: "idx_daily_store_summary_unique",
    requiresDuplicateCheckId: "daily-store-summaries-store-date",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_store_summary_unique
          ON daily_store_summaries ((payload->>'storeId'), (payload->>'date'))`,
    duplicateFallbackSql: `CREATE INDEX IF NOT EXISTS idx_daily_store_summary_lookup
                           ON daily_store_summaries ((payload->>'storeId'), (payload->>'date'))`,
  },
];

const POSTGRES_DUPLICATE_KEY_CHECKS: DuplicateKeyCheck[] = [
  {
    id: "orders-store-external",
    label: "orders (storeId, externalOrderId)",
    sql: `SELECT payload->>'storeId' AS store_id,
                 payload->>'externalOrderId' AS external_order_id,
                 COUNT(*)::int AS duplicate_count
          FROM orders
          WHERE payload->>'storeId' IS NOT NULL
            AND payload->>'externalOrderId' IS NOT NULL
          GROUP BY 1, 2
          HAVING COUNT(*) > 1
          LIMIT 20`,
  },
  {
    id: "order-items-store-external-product-order",
    label: "order_items (storeId, externalProductOrderId)",
    sql: `SELECT payload->>'storeId' AS store_id,
                 payload->>'externalProductOrderId' AS external_product_order_id,
                 COUNT(*)::int AS duplicate_count
          FROM order_items
          WHERE payload->>'storeId' IS NOT NULL
            AND payload->>'externalProductOrderId' IS NOT NULL
          GROUP BY 1, 2
          HAVING COUNT(*) > 1
          LIMIT 20`,
  },
  {
    id: "ad-costs-active-store-report-campaign",
    label: "ad_campaign_daily_costs active uploads (storeId, reportDate, campaignId)",
    sql: `SELECT costs.payload->>'storeId' AS store_id,
                 costs.payload->>'reportDate' AS report_date,
                 costs.payload->>'campaignId' AS campaign_id,
                 COUNT(*)::int AS duplicate_count
          FROM ad_campaign_daily_costs costs
          JOIN ad_excel_uploads uploads
            ON uploads.id = costs.payload->>'sourceUploadId'
          WHERE (uploads.payload->>'isActive')::boolean IS TRUE
            AND costs.payload->>'storeId' IS NOT NULL
            AND costs.payload->>'reportDate' IS NOT NULL
            AND costs.payload->>'campaignId' IS NOT NULL
          GROUP BY 1, 2, 3
          HAVING COUNT(*) > 1
          LIMIT 20`,
  },
  {
    id: "sales-unit-cost-snapshots-store-effective-from",
    label: "sales_unit_cost_snapshots (storeId, effectiveFrom)",
    sql: `SELECT payload->>'storeId' AS store_id,
                 payload->>'effectiveFrom' AS effective_from,
                 COUNT(*)::int AS duplicate_count
          FROM sales_unit_cost_snapshots
          WHERE payload->>'storeId' IS NOT NULL
            AND payload->>'effectiveFrom' IS NOT NULL
          GROUP BY 1, 2
          HAVING COUNT(*) > 1
          LIMIT 20`,
  },
  {
    id: "daily-sales-unit-profits-store-date-unit",
    label: "daily_sales_unit_profits (storeId, date, canonicalSalesUnitId)",
    sql: `SELECT payload->>'storeId' AS store_id,
                 payload->>'date' AS date,
                 payload->>'canonicalSalesUnitId' AS canonical_sales_unit_id,
                 COUNT(*)::int AS duplicate_count
          FROM daily_sales_unit_profits
          WHERE payload->>'storeId' IS NOT NULL
            AND payload->>'date' IS NOT NULL
            AND payload->>'canonicalSalesUnitId' IS NOT NULL
          GROUP BY 1, 2, 3
          HAVING COUNT(*) > 1
          LIMIT 20`,
  },
  {
    id: "daily-store-summaries-store-date",
    label: "daily_store_summaries (storeId, date)",
    sql: `SELECT payload->>'storeId' AS store_id,
                 payload->>'date' AS date,
                 COUNT(*)::int AS duplicate_count
          FROM daily_store_summaries
          WHERE payload->>'storeId' IS NOT NULL
            AND payload->>'date' IS NOT NULL
          GROUP BY 1, 2
          HAVING COUNT(*) > 1
          LIMIT 20`,
  },
];

const toStableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => toStableJsonValue(item) ?? null);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = toStableJsonValue((value as Record<string, unknown>)[key]);
      if (normalized !== undefined) {
        sorted[key] = normalized;
      }
    }
    return sorted;
  }

  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  return value;
};

export const stableStringify = (value: unknown): string => JSON.stringify(toStableJsonValue(value)) ?? "null";

export const hashPayload = (payload: unknown): string =>
  createHash("sha256").update(stableStringify(payload)).digest("hex");

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private database: DatabaseShape = createEmptyDatabase();
  private readonly storageMode: StorageMode = process.env.DATABASE_URL ? "postgres" : "file";
  private pool: Pool | null = null;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private pendingWriteCount = 0;
  private lastPersistenceError: PersistenceErrorState | null = null;
  private readonly operationExecutionLocks = new Set<string>();

  private readonly filePath = join(this.resolveDataDir(), "database.json");

  async onModuleInit(): Promise<void> {
    if (this.storageMode === "postgres") {
      await this.initializePostgresStorage();
      return;
    }

    this.ensureFileStorageReady();
    this.database = this.loadSnapshotFromFile();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.storageMode !== "postgres") {
      return;
    }

    await this.persistenceQueue.catch(() => undefined);
    await this.pool?.end();
  }

  getStorageMode() {
    return this.storageMode;
  }

  getPersistenceStatus(): {
    storageMode: StorageMode;
    hasPendingWrite: boolean;
    lastPersistenceError: PersistenceErrorState | null;
  } {
    return {
      storageMode: this.storageMode,
      hasPendingWrite: this.pendingWriteCount > 0,
      lastPersistenceError: this.lastPersistenceError,
    };
  }

  async queryOperations(query: OperationListQuery): Promise<PaginationResult<OperationRecord>> {
    if (this.storageMode !== "postgres") {
      return this.queryOperationsFromSnapshot(query);
    }

    const pagination = normalizePagination(query.page, query.pageSize);
    const builder = createSqlBuilder();
    builder.addCondition("payload->>'storeId' = {param}", query.storeId);
    if (query.status) {
      builder.addCondition("payload->>'status' = {param}", query.status);
    }
    if (query.operationType) {
      builder.addCondition("payload->>'operationType' = {param}", query.operationType);
    }

    const whereClause = builder.whereClause();
    const countQuery = builder.build(`SELECT COUNT(*)::int AS total_count FROM operations ${whereClause}`);
    const countResult = await this.getPool().query<{ total_count: number | string }>(
      countQuery.text,
      countQuery.params,
    );
    const totalCount = parsePgCount(countResult.rows[0]?.total_count);

    const itemsQuery = builder.buildPaginated(
      `SELECT payload
       FROM operations
       ${whereClause}
       ORDER BY payload->>'createdAt' DESC, id DESC`,
      pagination,
    );
    const rows = await this.getPool().query<{ payload: OperationRecord }>(itemsQuery.text, itemsQuery.params);

    return buildPaginationResult(
      rows.rows.map((row) => this.normalizeOperationRecord(row.payload)),
      totalCount,
      pagination,
    );
  }

  async getOperationById(operationId: string): Promise<OperationRecord | null> {
    if (this.storageMode !== "postgres") {
      const operation = this.database.operations.find((item) => item.id === operationId);
      return operation ? this.cloneSnapshot(this.normalizeOperationRecord(operation)) : null;
    }

    const result = await this.getPool().query<{ payload: OperationRecord }>(
      "SELECT payload FROM operations WHERE id = $1",
      [operationId],
    );
    const operation = result.rows[0]?.payload;
    if (!operation) {
      return null;
    }

    const normalized = this.normalizeOperationRecord(operation);
    this.upsertOperationInMemory(normalized);
    return this.cloneSnapshot(normalized);
  }

  async insertOperation(operation: OperationRecord): Promise<OperationRecord> {
    const normalized = this.normalizeOperationRecord(operation);

    if (this.storageMode !== "postgres") {
      return this.writeCommitted((draft) => {
        draft.operations.push(normalized);
        return this.cloneSnapshot(normalized);
      });
    }

    return this.runPostgresCommitted(async () => {
      const client = await this.getPool().connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO operations (id, payload, payload_hash, updated_at)
           VALUES ($1, $2::jsonb, $3, NOW())`,
          [normalized.id, JSON.stringify(normalized), hashPayload(normalized)],
        );
        await client.query("COMMIT");
        this.upsertOperationInMemory(normalized);
        return this.cloneSnapshot(normalized);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async releaseExpiredOperationLeases(now: Date = new Date()): Promise<number> {
    const nowAt = now.toISOString();

    if (this.storageMode !== "postgres") {
      return this.writeCommitted((draft) => {
        let recoveredCount = 0;
        draft.operations = draft.operations.map((operation) => {
          const recovered = this.recoverExpiredOperationLease(operation, nowAt);
          if (recovered !== operation) {
            recoveredCount += 1;
          }
          return recovered;
        });
        return recoveredCount;
      });
    }

    return this.runPostgresCommitted(async () => {
      const client = await this.getPool().connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ payload: OperationRecord }>(
          `SELECT payload
           FROM operations
           WHERE payload->>'status' = 'RUNNING'
             AND COALESCE(NULLIF(payload->>'leaseExpiresAt', ''), '0001-01-01T00:00:00.000Z') <= $1
           FOR UPDATE`,
          [nowAt],
        );

        let recoveredCount = 0;
        for (const row of result.rows) {
          const recovered = this.recoverExpiredOperationLease(row.payload, nowAt);
          if (recovered === row.payload) {
            continue;
          }
          recoveredCount += 1;
          await this.updateOperationPayload(client, recovered);
          this.upsertOperationInMemory(recovered);
        }

        await client.query("COMMIT");
        return recoveredCount;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async acquireNextOperation(
    leaseOwner: string,
    leaseDurationMs: number,
    now: Date = new Date(),
  ): Promise<OperationRecord | null> {
    const nowAt = now.toISOString();

    if (this.storageMode !== "postgres") {
      return this.writeCommitted((draft) => {
        const candidate = this.findNextOperationCandidate(draft.operations, nowAt);
        if (!candidate) {
          return null;
        }

        const leased = this.prepareLeasedOperation(candidate.operation, leaseOwner, leaseDurationMs, nowAt);
        draft.operations[candidate.index] = leased;
        return this.cloneSnapshot(leased);
      });
    }

    return this.runPostgresCommitted(async () => {
      const client = await this.getPool().connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ id: string; payload: OperationRecord }>(
          `SELECT id, payload
           FROM operations
           WHERE (
             (
               payload->>'status' = 'QUEUED'
               AND (NULLIF(payload->>'runAfter', '') IS NULL OR payload->>'runAfter' <= $1)
             )
             OR (
               payload->>'status' = 'RUNNING'
               AND (NULLIF(payload->>'leaseExpiresAt', '') IS NULL OR payload->>'leaseExpiresAt' <= $1)
             )
           )
           AND COALESCE(NULLIF(payload->>'attemptCount', '')::int, 0)
             < COALESCE(NULLIF(payload->>'maxAttempts', '')::int, ${DEFAULT_OPERATION_MAX_ATTEMPTS})
           AND NOT EXISTS (
             SELECT 1
             FROM operations active
             WHERE active.id <> operations.id
               AND active.payload->>'storeId' = operations.payload->>'storeId'
               AND active.payload->>'operationType' = operations.payload->>'operationType'
               AND active.payload->>'status' = 'RUNNING'
               AND COALESCE(NULLIF(active.payload->>'leaseExpiresAt', ''), '0001-01-01T00:00:00.000Z') > $1
           )
           ORDER BY
             CASE WHEN payload->>'status' = 'RUNNING' THEN 0 ELSE 1 END,
             COALESCE(NULLIF(payload->>'runAfter', ''), payload->>'createdAt'),
             payload->>'createdAt',
             id
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
          [nowAt],
        );

        const row = result.rows[0];
        if (!row) {
          await client.query("COMMIT");
          return null;
        }

        const leased = this.prepareLeasedOperation(
          this.normalizeOperationRecord(row.payload),
          leaseOwner,
          leaseDurationMs,
          nowAt,
        );
        await this.updateOperationPayload(client, leased);
        await client.query("COMMIT");
        this.upsertOperationInMemory(leased);
        return this.cloneSnapshot(leased);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async heartbeatOperation(
    operationId: string,
    leaseOwner: string,
    leaseDurationMs: number,
    progressJson?: Record<string, unknown> | null,
    now: Date = new Date(),
  ): Promise<OperationRecord | null> {
    const heartbeatAt = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    return this.updateOperationRecord(operationId, leaseOwner, (operation) => ({
      ...operation,
      heartbeatAt,
      leaseExpiresAt,
      ...(progressJson !== undefined ? { progressJson } : {}),
    }));
  }

  async markOperationSucceeded(
    operationId: string,
    leaseOwner: string,
    resultJson: Record<string, unknown>,
    finishedAt: string = new Date().toISOString(),
  ): Promise<OperationRecord | null> {
    return this.updateOperationRecord(operationId, leaseOwner, (operation) => ({
      ...operation,
      status: "SUCCEEDED",
      resultJson,
      errorMessage: null,
      finishedAt,
      runAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    }));
  }

  async markOperationFailedOrQueued(
    operationId: string,
    leaseOwner: string,
    params: {
      errorMessage: string;
      shouldRetry: boolean;
      runAfter: string | null;
      finishedAt?: string;
    },
  ): Promise<OperationRecord | null> {
    return this.updateOperationRecord(operationId, leaseOwner, (operation) => {
      if (params.shouldRetry) {
        return {
          ...operation,
          status: "QUEUED",
          errorMessage: params.errorMessage,
          runAfter: params.runAfter,
          leaseOwner: null,
          leaseExpiresAt: null,
          finishedAt: null,
        };
      }

      return {
        ...operation,
        status: "FAILED",
        errorMessage: params.errorMessage,
        runAfter: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: params.finishedAt ?? new Date().toISOString(),
      };
    });
  }

  async deferOperationLease(
    operationId: string,
    leaseOwner: string,
    params: {
      runAfter: string;
      errorMessage: string;
      decrementAttempt?: boolean;
    },
  ): Promise<OperationRecord | null> {
    return this.updateOperationRecord(operationId, leaseOwner, (operation) => ({
      ...operation,
      status: "QUEUED",
      attemptCount: Math.max(
        0,
        operation.attemptCount - (params.decrementAttempt ? OPERATION_LOCK_BUSY_ATTEMPT_DECREMENT : 0),
      ),
      errorMessage: params.errorMessage,
      runAfter: params.runAfter,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: null,
    }));
  }

  async tryAcquireOperationExecutionLock(
    storeId: string,
    operationType: OperationType,
  ): Promise<OperationExecutionLock | null> {
    const lockName = `operation:${storeId}:${operationType}`;

    if (this.storageMode !== "postgres") {
      if (this.operationExecutionLocks.has(lockName)) {
        return null;
      }

      this.operationExecutionLocks.add(lockName);
      let released = false;
      return {
        lockName,
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          this.operationExecutionLocks.delete(lockName);
        },
      };
    }

    const client = await this.getPool().connect();
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [lockName],
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return null;
    }

    let released = false;
    return {
      lockName,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]);
        } finally {
          client.release();
        }
      },
    };
  }

  async queryOrderItems(query: OrderItemListQuery): Promise<PaginationResult<OrderItem>> {
    if (this.storageMode !== "postgres") {
      return this.queryOrderItemsFromSnapshot(query);
    }

    const pagination = normalizePagination(query.page, query.pageSize);
    const builder = createSqlBuilder();
    const fromClause = `
      FROM order_items items
      LEFT JOIN order_source_signatures signatures
        ON signatures.id = items.payload->>'orderSourceSignatureId'
    `;
    builder.addCondition("items.payload->>'storeId' = {param}", query.storeId);

    if (query.dateFrom && query.dateTo) {
      builder.addCondition("NULLIF(items.payload->>'paymentDate', '') IS NOT NULL");
      builder.addCondition("items.payload->>'paymentDate' >= {param}", query.dateFrom);
      builder.addCondition("items.payload->>'paymentDate' <= {param}", query.dateTo);
    }

    const keywordProduct = query.productName ? normalizeText(query.productName) : null;
    if (keywordProduct) {
      builder.addCondition("COALESCE(items.payload->>'normalizedProductName', '') LIKE {param} ESCAPE '\\'", likePattern(keywordProduct));
    }

    const keywordOption = query.optionInfo ? normalizeText(query.optionInfo) : null;
    if (keywordOption) {
      builder.addCondition("COALESCE(items.payload->>'normalizedOptionInfo', '') LIKE {param} ESCAPE '\\'", likePattern(keywordOption));
    }

    if (query.mappingStatus && query.mappingStatus !== "ALL") {
      builder.addCondition(`${orderItemMappingStatusSql("items", "signatures")} = {param}`, query.mappingStatus);
    }
    if (query.orderStatus) {
      builder.addCondition("items.payload->>'orderStatus' = {param}", query.orderStatus);
    }
    if (query.saleStatus) {
      builder.addCondition("items.payload->>'saleStatus' = {param}", query.saleStatus);
    }
    if (query.paymentDateStatus && query.paymentDateStatus !== "ALL") {
      builder.addCondition(
        query.paymentDateStatus === "PRESENT"
          ? "NULLIF(items.payload->>'paymentDate', '') IS NOT NULL"
          : "NULLIF(items.payload->>'paymentDate', '') IS NULL",
      );
    }

    const whereClause = builder.whereClause();
    const countQuery = builder.build(`SELECT COUNT(*)::int AS total_count ${fromClause} ${whereClause}`);
    const countResult = await this.getPool().query<{ total_count: number | string }>(
      countQuery.text,
      countQuery.params,
    );
    const totalCount = parsePgCount(countResult.rows[0]?.total_count);

    const itemsQuery = builder.buildPaginated(
      `SELECT items.payload
       ${fromClause}
       ${whereClause}
       ORDER BY COALESCE(items.payload->>'paymentDate', '') DESC, items.id ASC`,
      pagination,
    );
    const rows = await this.getPool().query<{ payload: OrderItem }>(itemsQuery.text, itemsQuery.params);

    return buildPaginationResult(
      rows.rows.map((row) => row.payload),
      totalCount,
      pagination,
    );
  }

  async queryAdCampaignSignatures(
    query: AdCampaignSignatureListQuery,
  ): Promise<PaginationResult<AdCampaignSignatureQueryItem>> {
    if (this.storageMode !== "postgres" || (query.q ? HANGUL_REGEX.test(query.q) : false)) {
      return this.queryAdCampaignSignaturesFromSnapshot(query);
    }

    const pagination = normalizePagination(query.page, query.pageSize);
    const builder = createSqlBuilder();
    const fromClause = `
      FROM ad_campaign_signatures signatures
      LEFT JOIN canonical_sales_units sales_units
        ON sales_units.id = signatures.payload->>'canonicalSalesUnitId'
    `;
    builder.addCondition("signatures.payload->>'storeId' = {param}", query.storeId);
    builder.addCondition(
      `EXISTS (
        SELECT 1
        FROM ad_campaign_daily_costs costs
        JOIN ad_excel_uploads uploads
          ON uploads.id = costs.payload->>'sourceUploadId'
        WHERE ${this.buildActiveAdCostPredicate(builder, "costs", "uploads", query)}
      )`,
    );

    if (query.mappingStatus && query.mappingStatus !== "ALL") {
      builder.addCondition(`${adCampaignMappingStatusSql("signatures")} = {param}`, query.mappingStatus);
    }

    const keyword = query.q ? normalizeText(query.q) : null;
    if (keyword) {
      const pattern = likePattern(keyword);
      const searchCostPredicate = this.buildActiveAdCostPredicate(builder, "search_costs", "search_uploads", query);
      const searchConditions = [
        `LOWER(COALESCE(signatures.payload->>'campaignNameSnapshot', '')) LIKE ${builder.addParam(pattern)} ESCAPE '\\'`,
        `LOWER(COALESCE(signatures.payload->>'normalizedCampaignName', '')) LIKE ${builder.addParam(pattern)} ESCAPE '\\'`,
        `LOWER(COALESCE(signatures.payload->>'campaignId', '')) LIKE ${builder.addParam(pattern)} ESCAPE '\\'`,
        `LOWER(COALESCE(sales_units.payload->>'displayName', '')) LIKE ${builder.addParam(pattern)} ESCAPE '\\'`,
        `LOWER(COALESCE(signatures.payload->>'mappingReason', '')) LIKE ${builder.addParam(pattern)} ESCAPE '\\'`,
        `LOWER(${adCampaignMappingReasonAliasSql("signatures")}) LIKE ${builder.addParam(pattern)} ESCAPE '\\'`,
        `LOWER(COALESCE(signatures.payload->>'reasonNote', '')) LIKE ${builder.addParam(pattern)} ESCAPE '\\'`,
        `LOWER(COALESCE(signatures.payload->>'firstSeenDate', '')) LIKE ${builder.addParam(pattern)} ESCAPE '\\'`,
        `LOWER(COALESCE(signatures.payload->>'lastSeenDate', '')) LIKE ${builder.addParam(pattern)} ESCAPE '\\'`,
        `EXISTS (
          SELECT 1
          FROM ad_campaign_daily_costs search_costs
          JOIN ad_excel_uploads search_uploads
            ON search_uploads.id = search_costs.payload->>'sourceUploadId'
          WHERE ${searchCostPredicate}
            AND LOWER(COALESCE(search_costs.payload->>'reportDate', '')) LIKE ${builder.addParam(pattern)} ESCAPE '\\'
        )`,
      ];
      builder.addCondition(`(${searchConditions.join(" OR ")})`);
    }

    const whereClause = builder.whereClause();
    const countQuery = builder.build(`SELECT COUNT(*)::int AS total_count ${fromClause} ${whereClause}`);
    const countResult = await this.getPool().query<{ total_count: number | string }>(
      countQuery.text,
      countQuery.params,
    );
    const totalCount = parsePgCount(countResult.rows[0]?.total_count);

    const summaryPredicate = this.buildActiveAdCostPredicate(builder, "summary_costs", "summary_uploads", query);
    const itemsQuery = builder.buildPaginated(
      `SELECT signatures.payload AS signature_payload,
              summary.latest_row_payload,
              COALESCE(summary.total_cost, 0)::float8 AS total_cost,
              COALESCE(summary.row_count, 0)::int AS row_count
       ${fromClause}
       LEFT JOIN LATERAL (
         SELECT SUM(COALESCE((summary_costs.payload->>'totalCost')::numeric, 0)) AS total_cost,
                COUNT(*)::int AS row_count,
                (ARRAY_AGG(summary_costs.payload ORDER BY summary_costs.payload->>'reportDate' DESC, summary_costs.payload->>'updatedAt' DESC))[1] AS latest_row_payload
         FROM ad_campaign_daily_costs summary_costs
         JOIN ad_excel_uploads summary_uploads
           ON summary_uploads.id = summary_costs.payload->>'sourceUploadId'
         WHERE ${summaryPredicate}
       ) summary ON TRUE
       ${whereClause}
       ORDER BY COALESCE(NULLIF(signatures.payload->>'lastSeenDate', ''), signatures.payload->>'updatedAt') DESC,
                signatures.id ASC`,
      pagination,
    );
    const rows = await this.getPool().query<{
      signature_payload: AdCampaignSignature;
      latest_row_payload: AdCampaignDailyCost | null;
      total_cost: number | string | null;
      row_count: number | string | null;
    }>(itemsQuery.text, itemsQuery.params);

    return buildPaginationResult(
      rows.rows.map((row) => ({
        signature: row.signature_payload,
        latestRow: row.latest_row_payload ?? null,
        totalCost: Number(row.total_cost ?? 0),
        rowCount: parsePgCount(row.row_count),
      })),
      totalCount,
      pagination,
    );
  }

  private queryOperationsFromSnapshot(query: OperationListQuery): PaginationResult<OperationRecord> {
    const items = this.database.operations
      .map((item) => this.normalizeOperationRecord(item))
      .filter((item) => item.storeId === query.storeId)
      .filter((item) => (query.status ? item.status === query.status : true))
      .filter((item) => (query.operationType ? item.operationType === query.operationType : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return paginate(items, query.page, query.pageSize);
  }

  private queryOrderItemsFromSnapshot(query: OrderItemListQuery): PaginationResult<OrderItem> {
    const keywordProduct = query.productName ? normalizeText(query.productName) : null;
    const keywordOption = query.optionInfo ? normalizeText(query.optionInfo) : null;
    const items = this.database.orderItems
      .filter((item) => item.storeId === query.storeId)
      .filter((item) =>
        query.dateFrom && query.dateTo
          ? !!item.paymentDate && item.paymentDate >= query.dateFrom && item.paymentDate <= query.dateTo
          : true,
      )
      .filter((item) => (keywordProduct ? item.normalizedProductName.includes(keywordProduct) : true))
      .filter((item) => (keywordOption ? item.normalizedOptionInfo.includes(keywordOption) : true))
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
  }

  private queryAdCampaignSignaturesFromSnapshot(
    query: AdCampaignSignatureListQuery,
  ): PaginationResult<AdCampaignSignatureQueryItem> {
    const activeUploadIds = getActiveConfirmedUploadIds(this.database, query.storeId);
    const keyword = query.q ? normalizeText(query.q) : null;
    const rowsBySignatureId = new Map<string, AdCampaignDailyCost[]>();
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
        const reasonNote = repairMojibakeText(signature.reasonNote);
        const mappingReasonAlias = toDisplayMappingReasonAlias(signature.mappingReason);
        return (
          normalizeText(signature.campaignNameSnapshot).includes(keyword) ||
          normalizeText(repairMojibakeText(signature.campaignNameSnapshot)).includes(keyword) ||
          normalizeText(signature.normalizedCampaignName).includes(keyword) ||
          normalizeText(signature.campaignId ?? "").includes(keyword) ||
          normalizeText(salesUnitDisplayName).includes(keyword) ||
          normalizeText(signature.mappingReason).includes(keyword) ||
          normalizeText(mappingReasonAlias).includes(keyword) ||
          normalizeText(reasonNote).includes(keyword) ||
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
  }

  private buildActiveAdCostPredicate(
    builder: ReturnType<typeof createSqlBuilder>,
    costAlias: string,
    uploadAlias: string,
    query: Pick<AdCampaignSignatureListQuery, "dateFrom" | "dateTo">,
  ): string {
    const conditions = [
      `${costAlias}.payload->>'adCampaignSignatureId' = signatures.id`,
      `${costAlias}.payload->>'storeId' = signatures.payload->>'storeId'`,
      `${uploadAlias}.payload->>'storeId' = signatures.payload->>'storeId'`,
      `(${uploadAlias}.payload->>'isActive')::boolean IS TRUE`,
      `${uploadAlias}.payload->>'weekdayValidationStatus' = 'PASSED'`,
      `${uploadAlias}.payload->>'state' = 'CONFIRMED'`,
    ];

    if (query.dateFrom) {
      conditions.push(`${costAlias}.payload->>'reportDate' >= ${builder.addParam(query.dateFrom)}`);
    }
    if (query.dateTo) {
      conditions.push(`${costAlias}.payload->>'reportDate' <= ${builder.addParam(query.dateTo)}`);
    }

    return conditions.join(" AND ");
  }

  /**
   * Returns the live snapshot reference. **MUST NOT be mutated by callers.**
   * Use `write(mutator)` for any change.
   */
  getSnapshot(): DatabaseShape {
    return this.database;
  }

  write<T>(mutator: (draft: DatabaseShape) => T): T {
    const draft = this.cloneSnapshot(this.database);
    const result = mutator(draft);

    if (this.storageMode === "postgres") {
      this.database = draft;
      this.queuePostgresPersistence(draft);
      return result;
    }

    this.persistSnapshotToFileWithStatus(draft);
    this.database = draft;
    return result;
  }

  async writeCommitted<T>(mutator: (draft: DatabaseShape) => T): Promise<T> {
    this.pendingWriteCount += 1;

    const operation = this.persistenceQueue
      .catch(() => undefined)
      .then(async () => {
        const draft = this.cloneSnapshot(this.database);
        const result = mutator(draft);
        await this.persistSnapshotWithStatus(draft);
        this.database = draft;
        return result;
      });

    this.persistenceQueue = operation
      .then(() => undefined, () => undefined)
      .finally(() => {
        this.pendingWriteCount -= 1;
      });

    return operation;
  }

  async createCanonicalSalesUnitCommitted(params: {
    salesUnit: CanonicalSalesUnit;
    auditLog?: DatabaseShape["auditLogs"][number] | null;
  }): Promise<CanonicalSalesUnitCreateCommitResult> {
    if (this.storageMode !== "postgres") {
      return this.writeCommitted((draft) => {
        const existingStore = draft.stores.find((store) => store.id === params.salesUnit.storeId);
        if (!existingStore) {
          throw new Error("STORE_NOT_FOUND");
        }
        draft.canonicalSalesUnits.push(this.cloneSnapshot(params.salesUnit));
        if (params.auditLog) {
          draft.auditLogs.push(this.cloneSnapshot(params.auditLog));
        }
        return { salesUnit: this.cloneSnapshot(params.salesUnit) };
      });
    }

    return this.runPostgresCommitted(async () => {
      const client = await this.getPool().connect();
      try {
        await client.query("BEGIN");
        const storeResult = await client.query("SELECT id FROM stores WHERE id = $1 FOR UPDATE", [
          params.salesUnit.storeId,
        ]);
        if (storeResult.rows.length === 0) {
          throw new Error("STORE_NOT_FOUND");
        }

        await this.upsertTableRows(
          client,
          { key: "canonicalSalesUnits", tableName: "canonical_sales_units" },
          [params.salesUnit],
        );
        if (params.auditLog) {
          await this.upsertTableRows(client, { key: "auditLogs", tableName: "audit_logs" }, [params.auditLog]);
        }
        await client.query("COMMIT");

        this.upsertCanonicalSalesUnitInSnapshot(this.database, params.salesUnit);
        if (params.auditLog) {
          this.upsertAuditLogInSnapshot(this.database, params.auditLog);
        }

        return { salesUnit: this.cloneSnapshot(params.salesUnit) };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async saveOrderManualMappingsCommitted(params: {
    storeId: string;
    signatureIds: string[];
    canonicalSalesUnitId: string;
    timestamp: string;
  }): Promise<OrderManualMappingCommitResult> {
    const signatureIds = this.normalizeCommittedIdList(params.signatureIds);
    if (signatureIds.length === 0) {
      return { signatureIds, updatedOrderItemCount: 0, affectedDates: [] };
    }

    if (this.storageMode !== "postgres") {
      return this.writeCommitted((draft) =>
        this.applyOrderManualMappingsToSnapshot(draft, {
          ...params,
          signatureIds,
        }),
      );
    }

    return this.runPostgresCommitted(async () => {
      const client = await this.getPool().connect();
      try {
        await client.query("BEGIN");
        const signatureResult = await client.query<{ id: string; payload: OrderSourceSignature }>(
          `SELECT id, payload
           FROM order_source_signatures
           WHERE id = ANY($1::text[])
             AND payload->>'storeId' = $2
           FOR UPDATE`,
          [signatureIds, params.storeId],
        );

        if (signatureResult.rows.length !== signatureIds.length) {
          throw new Error("ORDER_MANUAL_MAPPING_TARGET_NOT_FOUND");
        }

        const itemResult = await client.query<{ id: string; payload: OrderItem }>(
          `SELECT id, payload
           FROM order_items
           WHERE payload->>'storeId' = $1
             AND payload->>'orderSourceSignatureId' = ANY($2::text[])
           FOR UPDATE`,
          [params.storeId, signatureIds],
        );

        const targetIdSet = new Set(signatureIds);
        const updatedSignatures = signatureResult.rows.map((row) => {
          const signature = this.cloneSnapshot(row.payload);
          if (!targetIdSet.has(signature.id) || signature.storeId !== params.storeId) {
            throw new Error("ORDER_MANUAL_MAPPING_SCOPE_MISMATCH");
          }
          return this.applyOrderManualMappingToSignature(signature, params);
        });
        const updatedOrderItems = itemResult.rows.map((row) => {
          const item = this.cloneSnapshot(row.payload);
          if (
            item.storeId !== params.storeId ||
            !item.orderSourceSignatureId ||
            !targetIdSet.has(item.orderSourceSignatureId)
          ) {
            throw new Error("ORDER_MANUAL_MAPPING_SCOPE_MISMATCH");
          }
          return this.applyOrderManualMappingToItem(item, params);
        });

        await this.updateTableRowsPayloads(client, "order_source_signatures", updatedSignatures);
        await this.updateTableRowsPayloads(client, "order_items", updatedOrderItems);
        await client.query("COMMIT");

        this.upsertOrderManualMappingRowsInSnapshot(this.database, {
          signatures: updatedSignatures,
          orderItems: updatedOrderItems,
        });

        return {
          signatureIds,
          updatedOrderItemCount: updatedOrderItems.length,
          affectedDates: this.collectAffectedPaymentDates(updatedOrderItems),
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async saveAdCampaignMappingsCommitted(params: {
    storeId: string;
    targetIds: string[];
    action: AdCampaignMappingCommitAction;
  }): Promise<AdCampaignMappingCommitResult> {
    const targetIds = this.normalizeCommittedIdList(params.targetIds);
    if (targetIds.length === 0) {
      return { signatureIds: [], updatedAdCampaignDailyCostCount: 0, affectedDates: [] };
    }

    if (this.storageMode !== "postgres") {
      return this.writeCommitted((draft) =>
        this.applyAdCampaignMappingsToSnapshot(draft, {
          ...params,
          targetIds,
        }),
      );
    }

    return this.runPostgresCommitted(async () => {
      const client = await this.getPool().connect();
      try {
        await client.query("BEGIN");

        const targetSignatureResult = await client.query<{ id: string; payload: AdCampaignSignature }>(
          `SELECT id, payload
           FROM ad_campaign_signatures
           WHERE id = ANY($1::text[])
             AND payload->>'storeId' = $2
           FOR UPDATE`,
          [targetIds, params.storeId],
        );
        const targetRowResult = await client.query<{ id: string; payload: AdCampaignDailyCost }>(
          `SELECT id, payload
           FROM ad_campaign_daily_costs
           WHERE id = ANY($1::text[])
             AND payload->>'storeId' = $2
           FOR UPDATE`,
          [targetIds, params.storeId],
        );

        const foundTargetIds = new Set([
          ...targetSignatureResult.rows.map((row) => row.id),
          ...targetRowResult.rows.map((row) => row.id),
        ]);
        if (targetIds.some((id) => !foundTargetIds.has(id))) {
          throw new Error("AD_CAMPAIGN_MAPPING_TARGET_NOT_FOUND");
        }

        const working = this.createAdCampaignMappingWorkingSnapshot({
          storeId: params.storeId,
          signatures: targetSignatureResult.rows.map((row) => this.cloneSnapshot(row.payload)),
          rows: targetRowResult.rows.map((row) => this.cloneSnapshot(row.payload)),
        });
        const initiallyUnlinkedTargetRowIds = new Set(
          targetRowResult.rows
            .filter((row) => !row.payload.adCampaignSignatureId)
            .map((row) => row.id),
        );
        const materializedSignatureIds = this.materializeAdCampaignSignatureIdsInSnapshot(
          working,
          params.storeId,
          targetIds,
        );
        const materializedSignatureIdByInitiallyUnlinkedRowId = this.collectAdCampaignRowSignatureIds(
          working,
          initiallyUnlinkedTargetRowIds,
        );
        const lockedSignatureIds = new Set(targetSignatureResult.rows.map((row) => row.id));
        const unlockedMaterializedSignatureIds = Array.from(materializedSignatureIds).filter(
          (signatureId) => !lockedSignatureIds.has(signatureId),
        );
        const existingMaterializedSignatureIds = new Set(targetSignatureResult.rows.map((row) => row.id));
        if (unlockedMaterializedSignatureIds.length > 0) {
          const materializedSignatureResult = await client.query<{ id: string; payload: AdCampaignSignature }>(
            `SELECT id, payload
             FROM ad_campaign_signatures
             WHERE id = ANY($1::text[])
               AND payload->>'storeId' = $2
            FOR UPDATE`,
            [unlockedMaterializedSignatureIds, params.storeId],
          );
          materializedSignatureResult.rows.forEach((row) => existingMaterializedSignatureIds.add(row.id));
          this.replaceAdCampaignSignaturesInWorkingSnapshot(
            working,
            materializedSignatureResult.rows.map((row) => this.cloneSnapshot(row.payload)),
          );
        }
        const signatureIds = Array.from(materializedSignatureIds);

        const relatedRowResult = await client.query<{ id: string; payload: AdCampaignDailyCost }>(
          `SELECT id, payload
           FROM ad_campaign_daily_costs
           WHERE payload->>'storeId' = $1
             AND (
               payload->>'adCampaignSignatureId' = ANY($2::text[])
               OR id = ANY($3::text[])
             )
           FOR UPDATE`,
          [params.storeId, signatureIds, targetIds],
        );
        this.replaceAdCampaignRowsInWorkingSnapshot(
          working,
          relatedRowResult.rows.map((row) => this.cloneSnapshot(row.payload)),
        );
        this.reapplyAdCampaignMaterializationSideEffects(working, {
          storeId: params.storeId,
          materializedSignatureIdByRowId: materializedSignatureIdByInitiallyUnlinkedRowId,
          signatureIds: existingMaterializedSignatureIds,
        });
        this.materializeAdCampaignSignatureIdsInSnapshot(working, params.storeId, targetIds);

        const commitResult = this.applyAdCampaignMappingsToSnapshot(working, {
          ...params,
          targetIds,
        });
        const touchedCanonicalSalesUnits = this.collectNewCanonicalSalesUnits(working);
        const updatedSignatures = working.adCampaignSignatures.filter((signature) =>
          commitResult.signatureIds.includes(signature.id),
        );
        const updatedRows = working.adCampaignDailyCosts.filter(
          (row) => row.adCampaignSignatureId && commitResult.signatureIds.includes(row.adCampaignSignatureId),
        );

        await this.upsertTableRows(
          client,
          { key: "adCampaignSignatures", tableName: "ad_campaign_signatures" },
          updatedSignatures,
        );
        await this.updateTableRowsPayloads(client, "ad_campaign_daily_costs", updatedRows);
        if (touchedCanonicalSalesUnits.length > 0) {
          await this.upsertTableRows(
            client,
            { key: "canonicalSalesUnits", tableName: "canonical_sales_units" },
            touchedCanonicalSalesUnits,
          );
        }
        await client.query("COMMIT");

        this.upsertAdCampaignMappingRowsInSnapshot(this.database, {
          signatures: updatedSignatures,
          adCampaignDailyCosts: updatedRows,
          canonicalSalesUnits: touchedCanonicalSalesUnits,
        });

        return commitResult;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async replaceDailyProfitSummariesCommitted<T>(params: {
    storeId: string;
    dates: string[];
    buildReplacement: (database: DatabaseShape) => DailyProfitSummaryReplacementResult<T>;
  }): Promise<T | null> {
    const dates = this.normalizeCommittedDateList(params.dates);
    if (dates.length === 0) {
      return null;
    }

    if (this.storageMode !== "postgres") {
      return this.writeCommitted((draft) => {
        const replacement = this.buildDailyProfitSummaryReplacement(draft, {
          storeId: params.storeId,
          dates,
          buildReplacement: params.buildReplacement,
        });
        this.replaceDailyProfitSummaryRowsInSnapshot(draft, {
          storeId: params.storeId,
          dates,
          dailySalesUnitProfits: replacement.dailySalesUnitProfits,
          dailyStoreSummaries: replacement.dailyStoreSummaries,
        });
        return replacement.result;
      });
    }

    return this.runPostgresCommitted(async () => {
      const replacement = this.buildDailyProfitSummaryReplacement(this.database, {
        storeId: params.storeId,
        dates,
        buildReplacement: params.buildReplacement,
      });
      const client = await this.getPool().connect();
      try {
        await client.query("BEGIN");
        await this.deleteDailyProfitSummaryRowsFromPostgres(client, params.storeId, dates);
        await this.upsertTableRows(
          client,
          { key: "dailySalesUnitProfits", tableName: "daily_sales_unit_profits" },
          replacement.dailySalesUnitProfits,
        );
        await this.upsertTableRows(
          client,
          { key: "dailyStoreSummaries", tableName: "daily_store_summaries" },
          replacement.dailyStoreSummaries,
        );
        await client.query("COMMIT");
        this.replaceDailyProfitSummaryRowsInSnapshot(this.database, {
          storeId: params.storeId,
          dates,
          dailySalesUnitProfits: replacement.dailySalesUnitProfits,
          dailyStoreSummaries: replacement.dailyStoreSummaries,
        });
        return replacement.result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async removeDailyProfitSummariesCommitted(params: { storeId: string; dates: string[] }): Promise<void> {
    const dates = this.normalizeCommittedDateList(params.dates);
    if (dates.length === 0) {
      return;
    }

    if (this.storageMode !== "postgres") {
      await this.writeCommitted((draft) => {
        this.removeDailyProfitSummaryRowsFromSnapshot(draft, params.storeId, dates);
      });
      return;
    }

    await this.runPostgresCommitted(async () => {
      const client = await this.getPool().connect();
      try {
        await client.query("BEGIN");
        await this.deleteDailyProfitSummaryRowsFromPostgres(client, params.storeId, dates);
        await client.query("COMMIT");
        this.removeDailyProfitSummaryRowsFromSnapshot(this.database, params.storeId, dates);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  private async runPostgresCommitted<T>(operationFactory: () => Promise<T>): Promise<T> {
    this.pendingWriteCount += 1;

    const operation = this.persistenceQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          const result = await operationFactory();
          this.lastPersistenceError = null;
          return result;
        } catch (error) {
          this.recordPersistenceError(error);
          throw error;
        }
      });

    this.persistenceQueue = operation
      .then(() => undefined, () => undefined)
      .finally(() => {
        this.pendingWriteCount -= 1;
      });

    return operation;
  }

  private async updateOperationRecord(
    operationId: string,
    leaseOwner: string,
    mutator: (operation: OperationRecord) => OperationRecord | null,
  ): Promise<OperationRecord | null> {
    if (this.storageMode !== "postgres") {
      return this.writeCommitted((draft) => {
        const index = draft.operations.findIndex((operation) => operation.id === operationId);
        if (index === -1) {
          return null;
        }

        const current = this.normalizeOperationRecord(draft.operations[index]);
        if (current.leaseOwner !== leaseOwner) {
          return null;
        }

        const next = mutator(current);
        if (!next) {
          return null;
        }

        draft.operations[index] = next;
        return this.cloneSnapshot(next);
      });
    }

    return this.runPostgresCommitted(async () => {
      const client = await this.getPool().connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ payload: OperationRecord }>(
          "SELECT payload FROM operations WHERE id = $1 FOR UPDATE",
          [operationId],
        );
        const row = result.rows[0];
        if (!row) {
          await client.query("COMMIT");
          return null;
        }

        const current = this.normalizeOperationRecord(row.payload);
        if (current.leaseOwner !== leaseOwner) {
          await client.query("COMMIT");
          return null;
        }

        const next = mutator(current);
        if (!next) {
          await client.query("COMMIT");
          return null;
        }

        await this.updateOperationPayload(client, next);
        await client.query("COMMIT");
        this.upsertOperationInMemory(next);
        return this.cloneSnapshot(next);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  private resolveDataDir(): string {
    if (process.env.DATA_DIR) {
      const configured = process.env.DATA_DIR;
      if (isAbsolute(configured)) {
        return configured;
      }

      const cwd = process.cwd();
      const normalized = configured.replace(/^[.][\\/]/, "").replace(/\\/g, "/");
      if (basename(cwd) === "backend" && normalized.startsWith("apps/backend/")) {
        return resolve(cwd, "..", "..", configured);
      }
      return resolve(cwd, configured);
    }

    const cwd = process.cwd();
    if (basename(cwd) === "backend") {
      return resolve(cwd, "data");
    }

    return resolve(cwd, "apps", "backend", "data");
  }

  private ensureFileStorageReady() {
    this.ensureFileStorageDirectory();
    if (!existsSync(this.filePath)) {
      this.persistSnapshotToFile(createEmptyDatabase());
    }
  }

  private ensureFileStorageDirectory() {
    const folder = dirname(this.filePath);
    if (!existsSync(folder)) {
      mkdirSync(folder, { recursive: true });
    }
  }

  private loadSnapshotFromFile(): DatabaseShape {
    return this.normalizeSnapshot(JSON.parse(readFileSync(this.filePath, "utf-8")) as DatabaseShape);
  }

  private cloneSnapshot<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private findNextOperationCandidate(
    operations: OperationRecord[],
    nowAt: string,
  ): { index: number; operation: OperationRecord } | null {
    const normalized = operations.map((operation, index) => ({
      index,
      operation: this.normalizeOperationRecord(operation),
    }));
    const candidates = normalized
      .filter(({ operation }) => this.isOperationRunnable(operation, nowAt))
      .filter(
        ({ operation }) =>
          !normalized.some(
            ({ operation: active }) =>
              active.id !== operation.id &&
              active.storeId === operation.storeId &&
              active.operationType === operation.operationType &&
              active.status === "RUNNING" &&
              !this.isOperationLeaseExpired(active, nowAt),
          ),
      )
      .sort((left, right) => this.compareOperationCandidates(left.operation, right.operation));

    return candidates[0] ?? null;
  }

  private isOperationRunnable(operation: OperationRecord, nowAt: string): boolean {
    if (operation.attemptCount >= operation.maxAttempts) {
      return false;
    }

    if (operation.status === "QUEUED") {
      return !operation.runAfter || operation.runAfter <= nowAt;
    }

    return operation.status === "RUNNING" && this.isOperationLeaseExpired(operation, nowAt);
  }

  private isOperationLeaseExpired(operation: OperationRecord, nowAt: string): boolean {
    return !operation.leaseExpiresAt || operation.leaseExpiresAt <= nowAt;
  }

  private compareOperationCandidates(left: OperationRecord, right: OperationRecord): number {
    const leftStaleRank = left.status === "RUNNING" ? 0 : 1;
    const rightStaleRank = right.status === "RUNNING" ? 0 : 1;
    if (leftStaleRank !== rightStaleRank) {
      return leftStaleRank - rightStaleRank;
    }

    const leftRunAt = left.runAfter ?? left.createdAt;
    const rightRunAt = right.runAfter ?? right.createdAt;
    return (
      leftRunAt.localeCompare(rightRunAt) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
    );
  }

  private prepareLeasedOperation(
    operation: OperationRecord,
    leaseOwner: string,
    leaseDurationMs: number,
    nowAt: string,
  ): OperationRecord {
    const nowMs = Date.parse(nowAt);
    return {
      ...this.normalizeOperationRecord(operation),
      status: "RUNNING",
      attemptCount: Math.max(0, operation.attemptCount ?? 0) + 1,
      errorMessage: null,
      heartbeatAt: nowAt,
      leaseOwner,
      leaseExpiresAt: new Date(nowMs + leaseDurationMs).toISOString(),
      lockedAt: nowAt,
      runAfter: null,
      startedAt: operation.startedAt ?? nowAt,
      finishedAt: null,
    };
  }

  private recoverExpiredOperationLease(
    operation: OperationRecord,
    nowAt: string,
  ): OperationRecord {
    const current = this.normalizeOperationRecord(operation);
    if (current.status !== "RUNNING" || !this.isOperationLeaseExpired(current, nowAt)) {
      return operation;
    }

    if (current.attemptCount >= current.maxAttempts) {
      return {
        ...current,
        status: "FAILED",
        errorMessage: current.errorMessage ?? "OPERATION_LEASE_EXPIRED",
        runAfter: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: nowAt,
      };
    }

    return {
      ...current,
      status: "QUEUED",
      errorMessage: "OPERATION_LEASE_EXPIRED",
      runAfter: nowAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: null,
    };
  }

  private async updateOperationPayload(client: Pool | PoolClient, operation: OperationRecord) {
    await client.query(
      `UPDATE operations
       SET payload = $2::jsonb,
           payload_hash = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [operation.id, JSON.stringify(operation), hashPayload(operation)],
    );
  }

  private upsertOperationInMemory(operation: OperationRecord) {
    const normalized = this.normalizeOperationRecord(operation);
    const index = this.database.operations.findIndex((item) => item.id === normalized.id);
    if (index === -1) {
      this.database.operations.push(this.cloneSnapshot(normalized));
      return;
    }
    this.database.operations[index] = this.cloneSnapshot(normalized);
  }

  private normalizeCommittedIdList(ids: string[]): string[] {
    return Array.from(new Set(ids.filter(Boolean)));
  }

  private applyOrderManualMappingsToSnapshot(
    snapshot: DatabaseShape,
    params: {
      storeId: string;
      signatureIds: string[];
      canonicalSalesUnitId: string;
      timestamp: string;
    },
  ): OrderManualMappingCommitResult {
    const targetIdSet = new Set(params.signatureIds);
    const signatures = params.signatureIds.map((signatureId) =>
      snapshot.orderSourceSignatures.find((item) => item.id === signatureId),
    );
    if (signatures.some((signature) => !signature || signature.storeId !== params.storeId)) {
      throw new Error("ORDER_MANUAL_MAPPING_TARGET_NOT_FOUND");
    }

    signatures.forEach((signature) => {
      this.applyOrderManualMappingToSignature(signature!, params);
    });

    const updatedOrderItems: OrderItem[] = [];
    snapshot.orderItems.forEach((item) => {
      if (
        item.storeId !== params.storeId ||
        !item.orderSourceSignatureId ||
        !targetIdSet.has(item.orderSourceSignatureId)
      ) {
        return;
      }
      this.applyOrderManualMappingToItem(item, params);
      updatedOrderItems.push(item);
    });

    return {
      signatureIds: params.signatureIds,
      updatedOrderItemCount: updatedOrderItems.length,
      affectedDates: this.collectAffectedPaymentDates(updatedOrderItems),
    };
  }

  private applyOrderManualMappingToSignature(
    signature: OrderSourceSignature,
    params: { canonicalSalesUnitId: string; timestamp: string },
  ): OrderSourceSignature {
    signature.canonicalSalesUnitId = params.canonicalSalesUnitId;
    signature.mappingStatus = "MAPPED";
    signature.confirmedAt = params.timestamp;
    signature.updatedAt = params.timestamp;
    return signature;
  }

  private applyOrderManualMappingToItem(
    item: OrderItem,
    params: { canonicalSalesUnitId: string; timestamp: string },
  ): OrderItem {
    item.canonicalSalesUnitId = params.canonicalSalesUnitId;
    item.updatedAt = params.timestamp;
    return item;
  }

  private collectAffectedPaymentDates(orderItems: OrderItem[]): string[] {
    return Array.from(new Set(orderItems.map((item) => item.paymentDate).filter((date): date is string => Boolean(date))))
      .sort((left, right) => left.localeCompare(right));
  }

  private upsertOrderManualMappingRowsInSnapshot(
    snapshot: DatabaseShape,
    params: {
      signatures: OrderSourceSignature[];
      orderItems: OrderItem[];
    },
  ): void {
    params.signatures.forEach((signature) => {
      const index = snapshot.orderSourceSignatures.findIndex((item) => item.id === signature.id);
      if (index === -1) {
        snapshot.orderSourceSignatures.push(this.cloneSnapshot(signature));
        return;
      }
      Object.assign(snapshot.orderSourceSignatures[index], this.cloneSnapshot(signature));
    });

    params.orderItems.forEach((orderItem) => {
      const index = snapshot.orderItems.findIndex((item) => item.id === orderItem.id);
      if (index === -1) {
        snapshot.orderItems.push(this.cloneSnapshot(orderItem));
        return;
      }
      Object.assign(snapshot.orderItems[index], this.cloneSnapshot(orderItem));
    });
  }

  private applyAdCampaignMappingsToSnapshot(
    snapshot: DatabaseShape,
    params: {
      storeId: string;
      targetIds: string[];
      action: AdCampaignMappingCommitAction;
    },
  ): AdCampaignMappingCommitResult {
    const signatureIds = this.materializeAdCampaignSignatureIdsInSnapshot(
      snapshot,
      params.storeId,
      params.targetIds,
    );
    const targetSignatureIdSet = new Set(signatureIds);

    const action = params.action;
    if (action.type === "RECALCULATE") {
      recalculateAdCampaignSignaturesForStore(snapshot, params.storeId, {
        signatureIds: targetSignatureIdSet,
        applyToRows: true,
      });
    } else {
      snapshot.adCampaignSignatures.forEach((signature) => {
        if (!targetSignatureIdSet.has(signature.id)) {
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
      applyAdCampaignSignatureToRows(snapshot, {
        storeId: params.storeId,
        signatureIds: targetSignatureIdSet,
      });
    }

    const updatedRows = snapshot.adCampaignDailyCosts.filter(
      (row) => row.storeId === params.storeId && row.adCampaignSignatureId && targetSignatureIdSet.has(row.adCampaignSignatureId),
    );

    return {
      signatureIds: Array.from(targetSignatureIdSet),
      updatedAdCampaignDailyCostCount: updatedRows.length,
      affectedDates: this.collectAffectedAdReportDates(updatedRows),
    };
  }

  private materializeAdCampaignSignatureIdsInSnapshot(
    snapshot: DatabaseShape,
    storeId: string,
    ids: string[],
  ): Set<string> {
    const directSignatureIds = new Set(
      ids.filter((id) =>
        snapshot.adCampaignSignatures.some((signature) => signature.id === id && signature.storeId === storeId),
      ),
    );
    const rowIds = ids.filter((id) =>
      snapshot.adCampaignDailyCosts.some((row) => row.id === id && row.storeId === storeId),
    );
    const materializedFromRows = ensureAdCampaignSignaturesForStore(snapshot, storeId, rowIds);

    snapshot.adCampaignDailyCosts.forEach((row) => {
      if (row.storeId === storeId && rowIds.includes(row.id) && row.adCampaignSignatureId) {
        materializedFromRows.add(row.adCampaignSignatureId);
      }
    });

    return new Set([...directSignatureIds, ...materializedFromRows]);
  }

  private createAdCampaignMappingWorkingSnapshot(params: {
    storeId: string;
    signatures: AdCampaignSignature[];
    rows: AdCampaignDailyCost[];
  }): DatabaseShape {
    const snapshot = createEmptyDatabase();
    snapshot.stores = this.database.stores
      .filter((store) => store.id === params.storeId)
      .map((store) => this.cloneSnapshot(store));
    snapshot.canonicalSalesUnits = this.database.canonicalSalesUnits
      .filter((salesUnit) => salesUnit.storeId === params.storeId)
      .map((salesUnit) => this.cloneSnapshot(salesUnit));
    snapshot.campaignMappings = this.database.campaignMappings
      .filter((mapping) => mapping.storeId === params.storeId)
      .map((mapping) => this.cloneSnapshot(mapping));

    const signatureById = new Map<string, AdCampaignSignature>();
    params.signatures.forEach((signature) => signatureById.set(signature.id, this.cloneSnapshot(signature)));
    const rowSignatureIds = new Set(
      params.rows.map((row) => row.adCampaignSignatureId).filter((id): id is string => Boolean(id)),
    );
    const rowSignatureKeys = new Set(params.rows.map((row) => this.getAdCampaignRowSignatureKey(row)));
    this.database.adCampaignSignatures.forEach((signature) => {
      if (
        signature.storeId === params.storeId &&
        (rowSignatureIds.has(signature.id) || rowSignatureKeys.has(this.getAdCampaignSignatureKey(signature)))
      ) {
        signatureById.set(signature.id, this.cloneSnapshot(signature));
      }
    });

    snapshot.adCampaignSignatures = Array.from(signatureById.values());
    snapshot.adCampaignDailyCosts = params.rows.map((row) => this.cloneSnapshot(row));
    return snapshot;
  }

  private replaceAdCampaignRowsInWorkingSnapshot(
    snapshot: DatabaseShape,
    rows: AdCampaignDailyCost[],
  ): void {
    const materializedSignatureIdsByRowId = new Map(
      snapshot.adCampaignDailyCosts
        .filter((row) => row.adCampaignSignatureId)
        .map((row) => [row.id, row.adCampaignSignatureId!]),
    );

    snapshot.adCampaignDailyCosts = rows.map((row) => {
      const next = this.cloneSnapshot(row);
      next.adCampaignSignatureId = next.adCampaignSignatureId ?? materializedSignatureIdsByRowId.get(next.id) ?? null;
      return next;
    });
  }

  private replaceAdCampaignSignaturesInWorkingSnapshot(
    snapshot: DatabaseShape,
    signatures: AdCampaignSignature[],
  ): void {
    signatures.forEach((signature) => {
      const index = snapshot.adCampaignSignatures.findIndex((item) => item.id === signature.id);
      if (index === -1) {
        snapshot.adCampaignSignatures.push(this.cloneSnapshot(signature));
        return;
      }
      snapshot.adCampaignSignatures[index] = this.cloneSnapshot(signature);
    });
  }

  private collectAdCampaignRowSignatureIds(
    snapshot: DatabaseShape,
    rowIds: Set<string>,
  ): Map<string, string> {
    const signatureIdsByRowId = new Map<string, string>();
    snapshot.adCampaignDailyCosts.forEach((row) => {
      if (rowIds.has(row.id) && row.adCampaignSignatureId) {
        signatureIdsByRowId.set(row.id, row.adCampaignSignatureId);
      }
    });
    return signatureIdsByRowId;
  }

  private reapplyAdCampaignMaterializationSideEffects(
    snapshot: DatabaseShape,
    params: {
      storeId: string;
      materializedSignatureIdByRowId: Map<string, string>;
      signatureIds: Set<string>;
    },
  ): void {
    const rowIdsToRematerialize = Array.from(params.materializedSignatureIdByRowId.entries())
      .filter(([, signatureId]) => params.signatureIds.has(signatureId))
      .map(([rowId]) => rowId);
    if (rowIdsToRematerialize.length === 0) {
      return;
    }

    const rowIdSet = new Set(rowIdsToRematerialize);
    snapshot.adCampaignDailyCosts.forEach((row) => {
      if (row.storeId === params.storeId && rowIdSet.has(row.id)) {
        row.adCampaignSignatureId = null;
      }
    });
    ensureAdCampaignSignaturesForStore(snapshot, params.storeId, rowIdSet);
  }

  private collectNewCanonicalSalesUnits(snapshot: DatabaseShape): CanonicalSalesUnit[] {
    const existingIds = new Set(this.database.canonicalSalesUnits.map((salesUnit) => salesUnit.id));
    return snapshot.canonicalSalesUnits
      .filter((salesUnit) => !existingIds.has(salesUnit.id))
      .map((salesUnit) => this.cloneSnapshot(salesUnit));
  }

  private upsertCanonicalSalesUnitInSnapshot(snapshot: DatabaseShape, salesUnit: CanonicalSalesUnit): void {
    const index = snapshot.canonicalSalesUnits.findIndex((item) => item.id === salesUnit.id);
    if (index === -1) {
      snapshot.canonicalSalesUnits.push(this.cloneSnapshot(salesUnit));
      return;
    }
    Object.assign(snapshot.canonicalSalesUnits[index], this.cloneSnapshot(salesUnit));
  }

  private upsertAuditLogInSnapshot(snapshot: DatabaseShape, auditLog: DatabaseShape["auditLogs"][number]): void {
    const index = snapshot.auditLogs.findIndex((item) => item.id === auditLog.id);
    if (index === -1) {
      snapshot.auditLogs.push(this.cloneSnapshot(auditLog));
      return;
    }
    Object.assign(snapshot.auditLogs[index], this.cloneSnapshot(auditLog));
  }

  private collectAffectedAdReportDates(rows: AdCampaignDailyCost[]): string[] {
    return Array.from(new Set(rows.map((row) => row.reportDate).filter(Boolean))).sort((left, right) =>
      left.localeCompare(right),
    );
  }

  private upsertAdCampaignMappingRowsInSnapshot(
    snapshot: DatabaseShape,
    params: {
      signatures: AdCampaignSignature[];
      adCampaignDailyCosts: AdCampaignDailyCost[];
      canonicalSalesUnits: CanonicalSalesUnit[];
    },
  ): void {
    params.canonicalSalesUnits.forEach((salesUnit) => {
      const index = snapshot.canonicalSalesUnits.findIndex((item) => item.id === salesUnit.id);
      if (index === -1) {
        snapshot.canonicalSalesUnits.push(this.cloneSnapshot(salesUnit));
        return;
      }
      Object.assign(snapshot.canonicalSalesUnits[index], this.cloneSnapshot(salesUnit));
    });

    params.signatures.forEach((signature) => {
      const index = snapshot.adCampaignSignatures.findIndex((item) => item.id === signature.id);
      if (index === -1) {
        snapshot.adCampaignSignatures.push(this.cloneSnapshot(signature));
        return;
      }
      Object.assign(snapshot.adCampaignSignatures[index], this.cloneSnapshot(signature));
    });

    params.adCampaignDailyCosts.forEach((row) => {
      const index = snapshot.adCampaignDailyCosts.findIndex((item) => item.id === row.id);
      if (index === -1) {
        snapshot.adCampaignDailyCosts.push(this.cloneSnapshot(row));
        return;
      }
      Object.assign(snapshot.adCampaignDailyCosts[index], this.cloneSnapshot(row));
    });
  }

  private normalizeCommittedDateList(dates: string[]): string[] {
    return Array.from(new Set(dates.filter(Boolean))).sort((left, right) => left.localeCompare(right));
  }

  private assertDailyProfitSummaryScope(
    storeId: string,
    dates: string[],
    dailySalesUnitProfits: StoredDailySalesUnitProfit[],
    dailyStoreSummaries: StoredDailyStoreSummary[],
  ): void {
    const dateSet = new Set(dates);
    const isOutOfScopeSalesUnitRow = dailySalesUnitProfits.some(
      (row) => row.storeId !== storeId || !dateSet.has(row.date),
    );
    const isOutOfScopeStoreSummaryRow = dailyStoreSummaries.some(
      (row) => row.storeId !== storeId || !dateSet.has(row.date),
    );
    if (isOutOfScopeSalesUnitRow || isOutOfScopeStoreSummaryRow) {
      throw new Error("DAILY_PROFIT_SUMMARY_SCOPE_MISMATCH");
    }
  }

  private buildDailyProfitSummaryReplacement<T>(
    snapshot: DatabaseShape,
    params: {
      storeId: string;
      dates: string[];
      buildReplacement: (database: DatabaseShape) => DailyProfitSummaryReplacementResult<T>;
    },
  ): DailyProfitSummaryReplacementResult<T> {
    const replacement = params.buildReplacement(snapshot);
    this.assertDailyProfitSummaryScope(
      params.storeId,
      params.dates,
      replacement.dailySalesUnitProfits,
      replacement.dailyStoreSummaries,
    );
    return replacement;
  }

  private async deleteDailyProfitSummaryRowsFromPostgres(
    client: PoolClient,
    storeId: string,
    dates: string[],
  ): Promise<void> {
    await client.query(
      `DELETE FROM daily_sales_unit_profits
       WHERE payload->>'storeId' = $1
         AND payload->>'date' = ANY($2::text[])`,
      [storeId, dates],
    );
    await client.query(
      `DELETE FROM daily_store_summaries
       WHERE payload->>'storeId' = $1
         AND payload->>'date' = ANY($2::text[])`,
      [storeId, dates],
    );
  }

  private replaceDailyProfitSummaryRowsInSnapshot(
    snapshot: DatabaseShape,
    params: {
      storeId: string;
      dates: string[];
      dailySalesUnitProfits: StoredDailySalesUnitProfit[];
      dailyStoreSummaries: StoredDailyStoreSummary[];
    },
  ): void {
    this.removeDailyProfitSummaryRowsFromSnapshot(snapshot, params.storeId, params.dates);
    snapshot.dailySalesUnitProfits.push(...this.cloneSnapshot(params.dailySalesUnitProfits));
    snapshot.dailyStoreSummaries.push(...this.cloneSnapshot(params.dailyStoreSummaries));
  }

  private removeDailyProfitSummaryRowsFromSnapshot(
    snapshot: DatabaseShape,
    storeId: string,
    dates: string[],
  ): void {
    const dateSet = new Set(dates);
    snapshot.dailySalesUnitProfits = snapshot.dailySalesUnitProfits.filter(
      (row) => row.storeId !== storeId || !dateSet.has(row.date),
    );
    snapshot.dailyStoreSummaries = snapshot.dailyStoreSummaries.filter(
      (row) => row.storeId !== storeId || !dateSet.has(row.date),
    );
  }

  private normalizeOperationRecord(operation: OperationRecord | Partial<OperationRecord>): OperationRecord {
    const source = isRecord(operation) ? operation : {};
    const createdAt = typeof source.createdAt === "string" ? source.createdAt : new Date().toISOString();
    const status = this.normalizeOperationStatus(source.status);
    const maxAttempts =
      typeof source.maxAttempts === "number" && Number.isInteger(source.maxAttempts) && source.maxAttempts > 0
        ? source.maxAttempts
        : DEFAULT_OPERATION_MAX_ATTEMPTS;

    return {
      id: typeof source.id === "string" ? source.id : hashPayload({ source, createdAt }).slice(0, 32),
      storeId: typeof source.storeId === "string" ? source.storeId : "",
      operationType: this.normalizeOperationType(source.operationType),
      status,
      retryOfOperationId: typeof source.retryOfOperationId === "string" ? source.retryOfOperationId : null,
      requestedBy: typeof source.requestedBy === "string" ? source.requestedBy : null,
      requestJson: isRecord(source.requestJson) ? source.requestJson : null,
      resultJson: isRecord(source.resultJson) ? source.resultJson : null,
      errorMessage: typeof source.errorMessage === "string" ? source.errorMessage : null,
      cutoffAt: typeof source.cutoffAt === "string" ? source.cutoffAt : createdAt,
      createdAt,
      startedAt: typeof source.startedAt === "string" ? source.startedAt : null,
      finishedAt: typeof source.finishedAt === "string" ? source.finishedAt : null,
      attemptCount:
        typeof source.attemptCount === "number" && Number.isInteger(source.attemptCount) && source.attemptCount >= 0
          ? source.attemptCount
          : 0,
      maxAttempts,
      runAfter: typeof source.runAfter === "string" ? source.runAfter : null,
      heartbeatAt: typeof source.heartbeatAt === "string" ? source.heartbeatAt : null,
      leaseOwner: typeof source.leaseOwner === "string" ? source.leaseOwner : null,
      leaseExpiresAt: typeof source.leaseExpiresAt === "string" ? source.leaseExpiresAt : null,
      lockedAt: typeof source.lockedAt === "string" ? source.lockedAt : null,
      progressJson: isRecord(source.progressJson) ? source.progressJson : null,
    };
  }

  private normalizeOperationStatus(status: unknown): OperationStatus {
    return status === "RUNNING" || status === "SUCCEEDED" || status === "FAILED" ? status : "QUEUED";
  }

  private normalizeOperationType(operationType: unknown): OperationType {
    return operationType === "AD_UPLOAD_CONFIRM" ||
      operationType === "RECALCULATE_ORDER_MAPPING" ||
      operationType === "RECALCULATE_AD_MAPPING"
      ? operationType
      : "ORDER_SYNC";
  }

  private async initializePostgresStorage() {
    this.ensureFileStorageReady();

    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
    });

    await this.pool.query("SELECT 1");
    await this.ensurePostgresSchema();

    const loaded = await this.loadSnapshotFromPostgres();
    if (this.isEmptySnapshot(loaded)) {
      const legacy = this.loadSnapshotFromFile();
      if (!this.isEmptySnapshot(legacy)) {
        await this.persistSnapshotToPostgres(legacy, { includeQueueOwnedTables: true });
        this.database = legacy;
        return;
      }
    }

    this.database = loaded;
  }

  private async ensurePostgresSchema() {
    const pool = this.getPool();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS storage_metadata (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const table of STORAGE_TABLES) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${table.tableName} (
          id TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          payload_hash TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`ALTER TABLE ${table.tableName} ADD COLUMN IF NOT EXISTS payload_hash TEXT`);
    }

    await this.backfillPostgresPayloadHashes(pool);
    const duplicateWarnings = await this.warnAboutDuplicateBusinessKeys(pool);
    await this.ensurePostgresIndexes(pool, duplicateWarnings);
  }

  private async backfillPostgresPayloadHashes(pool: Pool) {
    for (const table of STORAGE_TABLES) {
      const result = await pool.query<{ id: string; payload: unknown }>(
        `SELECT id, payload FROM ${table.tableName} WHERE payload_hash IS NULL ORDER BY id`,
      );

      for (let index = 0; index < result.rows.length; index += POSTGRES_UPSERT_BATCH_SIZE) {
        const batch = result.rows.slice(index, index + POSTGRES_UPSERT_BATCH_SIZE);
        await this.updatePayloadHashes(pool, table, batch);
      }
    }
  }

  private async updatePayloadHashes(
    client: Pool | PoolClient,
    table: StorageTable,
    rows: Array<{ id: string; payload: unknown }>,
  ) {
    if (rows.length === 0) {
      return;
    }

    const values: unknown[] = [];
    const tuples = rows.map((row, index) => {
      const parameterIndex = index * 2;
      values.push(row.id, hashPayload(row.payload));
      return `($${parameterIndex + 1}, $${parameterIndex + 2})`;
    });

    await client.query(
      `UPDATE ${table.tableName} AS target
       SET payload_hash = source.payload_hash
       FROM (VALUES ${tuples.join(", ")}) AS source(id, payload_hash)
       WHERE target.id = source.id
         AND target.payload_hash IS NULL`,
      values,
    );
  }

  private async warnAboutDuplicateBusinessKeys(client: Pool | PoolClient): Promise<DuplicateKeyWarning[]> {
    const warnings: DuplicateKeyWarning[] = [];

    for (const check of POSTGRES_DUPLICATE_KEY_CHECKS) {
      const result = await client.query<Record<string, unknown>>(check.sql);
      if (result.rows.length === 0) {
        continue;
      }

      const warning = {
        checkId: check.id,
        label: check.label,
        rows: result.rows,
      };
      warnings.push(warning);
      console.warn(
        `[DatabaseService] Duplicate business keys found for ${check.label}; leaving rows unchanged.`,
        result.rows,
      );
    }

    return warnings;
  }

  private async ensurePostgresIndexes(client: Pool | PoolClient, duplicateWarnings: DuplicateKeyWarning[]) {
    const duplicateCheckIds = new Set(duplicateWarnings.map((warning) => warning.checkId));

    for (const index of POSTGRES_JSONB_INDEXES) {
      if (index.requiresDuplicateCheckId && duplicateCheckIds.has(index.requiresDuplicateCheckId)) {
        if (index.duplicateFallbackSql) {
          await client.query(index.duplicateFallbackSql);
        }
        console.warn(
          `[DatabaseService] Skipped ${index.name} because duplicate data must be repaired first.`,
        );
        continue;
      }

      try {
        await client.query(index.sql);
      } catch (error) {
        if (index.duplicateFallbackSql && this.isUniqueViolation(error)) {
          await client.query(index.duplicateFallbackSql);
          console.warn(
            `[DatabaseService] Skipped ${index.name} because PostgreSQL reported duplicate data.`,
          );
          continue;
        }
        throw error;
      }
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
  }

  private async loadSnapshotFromPostgres(): Promise<DatabaseShape> {
    const snapshot = createEmptyDatabase();
    const pool = this.getPool();

    for (const table of STORAGE_TABLES) {
      const result = await pool.query<{ payload: unknown }>(
        `SELECT payload FROM ${table.tableName} ORDER BY id`,
      );
      (snapshot[table.key] as unknown[]) = result.rows.map((row) => row.payload);
    }

    return this.normalizeSnapshot(snapshot);
  }

  private isEmptySnapshot(snapshot: DatabaseShape) {
    return STORAGE_TABLES.every((table) => snapshot[table.key].length === 0);
  }

  private normalizeSnapshot(snapshot: DatabaseShape): DatabaseShape {
    const normalized = {
      ...createEmptyDatabase(),
      ...this.cloneSnapshot(snapshot),
    };

    for (const table of STORAGE_TABLES) {
      if (!Array.isArray(normalized[table.key])) {
        (normalized[table.key] as unknown[]) = [];
      }
    }

    normalized.dailyFakePurchases = Array.isArray(normalized.dailyFakePurchases)
      ? normalized.dailyFakePurchases
      : [];
    normalized.dailySalesUnitProfits = Array.isArray(normalized.dailySalesUnitProfits)
      ? normalized.dailySalesUnitProfits
      : [];
    normalized.dailyStoreSummaries = Array.isArray(normalized.dailyStoreSummaries)
      ? normalized.dailyStoreSummaries
      : [];
    normalized.adCampaignSignatures = Array.isArray(normalized.adCampaignSignatures)
      ? normalized.adCampaignSignatures
      : [];

    // 스토어 deliveryUnitCost 기본값 보정 (마이그레이션)
    normalized.stores = normalized.stores.map((store) => ({
      ...store,
      deliveryUnitCost:
        typeof store.deliveryUnitCost === "number" && store.deliveryUnitCost >= 0
          ? store.deliveryUnitCost
          : DEFAULT_DELIVERY_UNIT_COST,
    }));

    normalized.canonicalSalesUnits = normalized.canonicalSalesUnits.map((item) =>
      migrateCanonicalSalesUnit(item as never),
    );
    normalized.orderSourceSignatures = normalized.orderSourceSignatures.map((item) => ({
      ...item,
      mappingStatus: getSignatureMappingStatus(item),
      usageCount: typeof item.usageCount === "number" ? item.usageCount : 0,
      firstSeenAt: item.firstSeenAt ?? item.createdAt ?? null,
      lastSeenAt: item.lastSeenAt ?? item.updatedAt ?? null,
      sampleExternalProductId: item.sampleExternalProductId ?? null,
      sampleOptionCode: item.sampleOptionCode ?? null,
      sampleOptionManageCode: item.sampleOptionManageCode ?? null,
      lastAutoMappedAt: item.lastAutoMappedAt ?? null,
      mappingRuleHash: item.mappingRuleHash ?? null,
    }));
    this.rebuildOrderSourceSignatureSummaries(normalized);
    this.normalizeAdCampaignSignatures(normalized);
    normalized.operations = normalized.operations.map((operation) => this.normalizeOperationRecord(operation));

    return normalized;
  }

  private rebuildOrderSourceSignatureSummaries(database: DatabaseShape): void {
    const summaries = new Map<
      string,
      {
        usageCount: number;
        firstSeenAt: string | null;
        lastSeenAt: string | null;
        sampleExternalProductId: string | null;
        sampleOptionCode: string | null;
        sampleOptionManageCode: string | null;
      }
    >();

    for (const item of database.orderItems) {
      if (!item.orderSourceSignatureId) {
        continue;
      }

      const seenAt = item.paymentDate ?? item.orderDate ?? item.createdAt ?? null;
      const current = summaries.get(item.orderSourceSignatureId) ?? {
        usageCount: 0,
        firstSeenAt: null,
        lastSeenAt: null,
        sampleExternalProductId: null,
        sampleOptionCode: null,
        sampleOptionManageCode: null,
      };

      current.usageCount += 1;
      if (seenAt && (!current.firstSeenAt || seenAt < current.firstSeenAt)) {
        current.firstSeenAt = seenAt;
      }
      if (seenAt && (!current.lastSeenAt || seenAt > current.lastSeenAt)) {
        current.lastSeenAt = seenAt;
      }
      if (item.externalProductId && !current.sampleExternalProductId) {
        current.sampleExternalProductId = item.externalProductId;
      }
      if (item.optionCode && !current.sampleOptionCode) {
        current.sampleOptionCode = item.optionCode;
      }
      if (item.optionManageCode && !current.sampleOptionManageCode) {
        current.sampleOptionManageCode = item.optionManageCode;
      }
      summaries.set(item.orderSourceSignatureId, current);
    }

    database.orderSourceSignatures.forEach((signature) => {
      const summary = summaries.get(signature.id);
      signature.usageCount = summary?.usageCount ?? 0;
      signature.firstSeenAt = summary?.firstSeenAt ?? signature.firstSeenAt ?? signature.createdAt ?? null;
      signature.lastSeenAt = summary?.lastSeenAt ?? signature.lastSeenAt ?? signature.updatedAt ?? null;
      signature.sampleExternalProductId = summary?.sampleExternalProductId ?? signature.sampleExternalProductId ?? null;
      signature.sampleOptionCode = summary?.sampleOptionCode ?? signature.sampleOptionCode ?? null;
      signature.sampleOptionManageCode = summary?.sampleOptionManageCode ?? signature.sampleOptionManageCode ?? null;
    });
  }

  private normalizeAdCampaignSignatures(database: DatabaseShape): void {
    const timestamp = new Date().toISOString();
    const signaturesByKey = new Map<string, AdCampaignSignature>();

    database.adCampaignSignatures = database.adCampaignSignatures.map((item) => {
      const normalized: AdCampaignSignature = {
        ...item,
        channel: item.channel ?? "NAVER_DA",
        campaignId: item.campaignId ?? null,
        campaignNameSnapshot: item.campaignNameSnapshot ?? "",
        normalizedCampaignName: item.normalizedCampaignName ?? "",
        canonicalSalesUnitId: item.canonicalSalesUnitId ?? null,
        mappingReason: item.mappingReason ?? "NO_RULE",
        matchedRuleCount: typeof item.matchedRuleCount === "number" ? item.matchedRuleCount : 0,
        reasonNote: item.reasonNote ?? null,
        reasonNoteInherited: item.reasonNoteInherited ?? false,
        confirmedAt: item.confirmedAt ?? null,
        usageCount: typeof item.usageCount === "number" ? item.usageCount : 0,
        firstSeenDate: item.firstSeenDate ?? null,
        lastSeenDate: item.lastSeenDate ?? null,
        lastAutoMappedAt: item.lastAutoMappedAt ?? null,
        mappingRuleHash: item.mappingRuleHash ?? null,
        createdAt: item.createdAt ?? timestamp,
        updatedAt: item.updatedAt ?? timestamp,
      };
      signaturesByKey.set(this.getAdCampaignSignatureKey(normalized), normalized);
      return normalized;
    });

    const rowsBySignatureId = new Map<string, DatabaseShape["adCampaignDailyCosts"]>();
    database.adCampaignDailyCosts = database.adCampaignDailyCosts.map((row) => {
      const normalizedName = row.normalizedCampaignName ?? "";
      const rowWithSignature = {
        ...row,
        normalizedCampaignName: normalizedName,
        adCampaignSignatureId: row.adCampaignSignatureId ?? null,
      };
      const key = this.getAdCampaignRowSignatureKey(rowWithSignature);
      let signature = signaturesByKey.get(key);

      if (!signature) {
        signature = {
          id: this.createDeterministicAdCampaignSignatureId(key),
          storeId: rowWithSignature.storeId,
          channel: "NAVER_DA",
          campaignId: rowWithSignature.campaignId || null,
          campaignNameSnapshot: rowWithSignature.campaignName,
          normalizedCampaignName: normalizedName,
          canonicalSalesUnitId: rowWithSignature.canonicalSalesUnitId ?? null,
          mappingReason: rowWithSignature.mappingReason ?? "NO_RULE",
          matchedRuleCount: typeof rowWithSignature.matchedRuleCount === "number" ? rowWithSignature.matchedRuleCount : 0,
          reasonNote: rowWithSignature.reasonNote ?? null,
          reasonNoteInherited: rowWithSignature.reasonNoteInherited ?? false,
          confirmedAt: null,
          usageCount: 0,
          firstSeenDate: null,
          lastSeenDate: null,
          lastAutoMappedAt: null,
          mappingRuleHash: null,
          createdAt: rowWithSignature.createdAt ?? timestamp,
          updatedAt: rowWithSignature.updatedAt ?? timestamp,
        };
        signaturesByKey.set(key, signature);
        database.adCampaignSignatures.push(signature);
      }

      rowWithSignature.adCampaignSignatureId = signature.id;
      const rows = rowsBySignatureId.get(signature.id) ?? [];
      rows.push(rowWithSignature);
      rowsBySignatureId.set(signature.id, rows);
      return rowWithSignature;
    });

    database.adCampaignSignatures.forEach((signature) => {
      const rows = rowsBySignatureId.get(signature.id) ?? [];
      signature.usageCount = rows.length;
      signature.firstSeenDate = rows.reduce<string | null>(
        (oldest, row) => (!oldest || row.reportDate < oldest ? row.reportDate : oldest),
        null,
      );
      signature.lastSeenDate = rows.reduce<string | null>(
        (latest, row) => (!latest || row.reportDate > latest ? row.reportDate : latest),
        null,
      );

      const latestRow = rows
        .slice()
        .sort((left, right) =>
          `${right.reportDate}:${right.updatedAt}`.localeCompare(`${left.reportDate}:${left.updatedAt}`),
        )[0];
      if (latestRow) {
        signature.campaignNameSnapshot = latestRow.campaignName;
        signature.normalizedCampaignName = latestRow.normalizedCampaignName;
        signature.campaignId = latestRow.campaignId || signature.campaignId;
      }

      if (signature.confirmedAt) {
        return;
      }

      const manualRows = rows.filter(
        (row) => row.mappingReason === "MANUAL_MAPPED" || row.mappingReason === "INTENTIONALLY_UNMAPPED",
      );
      const manualKeys = new Set(
        manualRows.map((row) =>
          row.mappingReason === "MANUAL_MAPPED"
            ? `MANUAL_MAPPED:${row.canonicalSalesUnitId ?? ""}`
            : `INTENTIONALLY_UNMAPPED:${row.reasonNote ?? ""}`,
        ),
      );

      if (manualKeys.size === 1 && manualRows[0]) {
        const row = manualRows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        signature.canonicalSalesUnitId = row.canonicalSalesUnitId;
        signature.mappingReason = row.mappingReason;
        signature.matchedRuleCount = row.matchedRuleCount ?? 0;
        signature.reasonNote = row.reasonNote ?? null;
        signature.reasonNoteInherited = false;
        signature.confirmedAt = row.updatedAt ?? timestamp;
        signature.updatedAt = row.updatedAt ?? timestamp;
        return;
      }

      if (manualKeys.size > 1) {
        signature.canonicalSalesUnitId = null;
        signature.mappingReason = "MULTIPLE_RULES";
        signature.matchedRuleCount = manualKeys.size;
        signature.reasonNote = "기존 광고 row 수동 매핑이 서로 다릅니다.";
        signature.reasonNoteInherited = false;
        signature.updatedAt = timestamp;
        return;
      }

      if (latestRow) {
        signature.canonicalSalesUnitId = latestRow.canonicalSalesUnitId ?? null;
        signature.mappingReason = latestRow.mappingReason ?? "NO_RULE";
        signature.matchedRuleCount = latestRow.matchedRuleCount ?? 0;
        signature.reasonNote = latestRow.reasonNote ?? null;
        signature.reasonNoteInherited = latestRow.reasonNoteInherited ?? false;
      }
    });
  }

  private getAdCampaignSignatureKey(signature: Pick<AdCampaignSignature, "storeId" | "channel" | "campaignId" | "normalizedCampaignName">): string {
    return [
      signature.storeId,
      signature.channel,
      signature.campaignId ? `id:${signature.campaignId}` : `name:${signature.normalizedCampaignName}`,
    ].join("|");
  }

  private getAdCampaignRowSignatureKey(row: Pick<DatabaseShape["adCampaignDailyCosts"][number], "storeId" | "campaignId" | "normalizedCampaignName">): string {
    return [
      row.storeId,
      "NAVER_DA",
      row.campaignId ? `id:${row.campaignId}` : `name:${row.normalizedCampaignName}`,
    ].join("|");
  }

  private createDeterministicAdCampaignSignatureId(key: string): string {
    return `ad-sig-${createHash("sha1").update(key).digest("hex").slice(0, 20)}`;
  }

  private queuePostgresPersistence(snapshot: DatabaseShape) {
    const nextSnapshot = this.cloneSnapshot(snapshot);
    this.pendingWriteCount += 1;

    const operation = this.persistenceQueue
      .catch(() => undefined)
      .then(() => this.persistSnapshotWithStatus(nextSnapshot));

    this.persistenceQueue = operation
      .catch((error) => {
        const message = this.getErrorMessage(error);
        console.error(`[DatabaseService] PostgreSQL persistence failed: ${message}`);
      })
      .finally(() => {
        this.pendingWriteCount -= 1;
      });
  }

  private async persistSnapshotWithStatus(snapshot: DatabaseShape): Promise<void> {
    try {
      if (this.storageMode === "postgres") {
        await this.persistSnapshotToPostgres(snapshot, { includeQueueOwnedTables: false });
      } else {
        this.persistSnapshotToFile(snapshot);
      }
      this.lastPersistenceError = null;
    } catch (error) {
      this.recordPersistenceError(error);
      throw error;
    }
  }

  private persistSnapshotToFileWithStatus(snapshot: DatabaseShape): void {
    try {
      this.persistSnapshotToFile(snapshot);
      this.lastPersistenceError = null;
    } catch (error) {
      this.recordPersistenceError(error);
      throw error;
    }
  }

  private persistSnapshotToFile(snapshot: DatabaseShape): void {
    this.ensureFileStorageDirectory();

    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

    try {
      writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), "utf-8");
      renameSync(tempPath, this.filePath);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  }

  private recordPersistenceError(error: unknown): void {
    this.lastPersistenceError = {
      message: this.getErrorMessage(error),
      occurredAt: new Date().toISOString(),
    };
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async persistSnapshotToPostgres(
    snapshot: DatabaseShape,
    options: { includeQueueOwnedTables?: boolean } = {},
  ) {
    const client = await this.getPool().connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO storage_metadata (key, value, updated_at)
         VALUES ('database_shape', $1::jsonb, NOW())
         ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify({ version: POSTGRES_SCHEMA_VERSION, provider: "postgres" })],
      );

      for (const table of STORAGE_TABLES) {
        if (table.queueOwned && !options.includeQueueOwnedTables) {
          continue;
        }
        await this.persistTableRowsIncrementally(client, table, snapshot[table.key] as Array<{ id: string }>);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async persistTableRowsIncrementally(
    client: PoolClient,
    table: StorageTable,
    rows: Array<{ id: string }>,
  ): Promise<void> {
    await this.upsertTableRows(client, table, rows);
    await this.deleteMissingTableRows(client, table, rows.map((row) => row.id));
  }

  private async upsertTableRows(
    client: PoolClient,
    table: StorageTable,
    rows: Array<{ id: string }>,
  ): Promise<void> {
    for (let offset = 0; offset < rows.length; offset += POSTGRES_UPSERT_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + POSTGRES_UPSERT_BATCH_SIZE);
      const values: unknown[] = [];
      const tuples = batch.map((row, index) => {
        const parameterIndex = index * 3;
        values.push(row.id, JSON.stringify(row), hashPayload(row));
        return `($${parameterIndex + 1}, $${parameterIndex + 2}::jsonb, $${parameterIndex + 3}, NOW())`;
      });

      await client.query(
        `INSERT INTO ${table.tableName} (id, payload, payload_hash, updated_at)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (id) DO UPDATE
         SET payload = EXCLUDED.payload,
             payload_hash = EXCLUDED.payload_hash,
             updated_at = NOW()
         WHERE ${table.tableName}.payload_hash IS DISTINCT FROM EXCLUDED.payload_hash`,
        values,
      );
    }
  }

  private async updateTableRowsPayloads(
    client: PoolClient,
    tableName: string,
    rows: Array<{ id: string }>,
  ): Promise<void> {
    for (let offset = 0; offset < rows.length; offset += POSTGRES_UPSERT_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + POSTGRES_UPSERT_BATCH_SIZE);
      if (batch.length === 0) {
        continue;
      }

      const values: unknown[] = [];
      const tuples = batch.map((row, index) => {
        const parameterIndex = index * 3;
        values.push(row.id, JSON.stringify(row), hashPayload(row));
        return `($${parameterIndex + 1}, $${parameterIndex + 2}::jsonb, $${parameterIndex + 3})`;
      });

      await client.query(
        `UPDATE ${tableName} AS target
         SET payload = source.payload,
             payload_hash = source.payload_hash,
             updated_at = NOW()
         FROM (VALUES ${tuples.join(", ")}) AS source(id, payload, payload_hash)
         WHERE target.id = source.id`,
        values,
      );
    }
  }

  private async deleteMissingTableRows(
    client: PoolClient,
    table: StorageTable,
    nextIds: string[],
  ): Promise<void> {
    if (nextIds.length === 0) {
      await client.query(`DELETE FROM ${table.tableName}`);
      return;
    }

    await client.query(
      `DELETE FROM ${table.tableName}
       WHERE NOT (id = ANY($1::text[]))`,
      [Array.from(new Set(nextIds))],
    );
  }

  private getPool() {
    if (!this.pool) {
      throw new Error("DATABASE_NOT_INITIALIZED");
    }
    return this.pool;
  }
}
