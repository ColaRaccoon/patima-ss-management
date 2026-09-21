# 주문 동기화 안정화 및 진행 상태 UI 구현 계획서

작성일: 2026-09-18 (Asia/Seoul)  
분석 기준 커밋: `f2ea32d`  
프로젝트: `patima-naver-ss`  
기준 작업 경로: `C:\Users\seong\Desktop\workspace\patima-naver-ss`

## 1. 다음 세션에 전달할 지시

이 문서는 사용자 요구, 현재 코드의 확인된 문제, 구현 결정, 검증 기준을 한 파일에 담은 인수인계 문서다. 이전 대화 없이 이 파일과 저장소를 읽고 구현할 수 있어야 한다.

사용자는 **이번 세션에서는 분석과 계획서만 작성**하고 **다음 세션에서 실제 구현**하기를 요청했다. 이 문서를 구현하라는 요청을 받은 다음 세션은 아래 순서대로 실제 코드를 수정하고 검증한다. 단순히 계획을 다시 작성하거나 UI만 추가하고 끝내지 않는다. 현재 소스가 분석 기준과 달라졌으면 관련 변경을 먼저 확인하고 기존 작업을 보존한다.

사용자가 보고한 현상:

- 개별 스토어 주문 동기화가 체감상 약 6번 중 1번 실패한다. 측정된 실패율은 아니다.
- 실패를 즉시 인지할 UI가 없고, 진행 중/완료/실패도 알기 어렵다.
- 기존 ‘전체 스토어 주문 동기화’ 버튼을 누르면 프로그램이 ‘터진다’. 이것이 백엔드 종료, 메모리 부족, HTTP 오류, 화면 오류, 장시간 멈춤 중 무엇인지는 아직 확인되지 않았다.

최종 목표:

1. 한 번의 전체 동기화 요청으로 등록된 스토어의 판매 데이터를 현재 시각까지 수집·파싱·저장한다.
2. 한 스토어의 오류가 다른 스토어의 동기화를 중단시키지 않는다.
3. 사용자가 요청 접수, 대기, 진행 단계, 자동 재시도, 성공, 일부 실패, 전체 실패를 구분할 수 있다.
4. 새로고침·화면 이동·백엔드 재시작에도 작업 추적과 안전한 재개가 가능하다.
5. 누락된 수집, 저장 실패, 모의 데이터, 조회 연결 끊김을 ‘동기화 성공’으로 표시하지 않는다.

이번 분석에서는 소스만 읽었으며 실제 네이버 주문 요청, 운영 DB 변경, 장애 재현, 테스트 실행은 하지 않았다. 따라서 아래 위험 요인을 실제 장애의 확정 원인으로 보고하지 말 것.

## 2. 범위와 용어를 먼저 고정한다

### 2.1 전체 스토어와 현재 시각

- 전체 요청에 등록된 모든 스토어를 결과 행으로 포함한다. 기본 실행 대상은 기존 `isActive` 의미를 유지한 활성 스토어다. 비활성은 `SKIPPED / STORE_INACTIVE`로 이유를 보여주며 몰래 누락시키지 않는다. 비활성 스토어의 자동 활성화는 하지 않는다.
- 활성 스토어의 인증 미설정/복호화 오류는 ‘설정 필요’인 실패 결과다. 조용히 건너뛰거나 가짜 주문을 만들지 않는다.
- 서버가 접수 시 한 번 만든 `requestedCutoffAt`을 배치와 모든 자식 작업에 동일하게 저장한다. 재시도에도 같은 기준시각을 유지한다. 프런트 시계나 자식 작업별 현재 시각을 사용하지 않는다.
- 전체 버튼은 화면의 조회 날짜 필터와 분리한다. 기본 동작은 `CURRENT`이며 기준시각까지 최신화한다. 기존 ‘선택 날짜 동기화’와 ‘최근 30일 동기화’는 명시적 `MANUAL` / `RECENT_30_DAYS` 재수집으로 유지한다.
- ‘현재 시각 기준’은 해당 시각까지의 수집 범위를 완주했다는 의미다. 네이버 상세 API가 조회 순간의 최신 상태만 제공한다면 모든 스토어의 과거 특정 순간 상태를 정확히 재구성할 수 없다. API가 제공하지 않는 스냅샷 일관성을 약속하지 않는다. `requestedCutoffAt`, 실제 조회·완료 시각을 구분한다.
- KST 기준 날짜 경계를 사용하고 오늘의 종료는 23:59:59가 아닌 `requestedCutoffAt`으로 제한한다. 문서화된 API 시간 정밀도와 경계 포함 규칙을 확인해 적용한다.

### 2.2 수집 시작 범위 — 제품 가정이며 구현 결과에도 명시

사용자가 과거 전체 이력의 시작일을 지정하지 않았으므로 ‘스토어 개설 이후 모든 이력’을 임의로 약속하지 않는다. 기본은 기존 최근 30일을 초기 신규 주문 수집 범위로 삼고 이후에는 저장된 변경 수집 지점부터 최신화한다. 기존 DB에 있는 오래된 주문의 최신 상태도 아래 복구 방식으로 갱신한다. UI에 최초 수집 시작일을 보여준다.

- 최초 실행: 최근 30일 결제 기준 수집 + API가 허용하는 최근 변경 이력 수집 + DB에 이미 저장된 과거 상품주문 ID의 상세 재확인. 마지막 항목도 작은 청크로 처리한다.
- 이후 실행: 성공한 변경 수집 지점(`lastSuccessfulChangedTo`)부터 기준시각까지 변경 이력을 수집하고, 최근 결제 주문 재조회도 결합해 지연 반영을 보완한다.
- 오래전에 결제되어 지금 취소/반품된 주문도 변경 시각 경로로 가져온다. 최근 30일 결제 조회만으로 최신화를 완료했다고 판단하지 않는다.
- API 변경 이력 보존기간보다 공백이 길면 공백을 감지한다. 가능한 결제 기간 재수집과 기존 주문 ID 재확인을 수행하되, 보존기간 밖의 미발견 주문까지 복원했다고 주장하지 않는다. 복구 불가능한 범위는 `COVERAGE_GAP`과 날짜를 표시하고 범위 재수집 필요 상태로 남긴다.
- 수동 과거 재수집은 최신 동기화 watermark를 전진시키지 않는다. 초기 30일보다 더 오래된 미등록 이력 전체 가져오기는 별도 백필 범위로 설명하며, 현재 작업이 완료되었다는 이유로 ‘전체 과거 이력 완전 수집’이라 표기하지 않는다.

