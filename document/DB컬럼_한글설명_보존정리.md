# DB 컬럼 한글 설명 및 보존 정리

이 문서는 현재 프로그램 화면에서 쓰이는 한글 표현을 기준으로 DB 컬럼의 의미를 풀어쓴 것이다. 영어 컬럼명만 보고 판단하기 어려운 항목을 줄이고, 클라우드 DB 정규화 전에 어떤 컬럼을 살리고 줄일지 결정하기 위한 기준으로 사용한다.

## 판단 기준

- **보존**: 운영 DB에 장기 보관하는 것이 맞는 핵심 컬럼.
- **조건부 보존**: 현재 기능 또는 향후 추적 방식에 따라 살릴지 결정할 컬럼.
- **분리/아카이브**: 운영 조회에는 필요 없지만, 복구/감사/원본 재처리용으로 별도 파일 또는 저비용 저장소에 보관할 컬럼.
- **파생/삭제 후보**: 다른 컬럼에서 다시 만들 수 있거나 중복성이 높아 제거를 검토할 컬럼.

## 1. orders

주문 1건 자체를 나타내는 테이블이다. 화면에서는 주문상품 단위가 더 자주 보이지만, 이 테이블은 같은 주문번호 아래 여러 주문상품을 묶는 상위 레코드다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 내부 주문 ID | DB 내부 식별자. `order_items.orderId`가 참조한다. | 보존 |
| `storeId` | 스토어 ID | 어떤 네이버 스토어의 주문인지 구분한다. 집계, 동기화, 가져오기 기준이다. | 보존 |
| `externalOrderId` | 네이버 주문번호 | 네이버 원본 주문을 다시 찾는 외부 식별자다. 중복 수집 방지에도 필요하다. | 보존 |
| `orderDatetime` | 주문일시 | 주문이 발생한 시간. 주문일 기준 조회/집계에 필요하다. | 보존 |
| `paymentDatetime` | 결제일시 | 실제 결제가 완료된 시간. 매출 귀속일 기준에 더 자주 쓰인다. | 보존 |
| `orderStatus` | 주문 상태 | 주문 전체 상태. 화면의 `상태` 판단과 필터링에 사용된다. | 보존 |
| `syncedAt` | 동기화 일시 | 네이버 API에서 마지막으로 동기화한 시각. 누락/재동기화 판단에 필요하다. | 보존 |
| `createdAt` | DB 생성일시 | 이 프로그램 DB에 처음 저장된 시각. 운영상 필수는 낮다. | 조건부 보존 |
| `updatedAt` | DB 수정일시 | 마지막 갱신 시각. 증분 동기화와 디버깅에 유용하다. | 보존 |
| `rawPayload` | 네이버 주문 원본 JSON | 네이버 API 응답 원문. 현재 용량 증가의 가장 큰 원인 중 하나다. | 분리/아카이브 |

**정리:** `orders.rawPayload`는 운영 DB에서 계속 들고 있을 필요가 가장 낮다. 원본 재처리 가능성을 살리고 싶다면 파일/압축 아카이브로 보관하고, 운영 DB에는 핵심 컬럼만 남기는 쪽이 맞다.

## 2. order_items

