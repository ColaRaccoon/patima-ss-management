import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { AdCampaignDailyCost, AdExcelUpload, AdUploadPreviewRow, normalizeText } from "@patima/shared";
import * as XLSX from "xlsx";
import { AuditLogService } from "./audit-log.service";
import {
  evaluateAdMapping,
  getAdMappingOverride,
  getOverrideSnapshotHash,
  getRuleSnapshotHash,
  normalizeCampaignPattern,
} from "./ad-mapping-engine";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureStoreExists,
  formatApiSuccess,
  getAdMappingStatus,
  getWeekdayNameKo,
  hashBuffer,
  nowIso,
  paginate,
} from "./helpers";
import { OperationService } from "./operation.service";
import { StoreService } from "./store.service";

const REQUIRED_HEADERS = [
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
  ) {}

  onModuleInit(): void {
    this.operationService.registerRetryExecutor("AD_UPLOAD_CONFIRM", async (operation) => {
      const request = operation.requestJson as { uploadId: string; confirmReplace: boolean };
      return this.performConfirm(request.uploadId, request.confirmReplace);
    });
  }

  previewUpload(storeId: string, reportDate: string, file: Express.Multer.File) {
    this.storeService.ensureWritable(storeId);
    if (!file || !/\.xlsx$/i.test(file.originalname)) {
      throw new BadRequestException({
        success: false,
        message: "엑셀(.xlsx) 파일만 업로드할 수 있습니다.",
        errors: [{ field: "file", reason: "EXCEL_REQUIRED_COLUMNS_MISSING" }],
      });
    }

    const workbook = XLSX.read(file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false });
    const header = (rows[0] ?? []).map((value) => this.normalizeHeaderCell(value));

    REQUIRED_HEADERS.forEach((requiredHeader) => {
      if (!header.includes(this.normalizeHeaderCell(requiredHeader))) {
        throw new BadRequestException({
          success: false,
          message: "필수 엑셀 컬럼이 누락되었습니다.",
          errors: [{ field: requiredHeader, reason: "EXCEL_REQUIRED_COLUMNS_MISSING" }],
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
    const replacedUpload = snapshot.adExcelUploads.find(
      (item) => item.storeId === storeId && item.reportDate === reportDate && item.isActive,
    );

    const upload: AdExcelUpload = {
      id: createId(),
      storeId,
      sourceType: "NAVER_DA_XLSX",
      originalFileName: file.originalname,
      fileHash: hashBuffer(file.buffer),
      reportDate,
      detectedWeekday: detectedWeekdays[0] ?? null,
      weekdayValidationStatus,
      replacedUploadId: replacedUpload?.id ?? null,
      previewRuleSnapshotHash: getRuleSnapshotHash(snapshot, storeId),
      previewOverrideSnapshotHash: getOverrideSnapshotHash(snapshot, storeId),
      previewCreatedAt: nowIso(),
      previewExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      state: "PREVIEW_PARSED",
      isActive: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const previewRows: AdUploadPreviewRow[] = campaigns.map((campaign) => {
      const inheritedOverride =
        replacedUpload &&
        snapshot.adCampaignDailyCosts.find(
          (item) =>
            item.storeId === storeId &&
            item.sourceUploadId === replacedUpload.id &&
            item.reportDate === reportDate &&
            item.normalizedCampaignName === normalizeText(campaign.campaignName),
        );
      const mapping = evaluateAdMapping(
        snapshot,
        storeId,
        normalizeText(campaign.campaignName),
        inheritedOverride ? getAdMappingOverride(inheritedOverride) : null,
      );
      return {
        id: createId(),
        uploadId: upload.id,
        storeId,
        reportDate,
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        normalizedCampaignName: normalizeText(campaign.campaignName),
        weekday: campaign.weekday,
        adType: campaign.adType,
        status: campaign.status,
        totalCost: campaign.totalCost,
        impressions: campaign.impressions,
        clicks: campaign.clicks,
        totalConversions: campaign.totalConversions,
        totalConversionSales: campaign.totalConversionSales,
        matchedRuleCount: mapping.matchedRuleCount,
        canonicalSalesUnitId: mapping.canonicalSalesUnitId,
        mappingReason: mapping.mappingReason,
        reasonNote: mapping.reasonNote,
        reasonNoteInherited: mapping.reasonNoteInherited,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
    });

    this.databaseService.write((draft) => {
      draft.adExcelUploads.push(upload);
      draft.adUploadPreviewRows = draft.adUploadPreviewRows.filter((row) => row.uploadId !== upload.id);
      draft.adUploadPreviewRows.push(...previewRows);
    });

    this.auditLogService.record({
      storeId,
      domain: "AD_UPLOAD",
      action: "CREATE",
      targetId: upload.id,
      actorIdentifier: "LOCALHOST_ADMIN",
      beforeJson: null,
      afterJson: { reportDate, originalFileName: file.originalname },
    });

    return formatApiSuccess({
      uploadId: upload.id,
      reportDate,
      detectedWeekday: upload.detectedWeekday,
      weekdayValidationStatus,
      replaceTargetUploadId: replacedUpload?.id ?? null,
      previewState: upload.state,
      previewExpiresAt: upload.previewExpiresAt,
      ruleSnapshotHash: upload.previewRuleSnapshotHash,
      overrideSnapshotHash: upload.previewOverrideSnapshotHash,
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
      .sort((left, right) => left.campaignName.localeCompare(right.campaignName, "ko"));
    return formatApiSuccess(paginate(items, page, pageSize));
  }

  listUploads(storeId: string, page?: number, pageSize?: number) {
    const snapshot = this.databaseService.getSnapshot();
    const items = snapshot.adExcelUploads
      .filter((item) => item.storeId === storeId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((item) => ({
        uploadId: item.id,
        reportDate: item.reportDate,
        detectedWeekday: item.detectedWeekday,
        weekdayValidationStatus: item.weekdayValidationStatus,
        uploadStatus: item.state,
        isActive: item.isActive,
        replacedPreviousUpload: !!item.replacedUploadId,
        replacedUploadId: item.replacedUploadId,
      }));
    return formatApiSuccess(paginate(items, page, pageSize));
  }

  enqueueConfirm(uploadId: string, confirmReplace = false) {
    const snapshot = this.databaseService.getSnapshot();
    const upload = snapshot.adExcelUploads.find((item) => item.id === uploadId);
    if (!upload) {
      throw new NotFoundException({
        success: false,
        message: "업로드를 찾을 수 없습니다.",
        errors: [{ field: "uploadId", reason: "UPLOAD_NOT_FOUND" }],
      });
    }

    const operation = this.operationService.enqueue(
      upload.storeId,
      "AD_UPLOAD_CONFIRM",
      { uploadId, confirmReplace },
      () => this.performConfirm(uploadId, confirmReplace),
    );

    return formatApiSuccess({
      operationId: operation.id,
      operationType: operation.operationType,
      status: operation.status,
    });
  }

  async performConfirm(uploadId: string, confirmReplace: boolean) {
    const snapshot = this.databaseService.getSnapshot();
    const upload = snapshot.adExcelUploads.find((item) => item.id === uploadId);
    if (!upload) {
      throw new NotFoundException({
        success: false,
        message: "업로드를 찾을 수 없습니다.",
        errors: [{ field: "uploadId", reason: "UPLOAD_NOT_FOUND" }],
      });
    }

    const latestPreview = snapshot.adExcelUploads
      .filter((item) => item.storeId === upload.storeId && item.reportDate === upload.reportDate)
      .filter((item) => item.state === "PREVIEW_PARSED")
      .sort((left, right) => right.previewCreatedAt!.localeCompare(left.previewCreatedAt!))[0];

    if (!latestPreview || latestPreview.id !== upload.id) {
      throw new BadRequestException({
        success: false,
        message: "가장 최신 preview만 확정할 수 있습니다.",
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
    const currentReplaceTarget = snapshot.adExcelUploads.find(
      (item) =>
        item.storeId === upload.storeId &&
        item.reportDate === upload.reportDate &&
        item.isActive &&
        item.id !== upload.id,
    );

    if (
      upload.previewRuleSnapshotHash !== currentRuleHash ||
      upload.previewOverrideSnapshotHash !== currentOverrideHash ||
      (upload.replacedUploadId ?? null) !== (currentReplaceTarget?.id ?? null)
    ) {
      throw new BadRequestException({
        success: false,
        message: "preview 생성 이후 대상이 변경되어 다시 preview가 필요합니다.",
        errors: [{ field: "uploadId", reason: "AD_UPLOAD_PREVIEW_STALE" }],
      });
    }

    if (currentReplaceTarget && !confirmReplace) {
      throw new BadRequestException({
        success: false,
        message: "기존 업로드를 대체하려면 최종 확인이 필요합니다.",
        errors: [{ field: "confirmReplace", reason: "AD_UPLOAD_CONFIRMATION_REQUIRED" }],
      });
    }

    const previewRows = snapshot.adUploadPreviewRows.filter((item) => item.uploadId === upload.id);

    this.databaseService.write((draft) => {
      draft.adExcelUploads
        .filter(
          (item) =>
            item.storeId === upload.storeId &&
            item.reportDate === upload.reportDate &&
            item.isActive &&
            item.id !== upload.id,
        )
        .forEach((item) => {
          item.isActive = false;
          item.state = "REPLACED";
          item.updatedAt = nowIso();
        });

      draft.adCampaignDailyCosts = draft.adCampaignDailyCosts.filter((item) => item.sourceUploadId !== upload.id);
      previewRows.forEach((row) => {
        const confirmed: AdCampaignDailyCost = {
          ...row,
          sourceUploadId: upload.id,
        };
        draft.adCampaignDailyCosts.push(confirmed);
      });

      const target = draft.adExcelUploads.find((item) => item.id === upload.id)!;
      target.state = "CONFIRMED";
      target.isActive = true;
      target.updatedAt = nowIso();
    });

    this.auditLogService.record({
      storeId: upload.storeId,
      domain: "AD_UPLOAD",
      action: currentReplaceTarget ? "REPLACE" : "UPDATE",
      targetId: upload.id,
      actorIdentifier: "LOCALHOST_ADMIN",
      beforeJson: null,
      afterJson: {
        reportDate: upload.reportDate,
        replacedUploadId: currentReplaceTarget?.id ?? null,
      },
    });

    return {
      uploadId: upload.id,
      confirmedRowCount: previewRows.length,
      replacedUploadId: currentReplaceTarget?.id ?? null,
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
    const activeUploadIds = new Set(
      snapshot.adExcelUploads.filter((item) => item.storeId === query.storeId && item.isActive).map((item) => item.id),
    );

    const items = snapshot.adCampaignDailyCosts
      .filter((item) => item.storeId === query.storeId && activeUploadIds.has(item.sourceUploadId))
      .filter((item) => (query.dateFrom && query.dateTo ? item.reportDate >= query.dateFrom && item.reportDate <= query.dateTo : true))
      .filter((item) =>
        query.mappingStatus && query.mappingStatus !== "ALL"
          ? getAdMappingStatus(item) === query.mappingStatus
          : true,
      )
      .sort((left, right) => right.reportDate.localeCompare(left.reportDate));

    return formatApiSuccess(paginate(items, query.page, query.pageSize));
  }

  setIntentionalUnmapped(adCostId: string, payload: { reasonNote: string }) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.adCampaignDailyCosts.find((item) => item.id === adCostId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "광고 row를 찾을 수 없습니다.",
        errors: [{ field: "adCostId", reason: "MANUAL_OVERRIDE_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    this.databaseService.write((draft) => {
      const target = draft.adCampaignDailyCosts.find((item) => item.id === adCostId)!;
      target.canonicalSalesUnitId = null;
      target.matchedRuleCount = 0;
      target.mappingReason = "INTENTIONALLY_UNMAPPED";
      target.reasonNote = payload.reasonNote;
      target.reasonNoteInherited = false;
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      adCostId,
      mappingReason: "INTENTIONALLY_UNMAPPED",
      reasonNote: payload.reasonNote,
    });
  }

  saveManualMapping(adCostId: string, payload: { canonicalSalesUnitId: string }) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.adCampaignDailyCosts.find((item) => item.id === adCostId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "광고 row를 찾을 수 없습니다.",
        errors: [{ field: "adCostId", reason: "MANUAL_OVERRIDE_NOT_FOUND" }],
      });
    }

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

    if (salesUnit.storeId !== existing.storeId) {
      throw new BadRequestException({
        success: false,
        message: "같은 스토어의 판매단위만 연결할 수 있습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CROSS_STORE_REFERENCE" }],
      });
    }

    this.storeService.ensureWritable(existing.storeId);

    this.databaseService.write((draft) => {
      const target = draft.adCampaignDailyCosts.find((item) => item.id === adCostId)!;
      target.canonicalSalesUnitId = payload.canonicalSalesUnitId;
      target.matchedRuleCount = 0;
      target.mappingReason = "MANUAL_MAPPED";
      target.reasonNote = null;
      target.reasonNoteInherited = false;
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      adCostId,
      canonicalSalesUnitId: payload.canonicalSalesUnitId,
      mappingReason: "MANUAL_MAPPED",
    });
  }

  recalculateMapping(adCostId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.adCampaignDailyCosts.find((item) => item.id === adCostId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "광고 row를 찾을 수 없습니다.",
        errors: [{ field: "adCostId", reason: "MANUAL_OVERRIDE_NOT_FOUND" }],
      });
    }

    this.storeService.ensureWritable(existing.storeId);
    const mapping = evaluateAdMapping(snapshot, existing.storeId, existing.normalizedCampaignName);

    this.databaseService.write((draft) => {
      const target = draft.adCampaignDailyCosts.find((item) => item.id === adCostId)!;
      target.canonicalSalesUnitId = mapping.canonicalSalesUnitId;
      target.matchedRuleCount = mapping.matchedRuleCount;
      target.mappingReason = mapping.mappingReason;
      target.reasonNote = mapping.reasonNote;
      target.reasonNoteInherited = mapping.reasonNoteInherited;
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      adCostId,
      canonicalSalesUnitId: mapping.canonicalSalesUnitId,
      mappingReason: mapping.mappingReason,
      matchedRuleCount: mapping.matchedRuleCount,
    });
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
      const campaignId = row[getColumnIndex("캠페인 ID")!] ?? "";
      const campaignName = row[getColumnIndex("캠페인 이름")!] ?? "";

      if (!campaignId || campaignId.includes("결과")) {
        continue;
      }

      const nextRow = rows[index + 1] ?? [];
      const detailName = nextRow[getColumnIndex("캠페인 이름")!] ?? "";
      const weekday = WEEKDAYS.has(detailName) ? detailName : null;
      campaigns.push({
        campaignId,
        campaignName,
        weekday,
        adType: row[getColumnIndex("광고 구분")!] ?? null,
        status: row[getColumnIndex("상태")!] ?? null,
        totalCost: this.parseNumericCell(row[getColumnIndex("총비용")!] ?? 0),
        impressions: this.parseNumericCell(row[getColumnIndex("노출수")!] ?? 0),
        clicks: this.parseNumericCell(row[getColumnIndex("클릭수")!] ?? 0),
        totalConversions: this.parseNumericCell(row[getColumnIndex("총 전환수")!] ?? 0),
        totalConversionSales: this.parseNumericCell(row[getColumnIndex("총 전환매출액")!] ?? 0),
      });
    }

    return campaigns;
  }

  private normalizeHeaderCell(value: string | null | undefined) {
    return String(value ?? "")
      .replace(/\uFEFF/g, "")
      .trim();
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
