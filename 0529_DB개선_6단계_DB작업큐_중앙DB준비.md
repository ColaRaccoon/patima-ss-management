# 0529 DB 개선 6단계 - DB 기반 작업 큐와 중앙 DB 준비 지침서

## 이 문서의 목적

이 문서는 DB 개선 6단계 작업자가 현재 in-memory operation queue를 DB 기반 작업 실행 구조로 전환하고, 이후 중앙 PostgreSQL DB를 안전하게 사용할 수 있는 기반을 만들기 위한 지침서다.

이번 단계의 핵심은 여러 백엔드가 같은 DB를 바라보거나 서버가 재시작되어도 주문 동기화, 광고 업로드 확인, 매핑 재계산 같은 작업 상태가 정확히 복구되도록 만드는 것이다. 보안/인증 작업은 하지 않는다.

## 선행 조건

권장 선행 단계:

- 1단계 저장 안정화
- 2단계 row-level persistence
- 3단계 DB query pagination
- 4단계 daily summary
- 5단계 보존/백업 정책

특히 2단계가 끝나지 않은 상태에서 중앙 DB를 여러 백엔드가 동시에 바라보는 것은 위험하다. 전체 snapshot 덮어쓰기 구조가 남아 있으면 한 프로세스의 오래된 snapshot이 다른 프로세스의 최신 데이터를 되돌릴 수 있다.

## 현재 문제

현재 `OperationService`는 다음 구조다.

- 작업 record는 `operations` 배열에 저장한다.
- 실제 queue는 process memory의 `storeQueues: Map<string, Promise<void>>`에 있다.
- 서버 시작 시 QUEUED/RUNNING 작업을 실패 처리한다.
- heartbeat가 없다.
- retry/backoff가 제한적이다.
- 여러 백엔드가 있으면 같은 작업 중복 실행을 DB 차원에서 막기 어렵다.

문제:

- 서버 재시작 시 실행 중 작업은 무조건 실패 처리된다.
- 작업이 실제로 멈췄는지, 오래 걸리는지 구분하기 어렵다.
- 두 백엔드가 동시에 같은 store 작업을 실행할 수 있다.
- 중앙 DB 전환 전에 작업 실행 모델이 DB 중심이어야 한다.

## 이번 단계의 목표

1. operation record를 DB queue의 source of truth로 만든다.
2. in-memory `storeQueues` 의존을 줄인다.
3. DB lease 또는 PostgreSQL advisory lock으로 중복 실행을 막는다.
4. heartbeat와 stale detection을 도입한다.
5. retry/backoff/runAfter를 operation record에 추가한다.
6. 중앙 DB를 여러 백엔드가 바라볼 때 안전한 운영 조건을 문서화한다.

## 이번 단계에서 하지 말아야 할 것

- 인증/인가, 관리자 계정, CORS 같은 보안 작업은 하지 않는다.
- Redis를 필수 의존성으로 추가하지 않는다. PostgreSQL 기반으로 먼저 구현한다.
- 모든 작업 타입을 한 번에 복잡한 workflow engine으로 바꾸지 않는다.
- 기존 operation API 응답 shape를 깨지 않는다.
- 클라우드 DB를 실제로 연결하는 것은 마지막 검증 후 별도 작업으로 둔다.

## 집/회사 DB 동기화 보존 조건

이 단계가 끝나기 전까지 집/회사 PC 동기화의 공식 수단은 full snapshot export/import다. 이 단계가 끝난 뒤 중앙 DB를 도입하면 집/회사 동기화 방식은 "같은 중앙 DB를 사용"하는 형태로 바뀔 수 있다.

공통 원칙은 `0529_DB개선_공통_집회사동기화_필수조건.md`를 따른다.

필수 조건:

- 중앙 DB 도입 전까지 `scripts/db-export.mjs` / `scripts/db-import.mjs`를 깨지 않는다.
- 중앙 DB 도입 후에도 full backup/restore/export/import는 유지한다.
- 중앙 DB를 실제로 연결하기 전에는 row-level persistence와 DB 기반 operation queue가 완료되어야 한다.
- 여러 백엔드가 같은 DB를 볼 때 snapshot import는 백엔드 중지 또는 maintenance mode에서만 수행한다.

## 관련 파일

주요 수정 파일:

- `packages/shared/src/types.ts`
- `apps/backend/src/operation.service.ts`
- `apps/backend/src/database.service.ts`
- `apps/backend/src/order-sync.service.ts`
- `apps/backend/src/ads.service.ts`
- `apps/backend/src/order-mapping.service.ts`
- `apps/backend/src/campaign-mapping.service.ts`
- `apps/backend/src/run-tests.ts`
- `README.md`

필요 시 추가 파일:

- `apps/backend/src/operation-worker.service.ts`
- `apps/backend/src/operation-lock.service.ts`
- `migrations/20260529-operation-queue.sql`

참고:

- `0529_DB개선_2단계_row_level_persistence.md`

## OperationRecord 확장 후보

`packages/shared/src/types.ts`의 `OperationRecord`에 다음 필드 추가를 검토한다.

```ts
attemptCount: number;
maxAttempts: number;
runAfter: string | null;
heartbeatAt: string | null;
leaseOwner: string | null;
leaseExpiresAt: string | null;
lockedAt: string | null;
progressJson: Record<string, unknown> | null;
```

주의:

- 기존 데이터 migration을 위해 `DatabaseService.normalizeSnapshot()`에서 기본값을 보정한다.
- 프론트가 사용하지 않는 필드는 추가해도 기존 UI를 깨지 않는다.

## DB queue 설계

### 1. 작업 생성

enqueue 시:

1. operation row를 `QUEUED`로 저장한다.
2. `runAfter = now`
3. `attemptCount = 0`
4. `maxAttempts` 기본값 설정
5. 즉시 executor를 메모리 promise chain에 넣지 않는다.
6. worker loop가 DB에서 가져가 실행한다.

### 2. 작업 획득

PostgreSQL 기준 후보 SQL:

```sql
SELECT id
FROM operations
WHERE payload->>'status' = 'QUEUED'
  AND (payload->>'runAfter' IS NULL OR payload->>'runAfter' <= $1)
ORDER BY payload->>'createdAt'
LIMIT 1
FOR UPDATE SKIP LOCKED
```

현재 JSONB storage라 `FOR UPDATE SKIP LOCKED`를 쓰려면 row-level transaction 안에서 payload를 update해야 한다.

획득 시:

- status = RUNNING
- leaseOwner = process id 또는 instance id
- leaseExpiresAt = now + lease duration
- heartbeatAt = now
- startedAt = now if null
- attemptCount += 1

### 3. store 단위 중복 방지

주문 동기화 같은 작업은 store별 중복 실행을 막아야 한다.

방법:

1. PostgreSQL advisory lock
2. operation unique partial index
3. queue 획득 query에서 같은 store/type RUNNING 여부 확인

권장 1차:

- advisory lock 사용
- lock key: hash(`storeId:operationType`)
- 작업 시작 시 lock 획득 실패하면 runAfter를 조금 뒤로 미룬다.

### 4. heartbeat

긴 작업은 주기적으로 heartbeat를 갱신한다.

```ts
await operationService.heartbeat(operationId, progressJson?)
```

정책:

- heartbeat interval: 15~30초
- lease duration: 2~5분
- lease 만료 시 다른 worker가 재시도 가능

### 5. retry/backoff

실패 시:

- attemptCount < maxAttempts이면 QUEUED로 되돌리고 runAfter를 backoff 시간 후로 설정
- attemptCount >= maxAttempts이면 FAILED
- errorMessage 저장

backoff 예:

- 1차: 1분
- 2차: 5분
- 3차: 15분

### 6. 기존 retry API

기존 `retry(operationId)`는 새 operation을 생성하는 구조를 유지해도 된다.

단:

- retryOfOperationId 연결 유지
- 원본 requestJson 사용
- 새 operation은 DB queue에 들어간다.

## Worker 설계

### OperationWorkerService

Nest module init 시 worker loop를 시작한다.

메서드 후보:

```ts
start(): void
stop(): Promise<void>
pollOnce(): Promise<boolean>
runOperation(operation: OperationRecord): Promise<void>
```

주의:

- 테스트하기 쉽게 `pollOnce()`를 public 또는 injectable하게 둔다.
- shutdown 시 새 작업 획득을 멈추고 현재 작업 heartbeat를 정리한다.
- executor registry는 기존 `registerRetryExecutor()` 구조를 확장한다.

## 구현 순서

