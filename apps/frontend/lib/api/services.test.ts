import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateNetProfitAfterFakePurchase } from "@patima/shared";
import { getDashboardPageData, getProfitsPageData, getOrdersPageData, getSalesUnitsPageData } from "./services";
import { fetchApi } from "./client";
import nextConfig from "../../next.config";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";

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

test("orders request only the selected page of each list and retain total counts", async (context) => {
  const requests: URL[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.endsWith("/stores")) return Response.json({ success: true, data: [{ id: "s", isPrimary: true }] });
    return Response.json({ success: true, data: {
      items: [], page: Number(url.searchParams.get("page")), pageSize: 50,
      totalCount: 451, totalPages: 10, hasNext: true,
    } });
  });
  const result = await getOrdersPageData({ storeId: "s", orderPage: 3, signaturePage: 2, productName: "상품" });
  assert.equal(result.orderPage.page, 3);
  assert.equal(result.signaturePage.page, 2);
  assert.equal(result.orderPage.totalCount, 451);
  assert.equal(requests.length, 3, "does not eagerly download remaining signature pages");
  for (const url of requests.slice(1)) assert.equal(url.searchParams.get("pageSize"), "50");
  requests.length = 0;
  const normalized = await getOrdersPageData({ orderPage: NaN, signaturePage: 0.5 });
  assert.equal(normalized.orderPage.page, 1);
  assert.equal(normalized.signaturePage.page, 1);
});

test("all-page readers honor hasNext even when totalPages is omitted", async (context) => {
  const pages: number[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/stores")) return Response.json({ success: true, data: [{ id: "s", isPrimary: true }] });
    if (url.pathname.endsWith("/canonical-sales-units")) {
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      return Response.json({ success: true, data: { items: [{ id: `unit-${page}` }], hasNext: page < 2 } });
    }
    return Response.json({ success: true, data: [] });
  });
  const result = await getSalesUnitsPageData();
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.salesUnits.length, 2);
});

test("orders recover a stale page URL by fetching the last available page once", async (context) => {
  const requestedPages: number[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/stores")) return Response.json({ success: true, data: [{ id: "s", isPrimary: true }] });
    const page = Number(url.searchParams.get("page"));
    if (url.pathname.endsWith("/order-items")) requestedPages.push(page);
    return Response.json({ success: true, data: {
      items: page === 2 ? [{ id: "last-order" }] : [], page, pageSize: 50,
      totalCount: 60, totalPages: 2, hasNext: page < 2,
    } });
  });
  const result = await getOrdersPageData({ orderPage: 10 });
  assert.deepEqual(requestedPages, [10, 2]);
  assert.equal(result.orderPage.page, 2);
  assert.equal(result.orderItems[0].id, "last-order");
});

test("empty pages with hasNext fail instead of silently truncating or looping", async (context) => {
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    return Response.json({ success: true, data: url.pathname.endsWith("/stores")
      ? [{ id: "s", isPrimary: true }]
      : { items: [], hasNext: true } });
  });
  await assert.rejects(() => getSalesUnitsPageData(), /페이지 응답/);
});

test("management API errors remain errors unless sample fallback is explicitly enabled", async (context) => {
  const previous = process.env.API_ALLOW_MOCK_FALLBACK;
  try {
    delete process.env.API_ALLOW_MOCK_FALLBACK;
    context.mock.method(globalThis, "fetch", async () => Response.json({ message: "서버 연결 확인" }, { status: 503 }));
    await assert.rejects(() => getOrdersPageData(), /서버 연결 확인/);
    await assert.rejects(() => fetchApi({ label: "test", path: "/test", fallback: [] }), /서버 연결 확인/);
    process.env.API_ALLOW_MOCK_FALLBACK = "true";
    const fallback = await fetchApi({ label: "test", path: "/test", fallback: [] });
    assert.equal(fallback.source, "mock");
  } finally {
    if (previous === undefined) delete process.env.API_ALLOW_MOCK_FALLBACK;
    else process.env.API_ALLOW_MOCK_FALLBACK = previous;
  }
});

test("HTTP 200 with a failed envelope and no data is still an error", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ success: false, message: "잘못된 요청" }));
  await assert.rejects(() => fetchApi({ label: "test", path: "/test" }), /잘못된 요청/);
});
