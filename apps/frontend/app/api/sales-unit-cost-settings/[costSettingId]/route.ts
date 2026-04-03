import { proxyRequest } from "@/app/api/_utils/proxy";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ costSettingId: string }> },
) {
  const { costSettingId } = await context.params;
  return proxyRequest({
    path: `/sales-unit-cost-settings/${costSettingId}`,
    method: "PATCH",
    fallbackMessage: "비용 row 수정에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await request.json()),
  });
}
