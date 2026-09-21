import {
  proxyRequest,
  ORDER_SYNC_PROXY_TIMEOUT_MS,
} from "@/app/api/_utils/proxy";

export async function GET(
  _request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await context.params;
  return proxyRequest({
    timeoutMs: ORDER_SYNC_PROXY_TIMEOUT_MS,
    path: `/order-sync-batches/${encodeURIComponent(batchId)}`,
    method: "GET",
    fallbackMessage: "동기화 상태를 조회할 수 없습니다.",
  });
}
