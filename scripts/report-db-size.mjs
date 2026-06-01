import fs from 'node:fs';
import path from 'node:path';
import {
  DATABASE_SHAPE_KEYS,
  FULL_SYNC_TABLES,
  createPgClient,
  formatBytes,
  getExistingPayloadTables,
  listBackupFiles,
  quoteIdentifier,
  redactConnectionString,
} from './db-maintenance-utils.mjs';

const rawPayloadCountsSql = `
  COUNT(*) FILTER (
    WHERE payload ? 'rawPayload'
      AND payload->'rawPayload' IS DISTINCT FROM 'null'::jsonb
  )::int AS raw_payload_non_null_count,
  COUNT(*) FILTER (
    WHERE payload ? 'rawPayload'
      AND payload->'rawPayload' = 'null'::jsonb
  )::int AS raw_payload_null_count
`;

const reportBackups = () => {
  const backups = listBackupFiles();
  console.log('\nBackup files');
  if (backups.length === 0) {
    console.log('  none');
    return;
  }
  for (const file of backups.slice(0, 20)) {
    console.log(`  ${file.relativePath}: ${formatBytes(file.bytes)} (modified ${file.modifiedAt})`);
  }
};

const reportPostgres = async (client) => {
  console.log(`Target: ${redactConnectionString(process.env.DATABASE_URL)}`);
  const payloadTables = await getExistingPayloadTables(client);
  const payloadTableSet = new Set(payloadTables);
  const knownTableSet = new Set(FULL_SYNC_TABLES);
  const missingKnownTables = FULL_SYNC_TABLES.filter((table) => !payloadTableSet.has(table));
  const extraPayloadTables = payloadTables.filter((table) => !knownTableSet.has(table));
  const exportTables = Array.from(new Set([...FULL_SYNC_TABLES, ...payloadTables])).sort();

  console.log('\nFull sync coverage');
  console.log(`  configured full-sync tables=${FULL_SYNC_TABLES.length}`);
  console.log(`  existing payload tables=${payloadTables.length}`);
  console.log(`  db-export will include payload tables=${exportTables.length}`);
  console.log(`  missing configured tables=${missingKnownTables.length ? missingKnownTables.join(', ') : 'none'}`);
  console.log(`  extra payload tables=${extraPayloadTables.length ? extraPayloadTables.join(', ') : 'none'}`);

  console.log('\nTable sizes');
  const tableRows = [];
  for (const table of exportTables) {
    if (!payloadTableSet.has(table)) {
      tableRows.push({ table, rowCount: 0, payloadBytes: 0, missing: true });
      continue;
    }
    const tableSql = quoteIdentifier(table);
    const result = await client.query(
      `SELECT COUNT(*)::int AS row_count,
              COALESCE(SUM(pg_column_size(payload)), 0)::bigint AS payload_bytes
       FROM ${tableSql}`,
    );
    const row = result.rows[0];
    tableRows.push({
      table,
      rowCount: Number(row.row_count || 0),
      payloadBytes: Number(row.payload_bytes || 0),
      missing: false,
    });
  }
  tableRows
    .sort((left, right) => right.payloadBytes - left.payloadBytes || left.table.localeCompare(right.table))
    .forEach((row) => {
      const suffix = row.missing ? ' (missing table)' : '';
      console.log(`  ${row.table}: rows=${row.rowCount.toLocaleString()}, payload=${formatBytes(row.payloadBytes)}${suffix}`);
    });

  console.log('\nRaw payload retention');
  for (const table of ['orders', 'order_items']) {
    if (!payloadTableSet.has(table)) {
      console.log(`  ${table}: missing`);
      continue;
    }
    const result = await client.query(
      `SELECT COUNT(*)::int AS row_count, ${rawPayloadCountsSql}
       FROM ${quoteIdentifier(table)}`,
    );
    const row = result.rows[0];
    console.log(
      `  ${table}: rows=${row.row_count}, rawPayload non-null=${row.raw_payload_non_null_count}, rawPayload null=${row.raw_payload_null_count}`,
    );
  }

  if (payloadTableSet.has('audit_logs')) {
    const result = await client.query(
      `SELECT COUNT(*)::int AS row_count,
              ROUND(AVG(pg_column_size(payload)))::int AS average_payload_bytes,
              MAX(pg_column_size(payload))::int AS max_payload_bytes
       FROM audit_logs`,
    );
    const row = result.rows[0];
    console.log('\nAudit logs');
    console.log(`  rows=${row.row_count}, average payload=${formatBytes(row.average_payload_bytes)}, max payload=${formatBytes(row.max_payload_bytes)}`);
  }

  if (payloadTableSet.has('operations')) {
    const result = await client.query(
      `SELECT COUNT(*)::int AS row_count,
              COUNT(*) FILTER (
                WHERE payload ? 'resultJson'
                  AND payload->'resultJson' IS DISTINCT FROM 'null'::jsonb
              )::int AS result_json_non_null_count,
              ROUND(AVG(pg_column_size(payload)))::int AS average_payload_bytes
       FROM operations`,
    );
    const row = result.rows[0];
    console.log('\nOperations');
    console.log(`  rows=${row.row_count}, resultJson non-null=${row.result_json_non_null_count}, average payload=${formatBytes(row.average_payload_bytes)}`);
  }

  const largest = [];
  for (const table of payloadTables) {
    const result = await client.query(
      `SELECT $1::text AS table_name,
              id,
              pg_column_size(payload)::int AS payload_bytes,
              LEFT(payload::text, 160) AS sample
       FROM ${quoteIdentifier(table)}
       ORDER BY pg_column_size(payload) DESC
       LIMIT 20`,
      [table],
    );
    largest.push(...result.rows);
  }
  largest.sort((left, right) => Number(right.payload_bytes) - Number(left.payload_bytes));

  console.log('\nLargest payload rows');
  if (largest.length === 0) {
    console.log('  none');
  } else {
    for (const row of largest.slice(0, 20)) {
      console.log(`  ${row.table_name}/${row.id}: ${formatBytes(row.payload_bytes)} sample=${row.sample}`);
    }
  }
};

