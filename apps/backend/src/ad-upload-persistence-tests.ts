import assert from "node:assert/strict";
import type { DatabaseShape } from "@patima/shared";
import { DatabaseService, hashPayload } from "./database.service";
import { createEmptyDatabase } from "./helpers";
import { getAdCampaignSignatureKey } from "./ad-mapping-engine";

const storeId = "store-upload";
const reportDate = "2026-11-10";
const campaignId = "campaign-upload";
const fixture = () => {
  const database = createEmptyDatabase();
  database.stores.push({ id: storeId, isActive: true } as never);
  database.orders.push({ id: "unrelated-order", storeId } as never);
  database.adExcelUploads.push({ id: "historical-upload", storeId, reportDate: "2026-11-09" } as never);
  database.adCampaignDailyCosts.push({
    id: "historical-row", storeId, reportDate: "2026-11-09", campaignId,
  } as never);
  database.adCampaignSignatures.push({
    id: "signature-upload", storeId, campaignId, usageCount: 2, confirmedAt: "preserved-manual-mapping",
  } as never);
  return database;
};

const buildUpload = (working: DatabaseShape) => {
  const signature = working.adCampaignSignatures[0];
  signature.usageCount += 1;
  return {
    uploads: [{ id: "new-upload", storeId, reportDate, isActive: true, state: "CONFIRMED" }] as DatabaseShape["adExcelUploads"],
    signatures: [signature],
    rows: [{ id: "new-row", storeId, reportDate, campaignId, sourceUploadId: "new-upload", totalCost: 123 }] as DatabaseShape["adCampaignDailyCosts"],
    auditLogs: [{ id: "new-audit", storeId, domain: "AD_UPLOAD" }] as DatabaseShape["auditLogs"],
    result: { uploadId: "new-upload" },
  };
};

const postgresHarness = (options?: { failAt?: string; inactive?: boolean; multiScope?: boolean }) => {
  const service = Object.create(DatabaseService.prototype) as any;
  service.database = fixture();
  service.storageMode = "postgres";
  service.persistenceQueue = Promise.resolve();
  service.pendingWriteCount = 0;
  service.lastPersistenceError = null;
  const original = structuredClone(service.database);
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const tables: Record<string, Array<{ id: string; [key: string]: unknown }>> = {
    ad_excel_uploads: [],
    ad_campaign_daily_costs: [],
    ad_campaign_signatures: [{ ...original.adCampaignSignatures[0], usageCount: 7 }],
    audit_logs: [],
  };
  let staged: typeof tables = {};
  let releases = 0;
  let beforeCommit: (() => void) | undefined;
  service.writeCommitted = () => { throw new Error("Full snapshot writes are forbidden"); };
  const clone = service.cloneSnapshot.bind(service);
  service.cloneSnapshot = (value: unknown) => {
    assert.notEqual(value, service.database, "must never clone the complete database");
    return clone(value);
  };
  service.acquirePostgresClient = async () => ({
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql === "BEGIN") staged = structuredClone(tables);
      if (options?.failAt && sql.includes(options.failAt)) throw new Error("INJECTED_UPLOAD_FAILURE");
      if (sql.includes("FROM stores")) {
        if (!options?.multiScope) assert.deepEqual(values, [storeId]);
        return { rows: [{ payload: { id: values[0], isActive: !options?.inactive } }] };
      }
      if (sql.startsWith("SELECT")) {
        const table = /FROM ([a-z_]+)/.exec(sql)![1];
        assert.match(sql, /FOR UPDATE$/);
        if (table === "ad_campaign_signatures") {
          if (!options?.multiScope) assert.deepEqual(values, [storeId, [campaignId]]);
          assert.match(sql, /BTRIM\(payload->>'campaignId'\)/);
        }
        else if (!options?.multiScope) assert.deepEqual(values, [storeId, reportDate]);
        const selected = tables[table].filter((row) => row.storeId === values[0] && (
          table === "ad_campaign_signatures"
            ? (values[1] as string[]).includes(String(row.campaignId ?? "").trim())
            : row.reportDate === values[1]
        ));
        return { rows: structuredClone(selected).map((payload) => ({ payload })) };
      }
      if (sql.startsWith("INSERT")) {
        const table = /INSERT INTO ([a-z_]+)/.exec(sql)![1];
        assert.ok(Object.hasOwn(tables, table), `Unexpected write to ${table}`);
        for (let offset = 0; offset < values.length; offset += 3) {
          const row = JSON.parse(String(values[offset + 1]));
          assert.equal(values[offset + 2], hashPayload(row));
          const index = staged[table].findIndex((item) => item.id === row.id);
          if (index === -1) staged[table].push(row);
          else staged[table][index] = row;
        }
      }
      if (sql === "COMMIT") {
        beforeCommit?.();
        Object.assign(tables, staged);
      }
      return { rows: [] };
    },
    release: () => { releases += 1; },
  });
  return {
    service: service as DatabaseService,
    raw: service,
    original,
    queries,
    tables,
    releases: () => releases,
    beforeCommit: (fn: () => void) => { beforeCommit = fn; },
  };
};

