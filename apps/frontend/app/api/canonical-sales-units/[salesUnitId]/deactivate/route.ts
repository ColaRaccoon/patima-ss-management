import { NextResponse } from "next/server";
import {
  buildUpstreamEndpoint,
  extractUpstreamMessage,
  readUpstreamPayload,
} from "@/lib/api/upstream";

export async function POST(
  _request: Request,
  context: { params: Promise<{ salesUnitId: string }> },
) {
  const { salesUnitId } = await context.params;

  const response = await fetch(buildUpstreamEndpoint(`/canonical-sales-units/${salesUnitId}/deactivate`), {
    method: "POST",
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
        message: extractUpstreamMessage(payload, "표준 판매단위 비활성화에 실패했습니다."),
      },
      { status: response.status },
    );
  }

  return NextResponse.json(payload);
}
