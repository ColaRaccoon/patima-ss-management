import { cache } from "react";
import type { ApiEnvelope } from "@/lib/api/types";
import {
  buildUpstreamEndpoint,
  extractUpstreamMessage,
  readUpstreamPayload,
} from "@/lib/api/upstream";

function positiveMilliseconds(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed) || fallback
    : fallback;
}
const API_FETCH_ATTEMPT_TIMEOUT_MS = positiveMilliseconds(
  process.env.API_FETCH_ATTEMPT_TIMEOUT_MS,
  2500,
);
const API_FETCH_RETRY_WINDOW_MS = positiveMilliseconds(
  process.env.API_FETCH_RETRY_WINDOW_MS,
  30000,
);
const API_FETCH_RETRY_DELAY_MS = positiveMilliseconds(
  process.env.API_FETCH_RETRY_DELAY_MS,
  500,
);

function extractData<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "success" in payload) {
    const success = Reflect.get(payload, "success");
    if (success === false) {
      const message = Reflect.get(payload, "message");
      throw new Error(typeof message === "string" ? message : "API 요청 실패");
    }

    if (!("data" in payload)) throw new Error("API 응답에 데이터가 없습니다.");
    return Reflect.get(payload, "data") as T;
  }

  return payload as T;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "알 수 없는 네트워크 오류";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableNetworkError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "TypeError" || error.message === "fetch failed";
}

// React cache lasts for one server render, including layout + page. An explicit
// AbortSignal disables Next's automatic fetch deduplication, so memoize here.
const fetchEndpoint = cache(async (endpoint: string): Promise<unknown> => {
  const retryUntil = Date.now() + API_FETCH_RETRY_WINDOW_MS;
  for (;;) {
    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(API_FETCH_ATTEMPT_TIMEOUT_MS),
      });

      if (!response.ok) {
        const message = extractUpstreamMessage(
          await readUpstreamPayload(response),
          "API 요청 실패",
        );
        throw new Error(`${message} (HTTP ${response.status})`);
      }

      const payload = await response.json();
      return extractData<unknown>(payload);
    } catch (error) {
      if (!isRetryableNetworkError(error) || Date.now() >= retryUntil) {
        throw error;
      }

      await sleep(
        Math.min(
          API_FETCH_RETRY_DELAY_MS,
          Math.max(0, retryUntil - Date.now()),
        ),
      );
    }
  }
});

export async function fetchApi<T>(params: {
  label: string;
  path: string;
  fallback?: T;
}): Promise<ApiEnvelope<T>> {
  const endpoint = buildUpstreamEndpoint(params.path);
  try {
    return {
      label: params.label,
      data: (await fetchEndpoint(endpoint)) as T,
      source: "live",
      endpoint,
    };
  } catch (error) {
    if (
      process.env.API_ALLOW_MOCK_FALLBACK !== "true" ||
      !("fallback" in params)
    ) {
      throw new Error(`${params.label}: ${toErrorMessage(error)}`);
    }

    return {
      label: params.label,
      data: params.fallback as T,
      source: "mock",
      endpoint,
      error: toErrorMessage(error),
    };
  }
}

export function withQuery(
  path: string,
  query: Record<string, string | number | boolean | null | undefined>,
) {
  const searchParams = new URLSearchParams();

  Object.entries(query).forEach(([key, value]) => {
    if (value == null || value === "") {
      return;
    }

    searchParams.set(key, String(value));
  });

  const queryString = searchParams.toString();
  return queryString ? `${path}?${queryString}` : path;
}
