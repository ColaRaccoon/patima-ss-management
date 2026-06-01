import { BadRequestException, Injectable } from "@nestjs/common";
import type {
  DailySalesUnitProfit,
  DashboardSummary,
  DatabaseShape,
  StoredDailySalesUnitProfit,
  StoredDailyStoreSummary,
} from "@patima/shared";
import { DatabaseService } from "./database.service";
import {
  calculateDashboardSummary,
  calculateDailyProfitRows,
  createId,
  ensureDateString,
  ensureStoreExists,
  formatApiSuccess,
  nowIso,
} from "./helpers";

export const PROFIT_CALCULATION_VERSION = "profit-v1";

export type ProfitSummaryRecalculateReason =
  | "ORDER_SYNC"
  | "AD_UPLOAD"
  | "COST_CHANGE"
  | "MAPPING_CHANGE"
  | "MANUAL";

const enumerateDates = (dateFrom: string, dateTo: string): string[] => {
  ensureDateString(dateFrom, "dateFrom");
  ensureDateString(dateTo, "dateTo");

  const dates: string[] = [];
  const current = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);

  if (current.getTime() > end.getTime()) {
    throw new BadRequestException({
      success: false,
      message: "dateFrom must be before or equal to dateTo.",
      errors: [{ field: "dateFrom", reason: "INVALID_DATE_RANGE" }],
    });
  }

  while (current.getTime() <= end.getTime()) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
};

const stripStoredSalesUnitFields = (row: StoredDailySalesUnitProfit): DailySalesUnitProfit => {
  const { id, storeId, costSnapshotId, mappingBasisHash, calculationVersion, calculatedAt, createdAt, updatedAt, ...profitRow } = row;
  return {
    ...profitRow,
    childRows: profitRow.childRows?.map((childRow) => ({ ...childRow })),
  };
};

const stripStoredStoreSummaryFields = (row: StoredDailyStoreSummary): DashboardSummary => {
  const { id, storeId, calculationVersion, calculatedAt, createdAt, updatedAt, ...summary } = row;
  return { ...summary };
};

@Injectable()
export class ProfitSummaryService {
  constructor(private readonly databaseService: DatabaseService) {}