### 2.3 성공의 정의

성공은 해당 작업 범위의 모든 페이지/상세 항목을 검증하고 주문·주문항목·필수 매핑 변경을 DB에 커밋한 후에만 선언한다. 0건도 정상 응답 구조와 페이지 종료를 검증한 뒤 성공할 수 있다. 손익 요약 갱신은 별도 결과를 가진다. 주문은 저장됐지만 요약 갱신이 실패하면 ‘주문 저장 완료 · 손익 집계 갱신 필요’ 경고와 복구 동작을 제공한다.

## 3. 현재 구현에서 확인한 사실과 위험

줄 번호는 분석 시점 기준으로 바뀔 수 있으므로 함수 이름도 함께 사용한다.

| 위치 | 확인된 동작 | 해결할 문제 |
| --- | --- | --- |
| `apps/frontend/components/orders/orders-view.tsx`, `startOrderSync` 약 85행 | POST 결과의 operationId를 보관하지 않고 접수 문구 및 `router.refresh()` 한 번 실행 | 작업이 끝날 때까지 추적하지 않음. 버튼 busy도 POST 종료 시 해제 |
| 같은 파일, `startAllStoreOrderSync` 약 120행 | 화면의 `filters.dateFrom/dateTo`를 전체 동기화에 전송 | 오래된 조회 날짜가 현재 최신화 범위를 대신함 |
| 같은 파일, 약 371행 | `data.latestOperation` 상태/요청/결과 JSON을 정적으로 표시 | UI가 완전히 없는 것은 아니지만 자동 갱신·배치 진행·실패 원인 표시가 부족 |
| `components/operations/operations-view.tsx` | 개별 상세의 오류와 재시도 버튼은 있으나 폴링 없음 | 선택한 작업의 완료 추적이 안 되고 동일 ID 상세가 갱신되지 않는 경우도 있음 |
| `apps/backend/src/order-sync.service.ts`, `enqueueSyncAll` 약 129행 | 활성 스토어마다 설정을 확인하고 작업을 하나씩 enqueue | 영속 배치 ID 없음. 중간 설정 예외/삽입 실패 시 이미 등록된 작업만 남고 전체 HTTP는 실패 가능 |
| 같은 파일, `enqueueSync` / `performSync` | 개별 동기화는 인증 없으면 mock fallback 가능. 전체 요청만 live 강제 | 운영 버튼을 눌러 모의 주문이 성공 저장될 수 있는 정책을 제거해야 함 |
| `apps/backend/src/operation.service.ts` | 영속 QUEUED/RUNNING/SUCCEEDED/FAILED, 최대 3회, lease 2분, heartbeat 30초, 재시도 backoff 존재 | 큐를 새로 발명할 필요 없음. 오류 종류 구분 없이 재시도하며 실제 진행 정보가 비어 있음 |
| 같은 파일, `runOperation` | heartbeat/성공 처리의 lease 소유권 상실(null)을 확인하지 않음 | 실행 권한을 잃은 작업의 계속 실행·늦은 저장 방지 필요 |
| 같은 파일, `markOperationSucceeded` 후 `appendSuccessAudit` | 후속 감사 기록도 일반 snapshot 쓰기 수행 | 최종 성공 이후 부가 오류를 어떻게 처리할지 명확히 해야 함. 무조건 주문 재수집하지 말 것 |
| `operation-worker.service.ts`, `drainInternal` | 한 프로세스에서는 `await pollOnce()`로 이미 순차 실행 | ‘현재 모든 스토어를 Promise.all로 실행해서 터진다’는 진단은 사실이 아님 |
| `naver-commerce.service.ts`, `fetchOrderItems` 약 292행 | 날짜별 PAYED_DATETIME 조회 후 ID/상세/정규화 배열을 누적 | 최근 변경 API 함수는 존재하지만 현재 주 수집 경로에서 사용하지 않음. 큰 배열 유지 |
| 같은 파일, pagination 함수 | 조건형 최대 100페이지, 변경형 최대 50페이지 후 그대로 반환 | 더 남아 있어도 부분 수집을 성공으로 오인 가능. cursor 반복도 명시적 방어 없음 |
| 같은 파일, 상세 정규화/추출 | 재귀적으로 배열 탐색, normalize 실패는 filter로 제거 | 응답 구조 변경·상세 누락이 0건 또는 일부 성공으로 숨겨질 수 있음 |
| 같은 파일, `requestSellerJson` / `getSellerToken` | fetch timeout 없음. 401 GW.AUTHN 재발급 1회만 있음 | 긴 hang, 429/5xx/네트워크 일시 실패 복구, 오류 메타데이터 부족 |
| 같은 파일, `requestOrderDetailBatch` | 모든 오류에서 두 후보 요청 body를 차례로 시도 | 429/인증/서버 오류도 잘못된 body 추측으로 재요청. 검증된 공식 형식으로 고정 필요 |
| `order-sync.service.ts`, `performSync` 약 254행 | 항목마다 배열 `.find`, 전체 draft 변경, 주문 성공 상태는 이 단계에서 설정 | 데이터량 증가 시 CPU 비용 증가. 최종 작업 성공과 스토어 상태 시점 불일치 |
| `database.service.ts`, `writeCommitted` 약 1227행 | JSON stringify/parse로 전체 DB 복제, PostgreSQL도 여러 테이블의 전체 행을 순회 후 hash 비교 | 변경 행만 실제 갱신하더라도 전체 직렬화·스캔 비용은 남음. 메모리/이벤트 루프 지연 후보 |
| 같은 파일, 파일 모드 lease 정리/조회 | 일부 읽기 경로에서 lease 정리가 `writeCommitted`를 호출 | UI 폴링을 늘리면 전체 JSON 쓰기 부담까지 증가할 수 있음 |
| `profit-summary.service.ts`, `refreshStoreDatesBestEffort` | 실패를 null로 반환, 요청 날짜 범위 재집계 | 과거 결제 주문의 오늘 취소 등에서 실제 영향받은 날짜 누락 및 경고 미노출 가능 |
| `apps/frontend/app/api/_utils/proxy.ts` | 동기화 route가 실제 사용하는 proxy. fetch 예외/timeout 처리 및 성공 HTTP status 전달 부족 | API 중단을 정규화된 오류로 전달하고 202 의미 보존 필요 |

