import {
  proxyRequest,
  ORDER_SYNC_PROXY_TIMEOUT_MS,
} from "@/app/api/_utils/proxy";

export async function GET(request: Request) {
  return proxyRequest({
    timeoutMs: ORDER_SYNC_PROXY_TIMEOUT_MS,
    path: `/order-sync-batches${new URL(request.url).search}`,
    method: "GET",
    fallbackMessage: "동기화 이력을 조회할 수 없습니다.",
  });
}
