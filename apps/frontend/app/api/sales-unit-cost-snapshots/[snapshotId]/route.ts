import { NextResponse } from "next/server";
import {
  buildUpstreamEndpoint,
  extractUpstreamMessage,
  readUpstreamPayload,
} from "@/lib/api/upstream";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const { snapshotId } = await context.params;

  if (!snapshotId) {
    return NextResponse.json({ success: false, message: "snapshotId이 필요합니다." }, { status: 400 });
  }

  const response = await fetch(buildUpstreamEndpoint(`/sales-unit-cost-snapshots/${snapshotId}`), {
    method: "DELETE",
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
        message: extractUpstreamMessage(payload, "스냅샷 삭제에 실패했습니다."),
      },
      { status: response.status },
    );
  }

  return NextResponse.json(payload);
}
