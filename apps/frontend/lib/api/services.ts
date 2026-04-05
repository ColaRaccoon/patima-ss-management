import type { DashboardSummary, DailySalesUnitProfit, SaleStatus } from "@patima/shared";
import { fetchApi, withQuery } from "@/lib/api/client";
import {
  mockAdCosts,
  mockCampaignMappings,
  mockCostSettings,
  mockCredential,
  mockDashboardSummary,
  mockOperationDetail,
  mockOperations,
  mockOrderItems,
  mockPreview,
  mockPreviewRows,
  mockProfitDetailPreview,
  mockProfits,
  mockSalesUnits,
  mockSignatures,
  mockStores,
  mockUnmappedSummary,
  mockUploads,
  MOCK_DATE_FROM,
  MOCK_DATE_TO,
  MOCK_SELECTED_DATE,
} from "@/lib/api/mock-data";
import type {
  AdPreviewRowItem,
  AdPreviewSummary,
  AdUploadListItem,
  AdUploadsPageData,
  CampaignCostListItem,
  CampaignMappingRuleListItem,
  CostsPageData,
  CostSettingListItem,
  CredentialSummary,
  DailySalesUnitDetail,
  DashboardPageData,
  MappingsPageData,
  OperationsPageData,
  OperationDetail,
  OperationListItem,
  OrdersPageData,
  OrdersPageFilters,
  OrderListItem,
  OrderSourceSignatureListItem,
  ProfitsPageData,
  SalesUnitsPageData,
  SalesUnitListItem,
  ShellData,
  SourceState,
  StoreListItem,
  StoreSettingsPageData,
} from "@/lib/api/types";

const nowInSeoul = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const collectSources = (
  ...sources: Array<{
    label: string;
    source: "live" | "mock";
    endpoint: string;
    error?: string;
  }>
): SourceState[] =>
  sources.map((source) => ({
    label: source.label,
    source: source.source,
    endpoint: source.endpoint,
    error: source.error,
  }));

const pickPrimaryStore = (stores: StoreListItem[]) =>
  stores.find((store) => store.isPrimary) ?? stores[0] ?? null;

const toMappingReason = (value: string | null | undefined) => {
  switch (value) {
    case "NO_RULE":
      return "NO_RULE_MATCH";
    case "MULTIPLE_RULES":
      return "MULTIPLE_RULE_MATCHES";
    case "MANUAL_MAPPED":
      return "MANUAL_MAPPED";
    case "INTENTIONALLY_UNMAPPED":
      return "INTENTIONALLY_UNMAPPED";
    default:
      return null;
  }
};

function normalizeOrdersPageFilters(
  filters?: Partial<OrdersPageFilters>,
): OrdersPageFilters {
  const mappingStatus =
    filters?.mappingStatus === "MAPPED" || filters?.mappingStatus === "UNMAPPED"
      ? filters.mappingStatus
      : "ALL";
  const paymentDateStatus =
    filters?.paymentDateStatus === "PRESENT" ||
    filters?.paymentDateStatus === "MISSING"
      ? filters.paymentDateStatus
      : "ALL";
  const saleStatus =
    filters?.saleStatus === "SALE" ||
    filters?.saleStatus === "CANCELED" ||
    filters?.saleStatus === "CANCEL_REQUESTED" ||
    filters?.saleStatus === "RETURNED" ||
    filters?.saleStatus === "EXCHANGED" ||
    filters?.saleStatus === "UNKNOWN"
      ? filters.saleStatus
      : "ALL";

  return {
    dateFrom: filters?.dateFrom?.trim() || MOCK_DATE_FROM,
    dateTo: filters?.dateTo?.trim() || MOCK_DATE_TO,
    productName: filters?.productName?.trim() || "",
    optionInfo: filters?.optionInfo?.trim() || "",
    mappingStatus,
    saleStatus,
    orderStatus: filters?.orderStatus?.trim() || "",
    paymentDateStatus,
  };
}

