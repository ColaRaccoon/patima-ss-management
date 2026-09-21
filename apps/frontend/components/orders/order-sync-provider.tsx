"use client";

import Link from "next/link";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { OrderSyncBatchView } from "@patima/shared";
import {
  readOrderSyncResponse,
  validateOrderSyncBatch,
} from "@/lib/api/order-sync";

export const isActiveBatch = (batch: OrderSyncBatchView) =>
  batch.status === "QUEUED" || batch.status === "RUNNING";
type PendingRequest = { path: string; body: Record<string, unknown> };
type SyncContext = {
  batches: OrderSyncBatchView[];
  submitting: boolean;
  connectionError: string | null;
  submissionError: string | null;
  lastCheckedAt: string | null;
  submit: (path: string, body: Record<string, unknown>) => Promise<void>;
  retrySubmission: () => Promise<void>;
  pending: boolean;
};
const Context = createContext<SyncContext | null>(null);
const pendingStorageKey = "order-sync-pending-request-v1";
const batchWakeStorageKey = "order-sync-batch-wake-v1";

async function readBatchResponse(response: Response) {
  return validateOrderSyncBatch(await readOrderSyncResponse(response));
}

function BatchUrlWatcher({
  onSelect,
}: {
  onSelect: (id: string | null) => void;
}) {
  const selectedId = useSearchParams().get("batchId");
  useEffect(() => onSelect(selectedId), [selectedId, onSelect]);
  return null;
}

