// DB snapshot import — restore a JSON snapshot produced by db-export.mjs.
// 주의: 대상 DB의 모든 JSONB 블롭 테이블을 TRUNCATE 후 스냅샷으로 교체한다.
//       백엔드가 켜져있으면 runtime persistence와 충돌할 수 있으니 반드시 중지.
//
// Usage:
//   node scripts/db-import.mjs <snapshot.json>
//   node scripts/db-import.mjs <snapshot.json> --yes   // 확인 프롬프트 건너뜀

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const SNAPSHOT_SCHEMA_VERSION = 2;
const SUPPORTED_FORMATS = new Set(['jsonb-payload-v1', 'jsonb-payload-v2']);
const INSERT_BATCH_SIZE = 500;

const REBUILD_BEFORE_RESTORE_INDEXES = [
  'idx_order_items_store_external_product_order',
  'idx_order_items_store_external_product_order_lookup',
];

const KNOWN_STORAGE_TABLES = [
  'stores',
  'commerce_api_credentials',
  'products',
  'canonical_sales_units',
  'order_source_signatures',
  'orders',
  'order_items',
  'campaign_sales_unit_mappings',
  'ad_campaign_signatures',
  'ad_excel_uploads',
  'ad_upload_preview_rows',
  'ad_campaign_daily_costs',
  'sales_unit_cost_settings',
  'sales_unit_cost_snapshots',
  'sales_unit_cost_snapshot_entries',
  'daily_fake_purchases',
  'operations',
  'audit_logs',
];

