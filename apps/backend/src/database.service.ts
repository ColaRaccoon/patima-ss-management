import { Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { DatabaseShape, DEFAULT_DELIVERY_UNIT_COST } from "@patima/shared";
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
  { key: "adExcelUploads", tableName: "ad_excel_uploads" },
  { key: "adUploadPreviewRows", tableName: "ad_upload_preview_rows" },
  { key: "adCampaignDailyCosts", tableName: "ad_campaign_daily_costs" },
  { key: "salesUnitCostSettings", tableName: "sales_unit_cost_settings" },
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
    const normalized = this.cloneSnapshot(snapshot);

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
    }));

    return normalized;
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
