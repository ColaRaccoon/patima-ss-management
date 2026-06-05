# 4단계 - 광고 수동 매핑/의도적 제외/재계산 row-level 업데이트 전환

## 새 세션 시작 프롬프트

```text
document/0604_수동매핑_쓰기성능_4단계_광고매핑_row_level.md 파일을 읽고, 서브 에이전트 개발자/평가자 방식으로 끝까지 작업해줘.
```

## 필수 선행

먼저 [0604_수동매핑_쓰기성능_공통지침.md](./0604_수동매핑_쓰기성능_공통지침.md)를 읽는다.

이 단계도 반드시 공통 지침의 서브 에이전트 루프를 따른다. 개발자 에이전트가 구현하고, 평가자 에이전트가 결함을 하나라도 발견하면 재작업을 지시하며, 평가자가 합격할 때까지 반복한다.

1~3단계가 완료되지 않았다면 이 단계를 시작하지 않는다.

## 목표

광고 매핑 패널의 자주 쓰는 버튼도 전체 snapshot persistence 없이 처리한다.

대상 API:

- `POST /api/v1/ad-campaign-costs/batch-mapping`
- `POST /api/v1/ad-campaign-costs/batch-intentional-unmapped`
- `POST /api/v1/ad-campaign-costs/batch-recalculate-mapping`
- 가능하면 `ad-campaign-signatures` batch endpoint도 같은 경로로 정리

## 현재 문제 경로

프론트:

- `handleSaveAdCostMappings()`
- `handleIntentionalUnmapped()`
- `handleRecalculateAdCostMappings()`

백엔드:

- `AdsService.saveManualMappingsInternal()`
- `AdsService.setIntentionalUnmappedInternal()`
- `AdsService.recalculateMappingsInternal()`

현재 위 메서드들은 `databaseService.writeCommitted()`를 사용해 전체 snapshot persistence를 탄다.

## 작업 범위

필수 구현:

1. `DatabaseService` 또는 `AdsService`에 광고 매핑 전용 row-level commit 경로를 추가한다.
2. manual mapping:
   - 대상 ad cost id 또는 ad campaign signature id를 signature id로 materialize
   - 대상 `ad_campaign_signatures`만 갱신
   - 관련 `ad_campaign_daily_costs` row만 갱신
   - 관련 `reportDate`만 affectedDates로 수집
3. intentional unmapped:
   - signature:
     - `canonicalSalesUnitId = null`
     - `matchedRuleCount = 0`
     - `mappingReason = "INTENTIONALLY_UNMAPPED"`
     - `reasonNote`
     - `reasonNoteInherited = false`
     - `confirmedAt`
     - `updatedAt`
   - 관련 daily costs에도 기존 `applyAdCampaignSignatureToRows`와 같은 의미 적용
4. recalculate:
   - 기존 `recalculateAdCampaignSignaturesForStore()`의 평가 로직을 재사용한다.
   - 전체 store 재계산이 아니라 대상 signature만 재계산한다.
   - 관련 daily costs만 반영한다.
5. 저장 후 2단계 daily summary row-level path로 affectedDates만 갱신한다.
6. file mode fallback 유지.

## 설계 원칙

- `ad-mapping-engine.ts`의 기존 함수와 규칙을 재사용한다.
- `applyAdCampaignSignatureToRows()` 의미와 어긋나면 안 된다.
- `materializeAdCampaignSignatureIds()` 기존 동작을 유지한다.
- 광고 row와 signature endpoint가 같은 내부 경로를 공유하도록 중복을 줄인다.
- 자식 판매단위 광고 매핑 제한, store-level/group 매핑 허용 여부 등 기존 정책을 유지한다.

## 하지 말아야 할 것

- 광고 매핑 규칙 자체를 바꾸지 않는다.
- 캠페인 규칙 CRUD를 이 단계에서 바꾸지 않는다.
- 광고 업로드 confirm 로직을 바꾸지 않는다.
- UI를 바꾸지 않는다.

## 관련 파일

- `apps/backend/src/ads.service.ts`
- `apps/backend/src/ad-mapping-engine.ts`
- `apps/backend/src/database.service.ts`
- `apps/backend/src/run-tests.ts`
- `apps/backend/src/helpers.ts`

## 테스트 기준

필수:

- 광고 row 수동 매핑 시 target signature와 관련 daily cost만 갱신
- signature id로 들어온 요청도 동일하게 처리
- intentional unmapped reasonNote가 signature와 row에 반영
- recalculate가 대상 signature만 재계산하고 수동 confirmed row 규칙을 보존
- affectedDates dedupe
- file mode fallback
- PostgreSQL direct path가 전체 snapshot persistence를 우회
- daily summary row-level refresh와 연동
- backend test/typecheck 통과

가능하면 추가:

- 서로 다른 reportDate를 가진 같은 signature rows 매핑 시 해당 날짜들만 summary 갱신
- active upload 조건이 손익 계산에서 유지되는지 확인

## 평가자 체크리스트

- 기존 ad mapping engine 재사용 여부
- signature와 row 동기화 의미 보존 여부
- manual/intentional/recalculate 세 경로의 중복 최소화
- PostgreSQL direct path와 file fallback 모두 안전한지
- affectedDates가 정확한지
- 수동 confirmed mapping이 자동 규칙에 덮이지 않는지

## 완료 조건

- 평가자 에이전트 합격
- 테스트/타입체크 통과
- 가능하면 local backend에서 광고 매핑 읽기 API로 변경 결과 확인

