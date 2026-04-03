import { proxyRequest } from "@/app/api/_utils/proxy";

export async function GET(
  _request: Request,
  context: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await context.params;
  return proxyRequest({
    path: `/stores/${storeId}/commerce-credentials`,
    method: "GET",
    fallbackMessage: "인증 정보 조회에 실패했습니다.",
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await context.params;
  return proxyRequest({
    path: `/stores/${storeId}/commerce-credentials`,
    method: "POST",
    fallbackMessage: "인증 정보 저장에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await request.json()),
  });
}
