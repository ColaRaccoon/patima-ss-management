import assert from "node:assert/strict";
import { createSourceSignature, normalizeText } from "@patima/shared";
import { evaluateAdMapping, getAdMappingOverride } from "./ad-mapping-engine";
import {
  calculateDashboardSummary,
  calculateFee,
  createEmptyDatabase,
  getWeekdayNameKo,
  saleStatusFromNaverOrderState,
  saleStatusFromRawStatus,
} from "./helpers";
import { NaverCommerceConfigService } from "./naver-commerce-config.service";
import { createNaverClientSecretSign } from "./naver-commerce.service";
import { recalculateOrderMappingsForStore, resolveOrderSignatureAutoMapping } from "./sales-unit-auto-mapper";

const run = (name: string, fn: () => void) => {
  fn();
  console.log(`PASS ${name}`);
};

const createSalesUnit = (id: string, displayName: string, matchAliases: string[]) =>
  ({
    id,
    storeId: "store-1",
    displayName,
    matchAliases,
    normalizedMatchAliases: matchAliases.map((alias) => alias.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase()),
    memo: null,
    isActive: true,
    deactivatedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

run("normalizeText keeps prefixes and symbols while normalizing whitespace and case", () => {
  assert.equal(normalizeText("  [Fast Delivery]\nRunning Hat: BLACK  "), "[fast delivery] running hat: black");
});

run("getWeekdayNameKo resolves KST weekday correctly", () => {
  assert.equal(getWeekdayNameKo("2026-03-25"), "수요일");
});

run("saleStatusFromRawStatus maps cancel request correctly", () => {
  assert.equal(saleStatusFromRawStatus("CANCEL_REQUEST"), "CANCEL_REQUESTED");
});

run("saleStatusFromNaverOrderState prioritizes claim status over product order status", () => {
  assert.equal(saleStatusFromNaverOrderState("PAYED", "RETURN_REQUEST"), "RETURNED");
});

run("createNaverClientSecretSign produces a base64 bcrypt signature", () => {
  const signature = createNaverClientSecretSign(
    "aaaabbbbcccc",
    "$2a$04$abcdefghijklmnopqrstuv",
    "1643961623299",
  );
  assert.equal(
    signature,
    "JDJhJDA0JGFiY2RlZmdoaWprbG1ub3BxcnN0dXV6NDlObEtMdDYyUWhPdnNjSTNNWnR4ZUlDQjNoYUpD",
  );
});

run("NaverCommerceConfigService resolves matching env credentials", () => {
  const original = {
    NAVER_CLIENT_ID: process.env.NAVER_CLIENT_ID,
    NAVER_CLIENT_SECRET: process.env.NAVER_CLIENT_SECRET,
    NAVER_ACCOUNT_UID: process.env.NAVER_ACCOUNT_UID,
    NAVER_CHANNEL_NO: process.env.NAVER_CHANNEL_NO,
    NAVER_SOLUTION_ID: process.env.NAVER_SOLUTION_ID,
    NAVER_CALLBACK_URL: process.env.NAVER_CALLBACK_URL,
  };

  process.env.NAVER_CLIENT_ID = "env-client-id";
  process.env.NAVER_CLIENT_SECRET = "env-client-secret";
  process.env.NAVER_ACCOUNT_UID = "env-account";
  process.env.NAVER_CHANNEL_NO = "1001";
  process.env.NAVER_SOLUTION_ID = "sol-1";
  process.env.NAVER_CALLBACK_URL = "https://example.com/naver/callback";

  const service = new NaverCommerceConfigService();
  const resolved = service.getEnvCredentialForStore({
    sellerAccountId: "env-account",
    channelNo: "1001",
  } as never);

  assert.equal(resolved?.clientId, "env-client-id");
  assert.equal(resolved?.accountUid, "env-account");
  assert.equal(resolved?.channelNo, "1001");
  assert.equal(resolved?.solutionId, "sol-1");

  Object.entries(original).forEach(([key, value]) => {
    if (value == null) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  });
});

run("calculateFee falls back to feeRate only when both API fees are null", () => {
  const result = calculateFee(
    {
      paymentCommission: null,
      knowledgeShoppingSellingInterlockCommission: null,
      productPaymentAmount: 10000,
    } as never,
    {
      feeRate: 0.035,
    } as never,
  );
  assert.equal(result.totalFeeCost, 350);
  assert.equal(result.usedFallback, true);
  assert.equal(result.incomplete, false);
});

run("getAdMappingOverride returns manual mapped rows as overrides", () => {
  assert.deepEqual(
    getAdMappingOverride({
      canonicalSalesUnitId: "sales-1",
      mappingReason: "MANUAL_MAPPED",
      reasonNote: null,
    } as never),
    {
      type: "MANUAL_MAPPED",
      canonicalSalesUnitId: "sales-1",
    },
  );
});

run("evaluateAdMapping preserves manual overrides ahead of rule matching", () => {
  const database = createEmptyDatabase();
  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Hat", ["runninghat"]));
  database.campaignMappings.push({
    id: "mapping-1",
    storeId: "store-1",
    canonicalSalesUnitId: "sales-2",
    normalizedCampaignPattern: "alpha",
    isActive: true,
  } as never);

  const result = evaluateAdMapping(database, "store-1", "alpha campaign", {
    type: "MANUAL_MAPPED",
    canonicalSalesUnitId: "sales-1",
  });

  assert.equal(result.canonicalSalesUnitId, "sales-1");
  assert.equal(result.mappingReason, "MANUAL_MAPPED");
  assert.equal(result.matchedRuleCount, 0);
});

run("resolveOrderSignatureAutoMapping matches an order by alias", () => {
  const salesUnits = [createSalesUnit("sales-1", "Pretty Display Name", ["dietsocks", "diet socks"])];

  const result = resolveOrderSignatureAutoMapping(salesUnits, {
    normalizedProductName: normalizeText("diet socks"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("diet socks", null),
  } as never);

  assert.equal(result.canonicalSalesUnitId, "sales-1");
  assert.equal(result.ambiguous, false);
});

run("resolveOrderSignatureAutoMapping ignores displayName when aliases are empty", () => {
  const salesUnits = [createSalesUnit("sales-1", "diet socks", [])];

  const result = resolveOrderSignatureAutoMapping(salesUnits, {
    normalizedProductName: normalizeText("diet socks"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("diet socks", null),
  } as never);

  assert.equal(result.canonicalSalesUnitId, null);
  assert.equal(result.ambiguous, false);
});

run("recalculateOrderMappingsForStore marks ambiguous alias matches as conflict", () => {
  const database = createEmptyDatabase();
  database.canonicalSalesUnits.push(
    createSalesUnit("sales-1", "Diet Socks A", ["diet"]),
    createSalesUnit("sales-2", "Diet Socks B", ["diet"]),
  );
  database.orderSourceSignatures.push({
    id: "signature-1",
    storeId: "store-1",
    rawProductNameSnapshot: "diet special socks",
    rawOptionInfoSnapshot: null,
    normalizedProductName: normalizeText("diet special socks"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("diet special socks", null),
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED",
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.orderItems.push({
    id: "order-item-1",
    storeId: "store-1",
    orderId: "order-1",
    orderSourceSignatureId: "signature-1",
    canonicalSalesUnitId: null,
    externalProductOrderId: "external-1",
    externalProductId: null,
    packageNumber: null,
    rawProductName: "diet special socks",
    rawOptionInfo: null,
    normalizedProductName: normalizeText("diet special socks"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("diet special socks", null),
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: null,
    deliveryFeeAmount: null,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: "2026-04-01",
    paymentDate: "2026-04-01",
    saleStatus: "SALE",
    orderStatus: "DELIVERED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);

  recalculateOrderMappingsForStore(database, "store-1");

  assert.equal(database.orderSourceSignatures[0].mappingStatus, "CONFLICT");
  assert.equal(database.orderSourceSignatures[0].canonicalSalesUnitId, null);
  assert.equal(database.orderItems[0].canonicalSalesUnitId, null);
});

run("evaluateAdMapping falls back to alias matching without a campaign rule", () => {
  const database = createEmptyDatabase();
  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Display Only", ["kneebrace"]));

  const result = evaluateAdMapping(database, "store-1", normalizeText("best knee-brace campaign"));

  assert.equal(result.canonicalSalesUnitId, "sales-1");
  assert.equal(result.mappingReason, "RULE_MATCHED");
});

run("evaluateAdMapping returns conflict when multiple aliases match", () => {
  const database = createEmptyDatabase();
  database.canonicalSalesUnits.push(
    createSalesUnit("sales-1", "Campaign A", ["diet"]),
    createSalesUnit("sales-2", "Campaign B", ["diet"]),
  );

  const result = evaluateAdMapping(database, "store-1", normalizeText("diet launch campaign"));

  assert.equal(result.canonicalSalesUnitId, null);
  assert.equal(result.mappingReason, "MULTIPLE_RULES");
});

run("calculateDashboardSummary excludes conflict order revenue and conflict ad cost from totals", () => {
  const database = createEmptyDatabase();
  const date = "2026-04-01";

  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Diet Socks", ["dietsocks"]));
  database.salesUnitCostSettings.push({
    id: "cost-1",
    storeId: "store-1",
    canonicalSalesUnitId: "sales-1",
    unitCost: 10,
    feeRate: 0.1,
    otherCost: 5,
    isActive: true,
    deactivatedAt: null,
    effectiveFrom: date,
    effectiveTo: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.orderSourceSignatures.push(
    {
      id: "sig-mapped",
      storeId: "store-1",
      sourceSignature: createSourceSignature("diet socks", null),
      rawProductNameSnapshot: "diet socks",
      rawOptionInfoSnapshot: null,
      normalizedProductName: normalizeText("diet socks"),
      normalizedOptionInfo: "",
      canonicalSalesUnitId: "sales-1",
      mappingStatus: "MAPPED",
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    {
      id: "sig-conflict",
      storeId: "store-1",
      sourceSignature: createSourceSignature("diet", null),
      rawProductNameSnapshot: "diet",
      rawOptionInfoSnapshot: null,
      normalizedProductName: normalizeText("diet"),
      normalizedOptionInfo: "",
      canonicalSalesUnitId: null,
      mappingStatus: "CONFLICT",
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  );
  database.orderItems.push(
    {
      id: "order-1",
      storeId: "store-1",
      orderId: "record-1",
      orderSourceSignatureId: "sig-mapped",
      canonicalSalesUnitId: "sales-1",
      externalProductOrderId: "external-1",
      externalProductId: null,
      packageNumber: null,
      rawProductName: "diet socks",
      rawOptionInfo: null,
      normalizedProductName: normalizeText("diet socks"),
      normalizedOptionInfo: "",
      sourceSignature: createSourceSignature("diet socks", null),
      quantity: 1,
      productPaymentAmount: 100,
      totalProductAmount: null,
      deliveryFeeAmount: null,
      paymentCommission: null,
      knowledgeShoppingSellingInterlockCommission: null,
      saleCommission: null,
      channelCommission: null,
      orderDate: date,
      paymentDate: date,
      saleStatus: "SALE",
      orderStatus: "DELIVERED",
      isCanceled: false,
      isReturned: false,
      rawPayload: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    {
      id: "order-2",
      storeId: "store-1",
      orderId: "record-2",
      orderSourceSignatureId: "sig-conflict",
      canonicalSalesUnitId: null,
      externalProductOrderId: "external-2",
      externalProductId: null,
      packageNumber: null,
      rawProductName: "diet",
      rawOptionInfo: null,
      normalizedProductName: normalizeText("diet"),
      normalizedOptionInfo: "",
      sourceSignature: createSourceSignature("diet", null),
      quantity: 1,
      productPaymentAmount: 50,
      totalProductAmount: null,
      deliveryFeeAmount: null,
      paymentCommission: null,
      knowledgeShoppingSellingInterlockCommission: null,
      saleCommission: null,
      channelCommission: null,
      orderDate: date,
      paymentDate: date,
      saleStatus: "SALE",
      orderStatus: "DELIVERED",
      isCanceled: false,
      isReturned: false,
      rawPayload: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  );
  database.adExcelUploads.push({
    id: "upload-1",
    storeId: "store-1",
    isActive: true,
    weekdayValidationStatus: "PASSED",
    state: "CONFIRMED",
  } as never);
  database.adCampaignDailyCosts.push(
    {
      id: "ad-1",
      storeId: "store-1",
      sourceUploadId: "upload-1",
      reportDate: date,
      campaignName: "diet socks launch",
      normalizedCampaignName: normalizeText("diet socks launch"),
      totalCost: 20,
      canonicalSalesUnitId: "sales-1",
      mappingReason: "RULE_MATCHED",
      matchedRuleCount: 1,
      reasonNote: null,
      reasonNoteInherited: false,
    } as never,
    {
      id: "ad-2",
      storeId: "store-1",
      sourceUploadId: "upload-1",
      reportDate: date,
      campaignName: "diet launch",
      normalizedCampaignName: normalizeText("diet launch"),
      totalCost: 30,
      canonicalSalesUnitId: null,
      mappingReason: "MULTIPLE_RULES",
      matchedRuleCount: 2,
      reasonNote: null,
      reasonNoteInherited: false,
    } as never,
  );

  const summary = calculateDashboardSummary(database, "store-1", date);

  assert.equal(summary.totalRevenue, 100);
  assert.equal(summary.totalAdCost, 20);
  assert.equal(summary.conflictOrderItemCount, 1);
  assert.equal(summary.excludedConflictOrderRevenue, 50);
  assert.equal(summary.conflictCampaignCount, 1);
  assert.equal(summary.excludedConflictAdCost, 30);
});

console.log("All backend checks passed.");
