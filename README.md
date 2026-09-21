# Patima Naver SS

Smart Store profit management MVP for order, mapping, ad cost, and profit tracking.

## Workspaces

- `apps/frontend`: Next.js frontend
- `apps/backend`: Nest-style API backend
- `packages/shared`: shared types and normalization helpers

## Run

```bash
npm install
npm run dev:backend
npm run dev:frontend
```

## Environment

The backend now supports three layers for Naver Commerce integration:

- PostgreSQL persistence through `DATABASE_URL`
- Environment-driven Naver solution credentials through `NAVER_*`
- Store + credential bootstrap on startup when all required `NAVER_*` values exist
- Order raw payload retention through `ORDER_RAW_PAYLOAD_RETENTION_DAYS` (default `0`)

Required Naver values:

```env
NAVER_SOLUTION_ID=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
NAVER_ACCOUNT_UID=
NAVER_CHANNEL_NO=
NAVER_CALLBACK_URL=
```

Optional storage controls:

```env
ORDER_RAW_PAYLOAD_RETENTION_DAYS=0
AUDIT_LOG_RETENTION_DAYS=180
OPERATION_RETENTION_DAYS=90
DB_ARCHIVE_DIR=./backups/archive
```

`ORDER_RAW_PAYLOAD_RETENTION_DAYS` defaults to `0`, so new order syncs store
`OrderRecord.rawPayload` and `OrderItem.rawPayload` as `null`. Set a positive integer, such as
`30` or `90`, only when raw Naver order JSON needs to be retained temporarily for recent KST
order/payment dates. Invalid values fall back to `0`.

Maintenance scripts are dry-run by default:

```bash
node scripts/report-db-size.mjs
node scripts/prune-order-raw-payloads.mjs --days 0
node scripts/prune-order-item-repeated-text-fields.mjs --full
node scripts/prune-audit-logs.mjs --days 180
node scripts/prune-operations.mjs --days 90 --keep-failed
```

Add `--yes` only after creating a fresh snapshot and stopping the backend.

## Current behavior

- If `DATABASE_URL` exists, PostgreSQL is the primary storage provider.
- If `DATABASE_URL` is missing, the backend falls back to `apps/backend/data/database.json`.
- Runtime PostgreSQL storage is one row per record in `id + payload JSONB + payload_hash + updated_at` tables. The backend still loads a `DatabaseShape` memory snapshot on startup for shared business logic and file-mode parity.
- General write APIs use committed persistence: a successful PostgreSQL write response means the snapshot transaction committed, and file fallback writes through a temporary file before rename.
- Manual order/ad mapping hot paths now bypass full `DatabaseShape` snapshot persistence in PostgreSQL mode. They lock and update only selected signature/row payloads, update `payload_hash`, refresh the same rows in memory, and replace only affected daily profit summary dates.
- PostgreSQL runtime snapshot persistence keeps the JSONB payload tables but writes changed snapshots with row-level upsert/delete and `payload_hash`; full PC sync remains `scripts/db-export.mjs` / `scripts/db-import.mjs`.
- DB maintenance scripts cover size reporting, manual order raw payload pruning, audit log archiving, operation archiving, and restore rehearsal. See `scripts/README.md` and `DB_RESTORE_RUNBOOK.md`.
- If matching `NAVER_*` values exist, the backend bootstraps a Smart Store record and seller credential automatically.
- Credential test now issues a real SELLER token and checks seller account/channel endpoints.
- Order sync requires live Naver Commerce API credentials; missing or unreadable credentials fail only the affected store.
- Order sync stores order/order-item `rawPayload` only when `ORDER_RAW_PAYLOAD_RETENTION_DAYS` is greater than `0`; pruning preserves order rows, item rows, option codes, fees, delivery fees, sales amounts, and mapping fields.
- Order item display/search text is resolved from `order_source_signatures`; new order syncs avoid repeating product/option/signature text in `order_items.payload`.
- Production order sync never generates mock orders.
- If live Naver sync is configured but the API call fails, the sync is marked as failed instead of silently using mock data.

The live sync path uses:

- `POST /v1/oauth2/token`
- `GET /v1/pay-order/seller/product-orders` (payment-date windows)
- `GET /v1/pay-order/seller/product-orders/last-changed-statuses`
- `POST /v1/pay-order/seller/product-orders/query`
- `GET /v1/seller/account`
- `GET /v1/seller/channels`

## Verify

```bash
npm run lint
npm run test
npm run build
```

