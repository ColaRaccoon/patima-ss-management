// PAYED_DATETIME API 세부 조사
// 실행: node scripts/debug-api-deep.mjs

import bcrypt from "bcryptjs";

const NAVER_API_BASE_URL = "https://api.commerce.naver.com/external";
const CLIENT_ID = process.env.NAVER_CLIENT_ID ?? "79637ozpsgViSKrcRsy9L7";
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET ?? "$2a$04$R6b3ZZXRBxAfw/gHRdnXxu";
const ACCOUNT_UID = process.env.NAVER_ACCOUNT_UID ?? "ncp_2vBqbbyI2AVn4hCZdi1cN";
const TARGET_DATE = "2026-04-16";

function createSign(clientId, clientSecret, timestamp) {
  return Buffer.from(
    bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret),
    "utf8",
  ).toString("base64");
}

async function getToken() {
  const timestamp = Date.now().toString();
  const signature = createSign(CLIENT_ID, CLIENT_SECRET, timestamp);
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    timestamp,
    client_secret_sign: signature,
    grant_type: "client_credentials",
    type: "SELLER",
    account_id: ACCOUNT_UID,
  });
  const res = await fetch(`${NAVER_API_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  return json.access_token;
}

async function callApi(token, params) {
  const url = new URL(`${NAVER_API_BASE_URL}/v1/pay-order/seller/product-orders`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return await res.json();
}

const token = await getToken();
const from = `${TARGET_DATE}T00:00:00.000+09:00`;
const to = `${TARGET_DATE}T23:59:59.999+09:00`;

// 1. 기본 호출 - pagination 정보 확인
console.log("=== 1. PAYED_DATETIME 기본 호출 - pagination 정보 ===");
const basic = await callApi(token, {
  from, to, rangeType: "PAYED_DATETIME", pageSize: "100", page: "1",
});
console.log("data 구조:", JSON.stringify(basic.data?.pagination, null, 2));
const sampleContent = basic.data?.contents?.[0];
if (sampleContent) {
  console.log("첫 항목 keys:", Object.keys(sampleContent));
  if (sampleContent.productOrder) {
    console.log("productOrder keys:", Object.keys(sampleContent.productOrder));
  }
  console.log("\n첫 항목 전체:");
  console.log(JSON.stringify(sampleContent, null, 2).substring(0, 1500));
}

// 2. productOrderStatuses를 명시적으로 모든 상태 다 넣어보기
console.log("\n=== 2. 다양한 productOrderStatus 조합 테스트 ===");

const allStatuses = [
  "PAYMENT_WAITING", "PAYED", "DELIVERING", "DELIVERED",
  "PURCHASE_DECIDED", "EXCHANGED", "CANCELED", "RETURNED",
  "CANCELED_BY_NOPAYMENT"
];

// 각 상태별로 단독 호출
for (const status of allStatuses) {
  let totalCount = 0;
  for (let page = 1; page <= 30; page++) {
    const res = await callApi(token, {
      from, to, rangeType: "PAYED_DATETIME",
      pageSize: "100", page: String(page),
      productOrderStatuses: status,
    });
    const cnt = res.data?.contents?.length ?? 0;
    totalCount += cnt;
    if (cnt < 100) break;
  }
  console.log(`  ${status}: ${totalCount}건`);
}

// 3. 모든 상태를 콤마로 합쳐서
console.log("\n=== 3. productOrderStatuses 콤마 결합 ===");
let totalAll = 0;
for (let page = 1; page <= 30; page++) {
  const res = await callApi(token, {
    from, to, rangeType: "PAYED_DATETIME",
    pageSize: "100", page: String(page),
    productOrderStatuses: allStatuses.join(","),
  });
  const cnt = res.data?.contents?.length ?? 0;
  totalAll += cnt;
  if (cnt < 100) break;
}
console.log(`  결합: ${totalAll}건`);

// 4. claimStatuses 추가
console.log("\n=== 4. claimStatuses 추가 ===");
const claimStatuses = ["CANCEL_REQUEST", "CANCELING", "CANCEL_DONE", "RETURN_REQUEST", "EXCHANGE_REQUEST", "PURCHASE_DECISION_HOLDBACK", "ADMIN_CANCELING", "ADMIN_CANCEL_DONE"];
let totalClaim = 0;
for (let page = 1; page <= 30; page++) {
  const res = await callApi(token, {
    from, to, rangeType: "PAYED_DATETIME",
    pageSize: "100", page: String(page),
    claimStatuses: claimStatuses.join(","),
  });
  const cnt = res.data?.contents?.length ?? 0;
  totalClaim += cnt;
  if (cnt < 100) break;
}
console.log(`  claim 필터만: ${totalClaim}건`);

// 5. ORDERED_DATETIME으로 시도
console.log("\n=== 5. ORDERED_DATETIME 비교 ===");
let totalOrd = 0;
const orderedIds = new Set();
for (let page = 1; page <= 30; page++) {
  const res = await callApi(token, {
    from, to, rangeType: "ORDERED_DATETIME",
    pageSize: "100", page: String(page),
  });
  const items = res.data?.contents ?? [];
  items.forEach((c) => {
    const id = c.productOrder?.productOrderId ?? c.productOrderId;
    if (id) orderedIds.add(String(id));
  });
  totalOrd += items.length;
  if (items.length < 100) break;
}
console.log(`  ORDERED_DATETIME: ${totalOrd}건 (unique ${orderedIds.size}건)`);

// 6. PAYED + ORDERED 병합
console.log("\n=== 6. PAYED와 ORDERED 차집합 ===");
const payedIds = new Set();
for (let page = 1; page <= 30; page++) {
  const res = await callApi(token, {
    from, to, rangeType: "PAYED_DATETIME",
    pageSize: "100", page: String(page),
  });
  const items = res.data?.contents ?? [];
  items.forEach((c) => {
    const id = c.productOrder?.productOrderId ?? c.productOrderId;
    if (id) payedIds.add(String(id));
  });
  if (items.length < 100) break;
}
const onlyOrdered = [...orderedIds].filter((id) => !payedIds.has(id));
const onlyPayed = [...payedIds].filter((id) => !orderedIds.has(id));
console.log(`  PAYED unique: ${payedIds.size}건`);
console.log(`  ORDERED unique: ${orderedIds.size}건`);
console.log(`  ORDERED에만: ${onlyOrdered.length}건 (4/16 주문이지만 결제일이 다른날)`);
console.log(`  PAYED에만: ${onlyPayed.length}건 (4/16 결제이지만 주문일이 다른날)`);
console.log(`  합집합: ${new Set([...payedIds, ...orderedIds]).size}건`);

console.log("\n완료!");
