import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  _request: Request,
  context: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await context.params;
  return proxyRequest({
    path: `/stores/${storeId}/commerce-credentials/test`,
    method: "POST",
    fallbackMessage: "인증 연결 테스트에 실패했습니다.",
  });
}
