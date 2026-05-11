import { createHash } from "crypto";
import {
  CanonicalSalesUnit,
  createSourceSignature,
  DailySalesUnitProfit,
  DashboardSummary,
  DatabaseShape,
  DEFAULT_DELIVERY_UNIT_COST,
  MappingStatus,
  OrderItem,
  OrderSourceSignature,
  PaginationResult,
  ProfitStatus,
  SaleStatus,
  SalesUnitCostSetting,
  SalesUnitCostSnapshot,
  SalesUnitCostSnapshotEntry,
  Store,
  VAT_RATE,
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
  salesUnitCostSnapshots: [],
  salesUnitCostSnapshotEntries: [],
  dailyFakePurchases: [],
  operations: [],
  auditLogs: [],
});

export const createId = () => uuid();

/**
 * WeakMap cache for signature index (id → signature).
 * Automatically invalidated when database reference changes.
 */
const signatureIndexCache = new WeakMap<DatabaseShape, Map<string, OrderSourceSignature>>();

/**
 * Returns an O(1) index of signatures by id.
 * Cache is keyed by database reference and auto-invalidated on write.
 */
export const getSignatureIndex = (database: DatabaseShape): Map<string, OrderSourceSignature> => {
  let idx = signatureIndexCache.get(database);
  if (!idx) {
    idx = new Map(database.orderSourceSignatures.map((s) => [s.id, s]));
    signatureIndexCache.set(database, idx);
  }
  return idx;
};

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

const kstDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: KST_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const formatDate = (date: Date): string => kstDateFmt.format(date);

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

