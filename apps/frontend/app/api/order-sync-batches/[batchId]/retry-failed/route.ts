import {
  proxyRequest,
  ORDER_SYNC_PROXY_TIMEOUT_MS,
} from "@/app/api/_utils/proxy";

export async function POST(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await context.params;
  return proxyRequest({
    timeoutMs: ORDER_SYNC_PROXY_TIMEOUT_MS,
    path: `/order-sync-batches/${encodeURIComponent(batchId)}/retry-failed`,
    method: "POST",
    fallbackMessage: "실패 스토어 재시도를 접수할 수 없습니다.",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await request.json().catch(() => ({}))),
  });
}
