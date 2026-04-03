import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  _request: Request,
  context: { params: Promise<{ mappingId: string }> },
) {
  const { mappingId } = await context.params;
  return proxyRequest({
    path: `/campaign-mappings/${mappingId}/activate`,
    method: "POST",
    fallbackMessage: "캠페인 매핑 규칙 활성화에 실패했습니다.",
  });
}
