// Constants for profit calculation
export const VAT_RATE = 0.1;
export const DEFAULT_DELIVERY_UNIT_COST = 3500;

export type OperationStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type OperationType =
  | "ORDER_SYNC"
  | "AD_UPLOAD_CONFIRM"
  | "RECALCULATE_ORDER_MAPPING"
  | "RECALCULATE_AD_MAPPING";
export type SaleStatus =
  | "SALE"
  | "CANCELED"
  | "CANCEL_REQUESTED"
  | "RETURNED"
  | "EXCHANGED"
  | "UNKNOWN";
export type MappingStatus = "MAPPED" | "UNMAPPED" | "CONFLICT";
export type ProfitStatus = "COMPLETE" | "INCOMPLETE_COST";
export type WeekdayValidationStatus =
  | "PENDING"
  | "PASSED"
  | "MISSING"
  | "MULTIPLE"
  | "MISMATCH";
export type UploadState =
  | "PREVIEW_PARSED"
  | "CONFIRMED"
  | "REPLACED"
  | "EXPIRED"
  | "DELETED";
export type CampaignMappingReason =
  | "RULE_MATCHED"
  | "MANUAL_MAPPED"
  | "NO_RULE"
  | "MULTIPLE_RULES"
  | "INTENTIONALLY_UNMAPPED";

