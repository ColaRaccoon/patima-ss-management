import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import {
  AdCampaignDailyCost,
  AdExcelUpload,
  AdUploadPreviewRow,
  DatabaseShape,
  normalizeText,
  parseAdUploadFileName,
} from "@patima/shared";
import * as XLSX from "xlsx";
import { AuditLogService } from "./audit-log.service";
import {
  createAdCampaignSignatureIndex,
  getOverrideSnapshotHash,
  getRuleSnapshotHash,
  recalculateAdCampaignSignaturesForStore,
  refreshAdCampaignSignatureSummaries,
  upsertAdCampaignSignature,
} from "./ad-mapping-engine";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureDateString,
  formatApiSuccess,
  getActiveConfirmedUploadIds,
  getAdMappingStatus,
  getWeekdayNameKo,
  hashBuffer,
  nowIso,
  paginate,
  repairMojibakeText,
} from "./helpers";
import { OperationService } from "./operation.service";
import { ProfitSummaryService } from "./profit-summary.service";
import { StoreService } from "./store.service";

export const AD_UPLOAD_REQUIRED_HEADERS = [
  "캠페인 ID",
  "캠페인 이름",
  "총비용",
  "노출수",
  "클릭수",
  "총 전환수",
  "총 전환매출액",
];

const WEEKDAYS = new Set([
  "월요일",
  "화요일",
  "수요일",
  "목요일",
  "금요일",
  "토요일",
  "일요일",
]);

interface AdUploadCampaign {
  campaignId: string;
  campaignName: string;
  weekday: string | null;
  adType: string | null;
  status: string | null;
  totalCost: number;
  impressions: number;
  clicks: number;
  totalConversions: number;
  totalConversionSales: number;
}
interface PreparedAdUpload {
  originalFileName: string;
  fileHash: string;
  detectedWeekday: string | null;
  campaigns: AdUploadCampaign[];
}
interface PreparedAdUploadTarget {
  index: number;
  storeId: string;
  reportDate: string;
  prepared: PreparedAdUpload;
}
interface AdUploadFileResult {
  index: number;
  fileName: string;
  success: boolean;
  uploadId?: string;
  message?: string;
}