화면의 `주문상품 테이블`에 직접 보이는 핵심 테이블이다. 실제 매출, 수량, 수수료, 매핑, 마진 계산의 출발점이다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 내부 주문상품 ID | DB 내부 식별자. 개별 주문상품 1줄을 구분한다. | 보존 |
| `orderId` | 상위 주문 ID | `orders.id`와 연결한다. 주문번호 단위 추적에 필요하다. | 보존 |
| `storeId` | 스토어 ID | 스토어별 조회/집계/동기화 기준이다. | 보존 |
| `externalProductOrderId` | 네이버 상품주문번호 | 네이버 주문상품 1줄을 특정하는 핵심 외부 ID다. | 보존 |
| `externalProductId` | 네이버 상품 ID | 네이버 상품 단위 연결에 사용된다. 상품 캐시나 추후 상품별 분석에 필요할 수 있다. | 조건부 보존 |
| `productId` | 내부 상품 ID | `products` 테이블과 연결한다. 현재 상품 테이블 활용도가 낮으면 조건부다. | 조건부 보존 |
| `rawProductName` | 원본 상품명 | 화면의 `원본 주문`에 표시되는 네이버 상품명이다. | 조건부 보존 |
| `rawOptionInfo` | 원본 옵션명 | 화면의 `원본 주문` 보조 텍스트로 표시되는 옵션 정보다. | 조건부 보존 |
| `normalizedProductName` | 정규화 상품명 | 상품명 비교용으로 공백/기호 등을 정리한 값이다. | 파생/삭제 후보 |
| `normalizedOptionInfo` | 정규화 옵션명 | 옵션 비교용으로 정리한 값이다. | 파생/삭제 후보 |
| `sourceSignature` | 원본 시그니처 | 화면의 `원본 시그니처`. 상품명+옵션을 정규화해 만든 매핑 키다. | 조건부 보존 |
| `orderSourceSignatureId` | 원본 주문 조합 ID | `order_source_signatures`와 연결한다. 매핑 테이블을 쓰면 이 값이 핵심이다. | 보존 |
| `canonicalSalesUnitId` | 표준 판매단위 ID | 화면의 `판매단위`/`매핑` 결과. 마진 계산의 기준이다. | 보존 |
| `optionCode` | 네이버 옵션 코드 | 네이버가 부여한 옵션 식별자. 옵션 단위 추적에 유용하다. | 조건부 보존 |
| `optionManageCode` | 판매자 옵션 관리 코드 | 판매자가 설정한 옵션 관리 코드. 실제로 값이 거의 없으면 제거 가능성이 높다. | 조건부 보존 |
| `packageNumber` | 배송 묶음 번호 | 함께 배송 여부를 판단하는 묶음 번호다. 화면의 `함께배송` 판단과 연결된다. | 조건부 보존 |
| `quantity` | 수량 | 화면의 `수량`. 매출/원가/순이익 계산의 핵심이다. | 보존 |
| `productPaymentAmount` | 상품 결제금액 | 화면의 `주문금액`, 손익 화면의 `상품 매출`에 해당하는 핵심 매출값이다. | 보존 |
| `totalProductAmount` | 상품 총액 | 할인/결제 차이를 비교할 때 필요한 상품 원금 계열 값이다. | 보존 |
| `deliveryFeeAmount` | 고객 부담 배송비 | 주문상품별 배송비. 배송 마진이나 실매출 계산에 필요하다. | 보존 |
| `paymentCommission` | 결제 수수료 | 손익 화면의 `수수료` 구성요소다. | 보존 |
| `knowledgeShoppingSellingInterlockCommission` | 지식쇼핑/쇼핑검색 연동 수수료 | 네이버 연동 판매 수수료 계열 값으로 보인다. 수수료 합산에 필요하다. | 보존 |
| `saleCommission` | 판매 수수료 | 네이버 판매 수수료. 손익 계산에 필요하다. | 보존 |
| `channelCommission` | 채널 수수료 | 채널별 추가 수수료. 손익 계산에 필요하다. | 보존 |
| `saleStatus` | 판매 상태 | 화면의 `상태`. 취소/반품/정상 판매 판단에 쓰인다. | 보존 |
| `orderStatus` | 주문 상태 | 주문상품 기준 상태. `saleStatus`와 함께 필터링/검증에 쓰인다. | 보존 |
| `isCanceled` | 취소 여부 | `saleStatus`/`orderStatus`에서 다시 만들 수 있으면 중복이다. | 파생/삭제 후보 |
| `isReturned` | 반품 여부 | `saleStatus`/`orderStatus`에서 다시 만들 수 있으면 중복이다. | 파생/삭제 후보 |
| `orderDate` | 주문일 | 일별 조회/집계에 쓰이는 날짜. `orderDatetime`이 없거나 집계 최적화용이면 보존한다. | 보존 |
| `paymentDate` | 결제일 | 화면의 `결제일`. 매출 귀속일과 일별 손익의 핵심 기준이다. | 보존 |
| `createdAt` | DB 생성일시 | 운영 조회에는 필수도가 낮지만 디버깅에는 도움된다. | 조건부 보존 |
| `updatedAt` | DB 수정일시 | 재동기화/증분 갱신 판단에 유용하다. | 보존 |
| `rawPayload` | 네이버 주문상품 원본 JSON | 용량 증가의 가장 큰 원인. 원본 재처리용이다. | 분리/아카이브 |

**정리:** 이 테이블에서 무조건 살릴 것은 외부 ID, 날짜, 상태, 금액, 수량, 매핑 ID다. 가장 먼저 줄일 후보는 `rawPayload`, 그다음은 `rawProductName`/`rawOptionInfo`/`sourceSignature`의 반복 저장이다. 이 값들은 `order_source_signatures`에 한 번만 보관하고 `order_items`에서는 ID로 연결하는 방식이 더 작다.

## 3. order_source_signatures