export interface Store {
  id: string;
  name: string;
  platformType: "NAVER_SMARTSTORE";
  sellerAccountId: string;
  channelNo: string;
  isPrimary: boolean;
  isActive: boolean;
  deactivatedAt: string | null;
  memo: string | null;
  lastOrderSyncAt: string | null;
  lastOrderSyncStatus: "SUCCEEDED" | "FAILED" | "NEVER";
  credentialConnectionStatus: "SUCCEEDED" | "FAILED" | "NOT_TESTED";
  lastCredentialTestAt: string | null;
  deliveryUnitCost: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceCredential {
  id: string;
  storeId: string;
  clientId: string;
  clientSecretEncrypted: string;
  accessType: "SELLER";
  isEnabled: boolean;
  lastTokenIssuedAt: string | null;
  lastTokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  storeId: string;
  externalProductId: string;
  productName: string;
  normalizedProductName: string;
  status: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalSalesUnit {
  id: string;
  storeId: string;
  displayName: string;
  matchAliases: string[];
  normalizedMatchAliases: string[];
  linkedProductIds: string[];
  linkedOptionCodes: string[];
  linkedManageCodes: string[];
  memo: string | null;
  isActive: boolean;
  deactivatedAt: string | null;
  isStoreLevel: boolean;
  parentSalesUnitId: string | null;
  isGroup: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrderSourceSignature {
  id: string;
  storeId: string;
  sourceSignature: string;
  rawProductNameSnapshot: string;
  rawOptionInfoSnapshot: string | null;
  normalizedProductName: string;
  normalizedOptionInfo: string;
  canonicalSalesUnitId: string | null;
  mappingStatus: MappingStatus;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderRecord {
  id: string;
  storeId: string;
  externalOrderId: string;
  orderDatetime: string | null;
  paymentDatetime: string | null;
  orderStatus: string | null;
  rawPayload: Record<string, unknown> | null;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderItem {
  id: string;
  orderId: string;
  storeId: string;
  productId: string | null;
  orderSourceSignatureId: string | null;
  canonicalSalesUnitId: string | null;
  externalProductOrderId: string;
  externalProductId: string | null;
  optionCode: string | null;
  optionManageCode?: string;
  packageNumber: string | null;
  rawProductName: string;
  rawOptionInfo: string | null;
  normalizedProductName: string;
  normalizedOptionInfo: string;
  sourceSignature: string;
  quantity: number;
  productPaymentAmount: number;
  totalProductAmount: number | null;
  deliveryFeeAmount: number | null;
  paymentCommission: number | null;
  knowledgeShoppingSellingInterlockCommission: number | null;
  saleCommission: number | null;
  channelCommission: number | null;
  orderDate: string | null;
  paymentDate: string | null;
  saleStatus: SaleStatus;
  orderStatus: string;
  isCanceled: boolean;
  isReturned: boolean;
  rawPayload: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignSalesUnitMapping {
  id: string;
  storeId: string;
  channel: "NAVER_DA";
  canonicalSalesUnitId: string;
  campaignPattern: string;
  normalizedCampaignPattern: string;
  isActive: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdExcelUpload {
  id: string;
  storeId: string;
  sourceType: "NAVER_DA_XLSX";
  originalFileName: string;
  fileHash: string;
  reportDate: string;
  detectedWeekday: string | null;
  weekdayValidationStatus: WeekdayValidationStatus;
  replacedUploadId?: string | null;
  previewRuleSnapshotHash: string | null;
  previewOverrideSnapshotHash: string | null;
  previewCreatedAt: string | null;
  previewExpiresAt: string | null;
  state: UploadState;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdUploadPreviewRow {
  id: string;
  uploadId: string;
  storeId: string;
  reportDate: string;
  campaignId: string;
  campaignName: string;
  normalizedCampaignName: string;
  weekday: string | null;
  adType: string | null;
  status: string | null;
  totalCost: number;
  impressions: number;
  clicks: number;
  totalConversions: number;
  totalConversionSales: number;
  matchedRuleCount: number;
  canonicalSalesUnitId: string | null;
  mappingReason: CampaignMappingReason;
  reasonNote: string | null;
  reasonNoteInherited: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdCampaignDailyCost extends AdUploadPreviewRow {
  sourceUploadId: string;
}

export interface SalesUnitCostSetting {
  id: string;
  storeId: string;
  canonicalSalesUnitId: string;
  unitCost: number;
  feeRate: number | null;
  otherCost: number;
  isActive: boolean;
  deactivatedAt: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperationRecord {
  id: string;
  storeId: string;
  operationType: OperationType;
  status: OperationStatus;
  retryOfOperationId: string | null;
  requestedBy: string | null;
  requestJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  errorMessage: string | null;
  cutoffAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AuditLog {
  id: string;
  storeId: string | null;
  domain: string;
  action: string;
  targetId: string | null;
  actorType: "LOCALHOST_ADMIN";
  actorIdentifier: string | null;
  beforeJson: unknown | null;
  afterJson: unknown | null;
  createdAt: string;
}

export interface PaginationResult<T> {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNext: boolean;
  items: T[];
}

export interface DashboardSummary {
  date: string;
  // Kept for compatibility; currently equals totalProductRevenue and excludes shipping.
  totalRevenue: number;
  totalProductRevenue: number;
  totalDeliveryFeeAmount: number;
  totalAdCost: number;
  roughProfit: number;
  estimatedNetProfit: number | null;
  profitStatus: ProfitStatus;
  salesUnitCount: number;
  incompleteCostSalesUnitCount: number;
  unmappedOrderItemCount: number;
  conflictOrderItemCount: number;
  unmappedCampaignCount: number;
  conflictCampaignCount: number;
  intentionalUnmappedCampaignCount: number;
  excludedOrderRevenue: number;
  excludedUnmappedOrderRevenue: number;
  excludedConflictOrderRevenue: number;
  excludedNonSaleOrderRevenue: number;
  excludedAdCost: number;
  excludedUnmappedAdCost: number;
  excludedConflictAdCost: number;
  excludedIntentionalUnmappedAdCost: number;
  // VAT (부가세) fields
  totalVatAmount: number;
  totalVatAdjustedRevenue: number;
  // Delivery (배송비) fields
  uniquePackageCount: number;
  deliveryUnitCost: number;
  estimatedDeliveryBaseCost: number;
  customerPaidDeliveryFee: number;
  storeBorneDeliveryCost: number;
}

export interface DailySalesUnitProfit {
  date: string;
  canonicalSalesUnitId: string;
  displayName: string;
  totalQuantity: number;
  // Kept for compatibility; currently equals totalProductRevenue and excludes shipping.
  totalRevenue: number;
  totalProductRevenue: number;
  totalDeliveryFeeAmount: number;
  totalAdCost: number;
  totalUnitCost: number;
  totalFeeCost: number;
  totalOtherCost: number;
  roughProfit: number;
  estimatedNetProfit: number | null;
  profitStatus: ProfitStatus;
  // VAT (부가세) fields
  vatAmount: number;
  vatAdjustedRevenue: number;
  isStoreLevel?: boolean;
  isGroup?: boolean;
  parentSalesUnitId?: string | null;
  childRows?: DailySalesUnitProfit[];
}

export interface DailySalesUnitDetailRevenueBreakdown {
  productRevenueOriginal: number;
  vatRate: number;
  vatAmount: number;
  vatAdjustedRevenue: number;
  appliedInEstimatedNetProfit: true;
}

export interface DailySalesUnitDetailDeliveryContext {
  uniquePackageCount: number;
  deliveryUnitCost: number;
  estimatedDeliveryBaseCost: number;
  customerPaidDeliveryFee: number;
  storeBorneDeliveryCost: number;
  includedInThisSalesUnitNetProfit: false;
  note: string;
}

export interface DatabaseShape {
  stores: Store[];
  commerceCredentials: CommerceCredential[];
  products: Product[];
  canonicalSalesUnits: CanonicalSalesUnit[];
  orderSourceSignatures: OrderSourceSignature[];
  orders: OrderRecord[];
  orderItems: OrderItem[];
  campaignMappings: CampaignSalesUnitMapping[];
  adExcelUploads: AdExcelUpload[];
  adUploadPreviewRows: AdUploadPreviewRow[];
  adCampaignDailyCosts: AdCampaignDailyCost[];
  salesUnitCostSettings: SalesUnitCostSetting[];
  operations: OperationRecord[];
  auditLogs: AuditLog[];
}
