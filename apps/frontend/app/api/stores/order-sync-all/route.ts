import {
  proxyRequest,
  ORDER_SYNC_PROXY_TIMEOUT_MS,
} from "@/app/api/_utils/proxy";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  return proxyRequest({
    timeoutMs: ORDER_SYNC_PROXY_TIMEOUT_MS,
    path: "/stores/order-sync-all",
    method: "POST",
    fallbackMessage: "전체 스토어 주문 동기화 시작에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
