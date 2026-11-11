import { NextResponse } from "next/server";
import {
  buildUpstreamEndpoint,
  extractUpstreamMessage,
  readUpstreamPayload,
} from "@/lib/api/upstream";

export async function POST(request: Request) {
  let incoming: FormData;
  try {
    incoming = await request.formData();
  } catch {
    return NextResponse.json({ success: false, message: "업로드 요청 형식이 올바르지 않습니다." }, { status: 400 });
  }
  const storeId = incoming.get("storeId");
  const reportDate = incoming.get("reportDate");
  const files = incoming.getAll("files");

  if (typeof storeId !== "string" || !storeId.trim()) {
    return NextResponse.json({ success: false, message: "스토어를 선택해 주세요." }, { status: 400 });
  }
  if (typeof reportDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate) ||
    !Number.isFinite(Date.parse(`${reportDate}T00:00:00Z`)) ||
    new Date(`${reportDate}T00:00:00Z`).toISOString().slice(0, 10) !== reportDate) {
    return NextResponse.json({ success: false, message: "올바른 보고일을 선택해 주세요." }, { status: 400 });
  }
  if (files.length === 0 || files.length > 10 || files.some((file) => !(file instanceof File))) {
    return NextResponse.json({ success: false, message: "한 요청에 파일을 1개에서 10개까지 첨부해 주세요." }, { status: 400 });
  }

  const formData = new FormData();
  formData.append("storeId", storeId.trim());
  formData.append("reportDate", reportDate);
  // Content validation belongs to the backend so one invalid file does not
  // reject the other files in this batch.
  for (const file of files) formData.append("files", file);

  try {
    const response = await fetch(buildUpstreamEndpoint("/ad-uploads/batch"), {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json" },
      body: formData,
    });
    const payload = await readUpstreamPayload(response);
    if (!response.ok) {
      return NextResponse.json({
        success: false,
        message: extractUpstreamMessage(payload, "광고 파일 업로드에 실패했습니다."),
      }, { status: response.status });
    }
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({
      success: false,
      message: "일괄 업로드 응답을 확인하지 못했습니다. 업로드 이력을 확인한 후 다시 시도해 주세요.",
    }, { status: 502 });
  }
}
