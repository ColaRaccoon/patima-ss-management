import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  request: Request,
  context: { params: Promise<{ signatureId: string }> },
) {
  const { signatureId } = await context.params;
  return proxyRequest({
    path: `/order-source-signatures/${signatureId}/mapping`,
    method: "POST",
    fallbackMessage: "주문 매핑 저장에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await request.json()),
  });
}
