import { BadRequestException, Injectable, OnModuleInit } from "@nestjs/common";
import { OrderItem, OrderRecord, OrderSourceSignature, Product, normalizeText } from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureKstDateRange,
  ensureStoreExists,
  formatApiSuccess,
  mapOrderItemResponse,
  nowIso,
  paginate,
  rawToSourceSignature,
} from "./helpers";
import { NaverCommerceService, SyncedOrderItemInput } from "./naver-commerce.service";
import { OperationService } from "./operation.service";
import { recalculateOrderMappingsForStore } from "./sales-unit-auto-mapper";

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
      const request = operation.requestJson as { dateFrom: string; dateTo: string; rangeMode: string };
      return this.performSync(
        operation.storeId,
        request.dateFrom,
        request.dateTo,
        request.rangeMode as "MANUAL" | "AUTO_LAST_30_DAYS",
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

  async performSync(
    storeId: string,
    dateFrom: string,
    dateTo: string,
    rangeMode: "MANUAL" | "AUTO_LAST_30_DAYS",
  ) {
    const snapshot = this.databaseService.getSnapshot();
    const store = ensureStoreExists(snapshot, storeId);
    if (!store.isActive) {
      throw new BadRequestException("STORE_INACTIVE");
    }

    try {
      const liveEnabled = !!this.naverCommerceService.getResolvedConfiguration(storeId);
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
          if (entry.saleStatus === "UNKNOWN") {
            unknownOrderStatusCount += 1;
          }
          if (!entry.paymentDate) {
            paymentDateMissingCount += 1;
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

          if (existingItem) {
            Object.assign(existingItem, payload);
          } else {
            draft.orderItems.push(payload);
          }
          orderItemsUpserted += 1;
        });

        recalculateOrderMappingsForStore(draft, storeId);

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
    mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED";
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
          ? query.mappingStatus === "MAPPED"
            ? !!item.canonicalSalesUnitId
            : !item.canonicalSalesUnitId
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

  listOrderSourceSignatures(query: {
    storeId: string;
    mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED";
    q?: string;
    page?: number;
    pageSize?: number;
  }) {
    const keyword = query.q ? normalizeText(query.q) : null;
    const snapshot = this.databaseService.getSnapshot();
    const usageMap = new Map<string, number>();
    snapshot.orderItems
      .filter((item) => item.storeId === query.storeId && item.orderSourceSignatureId)
      .forEach((item) => {
        usageMap.set(item.orderSourceSignatureId!, (usageMap.get(item.orderSourceSignatureId!) ?? 0) + 1);
      });

    const items = snapshot.orderSourceSignatures
      .filter((item) => item.storeId === query.storeId)
      .filter((item) =>
        query.mappingStatus && query.mappingStatus !== "ALL"
          ? query.mappingStatus === "MAPPED"
            ? !!item.canonicalSalesUnitId
            : !item.canonicalSalesUnitId
          : true,
      )
      .filter((item) =>
        keyword
          ? normalizeText(item.rawProductNameSnapshot).includes(keyword) ||
            normalizeText(item.rawOptionInfoSnapshot ?? "").includes(keyword) ||
            normalizeText(item.sourceSignature).includes(keyword)
          : true,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((item) => {
        const salesUnit = snapshot.canonicalSalesUnits.find((entry) => entry.id === item.canonicalSalesUnitId);
        return {
          id: item.id,
          rawProductNameSnapshot: item.rawProductNameSnapshot,
          rawOptionInfoSnapshot: item.rawOptionInfoSnapshot,
          sourceSignature: item.sourceSignature,
          mappingStatus: item.canonicalSalesUnitId ? "MAPPED" : "UNMAPPED",
          canonicalSalesUnitId: item.canonicalSalesUnitId,
          canonicalDisplayName: salesUnit?.displayName ?? null,
          usageCount: usageMap.get(item.id) ?? 0,
        };
      });

    return formatApiSuccess(paginate(items, query.page, query.pageSize));
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
      confirmedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  private generateMockItems(dateFrom: string, dateTo: string): SyncedOrderItemInput[] {
    const start = new Date(`${dateFrom}T00:00:00+09:00`);
    const end = new Date(`${dateTo}T00:00:00+09:00`);
    const items: SyncedOrderItemInput[] = [];

    for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      const isoDate = cursor.toISOString().slice(0, 10);
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