추가 참고: `lib/api/route-proxy.ts`도 유사 구현이 있으나 동기화 route는 `_utils/proxy.ts`를 import한다. 잘못된 파일만 고치지 않는다. `lib/api/client.ts`의 화면 데이터용 타임아웃과 fallback도 확인한다. 실제 작업 상태 API에는 mock fallback을 사용하지 않는다.

실제 장애 원인은 다음을 측정해 좁힌다: 클릭 시 HTTP 응답/오류, 백엔드 PID 생존, 예외 stack, 메모리/RSS, 이벤트 루프 지연, DB 연결 및 저장 지연, 해당 operationId의 상태. 오래된 터널 로그만으로 현재 장애를 단정하지 않는다.

## 4. 권장 구조: 기존 큐 + 영속 배치 + 제한된 청크 처리

```text
전체 버튼 (CURRENT, idempotencyKey)
  -> 배치/스토어별 작업을 하나의 로컬 트랜잭션으로 접수 -> 202 + batchId
  -> 기존 OperationWorker가 스토어 작업을 차례로 실행
       인증 -> 날짜/변경 페이지 조회 -> 상세 검증 -> 작은 단위 저장
       -> 영향 날짜 집계 -> coverage/watermark/작업 결과 확정
  -> 배치 조회 API가 자식 결과를 모아 반환
  -> 공통 UI가 주기적으로 조회하여 진행/재시도/최종 결과 표시
```

초기 구현은 한 백엔드 프로세스, 동기화 실행 동시성 1을 유지한다. 병렬화를 해결책으로 먼저 도입하지 않는다. PostgreSQL advisory lock과 lease 보호는 유지하되, DB 전체 메모리 snapshot을 공유하는 현재 구조를 다중 백엔드 안전 구조라고 가정하지 않는다. 다중 writer에서 다른 테이블을 덮어쓰는 문제까지 검증하기 전에는 복수 worker 배포를 지원한다고 주장하지 않는다. Redis/BullMQ/SSE/WebSocket 도입은 필수가 아니다.

### 4.1 데이터 모델

기존 OperationStatus 4종은 다른 광고·매핑 작업도 사용하므로 유지한다. 재시도 대기는 `QUEUED + runAfter + attemptCount/error`로 표현하고 UI에서 별도 표시한다. 배치 결과 및 진행 단계는 별도 타입으로 추가한다.

- `OrderSyncBatch`: id, idempotencyKey, mode, requestedCutoffAt, requestedRange, createdAt, finishedAt, retryOfBatchId, schemaVersion.
- `OrderSyncBatchItem`: id, batchId, storeId, storeNameAtRequest, operationId 또는 null, eligibility, skipReason, preflightError, retry 관계. 등록 시 스토어 목록을 고정한다.
- `OrderSyncState`: storeId, initialCoverageFrom, lastSuccessfulChangedTo, lastSuccessfulSyncAt, updatedAt. 실행 중 progress와 성공 watermark를 혼동하지 않는다.
- `OperationRecord` 확장: batchId(선택), typed request/progress/result/error 또는 이에 해당하는 버전 있는 JSON. 기존 레코드는 필드가 없어도 읽혀야 한다.
- progress: stage, attempt, stageStartedAt, lastProgressAt, dateWindow, page, fetchedCount, validatedCount, committedCount, totalCount(nullable), retryAt, summaryStatus. heartbeatAt은 생존, lastProgressAt은 실제 진척이다.
- checkpoint: queryKind, window start/end, cursor/page, chunk identity, schemaVersion. 커밋된 청크까지만 기록한다. raw 응답 전체를 progress에 넣지 않는다.
- error: code, category, retryable, safeMessage, actionHint, stage, upstreamStatus, upstreamCode, traceId. 비밀키·토큰·구매자 개인정보를 저장/노출하지 않는다.

새 batch/item/state 테이블은 기존 JSONB 테이블 관례를 활용할 수 있다. PostgreSQL 경로에서는 전용 repository와 트랜잭션으로 관리하고, 일반 snapshot 저장이 오래된 작업 상태를 덮어쓰지 않도록 `queueOwned` 정책을 적용한다. 파일 모드도 `DatabaseShape`, `createEmptyDatabase`, normalize, atomic rename, export/import/maintenance 도구를 함께 갱신한다. 별도 테이블을 추가하면서 백업 목록에서 빠뜨리지 않는다.

### 4.2 접수 원자성과 중복 방지

1. 접수에서는 네이버 API 호출이나 비밀키 복호화를 하지 않는다. 스토어 목록/입력 검증/작업 생성만 수행한다. 각 스토어 인증 오류는 해당 worker의 실패로 격리한다.
2. batch + 모든 batch item + 실행할 자식 operation을 하나의 트랜잭션으로 저장한다. 파일 모드는 한 번의 원자적 쓰기다. DB 접수 실패 시 전부 rollback하며 202를 반환하지 않는다.
3. 클라이언트는 한 논리 요청에 UUID idempotencyKey를 만든다. 응답 유실 후 재요청도 같은 키를 사용한다. 서버는 키 uniqueness와 요청 fingerprint를 검증한다. 같은 키/같은 요청은 기존 배치를 반환하고, 같은 키/다른 요청은 409다.
4. 단일/전체/재시도 접수 모두 동일한 중복·직렬화 규칙을 사용한다. 메모리의 `hasInFlightOperation` 검사만으로 안전하다고 판단하지 않는다.
5. 다른 진행 중 개별 작업과 범위/기준시각이 다르면 기존 작업 성공을 이번 작업 성공으로 대체하지 않는다. 새 작업을 같은 스토어 큐의 뒤에 넣고 선행 작업 대기를 표시한다. 동일 idempotent 요청만 재사용한다. 완료되지 않은 선행 작업의 범위가 이후 작업에 충분하다는 근거 없이 skip하지 않는다.
6. UI는 접수 중 및 자신이 추적하는 전체 작업이 진행 중일 때 전체 실행 버튼을 비활성화한다. 다른 탭의 클릭/네트워크 재전송도 서버가 보호한다.
7. 수동 재시도는 새 operation 또는 새 retry batch로 이력을 남긴다. 원래 cutoff/범위를 유지하고 실패 스토어만 선택한다. ‘지금 최신화’는 새로운 CURRENT 요청이다.

