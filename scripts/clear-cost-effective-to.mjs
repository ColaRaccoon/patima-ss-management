// 비용 설정의 종료일(effectiveTo) 전부 null로 초기화하는 마이그레이션 스크립트.
//
// Usage:
//   node scripts/clear-cost-effective-to.mjs          # Postgres 모드 (DATABASE_URL 필요)
//   node scripts/clear-cost-effective-to.mjs --file   # 파일 모드 (data/database.json)

import dotenv from 'dotenv';
dotenv.config();

const useFile = process.argv.includes('--file') || !process.env.DATABASE_URL;

if (useFile) {
  // ── 파일 모드 ─────────────────────────────────────────────────────────
  import('node:fs').then(({ default: fs }) => {
    import('node:path').then(({ default: path }) => {
      const dataDir = process.env.DATA_DIR ?? path.resolve('apps/backend/data');
      const filePath = path.join(dataDir, 'database.json');

      if (!fs.existsSync(filePath)) {
        console.error(`❌ 파일을 찾을 수 없습니다: ${filePath}`);
        process.exit(1);
      }

      const db = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const settings = db.salesUnitCostSettings ?? [];

      let count = 0;
      for (const row of settings) {
        if (row.effectiveTo != null) {
          row.effectiveTo = null;
          count++;
        }
      }

      fs.writeFileSync(filePath, JSON.stringify(db, null, 2));
      console.log(`✅ 파일 모드 완료: ${count}개 row의 effectiveTo를 null로 초기화했습니다.`);
    });
  });
} else {
  // ── Postgres 모드 ─────────────────────────────────────────────────────
  const { default: pg } = await import('pg');

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // 전체 row 조회 후 effectiveTo 가 null이 아닌 것만 업데이트
  // (JSONB의 JSON null은 SQL IS NOT NULL 조건으로 걸러지지 않으므로 JS에서 판별)
  const res = await client.query(`SELECT id, payload FROM sales_unit_cost_settings`);

  console.log(`전체 비용 설정 row: ${res.rows.length}개`);

  let count = 0;
  for (const row of res.rows) {
    const effectiveTo = row.payload?.effectiveTo;
    if (effectiveTo == null) continue; // 이미 null이면 건너뜀

    const updated = { ...row.payload, effectiveTo: null };
    await client.query(
      `UPDATE sales_unit_cost_settings SET payload = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(updated), row.id],
    );
    count++;
    console.log(`  ✓ ${row.payload.canonicalSalesUnitId ?? row.id}  effectiveTo: ${effectiveTo} → null`);
  }

  await client.end();
  if (count === 0) {
    console.log(`\nℹ️  effectiveTo 가 설정된 row가 없습니다. 이미 모두 null 상태입니다.`);
  } else {
    console.log(`\n✅ Postgres 모드 완료: ${count}개 row의 effectiveTo를 null로 초기화했습니다.`);
  }
}
