// 비용 설정의 시작일(effectiveFrom)을 일괄 변경하는 마이그레이션 스크립트.
//
// 기본 동작: effectiveFrom === '2026-04-01' 인 row 들을 '2024-01-01' 로 변경합니다.
//
// Usage:
//   node scripts/update-cost-effective-from.mjs                        # Postgres 모드 (DATABASE_URL 필요)
//   node scripts/update-cost-effective-from.mjs --file                 # 파일 모드 (data/database.json)
//   node scripts/update-cost-effective-from.mjs --from=2026-04-01 --to=2024-01-01
//   node scripts/update-cost-effective-from.mjs --dry-run              # 실제 수정 없이 미리보기만
//
// 안전장치:
//   - 실행 전, sales_unit_cost_settings 테이블의 모든 row 를 backups/ 디렉토리에 JSON 으로 백업합니다.
//   - --dry-run 옵션을 사용하면 어떤 row 가 바뀔지 보여주기만 합니다.

import dotenv from 'dotenv';
dotenv.config();

const args = process.argv.slice(2);
const useFile = args.includes('--file') || !process.env.DATABASE_URL;
const dryRun = args.includes('--dry-run');

const fromArg = args.find((a) => a.startsWith('--from='));
const toArg = args.find((a) => a.startsWith('--to='));
const FROM_DATE = fromArg ? fromArg.split('=')[1] : '2026-04-01';
const TO_DATE = toArg ? toArg.split('=')[1] : '2024-01-01';

console.log('────────────────────────────────────────────────────────');
console.log(' 비용 설정 effectiveFrom 일괄 변경');
console.log('────────────────────────────────────────────────────────');
console.log(` 모드     : ${useFile ? '파일' : 'Postgres'}`);
console.log(` FROM     : ${FROM_DATE}`);
console.log(` TO       : ${TO_DATE}`);
console.log(` Dry-run  : ${dryRun ? 'YES (실제 수정 안 함)' : 'NO (실제 수정함)'}`);
console.log('────────────────────────────────────────────────────────\n');

const fs = (await import('node:fs')).default;
const path = (await import('node:path')).default;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.resolve('backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

if (useFile) {
  // ── 파일 모드 ─────────────────────────────────────────────────────────
  const dataDir = process.env.DATA_DIR ?? path.resolve('apps/backend/data');
  const filePath = path.join(dataDir, 'database.json');

  if (!fs.existsSync(filePath)) {
    console.error(`❌ 파일을 찾을 수 없습니다: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const backupPath = path.join(backupDir, `database-pre-effective-from-${stamp}.json`);
  fs.writeFileSync(backupPath, raw);
  console.log(`📦 백업 저장: ${backupPath}\n`);

  const db = JSON.parse(raw);
  const settings = db.salesUnitCostSettings ?? [];
  console.log(`전체 비용 설정 row: ${settings.length}개`);

  let count = 0;
  for (const row of settings) {
    if (row.effectiveFrom !== FROM_DATE) continue;
    console.log(
      `  ${dryRun ? '· (dry-run)' : '✓'} ${row.canonicalSalesUnitId ?? row.id}  effectiveFrom: ${row.effectiveFrom} → ${TO_DATE}`,
    );
    if (!dryRun) row.effectiveFrom = TO_DATE;
    count++;
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, JSON.stringify(db, null, 2));
  }
  console.log(`\n${dryRun ? 'ℹ️  Dry-run' : '✅ 완료'}: ${count}개 row 대상 (파일 모드)`);
} else {
  // ── Postgres 모드 ─────────────────────────────────────────────────────
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // 1) 백업: 테이블 전체를 JSON 으로 덤프
  const all = await client.query(
    `SELECT id, payload, updated_at FROM sales_unit_cost_settings ORDER BY id`,
  );
  const backupPath = path.join(backupDir, `sales_unit_cost_settings-pre-effective-from-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(all.rows, null, 2));
  console.log(`📦 백업 저장: ${backupPath} (${all.rows.length} rows)\n`);

  // 2) 대상 row 찾기 + 업데이트
  console.log(`전체 비용 설정 row: ${all.rows.length}개`);
  let count = 0;
  for (const row of all.rows) {
    const current = row.payload?.effectiveFrom;
    if (current !== FROM_DATE) continue;

    const updated = { ...row.payload, effectiveFrom: TO_DATE };
    console.log(
      `  ${dryRun ? '· (dry-run)' : '✓'} ${row.payload.canonicalSalesUnitId ?? row.id}  effectiveFrom: ${current} → ${TO_DATE}`,
    );
    if (!dryRun) {
      await client.query(
        `UPDATE sales_unit_cost_settings SET payload = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(updated), row.id],
      );
    }
    count++;
  }

  // 3) 검증 출력
  if (!dryRun) {
    const verify = await client.query(
      `SELECT COUNT(*)::int AS still_old
         FROM sales_unit_cost_settings
        WHERE payload->>'effectiveFrom' = $1`,
      [FROM_DATE],
    );
    const verifyNew = await client.query(
      `SELECT COUNT(*)::int AS now_new
         FROM sales_unit_cost_settings
        WHERE payload->>'effectiveFrom' = $1`,
      [TO_DATE],
    );
    console.log(`\n검증: '${FROM_DATE}' 잔여 = ${verify.rows[0].still_old}, '${TO_DATE}' 합계 = ${verifyNew.rows[0].now_new}`);
  }

  await client.end();
  console.log(`\n${dryRun ? 'ℹ️  Dry-run' : '✅ 완료'}: ${count}개 row 대상 (Postgres 모드)`);
}
