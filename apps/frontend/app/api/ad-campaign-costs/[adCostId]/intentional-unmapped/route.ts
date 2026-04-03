import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  request: Request,
  context: { params: Promise<{ adCostId: string }> },
) {
  const { adCostId } = await context.params;
  return proxyRequest({
    path: `/ad-campaign-costs/${adCostId}/intentional-unmapped`,
    method: "POST",
    fallbackMessage: "광고 제외 처리에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await request.json()),
  });
}