const JSONB_INDEXES = [
  {
    name: 'idx_orders_store_external',
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_store_external
          ON orders ((payload->>'storeId'), (payload->>'externalOrderId'))`,
  },
  {
    name: 'idx_orders_store_payment_datetime',
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_store_payment_datetime
          ON orders ((payload->>'storeId'), (payload->>'paymentDatetime'))`,
  },
  {
    name: 'idx_order_items_store_external_product_order',
    requiresDuplicateCheckId: 'order-items-store-external-product-order',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_store_external_product_order
          ON order_items ((payload->>'storeId'), (payload->>'externalProductOrderId'))`,
    duplicateFallbackSql: `CREATE INDEX IF NOT EXISTS idx_order_items_store_external_product_order_lookup
                           ON order_items ((payload->>'storeId'), (payload->>'externalProductOrderId'))`,
  },
  {
    name: 'idx_order_items_store_payment_date',
    sql: `CREATE INDEX IF NOT EXISTS idx_order_items_store_payment_date
          ON order_items ((payload->>'storeId'), (payload->>'paymentDate'))`,
  },
  {
    name: 'idx_order_items_store_sale_status',
    sql: `CREATE INDEX IF NOT EXISTS idx_order_items_store_sale_status
          ON order_items ((payload->>'storeId'), (payload->>'saleStatus'))`,
  },
  {
    name: 'idx_ad_costs_store_report_campaign',
    sql: `CREATE INDEX IF NOT EXISTS idx_ad_costs_store_report_campaign
          ON ad_campaign_daily_costs ((payload->>'storeId'), (payload->>'reportDate'), (payload->>'campaignId'))`,
  },
  {
    name: 'idx_operations_store_status_created',
    sql: `CREATE INDEX IF NOT EXISTS idx_operations_store_status_created
          ON operations ((payload->>'storeId'), (payload->>'status'), (payload->>'createdAt'))`,
  },
];

const DUPLICATE_CHECKS = [
  {
    id: 'orders-store-external',
    label: 'orders (storeId, externalOrderId)',
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
    id: 'order-items-store-external-product-order',
    label: 'order_items (storeId, externalProductOrderId)',
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
    id: 'ad-costs-active-store-report-campaign',
    label: 'ad_campaign_daily_costs active uploads (storeId, reportDate, campaignId)',
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
    id: 'sales-unit-cost-snapshots-store-effective-from',
    label: 'sales_unit_cost_snapshots (storeId, effectiveFrom)',
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

const file = process.argv[2];
const auto = process.argv.includes('--yes');
if (!file) {
  console.error('Usage: node scripts/db-import.mjs <snapshot.json> [--yes]');
  process.exit(1);
}
const fullPath = path.resolve(file);
if (!fs.existsSync(fullPath)) throw new Error(`파일 없음: ${fullPath}`);

const CONN = process.env.DATABASE_URL;
if (!CONN) throw new Error('DATABASE_URL env 없음. .env 확인.');

// Backend must be stopped
const probe = await fetch('http://localhost:4000/api/v1/stores', { signal: AbortSignal.timeout(1500) }).catch(() => null);
if (probe && probe.ok) {
  console.error('❌ 백엔드가 4000에 응답 중. 중지 후 재실행.');
  process.exit(1);
}

const toStableJsonValue = (value) => {
  if (Array.isArray(value)) return value.map((item) => toStableJsonValue(item) ?? null);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((stable, key) => {
      const normalized = toStableJsonValue(value[key]);
      if (normalized !== undefined) stable[key] = normalized;
      return stable;
    }, {});
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  return value;
};

const stableStringify = (value) => JSON.stringify(toStableJsonValue(value)) ?? 'null';
const hashPayload = (payload) => crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');

const quoteIdentifier = (identifier) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`지원하지 않는 table identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

const snapshot = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
if (!SUPPORTED_FORMATS.has(snapshot.meta?.format)) {
  console.error(`❌ 지원하지 않는 snapshot 포맷: ${snapshot.meta?.format}`);
  process.exit(1);
}
if (!snapshot.tables || typeof snapshot.tables !== 'object' || Array.isArray(snapshot.tables)) {
  console.error('❌ snapshot.tables 형식이 올바르지 않습니다.');
  process.exit(1);
}

const snapshotTables = Object.keys(snapshot.tables);
for (const table of snapshotTables) {
  quoteIdentifier(table);
  if (!Array.isArray(snapshot.tables[table])) {
    console.error(`❌ snapshot table rows 형식이 올바르지 않습니다: ${table}`);
    process.exit(1);
  }
}

console.log(`Snapshot: ${fullPath}`);
console.log(`  dumpedAt:       ${snapshot.meta.dumpedAt}`);
console.log(`  source:         ${snapshot.meta.source}`);
console.log(`  format:         ${snapshot.meta.format}`);
console.log(`  schemaVersion:  ${snapshot.meta.schemaVersion ?? 1}`);
console.log(`  tables:         ${snapshotTables.length}`);
console.log(`  target:         ${CONN.replace(/:[^:@]*@/, ':***@')}`);

if (!auto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question('\n대상 DB의 모든 JSONB 테이블을 TRUNCATE 후 교체합니다. 진행? (yes/no): ', res));
  rl.close();
  if (ans.trim().toLowerCase() !== 'yes') {
    console.log('취소됨.');
    process.exit(0);
  }
}

const ensurePayloadTable = async (client, table) => {
  const tableSql = quoteIdentifier(table);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${tableSql} (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      payload_hash TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`ALTER TABLE ${tableSql} ADD COLUMN IF NOT EXISTS payload_hash TEXT`);
};

const insertRows = async (client, table, rows) => {
  if (rows.length === 0) return;
  const tableSql = quoteIdentifier(table);

  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const values = [];
    const tuples = batch.map((row, index) => {
      const parameterIndex = index * 4;
      values.push(
        row.id,
        JSON.stringify(row.payload),
        row.payload_hash ?? hashPayload(row.payload),
        row.updated_at ?? new Date(),
      );
      return `($${parameterIndex + 1}, $${parameterIndex + 2}::jsonb, $${parameterIndex + 3}, $${parameterIndex + 4})`;
    });

    await client.query(
      `INSERT INTO ${tableSql} (id, payload, payload_hash, updated_at)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }
};

const warnAboutDuplicates = async (client) => {
  const duplicateCheckIds = new Set();
  for (const check of DUPLICATE_CHECKS) {
    const result = await client.query(check.sql);
    if (result.rows.length === 0) continue;
    duplicateCheckIds.add(check.id);
    console.warn(`  ! duplicate ${check.label}; rows unchanged: ${JSON.stringify(result.rows)}`);
  }
  return duplicateCheckIds;
};

const ensureIndexes = async (client, duplicateCheckIds) => {
  for (const index of JSONB_INDEXES) {
    if (index.requiresDuplicateCheckId && duplicateCheckIds.has(index.requiresDuplicateCheckId)) {
      if (index.duplicateFallbackSql) await client.query(index.duplicateFallbackSql);
      console.warn(`  ! skipped ${index.name}; duplicate data must be repaired first`);
      continue;
    }
    await client.query(index.sql);
  }
};

const client = new pg.Client({ connectionString: CONN });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`
    CREATE TABLE IF NOT EXISTS storage_metadata (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const existingPayloadTables = (await client.query(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='payload'
    ORDER BY table_name
  `)).rows.map((row) => row.table_name);

  const tablesToReplace = Array.from(new Set([...existingPayloadTables, ...snapshotTables, ...KNOWN_STORAGE_TABLES])).sort();
  for (const table of tablesToReplace) {
    await ensurePayloadTable(client, table);
  }

  for (const indexName of REBUILD_BEFORE_RESTORE_INDEXES) {
    await client.query(`DROP INDEX IF EXISTS ${quoteIdentifier(indexName)}`);
  }

  for (const table of tablesToReplace) {
    await client.query(`TRUNCATE TABLE ${quoteIdentifier(table)}`);
  }

  for (const table of snapshotTables) {
    const rows = snapshot.tables[table];
    await insertRows(client, table, rows);
    console.log(`  ✓ ${table}: ${rows.length} rows`);
  }

  await client.query(
    `INSERT INTO storage_metadata (key, value, updated_at)
     VALUES ('database_shape', $1::jsonb, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify({ version: SNAPSHOT_SCHEMA_VERSION, provider: 'postgres' })],
  );

  const duplicateCheckIds = await warnAboutDuplicates(client);
  await ensureIndexes(client, duplicateCheckIds);

  await client.query('COMMIT');
  console.log('\n✅ 임포트 완료. 이제 백엔드 기동하세요.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('❌ ROLLBACK:', e.message);
  process.exit(1);
} finally {
  await client.end();
}
