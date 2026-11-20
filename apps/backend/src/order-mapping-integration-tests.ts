import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { CanonicalSalesUnit, DatabaseShape, Store } from "@patima/shared";
import { normalizeMatchAlias } from "@patima/shared";
import { AppModule } from "./app.module";
import { DatabaseService } from "./database.service";
import { NaverCommerceService, type SyncedOrderItemInput } from "./naver-commerce.service";
import { OperationWorkerService } from "./operation-worker.service";
import { OrderSyncService } from "./order-sync.service";
import { createEmptyDatabase } from "./helpers";

const storeId = "mapping-integration-store";
const timestamp = "2026-11-11T00:00:00.000Z";
const store: Store = {
  id: storeId, name: "Synthetic mapping store", platformType: "NAVER_SMARTSTORE",
  sellerAccountId: "synthetic-seller", channelNo: "synthetic-channel", isPrimary: true,
  isActive: true, deactivatedAt: null, memo: null, lastOrderSyncAt: null,
  lastOrderSyncStatus: "NEVER", credentialConnectionStatus: "NOT_TESTED",
  lastCredentialTestAt: null, deliveryUnitCost: 0, createdAt: timestamp, updatedAt: timestamp,
};
const unit = (id: string, suffix: string, group = false): CanonicalSalesUnit => ({
  id, storeId, displayName: `통합테스트 보호대${suffix}`, matchAliases: group ? ["통합테스트 보호대"] : [],
  normalizedMatchAliases: group ? [normalizeMatchAlias("통합테스트 보호대")] : [],
  linkedProductIds: [], linkedOptionCodes: [], linkedManageCodes: [], memo: null,
  isActive: true, deactivatedAt: null, isStoreLevel: false,
  parentSalesUnitId: group ? null : "integration-group", isGroup: group,
  createdAt: timestamp, updatedAt: timestamp,
});

