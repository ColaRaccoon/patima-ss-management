import { proxyRequest } from "@/app/api/_utils/proxy";
import { withUpstreamQuery } from "@/lib/api/route-proxy";

export async function GET(request: Request) {
  return proxyRequest({
    path: withUpstreamQuery("/product-registrations/order-context", new URL(request.url).searchParams),
    method: "GET",
    fallbackMessage: "선택한 주문을 불러오지 못했습니다.",
  });
}
