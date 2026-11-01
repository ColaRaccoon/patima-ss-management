import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateNetProfitAfterFakePurchase } from "@patima/shared";
import { getDashboardPageData, getProfitsPageData } from "./services";
import nextConfig from "../../next.config";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";
import { parseAdUploadFileName } from "@patima/shared";
import { POST as uploadAdBatch } from "../../app/api/ad-uploads/batch/route";

test("daily ad filenames classify both stores, suffixes and calendar dates", () => {
  for (const store of ["파티마", "인피니티"]) for (const suffix of ["", "메인", "서브"]) {
    assert.deepEqual(parseAdUploadFileName(`261031_${store}${suffix}.xlsx`), { reportDate: "2026-10-31", storeName: `${store}스토어` });
  }
  for (const name of ["260229_파티마.xlsx", "261331_파티마.xlsx", "261031_다른스토어.xlsx"]) assert.equal(parseAdUploadFileName(name), null);
});

test("batch upload proxy forwards every file together and preserves server errors", async (context) => {
  const files = ["261031_인피니티.xlsx", "261031_파티마.xlsx"];
  let upstreamStatus = 201;
  const error = { message: "중복 캠페인입니다.", fileName: files[1] };
  const fetchMock = context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(input).endsWith("/ad-uploads/batch"));
    const form = init?.body as FormData;
    assert.deepEqual(form.getAll("files").map((file) => (file as File).name), files);
    assert.equal(form.has("storeId"), false);
    assert.equal(form.has("reportDate"), false);
    return Response.json(upstreamStatus === 201 ? { success: true, data: { items: [] } } : error, { status: upstreamStatus });
  });
  const request = () => {
    const form = new FormData();
    for (const name of files) form.append("files", new Blob(["fixture"]), name);
    return new Request("http://localhost/api/ad-uploads/batch", { method: "POST", body: form });
  };
  assert.equal((await uploadAdBatch(request())).status, 201);
  upstreamStatus = 400;
  const response = await uploadAdBatch(request());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), error);
  const empty = await uploadAdBatch(new Request("http://localhost/api/ad-uploads/batch", { method: "POST", body: new FormData() }));
  assert.equal(empty.status, 400);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("development and production builds use separate output directories", () => {
  const previous = process.env.NEXT_DIST_DIR;
  try {
    delete process.env.NEXT_DIST_DIR;
    assert.notEqual(nextConfig(PHASE_DEVELOPMENT_SERVER).distDir, nextConfig(PHASE_PRODUCTION_BUILD).distDir);
    assert.equal(nextConfig(PHASE_PRODUCTION_BUILD).distDir, nextConfig(PHASE_PRODUCTION_SERVER).distDir);
    process.env.NEXT_DIST_DIR = ".next-custom";
    assert.equal(nextConfig(PHASE_DEVELOPMENT_SERVER).distDir, ".next-custom");
  } finally {
    if (previous === undefined) delete process.env.NEXT_DIST_DIR;
    else process.env.NEXT_DIST_DIR = previous;
  }
});

test("dashboard and profits use the same live date, store and fake-purchase deduction", async (context) => {
  const requests: URL[] = [];
  const date = "2026-10-25";
  context.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      let data: unknown;
      switch (url.pathname.replace("/api/v1", "")) {
        case "/stores":
          data = [
            { id: "primary", isPrimary: true },
            { id: "selected", isPrimary: false },
          ];
          break;
        case "/profits/latest-date":
          data = {
            date,
            latestOrderDate: date,
            latestAdDate: date,
            latestOverlapDate: date,
          };
          break;
        case "/dashboard/summary":
          data = { date, estimatedNetProfit: 5200, profitStatus: "COMPLETE" };
          break;
        case "/profits/daily-sales-units":
          data = { items: [], hasNext: false };
          break;
        case "/operations":
          data = { items: [], hasNext: false };
          break;
        case "/daily-fake-purchases":
          data = { amount: 1000, exists: true, updatedAt: null };
          break;
        case "/profits/unmapped-summary":
          data = {};
          break;
        default:
          throw new Error(`Unexpected request: ${url}`);
      }
      return Response.json({ success: true, data });
    },
  );
  const dashboard = await getDashboardPageData({ storeId: "selected" });
  const profits = await getProfitsPageData({ storeId: "selected" });
  assert.equal(dashboard.selectedDate, date);
  assert.equal(profits.dateFrom, date);
  assert.equal(profits.dateTo, date);
  for (const page of [dashboard, profits]) {
    assert.equal(page.primaryStore?.id, "selected");
    assert.equal(
      calculateNetProfitAfterFakePurchase(
        page.summary.estimatedNetProfit,
        page.fakePurchase?.amount ?? 0,
      ),
      4200,
    );
    assert.ok(page.sources.every((source) => source.source === "live"));
  }
  for (const url of requests.filter(
    (item) => !item.pathname.endsWith("/stores"),
  )) {
    assert.equal(url.searchParams.get("storeId"), "selected");
    for (const key of ["date", "dateFrom", "dateTo"]) {
      if (url.searchParams.has(key))
        assert.equal(url.searchParams.get(key), date);
    }
  }
});

test("dashboard financial data does not silently fall back to mock results", async (context) => {
  context.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stores"))
        return Response.json({
          success: true,
          data: [{ id: "s", isPrimary: true }],
        });
      if (url.pathname.endsWith("/profits/latest-date"))
        return Response.json({ success: true, data: { date: "2026-10-25" } });
      return new Response("unavailable", { status: 503 });
    },
  );
  await assert.rejects(() => getDashboardPageData(), /HTTP 503/);
});

test("empty stores do not request mock store profit data", async (context) => {
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ success: true, data: [] });
  });
  const page = await getDashboardPageData();
  assert.equal(page.primaryStore, null);
  assert.equal(page.fakePurchase, null);
  assert.equal(requests, 1);
});
