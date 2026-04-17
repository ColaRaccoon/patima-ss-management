// 4/16 주문 데이터 불일치 디버깅 스크립트
// 실행: node scripts/debug-april16.mjs

import pg from "pg";
const { Client } = pg;

const client = new Client({
  connectionString: "postgresql://patima_app:664066@localhost:5432/patima_naver_ss",
});

await client.connect();

const TARGET_DATE = "2026-04-16";

// 1. 전체 주문 건수 및 금액 (paymentDate 기준, 모든 상태)
const allOrders = await client.query(`
  SELECT
    COUNT(*) as total_count,
    SUM((payload->>'productPaymentAmount')::numeric) as total_product_amount,
    SUM(COALESCE((payload->>'deliveryFeeAmount')::numeric, 0)) as total_delivery_fee
  FROM order_items
  WHERE payload->>'paymentDate' = $1
`, [TARGET_DATE]);

console.log("=== 1. 4/16 전체 주문 (paymentDate 기준) ===");
console.log(`  건수: ${allOrders.rows[0].total_count}`);
console.log(`  상품금액 합계: ${Number(allOrders.rows[0].total_product_amount).toLocaleString()}원`);
console.log(`  배송비 합계: ${Number(allOrders.rows[0].total_delivery_fee).toLocaleString()}원`);
console.log(`  상품+배송비: ${(Number(allOrders.rows[0].total_product_amount) + Number(allOrders.rows[0].total_delivery_fee)).toLocaleString()}원`);

// 2. saleStatus별 분포
const byStatus = await client.query(`
  SELECT
    payload->>'saleStatus' as sale_status,
    COUNT(*) as cnt,
    SUM((payload->>'productPaymentAmount')::numeric) as amount,
    SUM(COALESCE((payload->>'deliveryFeeAmount')::numeric, 0)) as delivery
  FROM order_items
  WHERE payload->>'paymentDate' = $1
  GROUP BY payload->>'saleStatus'
  ORDER BY cnt DESC
`, [TARGET_DATE]);

console.log("\n=== 2. saleStatus별 분포 ===");
for (const row of byStatus.rows) {
  console.log(`  ${row.sale_status}: ${row.cnt}건, 상품=${Number(row.amount).toLocaleString()}원, 배송비=${Number(row.delivery).toLocaleString()}원`);
}

// 3. paymentDate가 null인 주문 확인
const nullPaymentDate = await client.query(`
  SELECT
    COUNT(*) as cnt,
    SUM((payload->>'productPaymentAmount')::numeric) as amount
  FROM order_items
  WHERE payload->>'paymentDate' IS NULL OR payload->>'paymentDate' = ''
`);
console.log("\n=== 3. paymentDate가 NULL인 주문 (전체 기간) ===");
console.log(`  건수: ${nullPaymentDate.rows[0].cnt}, 금액: ${Number(nullPaymentDate.rows[0].amount || 0).toLocaleString()}원`);

// 4. 매핑 상태별 분포 (SALE만)
const mappingStatus = await client.query(`
  SELECT
    CASE
      WHEN payload->>'canonicalSalesUnitId' IS NOT NULL AND payload->>'canonicalSalesUnitId' != '' THEN 'MAPPED'
      ELSE 'UNMAPPED'
    END as mapping,
    COUNT(*) as cnt,
    SUM((payload->>'productPaymentAmount')::numeric) as amount
  FROM order_items
  WHERE payload->>'paymentDate' = $1 AND payload->>'saleStatus' = 'SALE'
  GROUP BY mapping
`, [TARGET_DATE]);

console.log("\n=== 4. 매핑 상태 (SALE만, 4/16) ===");
for (const row of mappingStatus.rows) {
  console.log(`  ${row.mapping}: ${row.cnt}건, ${Number(row.amount).toLocaleString()}원`);
}

// 5. rawStatus별 분포 (예상치 못한 상태값 확인)
const rawStatuses = await client.query(`
  SELECT
    payload->>'rawStatus' as raw_status,
    payload->>'saleStatus' as sale_status,
    COUNT(*) as cnt,
    SUM((payload->>'productPaymentAmount')::numeric) as amount
  FROM order_items
  WHERE payload->>'paymentDate' = $1
  GROUP BY payload->>'rawStatus', payload->>'saleStatus'
  ORDER BY cnt DESC
`, [TARGET_DATE]);

