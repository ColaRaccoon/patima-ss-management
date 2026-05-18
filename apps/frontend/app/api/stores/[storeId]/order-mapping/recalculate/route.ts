import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  _request: Request,
  context: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await context.params;

  return proxyRequest({
    path: `/stores/${storeId}/order-mapping/recalculate`,
    method: "POST",
    fallbackMessage: "주문 자동 매핑 재계산을 시작하지 못했습니다.",
  });
}
