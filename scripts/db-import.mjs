// DB snapshot import — restore a JSON snapshot produced by db-export.mjs.
// 주의: 대상 DB의 모든 JSONB 블롭 테이블을 TRUNCATE 후 스냅샷으로 교체한다.
//       백엔드가 켜져있으면 snapshot-replace persistence로 덮어써질 수 있으니 반드시 중지.
//
// Usage:
//   node scripts/db-import.mjs <snapshot.json>
//   node scripts/db-import.mjs <snapshot.json> --yes   // 확인 프롬프트 건너뜀

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import dotenv from 'dotenv';
dotenv.config();

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

const snapshot = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
if (snapshot.meta?.format !== 'jsonb-payload-v1') {
  console.error(`❌ 지원하지 않는 snapshot 포맷: ${snapshot.meta?.format}`);
  process.exit(1);
}

console.log(`Snapshot: ${fullPath}`);
console.log(`  dumpedAt: ${snapshot.meta.dumpedAt}`);
console.log(`  source:   ${snapshot.meta.source}`);
console.log(`  tables:   ${Object.keys(snapshot.tables).length}`);
console.log(`  target:   ${CONN.replace(/:[^:@]*@/, ':***@')}`);

if (!auto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question('\n대상 DB의 모든 JSONB 테이블을 TRUNCATE 후 교체합니다. 진행? (yes/no): ', res));
  rl.close();
  if (ans.trim().toLowerCase() !== 'yes') {
    console.log('취소됨.');
    process.exit(0);
  }
}

const client = new pg.Client({ connectionString: CONN });
await client.connect();
try {
  await client.query('BEGIN');

  for (const [table, rows] of Object.entries(snapshot.tables)) {
    // ensure table exists with (id, payload, updated_at) schema
    const exists = (await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1
    `, [table])).rowCount > 0;
    if (!exists) {
      await client.query(`
        CREATE TABLE ${table} (
          id TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      console.log(`  + created table ${table}`);
    }

    await client.query(`TRUNCATE TABLE ${table}`);
    for (const r of rows) {
      await client.query(
        `INSERT INTO ${table} (id, payload, updated_at) VALUES ($1, $2::jsonb, $3)`,
        [r.id, JSON.stringify(r.payload), r.updated_at ?? new Date()],
      );
    }
    console.log(`  ✓ ${table}: ${rows.length} rows`);
  }

  await client.query('COMMIT');
  console.log('\n✅ 임포트 완료. 이제 백엔드 기동하세요.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('❌ ROLLBACK:', e.message);
  process.exit(1);
} finally {
  await client.end();
}
