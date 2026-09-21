import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  _request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await context.params;
  return proxyRequest({
    path: `/order-sync-batches/${encodeURIComponent(batchId)}/retry-summary`,
    method: "POST",
    fallbackMessage: "집계 갱신을 완료하지 못했습니다.",
  });
}