function createMockDailySalesUnitDetail(
  row: DailySalesUnitProfit | null | undefined,
): DailySalesUnitDetail | null {
  if (!row) {
    return null;
  }

  return {
    date: row.date,
    canonicalSalesUnitId: row.canonicalSalesUnitId,
    displayName: row.displayName,
    summary: row,
    orderItems: [],
    adCampaigns: [],
    costBreakdown: {
      costSettingStatus: mockProfitDetailPreview.profitStatus,
      unitCostPerQuantity: 0,
      otherCostPerQuantity: 0,
      feeRateFallback: null,
      computedFeeCost: row.totalFeeCost,
      fallbackFeeCostPortion: mockProfitDetailPreview.fallbackFeeCostPortion,
      aggregatedFeeCandidates: {
        paymentCommission: 0,
        knowledgeShoppingSellingInterlockCommission: 0,
        saleCommission: 0,
        channelCommission: 0,
      },
    },
    excludedSummary: {
      excludedOrderRevenue: 0,
      excludedAdCost: 0,
      excludedUnmappedOrderRevenue: 0,
      excludedNonSaleOrderRevenue: 0,
      excludedUnmappedAdCost: 0,
      excludedIntentionalUnmappedAdCost: 0,
      excludedOrderStatusCounts: {
        CANCELED: 0,
        CANCEL_REQUESTED: 0,
        RETURNED: 0,
        EXCHANGED: 0,
      },
    },
  };
}

async function getStores() {
  return fetchApi<StoreListItem[]>({
    label: "Stores",
    path: "/stores",
    fallback: mockStores,
  });
}

async function getCredential(storeId: string) {
  return fetchApi<CredentialSummary>({
    label: "Credentials",
    path: `/stores/${storeId}/commerce-credentials`,
    fallback: mockCredential,
  });
}

async function getDashboardSummary(storeId: string, date: string) {
  return fetchApi<DashboardSummary>({
    label: "Dashboard summary",
    path: withQuery("/dashboard/summary", { storeId, date }),
    fallback: mockDashboardSummary,
  });
}

async function getProfitRows(storeId: string, dateFrom: string, dateTo: string) {
  const response = await fetchApi<{ items: DailySalesUnitProfit[] }>({
    label: "Profit rows",
    path: withQuery("/profits/daily-sales-units", {
      storeId,
      dateFrom,
      dateTo,
      page: 1,
      pageSize: 50,
    }),
    fallback: { items: mockProfits },
  });

  return { ...response, data: response.data.items };
}

async function getDailySalesUnitDetail(
  storeId: string,
  salesUnitId: string,
  date: string,
  fallbackRow?: DailySalesUnitProfit | null,
) {
  return fetchApi<DailySalesUnitDetail>({
    label: "Profit detail",
    path: withQuery(`/profits/daily-sales-units/${salesUnitId}`, {
      storeId,
      date,
    }),
    fallback:
      createMockDailySalesUnitDetail(fallbackRow) ??
      createMockDailySalesUnitDetail(mockProfits[0])!,
  });
}

async function getUnmappedSummary(storeId: string, dateFrom: string, dateTo: string) {
  return fetchApi({
    label: "Unmapped summary",
    path: withQuery("/profits/unmapped-summary", { storeId, dateFrom, dateTo }),
    fallback: mockUnmappedSummary,
  });
}

async function getOperations(storeId: string, operationType?: string) {
  const response = await fetchApi<{ items: Array<Record<string, unknown>> }>({
    label: "Operations",
    path: withQuery("/operations", {
      storeId,
      operationType,
      page: 1,
      pageSize: 20,
    }),
    fallback: {
      items: mockOperations as unknown as Array<Record<string, unknown>>,
    },
  });

  const items = response.data.items.map((item) => ({
    operationId: String(item.operationId ?? item.id),
    operationType: String(item.operationType) as OperationListItem["operationType"],
    status: String(item.status) as OperationListItem["status"],
    createdAt: String(item.createdAt),
    startedAt: item.startedAt ? String(item.startedAt) : null,
    finishedAt: item.finishedAt ? String(item.finishedAt) : null,
    cutoffAt: String(item.cutoffAt),
    errorMessage: item.errorMessage ? String(item.errorMessage) : null,
  }));

  return { ...response, data: items };
}

