import { NextResponse } from "next/server";
import {
  buildUpstreamEndpoint,
  readUpstreamPayload,
} from "@/lib/api/upstream";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
  const isManual = incoming.has("storeId") || incoming.has("reportDate");

  if (isManual && (typeof storeId !== "string" || !storeId.trim())) {
    return NextResponse.json({ success: false, message: "직접 지정 업로드에는 스토어와 보고일이 모두 필요합니다." }, { status: 400 });
  }
  if (isManual && (typeof reportDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate) ||
    !Number.isFinite(Date.parse(`${reportDate}T00:00:00Z`)) ||
    new Date(`${reportDate}T00:00:00Z`).toISOString().slice(0, 10) !== reportDate)) {
    return NextResponse.json({ success: false, message: "올바른 보고일을 선택해 주세요." }, { status: 400 });
  }
  const maxFiles = isManual ? 10 : 100;
  if (files.length === 0 || files.length > maxFiles || files.some((file) => !(file instanceof File))) {
    return NextResponse.json({ success: false, message: `한 요청에 파일을 1개에서 ${maxFiles}개까지 첨부해 주세요.` }, { status: 400 });
  }
  if (files.some((file) => (file as File).size > MAX_FILE_BYTES || (!isManual && (file as File).size === 0))) {
    return NextResponse.json({ success: false, message: "파일당 10MB 이하의 비어 있지 않은 엑셀 파일을 선택해 주세요." }, { status: 400 });
  }

  const formData = new FormData();
  if (isManual) {
    formData.append("storeId", (storeId as string).trim());
    formData.append("reportDate", reportDate as string);
  }
  // Manual mode keeps per-file validation on the backend so a bad file does
  // not reject the other files. Auto mode is committed as one atomic batch.
  for (const file of files) formData.append("files", file);

  try {
    const response = await fetch(buildUpstreamEndpoint("/ad-uploads/batch"), {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json" },
      body: formData,
    });
    const payload = await readUpstreamPayload(response);
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json({
      success: false,
      message: "일괄 업로드 응답을 확인하지 못했습니다. 업로드 이력을 확인한 후 다시 시도해 주세요.",
    }, { status: 502 });
  }
}
