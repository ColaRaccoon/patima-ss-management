import { parseAdUploadFileName } from "@patima/shared";
import { readApiResponse } from "./browser";

export interface AdUploadFailure {
  file: File;
  reason: string;
}

export interface AdUploadDetail {
  originalFileName: string;
  storeName: string;
  reportDate: string;
  uploadId: string;
  confirmedRowCount: number;
  summaryStatus: "SUCCEEDED" | "WARNING" | "FAILED";
}

interface AdUploadResult {
  succeeded: File[];
  failed: AdUploadFailure[];
  details?: AdUploadDetail[];
}

const MAX_MANUAL_BATCH_FILES = 10;
const MAX_AUTO_BATCH_FILES = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const UNCONFIRMED_BATCH_MESSAGE = "일괄 업로드 결과를 확인하지 못했습니다. 업로드 이력을 확인한 후 다시 시도해 주세요.";
const normalizeFileName = (name: string) => name.normalize("NFC");
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const validText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validateAutomaticResult(payload: unknown, files: File[]): AdUploadDetail[] {
  if (!isRecord(payload) || !Array.isArray(payload.items) || payload.items.length !== files.length ||
    payload.fileCount !== files.length || !validCount(payload.confirmedRowCount)) {
    throw new Error(UNCONFIRMED_BATCH_MESSAGE);
  }
  const itemsByName = new Map<string, AdUploadDetail[]>();
  const uploadIds = new Set<string>();
  for (const item of payload.items) {
    if (!isRecord(item) || !validText(item.originalFileName) || !validText(item.storeName) ||
      !validText(item.reportDate) || !validText(item.uploadId) || uploadIds.has(item.uploadId) ||
      !validCount(item.confirmedRowCount) || !["SUCCEEDED", "WARNING", "FAILED"].includes(String(item.summaryStatus))) {
      throw new Error(UNCONFIRMED_BATCH_MESSAGE);
    }
    const target = parseAdUploadFileName(item.originalFileName);
    if (!target || target.reportDate !== item.reportDate || target.storeName !== item.storeName.normalize("NFC").trim()) {
      throw new Error(UNCONFIRMED_BATCH_MESSAGE);
    }
    uploadIds.add(item.uploadId);
    const key = normalizeFileName(item.originalFileName);
    const matches = itemsByName.get(key) ?? [];
    matches.push(item as unknown as AdUploadDetail);
    itemsByName.set(key, matches);
  }
  const details = files.map((file) => {
    const item = itemsByName.get(normalizeFileName(file.name))?.shift();
    if (!item) throw new Error(UNCONFIRMED_BATCH_MESSAGE);
    return item;
  });
  if (details.reduce((sum, item) => sum + item.confirmedRowCount, 0) !== payload.confirmedRowCount) {
    throw new Error(UNCONFIRMED_BATCH_MESSAGE);
  }
  return details;
}

async function postBatch(body: FormData) {
  try {
    return await fetch("/api/ad-uploads/batch", { method: "POST", body });
  } catch {
    throw new Error(UNCONFIRMED_BATCH_MESSAGE);
  }
}

