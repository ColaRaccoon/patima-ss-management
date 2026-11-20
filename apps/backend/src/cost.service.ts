import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  CanonicalSalesUnit,
  CostSnapshotPreview,
  DatabaseShape,
  SalesUnitCostSetting,
  SalesUnitCostSnapshot,
  SalesUnitCostSnapshotEntry,
} from "@patima/shared";
import * as XLSX from "xlsx";
import { AuditLogService } from "./audit-log.service";
import { buildCostSettingRecord, validateCostSettingValues } from "./cost-setting-record";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureNoCrossStoreReference,
  ensureDateString,
  getCostSettingForDate,
  formatApiSuccess,
  nowIso,
  repairMojibakeText,
} from "./helpers";
import { ProfitSummaryService } from "./profit-summary.service";
import { SalesUnitService } from "./sales-unit.service";
import { StoreService } from "./store.service";

type SnapshotCost = NonNullable<CostSnapshotPreview["created"][number]["cost"]>;

interface ParsedCostRow {
  row: number;
  salesUnitId: string;
  displayName: string;
  matchAliases: string | null;
  linkedProductIds: string | null;
  linkedOptionCodes: string | null;
  linkedManageCodes: string | null;
  memo: string | null;
  unitCost: number | null;
  feeRate: number | null;
  otherCost: number | null;
}

function snapshotCostValues(cost: SnapshotCost | null): SnapshotCost | null {
  return cost && { unitCost: cost.unitCost, feeRate: cost.feeRate, otherCost: cost.otherCost };
}

function incomingSnapshotCost(row?: ParsedCostRow): SnapshotCost | null {
  return row?.unitCost == null ? null : {
    unitCost: row.unitCost,
    feeRate: row.feeRate,
    otherCost: row.otherCost ?? 0,
  };
}

function excelMetadataPatch(row: ParsedCostRow) {
  const { displayName, matchAliases, linkedProductIds, linkedOptionCodes, linkedManageCodes, memo } = row;
  const split = (value: string) => value.split(",").map((item) => item.trim());
  return {
    ...(displayName && { displayName }),
    ...(matchAliases && { matchAliases: split(matchAliases) }),
    ...(linkedProductIds && { linkedProductIds: split(linkedProductIds) }),
    ...(linkedOptionCodes && { linkedOptionCodes: split(linkedOptionCodes) }),
    ...(linkedManageCodes && { linkedManageCodes: split(linkedManageCodes) }),
    ...(memo !== null && { memo }),
  };
}

function buildSnapshotPreviewContext(database: DatabaseShape, storeId: string, effectiveFrom: string, file: Express.Multer.File) {
  const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
  const units = database.canonicalSalesUnits.filter((unit) => unit.storeId === storeId).sort(byId);
  const snapshots = database.salesUnitCostSnapshots
    .filter((snapshot) => snapshot.storeId === storeId)
    .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom) || byId(left, right));
  const baseline = snapshots.filter((snapshot) => snapshot.effectiveFrom <= effectiveFrom).at(-1);
  const entries = baseline
    ? database.salesUnitCostSnapshotEntries.filter((entry) => entry.snapshotId === baseline.id).sort(byId)
    : [];
  const settings = database.salesUnitCostSettings
    .filter((setting) => setting.storeId === storeId && setting.isActive && setting.effectiveFrom <= effectiveFrom)
    .sort(byId);
  const token = createHash("sha256")
    .update(JSON.stringify([storeId, effectiveFrom, file.originalname, units, snapshots, entries, settings]))
    .update(file.buffer)
    .digest("hex");
  return { units, snapshots, baseline, entries, settings, token };
}

const countPaymentDatesBefore = (dates: string[], boundary: string, includeBoundary = false) => {
  let start = 0;
  let end = dates.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    if (dates[middle] < boundary || (includeBoundary && dates[middle] === boundary)) {
      start = middle + 1;
    } else {
      end = middle;
    }
  }
  return start;
};