/** Real Nest routes, order normalizer, sync commits and file storage; all source data is synthetic. */
export async function runOrderMappingIntegrationTests(): Promise<void> {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "patima-mapping-integration-"));
  assert.equal(dirname(resolve(directory)), temporaryRoot);
  const overrides: Record<string, string | undefined> = {
    DATABASE_URL: undefined, DATA_DIR: directory, NAVER_BOOTSTRAP_STORE: "false",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  // A test regression can never send a request to Naver or the configured operational database.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "127.0.0.1", "integration test network must remain local");
    return originalFetch(input, init);
  };
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    let expectedStoredMappings: Array<[string, string | null]> = [];
    let manualSignatureId = "";
    let manualConfirmedAt: string | null = null;
    for (let boot = 0; boot < 2; boot++) {
      const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
      try {
        await app.listen(0, "127.0.0.1");
        await app.get(OperationWorkerService).stop();
        const database = app.get(DatabaseService);
        assert.equal(database.getStorageMode(), "file");
        const base = await app.getUrl();
        const get = async (path: string) => {
          const response = await fetch(`${base}/api/v1/${path}`, { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 200);
          const result = await response.json();
          assert.equal(result.success, true);
          return result.data;
        };
        const readSaved = () => JSON.parse(readFileSync(join(directory, "database.json"), "utf8")) as DatabaseShape;
        const mappings = (snapshot: DatabaseShape): Array<[string, string | null]> => snapshot.orderItems
          .map((item): [string, string | null] => [item.externalProductOrderId, item.canonicalSalesUnitId])
          .sort(([left], [right]) => left.localeCompare(right));

        if (boot === 0) {
          await database.writeCommitted((draft) => {
            draft.stores = [store];
            draft.canonicalSalesUnits = [
              unit("integration-group", "", true), unit("single", " 단품"), unit("double", " 1+1"),
              unit("female-single", " 여성용 단품"), unit("female-double", " 여성용 1+1"),
            ];
          });
          const naver = app.get(NaverCommerceService);
          const normalize = (naver as unknown as {
            normalizeOrderDetail(...args: unknown[]): SyncedOrderItemInput;
          }).normalizeOrderDetail.bind(naver);
          const incoming = (id: string, option: string, name = "통합테스트 보호대", productId = "integration-listing") => normalize({
            productOrder: {
              productOrderId: id, productId, productName: name,
              productOption: option, quantity: 1, totalPaymentAmount: 10000, productOrderStatus: "PAYED",
            },
            order: { orderId: `order-${id}`, orderDate: timestamp, paymentDate: timestamp },
          }, undefined, { includeRawPayload: false });
          let entries = [
            incoming("single-order", "구성: 단품 / 색상: 검정"),
            incoming("double-order", "구성: 1+1 / 색상: 흰색"),
            incoming("female-order", "대상: 여성용 / 구성: 1+1"),
            incoming("opaque-order", "12345"),
          ];
          let chunks = [entries];
          naver.getResolvedConfiguration = () => ({ store, credential: {} as never });
          naver.streamOrderItems = (async function* () {
            for (const items of chunks)
              yield { items, fetchedCount: items.length, validatedCount: items.length, checkpoint: { schemaVersion: 1 } };
          }) as typeof naver.streamOrderItems;
          const synced = app.get(OrderSyncService);
          await synced.performSync(storeId, "2026-11-11", "2026-11-11", "MANUAL");
          const original = mappings(readSaved());
          assert.deepEqual(original, [
            ["double-order", "double"], ["female-order", "female-double"],
            ["opaque-order", null], ["single-order", "single"],
          ]);
          const beforeCounts = database.getSnapshot().orderSourceSignatures.map((signature) => [signature.id, signature.usageCount]);
          await synced.performSync(storeId, "2026-11-11", "2026-11-11", "MANUAL");
          assert.deepEqual(mappings(readSaved()), original, "resync must not duplicate or change orders");
          assert.deepEqual(database.getSnapshot().orderSourceSignatures.map((signature) => [signature.id, signature.usageCount]), beforeCounts);

          const single = database.getSnapshot().orderItems.find((item) => item.externalProductOrderId === "single-order")!;
          manualSignatureId = single.orderSourceSignatureId!;
          const confirmation = await fetch(`${base}/api/v1/order-source-signatures/${manualSignatureId}/mapping`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ canonicalSalesUnitId: "female-single" }), signal: AbortSignal.timeout(5000),
          });
          assert.equal(confirmation.status, 201);
          assert.equal((await confirmation.json()).success, true);
          manualConfirmedAt = database.getSnapshot().orderSourceSignatures.find((signature) => signature.id === manualSignatureId)!.confirmedAt;
          assert.ok(manualConfirmedAt);
          entries = [
            incoming("single-order", "구성: 단품 / 색상: 검정"),
            incoming("next-day-order", "구성: 1 + 1 / 색상: 녹색", "통합테스트 보호대 신상품 행사"),
          ];
          chunks = [entries];
          await synced.performSync(storeId, "2026-11-11", "2026-11-11", "MANUAL");
          expectedStoredMappings = [
            ["double-order", "double"], ["female-order", "female-double"],
            ["next-day-order", "double"], ["opaque-order", null], ["single-order", "female-single"],
          ];
          assert.deepEqual(mappings(readSaved()), expectedStoredMappings);
          chunks = [
            [incoming("late-missing-name", "구성: 단품 / 색상: 파랑", "NAVER_PRODUCT_integration-late-listing", "integration-late-listing")],
            [incoming("late-known-name", "구성: 단품 / 색상: 파랑", "통합테스트 보호대", "integration-late-listing")],
          ];
          await synced.performSync(storeId, "2026-11-11", "2026-11-11", "MANUAL");
          expectedStoredMappings.push(["late-known-name", "single"], ["late-missing-name", "single"]);
          expectedStoredMappings.sort(([left], [right]) => left.localeCompare(right));
          assert.deepEqual(mappings(readSaved()), expectedStoredMappings, "a later chunk must persist recovered mappings for earlier missing-name orders");
          console.log("PASS mapping integration: real sync commits persist variants, repeated sync is idempotent, and HTTP manual confirmation survives resync");
        } else {
          assert.deepEqual(mappings(database.getSnapshot()), expectedStoredMappings, "full app restart must preserve stored mappings");
          const manual = database.getSnapshot().orderSourceSignatures.find((signature) => signature.id === manualSignatureId)!;
          assert.equal(manual.canonicalSalesUnitId, "female-single");
          assert.equal(manual.confirmedAt, manualConfirmedAt);
        }

        const all = await get(`order-items?storeId=${storeId}&pageSize=100`);
        assert.equal(all.totalCount, 7);
        assert.equal(all.items.length, 7);
        const mapped = await get(`order-items?storeId=${storeId}&mappingStatus=MAPPED&pageSize=100`);
        assert.equal(mapped.totalCount, 6);
        assert.ok(mapped.items.every((item: { mappingStatus: string; displayName: string | null }) => item.mappingStatus === "MAPPED" && item.displayName));
        const unresolved = await get(`order-items?storeId=${storeId}&mappingStatus=CONFLICT&pageSize=100`);
        assert.equal(unresolved.totalCount, 1);
        assert.equal(unresolved.items[0].canonicalSalesUnitId, null);
        assert.equal(unresolved.items[0].rawOptionInfo, "12345", "pruned repeated text must be restored for HTTP display");
        const signatures = await get(`order-source-signatures?storeId=${storeId}&mappingStatus=MAPPED&pageSize=100`);
        assert.equal(signatures.totalCount, 5);
        assert.ok(signatures.items.every((signature: { canonicalSalesUnitId: string; canonicalDisplayName: string }) => signature.canonicalSalesUnitId !== "integration-group" && signature.canonicalDisplayName));
        if (boot === 1) console.log("PASS mapping integration: full app restart and HTTP order/signature filters preserve persisted mappings and unresolved evidence");
      } finally {
        await app.close();
      }
    }
    await verifyPostgresRecoveryScope();
    await verifyRestartedNameRecovery(join(directory, "restart-recovery"));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function verifyRestartedNameRecovery(directory: string): Promise<void> {
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  try {
    for (let boot = 0; boot < 3; boot++) {
      const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
      try {
        await app.listen(0, "127.0.0.1");
        await app.get(OperationWorkerService).stop();
        const database = app.get(DatabaseService);
        assert.equal(database.getStorageMode(), "file");
        if (boot === 0) {
          await database.writeCommitted((draft) => {
            draft.stores = [store];
            draft.canonicalSalesUnits = [unit("integration-group", "", true), unit("single", " 단품"), unit("double", " 1+1")];
          });
        } else {
          const earlier = database.getSnapshot().orderItems.find((item) => item.externalProductOrderId === "restart-missing")!;
          assert.ok(earlier, "the first day's missing-name order must survive a real app restart");
          assert.equal(earlier.canonicalSalesUnitId, boot === 1 ? null : "double");
        }
        if (boot < 2) {
          const naver = app.get(NaverCommerceService);
          const normalizer = naver as unknown as { normalizeOrderDetail(...args: unknown[]): SyncedOrderItemInput };
          const date = boot === 0 ? "2026-11-09" : "2026-11-10";
          const item = normalizer.normalizeOrderDetail({
            productOrder: {
              productOrderId: boot === 0 ? "restart-missing" : "restart-known", productId: "restart-listing",
              productName: boot === 0 ? undefined : "통합테스트 보호대", productOption: "구성: 1+1 / 색상: 흰색",
              quantity: 1, totalPaymentAmount: 10000, productOrderStatus: "PAYED",
            },
            order: { orderId: `restart-order-${boot}`, orderDate: `${date}T09:00:00+09:00`, paymentDate: `${date}T09:00:00+09:00` },
          }, undefined, { includeRawPayload: false });
          naver.getResolvedConfiguration = () => ({ store, credential: {} as never });
          naver.streamOrderItems = (async function* () {
            yield { items: [item], fetchedCount: 1, validatedCount: 1, checkpoint: { schemaVersion: 1 } };
          }) as typeof naver.streamOrderItems;
          const result = await app.get(OrderSyncService).performSync(storeId, date, date, "MANUAL");
          if (boot === 0) {
            assert.equal(database.getSnapshot().orderItems[0].canonicalSalesUnitId, null);
          } else {
            assert.deepEqual(result.affectedDates, ["2026-11-09", "2026-11-10"], "recovering a historical order must refresh both the old and new profit dates");
            const saved = JSON.parse(readFileSync(join(directory, "database.json"), "utf8")) as DatabaseShape;
            assert.equal(saved.orderItems.length, 2);
            assert.ok(saved.orderItems.every((row) => row.canonicalSalesUnitId === "double"), "both the historical recovery and new order must reach persisted storage");
            assert.ok(saved.dailySalesUnitProfits.some((row) => row.date === "2026-11-09" && row.childRows?.some((child) => child.canonicalSalesUnitId === "double" && child.totalQuantity === 1 && child.totalProductRevenue === 10000)), "the old day's profit aggregation must use the recovered product");
          }
        } else {
          const snapshot = database.getSnapshot();
          assert.equal(snapshot.orderItems.length, 2);
          assert.ok(snapshot.orderItems.every((row) => row.canonicalSalesUnitId === "double"));
          assert.ok(snapshot.dailySalesUnitProfits.some((row) => row.date === "2026-11-09" && row.childRows?.some((child) => child.canonicalSalesUnitId === "double" && child.totalQuantity === 1 && child.totalProductRevenue === 10000)));
        }
      } finally {
        await app.close();
      }
    }
    console.log("PASS mapping integration: next-day name recovery survives app restarts, persists historical orders and refreshes the old profit date");
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  }
}

