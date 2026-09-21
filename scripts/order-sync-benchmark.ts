import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Store, DatabaseShape } from "../packages/shared/src";
import { DatabaseService } from "../apps/backend/src/database.service";
import { AuditLogService } from "../apps/backend/src/audit-log.service";
import { OrderSyncBatchService } from "../apps/backend/src/order-sync-batch.service";
import { OperationService } from "../apps/backend/src/operation.service";
import { OrderSyncService } from "../apps/backend/src/order-sync.service";
import { ProfitSummaryService } from "../apps/backend/src/profit-summary.service";
import type {
  OrderStreamChunk,
  OrderStreamOptions,
  SyncedOrderItemInput,
} from "../apps/backend/src/naver-commerce.service";

// Never import dotenv/main/bootstrap. Only newly-created temporary file storage is used.
const repeats = Number(process.argv[2] ?? 100);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 1000)
  throw new Error("Expected repeat count between 1 and 1000");
const output = process.argv[3];
const storeCount = 6;
const percentile95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rounded = (number: number) => Math.round(number * 100) / 100;
const megabytes = (bytes: number) => rounded(bytes / 1024 / 1024);

const createStore = (index: number): Store => ({
  id: `benchmark-store-${index}`,
  name: `Synthetic store ${index}`,
  platformType: "NAVER_SMARTSTORE",
  sellerAccountId: `synthetic-seller-${index}`,
  channelNo: `synthetic-channel-${index}`,
  isPrimary: index === 0,
  isActive: true,
  deactivatedAt: null,
  memo: null,
  lastOrderSyncAt: null,
  lastOrderSyncStatus: "NEVER",
  credentialConnectionStatus: "NOT_TESTED",
  lastCredentialTestAt: null,
  deliveryUnitCost: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const item = (
  storeId: string,
  index: number,
  date: string,
): SyncedOrderItemInput => ({
  externalOrderId: `${storeId}-order-${index}`,
  externalProductOrderId: `${storeId}-item-${index}`,
  externalProductId: `${storeId}-product-${index % 10}`,
  rawProductName: `Synthetic product ${index % 10}`,
  rawOptionInfo: "Synthetic option",
  optionCode: `option-${index % 10}`,
  optionManageCode: `manage-${index % 10}`,
  quantity: 1,
  productPaymentAmount: 10_000,
  totalProductAmount: 10_000,
  deliveryFeeAmount: 0,
  paymentCommission: 100,
  knowledgeShoppingSellingInterlockCommission: 100,
  saleCommission: 0,
  channelCommission: 0,
  orderDate: date,
  paymentDate: date,
  orderDateTime: `${date}T00:00:00.000+09:00`,
  paymentDateTime: `${date}T00:00:00.000+09:00`,
  productOrderStatus: "PAYED",
  claimStatus: null,
  rawStatus: "PAYED",
  saleStatus: "SALE",
  packageNumber: `${storeId}-package-${index}`,
  rawPayload: null,
});

async function runScenario(itemsPerStore: number) {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(
    join(temporaryRoot, "patima-order-sync-benchmark-"),
  );
  assert.equal(dirname(resolve(directory)), temporaryRoot);
  const oldDataDir = process.env.DATA_DIR;
  const oldDatabaseUrl = process.env.DATABASE_URL;
  const oldFetch = globalThis.fetch;
  process.env.DATA_DIR = directory;
  delete process.env.DATABASE_URL;
  globalThis.fetch = async () => {
    throw new Error("BENCHMARK_NETWORK_FORBIDDEN");
  };
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const start = performance.now();
  const enqueueTimes: number[] = [];
  const statusTimes: number[] = [];
  const operationTimes: number[] = [];
  const scheduledStatusTimes: number[] = [];
  const batchHeapSamples: number[] = [];
  let readCurrentStatus: (() => void) | undefined;
  let sampleDueAt = performance.now() + 25;
  let maxHeap = 0;
  let maxRss = 0;
  const sampleMemory = () => {
    const usage = process.memoryUsage();
    maxHeap = Math.max(maxHeap, usage.heapUsed);
    maxRss = Math.max(maxRss, usage.rss);
  };
  const memoryTimer = setInterval(() => {
    sampleMemory();
    if (readCurrentStatus) {
      readCurrentStatus();
      scheduledStatusTimes.push(Math.max(0, performance.now() - sampleDueAt));
    }
    sampleDueAt = performance.now() + 25;
  }, 25);
  let database: DatabaseService | undefined;
  try {
    database = new DatabaseService();
    assert.equal(database.getStorageMode(), "file");
    await database.onModuleInit();
    await database.writeCommitted((draft) => {
      draft.stores = Array.from({ length: storeCount }, (_, index) =>
        createStore(index),
      );
    });
    const audit = new AuditLogService(database);
    const batches = new OrderSyncBatchService(database);
    const operations = new OperationService(database, audit, batches);
    const summaries = new ProfitSummaryService(database);
    const synced = new OrderSyncService(
      database,
      operations,
      audit,
      {
        getResolvedConfiguration: (storeId: string) => ({
          store: { id: storeId },
          credential: { source: "SYNTHETIC_BENCHMARK" },
        }),
        async *streamOrderItems(
          storeId: string,
          _from: string,
          to: string,
          options: OrderStreamOptions,
        ): AsyncGenerator<OrderStreamChunk> {
          await options.onProgress?.({
            stage: "FETCHING_ORDERS",
            queryKind: "PAYMENT",
            dateWindow: { from: to, to },
          });
          for (let offset = 0; offset < itemsPerStore; offset += 100) {
            options.signal?.throwIfAborted();
            const length = Math.min(100, itemsPerStore - offset);
            await options.onProgress?.({
              stage: "FETCHING_DETAILS",
              queryKind: "PAYMENT",
              page: offset / 100 + 1,
            });
            yield {
              items: Array.from({ length }, (_, index) =>
                item(storeId, offset + index, to),
              ),
              fetchedCount: offset + length,
              validatedCount: offset + length,
              warnings: [],
              checkpoint: {
                schemaVersion: 1,
                queryKind: "PAYMENT",
                windowFrom: to,
                windowTo: to,
                page: offset / 100 + 1,
              },
            };
          }
        },
      } as never,
      summaries,
      batches,
    );
    synced.onModuleInit();
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const enqueueStart = performance.now();
      const batch = await batches.enqueue({
        mode: "CURRENT",
        idempotencyKey: `synthetic-${itemsPerStore}-${repeat}`,
      });
      readCurrentStatus = () => {
        batches.get(batch.batchId);
      };
      enqueueTimes.push(performance.now() - enqueueStart);
      assert.equal(batch.counts.target, storeCount);
      for (let index = 0; index < storeCount; index += 1) {
        const operationStart = performance.now();
        const running = operations.pollOnce();
        const statusStart = performance.now();
        await database.assertStatusReadable();
        batches.get(batch.batchId);
        statusTimes.push(performance.now() - statusStart);
        assert.equal(await running, true);
        operationTimes.push(performance.now() - operationStart);
        sampleMemory();
      }
      const result = batches.get(batch.batchId);
      assert.equal(
        result.status,
        "SUCCEEDED",
        JSON.stringify(
          result.items.map((entry) => ({
            status: entry.status,
            error: entry.error,
          })),
        ),
      );
      assert.equal(result.counts.succeeded, storeCount);
      assert.equal(
        await operations.pollOnce(),
        false,
        "No permanent queue entries may remain",
      );
      const snapshot: DatabaseShape = database.getSnapshot();
      assert.equal(snapshot.orderItems.length, storeCount * itemsPerStore);
      assert.equal(snapshot.orders.length, storeCount * itemsPerStore);
      assert.equal(
        new Set(
          snapshot.orderItems.map(
            (entry) => `${entry.storeId}:${entry.externalProductOrderId}`,
          ),
        ).size,
        snapshot.orderItems.length,
      );
      assert.equal(
        snapshot.operations.filter((entry) => entry.status !== "SUCCEEDED")
          .length,
        0,
      );
      batchHeapSamples.push(process.memoryUsage().heapUsed);
      if ((repeat + 1) % 20 === 0)
        console.error(
          `Synthetic ${itemsPerStore} items/store: ${repeat + 1}/${repeats} batches completed`,
        );
      await new Promise<void>((done) => setImmediate(done));
    }
    await new Promise<void>((done) => setTimeout(done, 20));
    const snapshot: DatabaseShape = database.getSnapshot();
    const elapsed = performance.now() - start;
    return {
      itemsPerStore,
      stores: storeCount,
      repeatedBatches: repeats,
      successfulOperations: snapshot.operations.length,
      uniqueOrders: snapshot.orders.length,
      uniqueOrderItems: snapshot.orderItems.length,
      duplicateItems: 0,
      failedOperations: 0,
      pendingOperations: 0,
      elapsedSeconds: rounded(elapsed / 1000),
      enqueueP95Ms: rounded(percentile95(enqueueTimes)),
      statusP95Ms: rounded(percentile95(statusTimes)),
      scheduledStatusP95Ms: rounded(percentile95(scheduledStatusTimes)),
      scheduledStatusSamples: scheduledStatusTimes.length,
      operationP95Ms: rounded(percentile95(operationTimes)),
      peakHeapMiB: megabytes(maxHeap),
      peakRssMiB: megabytes(maxRss),
      earlyBatchHeapMedianMiB: megabytes(median(batchHeapSamples.slice(0, 20))),
      lateBatchHeapMedianMiB: megabytes(median(batchHeapSamples.slice(-20))),
      eventLoopMaxMs: rounded(lag.max / 1e6),
      eventLoopP95Ms: rounded(lag.percentile(95) / 1e6),
    };
  } finally {
    clearInterval(memoryTimer);
    lag.disable();
    await database?.onApplicationShutdown();
    globalThis.fetch = oldFetch;
    if (oldDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    // This path came only from mkdtemp under the OS temp directory, never from user data configuration.
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    assert.ok(
      directory.startsWith(join(temporaryRoot, "patima-order-sync-benchmark-")),
    );
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const results = [];
  for (const size of [100, 300]) results.push(await runScenario(size));
  const report = {
    recordedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    measurementConditions:
      "Active developer workstation; background workloads are not isolated or controlled.",
    hardware: {
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      totalRamMiB: megabytes(totalmem()),
    },
    scope:
      "Synthetic file-mode baseline at 1x=100 and 3x=300 items/store. Production DB size was not inspected. statusP95Ms is immediate service execution; scheduledStatusP95Ms includes lateness of a 25ms timer plus state lookup, not HTTP/proxy or Naver network. Real file persistence, worker execution, mapping and summary services are included. Repeated IDs test idempotence, not continuously growing order history. Early/late heap medians sample first/last 20 batches without forced GC, include retained operation/audit history, and do not prove absence of memory leaks.",
    results,
  };
  const json = JSON.stringify(report, null, 2);
  if (output) writeFileSync(resolve(output), `${json}\n`, "utf8");
  console.log(json);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
