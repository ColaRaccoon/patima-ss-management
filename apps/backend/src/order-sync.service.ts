import { BadRequestException, Injectable, OnModuleInit } from "@nestjs/common";
import { OrderItem, OrderRecord, OrderSourceSignature, Product, normalizeText } from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureKstDateRange,
  ensureStoreExists,
  formatApiSuccess,
  getOrderItemMappingStatus,
  getSignatureMappingStatus,
  mapOrderItemResponse,
  nowIso,
  paginate,
  rawToSourceSignature,
} from "./helpers";
import { NaverCommerceService, SyncedOrderItemInput } from "./naver-commerce.service";
import { OperationService } from "./operation.service";
import { recalculateOrderMappingsForTouchedItems } from "./sales-unit-auto-mapper";
import { enrichSignatureDisplayName, type EnrichmentContext } from "./signature-enrichment";

interface OrderTemplate {
  productName: string;
  optionInfo: string;
  standardKey: string;
  price: number;
  quantity: number;
}

const ORDER_TEMPLATES: OrderTemplate[] = [
  {
    productName: "Black Running Hat",
    optionInfo: "[Fast Delivery] Color: Black",
    standardKey: "running-black",
    price: 19900,
    quantity: 1,
  },
  {
    productName: "Knee Support Guard",
    optionInfo: "Color: Modern Gray",
    standardKey: "knee-gray",
    price: 22900,
    quantity: 1,
  },
  {
    productName: "Daily Sports Socks",
    optionInfo: "Color: Black / Size: Free",
    standardKey: "sock-black",
    price: 12900,
    quantity: 2,
  },
  {
    productName: "Slim Shin Guard",
    optionInfo: "Option: Navy",
    standardKey: "guard-navy",
    price: 18900,
    quantity: 1,
  },
];

const RAW_STATUSES = [
  "PAYED",
  "DELIVERED",
  "PURCHASE_DECIDED",
  "CANCEL_REQUEST",
  "RETURNED",
  "EXCHANGED",
] as const;

