import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  CanonicalSalesUnit,
  SalesUnitCostSetting,
  SalesUnitCostSnapshot,
  SalesUnitCostSnapshotEntry,
} from "@patima/shared";
import * as XLSX from "xlsx";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureNoCrossStoreReference,
  formatApiSuccess,
  nowIso,
  repairMojibakeText,
} from "./helpers";
import { SalesUnitService } from "./sales-unit.service";
import { StoreService } from "./store.service";

@Injectable()
export class CostService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly auditLogService: AuditLogService,
    private readonly salesUnitService: SalesUnitService,
  ) {}

  list(storeId: string, canonicalSalesUnitId?: string) {
    const snapshot = this.databaseService.getSnapshot();
    const items = snapshot.salesUnitCostSettings
      .filter((item) => item.storeId === storeId)
      .filter((item) => (canonicalSalesUnitId ? item.canonicalSalesUnitId === canonicalSalesUnitId : true))
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))
      .map((item) => {
        const appliedOrderItemCount = snapshot.orderItems.filter(
          (orderItem) =>
            orderItem.storeId === storeId &&
            orderItem.canonicalSalesUnitId === item.canonicalSalesUnitId &&
            !!orderItem.paymentDate &&
            orderItem.paymentDate >= item.effectiveFrom &&
            (!item.effectiveTo || orderItem.paymentDate <= item.effectiveTo),
        ).length;

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

  create(payload: {
    storeId: string;
    canonicalSalesUnitId: string;
    unitCost: number;
    feeRate: number | null;
    otherCost: number;
    effectiveFrom: string;
  }) {
    this.storeService.ensureWritable(payload.storeId);
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
    this.validateValues(payload.unitCost, payload.otherCost, payload.feeRate);

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

    const created: SalesUnitCostSetting = {
      id: createId(),
      storeId: payload.storeId,
      canonicalSalesUnitId: payload.canonicalSalesUnitId,
      unitCost: payload.unitCost,
      feeRate: payload.feeRate,
      otherCost: payload.otherCost,
      isActive: true,
      deactivatedAt: null,
      effectiveFrom: payload.effectiveFrom,
      effectiveTo: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.databaseService.write((draft) => {
      const previous = draft.salesUnitCostSettings.find((item) => item.id === previousRow?.id);
      if (previous && !previous.effectiveTo) {
        previous.effectiveTo = this.minusOneDay(payload.effectiveFrom);
        previous.updatedAt = nowIso();
      }
      draft.salesUnitCostSettings.push(created);
    });

    return formatApiSuccess({
      costSettingId: created.id,
      canonicalSalesUnitId: created.canonicalSalesUnitId,
      effectiveFrom: created.effectiveFrom,
      effectiveTo: created.effectiveTo,
      isActive: created.isActive,
    });
  }

  update(costSettingId: string, payload: { unitCost: number; feeRate: number | null; otherCost: number; effectiveFrom: string }) {
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
        message: "이미 적용된 비용 row는 직접 수정할 수 없습니다.",
        errors: [{ field: "costSettingId", reason: "COST_SETTING_NOT_EDITABLE" }],
      });
    }
    this.validateValues(payload.unitCost, payload.otherCost, payload.feeRate);

    this.databaseService.write((draft) => {
      const target = draft.salesUnitCostSettings.find((item) => item.id === costSettingId)!;
      target.unitCost = payload.unitCost;
      target.feeRate = payload.feeRate;
      target.otherCost = payload.otherCost;
      target.effectiveFrom = payload.effectiveFrom;
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      costSettingId,
      effectiveFrom: payload.effectiveFrom,
      effectiveTo: existing.effectiveTo,
      isActive: existing.isActive,
    });
  }

  close(costSettingId: string, payload: { effectiveTo: string }) {
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

    this.databaseService.write((draft) => {
      const target = draft.salesUnitCostSettings.find((item) => item.id === costSettingId)!;
      target.effectiveTo = payload.effectiveTo;
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      costSettingId,
      effectiveTo: payload.effectiveTo,
      isClosed: true,
    });
  }

  deactivate(costSettingId: string) {
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

    this.databaseService.write((draft) => {
      const target = draft.salesUnitCostSettings.find((item) => item.id === costSettingId)!;
      target.isActive = false;
      target.deactivatedAt = nowIso();
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      costSettingId,
      isActive: false,
      deactivatedAt: nowIso(),
    });
  }

  private validateValues(unitCost: number, otherCost: number, feeRate: number | null) {
    if (unitCost < 0 || otherCost < 0) {
      throw new BadRequestException({
        success: false,
        message: "원가와 기타비용은 0 이상이어야 합니다.",
        errors: [{ field: "unitCost", reason: "INVALID_VALUE" }],
      });
    }
    if (feeRate != null && (feeRate < 0 || feeRate > 1)) {
      throw new BadRequestException({
        success: false,
        message: "feeRate는 0 이상 1 이하여야 합니다.",
        errors: [{ field: "feeRate", reason: "INVALID_VALUE" }],
      });
    }
  }

  private minusOneDay(dateString: string) {
    const date = new Date(`${dateString}T00:00:00+09:00`);
    date.setDate(date.getDate() - 1);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }

  /**
   * 비용 표 엑셀 업로드 + 메타 update + 스냅샷 생성
   */
  async importExcelSnapshot(
    storeId: string,
    effectiveFrom: string,
    file: Express.Multer.File,
  ): Promise<{
    snapshotId: string;
    effectiveFrom: string;
    metaUpdated: { created: number; updated: number };
    costEntries: { count: number };
    mismatch: { salesUnitCount: number; entryCount: number; missingSalesUnitIds: string[] };
    replacedSnapshot: { snapshotId: string; effectiveFrom: string } | null;
  }> {
    // 1. 쓰기 권한 확인
    this.storeService.ensureWritable(storeId);

    // 2. 파일 형식 검증
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

    // 4. 데이터 행 파싱
    interface ParsedRow {
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

    const parsedRows: ParsedRow[] = [];
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
        const num = typeof val === "number" ? val : parseFloat(String(val));
        return isNaN(num) ? null : num;
      };

      const getStringValue = (header: string): string | null => {
        const val = getCellValue(header);
        if (val === null) return null;
        return String(val).trim() || null;
      };

      const salesUnitId = getStringValue("salesUnitId") || "";
      const displayName = getStringValue("displayName") || "";

      parsedRows.push({
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

    // 5. 메타 업데이트 (즉시, 시점 무관) 및 비용 entry 생성 준비
    let metaCreated = 0;
    let metaUpdated = 0;
    const costEntryRows: SalesUnitCostSnapshotEntry[] = [];
    const missingSalesUnitIds: string[] = [];
    let replacedSnapshotInfo: { snapshotId: string; effectiveFrom: string } | null = null;

    const snapshot = this.databaseService.getSnapshot();
    const activeSalesUnits = snapshot.canonicalSalesUnits.filter(
      (unit) => unit.storeId === storeId && unit.isActive && !unit.isGroup && !unit.isStoreLevel,
    );

    const snapshotId = createId();

    this.databaseService.write((draft) => {
      for (const parsedRow of parsedRows) {
        const { salesUnitId, displayName, matchAliases, linkedProductIds, linkedOptionCodes, linkedManageCodes, memo, unitCost, feeRate, otherCost } =
          parsedRow;

        // 그룹/isStoreLevel 은 엑셀에서 읽기 전용 (무시)
        if (salesUnitId) {
          // 기존 판매단위 update
          const existing = draft.canonicalSalesUnits.find((u) => u.id === salesUnitId && u.storeId === storeId);
          if (existing) {
            // 그룹 또는 스토어레벨 판매단위는 메타 update 및 비용 entry 생성 전부 스킵
            if (existing.isGroup || existing.isStoreLevel) {
              continue;
            }
            // 메타만 업데이트 (그룹이 아닌 경우만)
            if (displayName) existing.displayName = displayName;
            if (matchAliases) existing.matchAliases = matchAliases.split(",").map((s) => s.trim());
            if (linkedProductIds) existing.linkedProductIds = linkedProductIds.split(",").map((s) => s.trim());
            if (linkedOptionCodes) existing.linkedOptionCodes = linkedOptionCodes.split(",").map((s) => s.trim());
            if (linkedManageCodes) existing.linkedManageCodes = linkedManageCodes.split(",").map((s) => s.trim());
            if (memo !== undefined && memo !== null) existing.memo = memo;
            existing.updatedAt = nowIso();
            metaUpdated++;
          }
        } else {
          // 신규 판매단위 생성
          if (displayName) {
            const newId = createId();
            draft.canonicalSalesUnits.push({
              id: newId,
              storeId,
              displayName,
              matchAliases: matchAliases ? matchAliases.split(",").map((s) => s.trim()) : [],
              normalizedMatchAliases: [], // 정규화는 나중에 normalization 로직에서
              linkedProductIds: linkedProductIds ? linkedProductIds.split(",").map((s) => s.trim()) : [],
              linkedOptionCodes: linkedOptionCodes ? linkedOptionCodes.split(",").map((s) => s.trim()) : [],
              linkedManageCodes: linkedManageCodes ? linkedManageCodes.split(",").map((s) => s.trim()) : [],
              memo: memo || null,
              isActive: true,
              deactivatedAt: null,
              isStoreLevel: false,
              parentSalesUnitId: null,
              isGroup: false,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            });
            metaCreated++;
          }
        }

        // 비용 entry 생성 (unitCost 또는 otherCost 중 하나라도 있으면)
        const hasAnyCost = unitCost !== null || otherCost !== null;
        if (hasAnyCost) {
          const effectiveUnitId = salesUnitId || draft.canonicalSalesUnits[draft.canonicalSalesUnits.length - 1]?.id;
          if (effectiveUnitId) {
            // 그룹/isStoreLevel 판매단위는 비용 entry 생성 스킵
            const targetUnit = draft.canonicalSalesUnits.find((u) => u.id === effectiveUnitId);
            if (targetUnit && !targetUnit.isGroup && !targetUnit.isStoreLevel) {
              costEntryRows.push({
                id: createId(),
                snapshotId: "", // 스냅샷 생성 후 업데이트
                storeId,
                canonicalSalesUnitId: effectiveUnitId,
                unitCost: unitCost || 0,
                feeRate: feeRate,
                otherCost: otherCost || 0,
                createdAt: nowIso(),
                updatedAt: nowIso(),
              });
            }
          }
        } else if (salesUnitId) {
          // 비용 없으면 mismatch에 기록 (그룹/storeLevel은 제외)
          const existingUnit = draft.canonicalSalesUnits.find((u) => u.id === salesUnitId && u.storeId === storeId);
          if (existingUnit && !existingUnit.isGroup && !existingUnit.isStoreLevel) {
            missingSalesUnitIds.push(salesUnitId);
          }
        }
      }

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
        sourceFileName: originalFileName,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });

      // 비용 entries 생성 (snapshotId 설정)
      costEntryRows.forEach((entry) => {
        entry.snapshotId = snapshotId;
        draft.salesUnitCostSnapshotEntries.push(entry);
      });

      // 감사 로그 기록
      this.auditLogService.record({
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
    const entryCount = costEntryRows.length;
    const salesUnitCount = activeSalesUnits.length;

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

    const activeSalesUnitCount = snapshot.canonicalSalesUnits.filter(
      (u) => u.storeId === storeId && u.isActive && !u.isGroup && !u.isStoreLevel,
    ).length;

    const pageNum = page || 1;
    const pageSz = pageSize || 50;
    const totalCount = snapshots.length;
    const totalPages = Math.ceil(totalCount / pageSz);
    const startIdx = (pageNum - 1) * pageSz;
    const endIdx = startIdx + pageSz;

    const items = snapshots.slice(startIdx, endIdx).map((s) => {
      const entryCount = snapshot.salesUnitCostSnapshotEntries.filter(
        (e) => e.snapshotId === s.id,
      ).length;
      const missingSalesUnitCount = activeSalesUnitCount - entryCount;

      return {
        id: s.id,
        effectiveFrom: s.effectiveFrom,
        entryCount,
        missingSalesUnitCount: Math.max(0, missingSalesUnitCount),
        sourceFileName: s.sourceFileName,
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

    for (const unit of activeSalesUnits) {
      const entry = entryIndex.get(unit.id);
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
  deleteSnapshot(snapshotId: string): { success: true; message: string } {
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

    this.databaseService.write((draft) => {
      // 스냅샷 삭제
      draft.salesUnitCostSnapshots = draft.salesUnitCostSnapshots.filter((s) => s.id !== snapshotId);
      // entries 삭제
      draft.salesUnitCostSnapshotEntries = draft.salesUnitCostSnapshotEntries.filter((e) => e.snapshotId !== snapshotId);

      // 감사 로그
      this.auditLogService.record({
        storeId: targetSnapshot.storeId,
        domain: "COST_SNAPSHOT",
        action: "DELETE",
        targetId: snapshotId,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: { id: snapshotId, effectiveFrom: targetSnapshot.effectiveFrom },
        afterJson: null,
      });
    });

    return {
      success: true,
      message: `스냅샷 ${targetSnapshot.effectiveFrom} 이 삭제되었습니다.`,
    };
  }
}
