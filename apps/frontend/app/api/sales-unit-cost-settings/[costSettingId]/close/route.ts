import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  request: Request,
  context: { params: Promise<{ costSettingId: string }> },
) {
  const { costSettingId } = await context.params;
  return proxyRequest({
    path: `/sales-unit-cost-settings/${costSettingId}/close`,
    method: "POST",
    fallbackMessage: "비용 row 종료에 실패했습니다.",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(await request.json()),
  });
}
