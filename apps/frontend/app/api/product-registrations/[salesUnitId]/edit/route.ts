import { proxyRequest } from "@/app/api/_utils/proxy";
import { withUpstreamQuery } from "@/lib/api/route-proxy";

type RouteContext = { params: Promise<{ salesUnitId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const { salesUnitId } = await params;
  return proxyRequest({
    path: withUpstreamQuery("/product-registrations/" + encodeURIComponent(salesUnitId) + "/edit", new URL(request.url).searchParams),
    method: "GET",
    fallbackMessage: "저장된 판매단위 정보를 불러오지 못했습니다.",
  });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { salesUnitId } = await params;
  return proxyRequest({
    path: "/product-registrations/" + encodeURIComponent(salesUnitId) + "/edit",
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
    fallbackMessage: "판매단위를 수정하지 못했습니다.",
  });
}