async function verifyPostgresRecoveryScope(): Promise<void> {
  const initial = createEmptyDatabase();
  initial.stores.push(store);
  initial.canonicalSalesUnits.push(unit("integration-group", "", true), unit("single", " 단품"), unit("double", " 1+1"));
  let committed = new Map<string, Map<string, Record<string, unknown>>>();
  let transaction = new Map<string, Map<string, Record<string, unknown>>>();
  let commitNumber = 0;
  let failSecondCommit = true;
  const client = {
    release() {},
    async query(sql: string, values: unknown[] = []) {
      if (sql === "BEGIN") transaction = structuredClone(committed);
      if (sql === "COMMIT") {
        commitNumber += 1;
        if (failSecondCommit && commitNumber === 2) throw new Error("TEST_RECOVERY_COMMIT_FAILED");
        committed = transaction;
      }
      if (sql === "ROLLBACK") transaction = structuredClone(committed);
      const table = sql.match(/^INSERT INTO ([a-z_]+)/)?.[1];
      if (table) {
        const rows = transaction.get(table) ?? new Map();
        for (let index = 0; index < values.length; index += 3)
          rows.set(String(values[index]), JSON.parse(String(values[index + 1])));
        transaction.set(table, rows);
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const database = Object.assign(Object.create(DatabaseService.prototype), {
    database: initial, storageMode: "postgres", persistenceQueue: Promise.resolve(),
    pendingWriteCount: 0, lastPersistenceError: null, pool: { connect: async () => client },
  }) as DatabaseService;
  const normalizer = Object.create(NaverCommerceService.prototype) as {
    normalizeOrderDetail(...args: unknown[]): SyncedOrderItemInput;
  };
  const incoming = (id: string, name?: string) => normalizer.normalizeOrderDetail({
    productOrder: { productOrderId: id, productId: "pg-listing", productName: name,
      productOption: "구성: 1+1", quantity: 1, totalPaymentAmount: 10000, productOrderStatus: "PAYED" },
    order: { orderId: `pg-order-${id}`, orderDate: timestamp, paymentDate: timestamp },
  }, undefined, { includeRawPayload: false });
  const naver = {
    getResolvedConfiguration: () => ({ store, credential: {} }),
    async *streamOrderItems() {
      for (const item of [incoming("pg-missing"), incoming("pg-known", "통합테스트 보호대")])
        yield { items: [item], fetchedCount: 1, validatedCount: 1, checkpoint: { schemaVersion: 1 } };
    },
  };
  const service = new OrderSyncService(database, {} as never, {} as never, naver as unknown as NaverCommerceService);
  await assert.rejects(() => service.performSync(storeId, "2026-11-11", "2026-11-11", "MANUAL"), /TEST_RECOVERY_COMMIT_FAILED/);
  assert.equal(database.getSnapshot().orderItems.length, 1, "failed second chunk must not leak its new order into memory");
  assert.equal(database.getSnapshot().orderItems[0].canonicalSalesUnitId, null, "failed recovery must not mutate a prior committed row");
  assert.equal(committed.get("order_items")?.size, 1);
  assert.equal([...committed.get("order_items")!.values()][0].canonicalSalesUnitId, null);
  failSecondCommit = false;
  await service.performSync(storeId, "2026-11-11", "2026-11-11", "MANUAL");
  assert.equal(database.getSnapshot().orderItems.length, 2);
  const rows = [...committed.get("order_items")!.values()];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.canonicalSalesUnitId === "double"), "earlier chunk recovery must be included in actual PostgreSQL upsert payloads");
  assert.ok(database.getSnapshot().orderItems.every((row) => row.canonicalSalesUnitId === "double"));
  console.log("PASS mapping integration: PostgreSQL commit scope persists prior-chunk recovery and rolls back failed recovery without memory leakage");
}
