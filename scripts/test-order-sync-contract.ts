import assert from "node:assert/strict";
import {
  readOrderSyncResponse,
  validateOrderSyncBatch,
} from "../apps/frontend/lib/api/order-sync";

async function main() {
  const batch = {
    batchId: "batch-test",
    mode: "CURRENT",
    status: "RUNNING",
    requestedCutoffAt: "2026-09-18T00:00:00.000Z",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:01.000Z",
    requestedRange: { dateFrom: "2026-08-20", dateTo: "2026-09-18" },
    counts: {
      total: 1,
      target: 1,
      queued: 0,
      running: 1,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    },
    items: [
      {
        storeId: "store-test",
        storeName: "검증 스토어",
        operationId: "operation-test",
        status: "RUNNING",
        skipReason: null,
        error: null,
        progress: { stage: "SAVING", committedCount: 3 },
        result: null,
        retryAt: null,
        initialCoverageFrom: "2026-08-20",
        attemptCount: 1,
        maxAttempts: 3,
      },
    ],
  };
  const response = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  assert.equal(
    validateOrderSyncBatch(
      await readOrderSyncResponse(
        response({ success: true, data: batch }, 202),
      ),
    ).batchId,
    "batch-test",
  );
  assert.equal(
    validateOrderSyncBatch({
      ...batch,
      mode: "YESTERDAY",
      requestedRange: { dateFrom: "2026-09-17", dateTo: "2026-09-17" },
    }).mode,
    "YESTERDAY",
  );
  for (const invalid of [
    null,
    {},
    { success: false, data: batch },
    { data: batch },
  ]) {
    await assert.rejects(readOrderSyncResponse(response(invalid)));
  }
  for (const invalid of [
    null,
    {},
    { ...batch, items: [{}] },
    { ...batch, counts: {} },
    { ...batch, status: "UNKNOWN" },
    { ...batch, requestedRange: null },
    { ...batch, items: [{ ...batch.items[0], retryAt: "bad-date" }] },
    {
      ...batch,
      items: [{ ...batch.items[0], progress: { lastProgressAt: "bad-date" } }],
    },
  ]) {
    assert.throws(() => validateOrderSyncBatch(invalid));
  }
  assert.throws(() => [batch, {}].map(validateOrderSyncBatch));
  await assert.rejects(
    readOrderSyncResponse(new Response("<html>upstream error</html>")),
  );
  await assert.rejects(
    readOrderSyncResponse(response({ success: true, data: batch }, 503)),
  );
  console.log(
    "Order sync frontend contract checks passed (valid 202, malformed lists, timestamps, false success, HTML, HTTP failure).",
  );
}

void main();
