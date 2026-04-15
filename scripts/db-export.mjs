// DB snapshot export — all JSONB storage tables into a single JSON file.
// 회사 ↔ 집 PC 간 데이터 이동, 백업 용도로 사용.
//
// Usage:
//   node scripts/db-export.mjs                  // backups/patima-<timestamp>.json
//   node scripts/db-export.mjs out.json         // 파일명 지정

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config();

const CONN = process.env.DATABASE_URL;
if (!CONN) throw new Error('DATABASE_URL env 없음. .env 확인.');

const outArg = process.argv[2];
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const defaultPath = path.resolve(`backups/patima-${ts}.json`);
const outPath = outArg ? path.resolve(outArg) : defaultPath;
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const client = new pg.Client({ connectionString: CONN });
await client.connect();

const tables = (await client.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' ORDER BY table_name
`)).rows.map(r => r.table_name);

const snapshot = {
  meta: {
    dumpedAt: new Date().toISOString(),
    source: CONN.replace(/:[^:@]*@/, ':***@'),
    format: 'jsonb-payload-v1',
  },
  tables: {},
};

for (const t of tables) {
  const cols = (await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
  `, [t])).rows.map(r => r.column_name);
  if (!cols.includes('payload')) continue; // only JSONB blob tables
  const rows = (await client.query(`SELECT id, payload, updated_at FROM ${t} ORDER BY id`)).rows;
  snapshot.tables[t] = rows;
  console.log(`  ✓ ${t}: ${rows.length} rows`);
}

fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
const size = fs.statSync(outPath).size;
console.log(`\n✅ ${outPath} (${size.toLocaleString()} bytes)`);

await client.end();