/** Auto mode sends one atomic batch; manual mode keeps per-file partial success. */
export async function uploadAdFiles({
  files,
  mode,
  storeId,
  reportDate,
  onProgress,
}: {
  files: File[];
  mode?: "auto" | "manual";
  storeId?: string;
  reportDate?: string;
  onProgress?: (completed: number, total: number) => void;
}): Promise<AdUploadResult> {
  const succeeded: File[] = [];
  const failed: AdUploadFailure[] = [];
  onProgress?.(0, files.length);
  if (files.length === 0) return { succeeded, failed };
  const resolvedMode = mode ?? (storeId !== undefined || reportDate !== undefined ? "manual" : "auto");

  if (resolvedMode === "auto") {
    try {
      if (files.length > MAX_AUTO_BATCH_FILES) throw new Error("자동 분류는 한 번에 최대 100개까지 업로드할 수 있습니다. 파일 수를 줄여 주세요.");
      const invalidFile = files.find((file) => file.size === 0 || file.size > MAX_FILE_BYTES || !parseAdUploadFileName(file.name));
      if (invalidFile) throw new Error(`${invalidFile.name}: 파일명·날짜·크기(1바이트~10MB)를 확인해 주세요. 선택한 파일은 모두 반영되지 않았습니다.`);
      const body = new FormData();
      for (const file of files) body.append("files", file);
      const response = await postBatch(body);
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const message = isRecord(payload) && validText(payload.message) ? payload.message : "일괄 업로드에 실패했습니다.";
        const fileName = isRecord(payload) && validText(payload.fileName) ? `${payload.fileName}: ` : "";
        const outcome = response.status === 400 || response.status === 413
          ? "선택한 파일은 모두 반영되지 않았습니다."
          : "업로드 이력을 확인한 후 다시 시도해 주세요.";
        throw new Error(`${fileName}${message}\n${outcome}`);
      }
      const details = validateAutomaticResult(await readApiResponse<unknown>(response, UNCONFIRMED_BATCH_MESSAGE), files);
      onProgress?.(files.length, files.length);
      return { succeeded: [...files], failed, details };
    } catch (error) {
      const reason = error instanceof Error ? error.message : UNCONFIRMED_BATCH_MESSAGE;
      onProgress?.(files.length, files.length);
      return { succeeded, failed: files.map((file) => ({ file, reason })) };
    }
  }

  if (!storeId?.trim() || !reportDate?.trim()) {
    onProgress?.(files.length, files.length);
    return { succeeded, failed: files.map((file) => ({ file, reason: "직접 지정 업로드에는 스토어와 보고일이 모두 필요합니다." })) };
  }
  for (let offset = 0; offset < files.length; offset += MAX_MANUAL_BATCH_FILES) {
    const batch = files.slice(offset, offset + MAX_MANUAL_BATCH_FILES).filter((file) => {
      if (file.size <= MAX_FILE_BYTES) return true;
      failed.push({ file, reason: "파일 크기가 10MB를 초과했습니다." });
      return false;
    });
    try {
      if (batch.length === 0) continue;
      const body = new FormData();
      body.append("storeId", storeId);
      body.append("reportDate", reportDate);
      for (const file of batch) body.append("files", file);
      const payload = await readApiResponse<unknown>(await postBatch(body), UNCONFIRMED_BATCH_MESSAGE);
      if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error(UNCONFIRMED_BATCH_MESSAGE);
      const resultsByIndex = new Map<number, Record<string, unknown>[]>();
      for (const result of payload.results) {
        if (!isRecord(result)) continue;
        if (typeof result.index !== "number" || !Number.isInteger(result.index) || result.index < 0 || result.index >= batch.length) continue;
        const matches = resultsByIndex.get(result.index) ?? [];
        matches.push(result);
        resultsByIndex.set(result.index, matches);
      }
      for (const [index, file] of batch.entries()) {
        const matches = resultsByIndex.get(index);
        const result = matches?.length === 1 ? matches[0] : undefined;
        if (!result || !validText(result.fileName) || normalizeFileName(result.fileName) !== normalizeFileName(file.name) || typeof result.success !== "boolean") {
          failed.push({ file, reason: UNCONFIRMED_BATCH_MESSAGE });
        } else if (result.success && validText(result.uploadId)) {
          succeeded.push(file);
        } else {
          failed.push({ file, reason: result.success === false && validText(result.message) ? result.message : UNCONFIRMED_BATCH_MESSAGE });
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : UNCONFIRMED_BATCH_MESSAGE;
      failed.push(...batch.map((file) => ({ file, reason })));
    } finally {
      onProgress?.(succeeded.length + failed.length, files.length);
    }
  }
  return { succeeded, failed };
}
