import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await context.params;
  return proxyRequest({
    path: `/order-sync-batches/${encodeURIComponent(batchId)}/acknowledge-coverage-gap`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await request.json().catch(() => ({}))),
    fallbackMessage: "변경 수집 기준선을 재설정하지 못했습니다.",
  });
}
