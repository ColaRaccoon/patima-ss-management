import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  _request: Request,
  context: { params: Promise<{ operationId: string }> },
) {
  const { operationId } = await context.params;
  return proxyRequest({
    path: `/operations/${operationId}/retry`,
    method: "POST",
    fallbackMessage: "작업 재시도 요청에 실패했습니다.",
  });
}
