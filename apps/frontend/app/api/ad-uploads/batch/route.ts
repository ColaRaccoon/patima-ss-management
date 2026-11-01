import { NextResponse } from "next/server";
import { buildUpstreamEndpoint, readUpstreamPayload } from "@/lib/api/upstream";

export async function POST(request: Request) {
  const incoming = await request.formData();
  const files = incoming.getAll("files");
  if (!files.length || files.length > 100 || files.some((file) => !(file instanceof File) || !file.size || file.size > 10 * 1024 * 1024)) {
    return NextResponse.json({ success: false, message: "파일당 10MB 이하의 엑셀 파일을 1~100개 선택하세요." }, { status: 400 });
  }
  const formData = new FormData();
  for (const file of files) formData.append("files", file);
  const response = await fetch(buildUpstreamEndpoint("/ad-uploads/batch"), {
    method: "POST", cache: "no-store", body: formData,
  });
  const payload = await readUpstreamPayload(response);
  return NextResponse.json(payload, { status: response.status });
}