## Docker

`docker-compose.yml` is included for local PostgreSQL startup, but Docker execution still depends on the local machine environment.

## 주문 동기화와 복구

- 기본 조회 날짜는 서버 한국시간 기준 어제입니다. 전체 스토어 선택 날짜 동기화는 화면에 지정한 하루(dateFrom=dateTo)를 MANUAL로 요청합니다. 어제 주문 동기화 및 날짜 없는 기본 API 요청은 YESTERDAY로 접수 시점의 한국시간 전날 하루를 고정합니다. 비활성은 제외, 인증 오류는 해당 스토어 실패로 남깁니다.
- 기본/선택 날짜 동기화는 그날 결제된 주문만 다시 조회하여 기존 주문을 갱신합니다. 30일 변경 이력이나 저장된 모든 주문 ID를 추가 조회하지 않으며, 전체 변경 수집 watermark도 전진시키지 않습니다. 다른 날 결제된 주문의 이후 취소·반품까지 포괄적으로 최신화하는 동작은 아닙니다.
- 이전 CURRENT/RECENT_30_DAYS 요청과 재시도는 원래 범위를 유지합니다. CURRENT의 최근 30일·변경 이력·기존 ID 복구 로직은 기존 작업 호환용으로 남아 있으며 기본 화면 버튼은 사용하지 않습니다.
- 기존 CURRENT 작업의 API 보존기간은 공식적으로 확정되지 않았습니다. 앱은 보수적 검증 정책으로 30일을 넘는 변경 수집 공백을 COVERAGE_GAP으로 표시하고 최근 30일과 기존 ID를 복구합니다. 이 30일은 네이버의 보존기간 보장이 아닙니다. 공백이 해소되지 않은 범위를 성공으로 표시하거나 성공 watermark를 전진시키지 않습니다.
- ‘과거 공백을 미해결로 남기고 현재 기준부터 재개’는 사용자가 범위 한계를 수용하는 동작입니다. 과거 실패 기록과 공백 경고는 보존하고 별도 변경 수집 기준선을 설정합니다. 이후 성공 작업에도 과거 미해결 공백 경고가 남습니다. 자세한 공식 근거와 한계는 document/NAVER_ORDER_API_CONTRACT.md를 참고하세요.
- 단일/전체 요청은 mode와 idempotencyKey를 받습니다. 동일 키와 동일 요청은 기존 batchId를 돌려주며, 다른 요청에 같은 키를 쓰면 409입니다. 응답이 유실되면 같은 키로 다시 요청하세요. 실패 스토어 재시도는 원래 기준시각을 유지하고 새 배치 이력을 남깁니다.
- 주문 화면의 공통 패널과 전역 표시에서 상태를 추적합니다. URL batchId와 서버 활성 배치 목록으로 복원하며, 조회 연결이 끊겨도 마지막 상태를 보존합니다. 손익 집계 경고는 ‘손익 집계만 다시 갱신’으로 복구합니다.
- 주문 청크와 checkpoint는 함께 커밋합니다. 재시작 시 안전한 범위 재조회와 멱등 upsert를 사용하며, 성공 watermark는 범위를 완주하고 terminal 상태를 확정할 때 기록합니다.
- 주문 동기화 저장에는 lease owner와 attempt fencing을 적용합니다. 현재 배포 지원 범위는 백엔드 프로세스 1개, 동기화 실행 동시성 1입니다. 다른 도메인의 메모리 snapshot 쓰기까지 다중 writer 안전성을 보장하지 않습니다.
- 추가 저장 테이블은 order_sync_batches, order_sync_batch_items, order_sync_states입니다. 기존 JSON 파일은 빠진 컬렉션을 빈 배열로 정규화합니다. 백업/복원 도구의 공통 테이블 목록에 포함되며, operation 정리는 배치에서 참조하는 작업을 보존합니다.
- 적용 전 DB_RESTORE_RUNBOOK.md의 백업·복원 절차를 확인하고 worker를 중지 또는 drain한 뒤 새 버전을 시작하세요. 구버전 worker와 혼합 실행하지 마세요. 부분 저장 복구는 주문 삭제 대신 멱등 재실행으로 수행합니다.
- 파일 모드는 원자적 파일 교체를 사용하지만 청크마다 전체 JSON 저장 비용이 있습니다. PostgreSQL은 주문용 commit 경로를 사용합니다. 실제 운영 데이터 규모와 DB 환경에서 성능·복구를 별도 검증해야 합니다.
