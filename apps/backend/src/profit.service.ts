import { Injectable, NotFoundException } from "@nestjs/common";
import { VAT_RATE } from "@patima/shared";
import { DatabaseService } from "./database.service";
import {
  calculateDashboardSummary,
  calculateDailyProfitRows,
  calculateFee,
  calculateStoreDeliverySummary,
  calculateVatAmount,
  formatApiSuccess,
  getActiveConfirmedUploadIds,
  getAdMappingStatus,
  getCostSettingForDate,
  getOrderItemMappingStatus,
  paginate,
  repairMojibakeText,
} from "./helpers";

@Injectable()
export class ProfitService {
  constructor(private readonly databaseService: DatabaseService) {}

  getLatestActivityDate(storeId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const activeUploadIds = getActiveConfirmedUploadIds(snapshot, storeId);
    const salesUnitIds = new Set(
      snapshot.canonicalSalesUnits.filter((item) => item.storeId === storeId).map((item) => item.id),
    );
    const eligibleOrderDates = snapshot.orderItems
      .filter(
        (item) =>
          item.storeId === storeId &&
          item.paymentDate &&
          item.saleStatus === "SALE" &&
          item.canonicalSalesUnitId &&
          salesUnitIds.has(item.canonicalSalesUnitId),
      )
      .map((item) => item.paymentDate!)
      .sort((left, right) => left.localeCompare(right));
    const eligibleAdDates = snapshot.adCampaignDailyCosts
      .filter(
        (item) =>
          item.storeId === storeId &&
          item.canonicalSalesUnitId &&
          salesUnitIds.has(item.canonicalSalesUnitId) &&
          activeUploadIds.has(item.sourceUploadId),
      )
      .map((item) => item.reportDate)
      .sort((left, right) => left.localeCompare(right));
    const latestOrderDate = eligibleOrderDates.at(-1) ?? null;
    const latestAdDate = eligibleAdDates.at(-1) ?? null;
    const orderDates = new Set(eligibleOrderDates);
    const latestOverlapDate = eligibleAdDates
      .filter((date) => orderDates.has(date))
      .sort((left, right) => left.localeCompare(right))
      .at(-1) ?? null;
    const date = latestOverlapDate ?? latestOrderDate ?? latestAdDate ?? null;

    return formatApiSuccess({
      date,
      latestOrderDate,
      latestAdDate,
      latestOverlapDate,
    });
  }

  getDashboardSummary(storeId: string, date: string) {
    return formatApiSuccess(calculateDashboardSummary(this.databaseService.getSnapshot(), storeId, date));
  }

