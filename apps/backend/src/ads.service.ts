import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import {
  AdCampaignDailyCost,
  AdExcelUpload,
  AdUploadPreviewRow,
  DatabaseShape,
  normalizeText,
} from "@patima/shared";
import * as XLSX from "xlsx";
import { AuditLogService } from "./audit-log.service";
import {
  applyAdCampaignSignatureToRows,
  ensureAdCampaignSignaturesForStore,
  getOverrideSnapshotHash,
  getRuleSnapshotHash,
  recalculateAdCampaignSignaturesForStore,
  refreshAdCampaignSignatureSummaries,
  upsertAdCampaignSignature,
} from "./ad-mapping-engine";
import { DatabaseService } from "./database.service";
import {
  createId,
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

const WEEKDAYS = new Set(["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"]);

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
    this.operationService.registerRetryExecutor("AD_UPLOAD_CONFIRM", async (operation) => {
      const request = operation.requestJson as { uploadId: string };
      return this.performConfirm(request.uploadId);
    });
  }

  async previewUpload(storeId: string, reportDate: string, file: Express.Multer.File) {
    this.storeService.ensureWritable(storeId);
    const originalFileName = repairMojibakeText(file?.originalname);
    if (!file || !/\.xlsx$/i.test(originalFileName)) {
      throw new BadRequestException({
        success: false,
        message: "엑셀(.xlsx) 파일만 업로드할 수 있습니다.",
        errors: [{ field: "file", reason: "EXCEL_REQUIRED_COLUMNS_MISSING" }],
        fileName: originalFileName,
      });
    }

    const workbook = XLSX.read(file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false });
    const header = (rows[0] ?? []).map((value) => this.normalizeHeaderCell(value));

    AD_UPLOAD_REQUIRED_HEADERS.forEach((requiredHeader) => {
      if (!header.includes(this.normalizeHeaderCell(requiredHeader))) {
        throw new BadRequestException({
          success: false,
          message: "필수 엑셀 컬럼이 누락되었습니다.",
          errors: [{ field: requiredHeader, reason: "EXCEL_REQUIRED_COLUMNS_MISSING" }],
          fileName: originalFileName,
        });
      }
    });

    const campaigns = this.parseCampaignRows(rows, header);
    const detectedWeekdays = Array.from(new Set(campaigns.map((item) => item.weekday).filter(Boolean))) as string[];

    let weekdayValidationStatus: AdExcelUpload["weekdayValidationStatus"] = "PASSED";
    if (detectedWeekdays.length === 0) {
      weekdayValidationStatus = "MISSING";
    } else if (detectedWeekdays.length > 1) {
      weekdayValidationStatus = "MULTIPLE";
    } else if (detectedWeekdays[0] !== getWeekdayNameKo(reportDate)) {
      weekdayValidationStatus = "MISMATCH";
    }

    const snapshot = this.databaseService.getSnapshot();
    const activeConfirmedRows = this.getActiveConfirmedRows(snapshot, storeId, reportDate);
    const campaignIds = campaigns.map((campaign) => campaign.campaignId);
    this.assertNoDuplicateCampaignIds(campaignIds, "AD_UPLOAD_DUPLICATE_IN_FILE");
    this.assertNoCampaignIdOverlap(
      campaignIds,
      activeConfirmedRows,
      "AD_UPLOAD_DUPLICATE_WITH_ACTIVE_UPLOAD",
    );

    // 요일 검증 실패 시 즉시 예외 던지기
    if (weekdayValidationStatus !== "PASSED") {
      throw new BadRequestException({
        success: false,
        message: this.describeWeekdayFailure(weekdayValidationStatus, detectedWeekdays, reportDate),
        errors: [{ field: "file", reason: "AD_UPLOAD_WEEKDAY_VALIDATION_FAILED" }],
        fileName: originalFileName,
        weekdayValidationStatus,
        detectedWeekday: detectedWeekdays[0] ?? null,
      });
    }

    const upload: AdExcelUpload = {
      id: createId(),
      storeId,
      sourceType: "NAVER_DA_XLSX",
      originalFileName,
      fileHash: hashBuffer(file.buffer),
      reportDate,
      detectedWeekday: detectedWeekdays[0] ?? null,
      weekdayValidationStatus,
      replacedUploadId: null,
      previewRuleSnapshotHash: getRuleSnapshotHash(snapshot, storeId),
      previewOverrideSnapshotHash: getOverrideSnapshotHash(snapshot, storeId),
      previewCreatedAt: nowIso(),
      previewExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      state: "CONFIRMED",
      isActive: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const confirmedRows: AdCampaignDailyCost[] = [];

    await this.databaseService.writeCommitted((draft) => {
      const touchedSignatureIds = new Set<string>();
      draft.adExcelUploads.push(upload);
      campaigns.forEach((campaign) => {
        const normalizedCampaignName = normalizeText(campaign.campaignName);
        const signature = upsertAdCampaignSignature(draft, {
          storeId,
          campaignId: campaign.campaignId,
          campaignName: campaign.campaignName,
          normalizedCampaignName,
          reportDate,
        });
        touchedSignatureIds.add(signature.id);
        const confirmed: AdCampaignDailyCost = {
          id: createId(),
          uploadId: upload.id,
          sourceUploadId: upload.id,
          adCampaignSignatureId: signature.id,
          storeId,
          reportDate,
          campaignId: campaign.campaignId,
          campaignName: campaign.campaignName,
          normalizedCampaignName,
          weekday: campaign.weekday,
          adType: campaign.adType,
          status: campaign.status,
          totalCost: campaign.totalCost,
          impressions: campaign.impressions,
          clicks: campaign.clicks,
          totalConversions: campaign.totalConversions,
          totalConversionSales: campaign.totalConversionSales,
          matchedRuleCount: signature.matchedRuleCount,
          canonicalSalesUnitId: signature.canonicalSalesUnitId,
          mappingReason: signature.mappingReason,
          reasonNote: signature.reasonNote,
          reasonNoteInherited: signature.reasonNoteInherited,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        confirmedRows.push(confirmed);
        draft.adCampaignDailyCosts.push(confirmed);
      });
      recalculateAdCampaignSignaturesForStore(draft, storeId, {
        signatureIds: touchedSignatureIds,
        applyToRowsFrom: reportDate,
        applyToRowsTo: reportDate,
      });
      this.auditLogService.appendToDraft(draft, {
        storeId,
        domain: "AD_UPLOAD",
        action: "CREATE",
        targetId: upload.id,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: null,
        afterJson: { reportDate, originalFileName, confirmedRowCount: confirmedRows.length },
      });
    });

    await this.recalculateProfitSummaryForAdDate(storeId, reportDate);

    return formatApiSuccess({
      uploadId: upload.id,
      reportDate,
      detectedWeekday: upload.detectedWeekday,
      weekdayValidationStatus,
      status: "CONFIRMED",
      confirmedRowCount: confirmedRows.length,
    });
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
      .sort((left, right) => left.campaignName.localeCompare(right.campaignName, "ko"))
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

    const previewRowCount = snapshot.adUploadPreviewRows.filter((item) => item.uploadId === upload.id).length;
    const adCostCount = snapshot.adCampaignDailyCosts.filter((item) => item.sourceUploadId === upload.id).length;
    const previousState = upload.state;
    const wasActive = upload.isActive;

    await this.databaseService.writeCommitted((draft) => {
      const affectedSignatureIds = new Set(
        draft.adCampaignDailyCosts
          .filter((item) => item.sourceUploadId === upload.id && item.adCampaignSignatureId)
          .map((item) => item.adCampaignSignatureId!),
      );
      draft.adUploadPreviewRows = draft.adUploadPreviewRows.filter((item) => item.uploadId !== upload.id);
      draft.adCampaignDailyCosts = draft.adCampaignDailyCosts.filter((item) => item.sourceUploadId !== upload.id);
      refreshAdCampaignSignatureSummaries(draft, {
        storeId: upload.storeId,
        signatureIds: affectedSignatureIds,
      });

      const target = draft.adExcelUploads.find((item) => item.id === upload.id)!;
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

    await this.recalculateProfitSummaryForAdDate(upload.storeId, upload.reportDate);

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
        errors: [{ field: "uploadId", reason: "AD_UPLOAD_CONFIRMATION_REQUIRED" }],
      });
    }

    const currentRuleHash = getRuleSnapshotHash(snapshot, upload.storeId);
    const currentOverrideHash = getOverrideSnapshotHash(snapshot, upload.storeId);

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

    const previewRows = snapshot.adUploadPreviewRows.filter((item) => item.uploadId === upload.id);
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
      draft.adCampaignDailyCosts = draft.adCampaignDailyCosts.filter((item) => item.sourceUploadId !== upload.id);
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

      const target = draft.adExcelUploads.find((item) => item.id === upload.id)!;
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

    await this.recalculateProfitSummaryForAdDate(upload.storeId, upload.reportDate);

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
    const activeUploadIds = getActiveConfirmedUploadIds(snapshot, query.storeId);

    const items = snapshot.adCampaignDailyCosts
      .filter((item) => item.storeId === query.storeId && activeUploadIds.has(item.sourceUploadId))
      .filter((item) => (query.dateFrom && query.dateTo ? item.reportDate >= query.dateFrom && item.reportDate <= query.dateTo : true))
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
      items: result.items.map(({ signature, latestRow, totalCost, rowCount }) => ({
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
      })),
    });
  }

  async setIntentionalUnmapped(adCostId: string, payload: { reasonNote: string }) {
    await this.setIntentionalUnmappedInternal([adCostId], payload);

    return formatApiSuccess({
      adCostId,
      mappingReason: "INTENTIONALLY_UNMAPPED",
      reasonNote: payload.reasonNote,
    });
  }

  async setIntentionalUnmappedMany(adCostIds: string[], payload: { reasonNote: string }) {
    const result = await this.setIntentionalUnmappedInternal(adCostIds, payload);
    return formatApiSuccess({
      adCostIds: result.adCostIds,
      updatedCount: result.adCostIds.length,
      mappingReason: "INTENTIONALLY_UNMAPPED",
      reasonNote: payload.reasonNote,
    });
  }

  async saveManualMapping(adCostId: string, payload: { canonicalSalesUnitId: string }) {
    await this.saveManualMappingsInternal([adCostId], payload);
    return formatApiSuccess({
      adCostId,
      canonicalSalesUnitId: payload.canonicalSalesUnitId,
      mappingReason: "MANUAL_MAPPED",
    });
  }

  async saveManualMappings(adCostIds: string[], payload: { canonicalSalesUnitId: string }) {
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

  private async setIntentionalUnmappedInternal(adCostIds: string[], payload: { reasonNote: string }) {
    const { dedupedIds, storeId } = this.resolveAdSignatureBatch(adCostIds);
    this.storeService.ensureWritable(storeId);
    const timestamp = nowIso();
    let targetSignatureIds = new Set<string>();
    await this.databaseService.writeCommitted((draft) => {
      targetSignatureIds = this.materializeAdCampaignSignatureIds(draft, storeId, dedupedIds);
      draft.adCampaignSignatures.forEach((signature) => {
        if (!targetSignatureIds.has(signature.id)) {
          return;
        }
        signature.canonicalSalesUnitId = null;
        signature.matchedRuleCount = 0;
        signature.mappingReason = "INTENTIONALLY_UNMAPPED";
        signature.reasonNote = payload.reasonNote;
        signature.reasonNoteInherited = false;
        signature.confirmedAt = timestamp;
        signature.updatedAt = timestamp;
      });
      applyAdCampaignSignatureToRows(draft, {
        storeId,
        signatureIds: targetSignatureIds,
      });
    });
    await this.recalculateProfitSummariesForAdIdentifiers(storeId, dedupedIds, targetSignatureIds);

    return { adCostIds: dedupedIds };
  }

  private async saveManualMappingsInternal(adCostIds: string[], payload: { canonicalSalesUnitId: string }) {
    const snapshot = this.databaseService.getSnapshot();
    const { dedupedIds, storeId } = this.resolveAdSignatureBatch(adCostIds, snapshot);
    const salesUnit = snapshot.canonicalSalesUnits.find(
      (item) => item.id === payload.canonicalSalesUnitId,
    );
    if (!salesUnit) {
      throw new NotFoundException({
        success: false,
        message: "판매단위를 찾을 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }

    if (salesUnit.storeId !== storeId) {
      throw new BadRequestException({
        success: false,
        message: "같은 스토어의 판매단위만 연결할 수 있습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CROSS_STORE_REFERENCE" }],
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
    let targetSignatureIds = new Set<string>();
    await this.databaseService.writeCommitted((draft) => {
      targetSignatureIds = this.materializeAdCampaignSignatureIds(draft, storeId, dedupedIds);
      draft.adCampaignSignatures.forEach((signature) => {
        if (!targetSignatureIds.has(signature.id)) {
          return;
        }
        signature.canonicalSalesUnitId = payload.canonicalSalesUnitId;
        signature.matchedRuleCount = 0;
        signature.mappingReason = "MANUAL_MAPPED";
        signature.reasonNote = null;
        signature.reasonNoteInherited = false;
        signature.confirmedAt = timestamp;
        signature.updatedAt = timestamp;
      });
      applyAdCampaignSignatureToRows(draft, {
        storeId,
        signatureIds: targetSignatureIds,
      });
    });
    await this.recalculateProfitSummariesForAdIdentifiers(storeId, dedupedIds, targetSignatureIds);

    return { adCostIds: dedupedIds };
  }

  private async recalculateMappingsInternal(adCostIds: string[]) {
    const snapshot = this.databaseService.getSnapshot();
    const { dedupedIds, storeId } = this.resolveAdSignatureBatch(adCostIds, snapshot);
    this.storeService.ensureWritable(storeId);
    let targetSignatureIds = new Set<string>();
    await this.databaseService.writeCommitted((draft) => {
      targetSignatureIds = this.materializeAdCampaignSignatureIds(draft, storeId, dedupedIds);
      recalculateAdCampaignSignaturesForStore(draft, storeId, {
        signatureIds: targetSignatureIds,
        applyToRows: true,
      });
    });
    await this.recalculateProfitSummariesForAdIdentifiers(storeId, dedupedIds, targetSignatureIds);
    const nextSnapshot = this.databaseService.getSnapshot();
    const signaturesById = new Map(nextSnapshot.adCampaignSignatures.map((signature) => [signature.id, signature]));
    const rowsById = new Map(nextSnapshot.adCampaignDailyCosts.map((row) => [row.id, row]));
    const mappings = dedupedIds.map((id) => {
      const row = rowsById.get(id);
      const signature = signaturesById.get(row?.adCampaignSignatureId ?? id);
      return {
        adCostId: id,
        canonicalSalesUnitId: signature?.canonicalSalesUnitId ?? row?.canonicalSalesUnitId ?? null,
        mappingReason: signature?.mappingReason ?? row?.mappingReason ?? "NO_RULE",
        matchedRuleCount: signature?.matchedRuleCount ?? row?.matchedRuleCount ?? 0,
      };
    });

    return {
      adCostIds: dedupedIds,
      mappings,
    };
  }

  private async recalculateProfitSummariesForAdIdentifiers(
    storeId: string,
    ids: string[],
    signatureIds: Set<string>,
  ) {
    const idSet = new Set(ids);
    const dates = this.databaseService
      .getSnapshot()
      .adCampaignDailyCosts.filter(
        (item) =>
          item.storeId === storeId &&
          (idSet.has(item.id) ||
            (item.adCampaignSignatureId ? signatureIds.has(item.adCampaignSignatureId) : false) ||
            signatureIds.has(item.id)),
      )
      .map((item) => item.reportDate);

    await this.profitSummaryService?.refreshStoreDateListBestEffort({
      storeId,
      dates,
      reason: "MAPPING_CHANGE",
    });
  }

  private resolveAdCostBatch(adCostIds: string[], snapshot = this.databaseService.getSnapshot()) {
    const dedupedIds = Array.from(new Set(adCostIds.filter(Boolean)));
    if (!dedupedIds.length) {
      throw new BadRequestException({
        success: false,
        message: "수정할 광고 row를 하나 이상 선택해 주세요.",
        errors: [{ field: "adCostIds", reason: "INVALID_VALUE" }],
      });
    }

    const adCosts = dedupedIds.map((adCostId) => {
      const adCost = snapshot.adCampaignDailyCosts.find((item) => item.id === adCostId);
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

  private resolveAdSignatureBatch(ids: string[], snapshot = this.databaseService.getSnapshot()) {
    const dedupedIds = Array.from(new Set(ids.filter(Boolean)));
    if (!dedupedIds.length) {
      throw new BadRequestException({
        success: false,
        message: "수정할 광고 캠페인을 하나 이상 선택해 주세요.",
        errors: [{ field: "adCostIds", reason: "INVALID_VALUE" }],
      });
    }

    const rowsById = new Map(snapshot.adCampaignDailyCosts.map((row) => [row.id, row]));
    const signaturesById = new Map(snapshot.adCampaignSignatures.map((signature) => [signature.id, signature]));
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

  private materializeAdCampaignSignatureIds(
    draft: DatabaseShape,
    storeId: string,
    ids: string[],
  ): Set<string> {
    const directSignatureIds = new Set(
      ids.filter((id) => draft.adCampaignSignatures.some((signature) => signature.id === id)),
    );
    const rowIds = ids.filter((id) => draft.adCampaignDailyCosts.some((row) => row.id === id));
    const materializedFromRows = ensureAdCampaignSignaturesForStore(draft, storeId, rowIds);

    draft.adCampaignDailyCosts.forEach((row) => {
      if (row.storeId === storeId && rowIds.includes(row.id) && row.adCampaignSignatureId) {
        materializedFromRows.add(row.adCampaignSignatureId);
      }
    });

    return new Set([...directSignatureIds, ...materializedFromRows]);
  }

  private parseCampaignRows(rows: string[][], header: string[]) {
    const headerIndex = new Map(header.map((value, index) => [value, index]));
    const getColumnIndex = (columnName: string) => headerIndex.get(this.normalizeHeaderCell(columnName));
    const campaigns: Array<{
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
    }> = [];

    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      const campaignId = repairMojibakeText(row[getColumnIndex("캠페인 ID")!] ?? "");
      const campaignName = this.normalizeCampaignNameForStorage(
        repairMojibakeText(row[getColumnIndex("캠페인 이름")!] ?? ""),
      );

      if (!campaignId || campaignId.includes("결과")) {
        continue;
      }

      const nextRow = rows[index + 1] ?? [];
      const detailName = repairMojibakeText(nextRow[getColumnIndex("캠페인 이름")!] ?? "");
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
        totalConversions: this.parseNumericCell(row[getColumnIndex("총 전환수")!] ?? 0),
        totalConversionSales: this.parseNumericCell(row[getColumnIndex("총 전환매출액")!] ?? 0),
      });
    }

    return campaigns;
  }

  private async recalculateProfitSummaryForAdDate(storeId: string, reportDate: string) {
    await this.profitSummaryService?.refreshStoreDatesBestEffort({
      storeId,
      dateFrom: reportDate,
      dateTo: reportDate,
      reason: "AD_UPLOAD",
    });
  }

  private getActiveConfirmedRows(snapshot: DatabaseShape, storeId: string, reportDate: string) {
    const activeUploadIds = getActiveConfirmedUploadIds(snapshot, storeId, reportDate);
    return snapshot.adCampaignDailyCosts
      .filter(
        (item) =>
          item.storeId === storeId &&
          item.reportDate === reportDate &&
          activeUploadIds.has(item.sourceUploadId),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private assertNoDuplicateCampaignIds(campaignIds: string[], reason: string) {
    const duplicateCampaignIds = this.findDuplicateCampaignIds(campaignIds);
    if (duplicateCampaignIds.length === 0) {
      return;
    }

    throw new BadRequestException({
      success: false,
      message: `Duplicate campaignId values are not allowed in one upload. (${this.summarizeCampaignIds(duplicateCampaignIds)})`,
      errors: [{ field: "campaignId", reason }],
    });
  }

  private assertNoCampaignIdOverlap(
    candidateCampaignIds: string[],
    activeConfirmedRows: AdCampaignDailyCost[],
    reason: string,
  ) {
    const activeConfirmedCampaignIds = new Set(activeConfirmedRows.map((item) => item.campaignId));
    const duplicateCampaignIds = Array.from(
      new Set(candidateCampaignIds.filter((campaignId) => activeConfirmedCampaignIds.has(campaignId))),
    );
    if (duplicateCampaignIds.length === 0) {
      return;
    }

    throw new BadRequestException({
      success: false,
      message: `campaignId already exists in active confirmed uploads for this date. (${this.summarizeCampaignIds(duplicateCampaignIds)})`,
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
    return campaignIds.length > 5 ? `${head} and ${campaignIds.length - 5} more` : head;
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