@Injectable()
export class OrderSyncService implements OnModuleInit {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly operationService: OperationService,
    private readonly auditLogService: AuditLogService,
    private readonly naverCommerceService: NaverCommerceService,
  ) {}

  onModuleInit(): void {
    this.operationService.registerRetryExecutor("ORDER_SYNC", async (operation) => {
      const request = operation.requestJson as {
        dateFrom: string;
        dateTo: string;
        rangeMode: string;
        requireLiveCredential?: boolean;
      };
      return this.performSync(
        operation.storeId,
        request.dateFrom,
        request.dateTo,
        request.rangeMode as "MANUAL" | "AUTO_LAST_30_DAYS",
        { requireLiveCredential: request.requireLiveCredential === true },
      );
    });
  }

  enqueueSync(storeId: string, dateFrom?: string, dateTo?: string) {
    const { dateFrom: normalizedDateFrom, dateTo: normalizedDateTo, rangeMode } =
      ensureKstDateRange(dateFrom, dateTo);
    ensureStoreExists(this.databaseService.getSnapshot(), storeId);
    const operation = this.operationService.enqueue(
      storeId,
      "ORDER_SYNC",
      {
        dateFrom: normalizedDateFrom,
        dateTo: normalizedDateTo,
        rangeMode,
      },
      () => this.performSync(storeId, normalizedDateFrom, normalizedDateTo, rangeMode),
    );

    return formatApiSuccess({
      operationId: operation.id,
      operationType: operation.operationType,
      status: operation.status,
      requestSummary: operation.requestJson,
    });
  }

  enqueueSyncAll(dateFrom?: string, dateTo?: string) {
    const { dateFrom: normalizedDateFrom, dateTo: normalizedDateTo, rangeMode } =
      ensureKstDateRange(dateFrom, dateTo);
    const snapshot = this.databaseService.getSnapshot();
    const activeStores = snapshot.stores.filter((store) => store.isActive);
    const operations: Array<{
      storeId: string;
      storeName: string;
      operationId: string;
      operationType: "ORDER_SYNC";
      status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
    }> = [];
    const skippedStores: Array<{
      storeId: string;
      storeName: string;
      reason: "NAVER_CREDENTIALS_NOT_CONFIGURED" | "ORDER_SYNC_ALREADY_IN_FLIGHT";
    }> = [];

    activeStores.forEach((store) => {
      if (this.operationService.hasInFlightOperation(store.id, "ORDER_SYNC")) {
        skippedStores.push({
          storeId: store.id,
          storeName: store.name,
          reason: "ORDER_SYNC_ALREADY_IN_FLIGHT",
        });
        return;
      }

      if (!this.naverCommerceService.getResolvedConfiguration(store.id)) {
        skippedStores.push({
          storeId: store.id,
          storeName: store.name,
          reason: "NAVER_CREDENTIALS_NOT_CONFIGURED",
        });
        return;
      }

      const operation = this.operationService.enqueue(
        store.id,
        "ORDER_SYNC",
        {
          dateFrom: normalizedDateFrom,
          dateTo: normalizedDateTo,
          rangeMode,
          requireLiveCredential: true,
          requestedByBatch: true,
        },
        () =>
          this.performSync(
            store.id,
            normalizedDateFrom,
            normalizedDateTo,
            rangeMode,
            { requireLiveCredential: true },
          ),
      );

      operations.push({
        storeId: store.id,
        storeName: store.name,
        operationId: operation.id,
        operationType: "ORDER_SYNC",
        status: operation.status,
      });
    });

    if (operations.length === 0 && skippedStores.length === 0) {
      throw new BadRequestException({
        success: false,
        message: "활성 스토어가 없습니다.",
        errors: [{ field: "storeId", reason: "NO_ACTIVE_STORES" }],
      });
    }

    return formatApiSuccess({
      dateFrom: normalizedDateFrom,
      dateTo: normalizedDateTo,
      rangeMode,
      targetStoreCount: operations.length,
      skippedStoreCount: skippedStores.length,
      operations,
      skippedStores,
    });
  }

  async performSync(
    storeId: string,
    dateFrom: string,
    dateTo: string,
    rangeMode: "MANUAL" | "AUTO_LAST_30_DAYS",
    options?: { requireLiveCredential?: boolean },
  ) {
    const snapshot = this.databaseService.getSnapshot();
    const store = ensureStoreExists(snapshot, storeId);
    if (!store.isActive) {
      throw new BadRequestException("STORE_INACTIVE");
    }

    try {
      const resolvedConfiguration = this.naverCommerceService.getResolvedConfiguration(storeId);
      const liveEnabled = !!resolvedConfiguration;

      if (options?.requireLiveCredential && !liveEnabled) {
        throw new BadRequestException("NAVER_CREDENTIALS_NOT_CONFIGURED");
      }

      const liveEntries = liveEnabled
        ? await this.naverCommerceService.fetchOrderItems(storeId, dateFrom, dateTo)
        : null;
      const entries = liveEntries ?? this.generateMockItems(dateFrom, dateTo);
      const syncSource = liveEnabled ? "NAVER_LIVE" : "MOCK_FALLBACK";

      let ordersUpserted = 0;
      let orderItemsUpserted = 0;
      let orderSourceSignaturesCreated = 0;
      let unknownOrderStatusCount = 0;
      let paymentDateMissingCount = 0;

      this.databaseService.write((draft) => {
        const touchedSignatureIds = new Set<string>();
        const touchedOrderItemIds = new Set<string>();

        entries.forEach((entry) => {
          const product = this.upsertProduct(draft, storeId, entry);
          const existingSignature = draft.orderSourceSignatures.find(
            (item) =>
              item.storeId === storeId &&
              item.normalizedProductName === normalizeText(entry.rawProductName) &&
              item.normalizedOptionInfo === normalizeText(entry.rawOptionInfo ?? ""),
          );
          const signature = this.upsertSignature(draft, storeId, entry.rawProductName, entry.rawOptionInfo);
          if (!existingSignature) {
            draft.orderSourceSignatures.push(signature);
            orderSourceSignaturesCreated += 1;
          }
          const existingOrder = draft.orders.find(
            (item) => item.storeId === storeId && item.externalOrderId === entry.externalOrderId,
          );
          let orderRecord: OrderRecord;

          if (existingOrder) {
            existingOrder.orderDatetime = entry.orderDateTime;
            existingOrder.paymentDatetime = entry.paymentDateTime;
            existingOrder.orderStatus = entry.rawStatus;
            existingOrder.rawPayload = entry.rawPayload;
            existingOrder.syncedAt = nowIso();
            existingOrder.updatedAt = nowIso();
            orderRecord = existingOrder;
          } else {
            orderRecord = {
              id: createId(),
              storeId,
              externalOrderId: entry.externalOrderId,
              orderDatetime: entry.orderDateTime,
              paymentDatetime: entry.paymentDateTime,
              orderStatus: entry.rawStatus,
              rawPayload: entry.rawPayload,
              syncedAt: nowIso(),
              createdAt: nowIso(),
              updatedAt: nowIso(),
            };
            draft.orders.push(orderRecord);
            ordersUpserted += 1;
          }

          const existingItem = draft.orderItems.find(
            (item) => item.storeId === storeId && item.externalProductOrderId === entry.externalProductOrderId,
          );
          const previousSignatureId = existingItem?.orderSourceSignatureId ?? null;
          if (entry.saleStatus === "UNKNOWN") {
            unknownOrderStatusCount += 1;
          }
          if (!entry.paymentDate) {
            paymentDateMissingCount += 1;
          }

          this.updateSignatureUsageSummary(draft, signature, entry, previousSignatureId, !existingItem);
          touchedSignatureIds.add(signature.id);
          if (previousSignatureId && previousSignatureId !== signature.id) {
            touchedSignatureIds.add(previousSignatureId);
          }

          const payload: OrderItem = {
            id: existingItem?.id ?? createId(),
            orderId: orderRecord.id,
            storeId,
            productId: product.id,
            orderSourceSignatureId: signature.id,
            canonicalSalesUnitId: null,
            externalProductOrderId: entry.externalProductOrderId,
            externalProductId: product.externalProductId,
            optionCode: entry.optionCode,
            packageNumber: entry.packageNumber,
            rawProductName: entry.rawProductName,
            rawOptionInfo: entry.rawOptionInfo,
            normalizedProductName: normalizeText(entry.rawProductName),
            normalizedOptionInfo: normalizeText(entry.rawOptionInfo ?? ""),
            sourceSignature: rawToSourceSignature(entry.rawProductName, entry.rawOptionInfo),
            quantity: entry.quantity,
            productPaymentAmount: entry.productPaymentAmount,
            totalProductAmount: entry.totalProductAmount,
            deliveryFeeAmount: entry.deliveryFeeAmount,
            paymentCommission: entry.paymentCommission,
            knowledgeShoppingSellingInterlockCommission:
              entry.knowledgeShoppingSellingInterlockCommission,
            saleCommission: entry.saleCommission,
            channelCommission: entry.channelCommission,
            orderDate: entry.orderDate,
            paymentDate: entry.paymentDate,
            saleStatus: entry.saleStatus,
            orderStatus: entry.rawStatus,
            isCanceled:
              entry.saleStatus === "CANCELED" || entry.saleStatus === "CANCEL_REQUESTED",
            isReturned: entry.saleStatus === "RETURNED",
            rawPayload: entry.rawPayload,
            createdAt: existingItem?.createdAt ?? nowIso(),
            updatedAt: nowIso(),
          };

          // optionManageCode가 있으면 추가
          if (entry.optionManageCode) {
            payload.optionManageCode = entry.optionManageCode;
          }

          if (existingItem) {
            Object.assign(existingItem, payload);
          } else {
            draft.orderItems.push(payload);
          }
          touchedOrderItemIds.add(payload.id);
          orderItemsUpserted += 1;
        });

        recalculateOrderMappingsForTouchedItems(draft, {
          storeId,
          signatureIds: touchedSignatureIds,
          orderItemIds: touchedOrderItemIds,
        });

        const targetStore = ensureStoreExists(draft, storeId);
        targetStore.lastOrderSyncAt = nowIso();
        targetStore.lastOrderSyncStatus = "SUCCEEDED";
        targetStore.updatedAt = nowIso();
      });

      const result = {
        syncSource,
        ordersUpserted,
        orderItemsUpserted,
        orderSourceSignaturesCreated,
        unknownOrderStatusCount,
        paymentDateMissingCount,
        syncedItemCount: entries.length,
      };

      this.auditLogService.record({
        storeId,
        domain: "ORDER_SYNC",
        action: "RUN",
        targetId: null,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: null,
        afterJson: { dateFrom, dateTo, rangeMode, syncSource },
      });

      return result;
    } catch (error) {
      this.databaseService.write((draft) => {
        const targetStore = ensureStoreExists(draft, storeId);
        targetStore.lastOrderSyncStatus = "FAILED";
        targetStore.updatedAt = nowIso();
      });

      this.auditLogService.record({
        storeId,
        domain: "ORDER_SYNC",
        action: "RUN_FAILED",
        targetId: null,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: null,
        afterJson: {
          dateFrom,
          dateTo,
          rangeMode,
          message: error instanceof Error ? error.message : String(error),
        },
      });

      throw error;
    }
  }

  listOrderItems(query: {
    storeId: string;
    dateFrom?: string;
    dateTo?: string;
    productName?: string;
    optionInfo?: string;
    mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED" | "CONFLICT";
    orderStatus?: string;
    saleStatus?: string;
    paymentDateStatus?: "ALL" | "PRESENT" | "MISSING";
    page?: number;
    pageSize?: number;
  }) {
    const keywordProduct = query.productName ? normalizeText(query.productName) : null;
    const keywordOption = query.optionInfo ? normalizeText(query.optionInfo) : null;
    const snapshot = this.databaseService.getSnapshot();
    const items = snapshot.orderItems
      .filter((item) => item.storeId === query.storeId)
      .filter((item) =>
        query.dateFrom && query.dateTo
          ? !!item.paymentDate && item.paymentDate >= query.dateFrom && item.paymentDate <= query.dateTo
          : true,
      )
      .filter((item) => (keywordProduct ? item.normalizedProductName.includes(keywordProduct) : true))
      .filter((item) => (keywordOption ? item.normalizedOptionInfo.includes(keywordOption) : true))
      .filter((item) =>
        query.mappingStatus && query.mappingStatus !== "ALL"
          ? getOrderItemMappingStatus(snapshot, item) === query.mappingStatus
          : true,
      )
      .filter((item) => (query.orderStatus ? item.orderStatus === query.orderStatus : true))
      .filter((item) => (query.saleStatus ? item.saleStatus === query.saleStatus : true))
      .filter((item) =>
        query.paymentDateStatus && query.paymentDateStatus !== "ALL"
          ? query.paymentDateStatus === "PRESENT"
            ? !!item.paymentDate
            : !item.paymentDate
          : true,
      )
      .sort((left, right) => (right.paymentDate ?? "").localeCompare(left.paymentDate ?? ""));

    return formatApiSuccess(
      paginate(
        items.map((item) => mapOrderItemResponse(snapshot, item)),
        query.page,
        query.pageSize,
      ),
    );
  }

  async listOrderSourceSignatures(query: {
    storeId: string;
    mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED" | "CONFLICT";
    q?: string;
    page?: number;
    pageSize?: number;
  }) {
    const keyword = query.q ? normalizeText(query.q) : null;
    const snapshot = this.databaseService.getSnapshot();
    const salesUnitsById = new Map(snapshot.canonicalSalesUnits.map((item) => [item.id, item]));
    const filteredSignatures = snapshot.orderSourceSignatures
      .filter((item) => item.storeId === query.storeId)
      .filter((item) =>
        query.mappingStatus && query.mappingStatus !== "ALL"
          ? getSignatureMappingStatus(item) === query.mappingStatus
          : true,
      )
      .filter((item) => {
        if (!keyword) {
          return true;
        }

        const salesUnitDisplayName = item.canonicalSalesUnitId
          ? salesUnitsById.get(item.canonicalSalesUnitId)?.displayName
          : null;
        return (
          normalizeText(item.rawProductNameSnapshot).includes(keyword) ||
          normalizeText(item.rawOptionInfoSnapshot ?? "").includes(keyword) ||
          normalizeText(item.sourceSignature).includes(keyword) ||
          normalizeText(salesUnitDisplayName).includes(keyword)
        );
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const pageResult = paginate(filteredSignatures, query.page, query.pageSize);
    const pageSignatureIds = new Set(pageResult.items.map((item) => item.id));

    // Precompute context to avoid N+1 queries during enrichment.
    // Also rebuild page-level usage as a compatibility guard for already-running
    // snapshots that have not passed through normalizeSnapshot after the summary
    // fields were introduced.
    const signatureItemsMap = new Map<string, typeof snapshot.orderItems>();
    const pageUsageMap = new Map<string, number>();
    const pageExternalProductIdMap = new Map<string, string>();
    const pageOptionCodeMap = new Map<string, string>();
    const pageOptionManageCodeMap = new Map<string, string>();
    snapshot.orderItems.forEach((item) => {
      if (!item.orderSourceSignatureId || !pageSignatureIds.has(item.orderSourceSignatureId)) {
        return;
      }
      const relatedItems = signatureItemsMap.get(item.orderSourceSignatureId) ?? [];
      relatedItems.push(item);
      signatureItemsMap.set(item.orderSourceSignatureId, relatedItems);
      pageUsageMap.set(item.orderSourceSignatureId, (pageUsageMap.get(item.orderSourceSignatureId) ?? 0) + 1);
      if (item.externalProductId && !pageExternalProductIdMap.has(item.orderSourceSignatureId)) {
        pageExternalProductIdMap.set(item.orderSourceSignatureId, item.externalProductId);
      }
      if (item.optionCode && !pageOptionCodeMap.has(item.orderSourceSignatureId)) {
        pageOptionCodeMap.set(item.orderSourceSignatureId, item.optionCode);
      }
      if (item.optionManageCode && !pageOptionManageCodeMap.has(item.orderSourceSignatureId)) {
        pageOptionManageCodeMap.set(item.orderSourceSignatureId, item.optionManageCode);
      }
    });

    // Build map of (externalProductId:storeId) -> product info
    const productsByIdMap = new Map<string, { productName: string | null }>();
    snapshot.products.forEach((product) => {
      const key = `${product.externalProductId}:${product.storeId}`;
      productsByIdMap.set(key, { productName: product.productName });
    });

    const enrichmentContext = { signatureItemsMap, productsByIdMap };

    const items = await Promise.all(
      pageResult.items.map(async (item) => {
        const salesUnit = snapshot.canonicalSalesUnits.find((entry) => entry.id === item.canonicalSalesUnitId);
        const enriched = await enrichSignatureDisplayName(snapshot, item, enrichmentContext);
        return {
          id: item.id,
          rawProductNameSnapshot: item.rawProductNameSnapshot,
          rawOptionInfoSnapshot: item.rawOptionInfoSnapshot,
          sourceSignature: item.sourceSignature,
          mappingStatus: getSignatureMappingStatus(item),
          canonicalSalesUnitId: item.canonicalSalesUnitId,
          canonicalDisplayName: salesUnit?.displayName ?? null,
          usageCount: Math.max(item.usageCount ?? 0, pageUsageMap.get(item.id) ?? 0),
          externalProductId: item.sampleExternalProductId ?? pageExternalProductIdMap.get(item.id) ?? null,
          optionCode: item.sampleOptionCode ?? pageOptionCodeMap.get(item.id) ?? null,
          optionManageCode: item.sampleOptionManageCode ?? pageOptionManageCodeMap.get(item.id) ?? null,
          fallbackProductName: enriched.fallbackProductName,
          fallbackProductNameSource: enriched.fallbackProductNameSource,
          storeSlug: null,
        };
      })
    );

    return formatApiSuccess({
      ...pageResult,
      items,
    });
  }

  private updateSignatureUsageSummary(
    draft: ReturnType<DatabaseService["getSnapshot"]>,
    signature: OrderSourceSignature,
    entry: SyncedOrderItemInput,
    previousSignatureId: string | null,
    isNewItem: boolean,
  ): void {
    const seenAt = entry.paymentDate ?? entry.orderDate ?? nowIso();
    const shouldIncrement = isNewItem || previousSignatureId !== signature.id;

    if (previousSignatureId && previousSignatureId !== signature.id) {
      const previousSignature = draft.orderSourceSignatures.find((item) => item.id === previousSignatureId);
      if (previousSignature) {
        previousSignature.usageCount = Math.max(0, (previousSignature.usageCount ?? 0) - 1);
        previousSignature.updatedAt = nowIso();
      }
    }

    if (shouldIncrement) {
      signature.usageCount = (signature.usageCount ?? 0) + 1;
      if (!signature.firstSeenAt || seenAt < signature.firstSeenAt) {
        signature.firstSeenAt = seenAt;
      }
    }

    if (!signature.firstSeenAt) {
      signature.firstSeenAt = seenAt;
    }
    if (!signature.lastSeenAt || seenAt > signature.lastSeenAt) {
      signature.lastSeenAt = seenAt;
    }
    if (entry.externalProductId && !signature.sampleExternalProductId) {
      signature.sampleExternalProductId = entry.externalProductId;
    }
    if (entry.optionCode && !signature.sampleOptionCode) {
      signature.sampleOptionCode = entry.optionCode;
    }
    if (entry.optionManageCode && !signature.sampleOptionManageCode) {
      signature.sampleOptionManageCode = entry.optionManageCode;
    }
    signature.updatedAt = nowIso();
  }

  private upsertProduct(
    draft: ReturnType<DatabaseService["getSnapshot"]>,
    storeId: string,
    entry: SyncedOrderItemInput,
  ): Product {
    const externalProductId =
      entry.externalProductId ?? `synthetic:${rawToSourceSignature(entry.rawProductName, entry.rawOptionInfo)}`;
    const existing = draft.products.find(
      (item) => item.storeId === storeId && item.externalProductId === externalProductId,
    );

    if (existing) {
      existing.productName = entry.rawProductName;
      existing.normalizedProductName = normalizeText(entry.rawProductName);
      existing.status = entry.saleStatus === "UNKNOWN" ? existing.status : entry.rawStatus;
      existing.lastSeenAt = nowIso();
      existing.updatedAt = nowIso();
      return existing;
    }

    const created: Product = {
      id: createId(),
      storeId,
      externalProductId,
      productName: entry.rawProductName,
      normalizedProductName: normalizeText(entry.rawProductName),
      status: entry.rawStatus,
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    draft.products.push(created);
    return created;
  }

  private upsertSignature(
    draft: ReturnType<DatabaseService["getSnapshot"]>,
    storeId: string,
    rawProductName: string,
    rawOptionInfo: string | null,
  ): OrderSourceSignature {
    const normalizedProductName = normalizeText(rawProductName);
    const normalizedOptionInfo = normalizeText(rawOptionInfo ?? "");
    const existing = draft.orderSourceSignatures.find(
      (item) =>
        item.storeId === storeId &&
        item.normalizedProductName === normalizedProductName &&
        item.normalizedOptionInfo === normalizedOptionInfo,
    );

    if (existing) {
      existing.rawProductNameSnapshot = rawProductName;
      existing.rawOptionInfoSnapshot = rawOptionInfo;
      existing.sourceSignature = rawToSourceSignature(rawProductName, rawOptionInfo);
      existing.usageCount = existing.usageCount ?? 0;
      existing.firstSeenAt = existing.firstSeenAt ?? existing.createdAt ?? null;
      existing.lastSeenAt = existing.lastSeenAt ?? existing.updatedAt ?? null;
      existing.sampleExternalProductId = existing.sampleExternalProductId ?? null;
      existing.sampleOptionCode = existing.sampleOptionCode ?? null;
      existing.sampleOptionManageCode = existing.sampleOptionManageCode ?? null;
      existing.lastAutoMappedAt = existing.lastAutoMappedAt ?? null;
      existing.mappingRuleHash = existing.mappingRuleHash ?? null;
      existing.updatedAt = nowIso();
      return existing;
    }

    return {
      id: createId(),
      storeId,
      sourceSignature: rawToSourceSignature(rawProductName, rawOptionInfo),
      rawProductNameSnapshot: rawProductName,
      rawOptionInfoSnapshot: rawOptionInfo,
      normalizedProductName,
      normalizedOptionInfo,
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
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  private generateMockItems(dateFrom: string, dateTo: string): SyncedOrderItemInput[] {
    const start = new Date(`${dateFrom}T00:00:00+09:00`);
    const end = new Date(`${dateTo}T00:00:00+09:00`);
    const items: SyncedOrderItemInput[] = [];

    for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      const isoDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(cursor);
      ORDER_TEMPLATES.forEach((template, index) => {
        const externalOrderId = `${isoDate.replace(/-/g, "")}${String(index + 1).padStart(4, "0")}`;
        const externalProductOrderId = `${externalOrderId}-ITEM`;
        const rawStatus = RAW_STATUSES[(cursor.getUTCDate() + index) % RAW_STATUSES.length];
        const paymentDate = rawStatus === "CANCEL_REQUEST" ? null : isoDate;
        const saleStatus =
          rawStatus === "CANCEL_REQUEST"
            ? "CANCEL_REQUESTED"
            : rawStatus === "RETURNED"
              ? "RETURNED"
              : rawStatus === "EXCHANGED"
                ? "EXCHANGED"
                : "SALE";

        items.push({
          externalOrderId,
          externalProductOrderId,
          externalProductId: `demo-product-${normalizeText(template.standardKey)}`,
          rawProductName: template.productName,
          rawOptionInfo: template.optionInfo,
          optionCode: null,
          quantity: template.quantity,
          productPaymentAmount: template.price * template.quantity,
          totalProductAmount: template.price * template.quantity,
          deliveryFeeAmount: 3000,
          paymentCommission: saleStatus === "SALE" ? Math.round(template.price * 0.015) : null,
          knowledgeShoppingSellingInterlockCommission:
            saleStatus === "SALE" ? Math.round(template.price * 0.008) : null,
          saleCommission: 0,
          channelCommission: 0,
          orderDate: isoDate,
          paymentDate,
          orderDateTime: `${isoDate}T09:00:00+09:00`,
          paymentDateTime: paymentDate ? `${paymentDate}T09:30:00+09:00` : null,
          productOrderStatus: rawStatus,
          claimStatus: rawStatus === "CANCEL_REQUEST" ? "CANCEL_REQUEST" : null,
          rawStatus,
          saleStatus,
          packageNumber: `PKG-${externalOrderId}`,
          rawPayload: {
            originalOrderStatus: rawStatus,
            claimStatus: rawStatus === "CANCEL_REQUEST" ? "CANCEL_REQUEST" : null,
            productOrderStatus: rawStatus,
          },
        });
      });
    }

    return items;
  }
}
