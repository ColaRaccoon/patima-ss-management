// Full JSONB snapshot export for backup and one-way home/company PC sync.
//
// Usage:
//   node scripts/db-export.mjs
//   node scripts/db-export.mjs backups/patima-manual.json

import fs from 'node:fs';
import path from 'node:path';
import {
  FULL_SYNC_TABLES,
  SNAPSHOT_FORMAT,
  SNAPSHOT_SCHEMA_VERSION,
  createPgClient,
  getExistingPayloadTables,
  getExistingPublicTables,
  hashPayload,
  quoteIdentifier,
  redactConnectionString,
} from './db-maintenance-utils.mjs';

const client = await createPgClient();
if (!client) {
  throw new Error('DATABASE_URL env is required for PostgreSQL full snapshot export.');
}

const outArg = process.argv[2];
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const defaultPath = path.resolve(`backups/patima-${ts}.json`);
const outPath = outArg ? path.resolve(outArg) : defaultPath;
fs.mkdirSync(path.dirname(outPath), { recursive: true });

try {
  const existingPublicTables = await getExistingPublicTables(client);
  const payloadTables = await getExistingPayloadTables(client);
  const payloadTableSet = new Set(payloadTables);
  const tables = Array.from(new Set([...FULL_SYNC_TABLES, ...payloadTables])).sort();

  const snapshot = {
    meta: {
      dumpedAt: new Date().toISOString(),
      source: redactConnectionString(process.env.DATABASE_URL),
      format: SNAPSHOT_FORMAT,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      storage: 'id-payload-jsonb-row-level',
      fullSync: {
        mode: 'one-way-full-replace',
        configuredTables: FULL_SYNC_TABLES,
        existingPayloadTables: payloadTables,
        existingPublicTables,
      },
    },
    tables: {},
  };

  console.log('Exporting PostgreSQL JSONB full snapshot');
  console.log(`  target file: ${outPath}`);
  console.log(`  payload tables: ${tables.length}`);

  for (const table of tables) {
    if (!payloadTableSet.has(table)) {
      snapshot.tables[table] = [];
      console.log(`  ${table}: 0 rows (configured table missing in current DB)`);
      continue;
    }

    const tableSql = quoteIdentifier(table);
    const rows = (
      await client.query(
        `SELECT id, payload, updated_at
         FROM ${tableSql}
         ORDER BY id`,
      )
    ).rows.map((row) => ({
      id: row.id,
      payload: row.payload,
      payload_hash: hashPayload(row.payload),
      updated_at: row.updated_at,
    }));

    snapshot.tables[table] = rows;
    console.log(`  ${table}: ${rows.length} rows`);
  }

  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  const size = fs.statSync(outPath).size;
  console.log(`\nWrote ${outPath} (${size.toLocaleString()} bytes)`);
} finally {
  await client.end();
}

