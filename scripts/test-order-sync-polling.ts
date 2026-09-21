import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as api from "../apps/frontend/lib/api/order-sync";

// Execute the actual provider callbacks/effect with deterministic browser IO.
// This harness covers scheduling; React rendering is left to the application.
const source = ts.transpileModule(
  readFileSync(
    resolve("apps/frontend/components/orders/order-sync-provider.tsx"),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const batch = (status = "RUNNING", id = "batch-1", version = 1) => ({
  batchId: id,
  mode: "YESTERDAY",
  status,
  requestedCutoffAt: "2026-09-19T00:00:00.000Z",
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: `2026-09-19T00:00:0${version}.000Z`,
  requestedRange: { dateFrom: "2026-09-18", dateTo: "2026-09-18" },
  counts: {
    total: 0,
    target: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  },
  items: [],
});
const response = (data: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, data }),
});
const drain = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

function harness(url = "http://localhost/orders") {
  const effects: Array<() => () => void> = [];
  const states: unknown[] = [];
  const listeners = new Map<string, Set<(event?: any) => void>>();
  const timers = new Map<number, { due: number; callback: () => void }>();
  const requests: string[] = [];
  let clock = 0,
    timerId = 0;
  let handler: (path: string, options: any) => unknown = () =>
    response({ items: [] });
  const events = {
    addEventListener: (name: string, fn: (event?: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    removeEventListener: (name: string, fn: (event?: any) => void) =>
      listeners.get(name)?.delete(fn),
  };
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  const window = {
    ...events,
    location: { href: url },
    history: {
      replaceState: (_state: unknown, _title: string, next: URL) => {
        window.location.href = String(next);
      },
    },
  };
  const document = { ...events, hidden: false };
  const jsx = (type: unknown, props: any) => ({ type, props });
  const exports: any = {};
  runInNewContext(source, {
    exports,
    URL,
    AbortController,
    console,
    window,
    document,
    sessionStorage: storage,
    localStorage: storage,
    crypto: { randomUUID: () => "test-request-key" },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { callback, due: clock + delay });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (path: string, options: any) => {
      requests.push(path);
      return handler(path, options);
    },
    require: (name: string) => {
      if (name === "react")
        return {
          createContext: () => ({ Provider: "provider" }),
          Suspense: "suspense",
          useCallback: (fn: unknown) => fn,
          useRef: (current: unknown) => ({ current }),
          useEffect: (fn: () => () => void) => effects.push(fn),
          useState: (initial: unknown) => {
            const index = states.length;
            states.push(initial);
            return [
              initial,
              (next: unknown) => {
                states[index] = next;
              },
            ];
          },
        };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "next/navigation")
        return { useRouter: () => ({ refresh: () => {} }) };
      if (name === "next/link") return { default: "link" };
      if (name === "@/lib/api/order-sync") return api;
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const tree = exports.OrderSyncProvider({ children: null });
  let cleanup: (() => void) | undefined;
  return {
    requests,
    states,
    timers,
    document,
    setHandler: (next: typeof handler) => {
      handler = next;
    },
    start: async () => {
      cleanup = effects[0]();
      await drain();
    },
    stop: () => cleanup?.(),
    emit: async (name: string, event?: unknown) => {
      listeners.get(name)?.forEach((fn) => fn(event));
      await drain();
    },
    submit: async () => {
      await tree.props.value.submit("/api/stores/order-sync-all", {});
      await drain();
    },
    advance: async (ms: number) => {
      const end = clock + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        clock = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
        await drain();
      }
      clock = end;
    },
  };
}

async function main() {
  const idle = harness();
  await idle.start();
  assert.equal(idle.requests.length, 2);
  assert.equal(idle.timers.size, 0);
  await idle.advance(60_000);
  assert.equal(idle.requests.length, 2, "idle must not poll periodically");
  for (const event of ["focus", "online", "visibilitychange"]) {
    const before = idle.requests.length;
    await idle.emit(event);
    assert.equal(idle.requests.length, before + 1);
    assert.equal(idle.timers.size, 0);
  }
  idle.stop();

  const active = harness("http://localhost/orders?batchId=batch-1");
  let finished = false;
  active.setHandler((path) =>
    response(
      path.includes("/batch-1")
        ? batch("SUCCEEDED", "batch-1", 2)
        : { items: finished ? [] : [batch()] },
    ),
  );
  await active.start();
  assert.equal(active.timers.size, 1);
  finished = true;
  await active.advance(2500);
  assert.ok(
    active.requests.some((path) => path.endsWith("/batch-1")),
    "missing active row must be resolved through detail",
  );
  assert.equal(active.timers.size, 0, "terminal jobs stop polling");
  active.setHandler((path, options) =>
    response(
      options?.method === "POST" || path.endsWith("/batch-1")
        ? batch("RUNNING", "batch-1", 3)
        : { items: [batch("RUNNING", "batch-1", 3)] },
    ),
  );
  const beforeSubmit = active.requests.length;
  await active.submit();
  assert.ok(
    active.requests.length > beforeSubmit + 1,
    "same-URL submission must explicitly wake polling",
  );
  assert.equal(active.timers.size, 1);
  active.stop();
  assert.equal(active.timers.size, 0);

  const failure = harness();
  failure.setHandler(() => {
    throw new Error("offline");
  });
  await failure.start();
  assert.equal(failure.timers.size, 1);
  failure.setHandler(() => response({ items: [] }));
  await failure.advance(5000);
  assert.equal(
    failure.timers.size,
    0,
    "recovered idle connection stops retrying",
  );
  failure.stop();

  const wake = harness();
  await wake.start();
  let release!: (value: unknown) => void;
  wake.setHandler(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await wake.emit("focus");
  const beforeWake = wake.requests.length;
  await wake.emit("online");
  assert.equal(
    wake.requests.length,
    beforeWake,
    "in-flight wake must not overlap requests",
  );
  wake.setHandler(() => response({ items: [] }));
  release(response({ items: [] }));
  await drain();
  await wake.advance(0);
  assert.equal(
    wake.requests.length,
    beforeWake + 1,
    "in-flight wake must be retained",
  );
  assert.equal(wake.timers.size, 0);
  wake.stop();

  const uncertain = harness();
  await uncertain.start();
  let historyFailed = false;
  uncertain.setHandler((path, options) => {
    if (options?.method === "POST") throw new Error("response lost");
    if (!path.includes("active=true") && !historyFailed) {
      historyFailed = true;
      throw new Error("history temporarily unavailable");
    }
    return response({
      items: path.includes("active=true") ? [] : [batch("SUCCEEDED")],
    });
  });
  await uncertain.submit();
  assert.equal(uncertain.timers.size, 1);
  await uncertain.advance(5000);
  assert.ok(
    (uncertain.states[0] as any[]).some((value) => value.batchId === "batch-1"),
    "uncertain POST must recover even a quickly completed job",
  );
  assert.equal(uncertain.timers.size, 0);
  uncertain.stop();

  const otherTab = harness();
  otherTab.setHandler(() => response({ items: [batch("SUCCEEDED")] }));
  await otherTab.start();
  otherTab.setHandler((path) =>
    response(
      path.endsWith("/batch-1")
        ? batch("SUCCEEDED", "batch-1", 2)
        : { items: [] },
    ),
  );
  await otherTab.emit("storage", {
    key: "order-sync-batch-wake-v1",
    newValue: JSON.stringify({ batchId: "batch-1", nonce: "changed" }),
  });
  assert.equal(
    (otherTab.states[0] as any[])[0].updatedAt,
    batch("SUCCEEDED", "batch-1", 2).updatedAt,
    "other-tab updates refresh a known terminal batch",
  );
  assert.equal(otherTab.timers.size, 0);
  otherTab.stop();
  await otherTab.emit("focus");
  assert.equal(otherTab.timers.size, 0);

  const partial = harness();
  partial.setHandler(() =>
    response({ items: [batch("SUCCEEDED", "a"), batch("SUCCEEDED", "b")] }),
  );
  await partial.start();
  let releaseList!: (value: unknown) => void;
  partial.setHandler((path) => {
    if (path.endsWith("/a")) return response(batch("SUCCEEDED", "a", 2));
    if (path.endsWith("/b")) throw new Error("second detail failed");
    return new Promise((resolve) => {
      releaseList = resolve;
    });
  });
  await partial.emit("focus");
  for (const id of ["a", "b"])
    await partial.emit("storage", {
      key: "order-sync-batch-wake-v1",
      newValue: JSON.stringify({ batchId: id }),
    });
  releaseList(response({ items: [] }));
  await drain();
  partial.setHandler((path) =>
    response(
      path.endsWith("/a")
        ? batch("SUCCEEDED", "a", 2)
        : path.endsWith("/b")
          ? batch("SUCCEEDED", "b", 2)
          : { items: [] },
    ),
  );
  await partial.advance(0);
  assert.ok(
    (partial.states[0] as any[]).every(
      (value) => value.updatedAt === batch("SUCCEEDED", "a", 2).updatedAt,
    ),
    "partial detail failure must retain every unapplied refresh",
  );
  assert.equal(partial.timers.size, 0);
  partial.stop();

  const unmounted = harness();
  let releaseUnmounted!: (value: unknown) => void;
  unmounted.setHandler(
    () =>
      new Promise((resolve) => {
        releaseUnmounted = resolve;
      }),
  );
  await unmounted.start();
  unmounted.stop();
  unmounted.setHandler(() => response({ items: [] }));
  releaseUnmounted(response({ items: [] }));
  await drain();
  assert.equal(
    unmounted.timers.size,
    0,
    "late response after cleanup must not restart polling",
  );
  console.log(
    "PASS order-sync provider polling: idle, completion, submit, recovery, in-flight wake, response loss, cross-tab refresh and cleanup",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
