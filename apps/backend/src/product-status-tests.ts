import assert from "node:assert/strict";
import type { DatabaseShape } from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import { createEmptyDatabase, migrateCanonicalSalesUnit } from "./helpers";
import { ProductStatusService } from "./product-status.service";
import { ProfitSummaryService } from "./profit-summary.service";

export async function runProductStatusTests() {
  const date = "2026-11-20";
  const savedAt = "2026-11-20T01:00:00.000Z";
  let data = createEmptyDatabase();
  data.stores.push({ id: "store", isActive: true } as never, { id: "other", isActive: true } as never);
  data.canonicalSalesUnits.push(
    migrateCanonicalSalesUnit({
      id: "group", storeId: "store", displayName: "에어핏 러닝벨트",
      matchAliases: ["에어핏 러닝벨트"], isGroup: true, isActive: true, createdAt: savedAt,
    } as never),
    migrateCanonicalSalesUnit({
      id: "solo", storeId: "store", displayName: "에어핏 러닝벨트 단품",
      parentSalesUnitId: "group", isActive: true, createdAt: savedAt,
    } as never),
    migrateCanonicalSalesUnit({
      id: "double", storeId: "store", displayName: "에어핏 러닝벨트 1+1",
      parentSalesUnitId: "group", isActive: true, createdAt: savedAt,
    } as never),
  );
  const db = {
    getSnapshot: () => data,
    writeCommitted: async (fn: (draft: DatabaseShape) => void) => {
      const draft = structuredClone(data);
      fn(draft);
      data = draft;
    },
  } as never;
  const status = new ProductStatusService(
    db,
    new ProfitSummaryService(db),
    { ensureWritable() {} } as never,
    new AuditLogService(db),
  );
  const sharedSource = {
    rawProductNameSnapshot: "에어핏 러닝벨트",
    usageCount: 1,
    sampleOptionCode: null,
    sampleOptionManageCode: null,
    sampleExternalProductId: null,
  };
  data.orderSourceSignatures.push(
    {
      ...sharedSource, id: "mapped", storeId: "store", rawOptionInfoSnapshot: "수량: 단품",
      canonicalSalesUnitId: "solo", mappingStatus: "MAPPED",
    } as never,
    {
      ...sharedSource, id: "review", storeId: "store", rawOptionInfoSnapshot: "수량: 1+1",
      canonicalSalesUnitId: null, mappingStatus: "UNMAPPED",
    } as never,
    {
      ...sharedSource, id: "outsider", storeId: "other", rawOptionInfoSnapshot: "수량: 1+1",
      canonicalSalesUnitId: null, mappingStatus: "UNMAPPED",
    } as never,
  );
  data.orderItems.push({
    id: "order-item", storeId: "store", canonicalSalesUnitId: "solo", paymentDate: date,
    saleStatus: "SALE", quantity: 1, productPaymentAmount: 10000, paymentCommission: 300,
  } as never);
  data.salesUnitCostSnapshots.push({
    id: "table", storeId: "store", effectiveFrom: date, sourceFileName: "launch-costs.xlsx",
    updatedAt: savedAt, createdAt: savedAt,
  });
  data.salesUnitCostSnapshotEntries.push({
    id: "entry", storeId: "store", snapshotId: "table", canonicalSalesUnitId: "double",
    unitCost: 5000, otherCost: 0, feeRate: null, updatedAt: savedAt, createdAt: savedAt,
  });
  data.salesUnitCostSettings.push({
    id: "manual", storeId: "store", canonicalSalesUnitId: "solo", unitCost: 0, otherCost: 0,
    feeRate: null, isActive: true, deactivatedAt: null, effectiveFrom: date, effectiveTo: date,
    updatedAt: "2026-11-20T02:00:00.000Z", createdAt: savedAt,
  });
  let workbench = status.getProductStatus("store", "double", date).data;
  assert.equal(workbench.product.id, "group");
  assert.deepEqual(workbench.configurations.map((row) => [row.id, row.cost?.source, row.cost?.unitCost, row.order.state, row.profit.state]), [
    ["solo", "INDIVIDUAL", 0, "CONNECTED", "COMPLETE"],
    ["double", "EXCEL", 5000, "REVIEW", "WAITING"],
  ]);
  assert.deepEqual(workbench.orderCandidates.map((item) => [item.id, item.suggestedConfigurationIds]), [["review", ["double"]]]);
  assert.equal(workbench.configurations[0].order.orderItemCount, 1);
  assert.equal(workbench.configurations[0].profit.estimatedNetProfit, 8700);
  assert.equal(workbench.configurations[1].cost?.sourceFileName, "launch-costs.xlsx");
  assert.equal(status.getCostCoverage("store", "2026-11-21").data.items.find((item) => item.id === "solo")?.unitCost, null);
  assert.deepEqual(status.getOrderContext("store", ["review", "mapped"]).data.items.map((item) => item.id), ["review", "mapped"]);
  assert.throws(() => status.getOrderContext("store", ["outsider"]));
  assert.throws(() => status.getProductStatus("other", "group", date));
  assert.throws(() => status.getCostCoverage("store", "2026-02-30"));

  assert.equal(workbench.advertising.state, "WAITING");
  await status.setAdvertisingStatus("group", { storeId: "store", notAdvertised: true });
  await status.setAdvertisingStatus("group", { storeId: "store", notAdvertised: true });
  assert.equal(data.auditLogs.length, 1);
  assert.equal(status.getProductStatus("store", "group", date).data.advertising.state, "NOT_ADVERTISED");
  assert.equal(migrateCanonicalSalesUnit(data.canonicalSalesUnits[0]).advertisingNotPlanned, true);
  data.adExcelUploads.push({
    id: "confirmed", storeId: "store", reportDate: date, isActive: true,
    weekdayValidationStatus: "PASSED", state: "CONFIRMED",
  } as never);
  data.adCampaignDailyCosts.push({
    id: "pending", storeId: "store", sourceUploadId: "confirmed", reportDate: date,
    totalCost: 800, campaignName: "에어핏 러닝벨트 광고", normalizedCampaignName: "에어핏 러닝벨트 광고",
    mappingReason: "NO_RULE", canonicalSalesUnitId: null,
  } as never);
  assert.equal(status.getProductStatus("store", "group", date).data.advertising.state, "REVIEW");
  Object.assign(data.adCampaignDailyCosts[0], { mappingReason: "MANUAL_MAPPED", canonicalSalesUnitId: "group" });
  workbench = status.getProductStatus("store", "group", date).data;
  assert.equal(workbench.advertising.state, "CONNECTED");
  assert.equal(workbench.advertising.dateCost, 800);
  assert.equal(workbench.profit.estimatedNetProfit, 7900);
}
