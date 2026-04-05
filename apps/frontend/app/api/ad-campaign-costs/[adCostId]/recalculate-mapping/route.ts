import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  _request: Request,
  context: { params: Promise<{ adCostId: string }> },
) {
  const { adCostId } = await context.params;
  return proxyRequest({
    path: `/ad-campaign-costs/${adCostId}/recalculate-mapping`,
    method: "POST",
    fallbackMessage: "광고 row 자동 재계산에 실패했습니다.",
  });
}
