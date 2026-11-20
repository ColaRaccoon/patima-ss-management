export interface ProductOrderContext {
  id: string;
  productName: string;
  optionInfo: string | null;
  usageCount: number;
}

export interface ProductRegistrationResult {
  salesUnitId: string;
  configurations: Array<{ salesUnitId: string; displayName: string; costSettingId: string | null }>;
  recalculationPending?: boolean;
}

export interface ProductEditData {
  version: string;
  date: string;
  effectiveFrom: string;
  product: { id: string; displayName: string; matchAliases: string[]; memo: string | null; isGroup: boolean };
  configurations: Array<{
    id: string;
    name: string;
    usesProductName: boolean;
    isActive: boolean;
    matchAliases: string[];
    linkedProductIds: string[];
    linkedOptionCodes: string[];
    linkedManageCodes: string[];
    memo: string | null;
    canChangeExistingCost: boolean;
    cost: {
      source: "INDIVIDUAL" | "EXCEL";
      sourceFileName: string | null;
      effectiveFrom: string;
      unitCost: number;
      otherCost: number;
      feeRate: number | null;
    } | null;
  }>;
}

interface ProductProfitStatus {
  state: "WAITING" | "INCOMPLETE_COST" | "COMPLETE";
  estimatedNetProfit: number | null;
}

export interface ProductStatus {
  storeId: string;
  date: string;
  product: { id: string; displayName: string; isGroup: boolean; isActive: boolean };
  configurations: Array<{
    id: string;
    displayName: string;
    isActive: boolean;
    cost: {
      source: "INDIVIDUAL" | "EXCEL";
      unitCost: number;
      feeRate: number | null;
      otherCost: number;
      effectiveFrom: string;
      sourceFileName: string | null;
    } | null;
    order: {
      state: "WAITING" | "REVIEW" | "CONNECTED";
      mappedSignatureCount: number;
      orderItemCount: number;
    };
    profit: ProductProfitStatus;
  }>;
  orderCandidateCount: number;
  orderCandidates: Array<ProductOrderContext & {
    externalProductId: string | null;
    optionCode: string | null;
    optionManageCode: string | null;
    mappingStatus: "UNMAPPED" | "CONFLICT" | "MAPPED";
    suggestedConfigurationIds: string[];
  }>;
  advertising: {
    state: "WAITING" | "REVIEW" | "CONNECTED" | "NOT_ADVERTISED";
    declaredNotAdvertised: boolean;
    activeRuleCount: number;
    campaignCount: number;
    candidateCount: number;
    dateCost: number;
    candidates: Array<{
      id: string;
      campaignName: string;
      reportDate: string;
      totalCost: number;
      mappingReason: string | null;
    }>;
  };
  profit: ProductProfitStatus;
}
