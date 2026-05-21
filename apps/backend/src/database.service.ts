import { Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { AdCampaignSignature, DatabaseShape, DEFAULT_DELIVERY_UNIT_COST } from "@patima/shared";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { Pool, PoolClient } from "pg";
import { createEmptyDatabase, getSignatureMappingStatus, migrateCanonicalSalesUnit } from "./helpers";

type DatabaseCollectionKey = keyof DatabaseShape;

interface StorageTable {
  key: DatabaseCollectionKey;
  tableName: string;
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

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private database: DatabaseShape = createEmptyDatabase();
  private readonly storageMode = process.env.DATABASE_URL ? "postgres" : "file";
  private pool: Pool | null = null;
  private persistenceQueue: Promise<void> = Promise.resolve();

  private readonly filePath = (() => {
    const dataDir = process.env.DATA_DIR
      ? join(process.cwd(), process.env.DATA_DIR.replace("./", ""))
      : join(process.cwd(), "apps", "backend", "data");
    return join(dataDir, "database.json");
  })();

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
    this.database = draft;

    if (this.storageMode === "postgres") {
      this.queuePostgresPersistence(draft);
      return result;
    }

    writeFileSync(this.filePath, JSON.stringify(this.database, null, 2), "utf-8");
    return result;
  }

  private ensureFileStorageReady() {
    const folder = dirname(this.filePath);
    if (!existsSync(folder)) {
      mkdirSync(folder, { recursive: true });
    }
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, JSON.stringify(createEmptyDatabase(), null, 2), "utf-8");
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
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    }
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
    this.persistenceQueue = this.persistenceQueue
      .catch(() => undefined)
      .then(() => this.persistSnapshotToPostgres(nextSnapshot))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[DatabaseService] PostgreSQL persistence failed: ${message}`);
      });
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
        [JSON.stringify({ version: 1, provider: "postgres" })],
      );

      for (const table of STORAGE_TABLES) {
        await this.replaceTableRows(client, table, snapshot[table.key] as Array<{ id: string }>);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async replaceTableRows(
    client: PoolClient,
    table: StorageTable,
    rows: Array<{ id: string }>,
  ) {
    await client.query(`TRUNCATE TABLE ${table.tableName}`);
    if (rows.length === 0) {
      return;
    }

    const values: unknown[] = [];
    const tuples = rows.map((row, index) => {
      const parameterIndex = index * 2;
      values.push(row.id, JSON.stringify(row));
      return `($${parameterIndex + 1}, $${parameterIndex + 2}::jsonb, NOW())`;
    });

    await client.query(
      `INSERT INTO ${table.tableName} (id, payload, updated_at)
       VALUES ${tuples.join(", ")}`,
      values,
    );
  }

  private getPool() {
    if (!this.pool) {
      throw new Error("DATABASE_NOT_INITIALIZED");
    }
    return this.pool;
  }
}
