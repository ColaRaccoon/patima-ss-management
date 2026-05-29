# scripts/

프로젝트 유지보수용 범용 스크립트.

## db-export.mjs / db-import.mjs

다른 PC(회사 ↔ 집)에서 동일 데이터로 작업하기 위한 스냅샷 이동 도구.

이 프로젝트는 Postgres에 `(id TEXT, payload JSONB, payload_hash TEXT, updated_at)` 구조로
모든 데이터를 저장한다. 백엔드 runtime 쓰기는 row 단위 upsert/delete를 사용하지만,
이 스크립트는 PC 간 이동과 백업 복원을 위한 명시적 full snapshot 도구다.
`pg_dump` 없이도 JSON 한 파일로 완전한 복원 지점이 된다.

### 내보내기 (소스 PC)

```
node scripts/db-export.mjs
# 또는 경로 지정
node scripts/db-export.mjs snapshot.json
```

기본 출력: `backups/patima-<timestamp>.json` (gitignored).

### 가져오기 (대상 PC)

1. 저장소 클론 및 의존성 설치
   ```
   git clone <repo>
   cd patima-naver-ss
   npm install
   ```

2. `.env` 작성 (회사 PC의 `.env` 내용 참고하여 직접 작성; `.env`는 gitignore)
   ```
   DATABASE_URL=postgresql://patima_app:patima_local@localhost:5432/patima_naver_ss
   MASTER_KEY=<회사 PC와 동일 값>
   NAVER_STORE_NAME=Infinity Sports
   PORT=4000
   NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api/v1
   ```

   `MASTER_KEY`는 암호화된 commerce credential 복호화에 쓰이므로 반드시 동일 값.

3. Postgres 기동 (docker compose 사용)
   ```
   docker compose up db -d
   ```

4. 스냅샷 임포트 — 백엔드는 켜지 말 것 (snapshot-replace가 덮어씀)
   ```
   node scripts/db-import.mjs <snapshot 경로>
   # 확인 없이 바로 실행
   node scripts/db-import.mjs <snapshot 경로> --yes
   ```

5. 백엔드/프론트 기동
   ```
   npm run dev
   ```

### 주의

- 임포트는 대상 DB의 **모든 JSONB 블롭 테이블을 TRUNCATE** 후 교체한다.
- 스냅샷은 `schemaVersion`과 `payload_hash`를 포함한다. 오래된 v1 스냅샷은
  임포트 시 `payload_hash`를 backfill해서 복원한다.
- 임포트 후 backend가 필요한 `payload_hash` 컬럼과 JSONB expression index를 보장한다.
- 이 도구는 단방향 full sync이며, 양쪽 PC에서 동시에 수정한 데이터를 merge하지 않는다.
- 소스 PC의 스냅샷을 집 PC로 옮기는 법: 이메일 첨부, 클라우드 드라이브,
  USB, 또는 private git-lfs. `backups/`는 `.gitignore`에 들어있어 일반
  커밋으로는 올라가지 않는다.
- 주기적으로(작업 전후) 스냅샷을 뜨면 양쪽 PC의 동기화가 쉬워진다.
