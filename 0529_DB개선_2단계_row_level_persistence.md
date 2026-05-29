# 0529 DB 개선 2단계 - Row-Level Persistence 전환 지침서

## 이 문서의 목적

이 문서는 DB 개선 2단계 작업자가 파일 하나만 읽고도 `DatabaseService`의 PostgreSQL 저장 방식을 안전하게 개선할 수 있도록 만든 지침서다.

이번 단계의 핵심은 PostgreSQL 저장 시 모든 테이블을 `TRUNCATE` 후 전체 재삽입하는 구조를 제거하고, 필요한 row만 upsert/delete하는 것이다. 단, 모든 도메인 테이블을 정규 컬럼 구조로 한 번에 바꾸지는 않는다. 먼저 현재 `id + payload JSONB` 구조를 유지한 채 row-level persistence를 도입한다.

## 선행 조건

이 단계는 가능하면 다음 작업 이후에 진행한다.

- `0529_DB개선_1단계_저장안정화.md`
  - PostgreSQL 저장 실패가 호출자에게 드러남
  - 쓰기 성공 응답이 DB 저장 완료를 의미함
  - 중첩 write로 audit log가 유실되는 주요 패턴 제거

선행 단계가 끝나지 않았다면, 이 단계에서 대규모 row-level 전환을 진행하기 전에 저장 실패 처리부터 보완해야 한다.

## 현재 문제

현재 `apps/backend/src/database.service.ts`는 PostgreSQL 모드에서도 사실상 JSON snapshot 저장소처럼 동작한다.

현재 흐름:

1. 서버 시작 시 모든 테이블 payload를 읽어 메모리 `DatabaseShape`로 만든다.
2. `write()` 때 전체 `DatabaseShape`를 clone한다.
3. PostgreSQL 저장 시 모든 storage table을 `TRUNCATE`한다.
4. 각 table의 모든 row를 다시 insert한다.

문제:

- 작은 변경도 전체 DB 크기에 비례한 쓰기가 된다.
- PostgreSQL lock, WAL 증가, 백업 지연이 커진다.
- 두 백엔드가 같은 DB를 보면 오래된 snapshot이 최신 DB를 덮어쓸 수 있다.
- DB unique constraint가 거의 없어 중복을 코드만으로 막는다.

## 이번 단계의 목표

1. PostgreSQL 저장 시 `TRUNCATE TABLE`을 제거한다.
2. 현재 JSONB table 구조를 유지하면서 row 단위 `INSERT ... ON CONFLICT DO UPDATE`를 사용한다.
3. 삭제된 row만 `DELETE`한다.
4. 변경되지 않은 row는 가능하면 업데이트하지 않는다.
5. 주요 테이블에 query/index 기반을 추가한다.
6. 전체 정규화는 하지 않되, 3단계 DB pagination과 4단계 daily summary가 쉬워지도록 기반을 만든다.

## 이번 단계에서 하지 말아야 할 것

- 모든 테이블을 정규 컬럼 테이블로 재작성하지 않는다.
- `DatabaseShape`와 기존 서비스 전체를 repository 구조로 한 번에 갈아엎지 않는다.
- 클라우드 DB 중앙화는 하지 않는다.
- 주문/주문상품 row를 보관 기간 기준으로 삭제하지 않는다.
- 보안/인증 관련 작업은 하지 않는다.
- 프론트엔드 UI를 바꾸지 않는다.

## 집/회사 DB 동기화 보존 조건

이 단계에서 runtime persistence의 `TRUNCATE + 전체 재삽입`은 제거하더라도, 집/회사 PC 동기화를 위한 명시적 full snapshot export/import 수단은 반드시 유지한다.

공통 원칙은 `0529_DB개선_공통_집회사동기화_필수조건.md`를 따른다.

필수 조치:

- `payload_hash` 같은 보조 컬럼을 추가하면 `scripts/db-export.mjs`, `scripts/db-import.mjs`도 같이 업데이트한다.
- import 스크립트는 `payload_hash`를 복원하거나 import 후 backfill해야 한다.
- schema version을 snapshot meta에 기록한다.
- import 후 index/schema ensure가 실행되도록 한다.

중요:

- 일반 API 쓰기에서 `TRUNCATE`를 제거하는 것이 목표다.
- 사용자가 명시적으로 실행하는 전체 restore/import 도구에서는 대상 DB를 완전 교체하기 위해 `TRUNCATE`를 사용할 수 있다.

## 관련 파일

주요 수정 파일:

- `apps/backend/src/database.service.ts`
- `apps/backend/src/run-tests.ts`
- `README.md`
- `scripts/db-export.mjs`
- `scripts/db-import.mjs`
- `scripts/README.md`

