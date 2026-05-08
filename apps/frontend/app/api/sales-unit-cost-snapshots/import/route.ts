import { NextResponse } from "next/server";
import {
  buildUpstreamEndpoint,
  extractUpstreamMessage,
  readUpstreamPayload,
} from "@/lib/api/upstream";

export async function POST(request: Request) {
  const incoming = await request.formData();
  const storeId = incoming.get("storeId");
  const effectiveFrom = incoming.get("effectiveFrom");
  const file = incoming.get("file");

  if (typeof storeId !== "string" || !storeId.trim()) {
    return NextResponse.json({ success: false, message: "storeId가 필요합니다." }, { status: 400 });
  }

  if (typeof effectiveFrom !== "string" || !effectiveFrom.trim()) {
    return NextResponse.json({ success: false, message: "effectiveFrom이 필요합니다." }, { status: 400 });
  }

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { success: false, message: "업로드할 .xlsx 파일을 선택해주세요." },
      { status: 400 },
    );
  }

  const formData = new FormData();
  formData.append("storeId", storeId);
  formData.append("effectiveFrom", effectiveFrom);
  formData.append("file", file);

  const response = await fetch(buildUpstreamEndpoint("/sales-unit-cost-snapshots/import"), {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
    body: formData,
  });

  const payload = await readUpstreamPayload(response);
  if (!response.ok) {
    const isObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null;

    if (isObject(payload)) {
      return NextResponse.json(
        {
          success: false,
          message:
            typeof payload.message === "string"
              ? payload.message
              : "비용 표 import에 실패했습니다.",
          ...(typeof payload.fileName === "string" && { fileName: payload.fileName }),
          ...(Array.isArray(payload.errors) && { errors: payload.errors }),
        },
        { status: response.status },
      );
    }

    return NextResponse.json(
      { success: false, message: "비용 표 import에 실패했습니다." },
      { status: response.status },
    );
  }

  return NextResponse.json(payload);
}
