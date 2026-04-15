import assert from "node:assert/strict";
import { createSourceSignature, normalizeText } from "@patima/shared";
import * as XLSX from "xlsx";
import { evaluateAdMapping, getAdMappingOverride } from "./ad-mapping-engine";
import { AD_UPLOAD_REQUIRED_HEADERS, AdsService } from "./ads.service";
import {
  calculateDashboardSummary,
  calculateDailyProfitRows,
  calculateFee,
  createEmptyDatabase,
  getWeekdayNameKo,
  repairMojibakeText,
  saleStatusFromNaverOrderState,
  saleStatusFromRawStatus,
} from "./helpers";
import { NaverCommerceConfigService } from "./naver-commerce-config.service";
import { NaverCommerceService, createNaverClientSecretSign } from "./naver-commerce.service";
import { OrderMappingService } from "./order-mapping.service";
import { ProfitService } from "./profit.service";
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
    linkedProductIds: [],
    linkedOptionCodes: [],
    linkedManageCodes: [],
    memo: null,
    isActive: true,
    deactivatedAt: null,
    isStoreLevel: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

const createMemoryDatabaseService = (database = createEmptyDatabase()) => ({
  database,
  getSnapshot() {
    return JSON.parse(JSON.stringify(this.database));
  },
  write(mutator: (draft: typeof database) => unknown) {
    const draft = this.getSnapshot();
    const result = mutator(draft);
    this.database = draft;
    return result;
  },
});

const createAdsServiceHarness = () => {
  const databaseService = createMemoryDatabaseService();
  const adsService = new AdsService(
    databaseService as never,
    {
      ensureWritable: () => undefined,
    } as never,
    {
      registerRetryExecutor: () => undefined,
      enqueue: () => {
        throw new Error("enqueue not used in tests");
      },
    } as never,
    {
      record: () => null,
    } as never,
  );

  return { databaseService, adsService };
};

const createOrderMappingServiceHarness = () => {
  const databaseService = createMemoryDatabaseService();
  const enqueueCalls: Array<{ storeId: string; requestJson: Record<string, unknown> }> = [];
  const orderMappingService = new OrderMappingService(
    databaseService as never,
    {
      registerRetryExecutor: () => undefined,
      enqueue: (storeId: string, _operationType: string, requestJson: Record<string, unknown>) => {
        enqueueCalls.push({ storeId, requestJson });
        return { id: `operation-${enqueueCalls.length}` };
      },
    } as never,
    {
      ensureWritable: () => undefined,
    } as never,
    {
      create: () => {
        throw new Error("create not used in this test");
      },
    } as never,
  );

  return { databaseService, orderMappingService, enqueueCalls };
};

const createOrderSourceSignature = (id: string, productName: string, storeId = "store-1") =>
  ({
    id,
    storeId,
    rawProductNameSnapshot: productName,
    rawOptionInfoSnapshot: null,
    normalizedProductName: normalizeText(productName),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature(productName, null),
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED",
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

const createAdUploadFile = (
  reportDate: string,
  campaigns: Array<{ campaignId: string; campaignName: string; totalCost: number }>,
) => {
  const sheetRows: string[][] = [AD_UPLOAD_REQUIRED_HEADERS.map((value) => String(value))];

  campaigns.forEach((campaign) => {
    sheetRows.push([
      campaign.campaignId,
      campaign.campaignName,
      String(campaign.totalCost),
      "0",
      "0",
      "0",
      "0",
    ]);
    sheetRows.push([
      "",
      getWeekdayNameKo(reportDate),
      "",
      "",
      "",
      "",
      "",
    ]);
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheetRows), "Sheet1");

  return {
    originalname: `ads-${reportDate}.xlsx`,
    buffer: XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }),
  } as never;
};

