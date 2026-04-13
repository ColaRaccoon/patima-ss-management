import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(request: Request) {
  return proxyRequest({
    path: "/ad-campaign-costs/batch-intentional-unmapped",
    method: "POST",
    fallbackMessage: "광고 row 일괄 제외 처리에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await request.json()),
  });
}
