import { proxyRequest } from "@/app/api/_utils/proxy";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ mappingId: string }> },
) {
  const { mappingId } = await context.params;
  return proxyRequest({
    path: `/campaign-mappings/${mappingId}`,
    method: "PATCH",
    fallbackMessage: "캠페인 매핑 규칙 수정에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await request.json()),
  });
}