const createConfirmedUploadRow = (params: {
  uploadId: string;
  reportDate: string;
  campaignId: string;
  campaignName: string;
  canonicalSalesUnitId: string | null;
  totalCost: number;
  mappingReason?: "RULE_MATCHED" | "MANUAL_MAPPED" | "NO_RULE" | "MULTIPLE_RULES" | "INTENTIONALLY_UNMAPPED";
}) =>
  ({
    id: `ad-${params.uploadId}-${params.campaignId}`,
    uploadId: params.uploadId,
    sourceUploadId: params.uploadId,
    storeId: "store-1",
    reportDate: params.reportDate,
    campaignId: params.campaignId,
    campaignName: params.campaignName,
    normalizedCampaignName: normalizeText(params.campaignName),
    weekday: getWeekdayNameKo(params.reportDate),
    adType: null,
    status: "ACTIVE",
    totalCost: params.totalCost,
    impressions: 0,
    clicks: 0,
    totalConversions: 0,
    totalConversionSales: 0,
    matchedRuleCount: params.canonicalSalesUnitId ? 1 : 0,
    canonicalSalesUnitId: params.canonicalSalesUnitId,
    mappingReason: params.mappingReason ?? (params.canonicalSalesUnitId ? "RULE_MATCHED" : "NO_RULE"),
    reasonNote: null,
    reasonNoteInherited: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

const createConfirmedUpload = (params: { uploadId: string; reportDate: string; isActive?: boolean }) =>
  ({
    id: params.uploadId,
    storeId: "store-1",
    sourceType: "NAVER_DA_XLSX",
    originalFileName: `${params.uploadId}.xlsx`,
    fileHash: `hash-${params.uploadId}`,
    reportDate: params.reportDate,
    detectedWeekday: getWeekdayNameKo(params.reportDate),
    weekdayValidationStatus: "PASSED",
    replacedUploadId: null,
    previewRuleSnapshotHash: null,
    previewOverrideSnapshotHash: null,
    previewCreatedAt: null,
    previewExpiresAt: null,
    state: "CONFIRMED",
    isActive: params.isActive ?? true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

run("normalizeText keeps prefixes and symbols while normalizing whitespace and case", () => {
  assert.equal(normalizeText("  [Fast Delivery]\nRunning Hat: BLACK  "), "[fast delivery] running hat: black");
});

run("getWeekdayNameKo resolves KST weekday correctly", () => {
  assert.equal(getWeekdayNameKo("2026-03-25"), "수요일");
});

run("repairMojibakeText repairs UTF-8 Korean file names decoded as latin1", () => {
  assert.equal(repairMojibakeText("ì¸í¼ëí°ìë¸.xlsx"), "인피니티서브.xlsx");
  assert.equal(repairMojibakeText("already-fine.xlsx"), "already-fine.xlsx");
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

run("NaverCommerceService prefers productOption over optionCode for readable option info", () => {
  const service = Object.create(NaverCommerceService.prototype) as NaverCommerceService;

  assert.equal(
    (service as any).buildOptionInfo(
      {
        productOption: "컬러: 옵션3.핑크베이지+핑크베이지 / 사이즈: M(32~35cm)",
        optionCode: "49765107855",
      },
      null,
      {},
    ),
    "컬러: 옵션3.핑크베이지+핑크베이지 / 사이즈: M(32~35cm)",
  );
});

run("NaverCommerceService omits optionCode when readable option fields are present", () => {
  const service = Object.create(NaverCommerceService.prototype) as NaverCommerceService;

  assert.equal(
    (service as any).buildOptionInfo(
      {
        optionName: "컬러",
        optionValue: "화이트",
        optionCode: "49765107855",
      },
      null,
      {},
    ),
    "컬러 / 화이트",
  );
});

run("NaverCommerceService falls back to optionCode when it is the only option field", () => {
  const service = Object.create(NaverCommerceService.prototype) as NaverCommerceService;

  assert.equal(
    (service as any).buildOptionInfo(
      {
        optionCode: "49765107855",
      },
      null,
      {},
    ),
    "49765107855",
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

run("OrderMappingService saveMappings deduplicates signatures and enqueues one recalculation", () => {
  const { databaseService, orderMappingService, enqueueCalls } = createOrderMappingServiceHarness();

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Diet Socks", ["diet socks"]));
    draft.orderSourceSignatures.push(
      createOrderSourceSignature("sig-1", "diet socks"),
      createOrderSourceSignature("sig-2", "diet socks black"),
    );
  });

  const result = orderMappingService.saveMappings(["sig-1", "sig-1", "sig-2"], {
    canonicalSalesUnitId: "sales-1",
  });
  const snapshot = databaseService.getSnapshot();
  const first = snapshot.orderSourceSignatures.find((item: { id: string }) => item.id === "sig-1");
  const second = snapshot.orderSourceSignatures.find((item: { id: string }) => item.id === "sig-2");

  assert.equal(result.data.updatedCount, 2);
  assert.equal(enqueueCalls.length, 1);
  assert.deepEqual(enqueueCalls[0]?.requestJson.signatureIds, ["sig-1", "sig-2"]);
  assert.equal(first?.canonicalSalesUnitId, "sales-1");
  assert.equal(second?.canonicalSalesUnitId, "sales-1");
  assert.equal(first?.mappingStatus, "MAPPED");
  assert.equal(second?.mappingStatus, "MAPPED");
});

run("OrderMappingService createAndMapMany skips order recalculation during sales-unit creation", () => {
  const databaseService = createMemoryDatabaseService();
  const createCalls: Array<{ options?: { skipOrderRecalculation?: boolean } }> = [];
  const orderMappingService = new OrderMappingService(
    databaseService as never,
    {
      registerRetryExecutor: () => undefined,
      enqueue: () => ({ id: "operation-1" }),
    } as never,
    {
      ensureWritable: () => undefined,
    } as never,
    {
      create: (payload: { displayName: string; matchAliases?: string[] | null }, options?: { skipOrderRecalculation?: boolean }) => {
        createCalls.push({ options });
        databaseService.write((draft) => {
          draft.canonicalSalesUnits.push(
            createSalesUnit("sales-created", payload.displayName, payload.matchAliases ?? []),
          );
        });
        return {
          data: {
            id: "sales-created",
          },
        };
      },
    } as never,
  );

  databaseService.write((draft) => {
    draft.orderSourceSignatures.push(createOrderSourceSignature("sig-create", "alpha pack"));
  });

  orderMappingService.createAndMapMany(["sig-create"], {
    displayName: "Alpha Pack",
    matchAliases: ["alpha pack"],
    memo: null,
  });

  assert.equal(createCalls[0]?.options?.skipOrderRecalculation, true);
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
      deliveryFeeAmount: 12,
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
      deliveryFeeAmount: 30,
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
  assert.equal(summary.totalProductRevenue, 100);
  assert.equal(summary.totalDeliveryFeeAmount, 12);
  assert.equal(summary.totalAdCost, 20);
  assert.equal(summary.conflictOrderItemCount, 1);
  assert.equal(summary.excludedConflictOrderRevenue, 50);
  assert.equal(summary.conflictCampaignCount, 1);
  assert.equal(summary.excludedConflictAdCost, 30);
});

run("profit rows keep delivery fee separate from product revenue and net profit", () => {
  const database = createEmptyDatabase();
  const date = "2026-04-02";

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
  database.orderSourceSignatures.push({
    id: "sig-1",
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
  } as never);
  database.orderItems.push({
    id: "order-1",
    storeId: "store-1",
    orderId: "record-1",
    orderSourceSignatureId: "sig-1",
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
    totalProductAmount: 100,
    deliveryFeeAmount: 20,
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
  } as never);

  const rows = calculateDailyProfitRows(database, "store-1", date, date);
  const summary = calculateDashboardSummary(database, "store-1", date);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalRevenue, 100);
  assert.equal(rows[0].totalProductRevenue, 100);
  assert.equal(rows[0].totalDeliveryFeeAmount, 20);
  assert.equal(rows[0].roughProfit, 100);
  assert.equal(rows[0].estimatedNetProfit, 75);
  assert.equal(summary.totalRevenue, 100);
  assert.equal(summary.totalProductRevenue, 100);
  assert.equal(summary.totalDeliveryFeeAmount, 20);
  assert.equal(summary.roughProfit, 100);
  assert.equal(summary.estimatedNetProfit, 75);
});

run("AdsService confirms two same-date uploads and sums ad cost across active confirmed uploads", () => {
  const { databaseService, adsService } = createAdsServiceHarness();
  const date = "2026-04-03";

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha", "beta"]));
  });

  const firstPreview = adsService.previewUpload(
    "store-1",
    date,
    createAdUploadFile(date, [{ campaignId: "cmp-1001", campaignName: "alpha launch", totalCost: 120 }]),
  );
  void adsService.performConfirm(firstPreview.data.uploadId);

  const secondPreview = adsService.previewUpload(
    "store-1",
    date,
    createAdUploadFile(date, [{ campaignId: "cmp-1002", campaignName: "beta launch", totalCost: 80 }]),
  );
  void adsService.performConfirm(secondPreview.data.uploadId);

  const snapshot = databaseService.getSnapshot();
  const activeConfirmedUploads = snapshot.adExcelUploads.filter(
    (item: { reportDate: string; isActive: boolean; state: string }) =>
      item.reportDate === date && item.isActive && item.state === "CONFIRMED",
  );
  const summary = calculateDashboardSummary(snapshot, "store-1", date);

  assert.equal(activeConfirmedUploads.length, 2);
  assert.equal(summary.totalAdCost, 200);
});

run("AdsService rejects preview when campaignId overlaps an active confirmed upload on the same date", () => {
  const { databaseService, adsService } = createAdsServiceHarness();
  const date = "2026-04-03";

  databaseService.write((draft) => {
    draft.adExcelUploads.push(createConfirmedUpload({ uploadId: "upload-existing", reportDate: date }));
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-existing",
        reportDate: date,
        campaignId: "cmp-dup",
        campaignName: "alpha launch",
        canonicalSalesUnitId: "sales-1",
        totalCost: 55,
      }),
    );
  });

  assert.throws(
    () =>
      adsService.previewUpload(
        "store-1",
        date,
        createAdUploadFile(date, [{ campaignId: "cmp-dup", campaignName: "beta launch", totalCost: 30 }]),
      ),
    (error: unknown) =>
      error instanceof Error &&
      "getResponse" in error &&
      JSON.stringify((error as { getResponse: () => unknown }).getResponse()).includes(
        "AD_UPLOAD_DUPLICATE_WITH_ACTIVE_UPLOAD",
      ),
  );
});

run("AdsService rejects preview when the new file contains duplicate campaignIds", () => {
  const { adsService } = createAdsServiceHarness();
  const date = "2026-04-03";

  assert.throws(
    () =>
      adsService.previewUpload(
        "store-1",
        date,
        createAdUploadFile(date, [
          { campaignId: "cmp-dup", campaignName: "alpha launch", totalCost: 30 },
          { campaignId: "cmp-dup", campaignName: "beta launch", totalCost: 40 },
        ]),
      ),
    (error: unknown) =>
      error instanceof Error &&
      "getResponse" in error &&
      JSON.stringify((error as { getResponse: () => unknown }).getResponse()).includes("AD_UPLOAD_DUPLICATE_IN_FILE"),
  );
});

run("ProfitService detail and summary include only active confirmed uploads", () => {
  const databaseService = createMemoryDatabaseService();
  const profitService = new ProfitService(databaseService as never);
  const date = "2026-04-03";

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.adExcelUploads.push(
      createConfirmedUpload({ uploadId: "upload-active", reportDate: date, isActive: true }),
      createConfirmedUpload({ uploadId: "upload-inactive", reportDate: date, isActive: false }),
    );
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-active",
        reportDate: date,
        campaignId: "cmp-1001",
        campaignName: "alpha launch",
        canonicalSalesUnitId: "sales-1",
        totalCost: 20,
      }),
      createConfirmedUploadRow({
        uploadId: "upload-inactive",
        reportDate: date,
        campaignId: "cmp-1002",
        campaignName: "alpha old",
        canonicalSalesUnitId: "sales-1",
        totalCost: 999,
      }),
    );
  });

  const summary = calculateDashboardSummary(databaseService.getSnapshot(), "store-1", date);
  const detail = profitService.getDailySalesUnitDetail("store-1", "sales-1", date);

  assert.equal(summary.totalAdCost, 20);
  assert.equal(detail.data.summary.totalAdCost, 20);
  assert.equal(detail.data.deliveryFeeSummary.totalDeliveryFeeAmount, 0);
  assert.equal(detail.data.adCampaigns.length, 1);
  assert.equal(detail.data.adCampaigns[0].adCostId, "ad-upload-active-cmp-1001");
});