console.log("\n=== 5. rawStatus → saleStatus 매핑 분포 ===");
for (const row of rawStatuses.rows) {
  console.log(`  ${row.raw_status} → ${row.sale_status}: ${row.cnt}건, ${Number(row.amount).toLocaleString()}원`);
}

// 6. 네이버 결제금액과 비교를 위한 총합
const grandTotal = await client.query(`
  SELECT
    SUM((payload->>'productPaymentAmount')::numeric + COALESCE((payload->>'deliveryFeeAmount')::numeric, 0)) as grand_total,
    SUM((payload->>'productPaymentAmount')::numeric) as product_only,
    SUM(COALESCE((payload->>'deliveryFeeAmount')::numeric, 0)) as delivery_only,
    COUNT(*) as cnt
  FROM order_items
  WHERE payload->>'paymentDate' = $1
`, [TARGET_DATE]);

console.log("\n=== 6. 네이버 비교 요약 ===");
console.log(`  네이버 결제금액:     9,094,250원 (421건)`);
console.log(`  DB 상품+배송비:     ${Number(grandTotal.rows[0].grand_total).toLocaleString()}원 (${grandTotal.rows[0].cnt}건)`);
console.log(`  DB 상품만:          ${Number(grandTotal.rows[0].product_only).toLocaleString()}원`);
console.log(`  DB 배송비만:        ${Number(grandTotal.rows[0].delivery_only).toLocaleString()}원`);
console.log(`  차이(네이버-DB총합): ${(9094250 - Number(grandTotal.rows[0].grand_total)).toLocaleString()}원`);
console.log(`  건수 차이:          ${421 - Number(grandTotal.rows[0].cnt)}건`);

// 7. 고액 주문 TOP 10 (이상값 확인)
const topOrders = await client.query(`
  SELECT
    payload->>'externalProductOrderId' as order_id,
    payload->>'rawProductName' as product,
    (payload->>'productPaymentAmount')::numeric as amount,
    COALESCE((payload->>'deliveryFeeAmount')::numeric, 0) as delivery,
    (payload->>'quantity')::int as qty,
    payload->>'saleStatus' as status,
    payload->>'rawStatus' as raw_status
  FROM order_items
  WHERE payload->>'paymentDate' = $1
  ORDER BY (payload->>'productPaymentAmount')::numeric DESC
  LIMIT 10
`, [TARGET_DATE]);

console.log("\n=== 7. 고액 주문 TOP 10 ===");
for (const row of topOrders.rows) {
  console.log(`  ${row.order_id} | ${row.product?.substring(0, 30)} | ${Number(row.amount).toLocaleString()}원 | 배송비${Number(row.delivery).toLocaleString()} | qty=${row.qty} | ${row.status}(${row.raw_status})`);
}

// 8. quantity > 1인 주문 확인 (건수 계산 방식 차이 가능성)
const multiQty = await client.query(`
  SELECT
    COUNT(*) as cnt,
    SUM((payload->>'quantity')::int) as total_qty,
    SUM((payload->>'productPaymentAmount')::numeric) as amount
  FROM order_items
  WHERE payload->>'paymentDate' = $1 AND (payload->>'quantity')::int > 1
`, [TARGET_DATE]);

console.log("\n=== 8. quantity > 1 주문 ===");
console.log(`  건수: ${multiQty.rows[0].cnt}, 총수량합: ${multiQty.rows[0].total_qty}, 금액: ${Number(multiQty.rows[0].amount || 0).toLocaleString()}원`);

// 9. SALE 상태 + MAPPED 주문만의 합계 (프로그램 표시값과 동일해야 함)
const programView = await client.query(`
  SELECT
    COUNT(*) as cnt,
    SUM((payload->>'productPaymentAmount')::numeric) as amount,
    SUM(COALESCE((payload->>'deliveryFeeAmount')::numeric, 0)) as delivery
  FROM order_items
  WHERE payload->>'paymentDate' = $1
    AND payload->>'saleStatus' = 'SALE'
    AND payload->>'canonicalSalesUnitId' IS NOT NULL
    AND payload->>'canonicalSalesUnitId' != ''
`, [TARGET_DATE]);

console.log("\n=== 9. 프로그램 표시값 재현 (SALE + MAPPED) ===");
console.log(`  건수: ${programView.rows[0].cnt}`);
console.log(`  상품금액: ${Number(programView.rows[0].amount).toLocaleString()}원 (프로그램: 7,798,650원)`);
console.log(`  배송비: ${Number(programView.rows[0].delivery).toLocaleString()}원 (프로그램: 714,000원)`);

await client.end();
console.log("\n완료!");
