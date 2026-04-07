import { createHash } from "crypto";
import {
  CanonicalSalesUnit,
  createSourceSignature,
  DailySalesUnitProfit,
  DashboardSummary,
  DatabaseShape,
  MappingStatus,
  OrderItem,
  OrderSourceSignature,
  PaginationResult,
  ProfitStatus,
  SaleStatus,
  SalesUnitCostSetting,
  Store,
  normalizeMatchAlias,
  normalizeText,
} from "@patima/shared";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { v4 as uuid } from "uuid";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const KST_TIMEZONE = "Asia/Seoul";

export const nowIso = () => new Date().toISOString();

export const createEmptyDatabase = (): DatabaseShape => ({
  stores: [],
  commerceCredentials: [],
  products: [],
  canonicalSalesUnits: [],
  orderSourceSignatures: [],
  orders: [],
  orderItems: [],
  campaignMappings: [],
  adExcelUploads: [],
  adUploadPreviewRows: [],
  adCampaignDailyCosts: [],
  salesUnitCostSettings: [],
  operations: [],
  auditLogs: [],
});

export const createId = () => uuid();

const HANGUL_REGEX = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const LATIN1_MOJIBAKE_HINT_REGEX = /[À-ÿ]/;

export const repairMojibakeText = (value: string | null | undefined) => {
  if (!value) {
    return value ?? "";
  }

  if (HANGUL_REGEX.test(value) || !LATIN1_MOJIBAKE_HINT_REGEX.test(value)) {
    return value;
  }

  const repaired = Buffer.from(value, "latin1").toString("utf8");
  if (!HANGUL_REGEX.test(repaired) || repaired.includes("�")) {
    return value;
  }

  return repaired;
};

export const getActiveConfirmedUploadIds = (
  database: DatabaseShape,
  storeId: string,
  reportDate?: string,
) =>
  new Set(
    database.adExcelUploads
      .filter(
        (upload) =>
          upload.storeId === storeId &&
          upload.isActive &&
          upload.weekdayValidationStatus === "PASSED" &&
          upload.state === "CONFIRMED" &&
          (!reportDate || upload.reportDate === reportDate),
      )
      .map((upload) => upload.id),
  );

export const ensureStoreExists = (database: DatabaseShape, storeId: string): Store => {
  const store = database.stores.find((item) => item.id === storeId);

  if (!store) {
    throw new NotFoundException({
      success: false,
      message: "스토어를 찾을 수 없습니다.",
      errors: [{ field: "storeId", reason: "STORE_NOT_FOUND" }],
    });
  }

  return store;
};

export const ensureDateString = (value: string, field: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException({
      success: false,
      message: "날짜 형식이 올바르지 않습니다.",
      errors: [{ field, reason: "INVALID_DATE_RANGE" }],
    });
  }

  return value;
};