run("ProfitService keeps delivery fee references separate from product revenue and net profit", () => {
  const databaseService = createMemoryDatabaseService();
  const profitService = new ProfitService(databaseService as never);
  const date = "2026-04-02";

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.salesUnitCostSettings.push({
      id: "cost-1",
      storeId: "store-1",
      canonicalSalesUnitId: "sales-1",
      unitCost: 0,
      feeRate: 0,
      otherCost: 0,
      isActive: true,
      deactivatedAt: null,
      effectiveFrom: date,
      effectiveTo: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    draft.orderItems.push({
      id: "order-item-1",
      storeId: "store-1",
      orderId: "record-1",
      orderSourceSignatureId: null,
      canonicalSalesUnitId: "sales-1",
      externalProductOrderId: "external-1",
      externalProductId: null,
      packageNumber: null,
      rawProductName: "alpha",
      rawOptionInfo: null,
      normalizedProductName: normalizeText("alpha"),
      normalizedOptionInfo: "",
      sourceSignature: createSourceSignature("alpha", null),
      quantity: 1,
      productPaymentAmount: 100,
      totalProductAmount: 100,
      deliveryFeeAmount: 30,
      paymentCommission: 0,
      knowledgeShoppingSellingInterlockCommission: 0,
      saleCommission: 0,
      channelCommission: 0,
      orderDate: date,
      paymentDate: date,
      saleStatus: "SALE",
      orderStatus: "DELIVERED",
      isCanceled: false,
      isReturned: false,
      rawPayload: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
  });

  const summary = calculateDashboardSummary(databaseService.getSnapshot(), "store-1", date);
  const detail = profitService.getDailySalesUnitDetail("store-1", "sales-1", date);

  assert.equal(summary.totalRevenue, 100);
  assert.equal(summary.totalProductRevenue, 100);
  assert.equal(summary.totalDeliveryFeeAmount, 30);
  assert.equal(summary.roughProfit, 100);
  assert.equal(summary.estimatedNetProfit, 100);
  assert.equal(detail.data.summary.totalRevenue, 100);
  assert.equal(detail.data.summary.totalProductRevenue, 100);
  assert.equal(detail.data.summary.totalDeliveryFeeAmount, 30);
  assert.equal(detail.data.deliveryFeeSummary.totalDeliveryFeeAmount, 30);
  assert.equal(detail.data.deliveryFeeSummary.includedInProductRevenue, false);
  assert.equal(detail.data.deliveryFeeSummary.includedInEstimatedNetProfit, false);
});

run("ProfitService latest activity date prefers latest overlap even over later eligible orders and ads", () => {
  const databaseService = createMemoryDatabaseService();
  const profitService = new ProfitService(databaseService as never);

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.orderItems.push({
      id: "order-overlap",
      storeId: "store-1",
      paymentDate: "2026-04-04",
      saleStatus: "SALE",
      canonicalSalesUnitId: "sales-1",
    } as never);
    draft.orderItems.push({
      id: "order-latest-eligible",
      storeId: "store-1",
      paymentDate: "2026-04-05",
      saleStatus: "SALE",
      canonicalSalesUnitId: "sales-1",
    } as never);
    draft.adExcelUploads.push(
      createConfirmedUpload({ uploadId: "upload-overlap", reportDate: "2026-04-04" }),
      createConfirmedUpload({ uploadId: "upload-latest-ad", reportDate: "2026-04-06" }),
    );
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-overlap",
        reportDate: "2026-04-04",
        campaignId: "cmp-overlap",
        campaignName: "overlap campaign",
        canonicalSalesUnitId: "sales-1",
        totalCost: 10,
      }),
      createConfirmedUploadRow({
        uploadId: "upload-latest-ad",
        reportDate: "2026-04-06",
        campaignId: "cmp-latest-ad",
        campaignName: "latest ad campaign",
        canonicalSalesUnitId: "sales-1",
        totalCost: 10,
      }),
    );
  });

  const latestDate = profitService.getLatestActivityDate("store-1");
  assert.equal(latestDate.data.latestOrderDate, "2026-04-05");
  assert.equal(latestDate.data.latestAdDate, "2026-04-06");
  assert.equal(latestDate.data.latestOverlapDate, "2026-04-04");
  assert.equal(latestDate.data.date, "2026-04-04");
});

