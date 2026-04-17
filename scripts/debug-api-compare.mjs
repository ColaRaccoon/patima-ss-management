// 네이버 API 반환 건수 vs DB 건수 비교 진단
// 실행: node scripts/debug-api-compare.mjs

import pg from "pg";
import bcrypt from "bcryptjs";

const { Client } = pg;

const NAVER_API_BASE_URL = "https://api.commerce.naver.com/external";
const CLIENT_ID = process.env.NAVER_CLIENT_ID ?? "79637ozpsgViSKrcRsy9L7";
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET ?? "$2a$04$R6b3ZZXRBxAfw/gHRdnXxu";
const ACCOUNT_UID = process.env.NAVER_ACCOUNT_UID ?? "ncp_2vBqbbyI2AVn4hCZdi1cN";
const TARGET_DATE = "2026-04-16";

// --- Naver Auth ---
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
  if (!res.ok || !json.access_token) {
    console.error("토큰 발급 실패:", json);
    process.exit(1);
  }
  return json.access_token;
}

// --- Naver API 호출 ---
async function fetchPaymentDateOrders(token, targetDate) {
  const from = `${targetDate}T00:00:00.000+09:00`;
  const to = `${targetDate}T23:59:59.999+09:00`;
  const allIds = [];
  const rawResponses = [];

  for (let page = 1; page <= 100; page++) {
    const url = new URL(`${NAVER_API_BASE_URL}/v1/pay-order/seller/product-orders`);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("rangeType", "PAYED_DATETIME");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("page", String(page));

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    rawResponses.push({ page, status: res.status, json });

    if (!res.ok) {
      console.error(`API 오류 (page ${page}):`, json);
      break;
    }

    // productOrderId 추출 (재귀 탐색)
    const ids = extractProductOrderIds(json);
    allIds.push(...ids);

    console.log(`  Page ${page}: ${ids.length}건 추출`);
    if (ids.length < 100) break;
  }

  return { allIds, rawResponses };
}

function extractProductOrderIds(obj) {
  const ids = [];
  function visit(node) {
    if (Array.isArray(node)) {
      const matching = node.filter(
        (e) => typeof e === "object" && e !== null && !Array.isArray(e) && e.productOrderId
      );
      if (matching.length > 0) {
        matching.forEach((e) => ids.push(String(e.productOrderId)));
        return;
      }
      node.forEach(visit);
      return;
    }
    if (typeof node === "object" && node !== null) {
      Object.values(node).forEach(visit);
    }
  }
  visit(obj);
  return ids;
}

// --- last-changed-statuses API로도 비교 ---
async function fetchChangedOrders(token, targetDate) {
  const start = `${targetDate}T00:00:00.000+09:00`;
  const end = `${targetDate}T23:59:59.999+09:00`;
  const allIds = [];
  let lastChangedFrom = start;
  let moreSequence = null;

  for (let page = 0; page < 100; page++) {
    const url = new URL(`${NAVER_API_BASE_URL}/v1/pay-order/seller/product-orders/last-changed-statuses`);
    url.searchParams.set("lastChangedFrom", lastChangedFrom);
    url.searchParams.set("lastChangedTo", end);
    url.searchParams.set("limitCount", "300");
    if (moreSequence != null) url.searchParams.set("moreSequence", String(moreSequence));

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();

    if (!res.ok) {
      console.error(`Changed API 오류:`, json);
      break;
    }

    // productOrderId 추출
    const entries = extractChangedEntries(json);
    entries.forEach((e) => {
      if (e.productOrderId) allIds.push(String(e.productOrderId));
    });

    // 다음 페이지 확인
    const cursor = extractCursor(json);
    if (!cursor) break;
    lastChangedFrom = cursor.moreFrom;
    moreSequence = cursor.moreSequence;
  }

  return [...new Set(allIds)];
}

function extractChangedEntries(obj) {
  const results = [];
  function visit(node) {
    if (Array.isArray(node)) {
      const matching = node.filter(
        (e) => typeof e === "object" && e !== null && (e.productOrderId || e.orderId || e.lastChangedDate)
      );
      if (matching.length > 0) {
        results.push(...matching);
        return;
      }
      node.forEach(visit);
      return;
    }
    if (typeof node === "object" && node !== null) Object.values(node).forEach(visit);
  }
  visit(obj);
  return results;
}

function extractCursor(obj) {
  let found = null;
  function visit(node) {
    if (found) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== "object" || !node) return;
    if (node.moreFrom && node.moreSequence != null) {
      found = { moreFrom: node.moreFrom, moreSequence: node.moreSequence };
      return;
    }
    Object.values(node).forEach(visit);
  }
  visit(obj);
  return found;
}

// --- DB 조회 ---
async function getDbOrderIds(targetDate) {
  const client = new Client({
    connectionString: "postgresql://patima_app:664066@localhost:5432/patima_naver_ss",
  });
  await client.connect();

  // paymentDate 기준
  const byPayment = await client.query(`
    SELECT payload->>'externalProductOrderId' as id
    FROM order_items WHERE payload->>'paymentDate' = $1
  `, [targetDate]);

  // 전체 (paymentDate 무관)
  const allItems = await client.query(`
    SELECT
      payload->>'externalProductOrderId' as id,
      payload->>'paymentDate' as payment_date
    FROM order_items
  `);

  await client.end();
  return {
    byPaymentDate: new Set(byPayment.rows.map((r) => r.id)),
    allIds: new Map(allItems.rows.map((r) => [r.id, r.payment_date])),
  };
}

