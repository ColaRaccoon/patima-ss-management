import type {
  DashboardSummary,
  DailySalesUnitProfit,
  OperationStatus,
  OperationType,
  ProfitStatus,
  SaleStatus,
  WeekdayValidationStatus,
} from "@patima/shared";

export type DataSource = "live" | "mock";

export interface SourceState {
  label: string;
  source: DataSource;
  endpoint: string;
  error?: string;
}

export interface ApiEnvelope<T> extends SourceState {
  data: T;
}

export interface StoreListItem {
  id: string;
  name: string;
  platformType: "NAVER_SMARTSTORE";
  sellerAccountId: string;
  channelNo: string;
  isPrimary: boolean;
  isActive: boolean;
  lastOrderSyncAt: string | null;
  lastOrderSyncStatus: "SUCCEEDED" | "FAILED" | "NEVER";
  credentialConnectionStatus: "SUCCEEDED" | "FAILED" | "NOT_TESTED";
  lastCredentialTestAt: string | null;
  memo?: string | null;
}

export interface CredentialSummary {
  credentialId: string | null;
  storeId: string;
  maskedClientId: string | null;
  accessType: "SELLER";
  secretStored: boolean;
  credentialConnectionStatus: "SUCCEEDED" | "FAILED" | "NOT_TESTED";
  lastCredentialTestAt: string | null;
  credentialSource?: "DATABASE" | "ENV" | "NONE";
}

export interface CredentialTestResult {
  storeId: string;
  connectionStatus: "SUCCEEDED";
  testedAt: string;
  credentialSource: "DATABASE" | "ENV";
  sellerAccountId: string;
  sellerName: string | null;
  channelNo: string;
  channelName: string | null;
}

export interface OrderListItem {
  id: string;
  orderRecordId: string;
  externalOrderId: string;
  orderSourceSignatureId: string | null;
  canonicalSalesUnitId: string | null;
  rawProductName: string;
  rawOptionInfo: string | null;
  sourceSignature: string;
  displayName: string | null;
  quantity: number;
  productPaymentAmount: number;
  packageNumber: string | null;
  deliveryFeeAmount: number | null;
  paymentCommission: number | null;
  knowledgeShoppingSellingInterlockCommission: number | null;
  saleCommission: number | null;
  channelCommission: number | null;
  paymentDate: string | null;
  orderStatus: string;
  saleStatus: SaleStatus;
  mappingStatus: "MAPPED" | "UNMAPPED" | "CONFLICT";
}

export interface OrderSourceSignatureListItem {
  id: string;
  rawProductNameSnapshot: string;
  rawOptionInfoSnapshot: string | null;
  sourceSignature: string;
  mappingStatus: "MAPPED" | "UNMAPPED" | "CONFLICT";
  canonicalSalesUnitId: string | null;
  canonicalDisplayName: string | null;
  usageCount: number;
  externalProductId: string | null;
  optionCode: string | null;
}

export interface SalesUnitListItem {
  id: string;
  storeId: string;
  displayName: string;
  matchAliases: string[];
  linkedProductIds: string[];
  linkedOptionCodes: string[];
  memo: string | null;
  isActive: boolean;
  deactivatedAt: string | null;
  isStoreLevel: boolean;
}

export interface AdUploadListItem {
  uploadId: string;
  reportDate: string;
  detectedWeekday: string | null;
  weekdayValidationStatus: WeekdayValidationStatus;
  uploadStatus: "PREVIEW_PARSED" | "CONFIRMED" | "FAILED" | "REPLACED" | "EXPIRED" | "DELETED";
  isActive: boolean;
  originalFileName?: string | null;
  createdAt?: string;
  previewExpiresAt?: string | null;
  ruleSnapshotHash?: string | null;
  overrideSnapshotHash?: string | null;
  replacedPreviousUpload?: boolean;
  replacedUploadId?: string | null;
}

