import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(request: Request) {
  return proxyRequest({
    path: "/product-registrations",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
    fallbackMessage: "신상품 등록에 실패했습니다.",
  });
}
