import assert from "node:assert/strict";
import { createSourceSignature, normalizeText, DEFAULT_DELIVERY_UNIT_COST } from "@patima/shared";
import * as XLSX from "xlsx";
import {
  evaluateAdMapping,
  getAdMappingOverride,
  recalculateAdCampaignSignaturesForStore,
} from "./ad-mapping-engine";
import { AD_UPLOAD_REQUIRED_HEADERS, AdsService } from "./ads.service";
import { DatabaseService } from "./database.service";
import { FakePurchaseService } from "./fake-purchase.service";
import {
  calculateDashboardSummary,
  calculateDailyProfitRows,
  calculateFee,
  calculateStoreDeliverySummary,
  calculateVatAmount,
  calculateVatAdjustedRevenue,
  createEmptyDatabase,
  getSignatureIndex,
  getWeekdayNameKo,
  repairMojibakeText,
  resolvePackageKey,
  saleStatusFromNaverOrderState,
  saleStatusFromRawStatus,
} from "./helpers";
import { NaverCommerceConfigService } from "./naver-commerce-config.service";
import { NaverCommerceService, createNaverClientSecretSign } from "./naver-commerce.service";
import { OrderMappingService } from "./order-mapping.service";
import { OrderSyncService } from "./order-sync.service";
import { OperationService } from "./operation.service";
import { ProfitService } from "./profit.service";
import {
  recalculateOrderMappingsForStore,
  recalculateOrderMappingsForTouchedItems,
  resolveOrderSignatureAutoMapping,
} from "./sales-unit-auto-mapper";
import { isMeaningfulName, extractNameFromOptionInfo, enrichSignatureDisplayName } from "./signature-enrichment";

const run = (name: string, fn: () => void) => {
  fn();
  console.log(`PASS ${name}`);
};