const getFileModeDatabasePath = () =>
  path.resolve(process.env.DATA_DIR || './apps/backend/data', 'database.json');

const reportFileMode = () => {
  const filePath = getFileModeDatabasePath();
  console.log('DATABASE_URL is missing. Reporting file mode target.');
  console.log(`Target file: ${filePath}`);
  if (!fs.existsSync(filePath)) {
    console.log('File mode database does not exist yet.');
    return;
  }

  const database = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const tableRows = DATABASE_SHAPE_KEYS.map(([key, table]) => {
    const rows = Array.isArray(database[key]) ? database[key] : [];
    const payloadBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
    return { key, table, rows, payloadBytes };
  });

  console.log('\nFull sync coverage');
  console.log(`  configured full-sync tables=${FULL_SYNC_TABLES.length}`);
  console.log('  db-export/db-import require DATABASE_URL for PostgreSQL full sync.');

  console.log('\nFile collections');
  tableRows
    .sort((left, right) => right.payloadBytes - left.payloadBytes || left.table.localeCompare(right.table))
    .forEach((row) => {
      console.log(`  ${row.table}: rows=${row.rows.length.toLocaleString()}, payload=${formatBytes(row.payloadBytes)}`);
    });

  const orders = Array.isArray(database.orders) ? database.orders : [];
  const orderItems = Array.isArray(database.orderItems) ? database.orderItems : [];
  console.log('\nRaw payload retention');
  for (const [label, rows] of [
    ['orders', orders],
    ['order_items', orderItems],
  ]) {
    const nonNull = rows.filter((row) => row.rawPayload !== null && row.rawPayload !== undefined).length;
    const nullCount = rows.filter((row) => row.rawPayload === null).length;
    console.log(`  ${label}: rows=${rows.length}, rawPayload non-null=${nonNull}, rawPayload null=${nullCount}`);
  }
};

console.log('DB size report');
const client = await createPgClient();
try {
  if (client) {
    await reportPostgres(client);
  } else {
    reportFileMode();
  }
  reportBackups();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client?.end();
}

