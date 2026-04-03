import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(request: Request) {
  return proxyRequest({
    path: "/campaign-mappings",
    method: "POST",
    fallbackMessage: "캠페인 매핑 규칙 생성에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await request.json()),
  });
}
