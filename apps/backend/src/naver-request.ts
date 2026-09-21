/** Errors contain only classified metadata; upstream messages may contain personal data. */
export class NaverRequestError extends Error {
  readonly safeMessage: string;
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly upstreamStatus?: number,
    readonly upstreamCode?: string,
    readonly traceId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.safeMessage = naverSafeMessage(code, upstreamStatus);
  }
}

const naverSafeMessage = (code: string, status?: number) => {
  if (
    code === "NAVER_CREDENTIALS_NOT_CONFIGURED" ||
    code === "NAVER_AUTHENTICATION_FAILED"
  )
    return "네이버 인증 설정을 확인해 주세요. 스토어 설정에서 연결을 다시 확인할 수 있습니다.";
  if (code === "NAVER_REQUEST_TIMEOUT" || code === "NAVER_NETWORK_ERROR")
    return "네이버 응답이 지연되거나 연결이 끊겼습니다. 잠시 후 다시 시도합니다.";
  if (status === 429)
    return "네이버 요청 한도에 도달했습니다. 안내된 대기 시간 후 다시 시도합니다.";
  if (status != null && status >= 500)
    return "네이버 서버에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도합니다.";
  if (code === "NAVER_MISSING_ORDER_DETAILS")
    return "일부 주문의 상세 정보가 누락되었습니다. 누락 주문을 다시 조회합니다.";
  if (code === "INCOMPLETE_PAGINATION")
    return "주문 목록을 끝까지 확인하지 못했습니다. 조회 범위를 줄여 다시 수집해 주세요.";
  if (
    code.startsWith("NAVER_INVALID_") ||
    code === "NAVER_UNEXPECTED_DETAIL_ID"
  )
    return "네이버 주문 응답을 검증하지 못했습니다. 작업 상세의 오류 코드로 응답 형식을 확인해 주세요.";
  if (code === "INVALID_ORDER_RANGE")
    return "주문 조회 날짜 또는 기준시각이 올바르지 않습니다. 조회 범위를 확인해 주세요.";
  return "네이버 요청을 처리하지 못했습니다. 작업 상세의 오류 코드와 스토어 연결 설정을 확인해 주세요.";
};

/** Cancel this waiter without cancelling a token request shared by other callers. */
export const waitForNaverToken = <T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
};

export const waitForNaverRetry = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

export async function requestNaverJson(
  url: string | URL,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 20_000);
    let failure: NaverRequestError;
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const record =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      const code = typeof record.code === "string" ? record.code : undefined;
      const traceId =
        typeof record.traceId === "string"
          ? record.traceId
          : (response.headers.get("GNCP-GW-Trace-ID") ?? undefined);
      if (response.ok) {
        if (body === null || typeof body !== "object")
          throw new NaverRequestError("NAVER_INVALID_RESPONSE");
        return body;
      }
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs =
        retryAfter == null
          ? undefined
          : /^\d+(\.\d+)?$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Math.max(0, Date.parse(retryAfter) - Date.now());
      failure = new NaverRequestError(
        response.status === 401 || response.status === 403
          ? "NAVER_AUTHENTICATION_FAILED"
          : "NAVER_API_ERROR",
        response.status === 429 || response.status >= 500,
        response.status,
        code,
        traceId,
        Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      );
    } catch (error) {
      signal?.throwIfAborted();
      failure =
        error instanceof NaverRequestError
          ? error
          : new NaverRequestError(
              controller.signal.aborted
                ? "NAVER_REQUEST_TIMEOUT"
                : "NAVER_NETWORK_ERROR",
              true,
            );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    // Long server-directed waits belong to the durable operation retry, not an occupied worker.
    if (
      !failure.retryable ||
      attempt === 2 ||
      (failure.retryAfterMs ?? 0) > 30_000
    )
      throw failure;
    await waitForNaverRetry(
      Math.max(
        failure.retryAfterMs ?? 0,
        500 * 2 ** attempt + Math.random() * 250,
      ),
      signal,
    );
  }
  throw new NaverRequestError("NAVER_REQUEST_FAILED", true);
}