export const ensureKstDateRange = (
  dateFrom?: string,
  dateTo?: string,
): { dateFrom: string; dateTo: string; rangeMode: "MANUAL" | "AUTO_LAST_30_DAYS" } => {
  if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) {
    throw new BadRequestException({
      success: false,
      message: "주문 동기화 날짜는 둘 다 주거나 둘 다 생략해야 합니다.",
      errors: [{ field: "dateFrom", reason: "ORDER_SYNC_DATE_BOTH_REQUIRED" }],
    });
  }

  if (!dateFrom || !dateTo) {
    const today = new Date();
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: KST_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(today);
    const current = `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
    const end = new Date(`${current}T00:00:00+09:00`);
    const start = new Date(end);
    start.setDate(start.getDate() - 29);

    return {
      dateFrom: formatDate(start),
      dateTo: formatDate(end),
      rangeMode: "AUTO_LAST_30_DAYS",
    };
  }

  const start = new Date(`${ensureDateString(dateFrom, "dateFrom")}T00:00:00+09:00`);
  const end = new Date(`${ensureDateString(dateTo, "dateTo")}T00:00:00+09:00`);

  if (start.getTime() > end.getTime()) {
    throw new BadRequestException({
      success: false,
      message: "날짜 범위가 올바르지 않습니다.",
      errors: [{ field: "dateFrom", reason: "INVALID_DATE_RANGE" }],
    });
  }

  const inclusiveDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (inclusiveDays > 30) {
    throw new BadRequestException({
      success: false,
      message: "수동 동기화 범위는 30일까지만 허용됩니다.",
      errors: [{ field: "dateFrom", reason: "ORDER_SYNC_DATE_RANGE_TOO_LARGE" }],
    });
  }

  return { dateFrom, dateTo, rangeMode: "MANUAL" };
};

export const formatDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const paginate = <T>(
  items: T[],
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
): PaginationResult<T> => {
  const normalizedPage = Math.max(1, page);
  const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));
  const totalCount = items.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / normalizedPageSize));
  const start = (normalizedPage - 1) * normalizedPageSize;
  const pagedItems = items.slice(start, start + normalizedPageSize);

  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalCount,
    totalPages,
    hasNext: normalizedPage < totalPages,
    items: pagedItems,
  };
};

export const hashJson = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const hashBuffer = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const roundHalfUp = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

export const sumNullable = (...values: Array<number | null | undefined>): number | null => {
  if (values.every((value) => value == null)) {
    return null;
  }

  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
};

export const saleStatusFromRawStatus = (rawStatus: string): SaleStatus => {
  switch (rawStatus) {
    case "PAYED":
    case "DELIVERING":
    case "DELIVERED":
    case "PURCHASE_DECIDED":
      return "SALE";
    case "CANCEL_REQUEST":
    case "CANCELING":
      return "CANCEL_REQUESTED";
    case "CANCEL_DONE":
    case "CANCELED":
    case "CANCELED_BY_NOPAYMENT":
      return "CANCELED";
    case "RETURN_REQUEST":
    case "COLLECTING":
    case "COLLECT_DONE":
    case "RETURN_DONE":
    case "RETURNED":
      return "RETURNED";
    case "EXCHANGE_REQUEST":
    case "EXCHANGE_REDELIVERING":
    case "EXCHANGE_DONE":
    case "EXCHANGED":
      return "EXCHANGED";
    default:
      return "UNKNOWN";
  }
};

export const saleStatusFromNaverOrderState = (
  productOrderStatus?: string | null,
  claimStatus?: string | null,
): SaleStatus => {
  if (claimStatus) {
    return saleStatusFromRawStatus(claimStatus);
  }
  if (productOrderStatus) {
    return saleStatusFromRawStatus(productOrderStatus);
  }
  return "UNKNOWN";
};

export const isoDateTimeToDate = (value?: string | null): string | null => {
  if (!value) {
    return null;
  }

  const normalized = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
};

export const asString = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return null;
};

export const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    if (!normalized) {
      return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

export const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

export const maskSecret = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}****`;
  }

  return `${value.slice(0, 4)}****${value.slice(-2)}`;
};

export const getWeekdayNameKo = (dateString: string): string => {
  return new Intl.DateTimeFormat("ko-KR", {
    weekday: "long",
    timeZone: KST_TIMEZONE,
  }).format(new Date(`${dateString}T12:00:00Z`));
};

export const isSalesUnitAssignable = (
  deactivatedAt: string | null,
  targetDate: string | null,
): boolean => {
  if (!deactivatedAt) {
    return true;
  }
  if (!targetDate) {
    return false;
  }

  const deactivatedDate = deactivatedAt.slice(0, 10);
  return targetDate < deactivatedDate;
};

export const createDisplayName = (standardProductName: string, standardOptionName?: string | null): string =>
  [standardProductName, standardOptionName].filter(Boolean).join(" / ");

export const sanitizeMatchAliases = (aliases: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const items: string[] = [];

  aliases.forEach((alias) => {
    const trimmed = alias?.trim();
    if (!trimmed) {
      return;
    }

    const normalized = normalizeMatchAlias(trimmed);
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    items.push(trimmed);
  });

  return items;
};