### 4.3 작업 상태와 배치 집계

스토어 작업 단계는 `VALIDATING`, `AUTHENTICATING`, `FETCHING_ORDERS`, `FETCHING_DETAILS`, `SAVING`, `RECALCULATING`, `FINALIZING`을 기본으로 한다. phase의 세부 명칭은 바꿔도 사용자 의미는 유지한다.

배치 상태는 자식의 영속 상태로 계산해 count 불일치를 피한다:

| 조건 | 배치 상태 / 표시 |
| --- | --- |
| 실행 가능한 자식이 대기 중이고 아직 시작하지 않음 | QUEUED / 대기 중 |
| 실행 중 또는 자동 재시도·선행 작업 대기가 남음 | RUNNING / 진행 중 또는 재시도 대기 |
| 실행 대상 모두 저장 성공 | SUCCEEDED / 동기화 완료, 제외·경고는 별도 표시 |
| 일부 성공, 일부 최종 실패 | PARTIAL_FAILED / 완료 · 일부 실패 |
| 실행 대상 전부 최종 실패 | FAILED / 동기화 실패 |
| 활성 실행 대상 없음 | NO_TARGETS / 동기화 대상 없음. 성공 표시 금지 |

인증 오류는 실패 count, 비활성은 제외 count다. 집계 갱신 경고/coverage 경고를 눈에 띄게 구분하며 incomplete coverage는 완전 성공으로 올리지 않는다. `완료`는 종료 여부이고 `성공/실패`는 결과이므로 서로 다른 순차 단계로 오해하지 않도록 표시한다.

### 4.4 API 계약

기존 `formatApiSuccess({ ... })` envelope와 서비스 경로 `/api/v1`를 유지한다. 기존 호출부 호환성은 명시적 migration으로 관리한다.

- `POST /stores/order-sync-all`: `{ mode: "CURRENT", idempotencyKey }`. 202는 저장된 접수의 확인이다. 응답에 batchId, requestedCutoffAt, status, counts, items, statusUrl. 레거시 날짜 인자가 있으면 명시적인 MANUAL 처리로 매핑하고 조용히 무시하지 않는다.
- `POST /stores/:storeId/order-sync`: 기존 날짜 기능 유지 + mode/idempotencyKey 지원. operationId와 가능하면 동일 UI용 batchId를 반환한다.
- `GET /order-sync-batches/:batchId`: 스토어별 status/stage/counts/errors/retryAt, 범위, 기준시각, updatedAt, 최종 결과.
- `GET /order-sync-batches?active=true` 및 최근 이력 조회: 새로고침/다른 화면/다른 탭에서 진행 작업 복원. 과도한 이력 반환을 막는 pagination 포함.
- `POST /order-sync-batches/:batchId/retry-failed`: 실패 항목만 새 배치에 접수. idempotencyKey 필수, 원래 배치와 연결. 비활성 항목 자동 활성화 금지.
- 기존 `GET /operations/:id`, retry API도 계속 동작하게 하며 새 진행/오류 정보를 제공한다.

각 경로의 Next route proxy와 타입, 서비스, backend controller/DTO까지 함께 구현한다. GET은 cache 금지. POST 응답 유실은 실패 확정이 아니라 ‘접수 여부 확인 중’으로 처리하고 idempotencyKey 조회/재요청으로 복원한다. proxy의 연결 오류/timeout은 안전한 JSON 502/504로 반환한다.

## 5. 네이버 API와 누락 없는 수집

### 5.1 HTTP 계층

- 토큰 발급과 주문 요청 모두 AbortSignal로 실제 fetch/응답 body 읽기까지 제한한다. 단순 Promise.race로 실패를 반환하고 실제 요청을 남겨두지 않는다.
- 시작 기본값 제안: 요청 20초, 요청당 최대 3회(최초 포함), exponential backoff + jitter, Retry-After 우선. 이는 네이버 보장값이 아니라 조정할 앱 설정이다.
- 429, 5xx, 일시 network/timeout만 제한적으로 재시도. 잘못된 입력·권한·인증 설정 오류는 빠르게 최종 실패. 인증 만료는 캐시 제거 후 토큰 갱신 한 번만 허용한다.
- SELLER 토큰 발급 single-flight를 캐시 키 기준으로 적용한다. client secret 교체 시 무효화 정책도 테스트한다.
- seller/client별 요청 간격 및 rate limiter를 적용하되 네이버 공식 제한을 확인하기 전 임의의 QPS를 사실처럼 명시하지 않는다. 여러 스토어가 같은 앱 credential을 쓰는 상황을 고려한다.
- HTTP 재시도와 operation 재시도 예산을 따로 기록한다. 한 청크의 retry budget이 끝나면 영속 retryAt로 양보하여 다음 스토어가 진행한다. 장시간 sleep으로 worker를 독점하지 않는다.
- body 후보를 오류마다 바꾸는 방식은 제거한다. 공식 요청 형식과 검증된 응답 schema를 사용한다. 200 + HTML/잘못된 JSON/null/error envelope는 빈 주문 성공으로 취급하지 않는다.

### 5.2 범위, 페이지, 상세 완전성

