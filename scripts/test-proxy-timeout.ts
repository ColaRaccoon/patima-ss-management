import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as upstream from "../apps/frontend/lib/api/upstream";

// Load the real proxy and route handlers with deterministic upstream IO/timers.
const timers = new Map<number, { callback: () => void; delay: number }>();
let timerId = 0;
let fetchImpl: (url: string, options: RequestInit) => Promise<unknown>;
function load(path: string, imports: Record<string, unknown>): any {
  const exports = {};
  const source = ts.transpileModule(readFileSync(resolve(path), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  runInNewContext(source, {
    exports,
    URL,
    AbortController,
    require: (name: string) => {
      if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
      return imports[name];
    },
    fetch: (url: string, options: RequestInit) => fetchImpl(url, options),
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return exports;
}
const proxy = load("apps/frontend/app/api/_utils/proxy.ts", {
  "next/server": {
    NextResponse: {
      json: (data: unknown, init?: ResponseInit) => Response.json(data, init),
    },
  },
  "@/lib/api/upstream": upstream,
});
const route = (path: string) =>
  load(`apps/frontend/app/api/${path}/route.ts`, {
    "@/app/api/_utils/proxy": proxy,
  });
const request = () =>
  new Request("http://localhost/api/example", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: "test-key" }),
  });
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function main() {
  const daily = route("daily-fake-purchases");
  let release!: (response: Response) => void;
  fetchImpl = async (url, options) => {
    assert.ok(url.endsWith("/daily-fake-purchases"));
    assert.equal(options.method, "PUT");
    assert.equal(
      options.signal,
      undefined,
      "existing synchronous writes must not acquire a timeout signal",
    );
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  };
  const saving = daily.PUT(request());
  await drain();
  assert.equal(
    timers.size,
    0,
    "a slow fake-purchase save must not schedule the former 25-second abort",
  );
  release(Response.json({ success: true, data: { amount: 1200 } }));
  assert.equal((await saving).status, 200);

  const boundedRoutes: Array<[string, string, object?]> = [
    ["stores/order-sync-all", "POST"],
    ["stores/[storeId]/order-sync", "POST", { storeId: "store-1" }],
    ["order-sync-batches", "GET"],
    ["order-sync-batches/[batchId]", "GET", { batchId: "batch-1" }],
    [
      "order-sync-batches/[batchId]/retry-failed",
      "POST",
      { batchId: "batch-1" },
    ],
    ["operations/[operationId]", "GET", { operationId: "operation-1" }],
    ["operations/[operationId]/retry", "POST", { operationId: "operation-1" }],
  ];
  for (const [path, method, params] of boundedRoutes) {
    fetchImpl = async (_url, options) =>
      new Promise((_resolve, reject) => {
        assert.ok(options.signal);
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    const pending = route(path)[method](request(), {
      params: Promise.resolve(params),
    });
    await drain();
    assert.equal(timers.size, 1, path);
    const timer = [...timers.values()][0];
    assert.equal(timer.delay, 25_000, path);
    timer.callback();
    const result = await pending;
    assert.equal(result.status, 504, path);
    assert.equal((await result.json()).success, false);
    assert.equal(timers.size, 0, "timeouts must be cleared after abort");
  }

  fetchImpl = async (_url, options) => {
    assert.equal(options.signal, undefined);
    return Response.json({ success: true, data: {} });
  };
  await route("order-sync-batches/[batchId]/retry-summary").POST(request(), {
    params: Promise.resolve({ batchId: "batch-1" }),
  });
  assert.equal(
    timers.size,
    0,
    "synchronous summary recalculation must not get the queued-job deadline",
  );

  for (const status of [202, 400]) {
    fetchImpl = async () =>
      Response.json(
        { success: status === 202, message: "upstream message", data: {} },
        { status },
      );
    const result = await proxy.proxyRequest({
      path: "/test",
      method: "POST",
      fallbackMessage: "fallback",
      timeoutMs: 25_000,
    });
    assert.equal(result.status, status);
    assert.equal((await result.json()).message, "upstream message");
    assert.equal(
      timers.size,
      0,
      "successful/error responses must clear their deadlines",
    );
  }
  fetchImpl = async (_url, options) => ({
    ok: true,
    status: 202,
    text: () =>
      new Promise((_resolve, reject) => {
        options.signal!.addEventListener(
          "abort",
          () => reject(new Error("body read aborted")),
          { once: true },
        );
      }),
  });
  const readingBody = proxy.proxyRequest({
    path: "/test",
    method: "GET",
    fallbackMessage: "fallback",
    timeoutMs: 25_000,
  });
  await drain();
  assert.equal(
    timers.size,
    1,
    "deadline must remain active while reading the response body",
  );
  [...timers.values()][0].callback();
  assert.equal((await readingBody).status, 504);
  assert.equal(timers.size, 0);

  fetchImpl = async () => {
    throw new Error("connection refused");
  };
  assert.equal(
    (
      await proxy.proxyRequest({
        path: "/test",
        method: "PUT",
        fallbackMessage: "fallback",
      })
    ).status,
    502,
  );
  console.log(
    "PASS proxy deadlines: synchronous save preserved, seven queued/status routes bounded, summary unbounded, status/error/cleanup preserved",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
