import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { BadRequestException, Injectable, OnModuleInit } from "@nestjs/common";
import {
  OrderItem,
  OrderRecord,
  OrderSourceSignature,
  Product,
  normalizeText,
} from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureStoreExists,
  formatApiSuccess,
  getSignatureMappingStatus,
  mapOrderItemResponse,
  nowIso,
  paginate,
  rawToSourceSignature,
  stripOrderItemRepeatedTextFields,
} from "./helpers";
import {
  NaverCommerceService,
  SyncedOrderItemInput,
} from "./naver-commerce.service";
import {
  OrderSyncBatchService,
  OrderSyncRequest,
} from "./order-sync-batch.service";
import {
  OperationService,
  OperationExecutionContext,
} from "./operation.service";
import { ProfitSummaryService } from "./profit-summary.service";
import {
  getKstRetentionCutoffDate,
  getOrderRawPayloadRetentionDays,
  getSyncedOrderItemRetentionDate,
  pruneExpiredOrderRawPayloads,
  shouldRetainOrderRawPayload,
} from "./raw-payload-retention";
import { recalculateOrderMappingsForTouchedItems } from "./sales-unit-auto-mapper";
import {
  enrichSignatureDisplayName,
  type EnrichmentContext,
} from "./signature-enrichment";

