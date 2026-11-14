import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchApi } from "./client";

test("a campaign lookup can complete after the former 2.5 second deadline", async (context) => {
  const timeout = context.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.ok(ms >= 7500, "uploaded campaign queries need time to finish");
    return new AbortController().signal;
  });
  let now = 0;
  context.mock.method(Date, "now", () => now);
  context.mock.method(globalThis, "fetch", async () => {
    now += 7500;
    return Response.json({ success: true, data: { items: [{ id: "campaign" }] } });
  });
  const result = await fetchApi<{ items: { id: string }[] }>({
    label: "Ad campaign signatures", path: "/ad-campaign-signatures",
  });
  assert.equal(result.source, "live");
  assert.equal(result.data.items[0].id, "campaign");
  assert.equal(timeout.mock.callCount(), 1);
});

test("a transient read timeout retries and returns live data", async (context) => {
  let now = 0;
  context.mock.method(Date, "now", () => now);
  context.mock.method(globalThis, "setTimeout", ((callback: () => void, ms: number) => {
    now += ms;
    queueMicrotask(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  let attempts = 0;
  context.mock.method(globalThis, "fetch", async () => {
    if (++attempts === 1) throw new DOMException("timed out", "TimeoutError");
    return Response.json({ success: true, data: ["recovered"] });
  });
  const result = await fetchApi<string[]>({ label: "campaigns", path: "/ad-campaign-signatures" });
  assert.deepEqual(result.data, ["recovered"]);
  assert.equal(result.source, "live");
  assert.equal(attempts, 2);
});

test("repeated timeouts stay inside the total read retry budget", async (context) => {
  let now = 0;
  let attemptTimeout = 0;
  const timeouts: number[] = [];
  context.mock.method(Date, "now", () => now);
  context.mock.method(AbortSignal, "timeout", (ms: number) => {
    attemptTimeout = ms;
    timeouts.push(ms);
    return new AbortController().signal;
  });
  context.mock.method(globalThis, "setTimeout", ((callback: () => void, ms: number) => {
    now += ms;
    queueMicrotask(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  context.mock.method(globalThis, "fetch", async () => {
    now += attemptTimeout;
    throw new DOMException("timed out", "TimeoutError");
  });
  await assert.rejects(
    () => fetchApi({ label: "campaigns", path: "/ad-campaign-signatures" }),
    /campaigns: timed out/,
  );
  assert.equal(now, 30000);
  assert.deepEqual(timeouts, [15000, 14500]);
});
