import assert from "node:assert/strict";
import { BadGatewayException } from "@nestjs/common";
import {
  NaverCommerceService,
  ResolvedCommerceCredential,
} from "./naver-commerce.service";
import { NaverRequestError, requestNaverJson } from "./naver-request";

// Synthetic fixtures follow the official conditional/content, detail/data, and changed/data envelopes.
const detail = (id: string, extra = {}) => ({
  order: {
    orderId: `order-${id}`,
    orderDate: "2026-09-01T12:00:00.000+09:00",
    paymentDate: "2026-09-01T12:00:01.000+09:00",
  },
  productOrder: {
    productOrderId: id,
    productName: "Fixture",
    productOrderStatus: "PAYED",
    quantity: 1,
    totalPaymentAmount: 1000,
    ...extra,
  },
});
const conditional = (ids: string[], page = 1, hasNext = false) => ({
  data: {
    contents: ids.map((id) => ({ content: detail(id) })),
    pagination: { page, size: 100, hasNext },
  },
});
const response = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });
const credential: ResolvedCommerceCredential = {
  credentialId: null,
  clientId: "fixture-client",
  clientSecret: "$2a$04$abcdefghijklmnopqrstuv",
  accessType: "SELLER",
  source: "ENV",
};
const service = () => {
  const instance = new NaverCommerceService(
    {} as never,
    {} as never,
    {} as never,
  );
  instance.getResolvedConfiguration = () => ({
    store: { sellerAccountId: "fixture-store", channelNo: "1" } as never,
    credential,
  });
  return instance;
};