async function getOperationDetail(operationId: string) {
  return fetchApi<OperationDetail>({
    label: "Operation detail",
    path: `/operations/${operationId}`,
    fallback: mockOperationDetail,
  });
}

async function getOrderItems(storeId: string, filters: OrdersPageFilters) {
  const response = await fetchApi<{ items: OrderListItem[] }>({
    label: "Order items",
    path: withQuery("/order-items", {
      storeId,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      productName: filters.productName || undefined,
      optionInfo: filters.optionInfo || undefined,
      mappingStatus: filters.mappingStatus,
      orderStatus: filters.orderStatus || undefined,
      saleStatus: filters.saleStatus === "ALL" ? undefined : filters.saleStatus,
      paymentDateStatus: filters.paymentDateStatus,
      page: 1,
      pageSize: 50,
    }),
    fallback: { items: mockOrderItems },
  });

  return { ...response, data: response.data.items };
}

async function getOrderSourceSignatures(
  storeId: string,
  filters?: Pick<OrdersPageFilters, "mappingStatus" | "productName" | "optionInfo">,
) {
  const response = await fetchApi<{ items: OrderSourceSignatureListItem[] }>({
    label: "Order signatures",
    path: withQuery("/order-source-signatures", {
      storeId,
      mappingStatus: filters?.mappingStatus ?? "ALL",
      q: [filters?.productName, filters?.optionInfo].filter(Boolean).join(" ") || undefined,
      page: 1,
      pageSize: 50,
    }),
    fallback: { items: mockSignatures },
  });
  return { ...response, data: response.data.items };
}

async function getSalesUnits(storeId: string) {
  const response = await fetchApi<{ items: SalesUnitListItem[] }>({
    label: "Sales units",
    path: withQuery("/canonical-sales-units", {
      storeId,
      page: 1,
      pageSize: 100,
    }),
    fallback: { items: mockSalesUnits },
  });
  return { ...response, data: response.data.items };
}

async function getAdUploads(storeId: string) {
  const response = await fetchApi<{ items: AdUploadListItem[] }>({
    label: "Ad uploads",
    path: withQuery("/ad-uploads", {
      storeId,
      page: 1,
      pageSize: 20,
    }),
    fallback: { items: mockUploads },
  });
  return { ...response, data: response.data.items };
}

async function getPreviewRows(uploadId: string, salesUnits: SalesUnitListItem[]) {
  const response = await fetchApi<{ items: Array<Record<string, unknown>> }>({
    label: "Ad preview rows",
    path: withQuery(`/ad-uploads/${uploadId}/preview-rows`, {
      page: 1,
      pageSize: 50,
    }),
    fallback: { items: mockPreviewRows as unknown as Array<Record<string, unknown>> },
  });

  const items = response.data.items.map((item, index) => {
    const canonicalSalesUnitId = item.canonicalSalesUnitId ? String(item.canonicalSalesUnitId) : null;
    const mappingReason = toMappingReason(item.mappingReason ? String(item.mappingReason) : null);
    return {
      rowNo: index + 1,
      campaignId: String(item.campaignId),
      campaignName: String(item.campaignName),
      adType: item.adType ? String(item.adType) : null,
      adStatus: item.status ? String(item.status) : null,
      weekdayLabel: item.weekday ? String(item.weekday) : null,
      totalCost: Number(item.totalCost ?? 0),
      mappingStatus: canonicalSalesUnitId ? "MAPPED" : "UNMAPPED",
      mappingReason,
      displayMappingState:
        mappingReason === "INTENTIONALLY_UNMAPPED"
          ? "INTENTIONALLY_UNMAPPED"
          : canonicalSalesUnitId
            ? "MAPPED"
            : "UNMAPPED",
      matchedRuleCount: Number(item.matchedRuleCount ?? 0),
      canonicalSalesUnitId,
      canonicalDisplayName:
        salesUnits.find((salesUnit) => salesUnit.id === canonicalSalesUnitId)?.displayName ?? null,
      reasonNote: item.reasonNote ? String(item.reasonNote) : null,
      reasonNoteInherited: Boolean(item.reasonNoteInherited),
    } satisfies AdPreviewRowItem;
  });

  return { ...response, data: items };
}

