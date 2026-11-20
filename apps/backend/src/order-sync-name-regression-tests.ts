import assert from "node:assert/strict";
import type {
  CanonicalSalesUnit,
  DatabaseShape,
  Product,
} from "@patima/shared";
import { normalizeMatchAlias, normalizeText } from "@patima/shared";
import { DatabaseService } from "./database.service";
import { createEmptyDatabase } from "./helpers";
import {
  NaverCommerceService,
  type SyncedOrderItemInput,
} from "./naver-commerce.service";
import { OrderSyncService } from "./order-sync.service";

const storeId = "name-test-store";
const productId = "name-test-product";
const unit = (id: string, alias: string): CanonicalSalesUnit => ({
  id,
  storeId,
  displayName: alias,
  matchAliases: [alias],
  normalizedMatchAliases: [normalizeMatchAlias(alias)],
  linkedProductIds: [],
  linkedOptionCodes: [],
  linkedManageCodes: [],
  memo: null,
  isActive: true,
  deactivatedAt: null,
  isStoreLevel: false,
  parentSalesUnitId: null,
  isGroup: false,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
});
const product = (productName: string): Product => ({
  id: "name-test-product-record",
  storeId,
  externalProductId: productId,
  productName,
  normalizedProductName: normalizeText(productName),
  status: "PAYED",
  firstSeenAt: "2026-11-01T00:00:00Z",
  lastSeenAt: "2026-11-01T00:00:00Z",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
});
const createHarness = (cachedName?: string) => {
  let data = createEmptyDatabase();
  data.stores.push({ id: storeId, isActive: true } as never);
  data.canonicalSalesUnits.push(
    unit("insole", "러닝깔창"),
    unit("main", "메인신발"),
    unit("manual", "수동지정상품"),
  );
  if (cachedName) data.products.push(product(cachedName));
  const scopes: Set<string>[] = [];
  const database = {
    getSnapshot: () => data,
    async commitOrderSync<T>(
      mutator: (draft: DatabaseShape) => T,
      _fence?: unknown,
      _store?: string,
      scope?: { itemIds: Set<string> },
    ) {
      if (scope) scopes.push(new Set(scope.itemIds));
      const draft = structuredClone(data);
      const result = mutator(draft);
      if (scope) {
        for (const item of draft.orderItems) {
          const previous = data.orderItems.find((row) => row.id === item.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(item)) {
            assert.ok(
              scope.itemIds.has(item.externalProductOrderId),
              "changed items must be in the commit scope",
            );
          }
        }
      }
      data = draft;
      return result;
    },
  };
  let incoming: SyncedOrderItemInput[][] = [];
  // Use the real detail normalizer, while the stream and credentials remain entirely synthetic.
  const normalizer = Object.create(NaverCommerceService.prototype) as any;
  const naver = {
    getResolvedConfiguration: () => ({}),
    async *streamOrderItems() {
      let count = 0;
      for (const items of incoming) {
        count += items.length;
        yield {
          items,
          fetchedCount: count,
          validatedCount: count,
          checkpoint: { schemaVersion: 1 },
        };
      }
    },
  };
  const service = new OrderSyncService(
    database as unknown as DatabaseService,
    {} as never,
    {} as never,
    naver as unknown as NaverCommerceService,
  );
  const syncChunks = async (
    chunks: Array<
      Array<{
        id: string;
        date: string;
        name?: string;
        option?: string;
        externalProductId?: string;
      }>
    >,
  ) => {
    incoming = chunks.map((chunk) =>
      chunk.map(({ id, date, name, option, externalProductId }) =>
        normalizer.normalizeOrderDetail(
          {
            productOrder: {
              productOrderId: id,
              productId: externalProductId ?? productId,
              productName: name,
              productOption: option ?? "사이즈: M",
              quantity: 1,
              totalPaymentAmount: 10000,
              productOrderStatus: "PAYED",
            },
            order: {
              orderId: `order-${id}`,
              orderDate: `${date}T10:00:00+09:00`,
              paymentDate: `${date}T10:00:00+09:00`,
            },
          },
          undefined,
          { includeRawPayload: false },
        ),
      ),
    );
    const original = structuredClone(incoming);
    const date = chunks[0][0].date;
    const result = await service.performSync(storeId, date, date, "MANUAL");
    assert.deepEqual(
      incoming,
      original,
      "normalizer input must not be mutated",
    );
    return result;
  };
  return {
    data: () => data,
    scopes,
    syncChunks,
    async sync(
      id: string,
      date: string,
      options: { name?: string; option?: string } = {},
    ) {
      await syncChunks([[{ id, date, ...options }]]);
      return data.orderItems.find((row) => row.externalProductOrderId === id)!;
    },
  };
};

