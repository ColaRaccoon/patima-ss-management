import { NextResponse } from "next/server";
import {
  buildUpstreamEndpoint,
  extractUpstreamMessage,
  readUpstreamPayload,
} from "@/lib/api/upstream";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ salesUnitId: string }> },
) {
  const { salesUnitId } = await context.params;
  const body = (await request.json()) as Record<string, unknown>;

  const response = await fetch(buildUpstreamEndpoint(`/canonical-sales-units/${salesUnitId}`), {
    method: "PATCH",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await readUpstreamPayload(response);
  if (!response.ok) {
    return NextResponse.json(
      {
        success: false,
        message: extractUpstreamMessage(payload, "표준 판매단위 수정에 실패했습니다."),
      },
      { status: response.status },
    );
  }

  return NextResponse.json(payload);
}
