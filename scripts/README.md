# scripts

운영/보수용 스크립트 모음입니다. DB 관련 스크립트는 PostgreSQL `DATABASE_URL`을 기준으로 동작합니다.

## 현재 PostgreSQL 저장 구조

현재 runtime PostgreSQL 저장소는 정규화된 컬럼 모델이 아니라 `DatabaseShape`의 각 컬렉션을 payload table로 나눈 구조입니다. 각 table은 기본적으로 `id`, `payload JSONB`, `payload_hash`, `updated_at`을 가지며, backend 시작 시 payload table을 읽어 메모리 snapshot을 구성합니다.

일반 `writeCommitted()` 경로는 메모리 `DatabaseShape`를 deep clone하고 변경된 snapshot을 PostgreSQL에 committed persistence로 저장합니다. `persistSnapshotToPostgres()`는 payload table을 순회하면서 `payload_hash` 기반 upsert/delete를 수행하므로, 변경되지 않은 row의 최종 UPDATE는 피하지만 전체 컬렉션 순회/직렬화/hash 비용은 남아 있습니다.

수동 매핑처럼 자주 누르는 hot path는 PostgreSQL mode에서 이 전체 snapshot persistence를 타지 않도록 분리했습니다.

- 주문 수동 매핑: `OrderMappingService.saveMappings()` -> `DatabaseService.saveOrderManualMappingsCommitted()`
- 광고 수동 매핑/의도적 제외/재계산: `AdsService` mapping API -> `DatabaseService.saveAdCampaignMappingsCommitted()`
- 영향 날짜 요약 갱신: `ProfitSummaryService.refreshStoreDateListBestEffort()` -> `DatabaseService.replaceDailyProfitSummariesCommitted()`

이 direct write 경로는 transaction 안에서 대상 signature/row만 `FOR UPDATE`로 조회하고, payload와 `payload_hash`를 갱신한 뒤 commit 후 같은 row를 메모리 snapshot에 반영합니다. file mode에서는 기존 `writeCommitted()` fallback을 유지합니다.

2026-06-04 기준 `node scripts/report-db-size.mjs` 확인 결과, `order_items` 34,133 rows / payload 104,473,785 bytes, `orders` 25,644 rows / payload 69,182,001 bytes입니다. 이 규모에서는 수동 매핑 저장이 전체 snapshot persistence를 다시 타지 않는지 계속 회귀 테스트로 확인해야 합니다.

## 수동 매핑 성능 검증

실 DB에 임의 수동 매핑 POST를 보내는 측정은 운영 데이터 변경이므로 사용자 승인 없이 실행하지 않습니다. 안전한 기본 검증은 backend 테스트 fixture와 코드 리뷰입니다.

```powershell
npm run test --workspace @patima/backend
npm run typecheck --workspace @patima/backend
node scripts/report-db-size.mjs
```

확인할 테스트 관점:

- `DatabaseService PostgreSQL saves order manual mappings with row-level direct updates`
- `DatabaseService PostgreSQL saves ad campaign mappings with row-level direct updates`
- `OrderMappingService saveMappings updates only related rows and refreshes affected dates directly`
- `AdsService PostgreSQL mapping APIs bypass writeCommitted snapshot persistence`
- `ProfitSummaryService PostgreSQL daily summary calculation waits for queued committed writes`

이 테스트들은 PostgreSQL mode double에서 `writeCommitted()` 또는 `persistSnapshotToPostgres()`가 호출되면 실패하도록 구성되어 있습니다. SQL text도 `UPDATE order_source_signatures`, `UPDATE order_items`, `INSERT INTO ad_campaign_signatures`, `UPDATE ad_campaign_daily_costs`, `daily_*` summary table 작업처럼 대상 row/table 중심인지 확인합니다.

실제 latency를 측정해야 할 때는 운영 변경 승인을 받은 뒤, 변경 전 `db-export` 백업을 남기고, 대표 signature 한두 개만 선택해 단건/소량 batch 기준으로 측정합니다. 권장 기준은 기존 15~20초 수준이 아니라 1~3초 이하이며, 큰 batch는 대상 row 수와 영향 날짜 수에 비례해야 합니다. 측정 후에는 `node scripts/report-db-size.mjs`와 backend health/status에서 pending write가 장시간 남지 않는지 확인합니다.

## 공식 집/회사 DB 동기화

현재 공식 수단은 `scripts/db-export.mjs` / `scripts/db-import.mjs` 기반 **단방향 전체 snapshot 이동**입니다. 양방향 merge가 아니며, 한쪽 PC를 원본으로 정한 뒤 다른 PC DB를 snapshot 상태로 덮어씁니다.

원본 PC:

```powershell
node scripts/db-export.mjs
```

대상 PC:

```powershell
node scripts/db-import.mjs backups/patima-xxxx.json --yes
```

필수 조건:

- 대상 PC의 backend는 import 전에 중지합니다.
- 집/회사 `.env`의 `MASTER_KEY`는 같아야 합니다.
- `DATABASE_URL`은 대상 PostgreSQL DB를 가리켜야 합니다.
- `backups/`는 gitignore 대상이므로 snapshot 파일은 USB, 개인 클라우드, 사내 승인 경로 등 별도 수단으로 이동합니다.
- 양쪽 PC에서 동시에 수정한 데이터를 자동 merge하지 않습니다.
- 원본 PC에서 `node scripts/report-db-size.mjs`로 full-sync table 누락이 없는지 확인한 뒤 export합니다.
- 대상 PC에서 `db-import.mjs --yes`는 JSONB payload table을 `TRUNCATE` 후 재삽입하므로, 대상 PC의 미동기화 로컬 변경은 사라집니다.

`db-export.mjs`는 현재 schema의 JSONB payload 테이블 전체를 snapshot에 포함합니다. 새 payload 테이블이 생기면 `scripts/db-maintenance-utils.mjs`의 `FULL_SYNC_TABLES`, `db-import.mjs`, 이 문서를 함께 확인합니다.

`db-import.mjs`는 명시적 restore/full sync 도구이므로 대상 JSONB payload 테이블을 `TRUNCATE` 후 snapshot row를 재삽입합니다. runtime API persistence에서 `TRUNCATE`를 쓰지 않는 것과 별개의 운영 복구 절차입니다.

## DB 크기 리포트

```powershell
node scripts/report-db-size.mjs
```

쓰기 경로 변경 전후 기준 측정에는 이 명령을 실행하고, timestamp가 포함된 출력을 관련 측정 문서에 붙입니다. 로컬 파일로 남기려면:

```powershell
node scripts/report-db-size.mjs > backups/db-size-baseline.txt
```

출력 항목:

- table별 row count와 payload byte 추정치
- export 대상 table 누락 여부
- `orders` / `order_items`의 `rawPayload` null/non-null count
- `audit_logs`, `operations` 요약
- 가장 큰 payload row top 20
- `backups/` 파일 크기 목록

## rawPayload 수동 prune

기본은 dry-run입니다.

```powershell
node scripts/prune-order-raw-payloads.mjs --days 90
node scripts/prune-order-raw-payloads.mjs --days 90 --yes
```

동작:

- `orders.payload.rawPayload`, `order_items.payload.rawPayload` 값만 JSON null로 바꿉니다.
- 주문 row, 주문상품 row, option/fee/revenue/mapping 필드, daily summary row는 삭제하지 않습니다.
- 기준일은 KST cutoff입니다.
- `orders`: `paymentDatetime -> orderDatetime -> syncedAt`
- `order_items`: `paymentDate -> orderDate -> createdAt`
- 실제 변경 시 `payload_hash`는 null로 두어 다음 backend 기동/쓰기 또는 export 시 실제 payload 기준으로 다시 계산되게 합니다.

권장 운영 순서:

1. 백업/export: `node scripts/db-export.mjs`로 최신 snapshot을 남기고, 필요하면 `node scripts/report-db-size.mjs > backups/db-size-before-raw-payload-prune.txt`도 저장합니다.
2. backend 중지: `--yes` 실행 중에는 runtime write와 겹치지 않도록 backend를 중지하는 것을 권장합니다. 스크립트도 localhost backend 응답을 감지하면 경고합니다.
3. dry-run: `node scripts/prune-order-raw-payloads.mjs --days 90`으로 대상 row 수를 확인합니다.
4. 승인 실행: dry-run 결과와 백업을 확인한 뒤에만 `node scripts/prune-order-raw-payloads.mjs --days 90 --yes`를 실행합니다.
5. 실행 후 report: `node scripts/report-db-size.mjs`로 `orders` / `order_items` rawPayload null/non-null count와 payload size 변화를 확인합니다.

`--yes`는 실제 DB payload를 변경하므로 자동화나 검증 작업에서 임의로 실행하지 않습니다.

## audit log 보존/archive

기본 보존 기간은 180일입니다.

```powershell
node scripts/prune-audit-logs.mjs --days 180
node scripts/prune-audit-logs.mjs --days 180 --yes
```

`--yes`를 붙이면 cutoff 이전 `audit_logs` row를 `DB_ARCHIVE_DIR` 아래 JSONL 파일로 먼저 archive한 뒤 DB에서 삭제합니다. archive 없이 삭제하는 옵션은 제공하지 않습니다.

## operation 보존/archive

기본 보존 기간은 90일입니다.

```powershell
node scripts/prune-operations.mjs --days 90 --keep-failed
node scripts/prune-operations.mjs --days 90 --prune-failed --yes
```

정책:

- `QUEUED`, `RUNNING`은 항상 보존합니다.
- 기본 대상은 cutoff 이전 `SUCCEEDED` operation입니다.
- `FAILED`는 기본 보존하며, `--prune-failed`가 있을 때만 archive/delete 후보가 됩니다.
- retry chain에 최근/진행 중 row가 연결되어 있으면 오래된 원본도 보존합니다.

## 환경변수

```env
ORDER_RAW_PAYLOAD_RETENTION_DAYS=90
AUDIT_LOG_RETENTION_DAYS=180
OPERATION_RETENTION_DAYS=90
DB_ARCHIVE_DIR=./backups/archive
```

모든 prune/archive 스크립트는 기본 dry-run이며 실제 변경은 `--yes`가 있을 때만 수행합니다. `--yes` 실행 전에는 backend를 중지하고 `node scripts/db-export.mjs`로 최신 snapshot을 남기는 것을 권장합니다.