export const assertGroupInvariants = (unit: CanonicalSalesUnit): void => {
  // 제약 1: isGroup: true이면 linkedProductIds/linkedOptionCodes/linkedManageCodes는 모두 빈 배열이어야 함
  if (unit.isGroup) {
    if (
      (unit.linkedProductIds && unit.linkedProductIds.length > 0) ||
      (unit.linkedOptionCodes && unit.linkedOptionCodes.length > 0) ||
      (unit.linkedManageCodes && unit.linkedManageCodes.length > 0)
    ) {
      throw new BadRequestException({
        success: false,
        message: "그룹 판매단위는 상품/옵션을 직접 매핑할 수 없습니다.",
        errors: [{ field: "isGroup", reason: "GROUP_CANNOT_HAVE_LINKED_ITEMS" }],
      });
    }
  }

  // 제약 2: parentSalesUnitId가 설정되면 isGroup이 true가 될 수 없음 (1단계 계층만 허용)
  if (unit.parentSalesUnitId && unit.isGroup) {
    throw new BadRequestException({
      success: false,
      message: "자식 판매단위는 그룹이 될 수 없습니다.",
      errors: [{ field: "isGroup", reason: "CHILD_CANNOT_BE_GROUP" }],
    });
  }

  // 제약 3: isStoreLevel과 isGroup은 동시 true가 될 수 없음
  if (unit.isStoreLevel && unit.isGroup) {
    throw new BadRequestException({
      success: false,
      message: "스토어 레벨 판매단위는 그룹이 될 수 없습니다.",
      errors: [{ field: "isGroup", reason: "STORE_LEVEL_CANNOT_BE_GROUP" }],
    });
  }
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
    linkedProductIds: raw.linkedProductIds ?? [],
    linkedOptionCodes: raw.linkedOptionCodes ?? [],
    linkedManageCodes: raw.linkedManageCodes ?? [],
    memo: raw.memo ?? null,
    isActive: raw.isActive,
    deactivatedAt: raw.deactivatedAt ?? null,
    isStoreLevel: raw.isStoreLevel ?? false,
    parentSalesUnitId: raw.parentSalesUnitId ?? null,
    isGroup: raw.isGroup ?? false,
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
    const signature = getSignatureIndex(database).get(item.orderSourceSignatureId);
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

/**
 * paymentDate 기준으로 적용할 비용 entry 를 찾는다.
 * 알고리즘: paymentDate ≤ effectiveFrom 인 가장 최근 스냅샷을 고른 뒤,
 *           그 스냅샷에서 canonicalSalesUnitId 매칭 entry 반환.
 * 매칭 entry 없으면 null → 손익에서 INCOMPLETE_COST 처리.
 */
export const getCostSettingForDate = (
  snapshotsForUnit: Array<{ snapshot: SalesUnitCostSnapshot; entry: SalesUnitCostSnapshotEntry | null }>,
  targetDate: string | null,
): SalesUnitCostSnapshotEntry | null => {
  if (!targetDate) {
    return null;
  }

  // snapshotsForUnit 은 calculateDailyProfitRows 가 미리 효과 시작일 오름차순으로 빌드해서 넘김.
  // 가장 최근부터 역방향으로 첫 매칭을 찾음.
  for (let i = snapshotsForUnit.length - 1; i >= 0; i -= 1) {
    const { snapshot, entry } = snapshotsForUnit[i];
    if (snapshot.effectiveFrom <= targetDate) {
      return entry; // entry 가 null 이면 그 스냅샷에 해당 판매단위가 없음 → INCOMPLETE_COST
    }
  }

  return null;
};

export const calculateFee = (
  orderItem: OrderItem,
  costSetting: SalesUnitCostSnapshotEntry | null,
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

// VAT utilities
export const calculateVatAmount = (productRevenue: number): number =>
  Math.round(productRevenue * VAT_RATE);

export const calculateVatAdjustedRevenue = (productRevenue: number): number =>
  productRevenue - calculateVatAmount(productRevenue);

// Delivery package utilities
export const resolvePackageKey = (item: OrderItem): string => {
  const trimmed = item.packageNumber?.trim() ?? "";
  return trimmed || item.orderId;
};

export const calculateEstimatedDeliveryBaseCost = (
  uniquePackageCount: number,
  deliveryUnitCost: number,
): number => uniquePackageCount * deliveryUnitCost;

export const calculateDeliveryMargin = (
  estimated: number,
  customerPaid: number,
): number => customerPaid - estimated;

export interface StoreDeliverySummary {
  uniquePackageCount: number;
  deliveryUnitCost: number;
  estimatedDeliveryBaseCost: number;
  customerPaidDeliveryFee: number;
  deliveryMargin: number;
}

const initRow = (
  date: string,
  canonicalSalesUnitId: string,
  displayName: string,
  isStoreLevel: boolean,
): DailySalesUnitProfit & { fallbackIncomplete: boolean } => ({
  date,
  canonicalSalesUnitId,
  displayName,
  isStoreLevel,
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
  vatAmount: 0,
  vatAdjustedRevenue: 0,
  fallbackIncomplete: false,
});

const finalizeRow = (
  row: DailySalesUnitProfit & { fallbackIncomplete: boolean },
): void => {
  row.vatAmount = calculateVatAmount(row.totalProductRevenue);
  row.vatAdjustedRevenue = row.totalProductRevenue - row.vatAmount;
  row.totalRevenue = row.totalProductRevenue;
  row.roughProfit = row.totalProductRevenue - row.totalAdCost;
  row.profitStatus = computeProfitStatus(row.fallbackIncomplete);
  row.estimatedNetProfit = row.fallbackIncomplete
    ? null
    : row.vatAdjustedRevenue -
      row.totalAdCost -
      row.totalUnitCost -
      row.totalFeeCost -
      row.totalOtherCost;
};

export const calculateDailyProfitRows = (
  database: DatabaseShape,
  storeId: string,
  dateFrom: string,
  dateTo: string,
  filterSalesUnitId?: string,
  includeGroupChildren?: boolean,
): DailySalesUnitProfit[] => {
  const salesUnitsById = new Map(
    database.canonicalSalesUnits.filter((item) => item.storeId === storeId).map((item) => [item.id, item]),
  );

  // 스토어의 스냅샷을 effectiveFrom 오름차순으로 정렬
  const snapshots = database.salesUnitCostSnapshots
    .filter((item) => item.storeId === storeId)
    .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));

  // 판매단위별로 (snapshot, entry|null) 페어 배열 빌드
  // entry 가 null 인 경우는 그 스냅샷에 해당 판매단위가 없는 경우 (케이스 2 누락 / 신규 판매단위)
  const entryIndex = new Map<string, Map<string, SalesUnitCostSnapshotEntry>>(); // snapshotId → unitId → entry
  database.salesUnitCostSnapshotEntries
    .filter((item) => item.storeId === storeId)
    .forEach((entry) => {
      const sub = entryIndex.get(entry.snapshotId) ?? new Map();
      sub.set(entry.canonicalSalesUnitId, entry);
      entryIndex.set(entry.snapshotId, sub);
    });

  const costSettingsByUnit = new Map<string, Array<{ snapshot: SalesUnitCostSnapshot; entry: SalesUnitCostSnapshotEntry | null }>>();
  database.canonicalSalesUnits
    .filter((unit) => unit.storeId === storeId)
    .forEach((unit) => {
      const pairs = snapshots.map((snapshot) => ({
        snapshot,
        entry: entryIndex.get(snapshot.id)?.get(unit.id) ?? null,
      }));
      costSettingsByUnit.set(unit.id, pairs);
    });

  // Step 1: 자식 + 단독 판매단위의 주문 집계
  const childRowMap = new Map<string, DailySalesUnitProfit & { fallbackIncomplete: boolean }>();

  const activeUploadIds = getActiveConfirmedUploadIds(database, storeId);

  // filterSalesUnitId가 그룹 ID인 경우 자식들의 ID 세트를 생성
  const filterGroupChildren = new Set<string>();
  if (filterSalesUnitId) {
    const filterUnit = salesUnitsById.get(filterSalesUnitId);
    if (filterUnit?.isGroup) {
      // 그룹 ID로 필터링: 그룹의 자식들과 그룹 자체 포함
      database.canonicalSalesUnits
        .filter((unit) => unit.storeId === storeId && unit.parentSalesUnitId === filterSalesUnitId)
        .forEach((unit) => filterGroupChildren.add(unit.id));
      filterGroupChildren.add(filterSalesUnitId);
    }
  }

  database.orderItems
    .filter(
      (item) =>
        item.storeId === storeId &&
        item.paymentDate &&
        item.paymentDate >= dateFrom &&
        item.paymentDate <= dateTo &&
        item.saleStatus === "SALE" &&
        item.canonicalSalesUnitId,
    )
    .forEach((item) => {
      // filterSalesUnitId 적용 로직
      if (filterSalesUnitId) {
        const filterUnit = salesUnitsById.get(filterSalesUnitId);
        if (filterUnit?.isGroup) {
          // 그룹 필터: 자식들 + 그룹 자신만
          if (!filterGroupChildren.has(item.canonicalSalesUnitId!)) {
            return;
          }
        } else {
          // 단독 유닛 필터: 정확히 일치하는 ID만
          if (item.canonicalSalesUnitId !== filterSalesUnitId) {
            return;
          }
        }
      }

      const salesUnit = salesUnitsById.get(item.canonicalSalesUnitId!);
      if (!salesUnit) {
        return;
      }
      const key = `${item.paymentDate}:${item.canonicalSalesUnitId}`;
      const costSetting = getCostSettingForDate(costSettingsByUnit.get(item.canonicalSalesUnitId!) ?? [], item.paymentDate);
      const fee = calculateFee(item, costSetting);
      const row =
        childRowMap.get(key) ??
        initRow(item.paymentDate!, item.canonicalSalesUnitId!, salesUnit.displayName, salesUnit.isStoreLevel);

      row.totalQuantity += item.quantity;
      row.totalProductRevenue += item.productPaymentAmount;
      row.totalDeliveryFeeAmount += item.deliveryFeeAmount ?? 0;
      row.totalFeeCost += fee.totalFeeCost;
      row.totalUnitCost += (costSetting?.unitCost ?? 0) * item.quantity;
      row.totalOtherCost += (costSetting?.otherCost ?? 0) * item.quantity;
      row.fallbackIncomplete = row.fallbackIncomplete || !costSetting || fee.incomplete;
      childRowMap.set(key, row);
    });

  // Step 2: 자식 → 부모 롤업 (groupRowMap 생성)
  const groupRowMap = new Map<string, DailySalesUnitProfit & { fallbackIncomplete: boolean }>();
  childRowMap.forEach((childRow) => {
    const unit = salesUnitsById.get(childRow.canonicalSalesUnitId);
    if (!unit?.parentSalesUnitId) {
      // 부모가 없는 자식 (단독 유닛)은 처리하지 않음
      return;
    }
    const parentKey = `${childRow.date}:${unit.parentSalesUnitId}`;
    const parentUnit = salesUnitsById.get(unit.parentSalesUnitId);
    if (!parentUnit) {
      return;
    }
    const parentRow =
      groupRowMap.get(parentKey) ??
      initRow(childRow.date, unit.parentSalesUnitId, parentUnit.displayName, parentUnit.isStoreLevel);
    parentRow.isGroup = true;
    parentRow.totalQuantity += childRow.totalQuantity;
    parentRow.totalProductRevenue += childRow.totalProductRevenue;
    parentRow.totalDeliveryFeeAmount += childRow.totalDeliveryFeeAmount;
    parentRow.totalUnitCost += childRow.totalUnitCost;
    parentRow.totalFeeCost += childRow.totalFeeCost;
    parentRow.totalOtherCost += childRow.totalOtherCost;
    parentRow.fallbackIncomplete = parentRow.fallbackIncomplete || childRow.fallbackIncomplete;
    groupRowMap.set(parentKey, parentRow);
  });

  // Step 3: 광고비 귀속 (그룹 또는 단독 유닛)
  database.adCampaignDailyCosts
    .filter(
      (item) =>
        item.storeId === storeId &&
        item.reportDate >= dateFrom &&
        item.reportDate <= dateTo &&
        item.canonicalSalesUnitId &&
        activeUploadIds.has(item.sourceUploadId),
    )
    .forEach((item) => {
      // 원본 candidate 조회
      const rawUnit = salesUnitsById.get(item.canonicalSalesUnitId!);
      if (!rawUnit) {
        return;
      }

      // 방어적 부모 승격: 자식 ID면 부모로 승격
      // 주의: Step 1/2와 동일하게 isActive 체크 없음(비활성 유닛도 처리)
      // 부모 존재 여부만 확인하므로 null 부모는 자동 방어됨
      let targetUnitId = item.canonicalSalesUnitId!;
      let targetUnit = rawUnit;
      if (rawUnit.parentSalesUnitId) {
        const parentUnit = salesUnitsById.get(rawUnit.parentSalesUnitId);
        if (parentUnit) {
          targetUnitId = parentUnit.id;
          targetUnit = parentUnit;
        }
      }

      // filterSalesUnitId 적용
      // 중요: 승격된 targetUnitId 기준으로 필터 매칭
      // 예: 자식 ID 광고 → 부모로 승격 → 그룹 필터 시 filterGroupChildren(그룹+자식들)에 포함 → 통과
      if (filterSalesUnitId) {
        const filterUnit = salesUnitsById.get(filterSalesUnitId);
        if (filterUnit?.isGroup) {
          if (!filterGroupChildren.has(targetUnitId)) {
            return;
          }
        } else {
          if (targetUnitId !== filterSalesUnitId) {
            return;
          }
        }
      }

      const key = `${item.reportDate}:${targetUnitId}`;

      // 광고비는 그룹이면 groupRowMap에, 단독이면 childRowMap에 적재
      if (targetUnit.isGroup) {
        const row =
          groupRowMap.get(key) ??
          initRow(item.reportDate, targetUnitId, targetUnit.displayName, targetUnit.isStoreLevel);
        row.isGroup = true;
        row.totalAdCost += item.totalCost;
        groupRowMap.set(key, row);
      } else {
        const row =
          childRowMap.get(key) ??
          initRow(item.reportDate, targetUnitId, targetUnit.displayName, targetUnit.isStoreLevel);
        row.totalAdCost += item.totalCost;
        childRowMap.set(key, row);
      }
    });

  // Step 4: 최종 결과 구성
  // - 그룹 행 (groupRowMap의 모든 행)
  // - 부모 없는 자식 행 (childRowMap 중 부모가 없는 것)
  // - childRows 첨부 (includeGroupChildren가 true인 경우)
  const resultMap = new Map<string, DailySalesUnitProfit & { fallbackIncomplete: boolean }>();

  // 그룹 행 추가
  groupRowMap.forEach((groupRow, groupKey) => {
    resultMap.set(groupKey, groupRow);
  });

  // 부모 없는 자식 행 추가
  childRowMap.forEach((childRow, childKey) => {
    const unit = salesUnitsById.get(childRow.canonicalSalesUnitId);
    if (!unit?.parentSalesUnitId) {
      // 부모가 없으면 최상위 리스트에 포함
      resultMap.set(childKey, childRow);
    }
  });

  // 자식 행을 그룹 행의 childRows에 첨부
  const groupChildrenMap = new Map<string, (DailySalesUnitProfit & { fallbackIncomplete: boolean })[]>();
  if (includeGroupChildren) {
    childRowMap.forEach((childRow, childKey) => {
      const unit = salesUnitsById.get(childRow.canonicalSalesUnitId);
      if (unit?.parentSalesUnitId) {
        const parentKey = `${childRow.date}:${unit.parentSalesUnitId}`;
        const list = groupChildrenMap.get(parentKey) ?? [];
        list.push(childRow);
        groupChildrenMap.set(parentKey, list);
      }
    });
  }

  return Array.from(resultMap.values())
    .map((row) => {
      finalizeRow(row);

      // childRows 첨부
      if (includeGroupChildren && row.isGroup) {
        const groupKey = `${row.date}:${row.canonicalSalesUnitId}`;
        const childRows = groupChildrenMap.get(groupKey) ?? [];
        row.childRows = childRows
          .map((childRow) => {
            finalizeRow(childRow);
            return childRow;
          })
          .sort((left, right) =>
            left.displayName.localeCompare(right.displayName, "ko"),
          );
      }

      return row;
    })
    .sort((left, right) =>
      left.date === right.date
        ? left.displayName.localeCompare(right.displayName, "ko")
        : left.date.localeCompare(right.date),
    );
};