async function getAdCosts(storeId: string, dateFrom: string, dateTo: string, salesUnits: SalesUnitListItem[]) {
  const response = await fetchApi<{ items: Array<Record<string, unknown>> }>({
    label: "Ad costs",
    path: withQuery("/ad-campaign-costs", {
      storeId,
      dateFrom,
      dateTo,
      page: 1,
      pageSize: 50,
    }),
    fallback: { items: mockAdCosts as unknown as Array<Record<string, unknown>> },
  });

  const items = response.data.items.map((item) => {
    const canonicalSalesUnitId = item.canonicalSalesUnitId ? String(item.canonicalSalesUnitId) : null;
    const mappingReason = toMappingReason(item.mappingReason ? String(item.mappingReason) : null);
    return {
      id: String(item.id),
      uploadId: String(item.sourceUploadId ?? item.uploadId ?? ""),
      reportDate: String(item.reportDate),
      campaignName: String(item.campaignName),
      totalCost: Number(item.totalCost ?? 0),
      canonicalSalesUnitId,
      canonicalDisplayName:
        salesUnits.find((salesUnit) => salesUnit.id === canonicalSalesUnitId)?.displayName ?? null,
      mappingStatus: canonicalSalesUnitId ? "MAPPED" : "UNMAPPED",
      mappingReason,
      matchedRuleCount: Number(item.matchedRuleCount ?? 0),
      reasonNote: item.reasonNote ? String(item.reasonNote) : null,
    } satisfies CampaignCostListItem;
  });

  return { ...response, data: items };
}

async function getCampaignMappings(storeId: string, salesUnits: SalesUnitListItem[]) {
  const response = await fetchApi<{ items: Array<Record<string, unknown>> }>({
    label: "Campaign mappings",
    path: withQuery("/campaign-mappings", {
      storeId,
      page: 1,
      pageSize: 50,
    }),
    fallback: { items: mockCampaignMappings as unknown as Array<Record<string, unknown>> },
  });

  const items = response.data.items.map((item) => ({
    id: String(item.id),
    storeId: String(item.storeId),
    adChannel: "NAVER_DA",
    matchType: "CONTAINS",
    campaignPattern: String(item.campaignPattern),
    normalizedCampaignPattern: String(item.normalizedCampaignPattern),
    canonicalSalesUnitId: String(item.canonicalSalesUnitId),
    canonicalDisplayName:
      salesUnits.find((salesUnit) => salesUnit.id === item.canonicalSalesUnitId)?.displayName ?? "-",
    isEnabled: Boolean(item.isActive),
    disabledAt: item.deactivatedAt ? String(item.deactivatedAt) : null,
  })) satisfies CampaignMappingRuleListItem[];

  return { ...response, data: items };
}