화면의 `원본 주문 조합 목록`에 해당한다. 같은 상품명+옵션 조합을 한 번만 저장하고, 표준 판매단위와 매핑하기 위한 테이블이다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 내부 원본 조합 ID | `order_items.orderSourceSignatureId`가 참조한다. | 보존 |
| `storeId` | 스토어 ID | 스토어별 원본 조합 구분에 필요하다. | 보존 |
| `sourceSignature` | 원본 시그니처 | 화면의 `원본 시그니처`. 원본 상품명+옵션 조합의 대표 키다. | 보존 |
| `rawProductNameSnapshot` | 원본 상품명 스냅샷 | 처음 또는 대표로 저장한 원본 상품명. 화면에서 원본 주문명을 보여줄 때 쓴다. | 보존 |
| `rawOptionInfoSnapshot` | 원본 옵션 스냅샷 | 대표 원본 옵션명. 화면에서 원본 옵션을 보여줄 때 쓴다. | 보존 |
| `normalizedProductName` | 정규화 상품명 | 자동 매핑이나 검색 보조에 쓸 수 있다. | 조건부 보존 |
| `normalizedOptionInfo` | 정규화 옵션명 | 자동 매핑이나 검색 보조에 쓸 수 있다. | 조건부 보존 |
| `canonicalSalesUnitId` | 표준 판매단위 ID | 현재 매핑된 판매단위. 마진 계산 기준이다. | 보존 |
| `mappingStatus` | 매핑 상태 | 화면의 `매핑 상태`. 미매핑/매핑/충돌 등을 나타낸다. | 보존 |
| `usageCount` | 사용 건수 | 화면의 `사용 건수`. 어떤 원본 조합이 많이 팔렸는지 판단한다. | 보존 |
| `firstSeenAt` | 최초 발견일시 | 원본 조합이 처음 들어온 시점. 신규 상품 감지에 도움된다. | 조건부 보존 |
| `lastSeenAt` | 마지막 발견일시 | 최근 사용 여부 판단에 도움된다. | 보존 |
| `lastAutoMappedAt` | 마지막 자동매핑 일시 | 자동 매핑 기능을 계속 쓸 때만 필요하다. 현재 값이 거의 없으면 제거 후보. | 파생/삭제 후보 |
| `mappingRuleHash` | 매핑 규칙 해시 | 어떤 규칙으로 자동 매핑됐는지 추적하는 값. 실제 활용이 없으면 제거 가능하다. | 파생/삭제 후보 |
| `createdAt` | DB 생성일시 | `firstSeenAt`과 의미가 겹칠 수 있다. | 조건부 보존 |
| `updatedAt` | DB 수정일시 | 매핑 변경 추적에 유용하다. | 보존 |

**정리:** 원본 상품명/옵션/시그니처는 주문상품마다 반복 저장하지 말고 이 테이블에 몰아두는 것이 좋다. 주문상품 테이블은 `orderSourceSignatureId`만 들고 있어도 대부분의 화면을 복원할 수 있다.

## 4. products

네이버 상품 정보를 간단히 캐시하는 테이블이다. 실제 마진 기준은 `canonical_sales_units`이므로, 이 테이블은 네이버 상품 단위 분석을 할지에 따라 중요도가 갈린다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 내부 상품 ID | `order_items.productId`와 연결된다. | 조건부 보존 |
| `storeId` | 스토어 ID | 스토어별 상품 구분. | 조건부 보존 |
| `externalProductId` | 네이버 상품 ID | 네이버 상품을 다시 찾는 외부 ID다. | 조건부 보존 |
| `name` | 상품명 | 네이버 상품명 표시/검색용. | 조건부 보존 |
| `createdAt` | DB 생성일시 | 운영 필수도 낮음. | 파생/삭제 후보 |
| `updatedAt` | DB 수정일시 | 상품명 변경 추적이 필요하면 보존. | 조건부 보존 |

**정리:** 현재 프로그램의 핵심이 판매단위별 손익이면 `products`는 필수 테이블이 아니다. 다만 네이버 상품 ID 기준 분석을 할 계획이 있으면 살린다.

## 5. canonical_sales_units

화면의 `판매단위`다. 마진 계산, 주문 매핑, 광고 매핑이 모두 최종적으로 이 단위를 기준으로 연결된다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 판매단위 ID | 주문/광고/원가를 연결하는 핵심 ID. | 보존 |
| `name` | 판매단위명 | 화면의 `판매단위` 이름. 예: 상품명/구성 단위. | 보존 |
| `displayName` | 표시명 | 화면에 보여주는 더 읽기 좋은 이름. 없으면 `name`을 쓴다. | 보존 |
| `sku` | SKU/관리코드 | 내부 상품 관리 코드가 있으면 사용. | 조건부 보존 |
| `isActive` | 활성 여부 | 더 이상 쓰지 않는 판매단위를 숨기거나 제외할 때 필요. | 보존 |
| `createdAt` | DB 생성일시 | 운영 필수도는 낮지만 추적에 도움. | 조건부 보존 |
| `updatedAt` | DB 수정일시 | 판매단위 수정 추적에 필요. | 보존 |

**정리:** 이 테이블은 거의 다 살리는 쪽이 맞다. 클라우드 DB로 가도 가장 중요한 기준 테이블이다.

