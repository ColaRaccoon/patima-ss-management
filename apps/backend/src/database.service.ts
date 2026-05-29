import { Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { AdCampaignSignature, DatabaseShape, DEFAULT_DELIVERY_UNIT_COST } from "@patima/shared";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { Pool, PoolClient } from "pg";
import { createEmptyDatabase, getSignatureMappingStatus, migrateCanonicalSalesUnit } from "./helpers";

type DatabaseCollectionKey = keyof DatabaseShape;
type StorageMode = "postgres" | "file";

interface PersistenceErrorState {
  message: string;
  occurredAt: string;
}

interface StorageTable {
  key: DatabaseCollectionKey;
  tableName: string;
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
  { key: "operations", tableName: "operations" },
  { key: "auditLogs", tableName: "audit_logs" },
];

export const POSTGRES_SCHEMA_VERSION = 2;
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
    name: "idx_ad_costs_store_report_campaign",
    sql: `CREATE INDEX IF NOT EXISTS idx_ad_costs_store_report_campaign
          ON ad_campaign_daily_costs ((payload->>'storeId'), (payload->>'reportDate'), (payload->>'campaignId'))`,
  },
  {
    name: "idx_operations_store_status_created",
    sql: `CREATE INDEX IF NOT EXISTS idx_operations_store_status_created
          ON operations ((payload->>'storeId'), (payload->>'status'), (payload->>'createdAt'))`,
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
        await this.persistSnapshotToPostgres(legacy);
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
        await this.persistSnapshotToPostgres(snapshot);
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

  private async persistSnapshotToPostgres(snapshot: DatabaseShape) {
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
