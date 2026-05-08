import { NextResponse } from "next/server";
import {
  buildUpstreamEndpoint,
  extractUpstreamMessage,
  readUpstreamPayload,
} from "@/lib/api/upstream";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId");
  const page = searchParams.get("page") || "1";
  const pageSize = searchParams.get("pageSize") || "50";

  if (!storeId) {
    return NextResponse.json({ success: false, message: "storeId이 필요합니다." }, { status: 400 });
  }

  const query = new URLSearchParams({
    storeId,
    page,
    pageSize,
  });

  const response = await fetch(buildUpstreamEndpoint(`/sales-unit-cost-snapshots?${query.toString()}`), {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  });

  const payload = await readUpstreamPayload(response);
  if (!response.ok) {
    return NextResponse.json(
      {
        success: false,
        message: extractUpstreamMessage(payload, "스냅샷 목록 조회에 실패했습니다."),
      },
      { status: response.status },
    );
  }

  return NextResponse.json(payload);
}