## 6. campaign_sales_unit_mappings

광고 캠페인을 판매단위와 연결하는 규칙 테이블이다. 화면의 광고 매핑 영역에서 `캠페인`, `판매단위`, `상태`로 보이는 내용과 연결된다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 광고 매핑 ID | 내부 식별자. | 보존 |
| `storeId` | 스토어 ID | 스토어별 광고 매핑 구분. | 보존 |
| `campaignId` | 캠페인 ID | 네이버 광고 캠페인 식별자. | 보존 |
| `campaignName` | 캠페인 이름 | 화면의 `캠페인`. 사용자가 매핑 판단할 때 필요. | 보존 |
| `normalizedCampaignName` | 정규화 캠페인 이름 | 자동 매핑/검색 보조용. 다시 만들 수 있으면 중복이다. | 파생/삭제 후보 |
| `canonicalSalesUnitId` | 표준 판매단위 ID | 광고비를 어떤 판매단위에 붙일지 결정한다. | 보존 |
| `mappingStatus` | 매핑 상태 | 광고 매핑의 매핑/미매핑/제외 상태. | 보존 |
| `reasonNote` | 매핑 사유 메모 | 왜 이 캠페인을 이 판매단위에 붙였는지 기록한다. | 조건부 보존 |
| `createdAt` | DB 생성일시 | 운영 필수도 낮음. | 조건부 보존 |
| `updatedAt` | DB 수정일시 | 매핑 변경 추적에 필요. | 보존 |

**정리:** 광고비가 손익에 들어가려면 `campaignId`, `campaignName`, `canonicalSalesUnitId`, `mappingStatus`는 살려야 한다. 정규화 이름은 필요할 때 다시 계산하는 방식도 가능하다.

## 7. ad_excel_uploads

광고 엑셀 파일 업로드 단위 기록이다. 어떤 파일을 언제 넣었는지, 중복 업로드인지, 확정됐는지 추적한다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 업로드 ID | 업로드 1건의 내부 식별자. | 보존 |
| `storeId` | 스토어 ID | 어느 스토어 광고 파일인지 구분한다. | 보존 |
| `fileName` | 파일명 | 업로드한 엑셀 파일 이름. 사용자 확인용. | 보존 |
| `fileHash` | 파일 해시 | 같은 파일 중복 업로드 방지. | 보존 |
| `rowCount` | 행 수 | 업로드 파일의 총 row 수. 검증/요약용. | 보존 |
| `state` | 업로드 상태 | 미리보기/확정/실패 등 업로드 진행 상태. | 보존 |
| `previewMappingHash` | 미리보기 매핑 기준 해시 | 미리보기 당시 매핑 상태와 확정 시점의 차이를 검증할 때 사용. | 조건부 보존 |
| `confirmedAt` | 확정 일시 | 광고비가 실제 반영된 시각. | 보존 |
| `createdAt` | 업로드 생성일시 | 업로드 이력 조회에 필요. | 보존 |
| `updatedAt` | 업로드 수정일시 | 상태 변경 추적에 필요. | 보존 |

**정리:** 업로드 재현성과 중복 방지를 위해 대부분 살리는 것이 낫다. 다만 오래된 업로드의 세부 preview row는 아카이브 가능하다.

## 8. ad_upload_preview_rows

광고 엑셀 업로드 미리보기 row다. 확정 전 검토용 성격이 강하다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 미리보기 row ID | 내부 식별자. | 조건부 보존 |
| `uploadId` | 업로드 ID | `ad_excel_uploads`와 연결한다. | 조건부 보존 |
| `rowIndex` | 엑셀 행 번호 | 원본 파일의 몇 번째 줄인지 확인한다. | 조건부 보존 |
| `campaignId` | 캠페인 ID | 엑셀의 `캠페인 ID`. | 보존 |
| `campaignName` | 캠페인 이름 | 엑셀의 `캠페인 이름`, 화면의 `캠페인`. | 보존 |
| `adType` | 광고 구분 | 엑셀의 `광고 구분`. 광고 유형 분석이 필요하면 보존. | 조건부 보존 |
| `status` | 광고 상태 | 엑셀의 `상태`. | 조건부 보존 |
| `impressions` | 노출수 | 엑셀의 `노출수`. 광고 성과 분석을 할 때 필요. | 조건부 보존 |
| `clicks` | 클릭수 | 엑셀의 `클릭수`. 광고 성과 분석을 할 때 필요. | 조건부 보존 |
| `totalCost` | 광고비 | 손익 화면의 `광고비`로 들어가는 핵심 값. | 보존 |
| `totalConversions` | 총 전환수 | 엑셀의 `총 전환수`. 성과 분석용. | 조건부 보존 |
| `totalConversionSales` | 총 전환매출액 | 엑셀의 `총 전환매출액`. 광고 성과 분석용. | 조건부 보존 |
| `canonicalSalesUnitId` | 표준 판매단위 ID | 미리보기 시 어느 판매단위에 붙을지 보여준다. | 보존 |
| `mappingStatus` | 매핑 상태 | 미리보기 row의 매핑/미매핑 상태. | 보존 |
| `reasonNote` | 사유 메모 | 매핑 사유 또는 제외 사유. | 조건부 보존 |
| `rawRowJson` | 원본 엑셀 row JSON | 원본 재검증용. 운영 DB에는 무겁고 중복될 수 있다. | 분리/아카이브 |