export async function runNaverReliabilityTests() {
  const originalFetch = globalThis.fetch;
  const install = (
    handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  ) => {
    globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/oauth2/token"))
        return response({ access_token: "fixture-token", expires_in: 3600 });
      return handler(parsed, init);
    };
  };
  const collect = (instance = service()) =>
    instance.fetchOrderItems("store", "2026-09-01", "2026-09-01");
  try {
    let requests = 0;
    install(() => {
      requests += 1;
      return response(conditional([]));
    });
    assert.deepEqual(await collect(), []);
    assert.equal(requests, 1);
    await assert.rejects(
      service().fetchOrderItems("store", "2026-09-02", "2026-09-02", {
        requestedCutoffAt: "2026-09-01T12:00:00.000+09:00",
      }),
      /INVALID_ORDER_RANGE/,
    );
    assert.equal(
      requests,
      1,
      "an entirely future range must fail instead of succeeding without querying a page",
    );

    install(() => response({}));
    await assert.rejects(collect(), /NAVER_INVALID_RESPONSE/);
    install(() => new Response("not JSON", { status: 200 }));
    await assert.rejects(collect(), /NAVER_INVALID_RESPONSE/);

    const detailBodies: string[][] = [];
    install((url, init) => {
      if (!url.pathname.endsWith("/query"))
        return response(conditional(["a", "b"]));
      const ids = (
        JSON.parse(String(init.body)) as { productOrderIds: string[] }
      ).productOrderIds;
      detailBodies.push(ids);
      return response({
        data: [detail(detailBodies.length === 1 ? "a" : "b")],
      });
    });
    assert.equal((await collect()).length, 2);
    assert.deepEqual(detailBodies, [["a", "b"], ["b"]]);
    install((url) => {
      const value = detail("a");
      value.order.paymentDate = "2026-08-31T15:30:00.000Z";
      return response(
        url.pathname.endsWith("/query")
          ? { data: [value] }
          : conditional(["a"]),
      );
    });
    assert.equal(
      (await collect())[0]?.paymentDate,
      "2026-09-01",
      "UTC timestamps must aggregate on the KST payment date",
    );

    install((url) =>
      response(
        url.pathname.endsWith("/query") ? { data: [] } : conditional(["a"]),
      ),
    );
    await assert.rejects(collect(), /NAVER_MISSING_ORDER_DETAILS/);
    install((url) =>
      response(
        url.pathname.endsWith("/query")
          ? { data: [detail("a"), detail("a")] }
          : conditional(["a"]),
      ),
    );
    await assert.rejects(collect(), /NAVER_UNEXPECTED_DETAIL_ID/);
    install((url) =>
      response(
        url.pathname.endsWith("/query")
          ? { data: [detail("unexpected")] }
          : conditional(["a"]),
      ),
    );
    await assert.rejects(collect(), /NAVER_UNEXPECTED_DETAIL_ID/);
    install((url) =>
      response(
        url.pathname.endsWith("/query")
          ? { data: [detail("a", { totalPaymentAmount: "broken" })] }
          : conditional(["a"]),
      ),
    );
    await assert.rejects(collect(), /NAVER_INVALID_ORDER_AMOUNT/);

    install((url) =>
      response(
        url.pathname.endsWith("/query")
          ? { data: [detail("a")] }
          : conditional(["a"], Number(url.searchParams.get("page")), true),
      ),
    );
    await assert.rejects(collect(), /INCOMPLETE_PAGINATION/);
    install(() => response(conditional([], 1, true)));
    await assert.rejects(collect(), /INCOMPLETE_PAGINATION/);

    let changedCalls = 0;
    const changedWindows: Array<{ from: string; to: string }> = [];
    let observedCutoff: string | null = null;
    install((url) => {
      if (url.pathname.endsWith("/last-changed-statuses")) {
        changedCalls += 1;
        changedWindows.push({
          from: url.searchParams.get("lastChangedFrom")!,
          to: url.searchParams.get("lastChangedTo")!,
        });
        return response({
          timestamp: "2026-09-01T12:00:00.000+09:00",
          traceId: "fixture-trace",
        });
      }
      observedCutoff = url.searchParams.get("to");
      return response(conditional([]));
    });
    assert.deepEqual(
      await service().fetchOrderItems("store", "2026-09-01", "2026-09-01", {
        requestedCutoffAt: "2026-09-01T12:00:00.000+09:00",
        changedFrom: "2026-08-31T12:00:00.000+09:00",
      }),
      [],
    );
    assert.equal(changedCalls, 2);
    assert.equal(changedWindows[0].from, "2026-08-31T11:55:00.000+09:00");
    assert.equal(
      Date.parse(changedWindows[1].from),
      Date.parse(changedWindows[0].to) + 1,
    );
    assert.equal(observedCutoff, "2026-09-01T12:00:00.000+09:00");

    install((url) => {
      if (url.pathname.endsWith("/query"))
        return response({
          data: [detail("old", { productOrderStatus: "CANCELED" })],
        });
      if (url.pathname.endsWith("/last-changed-statuses"))
        return response({
          data: {
            count: 1,
            lastChangeStatuses: [
              {
                productOrderId: "old",
                orderId: "order-old",
                lastChangedDate: "2026-09-01T10:00:00.000+09:00",
              },
            ],
          },
        });
      return response(conditional([]));
    });
    const changed = await service().fetchOrderItems(
      "store",
      "2026-09-01",
      "2026-09-01",
      { changedFrom: "2026-09-01T00:00:00.000+09:00" },
    );
    assert.equal(changed[0]?.saleStatus, "CANCELED");

    install((url) => {
      if (url.pathname.endsWith("/query"))
        return response({ data: [detail("old")] });
      if (url.pathname.endsWith("/last-changed-statuses"))
        return response({
          data: {
            count: 1,
            lastChangeStatuses: [
              {
                productOrderId: "old",
                orderId: "order-old",
                lastChangedDate: "2026-09-01T10:00:00.000+09:00",
              },
            ],
            more: {
              moreFrom: "2026-09-01T10:00:00.000+09:00",
              moreSequence: 1,
            },
          },
        });
      return response(conditional([]));
    });
    await assert.rejects(
      service().fetchOrderItems("store", "2026-09-01", "2026-09-01", {
        changedFrom: "2026-09-01T00:00:00.000+09:00",
      }),
      /INCOMPLETE_PAGINATION/,
    );

    let attempts = 0;
    install(() => {
      attempts += 1;
      return attempts < 3
        ? response({ code: "TEMPORARY", message: "private data" }, 503)
        : response({ ok: true });
    });
    assert.deepEqual(
      await requestNaverJson("https://fixture.invalid/orders", {}),
      { ok: true },
    );
    assert.equal(attempts, 3);
    attempts = 0;
    install(() => {
      attempts += 1;
      return response({ code: "BAD_REQUEST", message: "secret data" }, 400);
    });
    await assert.rejects(
      requestNaverJson("https://fixture.invalid/orders", {}),
      (error: unknown) =>
        error instanceof NaverRequestError &&
        !error.retryable &&
        !error.message.includes("secret"),
    );
    assert.equal(attempts, 1);
    await assert.rejects(
      service().testConnection("store"),
      (error: unknown) =>
        error instanceof BadGatewayException && error.getStatus() === 502,
    );

    install(() =>
      response({ code: "RATE_LIMIT" }, 429, { "retry-after": "60" }),
    );
    await assert.rejects(
      requestNaverJson("https://fixture.invalid/orders", {}),
      (error: unknown) =>
        error instanceof NaverRequestError && error.retryAfterMs === 60_000,
    );

    const originalSetTimeout = globalThis.setTimeout;
    try {
      globalThis.setTimeout = ((
        callback: (...args: unknown[]) => void,
        _delay?: number,
        ...args: unknown[]
      ) => originalSetTimeout(callback, 1, ...args)) as typeof setTimeout;
      let timedOutAttempts = 0;
      install(async (_url, init) => {
        timedOutAttempts += 1;
        return {
          text: () =>
            new Promise((_resolve, reject) =>
              init.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true },
              ),
            ),
        } as Response;
      });
      await assert.rejects(
        requestNaverJson("https://fixture.invalid/orders", {}),
        /NAVER_REQUEST_TIMEOUT/,
      );
      assert.equal(
        timedOutAttempts,
        3,
        "body timeout must remain bounded and retryable",
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    let tokenCount = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/oauth2/token")) {
        tokenCount += 1;
        return response({ access_token: "fixture-token", expires_in: 3600 });
      }
      return response(conditional([]));
    };
    const shared = service();
    await Promise.all([collect(shared), collect(shared)]);
    assert.equal(tokenCount, 1);

    let tokenIssuances = 0;
    let authenticatedCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/oauth2/token")) {
        tokenIssuances += 1;
        return response({
          access_token: `token-${tokenIssuances}`,
          expires_in: 3600,
        });
      }
      authenticatedCalls += 1;
      return response({ code: "GW.AUTHN" }, 401);
    };
    await assert.rejects(collect(), /NAVER_AUTHENTICATION_FAILED/);
    assert.equal(tokenIssuances, 2);
    assert.equal(authenticatedCalls, 2);

    const abort = new AbortController();
    let abortedRequest = false;
    install(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              abortedRequest = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
          abort.abort(new Error("LEASE_LOST"));
        }),
    );
    await assert.rejects(
      requestNaverJson("https://fixture.invalid/orders", {}, abort.signal),
      /LEASE_LOST/,
    );
    assert.equal(abortedRequest, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
