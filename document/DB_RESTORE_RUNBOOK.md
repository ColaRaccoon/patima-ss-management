# DB restore rehearsal runbook

이 문서는 Patima Naver SS의 PostgreSQL JSONB snapshot을 복구하고, 집/회사 PC 사이에서 단방향 full sync를 리허설하는 절차입니다.

## 원칙

- 공식 동기화 수단은 `scripts/db-export.mjs` / `scripts/db-import.mjs`입니다.
- 이 방식은 양방향 merge가 아니라 **한 PC의 전체 snapshot을 다른 PC에 덮어쓰는 단방향 full sync**입니다.
- 대상 PC의 backend는 import 전에 반드시 중지합니다.
- 집/회사 PC의 `.env` `MASTER_KEY`는 같아야 합니다.
- 보안/암호화/접근제어 정책은 별도 단계에서 다룹니다. 이 문서는 복구 가능성과 운영 절차만 다룹니다.

## 공통 restore 리허설

1. 현재 DB snapshot을 생성합니다.

   ```powershell
   node scripts/db-export.mjs
   ```

2. 임시 PostgreSQL DB를 만듭니다.

   예: `patima_restore_rehearsal`

3. 터미널의 `DATABASE_URL`을 임시 DB로 지정합니다.

   ```powershell
   $env:DATABASE_URL="postgresql://patima_app:password@localhost:5432/patima_restore_rehearsal"
   ```

4. snapshot을 restore합니다.

   ```powershell
   node scripts/db-import.mjs backups/patima-xxxx.json --yes
   ```

5. backend를 임시 DB로 기동합니다.

   ```powershell
   npm.cmd run dev:backend
   ```

6. 주요 smoke test를 수행합니다.

   - store 목록 조회
   - 주문 목록 조회
   - 주문상품 pagination 조회
   - 광고 업로드/매핑 화면 조회
   - 일별 수익 summary 조회
   - operation 목록 조회

7. 원본 DB와 임시 DB의 row count를 비교합니다.

   ```powershell
   node scripts/report-db-size.mjs
   ```

8. 실패 시 기록합니다.

   - 사용한 snapshot 파일명
   - 원본/대상 `DATABASE_URL`의 DB 이름
   - 실패 명령
   - 오류 메시지
   - 누락 table 또는 row count 차이

## 회사 -> 집 이동 시나리오

회사 PC를 원본으로 정하고 집 PC를 덮어씁니다.

1. 회사 PC에서 backend를 잠시 중지하거나 쓰기 작업이 없는 시간을 잡습니다.
2. 회사 PC에서 snapshot을 생성합니다.

   ```powershell
   node scripts/db-export.mjs
   node scripts/report-db-size.mjs
   ```

3. 생성된 `backups/patima-xxxx.json` 파일을 집 PC로 이동합니다.
4. 집 PC의 backend를 중지합니다.
5. 집 PC의 `.env`에서 `DATABASE_URL`, `MASTER_KEY`를 확인합니다.
6. 집 PC에서 import합니다.

   ```powershell
   node scripts/db-import.mjs backups/patima-xxxx.json --yes
   ```

7. 집 PC에서 backend를 기동하고 주요 화면/API를 확인합니다.
8. 집 PC에서 `node scripts/report-db-size.mjs`를 실행해 회사 PC 리포트와 row count를 비교합니다.

## 집 -> 회사 이동 시나리오

집 PC를 원본으로 정하고 회사 PC를 덮어씁니다.

1. 집 PC에서 backend를 잠시 중지하거나 쓰기 작업이 없는 시간을 잡습니다.
2. 집 PC에서 snapshot을 생성합니다.

   ```powershell
   node scripts/db-export.mjs
   node scripts/report-db-size.mjs
   ```

3. 생성된 `backups/patima-xxxx.json` 파일을 회사 PC로 이동합니다.
4. 회사 PC의 backend를 중지합니다.
5. 회사 PC의 `.env`에서 `DATABASE_URL`, `MASTER_KEY`를 확인합니다.
6. 회사 PC에서 import합니다.

   ```powershell
   node scripts/db-import.mjs backups/patima-xxxx.json --yes
   ```

7. 회사 PC에서 backend를 기동하고 주요 화면/API를 확인합니다.
8. 회사 PC에서 `node scripts/report-db-size.mjs`를 실행해 집 PC 리포트와 row count를 비교합니다.

## prune 전 권장 순서

1. 최신 snapshot 생성

   ```powershell
   node scripts/db-export.mjs
   ```

2. DB 크기와 후보 row 확인

   ```powershell
   node scripts/report-db-size.mjs
   node scripts/prune-order-raw-payloads.mjs --days 90
   node scripts/prune-audit-logs.mjs --days 180
   node scripts/prune-operations.mjs --days 90 --keep-failed
   ```

3. 사용자 승인 후에만 `--yes` 실행
4. 실행 후 `node scripts/report-db-size.mjs`로 row count와 rawPayload null/non-null count 재확인