**정리:** 미리보기 row는 확정 후에는 중요도가 낮아진다. 확정된 광고비는 `ad_campaign_daily_costs`에 남기고, 오래된 preview row와 `rawRowJson`은 줄일 수 있다.

## 9. ad_campaign_daily_costs

확정된 일별 광고비 테이블이다. 손익 화면의 `광고비` 계산에 직접 들어간다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 일별 광고비 ID | 내부 식별자. | 보존 |
| `storeId` | 스토어 ID | 스토어별 광고비 구분. | 보존 |
| `date` | 광고 집행일 | 일별 손익 귀속일. | 보존 |
| `campaignId` | 캠페인 ID | 네이버 광고 캠페인 식별자. | 보존 |
| `campaignName` | 캠페인 이름 | 화면의 `캠페인`. 사용자 확인용. | 보존 |
| `normalizedCampaignName` | 정규화 캠페인 이름 | 다시 만들 수 있으면 중복이다. | 파생/삭제 후보 |
| `adType` | 광고 구분 | 광고 유형별 분석이 필요하면 보존. | 조건부 보존 |
| `status` | 광고 상태 | 광고 row 상태. 운영 손익에는 필수도가 낮다. | 조건부 보존 |
| `impressions` | 노출수 | 광고 성과 분석용. | 조건부 보존 |
| `clicks` | 클릭수 | 광고 성과 분석용. | 조건부 보존 |
| `totalCost` | 광고비 | 손익 화면의 `광고비`. 핵심 비용값이다. | 보존 |
| `totalConversions` | 총 전환수 | 광고 성과 분석용. | 조건부 보존 |
| `totalConversionSales` | 총 전환매출액 | 광고 성과 분석용. | 조건부 보존 |
| `canonicalSalesUnitId` | 표준 판매단위 ID | 광고비를 판매단위별 손익에 배분한다. | 보존 |
| `mappingStatus` | 매핑 상태 | 광고비가 매핑됐는지 확인한다. | 보존 |
| `reasonNote` | 매핑 사유 메모 | 매핑 판단 근거. | 조건부 보존 |
| `reasonNoteInherited` | 상속된 사유 여부 | 사유가 규칙에서 온 것인지 표시하는 보조값. | 파생/삭제 후보 |
| `matchedRuleCount` | 매칭 규칙 수 | 디버깅용. 운영 손익에는 필수도가 낮다. | 파생/삭제 후보 |
| `weekday` | 요일 | `date`에서 다시 만들 수 있다. | 파생/삭제 후보 |
| `uploadId` | 업로드 ID | 어떤 엑셀 업로드에서 확정됐는지 추적한다. | 보존 |
| `createdAt` | 생성일시 | 운영 필수도 낮음. | 조건부 보존 |
| `updatedAt` | 수정일시 | 광고비 재확정/수정 추적에 필요. | 보존 |

**정리:** 광고비 자체는 `date`, `campaignId`, `totalCost`, `canonicalSalesUnitId`가 핵심이다. 성과 분석까지 하려면 노출/클릭/전환도 살린다.

## 10. ad_campaign_signatures

광고 캠페인 조합을 한 번만 저장하고 매핑하는 테이블이다. 주문의 `order_source_signatures`와 비슷한 역할이다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 광고 캠페인 조합 ID | 광고비 row 또는 매핑과 연결된다. | 보존 |
| `storeId` | 스토어 ID | 스토어별 캠페인 조합 구분. | 보존 |
| `campaignId` | 캠페인 ID | 네이버 광고 캠페인 식별자. | 보존 |
| `campaignNameSnapshot` | 캠페인 이름 스냅샷 | 대표 캠페인 이름. 화면 표시와 매핑 판단에 필요. | 보존 |
| `normalizedCampaignName` | 정규화 캠페인 이름 | 자동 매핑/검색 보조. 다시 계산 가능하면 삭제 후보. | 조건부 보존 |
| `canonicalSalesUnitId` | 표준 판매단위 ID | 캠페인을 어떤 판매단위에 붙일지 결정한다. | 보존 |
| `mappingStatus` | 매핑 상태 | 매핑/미매핑/제외 상태. | 보존 |
| `usageCount` | 사용 건수 | 해당 캠페인이 얼마나 자주 등장했는지. | 보존 |
| `firstSeenAt` | 최초 발견일시 | 신규 캠페인 감지에 도움. | 조건부 보존 |
| `lastSeenAt` | 마지막 발견일시 | 최근 사용 여부 판단. | 보존 |
| `createdAt` | 생성일시 | 운영 필수도 낮음. | 조건부 보존 |
| `updatedAt` | 수정일시 | 매핑 변경 추적. | 보존 |

