import { readApiResponse } from "./browser";

export interface AdUploadFailure {
  file: File;
  reason: string;
}

const MAX_BATCH_FILES = 10;
const UNCONFIRMED_BATCH_MESSAGE = "일괄 업로드 결과를 확인하지 못했습니다. 업로드 이력을 확인한 후 다시 시도해 주세요.";

/** Send bounded batches sequentially; each result still belongs to one file. */
export async function uploadAdFiles({
  files,
  storeId,
  reportDate,
  onProgress,
}: {
  files: File[];
  storeId: string;
  reportDate: string;
  onProgress?: (completed: number, total: number) => void;
}) {
  const succeeded: File[] = [];
  const failed: AdUploadFailure[] = [];
  onProgress?.(0, files.length);

  for (let offset = 0; offset < files.length; offset += MAX_BATCH_FILES) {
    const batch = files.slice(offset, offset + MAX_BATCH_FILES);
    try {
      const body = new FormData();
      body.append("storeId", storeId);
      body.append("reportDate", reportDate);
      for (const file of batch) body.append("files", file);
      let response: Response;
      try {
        response = await fetch("/api/ad-uploads/batch", { method: "POST", body });
      } catch {
        throw new Error(UNCONFIRMED_BATCH_MESSAGE);
      }
      const payload = await readApiResponse<unknown>(response, UNCONFIRMED_BATCH_MESSAGE);
      if (!payload || typeof payload !== "object" || !("results" in payload) || !Array.isArray(payload.results)) {
        throw new Error(UNCONFIRMED_BATCH_MESSAGE);
      }
      const resultsByIndex = new Map<number, Record<string, unknown>[]>();
      for (const result of payload.results) {
        if (!result || typeof result !== "object") continue;
        const item = result as Record<string, unknown>;
        if (typeof item.index !== "number" || !Number.isInteger(item.index) || item.index < 0 || item.index >= batch.length) continue;
        const matches = resultsByIndex.get(item.index) ?? [];
        matches.push(item);
        resultsByIndex.set(item.index, matches);
      }
      for (const [index, file] of batch.entries()) {
        const matches = resultsByIndex.get(index);
        const result = matches?.length === 1 ? matches[0] : undefined;
        if (!result || typeof result.fileName !== "string" || result.fileName !== file.name || typeof result.success !== "boolean") {
          failed.push({ file, reason: UNCONFIRMED_BATCH_MESSAGE });
        } else if (result.success && typeof result.uploadId === "string" && result.uploadId.trim()) {
          succeeded.push(file);
        } else {
          failed.push({
            file,
            reason: result.success === false && typeof result.message === "string" && result.message.trim()
              ? result.message
              : UNCONFIRMED_BATCH_MESSAGE,
          });
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : UNCONFIRMED_BATCH_MESSAGE;
      failed.push(...batch.map((file) => ({ file, reason })));
    }
    onProgress?.(succeeded.length + failed.length, files.length);
  }

  return { succeeded, failed };
}
