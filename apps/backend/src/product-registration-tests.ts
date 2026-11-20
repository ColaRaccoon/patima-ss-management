import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { OrderItem, OrderSourceSignature, Store } from "@patima/shared";
import { AppModule } from "./app.module";
import { DatabaseService } from "./database.service";
import { OperationWorkerService } from "./operation-worker.service";
import { ProductRegistrationService } from "./product-registration.service";

export async function runProductRegistrationTests() {
  const directory = mkdtempSync(join(tmpdir(), "patima-product-registration-"));
  const previous = { DATABASE_URL: process.env.DATABASE_URL, DATA_DIR: process.env.DATA_DIR, NAVER_BOOTSTRAP_STORE: process.env.NAVER_BOOTSTRAP_STORE };
  delete process.env.DATABASE_URL;
  process.env.DATA_DIR = directory;
  process.env.NAVER_BOOTSTRAP_STORE = "false";
  const stamp = "2026-10-01T00:00:00.000Z";
  const store: Store = {
    id: "store", name: "테스트", platformType: "NAVER_SMARTSTORE", sellerAccountId: "test", channelNo: "test",
    isPrimary: true, isActive: true, deactivatedAt: null, memo: null, lastOrderSyncAt: null,
    lastOrderSyncStatus: "NEVER", credentialConnectionStatus: "NOT_TESTED", lastCredentialTestAt: null,
    deliveryUnitCost: 0, createdAt: stamp, updatedAt: stamp,
  };
  const signature: OrderSourceSignature = {
    id: "signature", storeId: store.id, sourceSignature: "테스트 상품 / 단품",
    rawProductNameSnapshot: "테스트 상품", rawOptionInfoSnapshot: "단품",
    normalizedProductName: "테스트 상품", normalizedOptionInfo: "단품", canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED", confirmedAt: null, usageCount: 1, firstSeenAt: stamp, lastSeenAt: stamp,
    sampleExternalProductId: null, sampleOptionCode: null, sampleOptionManageCode: null,
    lastAutoMappedAt: null, mappingRuleHash: null, createdAt: stamp, updatedAt: stamp,
  };
  const item: OrderItem = {
    id: "item", orderId: "order", storeId: store.id, productId: null, orderSourceSignatureId: signature.id,
    canonicalSalesUnitId: null, externalProductOrderId: "order-item", externalProductId: null,
    optionCode: null, packageNumber: null, quantity: 1, productPaymentAmount: 1000, totalProductAmount: 1000,
    deliveryFeeAmount: 0, paymentCommission: 0, knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null, channelCommission: null, orderDate: "2026-10-01", paymentDate: "2026-10-01",
    saleStatus: "SALE", orderStatus: "PAYED", isCanceled: false, isReturned: false, rawPayload: null,
    createdAt: stamp, updatedAt: stamp,
  };

  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  try {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await app.init();
    await app.get(OperationWorkerService).stop();
    const database = app.get(DatabaseService);
    assert.equal(database.getStorageMode(), "file");
    await database.writeCommitted((draft) => {
      draft.stores.push(store, { ...store, id: "other-store", isPrimary: false });
      draft.orderSourceSignatures.push(signature, { ...signature, id: "other-signature", storeId: "other-store" });
      draft.orderItems.push(item);
    });
    const registration = app.get(ProductRegistrationService);
    const request = {
      requestId: randomUUID(),
      storeId: store.id,
      displayName: "테스트 상품",
      matchAliases: ["테스트 상품"],
      effectiveFrom: "2026-10-01",
      configurations: [
        { name: "단품", unitCost: 0, orderSignatureIds: [signature.id] },
        { name: "1+1", unitCost: 450, otherCost: 30, feeRate: 0.04, effectiveFrom: "2026-10-02" },
      ],
    };
    await assert.rejects(registration.register({
      ...request,
      configurations: [request.configurations[0], { ...request.configurations[1], name: "단품" }],
    }), /이미 사용 중인 판매단위 이름/);
    await assert.rejects(registration.register({
      ...request,
      configurations: [request.configurations[0], { ...request.configurations[1], orderSignatureIds: ["other-signature"] }],
    }), /같은 스토어/);
    assert.equal(database.getSnapshot().canonicalSalesUnits.length, 0);
    assert.equal(database.getSnapshot().salesUnitCostSettings.length, 0);
    assert.equal(database.getSnapshot().orderSourceSignatures[0].confirmedAt, null);
    assert.equal(database.getSnapshot().auditLogs.length, 0);

    const [first, repeated] = await Promise.all([registration.register(request), registration.register(request)]);
    assert.deepEqual(first.data, repeated.data);
    assert.equal(first.data.recalculationPending, false);
    const [single, bundle] = first.data.configurations;
    const snapshot = database.getSnapshot();
    assert.deepEqual(snapshot.canonicalSalesUnits.map((unit) => [unit.id, unit.parentSalesUnitId, unit.isGroup]), [
      [first.data.salesUnitId, null, true],
      [single.salesUnitId, first.data.salesUnitId, false],
      [bundle.salesUnitId, first.data.salesUnitId, false],
    ]);
    assert.deepEqual(snapshot.salesUnitCostSettings.map((cost) => [cost.id, cost.unitCost, cost.effectiveFrom]), [
      [single.costSettingId, 0, "2026-10-01"],
      [bundle.costSettingId, 450, "2026-10-02"],
    ]);
    assert.equal(snapshot.orderItems[0].canonicalSalesUnitId, single.salesUnitId);
    assert.equal(snapshot.orderSourceSignatures[0].canonicalSalesUnitId, single.salesUnitId);
    assert.ok(snapshot.orderSourceSignatures[0].confirmedAt);
    assert.equal(snapshot.auditLogs.length, 1);
    await assert.rejects(registration.register({ ...request, displayName: "다른 상품" }), /이미 사용된 상품 등록 요청/);
    await assert.rejects(registration.register({
      ...request, requestId: randomUUID(), displayName: "재연결 시도", matchAliases: [], configurations: [request.configurations[0]],
    }), /이미 수동으로 연결된 주문/);
    const incomplete = await registration.register({
      ...request, requestId: randomUUID(), displayName: "출시 예정", matchAliases: [], configurations: [{ unitCost: null }],
    });
    assert.equal(incomplete.data.configurations[0].salesUnitId, incomplete.data.salesUnitId);
    assert.equal(incomplete.data.configurations[0].costSettingId, null);
    assert.equal(database.getSnapshot().salesUnitCostSettings.length, 2);

    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const baseline = database.getSnapshot();
    const postgres = new DatabaseService();
    Object.assign(postgres, {
      storageMode: "postgres",
      database: baseline,
      acquirePostgresClient: async () => ({
        query: async (sql: string, values: unknown[] = []) => statements.push({ sql, values }),
        release() {},
      }),
    });
    await postgres.commitProductRegistration(store.id, (draft) => {
      draft.orderItems[0].canonicalSalesUnitId = bundle.salesUnitId;
      draft.salesUnitCostSettings.push({ ...draft.salesUnitCostSettings[0], id: "additional-cost" });
    });
    assert.equal(baseline.orderItems[0].canonicalSalesUnitId, single.salesUnitId);
    assert.equal(postgres.getSnapshot().orderItems[0].canonicalSalesUnitId, bundle.salesUnitId);
    assert.equal(statements[0]?.sql, "BEGIN");
    assert.equal(statements.at(-1)?.sql, "COMMIT");
    assert.deepEqual(statements.slice(2, -1).map(({ sql, values }) => [sql.trim().split(/\s+/).slice(0, 3).join(" "), values[0]]), [
      ["INSERT INTO order_items", item.id],
      ["INSERT INTO sales_unit_cost_settings", "additional-cost"],
    ]);

    const edit = registration.readEdit(store.id, single.salesUnitId, "2026-10-05").data;
    assert.deepEqual(edit.configurations.map((row) => [row.name, row.cost?.unitCost, row.canChangeExistingCost]), [
      ["단품", 0, false], ["1+1", 450, true],
    ]);
    assert.equal(edit.effectiveFrom, request.effectiveFrom);
    const patch = {
      ...edit,
      storeId: store.id,
      displayName: "테스트 상품 리뉴얼",
      matchAliases: edit.product.matchAliases,
      configurations: edit.configurations.map((row) => ({
        ...row,
        linkedManageCodes: row.id === bundle.salesUnitId ? ["MANAGE-BUNDLE"] : [],
        cost: row.id === single.salesUnitId ? { unitCost: 125, otherCost: 10, feeRate: 0.015, effectiveFrom: "2026-10-01" } : undefined,
      })),
    };
    await assert.rejects(registration.saveEdit(edit.product.id, patch), /기존 적용일보다 늦은 날짜/);
    assert.equal(database.getSnapshot().canonicalSalesUnits.find((row) => row.id === edit.product.id)?.displayName, request.displayName);
    patch.configurations[0].cost!.effectiveFrom = "2026-10-06";
    await registration.saveEdit(edit.product.id, patch);
    assert.equal(registration.readEdit(store.id, edit.product.id, "2026-10-05").data.configurations[0].cost?.unitCost, 0);
    const updated = registration.readEdit(store.id, edit.product.id, "2026-10-06").data;
    assert.equal(updated.product.displayName, "테스트 상품 리뉴얼");
    assert.equal(updated.configurations[0].cost?.unitCost, 125);
    assert.deepEqual(updated.configurations[1].linkedManageCodes, ["MANAGE-BUNDLE"]);
    assert.equal(database.getSnapshot().orderSourceSignatures[0].canonicalSalesUnitId, single.salesUnitId);
    await assert.rejects(registration.saveEdit(edit.product.id, patch), /저장된 값이 바뀌었습니다/);
  } finally {
    await app?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