**정리:** 광고 캠페인도 row마다 이름을 반복 저장하기보다 이 테이블에 대표값을 두고 ID로 연결하는 구조가 더 작다.

## 11. 원가 관련 테이블

판매단위별 원가, 수수료율, 기타비용 등을 저장한다. 손익 계산에서 `원가`, `기타비용`, 일부 `수수료` 계산에 연결된다.

### sales_unit_cost_settings

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 원가 설정 ID | 내부 식별자. | 보존 |
| `canonicalSalesUnitId` | 표준 판매단위 ID | 어떤 판매단위의 원가인지 연결한다. | 보존 |
| `unitCost` | 개당 원가 | 손익 화면의 `원가`. 수량과 곱해 비용 계산. | 보존 |
| `feeRate` | 수수료율 | 수수료를 비율로 계산할 때 사용. | 보존 |
| `otherCost` | 기타비용 | 손익 화면의 `기타비용`. 포장/부자재 등. | 보존 |
| `effectiveFrom` | 적용 시작일 | 날짜별 원가 변경 이력을 정확히 반영한다. | 보존 |
| `memo` | 메모 | 원가 변경 사유. | 조건부 보존 |
| `createdAt` | 생성일시 | 이력 추적용. | 조건부 보존 |
| `updatedAt` | 수정일시 | 이력 추적용. | 보존 |

### sales_unit_cost_snapshots / sales_unit_cost_snapshot_entries

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `snapshotId` | 원가 스냅샷 ID | 특정 시점 원가 세트를 묶는다. | 조건부 보존 |
| `entryId` | 스냅샷 항목 ID | 스냅샷 내부 개별 판매단위 원가. | 조건부 보존 |
| `capturedAt` | 스냅샷 생성일시 | 당시 원가 재현에 필요. | 조건부 보존 |
| `canonicalSalesUnitId` | 표준 판매단위 ID | 스냅샷 항목의 판매단위. | 조건부 보존 |
| `unitCost` | 개당 원가 | 당시 원가. | 조건부 보존 |
| `feeRate` | 수수료율 | 당시 수수료율. | 조건부 보존 |
| `otherCost` | 기타비용 | 당시 기타비용. | 조건부 보존 |

**정리:** 원가 변경 이력은 손익 재현성에 직접 영향을 준다. 단순히 현재 원가만 볼 거면 줄일 수 있지만, 과거 손익을 정확히 다시 계산하려면 원가 이력은 살리는 편이 안전하다.

## 12. daily_sales_unit_profits

일별 판매단위 손익 결과 테이블이다. 현재는 캐시/요약 테이블 성격이며, 조회 속도를 위해 만든 결과 저장소다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `storeId` | 스토어 ID | 스토어별 손익 구분. | 보존 |
| `date` | 기준일 | 일별 손익 날짜. 보통 결제일 기준. | 보존 |
| `canonicalSalesUnitId` | 표준 판매단위 ID | 어떤 판매단위의 손익인지 연결한다. | 보존 |
| `totalQuantity` | 총 수량 | 화면의 `수량`. | 보존 |
| `totalProductRevenue` | 상품 매출 | 화면의 `상품 매출`. | 보존 |
| `customerPaidDeliveryFee` | 고객 부담 배송비 | 배송비 수입. | 보존 |
| `estimatedDeliveryBaseCost` | 추정 배송 기본 원가 | 배송비 비용 추정값. | 조건부 보존 |
| `deliveryMargin` | 배송 마진 | 배송비 수입과 배송 원가 차이. 다시 계산 가능하면 삭제 후보. | 파생/삭제 후보 |
| `vatAmount` | VAT | 화면의 `VAT`. | 보존 |
| `totalAdCost` | 광고비 | 화면의 `광고비`. | 보존 |
| `totalFeeCost` | 수수료 | 화면의 `수수료`. | 보존 |
| `totalUnitCost` | 원가 | 화면의 `원가`. | 보존 |
| `totalOtherCost` | 기타비용 | 화면의 `기타비용`. | 보존 |
| `roughProfit` | 대략 손익 | 화면의 `대략 손익`. 다시 계산 가능하면 결과 캐시다. | 파생/삭제 후보 |
| `estimatedNetProfit` | 순이익 | 화면의 `순이익`. 조회 속도용 결과값. | 보존 |
| `createdAt` | 생성일시 | 캐시 생성 시각. | 조건부 보존 |
| `updatedAt` | 수정일시 | 캐시 갱신 시각. | 조건부 보존 |

