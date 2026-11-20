import { proxyRequest } from "@/app/api/_utils/proxy";
import { withUpstreamQuery } from "@/lib/api/route-proxy";

export async function GET(request: Request, { params }: { params: Promise<{ salesUnitId: string }> }) {
  const { salesUnitId } = await params;
  return proxyRequest({
    path: withUpstreamQuery(
      "/product-registrations/" + encodeURIComponent(salesUnitId) + "/status",
      new URL(request.url).searchParams,
    ),
    method: "GET",
    fallbackMessage: "상품 상태를 조회하지 못했습니다.",
  });
}
