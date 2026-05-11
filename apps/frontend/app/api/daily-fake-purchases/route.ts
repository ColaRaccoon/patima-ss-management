import { proxyRequest } from "@/app/api/_utils/proxy";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = new URLSearchParams();
  const storeId = searchParams.get("storeId");
  const date = searchParams.get("date");

  if (storeId) {
    query.set("storeId", storeId);
  }
  if (date) {
    query.set("date", date);
  }

  return proxyRequest({
    path: `/daily-fake-purchases?${query.toString()}`,
    method: "GET",
    fallbackMessage: "가구매 금액 조회에 실패했습니다.",
  });
}

export async function PUT(request: Request) {
  return proxyRequest({
    path: "/daily-fake-purchases",
    method: "PUT",
    fallbackMessage: "가구매 금액 저장에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await request.json()),
  });
}
