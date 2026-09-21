# 주문 수집 API 계약과 검증 근거

확인일: 2026-09-18. 실제 판매자 API나 운영 DB를 호출하지 않고 공식 문서와 네이버 기술지원 답변을 확인했다. 테스트는 가상의 주문 응답을 사용한다.

## 확인한 공식 계약

- 조건형 조회 `GET /v1/pay-order/seller/product-orders`: `data.contents[n].content.productOrder`에서 상품주문 ID를 읽고 `data.pagination.page/hasNext`로 페이지 진행을 검증한다. 배열 길이만으로 종료를 추측하지 않는다. [공식 API](https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-with-conditions-pay-order-seller), [content 중첩 경로에 대한 네이버 답변](https://github.com/commerce-api-naver/commerce-api/discussions/2935), [정상 빈 배열과 pagination 예시](https://github.com/commerce-api-naver/commerce-api/discussions/2475).
- 상세 조회 `POST /v1/pay-order/seller/product-orders/query`: 요청 본문은 `{ productOrderIds: [...] }` 하나만 사용하며 최대 300개씩 요청한다. `data[]`의 `order/productOrder`를 검증하고 요청 집합과 반환 집합을 비교한다. 누락 ID는 한 번 더 조회하며, 중복·예상 밖 ID 또는 재조회 후 누락은 성공으로 처리하지 않는다. [공식 API](https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-pay-order-seller), [공식 요청 예시](https://github.com/commerce-api-naver/commerce-api/discussions/1851).
- 변경 조회 `GET /v1/pay-order/seller/product-orders/last-changed-statuses`: `data.lastChangeStatuses`, `data.count`, `data.more.moreFrom/moreSequence`를 검증한다. 후속 요청에는 `moreFrom`을 `lastChangedFrom`으로, `moreSequence`를 그대로 전달한다. 조회 구간은 최대 24시간씩 분리한다. 이는 한 요청의 조회 구간 제한이며 이력 보존기간을 의미하지 않는다. [공식 API](https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-last-changed-status-pay-order-seller), [배치 수집 FAQ](https://github.com/commerce-api-naver/commerce-api/discussions/9).
- 변경 조회 정상 0건은 `data` 자체가 없고 `timestamp/traceId`만 있는 형식도 공식적으로 제공된다. 이 두 필드만 있으며 유효한 timestamp가 있는 응답을 허용한다. `{}`나 알 수 없는 구조는 0건으로 간주하지 않는다. [네이버의 빈 응답 형식 공지](https://github.com/commerce-api-naver/api-agency/discussions/321).
- KST 오프셋과 밀리초 경계를 사용한다. `.999` 종료 후 다음 `.000` 시작은 공식 FAQ의 연속 범위 예시다. 접수 cutoff는 고정하고 최종 변경 조회 전에 cutoff 이후 5초가 지나도록 기다려 제공 지연을 보완한다. 다음 실행은 성공 watermark 이전 5분을 중복 조회한다. [경계·제공 지연 FAQ](https://github.com/commerce-api-naver/commerce-api/discussions/10).
- 반환 cursor의 `moreFrom`도 같은 순간의 KST `.SSS` 형식으로 정규화한다. [네이버 답변](https://github.com/commerce-api-naver/commerce-api/discussions/1864)에는 소수점 한 자리 cursor를 그대로 다시 전송하면 입력 형식 오류가 발생하는 사례가 있다.

## 구현 정책과 한계

- 5분 overlap, HTTP 20초 timeout, 최대 3회 요청, 지수 backoff+jitter, 긴 Retry-After의 영속 큐 위임, 조건형 100페이지/변경형 50페이지 상한은 이 애플리케이션의 보호 정책이다. 페이지 상한에서 후속 데이터가 있으면 `INCOMPLETE_PAGINATION` 오류를 반환한다.
- 결제 기간 조회와 기존 저장 ID 재확인을 먼저 청크로 전달하고 변경 구간을 읽는다. 변경 API가 실패하더라도 앞선 청크의 안전한 저장·재실행이 가능하며, 전체 범위 성공 여부와 watermark 확정은 호출 서비스가 담당한다.
- 공식 자료에서 확정적인 변경 이력 보존기간을 확인하지 못했다. [네이버의 한 달 조회 답변](https://github.com/commerce-api-naver/commerce-api/discussions/1645)은 24시간씩 나누어 조회하도록 설명한다. 따라서 24시간을 보존기간으로 간주하지 않는다. 장기 미수집 공백의 보수적인 보장 범위 및 명시적 기준선 재설정은 애플리케이션의 수집 서비스 정책이며 네이버의 확정된 보존기간을 의미하지 않는다. API가 특정 과거 구간을 제공하지 않는다면 완료로 숨기지 않고 오류와 실패 구간을 남겨야 한다.
- 상세 API는 조회 순간의 상태다. 고정 cutoff 시점의 과거 스냅샷을 재현한다고 보장하지 않는다. 최초 최근 30일 범위 밖 미등록 과거 주문의 완전한 발굴 또한 별도 백필 없이는 보장하지 않는다.
- 필수 식별자·수량·금액 오류는 실패한다. 알려지지 않은 상태는 기존 `UNKNOWN` 정책을 유지하며 청크 경고로 전달한다. 원본 응답은 기존 명시적 보관 옵션 외에는 저장하지 않으며 HTTP 오류에는 upstream 메시지 대신 안전한 한국어 안내와 상태/코드/traceId만 전달한다.

회귀 테스트: `apps/backend/src/naver-reliability-tests.ts`의 `runNaverReliabilityTests`는 실제 네트워크 대신 fetch fixture를 사용하며 응답 파싱, 누락/중복, 페이지 반복, 변경 주문, cutoff, 재시도, 토큰 동시 발급 및 취소를 검증한다.
