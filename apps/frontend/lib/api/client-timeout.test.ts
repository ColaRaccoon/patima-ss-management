import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchApi } from "./client";

test("mapping reads allow responses slower than the previous 2.5 second cutoff", async (context) => {
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2800);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
    });
    return Response.json({ success: true, data: { items: ["saved campaign"] } });
  });
  const result = await fetchApi<{ items: string[] }>({ label: "Ad campaign signatures", path: "/ad-campaign-signatures" });
  assert.deepEqual(result.data.items, ["saved campaign"]);
  assert.equal(result.source, "live");
});

test("a transient read timeout retries and returns the real response", async (context) => {
  let attempts = 0;
  context.mock.method(globalThis, "fetch", async () => {
    if (++attempts === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return Response.json({ success: true, data: { items: [] } });
  });
  const result = await fetchApi<{ items: string[] }>({ label: "Ad campaign signatures", path: "/ad-campaign-signatures" });
  assert.equal(attempts, 2);
  assert.equal(result.source, "live");
});
