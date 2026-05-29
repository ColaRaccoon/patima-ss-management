// DB snapshot export — all JSONB storage tables into a single JSON file.
// 회사 ↔ 집 PC 간 데이터 이동, 백업 용도로 사용.
//
// Usage:
//   node scripts/db-export.mjs                  // backups/patima-<timestamp>.json
//   node scripts/db-export.mjs out.json         // 파일명 지정

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const SNAPSHOT_SCHEMA_VERSION = 2;
const SNAPSHOT_FORMAT = 'jsonb-payload-v2';

const CONN = process.env.DATABASE_URL;
if (!CONN) throw new Error('DATABASE_URL env 없음. .env 확인.');

const outArg = process.argv[2];
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const defaultPath = path.resolve(`backups/patima-${ts}.json`);
const outPath = outArg ? path.resolve(outArg) : defaultPath;
fs.mkdirSync(path.dirname(outPath), { recursive: true });

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

const client = new pg.Client({ connectionString: CONN });
await client.connect();

const tables = (await client.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' ORDER BY table_name
`)).rows.map((r) => r.table_name);

const snapshot = {
  meta: {
    dumpedAt: new Date().toISOString(),
    source: CONN.replace(/:[^:@]*@/, ':***@'),
    format: SNAPSHOT_FORMAT,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    storage: 'id-payload-jsonb-row-level',
  },
  tables: {},
};

for (const table of tables) {
  const cols = (await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
  `, [table])).rows.map((r) => r.column_name);
  if (!cols.includes('payload')) continue; // only JSONB blob tables

  const tableSql = quoteIdentifier(table);
  const hashColumn = cols.includes('payload_hash') ? 'payload_hash' : 'NULL AS payload_hash';
  const rows = (await client.query(
    `SELECT id, payload, ${hashColumn}, updated_at FROM ${tableSql} ORDER BY id`,
  )).rows.map((row) => ({
    id: row.id,
    payload: row.payload,
    payload_hash: row.payload_hash ?? hashPayload(row.payload),
    updated_at: row.updated_at,
  }));

  snapshot.tables[table] = rows;
  console.log(`  ✓ ${table}: ${rows.length} rows`);
}

fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
const size = fs.statSync(outPath).size;
console.log(`\n✅ ${outPath} (${size.toLocaleString()} bytes)`);

await client.end();