async function getCostSettings(storeId: string, salesUnits: SalesUnitListItem[]) {
  const response = await fetchApi<Array<Record<string, unknown>>>({
    label: "Cost settings",
    path: withQuery("/sales-unit-cost-settings", { storeId }),
    fallback: mockCostSettings as unknown as Array<Record<string, unknown>>,
  });

  const items = response.data.map((item) => ({
    id: String(item.id),
    storeId: String(item.storeId),
    canonicalSalesUnitId: String(item.canonicalSalesUnitId),
    canonicalDisplayName:
      salesUnits.find((salesUnit) => salesUnit.id === item.canonicalSalesUnitId)?.displayName ?? "-",
    unitCost: Number(item.unitCost ?? 0),
    feeRate: item.feeRate == null ? null : Number(item.feeRate),
    otherCost: Number(item.otherCost ?? 0),
    appliedOrderItemCount: Number(item.appliedOrderItemCount ?? 0),
    canEdit: Boolean(item.canEdit),
    canClose: Boolean(item.canClose),
    canDeactivate: Boolean(item.canDeactivate),
    blockingReason: item.blockingReason ? String(item.blockingReason) : null,
    effectiveFrom: String(item.effectiveFrom),
    effectiveTo: item.effectiveTo ? String(item.effectiveTo) : null,
    isActive: Boolean(item.isActive),
  })) satisfies CostSettingListItem[];

  return { ...response, data: items };
}

export async function getShellData(): Promise<ShellData> {
  const storeResponse = await getStores();
  return {
    primaryStore: pickPrimaryStore(storeResponse.data),
    storeSource: storeResponse.source,
    today: nowInSeoul(),
  };
}

export async function getDashboardPageData(): Promise<DashboardPageData> {
  const storeResponse = await getStores();
  const primaryStore = pickPrimaryStore(storeResponse.data);

  if (!primaryStore) {
    return {
      primaryStore: null,
      selectedDate: MOCK_SELECTED_DATE,
      summary: mockDashboardSummary,
      profits: [],
      recentOperations: [],
      sources: collectSources(storeResponse),
    };
  }

  const [summaryResponse, profitResponse, operationResponse] = await Promise.all([
    getDashboardSummary(primaryStore.id, MOCK_SELECTED_DATE),
    getProfitRows(primaryStore.id, MOCK_SELECTED_DATE, MOCK_SELECTED_DATE),
    getOperations(primaryStore.id),
  ]);

  return {
    primaryStore,
    selectedDate: MOCK_SELECTED_DATE,
    summary: summaryResponse.data,
    profits: profitResponse.data,
    recentOperations: operationResponse.data.slice(0, 4),
    sources: collectSources(storeResponse, summaryResponse, profitResponse, operationResponse),
  };
}

export async function getStoreSettingsPageData(): Promise<StoreSettingsPageData> {
  const storeResponse = await getStores();
  const primaryStore = pickPrimaryStore(storeResponse.data);

  if (!primaryStore) {
    return {
      stores: storeResponse.data,
      primaryStore: null,
      credential: null,
      sources: collectSources(storeResponse),
    };
  }

  const credentialResponse = await getCredential(primaryStore.id);
  return {
    stores: storeResponse.data,
    primaryStore,
    credential: credentialResponse.data,
    sources: collectSources(storeResponse, credentialResponse),
  };
}

export async function getOrdersPageData(
  filtersInput?: Partial<OrdersPageFilters>,
): Promise<OrdersPageData> {
  const storeResponse = await getStores();
  const primaryStore = pickPrimaryStore(storeResponse.data);
  const filters = normalizeOrdersPageFilters(filtersInput);

  if (!primaryStore) {
    return {
      primaryStore: null,
      filters,
      orderItems: [],
      signatures: [],
      latestOperation: null,
      sources: collectSources(storeResponse),
    };
  }

  const [orderResponse, signatureResponse, operationListResponse] = await Promise.all([
    getOrderItems(primaryStore.id, filters),
    getOrderSourceSignatures(primaryStore.id, {
      mappingStatus: filters.mappingStatus,
      productName: filters.productName,
      optionInfo: filters.optionInfo,
    }),
    getOperations(primaryStore.id, "ORDER_SYNC"),
  ]);
  const firstOperation = operationListResponse.data[0];
  const operationDetailResponse = firstOperation
    ? await getOperationDetail(firstOperation.operationId)
    : null;

  return {
    primaryStore,
    filters,
    orderItems: orderResponse.data,
    signatures: signatureResponse.data,
    latestOperation: operationDetailResponse?.data ?? null,
    sources: collectSources(
      storeResponse,
      orderResponse,
      signatureResponse,
      operationListResponse,
      ...(operationDetailResponse ? [operationDetailResponse] : []),
    ),
  };
}