  listDailySalesUnits(query: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
    canonicalSalesUnitId?: string;
    includeGroupChildren?: boolean;
    page?: number;
    pageSize?: number;
  }) {
    const rows = calculateDailyProfitRows(
      this.databaseService.getSnapshot(),
      query.storeId,
      query.dateFrom,
      query.dateTo,
      query.canonicalSalesUnitId,
      query.includeGroupChildren,
    );
    return formatApiSuccess(paginate(rows, query.page, query.pageSize));
  }

  getDailySalesUnitDetail(storeId: string, salesUnitId: string, date: string) {
    const snapshot = this.databaseService.getSnapshot();
    const activeUploadIds = getActiveConfirmedUploadIds(snapshot, storeId, date);
    const salesUnit = snapshot.canonicalSalesUnits.find((item) => item.id === salesUnitId && item.storeId === storeId);
    if (!salesUnit) {
      throw new NotFoundException({
        success: false,
        message: "표준 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "salesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }

    const summary =
      calculateDailyProfitRows(snapshot, storeId, date, date, salesUnitId)[0] ?? {
        date,
        canonicalSalesUnitId: salesUnitId,
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
        profitStatus: "COMPLETE" as const,
        vatAmount: 0,
        vatAdjustedRevenue: 0,
      };

    const costSettings = snapshot.salesUnitCostSettings.filter(
      (item) => item.storeId === storeId && item.canonicalSalesUnitId === salesUnitId,
    );
    const orderItems = snapshot.orderItems.filter(
      (item) =>
        item.storeId === storeId &&
        item.canonicalSalesUnitId === salesUnitId &&
        item.paymentDate === date &&
        item.saleStatus === "SALE",
    );
    const adCampaigns = snapshot.adCampaignDailyCosts.filter(
      (item) =>
        item.storeId === storeId &&
        item.canonicalSalesUnitId === salesUnitId &&
        item.reportDate === date &&
        activeUploadIds.has(item.sourceUploadId),
    );

    const aggregatedFeeCandidates = orderItems.reduce(
      (totals, item) => {
        totals.paymentCommission += item.paymentCommission ?? 0;
        totals.knowledgeShoppingSellingInterlockCommission +=
          item.knowledgeShoppingSellingInterlockCommission ?? 0;
        totals.saleCommission += item.saleCommission ?? 0;
        totals.channelCommission += item.channelCommission ?? 0;
        return totals;
      },
      {
        paymentCommission: 0,
        knowledgeShoppingSellingInterlockCommission: 0,
        saleCommission: 0,
        channelCommission: 0,
      },
    );
    const fallbackFeeCostPortion = orderItems.reduce((total, item) => {
      const costSetting = getCostSettingForDate(costSettings, item.paymentDate);
      const fee = calculateFee(item, costSetting);
      return total + (fee.usedFallback ? fee.totalFeeCost : 0);
    }, 0);
    const activeCostSetting = getCostSettingForDate(costSettings, date);
    const excludedSummary = calculateDashboardSummary(snapshot, storeId, date);
    const deliverySummary = calculateStoreDeliverySummary(snapshot, storeId, date, date);

    return formatApiSuccess({
      date,
      canonicalSalesUnitId: salesUnitId,
      displayName: salesUnit.displayName,
      summary,
      orderItems: orderItems.map((item) => ({
        orderItemId: item.id,
        orderId: snapshot.orders.find((order) => order.id === item.orderId)?.externalOrderId ?? item.orderId,
        orderStatus: item.orderStatus,
        saleStatus: item.saleStatus,
        quantity: item.quantity,
        productPaymentAmount: item.productPaymentAmount,
        deliveryFeeAmount: item.deliveryFeeAmount,
      })),
      adCampaigns: adCampaigns.map((item) => ({
        adCostId: item.id,
        campaignName: repairMojibakeText(item.campaignName),
        reportDate: item.reportDate,
        totalCost: item.totalCost,
      })),
      revenueBreakdown: {
        productRevenueOriginal: summary.totalProductRevenue,
        vatRate: VAT_RATE,
        vatAmount: calculateVatAmount(summary.totalProductRevenue),
        vatAdjustedRevenue: summary.vatAdjustedRevenue,
        appliedInEstimatedNetProfit: true,
      },
      deliveryContext: {
        uniquePackageCount: deliverySummary.uniquePackageCount,
        deliveryUnitCost: deliverySummary.deliveryUnitCost,
        estimatedDeliveryBaseCost: deliverySummary.estimatedDeliveryBaseCost,
        customerPaidDeliveryFee: deliverySummary.customerPaidDeliveryFee,
        storeBorneDeliveryCost: deliverySummary.storeBorneDeliveryCost,
        includedInThisSalesUnitNetProfit: false,
        note: "스토어 공통 비용으로 대시보드에서만 순이익에 반영됩니다",
      },
      costBreakdown: {
        costSettingStatus: summary.profitStatus,
        unitCostPerQuantity: activeCostSetting?.unitCost ?? 0,
        otherCostPerQuantity: activeCostSetting?.otherCost ?? 0,
        feeRateFallback: activeCostSetting?.feeRate ?? null,
        computedFeeCost: summary.totalFeeCost,
        fallbackFeeCostPortion,
        aggregatedFeeCandidates,
      },
      excludedSummary: {
        excludedOrderRevenue: excludedSummary.excludedOrderRevenue,
        excludedAdCost: excludedSummary.excludedAdCost,
        excludedUnmappedOrderRevenue: excludedSummary.excludedUnmappedOrderRevenue,
        excludedConflictOrderRevenue: excludedSummary.excludedConflictOrderRevenue,
        excludedNonSaleOrderRevenue: excludedSummary.excludedNonSaleOrderRevenue,
        excludedUnmappedAdCost: excludedSummary.excludedUnmappedAdCost,
        excludedConflictAdCost: excludedSummary.excludedConflictAdCost,
        excludedIntentionalUnmappedAdCost: excludedSummary.excludedIntentionalUnmappedAdCost,
        excludedOrderStatusCounts: {
          CANCELED: snapshot.orderItems.filter(
            (item) => item.storeId === storeId && item.paymentDate === date && item.saleStatus === "CANCELED",
          ).length,
          CANCEL_REQUESTED: snapshot.orderItems.filter(
            (item) =>
              item.storeId === storeId && item.paymentDate === date && item.saleStatus === "CANCEL_REQUESTED",
          ).length,
          RETURNED: snapshot.orderItems.filter(
            (item) => item.storeId === storeId && item.paymentDate === date && item.saleStatus === "RETURNED",
          ).length,
          EXCHANGED: snapshot.orderItems.filter(
            (item) => item.storeId === storeId && item.paymentDate === date && item.saleStatus === "EXCHANGED",
          ).length,
        },
      },
    });
  }

  getUnmappedSummary(storeId: string, dateFrom: string, dateTo: string) {
    const snapshot = this.databaseService.getSnapshot();
    const activeUploadIds = getActiveConfirmedUploadIds(snapshot, storeId);

    // Single pass for order items
    let unmappedOrderItemCount = 0;
    let unmappedOrderRevenue = 0;
    let conflictOrderItemCount = 0;
    let conflictOrderRevenue = 0;

    for (const item of snapshot.orderItems) {
      if (item.storeId !== storeId) continue;
      if (!item.paymentDate || item.paymentDate < dateFrom || item.paymentDate > dateTo) continue;
      if (item.saleStatus !== "SALE") continue;

      const status = getOrderItemMappingStatus(snapshot, item);
      if (status === "UNMAPPED") {
        unmappedOrderItemCount++;
        unmappedOrderRevenue += item.productPaymentAmount;
      } else if (status === "CONFLICT") {
        conflictOrderItemCount++;
        conflictOrderRevenue += item.productPaymentAmount;
      }
    }

    // Single pass for ad campaigns
    let unmappedCampaignCount = 0;
    let unmappedAdCost = 0;
    let conflictCampaignCount = 0;
    let conflictAdCost = 0;
    let intentionalUnmappedCampaignCount = 0;
    let intentionalUnmappedAdCost = 0;

    for (const item of snapshot.adCampaignDailyCosts) {
      if (item.storeId !== storeId) continue;
      if (item.reportDate < dateFrom || item.reportDate > dateTo) continue;
      if (!activeUploadIds.has(item.sourceUploadId)) continue;

      const status = getAdMappingStatus(item);
      if (status === "UNMAPPED") {
        unmappedCampaignCount++;
        unmappedAdCost += item.totalCost;
      } else if (status === "CONFLICT") {
        conflictCampaignCount++;
        conflictAdCost += item.totalCost;
      } else if (item.mappingReason === "INTENTIONALLY_UNMAPPED") {
        intentionalUnmappedCampaignCount++;
        intentionalUnmappedAdCost += item.totalCost;
      }
    }

    return formatApiSuccess({
      unmappedOrderItemCount,
      unmappedOrderRevenue,
      conflictOrderItemCount,
      conflictOrderRevenue,
      unmappedCampaignCount,
      unmappedAdCost,
      conflictCampaignCount,
      conflictAdCost,
      intentionalUnmappedCampaignCount,
      intentionalUnmappedAdCost,
    });
  }
}