run("ProfitService latest activity date ignores ineligible latest orders and falls back to the latest eligible order", () => {
  const databaseService = createMemoryDatabaseService();
  const profitService = new ProfitService(databaseService as never);

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.orderItems.push(
      {
        id: "order-eligible",
        storeId: "store-1",
        paymentDate: "2026-04-03",
        saleStatus: "SALE",
        canonicalSalesUnitId: "sales-1",
      } as never,
      {
        id: "order-canceled",
        storeId: "store-1",
        paymentDate: "2026-04-06",
        saleStatus: "CANCELED",
        canonicalSalesUnitId: "sales-1",
      } as never,
      {
        id: "order-unmapped",
        storeId: "store-1",
        paymentDate: "2026-04-05",
        saleStatus: "SALE",
        canonicalSalesUnitId: null,
      } as never,
    );
    draft.adExcelUploads.push(createConfirmedUpload({ uploadId: "upload-no-overlap", reportDate: "2026-04-04" }));
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-no-overlap",
        reportDate: "2026-04-04",
        campaignId: "cmp-no-overlap",
        campaignName: "no overlap campaign",
        canonicalSalesUnitId: "sales-1",
        totalCost: 25,
      }),
    );
  });

  const latestDate = profitService.getLatestActivityDate("store-1");
  assert.equal(latestDate.data.latestOrderDate, "2026-04-03");
  assert.equal(latestDate.data.latestAdDate, "2026-04-04");
  assert.equal(latestDate.data.latestOverlapDate, null);
  assert.equal(latestDate.data.date, "2026-04-03");
});

