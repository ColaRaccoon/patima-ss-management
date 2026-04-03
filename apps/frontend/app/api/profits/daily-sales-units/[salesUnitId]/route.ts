import { proxyRequest } from "@/app/api/_utils/proxy";

export async function GET(
  request: Request,
  context: { params: Promise<{ salesUnitId: string }> },
) {
  const { salesUnitId } = await context.params;
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId");
  const date = searchParams.get("date");

  const query = new URLSearchParams();
  if (storeId) {
    query.set("storeId", storeId);
  }
  if (date) {
    query.set("date", date);
  }

  return proxyRequest({
    path: `/profits/daily-sales-units/${salesUnitId}?${query.toString()}`,
    method: "GET",
    fallbackMessage: "손익 상세 조회에 실패했습니다.",
  });
}
