import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(request: Request) {
  return proxyRequest({
    path: "/ad-campaign-costs/batch-recalculate-mapping",
    method: "POST",
    fallbackMessage: "광고 row 일괄 자동 재계산에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await request.json()),
  });
}
