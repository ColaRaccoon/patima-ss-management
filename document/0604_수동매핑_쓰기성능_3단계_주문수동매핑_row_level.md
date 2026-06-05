# 3단계 - 주문 수동 매핑 저장 row-level 업데이트 전환

## 새 세션 시작 프롬프트

```text
document/0604_수동매핑_쓰기성능_3단계_주문수동매핑_row_level.md 파일을 읽고, 서브 에이전트 개발자/평가자 방식으로 끝까지 작업해줘.
```

## 필수 선행

먼저 [0604_수동매핑_쓰기성능_공통지침.md](./0604_수동매핑_쓰기성능_공통지침.md)를 읽는다.

이 단계도 반드시 공통 지침의 서브 에이전트 루프를 따른다. 개발자 에이전트가 구현하고, 평가자 에이전트가 결함을 하나라도 발견하면 재작업을 지시하며, 평가자가 합격할 때까지 반복한다.

1단계와 2단계가 완료되지 않았다면 이 단계를 시작하지 않는다.

## 목표

`POST /api/v1/order-source-signatures/batch-mapping` 저장을 전체 snapshot persistence 없이 처리한다.

수정 대상은 선택된 `order_source_signatures`와 그 시그니처를 참조하는 `order_items`뿐이어야 한다. 이후 순이익 요약은 2단계의 row-level daily summary 저장 경로를 사용한다.

## 현재 문제 경로

프론트:

- `apps/frontend/components/mappings/mappings-view.tsx`
- `handleSaveOrderMappings()`
- `/api/order-source-signatures/batch-mapping`

백엔드:

- `AppController.saveOrderMappings()`
- `OrderMappingService.saveMappings()`
- `OrderMappingService.saveMappingsInternal()`

현재 `saveMappingsInternal()`는 `databaseService.writeCommitted()` 안에서 전체 `orderSourceSignatures`와 전체 `orderItems`를 순회한 뒤 전체 snapshot persistence를 탄다.

## 작업 범위

필수 구현:

1. `DatabaseService`에 주문 수동 매핑 전용 commit 메서드를 추가한다.
   - 이름 예시: `saveOrderManualMappingsCommitted`
   - 입력: `storeId`, `signatureIds`, `canonicalSalesUnitId`, `timestamp`
   - 출력: `signatureIds`, `updatedOrderItemCount`, `affectedDates`
2. PostgreSQL mode:
   - transaction 사용
   - 대상 signature row만 `SELECT ... FOR UPDATE` 또는 동등한 안전한 방식으로 읽기
   - `storeId` 일치 검증
   - signature payload mutate:
     - `canonicalSalesUnitId`
     - `mappingStatus = "MAPPED"`
     - `confirmedAt = timestamp`
     - `updatedAt = timestamp`
   - 대상 order item row만 읽고 mutate:
     - `canonicalSalesUnitId`
     - `updatedAt`
   - 관련 order item의 `paymentDate`를 `affectedDates`로 수집
   - payload_hash 갱신
   - 메모리 snapshot의 해당 signature/item만 갱신
3. file mode:
   - 기존 `writeCommitted()` 방식 fallback 가능
4. `OrderMappingService.saveMappingsInternal()`를 위 메서드를 사용하도록 변경한다.
5. 기존 validation은 유지한다.
   - signature 존재 여부
   - 같은 store인지
   - sales unit 존재 여부
   - cross-store reference 금지
   - 비활성 판매단위 금지
   - 그룹 판매단위 직접 매핑 금지
6. 저장 후 `recalculateProfitSummariesForOrderSignatures()`는 2단계 row-level daily summary 경로를 사용해야 한다.

## 중요한 설계 주의사항

- `resolveSignatureBatch()`의 검증 로직을 가능하면 유지하거나 재사용한다.
- PostgreSQL direct path에서 새 검증을 만들더라도 기존 에러 메시지/응답 형태를 크게 바꾸지 않는다.
- `orderItems` 전체를 filter하지 말고, PostgreSQL query에서 `payload->>'storeId'`와 `payload->>'orderSourceSignatureId'` 조건을 사용한다.
- 이미 있는 index `idx_order_items_store_signature`를 활용한다.
- 메모리 snapshot update를 빠뜨리면 다음 읽기 응답이 DB와 어긋난다.
- `confirmedAt` 있는 수동 매핑은 자동 매핑에서 덮지 않는 기존 규칙을 유지한다.

## 하지 말아야 할 것

- 주문 자동 매핑 전체 재계산 API까지 이 단계에서 바꾸지 않는다.
- `createAndMapMany()`의 판매단위 생성 병목까지 이 단계에서 바꾸지 않는다.
- 수동 매핑 UI를 바꾸지 않는다.
- 전체 `orders` table을 건드리지 않는다.

## 관련 파일

- `apps/backend/src/database.service.ts`
- `apps/backend/src/order-mapping.service.ts`
- `apps/backend/src/app.controller.ts`
- `apps/backend/src/run-tests.ts`
- `apps/backend/src/sales-unit-auto-mapper.ts`
- `apps/backend/src/helpers.ts`

## 테스트 기준

필수:

- 한 signature 수동 매핑 시 해당 signature만 갱신
- 여러 signature batch 매핑 시 중복 ID dedupe
- 해당 signature를 참조하는 order item만 갱신
- 다른 store의 signature/order item은 변경되지 않음
- 관련 paymentDate만 affectedDates로 반환
- usageCount 0 또는 paymentDate 없는 signature는 affectedDates 빈 목록 또는 dedupe된 목록으로 처리
- 비활성 판매단위, 그룹 판매단위, cross-store 에러 유지
- file mode fallback 테스트
- PostgreSQL direct path가 `writeCommitted()` 전체 snapshot persistence를 호출하지 않는 구조 테스트
- 2단계 daily summary row-level path와 연동 테스트
- backend test/typecheck 통과

가능하면 추가:

- 큰 fixture에서 수동 매핑 저장이 전체 table 순회 없이 대상 row 수에 비례하는지 검증

## 평가자 체크리스트

- 기존 validation을 중복/누락 없이 유지했는가
- 기존 helper를 재사용했는가
- 불필요한 새 abstraction을 만들지 않았는가
- PostgreSQL direct path가 실제로 전체 snapshot persistence를 우회하는가
- file mode가 깨지지 않았는가
- 메모리 snapshot과 DB가 동시에 갱신되는가
- daily summary 갱신이 2단계 row-level path를 쓰는가

## 완료 조건

- 평가자 에이전트 합격
- 테스트/타입체크 통과
- 가능하면 local backend에서 읽기 API로 변경 결과 확인