**정리:** 이 테이블은 원본이라기보다 결과 캐시다. 클라우드 DB에서는 빠른 조회가 중요하면 살리고, 저장 용량을 최대한 줄이면 주문/광고/원가 원본에서 다시 계산할 수 있다.

## 13. daily_store_summaries

스토어 전체 일별 요약 테이블이다. 판매단위별 손익을 다시 합친 결과 캐시다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `storeId` | 스토어 ID | 스토어별 요약 구분. | 보존 |
| `date` | 기준일 | 일별 요약 날짜. | 보존 |
| `totalRevenue` | 총 매출 | 스토어 전체 매출 요약. | 보존 |
| `totalAdCost` | 총 광고비 | 스토어 전체 광고비 요약. | 보존 |
| `totalFeeCost` | 총 수수료 | 스토어 전체 수수료 요약. | 보존 |
| `totalUnitCost` | 총 원가 | 스토어 전체 원가 요약. | 보존 |
| `totalOtherCost` | 총 기타비용 | 스토어 전체 기타비용 요약. | 보존 |
| `estimatedNetProfit` | 추정 순이익 | 스토어 전체 순이익 요약. | 보존 |
| `createdAt` | 생성일시 | 캐시 생성 시각. | 조건부 보존 |
| `updatedAt` | 수정일시 | 캐시 갱신 시각. | 조건부 보존 |

**정리:** 이 테이블도 결과 캐시다. 원본 데이터를 보존하면 다시 만들 수 있지만, 대시보드 속도를 위해 살릴 수 있다.

## 14. operations

DB 작업 큐/작업 이력 테이블이다. 긴 작업, 동기화, 가져오기/내보내기 같은 작업의 상태를 추적한다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 작업 ID | 작업 1건 식별자. | 보존 |
| `type` | 작업 종류 | 동기화/가져오기/정리 등 어떤 작업인지 표시. | 보존 |
| `status` | 작업 상태 | 대기/진행/완료/실패 상태. | 보존 |
| `requestJson` | 작업 요청 JSON | 작업 실행에 사용한 상세 입력값. 오래되면 무거울 수 있다. | 조건부 보존 |
| `resultJson` | 작업 결과 JSON | 작업 결과 상세. 실패 원인 분석에 유용하지만 오래되면 아카이브 가능. | 조건부 보존 |
| `errorMessage` | 오류 메시지 | 실패 작업 확인에 필요. | 보존 |
| `createdAt` | 생성일시 | 작업 시작/등록 추적. | 보존 |
| `startedAt` | 시작일시 | 실제 처리 시작 시각. | 보존 |
| `finishedAt` | 완료일시 | 완료/실패 시각. | 보존 |
| `updatedAt` | 수정일시 | 상태 갱신 시각. | 보존 |

**정리:** 작업 상태와 오류 요약은 살리고, 오래된 `requestJson`/`resultJson`은 요약만 남기거나 아카이브하는 방식이 좋다.

## 15. audit_logs

매핑, 원가, 설정 변경 같은 사용자 변경 이력을 남기는 감사 로그다.

| 컬럼명 | 한글 의미 | 쓰임 | 판단 |
| --- | --- | --- | --- |
| `id` | 감사 로그 ID | 내부 식별자. | 보존 |
| `storeId` | 스토어 ID | 어느 스토어에서 발생한 변경인지 구분. | 보존 |
| `entityType` | 대상 종류 | 판매단위/매핑/원가 등 변경 대상의 종류. | 보존 |
| `entityId` | 대상 ID | 변경된 대상의 ID. | 보존 |
| `action` | 작업 종류 | 생성/수정/삭제 등. | 보존 |
| `beforeJson` | 변경 전 JSON | 변경 전 상태. 용량이 커질 수 있다. | 조건부 보존 |
| `afterJson` | 변경 후 JSON | 변경 후 상태. 용량이 커질 수 있다. | 조건부 보존 |
| `actor` | 작업자 | 누가 바꿨는지. | 보존 |
| `createdAt` | 발생일시 | 변경이 발생한 시각. | 보존 |

**정리:** 보안/감사까지 중요하면 `beforeJson`/`afterJson`을 살린다. 용량 절감이 더 중요하면 최근 N일만 운영 DB에 두고 오래된 로그는 압축 파일로 옮기는 것이 좋다.

## 16. 우선적으로 살릴 컬럼

아래 컬럼들은 클라우드 DB 정규화 후에도 운영 DB에 남기는 것이 안전하다.

