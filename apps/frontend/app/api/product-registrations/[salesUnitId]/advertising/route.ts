import { proxyRequest } from "@/app/api/_utils/proxy";

export async function PUT(request: Request, { params }: { params: Promise<{ salesUnitId: string }> }) {
  const { salesUnitId } = await params;
  return proxyRequest({
    path: "/product-registrations/" + encodeURIComponent(salesUnitId) + "/advertising",
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
    fallbackMessage: "광고 상태를 저장하지 못했습니다.",
  });
}