export const calculateStoreDeliverySummary = (
  database: DatabaseShape,
  storeId: string,
  dateFrom: string,
  dateTo: string,
): StoreDeliverySummary => {
  const store = database.stores.find((s) => s.id === storeId);
  const deliveryUnitCost = store?.deliveryUnitCost ?? DEFAULT_DELIVERY_UNIT_COST;

  const packageSet = new Set<string>();
  let customerPaidDeliveryFee = 0;

  database.orderItems
    .filter((item) =>
      item.storeId === storeId &&
      item.paymentDate &&
      item.paymentDate >= dateFrom &&
      item.paymentDate <= dateTo &&
      item.saleStatus === "SALE" &&
      item.canonicalSalesUnitId, // 매핑된 것만 포함
    )
    .forEach((item) => {
      packageSet.add(resolvePackageKey(item));
      customerPaidDeliveryFee += item.deliveryFeeAmount ?? 0;
    });

  const uniquePackageCount = packageSet.size;
  const estimatedDeliveryBaseCost = calculateEstimatedDeliveryBaseCost(
    uniquePackageCount,
    deliveryUnitCost,
  );
  const deliveryMargin = calculateDeliveryMargin(
    estimatedDeliveryBaseCost,
    customerPaidDeliveryFee,
  );

  return {
    uniquePackageCount,
    deliveryUnitCost,
    estimatedDeliveryBaseCost,
    customerPaidDeliveryFee,
    deliveryMargin,
  };
};