// --- 메인 ---
console.log(`=== 네이버 API vs DB 비교 (${TARGET_DATE}) ===\n`);

console.log("1. 네이버 토큰 발급...");
const token = await getToken();
console.log("   OK\n");

console.log("2. PAYED_DATETIME API 호출...");
const { allIds: payedIds, rawResponses } = await fetchPaymentDateOrders(token, TARGET_DATE);
const uniquePayedIds = [...new Set(payedIds)];
console.log(`   총 ${payedIds.length}건 (중복제거: ${uniquePayedIds.length}건)\n`);

console.log("3. last-changed-statuses API 호출...");
const changedIds = await fetchChangedOrders(token, TARGET_DATE);
console.log(`   총 ${changedIds.length}건 (중복제거)\n`);

console.log("4. DB 조회...");
const db = await getDbOrderIds(TARGET_DATE);
console.log(`   DB ${TARGET_DATE} paymentDate 기준: ${db.byPaymentDate.size}건`);
console.log(`   DB 전체 주문: ${db.allIds.size}건\n`);

// 비교
console.log("=== 5. 비교 결과 ===");
const apiNotInDb = uniquePayedIds.filter((id) => !db.byPaymentDate.has(id));
const dbNotInApi = [...db.byPaymentDate].filter((id) => !uniquePayedIds.includes(id));
const apiNotInDbAtAll = apiNotInDb.filter((id) => !db.allIds.has(id));
const apiInDbOtherDate = apiNotInDb.filter((id) => db.allIds.has(id));

console.log(`\n  PAYED_DATETIME API 반환: ${uniquePayedIds.length}건`);
console.log(`  DB에 ${TARGET_DATE}로 저장:  ${db.byPaymentDate.size}건`);
console.log(`  API에 있고 DB에 없는 주문: ${apiNotInDb.length}건`);
console.log(`    → DB에 아예 없음: ${apiNotInDbAtAll.length}건`);
console.log(`    → DB에 있지만 다른 날짜: ${apiInDbOtherDate.length}건`);
if (apiInDbOtherDate.length > 0) {
  console.log(`    → 다른 날짜 목록:`);
  apiInDbOtherDate.slice(0, 10).forEach((id) => {
    console.log(`      ${id} → paymentDate: ${db.allIds.get(id)}`);
  });
}
console.log(`  DB에 있고 API에 없는 주문: ${dbNotInApi.length}건`);

console.log(`\n  last-changed-statuses API:  ${changedIds.length}건`);
const changedNotInPayed = changedIds.filter((id) => !uniquePayedIds.includes(id));
const payedNotInChanged = uniquePayedIds.filter((id) => !changedIds.includes(id));
console.log(`  changed에 있고 payed에 없는 주문: ${changedNotInPayed.length}건`);
console.log(`  payed에 있고 changed에 없는 주문: ${payedNotInChanged.length}건`);

// 누락 주문의 상세 정보 가져오기
if (apiNotInDbAtAll.length > 0 && apiNotInDbAtAll.length <= 20) {
  console.log(`\n=== 6. DB에 아예 없는 ${apiNotInDbAtAll.length}건 상세 조회 ===`);
  const batches = [];
  for (let i = 0; i < apiNotInDbAtAll.length; i += 50) {
    batches.push(apiNotInDbAtAll.slice(i, i + 50));
  }
  for (const batch of batches) {
    let details = null;
    for (const bodyFormat of [{ productOrderIds: batch }, { productOrderIdList: batch }]) {
      try {
        const res = await fetch(`${NAVER_API_BASE_URL}/v1/pay-order/seller/product-orders/query`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(bodyFormat),
        });
        if (res.ok) {
          details = await res.json();
          break;
        }
      } catch {}
    }
    if (details) {
      const entries = extractProductOrderDetails(details);
      entries.forEach((e) => {
        const po = e.productOrder ?? e;
        console.log(`  ${po.productOrderId ?? "?"} | ${(po.productName ?? "?").substring(0, 30)} | ${po.totalPaymentAmount ?? po.paymentAmount ?? "?"}원 | status=${po.productOrderStatus} | claim=${e.claimStatus ?? po.claimStatus ?? "none"}`);
      });
    }
  }
}

function extractProductOrderDetails(obj) {
  const results = [];
  function visit(node) {
    if (Array.isArray(node)) {
      const matching = node.filter((e) => typeof e === "object" && e !== null && (e.productOrderId || (e.productOrder && e.productOrder.productOrderId)));
      if (matching.length > 0) { results.push(...matching); return; }
      node.forEach(visit);
      return;
    }
    if (typeof node === "object" && node !== null) Object.values(node).forEach(visit);
  }
  visit(obj);
  return results;
}

// Raw response 첫 페이지 구조 확인
console.log("\n=== 7. PAYED_DATETIME 첫 페이지 응답 구조 키 ===");
if (rawResponses[0]?.json) {
  const keys = Object.keys(rawResponses[0].json);
  console.log(`  Top-level keys: ${JSON.stringify(keys)}`);
  for (const key of keys) {
    const val = rawResponses[0].json[key];
    if (Array.isArray(val)) {
      console.log(`  ${key}: Array[${val.length}]`);
      if (val[0]) console.log(`    첫 항목 keys: ${JSON.stringify(Object.keys(val[0]))}`);
    } else if (typeof val === "object" && val !== null) {
      console.log(`  ${key}: Object keys=${JSON.stringify(Object.keys(val))}`);
    } else {
      console.log(`  ${key}: ${val}`);
    }
  }
}

console.log("\n완료!");
