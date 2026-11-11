import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHrefWithStore, buildStoreSwitchHref } from "./store-selection";

test("switching stores resets pagination and prior-store details while preserving filters", () => {
  const original = new URLSearchParams({
    storeId: "old", date: "2026-11-10", q: "상품", page: "7", orderPage: "8",
    signaturePage: "9", adPage: "10", orderPageSize: "50", orderStatus: "UNMAPPED",
    batchId: "batch-old", operationId: "operation-old", canonicalSalesUnitId: "unit-old",
  });
  const result = new URL(buildStoreSwitchHref("/mappings", original, "next"), "http://localhost");
  assert.equal(result.searchParams.get("storeId"), "next");
  assert.equal(result.searchParams.get("date"), "2026-11-10");
  assert.equal(result.searchParams.get("q"), "상품");
  assert.equal(result.searchParams.get("orderPageSize"), "50");
  assert.equal(result.searchParams.get("orderStatus"), "UNMAPPED");
  for (const key of ["page", "orderPage", "signaturePage", "adPage", "batchId", "operationId", "canonicalSalesUnitId"]) {
    assert.equal(result.searchParams.has(key), false);
  }
  assert.equal(original.get("storeId"), "old");
  assert.equal(original.get("page"), "7");
});

test("ordinary store-aware links preserve their own query and encode identifiers", () => {
  const result = new URL(buildHrefWithStore("/orders", "page=2", "store & one"), "http://localhost");
  assert.equal(result.searchParams.get("page"), "2");
  assert.equal(result.searchParams.get("storeId"), "store & one");
  assert.equal(buildHrefWithStore("/orders", "storeId=old", null), "/orders");
});