export interface AdPreviewSummary {
  uploadId: string;
  rowCount: number;
  reportDate: string;
  detectedWeekday: string;
  weekdayValidationStatus: WeekdayValidationStatus;
  activeConfirmedUploadCount: number;
  previewExpiresAt: string;
  previewState: "VALID" | "STALE" | "EXPIRED";
  ruleSnapshotHash: string;
  overrideSnapshotHash: string;
  replaceCandidateUploadId?: string | null;
  mappingPreviewSummary: {
    mappedCount: number;
    unmappedCount: number;
    conflictCount: number;
    multipleRuleMatchCount: number;
    intentionallyUnmappedCount: number;
  };
  requiresConfirm: boolean;
  status: "PREVIEW_PARSED";
}

export interface AdPreviewDetail extends AdPreviewSummary {
  originalFileName: string | null;
  createdAt: string | null;
  rows: AdPreviewRowItem[];
}

export interface AdPreviewRowItem {
  rowNo: number;
  campaignId: string;
  campaignName: string;
  adType: string | null;
  adStatus: string | null;
  weekdayLabel: string | null;
  totalCost: number;
  mappingStatus: "MAPPED" | "UNMAPPED" | "CONFLICT";
  mappingReason:
    | "NO_RULE_MATCH"
    | "MULTIPLE_RULE_MATCHES"
    | "MANUAL_MAPPED"
    | "INTENTIONALLY_UNMAPPED"
    | null;
  displayMappingState: "MAPPED" | "UNMAPPED" | "CONFLICT" | "INTENTIONALLY_UNMAPPED";
  matchedRuleCount: number;
  canonicalSalesUnitId: string | null;
  canonicalDisplayName: string | null;
  reasonNote: string | null;
  reasonNoteInherited: boolean;
}

export interface CampaignCostListItem {
  id: string;
  uploadId: string;
  reportDate: string;
  campaignName: string;
  totalCost: number;
  canonicalSalesUnitId: string | null;
  canonicalDisplayName: string | null;
  mappingStatus: "MAPPED" | "UNMAPPED" | "CONFLICT";
  mappingReason:
    | "NO_RULE_MATCH"
    | "MULTIPLE_RULE_MATCHES"
    | "MANUAL_MAPPED"
    | "INTENTIONALLY_UNMAPPED"
    | null;
  matchedRuleCount: number;
  reasonNote: string | null;
}

export interface CampaignMappingRuleListItem {
  id: string;
  storeId: string;
  adChannel: "NAVER_DA";
  matchType: "CONTAINS";
  campaignPattern: string;
  normalizedCampaignPattern: string;
  canonicalSalesUnitId: string;
  canonicalDisplayName: string;
  isEnabled: boolean;
  disabledAt: string | null;
}