- 공식 문서에서 조회 가능 기간·from/to 최대 간격·timestamp 정밀도·page 구조를 확인하고 fixture와 함께 기록한다. 읽지 못한 명세를 추측으로 구현하지 않는다.
- 시간 구간을 API 허용 범위 이하로 나누고 마지막 구간을 cutoff로 자른다. 날짜 순회가 서버 OS 시간대에 의존하지 않게 한다.
- 변경 주문 조회는 `moreFrom`/`moreSequence`를 사용한다. 경계에는 명세에 맞는 작은 overlap을 두고 storeId+externalProductOrderId로 중복 제거한다. 재조회 overlap 기본 5분은 조정 가능한 앱 정책이며 API의 지연 상한 보장이 아니다.
- 페이지 제한은 안전장치다. 더 있는 상태에서 제한 도달 시 시간 구간을 분할하거나 `INCOMPLETE_PAGINATION`으로 실패해야 한다. 무한 cursor 반복, 동일 페이지 반복, 더 이상 분할할 수 없는 밀집 구간도 명시적 실패로 처리한다.
- 상세 요청은 최대 300 ID 이내. 요청 ID와 응답 ID 집합을 비교한다. 빠진 ID, 중복/예상 외 ID, 잘못된 필수 필드에 대한 처리를 명시한다. 누락 ID만 제한 재조회한 뒤 미해결이면 완료 금지.
- 정상 0건과 파싱 실패를 구분한다. 예상 스키마를 파싱하고 잘못된 항목을 `.filter(Boolean)`로 사라지게 하지 않는다. 새 상태코드는 UNKNOWN 경고를 남기되 식별자·금액 오류는 별도 정책으로 실패시킨다.
- `fetched/validated/committed` 숫자를 구분한다. 총량이 확인되지 않았을 때 가짜 퍼센트를 계산하지 않는다.

### 5.3 체크포인트와 재시작

- 작은 시간 구간/상세 청크마다 idempotent upsert하고 커밋된 작업만 checkpoint로 확정한다. 적어도 전체 범위를 처음부터 안전하게 재실행할 수 있어야 한다.
- 변경 cursor가 재시작 후 유효하다는 보장이 없으면 마지막 미완료 시간 구간을 overlap 포함해 다시 읽는다. 변하는 offset page를 영구적인 cursor처럼 믿지 않는다.
- 같은 요청의 결과가 변할 수 있으므로 과거 더 오래된 작업이 최신 저장 상태를 덮지 않도록 스토어 작업 순서/원본 변경 시각/작업 generation을 적용한다.
- watermark는 해당 범위를 모두 완주한 뒤에만 전진한다. 부분 커밋이 있더라도 실패 상태와 저장된 건수를 표시한다. 재실행으로 금액이나 항목 수가 중복 증가하지 않아야 한다.

## 6. 저장 성능과 작업 복구

1. 우선 실측: 데이터 규모, heap/RSS, fetch/normalize/save/summary 소요시간, event-loop lag, persistenceQueue 대기시간을 기록한다. 메모리 상한만 올리는 것으로 해결했다고 하지 않는다.
2. 주문·상품·시그니처 lookup을 store별 Map으로 구축해 항목마다 전체 배열을 `.find()`하는 비용을 줄인다. 재처리 시 시그니처 사용량이나 배송비가 중복 누적되지 않도록 기존 의미를 보존한다.
3. PostgreSQL 주문 저장은 영향받은 orders/order_items/products/signatures/stores/audit 행만 쓰는 전용 commit 경로를 구현한다. 기존 manual mapping의 targeted transaction 패턴을 참고한다. 새 청크마다 `writeCommitted`로 전체 DB를 복제하는 것을 최종 성능 해결책으로 삼지 않는다.
4. `payload_hash`, 메모리 캐시, 관계 ID, 기존 수동 매핑을 보존한다. 커밋 실패 시 메모리에 먼저 적용하지 않는다. 일반 snapshot 쓰기와 targeted 쓰기를 직렬화하거나 최신 상태 병합 규칙으로 조정한다.
5. 각 청크의 주문 변경과 checkpoint는 같은 트랜잭션 또는 안전한 멱등 재실행 규칙으로 연결한다. 완료 처리 역시 watermark/최종 결과/최근 성공 시각이 서로 모순되지 않게 한다. 주문 커밋 후 terminal 기록 전 프로세스 종료도 테스트한다.
6. 파일 모드는 작은 청크와 메모리 인덱스를 사용하되 전체 JSON 구조의 비용을 인정한다. 변경 없는 stale cleanup/빈 큐 조회마다 파일을 다시 쓰지 않는다. heartbeat/progress 쓰기를 합치고 불필요한 전체 clone을 줄인다. 별도 대규모 파일 스토리지 재설계는 실측 결과에 따라 범위를 명시한다.
7. raw payload 기본 미보관 정책, optionCode/optionManageCode/packageNumber, 결제일, 클레임 상태, 수수료, 배송비, 시그니처 텍스트 절약 정책을 유지한다. 개인정보를 포함한 raw 데이터를 진행 기록에 복제하지 않는다.
8. 집계 대상은 요청 날짜뿐 아니라 변경 전/후 실제 영향받은 결제일 등 집계 기준 날짜의 합집합이다. 날짜가 바뀐 주문의 기존 날짜 집계도 정정한다. 요약 실패는 경고/재계산 동작으로 남긴다.
9. heartbeat는 중첩 호출을 막는다. lease 갱신 실패나 소유권 상실 시 실행에 abort 신호를 전달하고 추가 저장을 금지한다. 실제 commit 시 lease owner뿐 아니라 attempt/generation 토큰도 검증해 이전 실행을 차단한다. 동일 프로세스의 재획득도 구분해야 한다.
10. heartbeat가 살아 있어도 fetch가 멈출 수 있다. 요청 timeout + 단계별 무진척 watchdog을 둔다. 기본 무진척 120초를 출발점으로 하고 대량 저장 실측에 맞춰 조정한다. 총 실행시간 한도는 큰 정상 작업을 일괄 실패시키지 않도록 청크 재개와 함께 설정한다.
11. DB lock/connection/statement timeout을 적절히 제한하고 statement 취소·rollback 완료를 기다린다. JS timeout 뒤 SQL이 계속 commit되는 상태를 방치하지 않는다. 긴 저장 동안 heartbeat가 persistenceQueue에 막혀 lease가 만료되지 않는지 검증한다.
12. 실패 처리의 DB 쓰기까지 실패하면 원래 오류를 보존하고 구조화 로그를 남긴다. DB가 복구되면 만료 lease를 복구한다. DB 자체가 중단된 동안에는 UI가 ‘상태 확인 불가’를 표시해야 하며 그 순간 FAILED가 영속됐다고 보장할 수 없다.

