import { NextResponse } from "next/server";
import {
  buildUpstreamEndpoint,
  extractUpstreamMessage,
  readUpstreamPayload,
} from "@/lib/api/upstream";

export const ORDER_SYNC_PROXY_TIMEOUT_MS = 25_000;

export async function proxyRequest(params: {
  path: string;
  method: "GET" | "POST" | "PATCH" | "PUT";
  fallbackMessage: string;
  body?: BodyInit | null;
  headers?: HeadersInit;
  timeoutMs?: number;
}) {
  // Synchronous writes may include recalculation; deadlines are opt-in for queued jobs/status.
  const controller =
    params.timeoutMs === undefined ? undefined : new AbortController();
  const timeout = controller
    ? setTimeout(() => controller.abort(), params.timeoutMs)
    : undefined;
  try {
    const response = await fetch(buildUpstreamEndpoint(params.path), {
      signal: controller?.signal,
      method: params.method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...params.headers,
      },
      body: params.body,
    });

    const payload = await readUpstreamPayload(response);
    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message: extractUpstreamMessage(payload, params.fallbackMessage),
        },
        { status: response.status },
      );
    }

    return NextResponse.json(payload, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        success: false,
        message: controller?.signal.aborted
          ? "서버 응답 시간이 초과되었습니다. 접수 여부를 다시 확인해 주세요."
          : "서버에 연결할 수 없습니다. 잠시 후 다시 확인해 주세요.",
      },
      {
        status: controller?.signal.aborted ? 504 : 502,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}