필요 시 추가 파일:

- `apps/backend/src/database-persistence.ts`
- `apps/backend/src/database-indexes.ts`
- `migrations/20260529-jsonb-row-level-persistence.sql`

참고 파일:

- `packages/shared/src/types.ts`
- `0529_DB개선_1단계_저장안정화.md`
- `보완필요사항.html`

## 목표 설계

### 1. storage table 구조는 1차로 유지한다

이번 단계에서는 기존 table을 유지한다.

```sql
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

이유:

- 서비스 로직 전체가 `DatabaseShape` 배열을 기준으로 동작한다.
- 바로 정규 컬럼으로 옮기면 주문 동기화, 광고 업로드, 매핑, 원가, 마진 계산이 동시에 흔들린다.
- 먼저 persistence 비용과 lock 위험을 줄인다.

### 2. payload_hash 컬럼 추가 검토

변경되지 않은 row update를 줄이기 위해 `payload_hash`를 추가하는 방식을 권장한다.

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payload_hash TEXT;
```

모든 storage table에 추가한다.

저장 시:

- row payload를 stable stringify한다.
- SHA-256 hash를 계산한다.
- 기존 hash와 다르면 update한다.
- 같으면 update하지 않는다.

주의:

- JSON stringify key order가 안정적이어야 한다.
- 현재 객체 생성 순서가 대부분 안정적이더라도 안전하게 `stableStringify()` helper를 둔다.

### 3. replaceTableRows를 upsert/delete로 대체한다

현재 구조:

```ts
await client.query(`TRUNCATE TABLE ${table.tableName}`);
await client.query(`INSERT INTO ...`);
```

목표 구조:

```ts
await this.upsertTableRows(client, table, rows);
await this.deleteMissingTableRows(client, table, nextIds);
```

upsert SQL 예시:

```sql
INSERT INTO orders (id, payload, payload_hash, updated_at)
VALUES ($1, $2::jsonb, $3, NOW())
ON CONFLICT (id) DO UPDATE
SET payload = EXCLUDED.payload,
    payload_hash = EXCLUDED.payload_hash,
    updated_at = NOW()
WHERE orders.payload_hash IS DISTINCT FROM EXCLUDED.payload_hash
```

delete SQL 예시:

```sql
DELETE FROM orders
WHERE id <> ALL($1::text[])
```

주의:

- 빈 배열일 때는 `DELETE FROM table`이 된다. 기존 동작과 맞지만 위험하므로 table별로 의도 확인이 필요하다.
- 삭제는 "현재 snapshot에서 사라진 row"만 지운다.
- multi-backend 환경에서는 아직 snapshot stale 문제가 완전히 해결되지 않는다. 완전한 해결은 6단계 DB queue/centralization에서 다룬다.

### 4. batch 크기를 제한한다

한 번에 너무 많은 parameter를 넣으면 PostgreSQL parameter limit에 걸릴 수 있다.

권장:

- batch size 500~1000 row
- table별 row 수가 크면 여러 insert로 나누기

예시:

```ts
const POSTGRES_UPSERT_BATCH_SIZE = 500;
```

### 5. JSONB expression index 추가

3단계 DB pagination에서 사용할 hot path를 위해 index를 추가한다.

권장 index:

```sql
CREATE INDEX IF NOT EXISTS idx_orders_store_external
ON orders ((payload->>'storeId'), (payload->>'externalOrderId'));

CREATE INDEX IF NOT EXISTS idx_orders_store_payment_datetime
ON orders ((payload->>'storeId'), (payload->>'paymentDatetime'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_store_external_product_order
ON order_items ((payload->>'storeId'), (payload->>'externalProductOrderId'));

CREATE INDEX IF NOT EXISTS idx_order_items_store_payment_date
ON order_items ((payload->>'storeId'), (payload->>'paymentDate'));

CREATE INDEX IF NOT EXISTS idx_order_items_store_sale_status
ON order_items ((payload->>'storeId'), (payload->>'saleStatus'));

CREATE INDEX IF NOT EXISTS idx_ad_costs_store_report_campaign
ON ad_campaign_daily_costs ((payload->>'storeId'), (payload->>'reportDate'), (payload->>'campaignId'));

CREATE INDEX IF NOT EXISTS idx_operations_store_status_created
ON operations ((payload->>'storeId'), (payload->>'status'), (payload->>'createdAt'));
```

주의:

- expression index는 기존 JSONB 구조를 유지하는 타협안이다.
- 장기적으로 정규 컬럼 테이블 전환 시 다시 정리한다.
- unique index 추가 전에 중복 데이터가 있는지 점검해야 한다.

### 6. 중복 데이터 점검 helper 추가

unique index를 만들기 전에 중복을 검사한다.

점검 대상:

- `orders`: `(storeId, externalOrderId)`
- `order_items`: `(storeId, externalProductOrderId)`
- `ad_campaign_daily_costs`: `(storeId, reportDate, campaignId, active upload 범위)`
- `sales_unit_cost_snapshots`: `(storeId, effectiveFrom)`

중복이 있으면:

- 자동 삭제하지 않는다.
- migration 또는 startup log에서 경고한다.
- 테스트 데이터면 정리하고, 운영 데이터면 별도 repair 계획을 세운다.

## 구현 순서

1. `database.service.ts`에서 storage table schema에 `payload_hash` 컬럼을 추가한다.
2. startup 시 기존 row의 `payload_hash`가 없으면 backfill한다.
3. `stableStringify()`와 `hashPayload()` helper를 추가한다.
4. `replaceTableRows()`를 `persistTableRowsIncrementally()`로 대체한다.
5. `TRUNCATE` SQL을 제거한다.
6. batch upsert를 구현한다.
7. missing id delete를 구현한다.
8. 주요 JSONB expression index를 추가한다.
9. 중복 점검 helper를 추가한다.
10. PostgreSQL persistence 관련 테스트를 추가한다.

## 테스트 지침

필수 테스트:

1. row 1개 수정 시 해당 row만 upsert 대상이 된다.
2. 변경되지 않은 row는 `payload_hash`가 같으면 update되지 않는다.
3. snapshot에서 삭제된 row만 delete된다.
4. 빈 table snapshot 처리 시 기존 동작과 동일하게 해당 table이 비워진다.
5. `TRUNCATE` SQL이 더 이상 호출되지 않는다.
6. batch size보다 많은 row도 여러 batch로 저장된다.
7. 중복 key 점검이 중복 데이터를 발견한다.
8. 기존 `loadSnapshotFromPostgres()`는 정상적으로 snapshot을 복원한다.

가능하면 `pg`를 직접 띄우지 않는 unit test를 먼저 만든다.

- SQL 생성 helper를 pure function으로 분리한다.
- fake client가 받은 query를 검증한다.

검증 명령:

```powershell
npm.cmd run typecheck --workspace @patima/backend
npm.cmd run test --workspace @patima/backend
npm.cmd run lint
```

PostgreSQL local 검증:

```powershell
docker compose up -d db
npm.cmd run build --workspace @patima/backend
npm.cmd run start --workspace @patima/backend
```

## 완료 기준

- PostgreSQL 저장 시 `TRUNCATE TABLE`을 사용하지 않는다.
- 변경 row는 upsert되고 삭제 row만 delete된다.
- 변경 없는 row update가 최소화된다.
- 주요 JSONB expression index가 생성된다.
- 기존 파일 모드와 테스트 하네스가 깨지지 않는다.
- backend test, backend typecheck, 전체 lint가 통과한다.

## 다음 단계로 넘길 내용

2단계 완료 후 3단계에서 할 일:

- 주문 목록, 광고 매핑 목록, operation 목록을 DB query pagination으로 전환한다.
- `DatabaseService.getSnapshot()` 전체 배열 필터링을 hot path에서 줄인다.
- 2단계에서 만든 index를 실제 조회에서 사용한다.

## 다음 세션 실행 프롬프트

```text
너는 Codex다. 작업 경로는 C:\Users\seong\Desktop\workspace\patima-naver-ss 이다.

반드시 먼저 0529_DB개선_2단계_row_level_persistence.md 파일을 끝까지 읽고, 보안/인증 작업은 제외한 채 PostgreSQL row-level persistence만 구현해라.

이번 목표:
- PostgreSQL 저장 시 TRUNCATE + 전체 재삽입을 제거한다.
- 현재 id + payload JSONB 구조는 유지하되 row 단위 upsert/delete로 바꾼다.
- payload_hash 또는 동등한 방식으로 변경 없는 row update를 줄인다.
- 주요 JSONB expression index를 추가한다.
- 전체 정규화, 클라우드 DB 연결, UI 변경은 하지 않는다.

작업 후 다음을 실행해라:
- npm.cmd run typecheck --workspace @patima/backend
- npm.cmd run test --workspace @patima/backend
- npm.cmd run lint

최종 응답에는 변경 파일, TRUNCATE 제거 방식, upsert/delete 방식, index 목록, 테스트 결과를 포함해라.
```