export async function getSalesUnitsPageData(): Promise<SalesUnitsPageData> {
  const storeResponse = await getStores();
  const primaryStore = pickPrimaryStore(storeResponse.data);

  if (!primaryStore) {
    return {
      primaryStore: null,
      salesUnits: [],
      costSettings: [],
      sources: collectSources(storeResponse),
    };
  }

  const salesUnitResponse = await getSalesUnits(primaryStore.id);
  const costResponse = await getCostSettings(primaryStore.id, salesUnitResponse.data);
  return {
    primaryStore,
    salesUnits: salesUnitResponse.data,
    costSettings: costResponse.data,
    sources: collectSources(storeResponse, salesUnitResponse, costResponse),
  };
}

export async function getMappingsPageData(): Promise<MappingsPageData> {
  const storeResponse = await getStores();
  const primaryStore = pickPrimaryStore(storeResponse.data);

  if (!primaryStore) {
    return {
      primaryStore: null,
      salesUnits: [],
      signatures: [],
      adCosts: [],
      campaignMappings: [],
      sources: collectSources(storeResponse),
    };
  }

  const salesUnitResponse = await getSalesUnits(primaryStore.id);
  const [signatureResponse, adCostResponse, campaignMappingResponse] = await Promise.all([
    getOrderSourceSignatures(primaryStore.id, {
      mappingStatus: "ALL",
      productName: "",
      optionInfo: "",
    }),
    getAdCosts(primaryStore.id, MOCK_DATE_FROM, MOCK_DATE_TO, salesUnitResponse.data),
    getCampaignMappings(primaryStore.id, salesUnitResponse.data),
  ]);

  return {
    primaryStore,
    salesUnits: salesUnitResponse.data,
    signatures: signatureResponse.data,
    adCosts: adCostResponse.data,
    campaignMappings: campaignMappingResponse.data,
    sources: collectSources(
      storeResponse,
      salesUnitResponse,
      signatureResponse,
      adCostResponse,
      campaignMappingResponse,
    ),
  };
}

export async function getAdUploadsPageData(): Promise<AdUploadsPageData> {
  const storeResponse = await getStores();
  const primaryStore = pickPrimaryStore(storeResponse.data);

  if (!primaryStore) {
    return {
      primaryStore: null,
      uploads: [],
      preview: null,
      previewRows: [],
      sources: collectSources(storeResponse),
    };
  }

  const salesUnitResponse = await getSalesUnits(primaryStore.id);
  const uploadsResponse = await getAdUploads(primaryStore.id);
  const previewUpload =
    uploadsResponse.data.find((upload) => upload.uploadStatus === "PREVIEW_PARSED") ??
    uploadsResponse.data[0] ??
    null;
  const previewRowsResponse = previewUpload
    ? await getPreviewRows(previewUpload.uploadId, salesUnitResponse.data)
    : null;

  const preview: AdPreviewSummary | null = previewUpload
    ? {
        ...mockPreview,
        uploadId: previewUpload.uploadId,
        reportDate: previewUpload.reportDate,
        detectedWeekday: previewUpload.detectedWeekday ?? mockPreview.detectedWeekday,
        weekdayValidationStatus: previewUpload.weekdayValidationStatus,
        replaceCandidateUploadId: previewUpload.replacedUploadId,
        rowCount: previewRowsResponse?.data.length ?? 0,
        mappingPreviewSummary: {
          mappedCount: previewRowsResponse?.data.filter((row) => row.mappingStatus === "MAPPED").length ?? 0,
          unmappedCount: previewRowsResponse?.data.filter((row) => row.mappingStatus === "UNMAPPED").length ?? 0,
          multipleRuleMatchCount:
            previewRowsResponse?.data.filter((row) => row.mappingReason === "MULTIPLE_RULE_MATCHES").length ?? 0,
          intentionallyUnmappedCount:
            previewRowsResponse?.data.filter((row) => row.mappingReason === "INTENTIONALLY_UNMAPPED").length ?? 0,
        },
      }
    : null;

  return {
    primaryStore,
    uploads: uploadsResponse.data,
    preview,
    previewRows: previewRowsResponse?.data ?? [],
    sources: collectSources(
      storeResponse,
      salesUnitResponse,
      uploadsResponse,
      ...(previewRowsResponse ? [previewRowsResponse] : []),
    ),
  };
}

