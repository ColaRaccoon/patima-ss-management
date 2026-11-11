import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import * as XLSX from "xlsx";
import { parseAdUploadFileName } from "@patima/shared";
import { AdsService, AD_UPLOAD_REQUIRED_HEADERS } from "./ads.service";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import { ProfitSummaryService } from "./profit-summary.service";
import { createEmptyDatabase, getWeekdayNameKo } from "./helpers";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const file = (name: string, id = "campaign", date = "2026-10-31") => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    AD_UPLOAD_REQUIRED_HEADERS,
    [id, "상품 캠페인", 100, 10, 1, 1, 200],
    ["", getWeekdayNameKo(date)],
  ]), "Sheet1");
  return { originalname: name, buffer: XLSX.write(book, { type: "buffer", bookType: "xlsx" }) } as Express.Multer.File;
};

function harness(mode: "file" | "postgres" = "file") {
  const database = createEmptyDatabase();
  database.stores = ["인피니티스토어", "파티마스토어"].map((name, i) => ({
    id: `store-${i}`, name, isActive: true, deliveryUnitCost: 0,
  } as never));
  database.canonicalSalesUnits = database.stores.map((store) => ({
    id: `unit-${store.id}`, storeId: store.id, displayName: "상품", isActive: true,
    matchAliases: ["상품"], normalizedMatchAliases: ["상품"], linkedProductIds: [], linkedOptionCodes: [], linkedManageCodes: [],
  } as never));
  const db = Object.assign(Object.create(DatabaseService.prototype), {
    database, storageMode: mode, persistenceQueue: Promise.resolve(), pendingWriteCount: 0, lastPersistenceError: null,
    persistSnapshotWithStatus: async () => undefined,
  }) as DatabaseService;
  const profit = new ProfitSummaryService(db);
  const summaryCalls: Array<{ storeId: string; dates: string[] }> = [];
  const refresh = profit.refreshStoreDateListBestEffort.bind(profit);
  profit.refreshStoreDateListBestEffort = async (input) => { summaryCalls.push(input); return refresh(input); };
  const ads = new AdsService(db, { ensureWritable: (id: string) => {
    const store = db.getSnapshot().stores.find((store) => store.id === id);
    if (!store?.isActive) throw new BadRequestException("STORE_INACTIVE");
  } } as never, {} as never, new AuditLogService(db), profit);
  return { db, ads, profit, summaryCalls };
}

