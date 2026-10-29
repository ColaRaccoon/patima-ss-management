import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { calculateNetProfitAfterFakePurchase } from "@patima/shared";
import type { DatabaseShape, SalesUnitCostSetting } from "@patima/shared";
import {
  createEmptyDatabase,
  calculateDashboardSummary,
  calculateDailyProfitRows,
  calculateFee,
  calculateVatAmount,
  getCostSettingForDate,
} from "./helpers";
import { CostService } from "./cost.service";
import { StoreService } from "./store.service";
import { ProfitService } from "./profit.service";
import {
  ProfitSummaryService,
  PROFIT_CALCULATION_VERSION,
} from "./profit-summary.service";

const date = "2026-10-25";
const nextDate = "2026-10-26";
const timestamp = "2026-01-01T00:00:00.000Z";
const fixture = () => {
  const data = createEmptyDatabase();
  data.stores.push({
    id: "s",
    name: "Store",
    sellerAccountId: "seller",
    channelNo: "channel",
    isActive: true,
    deliveryUnitCost: 3500,
  } as never);
  data.canonicalSalesUnits.push({
    id: "u",
    storeId: "s",
    displayName: "Unit",
    isActive: true,
    isGroup: false,
    isStoreLevel: false,
    parentSalesUnitId: null,
    matchAliases: [],
    linkedProductIds: [],
    linkedOptionCodes: [],
    linkedManageCodes: [],
  } as never);
  data.salesUnitCostSnapshots.push({
    id: "snapshot",
    storeId: "s",
    effectiveFrom: "2026-01-01",
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceFileName: null,
  });
  data.salesUnitCostSnapshotEntries.push({
    id: "entry",
    snapshotId: "snapshot",
    storeId: "s",
    canonicalSalesUnitId: "u",
    unitCost: 2000,
    otherCost: 0,
    feeRate: 0.03,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  data.orderItems.push({
    id: "item",
    orderId: "order",
    storeId: "s",
    paymentDate: date,
    saleStatus: "SALE",
    canonicalSalesUnitId: "u",
    quantity: 1,
    productPaymentAmount: 10000,
    deliveryFeeAmount: 3000,
    packageNumber: "package",
    paymentCommission: 300,
    knowledgeShoppingSellingInterlockCommission: 0,
    saleCommission: 0,
    channelCommission: 0,
  } as never);
  data.adExcelUploads.push({
    id: "upload",
    storeId: "s",
    reportDate: date,
    isActive: true,
    weekdayValidationStatus: "PASSED",
    state: "CONFIRMED",
  } as never);
  data.adCampaignDailyCosts.push({
    id: "ad",
    storeId: "s",
    sourceUploadId: "upload",
    reportDate: date,
    canonicalSalesUnitId: "u",
    mappingReason: "MANUAL_MAPPED",
    totalCost: 1000,
  } as never);
  return data;
};

const memory = (initial: DatabaseShape) => ({
  data: structuredClone(initial),
  getSnapshot() {
    return structuredClone(this.data);
  },
  getStorageMode() {
    return "file";
  },
  async writeCommitted<T>(fn: (draft: DatabaseShape) => T) {
    const draft = this.getSnapshot();
    const result = fn(draft);
    this.data = draft;
    return result;
  },
});
const audit = { appendToDraft() {} };
const costs = (
  db: ReturnType<typeof memory>,
  summaries?: ProfitSummaryService,
) =>
  new CostService(
    db as never,
    { ensureWritable() {} } as never,
    audit as never,
    {} as never,
    summaries,
  );
const excel = (rows: unknown[][]) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["salesUnitId", "displayName", "unitCost", "feeRate", "otherCost"],
      ...rows,
    ]),
    "Costs",
  );
  return {
    originalname: "costs.xlsx",
    buffer: XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
  } as Express.Multer.File;
};
const exportRows = (service: ProfitService, dateTo = date) => {
  const workbook = XLSX.read(
    service.exportDailySalesUnitsExcel({
      storeId: "s",
      dateFrom: date,
      dateTo,
    }),
    { type: "buffer" },
  );
  return XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets.DailyProfitRows, {
    header: 1,
    defval: "",
  });
};
const rowFor = (db: ReturnType<typeof memory>, day = date) =>
  calculateDailyProfitRows(db.getSnapshot(), "s", day, day)[0];

