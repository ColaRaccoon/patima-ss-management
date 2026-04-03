import { proxyRequest } from "@/app/api/_utils/proxy";

export async function GET(
  _request: Request,
  context: { params: Promise<{ operationId: string }> },
) {
  const { operationId } = await context.params;
  return proxyRequest({
    path: `/operations/${operationId}`,
    method: "GET",
    fallbackMessage: "작업 상세 조회에 실패했습니다.",
  });
}
