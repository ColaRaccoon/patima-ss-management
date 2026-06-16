import type { ApiEnvelope } from "@/lib/api/types";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api/v1";
const API_FETCH_ATTEMPT_TIMEOUT_MS = Number(process.env.API_FETCH_ATTEMPT_TIMEOUT_MS ?? 2500);
const API_FETCH_RETRY_WINDOW_MS = Number(process.env.API_FETCH_RETRY_WINDOW_MS ?? 30000);
const API_FETCH_RETRY_DELAY_MS = Number(process.env.API_FETCH_RETRY_DELAY_MS ?? 500);

function buildEndpoint(path: string) {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  return `${API_BASE_URL}${path}`;
}

function extractData<T>(payload: unknown): T {
  if (
    payload &&
    typeof payload === "object" &&
    "success" in payload &&
    "data" in payload
  ) {
    const success = Reflect.get(payload, "success");
    if (success === false) {
      const message = Reflect.get(payload, "message");
      throw new Error(typeof message === "string" ? message : "API 요청 실패");
    }

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

export async function fetchApi<T>(params: {
  label: string;
  path: string;
  fallback?: T;
}): Promise<ApiEnvelope<T>> {
  const endpoint = buildEndpoint(params.path);
  const retryUntil = Date.now() + API_FETCH_RETRY_WINDOW_MS;

  try {
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
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        const data = extractData<T>(payload);

        return {
          label: params.label,
          data,
          source: "live",
          endpoint,
        };
      } catch (error) {
        if (!isRetryableNetworkError(error) || Date.now() >= retryUntil) {
          throw error;
        }

        await sleep(API_FETCH_RETRY_DELAY_MS);
      }
    }
  } catch (error) {
    if (!("fallback" in params)) {
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