export async function runAdUploadRegressionTests() {
  for (const name of ["261031_인피니티.xlsx", "261031_인피니티메인.xlsx", "261031_인피니티서브.xlsx", "261031_파티마.xlsx", "261031_파티마메인.xlsx", "261031_파티마서브.xlsx"]) {
    assert.equal(parseAdUploadFileName(name)?.reportDate, "2026-10-31");
    assert.equal(parseAdUploadFileName(name.normalize("NFD"))?.reportDate, "2026-10-31");
  }
  for (const name of ["260229_파티마.xlsx", "261332_파티마.xlsx", "261000_파티마.xlsx", "261031_다른스토어.xlsx", "261031_파티마.xlsx.exe", "../261031_파티마.xlsx"]) assert.equal(parseAdUploadFileName(name), null);
  assert.equal(parseAdUploadFileName("240229_파티마.XLSX")?.reportDate, "2024-02-29");

  const limits = harness();
  const limitFile = file("261031_인피니티.xlsx");
  await assert.rejects(limits.ads.uploadBatch([]), /1~100/);
  await assert.rejects(limits.ads.uploadBatch(Array.from({ length: 101 }, () => limitFile)), /1~100/);
  await assert.rejects(limits.ads.uploadBatch([{ ...limitFile, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }]), /10MB/);
  assert.equal(limits.db.getSnapshot().adExcelUploads.length, 0);
  assert.equal(limits.summaryCalls.length, 0);

  const batch = harness();
  const files = [
    file("261031_인피니티.xlsx", "shared-id"), file("261031_인피니티메인.xlsx", "main"), file("261031_인피니티서브.xlsx", "sub"),
    file("261031_파티마.xlsx", "shared-id"), file("261031_파티마메인.xlsx", "main"), file("261031_파티마서브.xlsx", "sub"),
  ];
  const result = await batch.ads.uploadBatch(files);
  assert.equal(result.data.fileCount, 6);
  assert.equal(result.data.confirmedRowCount, 6);
  assert.equal(batch.summaryCalls.length, 2, "one profit refresh per store, not per file");
  assert.ok(result.data.items.every((item) => item.summaryStatus === "SUCCEEDED"));
  assert.deepEqual(batch.db.getSnapshot().dailyStoreSummaries.map((row) => row.totalAdCost), [300, 300]);
  const saved = structuredClone(batch.db.getSnapshot());
  await assert.rejects(batch.ads.uploadBatch(files), (error: unknown) =>
    error instanceof BadRequestException && JSON.stringify(error.getResponse()).includes("AD_UPLOAD_DUPLICATE_WITH_ACTIVE_UPLOAD"));
  assert.deepEqual(batch.db.getSnapshot(), saved, "retry cannot duplicate any saved uploads");
  assert.equal(batch.summaryCalls.length, 2);

  const manual = harness();
  await manual.ads.uploadBatch([file("261030_인피니티.xlsx", "kept-campaign", "2026-10-30")]);
  const signature = manual.db.getSnapshot().adCampaignSignatures[0];
  Object.assign(signature, { confirmedAt: "2026-10-30T00:00:00Z", mappingReason: "MANUAL_MAPPED", reasonNote: "기존 수동 매핑", canonicalSalesUnitId: "unit-store-0" });
  const oldRows = structuredClone(manual.db.getSnapshot().adCampaignDailyCosts);
  const oldUploads = structuredClone(manual.db.getSnapshot().adExcelUploads);
  await manual.ads.uploadBatch([file("261031_인피니티.xlsx", "kept-campaign")]);
  assert.deepEqual(manual.db.getSnapshot().adCampaignDailyCosts.slice(0, oldRows.length), oldRows);
  assert.deepEqual(manual.db.getSnapshot().adExcelUploads.slice(0, oldUploads.length), oldUploads);
  const inherited = manual.db.getSnapshot().adCampaignDailyCosts.at(-1)!;
  assert.equal(inherited.mappingReason, "MANUAL_MAPPED");
  assert.equal(inherited.reasonNote, "기존 수동 매핑");
  assert.equal(inherited.canonicalSalesUnitId, "unit-store-0");

  // An overlap in a later file must roll back earlier files in the same batch.
  for (const badFile of [file("261031_인피니티메인.xlsx"), file("261031_인피니티메인.xlsx", "other", "2026-11-01"), file("260230_파티마.xlsx")]) {
    const state = harness();
    await assert.rejects(state.ads.uploadBatch([file("261031_인피니티.xlsx"), badFile]));
    assert.equal(state.db.getSnapshot().adExcelUploads.length, 0);
    assert.equal(state.db.getSnapshot().adCampaignDailyCosts.length, 0);
    assert.equal(state.summaryCalls.length, 0);
  }
  const existing = harness();
  await existing.ads.uploadBatch([file("261031_파티마.xlsx")]);
  const before = structuredClone(existing.db.getSnapshot());
  await assert.rejects(existing.ads.uploadBatch([file("261031_인피니티.xlsx"), file("261031_파티마메인.xlsx")]));
  assert.deepEqual(existing.db.getSnapshot(), before, "existing-date overlap preserves old data and rejects the entire batch");

  const concurrent = harness();
  const admissions = await Promise.allSettled([
    concurrent.ads.uploadBatch([file("261031_인피니티.xlsx")]),
    concurrent.ads.uploadBatch([file("261031_인피니티메인.xlsx")]),
  ]);
  assert.equal(admissions.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.db.getSnapshot().adExcelUploads.length, 1, "duplicate check sees writes queued before admission");

  for (const change of ["inactive", "missing", "ambiguous"] as const) {
    const state = harness();
    if (change === "inactive") state.db.getSnapshot().stores[0].isActive = false;
    if (change === "missing") state.db.getSnapshot().stores.shift();
    if (change === "ambiguous") state.db.getSnapshot().stores.push({ ...state.db.getSnapshot().stores[0], id: "another" });
    await assert.rejects(state.ads.uploadBatch([file("261031_인피니티.xlsx")]));
    assert.equal(state.db.getSnapshot().adExcelUploads.length, 0);
  }

  const multipleDates = harness();
  await multipleDates.ads.uploadBatch([file("261031_인피니티.xlsx"), file("261030_인피니티.xlsx", "campaign", "2026-10-30")]);
  assert.equal(multipleDates.summaryCalls.length, 1);
  assert.deepEqual(multipleDates.summaryCalls[0].dates.sort(), ["2026-10-30", "2026-10-31"]);
  const warning = harness();
  warning.profit.refreshStoreDateListBestEffort = async () => null;
  assert.equal((await warning.ads.uploadBatch([file("261031_파티마.xlsx")])).data.items[0].summaryStatus, "WARNING");
  assert.equal(warning.db.getSnapshot().adExcelUploads.length, 1, "a summary warning must not hide a committed upload");

  const pg = harness("postgres");
  const sql: Array<{ query: string; values?: unknown[] }> = [];
  let failCommit = false;
  (pg.db as any).pool = { connect: async () => ({ query: async (query: string, values?: unknown[]) => {
    sql.push({ query, values });
    if (query === "COMMIT" && failCommit) throw new Error("TEST_COMMIT_FAILED");
    const snapshot = pg.db.getSnapshot();
    if (query.includes("FROM stores")) {
      return { rows: snapshot.stores.filter((store) => store.id === values?.[0]).map((payload) => ({ payload: structuredClone(payload) })) };
    }
    const scopedRows = query.includes("FROM ad_excel_uploads") ? snapshot.adExcelUploads
      : query.includes("FROM ad_campaign_daily_costs") ? snapshot.adCampaignDailyCosts : null;
    if (scopedRows) {
      return { rows: scopedRows.filter((row) => row.storeId === values?.[0] && row.reportDate === values?.[1])
        .map((payload) => ({ payload: structuredClone(payload) })) };
    }
    if (query.includes("FROM ad_campaign_signatures")) {
      const campaignIds = new Set(values?.[1] as string[]);
      return { rows: snapshot.adCampaignSignatures.filter((row) => row.storeId === values?.[0] && campaignIds.has(row.campaignId?.trim() ?? ""))
        .map((payload) => ({ payload: structuredClone(payload) })) };
    }
    return { rows: [], rowCount: 0 };
  }, release: () => undefined }) };
  // Existing unrelated rows must not be copied, resent or deleted.
  const orders = pg.db.getSnapshot().orders;
  orders.push({ id: "old-order" } as never);
  pg.db.getSnapshot().adCampaignDailyCosts.push({ id: "unchanged-ad", totalCost: 123 } as never);
  pg.db.getSnapshot().adExcelUploads.push({ id: "old-upload", storeId: "other", reportDate: "2020-01-01" } as never);
  const originalClone = (pg.db as any).cloneSnapshot.bind(pg.db);
  (pg.db as any).cloneSnapshot = (value: unknown) => {
    assert.notStrictEqual(value, pg.db.getSnapshot(), "admission must not clone the whole database");
    assert.notStrictEqual(value, pg.db.getSnapshot().adCampaignDailyCosts, "admission must not clone all historical ad rows");
    assert.notStrictEqual(value, pg.db.getSnapshot().canonicalSalesUnits, "sales units are read-only mapping inputs");
    return originalClone(value);
  };
  const commit = (prefix: string) => pg.db.commitAdUploadBatchCommitted({
    // Reversed input order exercises deterministic store lock ordering.
    scopes: ["store-1", "store-0"].map((storeId) => ({ storeId, reportDate: "2026-10-31", campaignIds: [] })),
    build: (draft) => {
      assert.strictEqual(draft.orders, orders, "unrelated order data remains a read-only reference");
      return {
        uploads: ["store-0", "store-1"].map((storeId) => ({
          id: `${prefix}-${storeId}`, storeId, reportDate: "2026-10-31", state: "CONFIRMED", isActive: true,
        })) as ReturnType<typeof createEmptyDatabase>["adExcelUploads"],
        signatures: [], rows: [], auditLogs: [], result: prefix,
      };
    },
  });
  assert.equal(await commit("new-upload"), "new-upload");
  assert.strictEqual(pg.db.getSnapshot().orders, orders);
  assert.deepEqual(sql.filter((entry) => entry.query.includes("FROM stores")).map((entry) => entry.values?.[0]), ["store-0", "store-1"]);
  assert.equal(sql.filter((entry) => entry.query.startsWith("INSERT INTO")).length, 1);
  assert.deepEqual(sql.find((entry) => entry.query.startsWith("INSERT INTO"))?.values?.filter((_, i) => i % 3 === 0), ["new-upload-store-0", "new-upload-store-1"]);
  assert.equal(sql.some((entry) => /DELETE|orders|order_items|storage_metadata|canonical_sales_units/.test(entry.query)), false);
  failCommit = true;
  const committed = structuredClone(pg.db.getSnapshot());
  await assert.rejects(commit("failed-upload"), /TEST_COMMIT_FAILED/);
  assert.deepEqual(pg.db.getSnapshot(), committed);
  assert.ok(sql.some((entry) => entry.query === "ROLLBACK"));
  console.log("PASS ad batch routing, atomic duplicate checks, grouped summaries and row-level PostgreSQL rollback");

  const directory = mkdtempSync(join(tmpdir(), "patima-ad-batch-"));
  const overrides = { DATABASE_URL: undefined, DATA_DIR: directory, NAVER_BOOTSTRAP_STORE: "false" };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    try {
      await app.listen(0, "127.0.0.1");
      const database = app.get(DatabaseService);
      await database.writeCommitted((draft) => { draft.stores = harness().db.getSnapshot().stores; });
      const base = await app.getUrl();
      const send = async (uploads: Express.Multer.File[], fields: Record<string, string> = {}) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        for (const upload of uploads) form.append("files", new Blob([new Uint8Array(upload.buffer)]), upload.originalname);
        return fetch(`${base}/api/v1/ad-uploads/batch`, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
      };
      const uploads = [file("261031_인피니티.xlsx"), file("261031_파티마.xlsx")];
      const response = await send(uploads);
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.deepEqual(body.data.items.map((item: { storeName: string }) => item.storeName), ["인피니티스토어", "파티마스토어"]);
      assert.equal((await send(uploads)).status, 400);
      assert.equal((await send([file("260230_파티마.xlsx")])).status, 400);
      const manualUpload = file("manual-report.xlsx", "manual-campaign");
      assert.equal((await send([manualUpload], { storeId: "store-0" })).status, 400, "manual dispatch requires both fields");
      const manualResponse = await send([
        manualUpload,
        { ...file("wrong-format.csv", "rejected-campaign"), originalname: "wrong-format.csv" },
      ], { storeId: "store-0", reportDate: "2026-10-31" });
      assert.equal(manualResponse.status, 201);
      const manualBody = await manualResponse.json();
      assert.equal(manualBody.data.confirmedFileCount, 1);
      assert.deepEqual(manualBody.data.results.map((item: { success: boolean }) => item.success), [true, false]);
      assert.equal(manualBody.data.items, undefined, "explicit store/date keeps the partial manual-upload response");
      const persisted = JSON.parse(readFileSync(join(directory, "database.json"), "utf8"));
      assert.equal(persisted.adExcelUploads.length, 3);
      assert.equal(persisted.adCampaignDailyCosts.length, 3);
      assert.equal(persisted.dailyStoreSummaries.length, 2);
      assert.equal(persisted.orders.length, 0);
      assert.equal(persisted.adCampaignDailyCosts.find((row: { campaignId: string }) => row.campaignId === "manual-campaign").storeId, "store-0");
    } finally {
      await app.close();
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
  console.log("PASS multipart HTTP batch upload repairs Korean filenames, persists and rejects duplicate retries");
}
