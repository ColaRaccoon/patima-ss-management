import { Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import {
  calculateDashboardSummary,
  calculateDailyProfitRows,
  calculateFee,
  formatApiSuccess,
  getAdMappingStatus,
  getCostSettingForDate,
  getOrderItemMappingStatus,
  paginate,
} from "./helpers";

@Injectable()
export class ProfitService {
  constructor(private readonly databaseService: DatabaseService) {}

  getDashboardSummary(storeId: string, date: string) {
    return formatApiSuccess(calculateDashboardSummary(this.databaseService.getSnapshot(), storeId, date));
  }

  listDailySalesUnits(query: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
    canonicalSalesUnitId?: string;
    page?: number;
    pageSize?: number;
  }) {
    const rows = calculateDailyProfitRows(
      this.databaseService.getSnapshot(),
      query.storeId,
      query.dateFrom,
      query.dateTo,
      query.canonicalSalesUnitId,
    );
    return formatApiSuccess(paginate(rows, query.page, query.pageSize));
  }

  getDailySalesUnitDetail(storeId: string, salesUnitId: string, date: string) {
    const snapshot = this.databaseService.getSnapshot();
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
        totalAdCost: 0,
        totalUnitCost: 0,
        totalFeeCost: 0,
        totalOtherCost: 0,
        roughProfit: 0,
        estimatedNetProfit: 0,
        profitStatus: "COMPLETE" as const,
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
        item.reportDate === date,
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
        campaignName: item.campaignName,
        reportDate: item.reportDate,
        totalCost: item.totalCost,
      })),
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
    const activeUploadIds = new Set(
      snapshot.adExcelUploads.filter((item) => item.storeId === storeId && item.isActive).map((item) => item.id),
    );
    const unmappedOrderItems = snapshot.orderItems.filter(
      (item) =>
        item.storeId === storeId &&
        item.paymentDate &&
        item.paymentDate >= dateFrom &&
        item.paymentDate <= dateTo &&
        item.saleStatus === "SALE" &&
        getOrderItemMappingStatus(snapshot, item) === "UNMAPPED",
    );
    const conflictOrderItems = snapshot.orderItems.filter(
      (item) =>
        item.storeId === storeId &&
        item.paymentDate &&
        item.paymentDate >= dateFrom &&
        item.paymentDate <= dateTo &&
        item.saleStatus === "SALE" &&
        getOrderItemMappingStatus(snapshot, item) === "CONFLICT",
    );
    const adRows = snapshot.adCampaignDailyCosts.filter(
      (item) =>
        item.storeId === storeId &&
        item.reportDate >= dateFrom &&
        item.reportDate <= dateTo &&
        activeUploadIds.has(item.sourceUploadId),
    );

    return formatApiSuccess({
      unmappedOrderItemCount: unmappedOrderItems.length,
      unmappedOrderRevenue: unmappedOrderItems.reduce((total, item) => total + item.productPaymentAmount, 0),
      conflictOrderItemCount: conflictOrderItems.length,
      conflictOrderRevenue: conflictOrderItems.reduce((total, item) => total + item.productPaymentAmount, 0),
      unmappedCampaignCount: adRows.filter((item) => getAdMappingStatus(item) === "UNMAPPED").length,
      unmappedAdCost: adRows
        .filter((item) => getAdMappingStatus(item) === "UNMAPPED")
        .reduce((total, item) => total + item.totalCost, 0),
      conflictCampaignCount: adRows.filter((item) => getAdMappingStatus(item) === "CONFLICT").length,
      conflictAdCost: adRows
        .filter((item) => getAdMappingStatus(item) === "CONFLICT")
        .reduce((total, item) => total + item.totalCost, 0),
      intentionalUnmappedCampaignCount: adRows.filter((item) => item.mappingReason === "INTENTIONALLY_UNMAPPED")
        .length,
      intentionalUnmappedAdCost: adRows
        .filter((item) => item.mappingReason === "INTENTIONALLY_UNMAPPED")
        .reduce((total, item) => total + item.totalCost, 0),
    });
  }
}
