import { NextResponse } from "next/server";
import { proxyUpstream } from "@/lib/api/route-proxy";

export async function POST(request: Request) {
  const body = await request.formData().catch(() => null);
  const file = body?.get("file");
  if (!body || !(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { success: false, message: "업로드할 .xlsx 파일을 선택해 주세요." },
      { status: 400 },
    );
  }

  return proxyUpstream({
    path: "/sales-unit-cost-snapshots/preview",
    method: "POST",
    body,
    fallbackMessage: "비용 표를 확인하지 못했습니다.",
  });
}
