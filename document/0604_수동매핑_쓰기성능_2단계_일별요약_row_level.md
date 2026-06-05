# 2단계 - 일별 순이익 요약 row-level 저장 경로 추가

## 새 세션 시작 프롬프트

```text
document/0604_수동매핑_쓰기성능_2단계_일별요약_row_level.md 파일을 읽고, 서브 에이전트 개발자/평가자 방식으로 끝까지 작업해줘.
```

## 필수 선행

먼저 [0604_수동매핑_쓰기성능_공통지침.md](./0604_수동매핑_쓰기성능_공통지침.md)를 읽는다.

이 단계도 반드시 공통 지침의 서브 에이전트 루프를 따른다. 개발자 에이전트가 구현하고, 평가자 에이전트가 결함을 하나라도 발견하면 재작업을 지시하며, 평가자가 합격할 때까지 반복한다.

1단계가 완료되지 않았다면 이 단계를 시작하지 않는다.

## 목표

매핑 변경 후 순이익 요약을 갱신할 때 전체 snapshot persistence를 타지 않고, 영향받은 날짜의 `daily_sales_unit_profits`, `daily_store_summaries` row만 교체한다.

수동 매핑 저장 병목의 절반 이상이 이 영역에서 발생할 수 있으므로, 주문/광고 매핑 hot path 전환 전에 이 단계가 먼저 필요하다.

## 현재 문제

`ProfitSummaryService.recalculateStoreDateList()`는 다음 작업을 하나의 `databaseService.writeCommitted()` 안에서 수행한다.

1. 날짜별 sales unit profit row 생성
2. 날짜별 store summary row 생성
3. 기존 daily summary row filter 제거
4. 새 row push
5. 전체 `DatabaseShape` clone
6. 전체 storage table persistence

실제로 필요한 DB 변경은 두 테이블의 특정 날짜 row 삭제/삽입뿐이다.

## 작업 범위

필수 구현:

1. `DatabaseService`에 일별 요약 row만 commit하는 메서드를 추가한다.
   - 이름 예시: `replaceDailyProfitSummariesCommitted`
   - 입력 예시: `storeId`, `dates`, `dailySalesUnitProfits`, `dailyStoreSummaries`
   - PostgreSQL mode:
     - transaction 사용
     - `daily_sales_unit_profits`에서 해당 `storeId + dates` row만 삭제
     - `daily_store_summaries`에서 해당 `storeId + dates` row만 삭제
     - 새 row만 insert/upsert
     - payload_hash 저장
     - 메모리 snapshot도 같은 범위만 갱신
   - file mode:
     - 기존 `writeCommitted()` fallback 사용 가능
2. `ProfitSummaryService.recalculateStoreDateList()`가 PostgreSQL mode에서는 위 메서드를 사용하도록 바꾼다.
3. `invalidateStoreDateList()`도 가능하면 해당 날짜 daily summary row만 제거하는 경로를 사용한다.
4. 기존 응답 형식은 유지한다.

## 설계 원칙

- `calculateDailyProfitRows()`와 `calculateDashboardSummary()`는 기존 helper를 재사용한다.
- 새 계산 함수를 만들지 않는다.
- `DatabaseService` 내부의 기존 `hashPayload`, `stableStringify`, `POSTGRES_UPSERT_BATCH_SIZE`, `runPostgresCommitted` 패턴을 재사용한다.
- PostgreSQL direct update 후 메모리 snapshot이 DB와 일치해야 한다.
- file mode fallback을 깨면 안 된다.

## 하지 말아야 할 것

- 손익 계산 공식을 바꾸지 않는다.
- daily summary table 구조를 정규 컬럼으로 새로 만들지 않는다.
- 전체 `DatabaseShape` repository 전환을 하지 않는다.
- 주문/광고 매핑 API를 이 단계에서 직접 SQL로 바꾸지 않는다.

## 관련 파일

- `apps/backend/src/database.service.ts`
- `apps/backend/src/profit-summary.service.ts`
- `apps/backend/src/helpers.ts`
- `apps/backend/src/run-tests.ts`
- `packages/shared/src/types.ts`

## 테스트 기준

필수:

- PostgreSQL mode에서 `recalculateStoreDateList()`가 전체 `persistSnapshotToPostgres()`를 호출하지 않고 daily summary 두 테이블만 변경하는 테스트
- file mode fallback이 기존 방식대로 동작하는 테스트
- 여러 날짜 입력 시 해당 날짜 row만 교체되고 다른 날짜 row는 유지되는 테스트
- `invalidateStoreDateList()`가 해당 날짜 row만 제거하는 테스트
- 기존 손익 계산 결과가 바뀌지 않는 회귀 테스트
- backend test/typecheck 통과

가능하면 추가:

- 1000개 이상 order item fixture에서 daily summary 재계산이 전체 storage table persistence를 타지 않는 구조 검증

## 평가자 체크리스트

- 기존 helper 재사용 여부
- DB transaction과 memory snapshot 갱신 순서가 안전한지
- `dailySalesUnitProfits`, `dailyStoreSummaries` 외 테이블을 건드리지 않는지
- 날짜 dedupe와 빈 날짜 no-op이 유지되는지
- file mode fallback이 유지되는지
- export/import 스크립트와 충돌하지 않는지

## 완료 조건

- 평가자 에이전트 합격
- 테스트/타입체크 통과
- 메인 작업자가 PostgreSQL direct path와 file fallback path를 모두 확인