export const calculateDashboardSummary = (
  database: DatabaseShape,
  storeId: string,
  date: string,
): DashboardSummary => {
  // calculateDailyProfitRows는 기본적으로 includeGroupChildren=false이므로
  // 반환된 rows는 그룹 행 + 부모 없는 단독 유닛만 포함
  // (부모 있는 자식 행은 제외되어 이중 계산 방지)
  const rows = calculateDailyProfitRows(database, storeId, date, date, undefined, false);
  const activeUploadIds = getActiveConfirmedUploadIds(database, storeId);
  const deliverySummary = calculateStoreDeliverySummary(database, storeId, date, date);

  // Single pass: rows summary
  let totalProductRevenue = 0;
  let totalDeliveryFeeAmount = 0;
  let totalAdCost = 0;
  let roughProfit = 0;
  let totalVatAmount = 0;
  let totalVatAdjustedRevenue = 0;
  let sumRowEstimatedNetProfit = 0;
  let incompleteRowCount = 0;

  for (const row of rows) {
    totalProductRevenue += row.totalProductRevenue;
    totalDeliveryFeeAmount += row.totalDeliveryFeeAmount;
    totalAdCost += row.totalAdCost;
    roughProfit += row.roughProfit;
    totalVatAmount += row.vatAmount;
    totalVatAdjustedRevenue += row.vatAdjustedRevenue;
    if (row.profitStatus === "INCOMPLETE_COST") {
      incompleteRowCount++;
    } else if (row.estimatedNetProfit !== null) {
      sumRowEstimatedNetProfit += row.estimatedNetProfit;
    }
  }

  // 최종 순이익 = 판매단위 순이익 합 + 배송 마진
  const finalEstimatedNetProfit = incompleteRowCount > 0
    ? null
    : sumRowEstimatedNetProfit + deliverySummary.deliveryMargin;

  // 기존 estimatedNetProfit 임시 저장 (추후 복구)
  const estimatedNetProfit = finalEstimatedNetProfit;

  // Single pass: eligible orders
  let unmappedOrderItemCount = 0;
  let conflictOrderItemCount = 0;
  let excludedUnmappedOrderRevenue = 0;
  let excludedConflictOrderRevenue = 0;
  let excludedNonSaleOrderRevenue = 0;

  for (const item of database.orderItems) {
    if (item.storeId !== storeId || item.paymentDate !== date) continue;

    if (item.saleStatus === "SALE") {
      const status = getOrderItemMappingStatus(database, item);
      if (status === "UNMAPPED") {
        unmappedOrderItemCount++;
        excludedUnmappedOrderRevenue += item.productPaymentAmount;
      } else if (status === "CONFLICT") {
        conflictOrderItemCount++;
        excludedConflictOrderRevenue += item.productPaymentAmount;
      }
    } else {
      excludedNonSaleOrderRevenue += item.productPaymentAmount;
    }
  }

  // Single pass: eligible ads
  let unmappedCampaignCount = 0;
  let conflictCampaignCount = 0;
  let intentionalUnmappedCampaignCount = 0;
  let excludedUnmappedAdCost = 0;
  let excludedConflictAdCost = 0;
  let excludedIntentionalUnmappedAdCost = 0;

  for (const item of database.adCampaignDailyCosts) {
    if (item.storeId !== storeId || item.reportDate !== date || !activeUploadIds.has(item.sourceUploadId))
      continue;

    const status = getAdMappingStatus(item);
    if (status === "UNMAPPED") {
      unmappedCampaignCount++;
      excludedUnmappedAdCost += item.totalCost;
    } else if (status === "CONFLICT") {
      conflictCampaignCount++;
      excludedConflictAdCost += item.totalCost;
    }

    if (item.mappingReason === "INTENTIONALLY_UNMAPPED") {
      intentionalUnmappedCampaignCount++;
      excludedIntentionalUnmappedAdCost += item.totalCost;
    }
  }

  const profitStatus = incompleteRowCount > 0 ? "INCOMPLETE_COST" : "COMPLETE";

  return {
    date,
    totalRevenue: totalProductRevenue,
    totalProductRevenue,
    totalDeliveryFeeAmount,
    totalAdCost,
    roughProfit,
    estimatedNetProfit,
    profitStatus,
    salesUnitCount: rows.length,
    incompleteCostSalesUnitCount: incompleteRowCount,
    unmappedOrderItemCount,
    conflictOrderItemCount,
    unmappedCampaignCount,
    conflictCampaignCount,
    intentionalUnmappedCampaignCount,
    excludedOrderRevenue: excludedUnmappedOrderRevenue + excludedConflictOrderRevenue + excludedNonSaleOrderRevenue,
    excludedUnmappedOrderRevenue,
    excludedConflictOrderRevenue,
    excludedNonSaleOrderRevenue,
    excludedAdCost: excludedUnmappedAdCost + excludedConflictAdCost + excludedIntentionalUnmappedAdCost,
    excludedUnmappedAdCost,
    excludedConflictAdCost,
    excludedIntentionalUnmappedAdCost,
    totalVatAmount,
    totalVatAdjustedRevenue,
    uniquePackageCount: deliverySummary.uniquePackageCount,
    deliveryUnitCost: deliverySummary.deliveryUnitCost,
    estimatedDeliveryBaseCost: deliverySummary.estimatedDeliveryBaseCost,
    customerPaidDeliveryFee: deliverySummary.customerPaidDeliveryFee,
    deliveryMargin: deliverySummary.deliveryMargin,
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
