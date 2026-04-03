import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  return proxyRequest({
    path: `/stores/${storeId}/order-sync`,
    method: "POST",
    fallbackMessage: "주문 동기화 시작에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