export async function getCostsPageData(): Promise<CostsPageData> {
  const storeResponse = await getStores();
  const primaryStore = pickPrimaryStore(storeResponse.data);

  if (!primaryStore) {
    return {
      primaryStore: null,
      salesUnits: [],
      costSettings: [],
      sources: collectSources(storeResponse),
    };
  }

  const salesUnitResponse = await getSalesUnits(primaryStore.id);
  const costResponse = await getCostSettings(primaryStore.id, salesUnitResponse.data);
  return {
    primaryStore,
    salesUnits: salesUnitResponse.data,
    costSettings: costResponse.data,
    sources: collectSources(storeResponse, salesUnitResponse, costResponse),
  };
}

export async function getProfitsPageData(params?: {
  dateFrom?: string;
  dateTo?: string;
}): Promise<ProfitsPageData> {
  const dateFrom = params?.dateFrom?.trim() || MOCK_DATE_FROM;
  const dateTo = params?.dateTo?.trim() || MOCK_DATE_TO;
  const storeResponse = await getStores();
  const primaryStore = pickPrimaryStore(storeResponse.data);

  if (!primaryStore) {
    return {
      primaryStore: null,
      dateFrom,
      dateTo,
      summary: mockDashboardSummary,
      profits: [],
      unmappedSummary: mockUnmappedSummary,
      selectedDetail: null,
      sources: collectSources(storeResponse),
    };
  }

  const [summaryResponse, profitResponse, unmappedResponse] = await Promise.all([
    getDashboardSummary(primaryStore.id, dateTo || MOCK_SELECTED_DATE),
    getProfitRows(primaryStore.id, dateFrom, dateTo),
    getUnmappedSummary(primaryStore.id, dateFrom, dateTo),
  ]);

  const firstProfit = profitResponse.data[0] ?? null;
  const detailResponse =
    firstProfit != null
      ? await getDailySalesUnitDetail(
          primaryStore.id,
          firstProfit.canonicalSalesUnitId,
          firstProfit.date,
          firstProfit,
        )
      : null;

  return {
    primaryStore,
    dateFrom,
    dateTo,
    summary: summaryResponse.data,
    profits: profitResponse.data,
    unmappedSummary: unmappedResponse.data,
    selectedDetail: detailResponse?.data ?? null,
    sources: collectSources(
      storeResponse,
      summaryResponse,
      profitResponse,
      unmappedResponse,
      ...(detailResponse ? [detailResponse] : []),
    ),
  };
}

export async function getOperationsPageData(): Promise<OperationsPageData> {
  const storeResponse = await getStores();
  const primaryStore = pickPrimaryStore(storeResponse.data);

  if (!primaryStore) {
    return {
      primaryStore: null,
      operations: [],
      selectedOperation: null,
      sources: collectSources(storeResponse),
    };
  }

  const operationListResponse = await getOperations(primaryStore.id);
  const firstOperation = operationListResponse.data[0];
  const operationDetailResponse = firstOperation
    ? await getOperationDetail(firstOperation.operationId)
    : null;

  return {
    primaryStore,
    operations: operationListResponse.data,
    selectedOperation: operationDetailResponse?.data ?? null,
    sources: collectSources(
      storeResponse,
      operationListResponse,
      ...(operationDetailResponse ? [operationDetailResponse] : []),
    ),
  };
}
