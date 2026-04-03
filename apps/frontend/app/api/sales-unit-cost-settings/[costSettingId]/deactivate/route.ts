import { proxyRequest } from "@/app/api/_utils/proxy";

export async function POST(
  _request: Request,
  context: { params: Promise<{ costSettingId: string }> },
) {
  const { costSettingId } = await context.params;
  return proxyRequest({
    path: `/sales-unit-cost-settings/${costSettingId}/deactivate`,
    method: "POST",
    fallbackMessage: "비용 row 비활성화에 실패했습니다.",
  });
}