  async recalculateStoreDates(params: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
    reason: ProfitSummaryRecalculateReason;
  }) {
    const dates = enumerateDates(params.dateFrom, params.dateTo);
    return this.recalculateStoreDateList({
      storeId: params.storeId,
      dates,
      reason: params.reason,
    });
  }

  async recalculateStoreDatesSince(params: {
    storeId: string;
    dateFrom: string;
    reason: ProfitSummaryRecalculateReason;
  }) {
    ensureDateString(params.dateFrom, "dateFrom");
    const snapshot = this.databaseService.getSnapshot();
    const dates = this.collectKnownProfitDatesFrom(snapshot, params.storeId, params.dateFrom);
    return this.recalculateStoreDateList({
      storeId: params.storeId,
      dates,
      reason: params.reason,
    });
  }

  async refreshStoreDatesBestEffort(params: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
    reason: ProfitSummaryRecalculateReason;
  }) {
    try {
      const dates = enumerateDates(params.dateFrom, params.dateTo);
      return this.refreshStoreDateListBestEffort({
        storeId: params.storeId,
        dates,
        reason: params.reason,
      });
    } catch {
      return null;
    }
  }

  async refreshStoreDateListBestEffort(params: {
    storeId: string;
    dates: string[];
    reason: ProfitSummaryRecalculateReason;
  }) {
    try {
      return (await this.recalculateStoreDateList(params)).data;
    } catch {
      try {
        await this.invalidateStoreDateList(params);
      } catch {
        return null;
      }
      return null;
    }
  }

  async refreshStoreDatesSinceBestEffort(params: {
    storeId: string;
    dateFrom: string;
    reason: ProfitSummaryRecalculateReason;
  }) {
    try {
      ensureDateString(params.dateFrom, "dateFrom");
      const snapshot = this.databaseService.getSnapshot();
      return this.refreshStoreDateListBestEffort({
        storeId: params.storeId,
        dates: this.collectKnownProfitDatesFrom(snapshot, params.storeId, params.dateFrom),
        reason: params.reason,
      });
    } catch {
      return null;
    }
  }

  private async recalculateStoreDateList(params: {
    storeId: string;
    dates: string[];
    reason: ProfitSummaryRecalculateReason;
  }) {
    const dates = this.normalizeDates(params.dates);
    ensureStoreExists(this.databaseService.getSnapshot(), params.storeId);
    const calculatedAt = nowIso();
    let salesUnitRowCount = 0;
    let storeSummaryRowCount = 0;

    await this.databaseService.writeCommitted((draft) => {
      const salesUnitRows = dates.flatMap((date) =>
        this.createStoredSalesUnitRows({
          database: draft,
          storeId: params.storeId,
          date,
          calculatedAt,
        }),
      );
      const storeSummaryRows = dates.map((date) =>
        this.createStoredStoreSummaryRow({
          database: draft,
          storeId: params.storeId,
          date,
          calculatedAt,
        }),
      );

      const dateSet = new Set(dates);
      draft.dailySalesUnitProfits = draft.dailySalesUnitProfits.filter(
        (row) => row.storeId !== params.storeId || !dateSet.has(row.date),
      );
      draft.dailyStoreSummaries = draft.dailyStoreSummaries.filter(
        (row) => row.storeId !== params.storeId || !dateSet.has(row.date),
      );

      draft.dailySalesUnitProfits.push(...salesUnitRows);
      draft.dailyStoreSummaries.push(...storeSummaryRows);
      salesUnitRowCount = salesUnitRows.length;
      storeSummaryRowCount = storeSummaryRows.length;
    });

    return formatApiSuccess({
      recalculatedDateCount: dates.length,
      salesUnitRowCount,
      storeSummaryRowCount,
      reason: params.reason,
    });
  }

  private async invalidateStoreDateList(params: {
    storeId: string;
    dates: string[];
    reason: ProfitSummaryRecalculateReason;
  }) {
    const dates = this.normalizeDates(params.dates);
    if (dates.length === 0) {
      return formatApiSuccess({
        invalidatedDateCount: 0,
        reason: params.reason,
      });
    }

    const dateSet = new Set(dates);
    await this.databaseService.writeCommitted((draft) => {
      draft.dailySalesUnitProfits = draft.dailySalesUnitProfits.filter(
        (row) => row.storeId !== params.storeId || !dateSet.has(row.date),
      );
      draft.dailyStoreSummaries = draft.dailyStoreSummaries.filter(
        (row) => row.storeId !== params.storeId || !dateSet.has(row.date),
      );
    });

    return formatApiSuccess({
      invalidatedDateCount: dates.length,
      reason: params.reason,
    });
  }

  getDashboardSummary(storeId: string, date: string): DashboardSummary | null {
    const row = this.databaseService
      .getSnapshot()
      .dailyStoreSummaries.find((item) => item.storeId === storeId && item.date === date);
    return row ? stripStoredStoreSummaryFields(row) : null;
  }

  listDailySalesUnitRows(query: {
    storeId: string;
    dateFrom: string;
    dateTo: string;
    canonicalSalesUnitId?: string;
    includeGroupChildren?: boolean;
  }): DailySalesUnitProfit[] | null {
    const dates = enumerateDates(query.dateFrom, query.dateTo);
    const snapshot = this.databaseService.getSnapshot();
    const summaryDates = new Set(
      snapshot.dailyStoreSummaries
        .filter((row) => row.storeId === query.storeId && row.date >= query.dateFrom && row.date <= query.dateTo)
        .map((row) => row.date),
    );

    if (summaryDates.size === 0) {
      return null;
    }

    const storedRows = snapshot.dailySalesUnitProfits
      .filter((row) => row.storeId === query.storeId && row.date >= query.dateFrom && row.date <= query.dateTo)
      .filter((row) => summaryDates.has(row.date))
      .flatMap((row) => this.toApiSalesUnitRows(row, query.canonicalSalesUnitId))
      .map((row) => (query.includeGroupChildren ? row : { ...row, childRows: undefined }));
    const liveRows = dates
      .filter((date) => !summaryDates.has(date))
      .flatMap((date) =>
        calculateDailyProfitRows(
          snapshot,
          query.storeId,
          date,
          date,
          query.canonicalSalesUnitId,
          query.includeGroupChildren,
        ),
      );

    return [...storedRows, ...liveRows]
      .sort((left, right) =>
        left.date === right.date
          ? left.displayName.localeCompare(right.displayName, "ko")
          : left.date.localeCompare(right.date),
      );
  }

  private createStoredSalesUnitRows(params: {
    database: DatabaseShape;
    storeId: string;
    date: string;
    calculatedAt: string;
  }): StoredDailySalesUnitProfit[] {
    return calculateDailyProfitRows(params.database, params.storeId, params.date, params.date, undefined, true).map((row) =>
      this.toStoredSalesUnitProfit(row, params.storeId, params.calculatedAt),
    );
  }

  private createStoredStoreSummaryRow(params: {
    database: DatabaseShape;
    storeId: string;
    date: string;
    calculatedAt: string;
  }): StoredDailyStoreSummary {
    const summary = calculateDashboardSummary(params.database, params.storeId, params.date);
    return {
      id: this.storeSummaryId(params.storeId, params.date),
      storeId: params.storeId,
      ...summary,
      calculationVersion: PROFIT_CALCULATION_VERSION,
      calculatedAt: params.calculatedAt,
      createdAt: params.calculatedAt,
      updatedAt: params.calculatedAt,
    };
  }

  private toStoredSalesUnitProfit(
    row: DailySalesUnitProfit,
    storeId: string,
    calculatedAt: string,
  ): StoredDailySalesUnitProfit {
    return {
      ...row,
      childRows: row.childRows?.map((childRow) => ({ ...childRow })),
      id: this.salesUnitProfitId(storeId, row.date, row.canonicalSalesUnitId),
      storeId,
      costSnapshotId: null,
      mappingBasisHash: null,
      calculationVersion: PROFIT_CALCULATION_VERSION,
      calculatedAt,
      createdAt: calculatedAt,
      updatedAt: calculatedAt,
    };
  }

  private matchesSalesUnitFilter(row: StoredDailySalesUnitProfit, canonicalSalesUnitId: string): boolean {
    return row.canonicalSalesUnitId === canonicalSalesUnitId;
  }

  private toApiSalesUnitRows(
    row: StoredDailySalesUnitProfit,
    canonicalSalesUnitId?: string,
  ): DailySalesUnitProfit[] {
    const profitRow = stripStoredSalesUnitFields(row);
    if (!canonicalSalesUnitId) {
      return [profitRow];
    }

    if (this.matchesSalesUnitFilter(row, canonicalSalesUnitId)) {
      return [profitRow];
    }

    const childRow = row.childRows?.find((item) => item.canonicalSalesUnitId === canonicalSalesUnitId);
    return childRow ? [{ ...childRow }] : [];
  }

  private collectKnownProfitDatesFrom(
    database: DatabaseShape,
    storeId: string,
    dateFrom: string,
  ): string[] {
    const dates = new Set<string>();
    database.dailyStoreSummaries
      .filter((row) => row.storeId === storeId && row.date >= dateFrom)
      .forEach((row) => dates.add(row.date));
    database.orderItems
      .filter((row) => row.storeId === storeId && row.paymentDate && row.paymentDate >= dateFrom)
      .forEach((row) => dates.add(row.paymentDate!));
    database.adCampaignDailyCosts
      .filter((row) => row.storeId === storeId && row.reportDate >= dateFrom)
      .forEach((row) => dates.add(row.reportDate));
    return Array.from(dates).sort((left, right) => left.localeCompare(right));
  }

  private normalizeDates(dates: string[]): string[] {
    const normalized = Array.from(new Set(dates.filter(Boolean))).sort((left, right) => left.localeCompare(right));
    normalized.forEach((date) => ensureDateString(date, "date"));
    return normalized;
  }

  private salesUnitProfitId(storeId: string, date: string, canonicalSalesUnitId: string): string {
    return `daily-sales-unit-profit:${storeId}:${date}:${canonicalSalesUnitId || createId()}`;
  }

  private storeSummaryId(storeId: string, date: string): string {
    return `daily-store-summary:${storeId}:${date}`;
  }
}