export async function runOrderSyncNameRegressionTests() {
  const known = createHarness("러닝깔창");
  const first = await known.sync("name-day-1", "2026-11-09");
  const second = await known.sync("name-day-2", "2026-11-10");
  assert.equal(first.canonicalSalesUnitId, "insole");
  assert.equal(second.canonicalSalesUnitId, "insole");
  assert.equal(known.data().products[0].productName, "러닝깔창");
  assert.equal(known.data().orderSourceSignatures.length, 1);
  assert.equal(
    known.data().orderSourceSignatures[0].rawProductNameSnapshot,
    "러닝깔창",
  );
  assert.equal(known.data().orderSourceSignatures[0].usageCount, 2);
  console.log(
    "PASS order sync names: missing daily product names reuse the known product and signature",
  );

  const unknown = createHarness();
  assert.equal(
    (await unknown.sync("unknown-1", "2026-11-09")).canonicalSalesUnitId,
    null,
  );
  assert.equal(
    (await unknown.sync("unknown-2", "2026-11-10")).canonicalSalesUnitId,
    null,
  );
  assert.equal(unknown.data().orderSourceSignatures.length, 2);
  assert.ok(
    unknown
      .data()
      .orderSourceSignatures.every((row) =>
        row.rawProductNameSnapshot.startsWith("NAVER_PRODUCT_"),
      ),
  );
  console.log(
    "PASS order sync names: absent product evidence remains unmapped",
  );

  const bundled = createHarness("메인신발");
  const explicit = await bundled.sync("bundle-explicit", "2026-11-10", {
    option: "[함께배송⭐추가할인]러닝깔창: L",
  });
  assert.equal(explicit.canonicalSalesUnitId, "insole");
  assert.equal(
    bundled.data().orderSourceSignatures[0].rawProductNameSnapshot,
    "러닝깔창",
  );
  assert.equal(bundled.data().products[0].productName, "메인신발");
  for (const [index, option] of [
    "[함께배송]사이즈: L",
    "[함께배송]옵션선택: 블랙",
    "[함께배송]색상: 블랙",
  ].entries()) {
    const item = await bundled.sync(`bundle-ambiguous-${index}`, "2026-11-10", {
      option,
    });
    assert.equal(item.canonicalSalesUnitId, null);
    assert.ok(
      bundled
        .data()
        .orderSourceSignatures.find(
          (row) => row.id === item.orderSourceSignatureId,
        )!
        .rawProductNameSnapshot.startsWith("NAVER_PRODUCT_"),
    );
  }
  assert.equal(bundled.data().products[0].productName, "메인신발");
  console.log(
    "PASS order sync names: bundle labels restore only explicit names without borrowing the main name",
  );

  const bundleFirst = createHarness();
  await bundleFirst.sync("first-bundle", "2026-11-09", {
    option: "[함께배송]러닝깔창: L",
  });
  assert.ok(
    bundleFirst.data().products[0].productName.startsWith("NAVER_PRODUCT_"),
  );
  assert.equal(
    (await bundleFirst.sync("later-main", "2026-11-10")).canonicalSalesUnitId,
    null,
  );
  console.log(
    "PASS order sync names: bundle-first imports do not create false main product names",
  );

  const confirmed = createHarness();
  await confirmed.sync("confirmed-item", "2026-11-10");
  const signature = confirmed.data().orderSourceSignatures[0];
  signature.confirmedAt = "2026-11-10T03:00:00Z";
  signature.canonicalSalesUnitId = "manual";
  signature.mappingStatus = "MAPPED";
  confirmed.data().products[0].productName = "러닝깔창";
  confirmed.data().products[0].normalizedProductName = "러닝깔창";
  const resynced = await confirmed.sync("confirmed-item", "2026-11-10");
  assert.equal(resynced.canonicalSalesUnitId, "manual");
  assert.equal(resynced.orderSourceSignatureId, signature.id);
  assert.equal(confirmed.data().orderSourceSignatures.length, 1);
  assert.equal(
    confirmed.data().orderSourceSignatures[0].confirmedAt,
    signature.confirmedAt,
  );
  assert.equal(confirmed.data().products[0].productName, "러닝깔창");
  console.log(
    "PASS order sync names: explicit manual confirmations survive name restoration on resync",
  );

  const invalidConfirmation = createHarness();
  await invalidConfirmation.sync("invalid-confirmed-item", "2026-11-09");
  invalidConfirmation.data().orderSourceSignatures[0].confirmedAt =
    "2026-11-09T03:00:00Z";
  await invalidConfirmation.sync(
    "actual-name-after-invalid-confirmation",
    "2026-11-10",
    { name: "러닝깔창" },
  );
  assert.equal(
    invalidConfirmation
      .data()
      .orderItems.find(
        (item) => item.externalProductOrderId === "invalid-confirmed-item",
      )!.canonicalSalesUnitId,
    "insole",
    "a confirmation flag without a selected product must not block recovery",
  );

  const renamed = createHarness("러닝깔창");
  await renamed.sync("confirmed-renamed-item", "2026-11-10", {
    name: "러닝깔창",
  });
  const renamedSignature = renamed.data().orderSourceSignatures[0];
  renamedSignature.confirmedAt = "2026-11-10T03:00:00Z";
  renamedSignature.canonicalSalesUnitId = "manual";
  renamedSignature.mappingStatus = "MAPPED";
  renamed.data().products[0].productName = "새실제상품";
  renamed.data().products[0].normalizedProductName = "새실제상품";
  const renamedItem = await renamed.sync(
    "confirmed-renamed-item",
    "2026-11-10",
  );
  assert.equal(renamedItem.canonicalSalesUnitId, "manual");
  assert.equal(renamedItem.orderSourceSignatureId, renamedSignature.id);
  assert.equal(renamed.data().products[0].productName, "새실제상품");
  console.log(
    "PASS order sync names: missing names retain the existing manual choice after catalog renames",
  );

  const existing = known.data().orderSourceSignatures[0];
  existing.normalizedProductName = "old-name";
  existing.normalizedOptionInfo = "old-option";
  await known.sync("name-day-2", "2026-11-10");
  assert.equal(
    known.data().orderSourceSignatures[0].normalizedProductName,
    "러닝깔창",
  );
  assert.equal(
    known.data().orderSourceSignatures[0].normalizedOptionInfo,
    "사이즈: m",
  );
  await known.sync("actual-new-name", "2026-11-11", { name: "실제변경상품" });
  assert.equal(known.data().products[0].productName, "실제변경상품");
  assert.equal(
    known.data().orderSourceSignatures.at(-1)!.rawProductNameSnapshot,
    "실제변경상품",
  );
  console.log(
    "PASS order sync names: existing normalized fields refresh and real incoming names take precedence",
  );

  for (const splitChunks of [false, true]) {
    for (const knownFirst of [false, true]) {
      const ordered = createHarness();
      const missingInput = { id: "ordered-missing", date: "2026-11-10" };
      const namedInput = {
        id: "ordered-known",
        date: "2026-11-10",
        name: "러닝깔창",
      };
      const inputs = knownFirst
        ? [namedInput, missingInput]
        : [missingInput, namedInput];
      const chunks = splitChunks ? inputs.map((input) => [input]) : [inputs];
      const result = await ordered.syncChunks(chunks);
      assert.equal(result.syncedItemCount, 2);
      assert.equal(
        result.orderItemsUpserted,
        2,
        "recovery must not inflate the fetched order count",
      );
      assert.equal(ordered.data().orders.length, 2);
      assert.equal(ordered.data().orderItems.length, 2);
      assert.ok(
        ordered
          .data()
          .orderItems.every((item) => item.canonicalSalesUnitId === "insole"),
      );
      assert.equal(
        new Set(
          ordered.data().orderItems.map((item) => item.orderSourceSignatureId),
        ).size,
        1,
      );
      assert.equal(
        ordered.data().orderSourceSignatures.find((row) => row.usageCount === 2)
          ?.rawProductNameSnapshot,
        "러닝깔창",
      );
      assert.equal(
        ordered
          .data()
          .orderItems.reduce((sum, item) => sum + item.productPaymentAmount, 0),
        20000,
      );
      if (splitChunks && !knownFirst)
        assert.ok(ordered.scopes.at(-1)!.has("ordered-missing"));
      await ordered.syncChunks(chunks);
      assert.equal(ordered.data().orderItems.length, 2);
      assert.equal(
        ordered
          .data()
          .orderSourceSignatures.reduce(
            (sum, row) => sum + (row.usageCount ?? 0),
            0,
          ),
        2,
      );
      assert.ok(
        ordered
          .data()
          .orderItems.every((item) => item.canonicalSalesUnitId === "insole"),
      );
    }
  }
  console.log(
    "PASS order sync names: name recovery is independent of order and chunk boundaries and stays idempotent",
  );

  const laterRun = createHarness();
  await laterRun.sync("historical-missing", "2026-11-09");
  await laterRun.syncChunks([
    [
      {
        id: "unrelated-missing",
        date: "2026-11-09",
        externalProductId: "another-product",
      },
    ],
  ]);
  const recoveryResult = await laterRun.syncChunks([
    [
      {
        id: "next-day-name",
        date: "2026-11-10",
        name: "러닝깔창",
      },
    ],
  ]);
  assert.equal(
    laterRun
      .data()
      .orderItems.find(
        (item) => item.externalProductOrderId === "historical-missing",
      )!.canonicalSalesUnitId,
    "insole",
  );
  assert.equal(
    laterRun
      .data()
      .orderItems.find(
        (item) => item.externalProductOrderId === "unrelated-missing",
      )!.canonicalSalesUnitId,
    null,
  );
  assert.deepEqual(recoveryResult.affectedDates, ["2026-11-09", "2026-11-10"]);
  assert.ok(laterRun.scopes.at(-1)!.has("historical-missing"));
  assert.ok(!laterRun.scopes.at(-1)!.has("unrelated-missing"));
  console.log(
    "PASS order sync names: later runs recover earlier missing names and refresh their payment dates only for the related product",
  );

  const protectedHistory = createHarness();
  const manualItem = await protectedHistory.sync(
    "historical-manual",
    "2026-11-09",
  );
  const manualSignature = protectedHistory.data().orderSourceSignatures[0];
  manualSignature.confirmedAt = "2026-11-09T03:00:00Z";
  manualSignature.canonicalSalesUnitId = "manual";
  manualSignature.mappingStatus = "MAPPED";
  manualItem.canonicalSalesUnitId = "manual";
  await protectedHistory.sync("historical-bundle", "2026-11-09", {
    option: "[함께배송]사이즈: L",
  });
  await protectedHistory.sync("later-named-main", "2026-11-10", {
    name: "러닝깔창",
  });
  assert.equal(
    protectedHistory
      .data()
      .orderItems.find(
        (item) => item.externalProductOrderId === "historical-manual",
      )!.canonicalSalesUnitId,
    "manual",
  );
  assert.equal(
    protectedHistory
      .data()
      .orderItems.find(
        (item) => item.externalProductOrderId === "historical-bundle",
      )!.canonicalSalesUnitId,
    null,
  );
  assert.ok(!protectedHistory.scopes.at(-1)!.has("historical-manual"));
  assert.ok(!protectedHistory.scopes.at(-1)!.has("historical-bundle"));
  const changedBundle = createHarness();
  await changedBundle.syncChunks([
    [{ id: "changed-to-bundle", date: "2026-11-10" }],
    [
      {
        id: "changed-to-bundle",
        date: "2026-11-10",
        option: "[함께배송]사이즈: L",
      },
    ],
    [{ id: "real-main", date: "2026-11-10", name: "러닝깔창" }],
  ]);
  assert.equal(
    changedBundle
      .data()
      .orderItems.find(
        (item) => item.externalProductOrderId === "changed-to-bundle",
      )!.canonicalSalesUnitId,
    null,
  );
  console.log(
    "PASS order sync names: delayed recovery preserves manual and bundled orders including changed bundle options",
  );

  for (const name of ["비니", "양말"]) {
    const shortName = createHarness(name);
    shortName.data().canonicalSalesUnits.push(unit("short-name", name));
    assert.equal(
      (await shortName.sync("short-name-item", "2026-11-10"))
        .canonicalSalesUnitId,
      "short-name",
    );
    assert.equal(shortName.data().products[0].productName, name);
    assert.equal(
      (
        await shortName.sync("short-name-bundle", "2026-11-10", {
          option: `[함께배송]${name}: 블랙`,
        })
      ).canonicalSalesUnitId,
      "short-name",
    );
  }
  for (const label of ["M", "XL", "사이즈", "옵션", "123"]) {
    const invalidName = createHarness(label);
    assert.equal(
      (await invalidName.sync("invalid-name-item", "2026-11-10"))
        .canonicalSalesUnitId,
      null,
    );
    assert.ok(
      invalidName
        .data()
        .orderSourceSignatures[0].rawProductNameSnapshot.startsWith(
          "NAVER_PRODUCT_",
        ),
    );
  }
  console.log(
    "PASS order sync names: short real product names are retained while size and option labels cannot restore names",
  );
}
