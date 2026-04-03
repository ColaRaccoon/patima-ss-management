import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  _request: Request,
  context: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await context.params;
  return proxyRequest({
    path: `/stores/${storeId}/deactivate`,
    method: "POST",
    fallbackMessage: "스토어 비활성화에 실패했습니다.",
  });
}