1. `OperationRecord` 타입을 확장한다.
2. `DatabaseService.normalizeSnapshot()`에서 기존 operation 기본값을 보정한다.
3. `OperationService.enqueue()`를 DB queue 생성만 하도록 바꾼다.
4. `OperationWorkerService`를 추가한다.
5. operation 획득/lease/heartbeat helper를 구현한다.
6. 기존 executor 등록 구조를 worker가 사용할 수 있게 정리한다.
7. 주문 동기화, 광고 confirm, 매핑 재계산 operation이 새 worker로 실행되게 연결한다.
8. stale operation 처리를 heartbeat/lease 기준으로 바꾼다.
9. operation list/get API 응답은 기존 shape를 유지하되 새 메타를 포함한다.
10. tests를 추가한다.

## 테스트 지침

필수 테스트:

1. enqueue는 operation을 QUEUED로 저장한다.
2. worker pollOnce는 QUEUED operation 하나를 RUNNING으로 lease 잡고 실행한다.
3. 성공 시 SUCCEEDED와 resultJson이 저장된다.
4. 실패 시 attemptCount가 증가한다.
5. maxAttempts 전에는 backoff 후 QUEUED로 돌아간다.
6. maxAttempts 이후 FAILED가 된다.
7. heartbeat가 heartbeatAt과 progressJson을 갱신한다.
8. lease가 살아 있는 작업은 다른 worker가 획득하지 않는다.
9. lease 만료 작업은 재획득 가능하다.
10. 같은 storeId/operationType 작업이 동시에 실행되지 않는다.

검증 명령:

```powershell
npm.cmd run typecheck --workspace @patima/shared
npm.cmd run typecheck --workspace @patima/backend
npm.cmd run test --workspace @patima/backend
npm.cmd run lint
```

가능하면 PostgreSQL local 환경에서 worker 중복 실행 smoke test를 한다.

## 중앙 DB 준비 체크리스트

중앙 DB 연결 전 반드시 확인:

- 2단계 row-level persistence가 완료되어 있다.
- `TRUNCATE + 전체 재삽입`이 남아 있지 않다.
- 저장 성공 응답이 commit 성공을 의미한다.
- operation queue가 DB lease/heartbeat 기반이다.
- 백업/restore 리허설이 있다.
- 여러 백엔드 실행 시 같은 store operation이 중복 실행되지 않는다.

중앙 DB 전환 자체는 별도 작업으로 한다.

## 완료 기준

- operation queue의 source of truth가 DB가 된다.
- in-memory `storeQueues` 의존이 제거되거나 보조 역할로 축소된다.
- heartbeat와 lease가 operation에 기록된다.
- stale running operation 처리가 lease 기준으로 동작한다.
- retry/backoff가 DB에 기록된다.
- multi-backend 중복 실행 위험이 줄어든다.
- shared/backend typecheck, backend test, 전체 lint가 통과한다.

## 다음 단계로 넘길 내용

6단계 완료 후 가능한 후속 작업:

- 실제 중앙 PostgreSQL DB 연결 검토
- 운영 배포 방식 정리
- 보안 단계와 결합해 관리자 인증/CORS/키 관리 적용
- Redis 또는 외부 queue 도입 여부 재검토

## 다음 세션 실행 프롬프트

```text
너는 Codex다. 작업 경로는 C:\Users\seong\Desktop\workspace\patima-naver-ss 이다.

반드시 먼저 0529_DB개선_6단계_DB작업큐_중앙DB준비.md 파일을 끝까지 읽고, 보안/인증 작업은 제외한 채 DB 기반 operation queue를 구현해라.

이번 목표:
- OperationRecord를 DB queue의 source of truth로 만든다.
- in-memory storeQueues 의존을 줄이거나 제거한다.
- leaseOwner, leaseExpiresAt, heartbeatAt, attemptCount, runAfter 기반으로 작업을 실행한다.
- 같은 storeId/operationType 작업이 중복 실행되지 않게 한다.
- 중앙 DB 전환 전 체크리스트를 만족하도록 만든다.
- 실제 클라우드 DB 연결과 보안 작업은 하지 않는다.

작업 후 다음을 실행해라:
- npm.cmd run typecheck --workspace @patima/shared
- npm.cmd run typecheck --workspace @patima/backend
- npm.cmd run test --workspace @patima/backend
- npm.cmd run lint

최종 응답에는 변경 파일, queue/lease/heartbeat 동작 방식, retry/backoff 정책, 테스트 결과를 포함해라.
```