## 7. 사용자 UI 명세

주문 화면 상단에 지속적인 ‘주문 동기화’ 패널을 두고, 앱 레이아웃에는 진행 중 작업으로 돌아갈 수 있는 작은 상태 표시를 둔다. 단일 스토어와 전체 스토어가 동일한 추적 컴포넌트를 사용한다.

```text
전체 스토어 주문 동기화       진행 중 3/6 처리 완료
기준시각 2026-09-18 14:32:10 KST / 최초 수집 범위 및 이후 변경 반영
스토어 A  완료            저장 124건 · 14:32:41
스토어 B  상세 조회 중     확인 80건 / 총량 확인 중
스토어 C  자동 재시도 대기  네이버 응답 지연 · 14:33:20 재시도 · 2/3회
스토어 D  실패            인증 설정 확인 필요 [스토어 설정]
스토어 E  대기 중         앞선 작업 완료 후 시작
스토어 F  제외            비활성 스토어
[실패한 스토어만 재시도] [작업 이력]
```

- 최초 클릭 즉시 접수 중 표시. 202 이후에는 대기/진행 표시. ‘시작했습니다’를 최종 성공 색상/문구로 대체하지 않는다.
- 사용자 문구: 대기 중, 인증 확인 중, 주문 조회 중, 상세 조회 중, 저장 중, 집계 갱신 중, 자동 재시도 대기, 완료, 실패, 제외.
- 실패는 토스트만 잠깐 띄우지 말고 패널에 유지한다. 원인 요약, 다음 행동, 재시도 가능 여부, operationId/traceId를 상세 펼침에 제공한다. raw JSON은 기본 화면에서 제거한다.
- 진행률은 우선 완료 스토어 수/실행 대상 수. 스토어 내부는 stage와 실제 처리 건수. 성공/실패/제외/대기 카운트도 분리한다.
- 하나의 공통 hook/provider가 활성 배치를 2~3초마다 조회한다. 완료/실패하면 중단하고 주문·스토어·관련 요약 데이터를 한 번 갱신한다. polling마다 전체 페이지 `router.refresh()`를 실행하지 않는다.
- 요청이 겹치지 않도록 이전 poll 완료 후 다음 poll을 예약한다. 언마운트/새 선택 시 abort, 오래된 응답 무시, 탭 비활성 시 완화, 복귀 시 즉시 조회, backoff를 구현한다.
- 조회 실패는 ‘연결이 끊겨 상태를 확인할 수 없습니다. 마지막 확인 …’로 표시한다. 기존 상태를 보존하고 재연결한다. 조회 실패만으로 실제 작업을 FAILED나 SUCCEEDED로 바꾸지 않는다.
- URL의 batchId와 서버 활성 배치 조회로 새로고침 후 복원한다. localStorage만을 유일한 작업 원장으로 사용하지 않는다.
- `operations-view`도 선택한 operationId에 따라 갱신하고 retry 응답의 새 retryOperationId를 추적한다. 다른 스토어로 필터를 바꿔도 전체 배치 진행은 유지한다.
- 상태에 텍스트/아이콘을 함께 사용하고 `aria-live`는 단계/종료 중심으로 제공한다. 매 건수 변경마다 과도하게 읽어주지 않는다.
- 임시 오류 재시도 대기와 최종 실패를 구분한다. 재시도 대기 중에는 ‘실패한 스토어 재시도’로 중복 enqueue하지 않는다.

## 8. 구현 순서와 완료 조건

### 단계 A — 재현과 계약 검증

- git 상태, 실행 방법, 실제 storage mode/데이터 규모/프로세스 수를 확인한다. `.env` 비밀값을 출력하지 않는다.
- 기존 테스트를 baseline으로 실행하고 결과를 기록한다. 네이버 읽기 fixture/fault injection으로 증상을 좁힌다. 운영 데이터에 실패를 주입하지 않는다.
- 실제 장애의 stack/HTTP/메모리 근거와 확인되지 않은 가설을 구분한다. 안정적인 재현이 안 되더라도 명백한 결함의 방어 테스트와 개선을 진행한다.
- 공식 API 상세 schema를 확인하고 sanitized fixture를 고정한다.

### 단계 B — 영속 배치/중복 방지/상태 API

- 공용 타입, DB 정규화/migration, 전용 batch repository, 원자적 enqueue, idempotency 구현.
- 단일/전체/재시도 API와 status/read API 구현. 초기에는 mock executor로 상태 전이를 검증한다.
- 완료 조건: 중간 실패 시 orphan 접수 없음, 응답 유실 복원, 같은 key 중복 없음, 기존 광고/매핑 작업 호환.

### 단계 C — 네이버 호출/수집/저장 안정화

- timeout, 오류 분류, bounded retries, 응답 검증, pagination 완주 검증.
- CURRENT 범위/변경 watermark, 청크 수집/commit/checkpoint, targeted PostgreSQL 저장, 파일 모드 no-op write 개선.
- lease 상실 차단과 재시작 복구, 영향 날짜 집계, 성공 확정 순서를 통합.
- 완료 조건: transient fault 자동 복구, permanent fault 격리, 중복/누락/가짜 성공 방지.

### 단계 D — 진행 UI 통합

- 주문 화면 패널, 공통 폴링, 전역 상태 표시, 실패 재시도, 새로고침 복원 구현.
- 기존 `latestOperation` 정적 UI를 정리하고 operations 상세도 갱신한다.
- 완료 조건: 접수부터 최종 결과까지 사용자가 화면을 수동 새로고침하지 않아도 인지.

### 단계 E — 검증/배포 준비

- 아래 테스트 표를 수행하고 변경 파일, 명령 결과, 재현된 원인, 미검증 항목을 보고한다.
- 기존 DB 복원 가능한 백업 및 schema 호환을 확인한 뒤 실제 데이터로 통제된 smoke test를 진행한다. 배포 방식은 실제 환경에 맞춘다.
- 기능 일부만 만들었다면 미완료 기준을 명시하고 ‘완료’라고 보고하지 않는다.