@Injectable()
export class OrderSyncService implements OnModuleInit {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly operationService: OperationService,
    private readonly auditLogService: AuditLogService,
    private readonly naverCommerceService: NaverCommerceService,
    private readonly profitSummaryService?: ProfitSummaryService,
    private readonly batchService: OrderSyncBatchService = new OrderSyncBatchService(
      databaseService,
    ),
  ) {}

  onModuleInit(): void {
    this.operationService.registerRetryExecutor(
      "ORDER_SYNC",
      async (operation, context) => {
        if (
          operation.requestJson?.schemaVersion &&
          operation.requestJson.schemaVersion !== 1
        )
          throw Object.assign(new Error("UNSUPPORTED_REQUEST_SCHEMA"), {
            code: "UNSUPPORTED_REQUEST_SCHEMA",
            retryable: false,
          });
        const request = operation.requestJson as {
          dateFrom: string;
          dateTo: string;
          rangeMode: string;
          requireLiveCredential?: boolean;
          mode?: string;
          requestedCutoffAt?: string;
        };
        return this.performSync(
          operation.storeId,
          request.dateFrom,
          request.dateTo,
          request.rangeMode as "MANUAL" | "AUTO_YESTERDAY" | "AUTO_LAST_30_DAYS",
          {
            mode: request.mode,
            requestedCutoffAt: request.requestedCutoffAt ?? operation.cutoffAt,
            context,
          },
        );
      },
    );
  }

  async enqueueSync(
    storeId: string,
    dateFrom?: string,
    dateTo?: string,
    input: OrderSyncRequest = {},
  ) {
    const batch = await this.batchService.enqueue(
      { ...input, dateFrom, dateTo },
      storeId,
    );
    return formatApiSuccess({
      ...batch,
      operationId: batch.items[0]?.operationId ?? null,
    });
  }

  async enqueueSyncAll(
    dateFrom?: string,
    dateTo?: string,
    input: OrderSyncRequest = {},
  ) {
    return formatApiSuccess(
      await this.batchService.enqueue({ ...input, dateFrom, dateTo }),
    );
  }

  async performSync(
    storeId: string,
    dateFrom: string,
    dateTo: string,
    rangeMode: "MANUAL" | "AUTO_YESTERDAY" | "AUTO_LAST_30_DAYS",
    options?: {
      requireLiveCredential?: boolean;
      mode?: string;
      requestedCutoffAt?: string;
      context?: OperationExecutionContext;
    },
  ) {
    const snapshot = this.databaseService.getSnapshot();
    const store = ensureStoreExists(snapshot, storeId);
    if (!store.isActive) {
      throw new BadRequestException("STORE_INACTIVE");
    }

    await options?.context?.progress({
      stage: "VALIDATING",
      stageStartedAt: nowIso(),
    });
    let resolvedConfiguration;
    try {
      resolvedConfiguration =
        this.naverCommerceService.getResolvedConfiguration(storeId);
    } catch {
      throw Object.assign(new Error("NAVER_CREDENTIAL_DECRYPT_FAILED"), {
        code: "NAVER_CREDENTIAL_DECRYPT_FAILED",
        retryable: false,
        safeMessage: "스토어 인증 정보를 읽을 수 없습니다.",
        actionHint: "스토어 설정에서 인증 정보를 다시 저장하세요.",
      });
    }
    const liveEnabled = !!resolvedConfiguration;

    if (!liveEnabled) {
      throw Object.assign(new Error("NAVER_CREDENTIALS_NOT_CONFIGURED"), {
        code: "NAVER_CREDENTIALS_NOT_CONFIGURED",
        retryable: false,
        safeMessage: "네이버 인증 설정이 필요합니다.",
        actionHint: "스토어 설정에서 인증 정보를 입력하세요.",
      });
    }

    const rawPayloadRetentionDays = getOrderRawPayloadRetentionDays();
    const rawPayloadRetentionCutoffDate = getKstRetentionCutoffDate(
      rawPayloadRetentionDays,
    );
    const includeRawPayload = rawPayloadRetentionDays > 0;
    const syncSource = "NAVER_LIVE";
    const context = options?.context;
    const cutoff = options?.requestedCutoffAt ?? nowIso();
    const state = snapshot.orderSyncStates.find(
      (item) => item.storeId === storeId,
    );
    const current = options?.mode === "CURRENT";
    // This is an application verification policy, not a claim about Naver retention.
    const recoveryFrom = new Date(
      new Date(cutoff).getTime() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const changedWatermark = [
      state?.lastSuccessfulChangedTo,
      state?.changedCoverageBaselineAt,
    ]
      .filter((value): value is string => !!value)
      .sort()
      .at(-1);
    const coverageGap =
      current && changedWatermark && changedWatermark < recoveryFrom
        ? {
            code: "COVERAGE_GAP" as const,
            from: changedWatermark,
            to: recoveryFrom,
            reason:
              "앱 검증 정책(30일)을 넘긴 변경 이력 공백입니다. 네이버 보존기간은 보장되지 않아 과거 미발견 주문까지 복구했다고 확인할 수 없습니다.",
          }
        : null;
    const changedFrom = current
      ? coverageGap
        ? recoveryFrom
        : (changedWatermark ?? recoveryFrom)
      : undefined;
    const affectedDates = new Set<string>(
      (snapshot.operations.find((item) => item.id === context?.fence.id)
        ?.progressJson?.affectedDates as string[] | undefined) ?? [],
    );
    let syncedItemCount = 0;
    await context?.progress({
      stage: "AUTHENTICATING",
      stageStartedAt: nowIso(),
    });
    let ordersUpserted = 0;
    let orderItemsUpserted = 0;
    let orderSourceSignaturesCreated = 0;
    let unknownOrderStatusCount = 0;
    let paymentDateMissingCount = 0;
    let rawPayloadPrunedOrderCount = 0;
    let rawPayloadPrunedOrderItemCount = 0;

    for await (const chunk of this.naverCommerceService.streamOrderItems(
      storeId,
      dateFrom,
      dateTo,
      {
        includeRawPayload,
        requestedCutoffAt: cutoff,
        changedFrom,
        existingProductOrderIds:
          current && (!state || coverageGap)
            ? snapshot.orderItems
                .filter((item) => item.storeId === storeId)
                .map((item) => item.externalProductOrderId)
            : undefined,
        signal: context?.signal,
        onProgress: async (progress) => {
          await context?.progress(progress);
        },
      },
    )) {
      context?.signal.throwIfAborted();
      const entries = chunk.items;
      syncedItemCount += entries.length;
      await context?.progress({
        stage: "SAVING",
        fetchedCount: chunk.fetchedCount,
        validatedCount: chunk.validatedCount,
      });
      await this.databaseService.commitOrderSync(
        (draft) => {
          const ordersById = new Map(
            draft.orders
              .filter((item) => item.storeId === storeId)
              .map((item) => [item.externalOrderId, item]),
          );
          const itemsById = new Map(
            draft.orderItems
              .filter((item) => item.storeId === storeId)
              .map((item) => [item.externalProductOrderId, item]),
          );
          const productsById = new Map(
            draft.products
              .filter((item) => item.storeId === storeId)
              .map((item) => [item.externalProductId, item]),
          );
          const signatureKey = (name: string, option: string | null) =>
            JSON.stringify([normalizeText(name), normalizeText(option ?? "")]);
          const signaturesByKey = new Map(
            draft.orderSourceSignatures
              .filter((item) => item.storeId === storeId)
              .map((item) => [
                signatureKey(
                  item.rawProductNameSnapshot,
                  item.rawOptionInfoSnapshot,
                ),
                item,
              ]),
          );
          const touchedSignatureIds = new Set<string>();
          const touchedOrderItemIds = new Set<string>();

          entries.forEach((entry) => {
            const rawPayloadReferenceDate =
              getSyncedOrderItemRetentionDate(entry);
            const retainedRawPayload =
              entry.rawPayload &&
              shouldRetainOrderRawPayload(
                rawPayloadReferenceDate,
                rawPayloadRetentionCutoffDate,
                rawPayloadRetentionDays,
              )
                ? entry.rawPayload
                : null;
            const product = this.upsertProduct(
              draft,
              storeId,
              entry,
              productsById,
            );
            const key = signatureKey(entry.rawProductName, entry.rawOptionInfo);
            const existingSignature = signaturesByKey.get(key);
            const signature = this.upsertSignature(
              draft,
              storeId,
              entry.rawProductName,
              entry.rawOptionInfo,
              existingSignature,
            );
            if (!existingSignature) {
              draft.orderSourceSignatures.push(signature);
              signaturesByKey.set(key, signature);
              orderSourceSignaturesCreated += 1;
            }
            const existingOrder = ordersById.get(entry.externalOrderId);
            let orderRecord: OrderRecord;

            if (existingOrder) {
              existingOrder.orderDatetime = entry.orderDateTime;
              existingOrder.paymentDatetime = entry.paymentDateTime;
              existingOrder.orderStatus = entry.rawStatus;
              existingOrder.rawPayload = retainedRawPayload;
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
                rawPayload: retainedRawPayload,
                syncedAt: nowIso(),
                createdAt: nowIso(),
                updatedAt: nowIso(),
              };
              draft.orders.push(orderRecord);
              ordersById.set(entry.externalOrderId, orderRecord);
              ordersUpserted += 1;
            }

            const existingItem = itemsById.get(entry.externalProductOrderId);
            if (existingItem?.paymentDate)
              affectedDates.add(existingItem.paymentDate);
            if (entry.paymentDate) affectedDates.add(entry.paymentDate);
            const previousSignatureId =
              existingItem?.orderSourceSignatureId ?? null;
            if (entry.saleStatus === "UNKNOWN") {
              unknownOrderStatusCount += 1;
            }
            if (!entry.paymentDate) {
              paymentDateMissingCount += 1;
            }

            this.updateSignatureUsageSummary(
              draft,
              signature,
              entry,
              previousSignatureId,
              !existingItem,
            );
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
                entry.saleStatus === "CANCELED" ||
                entry.saleStatus === "CANCEL_REQUESTED",
              isReturned: entry.saleStatus === "RETURNED",
              rawPayload: retainedRawPayload,
              createdAt: existingItem?.createdAt ?? nowIso(),
              updatedAt: nowIso(),
            };

            // optionManageCode가 있으면 추가
            if (entry.optionManageCode) {
              payload.optionManageCode = entry.optionManageCode;
            }

            if (existingItem) {
              Object.assign(existingItem, payload);
              stripOrderItemRepeatedTextFields(existingItem);
            } else {
              draft.orderItems.push(stripOrderItemRepeatedTextFields(payload));
              itemsById.set(entry.externalProductOrderId, payload);
            }
            touchedOrderItemIds.add(payload.id);
            orderItemsUpserted += 1;
          });

          recalculateOrderMappingsForTouchedItems(draft, {
            storeId,
            signatureIds: touchedSignatureIds,
            orderItemIds: touchedOrderItemIds,
          });

          if (context) {
            const operation = draft.operations.find(
              (item) => item.id === context.fence.id,
            )!;
            operation.progressJson = {
              ...operation.progressJson,
              affectedDates: [...affectedDates],
              checkpoint: chunk.checkpoint,
              committedCount: syncedItemCount,
              stage: "SAVING",
              lastProgressAt: nowIso(),
            };
          }
        },
        context?.fence,
        storeId,
        {
          orderIds: new Set(entries.map((entry) => entry.externalOrderId)),
          itemIds: new Set(
            entries.map((entry) => entry.externalProductOrderId),
          ),
        },
      );
      await context?.progress({
        committedCount: syncedItemCount,
        affectedDates: [...affectedDates],
        checkpoint: chunk.checkpoint,
      });
      await yieldToEventLoop();
    }
    // Retention applies to historical rows too, once per run rather than once per fetched chunk.
    const retainedSnapshot = this.databaseService.getSnapshot();
    if (
      retainedSnapshot.orders.some(
        (item) => item.storeId === storeId && item.rawPayload,
      ) ||
      retainedSnapshot.orderItems.some(
        (item) => item.storeId === storeId && item.rawPayload,
      )
    ) {
      await this.databaseService.commitOrderSync(
        (draft) => {
          const pruned = pruneExpiredOrderRawPayloads(
            draft,
            storeId,
            rawPayloadRetentionCutoffDate,
            rawPayloadRetentionDays,
          );
          rawPayloadPrunedOrderCount = pruned.prunedOrderCount;
          rawPayloadPrunedOrderItemCount = pruned.prunedOrderItemCount;
        },
        context?.fence,
        storeId,
        {
          orderIds: new Set(
            retainedSnapshot.orders
              .filter((item) => item.storeId === storeId && item.rawPayload)
              .map((item) => item.externalOrderId),
          ),
          itemIds: new Set(
            retainedSnapshot.orderItems
              .filter((item) => item.storeId === storeId && item.rawPayload)
              .map((item) => item.externalProductOrderId),
          ),
        },
      );
    }
    await context?.progress({ stage: "RECALCULATING" });
    const dates = [...affectedDates].sort();
    const summaryRecalculation = this.profitSummaryService
      ? await this.profitSummaryService.refreshStoreDateListBestEffort({
          storeId,
          dates,
          reason: "ORDER_SYNC",
        })
      : null;

    const result = {
      syncSource,
      ordersUpserted,
      orderItemsUpserted,
      orderSourceSignaturesCreated,
      unknownOrderStatusCount,
      paymentDateMissingCount,
      syncedItemCount,
      coverageGap,
      historicalCoverageGap: state?.historicalCoverageGap ?? null,
      affectedDates: dates,
      summaryStatus: summaryRecalculation ? "SUCCEEDED" : "WARNING",
      summaryWarning: summaryRecalculation
        ? null
        : "주문 저장 완료 · 손익 집계 갱신 필요",
      rawPayloadRetentionDays,
      rawPayloadRetentionCutoffDate,
      rawPayloadPrunedOrderCount,
      rawPayloadPrunedOrderItemCount,
      ...(summaryRecalculation ? { summaryRecalculation } : {}),
    };

    await context?.progress({
      stage: "FINALIZING",
      summaryStatus: result.summaryStatus,
    });
    return result;
  }

  async listOrderItems(query: {
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
    const snapshot = this.databaseService.getSnapshot();
    const result = await this.databaseService.queryOrderItems(query);
    return formatApiSuccess({
      ...result,
      items: result.items.map((item) => mapOrderItemResponse(snapshot, item)),
    });
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
    const salesUnitsById = new Map(
      snapshot.canonicalSalesUnits.map((item) => [item.id, item]),
    );
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
      if (
        !item.orderSourceSignatureId ||
        !pageSignatureIds.has(item.orderSourceSignatureId)
      ) {
        return;
      }
      const relatedItems =
        signatureItemsMap.get(item.orderSourceSignatureId) ?? [];
      relatedItems.push(item);
      signatureItemsMap.set(item.orderSourceSignatureId, relatedItems);
      pageUsageMap.set(
        item.orderSourceSignatureId,
        (pageUsageMap.get(item.orderSourceSignatureId) ?? 0) + 1,
      );
      if (
        item.externalProductId &&
        !pageExternalProductIdMap.has(item.orderSourceSignatureId)
      ) {
        pageExternalProductIdMap.set(
          item.orderSourceSignatureId,
          item.externalProductId,
        );
      }
      if (
        item.optionCode &&
        !pageOptionCodeMap.has(item.orderSourceSignatureId)
      ) {
        pageOptionCodeMap.set(item.orderSourceSignatureId, item.optionCode);
      }
      if (
        item.optionManageCode &&
        !pageOptionManageCodeMap.has(item.orderSourceSignatureId)
      ) {
        pageOptionManageCodeMap.set(
          item.orderSourceSignatureId,
          item.optionManageCode,
        );
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
        const salesUnit = snapshot.canonicalSalesUnits.find(
          (entry) => entry.id === item.canonicalSalesUnitId,
        );
        const enriched = await enrichSignatureDisplayName(
          snapshot,
          item,
          enrichmentContext,
        );
        return {
          id: item.id,
          rawProductNameSnapshot: item.rawProductNameSnapshot,
          rawOptionInfoSnapshot: item.rawOptionInfoSnapshot,
          sourceSignature: item.sourceSignature,
          mappingStatus: getSignatureMappingStatus(item),
          canonicalSalesUnitId: item.canonicalSalesUnitId,
          canonicalDisplayName: salesUnit?.displayName ?? null,
          usageCount: Math.max(
            item.usageCount ?? 0,
            pageUsageMap.get(item.id) ?? 0,
          ),
          externalProductId:
            item.sampleExternalProductId ??
            pageExternalProductIdMap.get(item.id) ??
            null,
          optionCode:
            item.sampleOptionCode ?? pageOptionCodeMap.get(item.id) ?? null,
          optionManageCode:
            item.sampleOptionManageCode ??
            pageOptionManageCodeMap.get(item.id) ??
            null,
          fallbackProductName: enriched.fallbackProductName,
          fallbackProductNameSource: enriched.fallbackProductNameSource,
          storeSlug: null,
        };
      }),
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
      const previousSignature = draft.orderSourceSignatures.find(
        (item) => item.id === previousSignatureId,
      );
      if (previousSignature) {
        previousSignature.usageCount = Math.max(
          0,
          (previousSignature.usageCount ?? 0) - 1,
        );
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
    productsById: Map<string, Product>,
  ): Product {
    const externalProductId =
      entry.externalProductId ??
      `synthetic:${rawToSourceSignature(entry.rawProductName, entry.rawOptionInfo)}`;
    const existing = productsById.get(externalProductId);

    if (existing) {
      existing.productName = entry.rawProductName;
      existing.normalizedProductName = normalizeText(entry.rawProductName);
      existing.status =
        entry.saleStatus === "UNKNOWN" ? existing.status : entry.rawStatus;
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
    productsById.set(externalProductId, created);
    return created;
  }

  private upsertSignature(
    draft: ReturnType<DatabaseService["getSnapshot"]>,
    storeId: string,
    rawProductName: string,
    rawOptionInfo: string | null,
    existing?: OrderSourceSignature,
  ): OrderSourceSignature {
    const normalizedProductName = normalizeText(rawProductName);
    const normalizedOptionInfo = normalizeText(rawOptionInfo ?? "");

    if (existing) {
      existing.rawProductNameSnapshot = rawProductName;
      existing.rawOptionInfoSnapshot = rawOptionInfo;
      existing.sourceSignature = rawToSourceSignature(
        rawProductName,
        rawOptionInfo,
      );
      existing.usageCount = existing.usageCount ?? 0;
      existing.firstSeenAt = existing.firstSeenAt ?? existing.createdAt ?? null;
      existing.lastSeenAt = existing.lastSeenAt ?? existing.updatedAt ?? null;
      existing.sampleExternalProductId =
        existing.sampleExternalProductId ?? null;
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
}