run("ProfitService latest activity date falls back to the latest ad date when no eligible orders exist", () => {
  const databaseService = createMemoryDatabaseService();
  const profitService = new ProfitService(databaseService as never);

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.orderItems.push(
      {
        id: "order-canceled-only",
        storeId: "store-1",
        paymentDate: "2026-04-05",
        saleStatus: "CANCELED",
        canonicalSalesUnitId: "sales-1",
      } as never,
      {
        id: "order-without-sales-unit-only",
        storeId: "store-1",
        paymentDate: "2026-04-04",
        saleStatus: "SALE",
        canonicalSalesUnitId: null,
      } as never,
    );
    draft.adExcelUploads.push(createConfirmedUpload({ uploadId: "upload-ad-only", reportDate: "2026-04-06" }));
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-ad-only",
        reportDate: "2026-04-06",
        campaignId: "cmp-ad-only",
        campaignName: "ad only campaign",
        canonicalSalesUnitId: "sales-1",
        totalCost: 30,
      }),
    );
  });

  const latestDate = profitService.getLatestActivityDate("store-1");
  assert.equal(latestDate.data.latestOrderDate, null);
  assert.equal(latestDate.data.latestAdDate, "2026-04-06");
  assert.equal(latestDate.data.latestOverlapDate, null);
  assert.equal(latestDate.data.date, "2026-04-06");
});

