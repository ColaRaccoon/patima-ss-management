import { NextResponse } from "next/server";
import {
  buildUpstreamEndpoint,
  extractUpstreamMessage,
  readUpstreamPayload,
} from "@/lib/api/upstream";

export async function POST(request: Request) {
  const incoming = await request.formData();
  const storeId = incoming.get("storeId");
  const reportDate = incoming.get("reportDate");
  const file = incoming.get("file");

  if (typeof storeId !== "string" || !storeId.trim()) {
    return NextResponse.json({ success: false, message: "storeId가 필요합니다." }, { status: 400 });
  }

  if (typeof reportDate !== "string" || !reportDate.trim()) {
    return NextResponse.json({ success: false, message: "reportDate가 필요합니다." }, { status: 400 });
  }

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { success: false, message: "업로드할 .xlsx 파일을 선택해주세요." },
      { status: 400 },
    );
  }

  const formData = new FormData();
  formData.append("storeId", storeId);
  formData.append("reportDate", reportDate);
  formData.append("file", file);

  const response = await fetch(buildUpstreamEndpoint("/ad-uploads/preview"), {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
    body: formData,
  });

  const payload = await readUpstreamPayload(response);
  if (!response.ok) {
    return NextResponse.json(
      {
        success: false,
        message: extractUpstreamMessage(payload, "광고 엑셀 preview 생성에 실패했습니다."),
      },
      { status: response.status },
    );
  }

  return NextResponse.json(payload);
}