export function OrderSyncProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [batches, setBatches] = useState<OrderSyncBatchView[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRequest = useRef<PendingRequest | null>(null);
  const busy = useRef(false);
  const known = useRef(new Map<string, OrderSyncBatchView>());
  const watched = useRef(new Set<string>());
  const selectedBatch = useRef<string | null>(null);
  const mounted = useRef(true);
  const submitController = useRef<AbortController | null>(null);
  const wakePoll = useRef<((refreshHistory?: boolean) => void) | null>(null);

  const selectBatch = useCallback((selectedBatchId: string | null) => {
    selectedBatch.current = selectedBatchId;
    if (selectedBatchId) {
      watched.current.add(selectedBatchId);
      wakePoll.current?.();
    }
  }, []);

  const acceptBatch = useCallback(
    (batch: OrderSyncBatchView) => {
      const previous = known.current.get(batch.batchId);
      // A concurrent poll may finish after a newer submission response.
      if (previous && previous.updatedAt > batch.updatedAt) return;
      known.current.set(batch.batchId, batch);
      watched.current.add(batch.batchId);
      if (previous && isActiveBatch(previous) && !isActiveBatch(batch))
        router.refresh();
      const ordered = Array.from(known.current.values()).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      let recentTerminalCount = 0;
      for (const item of ordered) {
        if (isActiveBatch(item) || item.batchId === selectedBatch.current)
          continue;
        if (++recentTerminalCount <= 10) continue;
        known.current.delete(item.batchId);
        watched.current.delete(item.batchId);
      }
      setBatches(ordered.filter((item) => known.current.has(item.batchId)));
    },
    [router],
  );

  const send = useCallback(
    async (request: PendingRequest) => {
      if (busy.current) return;
      busy.current = true;
      setSubmitting(true);
      setSubmissionError(null);
      pendingRequest.current = request;
      setPending(true);
      try {
        sessionStorage.setItem(pendingStorageKey, JSON.stringify(request));
      } catch {
        /* Storage is optional; server owns the batch. */
      }
      try {
        // Reuse the exact key after transport loss; a second POST cannot create a second batch.
        let result: OrderSyncBatchView | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const controller = new AbortController();
          submitController.current = controller;
          const timeout = setTimeout(() => controller.abort(), 30_000);
          try {
            const response = await fetch(request.path, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(request.body),
              signal: controller.signal,
            });
            if (response.status >= 400 && response.status < 500) {
              pendingRequest.current = null;
              setPending(false);
              try {
                sessionStorage.removeItem(pendingStorageKey);
              } catch {
                /* optional */
              }
            }
            result = await readBatchResponse(response);
            break;
          } catch (error) {
            if (!mounted.current || !pendingRequest.current || attempt === 1)
              throw error;
          } finally {
            clearTimeout(timeout);
          }
        }
        if (result && mounted.current) {
          acceptBatch(result);
          // Retrying can return the same URL, so do not rely on the URL watcher.
          wakePoll.current?.();
          try {
            localStorage.setItem(
              batchWakeStorageKey,
              JSON.stringify({
                batchId: result.batchId,
                nonce: crypto.randomUUID(),
              }),
            );
          } catch {
            /* Other tabs can still recover on focus or reconnect. */
          }
          const url = new URL(window.location.href);
          url.searchParams.set("batchId", result.batchId);
          window.history.replaceState(null, "", url);
          pendingRequest.current = null;
          setPending(false);
          try {
            sessionStorage.removeItem(pendingStorageKey);
          } catch {
            /* optional */
          }
        }
      } catch (error) {
        if (mounted.current) {
          // The server may have accepted a request whose POST response was lost.
          if (pendingRequest.current) wakePoll.current?.(true);
          setSubmissionError(
            pendingRequest.current
              ? "접수 여부 확인 중입니다. 같은 요청으로 다시 확인해 주세요."
              : error instanceof Error
                ? error.message
                : "요청을 접수할 수 없습니다.",
          );
        }
      } finally {
        busy.current = false;
        if (mounted.current) setSubmitting(false);
      }
    },
    [acceptBatch],
  );

  const submit = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      if (pendingRequest.current) return send(pendingRequest.current);
      await send({
        path,
        body: { ...body, idempotencyKey: crypto.randomUUID() },
      });
    },
    [send],
  );

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let inFlight = false;
    let wakeRequested = false;
    let historyRequested = false;
    const refreshRequested = new Set<string>();
    let failures = 0;
    let initial = true;
    const requestedId = new URL(window.location.href).searchParams.get(
      "batchId",
    );
    if (requestedId) watched.current.add(requestedId);
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(pendingStorageKey) ?? "null",
      ) as PendingRequest | null;
      if (
        saved &&
        typeof saved.path === "string" &&
        /^\/api\/(stores\/[^/]+\/order-sync|stores\/order-sync-all|order-sync-batches\/[^/]+\/(?:retry-failed|retry-summary|acknowledge-coverage-gap))$/.test(
          saved.path,
        ) &&
        typeof saved.body?.idempotencyKey === "string"
      ) {
        pendingRequest.current = saved;
        setPending(true);
        setSubmissionError("이전 요청의 접수 여부를 확인해 주세요.");
      }
    } catch {
      /* The active batch is still recovered from the server. */
    }
    const poll = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      wakeRequested = false;
      const fetchRecent = initial || historyRequested;
      historyRequested = false;
      const requestController = new AbortController();
      controller = requestController;
      const timeout = setTimeout(() => requestController.abort(), 30_000);
      const refreshedIds = new Set<string>();
      try {
        const list = await readOrderSyncResponse(
          await fetch(
            `/api/order-sync-batches?${fetchRecent ? "pageSize=10" : "active=true&pageSize=50"}`,
            { cache: "no-store", signal: controller.signal },
          ),
        );
        if (
          !list ||
          typeof list !== "object" ||
          !("items" in list) ||
          !Array.isArray(list.items)
        )
          throw new Error("잘못된 상태 응답");
        const received = new Map(
          list.items
            .map(validateOrderSyncBatch)
            .map((batch) => [batch.batchId, batch]),
        );
        // Discover every active batch, including jobs submitted from another tab.
        for (let page = fetchRecent ? 1 : 2; ; page++) {
          if (!fetchRecent && page === 2 && list.items.length < 50) break;
          const active = await readOrderSyncResponse(
            await fetch(
              `/api/order-sync-batches?active=true&pageSize=50&page=${page}`,
              { cache: "no-store", signal: controller.signal },
            ),
          );
          if (
            !active ||
            typeof active !== "object" ||
            !("items" in active) ||
            !Array.isArray(active.items)
          )
            throw new Error("잘못된 상태 응답");
          const items = active.items.map(validateOrderSyncBatch);
          for (const batch of items) received.set(batch.batchId, batch);
          if (items.length < 50) break;
          if (page >= 100)
            throw new Error("활성 작업 조회 범위를 초과했습니다.");
        }
        for (const id of watched.current) {
          if (
            refreshRequested.has(id) ||
            (!received.has(id) &&
              (!known.current.has(id) || isActiveBatch(known.current.get(id)!)))
          ) {
            refreshRequested.delete(id);
            refreshedIds.add(id);
            received.set(
              id,
              await readBatchResponse(
                await fetch(
                  `/api/order-sync-batches/${encodeURIComponent(id)}`,
                  { cache: "no-store", signal: controller.signal },
                ),
              ),
            );
          }
        }
        if (!stopped) {
          received.forEach(acceptBatch);
          setConnectionError(null);
          setLastCheckedAt(new Date().toISOString());
          failures = 0;
          initial = false;
        }
      } catch {
        if (!stopped) {
          failures++;
          if (fetchRecent) historyRequested = true;
          for (const id of refreshedIds) refreshRequested.add(id);
          setConnectionError("연결이 끊겨 상태를 확인할 수 없습니다.");
        }
      } finally {
        clearTimeout(timeout);
        inFlight = false;
        const hasActive = Array.from(known.current.values()).some(
          isActiveBatch,
        );
        if (!stopped && (wakeRequested || failures > 0 || hasActive))
          timer = setTimeout(
            poll,
            wakeRequested
              ? 0
              : document.hidden
                ? 15_000
                : Math.min(30_000, 2500 * 2 ** failures),
          );
      }
    };
    const wake = (refreshHistory = false) => {
      if (stopped) return;
      if (refreshHistory) historyRequested = true;
      clearTimeout(timer);
      timer = undefined;
      if (inFlight) wakeRequested = true;
      else void poll();
    };
    const resume = () => {
      if (!document.hidden) wake();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== batchWakeStorageKey || !event.newValue) return;
      try {
        const value: unknown = JSON.parse(event.newValue);
        if (
          !value ||
          typeof value !== "object" ||
          !("batchId" in value) ||
          typeof value.batchId !== "string"
        )
          return;
        watched.current.add(value.batchId);
        refreshRequested.add(value.batchId);
        wake();
      } catch {
        /* Ignore unrelated or malformed storage values. */
      }
    };
    wakePoll.current = wake;
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("storage", onStorage);
    void poll();
    return () => {
      stopped = true;
      wakePoll.current = null;
      mounted.current = false;
      clearTimeout(timer);
      controller?.abort();
      submitController.current?.abort();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("storage", onStorage);
    };
  }, [acceptBatch]);

  return (
    <Context.Provider
      value={{
        batches,
        submitting,
        connectionError,
        submissionError,
        lastCheckedAt,
        submit,
        pending,
        retrySubmission: async () => {
          if (pendingRequest.current) await send(pendingRequest.current);
        },
      }}
    >
      <Suspense fallback={null}>
        <BatchUrlWatcher onSelect={selectBatch} />
      </Suspense>
      {children}
    </Context.Provider>
  );
}

export function useOrderSync() {
  const context = useContext(Context);
  if (!context) throw new Error("OrderSyncProvider is required");
  return context;
}

export function OrderSyncIndicator() {
  const { batches, connectionError, pending } = useOrderSync();
  const active = batches.filter(isActiveBatch);
  if (!active.length && !pending && !connectionError) return null;
  return (
    <div className="px-6 py-2 text-sm text-ink/70">
      <Link
        href={
          active[0]
            ? `/orders?batchId=${encodeURIComponent(active[0].batchId)}`
            : "/orders"
        }
      >
        {connectionError
          ? "주문 동기화 상태 확인 불가"
          : pending
            ? "주문 동기화 접수 여부 확인 중"
            : `주문 동기화 ${active.length}건 진행 중`}{" "}
        · 상세 보기 →
      </Link>
    </div>
  );
}