export const normalizeMatchAliasList = (aliases: Array<string | null | undefined>): string[] =>
  sanitizeMatchAliases(aliases).map((alias) => normalizeMatchAlias(alias));

export const deriveLegacyMatchAliases = (
  standardProductName?: string | null,
  standardOptionName?: string | null,
): string[] => {
  const productName = standardProductName?.trim() ?? "";
  const optionName = standardOptionName?.trim() ?? "";

  if (!productName) {
    return [];
  }

  return sanitizeMatchAliases([
    productName,
    optionName ? createDisplayName(productName, optionName) : null,
  ]);
};

export const migrateCanonicalSalesUnit = (
  raw: CanonicalSalesUnit &
    Partial<{
      standardProductName: string | null;
      standardOptionName: string | null;
      matchAliases: string[];
    }>,
): CanonicalSalesUnit => {
  const displayName =
    raw.displayName?.trim() ||
    createDisplayName(raw.standardProductName ?? "", raw.standardOptionName ?? null) ||
    "이름 없는 판매단위";
  const matchAliases =
    Array.isArray(raw.matchAliases) && raw.matchAliases.length > 0
      ? sanitizeMatchAliases(raw.matchAliases)
      : deriveLegacyMatchAliases(raw.standardProductName, raw.standardOptionName);

  return {
    id: raw.id,
    storeId: raw.storeId,
    displayName,
    matchAliases,
    normalizedMatchAliases: normalizeMatchAliasList(matchAliases),
    memo: raw.memo ?? null,
    isActive: raw.isActive,
    deactivatedAt: raw.deactivatedAt ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
};

export const getSignatureMappingStatus = (
  signature: Pick<OrderSourceSignature, "mappingStatus" | "canonicalSalesUnitId">,
): MappingStatus => signature.mappingStatus ?? (signature.canonicalSalesUnitId ? "MAPPED" : "UNMAPPED");

export const getOrderItemMappingStatus = (
  database: DatabaseShape,
  item: Pick<OrderItem, "canonicalSalesUnitId" | "orderSourceSignatureId">,
): MappingStatus => {
  if (item.orderSourceSignatureId) {
    const signature = database.orderSourceSignatures.find((entry) => entry.id === item.orderSourceSignatureId);
    if (signature) {
      return getSignatureMappingStatus(signature);
    }
  }

  return item.canonicalSalesUnitId ? "MAPPED" : "UNMAPPED";
};

export const getAdMappingStatus = (
  item: Pick<DatabaseShape["adCampaignDailyCosts"][number], "canonicalSalesUnitId" | "mappingReason">,
): MappingStatus => {
  if (item.mappingReason === "MULTIPLE_RULES") {
    return "CONFLICT";
  }

  return item.canonicalSalesUnitId ? "MAPPED" : "UNMAPPED";
};

export const getCostSettingForDate = (
  costSettings: SalesUnitCostSetting[],
  targetDate: string | null,
): SalesUnitCostSetting | null => {
  if (!targetDate) {
    return null;
  }

  return (
    costSettings.find((setting) => {
      const starts = setting.effectiveFrom <= targetDate;
      const ends = !setting.effectiveTo || setting.effectiveTo >= targetDate;
      return setting.isActive && starts && ends;
    }) ?? null
  );
};

export const calculateFee = (
  orderItem: OrderItem,
  costSetting: SalesUnitCostSetting | null,
): { totalFeeCost: number; usedFallback: boolean; incomplete: boolean } => {
  const apiFee = sumNullable(
    orderItem.paymentCommission,
    orderItem.knowledgeShoppingSellingInterlockCommission,
  );

  if (apiFee != null) {
    return { totalFeeCost: apiFee, usedFallback: false, incomplete: false };
  }

  if (costSetting?.feeRate == null) {
    return { totalFeeCost: 0, usedFallback: false, incomplete: true };
  }

  return {
    totalFeeCost: roundHalfUp(orderItem.productPaymentAmount * costSetting.feeRate),
    usedFallback: true,
    incomplete: false,
  };
};

export const computeProfitStatus = (hasIncomplete: boolean): ProfitStatus =>
  hasIncomplete ? "INCOMPLETE_COST" : "COMPLETE";

export const calculateDailyProfitRows = (
  database: DatabaseShape,
  storeId: string,
  dateFrom: string,
  dateTo: string,
  filterSalesUnitId?: string,
): DailySalesUnitProfit[] => {
  const salesUnitsById = new Map(
    database.canonicalSalesUnits.filter((item) => item.storeId === storeId).map((item) => [item.id, item]),
  );
  const costSettingsByUnit = new Map<string, SalesUnitCostSetting[]>();

  database.salesUnitCostSettings
    .filter((item) => item.storeId === storeId)
    .forEach((item) => {
      const list = costSettingsByUnit.get(item.canonicalSalesUnitId) ?? [];
      list.push(item);
      list.sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
      costSettingsByUnit.set(item.canonicalSalesUnitId, list);
    });

  const rowMap = new Map<string, DailySalesUnitProfit & { fallbackIncomplete: boolean }>();

  const activeUploadIds = getActiveConfirmedUploadIds(database, storeId);

  database.orderItems
    .filter(
      (item) =>
        item.storeId === storeId &&
        item.paymentDate &&
        item.paymentDate >= dateFrom &&
        item.paymentDate <= dateTo &&
        item.saleStatus === "SALE" &&
        item.canonicalSalesUnitId &&
        (!filterSalesUnitId || item.canonicalSalesUnitId === filterSalesUnitId),
    )
    .forEach((item) => {
      const salesUnit = salesUnitsById.get(item.canonicalSalesUnitId!);
      if (!salesUnit) {
        return;
      }
      const key = `${item.paymentDate}:${item.canonicalSalesUnitId}`;
      const costSetting = getCostSettingForDate(costSettingsByUnit.get(item.canonicalSalesUnitId!) ?? [], item.paymentDate);
      const fee = calculateFee(item, costSetting);
      const row =
        rowMap.get(key) ??
        {
          date: item.paymentDate!,
          canonicalSalesUnitId: item.canonicalSalesUnitId!,
          displayName: salesUnit.displayName,
          totalQuantity: 0,
          totalRevenue: 0,
          totalProductRevenue: 0,
          totalDeliveryFeeAmount: 0,
          totalAdCost: 0,
          totalUnitCost: 0,
          totalFeeCost: 0,
          totalOtherCost: 0,
          roughProfit: 0,
          estimatedNetProfit: 0,
          profitStatus: "COMPLETE" as ProfitStatus,
          fallbackIncomplete: false,
        };

      row.totalQuantity += item.quantity;
      row.totalProductRevenue += item.productPaymentAmount;
      row.totalDeliveryFeeAmount += item.deliveryFeeAmount ?? 0;
      row.totalFeeCost += fee.totalFeeCost;
      row.totalUnitCost += (costSetting?.unitCost ?? 0) * item.quantity;
      row.totalOtherCost += (costSetting?.otherCost ?? 0) * item.quantity;
      row.fallbackIncomplete = row.fallbackIncomplete || !costSetting || fee.incomplete;
      rowMap.set(key, row);
    });

  database.adCampaignDailyCosts
    .filter(
      (item) =>
        item.storeId === storeId &&
        item.reportDate >= dateFrom &&
        item.reportDate <= dateTo &&
        item.canonicalSalesUnitId &&
        activeUploadIds.has(item.sourceUploadId) &&
        (!filterSalesUnitId || item.canonicalSalesUnitId === filterSalesUnitId),
    )
    .forEach((item) => {
      const salesUnit = salesUnitsById.get(item.canonicalSalesUnitId!);
      if (!salesUnit) {
        return;
      }
      const key = `${item.reportDate}:${item.canonicalSalesUnitId}`;
      const row =
        rowMap.get(key) ??
        {
          date: item.reportDate,
          canonicalSalesUnitId: item.canonicalSalesUnitId!,
          displayName: salesUnit.displayName,
          totalQuantity: 0,
          totalRevenue: 0,
          totalProductRevenue: 0,
          totalDeliveryFeeAmount: 0,
          totalAdCost: 0,
          totalUnitCost: 0,
          totalFeeCost: 0,
          totalOtherCost: 0,
          roughProfit: 0,
          estimatedNetProfit: 0,
          profitStatus: "COMPLETE" as ProfitStatus,
          fallbackIncomplete: false,
        };

      row.totalAdCost += item.totalCost;
      rowMap.set(key, row);
    });

  return Array.from(rowMap.values())
    .map((row) => {
      row.totalRevenue = row.totalProductRevenue;
      row.roughProfit = row.totalRevenue - row.totalAdCost;
      row.profitStatus = computeProfitStatus(row.fallbackIncomplete);
      row.estimatedNetProfit = row.fallbackIncomplete
        ? null
        : row.totalRevenue - row.totalAdCost - row.totalUnitCost - row.totalFeeCost - row.totalOtherCost;
      return row;
    })
    .sort((left, right) =>
      left.date === right.date
        ? left.displayName.localeCompare(right.displayName, "ko")
        : left.date.localeCompare(right.date),
    );
};

export const calculateDashboardSummary = (
  database: DatabaseShape,
  storeId: string,
  date: string,
): DashboardSummary => {
  const rows = calculateDailyProfitRows(database, storeId, date, date);
  const activeUploadIds = getActiveConfirmedUploadIds(database, storeId);
  const totalProductRevenue = rows.reduce((total, row) => total + row.totalProductRevenue, 0);
  const totalDeliveryFeeAmount = rows.reduce(
    (total, row) => total + row.totalDeliveryFeeAmount,
    0,
  );
  const eligibleOrders = database.orderItems.filter(
    (item) => item.storeId === storeId && item.paymentDate === date,
  );
  const eligibleAds = database.adCampaignDailyCosts.filter(
    (item) =>
      item.storeId === storeId && item.reportDate === date && activeUploadIds.has(item.sourceUploadId),
  );

  const excludedUnmappedOrderRevenue = eligibleOrders
    .filter((item) => item.saleStatus === "SALE" && getOrderItemMappingStatus(database, item) === "UNMAPPED")
    .reduce((total, item) => total + item.productPaymentAmount, 0);
  const excludedConflictOrderRevenue = eligibleOrders
    .filter((item) => item.saleStatus === "SALE" && getOrderItemMappingStatus(database, item) === "CONFLICT")
    .reduce((total, item) => total + item.productPaymentAmount, 0);
  const excludedNonSaleOrderRevenue = eligibleOrders
    .filter((item) => item.saleStatus !== "SALE")
    .reduce((total, item) => total + item.productPaymentAmount, 0);
  const excludedUnmappedAdCost = eligibleAds
    .filter((item) => item.mappingReason === "NO_RULE")
    .reduce((total, item) => total + item.totalCost, 0);
  const excludedConflictAdCost = eligibleAds
    .filter((item) => item.mappingReason === "MULTIPLE_RULES")
    .reduce((total, item) => total + item.totalCost, 0);
  const excludedIntentionalUnmappedAdCost = eligibleAds
    .filter((item) => item.mappingReason === "INTENTIONALLY_UNMAPPED")
    .reduce((total, item) => total + item.totalCost, 0);
  const incompleteRows = rows.filter((row) => row.profitStatus === "INCOMPLETE_COST");

  return {
    date,
    totalRevenue: totalProductRevenue,
    totalProductRevenue,
    totalDeliveryFeeAmount,
    totalAdCost: rows.reduce((total, row) => total + row.totalAdCost, 0),
    roughProfit: rows.reduce((total, row) => total + row.roughProfit, 0),
    estimatedNetProfit:
      incompleteRows.length > 0
        ? null
        : rows.reduce((total, row) => total + (row.estimatedNetProfit ?? 0), 0),
    profitStatus: incompleteRows.length > 0 ? "INCOMPLETE_COST" : "COMPLETE",
    salesUnitCount: rows.length,
    incompleteCostSalesUnitCount: incompleteRows.length,
    unmappedOrderItemCount: eligibleOrders.filter(
      (item) => item.saleStatus === "SALE" && getOrderItemMappingStatus(database, item) === "UNMAPPED",
    ).length,
    conflictOrderItemCount: eligibleOrders.filter(
      (item) => item.saleStatus === "SALE" && getOrderItemMappingStatus(database, item) === "CONFLICT",
    ).length,
    unmappedCampaignCount: eligibleAds.filter((item) => item.mappingReason === "NO_RULE").length,
    conflictCampaignCount: eligibleAds.filter((item) => item.mappingReason === "MULTIPLE_RULES").length,
    intentionalUnmappedCampaignCount: eligibleAds.filter(
      (item) => item.mappingReason === "INTENTIONALLY_UNMAPPED",
    ).length,
    excludedOrderRevenue:
      excludedUnmappedOrderRevenue + excludedConflictOrderRevenue + excludedNonSaleOrderRevenue,
    excludedUnmappedOrderRevenue,
    excludedConflictOrderRevenue,
    excludedNonSaleOrderRevenue,
    excludedAdCost:
      excludedUnmappedAdCost + excludedConflictAdCost + excludedIntentionalUnmappedAdCost,
    excludedUnmappedAdCost,
    excludedConflictAdCost,
    excludedIntentionalUnmappedAdCost,
  };
};

export const ensureNormalizedLength = (value: string, field: string) => {
  if (!value) {
    throw new BadRequestException({
      success: false,
      message: "빈 값은 저장할 수 없습니다.",
      errors: [{ field, reason: "INVALID_VALUE" }],
    });
  }
};

export const sortByUpdatedAtDesc = <T extends { updatedAt: string }>(items: T[]): T[] =>
  [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

export const mapOrderItemResponse = (
  database: DatabaseShape,
  item: OrderItem,
) => {
  const salesUnit = database.canonicalSalesUnits.find((entry) => entry.id === item.canonicalSalesUnitId);
  return {
    id: item.id,
    orderRecordId: item.orderId,
    externalOrderId: database.orders.find((entry) => entry.id === item.orderId)?.externalOrderId ?? item.orderId,
    orderSourceSignatureId: item.orderSourceSignatureId,
    canonicalSalesUnitId: item.canonicalSalesUnitId,
    rawProductName: item.rawProductName,
    rawOptionInfo: item.rawOptionInfo,
    sourceSignature: item.sourceSignature,
    displayName: salesUnit?.displayName ?? null,
    quantity: item.quantity,
    productPaymentAmount: item.productPaymentAmount,
    packageNumber: item.packageNumber,
    deliveryFeeAmount: item.deliveryFeeAmount,
    paymentCommission: item.paymentCommission,
    knowledgeShoppingSellingInterlockCommission: item.knowledgeShoppingSellingInterlockCommission,
    saleCommission: item.saleCommission,
    channelCommission: item.channelCommission,
    paymentDate: item.paymentDate,
    orderStatus: item.orderStatus,
    saleStatus: item.saleStatus,
    mappingStatus: getOrderItemMappingStatus(database, item),
  };
};

export const ensureNoCrossStoreReference = (
  ownerStoreId: string,
  targetStoreId: string | undefined,
  field: string,
) => {
  if (targetStoreId && ownerStoreId !== targetStoreId) {
    throw new BadRequestException({
      success: false,
      message: "다른 스토어의 리소스를 참조할 수 없습니다.",
      errors: [{ field, reason: "CROSS_STORE_REFERENCE_NOT_ALLOWED" }],
    });
  }
};

export const formatApiSuccess = <T>(data: T, message: string | null = null) => ({
  success: true,
  data,
  message,
});

export const formatDateRangeFilter = (itemDate: string | null, dateFrom?: string, dateTo?: string): boolean => {
  if (!dateFrom || !dateTo) {
    return true;
  }
  if (!itemDate) {
    return false;
  }
  return itemDate >= dateFrom && itemDate <= dateTo;
};

export const rawToSourceSignature = (rawProductName: string, rawOptionInfo: string | null) =>
  createSourceSignature(rawProductName, rawOptionInfo);