| 영역 | 컬럼 |
| --- | --- |
| 주문 식별 | `storeId`, `externalOrderId`, `externalProductOrderId`, `orderId`, `orderSourceSignatureId` |
| 날짜 | `orderDatetime`, `paymentDatetime`, `orderDate`, `paymentDate`, `date`, `syncedAt`, `updatedAt` |
| 상태 | `orderStatus`, `saleStatus`, `mappingStatus`, `isActive`, `state` |
| 금액 | `productPaymentAmount`, `totalProductAmount`, `deliveryFeeAmount`, `paymentCommission`, `knowledgeShoppingSellingInterlockCommission`, `saleCommission`, `channelCommission`, `totalCost`, `unitCost`, `feeRate`, `otherCost` |
| 수량/성과 | `quantity`, `impressions`, `clicks`, `totalConversions`, `totalConversionSales` |
| 매핑 | `canonicalSalesUnitId`, `campaignId`, `campaignName`, `sourceSignature`, `usageCount`, `lastSeenAt` |
| 손익 결과 | `totalQuantity`, `totalProductRevenue`, `vatAmount`, `totalAdCost`, `totalFeeCost`, `totalUnitCost`, `totalOtherCost`, `estimatedNetProfit` |

## 17. 우선적으로 줄일 컬럼

아래 컬럼들은 용량을 크게 줄일 때 먼저 검토할 후보들이다.

| 우선순위 | 컬럼 | 이유 |
| --- | --- | --- |
| 1 | `orders.rawPayload`, `order_items.rawPayload` | 현재 export 용량 증가의 핵심 원인. 원본 재처리는 가능하게 하되 운영 DB에서는 분리하는 편이 좋다. |
| 2 | `order_items.sourceSignature`, `order_items.rawProductName`, `order_items.rawOptionInfo` | `order_source_signatures`로 빼면 주문상품마다 반복 저장하지 않아도 된다. |
| 3 | `order_items.normalizedProductName`, `order_items.normalizedOptionInfo` | 원본 상품명/옵션에서 다시 만들 수 있다. |
| 4 | `order_items.isCanceled`, `order_items.isReturned` | 상태값에서 다시 계산 가능하면 중복이다. |
| 5 | `ad_campaign_daily_costs.normalizedCampaignName`, `weekday`, `matchedRuleCount`, `reasonNoteInherited` | 조회 편의/디버깅용 성격이 강하고 다시 만들 수 있다. |
| 6 | 오래된 `ad_upload_preview_rows.rawRowJson` | 확정 후에는 운영 조회에 필요 없다. |
| 7 | 오래된 `operations.requestJson`, `operations.resultJson` | 작업 이력 요약만 남기고 상세 JSON은 아카이브 가능하다. |
| 8 | 오래된 `audit_logs.beforeJson`, `audit_logs.afterJson` | 감사 요구 수준에 따라 최근분만 DB 보관하고 나머지는 압축 보관 가능하다. |

## 18. 현재 용량 관점의 핵심 판단

최근 export 기준으로 가장 큰 문제는 `rawPayload`다. `orders`와 `order_items`에 들어 있는 네이버 원본 JSON만 줄여도 export 크기는 크게 내려간다.

그다음 단계는 주문상품 row마다 반복되는 텍스트를 줄이는 것이다. `rawProductName`, `rawOptionInfo`, `sourceSignature`, 정규화 상품명/옵션명을 `order_source_signatures`에 대표값으로 두고 `order_items`에서는 ID만 참조하면 중복 텍스트가 많이 줄어든다.

즉, 정규화 방향은 아래 순서가 가장 현실적이다.

1. `rawPayload`를 운영 DB에서 분리하고 압축 아카이브로 보관한다.
2. `order_items`의 원본 상품명/옵션/시그니처 반복 저장을 줄이고 `order_source_signatures` 중심으로 바꾼다.
3. 광고 캠페인도 `ad_campaign_signatures` 중심으로 대표값을 두고 일별 광고비에는 핵심 ID와 비용만 남긴다.
4. 손익 결과 테이블은 조회 속도용 캐시로 유지하되, 필요하면 언제든 재생성 가능하게 만든다.
5. 감사/작업 로그는 최근분만 운영 DB에 두고 오래된 상세 JSON은 아카이브한다.

## 19. 다음 검토 방식

이 문서를 기준으로 사용자가 직접 “죽여도 되는 컬럼”을 표시하면, 다음 작업은 `7단계 DB 정규 컬럼화 및 원본 분리 계획서`로 이어가면 된다.

그 계획서에는 다음 내용을 포함해야 한다.

1. 제거/분리 대상 컬럼 확정 목록.
2. 기존 export/import 호환 방식.
3. 회사 DB와 집 DB를 통째로 복사해도 깨지지 않는 동기화 절차.
4. 마이그레이션 전 백업 절차.
5. 마이그레이션 후 검증 쿼리.
6. 롤백 절차.
