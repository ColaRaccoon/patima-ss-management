import { proxyRequest } from "@/app/api/_utils/proxy";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
) {
  const { storeId } = await context.params;
  return proxyRequest({
    path: `/stores/${storeId}`,
    method: "PATCH",
    fallbackMessage: "스토어 정보 저장에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await request.json()),
  });
}
