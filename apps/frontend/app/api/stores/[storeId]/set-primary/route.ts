import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  _request: Request,
  context: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await context.params;
  return proxyRequest({
    path: `/stores/${storeId}/set-primary`,
    method: "POST",
    fallbackMessage: "대표 스토어 지정에 실패했습니다.",
  });
}