const pendingAsyncTests: Promise<void>[] = [];
const runAsync = (name: string, fn: () => Promise<void>) => {
  pendingAsyncTests.push(
    fn().then(() => {
      console.log(`PASS ${name}`);
    }),
  );
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

const createFakePurchaseServiceHarness = () => {
  const databaseService = createMemoryDatabaseService();
  const auditCalls: Array<Record<string, unknown>> = [];
  const fakePurchaseService = new FakePurchaseService(
    databaseService as never,
    {
      ensureWritable: (storeId: string) => {
        const exists = databaseService
          .getSnapshot()
          .stores.some((store: { id: string }) => store.id === storeId);
        if (!exists) {
          throw new Error("STORE_NOT_FOUND");
        }
      },
    } as never,
    {
      record: (params: Record<string, unknown>) => {
        auditCalls.push(params);
        return params;
      },
    } as never,
  );

  databaseService.write((draft) => {
    draft.stores.push({
      id: "store-1",
      name: "Main Store",
      platformType: "NAVER_SMARTSTORE",
      sellerAccountId: "seller-1",
      channelNo: "channel-1",
      isPrimary: true,
      isActive: true,
      deactivatedAt: null,
      memo: null,
      lastOrderSyncAt: null,
      lastOrderSyncStatus: "NEVER",
      credentialConnectionStatus: "NOT_TESTED",
      lastCredentialTestAt: null,
      deliveryUnitCost: DEFAULT_DELIVERY_UNIT_COST,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  return { databaseService, fakePurchaseService, auditCalls };
};

const createStoreRecord = (id: string, name: string, isActive = true) =>
  ({
    id,
    name,
    platformType: "NAVER_SMARTSTORE",
    sellerAccountId: `seller-${id}`,
    channelNo: `channel-${id}`,
    isPrimary: id === "store-live",
    isActive,
    deactivatedAt: isActive ? null : new Date().toISOString(),
    memo: null,
    lastOrderSyncAt: null,
    lastOrderSyncStatus: "NEVER",
    credentialConnectionStatus: "NOT_TESTED",
    lastCredentialTestAt: null,
    deliveryUnitCost: DEFAULT_DELIVERY_UNIT_COST,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as never;

const createOrderSyncServiceHarness = (params?: {
  stores?: ReturnType<typeof createStoreRecord>[];
  configuredStoreIds?: string[];
  inFlightStoreIds?: string[];
}) => {
  const databaseService = createMemoryDatabaseService();
  const enqueueCalls: Array<{
    storeId: string;
    operationType: string;
    requestJson: Record<string, unknown>;
  }> = [];
  const retryExecutors = new Map<string, (operation: Record<string, unknown>) => unknown>();
  const configuredStoreIds = new Set(params?.configuredStoreIds ?? ["store-live"]);
  const inFlightStoreIds = new Set(params?.inFlightStoreIds ?? []);

  databaseService.write((draft) => {
    draft.stores.push(
      ...(params?.stores ?? [
        createStoreRecord("store-live", "Live Store"),
        createStoreRecord("store-missing", "Missing Credential Store"),
        createStoreRecord("store-inactive", "Inactive Store", false),
      ]),
    );
  });

  const operationService = {
    registerRetryExecutor: (
      operationType: string,
      executor: (operation: Record<string, unknown>) => unknown,
    ) => {
      retryExecutors.set(operationType, executor);
    },
    hasInFlightOperation: (storeId: string) => inFlightStoreIds.has(storeId),
    enqueue: (
      storeId: string,
      operationType: string,
      requestJson: Record<string, unknown>,
    ) => {
      enqueueCalls.push({ storeId, operationType, requestJson });
      return {
        id: `operation-${enqueueCalls.length}`,
        operationType,
        status: "QUEUED",
      };
    },
  };

  const orderSyncService = new OrderSyncService(
    databaseService as never,
    operationService as never,
    { record: () => null } as never,
    {
      getResolvedConfiguration: (storeId: string) =>
        configuredStoreIds.has(storeId) ? { store: { id: storeId }, credential: {} } : null,
      fetchOrderItems: () => {
        throw new Error("fetchOrderItems not used in enqueue tests");
      },
    } as never,
  );

  return { databaseService, orderSyncService, enqueueCalls, retryExecutors };
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
    usageCount: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    sampleExternalProductId: null,
    sampleOptionCode: null,
    sampleOptionManageCode: null,
    lastAutoMappedAt: null,
    mappingRuleHash: null,
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

const createAdCampaignSignature = (params: {
  id: string;
  campaignId: string;
  campaignName: string;
  canonicalSalesUnitId?: string | null;
  mappingReason?: "RULE_MATCHED" | "MANUAL_MAPPED" | "NO_RULE" | "MULTIPLE_RULES" | "INTENTIONALLY_UNMAPPED";
  reasonNote?: string | null;
  firstSeenDate?: string | null;
  lastSeenDate?: string | null;
}) =>
  ({
    id: params.id,
    storeId: "store-1",
    channel: "NAVER_DA",
    campaignId: params.campaignId,
    campaignNameSnapshot: params.campaignName,
    normalizedCampaignName: normalizeText(params.campaignName),
    canonicalSalesUnitId: params.canonicalSalesUnitId ?? null,
    mappingReason: params.mappingReason ?? (params.canonicalSalesUnitId ? "RULE_MATCHED" : "NO_RULE"),
    matchedRuleCount: params.canonicalSalesUnitId ? 1 : 0,
    reasonNote: params.reasonNote ?? null,
    reasonNoteInherited: false,
    confirmedAt: params.canonicalSalesUnitId || params.reasonNote ? new Date().toISOString() : null,
    usageCount: 1,
    firstSeenDate: params.firstSeenDate ?? null,
    lastSeenDate: params.lastSeenDate ?? null,
    lastAutoMappedAt: null,
    mappingRuleHash: null,
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

run("OrderSyncService enqueueSyncAll targets active configured stores and skips missing credentials", () => {
  const { orderSyncService, enqueueCalls } = createOrderSyncServiceHarness();
  const result = orderSyncService.enqueueSyncAll("2026-05-10", "2026-05-10");

  assert.equal(result.data.dateFrom, "2026-05-10");
  assert.equal(result.data.dateTo, "2026-05-10");
  assert.equal(result.data.rangeMode, "MANUAL");
  assert.equal(result.data.targetStoreCount, 1);
  assert.equal(result.data.skippedStoreCount, 1);
  assert.equal(result.data.operations[0].storeId, "store-live");
  assert.equal(result.data.operations.some((item) => item.storeId === "store-inactive"), false);
  assert.equal(result.data.skippedStores[0].storeId, "store-missing");
  assert.equal(result.data.skippedStores[0].reason, "NAVER_CREDENTIALS_NOT_CONFIGURED");
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].requestJson.requireLiveCredential, true);
  assert.equal(enqueueCalls[0].requestJson.requestedByBatch, true);
});

run("OrderSyncService enqueueSyncAll skips stores with in-flight ORDER_SYNC", () => {
  const { orderSyncService, enqueueCalls } = createOrderSyncServiceHarness({
    stores: [
      createStoreRecord("store-live", "Live Store"),
      createStoreRecord("store-live-2", "Live Store 2"),
    ],
    configuredStoreIds: ["store-live", "store-live-2"],
    inFlightStoreIds: ["store-live"],
  });
  const result = orderSyncService.enqueueSyncAll("2026-05-10", "2026-05-10");

  assert.equal(result.data.targetStoreCount, 1);
  assert.equal(result.data.skippedStoreCount, 1);
  assert.equal(result.data.operations[0].storeId, "store-live-2");
  assert.equal(result.data.skippedStores[0].storeId, "store-live");
  assert.equal(result.data.skippedStores[0].reason, "ORDER_SYNC_ALREADY_IN_FLIGHT");
  assert.equal(enqueueCalls.length, 1);
});

run("OrderSyncService retry executor preserves requireLiveCredential", () => {
  const { orderSyncService, retryExecutors } = createOrderSyncServiceHarness();
  let capturedOptions: { requireLiveCredential?: boolean } | undefined;
  orderSyncService.performSync = ((
    _storeId: string,
    _dateFrom: string,
    _dateTo: string,
    _rangeMode: "MANUAL" | "AUTO_LAST_30_DAYS",
    options?: { requireLiveCredential?: boolean },
  ) => {
    capturedOptions = options;
    return {};
  }) as never;

  orderSyncService.onModuleInit();
  const retryExecutor = retryExecutors.get("ORDER_SYNC");
  assert.ok(retryExecutor);
  retryExecutor({
    storeId: "store-live",
    requestJson: {
      dateFrom: "2026-05-10",
      dateTo: "2026-05-10",
      rangeMode: "MANUAL",
      requireLiveCredential: true,
    },
  });

  assert.equal(capturedOptions?.requireLiveCredential, true);
});

run("OrderSyncService enqueueSyncAll rejects manual ranges over 30 days", () => {
  const { orderSyncService } = createOrderSyncServiceHarness();

  assert.throws(() => orderSyncService.enqueueSyncAll("2026-01-01", "2026-02-01"));
});

run("OperationService hasInFlightOperation checks queued and running operations by type", () => {
  const databaseService = createMemoryDatabaseService();
  const operationService = new OperationService(
    databaseService as never,
    { record: () => null } as never,
  );

  databaseService.write((draft) => {
    draft.operations.push(
      {
        id: "op-queued",
        storeId: "store-1",
        operationType: "ORDER_SYNC",
        status: "QUEUED",
        retryOfOperationId: null,
        requestedBy: "LOCALHOST_ADMIN",
        requestJson: {},
        resultJson: null,
        errorMessage: null,
        cutoffAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      },
      {
        id: "op-done",
        storeId: "store-1",
        operationType: "RECALCULATE_AD_MAPPING",
        status: "SUCCEEDED",
        retryOfOperationId: null,
        requestedBy: "LOCALHOST_ADMIN",
        requestJson: {},
        resultJson: null,
        errorMessage: null,
        cutoffAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: new Date().toISOString(),
      },
    );
  });

  assert.equal(operationService.hasInFlightOperation("store-1", "ORDER_SYNC"), true);
  assert.equal(operationService.hasInFlightOperation("store-1", "RECALCULATE_AD_MAPPING"), false);
  assert.equal(operationService.hasInFlightOperation("store-2", "ORDER_SYNC"), false);
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

run("calculateVatAmount rounds to nearest won", () => {
  assert.equal(calculateVatAmount(10000), 1000);
  assert.equal(calculateVatAmount(9994), 999);
  assert.equal(calculateVatAmount(9995), 1000);
});

run("calculateVatAdjustedRevenue subtracts VAT amount from revenue", () => {
  assert.equal(calculateVatAdjustedRevenue(10000), 9000);
  assert.equal(calculateVatAdjustedRevenue(9994), 8995);
});

run("resolvePackageKey falls back to orderId when packageNumber is empty or null", () => {
  assert.equal(resolvePackageKey({ packageNumber: "PKG-001", orderId: "ORD-001" } as never), "PKG-001");
  assert.equal(resolvePackageKey({ packageNumber: "  ", orderId: "ORD-001" } as never), "ORD-001");
  assert.equal(resolvePackageKey({ packageNumber: null, orderId: "ORD-001" } as never), "ORD-001");
});

run("calculateStoreDeliverySummary counts unique packages and computes delivery margin", () => {
  const database = createEmptyDatabase();
  database.stores.push({
    id: "store-1",
    deliveryUnitCost: DEFAULT_DELIVERY_UNIT_COST,
  } as never);
  database.orderItems.push(
    {
      id: "item-1",
      storeId: "store-1",
      packageNumber: "PKG-001",
      orderId: "ORD-001",
      paymentDate: "2026-04-02",
      saleStatus: "SALE",
      canonicalSalesUnitId: "sales-1",
      deliveryFeeAmount: 3000,
    } as never,
    {
      id: "item-2",
      storeId: "store-1",
      packageNumber: "PKG-001",
      orderId: "ORD-001",
      paymentDate: "2026-04-02",
      saleStatus: "SALE",
      canonicalSalesUnitId: "sales-1",
      deliveryFeeAmount: 0,
    } as never,
    {
      id: "item-3",
      storeId: "store-1",
      packageNumber: "PKG-002",
      orderId: "ORD-002",
      paymentDate: "2026-04-02",
      saleStatus: "SALE",
      canonicalSalesUnitId: "sales-1",
      deliveryFeeAmount: 2000,
    } as never,
    {
      id: "item-4",
      storeId: "store-1",
      packageNumber: null,
      orderId: "ORD-003",
      paymentDate: "2026-04-02",
      saleStatus: "CANCELED",
      canonicalSalesUnitId: "sales-1",
      deliveryFeeAmount: 5000,
    } as never,
    {
      id: "item-5",
      storeId: "store-1",
      packageNumber: null,
      orderId: "ORD-004",
      paymentDate: "2026-04-02",
      saleStatus: "SALE",
      canonicalSalesUnitId: null,
      deliveryFeeAmount: 2000,
    } as never,
  );

  const summary = calculateStoreDeliverySummary(database, "store-1", "2026-04-02", "2026-04-02");
  assert.equal(summary.uniquePackageCount, 2);
  assert.equal(summary.deliveryUnitCost, 3500);
  assert.equal(summary.estimatedDeliveryBaseCost, 7000);
  assert.equal(summary.customerPaidDeliveryFee, 5000);
  assert.equal(summary.deliveryMargin, -2000);
});

run("calculateStoreDeliverySummary keeps positive delivery margin without clamping", () => {
  const database = createEmptyDatabase();
  database.stores.push({
    id: "store-1",
    deliveryUnitCost: DEFAULT_DELIVERY_UNIT_COST,
  } as never);
  database.orderItems.push({
    id: "item-1",
    storeId: "store-1",
    packageNumber: "PKG-001",
    orderId: "ORD-001",
    paymentDate: "2026-04-02",
    saleStatus: "SALE",
    canonicalSalesUnitId: "sales-1",
    deliveryFeeAmount: 10000,
  } as never);

  const summary = calculateStoreDeliverySummary(database, "store-1", "2026-04-02", "2026-04-02");
  assert.equal(summary.estimatedDeliveryBaseCost, 3500);
  assert.equal(summary.customerPaidDeliveryFee, 10000);
  assert.equal(summary.deliveryMargin, 6500);
});

run("FakePurchaseService stores daily amounts by store and date with audit history", () => {
  const { databaseService, fakePurchaseService, auditCalls } = createFakePurchaseServiceHarness();

  assert.deepEqual(fakePurchaseService.get("store-1", "2026-04-02"), {
    amount: 0,
    exists: false,
    updatedAt: null,
  });

  const created = fakePurchaseService.upsert({
    storeId: "store-1",
    date: "2026-04-02",
    amount: 12000,
  });

  assert.equal(created.amount, 12000);
  assert.deepEqual(fakePurchaseService.get("store-1", "2026-04-02"), {
    amount: 12000,
    exists: true,
    updatedAt: created.updatedAt,
  });

  const updated = fakePurchaseService.upsert({
    storeId: "store-1",
    date: "2026-04-02",
    amount: 0,
  });
  const snapshot = databaseService.getSnapshot();

  assert.equal(updated.id, created.id);
  assert.equal(updated.amount, 0);
  assert.equal(snapshot.dailyFakePurchases.length, 1);
  assert.equal(snapshot.dailyFakePurchases[0].amount, 0);
  assert.equal(auditCalls.length, 2);
  assert.deepEqual(auditCalls[0], {
    storeId: "store-1",
    domain: "FAKE_PURCHASE",
    action: "UPSERT",
    targetId: "store-1-2026-04-02",
    actorIdentifier: "LOCALHOST_ADMIN",
    beforeJson: null,
    afterJson: 12000,
  });
  assert.deepEqual(auditCalls[1], {
    storeId: "store-1",
    domain: "FAKE_PURCHASE",
    action: "UPSERT",
    targetId: "store-1-2026-04-02",
    actorIdentifier: "LOCALHOST_ADMIN",
    beforeJson: 12000,
    afterJson: 0,
  });
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

run("recalculateOrderMappingsForTouchedItems updates only touched order items", () => {
  const database = createEmptyDatabase();
  const touchedUnit = createSalesUnit("sales-1", "Touched Unit", []) as Record<string, unknown>;
  const untouchedUnit = createSalesUnit("sales-2", "Untouched Unit", []) as Record<string, unknown>;
  database.canonicalSalesUnits.push(
    {
      ...touchedUnit,
      linkedProductIds: ["prod-1"],
    } as never,
    {
      ...untouchedUnit,
      linkedProductIds: ["prod-2"],
    } as never,
  );
  database.orderSourceSignatures.push(
    createOrderSourceSignature("sig-1", "touched product"),
    createOrderSourceSignature("sig-2", "untouched product"),
  );
  const createOrderItem = (id: string, signatureId: string, productId: string) =>
    ({
      id,
      storeId: "store-1",
      orderId: `order-${id}`,
      orderSourceSignatureId: signatureId,
      canonicalSalesUnitId: null,
      externalProductOrderId: `external-${id}`,
      externalProductId: productId,
      optionCode: null,
      packageNumber: null,
      rawProductName: id,
      rawOptionInfo: null,
      normalizedProductName: normalizeText(id),
      normalizedOptionInfo: "",
      sourceSignature: createSourceSignature(id, null),
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
    }) as never;
  const conflictingSameSignatureItem = createOrderItem("item-3", "sig-1", "prod-2") as Record<string, unknown>;
  conflictingSameSignatureItem.canonicalSalesUnitId = "sales-2";
  database.orderItems.push(
    createOrderItem("item-1", "sig-1", "prod-1"),
    createOrderItem("item-2", "sig-2", "prod-2"),
    conflictingSameSignatureItem as never,
  );

  recalculateOrderMappingsForTouchedItems(database, {
    storeId: "store-1",
    signatureIds: new Set(["sig-1"]),
    orderItemIds: new Set(["item-1"]),
  });

  assert.equal(database.orderItems.find((item) => item.id === "item-1")?.canonicalSalesUnitId, "sales-1");
  assert.equal(database.orderItems.find((item) => item.id === "item-2")?.canonicalSalesUnitId, null);
  assert.equal(database.orderItems.find((item) => item.id === "item-3")?.canonicalSalesUnitId, "sales-2");
  assert.equal(database.orderSourceSignatures.find((item) => item.id === "sig-1")?.mappingStatus, "CONFLICT");
  assert.equal(database.orderSourceSignatures.find((item) => item.id === "sig-1")?.canonicalSalesUnitId, null);
  assert.equal(database.orderSourceSignatures.find((item) => item.id === "sig-2")?.canonicalSalesUnitId, null);
});

run("OrderMappingService saveMappings deduplicates signatures without recalculation", () => {
  const { databaseService, orderMappingService, enqueueCalls } = createOrderMappingServiceHarness();

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Diet Socks", ["diet socks"]));
    draft.orderSourceSignatures.push(
      createOrderSourceSignature("sig-1", "diet socks"),
      createOrderSourceSignature("sig-2", "diet socks black"),
    );
    draft.orderItems.push(
      {
        id: "order-item-1",
        storeId: "store-1",
        orderSourceSignatureId: "sig-1",
        canonicalSalesUnitId: null,
        updatedAt: new Date().toISOString(),
      } as never,
      {
        id: "order-item-2",
        storeId: "store-1",
        orderSourceSignatureId: "sig-2",
        canonicalSalesUnitId: null,
        updatedAt: new Date().toISOString(),
      } as never,
    );
  });

  const result = orderMappingService.saveMappings(["sig-1", "sig-1", "sig-2"], {
    canonicalSalesUnitId: "sales-1",
  });
  const snapshot = databaseService.getSnapshot();
  const first = snapshot.orderSourceSignatures.find((item: { id: string }) => item.id === "sig-1");
  const second = snapshot.orderSourceSignatures.find((item: { id: string }) => item.id === "sig-2");
  const firstOrderItem = snapshot.orderItems.find((item: { id: string }) => item.id === "order-item-1");
  const secondOrderItem = snapshot.orderItems.find((item: { id: string }) => item.id === "order-item-2");

  assert.equal(result.data.updatedCount, 2);
  assert.equal(result.data.operationId, null);
  assert.equal(enqueueCalls.length, 0);
  assert.equal(first?.canonicalSalesUnitId, "sales-1");
  assert.equal(second?.canonicalSalesUnitId, "sales-1");
  assert.equal(firstOrderItem?.canonicalSalesUnitId, "sales-1");
  assert.equal(secondOrderItem?.canonicalSalesUnitId, "sales-1");
  assert.equal(first?.mappingStatus, "MAPPED");
  assert.equal(second?.mappingStatus, "MAPPED");
});

run("OrderMappingService enqueueRecalculate starts one order mapping recalculation", () => {
  const { orderMappingService, enqueueCalls } = createOrderMappingServiceHarness();

  const result = orderMappingService.enqueueRecalculate("store-1");

  assert.equal(result.data.operationId, "operation-1");
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0]?.storeId, "store-1");
  assert.equal(enqueueCalls[0]?.requestJson.reason, "MANUAL_RECALCULATE_ORDER_MAPPING");
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

runAsync("OrderSyncService listOrderSourceSignatures searches canonical sales unit display name", async () => {
  const { databaseService, orderSyncService } = createOrderSyncServiceHarness({
    stores: [createStoreRecord("store-1", "Main Store")],
    configuredStoreIds: ["store-1"],
  });

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-needle", "Needle Unit", []));
    draft.orderSourceSignatures.push(
      Object.assign(createOrderSourceSignature("sig-needle", "Hidden Product") as Record<string, unknown>, {
        canonicalSalesUnitId: "sales-needle",
        mappingStatus: "MAPPED",
      }) as never,
      createOrderSourceSignature("sig-other", "Other Product"),
    );
  });

  const result = await orderSyncService.listOrderSourceSignatures({
    storeId: "store-1",
    q: "Needle Unit",
  });

  assert.equal(result.data.totalCount, 1);
  assert.equal(result.data.items[0].id, "sig-needle");
  assert.equal(result.data.items[0].canonicalDisplayName, "Needle Unit");
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

run("recalculateAdCampaignSignaturesForStore without row apply leaves ad cost rows unchanged", () => {
  const database = createEmptyDatabase();
  const originalUpdatedAt = "2026-04-01T00:00:00.000Z";
  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Launch Unit", ["launch"]));
  database.campaignMappings.push({
    id: "campaign-rule-1",
    storeId: "store-1",
    channel: "NAVER_DA",
    canonicalSalesUnitId: "sales-1",
    campaignPattern: "launch",
    normalizedCampaignPattern: normalizeText("launch"),
    isActive: true,
    deactivatedAt: null,
    createdAt: originalUpdatedAt,
    updatedAt: originalUpdatedAt,
  });
  database.adCampaignSignatures.push({
    id: "ad-signature-1",
    storeId: "store-1",
    channel: "NAVER_DA",
    campaignId: "cmp-1",
    campaignNameSnapshot: "launch campaign",
    normalizedCampaignName: normalizeText("launch campaign"),
    canonicalSalesUnitId: null,
    mappingReason: "NO_RULE",
    matchedRuleCount: 0,
    reasonNote: "일치하는 규칙이 없습니다.",
    reasonNoteInherited: false,
    confirmedAt: null,
    usageCount: 1,
    firstSeenDate: "2026-04-01",
    lastSeenDate: "2026-04-01",
    lastAutoMappedAt: null,
    mappingRuleHash: null,
    createdAt: originalUpdatedAt,
    updatedAt: originalUpdatedAt,
  });
  const row = createConfirmedUploadRow({
    uploadId: "upload-1",
    reportDate: "2026-04-01",
    campaignId: "cmp-1",
    campaignName: "launch campaign",
    canonicalSalesUnitId: null,
    totalCost: 100,
  }) as Record<string, unknown>;
  row.adCampaignSignatureId = "ad-signature-1";
  row.updatedAt = originalUpdatedAt;
  database.adCampaignDailyCosts.push(row as never);

  recalculateAdCampaignSignaturesForStore(database, "store-1", { onlyUnconfirmed: true });

  assert.equal(database.adCampaignSignatures[0].canonicalSalesUnitId, "sales-1");
  assert.equal(database.adCampaignSignatures[0].mappingReason, "RULE_MATCHED");
  assert.equal(database.adCampaignDailyCosts[0].canonicalSalesUnitId, null);
  assert.equal(database.adCampaignDailyCosts[0].mappingReason, "NO_RULE");
  assert.equal(database.adCampaignDailyCosts[0].updatedAt, originalUpdatedAt);
});

run("DatabaseService normalizeSnapshot keeps conflicting manual ad rows as signature conflict", () => {
  const database = createEmptyDatabase();
  database.adCampaignDailyCosts.push(
    createConfirmedUploadRow({
      uploadId: "upload-1",
      reportDate: "2026-04-01",
      campaignId: "cmp-conflict",
      campaignName: "manual conflict",
      canonicalSalesUnitId: "sales-1",
      totalCost: 100,
      mappingReason: "MANUAL_MAPPED",
    }),
    createConfirmedUploadRow({
      uploadId: "upload-2",
      reportDate: "2026-04-02",
      campaignId: "cmp-conflict",
      campaignName: "manual conflict",
      canonicalSalesUnitId: "sales-2",
      totalCost: 100,
      mappingReason: "MANUAL_MAPPED",
    }),
  );

  const normalized = (
    new DatabaseService() as unknown as {
      normalizeSnapshot(snapshot: typeof database): typeof database;
    }
  ).normalizeSnapshot(database);
  const signature = normalized.adCampaignSignatures.find(
    (item: { campaignId: string | null }) => item.campaignId === "cmp-conflict",
  )!;

  assert.equal(signature.mappingReason, "MULTIPLE_RULES");
  assert.equal(signature.canonicalSalesUnitId, null);
  assert.equal(signature.confirmedAt, null);
  assert.equal(new Set(normalized.adCampaignDailyCosts.map((item) => item.adCampaignSignatureId)).size, 1);
});

run("calculateDashboardSummary excludes conflict order revenue and conflict ad cost from totals", () => {
  const database = createEmptyDatabase();
  const date = "2026-04-01";

  database.canonicalSalesUnits.push(createSalesUnit("sales-1", "Diet Socks", ["dietsocks"]));
  database.salesUnitCostSnapshots.push({
    id: "snapshot-1",
    storeId: "store-1",
    effectiveFrom: date,
    sourceFileName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.salesUnitCostSnapshotEntries.push({
    id: "cost-1",
    snapshotId: "snapshot-1",
    storeId: "store-1",
    canonicalSalesUnitId: "sales-1",
    unitCost: 10,
    feeRate: 0.1,
    otherCost: 5,
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
  database.salesUnitCostSnapshots.push({
    id: "snapshot-delivery-profit",
    storeId: "store-1",
    effectiveFrom: date,
    sourceFileName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.salesUnitCostSnapshotEntries.push({
    id: "cost-1",
    snapshotId: "snapshot-delivery-profit",
    storeId: "store-1",
    canonicalSalesUnitId: "sales-1",
    unitCost: 10,
    feeRate: 0.1,
    otherCost: 5,
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
  assert.equal(rows[0].vatAmount, 10);
  assert.equal(rows[0].vatAdjustedRevenue, 90);
  assert.equal(rows[0].estimatedNetProfit, 65);
  assert.equal(summary.totalRevenue, 100);
  assert.equal(summary.totalProductRevenue, 100);
  assert.equal(summary.totalDeliveryFeeAmount, 20);
  assert.equal(summary.roughProfit, 100);
  assert.equal(summary.totalVatAmount, 10);
  assert.equal(summary.totalVatAdjustedRevenue, 90);
  assert.equal(summary.estimatedNetProfit, -3415);
  assert.equal(summary.uniquePackageCount, 1);
  assert.equal(summary.deliveryUnitCost, 3500);
  assert.equal(summary.deliveryMargin, -3480);
});

run("AdsService confirms two same-date uploads and sums ad cost across active confirmed uploads", () => {
  const { databaseService, adsService } = createAdsServiceHarness();
  const date = "2026-04-03";

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha", "beta"]));
  });

  adsService.previewUpload(
    "store-1",
    date,
    createAdUploadFile(date, [{ campaignId: "cmp-1001", campaignName: "alpha launch", totalCost: 120 }]),
  );

  adsService.previewUpload(
    "store-1",
    date,
    createAdUploadFile(date, [{ campaignId: "cmp-1002", campaignName: "beta launch", totalCost: 80 }]),
  );

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
  assert.equal(detail.data.deliveryContext.uniquePackageCount, 0);
  assert.equal(detail.data.deliveryContext.customerPaidDeliveryFee, 0);
  assert.equal(detail.data.deliveryContext.includedInThisSalesUnitNetProfit, false);
  assert.equal(detail.data.adCampaigns.length, 1);
  assert.equal(detail.data.adCampaigns[0].adCostId, "ad-upload-active-cmp-1001");
});

run("ProfitService keeps delivery fee references separate from product revenue and net profit", () => {
  const databaseService = createMemoryDatabaseService();
  const profitService = new ProfitService(databaseService as never);
  const date = "2026-04-02";

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-1", "Alpha Unit", ["alpha"]));
    draft.salesUnitCostSnapshots.push({
      id: "snapshot-profit-service",
      storeId: "store-1",
      effectiveFrom: date,
      sourceFileName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    draft.salesUnitCostSnapshotEntries.push({
      id: "cost-1",
      snapshotId: "snapshot-profit-service",
      storeId: "store-1",
      canonicalSalesUnitId: "sales-1",
      unitCost: 0,
      feeRate: 0,
      otherCost: 0,
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
  assert.equal(summary.totalVatAmount, 10);
  assert.equal(summary.totalVatAdjustedRevenue, 90);
  assert.equal(summary.estimatedNetProfit, -3380);
  assert.equal(detail.data.summary.totalRevenue, 100);
  assert.equal(detail.data.summary.totalProductRevenue, 100);
  assert.equal(detail.data.summary.totalDeliveryFeeAmount, 30);
  assert.equal(detail.data.revenueBreakdown.productRevenueOriginal, 100);
  assert.equal(detail.data.revenueBreakdown.vatAmount, 10);
  assert.equal(detail.data.revenueBreakdown.vatAdjustedRevenue, 90);
  assert.equal(detail.data.deliveryContext.uniquePackageCount, 1);
  assert.equal(detail.data.deliveryContext.deliveryMargin, -3470);
  assert.equal(detail.data.deliveryContext.includedInThisSalesUnitNetProfit, false);
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
    draft.adCampaignSignatures.push({
      id: "ad-signature-delete",
      storeId: "store-1",
      channel: "NAVER_DA",
      campaignId: "cmp-delete",
      campaignNameSnapshot: "duplicate launch",
      normalizedCampaignName: normalizeText("duplicate launch"),
      canonicalSalesUnitId: "sales-1",
      mappingReason: "RULE_MATCHED",
      matchedRuleCount: 1,
      reasonNote: null,
      reasonNoteInherited: false,
      confirmedAt: null,
      usageCount: 1,
      firstSeenDate: date,
      lastSeenDate: date,
      lastAutoMappedAt: null,
      mappingRuleHash: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const row = createConfirmedUploadRow({
      uploadId: "upload-delete",
      reportDate: date,
      campaignId: "cmp-delete",
      campaignName: "duplicate launch",
      canonicalSalesUnitId: "sales-1",
      totalCost: 45,
    }) as Record<string, unknown>;
    row.adCampaignSignatureId = "ad-signature-delete";
    draft.adCampaignDailyCosts.push(row as never);
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
  assert.equal(snapshot.adCampaignSignatures.find((item: { id: string }) => item.id === "ad-signature-delete")?.usageCount, 0);
  assert.equal(snapshot.adCampaignSignatures.find((item: { id: string }) => item.id === "ad-signature-delete")?.firstSeenDate, null);
  assert.equal(snapshot.adCampaignSignatures.find((item: { id: string }) => item.id === "ad-signature-delete")?.lastSeenDate, null);
  assert.equal(calculateDashboardSummary(snapshot, "store-1", date).totalAdCost, 0);
});

run("AdsService listAdCampaignSignatures excludes stale signatures and searches extended fields", () => {
  const { databaseService, adsService } = createAdsServiceHarness();

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(createSalesUnit("sales-needle", "Needle Unit", []));
    draft.adExcelUploads.push(
      createConfirmedUpload({ uploadId: "upload-active", reportDate: "2026-04-03" }),
      createConfirmedUpload({ uploadId: "upload-inactive", reportDate: "2026-04-02", isActive: false }),
    );
    draft.adCampaignSignatures.push(
      createAdCampaignSignature({
        id: "ad-signature-active",
        campaignId: "cmp-active",
        campaignName: "active launch",
        canonicalSalesUnitId: "sales-needle",
        mappingReason: "INTENTIONALLY_UNMAPPED",
        reasonNote: "budget hold",
        firstSeenDate: "2026-04-01",
        lastSeenDate: "2026-04-03",
      }),
      createAdCampaignSignature({
        id: "ad-signature-stale",
        campaignId: "cmp-stale",
        campaignName: "stale launch",
        firstSeenDate: "2026-04-02",
        lastSeenDate: "2026-04-02",
      }),
      createAdCampaignSignature({
        id: "ad-signature-no-rule",
        campaignId: "cmp-no-rule",
        campaignName: "no rule launch",
        mappingReason: "NO_RULE",
        firstSeenDate: "2026-04-03",
        lastSeenDate: "2026-04-03",
      }),
    );
    draft.adCampaignDailyCosts.push(
      Object.assign(
        createConfirmedUploadRow({
          uploadId: "upload-active",
          reportDate: "2026-04-03",
          campaignId: "cmp-active",
          campaignName: "active launch",
          canonicalSalesUnitId: null,
          totalCost: 120,
        }),
        { adCampaignSignatureId: "ad-signature-active" },
      ) as never,
      Object.assign(
        createConfirmedUploadRow({
          uploadId: "upload-inactive",
          reportDate: "2026-04-02",
          campaignId: "cmp-stale",
          campaignName: "stale launch",
          canonicalSalesUnitId: null,
          totalCost: 80,
        }),
        { adCampaignSignatureId: "ad-signature-stale" },
      ) as never,
      Object.assign(
        createConfirmedUploadRow({
          uploadId: "upload-active",
          reportDate: "2026-04-03",
          campaignId: "cmp-no-rule",
          campaignName: "no rule launch",
          canonicalSalesUnitId: null,
          totalCost: 40,
          mappingReason: "NO_RULE",
        }),
        { adCampaignSignatureId: "ad-signature-no-rule" },
      ) as never,
    );
  });

  const defaultResult = adsService.listAdCampaignSignatures({ storeId: "store-1" });
  assert.equal(defaultResult.data.totalCount, 2);
  assert.deepEqual(
    new Set(defaultResult.data.items.map((item: { id: string }) => item.id)),
    new Set(["ad-signature-active", "ad-signature-no-rule"]),
  );

  ["Needle Unit", "budget hold", "intentional", "2026-04-03"].forEach((q) => {
    const result = adsService.listAdCampaignSignatures({ storeId: "store-1", q });
    assert.equal(
      result.data.items.some((item: { id: string }) => item.id === "ad-signature-active"),
      true,
    );
  });

  const reasonAliasResult = adsService.listAdCampaignSignatures({ storeId: "store-1", q: "NO_RULE_MATCH" });
  assert.equal(reasonAliasResult.data.totalCount, 1);
  assert.equal(reasonAliasResult.data.items[0].id, "ad-signature-no-rule");
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

run("AdsService stores manual mappings on campaign signatures and later uploads inherit them", () => {
  const { databaseService, adsService } = createAdsServiceHarness();

  databaseService.write((draft) => {
    draft.canonicalSalesUnits.push(
      createSalesUnit("sales-1", "Manual Unit", ["manual"]),
      createSalesUnit("sales-2", "Rule Unit", ["rule"]),
    );
  });

  adsService.previewUpload(
    "store-1",
    "2026-04-03",
    createAdUploadFile("2026-04-03", [
      { campaignId: "cmp-signature", campaignName: "brand launch", totalCost: 120 },
    ]),
  );

  const firstSnapshot = databaseService.getSnapshot();
  const firstRow = firstSnapshot.adCampaignDailyCosts.find(
    (item: { campaignId: string }) => item.campaignId === "cmp-signature",
  )!;

  adsService.saveManualMappings([firstRow.id], { canonicalSalesUnitId: "sales-1" });
  const manualSnapshot = databaseService.getSnapshot();
  const signature = manualSnapshot.adCampaignSignatures.find(
    (item: { campaignId: string | null }) => item.campaignId === "cmp-signature",
  )!;

  assert.equal(signature.canonicalSalesUnitId, "sales-1");
  assert.equal(signature.mappingReason, "MANUAL_MAPPED");
  assert.ok(signature.confirmedAt);
  assert.equal(
    manualSnapshot.adCampaignDailyCosts.find((item: { id: string }) => item.id === firstRow.id)?.adCampaignSignatureId,
    signature.id,
  );

  databaseService.write((draft) => {
    draft.campaignMappings.push({
      id: "campaign-rule-1",
      storeId: "store-1",
      channel: "NAVER_DA",
      canonicalSalesUnitId: "sales-2",
      campaignPattern: "brand",
      normalizedCampaignPattern: normalizeText("brand"),
      isActive: true,
      deactivatedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  adsService.recalculateMappings([signature.id]);
  assert.equal(
    databaseService.getSnapshot().adCampaignSignatures.find((item: { id: string }) => item.id === signature.id)
      ?.canonicalSalesUnitId,
    "sales-1",
  );

  adsService.previewUpload(
    "store-1",
    "2026-04-04",
    createAdUploadFile("2026-04-04", [
      { campaignId: "cmp-signature", campaignName: "brand launch", totalCost: 80 },
    ]),
  );

  const finalSnapshot = databaseService.getSnapshot();
  const rows = finalSnapshot.adCampaignDailyCosts.filter(
    (item: { campaignId: string }) => item.campaignId === "cmp-signature",
  );
  const finalSignature = finalSnapshot.adCampaignSignatures.find(
    (item: { id: string }) => item.id === signature.id,
  )!;

  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((item: { adCampaignSignatureId: string | null }) => item.adCampaignSignatureId)).size, 1);
  assert.equal(finalSignature.usageCount, 2);
  rows.forEach((item: { canonicalSalesUnitId: string | null; mappingReason: string }) => {
    assert.equal(item.canonicalSalesUnitId, "sales-1");
    assert.equal(item.mappingReason, "MANUAL_MAPPED");
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

// ========== Signature Enrichment Tests ==========

run("isMeaningfulName rejects empty/null/whitespace strings", () => {
  assert.equal(isMeaningfulName(null), false);
  assert.equal(isMeaningfulName(undefined), false);
  assert.equal(isMeaningfulName(""), false);
  assert.equal(isMeaningfulName("   "), false);
});

run("isMeaningfulName rejects strings with length <= 2", () => {
  assert.equal(isMeaningfulName("L"), false);
  assert.equal(isMeaningfulName("XL"), false);
  assert.equal(isMeaningfulName("M"), false);
  assert.equal(isMeaningfulName("s"), false);
  assert.equal(isMeaningfulName("XS"), false);
});

run("isMeaningfulName rejects size/option patterns (case-insensitive)", () => {
  assert.equal(isMeaningfulName("xs"), false);
  assert.equal(isMeaningfulName("XS"), false);
  assert.equal(isMeaningfulName("s"), false);
  assert.equal(isMeaningfulName("m"), false);
  assert.equal(isMeaningfulName("l"), false);
  assert.equal(isMeaningfulName("xl"), false);
  assert.equal(isMeaningfulName("xxl"), false);
  assert.equal(isMeaningfulName("free"), false);
  assert.equal(isMeaningfulName("one"), false);
  assert.equal(isMeaningfulName("원사이즈"), false);
  assert.equal(isMeaningfulName("32"), false);
  assert.equal(isMeaningfulName("36"), false);
});

run("isMeaningfulName rejects values contained in context option info", () => {
  const contextOption = "[함께배송⭐추가할인]러닝깔창: L";
  assert.equal(isMeaningfulName("L", contextOption), false);
  assert.equal(isMeaningfulName("l", contextOption), false); // case-insensitive check
});

run("isMeaningfulName accepts meaningful product names", () => {
  assert.equal(isMeaningfulName("러닝깔창"), true);
  assert.equal(isMeaningfulName("베놈 무릎보호대"), true);
  assert.equal(isMeaningfulName("Running Hat"), true);
  assert.equal(isMeaningfulName("ABC"), true); // length >= 3
});

run("extractNameFromOptionInfo parses pattern correctly", () => {
  assert.equal(
    extractNameFromOptionInfo("[함께배송⭐추가할인]러닝깔창: L"),
    "러닝깔창"
  );
  assert.equal(
    extractNameFromOptionInfo("[TAG]상품명: 사이즈"),
    "상품명"
  );
  assert.equal(
    extractNameFromOptionInfo("무릎보호대: XL"),
    "무릎보호대"
  );
});

run("extractNameFromOptionInfo returns null for non-matching patterns", () => {
  assert.equal(extractNameFromOptionInfo("no colon here"), null);
  assert.equal(extractNameFromOptionInfo(""), null);
  assert.equal(extractNameFromOptionInfo(null as never), null);
});

run("enrichSignatureDisplayName returns snapshot when meaningful", async () => {
  const database = createEmptyDatabase();
  const signature = {
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: "sig",
    rawProductNameSnapshot: "러닝깔창",
    rawOptionInfoSnapshot: null,
    normalizedProductName: "러닝깔창",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED" as const,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;

  const result = await enrichSignatureDisplayName(database, signature);
  assert.equal(result.fallbackProductName, "러닝깔창");
  assert.equal(result.fallbackProductNameSource, "snapshot");
});

run("enrichSignatureDisplayName falls back to orderItem rawProductName", async () => {
  const database = createEmptyDatabase();
  const signature = {
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: "sig",
    rawProductNameSnapshot: "",
    rawOptionInfoSnapshot: null,
    normalizedProductName: "",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED" as const,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;
  database.orderItems.push({
    id: "item-1",
    orderId: "order-1",
    storeId: "store-1",
    productId: null,
    orderSourceSignatureId: "sig-1",
    canonicalSalesUnitId: null,
    externalProductOrderId: "ext-1",
    externalProductId: null,
    optionCode: null,
    packageNumber: null,
    rawProductName: "베놈 무릎보호대",
    rawOptionInfo: null,
    normalizedProductName: "베놈 무릎보호대",
    normalizedOptionInfo: "",
    sourceSignature: "sig",
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: null,
    deliveryFeeAmount: null,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: null,
    paymentDate: null,
    saleStatus: "SALE",
    orderStatus: "PAYED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);

  const result = await enrichSignatureDisplayName(database, signature);
  assert.equal(result.fallbackProductName, "베놈 무릎보호대");
  assert.equal(result.fallbackProductNameSource, "orderItem");
});

run("enrichSignatureDisplayName extracts from option info pattern", async () => {
  const database = createEmptyDatabase();
  const signature = {
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: "sig",
    rawProductNameSnapshot: "",
    rawOptionInfoSnapshot: "[함께배송⭐추가할인]러닝깔창: L",
    normalizedProductName: "",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED" as const,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;

  const result = await enrichSignatureDisplayName(database, signature);
  assert.equal(result.fallbackProductName, "러닝깔창");
  assert.equal(result.fallbackProductNameSource, "optionInfo");
});

run("enrichSignatureDisplayName matches product by externalProductId", async () => {
  const database = createEmptyDatabase();
  const signature = {
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: "sig",
    rawProductNameSnapshot: "",
    rawOptionInfoSnapshot: null,
    normalizedProductName: "",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED" as const,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;
  database.orderItems.push({
    id: "item-1",
    orderId: "order-1",
    storeId: "store-1",
    productId: null,
    orderSourceSignatureId: "sig-1",
    canonicalSalesUnitId: null,
    externalProductOrderId: "ext-1",
    externalProductId: "prod-123",
    optionCode: null,
    packageNumber: null,
    rawProductName: "L",
    rawOptionInfo: null,
    normalizedProductName: "l",
    normalizedOptionInfo: "",
    sourceSignature: "sig",
    quantity: 1,
    productPaymentAmount: 10000,
    totalProductAmount: null,
    deliveryFeeAmount: null,
    paymentCommission: null,
    knowledgeShoppingSellingInterlockCommission: null,
    saleCommission: null,
    channelCommission: null,
    orderDate: null,
    paymentDate: null,
    saleStatus: "SALE",
    orderStatus: "PAYED",
    isCanceled: false,
    isReturned: false,
    rawPayload: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  database.products.push({
    id: "p-1",
    storeId: "store-1",
    externalProductId: "prod-123",
    productName: "고급 러닝화",
    normalizedProductName: "고급 러닝화",
    status: null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const result = await enrichSignatureDisplayName(database, signature);
  assert.equal(result.fallbackProductName, "고급 러닝화");
  assert.equal(result.fallbackProductNameSource, "product");
});

run("enrichSignatureDisplayName returns null when all fallbacks fail", async () => {
  const database = createEmptyDatabase();
  const signature = {
    id: "sig-1",
    storeId: "store-1",
    sourceSignature: "sig",
    rawProductNameSnapshot: "",
    rawOptionInfoSnapshot: null,
    normalizedProductName: "",
    normalizedOptionInfo: "",
    canonicalSalesUnitId: null,
    mappingStatus: "UNMAPPED" as const,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;

  const result = await enrichSignatureDisplayName(database, signature);
  assert.equal(result.fallbackProductName, null);
  assert.equal(result.fallbackProductNameSource, null);
});

run("getSignatureIndex caches index by database reference", () => {
  const database = createEmptyDatabase();
  database.orderSourceSignatures = [
    {
      id: "sig-1",
      storeId: "store-1",
      sourceSignature: "sig1",
      rawProductNameSnapshot: "Product 1",
      rawOptionInfoSnapshot: "Option 1",
      normalizedProductName: "product 1",
      normalizedOptionInfo: "option 1",
      canonicalSalesUnitId: "unit-1",
      mappingStatus: "MAPPED" as const,
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    {
      id: "sig-2",
      storeId: "store-1",
      sourceSignature: "sig2",
      rawProductNameSnapshot: "Product 2",
      rawOptionInfoSnapshot: null,
      normalizedProductName: "product 2",
      normalizedOptionInfo: "",
      canonicalSalesUnitId: null,
      mappingStatus: "UNMAPPED",
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  ];

  // First call builds the index
  const index1 = getSignatureIndex(database);
  assert.equal(index1.size, 2);
  assert.equal(index1.get("sig-1")?.sourceSignature, "sig1");
  assert.equal(index1.get("sig-2")?.sourceSignature, "sig2");

  // Second call with same reference should return cached index (same object)
  const index2 = getSignatureIndex(database);
  assert.strictEqual(index1, index2, "Cache should return same Map instance");

  // Third call still returns cached
  const index3 = getSignatureIndex(database);
  assert.strictEqual(index1, index3);
});

run("getSignatureIndex cache invalidates on database reference change", () => {
  const database1 = createEmptyDatabase();
  database1.orderSourceSignatures = [
    {
      id: "sig-1",
      storeId: "store-1",
      sourceSignature: "sig1",
      rawProductNameSnapshot: "Product 1",
      rawOptionInfoSnapshot: "Option 1",
      normalizedProductName: "product 1",
      normalizedOptionInfo: "option 1",
      canonicalSalesUnitId: "unit-1",
      mappingStatus: "MAPPED" as const,
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  ];

  const index1 = getSignatureIndex(database1);
  assert.equal(index1.size, 1);

  // Create a new database reference with different signatures
  const database2 = createEmptyDatabase();
  database2.orderSourceSignatures = [
    {
      id: "sig-a",
      storeId: "store-1",
      sourceSignature: "siga",
      rawProductNameSnapshot: "Product A",
      rawOptionInfoSnapshot: null,
      normalizedProductName: "product a",
      normalizedOptionInfo: "",
      canonicalSalesUnitId: null,
      mappingStatus: "UNMAPPED",
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    {
      id: "sig-b",
      storeId: "store-1",
      sourceSignature: "sigb",
      rawProductNameSnapshot: "Product B",
      rawOptionInfoSnapshot: null,
      normalizedProductName: "product b",
      normalizedOptionInfo: "",
      canonicalSalesUnitId: null,
      mappingStatus: "UNMAPPED",
      confirmedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  ];

  // New database reference should build new index
  const index2 = getSignatureIndex(database2);
  assert.equal(index2.size, 2);
  assert.notStrictEqual(index1, index2, "Different database references should have different caches");
  assert.equal(index2.get("sig-a")?.sourceSignature, "siga");
  assert.equal(index2.get("sig-b")?.sourceSignature, "sigb");

  // Original database should still have cached original index
  const index1Again = getSignatureIndex(database1);
  assert.strictEqual(index1, index1Again);
  assert.equal(index1Again.size, 1);
});

void Promise.all(pendingAsyncTests).then(() => {
  console.log("All backend checks passed.");
});