run("AdsService deleteUpload deactivates the upload and removes related ad rows", () => {
  const { databaseService, adsService } = createAdsServiceHarness();
  const date = "2026-04-03";

  databaseService.write((draft) => {
    draft.adExcelUploads.push(createConfirmedUpload({ uploadId: "upload-delete", reportDate: date, isActive: true }));
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-delete",
        reportDate: date,
        campaignId: "cmp-delete",
        campaignName: "duplicate launch",
        canonicalSalesUnitId: "sales-1",
        totalCost: 45,
      }),
    );
  });

  const result = adsService.deleteUpload("upload-delete");
  const snapshot = databaseService.getSnapshot();
  const upload = snapshot.adExcelUploads.find((item: { id: string }) => item.id === "upload-delete");

  assert.equal(result.data.uploadId, "upload-delete");
  assert.equal(result.data.previousState, "CONFIRMED");
  assert.equal(result.data.adCostCount, 1);
  assert.equal(upload?.state, "DELETED");
  assert.equal(upload?.isActive, false);
  assert.equal(snapshot.adCampaignDailyCosts.some((item: { sourceUploadId: string }) => item.sourceUploadId === "upload-delete"), false);
  assert.equal(calculateDashboardSummary(snapshot, "store-1", date).totalAdCost, 0);
});

