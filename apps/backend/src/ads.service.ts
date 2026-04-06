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
  evaluateAdMapping,
  getAdMappingOverride,
  getOverrideSnapshotHash,
  getRuleSnapshotHash,
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
  ) {}

  onModuleInit(): void {
    this.operationService.registerRetryExecutor("AD_UPLOAD_CONFIRM", async (operation) => {
      const request = operation.requestJson as { uploadId: string };
      return this.performConfirm(request.uploadId);
    });
  }

  previewUpload(storeId: string, reportDate: string, file: Express.Multer.File) {
    this.storeService.ensureWritable(storeId);
    const originalFileName = repairMojibakeText(file?.originalname);
    if (!file || !/\.xlsx$/i.test(originalFileName)) {
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

    AD_UPLOAD_REQUIRED_HEADERS.forEach((requiredHeader) => {
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
    const activeConfirmedRows = this.getActiveConfirmedRows(snapshot, storeId, reportDate);
    this.assertNoDuplicateCampaignIds(
      campaigns.map((campaign) => campaign.campaignId),
      "AD_UPLOAD_DUPLICATE_IN_FILE",
    );
    this.assertNoCampaignIdOverlap(
      campaigns.map((campaign) => campaign.campaignId),
      activeConfirmedRows,
      "AD_UPLOAD_DUPLICATE_WITH_ACTIVE_UPLOAD",
    );

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
      state: "PREVIEW_PARSED",
      isActive: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const previewRows: AdUploadPreviewRow[] = campaigns.map((campaign) => {
      const normalizedCampaignName = normalizeText(campaign.campaignName);
      const inheritedOverride = this.findInheritedOverride(
        activeConfirmedRows,
        campaign.campaignId,
        normalizedCampaignName,
      );
      const mapping = evaluateAdMapping(
        snapshot,
        storeId,
        normalizedCampaignName,
        inheritedOverride ? getAdMappingOverride(inheritedOverride) : null,
      );
      return {
        id: createId(),
        uploadId: upload.id,
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
      afterJson: { reportDate, originalFileName },
    });

    return formatApiSuccess({
      uploadId: upload.id,
      reportDate,
      detectedWeekday: upload.detectedWeekday,
      weekdayValidationStatus,
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

  deleteUpload(uploadId: string) {
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

    this.databaseService.write((draft) => {
      draft.adUploadPreviewRows = draft.adUploadPreviewRows.filter((item) => item.uploadId !== upload.id);
      draft.adCampaignDailyCosts = draft.adCampaignDailyCosts.filter((item) => item.sourceUploadId !== upload.id);

      const target = draft.adExcelUploads.find((item) => item.id === upload.id)!;
      target.state = "DELETED";
      target.isActive = false;
      target.updatedAt = nowIso();
    });

    this.auditLogService.record({
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

    return formatApiSuccess({
      uploadId: upload.id,
      previousState,
      previewRowCount,
      adCostCount,
    });
  }

  enqueueConfirm(uploadId: string) {
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

    this.databaseService.write((draft) => {
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
      action: "UPDATE",
      targetId: upload.id,
      actorIdentifier: "LOCALHOST_ADMIN",
      beforeJson: null,
      afterJson: {
        reportDate: upload.reportDate,
        confirmedRowCount: previewRows.length,
      },
    });

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
      const campaignId = repairMojibakeText(row[getColumnIndex("캠페인 ID")!] ?? "");
      const campaignName = repairMojibakeText(row[getColumnIndex("캠페인 이름")!] ?? "");

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

  private findInheritedOverride(
    activeConfirmedRows: AdCampaignDailyCost[],
    campaignId: string,
    normalizedCampaignName: string,
  ) {
    const matchedByCampaignId = activeConfirmedRows.find((item) => item.campaignId === campaignId);
    if (matchedByCampaignId) {
      return matchedByCampaignId;
    }

    const matchedByName = activeConfirmedRows.filter(
      (item) => item.normalizedCampaignName === normalizedCampaignName,
    );
    return matchedByName.length === 1 ? matchedByName[0] : null;
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
