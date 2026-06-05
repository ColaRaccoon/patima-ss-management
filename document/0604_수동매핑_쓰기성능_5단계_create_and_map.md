# 5단계 - create-and-map 및 판매단위 변경 연동 병목 정리

## 새 세션 시작 프롬프트

```text
document/0604_수동매핑_쓰기성능_5단계_create_and_map.md 파일을 읽고, 서브 에이전트 개발자/평가자 방식으로 끝까지 작업해줘.
```

## 필수 선행

먼저 [0604_수동매핑_쓰기성능_공통지침.md](./0604_수동매핑_쓰기성능_공통지침.md)를 읽는다.

이 단계도 반드시 공통 지침의 서브 에이전트 루프를 따른다. 개발자 에이전트가 구현하고, 평가자 에이전트가 결함을 하나라도 발견하면 재작업을 지시하며, 평가자가 합격할 때까지 반복한다.

1~4단계가 완료되지 않았다면 이 단계를 시작하지 않는다.

## 목표

기존 판매단위에 수동 매핑하는 버튼뿐 아니라, 매핑 화면에서 새 판매단위를 만들고 바로 매핑하는 흐름도 지나치게 느리지 않게 정리한다.

또한 판매단위 alias, linkedProductIds, linkedOptionCodes, linkedManageCodes 변경 후 자동 매핑 재계산이 전체 snapshot persistence를 과도하게 타는 경로를 점검한다.

## 현재 문제

`OrderMappingService.createAndMapMany()`는 `SalesUnitService.create(..., { skipOrderRecalculation: true })` 후 `saveMappingsInternal()`를 호출한다.

3단계가 끝나면 매핑 저장은 빨라지지만, 판매단위 생성 자체가 여전히 `writeCommitted()` 전체 snapshot persistence를 탈 수 있다.

판매단위 수정/비활성화/그룹 변경은 주문/광고 매핑에 영향을 줄 수 있으므로 더 조심해야 한다.

## 작업 범위

필수:

1. `createAndMapMany()` 흐름의 실제 병목을 측정한다.
2. 판매단위 생성 후 즉시 주문 매핑하는 경로에서 불필요한 전체 자동 재계산이 없는지 확인한다.
3. PostgreSQL mode에서 판매단위 생성만 row-level insert/upsert로 처리할 수 있는지 검토하고, 범위가 작으면 구현한다.
4. 구현한다면 `canonical_sales_units` 해당 row만 insert하고 메모리 snapshot에 추가한다.
5. 생성 직후 매핑은 3단계 주문 row-level 경로를 사용한다.

선택:

- 판매단위 수정/비활성화가 매핑 재계산을 호출하는 경우, 대상이 명확한 경로만 row-level로 바꾼다.
- 범위가 커지면 이 단계에서는 분석 문서와 다음 단계 계획만 남긴다.

## 하지 말아야 할 것

- 판매단위/그룹 비즈니스 규칙을 바꾸지 않는다.
- 비용 스냅샷 구조를 바꾸지 않는다.
- 전체 sales unit service를 repository 구조로 갈아엎지 않는다.
- 불명확한 영향 범위의 자동 재계산을 무리하게 row-level로 바꾸지 않는다.

## 관련 파일

- `apps/backend/src/order-mapping.service.ts`
- `apps/backend/src/sales-unit.service.ts`
- `apps/backend/src/database.service.ts`
- `apps/backend/src/sales-unit-auto-mapper.ts`
- `apps/backend/src/ad-mapping-engine.ts`
- `apps/backend/src/run-tests.ts`

## 테스트 기준

필수:

- create-and-map이 새 판매단위를 만들고 선택 signature를 매핑
- 생성된 sales unit이 메모리 snapshot과 DB에 모두 존재
- 기존 validation과 alias normalization 유지
- create 후 자동 주문 재계산 skip 의미 유지
- backend test/typecheck 통과

선택:

- 판매단위 수정 후 관련 자동 매핑 범위가 기존과 동일한지 회귀 테스트

## 평가자 체크리스트

- 범위를 과도하게 넓히지 않았는가
- 판매단위 비즈니스 규칙이 바뀌지 않았는가
- 기존 normalization helper를 재사용했는가
- create-and-map 저장 경로가 3단계 row-level 매핑을 사용하는가
- 무리한 추상화가 없는가

## 완료 조건

- 평가자 에이전트 합격
- 테스트/타입체크 통과
- 작업 범위가 커져 구현을 보류한 항목은 명확히 다음 작업으로 문서화