@Injectable()
export class CostService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly auditLogService: AuditLogService,
    private readonly salesUnitService: SalesUnitService,
    private readonly profitSummaryService?: ProfitSummaryService,
  ) {}

  list(storeId: string, canonicalSalesUnitId?: string) {
    const snapshot = this.databaseService.getSnapshot();
    const settings = snapshot.salesUnitCostSettings.filter((item) =>
      item.storeId === storeId && (!canonicalSalesUnitId || item.canonicalSalesUnitId === canonicalSalesUnitId));
    const datesByUnit = new Map<string, string[]>();
    for (const setting of settings) datesByUnit.set(setting.canonicalSalesUnitId, []);
    if (datesByUnit.size > 0) {
      for (const orderItem of snapshot.orderItems) {
        if (orderItem.storeId !== storeId || !orderItem.paymentDate || !orderItem.canonicalSalesUnitId) continue;
        datesByUnit.get(orderItem.canonicalSalesUnitId)?.push(orderItem.paymentDate);
      }
      for (const dates of datesByUnit.values()) dates.sort();
    }
    const items = settings.sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))
      .map((item) => {
        const dates = datesByUnit.get(item.canonicalSalesUnitId)!;
        const from = countPaymentDatesBefore(dates, item.effectiveFrom);
        const to = item.effectiveTo
          ? countPaymentDatesBefore(dates, item.effectiveTo, true)
          : dates.length;
        const appliedOrderItemCount = Math.max(0, to - from);

        return {
          ...item,
          appliedOrderItemCount,
          canEdit: appliedOrderItemCount === 0 && item.isActive,
          canClose: item.isActive,
          canDeactivate: appliedOrderItemCount === 0 && item.isActive,
          blockingReason: appliedOrderItemCount > 0 ? "ALREADY_APPLIED" : item.isActive ? null : "ALREADY_INACTIVE",
        };
      });

    return formatApiSuccess(items);
  }

  async create(payload: {
    storeId: string;
    canonicalSalesUnitId: string;
    unitCost: number;
    feeRate: number | null;
    otherCost: number;
    effectiveFrom: string;
  }) {
    this.storeService.ensureWritable(payload.storeId);
    ensureDateString(payload.effectiveFrom, "effectiveFrom");
    const snapshot = this.databaseService.getSnapshot();
    const salesUnit = snapshot.canonicalSalesUnits.find((item) => item.id === payload.canonicalSalesUnitId);
    if (!salesUnit) {
      throw new NotFoundException({
        success: false,
        message: "표준 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    ensureNoCrossStoreReference(payload.storeId, salesUnit.storeId, "canonicalSalesUnitId");
    validateCostSettingValues(payload.unitCost, payload.otherCost, payload.feeRate);

    const activeRows = snapshot.salesUnitCostSettings
      .filter(
        (item) =>
          item.storeId === payload.storeId &&
          item.canonicalSalesUnitId === payload.canonicalSalesUnitId &&
          item.isActive,
      )
      .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));

    const sameStart = activeRows.find((item) => item.effectiveFrom === payload.effectiveFrom);
    if (sameStart) {
      throw new BadRequestException({
        success: false,
        message: "같은 시작일 비용 row가 이미 존재합니다.",
        errors: [{ field: "effectiveFrom", reason: "COST_PERIOD_OVERLAP" }],
      });
    }

    const previousRow = activeRows
      .filter((item) => item.effectiveFrom < payload.effectiveFrom)
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
    const nextRow = activeRows
      .filter((item) => item.effectiveFrom > payload.effectiveFrom)
      .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom))[0];

    if (nextRow && payload.effectiveFrom >= nextRow.effectiveFrom) {
      throw new BadRequestException({
        success: false,
        message: "다음 비용 구간과 충돌합니다.",
        errors: [{ field: "effectiveFrom", reason: "COST_PERIOD_OVERLAP" }],
      });
    }

    if (previousRow?.effectiveTo && payload.effectiveFrom <= previousRow.effectiveTo) {
      throw new BadRequestException({
        success: false,
        message: "기존 비용 기간 한가운데 삽입할 수 없습니다.",
        errors: [{ field: "effectiveFrom", reason: "COST_PERIOD_SPLIT_NOT_SUPPORTED" }],
      });
    }

    const created = buildCostSettingRecord(payload, nowIso(), nextRow ? this.minusOneDay(nextRow.effectiveFrom) : null);

    await this.databaseService.writeCommitted((draft) => {
      const previous = draft.salesUnitCostSettings.find((item) => item.id === previousRow?.id);
      if (previous && !previous.effectiveTo) {
        previous.costValuesUpdatedAt ??= previous.updatedAt;
        previous.effectiveTo = this.minusOneDay(payload.effectiveFrom);
        previous.updatedAt = nowIso();
      }
      draft.salesUnitCostSettings.push(created);
    });
    await this.recalculateProfitSummariesSince(payload.storeId, payload.effectiveFrom);

    return formatApiSuccess({
      costSettingId: created.id,
      canonicalSalesUnitId: created.canonicalSalesUnitId,
      effectiveFrom: created.effectiveFrom,
      effectiveTo: created.effectiveTo,
      isActive: created.isActive,
    });
  }

  async update(costSettingId: string, payload: { unitCost: number; feeRate: number | null; otherCost: number; effectiveFrom: string }) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.salesUnitCostSettings.find((item) => item.id === costSettingId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "비용 설정 row를 찾을 수 없습니다.",
        errors: [{ field: "costSettingId", reason: "COST_SETTING_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);
    ensureDateString(payload.effectiveFrom, "effectiveFrom");
    const appliedCount = snapshot.orderItems.filter(
      (orderItem) =>
        orderItem.storeId === existing.storeId &&
        orderItem.canonicalSalesUnitId === existing.canonicalSalesUnitId &&
        !!orderItem.paymentDate &&
        orderItem.paymentDate >= existing.effectiveFrom &&
        (!existing.effectiveTo || orderItem.paymentDate <= existing.effectiveTo),
    ).length;
    if (appliedCount > 0) {
      throw new BadRequestException({
        success: false,
        message: "이미 적용된 비용 row는 직접 수정할 수 없습니다.",
        errors: [{ field: "costSettingId", reason: "COST_SETTING_NOT_EDITABLE" }],
      });
    }
    validateCostSettingValues(payload.unitCost, payload.otherCost, payload.feeRate);

    if (!existing.isActive || (existing.effectiveTo && payload.effectiveFrom > existing.effectiveTo) ||
      snapshot.salesUnitCostSettings.some((item) => item.id !== existing.id && item.isActive &&
        item.storeId === existing.storeId && item.canonicalSalesUnitId === existing.canonicalSalesUnitId &&
        item.effectiveFrom <= (existing.effectiveTo ?? "9999-12-31") &&
        (item.effectiveTo ?? "9999-12-31") >= payload.effectiveFrom)) {
      throw new BadRequestException("비용 적용 기간이 다른 설정과 겹치거나 유효하지 않습니다.");
    }

    await this.databaseService.writeCommitted((draft) => {
      const target = draft.salesUnitCostSettings.find((item) => item.id === costSettingId)!;
      target.unitCost = payload.unitCost;
      target.feeRate = payload.feeRate;
      target.otherCost = payload.otherCost;
      target.effectiveFrom = payload.effectiveFrom;
      target.updatedAt = nowIso();
      target.costValuesUpdatedAt = target.updatedAt;
    });
    await this.recalculateProfitSummariesSince(
      existing.storeId,
      existing.effectiveFrom < payload.effectiveFrom ? existing.effectiveFrom : payload.effectiveFrom,
    );

    return formatApiSuccess({
      costSettingId,
      effectiveFrom: payload.effectiveFrom,
      effectiveTo: existing.effectiveTo,
      isActive: existing.isActive,
    });
  }

  async close(costSettingId: string, payload: { effectiveTo: string }) {
    ensureDateString(payload.effectiveTo, "effectiveTo");
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.salesUnitCostSettings.find((item) => item.id === costSettingId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "비용 설정 row를 찾을 수 없습니다.",
        errors: [{ field: "costSettingId", reason: "COST_SETTING_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);
    if (payload.effectiveTo < existing.effectiveFrom) {
      throw new BadRequestException({
        success: false,
        message: "종료일은 시작일보다 빠를 수 없습니다.",
        errors: [{ field: "effectiveTo", reason: "INVALID_DATE_RANGE" }],
      });
    }
    if (!existing.isActive || snapshot.salesUnitCostSettings.some((item) =>
      item.id !== existing.id && item.storeId === existing.storeId &&
      item.canonicalSalesUnitId === existing.canonicalSalesUnitId && item.isActive &&
      item.effectiveFrom > existing.effectiveFrom && item.effectiveFrom <= payload.effectiveTo)) {
      throw new BadRequestException("종료일이 다른 비용 설정과 겹치거나 비활성 설정입니다.");
    }

    await this.databaseService.writeCommitted((draft) => {
      const target = draft.salesUnitCostSettings.find((item) => item.id === costSettingId)!;
      target.costValuesUpdatedAt ??= target.updatedAt;
      target.effectiveTo = payload.effectiveTo;
      target.updatedAt = nowIso();
    });
    await this.recalculateProfitSummariesSince(existing.storeId,
      existing.effectiveTo && existing.effectiveTo < payload.effectiveTo ? existing.effectiveTo : payload.effectiveTo);

    return formatApiSuccess({
      costSettingId,
      effectiveTo: payload.effectiveTo,
      isClosed: true,
    });
  }

  async deactivate(costSettingId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.salesUnitCostSettings.find((item) => item.id === costSettingId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "비용 설정 row를 찾을 수 없습니다.",
        errors: [{ field: "costSettingId", reason: "COST_SETTING_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);
    const appliedCount = snapshot.orderItems.filter(
      (orderItem) =>
        orderItem.storeId === existing.storeId &&
        orderItem.canonicalSalesUnitId === existing.canonicalSalesUnitId &&
        !!orderItem.paymentDate &&
        orderItem.paymentDate >= existing.effectiveFrom &&
        (!existing.effectiveTo || orderItem.paymentDate <= existing.effectiveTo),
    ).length;
    if (appliedCount > 0) {
      throw new BadRequestException({
        success: false,
        message: "이미 적용된 이력 row는 비활성화할 수 없습니다.",
        errors: [{ field: "costSettingId", reason: "COST_SETTING_ALREADY_APPLIED" }],
      });
    }

    await this.databaseService.writeCommitted((draft) => {
      const target = draft.salesUnitCostSettings.find((item) => item.id === costSettingId)!;
      target.isActive = false;
      target.deactivatedAt = nowIso();
      target.updatedAt = nowIso();
    });
    await this.recalculateProfitSummariesSince(existing.storeId, existing.effectiveFrom);

    return formatApiSuccess({
      costSettingId,
      isActive: false,
      deactivatedAt: nowIso(),
    });
  }

  private minusOneDay(dateString: string) {
    const date = new Date(`${dateString}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }

  previewExcelSnapshot(
    storeId: string,
    effectiveFrom: string,
    file: Express.Multer.File,
  ): CostSnapshotPreview {
    this.storeService.ensureWritable(storeId);
    ensureDateString(effectiveFrom, "effectiveFrom");
    const rows = this.parseExcelSnapshot(file);
    const { units, snapshots, baseline, entries, settings, token } = buildSnapshotPreviewContext(
      this.databaseService.getSnapshot(), storeId, effectiveFrom, file,
    );
    const existingById = new Map(units.map((unit) => [unit.id, unit]));
    const rowById = new Map<string, ParsedCostRow>();
    const entryByUnit = new Map(entries.map((entry) => [entry.canonicalSalesUnitId, entry]));
    const settingsByUnit = new Map<string, SalesUnitCostSetting[]>();
    for (const setting of settings) {
      const unitSettings = settingsByUnit.get(setting.canonicalSalesUnitId) ?? [];
      unitSettings.push(setting);
      settingsByUnit.set(setting.canonicalSalesUnitId, unitSettings);
    }
    const sameDate = snapshots.find((snapshot) => snapshot.effectiveFrom === effectiveFrom);
    const preview: CostSnapshotPreview = {
      token,
      storeId,
      effectiveFrom,
      fileName: repairMojibakeText(file.originalname),
      replaces: sameDate ? {
        id: sameDate.id,
        sourceFileName: repairMojibakeText(sameDate.sourceFileName) || null,
        createdAt: sameDate.createdAt,
      } : null,
      nextSnapshotDate: snapshots.find((snapshot) => snapshot.effectiveFrom > effectiveFrom)?.effectiveFrom ?? null,
      created: [],
      changed: [],
      missing: [],
    };
    for (const row of rows) {
      if (!row.salesUnitId) {
        preview.created.push({ row: row.row, displayName: row.displayName, cost: incomingSnapshotCost(row) });
        continue;
      }
      if (!existingById.has(row.salesUnitId)) {
        throw new BadRequestException(`${row.row}행: 판매단위 '${row.salesUnitId}'가 이 스토어에 없습니다.`);
      }
      rowById.set(row.salesUnitId, row);
    }

    const timestamp = nowIso();
    const pendingSnapshot: SalesUnitCostSnapshot = {
      id: "",
      storeId,
      effectiveFrom,
      sourceFileName: file.originalname,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    for (const unit of units) {
      if (unit.isGroup || unit.isStoreLevel) continue;
      const row = rowById.get(unit.id);
      const previousEntry = entryByUnit.get(unit.id) ?? null;
      const unitSettings = settingsByUnit.get(unit.id) ?? [];
      const previousCost = snapshotCostValues(getCostSettingForDate(
        baseline ? [{ snapshot: baseline, entry: previousEntry }] : [],
        effectiveFrom,
        unitSettings,
      ));
      const newValues = incomingSnapshotCost(row);
      const nextEntry: SalesUnitCostSnapshotEntry | null = newValues ? {
        id: "",
        snapshotId: "",
        storeId,
        canonicalSalesUnitId: unit.id,
        ...newValues,
        createdAt: timestamp,
        updatedAt: timestamp,
      } : null;
      const nextCost = snapshotCostValues(getCostSettingForDate(
        [{ snapshot: pendingSnapshot, entry: nextEntry }],
        effectiveFrom,
        unitSettings,
      ));
      const metadata = row ? excelMetadataPatch(row) : {};
      const metadataChanged = Object.entries(metadata).some(([key, value]) =>
        JSON.stringify(unit[key as keyof CanonicalSalesUnit]) !== JSON.stringify(value));
      const displayName = row?.displayName || unit.displayName;
      if (unit.isActive && !nextEntry) {
        preview.missing.push({
          id: unit.id,
          displayName,
          reason: row ? "BLANK_COST" : "OMITTED",
          losesCurrentCost: previousCost !== null && nextCost === null,
        });
      }
      if (metadataChanged || (nextEntry && JSON.stringify(previousCost) !== JSON.stringify(nextCost))) {
        preview.changed.push({
          id: unit.id,
          previousName: unit.displayName,
          displayName,
          metadataChanged,
          previousCost,
          nextCost,
        });
      }
    }
    return preview;
  }

  private parseExcelSnapshot(file: Express.Multer.File): ParsedCostRow[] {
    if (!file?.buffer?.length) {
      throw new BadRequestException("업로드할 .xlsx 파일을 선택해 주세요.");
    }
    const originalFileName = file.originalname;
    if (!/\.xlsx$/i.test(originalFileName)) {
      throw new BadRequestException({
        success: false,
        message: "엑셀 파일(.xlsx)만 업로드 가능합니다.",
        errors: [{ field: "file", reason: "INVALID_FILE_FORMAT" }],
        fileName: originalFileName,
      });
    }

    // 3. XLSX 파싱
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: "buffer" });
    } catch {
      throw new BadRequestException({
        success: false,
        message: "엑셀 파일 파싱에 실패했습니다.",
        errors: [{ field: "file", reason: "PARSE_FAILED" }],
        fileName: originalFileName,
      });
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new BadRequestException({
        success: false,
        message: "엑셀 파일에 sheet가 없습니다.",
        errors: [{ field: "file", reason: "NO_SHEET" }],
        fileName: originalFileName,
      });
    }

    const sheet = workbook.Sheets[sheetName];
    const rows: unknown[] = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[];

    if (rows.length === 0) {
      throw new BadRequestException({
        success: false,
        message: "엑셀 파일이 비어있습니다.",
        errors: [{ field: "file", reason: "EMPTY_FILE" }],
        fileName: originalFileName,
      });
    }

    // 헤더 행 (첫 번째 줄)
    const headerRow = rows[0] as string[];
    const headerIndexMap = new Map<string, number>();
    const requiredHeaders = ["salesUnitId", "displayName", "unitCost", "feeRate", "otherCost"];
    const optionalHeaders = ["matchAliases", "linkedProductIds", "linkedOptionCodes", "linkedManageCodes", "memo"];
    const allExpectedHeaders = [...requiredHeaders, ...optionalHeaders];

    headerRow.forEach((header, idx) => {
      if (allExpectedHeaders.includes(header)) {
        headerIndexMap.set(header, idx);
      }
    });

    // 필수 헤더 확인
    for (const required of requiredHeaders) {
      if (!headerIndexMap.has(required)) {
        throw new BadRequestException({
          success: false,
          message: `필수 헤더 '${required}' 가 없습니다.`,
          errors: [{ field: "file", reason: "MISSING_HEADER", headerName: required }],
          fileName: originalFileName,
        });
      }
    }

    const parsedRows: ParsedCostRow[] = [];
    const seenSalesUnitIds = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] as (string | number)[];

      const getCellValue = (header: string): string | number | null => {
        const idx = headerIndexMap.get(header);
        if (idx === undefined) return null;
        const val = row[idx];
        if (val === null || val === undefined || val === "") return null;
        return val;
      };

      const getNumberValue = (header: string): number | null => {
        const val = getCellValue(header);
        if (val === null) return null;
        const text = String(val).trim();
        if (!text) return null;
        // Accept thousands separators, but never parse only the numeric prefix.
        const valid = typeof val === "number" || /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text);
        const num = Number(text.replace(/,/g, ""));
        if (!valid || !Number.isFinite(num) || num < 0 || (header === "feeRate" && num > 1)) {
          throw new BadRequestException({
            success: false,
            message: `${i + 1}행 ${header}: 유효한 ${header === "feeRate" ? "0~1 사이 비율" : "0 이상의 숫자"}을 입력하세요.`,
            errors: [{ field: header, row: i + 1, reason: "INVALID_COST_VALUE" }],
          });
        }
        return num;
      };

      const getStringValue = (header: string): string | null => {
        const val = getCellValue(header);
        if (val === null) return null;
        return String(val).trim() || null;
      };

      const salesUnitId = getStringValue("salesUnitId") || "";
      const displayName = getStringValue("displayName") || "";
      if (!salesUnitId && !displayName) {
        if (["unitCost", "feeRate", "otherCost"].some((header) => getCellValue(header) != null)) {
          throw new BadRequestException(`${i + 1}행: 비용을 적용할 판매단위가 없습니다.`);
        }
        continue;
      }
      if (salesUnitId && seenSalesUnitIds.has(salesUnitId)) {
        throw new BadRequestException(`${i + 1}행: 판매단위가 중복되었습니다.`);
      }
      if (salesUnitId) seenSalesUnitIds.add(salesUnitId);

      parsedRows.push({
        row: i + 1,
        salesUnitId,
        displayName,
        matchAliases: getStringValue("matchAliases"),
        linkedProductIds: getStringValue("linkedProductIds"),
        linkedOptionCodes: getStringValue("linkedOptionCodes"),
        linkedManageCodes: getStringValue("linkedManageCodes"),
        memo: getStringValue("memo"),
        unitCost: getNumberValue("unitCost"),
        feeRate: getNumberValue("feeRate"),
        otherCost: getNumberValue("otherCost"),
      });
    }
    return parsedRows;
  }

  async importExcelSnapshot(
    storeId: string,
    effectiveFrom: string,
    file: Express.Multer.File,
    previewToken?: string,
  ): Promise<{
    snapshotId: string;
    effectiveFrom: string;
    metaUpdated: { created: number; updated: number };
    costEntries: { count: number };
    mismatch: { salesUnitCount: number; entryCount: number; missingSalesUnitIds: string[] };
    replacedSnapshot: { snapshotId: string; effectiveFrom: string } | null;
  }> {
    this.storeService.ensureWritable(storeId);
    ensureDateString(effectiveFrom, "effectiveFrom");
    const parsedRows = this.parseExcelSnapshot(file);

    let metaCreated = 0;
    let metaUpdated = 0;
    const costEntryRows: SalesUnitCostSnapshotEntry[] = [];
    let missingSalesUnitIds: string[] = [];
    let salesUnitCount = 0;
    let replacedSnapshotInfo: { snapshotId: string; effectiveFrom: string } | null = null;
    const snapshotId = createId();

    await this.databaseService.writeCommitted((draft) => {
      this.storeService.ensureWritable(storeId);
      if (previewToken !== undefined &&
        previewToken !== buildSnapshotPreviewContext(draft, storeId, effectiveFrom, file).token) {
        throw new ConflictException("파일 또는 스토어의 판매단위·원가가 변경됐습니다. 변경 내용을 다시 확인해 주세요.");
      }
      const storeUnits = new Map(draft.canonicalSalesUnits
        .filter((unit) => unit.storeId === storeId).map((unit) => [unit.id, unit]));
      const timestamp = nowIso();
      for (const parsedRow of parsedRows) {
        let effectiveUnitId = parsedRow.salesUnitId;
        const metadata = excelMetadataPatch(parsedRow);
        if (effectiveUnitId) {
          const existing = storeUnits.get(effectiveUnitId);
          if (!existing) {
            throw new BadRequestException(`${parsedRow.row}행: 판매단위 '${effectiveUnitId}'가 이 스토어에 없습니다.`);
          }
          if (existing.isGroup || existing.isStoreLevel) continue;
          Object.assign(existing, metadata, { updatedAt: timestamp });
          metaUpdated++;
        } else {
          effectiveUnitId = createId();
          draft.canonicalSalesUnits.push({
            id: effectiveUnitId,
            storeId,
            displayName: parsedRow.displayName,
            matchAliases: [],
            normalizedMatchAliases: [],
            linkedProductIds: [],
            linkedOptionCodes: [],
            linkedManageCodes: [],
            memo: null,
            isActive: true,
            deactivatedAt: null,
            isStoreLevel: false,
            parentSalesUnitId: null,
            isGroup: false,
            createdAt: timestamp,
            updatedAt: timestamp,
            ...metadata,
          });
          metaCreated++;
        }

        const cost = incomingSnapshotCost(parsedRow);
        if (cost) {
          costEntryRows.push({
            id: createId(),
            snapshotId,
            storeId,
            canonicalSalesUnitId: effectiveUnitId,
            ...cost,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        }
      }
      const activeUnits = draft.canonicalSalesUnits.filter(
        (unit) => unit.storeId === storeId && unit.isActive && !unit.isGroup && !unit.isStoreLevel,
      );
      const entryUnitIds = new Set(costEntryRows.map((entry) => entry.canonicalSalesUnitId));
      salesUnitCount = activeUnits.length;
      missingSalesUnitIds = activeUnits.filter((unit) => !entryUnitIds.has(unit.id)).map((unit) => unit.id);

      // 6. 스냅샷 생성
      // 같은 effectiveFrom 스냅샷이 있으면 hard delete
      const existingSnapshotIdx = draft.salesUnitCostSnapshots.findIndex(
        (s) => s.storeId === storeId && s.effectiveFrom === effectiveFrom,
      );
      if (existingSnapshotIdx >= 0) {
        const replaced = draft.salesUnitCostSnapshots[existingSnapshotIdx];
        replacedSnapshotInfo = { snapshotId: replaced.id, effectiveFrom: replaced.effectiveFrom };
        // 기존 스냅샷 삭제
        draft.salesUnitCostSnapshots.splice(existingSnapshotIdx, 1);
        // 기존 entries 삭제
        draft.salesUnitCostSnapshotEntries = draft.salesUnitCostSnapshotEntries.filter(
          (e) => e.snapshotId !== replaced.id,
        );
      }

      // 신규 스냅샷 push
      draft.salesUnitCostSnapshots.push({
        id: snapshotId,
        storeId,
        effectiveFrom,
        sourceFileName: repairMojibakeText(file.originalname),
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      draft.salesUnitCostSnapshotEntries = draft.salesUnitCostSnapshotEntries.concat(costEntryRows);

      // 감사 로그 기록
      this.auditLogService.appendToDraft(draft, {
        storeId,
        domain: "COST_SNAPSHOT",
        action: replacedSnapshotInfo ? "REPLACE" : "CREATE",
        targetId: snapshotId,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: replacedSnapshotInfo ? { id: replacedSnapshotInfo.snapshotId } : null,
        afterJson: { id: snapshotId, effectiveFrom, entryCount: costEntryRows.length },
      });
    });

    // 7. mismatch 체크
    await this.recalculateProfitSummariesSince(storeId, effectiveFrom);

    const entryCount = costEntryRows.length;

    return {
      snapshotId,
      effectiveFrom,
      metaUpdated: { created: metaCreated, updated: metaUpdated },
      costEntries: { count: entryCount },
      mismatch: {
        salesUnitCount,
        entryCount,
        missingSalesUnitIds,
      },
      replacedSnapshot: replacedSnapshotInfo,
    };
  }

  /**
   * 스냅샷 목록 조회 (effectiveFrom 내림차순)
   */
  listSnapshots(
    storeId: string,
    page?: number,
    pageSize?: number,
  ): {
    snapshots: Array<{
      id: string;
      effectiveFrom: string;
      entryCount: number;
      missingSalesUnitCount: number;
      sourceFileName: string | null;
      createdAt: string;
    }>;
    pagination: { page: number; pageSize: number; totalCount: number; totalPages: number };
  } {
    const snapshot = this.databaseService.getSnapshot();

    const snapshots = snapshot.salesUnitCostSnapshots
      .filter((s) => s.storeId === storeId)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));

    const activeSalesUnitIds = new Set(snapshot.canonicalSalesUnits.filter(
      (u) => u.storeId === storeId && u.isActive && !u.isGroup && !u.isStoreLevel,
    ).map((unit) => unit.id));

    const pageNum = page || 1;
    const pageSz = pageSize || 50;
    const totalCount = snapshots.length;
    const totalPages = Math.ceil(totalCount / pageSz);
    const startIdx = (pageNum - 1) * pageSz;
    const endIdx = startIdx + pageSz;

    const items = snapshots.slice(startIdx, endIdx).map((s) => {
      const entries = snapshot.salesUnitCostSnapshotEntries.filter(
        (e) => e.snapshotId === s.id,
      );
      const covered = new Set(entries.filter((entry) => activeSalesUnitIds.has(entry.canonicalSalesUnitId))
        .map((entry) => entry.canonicalSalesUnitId));

      return {
        id: s.id,
        effectiveFrom: s.effectiveFrom,
        entryCount: entries.length,
        missingSalesUnitCount: activeSalesUnitIds.size - covered.size,
        sourceFileName: repairMojibakeText(s.sourceFileName) || null,
        createdAt: s.createdAt,
      };
    });

    return {
      snapshots: items,
      pagination: {
        page: pageNum,
        pageSize: pageSz,
        totalCount,
        totalPages,
      },
    };
  }

  /**
   * 비용 표 엑셀 다운로드
   */
  exportExcel(storeId: string, effectiveFrom?: string): Buffer {
    const snapshot = this.databaseService.getSnapshot();
    if (effectiveFrom) ensureDateString(effectiveFrom, "effectiveFrom");

    // 적용될 스냅샷 결정
    let targetSnapshot: SalesUnitCostSnapshot | undefined;
    if (effectiveFrom) {
      // effectiveFrom 지정 시, 그 시점 직전까지 적용된 스냅샷
      const snapshotsUpToDate = snapshot.salesUnitCostSnapshots
        .filter((s) => s.storeId === storeId && s.effectiveFrom <= effectiveFrom)
        .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
      targetSnapshot = snapshotsUpToDate[0];
    } else {
      // 미지정 시 가장 최근 스냅샷
      const snapshotsAll = snapshot.salesUnitCostSnapshots
        .filter((s) => s.storeId === storeId)
        .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
      targetSnapshot = snapshotsAll[0];
    }

    // 그룹 부모(isGroup) / 스토어레벨(isStoreLevel) 판매단위는 비용 설정 대상이 아니므로 표에서 제외.
    // import 의 mismatch 계산 / entry 생성 정책과 일관 (0504계획서 7.6).
    const activeSalesUnits = snapshot.canonicalSalesUnits.filter(
      (u) => u.storeId === storeId && u.isActive && !u.isGroup && !u.isStoreLevel,
    );

    // entry index 구축
    const entryIndex = new Map<string, SalesUnitCostSnapshotEntry>();
    if (targetSnapshot) {
      snapshot.salesUnitCostSnapshotEntries
        .filter((e) => e.snapshotId === targetSnapshot!.id)
        .forEach((e) => {
          entryIndex.set(e.canonicalSalesUnitId, e);
        });
    }

    // 엑셀 행 생성
    const headers = ["salesUnitId", "displayName", "unitCost", "feeRate", "otherCost", "matchAliases", "linkedProductIds", "linkedOptionCodes", "linkedManageCodes", "memo"];
    const data: unknown[][] = [headers];
    const manualSettings = snapshot.salesUnitCostSettings.filter((item) => item.storeId === storeId);
    const targetDate = effectiveFrom ?? [
      targetSnapshot?.effectiveFrom ?? "", ...manualSettings.filter((item) => item.isActive).map((item) => item.effectiveFrom),
    ].sort().at(-1) ?? null;

    for (const unit of activeSalesUnits) {
      const entry = getCostSettingForDate(
        targetSnapshot ? [{ snapshot: targetSnapshot, entry: entryIndex.get(unit.id) ?? null }] : [],
        targetDate,
        manualSettings.filter((item) => item.canonicalSalesUnitId === unit.id),
      );
      data.push([
        unit.id,
        unit.displayName,
        entry?.unitCost ?? "",
        entry?.feeRate ?? "",
        entry?.otherCost ?? "",
        unit.matchAliases.join(","),
        unit.linkedProductIds.join(","),
        unit.linkedOptionCodes.join(","),
        unit.linkedManageCodes.join(","),
        unit.memo ?? "",
      ]);
    }

    const sheet = XLSX.utils.aoa_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "CostSnapshot");

    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  }

  /**
   * 스냅샷 삭제
   */
  async deleteSnapshot(snapshotId: string): Promise<{ success: true; message: string }> {
    const snapshot = this.databaseService.getSnapshot();
    const targetSnapshot = snapshot.salesUnitCostSnapshots.find((s) => s.id === snapshotId);

    if (!targetSnapshot) {
      throw new NotFoundException({
        success: false,
        message: "스냅샷을 찾을 수 없습니다.",
        errors: [{ field: "snapshotId", reason: "SNAPSHOT_NOT_FOUND" }],
      });
    }

    this.storeService.ensureWritable(targetSnapshot.storeId);

    await this.databaseService.writeCommitted((draft) => {
      // 스냅샷 삭제
      draft.salesUnitCostSnapshots = draft.salesUnitCostSnapshots.filter((s) => s.id !== snapshotId);
      // entries 삭제
      draft.salesUnitCostSnapshotEntries = draft.salesUnitCostSnapshotEntries.filter((e) => e.snapshotId !== snapshotId);

      // 감사 로그
      this.auditLogService.appendToDraft(draft, {
        storeId: targetSnapshot.storeId,
        domain: "COST_SNAPSHOT",
        action: "DELETE",
        targetId: snapshotId,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: { id: snapshotId, effectiveFrom: targetSnapshot.effectiveFrom },
        afterJson: null,
      });
    });
    await this.recalculateProfitSummariesSince(targetSnapshot.storeId, targetSnapshot.effectiveFrom);

    return {
      success: true,
      message: `스냅샷 ${targetSnapshot.effectiveFrom} 이 삭제되었습니다.`,
    };
  }

  private async recalculateProfitSummariesSince(storeId: string, dateFrom: string) {
    await this.profitSummaryService?.refreshStoreDatesSinceBestEffort({
      storeId,
      dateFrom,
      reason: "COST_CHANGE",
    });
  }
}