@Injectable()
export class AdsService implements OnModuleInit {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly operationService: OperationService,
    private readonly auditLogService: AuditLogService,
    private readonly profitSummaryService?: ProfitSummaryService,
  ) {}

  onModuleInit(): void {
    this.operationService.registerRetryExecutor(
      "AD_UPLOAD_CONFIRM",
      async (operation) => {
        const request = operation.requestJson as { uploadId: string };
        return this.performConfirm(request.uploadId);
      },
    );
  }

  async previewUpload(
    storeId: string,
    reportDate: string,
    file: Express.Multer.File,
  ) {
    this.storeService.ensureWritable(storeId);
    ensureDateString(reportDate, "reportDate");
    const prepared = this.parseUpload(reportDate, file);
    const results = await this.commitPreparedUploads(
      storeId,
      reportDate,
      [{ index: 0, prepared }],
      false,
    );
    const result = results[0];
    return formatApiSuccess({
      uploadId: result.uploadId!,
      reportDate,
      detectedWeekday: prepared.detectedWeekday,
      weekdayValidationStatus: "PASSED" as const,
      status: "CONFIRMED",
      confirmedRowCount: prepared.campaigns.length,
    });
  }

  async previewUploads(
    storeId: string,
    reportDate: string,
    files: Express.Multer.File[],
  ) {
    this.storeService.ensureWritable(storeId);
    ensureDateString(reportDate, "reportDate");
    if (!files?.length || files.length > 10) {
      throw new BadRequestException({
        success: false,
        message: "광고 파일은 한 번에 1~10개까지 업로드할 수 있습니다.",
      });
    }
    const results: AdUploadFileResult[] = [];
    const prepared: Array<{ index: number; prepared: PreparedAdUpload }> = [];
    files.forEach((file, index) => {
      try {
        prepared.push({ index, prepared: this.parseUpload(reportDate, file) });
      } catch (error) {
        results.push({
          index,
          fileName: repairMojibakeText(file?.originalname),
          success: false,
          message:
            error instanceof Error
              ? error.message
              : "광고 파일을 읽을 수 없습니다.",
        });
      }
    });
    if (prepared.length)
      results.push(
        ...(await this.commitPreparedUploads(
          storeId,
          reportDate,
          prepared,
          true,
        )),
      );
    results.sort((left, right) => left.index - right.index);
    return formatApiSuccess({
      results,
      confirmedFileCount: results.filter((result) => result.success).length,
    });
  }

  async uploadBatch(files: Express.Multer.File[]) {
    if (!files?.length || files.length > 100) {
      throw new BadRequestException("1~100개의 엑셀 파일을 선택하세요.");
    }
    const snapshot = this.databaseService.getSnapshot();
    const prepared: PreparedAdUploadTarget[] = files.map((file, index) => {
      const fileName = repairMojibakeText(file?.originalname);
      const target = parseAdUploadFileName(fileName);
      if (!target) {
        throw new BadRequestException({
          success: false,
          message:
            "파일명은 YYMMDD_인피니티[메인/서브].xlsx 또는 YYMMDD_파티마[메인/서브].xlsx 형식이어야 합니다. 날짜도 확인하세요.",
          fileName,
          errors: [{ field: "file", reason: "AD_UPLOAD_INVALID_FILENAME" }],
        });
      }
      const stores = snapshot.stores.filter(
        (store) => store.name.normalize("NFC").trim() === target.storeName,
      );
      if (stores.length !== 1) {
        throw new BadRequestException({
          success: false,
          message: `${target.storeName}를 하나로 식별할 수 없습니다. 스토어 설정을 확인하세요.`,
          fileName,
          errors: [
            {
              field: "storeId",
              reason: "AD_UPLOAD_STORE_AMBIGUOUS_OR_MISSING",
            },
          ],
        });
      }
      this.storeService.ensureWritable(stores[0].id);
      return {
        index,
        storeId: stores[0].id,
        reportDate: target.reportDate,
        prepared: this.parseUpload(target.reportDate, file),
      };
    });
    const results = await this.databaseService.commitAdUploadBatchCommitted({
      scopes: prepared.map(({ storeId, reportDate, prepared: upload }) => ({
        storeId,
        reportDate,
        campaignIds: upload.campaigns.map((campaign) => campaign.campaignId),
      })),
      build: (draft) => this.buildPreparedUploads(draft, prepared, false),
    });
    const datesByStore = new Map<string, Set<string>>();
    for (const target of prepared) {
      const dates = datesByStore.get(target.storeId) ?? new Set<string>();
      dates.add(target.reportDate);
      datesByStore.set(target.storeId, dates);
    }
    const summaries = new Map<string, boolean>();
    for (const [storeId, dates] of datesByStore) {
      const summary = await this.profitSummaryService
        ?.refreshStoreDateListBestEffort({
          storeId,
          dates: [...dates],
          reason: "AD_UPLOAD",
        })
        .catch(() => null);
      summaries.set(storeId, !!summary);
    }
    const items = results.map((result) => {
      const { storeId, reportDate, prepared: upload } = prepared[result.index];
      return {
        uploadId: result.uploadId!,
        originalFileName: upload.originalFileName,
        storeId,
        storeName: snapshot.stores.find((store) => store.id === storeId)!.name,
        reportDate,
        detectedWeekday: upload.detectedWeekday,
        weekdayValidationStatus: "PASSED" as const,
        status: "CONFIRMED" as const,
        confirmedRowCount: upload.campaigns.length,
        summaryStatus: summaries.get(storeId)
          ? ("SUCCEEDED" as const)
          : ("WARNING" as const),
      };
    });
    return formatApiSuccess({
      items,
      fileCount: items.length,
      confirmedRowCount: items.reduce(
        (sum, item) => sum + item.confirmedRowCount,
        0,
      ),
    });
  }

  private parseUpload(
    reportDate: string,
    file: Express.Multer.File,
  ): PreparedAdUpload {
    const originalFileName = repairMojibakeText(file?.originalname);
    if (!file || !/\.xlsx$/i.test(originalFileName)) {
      throw new BadRequestException({
        success: false,
        message: "엑셀(.xlsx) 파일만 업로드할 수 있습니다.",
        errors: [{ field: "file", reason: "EXCEL_REQUIRED_COLUMNS_MISSING" }],
        fileName: originalFileName,
      });
    }
    if (!file.buffer?.length) {
      throw new BadRequestException({
        success: false,
        message: "빈 엑셀 파일은 업로드할 수 없습니다.",
        fileName: originalFileName,
      });
    }
    if (file.buffer.length > 10 * 1024 * 1024) {
      throw new BadRequestException({
        success: false,
        message: "파일당 최대 10MB까지 업로드할 수 있습니다.",
        fileName: originalFileName,
      });
    }
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: "buffer" });
    } catch {
      throw new BadRequestException({
        success: false,
        message: "엑셀 파일을 읽을 수 없습니다.",
        fileName: originalFileName,
      });
    }
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) {
      throw new BadRequestException({
        success: false,
        message: "엑셀 파일에 워크시트가 없습니다.",
        fileName: originalFileName,
      });
    }
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false,
    });
    const header = (rows[0] ?? []).map((value) =>
      this.normalizeHeaderCell(value),
    );
    for (const requiredHeader of AD_UPLOAD_REQUIRED_HEADERS) {
      if (!header.includes(this.normalizeHeaderCell(requiredHeader))) {
        throw new BadRequestException({
          success: false,
          message: "필수 엑셀 컬럼이 누락되었습니다.",
          errors: [
            { field: requiredHeader, reason: "EXCEL_REQUIRED_COLUMNS_MISSING" },
          ],
          fileName: originalFileName,
        });
      }
    }
    const campaigns = this.parseCampaignRows(rows, header);
    this.assertNoDuplicateCampaignIds(
      campaigns.map((campaign) => campaign.campaignId),
      "AD_UPLOAD_DUPLICATE_IN_FILE",
      originalFileName,
    );
    const detectedWeekdays = Array.from(
      new Set(campaigns.map((item) => item.weekday).filter(Boolean)),
    ) as string[];
    const weekdayValidationStatus =
      detectedWeekdays.length === 0
        ? "MISSING"
        : detectedWeekdays.length > 1
          ? "MULTIPLE"
          : detectedWeekdays[0] !== getWeekdayNameKo(reportDate)
            ? "MISMATCH"
            : "PASSED";
    if (weekdayValidationStatus !== "PASSED") {
      throw new BadRequestException({
        success: false,
        message: this.describeWeekdayFailure(
          weekdayValidationStatus,
          detectedWeekdays,
          reportDate,
        ),
        errors: [
          { field: "file", reason: "AD_UPLOAD_WEEKDAY_VALIDATION_FAILED" },
        ],
        fileName: originalFileName,
        weekdayValidationStatus,
        detectedWeekday: detectedWeekdays[0] ?? null,
      });
    }
    return {
      originalFileName,
      fileHash: hashBuffer(file.buffer),
      detectedWeekday: detectedWeekdays[0],
      campaigns,
    };
  }

  private async commitPreparedUploads(
    storeId: string,
    reportDate: string,
    files: Array<{ index: number; prepared: PreparedAdUpload }>,
    allowPartial: boolean,
  ): Promise<AdUploadFileResult[]> {
    const results = await this.databaseService.commitAdUploadsCommitted({
      storeId,
      reportDate,
      campaignIds: files.flatMap(({ prepared }) =>
        prepared.campaigns.map((campaign) => campaign.campaignId),
      ),
      build: (draft) =>
        this.buildPreparedUploads(
          draft,
          files.map((file) => ({ ...file, storeId, reportDate })),
          allowPartial,
        ),
    });
    if (results.some((result) => result.success))
      await this.recalculateProfitSummaryForAdDate(storeId, reportDate);
    return results;
  }

  private buildPreparedUploads(
    draft: DatabaseShape,
    files: PreparedAdUploadTarget[],
    allowPartial: boolean,
  ) {
    const signatureIndex = createAdCampaignSignatureIndex(draft);
    const touchedSignatureIds = new Set<string>();
    const uploads: AdExcelUpload[] = [];
    const confirmedRows: AdCampaignDailyCost[] = [];
    const auditLogs: DatabaseShape["auditLogs"] = [];
    const fileResults: AdUploadFileResult[] = [];
    const timestamp = nowIso();
    const activeCampaignsByScope = new Map<string, Set<string>>();
    for (const { index, storeId, reportDate, prepared } of files) {
      const scopeKey = JSON.stringify([storeId, reportDate]);
      let activeCampaignIds = activeCampaignsByScope.get(scopeKey);
      if (!activeCampaignIds) {
        activeCampaignIds = new Set(
          this.getActiveConfirmedRows(draft, storeId, reportDate).map((row) =>
            row.campaignId.trim(),
          ),
        );
        activeCampaignsByScope.set(scopeKey, activeCampaignIds);
      }
      try {
        this.assertNoCampaignIdOverlap(
          prepared.campaigns.map((campaign) => campaign.campaignId),
          activeCampaignIds,
          "AD_UPLOAD_DUPLICATE_WITH_ACTIVE_UPLOAD",
          prepared.originalFileName,
        );
      } catch (error) {
        if (!allowPartial) throw error;
        fileResults.push({
          index,
          fileName: prepared.originalFileName,
          success: false,
          message:
            error instanceof Error ? error.message : "중복 캠페인이 있습니다.",
        });
        continue;
      }
      const upload: AdExcelUpload = {
        id: createId(),
        storeId,
        sourceType: "NAVER_DA_XLSX",
        originalFileName: prepared.originalFileName,
        fileHash: prepared.fileHash,
        reportDate,
        detectedWeekday: prepared.detectedWeekday,
        weekdayValidationStatus: "PASSED",
        replacedUploadId: null,
        // These files are confirmed immediately; preview-staleness hashes are only needed by legacy previews.
        previewRuleSnapshotHash: null,
        previewOverrideSnapshotHash: null,
        previewCreatedAt: null,
        previewExpiresAt: null,
        state: "CONFIRMED",
        isActive: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      uploads.push(upload);
      for (const campaign of prepared.campaigns) {
        activeCampaignIds.add(campaign.campaignId);
        const normalizedCampaignName = normalizeText(campaign.campaignName);
        const signature = upsertAdCampaignSignature(
          draft,
          {
            storeId,
            campaignId: campaign.campaignId,
            campaignName: campaign.campaignName,
            normalizedCampaignName,
            reportDate,
          },
          signatureIndex,
        );
        touchedSignatureIds.add(signature.id);
        confirmedRows.push({
          ...campaign,
          id: createId(),
          uploadId: upload.id,
          sourceUploadId: upload.id,
          adCampaignSignatureId: signature.id,
          storeId,
          reportDate,
          normalizedCampaignName,
          matchedRuleCount: signature.matchedRuleCount,
          canonicalSalesUnitId: signature.canonicalSalesUnitId,
          mappingReason: signature.mappingReason,
          reasonNote: signature.reasonNote,
          reasonNoteInherited: signature.reasonNoteInherited,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      auditLogs.push(
        this.auditLogService.createAuditLog({
          storeId,
          domain: "AD_UPLOAD",
          action: "CREATE",
          targetId: upload.id,
          actorIdentifier: "LOCALHOST_ADMIN",
          beforeJson: null,
          afterJson: {
            reportDate,
            originalFileName: prepared.originalFileName,
            confirmedRowCount: prepared.campaigns.length,
          },
        }),
      );
      fileResults.push({
        index,
        fileName: prepared.originalFileName,
        success: true,
        uploadId: upload.id,
      });
    }
    const rowsByStore = new Map<string, AdCampaignDailyCost[]>();
    for (const row of confirmedRows) {
      const rows = rowsByStore.get(row.storeId) ?? [];
      rows.push(row);
      rowsByStore.set(row.storeId, rows);
    }
    for (const [storeId, rows] of rowsByStore) {
      recalculateAdCampaignSignaturesForStore(draft, storeId, {
        signatureIds: new Set(rows.map((row) => row.adCampaignSignatureId!)),
        applyToRows: true,
        rows,
      });
    }
    return {
      uploads,
      rows: confirmedRows,
      auditLogs,
      signatures: draft.adCampaignSignatures.filter((signature) =>
        touchedSignatureIds.has(signature.id),
      ),
      result: fileResults,
    };
  }

  listPreviewRows(uploadId: string, page?: number, pageSize?: number) {
    const snapshot = this.databaseService.getSnapshot();
    const upload = snapshot.adExcelUploads.find((item) => item.id === uploadId);
    if (!upload) {
      throw new NotFoundException({
        success: false,
        message: "업로드를 찾을 수 없습니다.",
        errors: [{ field: "uploadId", reason: "UPLOAD_NOT_FOUND" }],
      });
    }

    const items = snapshot.adUploadPreviewRows
      .filter((item) => item.uploadId === uploadId)
      .sort((left, right) =>
        left.campaignName.localeCompare(right.campaignName, "ko"),
      )
      .map((item) => ({
        ...item,
        campaignName: repairMojibakeText(item.campaignName),
        weekday: repairMojibakeText(item.weekday),
        adType: repairMojibakeText(item.adType),
        status: repairMojibakeText(item.status),
        reasonNote: repairMojibakeText(item.reasonNote),
      }));
    return formatApiSuccess(paginate(items, page, pageSize));
  }

  listUploads(storeId: string, page?: number, pageSize?: number) {
    const snapshot = this.databaseService.getSnapshot();
    const items = snapshot.adExcelUploads
      .filter((item) => item.storeId === storeId && item.state !== "DELETED")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((item) => ({
        uploadId: item.id,
        reportDate: item.reportDate,
        detectedWeekday: item.detectedWeekday,
        weekdayValidationStatus: item.weekdayValidationStatus,
        uploadStatus: item.state,
        isActive: item.isActive,
        originalFileName: repairMojibakeText(item.originalFileName),
        createdAt: item.createdAt,
        previewExpiresAt: item.previewExpiresAt,
        ruleSnapshotHash: item.previewRuleSnapshotHash,
        overrideSnapshotHash: item.previewOverrideSnapshotHash,
      }));
    return formatApiSuccess(paginate(items, page, pageSize));
  }

  async deleteUpload(uploadId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const upload = snapshot.adExcelUploads.find((item) => item.id === uploadId);
    if (!upload) {
      throw new NotFoundException({
        success: false,
        message: "업로드를 찾을 수 없습니다.",
        errors: [{ field: "uploadId", reason: "UPLOAD_NOT_FOUND" }],
      });
    }

    if (upload.state === "DELETED") {
      throw new BadRequestException({
        success: false,
        message: "이미 삭제된 업로드입니다.",
        errors: [{ field: "uploadId", reason: "AD_UPLOAD_ALREADY_DELETED" }],
      });
    }

    this.storeService.ensureWritable(upload.storeId);

    const previewRowCount = snapshot.adUploadPreviewRows.filter(
      (item) => item.uploadId === upload.id,
    ).length;
    const adCostCount = snapshot.adCampaignDailyCosts.filter(
      (item) => item.sourceUploadId === upload.id,
    ).length;
    const previousState = upload.state;
    const wasActive = upload.isActive;

    await this.databaseService.writeCommitted((draft) => {
      const affectedSignatureIds = new Set(
        draft.adCampaignDailyCosts
          .filter(
            (item) =>
              item.sourceUploadId === upload.id && item.adCampaignSignatureId,
          )
          .map((item) => item.adCampaignSignatureId!),
      );
      draft.adUploadPreviewRows = draft.adUploadPreviewRows.filter(
        (item) => item.uploadId !== upload.id,
      );
      draft.adCampaignDailyCosts = draft.adCampaignDailyCosts.filter(
        (item) => item.sourceUploadId !== upload.id,
      );
      refreshAdCampaignSignatureSummaries(draft, {
        storeId: upload.storeId,
        signatureIds: affectedSignatureIds,
      });

      const target = draft.adExcelUploads.find(
        (item) => item.id === upload.id,
      )!;
      target.state = "DELETED";
      target.isActive = false;
      target.updatedAt = nowIso();
      this.auditLogService.appendToDraft(draft, {
        storeId: upload.storeId,
        domain: "AD_UPLOAD",
        action: "DELETE",
        targetId: upload.id,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: {
          state: previousState,
          isActive: wasActive,
          previewRowCount,
          adCostCount,
        },
        afterJson: {
          state: "DELETED",
          isActive: false,
        },
      });
    });

    await this.recalculateProfitSummaryForAdDate(
      upload.storeId,
      upload.reportDate,
    );

    return formatApiSuccess({
      uploadId: upload.id,
      previousState,
      previewRowCount,
      adCostCount,
    });
  }

  async enqueueConfirm(uploadId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const upload = snapshot.adExcelUploads.find((item) => item.id === uploadId);
    if (!upload) {
      throw new NotFoundException({
        success: false,
        message: "업로드를 찾을 수 없습니다.",
        errors: [{ field: "uploadId", reason: "UPLOAD_NOT_FOUND" }],
      });
    }

    const operation = await this.operationService.enqueue(
      upload.storeId,
      "AD_UPLOAD_CONFIRM",
      { uploadId },
      () => this.performConfirm(uploadId),
    );

    return formatApiSuccess({
      operationId: operation.id,
      operationType: operation.operationType,
      status: operation.status,
    });
  }

  async performConfirm(uploadId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const upload = snapshot.adExcelUploads.find((item) => item.id === uploadId);
    if (!upload) {
      throw new NotFoundException({
        success: false,
        message: "업로드를 찾을 수 없습니다.",
        errors: [{ field: "uploadId", reason: "UPLOAD_NOT_FOUND" }],
      });
    }

    if (upload.state !== "PREVIEW_PARSED") {
      throw new BadRequestException({
        success: false,
        message: "Only preview uploads can be confirmed.",
        errors: [{ field: "uploadId", reason: "AD_UPLOAD_PREVIEW_STALE" }],
      });
    }

    if (upload.previewExpiresAt && upload.previewExpiresAt < nowIso()) {
      throw new BadRequestException({
        success: false,
        message: "preview가 만료되었습니다.",
        errors: [{ field: "uploadId", reason: "AD_UPLOAD_PREVIEW_STALE" }],
      });
    }

    if (upload.weekdayValidationStatus !== "PASSED") {
      throw new BadRequestException({
        success: false,
        message: "요일 검증을 통과하지 못한 업로드는 확정할 수 없습니다.",
        errors: [
          { field: "uploadId", reason: "AD_UPLOAD_CONFIRMATION_REQUIRED" },
        ],
      });
    }

    const currentRuleHash = getRuleSnapshotHash(snapshot, upload.storeId);
    const currentOverrideHash = getOverrideSnapshotHash(
      snapshot,
      upload.storeId,
    );

    if (
      upload.previewRuleSnapshotHash !== currentRuleHash ||
      upload.previewOverrideSnapshotHash !== currentOverrideHash
    ) {
      throw new BadRequestException({
        success: false,
        message: "preview 생성 이후 대상이 변경되어 다시 preview가 필요합니다.",
        errors: [{ field: "uploadId", reason: "AD_UPLOAD_PREVIEW_STALE" }],
      });
    }

    const previewRows = snapshot.adUploadPreviewRows.filter(
      (item) => item.uploadId === upload.id,
    );
    this.assertNoDuplicateCampaignIds(
      previewRows.map((row) => row.campaignId),
      "AD_UPLOAD_DUPLICATE_IN_FILE",
    );
    this.assertNoCampaignIdOverlap(
      previewRows.map((row) => row.campaignId),
      this.getActiveConfirmedRows(snapshot, upload.storeId, upload.reportDate),
      "AD_UPLOAD_DUPLICATE_WITH_ACTIVE_UPLOAD",
    );

    await this.databaseService.writeCommitted((draft) => {
      const touchedSignatureIds = new Set<string>();
      draft.adCampaignDailyCosts = draft.adCampaignDailyCosts.filter(
        (item) => item.sourceUploadId !== upload.id,
      );
      previewRows.forEach((row) => {
        const signature = upsertAdCampaignSignature(draft, {
          storeId: upload.storeId,
          campaignId: row.campaignId,
          campaignName: row.campaignName,
          normalizedCampaignName: row.normalizedCampaignName,
          reportDate: row.reportDate,
        });
        touchedSignatureIds.add(signature.id);
        const confirmed: AdCampaignDailyCost = {
          ...row,
          sourceUploadId: upload.id,
          adCampaignSignatureId: signature.id,
        };
        draft.adCampaignDailyCosts.push(confirmed);
      });
      recalculateAdCampaignSignaturesForStore(draft, upload.storeId, {
        signatureIds: touchedSignatureIds,
        applyToRowsFrom: upload.reportDate,
        applyToRowsTo: upload.reportDate,
      });

      const target = draft.adExcelUploads.find(
        (item) => item.id === upload.id,
      )!;
      target.state = "CONFIRMED";
      target.isActive = true;
      target.updatedAt = nowIso();
      this.auditLogService.appendToDraft(draft, {
        storeId: upload.storeId,
        domain: "AD_UPLOAD",
        action: "UPDATE",
        targetId: upload.id,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: null,
        afterJson: {
          reportDate: upload.reportDate,
          confirmedRowCount: previewRows.length,
        },
      });
    });

    await this.recalculateProfitSummaryForAdDate(
      upload.storeId,
      upload.reportDate,
    );

    return {
      uploadId: upload.id,
      confirmedRowCount: previewRows.length,
    };
  }

  listAdCosts(query: {
    storeId: string;
    dateFrom?: string;
    dateTo?: string;
    mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED" | "CONFLICT";
    page?: number;
    pageSize?: number;
  }) {
    const snapshot = this.databaseService.getSnapshot();
    const activeUploadIds = getActiveConfirmedUploadIds(
      snapshot,
      query.storeId,
    );

    const items = snapshot.adCampaignDailyCosts
      .filter(
        (item) =>
          item.storeId === query.storeId &&
          activeUploadIds.has(item.sourceUploadId),
      )
      .filter((item) =>
        query.dateFrom && query.dateTo
          ? item.reportDate >= query.dateFrom && item.reportDate <= query.dateTo
          : true,
      )
      .filter((item) =>
        query.mappingStatus && query.mappingStatus !== "ALL"
          ? getAdMappingStatus(item) === query.mappingStatus
          : true,
      )
      .sort((left, right) => right.reportDate.localeCompare(left.reportDate))
      .map((item) => ({
        ...item,
        campaignName: repairMojibakeText(item.campaignName),
        weekday: repairMojibakeText(item.weekday),
        adType: repairMojibakeText(item.adType),
        status: repairMojibakeText(item.status),
        reasonNote: repairMojibakeText(item.reasonNote),
      }));

    return formatApiSuccess(paginate(items, query.page, query.pageSize));
  }

  async listAdCampaignSignatures(query: {
    storeId: string;
    dateFrom?: string;
    dateTo?: string;
    mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED" | "CONFLICT";
    q?: string;
    page?: number;
    pageSize?: number;
  }) {
    const result = await this.databaseService.queryAdCampaignSignatures(query);

    return formatApiSuccess({
      ...result,
      items: result.items.map(
        ({ signature, latestRow, totalCost, rowCount }) => ({
          id: signature.id,
          adCampaignSignatureId: signature.id,
          uploadId: latestRow?.sourceUploadId ?? signature.id,
          sourceUploadId: latestRow?.sourceUploadId ?? signature.id,
          storeId: signature.storeId,
          reportDate: signature.lastSeenDate ?? latestRow?.reportDate ?? "",
          campaignId: signature.campaignId ?? latestRow?.campaignId ?? "",
          campaignName: repairMojibakeText(signature.campaignNameSnapshot),
          normalizedCampaignName: signature.normalizedCampaignName,
          totalCost,
          matchedRuleCount: signature.matchedRuleCount,
          canonicalSalesUnitId: signature.canonicalSalesUnitId,
          mappingReason: signature.mappingReason,
          reasonNote: repairMojibakeText(signature.reasonNote),
          reasonNoteInherited: signature.reasonNoteInherited,
          usageCount: signature.usageCount ?? rowCount,
          firstSeenDate: signature.firstSeenDate,
          lastSeenDate: signature.lastSeenDate,
          confirmedAt: signature.confirmedAt,
        }),
      ),
    });
  }

  async setIntentionalUnmapped(
    adCostId: string,
    payload: { reasonNote: string },
  ) {
    await this.setIntentionalUnmappedInternal([adCostId], payload);

    return formatApiSuccess({
      adCostId,
      mappingReason: "INTENTIONALLY_UNMAPPED",
      reasonNote: payload.reasonNote,
    });
  }

  async setIntentionalUnmappedMany(
    adCostIds: string[],
    payload: { reasonNote: string },
  ) {
    const result = await this.setIntentionalUnmappedInternal(
      adCostIds,
      payload,
    );
    return formatApiSuccess({
      adCostIds: result.adCostIds,
      updatedCount: result.adCostIds.length,
      mappingReason: "INTENTIONALLY_UNMAPPED",
      reasonNote: payload.reasonNote,
    });
  }

  async saveManualMapping(
    adCostId: string,
    payload: { canonicalSalesUnitId: string },
  ) {
    await this.saveManualMappingsInternal([adCostId], payload);
    return formatApiSuccess({
      adCostId,
      canonicalSalesUnitId: payload.canonicalSalesUnitId,
      mappingReason: "MANUAL_MAPPED",
    });
  }

  async saveManualMappings(
    adCostIds: string[],
    payload: { canonicalSalesUnitId: string },
  ) {
    const result = await this.saveManualMappingsInternal(adCostIds, payload);
    return formatApiSuccess({
      adCostIds: result.adCostIds,
      canonicalSalesUnitId: payload.canonicalSalesUnitId,
      updatedCount: result.adCostIds.length,
      mappingReason: "MANUAL_MAPPED",
    });
  }

  async recalculateMapping(adCostId: string) {
    const result = await this.recalculateMappingsInternal([adCostId]);
    return formatApiSuccess({
      adCostId,
      canonicalSalesUnitId: result.mappings[0]?.canonicalSalesUnitId ?? null,
      mappingReason: result.mappings[0]?.mappingReason ?? "NO_RULE",
      matchedRuleCount: result.mappings[0]?.matchedRuleCount ?? 0,
    });
  }

  async recalculateMappings(adCostIds: string[]) {
    const result = await this.recalculateMappingsInternal(adCostIds);
    return formatApiSuccess({
      adCostIds: result.adCostIds,
      updatedCount: result.adCostIds.length,
      mappings: result.mappings,
    });
  }

  private async setIntentionalUnmappedInternal(
    adCostIds: string[],
    payload: { reasonNote: string },
  ) {
    const { dedupedIds, storeId } = this.resolveAdSignatureBatch(adCostIds);
    this.storeService.ensureWritable(storeId);
    const timestamp = nowIso();
    const commitResult =
      await this.databaseService.saveAdCampaignMappingsCommitted({
        storeId,
        targetIds: dedupedIds,
        action: {
          type: "INTENTIONALLY_UNMAPPED",
          reasonNote: payload.reasonNote,
          timestamp,
        },
      });
    await this.recalculateProfitSummariesForAdDates(
      storeId,
      commitResult.affectedDates,
    );

    return { adCostIds: dedupedIds };
  }

  private async saveManualMappingsInternal(
    adCostIds: string[],
    payload: { canonicalSalesUnitId: string },
  ) {
    const snapshot = this.databaseService.getSnapshot();
    const { dedupedIds, storeId } = this.resolveAdSignatureBatch(
      adCostIds,
      snapshot,
    );
    const salesUnit = snapshot.canonicalSalesUnits.find(
      (item) => item.id === payload.canonicalSalesUnitId,
    );
    if (!salesUnit) {
      throw new NotFoundException({
        success: false,
        message: "판매단위를 찾을 수 없습니다.",
        errors: [
          {
            field: "canonicalSalesUnitId",
            reason: "CANONICAL_SALES_UNIT_NOT_FOUND",
          },
        ],
      });
    }

    if (salesUnit.storeId !== storeId) {
      throw new BadRequestException({
        success: false,
        message: "같은 스토어의 판매단위만 연결할 수 있습니다.",
        errors: [
          { field: "canonicalSalesUnitId", reason: "CROSS_STORE_REFERENCE" },
        ],
      });
    }

    if (!salesUnit.isActive) {
      throw new BadRequestException({
        success: false,
        message: "비활성화된 판매단위에는 매핑할 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "INVALID_VALUE" }],
      });
    }

    this.storeService.ensureWritable(storeId);
    const timestamp = nowIso();
    const commitResult =
      await this.databaseService.saveAdCampaignMappingsCommitted({
        storeId,
        targetIds: dedupedIds,
        action: {
          type: "MANUAL_MAPPED",
          canonicalSalesUnitId: payload.canonicalSalesUnitId,
          timestamp,
        },
      });
    await this.recalculateProfitSummariesForAdDates(
      storeId,
      commitResult.affectedDates,
    );

    return { adCostIds: dedupedIds };
  }

  private async recalculateMappingsInternal(adCostIds: string[]) {
    const snapshot = this.databaseService.getSnapshot();
    const { dedupedIds, storeId } = this.resolveAdSignatureBatch(
      adCostIds,
      snapshot,
    );
    this.storeService.ensureWritable(storeId);
    const commitResult =
      await this.databaseService.saveAdCampaignMappingsCommitted({
        storeId,
        targetIds: dedupedIds,
        action: { type: "RECALCULATE" },
      });
    await this.recalculateProfitSummariesForAdDates(
      storeId,
      commitResult.affectedDates,
    );
    const nextSnapshot = this.databaseService.getSnapshot();
    const signaturesById = new Map(
      nextSnapshot.adCampaignSignatures.map((signature) => [
        signature.id,
        signature,
      ]),
    );
    const rowsById = new Map(
      nextSnapshot.adCampaignDailyCosts.map((row) => [row.id, row]),
    );
    const mappings = dedupedIds.map((id) => {
      const row = rowsById.get(id);
      const signature = signaturesById.get(row?.adCampaignSignatureId ?? id);
      return {
        adCostId: id,
        canonicalSalesUnitId:
          signature?.canonicalSalesUnitId ?? row?.canonicalSalesUnitId ?? null,
        mappingReason:
          signature?.mappingReason ?? row?.mappingReason ?? "NO_RULE",
        matchedRuleCount:
          signature?.matchedRuleCount ?? row?.matchedRuleCount ?? 0,
      };
    });

    return {
      adCostIds: dedupedIds,
      mappings,
    };
  }

  private async recalculateProfitSummariesForAdDates(
    storeId: string,
    affectedDates: string[],
  ) {
    const dates = Array.from(new Set(affectedDates.filter(Boolean))).sort(
      (left, right) => left.localeCompare(right),
    );
    if (dates.length === 0) {
      return;
    }

    await this.profitSummaryService?.refreshStoreDateListBestEffort({
      storeId,
      dates,
      reason: "MAPPING_CHANGE",
    });
  }

  private resolveAdCostBatch(
    adCostIds: string[],
    snapshot = this.databaseService.getSnapshot(),
  ) {
    const dedupedIds = Array.from(new Set(adCostIds.filter(Boolean)));
    if (!dedupedIds.length) {
      throw new BadRequestException({
        success: false,
        message: "수정할 광고 row를 하나 이상 선택해 주세요.",
        errors: [{ field: "adCostIds", reason: "INVALID_VALUE" }],
      });
    }

    const adCosts = dedupedIds.map((adCostId) => {
      const adCost = snapshot.adCampaignDailyCosts.find(
        (item) => item.id === adCostId,
      );
      if (!adCost) {
        throw new NotFoundException({
          success: false,
          message: "광고 row를 찾을 수 없습니다.",
          errors: [{ field: "adCostIds", reason: "MANUAL_OVERRIDE_NOT_FOUND" }],
        });
      }
      return adCost;
    });

    const storeIds = Array.from(new Set(adCosts.map((item) => item.storeId)));
    if (storeIds.length !== 1) {
      throw new BadRequestException({
        success: false,
        message: "같은 스토어의 광고 row만 함께 수정할 수 있습니다.",
        errors: [{ field: "adCostIds", reason: "CROSS_STORE_REFERENCE" }],
      });
    }

    return {
      dedupedIds,
      storeId: storeIds[0],
      adCosts,
    };
  }

  private resolveAdSignatureBatch(
    ids: string[],
    snapshot = this.databaseService.getSnapshot(),
  ) {
    const dedupedIds = Array.from(new Set(ids.filter(Boolean)));
    if (!dedupedIds.length) {
      throw new BadRequestException({
        success: false,
        message: "수정할 광고 캠페인을 하나 이상 선택해 주세요.",
        errors: [{ field: "adCostIds", reason: "INVALID_VALUE" }],
      });
    }

    const rowsById = new Map(
      snapshot.adCampaignDailyCosts.map((row) => [row.id, row]),
    );
    const signaturesById = new Map(
      snapshot.adCampaignSignatures.map((signature) => [
        signature.id,
        signature,
      ]),
    );
    const storeIds = new Set<string>();

    dedupedIds.forEach((id) => {
      const row = rowsById.get(id);
      const signature = signaturesById.get(id);
      if (!row && !signature) {
        throw new NotFoundException({
          success: false,
          message: "광고 캠페인을 찾을 수 없습니다.",
          errors: [{ field: "adCostIds", reason: "MANUAL_OVERRIDE_NOT_FOUND" }],
        });
      }
      if (row) {
        storeIds.add(row.storeId);
      }
      if (signature) {
        storeIds.add(signature.storeId);
      }
    });

    if (storeIds.size !== 1) {
      throw new BadRequestException({
        success: false,
        message: "같은 스토어의 광고 캠페인만 함께 수정할 수 있습니다.",
        errors: [{ field: "adCostIds", reason: "CROSS_STORE_REFERENCE" }],
      });
    }

    return {
      dedupedIds,
      storeId: Array.from(storeIds)[0],
    };
  }

  private parseCampaignRows(rows: string[][], header: string[]) {
    const headerIndex = new Map(header.map((value, index) => [value, index]));
    const getColumnIndex = (columnName: string) =>
      headerIndex.get(this.normalizeHeaderCell(columnName));
    const campaigns: AdUploadCampaign[] = [];

    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      const campaignId = repairMojibakeText(
        row[getColumnIndex("캠페인 ID")!] ?? "",
      ).trim();
      const campaignName = this.normalizeCampaignNameForStorage(
        repairMojibakeText(row[getColumnIndex("캠페인 이름")!] ?? ""),
      );

      if (!campaignId || campaignId.includes("결과")) {
        continue;
      }

      const nextRow = rows[index + 1] ?? [];
      const detailName = repairMojibakeText(
        nextRow[getColumnIndex("캠페인 이름")!] ?? "",
      );
      const weekday = WEEKDAYS.has(detailName) ? detailName : null;
      campaigns.push({
        campaignId,
        campaignName,
        weekday,
        adType: repairMojibakeText(row[getColumnIndex("광고 구분")!] ?? null),
        status: repairMojibakeText(row[getColumnIndex("상태")!] ?? null),
        totalCost: this.parseNumericCell(row[getColumnIndex("총비용")!] ?? 0),
        impressions: this.parseNumericCell(row[getColumnIndex("노출수")!] ?? 0),
        clicks: this.parseNumericCell(row[getColumnIndex("클릭수")!] ?? 0),
        totalConversions: this.parseNumericCell(
          row[getColumnIndex("총 전환수")!] ?? 0,
        ),
        totalConversionSales: this.parseNumericCell(
          row[getColumnIndex("총 전환매출액")!] ?? 0,
        ),
      });
    }

    return campaigns;
  }

  private async recalculateProfitSummaryForAdDate(
    storeId: string,
    reportDate: string,
  ) {
    await this.profitSummaryService?.refreshStoreDatesBestEffort({
      storeId,
      dateFrom: reportDate,
      dateTo: reportDate,
      reason: "AD_UPLOAD",
    });
  }

  private getActiveConfirmedRows(
    snapshot: DatabaseShape,
    storeId: string,
    reportDate: string,
  ) {
    const activeUploadIds = getActiveConfirmedUploadIds(
      snapshot,
      storeId,
      reportDate,
    );
    return snapshot.adCampaignDailyCosts.filter(
      (item) =>
        item.storeId === storeId &&
        item.reportDate === reportDate &&
        activeUploadIds.has(item.sourceUploadId),
    );
  }

  private assertNoDuplicateCampaignIds(
    campaignIds: string[],
    reason: string,
    fileName?: string,
  ) {
    const duplicateCampaignIds = this.findDuplicateCampaignIds(campaignIds);
    if (duplicateCampaignIds.length === 0) {
      return;
    }

    throw new BadRequestException({
      success: false,
      message: `파일 안에 같은 캠페인 ID가 중복되어 있습니다. (${this.summarizeCampaignIds(duplicateCampaignIds)})`,
      fileName,
      errors: [{ field: "campaignId", reason }],
    });
  }

  private assertNoCampaignIdOverlap(
    candidateCampaignIds: string[],
    activeConfirmedRows: AdCampaignDailyCost[] | Set<string>,
    reason: string,
    fileName?: string,
  ) {
    const activeConfirmedCampaignIds =
      activeConfirmedRows instanceof Set
        ? activeConfirmedRows
        : new Set(activeConfirmedRows.map((item) => item.campaignId.trim()));
    const duplicateCampaignIds = Array.from(
      new Set(
        candidateCampaignIds
          .map((campaignId) => campaignId.trim())
          .filter((campaignId) => activeConfirmedCampaignIds.has(campaignId)),
      ),
    );
    if (duplicateCampaignIds.length === 0) {
      return;
    }

    throw new BadRequestException({
      success: false,
      message: `같은 보고일에 이미 업로드된 캠페인 ID가 있습니다. (${this.summarizeCampaignIds(duplicateCampaignIds)})`,
      fileName,
      errors: [{ field: "campaignId", reason }],
    });
  }

  private findDuplicateCampaignIds(campaignIds: string[]) {
    const counts = new Map<string, number>();
    campaignIds.forEach((campaignId) => {
      counts.set(campaignId, (counts.get(campaignId) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([campaignId]) => campaignId)
      .sort((left, right) => left.localeCompare(right));
  }

  private summarizeCampaignIds(campaignIds: string[]) {
    const head = campaignIds.slice(0, 5).join(", ");
    return campaignIds.length > 5
      ? `${head} and ${campaignIds.length - 5} more`
      : head;
  }

  private describeWeekdayFailure(
    status: "MISSING" | "MULTIPLE" | "MISMATCH",
    detectedWeekdays: string[],
    reportDate: string,
  ): string {
    if (status === "MISSING") {
      return "엑셀에 요일 정보가 없습니다.";
    }
    if (status === "MULTIPLE") {
      return `여러 요일이 혼재되어 있습니다 (감지: ${detectedWeekdays.join(", ")}).`;
    }
    // MISMATCH
    const expected = getWeekdayNameKo(reportDate);
    return `reportDate(${reportDate}, ${expected})와 엑셀 요일(${detectedWeekdays[0]})이 일치하지 않습니다.`;
  }

  private normalizeHeaderCell(value: string | null | undefined) {
    return String(value ?? "")
      .replace(/\uFEFF/g, "")
      .trim();
  }

  private normalizeCampaignNameForStorage(value: string) {
    const trimmed = value.trim();
    const withoutDatePrefix = trimmed.replace(/^\d{4}_+/, "").trim();
    return withoutDatePrefix || trimmed;
  }

  private parseNumericCell(value: string | number | null | undefined) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : 0;
    }

    if (typeof value === "string") {
      const normalized = value.replace(/,/g, "").trim();
      if (!normalized) {
        return 0;
      }

      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
  }
}
