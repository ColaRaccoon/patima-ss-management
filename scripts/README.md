# scripts

운영/보수용 스크립트 모음입니다. DB 관련 스크립트는 PostgreSQL `DATABASE_URL`을 기준으로 동작합니다.

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

`db-export.mjs`는 현재 schema의 JSONB payload 테이블 전체를 snapshot에 포함합니다. 새 payload 테이블이 생기면 `scripts/db-maintenance-utils.mjs`의 `FULL_SYNC_TABLES`, `db-import.mjs`, 이 문서를 함께 확인합니다.

`db-import.mjs`는 명시적 restore/full sync 도구이므로 대상 JSONB payload 테이블을 `TRUNCATE` 후 snapshot row를 재삽입합니다. runtime API persistence에서 `TRUNCATE`를 쓰지 않는 것과 별개의 운영 복구 절차입니다.

## DB 크기 리포트

```powershell
node scripts/report-db-size.mjs
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