export async function runProfitRegressionTests() {
  const check = async (name: string, fn: () => void | Promise<void>) => {
    await fn();
    console.log(`PASS profit regression: ${name}`);
  };

  await check(
    "VAT remains 10 percent and all API fee fields are counted once",
    () => {
      assert.equal(calculateVatAmount(11000), 1100);
      assert.deepEqual(
        calculateFee(
          {
            paymentCommission: 300,
            knowledgeShoppingSellingInterlockCommission: 200,
            saleCommission: 100,
            channelCommission: 50,
          } as never,
          null,
        ),
        { totalFeeCost: 650, usedFallback: false, incomplete: false },
      );
      assert.equal(
        calculateFee(
          {
            paymentCommission: 0,
            knowledgeShoppingSellingInterlockCommission: 0,
            channelCommission: 500,
          } as never,
          { unitCost: 0, otherCost: 0, feeRate: 0.05 },
        ).totalFeeCost,
        500,
      );
      assert.deepEqual(
        calculateFee({ productPaymentAmount: 10000 } as never, {
          unitCost: 0,
          otherCost: 0,
          feeRate: 0.05,
        }),
        { totalFeeCost: 500, usedFallback: true, incomplete: false },
      );
      assert.equal(
        calculateFee({ productPaymentAmount: 10000 } as never, null).incomplete,
        true,
      );
      assert.equal(
        calculateFee({ paymentCommission: 0 } as never, {
          unitCost: 0,
          otherCost: 0,
          feeRate: 0.05,
        }).totalFeeCost,
        0,
      );
    },
  );

  await check(
    "group, child and store ads are deducted once, including delivery and other cost",
    () => {
      const data = fixture();
      data.canonicalSalesUnits[0].parentSalesUnitId = "group";
      data.canonicalSalesUnits.push(
        {
          id: "group",
          storeId: "s",
          displayName: "Group",
          isGroup: true,
        } as never,
        {
          id: "store-ad",
          storeId: "s",
          displayName: "Store ad",
          isStoreLevel: true,
        } as never,
      );
      data.salesUnitCostSnapshotEntries[0].otherCost = 1000;
      data.adCampaignDailyCosts.push({
        ...data.adCampaignDailyCosts[0],
        id: "store-cost",
        canonicalSalesUnitId: "store-ad",
        totalCost: 500,
      });
      const rows = calculateDailyProfitRows(
        data,
        "s",
        date,
        date,
        undefined,
        true,
      );
      const group = rows.find((row) => row.isGroup)!;
      assert.equal(group.totalAdCost, 1000);
      assert.equal(group.childRows![0].totalAdCost, 0);
      const summary = calculateDashboardSummary(data, "s", date);
      assert.equal(summary.totalProductRevenue, 10000);
      assert.equal(summary.totalAdCost, 1500);
      assert.equal(summary.estimatedNetProfit, 3700); // 10000 - VAT 1000 - cost 2000 - other 1000 - fee 300 - ads 1500 - delivery 500
    },
  );

  await check(
    "excluded advertising categories are mutually exclusive in both APIs",
    () => {
      const data = fixture();
      const ad = data.adCampaignDailyCosts[0];
      data.adCampaignDailyCosts.push(
        {
          ...ad,
          id: "intentional",
          canonicalSalesUnitId: null,
          mappingReason: "INTENTIONALLY_UNMAPPED",
          totalCost: 1000,
        },
        {
          ...ad,
          id: "unmapped",
          canonicalSalesUnitId: null,
          mappingReason: "NO_RULE",
          totalCost: 2000,
        },
        {
          ...ad,
          id: "conflict",
          canonicalSalesUnitId: null,
          mappingReason: "MULTIPLE_RULES",
          totalCost: 3000,
        },
        { ...ad, id: "inactive", sourceUploadId: "inactive", totalCost: 9000 },
      );
      const summary = calculateDashboardSummary(data, "s", date);
      const excluded = new ProfitService(
        memory(data) as never,
      ).getUnmappedSummary("s", date, date).data;
      assert.equal(summary.totalAdCost, 1000);
      assert.equal(summary.excludedAdCost, 6000);
      assert.deepEqual(
        [
          excluded.unmappedAdCost,
          excluded.conflictAdCost,
          excluded.intentionalUnmappedAdCost,
        ],
        [2000, 3000, 1000],
      );
      assert.deepEqual(
        [
          summary.unmappedCampaignCount,
          summary.conflictCampaignCount,
          summary.intentionalUnmappedCampaignCount,
        ],
        [1, 1, 1],
      );
      assert.equal(summary.estimatedNetProfit, 5200);
    },
  );

  await check(
    "cost import rejects invalid numbers atomically and accepts thousands separators",
    async () => {
      const db = memory(fixture());
      const service = costs(db);
      const original = db.getSnapshot();
      for (const [unit, fee, other] of [
        [-1, 0.03, 0],
        [2000, 3, 0],
        [2000, 0.03, -1],
        ["2,00", 0.03, 0],
        ["2000oops", 0.03, 0],
        ["Infinity", 0.03, 0],
        ["NaN", 0.03, 0],
        [2000, "3%", 0],
      ]) {
        await assert.rejects(() =>
          service.importExcelSnapshot(
            "s",
            date,
            excel([["u", "Changed name", unit, fee, other]]),
          ),
        );
        assert.deepEqual(db.getSnapshot(), original);
      }
      await assert.rejects(() =>
        service.importExcelSnapshot(
          "s",
          date,
          excel([
            ["u", "Unit", 2000, 0.03, 0],
            ["u", "Unit", 100, 0, 0],
          ]),
        ),
      );
      await assert.rejects(() =>
        service.importExcelSnapshot(
          "s",
          date,
          excel([["not-in-store", "Other", 2000, 0, 0]]),
        ),
      );
      assert.deepEqual(db.getSnapshot(), original);
      await service.importExcelSnapshot(
        "s",
        date,
        excel([["u", "Unit", "2,000", "0.03", "1,000"]]),
      );
      assert.equal(rowFor(db).totalUnitCost, 2000);
      assert.equal(rowFor(db).totalOtherCost, 1000);
      assert.equal(rowFor(db).estimatedNetProfit, 4700);
    },
  );

  await check(
    "blank unit cost is incomplete while an explicit zero is valid",
    async () => {
      const db = memory(fixture());
      const service = costs(db);
      const result = await service.importExcelSnapshot(
        "s",
        date,
        excel([["u", "Unit", null, 0.03, 0]]),
      );
      assert.deepEqual(result.mismatch.missingSalesUnitIds, ["u"]);
      assert.equal(rowFor(db).estimatedNetProfit, null);
      assert.equal(rowFor(db).profitStatus, "INCOMPLETE_COST");
      await service.importExcelSnapshot(
        "s",
        date,
        excel([["u", "Unit", 0, 0.03, 0]]),
      );
      assert.equal(rowFor(db).totalUnitCost, 0);
      assert.equal(rowFor(db).profitStatus, "COMPLETE");
      assert.equal(rowFor(db).estimatedNetProfit, 7700);
    },
  );

  await check(
    "manual cost API updates live rows, detail and cached summaries",
    async () => {
      const db = memory(fixture());
      const summaries = new ProfitSummaryService(db as never);
      const service = costs(db, summaries);
      await summaries.recalculateStoreDates({
        storeId: "s",
        dateFrom: date,
        dateTo: date,
        reason: "MANUAL",
      });
      const created = await service.create({
        storeId: "s",
        canonicalSalesUnitId: "u",
        unitCost: 9000,
        otherCost: 100,
        feeRate: 0.04,
        effectiveFrom: date,
      });
      const profits = new ProfitService(db as never, summaries);
      assert.equal(rowFor(db).totalUnitCost, 9000);
      assert.equal(
        profits.getDashboardSummary("s", date).data.estimatedNetProfit,
        -1900,
      );
      assert.equal(
        profits.getDailySalesUnitDetail("s", "u", date).data.costBreakdown
          .unitCostPerQuantity,
        9000,
      );
      const workbook = XLSX.read(service.exportExcel("s", date), {
        type: "buffer",
      });
      assert.equal(workbook.Sheets.CostSnapshot.C2.v, 9000);
      await service.close(created.data.costSettingId, { effectiveTo: date });
      db.data.orderItems.push({
        ...db.data.orderItems[0],
        id: "next",
        paymentDate: nextDate,
      });
      assert.equal(rowFor(db, nextDate).estimatedNetProfit, null);
      await service.importExcelSnapshot(
        "s",
        nextDate,
        excel([["u", "Unit", 3000, 0.03, 0]]),
      );
      assert.equal(rowFor(db, nextDate).totalUnitCost, 3000);
    },
  );

  await check(
    "future manual cost edits, deactivation and out-of-order insertion honor periods",
    async () => {
      const db = memory(fixture());
      const service = costs(db);
      const later = await service.create({
        storeId: "s",
        canonicalSalesUnitId: "u",
        unitCost: 7000,
        otherCost: 0,
        feeRate: 0.03,
        effectiveFrom: "2026-12-01",
      });
      const earlier = await service.create({
        storeId: "s",
        canonicalSalesUnitId: "u",
        unitCost: 5000,
        otherCost: 0,
        feeRate: 0.03,
        effectiveFrom: "2026-11-01",
      });
      assert.equal(earlier.data.effectiveTo, "2026-11-30");
      await service.update(earlier.data.costSettingId, {
        unitCost: 6000,
        otherCost: 0,
        feeRate: 0.03,
        effectiveFrom: "2026-11-01",
      });
      const data = db.getSnapshot();
      data.orderItems[0].paymentDate = "2026-11-15";
      assert.equal(
        calculateDailyProfitRows(data, "s", "2026-11-15", "2026-11-15")[0]
          .totalUnitCost,
        6000,
      );
      await assert.rejects(() =>
        service.close(earlier.data.costSettingId, {
          effectiveTo: "2026-12-01",
        }),
      );
      await assert.rejects(() =>
        service.update(later.data.costSettingId, {
          unitCost: 6000,
          otherCost: 0,
          feeRate: 0.03,
          effectiveFrom: "2026-11-20",
        }),
      );
      await service.deactivate(earlier.data.costSettingId);
      data.salesUnitCostSettings = db.getSnapshot().salesUnitCostSettings;
      assert.equal(
        calculateDailyProfitRows(data, "s", "2026-11-15", "2026-11-15")[0]
          .totalUnitCost,
        2000,
      );
    },
  );

  await check(
    "same-day source precedence and full snapshots do not resurrect old costs",
    () => {
      const data = fixture();
      const snapshot = {
        ...data.salesUnitCostSnapshots[0],
        effectiveFrom: date,
        updatedAt: "2026-10-25T10:00:00Z",
      };
      const manual = {
        ...data.salesUnitCostSnapshotEntries[0],
        effectiveFrom: date,
        effectiveTo: null,
        isActive: true,
        updatedAt: "2026-10-25T09:00:00Z",
        unitCost: 9000,
      } as unknown as SalesUnitCostSetting;
      assert.equal(
        getCostSettingForDate([{ snapshot, entry: null }], date, [manual]),
        null,
      );
      manual.updatedAt = "2026-10-25T11:00:00Z";
      assert.equal(
        getCostSettingForDate([{ snapshot, entry: null }], date, [manual])
          ?.unitCost,
        9000,
      );
    },
  );

  await check(
    "delivery price edits refresh cached profits and stale fallback stays correct",
    async () => {
      const db = memory(fixture());
      const summaries = new ProfitSummaryService(db as never);
      const profits = new ProfitService(db as never, summaries);
      await summaries.recalculateStoreDates({
        storeId: "s",
        dateFrom: date,
        dateTo: date,
        reason: "MANUAL",
      });
      const stores = new StoreService(
        db as never,
        audit as never,
        { hasRunningOperation: () => false } as never,
        summaries,
      );
      await stores.update("s", {
        name: "Store",
        sellerAccountId: "seller",
        channelNo: "channel",
        deliveryUnitCost: 4500,
      });
      assert.equal(db.data.dailyStoreSummaries[0].deliveryUnitCost, 4500);
      assert.equal(
        profits.getDashboardSummary("s", date).data.estimatedNetProfit,
        4200,
      );
      db.data.stores[0].deliveryUnitCost = 5500;
      assert.equal(
        profits.getDashboardSummary("s", date).data.estimatedNetProfit,
        3200,
      );
    },
  );

  await check(
    "closing a superseded manual cost does not change historical source precedence",
    async () => {
      const db = memory(fixture());
      db.data.salesUnitCostSnapshots[0].effectiveFrom = date;
      db.data.salesUnitCostSnapshots[0].updatedAt = "2026-10-25T10:00:00Z";
      db.data.salesUnitCostSettings.push({
        id: "manual",
        storeId: "s",
        canonicalSalesUnitId: "u",
        unitCost: 9000,
        otherCost: 0,
        feeRate: 0.03,
        effectiveFrom: date,
        effectiveTo: null,
        isActive: true,
        deactivatedAt: null,
        createdAt: "2026-10-25T09:00:00Z",
        updatedAt: "2026-10-25T09:00:00Z",
      });
      assert.equal(rowFor(db).totalUnitCost, 2000);
      await costs(db).close("manual", { effectiveTo: date });
      assert.equal(rowFor(db).totalUnitCost, 2000);
    },
  );

  await check(
    "previously saved invalid costs do not become complete profitable rows",
    () => {
      const db = memory(fixture());
      db.data.salesUnitCostSnapshotEntries[0].unitCost = -2000;
      assert.equal(rowFor(db).estimatedNetProfit, null);
      const rows = exportRows(new ProfitService(db as never));
      assert.equal(rows.find((row) => row[0] === date)![8], "");
      assert.equal(rows.at(-1)![8], "");
      assert.equal(rows.at(-1)![11], "");
    },
  );

  await check(
    "old calculation versions cannot mask corrected live values",
    async () => {
      const db = memory(fixture());
      const summaries = new ProfitSummaryService(db as never);
      const profits = new ProfitService(db as never, summaries);
      await summaries.recalculateStoreDates({
        storeId: "s",
        dateFrom: date,
        dateTo: date,
        reason: "MANUAL",
      });
      db.data.dailyStoreSummaries[0].calculationVersion = "profit-v1";
      db.data.dailyStoreSummaries[0].estimatedNetProfit = 999999;
      db.data.dailySalesUnitProfits[0].estimatedNetProfit = 999999;
      assert.equal(
        profits.getDashboardSummary("s", date).data.estimatedNetProfit,
        5200,
      );
      assert.equal(
        profits.listDailySalesUnits({
          storeId: "s",
          dateFrom: date,
          dateTo: date,
        }).data.items[0].estimatedNetProfit,
        5700,
      );
      db.data.dailyStoreSummaries[0].calculationVersion =
        PROFIT_CALCULATION_VERSION;
      db.data.dailySalesUnitProfits[0].calculationVersion = "profit-v1";
      assert.equal(
        profits.listDailySalesUnits({
          storeId: "s",
          dateFrom: date,
          dateTo: date,
        }).data.items[0].estimatedNetProfit,
        5700,
      );
    },
  );

  await check(
    "Excel includes other cost, weighted unit cost and each date's store adjustments",
    () => {
      const data = fixture();
      data.salesUnitCostSnapshotEntries[0].otherCost = 1000;
      data.orderItems.push({
        ...data.orderItems[0],
        id: "next",
        orderId: "next-order",
        paymentDate: nextDate,
        quantity: 3,
        productPaymentAmount: 60000,
        paymentCommission: 1800,
      });
      data.dailyFakePurchases.push(
        { storeId: "s", date, amount: 100 } as never,
        { storeId: "s", date: nextDate, amount: 200 } as never,
        { storeId: "s", date: "2026-10-27", amount: 300 } as never,
      );
      const rows = exportRows(
        new ProfitService(memory(data) as never),
        "2026-10-27",
      );
      const first = rows.find((row) => row[0] === date)!;
      assert.equal(first[8], 4300);
      assert.equal(first[9], 0.57);
      assert.deepEqual(first.slice(13, 16), [100, -500, 4100]);
      assert.deepEqual(
        rows.find((row) => row[0] === nextDate)!.slice(13, 16),
        [200, -500, 42500],
      );
      assert.deepEqual(
        rows.find((row) => row[0] === "2026-10-27")!.slice(13, 16),
        [300, 0, -300],
      );
      assert.equal(rows.at(-1)![8], 5275); // total fixed cost 21100 / four units
      assert.equal(calculateNetProfitAfterFakePurchase(4200, 100), 4100);
      assert.equal(calculateNetProfitAfterFakePurchase(null, 100), null);
      assert.equal(calculateNetProfitAfterFakePurchase(100, 200), -100);
    },
  );
}