run("AdsService saveManualMappings applies one sales unit to multiple rows", () => {
  const { databaseService, adsService } = createAdsServiceHarness();

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-1",
        reportDate: "2026-04-03",
        campaignId: "cmp-1",
        campaignName: "alpha launch",
        canonicalSalesUnitId: null,
        totalCost: 120,
      }),
      createConfirmedUploadRow({
        uploadId: "upload-2",
        reportDate: "2026-04-03",
        campaignId: "cmp-2",
        campaignName: "alpha retarget",
        canonicalSalesUnitId: null,
        totalCost: 80,
      }),
    );
  });

  const result = adsService.saveManualMappings(
    ["ad-upload-1-cmp-1", "ad-upload-2-cmp-2"],
    { canonicalSalesUnitId: "sales-1" },
  );
  const snapshot = databaseService.getSnapshot();

  assert.equal(result.data.updatedCount, 2);
  snapshot.adCampaignDailyCosts.forEach((item: any) => {
    assert.equal(item.canonicalSalesUnitId, "sales-1");
    assert.equal(item.mappingReason, "MANUAL_MAPPED");
    assert.equal(item.matchedRuleCount, 0);
    assert.equal(item.reasonNote, null);
    assert.equal(item.reasonNoteInherited, false);
  });
});

run("AdsService saveManualMappings rejects inactive sales units", () => {
  const { databaseService, adsService } = createAdsServiceHarness();
  const inactiveSalesUnit = createSalesUnit("sales-1", "Alpha Unit", ["alpha"]) as Record<string, unknown>;

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(
      {
        ...inactiveSalesUnit,
        isActive: false,
        deactivatedAt: new Date().toISOString(),
      } as never,
    );
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-5",
        reportDate: "2026-04-03",
        campaignId: "cmp-5",
        campaignName: "alpha launch",
        canonicalSalesUnitId: null,
        totalCost: 20,
      }),
    );
  });

  assert.throws(
    () =>
      adsService.saveManualMappings(["ad-upload-5-cmp-5"], {
        canonicalSalesUnitId: "sales-1",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "getResponse" in error &&
      JSON.stringify((error as { getResponse: () => unknown }).getResponse()).includes("비활성화된 판매단위"),
  );
});

run("AdsService setIntentionalUnmappedMany applies one note to multiple rows", () => {
  const { databaseService, adsService } = createAdsServiceHarness();

  databaseService.write((draft) => {
    draft.adCampaignDailyCosts.push(
      createConfirmedUploadRow({
        uploadId: "upload-3",
        reportDate: "2026-04-03",
        campaignId: "cmp-3",
        campaignName: "beta launch",
        canonicalSalesUnitId: "sales-1",
        totalCost: 50,
      }),
      createConfirmedUploadRow({
        uploadId: "upload-4",
        reportDate: "2026-04-03",
        campaignId: "cmp-4",
        campaignName: "beta retention",
        canonicalSalesUnitId: "sales-1",
        totalCost: 40,
      }),
    );
  });

  const result = adsService.setIntentionalUnmappedMany(
    ["ad-upload-3-cmp-3", "ad-upload-4-cmp-4"],
    { reasonNote: "merged into brand spend" },
  );
  const snapshot = databaseService.getSnapshot();

  assert.equal(result.data.updatedCount, 2);
  snapshot.adCampaignDailyCosts.forEach((item: any) => {
    assert.equal(item.canonicalSalesUnitId, null);
    assert.equal(item.mappingReason, "INTENTIONALLY_UNMAPPED");
    assert.equal(item.reasonNote, "merged into brand spend");
    assert.equal(item.reasonNoteInherited, false);
  });
});

console.log("All backend checks passed.");