## 9. 파일별 작업 지도

| 파일/영역 | 변경 내용 |
| --- | --- |
| `packages/shared/src/types.ts`, `index.ts` 및 empty DB helper | batch/state/progress/error/result 타입, 레거시 기본값 |
| `apps/backend/src/order-sync.service.ts` | 단일/전체 통합 접수, CURRENT 범위, 청크 적용, 최종 상태/집계 |
| `apps/backend/src/naver-commerce.service.ts` | timeout/retry/schema/pagination/변경 주문 경로/stream 또는 async iterator |
| 신규 `order-sync-batch.service.ts` 및 필요 repository | 배치 원자 접수, 결과 집계, 실패 재시도, 활성 배치 조회 |
| `operation.service.ts`, `operation-worker.service.ts` | executor context(signal/progress/checkpoint), 재시도 분류, lease fencing |
| `database.service.ts` | targeted order commit, queueOwned 테이블, 원자 접수/중복, checkpoint, no-op write 방지 |
| `profit-summary.service.ts` | 실제 영향 날짜 재집계 및 실패 결과 계약 |
| `app.controller.ts`, `app.module.ts` | DTO/route/provider 등록, 202 및 오류 계약 |
| `run-tests.ts` 및 새 fixture/통합 테스트 | 네이버 fault injection, DB/worker/복구 테스트 |
| `apps/frontend/app/api/stores/**`, 신규 batch routes, `operations/**` | 요청/응답 전달, 상태·재시도 API |
| `apps/frontend/app/api/_utils/proxy.ts` | 실제 사용 중 proxy timeout/예외/status 전달 |
| `apps/frontend/lib/api/types.ts`, `services.ts`, `browser.ts` | 계약 타입, 엄격한 success/schema 처리, 실제 상태 fallback 금지 |
| `components/orders/orders-view.tsx` | 버튼 범위 수정, 작업 패널/진행 추적 연결 |
| `components/operations/operations-view.tsx`, `layout/app-shell.tsx`, `top-header.tsx` | 상세 갱신, 전역 진행 상태/진입 링크 |
| 신규 공통 hook 및 sync panel | 폴링 수명, 재연결, stale 응답 방지, 한국어 상태 UI |
| `scripts/db-export.mjs`, `db-import.mjs`, maintenance 관련 목록 | 새 테이블 포함, 활성 배치 및 retry 참조가 prune으로 끊기지 않게 처리 |
| `README.md` | 실제 결제/변경 조회 흐름, 운영 mock 제거, 환경 설정/복구 절차 |

신규 파일명은 조정 가능하지만 위 책임을 누락하지 않는다. 같은 저장소의 기존 상품/매핑/광고 계산을 전면 재작성하지 않는다.

## 10. 필수 검증 시나리오

기존 테스트는 `apps/backend/src/run-tests.ts`의 자체 runner를 사용한다. 현재 프런트 package에는 별도 테스트 runner가 없다. backend 단위 테스트는 기존 체계에 추가하고, 필요한 UI 테스트는 최소한의 적절한 테스트 수단을 마련하거나 브라우저 시나리오로 근거를 남긴다. DOM을 보지 않고 타입 체크만으로 UI 검증 완료라고 하지 않는다.

| 시나리오 | 기대 결과 |
| --- | --- |
| 6개 정상 스토어 전체 실행 | 1회 접수로 모두 완료, 공통 cutoff, DB 실제 저장과 UI 성공 일치 |
| 1개 429/503/timeout 후 회복 | bounded 자동 재시도, 재시도 표시, 다른 스토어 계속 진행 |
| 1개 인증 실패 또는 secret 복호화 실패 | 해당 스토어만 최종 실패, 나머지 성공, 배치 일부 실패 |
| 네이버 요청 영구 무응답 | 실제 요청 abort, 무한 RUNNING 없음, 예산 후 실패/재시도 기록 |
| 접수 N번째 DB insert 실패 | 배치와 자식 모두 rollback, orphan 작업/가짜 202 없음 |
| 더블 클릭/두 탭/응답 유실 같은 key 재전송 | 단 하나의 논리 배치, 기존 batchId 복구 |
| 동일 key에 다른 범위 | 409, 기존 작업 변조 없음 |
| 전체와 개별 요청 겹침 | 스토어별 직렬화, 서로 다른 cutoff 작업을 잘못 skip하지 않음 |
| 활성 스토어 없음/모두 비활성 | NO_TARGETS 및 제외 이유, 성공 오인 없음 |
| 인증 없는 개별 스토어 | mock 주문 생성 없음, 설정 필요 표시 |
| 정상 0건/200 HTML/잘못된 schema | 정상 0건만 성공, 나머지는 파싱/외부 응답 오류 |
| 마지막 페이지 정확히 pageSize/최대 page/cursor 반복 | 종료 명세 준수, 누락 시 성공 금지, 무한 루프 없음 |
| 상세 누락/중복 ID/잘못된 필수 값 | 집합 검증, 제한 보완 조회, 미해결은 실패 |
| KST 자정 직전/직후 및 다른 OS TZ | 고정 cutoff와 날짜 경계 일치, 다음 요청에서 경계 주문 누락 없음 |
| 30일 이전 결제 주문의 오늘 취소/반품 | 변경 조회로 반영, 과거 결제일 집계 정정 |
| 최초 상태 없는 기존 DB/긴 미동기화 공백 | 초기 범위/기존 ID 복구, coverage gap 표시, 거짓 전체 완주 없음 |
| 청크 커밋 전후 또는 terminal 확정 전 프로세스 종료 | 안전 재개, 중복 매출 없음, watermark 조기 전진 없음 |
| lease 상실 및 이전 attempt의 늦은 응답 | 이전 generation 저장/성공 처리 차단 |
| DB 장애 중 실패 기록도 실패 | 원래 오류 보존, worker 생존, UI 확인 불가, 복구 후 상태 회수 |
| 주문 저장 성공/요약 갱신 실패 | 주문 저장 완료+집계 경고, 성공한 주문을 불필요하게 재수집하지 않는 복구 |
| 화면 이동/새로고침/선택 스토어 변경 | 배치 복원, 폴링 중복/메모리 누수/오래된 응답 덮어쓰기 없음 |
| polling 일시 실패 후 회복 | 마지막 상태 유지, 확인 불가 표시, 재연결 후 최종 결과 확인 |
| 실패 스토어만 수동 재시도 | 성공 스토어 재실행 없음, retry 이력/기준시각 유지 |
| 같은 기간 재동기화 | 주문 수·매출·시그니처 사용량 중복 증가 없음, 기존 매핑 보존 |
| 광고 확정/매핑 재계산 회귀 | 기존 operation 타입 정상 동작 |
| PostgreSQL + 파일 모드 각각 | 접수/재시작/저장/상태 의미 일치, 실제 DB 통합 테스트 근거 |

