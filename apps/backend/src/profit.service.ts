import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { VAT_RATE, SalesUnitCostSnapshotEntry } from "@patima/shared";
import type { DailySalesUnitProfit } from "@patima/shared";
import * as XLSX from "xlsx";
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
  roundHalfUp,
} from "./helpers";
import { ProfitSummaryService } from "./profit-summary.service";

type ExportStoreSummary = {
  fakePurchaseAmount: number | "";
  deliveryMargin: number | "";
  storeNetProfit: number | "";
};

@Injectable()
export class ProfitService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly profitSummaryService?: ProfitSummaryService,
  ) {}

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
    return formatApiSuccess(
      this.profitSummaryService?.getDashboardSummary(storeId, date) ??
        calculateDashboardSummary(this.databaseService.getSnapshot(), storeId, date),
    );
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
    const rows =
      this.profitSummaryService?.listDailySalesUnitRows(query) ??
      calculateDailyProfitRows(
        this.databaseService.getSnapshot(),
        query.storeId,
        query.dateFrom,
        query.dateTo,
        query.canonicalSalesUnitId,
        query.includeGroupChildren,
      );
    return formatApiSuccess(paginate(rows, query.page, query.pageSize));
  }

  exportDailySalesUnitsExcel(query: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
    canonicalSalesUnitId?: string;
  }): Buffer {
    if (!query.storeId || !query.dateFrom || !query.dateTo) {
      throw new BadRequestException({
        success: false,
        message: "storeId, dateFrom, dateTo가 필요합니다.",
        errors: [{ field: "query", reason: "REQUIRED_EXPORT_QUERY_MISSING" }],
      });
    }

    const snapshot = this.databaseService.getSnapshot();
    const rows =
      this.profitSummaryService?.listDailySalesUnitRows({
        storeId: query.storeId,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        canonicalSalesUnitId: query.canonicalSalesUnitId,
        includeGroupChildren: true,
      }) ??
      calculateDailyProfitRows(
        snapshot,
        query.storeId,
        query.dateFrom,
        query.dateTo,
        query.canonicalSalesUnitId,
        true,
      );

    const dailyStoreSummaries = this.buildDailyStoreProfitSummaryMap(
      snapshot,
      query.storeId,
      rows.map((row) => row.date),
    );
    const flatRows = this.flattenDailyProfitRowsForExport(rows, dailyStoreSummaries);
    const headers = [
      "일자",
      "판매단위명",
      "수량",
      "판매가",
      "상품 매출",
      "VAT",
      "광고비",
      "수수료",
      "상품당 고정비용",
      "상품당 고정비 마진률",
      "원가",
      "제품별 순이익",
      "",
      "스토어 가구매값",
      "스토어 배송마진",
      "스토어 전체 순이익",
    ];
    const data: unknown[][] = [headers, ...flatRows];

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(data);
    this.applyIntegerNumberFormat(sheet);
    this.applyPercentageNumberFormat(sheet, headers.indexOf("상품당 고정비 마진률"));
    sheet["!cols"] = [
      { wch: 12 },
      { wch: 32 },
      { wch: 10 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 18 },
      { wch: 20 },
      { wch: 14 },
      { wch: 14 },
      { wch: 4 },
      { wch: 14 },
      { wch: 14 },
      { wch: 18 },
    ];
    XLSX.utils.book_append_sheet(workbook, sheet, "DailyProfitRows");

    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  }

  private buildDailyStoreProfitSummaryMap(
    database: ReturnType<DatabaseService["getSnapshot"]>,
    storeId: string,
    dates: string[],
  ): Map<string, ExportStoreSummary> {
    const uniqueDates = Array.from(new Set(dates));
    const summaryMap = new Map<string, ExportStoreSummary>();

    uniqueDates.forEach((date) => {
      const summary = this.profitSummaryService?.getDashboardSummary(storeId, date) ??
        calculateDashboardSummary(database, storeId, date);
      const fakePurchaseAmount =
        database.dailyFakePurchases.find((row) => row.storeId === storeId && row.date === date)?.amount ?? 0;
      const storeNetProfit =
        summary.estimatedNetProfit == null ? "" : summary.estimatedNetProfit - fakePurchaseAmount;

      summaryMap.set(date, {
        fakePurchaseAmount,
        deliveryMargin: summary.deliveryMargin,
        storeNetProfit,
      });
    });

    return summaryMap;
  }

  private flattenDailyProfitRowsForExport(
    rows: DailySalesUnitProfit[],
    dailyStoreSummaries: Map<string, ExportStoreSummary>,
  ): unknown[][] {
    const flatRows: unknown[][] = [];
    let hasWrittenStoreSummary = false;

    rows.forEach((row) => {
      const storeSummary = dailyStoreSummaries.get(row.date) ?? {
        fakePurchaseAmount: 0,
        deliveryMargin: 0,
        storeNetProfit: "",
      };
      const storeSummaryForRow: ExportStoreSummary = hasWrittenStoreSummary
        ? { fakePurchaseAmount: "", deliveryMargin: "", storeNetProfit: "" }
        : storeSummary;

      flatRows.push(
        this.createDailyProfitExportRow({
          row,
          adCostAmount: row.totalAdCost,
          netProfitAmount: row.estimatedNetProfit ?? "",
          storeSummary: storeSummaryForRow,
          displayQuantity: row.isGroup ? "" : undefined,
        }),
      );
      hasWrittenStoreSummary = true;

      row.childRows?.forEach((childRow) => {
        flatRows.push(
          this.createDailyProfitExportRow({
            row: childRow,
            adCostAmount: "",
            netProfitAmount: "",
            storeSummary: { fakePurchaseAmount: "", deliveryMargin: "", storeNetProfit: "" },
          }),
        );
      });
    });

    return flatRows;
  }

  private createDailyProfitExportRow(params: {
    row: DailySalesUnitProfit;
    adCostAmount: number | "";
    netProfitAmount: number | "";
    storeSummary: ExportStoreSummary;
    displayQuantity?: number | "";
  }): unknown[] {
    const { row, adCostAmount, netProfitAmount, storeSummary, displayQuantity } = params;
    const isStoreLevel = row.isStoreLevel === true;
    const shouldShowPerUnitValues = !isStoreLevel && !row.isGroup;
    const salePrice = shouldShowPerUnitValues && row.totalQuantity > 0
      ? roundHalfUp(row.totalProductRevenue / row.totalQuantity)
      : "";
    const fixedCostPerProduct =
      shouldShowPerUnitValues && row.totalQuantity > 0
        ? roundHalfUp((row.totalFeeCost + row.vatAmount + row.totalUnitCost) / row.totalQuantity)
        : "";
    const fixedCostMarginRate =
      typeof salePrice === "number" && salePrice > 0 && typeof fixedCostPerProduct === "number"
        ? (salePrice - fixedCostPerProduct) / salePrice
        : "";

    return [
      row.date,
      this.formatExportDisplayName(row),
      isStoreLevel ? "" : displayQuantity ?? row.totalQuantity,
      isStoreLevel ? "" : salePrice,
      isStoreLevel ? "" : row.totalProductRevenue,
      isStoreLevel ? "" : row.vatAmount,
      adCostAmount,
      isStoreLevel ? "" : row.totalFeeCost,
      isStoreLevel ? "" : fixedCostPerProduct,
      fixedCostMarginRate,
      isStoreLevel ? "" : row.totalUnitCost,
      isStoreLevel ? "" : netProfitAmount,
      "",
      storeSummary.fakePurchaseAmount,
      storeSummary.deliveryMargin,
      storeSummary.storeNetProfit,
    ];
  }

  private formatExportDisplayName(row: DailySalesUnitProfit): string {
    return row.isGroup ? `[그룹단위]${row.displayName}` : row.displayName;
  }

  private applyIntegerNumberFormat(sheet: XLSX.WorkSheet): void {
    Object.keys(sheet).forEach((cellAddress) => {
      if (cellAddress.startsWith("!")) {
        return;
      }

      const cell = sheet[cellAddress];
      if (cell?.t === "n") {
        cell.z = "0";
      }
    });
  }

  private applyPercentageNumberFormat(sheet: XLSX.WorkSheet, zeroBasedColumnIndex: number): void {
    if (zeroBasedColumnIndex < 0) {
      return;
    }

    const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
    for (let rowIndex = 1; rowIndex <= range.e.r; rowIndex += 1) {
      const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: zeroBasedColumnIndex });
      const cell = sheet[cellAddress];
      if (cell?.t === "n") {
        cell.z = "0.0%";
      }
    }
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

    const summary = this.getDailySalesUnitDetailSummary(snapshot, storeId, salesUnit, date) ?? {
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

    // 스냅샷 기반 비용 조회 구축 (새 모델)
    const snapshots = snapshot.salesUnitCostSnapshots
      .filter((item) => item.storeId === storeId)
      .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));

    const entryIndex = new Map<string, Map<string, SalesUnitCostSnapshotEntry>>();
    snapshot.salesUnitCostSnapshotEntries
      .filter((item) => item.storeId === storeId)
      .forEach((entry) => {
        const sub = entryIndex.get(entry.snapshotId) ?? new Map();
        sub.set(entry.canonicalSalesUnitId, entry);
        entryIndex.set(entry.snapshotId, sub);
      });

    const costSettingsByUnit = snapshots.map((snapshot) => ({
      snapshot,
      entry: entryIndex.get(snapshot.id)?.get(salesUnitId) ?? null,
    }));

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
      const costSetting = getCostSettingForDate(costSettingsByUnit, item.paymentDate);
      const fee = calculateFee(item, costSetting);
      return total + (fee.usedFallback ? fee.totalFeeCost : 0);
    }, 0);
    const activeCostSetting = getCostSettingForDate(costSettingsByUnit, date);
    const excludedSummary = this.profitSummaryService?.getDashboardSummary(storeId, date) ??
      calculateDashboardSummary(snapshot, storeId, date);
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
        deliveryMargin: deliverySummary.deliveryMargin,
        includedInThisSalesUnitNetProfit: false,
        note: "스토어 공통 배송 마진으로 대시보드에서만 순이익에 반영됩니다",
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

  private getDailySalesUnitDetailSummary(
    snapshot: ReturnType<DatabaseService["getSnapshot"]>,
    storeId: string,
    salesUnit: { id: string; parentSalesUnitId?: string | null },
    date: string,
  ): DailySalesUnitProfit | null {
    const storedRow = this.profitSummaryService?.listDailySalesUnitRows({
      storeId,
      dateFrom: date,
      dateTo: date,
      canonicalSalesUnitId: salesUnit.id,
      includeGroupChildren: true,
    })?.find((row) => row.canonicalSalesUnitId === salesUnit.id);
    if (storedRow) {
      return storedRow;
    }

    const liveRows = calculateDailyProfitRows(
      snapshot,
      storeId,
      date,
      date,
      salesUnit.parentSalesUnitId ?? salesUnit.id,
      true,
    );
    return (
      liveRows.find((row) => row.canonicalSalesUnitId === salesUnit.id) ??
      liveRows
        .flatMap((row) => row.childRows ?? [])
        .find((row) => row.canonicalSalesUnitId === salesUnit.id) ??
      liveRows[0] ??
      null
    );
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
