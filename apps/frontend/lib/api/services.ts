import type { DashboardSummary, DailySalesUnitProfit, SaleStatus } from "@patima/shared";
import { DEFAULT_DELIVERY_UNIT_COST } from "@patima/shared";
import { fetchApi, withQuery } from "@/lib/api/client";
import { pickPrimaryStore, resolveSelectedStore } from "@/lib/store-selection";
import {
  mockAdCosts,
  mockCampaignMappings,
  mockCostSettings,
  mockCredential,
  mockDashboardSummary,
  mockOperationDetail,
  mockOperations,
  mockOrderItems,
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
  AdPreviewDetail,
  AdPreviewRowItem,
  AdUploadListItem,
  AdUploadsPageData,
  CampaignCostListItem,
  CampaignMappingRuleListItem,
  CostsPageData,
  CostSettingListItem,
  CredentialSummary,
  DailyFakePurchaseResponse,
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

const MAX_FRONTEND_PAGE_SIZE = 200;
const USE_AD_UPLOADS_MOCK_FALLBACK = false;
const USE_PROFITS_MOCK_FALLBACK = false;

const toMappingReason = (value: string | null | undefined) => {
  switch (value) {
    case "NO_RULE":
    case "NO_RULE_MATCH":
      return "NO_RULE_MATCH";
    case "MULTIPLE_RULES":
    case "MULTIPLE_RULE_MATCHES":
      return "MULTIPLE_RULE_MATCHES";
    case "MANUAL_MAPPED":
      return "MANUAL_MAPPED";
    case "INTENTIONALLY_UNMAPPED":
      return "INTENTIONALLY_UNMAPPED";
    default:
      return null;
  }
};

const toAdMappingStatus = (
  canonicalSalesUnitId: string | null,
  mappingReason: ReturnType<typeof toMappingReason>,
) => {
  if (mappingReason === "MULTIPLE_RULE_MATCHES") {
    return "CONFLICT" as const;
  }

  return canonicalSalesUnitId ? ("MAPPED" as const) : ("UNMAPPED" as const);
};

async function fetchAllRecordPages<T>(params: {
  label: string;
  path: string;
  query: Record<string, string | number | boolean | null | undefined>;
  fallback?: T[];
}) {
  let page = 1;
  let collected: T[] = [];
  let baseResponse:
    | {
        label: string;
        source: "live" | "mock";
        endpoint: string;
        error?: string;
      }
    | null = null;

  while (true) {
    const response = await fetchApi<{
      items: T[];
      hasNext?: boolean;
      totalPages?: number;
    }>({
      label: params.label,
      path: withQuery(params.path, {
        ...params.query,
        page,
        pageSize: MAX_FRONTEND_PAGE_SIZE,
      }),
      ...("fallback" in params
        ? {
            fallback: { items: page === 1 ? (params.fallback ?? []) : [] },
          }
        : {}),
    });

    if (!baseResponse) {
      baseResponse = {
        label: response.label,
        source: response.source,
        endpoint: response.endpoint,
        ...(response.error ? { error: response.error } : {}),
      };
    }

    if (response.source === "mock") {
      return {
        ...response,
        data: response.data.items,
      };
    }

    collected.push(...response.data.items);

    if (!response.data.hasNext || page >= (response.data.totalPages ?? page)) {
      break;
    }

    page += 1;
  }

  return {
    ...baseResponse!,
    data: collected,
  };
}

function normalizeOrdersPageFilters(
  filters?: Partial<OrdersPageFilters>,
): OrdersPageFilters {
  const mappingStatus =
    filters?.mappingStatus === "MAPPED" ||
    filters?.mappingStatus === "UNMAPPED" ||
    filters?.mappingStatus === "CONFLICT"
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
    revenueBreakdown: {
      productRevenueOriginal: row.totalProductRevenue,
      vatRate: 0.1,
      vatAmount: row.vatAmount,
      vatAdjustedRevenue: row.vatAdjustedRevenue,
      appliedInEstimatedNetProfit: true,
    },
    deliveryContext: {
      uniquePackageCount: 0,
      deliveryUnitCost: DEFAULT_DELIVERY_UNIT_COST,
      estimatedDeliveryBaseCost: 0,
      customerPaidDeliveryFee: row.totalDeliveryFeeAmount,
      deliveryMargin: row.totalDeliveryFeeAmount,
      includedInThisSalesUnitNetProfit: false,
      note: "스토어 공통 배송 마진으로 대시보드에서만 순이익에 반영됩니다",
    },
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
      excludedConflictOrderRevenue: 0,
      excludedNonSaleOrderRevenue: 0,
      excludedUnmappedAdCost: 0,
      excludedConflictAdCost: 0,
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

async function getStores(useFallback = true) {
  return fetchApi<StoreListItem[]>({
    label: "Stores",
    path: "/stores",
    ...(useFallback ? { fallback: mockStores } : {}),
  });
}

async function getCredential(storeId: string) {
  return fetchApi<CredentialSummary>({
    label: "Credentials",
    path: `/stores/${storeId}/commerce-credentials`,
    fallback: mockCredential,
  });
}

async function getDashboardSummary(storeId: string, date: string, useFallback = true) {
  return fetchApi<DashboardSummary>({
    label: "Dashboard summary",
    path: withQuery("/dashboard/summary", { storeId, date }),
    ...(useFallback ? { fallback: mockDashboardSummary } : {}),
  });
}

async function getLatestProfitDate(storeId: string, useFallback = true) {
  return fetchApi<{
    date: string | null;
    latestOrderDate: string | null;
    latestAdDate: string | null;
    latestOverlapDate: string | null;
  }>({
    label: "Latest profit date",
    path: withQuery("/profits/latest-date", { storeId }),
    ...(useFallback
      ? {
          fallback: {
            date: MOCK_SELECTED_DATE,
            latestOrderDate: MOCK_SELECTED_DATE,
            latestAdDate: MOCK_SELECTED_DATE,
            latestOverlapDate: MOCK_SELECTED_DATE,
          },
        }
      : {}),
  });
}

async function getProfitRows(storeId: string, dateFrom: string, dateTo: string, useFallback = true) {
  const response = useFallback
    ? await fetchAllRecordPages<DailySalesUnitProfit>({
        label: "Profit rows",
        path: "/profits/daily-sales-units",
        query: {
          storeId,
          dateFrom,
          dateTo,
          includeGroupChildren: "true",
        },
        fallback: mockProfits,
      })
    : await fetchAllRecordPages<DailySalesUnitProfit>({
        label: "Profit rows",
        path: "/profits/daily-sales-units",
        query: {
          storeId,
          dateFrom,
          dateTo,
          includeGroupChildren: "true",
        },
      });

  return { ...response, data: response.data };
}

async function getDailySalesUnitDetail(
  storeId: string,
  salesUnitId: string,
  date: string,
  fallbackRow?: DailySalesUnitProfit | null,
  useFallback = true,
) {
  return fetchApi<DailySalesUnitDetail>({
    label: "Profit detail",
    path: withQuery(`/profits/daily-sales-units/${salesUnitId}`, {
      storeId,
      date,
    }),
    ...(useFallback
      ? {
          fallback:
            createMockDailySalesUnitDetail(fallbackRow) ??
            createMockDailySalesUnitDetail(mockProfits[0])!,
        }
      : {}),
  });
}

async function getUnmappedSummary(storeId: string, dateFrom: string, dateTo: string, useFallback = true) {
  return fetchApi({
    label: "Unmapped summary",
    path: withQuery("/profits/unmapped-summary", { storeId, dateFrom, dateTo }),
    ...(useFallback ? { fallback: mockUnmappedSummary } : {}),
  });
}

async function getDailyFakePurchase(storeId: string, date: string, useFallback = true) {
  return fetchApi<DailyFakePurchaseResponse>({
    label: "Daily fake purchase",
    path: withQuery("/daily-fake-purchases", { storeId, date }),
    ...(useFallback
      ? {
          fallback: {
            amount: 0,
            exists: false,
            updatedAt: null,
          },
        }
      : {}),
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
  const response = await fetchAllRecordPages<OrderSourceSignatureListItem>({
    label: "Order signatures",
    path: "/order-source-signatures",
    query: {
      storeId,
      mappingStatus: filters?.mappingStatus ?? "ALL",
      q: [filters?.productName, filters?.optionInfo].filter(Boolean).join(" ") || undefined,
    },
    fallback: mockSignatures,
  });
  return { ...response, data: response.data };
}

async function getSalesUnits(storeId: string, useFallback = true) {
  const response = useFallback
    ? await fetchAllRecordPages<SalesUnitListItem>({
        label: "Sales units",
        path: "/canonical-sales-units",
        query: {
          storeId,
        },
        fallback: mockSalesUnits,
      })
    : await fetchAllRecordPages<SalesUnitListItem>({
        label: "Sales units",
        path: "/canonical-sales-units",
        query: {
          storeId,
        },
      });

  return {
    ...response,
    data: response.data.map((item) => ({
      ...item,
      matchAliases:
        Array.isArray((item as Partial<SalesUnitListItem>).matchAliases) &&
        (item as Partial<SalesUnitListItem>).matchAliases
          ? (item as Partial<SalesUnitListItem>).matchAliases!
          : [],
    })),
  };
}

async function getAdUploads(storeId: string, useFallback = true) {
  const response = await fetchApi<{ items: AdUploadListItem[] }>({
    label: "Ad uploads",
    path: withQuery("/ad-uploads", {
      storeId,
      page: 1,
      pageSize: 20,
    }),
    ...(useFallback ? { fallback: { items: mockUploads } } : {}),
  });
  return { ...response, data: response.data.items };
}

async function getPreviewRows(
  uploadId: string,
  salesUnits: SalesUnitListItem[],
  useFallback = true,
) {
  const response = useFallback
    ? await fetchAllRecordPages<Record<string, unknown>>({
        label: "Ad preview rows",
        path: `/ad-uploads/${uploadId}/preview-rows`,
        query: {},
        fallback: mockPreviewRows as unknown as Array<Record<string, unknown>>,
      })
    : await fetchAllRecordPages<Record<string, unknown>>({
        label: "Ad preview rows",
        path: `/ad-uploads/${uploadId}/preview-rows`,
        query: {},
      });

  const items = response.data.map((item, index) => {
    const canonicalSalesUnitId = item.canonicalSalesUnitId ? String(item.canonicalSalesUnitId) : null;
    const mappingReason = toMappingReason(item.mappingReason ? String(item.mappingReason) : null);
    const mappingStatus = toAdMappingStatus(canonicalSalesUnitId, mappingReason);
    return {
      rowNo: Number(item.rowNo ?? index + 1),
      campaignId: String(item.campaignId),
      campaignName: String(item.campaignName),
      adType: item.adType ? String(item.adType) : null,
      adStatus: item.status ? String(item.status) : item.adStatus ? String(item.adStatus) : null,
      weekdayLabel:
        item.weekday ? String(item.weekday) : item.weekdayLabel ? String(item.weekdayLabel) : null,
      totalCost: Number(item.totalCost ?? 0),
      mappingStatus,
      mappingReason,
      displayMappingState:
        mappingReason === "INTENTIONALLY_UNMAPPED"
          ? "INTENTIONALLY_UNMAPPED"
          : mappingStatus,
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

async function getAdCosts(
  storeId: string,
  salesUnits: SalesUnitListItem[],
  dateFrom?: string,
  dateTo?: string,
) {
  const response = await fetchAllRecordPages({
    label: "Ad costs",
    path: "/ad-campaign-costs",
    query: {
      storeId,
      dateFrom,
      dateTo,
    },
    fallback: mockAdCosts as unknown as Array<Record<string, unknown>>,
  });

  const items = response.data.map((item) => {
    const canonicalSalesUnitId = item.canonicalSalesUnitId ? String(item.canonicalSalesUnitId) : null;
    const mappingReason = toMappingReason(item.mappingReason ? String(item.mappingReason) : null);
    const mappingStatus = toAdMappingStatus(canonicalSalesUnitId, mappingReason);
    return {
      id: String(item.id),
      uploadId: String(item.sourceUploadId ?? item.uploadId ?? ""),
      reportDate: String(item.reportDate),
      campaignName: String(item.campaignName),
      totalCost: Number(item.totalCost ?? 0),
      canonicalSalesUnitId,
      canonicalDisplayName:
        salesUnits.find((salesUnit) => salesUnit.id === canonicalSalesUnitId)?.displayName ?? null,
      mappingStatus,
      mappingReason,
      matchedRuleCount: Number(item.matchedRuleCount ?? 0),
      reasonNote: item.reasonNote ? String(item.reasonNote) : null,
    } satisfies CampaignCostListItem;
  });

  return { ...response, data: items };
}

async function getCampaignMappings(storeId: string, salesUnits: SalesUnitListItem[]) {
  const response = await fetchAllRecordPages<Record<string, unknown>>({
    label: "Campaign mappings",
    path: "/campaign-mappings",
    query: {
      storeId,
    },
    fallback: mockCampaignMappings as unknown as Array<Record<string, unknown>>,
  });

  const items = response.data.map((item) => ({
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

async function getCostSnapshots(storeId: string) {
  const response = await fetchApi<
    Array<Record<string, unknown>> | { snapshots?: Array<Record<string, unknown>> }
  >({
    label: "Cost snapshots",
    path: withQuery("/sales-unit-cost-snapshots", { storeId }),
    fallback: [],
  });

  const snapshots = Array.isArray(response.data)
    ? response.data
    : response.data.snapshots ?? [];
  const items = snapshots.map((item) => ({
    id: String(item.id),
    effectiveFrom: String(item.effectiveFrom),
    entryCount: Number(item.entryCount ?? 0),
    missingSalesUnitCount: Number(item.missingSalesUnitCount ?? 0),
    sourceFileName: item.sourceFileName ? String(item.sourceFileName) : null,
    createdAt: String(item.createdAt),
  }));

  return { ...response, data: items };
}

export async function getShellData(): Promise<ShellData> {
  const storeResponse = await getStores();
  return {
    stores: storeResponse.data,
    primaryStore: pickPrimaryStore(storeResponse.data),
    storeSource: storeResponse.source,
    today: nowInSeoul(),
  };
}

export async function getDashboardPageData(params?: {
  storeId?: string;
}): Promise<DashboardPageData> {
  const storeResponse = await getStores();
  const primaryStore = resolveSelectedStore(storeResponse.data, params?.storeId);

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

export async function getStoreSettingsPageData(params?: {
  storeId?: string;
}): Promise<StoreSettingsPageData> {
  const storeResponse = await getStores();
  const primaryStore = resolveSelectedStore(storeResponse.data, params?.storeId);

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
  filtersInput?: Partial<OrdersPageFilters> & { storeId?: string },
): Promise<OrdersPageData> {
  const storeResponse = await getStores();
  const primaryStore = resolveSelectedStore(storeResponse.data, filtersInput?.storeId);
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

export async function getSalesUnitsPageData(params?: {
  storeId?: string;
}): Promise<SalesUnitsPageData> {
  const storeResponse = await getStores();
  const primaryStore = resolveSelectedStore(storeResponse.data, params?.storeId);

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

export async function getMappingsPageData(params?: {
  storeId?: string;
}): Promise<MappingsPageData> {
  const storeResponse = await getStores();
  const primaryStore = resolveSelectedStore(storeResponse.data, params?.storeId);

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
    getAdCosts(primaryStore.id, salesUnitResponse.data),
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

export async function getAdUploadsPageData(params?: {
  storeId?: string;
}): Promise<AdUploadsPageData> {
  const storeResponse = await getStores(USE_AD_UPLOADS_MOCK_FALLBACK);
  const primaryStore = resolveSelectedStore(storeResponse.data, params?.storeId);

  if (!primaryStore) {
    return {
      primaryStore: null,
      uploads: [],
      previews: [],
      sources: collectSources(storeResponse),
    };
  }

  const uploadsResponse = await getAdUploads(primaryStore.id, USE_AD_UPLOADS_MOCK_FALLBACK);

  return {
    primaryStore,
    uploads: uploadsResponse.data,
    previews: [],
    sources: collectSources(
      storeResponse,
      uploadsResponse,
    ),
  };
}

export async function getCostsPageData(params?: {
  storeId?: string;
}): Promise<CostsPageData> {
  const storeResponse = await getStores();
  const primaryStore = resolveSelectedStore(storeResponse.data, params?.storeId);

  if (!primaryStore) {
    return {
      primaryStore: null,
      salesUnits: [],
      costSnapshots: [],
      sources: collectSources(storeResponse),
    };
  }

  const salesUnitResponse = await getSalesUnits(primaryStore.id);
  const snapshotResponse = await getCostSnapshots(primaryStore.id);
  return {
    primaryStore,
    salesUnits: salesUnitResponse.data,
    costSnapshots: snapshotResponse.data,
    sources: collectSources(storeResponse, salesUnitResponse, snapshotResponse),
  };
}

export async function getProfitsPageData(params?: {
  storeId?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<ProfitsPageData> {
  const requestedDateFrom = params?.dateFrom?.trim();
  const requestedDateTo = params?.dateTo?.trim();
  const storeResponse = await getStores(USE_PROFITS_MOCK_FALLBACK);
  const primaryStore = resolveSelectedStore(storeResponse.data, params?.storeId);

  if (!primaryStore) {
    const fallbackDate = requestedDateFrom || requestedDateTo || MOCK_SELECTED_DATE;
    return {
      primaryStore: null,
      dateFrom: fallbackDate,
      dateTo: fallbackDate,
      latestOrderDate: null,
      latestAdDate: null,
      latestOverlapDate: null,
      summary: mockDashboardSummary,
      profits: [],
      unmappedSummary: mockUnmappedSummary,
      fakePurchase: null,
      selectedDetail: null,
      sources: collectSources(storeResponse),
    };
  }

  const latestDateResponse =
    requestedDateFrom || requestedDateTo
      ? null
      : await getLatestProfitDate(primaryStore.id, USE_PROFITS_MOCK_FALLBACK);
  const resolvedDate =
    requestedDateFrom ||
    requestedDateTo ||
    latestDateResponse?.data.date ||
    nowInSeoul() ||
    MOCK_SELECTED_DATE;
  const dateFrom = requestedDateFrom || requestedDateTo || resolvedDate;
  const dateTo = requestedDateTo || requestedDateFrom || resolvedDate;

  const [summaryResponse, profitResponse, unmappedResponse, fakePurchaseResponse] = await Promise.all([
    getDashboardSummary(primaryStore.id, dateTo || MOCK_SELECTED_DATE, USE_PROFITS_MOCK_FALLBACK),
    getProfitRows(primaryStore.id, dateFrom, dateTo, USE_PROFITS_MOCK_FALLBACK),
    getUnmappedSummary(primaryStore.id, dateFrom, dateTo, USE_PROFITS_MOCK_FALLBACK),
    getDailyFakePurchase(primaryStore.id, dateTo || MOCK_SELECTED_DATE, USE_PROFITS_MOCK_FALLBACK),
  ]);

  const firstProfit = profitResponse.data[0] ?? null;
  const detailResponse =
    firstProfit != null
      ? await getDailySalesUnitDetail(
          primaryStore.id,
          firstProfit.canonicalSalesUnitId,
          firstProfit.date,
          firstProfit,
          USE_PROFITS_MOCK_FALLBACK,
        )
      : null;

  return {
    primaryStore,
    dateFrom,
    dateTo,
    latestOrderDate: latestDateResponse?.data.latestOrderDate ?? null,
    latestAdDate: latestDateResponse?.data.latestAdDate ?? null,
    latestOverlapDate: latestDateResponse?.data.latestOverlapDate ?? null,
    summary: summaryResponse.data,
    profits: profitResponse.data,
    unmappedSummary: unmappedResponse.data,
    fakePurchase: fakePurchaseResponse.data,
    selectedDetail: detailResponse?.data ?? null,
    sources: collectSources(
      storeResponse,
      ...(latestDateResponse ? [latestDateResponse] : []),
      summaryResponse,
      profitResponse,
      unmappedResponse,
      fakePurchaseResponse,
      ...(detailResponse ? [detailResponse] : []),
    ),
  };
}

export async function getOperationsPageData(params?: {
  storeId?: string;
}): Promise<OperationsPageData> {
  const storeResponse = await getStores();
  const primaryStore = resolveSelectedStore(storeResponse.data, params?.storeId);

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