성능 검증은 최소 6개 스토어 fixture로 진행한다. 실제 데이터량의 1배와 3배를 재현하되 개인정보 없는 합성 데이터로 실행한다. 100회 반복은 외부 API를 100회 호출하지 말고 mock API/테스트 DB로 진행한다. 누적 메모리 증가, backend 종료, 영구 대기, 중복 저장이 없어야 한다. 실제 네이버 smoke test는 호출 한도와 운영 데이터를 고려해 소규모로 검증한다.

초기 목표값: 로컬 정상 환경에서 접수/상태 API p95 2초 이내, 서버 상태 변경 후 UI 반영 5초 이내. 실제 하드웨어·데이터 규모와 측정치를 함께 보고한다. 2분 lease보다 긴 이벤트 루프 정지나 heartbeat 대기가 발생하면 미완료다. OOM이 없었다는 한 번의 관찰만으로 안정성을 입증하지 않는다.

명령:

```powershell
npm run lint
npm run test
npm run build
```

PostgreSQL 실제 트랜잭션/중복 접수/재시작 테스트는 별도 테스트 DB로 수행한다. 기존 fake DB harness 통과만으로 advisory lock, 원자 commit, queueOwned 동작을 검증했다고 하지 않는다. 실행하지 못한 명령과 이유는 그대로 적는다.

## 11. 운영 적용 및 복구

- 기존 운영 주문을 지우거나 DB를 초기화하지 않는다. 스키마 변경은 additive로 시작하고 레거시 JSON을 기본값으로 읽는다.
- 새로운 CURRENT 동기화 활성화 전에 실제 백업 경로 및 복원 절차를 확인한다. 배치/state 테이블도 export/import 왕복 검사한다.
- 진행 중 작업을 구버전 worker가 집어가는 혼합 배포를 피한다. 배포 시 drain/중지 후 새 버전 시작 또는 request schemaVersion 호환 차단을 사용한다.
- 청크 커밋 구조이므로 롤백은 부분 저장된 주문 삭제가 아니다. 멱등 재처리로 복구한다. 코드 롤백 시 새로운 request/progress schema를 구버전이 처리 가능한지도 확인한다.
- 작업 로그에는 batchId, operationId, storeId, attempt, stage, elapsedMs, counts, 오류 code를 남긴다. 오류 원문에서 토큰/secret/구매자 정보는 제거한다.
- 상태 API는 작업 전체 rawPayload를 전달하지 않는다. 진행 기록/배치 정리 정책은 활성 작업과 재시도 참조를 보호한다.
- 실제 ‘터짐’이 OOM/프로세스 종료로 확인되면 그 재현 케이스가 해결됐는지 반드시 별도로 보고한다. 외부 API 불안정 또는 운영 DB 장애 자체를 앱이 없앨 수는 없으며, 그런 경우에도 상태와 복구 경로가 명확해야 한다.

## 12. 공식 참고 자료와 확인 한계

2026-09-18 확인 시 current 문서는 2.89.0(2026-09-15)이었다. 다음 세션은 구현 시점 공식 명세를 다시 확인한다.

- [조건형 상품 주문 상세 내역 조회](https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-with-conditions-pay-order-seller): 현재 코드가 사용하는 결제 범위 조회 endpoint의 공식 출처.
- [변경 상품 주문 내역 조회](https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-last-changed-status-pay-order-seller): 변경 시각 기준이며, 후속 조회에 moreFrom/moreSequence를 전달하는 방식 확인.
- [상품 주문 상세 내역 조회](https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-pay-order-seller): 요청 ID 최대 300개 확인.

이번 웹 텍스트 추출에서는 동적 Request/Response schema 전체가 노출되지 않았다. 따라서 정확한 보존기간, 조건형 최대 조회 간격, 페이지 종료 필드, rate limit 수치, 상세 body/응답 wrapper의 최종 계약은 이 문서에서 확정하지 않는다. 구현 단계에서 공식 schema 또는 공식 예제를 확인하고 테스트 fixture에 반영한다.

## 13. 다음 세션 완료 보고에 포함할 내용

1. 실제로 확인한 장애 원인과 이를 입증한 재현/로그/측정 근거. 확인 못 한 원인은 추정이라고 명시.
2. 한 번 클릭부터 최종 결과까지의 동작과 사용자 화면.
3. 최초 수집 범위, 이후 최신화 방식, API 한계 및 coverage gap 처리.
4. 변경 파일과 DB migration/환경 설정.
5. 실행한 테스트·성능 수치·PostgreSQL 및 파일 모드 검증 결과.
6. 실제 네이버 smoke test 여부, 미검증 항목, 남은 문제.

다음 세션에 사용할 요청 예시:

> `document/ORDER_SYNC_RELIABILITY_IMPLEMENTATION_PLAN.md`를 읽고 이 계획의 주문 동기화 안정화와 상태 UI를 실제 구현해줘. 현재 코드와 달라진 부분을 먼저 확인하고 기존 변경을 보존해줘. 전체 스토어 한 번 동기화, 스토어별 실패 격리, 현재 시각 범위, 누락 방지, 영속 상태 추적, 재시작 복구까지 구현하고 필수 테스트를 수행해줘. 계획만 다시 작성하거나 UI만 만들고 완료 처리하지 말고, 확인된 결과와 미검증 항목을 구분해 보고해줘.