export async function runAdUploadPersistenceTests() {
  const scoped = postgresHarness();
  const originalOrderArray = scoped.service.getSnapshot().orders;
  scoped.beforeCommit(() => assert.deepEqual(scoped.service.getSnapshot(), scoped.original));
  const result = await scoped.service.commitAdUploadsCommitted({
    storeId, reportDate, campaignIds: [campaignId, campaignId],
    build: (working) => {
      assert.equal(working.orders, originalOrderArray, "read-only order data must not be cloned");
      assert.equal(working.adExcelUploads.length, 0);
      assert.equal(working.adCampaignDailyCosts.length, 0);
      assert.equal(working.auditLogs.length, 0);
      assert.equal(working.adCampaignSignatures[0].usageCount, 7, "build uses locked database payload");
      return buildUpload(working);
    },
  });
  assert.deepEqual(result, { uploadId: "new-upload" });
  assert.equal(scoped.service.getSnapshot().orders, originalOrderArray);
  assert.deepEqual(scoped.service.getSnapshot().orders, scoped.original.orders);
  assert.deepEqual(scoped.service.getSnapshot().adCampaignDailyCosts[0], scoped.original.adCampaignDailyCosts[0]);
  assert.equal(scoped.service.getSnapshot().adCampaignDailyCosts.length, 2);
  assert.equal(scoped.service.getSnapshot().adCampaignSignatures[0].usageCount, 8);
  assert.equal(scoped.service.getSnapshot().adCampaignSignatures[0].confirmedAt, "preserved-manual-mapping");
  assert.equal(scoped.service.getSnapshot().auditLogs.length, 1);
  assert.equal(scoped.queries.filter(({ sql }) => sql.startsWith("INSERT")).length, 4);
  assert.ok(scoped.queries.every(({ sql }) => !/DELETE|storage_metadata|order_items/.test(sql)));
  assert.equal(scoped.releases(), 1);
  console.log("PASS ad upload persistence: scoped SQL writes publish only after commit");

  const external = postgresHarness();
  external.raw.database.adCampaignDailyCosts.push({ id: "deleted-elsewhere", storeId, reportDate, campaignId });
  external.raw.database.adExcelUploads.push({ id: "changed-elsewhere", storeId, reportDate, isActive: true });
  external.tables.ad_excel_uploads.push({ id: "changed-elsewhere", storeId, reportDate, isActive: false });
  external.tables.ad_excel_uploads.push({ id: "external-upload", storeId, reportDate, isActive: true, state: "CONFIRMED" });
  external.tables.ad_campaign_daily_costs.push({
    id: "external-row", storeId, reportDate, campaignId: "another-campaign", sourceUploadId: "external-upload", totalCost: 456,
  });
  external.tables.ad_campaign_signatures[0].campaignId = ` ${campaignId} `;
  await external.service.commitAdUploadsCommitted({
    storeId, reportDate, campaignIds: [` ${campaignId} `, campaignId],
    build: (working) => {
      assert.equal(working.adExcelUploads.find((row) => row.id === "changed-elsewhere")!.isActive, false);
      assert.equal(working.adCampaignDailyCosts[0].id, "external-row");
      assert.equal(working.adCampaignDailyCosts.some((row) => row.id === "deleted-elsewhere"), false);
      assert.equal(getAdCampaignSignatureKey({ ...working.adCampaignSignatures[0], channel: "NAVER_DA" }),
        `${storeId}|NAVER_DA|id:${campaignId}`);
      return buildUpload(working);
    },
  });
  const current = external.service.getSnapshot();
  assert.equal(current.adExcelUploads.find((row) => row.id === "changed-elsewhere")!.isActive, false);
  assert.equal(current.adCampaignDailyCosts.some((row) => row.id === "deleted-elsewhere"), false);
  assert.equal(current.adCampaignDailyCosts.find((row) => row.id === "external-row")!.totalCost, 456);
  assert.equal(current.adCampaignDailyCosts.find((row) => row.id === "new-row")!.totalCost, 123);
  assert.equal(current.adCampaignDailyCosts.some((row) => row.id === "historical-row"), true);
  assert.equal(external.queries.filter(({ sql }) => sql.startsWith("INSERT INTO ad_campaign_daily_costs"))
    .flatMap(({ values }) => values.filter((_, index) => index % 3 === 0)).includes("external-row"), false);
  console.log("PASS ad upload persistence: locked scope refreshes external changes and normalized campaign keys");

  for (const failAt of ["INSERT INTO ad_campaign_daily_costs", "COMMIT"]) {
    const failed = postgresHarness({ failAt });
    await assert.rejects(() => failed.service.commitAdUploadsCommitted({
      storeId, reportDate, campaignIds: [campaignId], build: buildUpload,
    }), /INJECTED_UPLOAD_FAILURE/);
    assert.deepEqual(failed.service.getSnapshot(), failed.original);
    assert.equal(failed.tables.ad_excel_uploads.length, 0);
    assert.ok(failed.queries.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(failed.releases(), 1);
  }
  console.log("PASS ad upload persistence: write and commit failures preserve memory");

  for (const invalid of ["store", "date", "campaign"]) {
    const scopedFailure = postgresHarness();
    await assert.rejects(() => scopedFailure.service.commitAdUploadsCommitted({
      storeId, reportDate, campaignIds: [campaignId],
      build: (working) => {
        const replacement = buildUpload(working);
        if (invalid === "store") replacement.rows[0].storeId = "another-store";
        if (invalid === "date") replacement.rows[0].reportDate = "2026-11-09";
        if (invalid === "campaign") replacement.rows[0].campaignId = "another-campaign";
        return replacement;
      },
    }), /AD_UPLOAD_COMMIT_SCOPE_MISMATCH/);
    assert.deepEqual(scopedFailure.service.getSnapshot(), scopedFailure.original);
    assert.equal(scopedFailure.queries.filter(({ sql }) => sql.startsWith("INSERT")).length, 0);
  }
  const inactive = postgresHarness({ inactive: true });
  await assert.rejects(() => inactive.service.commitAdUploadsCommitted({
    storeId, reportDate, campaignIds: [campaignId],
    build: () => { throw new Error("Must not build for inactive store"); },
  }), /비활성화된 스토어/);
  console.log("PASS ad upload persistence: invalid scope and inactive stores are rejected");

  const serial = postgresHarness();
  const seenRows: number[] = [];
  const save = () => serial.service.commitAdUploadsCommitted({
    storeId, reportDate, campaignIds: [campaignId],
    build: (working) => {
      seenRows.push(working.adCampaignDailyCosts.length);
      if (working.adCampaignDailyCosts.some((row) => row.campaignId === campaignId)) {
        throw new Error("DUPLICATE_CAMPAIGN");
      }
      return buildUpload(working);
    },
  });
  const outcomes = await Promise.allSettled([save(), save()]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "rejected"]);
  assert.deepEqual(seenRows, [0, 1]);
  assert.equal(serial.tables.ad_campaign_daily_costs.length, 1);
  assert.equal(serial.service.getSnapshot().adCampaignDailyCosts.length, 2);
  console.log("PASS ad upload persistence: serialized builds see newly committed duplicates");

  const file = Object.create(DatabaseService.prototype) as any;
  file.database = fixture();
  file.storageMode = "file";
  file.persistenceQueue = Promise.resolve();
  file.pendingWriteCount = 0;
  const original = structuredClone(file.database);
  let persisted: DatabaseShape | null = null;
  file.persistSnapshotWithStatus = async (draft: DatabaseShape) => {
    assert.deepEqual(file.database, original, "file memory must not publish before persistence");
    persisted = structuredClone(draft);
  };
  await (file as DatabaseService).commitAdUploadsCommitted({
    storeId, reportDate, campaignIds: [campaignId], build: buildUpload,
  });
  assert.deepEqual(file.database, persisted);
  assert.equal(file.database.adCampaignDailyCosts.length, 2);
  assert.equal(file.database.adCampaignSignatures.length, 1);
  assert.equal(file.database.adCampaignSignatures[0].usageCount, 3);
  console.log("PASS ad upload persistence: file mode retains atomic snapshot publication");

  const batchScopes = [
    { storeId: "z-store", reportDate, campaignIds: ["z-campaign"] },
    { storeId: "a-store", reportDate: "2026-11-11", campaignIds: ["a-campaign"] },
    { storeId: "a-store", reportDate, campaignIds: ["a-campaign"] },
    { storeId: "a-store", reportDate, campaignIds: [" a-campaign "] },
  ];
  const buildBatch = (working: DatabaseShape) => {
    const rows: DatabaseShape["adCampaignDailyCosts"] = [];
    const uploads: DatabaseShape["adExcelUploads"] = [];
    const auditLogs: DatabaseShape["auditLogs"] = [];
    for (const [index, scope] of batchScopes.slice(0, 3).entries()) {
      const campaignId = scope.campaignIds[0];
      const signature = working.adCampaignSignatures.find((row) => row.storeId === scope.storeId && row.campaignId === campaignId)!;
      signature.usageCount += 1;
      const uploadId = `batch-upload-${index}`;
      uploads.push({ id: uploadId, storeId: scope.storeId, reportDate: scope.reportDate } as never);
      rows.push({ id: `batch-row-${index}`, storeId: scope.storeId, reportDate: scope.reportDate,
        campaignId, adCampaignSignatureId: signature.id, sourceUploadId: uploadId } as never);
      auditLogs.push({ id: `batch-audit-${index}`, storeId: scope.storeId } as never);
    }
    return { uploads, rows, auditLogs, signatures: working.adCampaignSignatures,
      result: uploads.map((upload) => upload.id) };
  };
  for (const failAt of [undefined, "INSERT INTO audit_logs", "COMMIT"]) {
    const batch = postgresHarness({ multiScope: true, failAt });
    for (const prefix of ["a", "z"]) {
      batch.raw.database.stores.push({ id: `${prefix}-store`, isActive: true });
      batch.tables.ad_campaign_signatures.push({ id: `${prefix}-signature`, storeId: `${prefix}-store`,
        campaignId: `${prefix}-campaign`, usageCount: 10 });
    }
    const before = structuredClone(batch.service.getSnapshot());
    batch.beforeCommit(() => assert.deepEqual(batch.service.getSnapshot(), before));
    const execute = () => batch.service.commitAdUploadBatchCommitted({ scopes: batchScopes, build: buildBatch });
    if (failAt) {
      await assert.rejects(execute, /INJECTED_UPLOAD_FAILURE/);
      assert.deepEqual(batch.service.getSnapshot(), before);
      assert.equal(batch.tables.ad_excel_uploads.length, 0, "no store/date may persist after failed batch");
      assert.equal(batch.tables.ad_campaign_daily_costs.length, 0);
      assert.ok(batch.queries.some(({ sql }) => sql === "ROLLBACK"));
    } else {
      assert.deepEqual(await execute(), ["batch-upload-0", "batch-upload-1", "batch-upload-2"]);
      assert.equal(batch.tables.ad_excel_uploads.length, 3);
      assert.equal(batch.tables.ad_campaign_daily_costs.length, 3);
      assert.equal(batch.service.getSnapshot().adCampaignSignatures.find((row) => row.id === "a-signature")!.usageCount, 12);
      assert.equal(batch.service.getSnapshot().adCampaignSignatures.find((row) => row.id === "z-signature")!.usageCount, 11);
      assert.equal(batch.service.getSnapshot().adCampaignDailyCosts.some((row) => row.id === "historical-row"), true);
      assert.equal(batch.queries.filter(({ sql }) => sql === "COMMIT").length, 1);
      assert.equal(batch.queries.filter(({ sql }) => sql.startsWith("INSERT")).length, 4);
    }
    assert.deepEqual(batch.queries.filter(({ sql }) => sql.includes("FROM stores")).map(({ values }) => values[0]),
      ["a-store", "z-store"], "all store locks use a stable global order");
    const firstCollectionRead = batch.queries.findIndex(({ sql }) => sql.includes("FROM ad_"));
    const lastStoreLock = batch.queries.map(({ sql }, index) => sql.includes("FROM stores") ? index : -1).reduce((a, b) => Math.max(a, b));
    assert.ok(firstCollectionRead > lastStoreLock);
    assert.deepEqual(batch.queries.filter(({ sql }) => sql.includes("FROM ad_excel_uploads")).map(({ values }) => values), [
      ["a-store", reportDate], ["a-store", "2026-11-11"], ["z-store", reportDate],
    ]);
    assert.equal(batch.queries.filter(({ sql }) => sql.includes("FROM ad_campaign_signatures")).length, 2);
    assert.equal(batch.releases(), 1);
  }
  console.log("PASS ad upload persistence: multi-store/date batch locks deterministically and commits or rolls back together");

  const fileBatch = Object.create(DatabaseService.prototype) as any;
  fileBatch.database = fixture();
  fileBatch.storageMode = "file";
  fileBatch.persistenceQueue = Promise.resolve();
  fileBatch.pendingWriteCount = 0;
  for (const prefix of ["a", "z"]) {
    fileBatch.database.stores.push({ id: `${prefix}-store`, isActive: true });
    fileBatch.database.adCampaignSignatures.push({ id: `${prefix}-signature`, storeId: `${prefix}-store`,
      campaignId: `${prefix}-campaign`, usageCount: 10 });
  }
  let fileWrites = 0;
  fileBatch.persistSnapshotWithStatus = async () => { fileWrites += 1; };
  await (fileBatch as DatabaseService).commitAdUploadBatchCommitted({
    scopes: batchScopes,
    build: (working) => {
      const replacement = buildBatch(working);
      replacement.signatures = replacement.signatures.filter((row) => row.storeId === "a-store" || row.storeId === "z-store");
      return replacement;
    },
  });
  assert.equal(fileWrites, 1, "all stores and dates share one atomic file write");
  assert.equal(fileBatch.database.adCampaignDailyCosts.length, 4);
  console.log("PASS ad upload persistence: multi-store/date file batch persists once");
}