export interface CostSettingListItem {
  id: string;
  storeId: string;
  canonicalSalesUnitId: string;
  canonicalDisplayName: string;
  unitCost: number;
  feeRate: number | null;
  otherCost: number;
  appliedOrderItemCount: number;
  canEdit: boolean;
  canClose: boolean;
  canDeactivate: boolean;
  blockingReason: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

export interface OperationListItem {
  operationId: string;
  operationType: OperationType;
  status: OperationStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cutoffAt: string;
  errorMessage: string | null;
}

export interface OperationDetail {
  operationId: string;
  storeId: string;
  operationType: OperationType;
  status: OperationStatus;
  cutoffAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  requestSummary: Record<string, unknown> | null;
  resultSummary: Record<string, unknown> | null;
}

export interface UnmappedSummary {
  unmappedOrderItemCount: number;
  unmappedOrderRevenue: number;
  conflictOrderItemCount: number;
  conflictOrderRevenue: number;
  unmappedCampaignCount: number;
  unmappedAdCost: number;
  conflictCampaignCount: number;
  conflictAdCost: number;
  intentionalUnmappedCampaignCount: number;
  intentionalUnmappedAdCost: number;
}

export interface ProfitDetailPreview {
  displayName: string;
  orderCount: number;
  adCampaignCount: number;
  deliveryFeeReferenceTotal: number;
  fallbackFeeCostPortion: number;
  profitStatus: ProfitStatus;
}

export interface DailySalesUnitDetail {
  date: string;
  canonicalSalesUnitId: string;
  displayName: string;
  summary: DailySalesUnitProfit;
  orderItems: Array<{
    orderItemId: string;
    orderId: string;
    orderStatus: string;
    saleStatus: SaleStatus;
    quantity: number;
    productPaymentAmount: number;
    deliveryFeeAmount: number | null;
  }>;
  adCampaigns: Array<{
    adCostId: string;
    campaignName: string;
    reportDate: string;
    totalCost: number;
  }>;
  deliveryFeeSummary: {
    totalDeliveryFeeAmount: number;
    includedInProductRevenue: boolean;
    includedInEstimatedNetProfit: boolean;
  };
  costBreakdown: {
    costSettingStatus: ProfitStatus;
    unitCostPerQuantity: number;
    otherCostPerQuantity: number;
    feeRateFallback: number | null;
    computedFeeCost: number;
    fallbackFeeCostPortion: number;
    aggregatedFeeCandidates: {
      paymentCommission: number;
      knowledgeShoppingSellingInterlockCommission: number;
      saleCommission: number;
      channelCommission: number;
    };
  };
  excludedSummary: {
    excludedOrderRevenue: number;
    excludedAdCost: number;
    excludedUnmappedOrderRevenue: number;
    excludedConflictOrderRevenue: number;
    excludedNonSaleOrderRevenue: number;
    excludedUnmappedAdCost: number;
    excludedConflictAdCost: number;
    excludedIntentionalUnmappedAdCost: number;
    excludedOrderStatusCounts: {
      CANCELED: number;
      CANCEL_REQUESTED: number;
      RETURNED: number;
      EXCHANGED: number;
    };
  };
}

export interface ShellData {
  primaryStore: StoreListItem | null;
  storeSource: DataSource;
  today: string;
}

export interface DashboardPageData {
  primaryStore: StoreListItem | null;
  selectedDate: string;
  summary: DashboardSummary;
  profits: DailySalesUnitProfit[];
  recentOperations: OperationListItem[];
  sources: SourceState[];
}

export interface StoreSettingsPageData {
  stores: StoreListItem[];
  primaryStore: StoreListItem | null;
  credential: CredentialSummary | null;
  sources: SourceState[];
}

export interface OrdersPageFilters {
  dateFrom: string;
  dateTo: string;
  productName: string;
  optionInfo: string;
  mappingStatus: "ALL" | "MAPPED" | "UNMAPPED" | "CONFLICT";
  saleStatus: string;
  orderStatus: string;
  paymentDateStatus: "ALL" | "PRESENT" | "MISSING";
}

export interface OrdersPageData {
  primaryStore: StoreListItem | null;
  filters: OrdersPageFilters;
  orderItems: OrderListItem[];
  signatures: OrderSourceSignatureListItem[];
  latestOperation: OperationDetail | null;
  sources: SourceState[];
}

export interface SalesUnitsPageData {
  primaryStore: StoreListItem | null;
  salesUnits: SalesUnitListItem[];
  costSettings: CostSettingListItem[];
  sources: SourceState[];
}

export interface MappingsPageData {
  primaryStore: StoreListItem | null;
  salesUnits: SalesUnitListItem[];
  signatures: OrderSourceSignatureListItem[];
  adCosts: CampaignCostListItem[];
  campaignMappings: CampaignMappingRuleListItem[];
  sources: SourceState[];
}

export interface AdUploadsPageData {
  primaryStore: StoreListItem | null;
  uploads: AdUploadListItem[];
  previews: AdPreviewDetail[];
  sources: SourceState[];
}

export interface CostsPageData {
  primaryStore: StoreListItem | null;
  salesUnits: SalesUnitListItem[];
  costSettings: CostSettingListItem[];
  sources: SourceState[];
}

export interface ProfitsPageData {
  primaryStore: StoreListItem | null;
  dateFrom: string;
  dateTo: string;
  latestOrderDate: string | null;
  latestAdDate: string | null;
  latestOverlapDate: string | null;
  summary: DashboardSummary;
  profits: DailySalesUnitProfit[];
  unmappedSummary: UnmappedSummary;
  selectedDetail: DailySalesUnitDetail | null;
  sources: SourceState[];
}

export interface OperationsPageData {
  primaryStore: StoreListItem | null;
  operations: OperationListItem[];
  selectedOperation: OperationDetail | null;
  sources: SourceState[];
}
